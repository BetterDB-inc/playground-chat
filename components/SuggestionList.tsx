"use client";

/**
 * Two presentations of the same prompt list - used both as the empty-state
 * starter grid and as follow-up chips. Keeping them in one component
 * guarantees the suggestion text never drifts between the two.
 */

export const SUGGESTIONS = [
  "What is Valkey and how does it differ from Redis?",
  "How do I use XADD and XREAD for streams?",
  "Explain the FT.SEARCH KNN vector search syntax",
  "What persistence options does Valkey support?",
  "How does valkey-search differ from RediSearch?",
  "When should I use a Bloom filter vs a Set?",
  "How do I configure Valkey Cluster for high availability?",
] as const;

interface Props {
  onPick: (text: string) => void;
  variant: "grid" | "chips";
  disabled?: boolean;
}

export function SuggestionList({ onPick, variant, disabled }: Props) {
  if (variant === "grid") {
    return (
      <div className="grid gap-2 w-full max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="text-left px-4 py-2.5 rounded-lg border border-border bg-card
                       text-card-foreground text-sm
                       hover:border-primary/50 hover:bg-accent
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors duration-150"
          >
            {s}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="pt-2">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 font-medium">
        Try another question
      </div>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="text-left px-3 py-1.5 rounded-full border border-border bg-card
                       text-card-foreground text-xs
                       hover:border-primary/50 hover:bg-accent
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors duration-150"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
