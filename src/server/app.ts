import express, { type Express } from "express";
import { webhookRouter } from "./routes/webhook";
import { healthRouter } from "./routes/health";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "../utils/logger";

/**
 * Creates and configures the Express application.
 *
 * Key setup:
 * - Raw body capture for webhook signature verification
 * - JSON parsing with body size limit
 * - Health check and webhook routes
 * - Global error handler
 */
export function createApp(): Express {
  const app = express();

  // Parse JSON bodies and capture the raw buffer for signature verification
  app.use(
    express.json({
      limit: "5mb",
      verify: (req, _res, buf) => {
        // Store raw body for HMAC signature verification
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;

    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          durationMs: duration,
          deliveryId,
        },
        "Request completed"
      );
    });

    next();
  });

  // Routes
  app.use(healthRouter);
  app.use(webhookRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}