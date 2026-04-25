"use client";

import { useCallback, useState } from "react";
import { Chat } from "@/components/Chat";
import { MetricsPanel } from "@/components/MetricsPanel";
import type { TurnMetrics } from "@/lib/types";

interface KeyedTurn {
  id: string;
  metrics: TurnMetrics;
}

export default function Home() {
  const [turns, setTurns] = useState<KeyedTurn[]>([]);

  const handleTurnComplete = useCallback((metrics: TurnMetrics) => {
    setTurns((prev) => [
      ...prev,
      {
        // Stable id, used as React key. Random component handles the rare
        // case of two turns colliding inside the same millisecond.
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        metrics,
      },
    ]);
  }, []);

  return (
    // Mobile: stack chat on top, metrics below (collapsible).
    // ≥md: side-by-side, chat 2/3, metrics 1/3.
    <main className="flex flex-col md:flex-row h-screen overflow-hidden">
      <div className="flex-1 md:flex-[2] min-w-0 min-h-0 overflow-hidden">
        <Chat onTurnComplete={handleTurnComplete} />
      </div>
      <div className="md:flex-[1] md:min-w-[280px] md:max-w-sm min-h-0 overflow-hidden border-t md:border-t-0 md:border-l border-border">
        <MetricsPanel turns={turns} />
      </div>
    </main>
  );
}
