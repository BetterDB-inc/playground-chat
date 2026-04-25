"use client";

import { GlobalStats } from "./GlobalStats";
import { TurnMetrics } from "./TurnMetrics";
import type { TurnMetrics as TurnMetricsType } from "@/lib/types";

interface Props {
  turns: { id: string; metrics: TurnMetricsType }[];
}

export function MetricsPanel({ turns }: Props) {
  return (
    <aside className="flex flex-col h-full bg-background border-l border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <h2 className="text-sm font-semibold text-foreground tracking-tight">Cache Metrics</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <section>
          <SectionLabel>All-time</SectionLabel>
          <GlobalStats />
        </section>

        <section>
          <SectionLabel>This session</SectionLabel>
          <TurnMetrics turns={turns} />
        </section>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border">
        <p className="text-[10px] text-muted-foreground/70 text-center">
          Powered by <span className="text-primary font-medium">@betterdb/agent-cache</span> &amp;{" "}
          <span className="text-primary font-medium">@betterdb/semantic-cache</span>
        </p>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2.5 font-medium">
      {children}
    </div>
  );
}
