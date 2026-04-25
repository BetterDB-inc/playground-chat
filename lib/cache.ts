import { AgentCache } from "@betterdb/agent-cache";
import { SemanticCache } from "@betterdb/semantic-cache";
import { valkey } from "./valkey";
import { embedText } from "./embeddings";
import { LLM_COST_TABLE } from "./pricing";

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
  costTable: LLM_COST_TABLE,
});

let _initialized = false;

export async function initCaches(): Promise<void> {
  if (_initialized) return;
  await semanticCache.initialize();
  _initialized = true;
}
