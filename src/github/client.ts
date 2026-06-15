import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { env } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Cache of Octokit instances keyed by installation ID.
 * Installation tokens are valid for 1 hour; we cache the client
 * and let @octokit/auth-app handle token refresh automatically.
 */
const clientCache = new Map<
  number,
  { client: Octokit; createdAt: number }
>();

/** Cache TTL: 50 minutes (tokens last 60 min, refresh early) */
const CACHE_TTL_MS = 50 * 60 * 1000;

/**
 * Creates an Octokit client authenticated as the GitHub App itself (JWT).
 * Used for app-level API calls (not installation-specific).
 */
export function createAppClient(): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
    },
    log: {
      debug: (msg: string) => logger.debug({ component: "octokit" }, msg),
      info: (msg: string) => logger.info({ component: "octokit" }, msg),
      warn: (msg: string) => logger.warn({ component: "octokit" }, msg),
      error: (msg: string) => logger.error({ component: "octokit" }, msg),
    },
  });
}

/**
 * Creates an Octokit client authenticated as a specific GitHub App installation.
 * This is the primary client used for all PR operations.
 *
 * Caches instances per installation ID and automatically handles token refresh.
 */
export function createInstallationClient(installationId: number): Octokit {
  const now = Date.now();
  const cached = clientCache.get(installationId);

  if (cached && now - cached.createdAt < CACHE_TTL_MS) {
    logger.debug(
      { installationId },
      "Using cached Octokit installation client"
    );
    return cached.client;
  }

  logger.debug(
    { installationId },
    "Creating new Octokit installation client"
  );

  const client = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    },
    log: {
      debug: (msg: string) => logger.debug({ component: "octokit", installationId }, msg),
      info: (msg: string) => logger.info({ component: "octokit", installationId }, msg),
      warn: (msg: string) => logger.warn({ component: "octokit", installationId }, msg),
      error: (msg: string) => logger.error({ component: "octokit", installationId }, msg),
    },
    // Custom retry logic for transient failures
    retry: {
      enabled: true,
      retries: 3,
    },
    throttle: {
      enabled: false, // We handle rate limiting ourselves
    },
  });

  clientCache.set(installationId, { client, createdAt: now });

  // Clean up stale entries periodically
  if (clientCache.size > 100) {
    for (const [id, entry] of clientCache.entries()) {
      if (now - entry.createdAt > CACHE_TTL_MS) {
        clientCache.delete(id);
      }
    }
  }

  return client;
}

/**
 * Clears the client cache. Useful for testing and shutdown.
 */
export function clearClientCache(): void {
  clientCache.clear();
}