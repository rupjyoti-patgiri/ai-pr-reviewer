import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import express from "express";
import type { Express } from "express";

/**
 * Mock all external dependencies before importing the app.
 */

// Mock environment variables
vi.mock("../../src/config/env", () => ({
  env: {
    GITHUB_APP_ID: 12345,
    GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    GITHUB_PRIVATE_KEY_PATH: "./test-key.pem",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_MODEL: "gpt-4o",
    REDIS_URL: "redis://localhost:6379",
    PORT: 3000,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
}));

// Mock the logger to suppress output during tests
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  createPRLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Redis connection for health check
vi.mock("../../src/queue/connection", () => ({
  getRedisConnection: () => ({
    ping: vi.fn().mockResolvedValue("PONG"),
  }),
  initializeRedisConnection: vi.fn(),
  closeRedisConnection: vi.fn(),
}));

// Mock the review queue
const mockEnqueueReviewJob = vi.fn().mockResolvedValue("job-123");
vi.mock("../../src/queue/reviewQueue", () => ({
  enqueueReviewJob: (...args: unknown[]) => mockEnqueueReviewJob(...args),
}));

import { createApp } from "../../src/server/app";

const WEBHOOK_SECRET = "test-webhook-secret";

/**
 * Helper: creates a valid GitHub webhook signature for a payload.
 */
function signPayload(payload: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")
  );
}

/**
 * Helper: makes a webhook request to the app.
 */
async function sendWebhook(
  app: Express,
  payload: Record<string, unknown>,
  options: {
    event?: string;
    signature?: string;
    deliveryId?: string;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  // We need to use a real HTTP request because the raw body
  // is captured during express.json() parsing.
  // For testing, we'll use a lightweight approach with supertest-like behavior.

  return new Promise((resolve, reject) => {
    const http = require("http");
    const server = http.createServer(app);

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 0;
      const bodyStr = JSON.stringify(payload);
      const sig = options.signature ?? signPayload(bodyStr);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/webhook",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            "X-Hub-Signature-256": sig,
            "X-GitHub-Event": options.event ?? "pull_request",
            "X-GitHub-Delivery": options.deliveryId ?? "test-delivery-123",
          },
        },
        (res: typeof http.IncomingMessage) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            server.close();
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(data),
              });
            } catch {
              resolve({
                status: res.statusCode,
                body: { raw: data },
              });
            }
          });
        }
      );

      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });

      req.write(bodyStr);
      req.end();
    });
  });
}

/**
 * Creates a valid pull_request webhook payload.
 */
function createPRPayload(
  action: string = "opened",
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    action,
    pull_request: {
      number: 42,
      title: "Add new feature",
      body: "This PR adds a cool feature",
      state: "open",
      head: {
        ref: "feature/cool",
        sha: "abc123def456",
        repo: { full_name: "owner/repo" },
      },
      base: {
        ref: "main",
        sha: "base123",
        repo: { full_name: "owner/repo" },
      },
      user: { login: "developer" },
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    repository: {
      name: "repo",
      full_name: "owner/repo",
      owner: { login: "owner" },
      private: true,
    },
    installation: { id: 98765 },
    sender: { login: "developer" },
    ...overrides,
  };
}

describe("Webhook Endpoint", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it("should return 202 for a valid opened PR webhook", async () => {
    const payload = createPRPayload("opened");
    const result = await sendWebhook(app, payload);

    expect(result.status).toBe(202);
    expect(result.body).toHaveProperty("jobId");
    expect(result.body).toHaveProperty("message", "Review job enqueued");
    expect(mockEnqueueReviewJob).toHaveBeenCalled();
  });

  it("should return 202 for synchronize action", async () => {
    mockEnqueueReviewJob.mockClear();
    const payload = createPRPayload("synchronize");
    const result = await sendWebhook(app, payload);

    expect(result.status).toBe(202);
    expect(mockEnqueueReviewJob).toHaveBeenCalled();
  });

  it("should return 202 for reopened action", async () => {
    mockEnqueueReviewJob.mockClear();
    const payload = createPRPayload("reopened");
    const result = await sendWebhook(app, payload);

    expect(result.status).toBe(202);
    expect(mockEnqueueReviewJob).toHaveBeenCalled();
  });

  it("should return 200 and ignore non-reviewable actions", async () => {
    mockEnqueueReviewJob.mockClear();
    const payload = createPRPayload("closed");
    const result = await sendWebhook(app, payload);

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("message", "Action ignored");
    expect(mockEnqueueReviewJob).not.toHaveBeenCalled();
  });

  it("should return 200 and ignore non-pull_request events", async () => {
    mockEnqueueReviewJob.mockClear();
    const payload = { action: "created", issue: {} };
    const result = await sendWebhook(app, payload, { event: "issues" });

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("message", "Event ignored");
    expect(mockEnqueueReviewJob).not.toHaveBeenCalled();
  });

  it("should return 401 for missing signature", async () => {
    const payload = createPRPayload("opened");
    const result = await sendWebhook(app, payload, { signature: "" });

    // Empty string signature should fail
    expect(result.status).toBe(401);
  });

  it("should return 401 for invalid signature", async () => {
    const payload = createPRPayload("opened");
    const result = await sendWebhook(app, payload, {
      signature: "sha256=invalid_signature_here",
    });

    expect(result.status).toBe(401);
  });

  it("should pass correct job data to the queue", async () => {
    mockEnqueueReviewJob.mockClear();
    const payload = createPRPayload("opened");
    await sendWebhook(app, payload);

    expect(mockEnqueueReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        installationId: 98765,
        action: "opened",
        prTitle: "Add new feature",
        headSha: "abc123def456",
      })
    );
  });
});

describe("Health Endpoint", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it("should return 200 with health status", async () => {
    return new Promise<void>((resolve, reject) => {
      const http = require("http");
      const server = http.createServer(app);

      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === "object" ? address?.port : 0;

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            method: "GET",
          },
          (res: typeof http.IncomingMessage) => {
            let data = "";
            res.on("data", (chunk: string) => {
              data += chunk;
            });
            res.on("end", () => {
              server.close();
              try {
                const body = JSON.parse(data);
                expect(res.statusCode).toBe(200);
                expect(body).toHaveProperty("status");
                expect(body).toHaveProperty("uptime");
                expect(body).toHaveProperty("checks");
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          }
        );

        req.on("error", (err: Error) => {
          server.close();
          reject(err);
        });

        req.end();
      });
    });
  });
});