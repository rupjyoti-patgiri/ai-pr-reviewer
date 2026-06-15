import { logger } from "./logger";

/**
 * Simple sliding-window rate limiter with exponential backoff.
 * Used to respect GitHub API (5000 req/hr) and OpenAI rate limits.
 */
interface RateLimiterConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Name for logging */
  name: string;
}

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private timestamps: number[] = [];
  private consecutiveRetries: number = 0;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  /**
   * Waits until a request can be made within the rate limit.
   * Automatically applies backoff pressure if close to the limit.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Remove timestamps outside the current window
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length >= this.config.maxRequests) {
      // Calculate wait time: when the oldest request in window expires
      const oldestInWindow = this.timestamps[0];
      if (oldestInWindow !== undefined) {
        const waitTime = oldestInWindow + this.config.windowMs - now + 100; // +100ms buffer
        logger.warn(
          {
            limiter: this.config.name,
            waitMs: waitTime,
            currentCount: this.timestamps.length,
            maxRequests: this.config.maxRequests,
          },
          "Rate limit reached — waiting before next request"
        );
        await this.sleep(waitTime);
      }
    }

    this.timestamps.push(Date.now());
    this.consecutiveRetries = 0;
  }

  /**
   * Handles a rate-limit error (HTTP 429 or similar).
   * Applies exponential backoff and waits before the caller retries.
   * Returns the wait time in ms.
   */
  async handleRateLimitError(retryAfterMs?: number): Promise<number> {
    this.consecutiveRetries++;
    const baseDelay = retryAfterMs ?? 1000;
    const backoffDelay =
      baseDelay * Math.pow(2, this.consecutiveRetries - 1);
    const jitter = Math.random() * 1000;
    const totalDelay = Math.min(backoffDelay + jitter, 60000); // Cap at 60s

    logger.warn(
      {
        limiter: this.config.name,
        retryNumber: this.consecutiveRetries,
        delayMs: Math.round(totalDelay),
      },
      "Applying exponential backoff after rate limit error"
    );

    await this.sleep(totalDelay);
    return totalDelay;
  }

  /**
   * Resets the consecutive retry counter (call after a successful request).
   */
  resetRetries(): void {
    this.consecutiveRetries = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Pre-configured rate limiters for external APIs.
 */
export const githubRateLimiter = new RateLimiter({
  maxRequests: 4500, // Stay under 5000/hr limit with buffer
  windowMs: 60 * 60 * 1000,
  name: "github-api",
});

export const openaiRateLimiter = new RateLimiter({
  maxRequests: 500, // Conservative default — adjust per your OpenAI tier
  windowMs: 60 * 1000,
  name: "openai-api",
});