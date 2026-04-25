import { streamText, wrapLanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAgentCacheMiddleware } from "@betterdb/agent-cache/ai";
import { initCaches, agentCache, semanticCache } from "@/lib/cache";
import { tools } from "@/lib/tools";
import { rateLimit, isBudgetExceeded, checkBudget } from "@/lib/rate-limit";
import { validateInput } from "@/lib/guardrails";
import { logTurn } from "@/lib/logger";
import { recordTurn } from "@/lib/stats";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import type { ToolMeta } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Cost estimate for gpt-4o-mini: $0.00015/1k in, $0.0006/1k out
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const table: Record<string, { in: number; out: number }> = {
    "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
    "gpt-4o": { in: 0.0025, out: 0.01 },
  };
  const rates = table[model] ?? { in: 0.00015, out: 0.0006 };
  return (inputTokens / 1000) * rates.in + (outputTokens / 1000) * rates.out;
}

export async function POST(req: Request) {
  await initCaches();

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  let body: { messages?: unknown[] };
  try {
    body = (await req.json()) as { messages?: unknown[] };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = (body.messages ?? []) as Array<{
    role: string;
    content: string;
  }>;
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user")?.content ?? "";

  // Guardrails
  const guard = validateInput(lastUser);
  if (!guard.ok) {
    return Response.json({ error: guard.reason }, { status: 400 });
  }

  // Rate limiting
  const rl = await rateLimit(ip);
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retryAfter: rl.retryAfter },
      { status: 429 }
    );
  }

  // Semantic cache check
  const semanticStart = Date.now();
  const semanticHit = await semanticCache.check(lastUser);
  const embedLatencyMs = Date.now() - semanticStart;

  if (semanticHit.hit && semanticHit.response) {
    const savedUsd = 0.001; // estimated savings for a typical response
    await Promise.all([
      logTurn({
        ip,
        q: lastUser,
        semantic: { hit: true, similarity: semanticHit.similarity, savedUsd },
        toolHits: [],
        costUsd: 0,
      }),
      recordTurn({ semanticHit: true, savedUsd }),
    ]);

    const metricsHeader = JSON.stringify({
      semanticHit: true,
      similarity: semanticHit.similarity,
      embedLatencyMs,
      savedUsd,
      toolHits: [],
    });

    // Stream the cached response as SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const text = semanticHit.response!;
        // Send as AI SDK data stream format
        controller.enqueue(
          encoder.encode(`0:${JSON.stringify(text)}\n`)
        );
        controller.enqueue(
          encoder.encode(
            `2:${JSON.stringify([{ type: "metrics", data: JSON.parse(metricsHeader) }])}\n`
          )
        );
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "X-Metrics": metricsHeader,
        "Cache-Control": "no-cache",
      },
    });
  }

  // Budget check before calling LLM
  const budgetExceeded = await isBudgetExceeded();
  if (budgetExceeded) {
    return Response.json(
      { error: "Daily budget exceeded. Try again tomorrow." },
      { status: 429 }
    );
  }

  // Build cached LLM model
  const llmModel = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = wrapLanguageModel({
    model: openai(llmModel),
    middleware: createAgentCacheMiddleware({ cache: agentCache }),
  });

  const toolMetas: ToolMeta[] = [];

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools,
    maxSteps: 5,
    onStepFinish: ({ toolResults }) => {
      for (const tr of toolResults ?? []) {
        const meta = (tr.result as { _meta?: ToolMeta } | undefined)?._meta;
        if (meta) toolMetas.push(meta);
      }
    },
    onFinish: async ({ text, usage }) => {
      const inputTokens = usage?.promptTokens ?? 0;
      const outputTokens = usage?.completionTokens ?? 0;
      const costUsd = estimateCost(llmModel, inputTokens, outputTokens);
      const savedUsd = toolMetas.filter((t) => t.hit).length * 0.0001;

      await Promise.all([
        semanticCache.store(lastUser, text),
        checkBudget(costUsd),
        logTurn({
          ip,
          q: lastUser,
          semantic: { hit: false },
          toolHits: toolMetas,
          usage: { promptTokens: inputTokens, completionTokens: outputTokens },
          costUsd,
        }),
        recordTurn({ semanticHit: false, savedUsd, costUsd }),
      ]);
    },
  });

  return result.toDataStreamResponse({
    headers: {
      "X-Metrics": JSON.stringify({
        semanticHit: false,
        embedLatencyMs,
        toolHits: toolMetas,
      }),
    },
  });
}
