import { detectLanguage } from "./fileFilter";
import { logger } from "../utils/logger";
import type { DiffChunk } from "./types";

/**
 * Unified diff hunk header regex.
 * Matches: @@ -oldStart,oldCount +newStart,newCount @@ optional context
 * Examples:
 *   @@ -10,6 +10,8 @@ function example() {
 *   @@ -0,0 +1,25 @@
 */
const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/**
 * Parses a unified diff patch string for a single file into structured DiffChunk objects.
 *
 * Each hunk in the diff becomes a separate DiffChunk, containing:
 * - The line range in the new file
 * - Added and removed lines
 * - Context (unchanged) lines
 * - The raw patch text
 *
 * This is the foundation for sending meaningful code segments to the AI for review.
 */
export function parseDiff(filename: string, patch: string): DiffChunk[] {
  if (!patch || patch.trim().length === 0) {
    return [];
  }

  const language = detectLanguage(filename);
  const lines = patch.split("\n");
  const chunks: DiffChunk[] = [];

  let currentChunk: {
    startLine: number;
    currentNewLine: number;
    addedLines: string[];
    removedLines: string[];
    context: string[];
    patchLines: string[];
  } | null = null;

  for (const line of lines) {
    // Check for hunk header
    const hunkMatch = HUNK_HEADER_REGEX.exec(line);

    if (hunkMatch) {
      // Save the previous chunk if it exists
      if (currentChunk && (currentChunk.addedLines.length > 0 || currentChunk.removedLines.length > 0)) {
        chunks.push({
          filename,
          language,
          startLine: currentChunk.startLine,
          endLine: currentChunk.currentNewLine - 1,
          addedLines: currentChunk.addedLines,
          removedLines: currentChunk.removedLines,
          context: currentChunk.context,
          fullPatch: currentChunk.patchLines.join("\n"),
        });
      }

      // Start a new chunk
      const newStart = parseInt(hunkMatch[3] ?? "1", 10);
      currentChunk = {
        startLine: newStart,
        currentNewLine: newStart,
        addedLines: [],
        removedLines: [],
        context: [],
        patchLines: [line],
      };
      continue;
    }

    if (!currentChunk) {
      continue;
    }

    currentChunk.patchLines.push(line);

    if (line.startsWith("+")) {
      // Added line
      currentChunk.addedLines.push(line.substring(1));
      currentChunk.currentNewLine++;
    } else if (line.startsWith("-")) {
      // Removed line (does not advance new file line counter)
      currentChunk.removedLines.push(line.substring(1));
    } else if (line.startsWith(" ") || line === "") {
      // Context line (unchanged)
      currentChunk.context.push(line.startsWith(" ") ? line.substring(1) : line);
      currentChunk.currentNewLine++;
    }
    // Lines starting with \ (e.g., "\ No newline at end of file") are ignored
  }

  // Don't forget the last chunk
  if (currentChunk && (currentChunk.addedLines.length > 0 || currentChunk.removedLines.length > 0)) {
    chunks.push({
      filename,
      language,
      startLine: currentChunk.startLine,
      endLine: currentChunk.currentNewLine - 1,
      addedLines: currentChunk.addedLines,
      removedLines: currentChunk.removedLines,
      context: currentChunk.context,
      fullPatch: currentChunk.patchLines.join("\n"),
    });
  }

  logger.debug(
    {
      filename,
      language,
      chunkCount: chunks.length,
      totalAdded: chunks.reduce((sum, c) => sum + c.addedLines.length, 0),
      totalRemoved: chunks.reduce((sum, c) => sum + c.removedLines.length, 0),
    },
    "Parsed diff into chunks"
  );

  return chunks;
}

/**
 * Merges adjacent or nearby diff chunks into larger logical chunks.
 * This reduces the number of AI API calls for files with many small hunks.
 *
 * Two chunks are merged if they are within `proximityLines` of each other.
 */
export function mergeAdjacentChunks(
  chunks: DiffChunk[],
  proximityLines: number = 10
): DiffChunk[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged: DiffChunk[] = [];
  let current = { ...chunks[0]! };

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i]!;

    // Check if the next chunk is close enough to merge
    const gap = next.startLine - current.endLine;

    if (gap <= proximityLines) {
      // Merge: extend the current chunk to include the next one
      current = {
        ...current,
        endLine: next.endLine,
        addedLines: [...current.addedLines, ...next.addedLines],
        removedLines: [...current.removedLines, ...next.removedLines],
        context: [...current.context, ...next.context],
        fullPatch: current.fullPatch + "\n" + next.fullPatch,
      };
    } else {
      // Gap too large — finalize current and start fresh
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);

  if (merged.length < chunks.length) {
    logger.debug(
      {
        filename: chunks[0]?.filename,
        originalChunks: chunks.length,
        mergedChunks: merged.length,
      },
      "Merged adjacent diff chunks"
    );
  }

  return merged;
}