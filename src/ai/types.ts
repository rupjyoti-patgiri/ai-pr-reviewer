/**
 * TypeScript interfaces for AI-related data structures.
 */

/** Severity levels for review comments */
export type ReviewSeverity = "critical" | "warning" | "suggestion" | "praise";

/** Categories of review feedback */
export type ReviewCategory =
  | "bug"
  | "security"
  | "performance"
  | "readability"
  | "architecture"
  | "best-practice";

/** A single AI-generated review comment (raw from AI response) */
export interface AIReviewComment {
  file: string;
  line: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  comment: string;
  suggestion?: string;
}

/** The structured response from the AI provider */
export interface AIReviewResponse {
  comments: AIReviewComment[];
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  model: string;
  durationMs: number;
}

/** Input for the AI review request */
export interface AIReviewRequest {
  prTitle: string;
  prDescription: string;
  filename: string;
  language: string;
  patch: string;
}

/** Configuration for the AI provider */
export interface AIProviderConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
}

/** Abstract interface for AI providers (strategy pattern) */
export interface AIProvider {
  readonly name: string;

  /**
   * Sends a code review request to the AI provider and returns
   * structured review comments.
   */
  reviewCode(request: AIReviewRequest): Promise<AIReviewResponse>;

  /**
   * Checks if the provider is properly configured and reachable.
   */
  healthCheck(): Promise<boolean>;
}