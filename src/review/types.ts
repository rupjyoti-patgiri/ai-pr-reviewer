/**
 * TypeScript interfaces for the review engine layer.
 */

import type { ReviewSeverity, ReviewCategory } from "../ai/types";

/** A parsed chunk of a unified diff for a single file */
export interface DiffChunk {
  /** Full path of the file in the repository */
  filename: string;
  /** Detected programming language from file extension */
  language: string;
  /** Starting line number in the new (right-side) file */
  startLine: number;
  /** Ending line number in the new (right-side) file */
  endLine: number;
  /** Lines that were added (prefixed with + in diff) */
  addedLines: string[];
  /** Lines that were removed (prefixed with - in diff) */
  removedLines: string[];
  /** Surrounding unchanged context lines */
  context: string[];
  /** The raw patch text for this chunk */
  fullPatch: string;
}

/** A file that has been filtered and is ready for review */
export interface ReviewableFile {
  filename: string;
  language: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  chunks: DiffChunk[];
}

/** A review comment ready to be posted (after AI processing) */
export interface ReviewComment {
  file: string;
  line: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  comment: string;
  suggestion?: string;
}

/** Result of the full review pipeline for a single PR */
export interface ReviewResult {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  comments: ReviewComment[];
  filesReviewed: number;
  filesSkipped: number;
  totalTokensUsed: number;
  totalDurationMs: number;
  errors: ReviewError[];
}

/** An error that occurred during review of a specific file */
export interface ReviewError {
  filename: string;
  error: string;
  phase: "filter" | "parse" | "ai" | "post";
}

/** Job data passed through BullMQ */
export interface ReviewJobData {
  deliveryId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
  action: string;
  prTitle: string;
  prDescription: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

/** Reason a file was skipped during review */
export interface SkippedFile {
  filename: string;
  reason: string;
}