"use client";

import type { TurnMetrics } from "@/lib/types";

interface Props {
  turns: TurnMetrics[];
}

export function TurnMetrics({ turns }: Props) {
  if (turns.length === 0) {
    return (
      <div className="text-slate-500 text-sm text-center py-6">
        Ask a question to see per-turn cache metrics.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {[...turns].reverse().map((turn, i) => (
        <TurnCard key={i} turn={turn} idx={turns.length - i} />
      ))}
    </div>
  );
}

function TurnCard({ turn, idx }: { turn: TurnMetrics; idx: number }) {
  const totalSaved = (turn.savedUsd ?? 0).toFixed(4);

  return (
    <div className="rounded-lg bg-[#1A3F54]/30 border border-[#1A3F54]/60 p-3 text-xs font-mono space-y-2">
      <div className="text-slate-300 font-semibold text-[11px] uppercase tracking-wide">
        Turn {idx}
      </div>

      {/* Semantic cache */}
      <Row
        label="Semantic cache"
        badge={turn.semantic.hit}
        detail={
          turn.semantic.hit
            ? `sim=${(turn.semantic.similarity ?? 0).toFixed(3)} · saved $${(turn.semantic.savedUsd ?? 0).toFixed(4)}`
            : turn.semantic.embedLatencyMs
            ? `embed ${turn.semantic.embedLatencyMs}ms`
            : undefined
        }
      />

      {/* Tool results */}
      {turn.toolHits.length > 0 && (
        <div className="pl-2 border-l border-[#1A3F54] space-y-1">
          <div className="text-slate-500 text-[10px]">TOOLS</div>
          {turn.toolHits.map((t, j) => (
            <Row
              key={j}
              label={t.name}
              badge={t.hit}
              detail={`${t.latencyMs}ms`}
            />
          ))}
        </div>
      )}

      {/* LLM exact match */}
      {!turn.semantic.hit && (
        <Row
          label="LLM exact match"
          badge={turn.llmExactHit ?? false}
          detail={
            turn.promptTokens !== undefined
              ? `in ${turn.promptTokens}t / out ${turn.completionTokens ?? 0}t · $${(turn.costUsd ?? 0).toFixed(5)}`
              : undefined
          }
        />
      )}

      {/* Session total */}
      <div className="text-[#2DD4BF] text-[10px] pt-1">
        Saved this turn: ${totalSaved}
      </div>
    </div>
  );
}

function Row({
  label,
  badge,
  detail,
}: {
  label: string;
  badge: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-slate-400 w-36 shrink-0 truncate">{label}</span>
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
          badge
            ? "bg-emerald-500/20 text-emerald-400"
            : "bg-slate-700/60 text-slate-400"
        }`}
      >
        {badge ? "HIT" : "MISS"}
      </span>
      {detail && (
        <span className="text-slate-500 truncate">{detail}</span>
      )}
    </div>
  );
}
