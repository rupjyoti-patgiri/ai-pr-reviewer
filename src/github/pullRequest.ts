import type { Octokit } from "@octokit/rest";
import { githubRateLimiter } from "../utils/rateLimiter";
import { logger } from "../utils/logger";
import type { PRFile, PRMetadata } from "./types";

/**
 * Fetches full PR metadata from the GitHub API.
 */
export async function fetchPRMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PRMetadata> {
  await githubRateLimiter.acquire();

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  githubRateLimiter.resetRetries();

  return {
    owner,
    repo,
    pullNumber,
    title: data.title,
    description: data.body ?? "",
    baseBranch: data.base.ref,
    headBranch: data.head.ref,
    headSha: data.head.sha,
    author: data.user?.login ?? "unknown",
    state: data.state,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

/**
 * Fetches all changed files in a PR, handling pagination automatically.
 * GitHub returns a maximum of 3000 files and 300 per page.
 */
export async function fetchPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PRFile[]> {
  const allFiles: PRFile[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    await githubRateLimiter.acquire();

    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });

    githubRateLimiter.resetRetries();

    if (data.length === 0) {
      break;
    }

    const files: PRFile[] = data.map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status as PRFile["status"],
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
      blob_url: file.blob_url,
      raw_url: file.raw_url,
      contents_url: file.contents_url,
      previous_filename: file.previous_filename,
    }));

    allFiles.push(...files);

    // If we got fewer than perPage results, we've reached the end
    if (data.length < perPage) {
      break;
    }

    page++;

    // Safety limit: GitHub caps at 3000 files
    if (allFiles.length >= 3000) {
      logger.warn(
        { owner, repo, pullNumber, fileCount: allFiles.length },
        "PR has 3000+ files — GitHub API limit reached"
      );
      break;
    }
  }

  logger.info(
    { owner, repo, pullNumber, fileCount: allFiles.length },
    "Fetched PR changed files"
  );

  return allFiles;
}

/**
 * Fetches the raw content of a specific file at a given commit SHA.
 * Useful when we need the full file for context (not just the diff).
 */
export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    await githubRateLimiter.acquire();

    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    githubRateLimiter.resetRetries();

    // getContent returns file data with base64 content
    if ("content" in data && typeof data.content === "string") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }

    return null;
  } catch (error) {
    const err = error as { status?: number };
    if (err.status === 404) {
      logger.debug({ path, ref }, "File not found at ref (possibly deleted)");
      return null;
    }
    throw error;
  }
}