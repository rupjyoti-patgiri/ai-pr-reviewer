import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Singleton Redis connection for BullMQ.
 *
 * BullMQ requires an ioredis instance. We create a single connection
 * and share it across the queue producer and worker.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Connection event logging
 * - Graceful shutdown support
 */

let redisConnection: IORedis | null = null;

/**
 * Initializes the Redis connection.
 * Should be called once at application startup.
 */
export async function initializeRedisConnection(): Promise<void> {
  if (redisConnection) {
    logger.warn("Redis connection already initialized");
    return;
  }

  const isUpstash = env.REDIS_URL.includes("upstash.io");

  redisConnection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: true,
    tls: isUpstash ? {} : undefined, // Upstash requires TLS
    retryStrategy: (times: number) => {
      if (times > 20) {
        logger.fatal(
          { retryAttempt: times },
          "Redis connection failed after 20 retries — giving up"
        );
        return null; // Stop retrying
      }
      const delay = Math.min(times * 500, 10000);
      logger.warn(
        { retryAttempt: times, delayMs: delay },
        "Retrying Redis connection..."
      );
      return delay;
    },
    lazyConnect: false,
  });

  // Connection event handlers
  redisConnection.on("connect", () => {
    logger.info("Redis connection established");
  });

  redisConnection.on("ready", () => {
    logger.info("Redis is ready to accept commands");
  });

  redisConnection.on("error", (error) => {
    logger.error({ error }, "Redis connection error");
  });

  redisConnection.on("close", () => {
    logger.warn("Redis connection closed");
  });

  redisConnection.on("reconnecting", () => {
    logger.info("Redis reconnecting...");
  });

  // Wait for the connection to be ready
  await new Promise<void>((resolve, reject) => {
    if (!redisConnection) {
      reject(new Error("Redis connection is null"));
      return;
    }

    if (redisConnection.status === "ready") {
      resolve();
      return;
    }

    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      redisConnection?.removeListener("ready", onReady);
      redisConnection?.removeListener("error", onError);
    };

    redisConnection.once("ready", onReady);
    redisConnection.once("error", onError);
  });
}

/**
 * Returns the shared Redis connection.
 * Throws if not initialized.
 */
export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    throw new Error(
      "Redis connection not initialized. Call initializeRedisConnection() first."
    );
  }
  return redisConnection;
}

/**
 * Creates a new, separate Redis connection for BullMQ workers.
 * Workers need their own connection (BullMQ requirement).
 */
export function createWorkerConnection(): IORedis {
  const isUpstash = env.REDIS_URL.includes("upstash.io");

  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    tls: isUpstash ? {} : undefined, // Upstash requires TLS
    retryStrategy: (times: number) => {
      if (times > 20) return null;
      return Math.min(times * 500, 10000);
    },
  });

  connection.on("error", (error) => {
    logger.error({ error, type: "worker" }, "Worker Redis connection error");
  });

  return connection;
}

/**
 * Gracefully closes the Redis connection.
 * Should be called during application shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    logger.info("Redis connection closed gracefully");
  }
}