import { Queue } from "bullmq";
import { getRedisConnection } from "./connection";
import { logger } from "../utils/logger";
import type { ReviewJobData } from "../review/types";

/**
 * Queue name constant.
 * All review jobs are processed through this single queue.
 */
const QUEUE_NAME = "pr-review";

/**
 * Singleton BullMQ queue instance.
 * Lazily initialized on first use.
 */
let reviewQueue: Queue<ReviewJobData> | null = null;

/**
 * Returns the singleton review queue instance.
 */
function getQueue(): Queue<ReviewJobData> {
  if (!reviewQueue) {
    const connection = getRedisConnection();
    reviewQueue = new Queue<ReviewJobData>(QUEUE_NAME, {
      connection: connection as any,
      defaultJobOptions: {
        // Retry failed jobs with exponential backoff
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000, // Start with 5s, then 10s, then 20s
        },
        // Remove completed jobs after 24 hours
        removeOnComplete: {
          age: 24 * 60 * 60, // 24 hours in seconds
          count: 1000, // Keep last 1000 completed jobs
        },
        // Keep failed jobs for 7 days for debugging
        removeOnFail: {
          age: 7 * 24 * 60 * 60, // 7 days
          count: 500,
        },
      },
    });

    reviewQueue!.on("error", (error) => {
      logger.error({ error, queue: QUEUE_NAME }, "Queue error");
    });

    logger.info({ queue: QUEUE_NAME }, "Review queue initialized");
  }

  return reviewQueue as any;
}

/**
 * Enqueues a new PR review job.
 *
 * Uses a composite job ID based on owner/repo/PR#/headSha to ensure
 * idempotency — if the same PR event is received twice (e.g., due to
 * webhook retry), it won't create duplicate jobs.
 *
 * @returns The job ID
 */
export async function enqueueReviewJob(
  data: ReviewJobData
): Promise<string> {
  const queue = getQueue();

  // Idempotent job ID: prevents duplicate reviews for the same commit
  const jobId = `review-${data.owner}-${data.repo}-${data.pullNumber}-${data.headSha}`;

  // Check if a job with this ID already exists and is active/waiting
  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      logger.info(
        {
          jobId,
          state,
          owner: data.owner,
          repo: data.repo,
          pullNumber: data.pullNumber,
        },
        "Duplicate review job detected — skipping enqueue"
      );
      return jobId;
    }
  }

  const job = await queue.add("review", data, {
    jobId,
    priority: data.action === "opened" ? 1 : 2, // New PRs get higher priority
  });

  logger.info(
    {
      jobId: job.id,
      owner: data.owner,
      repo: data.repo,
      pullNumber: data.pullNumber,
      action: data.action,
    },
    "Review job enqueued"
  );

  return job.id ?? jobId;
}

/**
 * Closes the queue connection. Call during shutdown.
 */
export async function closeReviewQueue(): Promise<void> {
  if (reviewQueue) {
    await reviewQueue.close();
    reviewQueue = null;
    logger.info("Review queue closed");
  }
}