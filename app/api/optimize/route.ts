/**
 * Cache self-optimization agent.
 *
 * Triggered by Vercel Cron (see vercel.json) or manually via:
 *   curl -X POST /api/optimize -H "Authorization: Bearer $CRON_SECRET"
 *
 * Uses GPT (via @ai-sdk/openai + generateText) to:
 *   1. List all caches registered on the configured Valkey instance.
 *   2. Fetch health, threshold recommendations, and tool effectiveness.
 *   3. Propose threshold / TTL adjustments where the data clearly warrants it.
 *   4. Auto-approve the proposals it creates.
 *
 * Required env vars (in addition to existing ones):
 *   BETTERDB_URL          Monitor base URL
 *   BETTERDB_TOKEN        MCP bearer token
 *   BETTERDB_INSTANCE_ID  Valkey connection ID in Monitor
 *   CRON_SECRET           Shared secret to authenticate cron + manual calls
 *
 * Optional:
 *   OPTIMIZE_MODEL        OpenAI model to use (default: gpt-4o-mini)
 */

import { timingSafeEqual } from "crypto";
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { monitorGet, monitorPost, requireInstanceId } from "@/lib/monitor-client";
import { validateEnv } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 55; // leave headroom vs the 60s Vercel limit

// Budget: 20 steps × 10s max per tool call = 200s worst case, but the
// AbortSignal on generateText caps the whole run at 45s.
const AGENT_TIMEOUT_MS = 45_000;

function constantTimeEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    // timingSafeEqual throws if lengths differ — that itself is a mismatch.
    return false;
  }
}

const SYSTEM_PROMPT = `\
You are a cache optimization agent for a production LLM application backed by Valkey.
You have access to a BetterDB Monitor instance. The caches and their types are unknown
upfront — always discover them by calling list_caches first and use the type field
("semantic_cache" or "agent_cache") from each entry to decide what to do next.

Your job each run:

1. Call list_caches to discover all registered, live caches and their types.
2. For every cache whose type is "semantic_cache": call cache_health then threshold_recommendation.
   - If recommendation is "tighten_threshold" or "loosen_threshold" AND sample_count >= 100:
     * First call recent_changes to confirm no pending threshold proposal already exists.
     * If clear, call propose_threshold_adjust then immediately call approve_proposal.
   - If "optimal" or "insufficient_data": log why and skip.
3. For every cache whose type is "agent_cache": call cache_health then tool_effectiveness.
   - For each tool with recommendation "increase_ttl" or "decrease_ttl_or_disable" AND
     at least 20 total ops (hits + misses):
     * First call recent_changes to confirm no pending TTL proposal for that tool.
     * If clear, call propose_tool_ttl_adjust then immediately call approve_proposal.
       * increase_ttl         → double current TTL (cap at 86400 s)
       * decrease_ttl_or_disable → halve current TTL (floor at 60 s);
                                   if hit_rate < 0.05 propose 60 s
4. After all actions, output a concise plain-text summary of what you did and why.

Rules:
- Never propose a threshold outside [0.02, 0.30].
- Never propose a TTL below 60 s or above 86400 s.
- reasoning fields must be >= 20 characters and reference actual metric values.
- If BETTERDB_URL / BETTERDB_TOKEN / BETTERDB_INSTANCE_ID are not configured, stop.
- Be conservative: skip when data is ambiguous or sample_count is too low.
`;

// ---- tool definitions -------------------------------------------------------

function instancePath(suffix: string): string {
  const id = requireInstanceId();
  return `/mcp/instance/${id}${suffix}`;
}

