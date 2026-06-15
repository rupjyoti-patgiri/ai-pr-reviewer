import { env } from "../config/env";
import { reviewConfig } from "../config/reviewRules";
import { OpenAIProvider } from "./openai";
import type { AIProvider, AIProviderConfig } from "./types";
import { logger } from "../utils/logger";

/**
 * AI Provider Factory (Strategy Pattern).
 *
 * Creates the appropriate AI provider based on the review configuration.
 * Currently supports OpenAI; extensible for Anthropic, local models, etc.
 */

let cachedProvider: AIProvider | null = null;

/**
 * Returns a singleton AI provider instance based on the current configuration.
 * Caches the instance to avoid recreating clients on every review.
 */
export function getAIProvider(): AIProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const providerName = reviewConfig.ai.provider;

  switch (providerName) {
    case "openai": {
      const config: AIProviderConfig = {
        model: env.OPENAI_MODEL || reviewConfig.ai.model,
        temperature: reviewConfig.ai.temperature,
        maxTokens: reviewConfig.ai.maxTokensPerRequest,
        apiKey: env.OPENAI_API_KEY,
      };

      cachedProvider = new OpenAIProvider(config);
      logger.info(
        { provider: providerName, model: config.model },
        "Initialized AI provider"
      );
      break;
    }

    default:
      throw new Error(
        `Unsupported AI provider: "${providerName}". ` +
          `Supported providers: openai`
      );
  }

  return cachedProvider;
}

/**
 * Resets the cached provider. Useful for testing or config reloading.
 */
export function resetAIProvider(): void {
  cachedProvider = null;
}