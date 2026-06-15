import { Worker, type Job } from "bullmq";
import { createWorkerConnection } from "./connection";
import { executeReview } from "../review/engine";
import { reviewConfig } from "../config/reviewRules";
import { logger, createPRLogger } from "../utils/logger";
import type { ReviewJobData, ReviewResult } from "../review/types";

/**
 * Queue name — must match the producer queue name.
 */
const QUEUE_NAME = "pr-review";

/**
 * Singleton worker instance.
 */
let worker: Worker<ReviewJobData, ReviewResult> | null = null;

/**
 * Starts the BullMQ worker that processes review jobs.
 *
 * Features:
 * - Concurrency control (from review config)
 * - Per-job structured logging
 * - Graceful error handling with automatic retries
 * - Lock duration extended for long-running reviews
 */
export function startReviewWorker(): void {
  if (worker) {
    logger.warn("Review worker already running");
    return;
  }

  const connection = createWorkerConnection();

  worker = new Worker<ReviewJobData, ReviewResult>(
    QUEUE_NAME,
    async (job: Job<ReviewJobData, ReviewResult>) => {
      const data = job.data;

      const prLogger = createPRLogger({
        requestId: data.deliveryId,
        owner: data.owner,
        repo: data.repo,
        prNumber: data.pullNumber,
      });

      prLogger.info(
        {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          action: data.action,
        },
        "Processing review job"
      );

      try {
        // Update job progress
        await job.updateProgress(10);

        const result = await executeReview(data);

        await job.updateProgress(100);

        prLogger.info(
          {
            jobId: job.id,
            filesReviewed: result.filesReviewed,
            commentCount: result.comments.length,
            totalTokens: result.totalTokensUsed,
            durationMs: result.totalDurationMs,
            errors: result.errors.length,
          },
          "Review job completed successfully"
        );

        return result;
      } catch (error) {
        prLogger.error(
          {
            jobId: job.id,
            error,
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts,
          },
          "Review job failed"
        );
        throw error; // BullMQ will handle retry based on job options
      }
    },
    {
      connection: connection as any,
      concurrency: reviewConfig.rateLimit.maxConcurrentReviews,
      // Extend lock for long-running reviews (AI calls can be slow)
      lockDuration: 5 * 60 * 1000, // 5 minutes
      lockRenewTime: 2 * 60 * 1000, // Renew every 2 minutes
      // Stalled job detection
      stalledInterval: 60 * 1000, // Check every 60 seconds
      maxStalledCount: 2, // Allow 2 stalls before marking as failed
    }
  );

  // Worker event handlers
  worker.on("completed", (job) => {
    logger.info(
      {
        jobId: job.id,
        owner: job.data.owner,
        repo: job.data.repo,
        pullNumber: job.data.pullNumber,
      },
      "Job completed"
    );
  });

  worker.on("failed", (job, error) => {
    if (job) {
      logger.error(
        {
          jobId: job.id,
          owner: job.data.owner,
          repo: job.data.repo,
          pullNumber: job.data.pullNumber,
          error: error.message,
          attempt: job.attemptsMade,
        },
        "Job failed"
      );
    } else {
      logger.error({ error: error.message }, "Job failed (no job reference)");
    }
  });

  worker.on("stalled", (jobId) => {
    logger.warn({ jobId }, "Job stalled — will be retried");
  });

  worker.on("error", (error) => {
    logger.error({ error }, "Worker error");
  });

  worker.on("ready", () => {
    logger.info(
      {
        queue: QUEUE_NAME,
        concurrency: reviewConfig.rateLimit.maxConcurrentReviews,
      },
      "Review worker is ready and listening for jobs"
    );
  });

  logger.info(
    {
      queue: QUEUE_NAME,
      concurrency: reviewConfig.rateLimit.maxConcurrentReviews,
      lockDuration: "5m",
    },
    "Review worker started"
  );
}

/**
 * Gracefully stops the review worker.
 * Waits for the current job to complete before shutting down.
 */
export async function stopReviewWorker(): Promise<void> {
  if (worker) {
    logger.info("Stopping review worker (waiting for current jobs to finish)...");
    await worker.close();
    worker = null;
    logger.info("Review worker stopped");
  }
}


