"use client";

export interface MemoryItemView {
  id: string;
  content: string;
  importance: number;
  tags: string[];
  createdAt: number;
}

/** A single remembered fact. The Forget action is added in the governed-forget slice. */
export function MemoryItemCard({ item }: { item: MemoryItemView }) {
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
    </li>
  );
}
