/**
 * TypeScript interfaces for GitHub-related data structures.
 * These map to the GitHub API response shapes we use.
 */

/** Webhook payload for pull_request events */
export interface PullRequestWebhookPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    head: {
      ref: string;
      sha: string;
      repo: {
        full_name: string;
      };
    };
    base: {
      ref: string;
      sha: string;
      repo: {
        full_name: string;
      };
    };
    user: {
      login: string;
    };
    updated_at: string;
    created_at: string;
  };
  repository: {
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
    private: boolean;
  };
  installation: {
    id: number;
  };
  sender: {
    login: string;
  };
}

/** A single changed file in a pull request */
export interface PRFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  previous_filename?: string;
}

/** PR metadata fetched from GitHub */
export interface PRMetadata {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  author: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

/** A single review comment to be posted on the PR */
export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** The full review submission payload */
export interface GitHubReviewSubmission {
  owner: string;
  repo: string;
  pullNumber: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
  commitId: string;
}

/** Installation authentication context */
export interface InstallationAuth {
  installationId: number;
  token: string;
  expiresAt: string;
}