import { describe, it, expect } from "vitest";
import {
  estimateLlmCost,
  estimateEmbedCost,
  approximateTokens,
  LLM_COST_TABLE,
  EMBED_MODEL_DIMS,
} from "@/lib/pricing";

describe("pricing", () => {
  it("estimates LLM cost from input + output tokens", () => {
    // gpt-4o-mini: $0.00015 in, $0.0006 out per 1k.
    // 1000 in + 1000 out → 0.00015 + 0.0006 = $0.00075
    const cost = estimateLlmCost("gpt-4o-mini", 1000, 1000);
    expect(cost).toBeCloseTo(0.00075, 6);
  });

  it("returns 0 for unknown models rather than guessing", () => {
    expect(estimateLlmCost("nonexistent-model", 1000, 1000)).toBe(0);
  });

  it("estimates embedding cost from input tokens only", () => {
    // text-embedding-3-small: $0.00002 per 1k. 5000 tokens → $0.0001
    const cost = estimateEmbedCost("text-embedding-3-small", 5000);
    expect(cost).toBeCloseTo(0.0001, 6);
  });

  it("approximates token count from text length", () => {
    expect(approximateTokens("")).toBe(0);
    // 16 chars / 4 = 4 tokens
    expect(approximateTokens("a".repeat(16))).toBe(4);
  });

  it("LLM cost table has positive rates for every entry", () => {
    for (const [model, rates] of Object.entries(LLM_COST_TABLE)) {
      expect(rates.inputPer1k, `${model} inputPer1k`).toBeGreaterThan(0);
      expect(rates.outputPer1k, `${model} outputPer1k`).toBeGreaterThan(0);
    }
  });

  it("embed model dim map covers the OpenAI defaults", () => {
    expect(EMBED_MODEL_DIMS["text-embedding-3-small"]).toBe(1536);
    expect(EMBED_MODEL_DIMS["text-embedding-3-large"]).toBe(3072);
  });
});
