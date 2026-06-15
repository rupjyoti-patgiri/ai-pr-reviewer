import { createInstallationClient } from "../github/client";
import { fetchPRMetadata, fetchPRFiles } from "../github/pullRequest";
import {
  postReview,
  postPRComment,
  mapToGitHubComments,
  generateReviewSummary,
} from "../github/comments";
import { getAIProvider } from "../ai/provider";
import { OpenAIProvider } from "../ai/openai";
import { filterFiles, detectLanguage } from "./fileFilter";
import { parseDiff, mergeAdjacentChunks } from "./diffParser";
import { applyChunkStrategy } from "./chunkStrategy";
import { reviewConfig } from "../config/reviewRules";
import { createPRLogger } from "../utils/logger";
import { estimateChatTokens } from "../utils/tokenCounter";
import { SYSTEM_PROMPT, buildUserPrompt } from "../ai/prompts";
import type { ReviewJobData, ReviewResult, ReviewComment, ReviewError, ReviewableFile } from "./types";
import type { AIReviewComment, AIReviewRequest } from "../ai/types";

/**
 * Core review engine — orchestrates the entire code review pipeline.
 *
 * Pipeline:
 * 1. Authenticate as GitHub App installation
 * 2. Fetch PR metadata and changed files
 * 3. Filter and parse diffs
 * 4. Send to AI for review (with smart chunking)
 * 5. Collect and deduplicate comments
 * 6. Post the review on the PR
 */
