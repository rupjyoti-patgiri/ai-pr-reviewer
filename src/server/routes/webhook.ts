import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { verifySignature } from "../middleware/verifySignature";
import { enqueueReviewJob } from "../../queue/reviewQueue";
import { logger } from "../../utils/logger";
import type { PullRequestWebhookPayload } from "../../github/types";

const router = Router();

/** Actions that should trigger a code review */
const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * POST /webhook
 * Receives GitHub webhook events, validates them, and enqueues review jobs.
 */
router.post(
  "/webhook",
  verifySignature,
  async (req: Request, res: Response) => {
    const deliveryId =
      (req.headers["x-github-delivery"] as string) ??
      crypto.randomUUID();
    const eventType = req.headers["x-github-event"] as string | undefined;

    const childLogger = logger.child({ deliveryId, eventType });

    // Only process pull_request events
    if (eventType !== "pull_request") {
      childLogger.debug("Ignoring non-pull_request event");
      res.status(200).json({ message: "Event ignored", eventType });
      return;
    }

    const payload = req.body as PullRequestWebhookPayload;
    const action = payload.action;

    // Only process reviewable actions
    if (!REVIEWABLE_ACTIONS.has(action)) {
      childLogger.debug({ action }, "Ignoring non-reviewable PR action");
      res
        .status(200)
        .json({ message: "Action ignored", action });
      return;
    }

    const { repository, pull_request: pr, installation } = payload;

    if (!repository || !pr || !installation) {
      childLogger.warn("Malformed webhook payload — missing required fields");
      res.status(400).json({ error: "Malformed payload" });
      return;
    }

    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pr.number;
    const installationId = installation.id;

    childLogger.info(
      { owner, repo, pullNumber, action, installationId },
      "Received reviewable PR event — enqueuing review job"
    );

    try {
      const jobId = await enqueueReviewJob({
        deliveryId,
        owner,
        repo,
        pullNumber,
        installationId,
        action,
        prTitle: pr.title,
        prDescription: pr.body ?? "",
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
      });

      childLogger.info({ jobId }, "Review job enqueued successfully");

      res.status(202).json({
        message: "Review job enqueued",
        jobId,
        deliveryId,
      });
    } catch (error) {
      childLogger.error({ error }, "Failed to enqueue review job");
      res.status(500).json({ error: "Failed to enqueue review job" });
    }
  }
);

export { router as webhookRouter };