"use client";

import { useChat } from "ai/react";
import { useEffect, useRef, useState } from "react";
import type { TurnMetrics } from "@/lib/types";

interface Props {
  onTurnComplete: (metrics: TurnMetrics) => void;
}

const SUGGESTIONS = [
  "What is Valkey and how does it differ from Redis?",
  "How do I use XADD and XREAD for streams?",
  "Explain the FT.SEARCH KNN vector search syntax",
  "What persistence options does Valkey support?",
  "How does valkey-search differ from RediSearch?",
];

export function Chat({ onTurnComplete }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingMetrics, setPendingMetrics] = useState<Partial<TurnMetrics>>({});

  const { messages, input, handleInputChange, handleSubmit, isLoading, data } =
    useChat({
      api: "/api/chat",
      onResponse: (res) => {
        const metricsHeader = res.headers.get("X-Metrics");
        if (metricsHeader) {
          try {
            const m = JSON.parse(metricsHeader) as Partial<TurnMetrics>;
            setPendingMetrics((prev) => ({ ...prev, ...m }));
          } catch {
            // ignore
          }
        }
      },
      onFinish: () => {
        // Combine header metrics + data stream metrics
        const metrics: TurnMetrics = {
          semantic: pendingMetrics.semantic ?? { hit: false },
          toolHits: pendingMetrics.toolHits ?? [],
          llmExactHit: pendingMetrics.llmExactHit,
          promptTokens: pendingMetrics.promptTokens,
          completionTokens: pendingMetrics.completionTokens,
          costUsd: pendingMetrics.costUsd,
          savedUsd: pendingMetrics.savedUsd,
        };
        onTurnComplete(metrics);
        setPendingMetrics({});
      },
    });

  // Parse data stream for metrics updates
  useEffect(() => {
    if (!data) return;
    for (const item of data as unknown[]) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type: string }).type === "metrics"
      ) {
        const d = (item as { data: Partial<TurnMetrics> }).data;
        setPendingMetrics((prev) => ({ ...prev, ...d }));
      }
    }
  }, [data]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function submitSuggestion(text: string) {
    const event = {
      preventDefault: () => {},
    } as React.FormEvent<HTMLFormElement>;
    handleInputChange({
      target: { value: text },
    } as React.ChangeEvent<HTMLInputElement>);
    // Small delay so state updates before submit
    setTimeout(() => {
      const form = document.getElementById("chat-form") as HTMLFormElement;
      form?.requestSubmit();
    }, 50);
  }

  return (
    <div className="flex flex-col h-full bg-[#0f1923]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#1A3F54]/60">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#1A3F54] flex items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 text-[#2DD4BF]"
              fill="currentColor"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-slate-100">
              BetterDB Playground
            </h1>
            <p className="text-xs text-slate-500">
              Valkey &amp; Redis OSS docs · RAG + caching demo
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
            <div>
              <h2 className="text-2xl font-bold text-slate-100 mb-2">
                Ask about Valkey or Redis
              </h2>
              <p className="text-slate-500 text-sm max-w-md">
                Backed by live documentation with{" "}
                <span className="text-[#2DD4BF]">semantic caching</span> and{" "}
                <span className="text-[#2DD4BF]">tool result caching</span>.
                Watch the metrics panel to see cache hits in real time.
              </p>
            </div>
            <div className="grid gap-2 w-full max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submitSuggestion(s)}
                  className="text-left px-4 py-2.5 rounded-lg border border-[#1A3F54] bg-[#1A3F54]/30
                             text-slate-300 text-sm hover:border-[#2DD4BF]/50 hover:bg-[#1A3F54]/50
                             transition-colors duration-150"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-[#1A3F54] text-slate-100 rounded-br-sm"
                  : "bg-[#1A3F54]/30 border border-[#1A3F54]/60 text-slate-200 rounded-bl-sm"
              }`}
            >
              <MessageContent content={m.content} />
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-[#1A3F54]/30 border border-[#1A3F54]/60 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-4 border-t border-[#1A3F54]/60">
        <form
          id="chat-form"
          onSubmit={handleSubmit}
          className="flex gap-2 items-center"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            placeholder="Ask about Valkey, Redis commands, or BetterDB…"
            className="flex-1 bg-[#1A3F54]/30 border border-[#1A3F54] rounded-xl px-4 py-3
                       text-sm text-slate-100 placeholder-slate-600 outline-none
                       focus:border-[#2DD4BF]/60 transition-colors"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-[#2DD4BF] text-[#0f1923] rounded-xl px-4 py-3 font-semibold text-sm
                       disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#2DD4BF]/90
                       transition-colors shrink-0"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  // Simple code block rendering
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0];
          const code = lines.slice(1).join("\n");
          return (
            <pre
              key={i}
              className="mt-2 mb-2 bg-[#0f1923] rounded-lg p-3 text-xs overflow-x-auto text-[#2DD4BF] border border-[#1A3F54]/60"
            >
              {lang && (
                <div className="text-slate-600 text-[10px] mb-1 uppercase">
                  {lang}
                </div>
              )}
              <code>{code}</code>
            </pre>
          );
        }
        return (
          <span key={i} className="whitespace-pre-wrap break-words">
            {part}
          </span>
        );
      })}
    </>
  );
}
