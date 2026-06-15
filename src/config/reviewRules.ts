import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod";
import { logger } from "../utils/logger";

/**
 * Zod schema for the review-config.yaml structure.
 * Provides defaults so the app works even with a minimal config file.
 */
const reviewConfigSchema = z.object({
  ai: z
    .object({
      provider: z.enum(["openai"]).default("openai"),
      model: z.string().default("gpt-4o"),
      temperature: z.number().min(0).max(2).default(0.1),
      maxTokensPerRequest: z.number().int().positive().default(4096),
    })
    .default({}),

  files: z
    .object({
      maxChangedLines: z.number().int().positive().default(500),
      maxFileSize: z.number().int().positive().default(10000),
      ignorePatterns: z.array(z.string()).default([
        "**/*.lock",
        "**/package-lock.json",
        "**/*.min.js",
        "**/*.min.css",
        "**/*.map",
        "**/dist/**",
        "**/build/**",
        "**/node_modules/**",
        "**/*.png",
        "**/*.jpg",
        "**/*.svg",
        "**/*.ico",
        "**/*.woff*",
        "**/*.ttf",
      ]),
      includePatterns: z.array(z.string()).default([]),
    })
    .default({}),

  review: z
    .object({
      maxCommentsPerFile: z.number().int().positive().default(15),
      maxTotalComments: z.number().int().positive().default(50),
      minSeverityToComment: z
        .enum(["critical", "warning", "suggestion"])
        .default("suggestion"),
      autoRequestChanges: z.boolean().default(true),
      includePraise: z.boolean().default(true),
    })
    .default({}),

  rateLimit: z
    .object({
      maxConcurrentReviews: z.number().int().positive().default(3),
      delayBetweenApiCalls: z.number().int().nonnegative().default(500),
    })
    .default({}),
});

export type ReviewConfig = z.infer<typeof reviewConfigSchema>;

/**
 * Loads review rules from review-config.yaml.
 * Falls back to defaults if the file is missing or malformed.
 */
function loadReviewConfig(): ReviewConfig {
  const configPath = path.resolve(
    process.cwd(),
    "review-config.yaml"
  );

  try {
    if (!fs.existsSync(configPath)) {
      logger.warn(
        { configPath },
        "review-config.yaml not found — using default configuration"
      );
      return reviewConfigSchema.parse({});
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw);

    const result = reviewConfigSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        { errors: result.error.issues },
        "review-config.yaml has validation errors — falling back to defaults for invalid fields"
      );
      // Still attempt a partial parse with defaults
      return reviewConfigSchema.parse(parsed ?? {});
    }

    logger.info({ configPath }, "Loaded review configuration");
    return result.data;
  } catch (error) {
    logger.error(
      { error, configPath },
      "Failed to load review-config.yaml — using defaults"
    );
    return reviewConfigSchema.parse({});
  }
}

/** Singleton review configuration */
export const reviewConfig = loadReviewConfig();