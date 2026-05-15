import {
  streamText,
  wrapLanguageModel,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAgentCacheMiddleware } from "@betterdb/agent-cache/ai";
import { initCaches, agentCache, semanticCache } from "@/lib/cache";
import { tools } from "@/lib/tools";
import { rateLimit, reserveBudget, settleBudget } from "@/lib/rate-limit";
import { validateInputSync, moderateInput } from "@/lib/guardrails";
import { logTurn } from "@/lib/logger";
import { recordTurn } from "@/lib/stats";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { validateEnv } from "@/lib/env";
import { detectClientIp } from "@/lib/client-ip";
import { scrubSecrets } from "@/lib/secrets";
import { estimateLlmCost, approximateTokens } from "@/lib/pricing";
import { captureChatTurn, flushAnalytics } from "@/lib/analytics";
import { after } from "next/server";
import type { ToolMeta, TurnMetrics } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Pessimistic per-call cost estimate for the budget gate. */
function estimatedRequestCost(model: string, promptText: string): number {
  // Assume ~2x prompt tokens for output as a conservative cap.
  const promptTokens = approximateTokens(promptText);
  return estimateLlmCost(model, promptTokens, promptTokens * 2);
}

function uiMessageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Infer a database category from the query for per-category threshold tuning.
 * Lets the optimize agent (and thresholdEffectiveness) recommend different
 * cutoffs for e.g. Valkey vs Dragonfly queries without a global blunt adjustment.
 */
function detectCategory(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes("dragonfly")) return "dragonfly";
  if (t.includes("valkey")) return "valkey";
  if (t.includes("redis")) return "redis";
  if (t.includes("betterdb")) return "betterdb";
  return undefined;
}

/**
 * Keyword-overlap rerank: among top-k cosine candidates, pick the one whose
 * response contains the most words from the query. Zero LLM calls — acts as a
 * cheap first filter before the judge fires on truly borderline hits.
 */
