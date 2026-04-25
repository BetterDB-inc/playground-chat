import { valkey } from "./valkey";
import type { ToolMeta } from "./types";

interface LogTurnOpts {
  ip: string;
  q: string;
  semantic: {
    hit: boolean;
    similarity?: number;
    savedUsd?: number;
  };
  toolHits: ToolMeta[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  costUsd?: number;
}

export async function logTurn(opts: LogTurnOpts): Promise<void> {
  const streamKey = process.env.LOG_STREAM_KEY ?? "playground:logs";
  const maxLen = Number(process.env.LOG_STREAM_MAXLEN ?? 10000);

  const toolHitsStr = opts.toolHits
    .map((t) => `${t.name}:${t.hit ? "HIT" : "MISS"}:${t.latencyMs}ms`)
    .join(",");

  const costUsd = opts.costUsd ?? 0;
  const savedUsd = opts.semantic.savedUsd ?? 0;

  try {
    await (valkey as unknown as {
      xadd: (...args: unknown[]) => Promise<unknown>;
    }).xadd(
      streamKey,
      "MAXLEN",
      "~",
      String(maxLen),
      "*",
      "ts", new Date().toISOString(),
      "ip", opts.ip,
      "q", opts.q.slice(0, 500),
      "semantic_hit", String(opts.semantic.hit),
      "similarity", String(opts.semantic.similarity ?? ""),
      "tool_hits", toolHitsStr,
      "tokens_in", String(opts.usage?.promptTokens ?? ""),
      "tokens_out", String(opts.usage?.completionTokens ?? ""),
      "cost_usd", String(costUsd),
      "saved_usd", String(savedUsd)
    );
  } catch {
    // Non-fatal: logging failure should not break the chat response
  }
}