const cacheTools = {
  list_caches: tool({
    description: "List all caches registered on the active Valkey instance.",
    inputSchema: z.object({}),
    execute: async () => monitorGet(instancePath("/caches")),
  }),

  cache_health: tool({
    description:
      "Detailed health for a single cache (hit rate, cost saved, warnings, " +
      "per-tool breakdown for agent_cache, uncertain_hit_rate for semantic_cache).",
    inputSchema: z.object({
      cache_name: z.string().describe("Cache name as shown by list_caches"),
    }),
    execute: async ({ cache_name }) =>
      monitorGet(instancePath(`/caches/${encodeURIComponent(cache_name)}/health`)),
  }),

  threshold_recommendation: tool({
    description:
      "Threshold-tuning recommendation for a semantic_cache based on the rolling " +
      "similarity-score window. Returns recommendation, sample_count, and recommended_threshold.",
    inputSchema: z.object({
      cache_name: z.string(),
      category: z
        .string()
        .optional()
        .describe("Omit for the global threshold"),
      min_samples: z.number().int().optional().describe("Default 100"),
    }),
    execute: async ({ cache_name, category, min_samples }) => {
      const qs = new URLSearchParams();
      if (category) qs.set("category", category);
      if (min_samples !== undefined) qs.set("minSamples", String(min_samples));
      const q = qs.size ? `?${qs}` : "";
      return monitorGet(
        instancePath(
          `/caches/${encodeURIComponent(cache_name)}/threshold-recommendation${q}`,
        ),
      );
    },
  }),

  tool_effectiveness: tool({
    description:
      "Per-tool hit_rate, cost_saved_usd, ttl_current, and recommendation " +
      "for an agent_cache. Returns an array sorted by cost_saved_usd desc.",
    inputSchema: z.object({ cache_name: z.string() }),
    execute: async ({ cache_name }) =>
      monitorGet(
        instancePath(
          `/caches/${encodeURIComponent(cache_name)}/tool-effectiveness`,
        ),
      ),
  }),

  recent_changes: tool({
    description:
      "Recent proposals for a cache (any status, newest first). " +
      "Call this before proposing to avoid creating duplicates.",
    inputSchema: z.object({
      cache_name: z.string(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Default 20"),
    }),
    execute: async ({ cache_name, limit }) => {
      const q = limit !== undefined ? `?limit=${limit}` : "";
      return monitorGet(
        instancePath(
          `/caches/${encodeURIComponent(cache_name)}/recent-changes${q}`,
        ),
      );
    },
  }),

  propose_threshold_adjust: tool({
    description:
      "Propose a similarity-threshold change for a semantic_cache. " +
      "Returns a proposal_id — pass it to approve_proposal immediately.",
    inputSchema: z.object({
      cache_name: z.string(),
      new_threshold: z.number().min(0.02).max(0.3),
      reasoning: z.string().min(20),
      category: z.string().nullable().optional(),
    }),
    execute: async ({ cache_name, new_threshold, reasoning, category }) =>
      monitorPost(instancePath("/cache-proposals/threshold-adjust"), {
        cache_name,
        new_threshold,
        reasoning,
        category: category ?? null,
      }),
  }),

  propose_tool_ttl_adjust: tool({
    description:
      "Propose a per-tool TTL change for an agent_cache. " +
      "Returns a proposal_id — pass it to approve_proposal immediately.",
    inputSchema: z.object({
      cache_name: z.string(),
      tool_name: z.string(),
      new_ttl_seconds: z.number().int().min(60).max(86400),
      reasoning: z.string().min(20),
    }),
    execute: async ({ cache_name, tool_name, new_ttl_seconds, reasoning }) =>
      monitorPost(instancePath("/cache-proposals/tool-ttl-adjust"), {
        cache_name,
        tool_name,
        new_ttl_seconds,
        reasoning,
      }),
  }),

  approve_proposal: tool({
    description:
      "Approve a pending proposal. Synchronously writes the change to Valkey " +
      "and returns terminal status (applied | failed).",
    inputSchema: z.object({
      proposal_id: z.string(),
    }),
    execute: async ({ proposal_id }) =>
      // Approval is intentionally NOT instance-scoped — proposal IDs are
      // globally unique UUIDs and the Monitor routes them without an instance
      // prefix. Verified against CacheProposalMcpController:
      //   @Post('cache-proposals/:proposalId/approve')  (no instance segment)
      monitorPost(
        `/mcp/cache-proposals/${encodeURIComponent(proposal_id)}/approve`,
        { actor: "optimize-agent" },
      ),
  }),

};

// ---- route ------------------------------------------------------------------

export async function POST(req: Request) {
  // Authenticate — CRON_SECRET is required. Vercel injects it automatically
  // and sends it as x-vercel-cron-secret on cron calls. Manual callers pass
  // it as Authorization: Bearer <secret>. Refusing when unset prevents an
  // accidental open endpoint in misconfigured deployments.
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret) {
    return Response.json(
      { error: "CRON_SECRET is not configured — endpoint is disabled" },
      { status: 401 },
    );
  }
  const auth =
    req.headers.get("x-vercel-cron-secret") ??
    req.headers.get("authorization") ??
    "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!constantTimeEqual(provided, cronSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let env: ReturnType<typeof validateEnv>;
  try {
    env = validateEnv();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Env validation failed" },
      { status: 500 },
    );
  }

  // Pre-flight: validate BetterDB vars before spending an LLM call.
  // These are checked lazily inside tool execute() functions, but failing
  // there wastes tokens on the first tool invocation.
  if (
    !process.env.BETTERDB_URL ||
    !process.env.BETTERDB_TOKEN ||
    !process.env.BETTERDB_INSTANCE_ID
  ) {
    return Response.json(
      { error: "BETTERDB_URL, BETTERDB_TOKEN, and BETTERDB_INSTANCE_ID must all be set" },
      { status: 500 },
    );
  }

  const optimizeModel = process.env.OPTIMIZE_MODEL ?? "gpt-4o-mini";
  const openai = createOpenAI({ apiKey: env.openaiKey });
  const abortController = new AbortController();
  const agentTimer = setTimeout(() => abortController.abort(), AGENT_TIMEOUT_MS);

  try {
    const { text, steps } = await generateText({
      model: openai(optimizeModel),
      system: SYSTEM_PROMPT,
      prompt: "Run the cache optimization cycle now.",
      tools: cacheTools,
      stopWhen: stepCountIs(20),
      abortSignal: abortController.signal,
    });

    const toolCallCount = steps.reduce(
      (n, s) => n + (s.toolCalls?.length ?? 0),
      0,
    );

    console.log(
      `[optimize] done — ${toolCallCount} tool calls, model=${optimizeModel}`,
    );

    return Response.json({ ok: true, summary: text, toolCallCount });
  } catch (e) {
    console.error("[optimize] agent error:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : "Agent failed" },
      { status: 500 },
    );
  } finally {
    clearTimeout(agentTimer);
  }
}

export async function GET() {
  return Response.json(
    { error: "Method not allowed. POST to trigger the optimization cycle." },
    { status: 405 },
  );
}