async function rerankByKeywordOverlap(
  query: string,
  candidates: Array<{ response: string; similarity: number }>,
): Promise<number> {
  if (candidates.length <= 1) return 0;
  const words = new Set((query.toLowerCase().match(/\b\w{3,}\b/g) ?? []) as string[]);
  if (words.size === 0) return 0;
  let best = 0;
  let bestScore = -1;
  candidates.forEach((candidate, i) => {
    const resp = candidate.response.toLowerCase();
    let overlap = 0;
    for (const w of words) if (resp.includes(w)) overlap++;
    // Tiebreak with cosine similarity (1 - distance/2); lower distance = higher similarity.
    const score = overlap + (1 - candidate.similarity / 2);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export async function POST(req: Request) {
  // Fail fast if the deployment is misconfigured. validateEnv() is memoized
  // so this is essentially free after the first call.
  let env;
  try {
    env = validateEnv();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Server misconfigured" },
      { status: 500 },
    );
  }

  await initCaches();

  const ip = detectClientIp(req);
  const turnStart = Date.now();

  let body: { messages?: UIMessage[] };
  try {
    body = (await req.json()) as { messages?: UIMessage[] };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const uiMessages = body.messages ?? [];
  const lastUser = [...uiMessages].reverse().find((m) => m.role === "user");

  // Distinguish "no user message at all" from "user message that's too short".
  // Without this, an empty `messages` array would surface "Query too short"
  // which is misleading.
  if (!lastUser) {
    return Response.json(
      { error: "Request must include at least one user message." },
      { status: 400 },
    );
  }
  const lastUserText = uiMessageText(lastUser);

  // Sync guardrails: cheap and synchronous (length, control chars, type).
  const guardSync = validateInputSync(lastUserText);
  if (!guardSync.ok) {
    return Response.json({ error: guardSync.reason }, { status: 400 });
  }

  // Async guardrails: OpenAI Moderation (no-op unless MODERATION_ENABLED).
  const guardAsync = await moderateInput(lastUserText);
  if (!guardAsync.ok) {
    return Response.json({ error: guardAsync.reason }, { status: 400 });
  }

  // Rate limit (atomic Lua, sliding window).
  const rl = await rateLimit(ip);
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // Strip credentials from the prompt before it's stored anywhere
  // (semantic cache, logs). Doesn't change what the model sees during this
  // request - only what we persist.
  const persistedQuery = scrubSecrets(lastUserText);

  // createOpenAI is O(1) — create it here so the judge closure can reference
  // it without capturing env. Also reused below for the LLM call.
  const openai = createOpenAI({ apiKey: env.openaiKey });

  // Detect which database the query is about so per-category threshold
  // recommendations and the rolling similarity window are segmented by topic.
  const queryCategory = detectCategory(lastUserText);

  // ---- Semantic cache: check ----
  // Fallback shape mirrors what the cache package returns on a true miss so
  // every downstream access (confidence, nearestMiss, costSaved) is safe.
  type SemanticHit = Awaited<ReturnType<typeof semanticCache.check>>;
  const semanticMiss: SemanticHit = { hit: false, confidence: "miss" };
  const semanticStart = Date.now();
  let semanticHit: SemanticHit;
  try {
    semanticHit = await semanticCache.check(lastUserText, {
      staleAfterModelChange: true,
      currentModel: env.llmModel,
      category: queryCategory,
      // Fetch top-3 and pick the best by keyword overlap before the judge
      // fires — catches entity-swap mismatches cheaply.
      rerank: { k: 3, rerankFn: rerankByKeywordOverlap },
      // LLM-as-judge for borderline hits inside the uncertainty band.
      // gpt-4o-mini is fast (<1 s typical) and cheap. onError:'accept' means a
      // timeout or API failure falls back to serving the uncertain hit rather
      // than forcing a full LLM round-trip.
      judge: {
        judgeFn: async ({ prompt, response }) => {
          const { text } = await generateText({
            model: openai(process.env.JUDGE_MODEL ?? "gpt-4o-mini"),
            system:
              "You are a cache quality judge for a Valkey, Redis, Dragonfly, and " +
              "BetterDB documentation chatbot. Given a user query and a cached " +
              'response, reply with exactly "yes" if the cached response adequately ' +
              'answers the query, or "no" if it does not. Output only one word.',
            prompt: `Query: ${prompt}\n\nCached response:\n${response.slice(0, 800)}`,
          });
          return text.trim().toLowerCase().startsWith("y");
        },
        timeoutMs: 3000,
        onError: "accept",
      },
    });
  } catch (e) {
    console.warn("semantic cache check failed:", e);
    semanticHit = semanticMiss;
  }
  const embedLatencyMs = Date.now() - semanticStart;

  // Diagnostic: when a query misses, log the nearest neighbour distance and
  // the configured threshold so we can tell at a glance whether the cache is
  // empty, the threshold is too tight, or something stale-evicted.
  if (process.env.SEMANTIC_DEBUG === "true" && !semanticHit.hit) {
    const nearest = semanticHit.nearestMiss?.similarity;
    const threshold = Number(process.env.SEMANTIC_THRESHOLD ?? 0.08);
    console.log(
      `[semantic miss] threshold=${threshold} nearest=${nearest ?? "none"} ` +
        `confidence=${semanticHit.confidence} prompt_chars=${lastUserText.length}`,
    );
  }

  if (semanticHit.hit && semanticHit.response) {
    const text = semanticHit.response;
    // costSaved comes from the cache itself when the original store() included
    // model + token counts. If the original was stored without those (e.g.
    // pre-warm script), it'll be undefined - we report 0 in that case.
    const savedUsd = semanticHit.costSaved ?? 0;

    await Promise.all([
      logTurn({
        ip,
        q: persistedQuery,
        semantic: {
          hit: true,
          similarity: semanticHit.similarity,
          savedUsd,
        },
        toolHits: [],
        costUsd: 0,
      }),
      recordTurn({
        semanticHit: true,
        savedUsd,
        totalLatencyMs: Date.now() - turnStart,
      }),
    ]);

    // PostHog: send the raw prompt + IP. Deferred via after() so the network
    // round-trip happens AFTER the response is sent, but before the lambda
    // freezes - guaranteeing delivery on serverless without adding latency.
    // Telemetry is opt-in (BETTERDB_POSTHOG_API_KEY) and can be disabled
    // with BETTERDB_TELEMETRY=false; both paths NOOP when off.
    after(async () => {
      await captureChatTurn({
        prompt: lastUserText,
        ip,
        semantic: {
          hit: true,
          similarity: semanticHit.similarity,
          savedUsd,
          embedLatencyMs,
        },
        toolHits: [],
        model: env.llmModel,
        costUsd: 0,
        totalLatencyMs: Date.now() - turnStart,
      });
      await flushAnalytics();
    });

    // Hand-roll a v6 UIMessageStream for the cached response. The AI SDK's
    // helpers all assume there's an underlying model call - for cache hits
    // we synthesise the same protocol manually so the client treats it
    // identically to a fresh streaming response.
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = `cached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // A judge-accepted hit has confidence:'high' (promoted from 'uncertain')
        // AND a similarity score inside the uncertainty band. Derive it from
        // the same thresholds used to construct the cache so the UI can show
        // "judge ✓" rather than a plain HIT.
        const scThreshold = Number(process.env.SEMANTIC_THRESHOLD ?? 0.08);
        const scBand = Number(process.env.SEMANTIC_UNCERTAINTY_BAND ?? 0.07);
        const judgeAccepted =
          semanticHit.confidence === "high" &&
          semanticHit.similarity !== undefined &&
          semanticHit.similarity > scThreshold - scBand;

        const metrics: TurnMetrics = {
          semantic: {
            hit: true,
            similarity: semanticHit.similarity,
            savedUsd,
            embedLatencyMs,
            confidence: semanticHit.confidence as "high" | "uncertain",
            judgeAccepted,
          },
          toolHits: [],
          savedUsd,
        };
        writer.write({ type: "start", messageMetadata: metrics });
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
        writer.write({ type: "finish", messageMetadata: metrics });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // ---- Budget gate: atomic reserve, settle in onFinish ----
  const estimatedCost = estimatedRequestCost(env.llmModel, lastUserText);
  const reserve = await reserveBudget(estimatedCost);
  if (!reserve.ok) {
    return Response.json(
      {
        error: "budget_exceeded",
        message: "Daily budget exceeded. Try again tomorrow.",
        spentUsd: reserve.spentUsd,
        budgetUsd: reserve.budgetUsd,
      },
      { status: 429 },
    );
  }

  // ---- LLM call ----
  const model = wrapLanguageModel({
    model: openai(env.llmModel),
    middleware: createAgentCacheMiddleware({ cache: agentCache }),
  });

  const toolMetas: ToolMeta[] = [];

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(uiMessages),
    tools,
    stopWhen: stepCountIs(5),
    onStepFinish: ({ toolResults }) => {
      for (const tr of toolResults ?? []) {
        const meta = (tr.output as { _meta?: ToolMeta } | undefined)?._meta;
        if (meta) toolMetas.push(meta);
      }
    },
    onFinish: async ({ text, usage }) => {
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const actualCost = estimateLlmCost(env.llmModel, inputTokens, outputTokens);

      // True up the budget reservation - we may have estimated low.
      void settleBudget(estimatedCost, actualCost);

      // Store with model + tokens so subsequent semantic-cache hits can
      // report an accurate `costSaved`. This is the key change vs. before:
      // the cache itself becomes the source of truth for savings.
      const semanticStorePromise = semanticCache
        .store(lastUserText, text, {
          model: env.llmModel,
          inputTokens,
          outputTokens,
          category: queryCategory,
        })
        .catch((e) => console.warn("semantic cache store failed:", e));

      await Promise.all([
        semanticStorePromise,
        logTurn({
          ip,
          q: persistedQuery,
          semantic: { hit: false },
          toolHits: toolMetas,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
          },
          costUsd: actualCost,
        }),
        recordTurn({
          semanticHit: false,
          savedUsd: 0,
          costUsd: actualCost,
          totalLatencyMs: Date.now() - turnStart,
        }),
      ]);

      // Raw prompt + IP + full per-turn metrics → PostHog. Same opt-in and
      // opt-out as the cache-hit path above. Deferred via after() so the
      // PostHog HTTP round-trip runs after the stream closes but before the
      // lambda is frozen - the previous in-band fire-and-forget pattern was
      // dropping these events on serverless because the 10s flush timer
      // never fired before the function exited.
      after(async () => {
        await captureChatTurn({
          prompt: lastUserText,
          ip,
          semantic: { hit: false, embedLatencyMs },
          toolHits: toolMetas,
          model: env.llmModel,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          costUsd: actualCost,
          totalLatencyMs: Date.now() - turnStart,
        });
        await flushAnalytics();
      });
    },
  });

  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }) => {
      if (part.type !== "finish") return undefined;
      const inputTokens = part.totalUsage?.inputTokens ?? 0;
      const outputTokens = part.totalUsage?.outputTokens ?? 0;
      const costUsd = estimateLlmCost(env.llmModel, inputTokens, outputTokens);
      const metrics: TurnMetrics = {
        semantic: {
          hit: false,
          embedLatencyMs,
          nearestMiss: semanticHit.nearestMiss?.similarity,
          // deltaToThreshold <= 0 means the score cleared the cosine threshold
          // but the judge said no — distinct from a plain cosine miss.
          judgeRejected:
            semanticHit.nearestMiss !== undefined &&
            semanticHit.nearestMiss.deltaToThreshold <= 0,
        },
        toolHits: toolMetas,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        costUsd,
        // No fabricated savedUsd here. Tool-tier savings are tracked
        // automatically by agent-cache's internal counters and reported via
        // /api/stats. Per-turn savedUsd only makes sense on a semantic hit.
        savedUsd: 0,
      };
      return metrics;
    },
  });
}
