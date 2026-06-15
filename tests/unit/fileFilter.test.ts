import { describe, it, expect } from "vitest";
import { filterFiles, detectLanguage } from "../../src/review/fileFilter";
import type { PRFile } from "../../src/github/types";

/**
 * Helper to create a mock PRFile with sensible defaults.
 */
function mockFile(overrides: Partial<PRFile> & { filename: string }): PRFile {
  return {
    sha: "abc123",
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1,3 +1,4 @@\n line1\n+added\n line2\n line3",
    blob_url: "",
    raw_url: "",
    contents_url: "",
    ...overrides,
  };
}

describe("detectLanguage", () => {
  it("should detect TypeScript from .ts extension", () => {
    expect(detectLanguage("src/app.ts")).toBe("TypeScript");
  });

  it("should detect TypeScript React from .tsx extension", () => {
    expect(detectLanguage("components/Button.tsx")).toBe("TypeScript React");
  });

  it("should detect Python from .py extension", () => {
    expect(detectLanguage("scripts/deploy.py")).toBe("Python");
  });

  it("should detect Go from .go extension", () => {
    expect(detectLanguage("main.go")).toBe("Go");
  });

  it("should detect Rust from .rs extension", () => {
    expect(detectLanguage("src/lib.rs")).toBe("Rust");
  });

  it("should handle Dockerfile (no extension)", () => {
    expect(detectLanguage("Dockerfile")).toBe("Dockerfile");
  });

  it("should handle Makefile (no extension)", () => {
    expect(detectLanguage("Makefile")).toBe("Makefile");
  });

  it("should return 'Unknown' for unrecognized extensions", () => {
    expect(detectLanguage("data.xyz123")).toBe("Unknown");
  });

  it("should be case-insensitive for extensions", () => {
    expect(detectLanguage("README.MD")).toBe("Markdown");
  });

  it("should handle deeply nested paths", () => {
    expect(detectLanguage("src/utils/helpers/format.ts")).toBe("TypeScript");
  });
});

describe("filterFiles", () => {
  it("should keep reviewable source files", () => {
    const files = [
      mockFile({ filename: "src/app.ts" }),
      mockFile({ filename: "src/utils/helper.ts" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("should skip deleted files", () => {
    const files = [
      mockFile({ filename: "src/old.ts", status: "removed" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("deleted");
  });

  it("should skip binary files by extension", () => {
    const files = [
      mockFile({ filename: "assets/logo.png" }),
      mockFile({ filename: "fonts/arial.woff2" }),
      mockFile({ filename: "docs/guide.pdf" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(3);
    skipped.forEach((s) => expect(s.reason).toContain("Binary"));
  });

  it("should skip lock files via ignore patterns", () => {
    const files = [
      mockFile({ filename: "package-lock.json" }),
      mockFile({ filename: "yarn.lock" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("should skip files matching dist/ and build/ patterns", () => {
    const files = [
      mockFile({ filename: "dist/bundle.js" }),
      mockFile({ filename: "build/output.css" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("should skip minified files", () => {
    const files = [
      mockFile({ filename: "public/app.min.js" }),
      mockFile({ filename: "styles/theme.min.css" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("should skip source map files", () => {
    const files = [mockFile({ filename: "dist/app.js.map" })];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("should skip files without patch data", () => {
    const files = [
      mockFile({ filename: "src/app.ts", patch: undefined }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("No patch data");
  });

  it("should skip files exceeding max changed lines", () => {
    const files = [
      mockFile({
        filename: "src/huge.ts",
        changes: 99999,
      }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("Too many changes");
  });

  it("should handle a mix of reviewable and non-reviewable files", () => {
    const files = [
      mockFile({ filename: "src/app.ts" }),
      mockFile({ filename: "package-lock.json" }),
      mockFile({ filename: "assets/image.png" }),
      mockFile({ filename: "src/utils.ts" }),
      mockFile({ filename: "src/deleted.ts", status: "removed" }),
    ];

    const { reviewable, skipped } = filterFiles(files);

    expect(reviewable).toHaveLength(2);
    expect(skipped).toHaveLength(3);
    expect(reviewable.map((f) => f.filename)).toEqual([
      "src/app.ts",
      "src/utils.ts",
    ]);
  });
});