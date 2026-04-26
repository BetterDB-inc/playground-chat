"use client";

import type { TurnMetrics } from "@/lib/types";

interface Props {
  /**
   * Per-turn metrics with stable identifiers. The parent assigns ids as they
   * are received so list reordering doesn't cause React to mis-key children.
   */
  turns: { id: string; metrics: TurnMetrics }[];
}

export function TurnMetrics({ turns }: Props) {
  if (turns.length === 0) {
    return (
      <div className="text-muted-foreground text-xs text-center py-8 px-3 border border-dashed border-border rounded-lg">
        Ask a question to see per-turn cache metrics.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {[...turns].reverse().map((turn, i) => (
        <TurnCard key={turn.id} turn={turn.metrics} idx={turns.length - i} />
      ))}
    </div>
  );
}

function TurnCard({ turn, idx }: { turn: TurnMetrics; idx: number }) {
  // Only show "saved this turn" when there actually is a saving - a miss
  // displaying "$0.0000 saved" is misleading.
  const showSavedFooter = (turn.savedUsd ?? 0) > 0;

  return (
    <div className="rounded-lg bg-card border border-border p-3 space-y-2">
      <div className="text-foreground font-mono font-semibold text-[11px] uppercase tracking-wider">
        Turn {idx}
      </div>

      <Row
        label="Semantic cache"
        badge={turn.semantic.hit}
        detail={
          turn.semantic.hit
            ? `${formatSimilarity(turn.semantic.similarity)} match · saved ${formatMicro(turn.semantic.savedUsd)}`
            : turn.semantic.embedLatencyMs
              ? `embed ${turn.semantic.embedLatencyMs}ms`
              : undefined
        }
      />

      {turn.toolHits.length > 0 && (
        <div className="pl-2.5 ml-1 border-l border-border space-y-1.5 pt-0.5">
          <div className="text-muted-foreground text-[10px] uppercase tracking-widest font-medium">
            Tools
          </div>
          {turn.toolHits.map((t, j) => (
            <Row
              // tool order is stable within a turn, but combine name+index for safety
              key={`${t.name}-${j}`}
              label={t.name}
              badge={t.hit}
              detail={`${t.latencyMs}ms`}
            />
          ))}
        </div>
      )}

      {!turn.semantic.hit && (
        <Row
          label="LLM exact match"
          badge={turn.llmExactHit ?? false}
          detail={
            turn.promptTokens !== undefined
              ? `in ${turn.promptTokens}t · out ${turn.completionTokens ?? 0}t · ${formatMicro(turn.costUsd)}`
              : undefined
          }
        />
      )}

      {showSavedFooter && (
        <div className="text-primary text-[10px] font-mono pt-1 border-t border-border">
          Saved this turn: <span className="font-semibold">{formatMicro(turn.savedUsd)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Convert cosine DISTANCE (0-2 scale, what semantic-cache returns) into a
 * human-friendly similarity percentage (0-100%, higher = closer match).
 *
 *   distance 0.0  -> 100% (identical embeddings)
 *   distance 0.08 ->  96% (typical hit at our default threshold)
 *   distance 1.0  ->  50% (orthogonal vectors)
 *   distance 2.0  ->   0% (opposite vectors)
 *
 * The Math.max(0, ...) clamp removes the occasional `-0.000` that fp math
 * produces for true matches.
 */
function formatSimilarity(distance: number | undefined): string {
  if (distance === undefined || distance === null) return "—";
  const sim = Math.max(0, Math.min(1, 1 - distance / 2));
  return `${(sim * 100).toFixed(1)}%`;
}

function formatMicro(v: number | undefined): string {
  if (v === undefined || v === null) return "-";
  if (v === 0) return "$0";
  if (v < 0.0001) return `$${v.toExponential(2)}`;
  return `$${v.toFixed(4)}`;
}

function Row({ label, badge, detail }: { label: string; badge: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <span className="text-muted-foreground w-32 shrink-0 truncate">{label}</span>
      <Badge hit={badge} />
      {detail && <span className="text-muted-foreground/80 truncate text-[10.5px]">{detail}</span>}
    </div>
  );
}

function Badge({ hit }: { hit: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold tracking-wider shrink-0 ${
        hit
          ? "bg-success/15 text-success border border-success/30"
          : "bg-muted text-muted-foreground border border-border"
      }`}
    >
      {hit ? "HIT" : "MISS"}
    </span>
  );
}
