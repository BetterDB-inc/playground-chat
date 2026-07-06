import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { LlmCacheParams } from "@betterdb/agent-cache";
import { initCaches, agentCache, semanticCache } from "@/lib/cache";
import { tools } from "@/lib/tools";
import { rateLimit, reserveBudget, settleBudget } from "@/lib/rate-limit";
import { validateInputSync, moderateInput } from "@/lib/guardrails";
import { logTurn } from "@/lib/logger";
import { recordTurn, recordMemoryRecall, recordConsolidation } from "@/lib/stats";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { validateEnv } from "@/lib/env";
import { detectClientIp } from "@/lib/client-ip";
import { scrubSecrets } from "@/lib/secrets";
import { estimateLlmCost, approximateTokens } from "@/lib/pricing";
import { captureChatTurn, flushAnalytics } from "@/lib/analytics";
import { after } from "next/server";
import { getOrCreateUserId } from "@/lib/session";
import { recallMemories, rememberFact, maybeConsolidate } from "@/lib/memory";
import { extractFacts } from "@/lib/memory-extract";
import { withSpan, spanText, telemetryEnabled, captureContent } from "@/lib/telemetry";
import type { Span } from "@opentelemetry/api";
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

/**
 * Post-turn memory maintenance: extract + remember durable facts, then run the
 * throttled consolidation pass. Runs on every turn — cache hits included — so a
 * fact shared on a cached turn is still stored and old memories still get
 * summarized. Best-effort and write-only: it never changes the reply, so it's
 * safe on cache paths (unlike recall, which would break cross-user sharing).
 * Callers pass already-scrubbed text — durable facts are persisted and recalled
 * into future prompts, so credentials must never reach here.
 */
async function postTurnMemory(
  openai: ReturnType<typeof createOpenAI>,
  userId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  // Both LLM calls below hit OpenAI, so each books its cost against the same
  // daily USD kill-switch that gates the main path: reserve a pessimistic
  // estimate up front (skip the work if the budget is spent), then settle the
  // actual spend so the counter stays accurate.
  const extractModel = process.env.EXTRACT_MODEL ?? "gpt-4o-mini";
  const estCost = estimateLlmCost(
    extractModel,
    approximateTokens(`${userText}\n${assistantText}`) + 400,
    256,
  );
  // Gate extraction on the budget, but skip ONLY extraction when it's spent —
  // consolidation below makes its own separate reservation, so it must still get
  // a chance to run (and will no-op if it's also over budget).
  const reserve = await reserveBudget(estCost);
  if (reserve.ok) {
    try {
      const { facts, usage } = await extractFacts(openai(extractModel), userText, assistantText);
      await settleBudget(
        estCost,
        estimateLlmCost(extractModel, usage.inputTokens, usage.outputTokens),
      );
      for (const fact of facts) {
        await rememberFact(fact.content, userId, {
          importance: fact.importance,
          tags: fact.tags,
        });
      }
    } catch (e) {
      console.warn("memory extraction failed:", e);
    }
  }

  const consolidateModel = process.env.CONSOLIDATE_MODEL ?? extractModel;
  try {
    const result = await maybeConsolidate(userId, async (items) => {
      const joined = items.map((m) => `- ${m.content}`).join("\n");
      // Reserve for this consolidation call too; skip it if over budget.
      const estC = estimateLlmCost(consolidateModel, approximateTokens(joined) + 400, 256);
      const reserveC = await reserveBudget(estC);
      if (!reserveC.ok) {
        throw new Error("daily budget exhausted; skipping consolidation");
      }
      const { text: summary, usage } = await generateText({
        model: openai(consolidateModel),
        system:
          "Summarize these durable facts about a single user into one concise paragraph. " +
          "Preserve specifics (stack, preferences, goals); drop redundancy. Output only the summary.",
        prompt: joined,
      });
      await settleBudget(
        estC,
        estimateLlmCost(consolidateModel, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0),
      );
      return summary.trim();
    });
    if (result) {
      await recordConsolidation(result.created.length);
    }
  } catch (e) {
    console.warn("memory consolidation failed:", e);
  }
}

