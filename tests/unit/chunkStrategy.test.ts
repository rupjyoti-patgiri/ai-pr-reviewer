import { describe, it, expect, vi } from "vitest";
import { applyChunkStrategy } from "../../src/review/chunkStrategy";
import type { DiffChunk } from "../../src/review/types";

/**
 * Mock tiktoken to avoid loading WASM in tests.
 * We approximate: 1 token ≈ 4 characters.
 */
vi.mock("../../src/utils/tokenCounter", () => ({
  countTokens: (text: string) => Math.ceil(text.length / 4),
  estimateChatTokens: (sys: string, user: string) =>
    Math.ceil(sys.length / 4) + Math.ceil(user.length / 4) + 10,
  getModelMaxTokens: () => 128000,
  freeEncoder: vi.fn(),
}));

function createChunk(
  filename: string,
  patchSize: number,
  startLine: number = 1
): DiffChunk {
  const patchContent = "+" + "a".repeat(patchSize);
  return {
    filename,
    language: "TypeScript",
    startLine,
    endLine: startLine + 10,
    addedLines: [patchContent],
    removedLines: [],
    context: [],
    fullPatch: patchContent,
  };
}

describe("applyChunkStrategy", () => {
  it("should return all chunks in a single batch if they fit within budget", () => {
    const chunks = [
      createChunk("file.ts", 100, 1),
      createChunk("file.ts", 100, 20),
    ];

    const batches = applyChunkStrategy(chunks, "gpt-4o");

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("should split into multiple batches for large total token count", () => {
    // Create chunks that together exceed the token budget
    // Each chunk is large enough that only a few fit per batch
    const chunks: DiffChunk[] = [];
    for (let i = 0; i < 20; i++) {
      chunks.push(createChunk("file.ts", 50000, i * 20 + 1));
    }

    const batches = applyChunkStrategy(chunks, "gpt-4o");

    expect(batches.length).toBeGreaterThan(1);
    // Each batch should contain at least one chunk
    batches.forEach((batch) => {
      expect(batch.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("should handle a single chunk that fits", () => {
    const chunks = [createChunk("file.ts", 200, 1)];

    const batches = applyChunkStrategy(chunks, "gpt-4o");

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it("should handle empty chunks array", () => {
    const batches = applyChunkStrategy([], "gpt-4o");

    // Empty input: single batch containing empty array
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(0);
  });

  it("should preserve chunk data through batching", () => {
    const chunk = createChunk("src/important.ts", 100, 42);
    chunk.language = "TypeScript";

    const batches = applyChunkStrategy([chunk], "gpt-4o");

    expect(batches[0]![0]!.filename).toBe("src/important.ts");
    expect(batches[0]![0]!.startLine).toBe(42);
    expect(batches[0]![0]!.language).toBe("TypeScript");
  });
});