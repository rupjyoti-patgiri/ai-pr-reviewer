import { encoding_for_model, type TiktokenModel } from "tiktoken";
import { logger } from "./logger";

/**
 * Token counting utility using tiktoken.
 * Caches the encoder instance for performance.
 */
let cachedEncoder: ReturnType<typeof encoding_for_model> | null = null;
let cachedModelName: string | null = null;

function getEncoder(model: string): ReturnType<typeof encoding_for_model> {
  // Map model names to tiktoken-compatible names
  const modelMap: Record<string, TiktokenModel> = {
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4-turbo": "gpt-4-turbo",
    "gpt-4": "gpt-4",
    "gpt-3.5-turbo": "gpt-3.5-turbo",
  };

  const tiktokenModel = modelMap[model] ?? "gpt-4o";

  if (cachedEncoder && cachedModelName === tiktokenModel) {
    return cachedEncoder;
  }

  try {
    cachedEncoder = encoding_for_model(tiktokenModel);
    cachedModelName = tiktokenModel;
    return cachedEncoder;
  } catch (error) {
    logger.warn(
      { model, error },
      "Failed to load tiktoken encoder for model, falling back to gpt-4o"
    );
    cachedEncoder = encoding_for_model("gpt-4o");
    cachedModelName = "gpt-4o";
    return cachedEncoder;
  }
}

/**
 * Counts the number of tokens in a text string for the given model.
 */
export function countTokens(text: string, model: string = "gpt-4o"): number {
  const encoder = getEncoder(model);
  const tokens = encoder.encode(text);
  return tokens.length;
}

/**
 * Estimates the total tokens for a chat completion request
 * (system + user messages with overhead).
 */
export function estimateChatTokens(
  systemPrompt: string,
  userPrompt: string,
  model: string = "gpt-4o"
): number {
  const systemTokens = countTokens(systemPrompt, model);
  const userTokens = countTokens(userPrompt, model);
  // Overhead for message formatting: ~4 tokens per message + 2 for priming
  const overhead = 4 * 2 + 2;
  return systemTokens + userTokens + overhead;
}

/**
 * Returns the maximum context window size for a given model.
 */
export function getModelMaxTokens(model: string): number {
  const limits: Record<string, number> = {
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
    "gpt-3.5-turbo": 16385,
  };
  return limits[model] ?? 128000;
}

/**
 * Cleans up the tiktoken encoder. Call on shutdown.
 */
export function freeEncoder(): void {
  if (cachedEncoder) {
    cachedEncoder.free();
    cachedEncoder = null;
    cachedModelName = null;
  }
}