export async function executeReview(job: ReviewJobData): Promise<ReviewResult> {
  const prLogger = createPRLogger({
    requestId: job.deliveryId,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.pullNumber,
  });

  const startTime = Date.now();
  const allComments: ReviewComment[] = [];
  const errors: ReviewError[] = [];
  let totalTokensUsed = 0;

  prLogger.info(
    { action: job.action, headSha: job.headSha },
    "Starting PR review"
  );

  try {
    // Step 1: Authenticate
    const octokit = createInstallationClient(job.installationId);
    prLogger.debug("Authenticated as GitHub App installation");

    // Step 2: Fetch PR data
    const [metadata, files] = await Promise.all([
      fetchPRMetadata(octokit, job.owner, job.repo, job.pullNumber),
      fetchPRFiles(octokit, job.owner, job.repo, job.pullNumber),
    ]);

    prLogger.info(
      {
        title: metadata.title,
        author: metadata.author,
        fileCount: files.length,
        baseBranch: metadata.baseBranch,
        headBranch: metadata.headBranch,
      },
      "Fetched PR metadata and files"
    );

    // Handle empty PRs
    if (files.length === 0) {
      prLogger.info("PR has no changed files — skipping review");
      await postPRComment(
        octokit,
        job.owner,
        job.repo,
        job.pullNumber,
        "🤖 **AI PR Reviewer**: No changed files to review in this PR."
      );
      return {
        owner: job.owner,
        repo: job.repo,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        comments: [],
        filesReviewed: 0,
        filesSkipped: 0,
        totalTokensUsed: 0,
        totalDurationMs: Date.now() - startTime,
        errors: [],
      };
    }

    // Step 3: Filter files
    const { reviewable, skipped } = filterFiles(files);

    if (reviewable.length === 0) {
      prLogger.info(
        { skippedCount: skipped.length },
        "All files were filtered out — skipping review"
      );
      await postPRComment(
        octokit,
        job.owner,
        job.repo,
        job.pullNumber,
        `🤖 **AI PR Reviewer**: All ${files.length} changed file(s) were filtered out (lock files, generated code, binary files, etc.). Nothing to review.`
      );
      return {
        owner: job.owner,
        repo: job.repo,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        comments: [],
        filesReviewed: 0,
        filesSkipped: skipped.length,
        totalTokensUsed: 0,
        totalDurationMs: Date.now() - startTime,
        errors: [],
      };
    }

    // Step 4: Parse diffs and prepare reviewable files
    const reviewableFiles: ReviewableFile[] = reviewable
      .filter((f) => f.patch)
      .map((f) => {
        const rawChunks = parseDiff(f.filename, f.patch!);
        const mergedChunks = mergeAdjacentChunks(rawChunks);
        return {
          filename: f.filename,
          language: detectLanguage(f.filename),
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch!,
          chunks: mergedChunks,
        };
      });

    prLogger.info(
      {
        reviewableFiles: reviewableFiles.length,
        skippedFiles: skipped.length,
        totalChunks: reviewableFiles.reduce((sum, f) => sum + f.chunks.length, 0),
      },
      "Diffs parsed and ready for AI review"
    );

    // Step 5: AI Review — process each file
    const aiProvider = getAIProvider();
    const model = reviewConfig.ai.model;

    // Separate files into those that can be batched and those that need individual processing
    const { batchable, individual } = categorizeBySizeForBatching(
      reviewableFiles,
      model
    );

    // Process individually-chunked large files
    for (const file of individual) {
      try {
        const fileComments = await reviewFileWithChunking(
          file,
          job,
          aiProvider,
          model
        );
        allComments.push(...fileComments.comments);
        totalTokensUsed += fileComments.tokensUsed;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        prLogger.error(
          { error, filename: file.filename },
          "Failed to review file"
        );
        errors.push({
          filename: file.filename,
          error: errMsg,
          phase: "ai",
        });
      }

      // Delay between API calls to respect rate limits
      if (reviewConfig.rateLimit.delayBetweenApiCalls > 0) {
        await sleep(reviewConfig.rateLimit.delayBetweenApiCalls);
      }
    }

    // Process small files in batches
    if (batchable.length > 0 && aiProvider instanceof OpenAIProvider) {
      try {
        const batchComments = await reviewBatchFiles(
          batchable,
          job,
          aiProvider,
          model
        );
        allComments.push(...batchComments.comments);
        totalTokensUsed += batchComments.tokensUsed;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        prLogger.error({ error }, "Failed to batch review files");
        // Fallback: review each batchable file individually
        for (const file of batchable) {
          try {
            const fileComments = await reviewFileWithChunking(
              file,
              job,
              aiProvider,
              model
            );
            allComments.push(...fileComments.comments);
            totalTokensUsed += fileComments.tokensUsed;
          } catch (innerError) {
            const innerErrMsg = innerError instanceof Error ? innerError.message : String(innerError);
            errors.push({
              filename: file.filename,
              error: innerErrMsg,
              phase: "ai",
            });
          }
        }
      }
    } else {
      // No batch support — review each batchable file individually too
      for (const file of batchable) {
        try {
          const fileComments = await reviewFileWithChunking(
            file,
            job,
            aiProvider,
            model
          );
          allComments.push(...fileComments.comments);
          totalTokensUsed += fileComments.tokensUsed;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          errors.push({
            filename: file.filename,
            error: errMsg,
            phase: "ai",
          });
        }

        if (reviewConfig.rateLimit.delayBetweenApiCalls > 0) {
          await sleep(reviewConfig.rateLimit.delayBetweenApiCalls);
        }
      }
    }

    // Step 6: Enforce total comment limit and deduplicate
    const finalComments = deduplicateAndLimit(allComments);

    prLogger.info(
      {
        totalComments: finalComments.length,
        totalTokensUsed,
        filesReviewed: reviewableFiles.length,
        filesSkipped: skipped.length,
        errorCount: errors.length,
      },
      "AI review complete — posting results"
    );

    // Step 7: Post the review
    if (finalComments.length > 0 || errors.length === 0) {
      const githubComments = mapToGitHubComments(finalComments);
      const summaryBody = generateReviewSummary(
        finalComments,
        reviewableFiles.length,
        skipped.length
      );

      // Determine review event type
      const hasCritical = finalComments.some(
        (c) => c.severity === "critical"
      );
      const event =
        hasCritical && reviewConfig.review.autoRequestChanges
          ? "REQUEST_CHANGES" as const
          : "COMMENT" as const;

      await postReview(octokit, {
        owner: job.owner,
        repo: job.repo,
        pullNumber: job.pullNumber,
        event,
        body: summaryBody,
        comments: githubComments,
        commitId: job.headSha,
      });

      prLogger.info(
        { event, commentCount: githubComments.length },
        "Review posted successfully"
      );
    } else {
      // All files errored — post an error comment
      await postPRComment(
        octokit,
        job.owner,
        job.repo,
        job.pullNumber,
        `🤖 **AI PR Reviewer**: Review encountered errors for all files. Please check the logs.\n\n` +
          errors.map((e) => `- \`${e.filename}\`: ${e.error}`).join("\n")
      );
    }

    const totalDurationMs = Date.now() - startTime;
    prLogger.info(
      { totalDurationMs, totalTokensUsed },
      "Review pipeline completed"
    );

    return {
      owner: job.owner,
      repo: job.repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      comments: finalComments,
      filesReviewed: reviewableFiles.length,
      filesSkipped: skipped.length,
      totalTokensUsed,
      totalDurationMs,
      errors,
    };
  } catch (error) {
    const totalDurationMs = Date.now() - startTime;
    prLogger.error(
      { error, totalDurationMs },
      "Review pipeline failed"
    );

    // Attempt to notify the PR about the failure
    try {
      const octokit = createInstallationClient(job.installationId);
      await postPRComment(
        octokit,
        job.owner,
        job.repo,
        job.pullNumber,
        `🤖 **AI PR Reviewer**: Review failed due to an internal error. The team has been notified.\n\n` +
          `> Error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } catch {
      prLogger.error("Failed to post error comment on PR");
    }

    throw error;
  }
}

/**
 * Reviews a single file, applying chunking strategy if the diff is too large.
 */
async function reviewFileWithChunking(
  file: ReviewableFile,
  job: ReviewJobData,
  aiProvider: ReturnType<typeof getAIProvider>,
  model: string
): Promise<{ comments: ReviewComment[]; tokensUsed: number }> {
  const chunks = file.chunks;

  if (chunks.length === 0) {
    return { comments: [], tokensUsed: 0 };
  }

  // Apply chunking strategy to split into API-call-sized batches
  const batches = applyChunkStrategy(chunks, model);
  const allComments: ReviewComment[] = [];
  let tokensUsed = 0;

  for (const batch of batches) {
    // Combine batch chunks into a single patch for the API call
    const combinedPatch = batch.map((c) => c.fullPatch).join("\n\n");

    const request: AIReviewRequest = {
      prTitle: job.prTitle,
      prDescription: job.prDescription,
      filename: file.filename,
      language: file.language,
      patch: combinedPatch,
    };

    const response = await aiProvider.reviewCode(request);

    const comments: ReviewComment[] = response.comments.map((c) => ({
      file: c.file || file.filename,
      line: c.line,
      severity: c.severity,
      category: c.category,
      comment: c.comment,
      suggestion: c.suggestion,
    }));

    allComments.push(...comments);
    tokensUsed += response.tokensUsed.total;
  }

  return { comments: allComments, tokensUsed };
}

/**
 * Reviews multiple small files in a single batch API call.
 */
async function reviewBatchFiles(
  files: ReviewableFile[],
  job: ReviewJobData,
  aiProvider: OpenAIProvider,
  model: string
): Promise<{ comments: ReviewComment[]; tokensUsed: number }> {
  const fileInputs = files.map((f) => ({
    filename: f.filename,
    language: f.language,
    patch: f.patch,
  }));

  const response = await aiProvider.reviewBatch(
    job.prTitle,
    job.prDescription,
    fileInputs
  );

  const comments: ReviewComment[] = response.comments.map((c) => ({
    file: c.file,
    line: c.line,
    severity: c.severity,
    category: c.category,
    comment: c.comment,
    suggestion: c.suggestion,
  }));

  return { comments, tokensUsed: response.tokensUsed.total };
}

/**
 * Categorizes files into batchable (small) and individual (large) groups.
 * Small files can be sent together in one API call for efficiency.
 */
function categorizeBySizeForBatching(
  files: ReviewableFile[],
  model: string
): { batchable: ReviewableFile[]; individual: ReviewableFile[] } {
  const BATCH_THRESHOLD_TOKENS = 2000; // Files under this can be batched
  const batchable: ReviewableFile[] = [];
  const individual: ReviewableFile[] = [];

  for (const file of files) {
    const userPrompt = buildUserPrompt({
      prTitle: "",
      prDescription: "",
      filename: file.filename,
      language: file.language,
      patch: file.patch,
    });
    const tokens = estimateChatTokens(SYSTEM_PROMPT, userPrompt, model);

    if (tokens <= BATCH_THRESHOLD_TOKENS) {
      batchable.push(file);
    } else {
      individual.push(file);
    }
  }

  return { batchable, individual };
}

/**
 * Deduplicates comments (same file + same line) and enforces the global comment limit.
 */
function deduplicateAndLimit(comments: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  const unique: ReviewComment[] = [];

  for (const comment of comments) {
    const key = `${comment.file}:${comment.line}:${comment.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(comment);
    }
  }

  // Sort by severity priority (critical first)
  const severityOrder: Record<string, number> = {
    critical: 0,
    warning: 1,
    suggestion: 2,
    praise: 3,
  };

  unique.sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99)
  );

  // Enforce global comment limit
  const maxTotal = reviewConfig.review.maxTotalComments;
  if (unique.length > maxTotal) {
    return unique.slice(0, maxTotal);
  }

  return unique;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}