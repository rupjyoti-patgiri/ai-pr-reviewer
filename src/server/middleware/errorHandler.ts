import type { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";

/**
 * Express error-handling middleware.
 * Catches all unhandled errors, logs them, and returns a clean JSON response.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const deliveryId =
    (req.headers["x-github-delivery"] as string | undefined) ?? "unknown";
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? deliveryId;

  logger.error(
    {
      err,
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
    },
    "Unhandled error in request pipeline"
  );

  // Don't leak error details in production
  const isProduction = process.env["NODE_ENV"] === "production";

  res.status(500).json({
    error: "Internal server error",
    message: isProduction ? undefined : err.message,
    requestId,
  });
}