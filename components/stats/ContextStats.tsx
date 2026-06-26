"use client";

import { useCallback, useEffect, useState } from "react";
import type { ContextCounters } from "@/lib/stats";
import { usePageVisible } from "@/hooks/usePageVisible";

interface ContextStatsData {
  retrieval: { numDocs: number; percentIndexed: number; indexingState: string } | null;
  memory: { stored: number; evictions: number } | null;
  counters: ContextCounters | null;
}

const POLL_INTERVAL_MS = 15_000;

/** Display a 0..1 fraction (or already-0..100) as a whole percent. */
function fmtPct(p: number): string {
  return `${(p <= 1 ? p * 100 : p).toFixed(0)}%`;
}

/** Format a millisecond latency as "1.2s" or "850ms". */
function fmtMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Context-layer gauges next to the cache metrics, split into retrieval (index
 * health + query activity) and agent-memory (store size + recall activity).
 * All-time aggregates, polled.
 */
export function ContextStats() {
  const [data, setData] = useState<ContextStatsData>({
    retrieval: null,
    memory: null,
    counters: null,
  });
  const visible = usePageVisible();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/context-stats", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const next = (await res.json()) as ContextStatsData;
      setData(next);
    } catch (err) {
      // keep last-known values
      console.warn("/api/context-stats failed:", err instanceof Error ? err.message : err);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  const { retrieval, memory, counters } = data;

  return (
    <div className="space-y-3">
      <Group label="Retrieval">
        <Row
          label="Docs indexed"
          value={retrieval ? `${retrieval.numDocs} · ${fmtPct(retrieval.percentIndexed)}` : "—"}
        />
        <Row
          label="Query latency"
          value={counters && counters.queryTotal > 0 ? fmtMs(counters.avgQueryLatencyMs) : "—"}
        />
        <Row
          label="Docs / query"
          value={counters && counters.queryTotal > 0 ? counters.avgDocsPerTurn.toFixed(1) : "—"}
        />
      </Group>

      <Group label="Memory">
        <Row label="Memories stored" value={memory ? String(memory.stored) : "—"} />
        <Row
          label="Recall hit-rate"
          value={counters && counters.recallTotal > 0 ? fmtPct(counters.recallHitRate) : "—"}
        />
        <Row
          label="Recall latency"
          value={counters && counters.recallTotal > 0 ? fmtMs(counters.avgRecallLatencyMs) : "—"}
        />
        <Row label="Evictions" value={memory ? String(memory.evictions) : "—"} />
        <Row label="Consolidations" value={counters ? String(counters.consolidations) : "—"} />
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      {children}
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
