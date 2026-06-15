import pino from "pino";

/**
 * Structured JSON logger using Pino.
 * In development, uses pino-pretty for human-readable output.
 * In production, outputs raw JSON for log aggregation systems.
 */
const logLevel = process.env["LOG_LEVEL"] ?? "info";
const nodeEnv = process.env["NODE_ENV"] ?? "production";

export const logger = pino({
  level: logLevel,
  transport:
    nodeEnv === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  base: {
    service: "ai-pr-reviewer",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
});

/**
 * Creates a child logger with PR-specific context.
 * Used throughout the review pipeline for traceable logs.
 */
export function createPRLogger(context: {
  requestId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): pino.Logger {
  return logger.child({
    requestId: context.requestId,
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
  });
}