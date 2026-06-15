import { describe, it, expect } from "vitest";
import { parseAIResponse } from "../../src/ai/parser";

describe("parseAIResponse", () => {
  it("should parse a valid JSON object response with comments array", () => {
    const response = JSON.stringify({
      comments: [
        {
          file: "src/app.ts",
          line: 10,
          severity: "warning",
          category: "bug",
          comment: "Potential null reference",
          suggestion: "```suggestion\nif (x != null) { ... }\n```",
        },
      ],
    });

    const comments = parseAIResponse(response);

    expect(comments).toHaveLength(1);
    expect(comments[0]!.file).toBe("src/app.ts");
    expect(comments[0]!.line).toBe(10);
    expect(comments[0]!.severity).toBe("warning");
    expect(comments[0]!.category).toBe("bug");
    expect(comments[0]!.comment).toBe("Potential null reference");
    expect(comments[0]!.suggestion).toBeDefined();
  });

  it("should parse a raw JSON array response", () => {
    const response = JSON.stringify([
      {
        file: "src/utils.ts",
        line: 5,
        severity: "suggestion",
        category: "readability",
        comment: "Consider using a more descriptive name",
      },
    ]);

    const comments = parseAIResponse(response);

    expect(comments).toHaveLength(1);
    expect(comments[0]!.severity).toBe("suggestion");
  });

  it("should handle JSON embedded in markdown code blocks", () => {
    const response = `Here's my review:

\`\`\`json
{
  "comments": [
    {
      "file": "src/index.ts",
      "line": 1,
      "severity": "praise",
      "category": "best-practice",
      "comment": "Good use of strict mode"
    }
  ]
}
\`\`\``;

    const comments = parseAIResponse(response);

    expect(comments).toHaveLength(1);
    expect(comments[0]!.severity).toBe("praise");
  });

  it("should return empty array for empty comments", () => {
    const response = JSON.stringify({ comments: [] });

    const comments = parseAIResponse(response);

    expect(comments).toEqual([]);
  });

  it("should return empty array for invalid JSON", () => {
    const comments = parseAIResponse("This is not JSON at all.");

    expect(comments).toEqual([]);
  });

  it("should return empty array for completely garbled input", () => {
    const comments = parseAIResponse("{{{invalid}}}");

    expect(comments).toEqual([]);
  });

  it("should fix missing file field when expectedFilename is provided", () => {
    const response = JSON.stringify({
      comments: [
        {
          file: "",
          line: 15,
          severity: "critical",
          category: "security",
          comment: "Hardcoded API key detected",
        },
      ],
    });

    const comments = parseAIResponse(response, "src/config.ts");

    expect(comments).toHaveLength(1);
    expect(comments[0]!.file).toBe("src/config.ts");
  });

  it("should handle partial recovery from mixed valid/invalid items", () => {
    const response = JSON.stringify({
      comments: [
        {
          file: "src/app.ts",
          line: 10,
          severity: "warning",
          category: "bug",
          comment: "Valid comment",
        },
        {
          // Invalid: missing required fields
          file: "src/app.ts",
          severity: "invalid_severity",
        },
        {
          file: "src/app.ts",
          line: 20,
          severity: "suggestion",
          category: "readability",
          comment: "Another valid comment",
        },
      ],
    });

    const comments = parseAIResponse(response);

    // Should recover at least the valid comments
    expect(comments.length).toBeGreaterThanOrEqual(2);
  });

  it("should enforce max comments per file limit", () => {
    // Create a response with more comments than the configured max (15)
    const manyComments = Array.from({ length: 25 }, (_, i) => ({
      file: "src/big-file.ts",
      line: i + 1,
      severity: "suggestion" as const,
      category: "readability" as const,
      comment: `Comment ${i + 1}`,
    }));

    const response = JSON.stringify({ comments: manyComments });
    const comments = parseAIResponse(response);

    // Should be limited to maxCommentsPerFile (default: 15)
    expect(comments.length).toBeLessThanOrEqual(15);
  });

  it("should filter by minimum severity from config", () => {
    const response = JSON.stringify({
      comments: [
        {
          file: "src/app.ts",
          line: 1,
          severity: "critical",
          category: "bug",
          comment: "Critical issue",
        },
        {
          file: "src/app.ts",
          line: 2,
          severity: "warning",
          category: "performance",
          comment: "Performance issue",
        },
        {
          file: "src/app.ts",
          line: 3,
          severity: "suggestion",
          category: "readability",
          comment: "Style suggestion",
        },
      ],
    });

    const comments = parseAIResponse(response);

    // With default minSeverity of "suggestion", all should be included
    expect(comments.length).toBeGreaterThanOrEqual(3);
  });
});