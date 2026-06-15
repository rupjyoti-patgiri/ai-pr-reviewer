import { z } from "zod";
import { logger } from "../utils/logger";
import type { AIReviewComment, ReviewSeverity } from "./types";
import { reviewConfig } from "../config/reviewRules";

/**
 * Zod schema for validating individual AI review comments.
 * Ensures the AI response conforms to our expected structure.
 */
const reviewCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["critical", "warning", "suggestion", "praise"]),
  category: z.enum([
    "bug",
    "security",
    "performance",
    "readability",
    "architecture",
    "best-practice",
  ]),
  comment: z.string().min(1),
  suggestion: z.string().optional(),
});

/**
 * Zod schema for the complete AI response.
 * The AI should return a JSON object with a "comments" array.
 */
const aiResponseSchema = z.object({
  comments: z.array(reviewCommentSchema),
});

/**
 * Alternative schema: AI might return a raw array instead of an object.
 */
const aiResponseArraySchema = z.array(reviewCommentSchema);

/** Severity ordering for filtering */
const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
  praise: 3,
};

/**
 * Parses and validates the AI response into structured review comments.
 *
 * Handles multiple response formats:
 * 1. { "comments": [...] }  — preferred format
 * 2. [...]                   — raw array
 * 3. JSON embedded in markdown code blocks
 *
 * Applies filtering based on review config (min severity, max comments, etc.)
 */
export function parseAIResponse(
  rawResponse: string,
  expectedFilename?: string
): AIReviewComment[] {
  const parsed = extractAndParseJSON(rawResponse);

  if (!parsed) {
    logger.warn(
      { responseLength: rawResponse.length },
      "Failed to parse AI response as JSON"
    );
    return [];
  }

  // --- THE FIX: Pre-process the raw JSON before strict Zod validation ---
  if (expectedFilename) {
    if (Array.isArray(parsed)) {
      parsed.forEach((c: any) => {
        if (typeof c === "object" && c !== null && !c.file) {
          c.file = expectedFilename;
        }
      });
    }  else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).comments)) {
      (parsed as any).comments.forEach((c: any) => {
        if (typeof c === "object" && c !== null && !c.file) {
          c.file = expectedFilename;
        }
      });
    }
  }
  // ----------------------------------------------------------------------

  let comments: AIReviewComment[];

  // Try parsing as { comments: [...] } first
  const objectResult = aiResponseSchema.safeParse(parsed);
  if (objectResult.success) {
    comments = objectResult.data.comments;
  } else {
    // Try parsing as a raw array
    const arrayResult = aiResponseArraySchema.safeParse(parsed);
    if (arrayResult.success) {
      comments = arrayResult.data;
    } else {
      logger.warn(
        {
          objectErrors: objectResult.error.issues.slice(0, 3),
          arrayErrors: arrayResult.error.issues.slice(0, 3),
        },
        "AI response failed schema validation"
      );

      // Attempt partial recovery: try to extract valid comments from the array
      comments = attemptPartialRecovery(parsed);
    }
  }

  // Apply severity filter from config
  const minSeverity = reviewConfig.review.minSeverityToComment;
  const minSeverityOrder = SEVERITY_ORDER[minSeverity];

  comments = comments.filter((c) => {
    const commentOrder = SEVERITY_ORDER[c.severity];
    // Always include praise if configured
    if (c.severity === "praise") {
      return reviewConfig.review.includePraise;
    }
    return commentOrder <= minSeverityOrder;
  });

  // Enforce per-file comment limit
  if (comments.length > reviewConfig.review.maxCommentsPerFile) {
    // Sort by severity (critical first) and take the top N
    comments.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
    comments = comments.slice(0, reviewConfig.review.maxCommentsPerFile);
  }

  logger.debug(
    { commentCount: comments.length, expectedFilename },
    "Parsed AI review comments"
  );

  return comments;
}

/**
 * Extracts JSON from the AI response text.
 * Handles cases where JSON is wrapped in markdown code blocks.
 */
function extractAndParseJSON(text: string): unknown {
  const trimmed = text.trim();

  // Try direct JSON parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to extraction attempts
  }

  // Try extracting from markdown code block: ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const match = codeBlockRegex.exec(trimmed);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      // Continue
    }
  }

  // Try finding the first { or [ and parsing from there
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");

  const startIndex =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

  if (startIndex !== -1) {
    const isObject = trimmed[startIndex] === "{";
    const endChar = isObject ? "}" : "]";

    // Find the matching closing character
    let depth = 0;
    for (let i = startIndex; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (char === "{" || char === "[") depth++;
      if (char === "}" || char === "]") depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(startIndex, i + 1));
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Attempts to recover valid comments from a partially valid response.
 * Iterates through array elements and keeps only those that pass validation.
 */
function attemptPartialRecovery(parsed: unknown): AIReviewComment[] {
  const comments: AIReviewComment[] = [];

  // Check if it's an object with a comments-like field
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const possibleArrays = Object.values(obj).filter(Array.isArray);
    for (const arr of possibleArrays) {
      comments.push(...recoverFromArray(arr));
    }
  } else if (Array.isArray(parsed)) {
    comments.push(...recoverFromArray(parsed));
  }

  if (comments.length > 0) {
    logger.info(
      { recoveredCount: comments.length },
      "Partially recovered valid comments from malformed AI response"
    );
  }

  return comments;
}

function recoverFromArray(arr: unknown[]): AIReviewComment[] {
  const comments: AIReviewComment[] = [];
  for (const item of arr) {
    const result = reviewCommentSchema.safeParse(item);
    if (result.success) {
      comments.push(result.data);
    }
  }
  return comments;
}