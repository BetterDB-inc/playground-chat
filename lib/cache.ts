import { AgentCache } from "@betterdb/agent-cache";
import { SemanticCache } from "@betterdb/semantic-cache";
import { valkey } from "./valkey";
import { embedText } from "./embeddings";
import { LLM_COST_TABLE } from "./pricing";
import { getAnalytics } from "./analytics";

/**
 * Tool tier and LLM tier of @betterdb/agent-cache, both backed by the same
 * Valkey instance. The cost table is the same one used by /api/chat for
 * estimating call cost - passing it here lets agent-cache report accurate
 * `costSavedMicros` in its stats endpoint.
 */
export const agentCache = new AgentCache({
  client: valkey,
  name: "playground",
  tierDefaults: {
    tool: { ttl: Number(process.env.TOOL_TTL_SECONDS ?? 86400) },
    llm: { ttl: Number(process.env.LLM_TTL_SECONDS ?? process.env.TOOL_TTL_SECONDS ?? 86400) },
  },
  costTable: LLM_COST_TABLE,
  // Re-read tool policies from Valkey every 30s so Monitor can apply cache
  // proposals (TTL / disable) without a process restart.
  configRefresh: { enabled: true, intervalMs: 30_000 },
});

/**
 * Semantic cache for full LLM responses. Cosine-distance threshold; lower
 * is stricter. The cost table mirrors `agentCache` so a hit reports the
 * dollars saved for the LLM call we avoided.
 */
export const semanticCache = new SemanticCache({
  client: valkey,
  name: "playground_scache",
  embedFn: embedText,
  defaultThreshold: Number(process.env.SEMANTIC_THRESHOLD ?? 0.08),
  defaultTtl: Number(process.env.SEMANTIC_TTL_SECONDS ?? 604800),
  // Measured distribution: paraphrases 0.81–0.91 similarity, borderline band
  // 0.74–0.81 (≈ 0.38–0.52 cosine distance). Default band of 0.05 is too
  // narrow — use 0.07 so borderline hits reach the judge.
  uncertaintyBand: Number(process.env.SEMANTIC_UNCERTAINTY_BAND ?? 0.07),
  costTable: LLM_COST_TABLE,
  // Re-read threshold config from Valkey every 30s so Monitor can tune the
  // similarity threshold live without a process restart.
  configRefresh: { enabled: true, intervalMs: 30_000 },
});

/**
 * Single shared init promise. Two concurrent first-requests would otherwise
 * both pass a boolean check before either had a chance to flip it, and we'd
 * call `semanticCache.initialize()` twice (which races on FT.CREATE).
 * Awaiting the same promise from every caller serialises this safely.
 */
let _initPromise: Promise<void> | null = null;

export function initCaches(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      // Kick off the PostHog client construction (one valkey GET for the
      // instance id) in parallel with semantic-cache init so the first
      // chat turn doesn't pay either cost on its critical path.
      await Promise.all([semanticCache.initialize(), getAnalytics().catch(() => undefined)]);
    })().catch((err) => {
      // Reset on failure so the next request can retry instead of being
      // permanently stuck on a stale rejected promise.
      _initPromise = null;
      throw err;
    });
  }
  return _initPromise;
}
