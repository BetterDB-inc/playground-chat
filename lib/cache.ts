import { AgentCache } from "@betterdb/agent-cache";
import { SemanticCache } from "@betterdb/semantic-cache";
import { valkey } from "./valkey";

// Embed function using OpenAI REST API (no SDK import needed here)
async function openaiEmbed(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
      input: text,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: [{ embedding: number[] }] };
  return json.data[0].embedding;
}

export const agentCache = new AgentCache({
  client: valkey,
  name: "playground",
  tierDefaults: {
    tool: { ttl: Number(process.env.TOOL_TTL_SECONDS ?? 86400) },
    llm: { ttl: Number(process.env.TOOL_TTL_SECONDS ?? 86400) },
  },
  costTable: {
    "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  },
});

// SEMANTIC_THRESHOLD env is cosine distance (0–2 scale).
// Default 0.08 ≈ cosine similarity 0.92
export const semanticCache = new SemanticCache({
  client: valkey,
  name: "playground_scache",
  embedFn: openaiEmbed,
  defaultThreshold: Number(process.env.SEMANTIC_THRESHOLD ?? 0.08),
  defaultTtl: Number(process.env.SEMANTIC_TTL_SECONDS ?? 604800),
  costTable: {
    "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  },
});

let _initialized = false;

export async function initCaches(): Promise<void> {
  if (_initialized) return;
  await semanticCache.initialize();
  _initialized = true;
}
