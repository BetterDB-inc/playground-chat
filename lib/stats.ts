import { valkey } from "./valkey";
import { agentCache, semanticCache, initCaches } from "./cache";
import type { GlobalStats } from "./types";

/**
 * Global counters maintained by /api/chat. Per-turn we increment a few of
 * these directly; we also pull authoritative `costSavedMicros` from the
 * agent-cache and semantic-cache packages so the displayed savings reflect
 * what those packages actually computed (model + token-aware), not a local
 * approximation.
 */

const K = {
  msgs: "playground:stats:total_messages",
  hits: "playground:stats:total_hits",
  misses: "playground:stats:total_misses",
};

export async function recordTurn(opts: {
  semanticHit: boolean;
  savedUsd: number;
  costUsd?: number;
}): Promise<void> {
  // savedUsd / costUsd no longer flow into Valkey from here - the cache
  // packages own those counters. We only track turn count + hit/miss split.
  void opts.savedUsd;
  void opts.costUsd;
  const p = valkey.pipeline();
  p.incr(K.msgs);
  if (opts.semanticHit) p.incr(K.hits);
  else p.incr(K.misses);
  await p.exec();
}

export async function readStats(): Promise<GlobalStats> {
  // Ensure the cache packages are initialised before calling .stats() on
  // them - otherwise semanticCache.stats() throws `not initialized`, the
  // catch() below swallows it, and we silently report 0 saved. /api/stats
  // is reachable without going through the chat route's own initCaches()
  // call, so we do it here defensively.
  await initCaches();

  const [msgsRaw, hitsRaw, missesRaw, agentStats, semStats] = await Promise.all([
    valkey.get(K.msgs),
    valkey.get(K.hits),
    valkey.get(K.misses),
    agentCache.stats().catch(() => null),
    semanticCache.stats().catch(() => null),
  ]);

  const totalHits = Number(hitsRaw ?? 0);
  const totalMisses = Number(missesRaw ?? 0);
  const total = totalHits + totalMisses;

  const agentSavedMicros = agentStats?.costSavedMicros ?? 0;
  const semSavedMicros = semStats?.costSavedMicros ?? 0;
  const totalSavedUsd = (agentSavedMicros + semSavedMicros) / 1_000_000;

  return {
    totalMessages: Number(msgsRaw ?? 0),
    totalSavedUsd,
    totalHits,
    totalMisses,
    hitRate: total > 0 ? totalHits / total : 0,
  };
}
