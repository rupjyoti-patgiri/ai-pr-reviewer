import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration test for the review engine.
 * Mocks external dependencies (GitHub API, OpenAI) to test the orchestration logic.
 */

// Mock env
vi.mock("../../src/config/env", () => ({
  env: {
    GITHUB_APP_ID: 12345,
    GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    GITHUB_PRIVATE_KEY_PATH: "./test-key.pem",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "gpt-4o",
    REDIS_URL: "redis://localhost:6379",
    PORT: 3000,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
  },
}));

// Mock logger
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

// Mock tiktoken
vi.mock("../../src/utils/tokenCounter", () => ({
  countTokens: (text: string) => Math.ceil(text.length / 4),
  estimateChatTokens: (sys: string, user: string) =>
    Math.ceil(sys.length / 4) + Math.ceil(user.length / 4) + 10,
  getModelMaxTokens: () => 128000,
  freeEncoder: vi.fn(),
}));

// Mock GitHub client
const mockCreateReview = vi.fn().mockResolvedValue({});
const mockCreateComment = vi.fn().mockResolvedValue({});
const mockGetPR = vi.fn().mockResolvedValue({
  data: {
    title: "Test PR",
    body: "Test description",
    base: { ref: "main" },
    head: { ref: "feature", sha: "abc123" },
    user: { login: "developer" },
    state: "open",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
});
const mockListFiles = vi.fn().mockResolvedValue({
  data: [
    {
      sha: "file1sha",
      filename: "src/app.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      changes: 7,
      patch:
        "@@ -1,5 +1,8 @@\n import express from 'express';\n \n+import cors from 'cors';\n+\n const app = express();\n+app.use(cors());\n \n app.listen(3000);",
      blob_url: "",
      raw_url: "",
      contents_url: "",
    },
    {
      sha: "file2sha",
      filename: "package-lock.json",
      status: "modified",
      additions: 500,
      deletions: 200,
      changes: 700,
      patch: "@@ -1,3 +1,3 @@\n some lock content",
      blob_url: "",
      raw_url: "",
      contents_url: "",
    },
  ],
});

vi.mock("../../src/github/client", () => ({
  createInstallationClient: () => ({
    pulls: {
      get: mockGetPR,
      listFiles: mockListFiles,
      createReview: mockCreateReview,
    },
    issues: {
      createComment: mockCreateComment,
    },
  }),
  clearClientCache: vi.fn(),
}));

// Mock rate limiter
vi.mock("../../src/utils/rateLimiter", () => ({
  githubRateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    resetRetries: vi.fn(),
    handleRateLimitError: vi.fn().mockResolvedValue(1000),
  },
  openaiRateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    resetRetries: vi.fn(),
    handleRateLimitError: vi.fn().mockResolvedValue(1000),
  },
}));

// Mock OpenAI provider
const mockReviewCode = vi.fn().mockResolvedValue({
  comments: [
    {
      file: "src/app.ts",
      line: 3,
      severity: "suggestion",
      category: "security",
      comment: "Consider configuring CORS with specific origins instead of using default (allow-all) configuration.",
      suggestion: '```suggestion\napp.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") }));\n```',
    },
    {
      file: "src/app.ts",
      line: 6,
      severity: "praise",
      category: "best-practice",
      comment: "Good addition of CORS middleware.",
    },
  ],
  tokensUsed: { prompt: 500, completion: 200, total: 700 },
  model: "gpt-4o",
  durationMs: 1500,
});

