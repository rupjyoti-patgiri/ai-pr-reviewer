import { countTokens, estimateChatTokens, getModelMaxTokens } from "../utils/tokenCounter";
import { SYSTEM_PROMPT } from "../ai/prompts";
import { reviewConfig } from "../config/reviewRules";
import { logger } from "../utils/logger";
import type { DiffChunk } from "./types";

/**
 * Token budget calculation:
 * Model max tokens - system prompt tokens - response tokens - safety margin
 */
function getAvailableTokenBudget(model: string): number {
  const modelMax = getModelMaxTokens(model);
  const systemTokens = countTokens(SYSTEM_PROMPT, model);
  const responseReserve = reviewConfig.ai.maxTokensPerRequest;
  const safetyMargin = 500; // Buffer for message formatting overhead

  return modelMax - systemTokens - responseReserve - safetyMargin;
}

/**
 * Estimates the token count of a diff chunk when formatted as a user prompt.
 * Includes overhead for the PR context template.
 */
function estimateChunkTokens(chunk: DiffChunk, model: string): number {
  // Approximate the user prompt format
  const promptOverhead = 150; // Tokens for PR title, description template, etc.
  const patchTokens = countTokens(chunk.fullPatch, model);
  return patchTokens + promptOverhead;
}

/**
 * Smart chunking strategy for large file diffs.
 *
 * When a file's diff is too large to fit within the model's token limit,
 * this function splits it into smaller chunks that each fit within budget.
 *
 * Strategy:
 * 1. If the entire file diff fits → return as-is (single chunk)
 * 2. If individual hunks are small enough → group hunks into token-budget-sized batches
 * 3. If a single hunk is too large → split it at logical boundaries (function/class definitions)
 * 4. Last resort → split by raw line count
 */
export function applyChunkStrategy(
  chunks: DiffChunk[],
  model: string = "gpt-4o"
): DiffChunk[][] {
  const budget = getAvailableTokenBudget(model);

  logger.debug(
    {
      filename: chunks[0]?.filename,
      chunkCount: chunks.length,
      tokenBudget: budget,
      model,
    },
    "Applying chunk strategy"
  );

  // Calculate total tokens for all chunks combined
  const totalTokens = chunks.reduce(
    (sum, chunk) => sum + estimateChunkTokens(chunk, model),
    0
  );

  // Case 1: Everything fits in one request
  if (totalTokens <= budget) {
    logger.debug(
      { totalTokens, budget },
      "All chunks fit in single request"
    );
    return [chunks];
  }

  // Case 2: Group chunks into batches that fit within budget
  const batches: DiffChunk[][] = [];
  let currentBatch: DiffChunk[] = [];
  let currentBatchTokens = 0;

  for (const chunk of chunks) {
    const chunkTokens = estimateChunkTokens(chunk, model);

    // Case 3: Single chunk exceeds budget — split it
    if (chunkTokens > budget) {
      // Flush current batch if non-empty
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchTokens = 0;
      }

      const splitChunks = splitLargeChunk(chunk, budget, model);
      for (const splitChunk of splitChunks) {
        batches.push([splitChunk]);
      }
      continue;
    }

    // Check if adding this chunk would exceed budget
    if (currentBatchTokens + chunkTokens > budget) {
      // Start a new batch
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [chunk];
      currentBatchTokens = chunkTokens;
    } else {
      currentBatch.push(chunk);
      currentBatchTokens += chunkTokens;
    }
  }

  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  logger.info(
    {
      filename: chunks[0]?.filename,
      originalChunks: chunks.length,
      batches: batches.length,
      totalTokens,
      budget,
    },
    "Split file into multiple review batches"
  );

  return batches;
}

/**
 * Splits a single large diff chunk into smaller pieces.
 *
 * Tries to split at logical boundaries:
 * 1. Function/class/method definitions
 * 2. Blank lines
 * 3. Fixed line count (last resort)
 */