export async function POST(req: Request) {
  // One root span per chat turn. Child spans (cache checks, memory recall,
  // retrieval, AI SDK generations) nest under it via context propagation.
  // The span ends when the handler returns the Response — LLM streaming
  // continues in the AI SDK's own spans. No-op unless LANGWATCH_API_KEY set.
  return withSpan("chat.turn", { "langwatch.span.type": "chain" }, (span) =>
    handleChat(req, span),
  );
}

async function handleChat(req: Request, turnSpan: Span): Promise<Response> {
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

  let body: { id?: string; messages?: UIMessage[] };
  try {
    body = (await req.json()) as { id?: string; messages?: UIMessage[] };
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

  // Anonymous per-visitor identity for cross-session memory. A new visitor gets
  // a fresh httpOnly cookie id, attached to whichever response we return below.
  const { userId, setCookie } = getOrCreateUserId(req);
  const sessionHeaders = setCookie ? { "set-cookie": setCookie } : undefined;

  // Trace attribution: LangWatch groups traces by thread (useChat sends a
  // stable per-conversation `id` with every request) and user.
  turnSpan.setAttributes({
    "langwatch.user.id": userId,
    ...(typeof body.id === "string" && body.id !== "" ? { "langwatch.thread.id": body.id } : {}),
  });

  // Sync guardrails: cheap and synchronous (length, control chars, type).
  // Carry sessionHeaders on every post-mint response (errors included) so a new
  // visitor's cookie sticks on the first attempt, not only on a successful turn.
  const guardSync = validateInputSync(lastUserText);
  if (!guardSync.ok) {
    return Response.json({ error: guardSync.reason }, { status: 400, headers: sessionHeaders });
  }

  // Async guardrails: OpenAI Moderation (no-op unless MODERATION_ENABLED).
  const guardAsync = await moderateInput(lastUserText);
  if (!guardAsync.ok) {
    return Response.json({ error: guardAsync.reason }, { status: 400, headers: sessionHeaders });
  }

  // Rate limit (atomic Lua, sliding window).
  const rl = await rateLimit(ip);
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retryAfter: rl.retryAfter },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfter ?? 60), ...(sessionHeaders ?? {}) },
      },
    );
  }

  // Strip credentials from the prompt before it's stored anywhere
  // (semantic cache, logs). Doesn't change what the model sees during this
  // request - only what we persist.
  const persistedQuery = scrubSecrets(lastUserText);

  // Scrubbed + truncated on the trace, mirroring what the log stream stores.
  // Like every other content-capture path, only when explicitly opted in —
  // by default spans carry metadata only.
  if (captureContent) {
    turnSpan.setAttribute("langwatch.input", spanText(persistedQuery.slice(0, 500)));
  }

  // createOpenAI is O(1) — create it here so the judge closure can reference
  // it without capturing env. Also reused below for the LLM call.
  const openai = createOpenAI({ apiKey: env.openaiKey });

  // Detect which database the query is about so per-category threshold
  // recommendations and the rolling similarity window are segmented by topic.
  const queryCategory = detectCategory(lastUserText);

  // Convert UI messages to model messages once — reused by the agent cache
  // check, the semantic cache path, and streamText. Avoids a second conversion
  // later and ensures the LLM cache hash is identical between check and store.
  const modelMessages = await convertToModelMessages(uiMessages);

  // Build LLM cache params. System message uses string content to match the
  // LanguageModelV1Prompt format the AI SDK passes to models internally.
  const llmCacheParams: LlmCacheParams = {
    model: env.llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...modelMessages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  // ---- Agent cache: LLM tier (exact-match, O(1) hash lookup) ----
  // Check this BEFORE the semantic cache — an exact-match Valkey GET is free
  // compared to the embedding API call + vector search the semantic cache
  // requires on every request.
  try {
    const agentLlmResult = await agentCache.llm.check(llmCacheParams);
    if (agentLlmResult.hit && agentLlmResult.response) {
      const cachedText = agentLlmResult.response;

      turnSpan.setAttributes({
        "cache.llm_exact.hit": true,
        "chat.response_source": "agent_cache_llm",
      });
      if (captureContent) {
        turnSpan.setAttribute("langwatch.output", spanText(scrubSecrets(cachedText).slice(0, 2000)));
      }

      await Promise.all([
        logTurn({
          ip,
          q: persistedQuery,
          semantic: { hit: false },
          toolHits: [],
          costUsd: 0,
          llmExactHit: true,
        }),
        // Count as a hit: agent cache avoided the LLM call, latency belongs in
        // hitLatencySum not missLatencySum so avgMissLatencyMs stays accurate.
        recordTurn({ semanticHit: true, savedUsd: 0, totalLatencyMs: Date.now() - turnStart }),
      ]);

      after(async () => {
        await captureChatTurn({
          prompt: lastUserText,
          ip,
          semantic: { hit: false },
          toolHits: [],
          model: env.llmModel,
          costUsd: 0,
          totalLatencyMs: Date.now() - turnStart,
        });
        await postTurnMemory(openai, userId, persistedQuery, scrubSecrets(cachedText));
        await flushAnalytics();
      });

      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          const id = `llm-cached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const metrics: TurnMetrics = {
            semantic: { hit: false },
            toolHits: [],
            llmExactHit: true,
            savedUsd: 0,
          };
          writer.write({ type: "start", messageMetadata: metrics });
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: cachedText });
          writer.write({ type: "text-end", id });
          writer.write({ type: "finish", messageMetadata: metrics });
        },
      });
      return createUIMessageStreamResponse({ stream, headers: sessionHeaders });
    }
  } catch (e) {
    console.warn("agent cache llm check failed:", e);
  }

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
              "You are a cache quality judge for a Valkey, Redis, Dragonfly, and BetterDB documentation chatbot. " +
              "Decide whether the cached response is a good answer to the user query. " +
              'Reply "yes" if the response answers the same underlying question, even if the query is worded differently — ' +
              "paraphrases, reorderings, and different phrasings of the same question should be accepted. " +
              'Reply "no" only if the response focuses on a different entity (e.g. the cached answer is about Valkey ' +
              "but the query asks about Redis or Dragonfly specifically), or addresses a fundamentally different topic. " +
              "Output only one word: yes or no.",
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

    // A judge-accepted hit has confidence:'high' (promoted from 'uncertain')
    // AND a similarity score inside the uncertainty band.
    // Use the live threshold from the cache instance (not the env var) so
    // this stays correct after configRefresh applies a loosened threshold
    // from the optimize agent. The uncertainty band lower bound is
    // liveThreshold - band; anything below that was always high-confidence
    // and never reached the judge.
    const scBand = Number(process.env.SEMANTIC_UNCERTAINTY_BAND ?? 0.07);
    const liveThreshold = queryCategory
      ? (semanticCache._categoryThresholds[queryCategory] ?? semanticCache._defaultThreshold)
      : semanticCache._defaultThreshold;
    const judgeAccepted =
      semanticHit.confidence === "high" &&
      semanticHit.similarity !== undefined &&
      semanticHit.similarity > liveThreshold - scBand;

    turnSpan.setAttributes({
      "cache.semantic.hit": true,
      "cache.semantic.confidence": semanticHit.confidence,
      "cache.semantic.judge_accepted": judgeAccepted,
      "cache.cost_saved_usd": savedUsd,
      "cache.embed_latency_ms": embedLatencyMs,
      "chat.response_source": "semantic_cache",
      ...(semanticHit.similarity !== undefined
        ? { "cache.semantic.similarity": semanticHit.similarity }
        : {}),
    });
    if (captureContent) {
      turnSpan.setAttribute("langwatch.output", spanText(scrubSecrets(text).slice(0, 2000)));
    }

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
      await postTurnMemory(openai, userId, persistedQuery, scrubSecrets(text));
      await flushAnalytics();
    });

    // Hand-roll a v6 UIMessageStream for the cached response. The AI SDK's
    // helpers all assume there's an underlying model call - for cache hits
    // we synthesise the same protocol manually so the client treats it
    // identically to a fresh streaming response.
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = `cached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    return createUIMessageStreamResponse({ stream, headers: sessionHeaders });
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
      { status: 429, headers: sessionHeaders },
    );
  }

  // ---- Memory recall: personalize the system prompt for this visitor ----
  // Only on the LLM path (cache hits serve generic doc answers, and injecting
  // per-user memory into the cache-check params would break cross-user sharing).
  // Best-effort: a recall failure must never break the chat.
  let system = SYSTEM_PROMPT;
  // True once this turn's reply is shaped by per-visitor memory. Such a reply is
  // user-specific and must NOT be written to the shared agent/semantic caches —
  // those are keyed on the base prompt/query (no memory block), so caching it
  // would serve one visitor's memory-shaped answer to another on the same query.
  let personalized = false;
  try {
    const recallStart = Date.now();
    // Embed the scrubbed query (same text post-turn extraction/persistence use),
    // so credential-shaped content never reaches the embedding API and recall
    // stays consistent with what gets stored.
    const memories = await recallMemories(persistedQuery, userId);
    void recordMemoryRecall({
      hit: memories.length > 0,
      latencyMs: Date.now() - recallStart,
    }).catch(() => {});
    turnSpan.setAttribute("memory.recalled", memories.length);
    if (memories.length > 0) {
      const lines = memories.map((m) => `- ${m.item.content}`).join("\n");
      system = `${SYSTEM_PROMPT}\n\n## What you remember about this user\n${lines}`;
      personalized = true;
    }
  } catch (e) {
    console.warn("memory recall failed:", e);
  }

  // ---- LLM call ----
  // Miss path: record why the caches didn't answer + whether memory shaped it.
  turnSpan.setAttributes({
    "cache.semantic.hit": false,
    "chat.response_source": "llm",
    "chat.personalized": personalized,
    "cache.embed_latency_ms": embedLatencyMs,
    ...(semanticHit.nearestMiss !== undefined
      ? {
          "cache.semantic.nearest_miss": semanticHit.nearestMiss.similarity,
          // deltaToThreshold <= 0 means the score cleared the cosine threshold
          // but the judge said no — distinct from a plain cosine miss.
          "cache.semantic.judge_rejected": semanticHit.nearestMiss.deltaToThreshold <= 0,
        }
      : {}),
  });

  const toolMetas: ToolMeta[] = [];

  const result = streamText({
    model: openai(env.llmModel),
    system,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(5),
    // AI SDK OTel spans (generations, tool calls, token usage) — exported to
    // LangWatch as children of chat.turn. Inputs/outputs stay off the wire
    // unless content capture is explicitly enabled: the system prompt may
    // embed this visitor's recalled memories.
    experimental_telemetry: {
      isEnabled: telemetryEnabled,
      functionId: "chat-turn",
      recordInputs: captureContent,
      recordOutputs: captureContent,
    },
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

      // Store in both caches — but only when the reply wasn't personalized by
      // this visitor's memory. A memory-shaped answer is user-specific, and both
      // cache keys omit the memory block (llmCacheParams uses the base
      // SYSTEM_PROMPT; the semantic cache keys on the bare query), so caching it
      // would leak one visitor's answer to the next on the same question.
      // llmCacheParams was built before the LLM call so the hash is identical to
      // the one used in the upfront check above.
      const agentLlmStorePromise = personalized
        ? Promise.resolve()
        : agentCache.llm
            .store(llmCacheParams, text, { tokens: { input: inputTokens, output: outputTokens } })
            .catch((e) => console.warn("agent cache llm store failed:", e));

      // Store with model + tokens so subsequent semantic-cache hits can
      // report an accurate `costSaved`. This is the key change vs. before:
      // the cache itself becomes the source of truth for savings.
      const semanticStorePromise = personalized
        ? Promise.resolve()
        : semanticCache
            .store(lastUserText, text, {
              model: env.llmModel,
              inputTokens,
              outputTokens,
              category: queryCategory,
            })
            .catch((e) => console.warn("semantic cache store failed:", e));

      await Promise.all([
        agentLlmStorePromise,
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

      // Learn facts + run the throttled consolidation pass. Deferred so neither
      // LLM call adds latency to the stream; best-effort so it never breaks it.
      after(() => postTurnMemory(openai, userId, persistedQuery, scrubSecrets(text)));
    },
  });

  return result.toUIMessageStreamResponse({
    headers: sessionHeaders,
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
            semanticHit.nearestMiss !== undefined && semanticHit.nearestMiss.deltaToThreshold <= 0,
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
