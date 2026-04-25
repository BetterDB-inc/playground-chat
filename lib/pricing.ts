/**
 * Single source of truth for model pricing.
 *
 * Mirrors the shape used by `@betterdb/agent-cache` and `@betterdb/semantic-cache`
 * so the same rates can be passed straight to those packages' `costTable` option.
 *
 * Pricing is in USD per 1,000 tokens. Source: OpenAI public pricing as of
 * 2026-04. Update when models change.
 */

export interface ModelCost {
  inputPer1k: number;
  outputPer1k: number;
}

/**
 * Chat / completion models.
 */
export const LLM_COST_TABLE: Record<string, ModelCost> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  "gpt-4.1": { inputPer1k: 0.002, outputPer1k: 0.008 },
};

/**
 * Embedding models. Output rate is unused (embeddings have no output tokens),
 * but we keep the same shape for consistency.
 */
export const EMBED_COST_TABLE: Record<string, ModelCost> = {
  "text-embedding-3-small": { inputPer1k: 0.00002, outputPer1k: 0 },
  "text-embedding-3-large": { inputPer1k: 0.00013, outputPer1k: 0 },
  "text-embedding-ada-002": { inputPer1k: 0.0001, outputPer1k: 0 },
};

/**
 * Embedding model → expected vector dimension. Used to assert the env var
 * `EMBED_DIM` matches the chosen model so a misconfiguration doesn't silently
 * produce a corrupt index.
 */
export const EMBED_MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * Estimate cost in USD for an LLM call.
 * Returns 0 when the model isn't in the table (unknown model - better to
 * report 0 than guess).
 */
export function estimateLlmCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = LLM_COST_TABLE[model];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.inputPer1k + (outputTokens / 1000) * rates.outputPer1k;
}

/**
 * Estimate cost in USD for an embedding call.
 */
export function estimateEmbedCost(model: string, inputTokens: number): number {
  const rates = EMBED_COST_TABLE[model];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.inputPer1k;
}

/**
 * Approximate token count for a string. Mirrors the heuristic used by the
 * ingest scripts (~4 chars/token). Good enough for cost gating and metrics;
 * not exact.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
