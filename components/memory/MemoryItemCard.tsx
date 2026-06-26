"use client";

import { useState } from "react";

export interface MemoryItemView {
  id: string;
  content: string;
  importance: number;
  tags: string[];
  createdAt: number;
}

interface Props {
  item: MemoryItemView;
  forgetEnabled: boolean;
  pending: boolean;
  onForget: (id: string) => void | Promise<void>;
}

/**
 * A single remembered fact, with a governed "Forget" action. Forget does not
 * delete — it files a proposal in the Monitor for an operator to approve, so
 * the card shows a "pending approval" state once requested.
 */
export function MemoryItemCard({ item, forgetEnabled, pending, onForget }: Props) {
  const [busy, setBusy] = useState(false);

  const handleForget = async () => {
    setBusy(true);
    try {
      await onForget(item.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-border p-2">
      <p className="text-xs text-foreground leading-snug">{item.content}</p>
      {item.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-end">
        {pending ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-500">
            Forget pending operator approval
          </span>
        ) : (
          <button
            type="button"
            onClick={handleForget}
            disabled={!forgetEnabled || busy}
            title={
              forgetEnabled
                ? "Request removal — an operator approves it in the Monitor before it's deleted"
                : "Connect a BetterDB Monitor to enable governed forget"
            }
            className="text-[10px] text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            {busy ? "Requesting…" : "Forget"}
          </button>
        )}
      </div>
    </li>
  );
}
