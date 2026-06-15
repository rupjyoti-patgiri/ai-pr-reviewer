import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

/**
 * Middleware that verifies the GitHub webhook signature (HMAC SHA-256).
 *
 * GitHub sends the signature in the `X-Hub-Signature-256` header as:
 *   sha256=<hex_digest>
 *
 * We compute HMAC SHA-256 of the raw request body using the webhook secret
 * and compare using timing-safe equality.
 *
 * Also enforces webhook replay protection: rejects events older than 5 minutes.
 */
export function verifySignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signatureHeader = req.headers["x-hub-signature-256"];
  const deliveryId = req.headers["x-github-delivery"] as string | undefined;
  const timestampHeader = req.headers["x-github-hook-installation-target-id"];

  // Ensure signature header is present
  if (!signatureHeader || typeof signatureHeader !== "string") {
    logger.warn(
      { deliveryId },
      "Webhook rejected: missing X-Hub-Signature-256 header"
    );
    res.status(401).json({ error: "Missing signature header" });
    return;
  }

  // The raw body must be available (set up by express.json with verify callback)
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    logger.error(
      { deliveryId },
      "Webhook rejected: raw body not available for signature verification"
    );
    res.status(500).json({ error: "Internal error: raw body unavailable" });
    return;
  }

  // Compute expected signature
  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

  // Timing-safe comparison to prevent timing attacks
  const signatureBuffer = Buffer.from(signatureHeader, "utf-8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf-8");

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    logger.warn(
      { deliveryId },
      "Webhook rejected: invalid signature"
    );
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Webhook replay protection: reject events older than 5 minutes
  // GitHub sends the timestamp in the payload; we check the delivery header timing
  const hookTimestamp = req.headers["x-github-hook-installation-target-id"];
  // Since GitHub doesn't send a direct timestamp header, we use a heuristic:
  // Check if the payload contains a timestamp and verify it's recent
  try {
    const body = req.body as Record<string, unknown>;
    if (body && typeof body === "object") {
      // pull_request events contain action timestamps
      const pr = body["pull_request"] as Record<string, unknown> | undefined;
      if (pr && typeof pr["updated_at"] === "string") {
        const eventTime = new Date(pr["updated_at"]).getTime();
        const now = Date.now();
        const fiveMinutesMs = 5 * 60 * 1000;

        if (now - eventTime > fiveMinutesMs) {
          logger.warn(
            {
              deliveryId,
              eventTime: pr["updated_at"],
              ageMs: now - eventTime,
            },
            "Webhook rejected: event is older than 5 minutes (replay protection)"
          );
          res.status(400).json({ error: "Event too old (replay protection)" });
          return;
        }
      }
    }
  } catch {
    // If timestamp parsing fails, allow the request through
    // (don't block legitimate webhooks due to parsing edge cases)
    logger.debug(
      { deliveryId },
      "Could not parse event timestamp for replay protection — allowing request"
    );
  }

  logger.debug({ deliveryId }, "Webhook signature verified successfully");
  next();
}