vi.mock("../../src/ai/provider", () => ({
  getAIProvider: () => ({
    name: "openai",
    reviewCode: mockReviewCode,
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  resetAIProvider: vi.fn(),
}));

import { executeReview } from "../../src/review/engine";
import type { ReviewJobData } from "../../src/review/types";

describe("Review Engine Integration", () => {
  const jobData: ReviewJobData = {
    deliveryId: "test-delivery-001",
    owner: "testowner",
    repo: "testrepo",
    pullNumber: 42,
    installationId: 12345,
    action: "opened",
    prTitle: "Test PR",
    prDescription: "Test description",
    baseBranch: "main",
    headBranch: "feature",
    headSha: "abc123def456",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default mocks
    mockListFiles.mockResolvedValue({
      data: [
        {
          sha: "file1sha",
          filename: "src/app.ts",
          status: "modified",
          additions: 5,
          deletions: 2,
          changes: 7,
          patch:
            "@@ -1,5 +1,8 @@\n import express from 'express';\n \n+import cors from 'cors';\n+\n const app = express();\n+app.use(cors());\n \n app.listen(3000);",
          blob_url: "",
          raw_url: "",
          contents_url: "",
        },
        {
          sha: "file2sha",
          filename: "package-lock.json",
          status: "modified",
          additions: 500,
          deletions: 200,
          changes: 700,
          patch: "@@ -1,3 +1,3 @@\n some lock content",
          blob_url: "",
          raw_url: "",
          contents_url: "",
        },
      ],
    });
  });

  it("should execute a full review pipeline successfully", async () => {
    const result = await executeReview(jobData);

    expect(result.owner).toBe("testowner");
    expect(result.repo).toBe("testrepo");
    expect(result.pullNumber).toBe(42);
    expect(result.filesReviewed).toBe(1); // Only src/app.ts (lock file filtered)
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1); // package-lock.json
    expect(result.comments.length).toBeGreaterThanOrEqual(1);
    expect(result.totalDurationMs).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should skip lock files and only review source files", async () => {
    const result = await executeReview(jobData);

    // AI should only be called for src/app.ts, not package-lock.json
    expect(mockReviewCode).toHaveBeenCalledTimes(1);
    expect(mockReviewCode).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "src/app.ts",
        language: "TypeScript",
      })
    );
  });

  it("should post a review on GitHub with correct parameters", async () => {
    await executeReview(jobData);

    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    expect(mockCreateReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "testowner",
        repo: "testrepo",
        pull_number: 42,
        commit_id: "abc123def456",
      })
    );
  });

  it("should handle PRs with no changed files", async () => {
    mockListFiles.mockResolvedValue({ data: [] });

    const result = await executeReview(jobData);

    expect(result.filesReviewed).toBe(0);
    expect(result.comments).toHaveLength(0);
    expect(mockReviewCode).not.toHaveBeenCalled();
    // Should post a comment explaining no files to review
    expect(mockCreateComment).toHaveBeenCalled();
  });

  it("should handle PRs where all files are filtered out", async () => {
    mockListFiles.mockResolvedValue({
      data: [
        {
          sha: "locksha",
          filename: "package-lock.json",
          status: "modified",
          additions: 100,
          deletions: 50,
          changes: 150,
          patch: "@@ -1,3 +1,3 @@\n content",
          blob_url: "",
          raw_url: "",
          contents_url: "",
        },
        {
          sha: "imgsha",
          filename: "assets/logo.png",
          status: "added",
          additions: 0,
          deletions: 0,
          changes: 0,
          patch: undefined,
          blob_url: "",
          raw_url: "",
          contents_url: "",
        },
      ],
    });

    const result = await executeReview(jobData);

    expect(result.filesReviewed).toBe(0);
    expect(result.filesSkipped).toBe(2);
    expect(mockReviewCode).not.toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalled();
  });

  it("should handle AI provider errors gracefully", async () => {
    mockReviewCode.mockRejectedValueOnce(new Error("OpenAI API error"));

    const result = await executeReview(jobData);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]!.phase).toBe("ai");
    expect(result.errors[0]!.filename).toBe("src/app.ts");
  });

  it("should include review summary in the posted review body", async () => {
    await executeReview(jobData);

    const createReviewCall = mockCreateReview.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const body = createReviewCall?.body as string | undefined;

    expect(body).toBeDefined();
    expect(body).toContain("AI Code Review Summary");
    expect(body).toContain("Files reviewed");
    expect(body).toContain("AI PR Reviewer");
  });
});