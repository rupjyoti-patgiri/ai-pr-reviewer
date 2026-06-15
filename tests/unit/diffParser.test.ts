import { describe, it, expect } from "vitest";
import { parseDiff, mergeAdjacentChunks } from "../../src/review/diffParser";

describe("parseDiff", () => {
  it("should parse a simple single-hunk diff", () => {
    const patch = `@@ -1,5 +1,6 @@
 import express from 'express';
 
+import cors from 'cors';
 const app = express();
 
 app.get('/', (req, res) => {`;

    const chunks = parseDiff("src/app.ts", patch);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.filename).toBe("src/app.ts");
    expect(chunks[0]!.language).toBe("TypeScript");
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.addedLines).toContain("import cors from 'cors';");
    expect(chunks[0]!.removedLines).toHaveLength(0);
    expect(chunks[0]!.context.length).toBeGreaterThan(0);
  });

  it("should parse a multi-hunk diff into separate chunks", () => {
    const patch = `@@ -1,3 +1,4 @@
 line1
+added1
 line2
 line3
@@ -20,3 +21,4 @@
 line20
+added2
 line21
 line22`;

    const chunks = parseDiff("file.js", patch);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.addedLines).toEqual(["added1"]);
    expect(chunks[1]!.startLine).toBe(21);
    expect(chunks[1]!.addedLines).toEqual(["added2"]);
  });

  it("should handle diff with both additions and deletions", () => {
    const patch = `@@ -5,7 +5,7 @@
 const config = {
   port: 3000,
-  host: 'localhost',
+  host: '0.0.0.0',
   debug: false,
 };`;

    const chunks = parseDiff("config.ts", patch);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.addedLines).toEqual(["  host: '0.0.0.0',"]);
    expect(chunks[0]!.removedLines).toEqual(["  host: 'localhost',"]);
  });

  it("should handle new file diffs (no old file lines)", () => {
    const patch = `@@ -0,0 +1,3 @@
+export const VERSION = '1.0.0';
+export const NAME = 'ai-reviewer';
+export const AUTHOR = 'team';`;

    const chunks = parseDiff("src/version.ts", patch);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.addedLines).toHaveLength(3);
    expect(chunks[0]!.removedLines).toHaveLength(0);
    expect(chunks[0]!.context).toHaveLength(0);
  });

  it("should return empty array for empty patch", () => {
    expect(parseDiff("file.ts", "")).toEqual([]);
    expect(parseDiff("file.ts", "   ")).toEqual([]);
  });

  it("should detect language correctly from filename", () => {
    const patch = `@@ -1,2 +1,3 @@
 def hello():
+    print("world")
     pass`;

    const chunks = parseDiff("app/main.py", patch);
    expect(chunks[0]!.language).toBe("Python");
  });

  it("should handle diff with 'No newline at end of file' marker", () => {
    const patch = `@@ -1,2 +1,3 @@
 line1
+line2
 line3
\\ No newline at end of file`;

    const chunks = parseDiff("file.txt", patch);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.addedLines).toEqual(["line2"]);
  });
});

describe("mergeAdjacentChunks", () => {
  it("should merge chunks that are close together", () => {
    const chunks = [
      {
        filename: "file.ts",
        language: "TypeScript",
        startLine: 1,
        endLine: 5,
        addedLines: ["a"],
        removedLines: [],
        context: ["ctx"],
        fullPatch: "patch1",
      },
      {
        filename: "file.ts",
        language: "TypeScript",
        startLine: 10,
        endLine: 15,
        addedLines: ["b"],
        removedLines: [],
        context: ["ctx2"],
        fullPatch: "patch2",
      },
    ];

    const merged = mergeAdjacentChunks(chunks, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.addedLines).toEqual(["a", "b"]);
    expect(merged[0]!.startLine).toBe(1);
    expect(merged[0]!.endLine).toBe(15);
  });

  it("should NOT merge chunks that are far apart", () => {
    const chunks = [
      {
        filename: "file.ts",
        language: "TypeScript",
        startLine: 1,
        endLine: 5,
        addedLines: ["a"],
        removedLines: [],
        context: [],
        fullPatch: "patch1",
      },
      {
        filename: "file.ts",
        language: "TypeScript",
        startLine: 100,
        endLine: 105,
        addedLines: ["b"],
        removedLines: [],
        context: [],
        fullPatch: "patch2",
      },
    ];

    const merged = mergeAdjacentChunks(chunks, 10);

    expect(merged).toHaveLength(2);
  });

  it("should return the same chunk if only one is provided", () => {
    const chunks = [
      {
        filename: "file.ts",
        language: "TypeScript",
        startLine: 1,
        endLine: 5,
        addedLines: ["a"],
        removedLines: [],
        context: [],
        fullPatch: "patch1",
      },
    ];

    const merged = mergeAdjacentChunks(chunks);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(chunks[0]);
  });

  it("should return empty array for empty input", () => {
    expect(mergeAdjacentChunks([])).toEqual([]);
  });
});