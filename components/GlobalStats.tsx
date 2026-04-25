"use client";

import { useEffect, useState, useCallback } from "react";
import type { GlobalStats } from "@/lib/types";
import { usePageVisible } from "@/hooks/usePageVisible";

const POLL_INTERVAL_MS = 15_000;

export function GlobalStats() {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const visible = usePageVisible();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (res.ok) setStats((await res.json()) as GlobalStats);
    } catch {
      // Polled; transient errors are fine.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    fetchStats();
    const id = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible, fetchStats]);

  if (!stats) {
    return (
      <div className="grid grid-cols-3 gap-2.5">
        {["q", "s", "h"].map((k) => (
          <div key={k} className="h-16 bg-card border border-border rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  const hitPct = Math.round(stats.hitRate * 100);

  return (
    <div className="grid grid-cols-3 gap-2.5">
      <StatCard label="Questions answered" value={stats.totalMessages.toLocaleString()} />
      <StatCard label="Saved by caching" value={formatUsd(stats.totalSavedUsd)} accent />
      <StatCard label="Cache hit rate" value={`${hitPct}%`} accent={hitPct > 50} />
    </div>
  );
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
