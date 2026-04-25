import { valkey } from "./valkey";
import type { GlobalStats } from "./types";

const K = {
  msgs: "playground:stats:total_messages",
  saved: "playground:stats:total_saved_usd_micros",
  hits: "playground:stats:total_hits",
  misses: "playground:stats:total_misses",
};

export async function recordTurn(opts: {
  semanticHit: boolean;
  savedUsd: number;
  costUsd?: number;
}): Promise<void> {
  const micros = Math.round(opts.savedUsd * 1_000_000);
  const p = valkey.pipeline();
  p.incr(K.msgs);
  if (micros > 0) p.incrby(K.saved, micros);
  if (opts.semanticHit) p.incr(K.hits);
  else p.incr(K.misses);
  await p.exec();
}

export async function readStats(): Promise<GlobalStats> {
  const [msgs, savedMicros, hits, misses] = await Promise.all([
    valkey.get(K.msgs),
    valkey.get(K.saved),
    valkey.get(K.hits),
    valkey.get(K.misses),
  ]);

  const totalHits = Number(hits ?? 0);
  const totalMisses = Number(misses ?? 0);
  const total = totalHits + totalMisses;

  return {
    totalMessages: Number(msgs ?? 0),
    totalSavedUsd: Number(savedMicros ?? 0) / 1_000_000,
    totalHits,
    totalMisses,
    hitRate: total > 0 ? totalHits / total : 0,
  };
}
