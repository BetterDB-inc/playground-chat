"use client";

import { useEffect, useState } from "react";
import type { GlobalStats } from "@/lib/types";

export function GlobalStats() {
  const [stats, setStats] = useState<GlobalStats | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        if (res.ok) setStats(await res.json() as GlobalStats);
      } catch {
        // ignore
      }
    }
    fetchStats();
    const id = setInterval(fetchStats, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!stats) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-[#1A3F54]/40 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  const hitPct = Math.round(stats.hitRate * 100);

  return (
    <div className="grid grid-cols-3 gap-3">
      <StatCard
        label="Questions answered"
        value={stats.totalMessages.toLocaleString()}
      />
      <StatCard
        label="Saved by caching"
        value={`$${stats.totalSavedUsd.toFixed(2)}`}
        accent
      />
      <StatCard
        label="Cache hit rate"
        value={`${hitPct}%`}
        accent={hitPct > 50}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-[#1A3F54]/50 border border-[#1A3F54] p-3 text-center">
      <div
        className={`text-lg font-bold tabular-nums ${
          accent ? "text-[#2DD4BF]" : "text-slate-100"
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-slate-400 mt-0.5 leading-tight">{label}</div>
    </div>
  );
}
