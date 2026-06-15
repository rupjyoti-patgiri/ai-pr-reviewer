import OpenAI from "openai";
import { SYSTEM_PROMPT, buildUserPrompt, buildBatchUserPrompt } from "./prompts";
import { parseAIResponse } from "./parser";
import { openaiRateLimiter } from "../utils/rateLimiter";
import { logger } from "../utils/logger";
import { countTokens } from "../utils/tokenCounter";
import type {
  AIProvider,
  AIProviderConfig,
  AIReviewRequest,
  AIReviewResponse,
} from "./types";

/**
 * OpenAI implementation of the AIProvider interface.
 * Uses the OpenAI SDK to send code review requests to GPT-4o (or configured model).
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
  }

  /**
   * Sends a single file's diff for review.
   * Includes retry logic with exponential backoff on failures.
   */
  async reviewCode(request: AIReviewRequest): Promise<AIReviewResponse> {
    const userPrompt = buildUserPrompt(request);
    const startTime = Date.now();

    const promptTokens = countTokens(
      SYSTEM_PROMPT + userPrompt,
      this.config.model
    );

    logger.debug(
      {
        file: request.filename,
        estimatedTokens: promptTokens,
        model: this.config.model,
      },
      "Sending review request to OpenAI"
    );

    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await openaiRateLimiter.acquire();

        const response = await this.client.chat.completions.create({
          model: this.config.model,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        });

        openaiRateLimiter.resetRetries();

        const choice = response.choices[0];
        const content = choice?.message?.content ?? '{"comments": []}';

        const comments = parseAIResponse(content, request.filename);

        const durationMs = Date.now() - startTime;

        logger.info(
          {
            file: request.filename,
            commentCount: comments.length,
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens,
            durationMs,
            attempt,
          },
          "Received review from OpenAI"
        );

        return {
          comments,
          tokensUsed: {
            prompt: response.usage?.prompt_tokens ?? promptTokens,
            completion: response.usage?.completion_tokens ?? 0,
            total: response.usage?.total_tokens ?? promptTokens,
          },
          model: response.model,
          durationMs,
        };
      } catch (error) {
        lastError = error as Error;
        const err = error as { status?: number; headers?: Record<string, string> };

        // Handle rate limiting (HTTP 429)
        if (err.status === 429) {
          const retryAfter = err.headers?.["retry-after"];
          const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
          await openaiRateLimiter.handleRateLimitError(retryMs);
          logger.warn(
            { attempt, maxRetries, file: request.filename },
            "OpenAI rate limit hit — retrying"
          );
          continue;
        }

        // Handle server errors (5xx) — retry
        if (err.status && err.status >= 500) {
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          logger.warn(
            { attempt, maxRetries, status: err.status, backoffMs, file: request.filename },
            "OpenAI server error — retrying with backoff"
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // Client errors (4xx except 429) — don't retry
        logger.error(
          { error, attempt, file: request.filename },
          "OpenAI request failed with non-retryable error"
        );
        throw error;
      }
    }

    // All retries exhausted
    logger.error(
      { error: lastError, file: request.filename, maxRetries },
      "All OpenAI retry attempts exhausted"
    );
    throw lastError ?? new Error("OpenAI review failed after all retries");
  }

  /**
   * Sends multiple small files for batch review in a single API call.
   * More token-efficient for PRs with many small file changes.
   */
  async reviewBatch(
    prTitle: string,
    prDescription: string,
    files: Array<{ filename: string; language: string; patch: string }>
  ): Promise<AIReviewResponse> {
    const userPrompt = buildBatchUserPrompt(prTitle, prDescription, files);
    const startTime = Date.now();

    const promptTokens = countTokens(
      SYSTEM_PROMPT + userPrompt,
      this.config.model
    );

    logger.debug(
      {
        fileCount: files.length,
        estimatedTokens: promptTokens,
        model: this.config.model,
      },
      "Sending batch review request to OpenAI"
    );

    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await openaiRateLimiter.acquire();

        const response = await this.client.chat.completions.create({
          model: this.config.model,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        });

        openaiRateLimiter.resetRetries();

        const content =
          response.choices[0]?.message?.content ?? '{"comments": []}';
        const comments = parseAIResponse(content);
        const durationMs = Date.now() - startTime;

        logger.info(
          {
            fileCount: files.length,
            commentCount: comments.length,
            totalTokens: response.usage?.total_tokens,
            durationMs,
          },
          "Received batch review from OpenAI"
        );

        return {
          comments,
          tokensUsed: {
            prompt: response.usage?.prompt_tokens ?? promptTokens,
            completion: response.usage?.completion_tokens ?? 0,
            total: response.usage?.total_tokens ?? promptTokens,
          },
          model: response.model,
          durationMs,
        };
      } catch (error) {
        lastError = error as Error;
        const err = error as { status?: number; headers?: Record<string, string> };

        if (err.status === 429) {
          const retryAfter = err.headers?.["retry-after"];
          const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
          await openaiRateLimiter.handleRateLimitError(retryMs);
          continue;
        }

        if (err.status && err.status >= 500) {
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error("OpenAI batch review failed after all retries");
  }

  /**
   * Simple health check — makes a minimal API call to verify connectivity.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch (error) {
      logger.error({ error }, "OpenAI health check failed");
      return false;
    }
  }
}