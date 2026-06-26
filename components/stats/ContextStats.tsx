"use client";

import { useCallback, useEffect, useState } from "react";

interface ContextStatsData {
  retrieval: { numDocs: number; percentIndexed: number; indexingState: string } | null;
  memory: { stored: number; evictions: number } | null;
}

const POLL_INTERVAL_MS = 15_000;

/** Display a 0..1 fraction (or already-0..100) as a whole percent. */
function fmtPct(p: number): string {
  return `${(p <= 1 ? p * 100 : p).toFixed(0)}%`;
}

/**
 * Compact context-layer gauges next to the cache metrics: retrieval index
 * health (docs indexed + % backfilled) and the agent-memory store size.
 */
export function ContextStats() {
  const [data, setData] = useState<ContextStatsData>({ retrieval: null, memory: null });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/context-stats", { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as ContextStatsData);
    } catch {
      // keep last-known values
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const { retrieval, memory } = data;

  return (
    <div className="space-y-1.5">
      <Row
        label="Docs indexed"
        value={retrieval ? `${retrieval.numDocs} · ${fmtPct(retrieval.percentIndexed)}` : "—"}
      />
      <Row label="Memories stored" value={memory ? String(memory.stored) : "—"} />
      <Row label="Evictions" value={memory ? String(memory.evictions) : "—"} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}
