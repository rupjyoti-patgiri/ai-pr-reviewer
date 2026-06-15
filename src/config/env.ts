import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z } from "zod";

// Load .env file in non-production environments
dotenv.config();

/**
 * Zod schema for validating all required environment variables.
 * Ensures the app fails fast on startup if misconfigured.
 */
const envSchema = z.object({
  // GitHub App
  GITHUB_APP_ID: z
    .string()
    .min(1, "GITHUB_APP_ID is required")
    .transform(Number)
    .pipe(z.number().positive("GITHUB_APP_ID must be a positive number")),

  GITHUB_PRIVATE_KEY_PATH: z
    .string()
    .default("./private-key.pem"),

  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(1, "GITHUB_WEBHOOK_SECRET is required"),

  // OpenAI
  OPENAI_API_KEY: z
    .string()
    .min(1, "OPENAI_API_KEY is required"),

  OPENAI_MODEL: z
    .string()
    .default("gpt-4o"),

  // Redis
  REDIS_URL: z
    .string()
    .url("REDIS_URL must be a valid URL")
    .default("redis://localhost:6379"),

  // Server
  PORT: z
    .string()
    .default("3000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("production"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates environment variables and reads the GitHub App private key.
 * Throws a descriptive error if validation fails.
 */
function loadAndValidateEnv(): EnvConfig & { GITHUB_PRIVATE_KEY: string } {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `❌ Environment variable validation failed:\n${formatted}`
    );
  }

  const config = result.data;

  // Read the GitHub App private key from disk
  let privateKey: string;

  if (process.env["GITHUB_PRIVATE_KEY"]) {
    privateKey = process.env["GITHUB_PRIVATE_KEY"].replace(/\\n/g, "\n");
    if (!privateKey.includes("BEGIN")) {
      throw new Error(
        `❌ GITHUB_PRIVATE_KEY environment variable does not contain a valid PEM key.`
      );
    }
  } else {
    const keyPath = path.resolve(config.GITHUB_PRIVATE_KEY_PATH);
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        `❌ GitHub private key file not found at: ${keyPath}\n` +
        `  Generate one in your GitHub App settings and save it to this path.`
      );
    }
    privateKey = fs.readFileSync(keyPath, "utf-8");
    if (!privateKey.includes("BEGIN")) {
      throw new Error(
        `❌ GitHub private key at ${keyPath} does not appear to be a valid PEM file.`
      );
    }
  }

  return {
    ...config,
    GITHUB_PRIVATE_KEY: privateKey,
  };
}

/** Singleton validated environment configuration */
export const env = loadAndValidateEnv();