function splitLargeChunk(
  chunk: DiffChunk,
  tokenBudget: number,
  model: string
): DiffChunk[] {
  const lines = chunk.fullPatch.split("\n");
  const result: DiffChunk[] = [];

  // Estimate how many lines fit in the budget (rough: ~3 tokens per line average)
  const tokensPerLine = Math.max(
    1,
    Math.ceil(countTokens(chunk.fullPatch, model) / Math.max(lines.length, 1))
  );
  const maxLinesPerChunk = Math.floor((tokenBudget - 150) / tokensPerLine);

  if (maxLinesPerChunk <= 0) {
    logger.warn(
      { filename: chunk.filename, lines: lines.length },
      "Chunk is extremely large — cannot split meaningfully"
    );
    return [chunk]; // Return as-is; the AI call might fail but we handle that
  }

  // Find logical split points in the diff
  const splitPoints = findLogicalSplitPoints(lines, maxLinesPerChunk);

  let startIdx = 0;
  let currentNewLine = chunk.startLine;

  for (const splitIdx of splitPoints) {
    const segmentLines = lines.slice(startIdx, splitIdx);
    const segmentPatch = segmentLines.join("\n");

    // Count new-file lines in this segment
    const addedInSegment = segmentLines.filter((l) => l.startsWith("+")).length;
    const contextInSegment = segmentLines.filter(
      (l) => l.startsWith(" ") || l === ""
    ).length;
    const segmentNewLines = addedInSegment + contextInSegment;

    const subChunk: DiffChunk = {
      filename: chunk.filename,
      language: chunk.language,
      startLine: currentNewLine,
      endLine: currentNewLine + segmentNewLines - 1,
      addedLines: segmentLines
        .filter((l) => l.startsWith("+"))
        .map((l) => l.substring(1)),
      removedLines: segmentLines
        .filter((l) => l.startsWith("-"))
        .map((l) => l.substring(1)),
      context: segmentLines
        .filter((l) => l.startsWith(" "))
        .map((l) => l.substring(1)),
      fullPatch: segmentPatch,
    };

    if (subChunk.addedLines.length > 0 || subChunk.removedLines.length > 0) {
      result.push(subChunk);
    }

    currentNewLine += segmentNewLines;
    startIdx = splitIdx;
  }

  // Handle remaining lines
  if (startIdx < lines.length) {
    const remainingLines = lines.slice(startIdx);
    const remainingPatch = remainingLines.join("\n");
    const addedInRemaining = remainingLines.filter((l) => l.startsWith("+")).length;
    const contextInRemaining = remainingLines.filter(
      (l) => l.startsWith(" ") || l === ""
    ).length;
    const remainingNewLines = addedInRemaining + contextInRemaining;

    const subChunk: DiffChunk = {
      filename: chunk.filename,
      language: chunk.language,
      startLine: currentNewLine,
      endLine: currentNewLine + remainingNewLines - 1,
      addedLines: remainingLines
        .filter((l) => l.startsWith("+"))
        .map((l) => l.substring(1)),
      removedLines: remainingLines
        .filter((l) => l.startsWith("-"))
        .map((l) => l.substring(1)),
      context: remainingLines
        .filter((l) => l.startsWith(" "))
        .map((l) => l.substring(1)),
      fullPatch: remainingPatch,
    };

    if (subChunk.addedLines.length > 0 || subChunk.removedLines.length > 0) {
      result.push(subChunk);
    }
  }

  logger.debug(
    {
      filename: chunk.filename,
      originalLines: lines.length,
      subChunks: result.length,
      maxLinesPerChunk,
    },
    "Split large chunk into sub-chunks"
  );

  return result;
}

/**
 * Finds logical split points in diff lines.
 * Prefers splitting at:
 * 1. Function/class/method definition boundaries
 * 2. Blank lines
 * 3. Fixed intervals (fallback)
 */
function findLogicalSplitPoints(
  lines: string[],
  maxLinesPerChunk: number
): number[] {
  const splitPoints: number[] = [];
  let linesSinceLastSplit = 0;

  // Patterns that indicate logical boundaries (start of new blocks)
  const boundaryPatterns = [
    /^(?:export\s+)?(?:function|class|interface|type|enum|const|let|var)\s/,
    /^(?:export\s+)?(?:async\s+)?function\s/,
    /^(?:public|private|protected|static)\s/,
    /^(?:def |class |module |describe\(|it\(|test\()/,
    /^(?:func |fn |impl |struct |trait |pub)\s/
  ];
  
  for (let i = 0; i < lines.length; i++) {
    linesSinceLastSplit++;

    if (linesSinceLastSplit < maxLinesPerChunk * 0.5) {
      // Don't split too early — let chunks be at least half the max size
      continue;
    }

    if (linesSinceLastSplit >= maxLinesPerChunk) {
      // We must split — look for the nearest good split point
      // Search backwards up to 20 lines for a boundary
      let bestSplit = i;
      for (let j = i; j > Math.max(i - 20, splitPoints.length > 0 ? splitPoints[splitPoints.length - 1]! : 0); j--) {
        const line = lines[j];
        if (!line) continue;

        // Check for logical boundary
        const isBoundary = boundaryPatterns.some((p) => p.test(line));
        if (isBoundary) {
          bestSplit = j;
          break;
        }

        // Blank line / empty context line is also acceptable
        if (line === " " || line === "+" || line === "") {
          bestSplit = j + 1;
          break;
        }
      }

      splitPoints.push(bestSplit);
      linesSinceLastSplit = i - bestSplit;
    }
  }

  return splitPoints;
}