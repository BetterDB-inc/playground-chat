/**
 * PostHog telemetry, mirrored from the @betterdb/* package pattern in
 * `monitor/packages/{semantic-cache,agent-cache}/src/analytics.ts`:
 *
 *   - Lazy import of `posthog-node` so the dep stays optional. If it isn't
 *     installed (or any init step throws) we silently degrade to a NOOP
 *     client and the chat route never breaks.
 *   - Env-var-driven config (`BETTERDB_POSTHOG_API_KEY`, `BETTERDB_POSTHOG_HOST`),
 *     same names as the rest of the org so a single PostHog project can
 *     receive events from every BetterDB surface.
 *   - Single global opt-out via `BETTERDB_TELEMETRY=false|0|no|off`.
 *   - Stable per-deployment `distinctId` stored in Valkey so PostHog can
 *     group events by instance even across function cold starts.
 *
 * What we send (event: `chat_turn`):
 *   - The raw user prompt
 *   - The raw client IP
 *   - Cache hit/miss + similarity + dollars saved
 *   - Tool hits + per-tool latency
 *   - Token counts, cost, model, total duration
 *
 * This deliberately bypasses the secret scrubber and IP hasher used by
 * `lib/logger.ts`. The premise: we don't want to keep a queryable copy
 * locally, we want PostHog to be the system of record for prompt-level
 * analytics. Operators who don't want raw data leaving their box should
 * leave `BETTERDB_POSTHOG_API_KEY` unset (the default) or set
 * `BETTERDB_TELEMETRY=false`.
 */

import { valkey } from "./valkey";
import { randomUUID } from "node:crypto";

export interface ChatTurnEvent {
  /** Raw user prompt, untruncated. */
  prompt: string;
  /** Raw client IP (or the per-request token if the IP wasn't detectable). */
  ip: string;
  semantic: {
    hit: boolean;
    similarity?: number;
    savedUsd?: number;
    embedLatencyMs?: number;
  };
  toolHits: Array<{ name: string; hit: boolean; latencyMs: number }>;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  /** End-to-end ms from request receipt to onFinish. */
  totalLatencyMs: number;
}

interface AnalyticsClient {
  capture(event: ChatTurnEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP: AnalyticsClient = {
  capture: () => {
    /* no-op */
  },
  flush: async () => {
    /* no-op */
  },
  shutdown: async () => {
    /* no-op */
  },
};

function isOptedOut(): boolean {
  const v = (process.env.BETTERDB_TELEMETRY ?? "").trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
}

const INSTANCE_KEY = "playground:__instance_id";

/**
 * Persistent per-deployment id. Generated once and stored in Valkey so
 * every Vercel function invocation reuses the same value. Used as the
 * PostHog `distinctId` so events from one deployment cluster together.
 */
async function getOrCreateInstanceId(): Promise<string> {
  try {
    const existing = await valkey.get(INSTANCE_KEY);
    if (existing) return existing;
    const fresh = randomUUID();
    // SETNX so two cold starts racing each other don't double-write.
    const set = await valkey.set(INSTANCE_KEY, fresh, "NX");
    if (set === "OK") return fresh;
    return (await valkey.get(INSTANCE_KEY)) ?? fresh;
  } catch {
    // Fall back to an ephemeral id - telemetry will still work, but events
    // from this process won't group with prior ones.
    return randomUUID();
  }
}

let _client: Promise<AnalyticsClient> | null = null;

async function buildClient(): Promise<AnalyticsClient> {
  if (isOptedOut()) return NOOP;
  const apiKey = process.env.BETTERDB_POSTHOG_API_KEY;
  if (!apiKey) return NOOP;

  const host = process.env.BETTERDB_POSTHOG_HOST;
  const distinctId = await getOrCreateInstanceId();

  try {
    // Lazy import: the dep is optional, so don't break installs that don't
    // have posthog-node.
    const mod = (await import("posthog-node")) as {
      PostHog: new (
        key: string,
        opts: { host?: string; flushAt?: number; flushInterval?: number },
      ) => {
        capture: (args: {
          distinctId: string;
          event: string;
          properties: Record<string, unknown>;
        }) => void;
        flush: () => Promise<void>;
        shutdown: () => Promise<void>;
      };
    };
    const ph = new mod.PostHog(apiKey, {
      host,
      flushAt: 20,
      flushInterval: 10_000,
    });

    return {
      capture: (event) => {
        const props: Record<string, unknown> = {
          prompt: event.prompt,
          ip: event.ip,
          model: event.model,
          semantic_hit: event.semantic.hit,
          semantic_similarity: event.semantic.similarity,
          semantic_saved_usd: event.semantic.savedUsd,
          embed_latency_ms: event.semantic.embedLatencyMs,
          tool_hits: event.toolHits,
          tool_hit_count: event.toolHits.filter((t) => t.hit).length,
          tool_miss_count: event.toolHits.filter((t) => !t.hit).length,
          prompt_tokens: event.promptTokens,
          completion_tokens: event.completionTokens,
          cost_usd: event.costUsd,
          total_latency_ms: event.totalLatencyMs,
          deployment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "dev",
          // Standard PostHog hint so the event UI shows where it came from.
          $lib: "betterdb-playground-chat",
        };
        try {
          ph.capture({ distinctId, event: "chat_turn", properties: props });
        } catch {
          // Never let a telemetry hiccup affect the chat response.
        }
      },
      flush: async () => {
        try {
          await ph.flush();
        } catch {
          /* swallow - never let a telemetry hiccup affect the chat response. */
        }
      },
      shutdown: async () => {
        try {
          await ph.shutdown();
        } catch {
          /* swallow */
        }
      },
    };
  } catch {
    return NOOP;
  }
}

/**
 * Returns the (cached) analytics client. Safe to call from every request -
 * the underlying PostHog client and instance id are constructed once.
 */
export function getAnalytics(): Promise<AnalyticsClient> {
  if (!_client) _client = buildClient();
  return _client;
}

/**
 * Convenience: fire-and-forget capture. Awaits client construction (one
 * round-trip to Valkey on the first call), then schedules the event for
 * the next batch flush. Returns immediately - does NOT await network I/O
 * to PostHog.
 */
export async function captureChatTurn(event: ChatTurnEvent): Promise<void> {
  const c = await getAnalytics();
  c.capture(event);
}

/**
 * Force the in-memory PostHog queue to be sent NOW. Intended for use with
 * Next.js's `after()` (or Vercel's `waitUntil`) so events buffered during a
 * request are delivered before the serverless function gets frozen. Without
 * this, on a low-traffic deployment most events never leave the lambda - the
 * 10s flushInterval timer doesn't fire because the runtime suspends the
 * process the moment the response stream closes.
 */
export async function flushAnalytics(): Promise<void> {
  const c = await getAnalytics();
  await c.flush();
}
