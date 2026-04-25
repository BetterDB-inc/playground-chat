"use client";

import { useState } from "react";
import { Chat } from "@/components/Chat";
import { MetricsPanel } from "@/components/MetricsPanel";
import type { TurnMetrics } from "@/lib/types";

export default function Home() {
  const [turns, setTurns] = useState<TurnMetrics[]>([]);

  function handleTurnComplete(metrics: TurnMetrics) {
    setTurns((prev) => [...prev, metrics]);
  }

  return (
    <main className="flex h-screen overflow-hidden">
      {/* Chat panel — 2/3 width */}
      <div className="flex-[2] min-w-0 overflow-hidden">
        <Chat onTurnComplete={handleTurnComplete} />
      </div>

      {/* Metrics panel — 1/3 width */}
      <div className="flex-[1] min-w-[280px] max-w-sm overflow-hidden">
        <MetricsPanel turns={turns} />
      </div>
    </main>
  );
}
