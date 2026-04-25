"use client";

import { GlobalStats } from "./GlobalStats";
import { TurnMetrics } from "./TurnMetrics";
import type { TurnMetrics as TurnMetricsType } from "@/lib/types";

interface Props {
  turns: TurnMetricsType[];
}

export function MetricsPanel({ turns }: Props) {
  return (
    <aside className="flex flex-col h-full bg-[#0f1923] border-l border-[#1A3F54]/60 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1A3F54]/60 flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-[#2DD4BF] animate-pulse" />
        <h2 className="text-sm font-semibold text-slate-200">Cache Metrics</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Global stats */}
        <section>
          <SectionLabel>All-time</SectionLabel>
          <GlobalStats />
        </section>

        {/* Per-turn */}
        <section>
          <SectionLabel>This session</SectionLabel>
          <TurnMetrics turns={turns} />
        </section>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[#1A3F54]/60">
        <p className="text-[10px] text-slate-600 text-center">
          Powered by{" "}
          <span className="text-[#2DD4BF]">@betterdb/agent-cache</span> &amp;{" "}
          <span className="text-[#2DD4BF]">@betterdb/semantic-cache</span>
        </p>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
      {children}
    </div>
  );
}
