"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThemeToggle } from "./ThemeToggle";
import { SuggestionList } from "./SuggestionList";
import type { TurnMetrics } from "@/lib/types";

interface Props {
  onTurnComplete: (metrics: TurnMetrics) => void;
}

// We attach TurnMetrics to assistant messages via messageMetadata on the server.
type ChatMessage = UIMessage<TurnMetrics>;

export function Chat({ onTurnComplete }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [input, setInput] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastReportedIdRef = useRef<string | null>(null);

  const { messages, sendMessage, status } = useChat<ChatMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onError: (err) => {
      // Surface server errors to the user. Without this the request just
      // disappears silently from the user's perspective.
      const msg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setErrorMessage(msg);
    },
  });

  const isLoading = status === "submitted" || status === "streaming";
  // Hide the typing dots as soon as the first text part of the assistant
  // message starts arriving - otherwise dots and partial text overlap.
  const lastMsg = messages[messages.length - 1];
  const hasAssistantText = useMemo(() => {
    if (!lastMsg || lastMsg.role !== "assistant") return false;
    return lastMsg.parts.some(
      (p) =>
        p.type === "text" &&
        typeof (p as { text?: string }).text === "string" &&
        (p as { text: string }).text.length > 0,
    );
  }, [lastMsg]);
  const showTypingDots = isLoading && !hasAssistantText;

  // Report metrics once per assistant message when the run finishes.
  useEffect(() => {
    if (status !== "ready") return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    if (lastReportedIdRef.current === last.id) return;
    const meta = last.metadata;
    if (!meta) return;
    lastReportedIdRef.current = last.id;
    onTurnComplete(meta);
  }, [status, messages, onTurnComplete]);

  // Throttled scroll to the bottom - coalesce repeated scroll requests via
  // rAF so a streaming response (which fires per-token) doesn't queue
  // hundreds of scroll animations.
  useEffect(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, showTypingDots]);

  // Refocus the input after a turn finishes streaming so the user can keep
  // typing without clicking back.
  useEffect(() => {
    if (status === "ready") inputRef.current?.focus();
  }, [status]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || isLoading) return;
      setErrorMessage(null);
      sendMessage({ text });
      setInput("");
    },
    [input, isLoading, sendMessage],
  );

  const submitSuggestion = useCallback(
    (text: string) => {
      if (isLoading) return;
      setErrorMessage(null);
      sendMessage({ text });
      setInput("");
    },
    [isLoading, sendMessage],
  );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-border flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary" fill="currentColor" aria-hidden>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-foreground tracking-tight">
            RESP-compatible DBs and BetterDB
          </h1>
          <p className="text-xs text-muted-foreground truncate">
            Valkey · Redis · Dragonfly · BetterDB docs · semantic and kv/agentic cache demo
          </p>
        </div>
        <ThemeToggle />
      </header>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto px-4 py-3 sm:py-6 space-y-4"
        aria-live="polite"
        aria-busy={isLoading}
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center min-h-full gap-4 sm:gap-8 text-center">
            <div className="space-y-2 max-w-md">
              <h2 className="text-xl sm:text-2xl font-semibold text-foreground tracking-tight">
                Ask about Valkey, Redis, Dragonfly, or BetterDB
              </h2>
              <p className="text-muted-foreground text-sm">
                Backed by live documentation with{" "}
                <span className="text-primary font-medium">semantic caching</span> and{" "}
                <span className="text-primary font-medium">tool result caching</span>. Watch the
                metrics panel to see cache hits in real time.
              </p>
            </div>
            <SuggestionList onPick={submitSuggestion} variant="grid" disabled={isLoading} />
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "user" ? (
              <div className="max-w-[85%] sm:max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm leading-relaxed font-medium">
                <UserText message={m} />
              </div>
            ) : (
              <div className="max-w-[90%] sm:max-w-[85%] rounded-2xl rounded-bl-sm bg-card border border-border px-4 py-3">
                <AssistantMarkdown message={m} />
              </div>
            )}
          </div>
        ))}

        {showTypingDots && (
          <div className="flex justify-start">
            <div
              className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3"
              aria-label="Assistant is typing"
              role="status"
            >
              <div className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="flex justify-start" role="alert">
            <div className="max-w-[90%] rounded-xl border border-destructive/40 bg-destructive/10 text-destructive px-4 py-2.5 text-sm">
              {errorMessage}
            </div>
          </div>
        )}

        {/* Follow-up suggestions: show after the latest assistant message */}
        {!isLoading &&
          messages.length > 0 &&
          messages[messages.length - 1]?.role === "assistant" && (
            <SuggestionList onPick={submitSuggestion} variant="chips" disabled={isLoading} />
          )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 sm:py-4 border-t border-border">
        <form id="chat-form" onSubmit={handleSubmit} className="flex gap-2 items-center">
          <label htmlFor="chat-input" className="sr-only">
            Ask a question
          </label>
          <input
            id="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about Valkey, Redis, Dragonfly, or BetterDB…"
            autoComplete="off"
            autoFocus
            className="flex-1 bg-card border border-border rounded-xl px-4 py-3
                       text-sm text-foreground placeholder:text-muted-foreground/60 outline-none
                       focus:border-primary/60 focus:ring-2 focus:ring-primary/20
                       transition-colors"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-primary text-primary-foreground rounded-xl px-5 py-3 font-semibold text-sm
                       disabled:opacity-40 disabled:cursor-not-allowed
                       hover:bg-primary/90
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                       transition-colors shrink-0"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function getText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function UserText({ message }: { message: ChatMessage }) {
  return <span className="whitespace-pre-wrap break-words">{getText(message)}</span>;
}

function AssistantMarkdown({ message }: { message: ChatMessage }) {
  const text = getText(message);
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
