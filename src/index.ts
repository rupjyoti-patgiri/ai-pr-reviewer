import { createApp } from "./server/app";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { initializeRedisConnection, closeRedisConnection } from "./queue/connection";
import { startReviewWorker, stopReviewWorker } from "./queue/reviewWorker";
import { freeEncoder } from "./utils/tokenCounter";

/**
 * Application entry point.
 * Starts the Express server, initializes Redis, and starts the BullMQ worker.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      model: env.OPENAI_MODEL,
    },
    "🚀 Starting AI PR Reviewer..."
  );

  // Initialize Redis connection
  await initializeRedisConnection();
  logger.info("✅ Redis connected");

  // Start the BullMQ worker for processing review jobs
  startReviewWorker();
  logger.info("✅ Review worker started");

  // Create and start the Express server
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT },
      `✅ Webhook server listening on port ${env.PORT}`
    );
    logger.info("🎉 AI PR Reviewer is ready to receive webhooks!");
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "⏳ Shutting down gracefully...");

    // 1. Stop accepting new HTTP connections
    server.close(() => {
      logger.info("HTTP server closed");
    });

    // 2. Stop the BullMQ worker (wait for current job to finish)
    try {
      await stopReviewWorker();
      logger.info("Review worker stopped");
    } catch (error) {
      logger.error({ error }, "Error stopping review worker");
    }

    // 3. Close Redis connection
    try {
      await closeRedisConnection();
      logger.info("Redis connection closed");
    } catch (error) {
      logger.error({ error }, "Error closing Redis connection");
    }

    // 4. Free tiktoken encoder
    freeEncoder();

    logger.info("👋 Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Handle unhandled rejections
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection — shutting down");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ error }, "Uncaught exception — shutting down");
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  logger.fatal({ error }, "❌ Failed to start AI PR Reviewer");
  process.exit(1);
});