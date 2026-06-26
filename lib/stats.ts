import { valkey } from "./valkey";
import { agentCache, semanticCache, initCaches } from "./cache";
import type { GlobalStats } from "./types";

/**
 * Global counters maintained by /api/chat. Per-turn we increment a few of
 * these directly; we also pull authoritative `costSavedMicros` from the
 * agent-cache and semantic-cache packages so the displayed savings reflect
 * what those packages actually computed (model + token-aware), not a local
 * approximation.
 *
 * Latency tracking: we keep a rolling sum + count of full LLM-turn latency
 * and a separate rolling sum of cache-hit latency. "Time saved" is then
 * `(sum_miss / count_miss) * count_hit - sum_hit_latency`. We use sums (not
 * exponential moving averages) so the calculation stays stable across
 * function-instance restarts; the values are stored in Valkey.
 */

const K = {
  msgs: "playground:stats:total_messages",
  hits: "playground:stats:total_hits",
  misses: "playground:stats:total_misses",
  // Latency counters (in milliseconds, integer Valkey INCRBY-safe values)
  missLatencySum: "playground:stats:miss_latency_ms_sum",
  hitLatencySum: "playground:stats:hit_latency_ms_sum",
};

/**
 * Context-layer counters (memory recall + retrieval) tracked the same way as the
 * cache counters above: integer rolling sums in Valkey, averaged on read. They
 * feed the "Retrieval & memory store" section of the metrics panel.
 */
const CTX = {
  recallTotal: "playground:mem:recall_total",
  recallHits: "playground:mem:recall_hits",
  recallLatencySum: "playground:mem:recall_latency_ms_sum",
  consolidations: "playground:mem:consolidations",
  queryTotal: "playground:rag:query_total",
  queryLatencySum: "playground:rag:query_latency_ms_sum",
  docsRetrievedSum: "playground:rag:docs_retrieved_sum",
};

export async function recordTurn(opts: {
  semanticHit: boolean;
  savedUsd: number;
  costUsd?: number;
  /** Wall-clock duration of the turn from request receipt to response done. */
  totalLatencyMs?: number;
}): Promise<void> {
  // savedUsd / costUsd no longer flow into Valkey from here - the cache
  // packages own those counters. We only track turn count + hit/miss split
  // and the latency rolling sums.
  void opts.savedUsd;
  void opts.costUsd;
  const p = valkey.pipeline();
  p.incr(K.msgs);
  if (opts.semanticHit) {
    p.incr(K.hits);
    if (opts.totalLatencyMs !== undefined) {
      p.incrby(K.hitLatencySum, Math.round(opts.totalLatencyMs));
    }
  } else {
    p.incr(K.misses);
    if (opts.totalLatencyMs !== undefined) {
      p.incrby(K.missLatencySum, Math.round(opts.totalLatencyMs));
    }
  }
  await p.exec();
}

/** Record one memory recall: whether it returned anything, and how long it took. */
export async function recordMemoryRecall(opts: { hit: boolean; latencyMs: number }): Promise<void> {
  const p = valkey.pipeline();
  p.incr(CTX.recallTotal);
  if (opts.hit) {
    p.incr(CTX.recallHits);
  }
  p.incrby(CTX.recallLatencySum, Math.round(opts.latencyMs));
  await p.exec();
}

/** Record a consolidation pass that compressed `created` old memories into summaries. */
export async function recordConsolidation(created: number): Promise<void> {
  if (created <= 0) {
    return;
  }
  await valkey.incrby(CTX.consolidations, created);
}

/** Record one retrieval query: how long the vector search took and how many docs it returned. */
export async function recordRetrievalQuery(opts: {
  latencyMs: number;
  docs: number;
}): Promise<void> {
  const p = valkey.pipeline();
  p.incr(CTX.queryTotal);
  p.incrby(CTX.queryLatencySum, Math.round(opts.latencyMs));
  p.incrby(CTX.docsRetrievedSum, opts.docs);
  await p.exec();
}

