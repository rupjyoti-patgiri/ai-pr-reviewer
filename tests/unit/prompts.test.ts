import { describe, it, expect } from "vitest";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  buildBatchUserPrompt,
} from "../../src/ai/prompts";

describe("SYSTEM_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(SYSTEM_PROMPT).toBeDefined();
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("should contain review criteria categories", () => {
    expect(SYSTEM_PROMPT).toContain("Bugs");
    expect(SYSTEM_PROMPT).toContain("Security");
    expect(SYSTEM_PROMPT).toContain("Performance");
    expect(SYSTEM_PROMPT).toContain("Readability");
    expect(SYSTEM_PROMPT).toContain("Architecture");
    expect(SYSTEM_PROMPT).toContain("Best Practices");
  });

  it("should specify the JSON response format", () => {
    expect(SYSTEM_PROMPT).toContain("JSON");
    expect(SYSTEM_PROMPT).toContain('"file"');
    expect(SYSTEM_PROMPT).toContain('"line"');
    expect(SYSTEM_PROMPT).toContain('"severity"');
    expect(SYSTEM_PROMPT).toContain('"category"');
    expect(SYSTEM_PROMPT).toContain('"comment"');
  });

  it("should include severity levels", () => {
    expect(SYSTEM_PROMPT).toContain("critical");
    expect(SYSTEM_PROMPT).toContain("warning");
    expect(SYSTEM_PROMPT).toContain("suggestion");
    expect(SYSTEM_PROMPT).toContain("praise");
  });

  it("should instruct to only comment on changed lines", () => {
    expect(SYSTEM_PROMPT).toContain("changed lines");
  });

  it("should instruct not to nitpick formatting", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("nitpick");
  });
});

describe("buildUserPrompt", () => {
  it("should include PR title", () => {
    const prompt = buildUserPrompt({
      prTitle: "Add user authentication",
      prDescription: "Implements JWT auth",
      filename: "src/auth.ts",
      language: "TypeScript",
      patch: "+const token = jwt.sign(payload, secret);",
    });

    expect(prompt).toContain("Add user authentication");
  });

  it("should include PR description", () => {
    const prompt = buildUserPrompt({
      prTitle: "Fix bug",
      prDescription: "Fixes the null pointer in user service",
      filename: "src/user.ts",
      language: "TypeScript",
      patch: "+if (user) { return user.name; }",
    });

    expect(prompt).toContain("Fixes the null pointer in user service");
  });

  it("should handle empty description gracefully", () => {
    const prompt = buildUserPrompt({
      prTitle: "Quick fix",
      prDescription: "",
      filename: "src/fix.ts",
      language: "TypeScript",
      patch: "+return true;",
    });

    expect(prompt).toContain("none provided");
  });

  it("should include filename and language", () => {
    const prompt = buildUserPrompt({
      prTitle: "Test",
      prDescription: "Test",
      filename: "src/deep/nested/module.py",
      language: "Python",
      patch: "+def hello(): pass",
    });

    expect(prompt).toContain("src/deep/nested/module.py");
    expect(prompt).toContain("Python");
  });

  it("should include the diff in a code block", () => {
    const patch = "+const x = 42;\n+const y = x * 2;";
    const prompt = buildUserPrompt({
      prTitle: "Test",
      prDescription: "",
      filename: "file.ts",
      language: "TypeScript",
      patch,
    });

    expect(prompt).toContain("```diff");
    expect(prompt).toContain(patch);
    expect(prompt).toContain("```");
  });
});

describe("buildBatchUserPrompt", () => {
  it("should include all file patches", () => {
    const files = [
      { filename: "src/a.ts", language: "TypeScript", patch: "+line1" },
      { filename: "src/b.py", language: "Python", patch: "+line2" },
    ];

    const prompt = buildBatchUserPrompt("Test PR", "Description", files);

    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("+line1");
    expect(prompt).toContain("src/b.py");
    expect(prompt).toContain("Python");
    expect(prompt).toContain("+line2");
  });

  it("should include PR context", () => {
    const prompt = buildBatchUserPrompt(
      "Feature: Multi-file change",
      "Refactoring utils",
      [{ filename: "a.ts", language: "TypeScript", patch: "+x" }]
    );

    expect(prompt).toContain("Feature: Multi-file change");
    expect(prompt).toContain("Refactoring utils");
  });

  it("should handle empty description in batch prompt", () => {
    const prompt = buildBatchUserPrompt("Title", "", [
      { filename: "a.ts", language: "TypeScript", patch: "+x" },
    ]);

    expect(prompt).toContain("none provided");
  });
});