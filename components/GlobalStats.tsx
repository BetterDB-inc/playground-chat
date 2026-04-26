"use client";

import { useEffect, useState, useCallback } from "react";
import type { GlobalStats } from "@/lib/types";
import { usePageVisible } from "@/hooks/usePageVisible";

const POLL_INTERVAL_MS = 15_000;
/** Time without a successful poll before we surface an error state. */
const ERROR_AFTER_MS = 60_000;

interface State {
  stats: GlobalStats | null;
  /** Wall-clock ms timestamp of the last successful fetch, or null if never. */
  lastSuccessAt: number | null;
  /** Whether the most recent fetch errored. */
  hasError: boolean;
}

export function GlobalStats() {
  const [state, setState] = useState<State>({
    stats: null,
    lastSuccessAt: null,
    hasError: false,
  });
  const visible = usePageVisible();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GlobalStats;
      setState({ stats: data, lastSuccessAt: Date.now(), hasError: false });
    } catch (err) {
      // Don't blow away the last-known-good stats - keep showing them but
      // mark the state as errored so the UI can surface a hint.
      console.warn("/api/stats failed:", err instanceof Error ? err.message : err);
      setState((prev) => ({ ...prev, hasError: true }));
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    fetchStats();
    const id = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible, fetchStats]);

  // Initial-load skeleton: only when we have nothing AND no error yet.
  if (!state.stats && !state.hasError) {
    return (
      <div className="grid grid-cols-3 gap-2.5">
        {["q", "s", "h"].map((k) => (
          <div key={k} className="h-16 bg-card border border-border rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  // Errored before we ever loaded anything: explicit failure UI.
  if (!state.stats && state.hasError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2 text-center">
        Could not load stats. Retrying every {POLL_INTERVAL_MS / 1000}s.
      </div>
    );
  }

  // We have data. If we've been unable to refresh for a while, dim the cards
  // and add a stale-data hint without flushing the last known values.
  const stats = state.stats!;
  const stale =
    state.hasError &&
    state.lastSuccessAt !== null &&
    Date.now() - state.lastSuccessAt > ERROR_AFTER_MS;
  const hitPct = Math.round(stats.hitRate * 100);

  return (
    <div className={`space-y-2.5 ${stale ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-3 gap-2.5">
        <StatCard label="Questions answered" value={stats.totalMessages.toLocaleString()} />
        <StatCard label="Saved by caching" value={formatUsd(stats.totalSavedUsd)} accent />
        <StatCard
          label={stale ? "Cache hit rate (stale)" : "Cache hit rate"}
          value={`${hitPct}%`}
          accent={hitPct > 50}
        />
      </div>
      <div className="grid grid-cols-1 gap-2.5">
        <StatCard
          label={`Time saved by caching (vs ${formatLatency(stats.avgMissLatencyMs)} avg miss)`}
          value={formatDuration(stats.totalSavedSeconds)}
          accent
        />
      </div>
    </div>
  );
}

/**
 * Format a duration in seconds as a human-friendly string.
 *  90    -> "1m 30s"
 *  3700  -> "1h 1m"
 *  259200 -> "3d 0h"
 */
function formatDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Format a millisecond latency as "1.2s" or "850ms". */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format a USD amount, preserving micro-dollar precision when the value is
 * meaningful but smaller than a cent.
 */
function formatUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-card border border-border p-3 text-center">
      <div
        className={`text-lg font-semibold tabular-nums tracking-tight leading-none ${
          accent ? "text-primary" : "text-foreground"
        }`}
        title={value}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1.5 leading-tight">{label}</div>
    </div>
  );
}
