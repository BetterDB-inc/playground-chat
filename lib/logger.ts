import { valkey } from "./valkey";
import { hashIp } from "./client-ip";
import { scrubSecrets } from "./secrets";
import { cmd } from "./valkey-cmd";
import type { ToolMeta } from "./types";

interface LogTurnOpts {
  /** Raw client IP - will be hashed before storage. */
  ip: string;
  /** Raw user query - will be scrubbed for secrets and truncated. */
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
  llmExactHit?: boolean;
}

const MAX_QUERY_LOGGED = 500;

/**
 * Append a request log entry to a Valkey Stream.
 *
 * Privacy:
 *  - IPs are hashed with a daily-rotating HMAC salt (see lib/client-ip.ts).
 *    Same-day same-IP entries can be correlated for abuse investigation;
 *    cross-day correlation requires the original salt.
 *  - User queries are passed through `scrubSecrets` before storage so
 *    obvious credentials (API keys, JWTs, AWS keys) are redacted.
 *
 * Failures are swallowed by design - a logging hiccup must never break the
 * chat response. We do `console.warn` so issues surface in dev / `vercel
 * logs`.
 */
export async function logTurn(opts: LogTurnOpts): Promise<void> {
  const streamKey = process.env.LOG_STREAM_KEY ?? "playground:logs";
  const maxLen = Number(process.env.LOG_STREAM_MAXLEN ?? 10000);

  const toolHitsStr = opts.toolHits
    .map((t) => `${t.name}:${t.hit ? "HIT" : "MISS"}:${t.latencyMs}ms`)
    .join(",");
  const costUsd = opts.costUsd ?? 0;
  const savedUsd = opts.semantic.savedUsd ?? 0;
  const sanitisedQ = scrubSecrets(opts.q).slice(0, MAX_QUERY_LOGGED);

  try {
    await cmd(
      valkey,
      "XADD",
      streamKey,
      "MAXLEN",
      "~",
      String(maxLen),
      "*",
      "ts",
      new Date().toISOString(),
      "ip_hash",
      hashIp(opts.ip),
      "q",
      sanitisedQ,
      "semantic_hit",
      String(opts.semantic.hit),
      "similarity",
      String(opts.semantic.similarity ?? ""),
      "llm_exact_hit",
      String(opts.llmExactHit ?? ""),
      "tool_hits",
      toolHitsStr,
      "tokens_in",
      String(opts.usage?.promptTokens ?? ""),
      "tokens_out",
      String(opts.usage?.completionTokens ?? ""),
      "cost_usd",
      String(costUsd),
      "saved_usd",
      String(savedUsd),
    );
  } catch (e) {
    console.warn("logTurn failed:", e instanceof Error ? e.message : e);
  }
}
