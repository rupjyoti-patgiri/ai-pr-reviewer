import type { AIReviewRequest } from "./types";

/**
 * System prompt that defines the AI reviewer's persona and output format.
 * This prompt is constant across all review requests.
 */
export const SYSTEM_PROMPT = `You are an expert senior software engineer performing a code review on a GitHub Pull Request.

REVIEW CRITERIA:
- 🐛 Bugs & Logic Errors: Off-by-one errors, null/undefined risks, race conditions, infinite loops, incorrect comparisons, missing return statements
- 🔒 Security: SQL/NoSQL injection, XSS, hardcoded secrets/credentials, insecure cryptography, authentication/authorization issues, path traversal, SSRF
- ⚡ Performance: N+1 queries, unnecessary re-renders, memory leaks, O(n²) where O(n) is possible, unbounded data loading, missing pagination, excessive allocations
- 📖 Readability: Poor naming, excessive complexity, dead code, magic numbers, unclear intent, missing or misleading comments
- 🏗️ Architecture: SOLID principle violations, tight coupling, missing abstractions, incorrect layer boundaries, god objects/functions
- ✅ Best Practices: Missing error handling, weak typing, unhandled edge cases, test coverage gaps, missing input validation, incorrect async patterns

RESPONSE FORMAT:
You MUST respond with a JSON object containing a "comments" array. Each element must have:
{
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "warning" | "suggestion" | "praise",
      "category": "bug" | "security" | "performance" | "readability" | "architecture" | "best-practice",
      "comment": "Clear, specific explanation of the issue or praise",
      "suggestion": "\`\`\`suggestion\\n<corrected code>\\n\`\`\`"
    }
  ]
}

RULES:
1. ONLY comment on changed lines (lines prefixed with + in the diff). Never comment on unchanged context lines.
2. Be specific — reference exact variable names, function names, and line numbers.
3. Include actionable fix suggestions using GitHub's suggestion block format when possible.
4. If the code is well-written, include a "praise" comment acknowledging good patterns.
5. Do NOT nitpick formatting or style issues (assume a formatter like Prettier handles this).
6. Return {"comments": []} if there are no meaningful comments.
7. Limit to the top 15 most impactful comments per file.
8. Prioritize by impact: critical bugs > security issues > performance > readability > architecture > best practices.
9. For each issue, explain WHY it's a problem, not just WHAT is wrong.
10. Consider the PR context (title, description) to understand the intent of the changes.`;

/**
 * Constructs the user prompt for a specific code review request.
 * Contains the PR context and the actual diff to review.
 */
export function buildUserPrompt(request: AIReviewRequest): string {
  const descriptionSection = request.prDescription.trim()
    ? `PR Description: ${request.prDescription.trim()}`
    : "PR Description: (none provided)";

  return `PR Title: ${request.prTitle}
${descriptionSection}
File: ${request.filename} (Language: ${request.language})

Diff:
\`\`\`diff
${request.patch}
\`\`\`

Review this code change and provide your review in the specified JSON format.`;
}

/**
 * Constructs a user prompt for batch review (multiple small files at once).
 */
export function buildBatchUserPrompt(
  prTitle: string,
  prDescription: string,
  files: Array<{ filename: string; language: string; patch: string }>
): string {
  const descriptionSection = prDescription.trim()
    ? `PR Description: ${prDescription.trim()}`
    : "PR Description: (none provided)";

  const fileSections = files
    .map(
      (f) =>
        `### File: ${f.filename} (Language: ${f.language})\n\`\`\`diff\n${f.patch}\n\`\`\``
    )
    .join("\n\n");

  return `PR Title: ${prTitle}
${descriptionSection}

The following files are part of the same PR. Review all of them:

${fileSections}

Review these code changes and provide your review in the specified JSON format. Include the correct file path for each comment.`;
}