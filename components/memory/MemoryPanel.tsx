"use client";

import { useCallback, useEffect, useState } from "react";
import { MemoryItemCard, type MemoryItemView } from "./MemoryItemCard";

interface MemoryListResult {
  items: MemoryItemView[];
  total: number;
  forgetEnabled?: boolean;
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Lists what the assistant remembers about this visitor (via /api/memory →
 * agent-memory `list`). Refetches on each completed turn (`refreshKey`) so a
 * newly-learned fact shows up right away, and polls as a backstop. Each fact
 * carries a governed Forget action (files a proposal in the Monitor).
 */
export function MemoryPanel({ refreshKey }: { refreshKey?: number }) {
  const [items, setItems] = useState<MemoryItemView[]>([]);
  const [forgetEnabled, setForgetEnabled] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [hasError, setHasError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MemoryListResult;
      setItems(data.items ?? []);
      setForgetEnabled(Boolean(data.forgetEnabled));
      setHasError(false);
    } catch (err) {
      console.warn("/api/memory failed:", err instanceof Error ? err.message : err);
      setHasError(true);
    }
  }, []);

  const handleForget = useCallback(async (id: string) => {
    try {
      const res = await fetch("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPendingIds((prev) => new Set(prev).add(id));
    } catch (err) {
      console.warn("/api/memory/forget failed:", err instanceof Error ? err.message : err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground leading-relaxed">
        {hasError
          ? "Couldn't load memories right now."
          : "Nothing remembered yet. Tell the assistant about yourself — what you're building, your stack, how you like answers — and it'll remember next time you visit."}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <MemoryItemCard
          key={item.id}
          item={item}
          forgetEnabled={forgetEnabled}
          pending={pendingIds.has(item.id)}
          onForget={handleForget}
        />
      ))}
    </ul>
  );
}
