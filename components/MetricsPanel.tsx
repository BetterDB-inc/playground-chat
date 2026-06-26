"use client";

import { GlobalStats } from "./GlobalStats";
import { TurnMetrics } from "./TurnMetrics";
import { MemoryPanel } from "./memory/MemoryPanel";
import { ContextStats } from "./stats/ContextStats";
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
        <h2 className="text-sm font-semibold text-foreground tracking-tight">Cache &amp; Memory</h2>
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

        <section>
          <SectionLabel>Context layer</SectionLabel>
          <ContextStats />
        </section>

        <section>
          <SectionLabel>Memory</SectionLabel>
          <MemoryPanel refreshKey={turns.length} />
        </section>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border">
        <p className="text-[10px] text-muted-foreground/70 text-center leading-relaxed">
          Powered by{" "}
          <FooterLink href="https://github.com/BetterDB-inc/monitor/tree/master/packages/agent-cache">
            @betterdb/agent-cache
          </FooterLink>{" "}
          &amp;{" "}
          <FooterLink href="https://github.com/BetterDB-inc/monitor/tree/master/packages/semantic-cache">
            @betterdb/semantic-cache
          </FooterLink>
          <br />
          Also in Python:{" "}
          <FooterLink href="https://github.com/BetterDB-inc/monitor/tree/master/packages/agent-cache-py">
            agent-cache-py
          </FooterLink>{" "}
          &middot;{" "}
          <FooterLink href="https://github.com/BetterDB-inc/monitor/tree/master/packages/semantic-cache-py">
            semantic-cache-py
          </FooterLink>
          <br />
          <FooterLink href="https://github.com/BetterDB-inc/playground-chat">
            Source on GitHub
          </FooterLink>
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

/**
 * Footer link styled to match the previous static footer text. Always opens in
 * a new tab and uses noopener+noreferrer because we never want a third-party
 * page to inherit a window reference back to us.
 */
function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary font-medium hover:underline underline-offset-2 transition-colors"
    >
      {children}
    </a>
  );
}
