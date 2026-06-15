import { Router, type Request, type Response } from "express";
import { getRedisConnection } from "../../queue/connection";
import { logger } from "../../utils/logger";

const router = Router();

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  version: string;
  checks: {
    redis: { status: string; latencyMs?: number };
  };
}

/**
 * GET /health
 * Returns the health status of the application and its dependencies.
 */
router.get("/health", async (_req: Request, res: Response) => {
  const start = Date.now();
  const health: HealthStatus = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env["npm_package_version"] ?? "1.0.0",
    checks: {
      redis: { status: "unknown" },
    },
  };

  // Check Redis connectivity
  try {
    const redis = getRedisConnection();
    const pingStart = Date.now();
    await redis.ping();
    health.checks.redis = {
      status: "connected",
      latencyMs: Date.now() - pingStart,
    };
  } catch (error) {
    health.checks.redis = { status: "disconnected" };
    health.status = "degraded";
    logger.warn({ error }, "Redis health check failed");
  }

  const statusCode = health.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(health);
});

export { router as healthRouter };