export interface ContextCounters {
  recallTotal: number;
  recallHits: number;
  recallHitRate: number;
  avgRecallLatencyMs: number;
  consolidations: number;
  queryTotal: number;
  avgQueryLatencyMs: number;
  avgDocsPerTurn: number;
}

/** All-time memory-recall + retrieval aggregates for the metrics panel. */
export async function readContextCounters(): Promise<ContextCounters> {
  const [rtRaw, rhRaw, rlsRaw, consRaw, qtRaw, qlsRaw, drsRaw] = await Promise.all([
    valkey.get(CTX.recallTotal),
    valkey.get(CTX.recallHits),
    valkey.get(CTX.recallLatencySum),
    valkey.get(CTX.consolidations),
    valkey.get(CTX.queryTotal),
    valkey.get(CTX.queryLatencySum),
    valkey.get(CTX.docsRetrievedSum),
  ]);

  const recallTotal = Number(rtRaw ?? 0);
  const recallHits = Number(rhRaw ?? 0);
  const recallLatencySum = Number(rlsRaw ?? 0);
  const queryTotal = Number(qtRaw ?? 0);
  const queryLatencySum = Number(qlsRaw ?? 0);
  const docsRetrievedSum = Number(drsRaw ?? 0);

  return {
    recallTotal,
    recallHits,
    recallHitRate: recallTotal > 0 ? recallHits / recallTotal : 0,
    avgRecallLatencyMs: recallTotal > 0 ? recallLatencySum / recallTotal : 0,
    consolidations: Number(consRaw ?? 0),
    queryTotal,
    avgQueryLatencyMs: queryTotal > 0 ? queryLatencySum / queryTotal : 0,
    avgDocsPerTurn: queryTotal > 0 ? docsRetrievedSum / queryTotal : 0,
  };
}

export async function readStats(): Promise<GlobalStats> {
  // Ensure the cache packages are initialised before calling .stats() on
  // them - otherwise semanticCache.stats() throws `not initialized`, the
  // catch() below swallows it, and we silently report 0 saved. /api/stats
  // is reachable without going through the chat route's own initCaches()
  // call, so we do it here defensively.
  await initCaches();

  const [msgsRaw, hitsRaw, missesRaw, missLatRaw, hitLatRaw, agentStats, semStats] =
    await Promise.all([
      valkey.get(K.msgs),
      valkey.get(K.hits),
      valkey.get(K.misses),
      valkey.get(K.missLatencySum),
      valkey.get(K.hitLatencySum),
      agentCache.stats().catch(() => null),
      semanticCache.stats().catch(() => null),
    ]);

  const totalHits = Number(hitsRaw ?? 0);
  const totalMisses = Number(missesRaw ?? 0);
  const total = totalHits + totalMisses;

  const agentSavedMicros = agentStats?.costSavedMicros ?? 0;
  const semSavedMicros = semStats?.costSavedMicros ?? 0;
  const totalSavedUsd = (agentSavedMicros + semSavedMicros) / 1_000_000;

  // Latency: how long would each cache hit have taken if it had missed?
  // Estimate using the rolling average of actual misses. If we have no
  // miss data yet (cold start, only hits), fall back to a conservative 3s
  // baseline so the UI shows a non-zero number rather than 0s.
  const COLD_START_MISS_BASELINE_MS = 3000;
  const missLatencySum = Number(missLatRaw ?? 0);
  const hitLatencySum = Number(hitLatRaw ?? 0);
  const avgMissLatencyMs =
    totalMisses > 0 ? missLatencySum / totalMisses : COLD_START_MISS_BASELINE_MS;
  // Saved = (what hits WOULD have cost as misses) - (what they actually cost as hits)
  const wouldHaveTakenMs = avgMissLatencyMs * totalHits;
  const totalSavedSeconds = Math.max(0, (wouldHaveTakenMs - hitLatencySum) / 1000);

  return {
    totalMessages: Number(msgsRaw ?? 0),
    totalSavedUsd,
    totalHits,
    totalMisses,
    hitRate: total > 0 ? totalHits / total : 0,
    totalSavedSeconds,
    avgMissLatencyMs,
  };
}
