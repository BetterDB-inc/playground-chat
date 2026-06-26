import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Smoke test for the chat route's recall → inject → remember loop (spec §9).
 * Everything external is faked (LLM, embedder, caches, guardrails, budget) so
 * the test exercises the real route wiring: a recalled memory must land in the
 * system prompt handed to the LLM, and a durable fact extracted from the turn
 * must be remembered afterwards.
 */

const mocks = vi.hoisted(() => ({
  capturedSystem: "",
  onFinishDone: Promise.resolve() as Promise<unknown>,
  afterPromises: [] as Promise<unknown>[],
  recallMemories: vi.fn(),
  rememberFact: vi.fn(),
  maybeConsolidate: vi.fn(),
  extractFacts: vi.fn(),
}));

/** Await onFinish plus every deferred after() callback it scheduled. */
async function settle(): Promise<void> {
  await mocks.onFinishDone;
  await Promise.all(mocks.afterPromises);
}

vi.mock("ai", () => ({
  stepCountIs: () => true,
  convertToModelMessages: vi.fn(async () => [{ role: "user", content: "hello" }]),
  createUIMessageStream: vi.fn(() => ({})),
  createUIMessageStreamResponse: vi.fn(() => new Response("ok")),
  generateText: vi.fn(async () => ({ text: "summary" })),
  streamText: vi.fn((opts: { system: string; onFinish?: (e: unknown) => unknown }) => {
    mocks.capturedSystem = opts.system;
    mocks.onFinishDone = Promise.resolve(
      opts.onFinish?.({ text: "Valkey is great.", usage: { inputTokens: 5, outputTokens: 7 } }),
    );
    return { toUIMessageStreamResponse: vi.fn(() => new Response("stream")) };
  }),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => ({ model: "fake" }),
}));

vi.mock("@/lib/cache", () => ({
  initCaches: vi.fn(async () => undefined),
  agentCache: {
    llm: { check: vi.fn(async () => ({ hit: false })), store: vi.fn(async () => undefined) },
  },
  semanticCache: {
    check: vi.fn(async () => ({ hit: false, confidence: "miss" })),
    store: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/tools", () => ({ tools: {} }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true })),
  reserveBudget: vi.fn(async () => ({ ok: true })),
  settleBudget: vi.fn(async () => undefined),
}));
vi.mock("@/lib/guardrails", () => ({
  validateInputSync: () => ({ ok: true }),
  moderateInput: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/logger", () => ({ logTurn: vi.fn(async () => undefined) }));
vi.mock("@/lib/stats", () => ({
  recordTurn: vi.fn(async () => undefined),
  recordMemoryRecall: vi.fn(async () => undefined),
  recordConsolidation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/system-prompt", () => ({ SYSTEM_PROMPT: "BASE PROMPT" }));
vi.mock("@/lib/env", () => ({ validateEnv: () => ({ openaiKey: "k", llmModel: "gpt-4o-mini" }) }));
vi.mock("@/lib/client-ip", () => ({ detectClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/secrets", () => ({ scrubSecrets: (s: string) => s }));
vi.mock("@/lib/pricing", () => ({
  estimateLlmCost: () => 0,
  approximateTokens: () => 10,
}));
vi.mock("@/lib/analytics", () => ({
  captureChatTurn: vi.fn(async () => undefined),
  flushAnalytics: vi.fn(async () => undefined),
}));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    mocks.afterPromises.push(Promise.resolve().then(fn));
  },
}));
vi.mock("@/lib/session", () => ({
  getOrCreateUserId: () => ({ userId: "user-1", setCookie: undefined }),
}));
vi.mock("@/lib/memory", () => ({
  recallMemories: mocks.recallMemories,
  rememberFact: mocks.rememberFact,
  maybeConsolidate: mocks.maybeConsolidate,
}));
vi.mock("@/lib/memory-extract", () => ({ extractFacts: mocks.extractFacts }));

function chatRequest(text: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text }] }] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterPromises = [];
  mocks.recallMemories.mockResolvedValue([{ item: { content: "prefers dark mode" } }]);
  mocks.rememberFact.mockResolvedValue("mem-id");
  mocks.maybeConsolidate.mockResolvedValue(null);
  mocks.extractFacts.mockResolvedValue({
    facts: [{ content: "likes Valkey", importance: 0.8, tags: ["pref"] }],
    usage: { inputTokens: 10, outputTokens: 5 },
  });
});

describe("chat route — recall → inject → remember", () => {
  it("injects recalled memories into the system prompt", async () => {
    const { POST } = await import("@/app/api/chat/route");
    await POST(chatRequest("tell me about valkey"));

    expect(mocks.recallMemories).toHaveBeenCalledWith("tell me about valkey", "user-1");
    expect(mocks.capturedSystem).toContain("What you remember about this user");
    expect(mocks.capturedSystem).toContain("prefers dark mode");
  });

  it("remembers durable facts extracted from the turn", async () => {
    const { POST } = await import("@/app/api/chat/route");
    await POST(chatRequest("tell me about valkey"));
    await settle();

    expect(mocks.extractFacts).toHaveBeenCalled();
    expect(mocks.rememberFact).toHaveBeenCalledWith(
      "likes Valkey",
      "user-1",
      expect.objectContaining({ importance: 0.8, tags: ["pref"] }),
    );
  });

  it("does not inject a memory block when nothing is recalled", async () => {
    mocks.recallMemories.mockResolvedValue([]);
    const { POST } = await import("@/app/api/chat/route");
    await POST(chatRequest("hello"));

    expect(mocks.capturedSystem).toBe("BASE PROMPT");
  });

  it("does NOT cache a memory-personalized reply (would leak across visitors)", async () => {
    const { agentCache, semanticCache } = await import("@/lib/cache");
    const { POST } = await import("@/app/api/chat/route");
    await POST(chatRequest("tell me about valkey"));
    await settle();

    expect(mocks.capturedSystem).toContain("prefers dark mode");
    expect(agentCache.llm.store).not.toHaveBeenCalled();
    expect(semanticCache.store).not.toHaveBeenCalled();
  });

  it("caches a generic reply when no memory personalized the turn", async () => {
    mocks.recallMemories.mockResolvedValue([]);
    const { agentCache, semanticCache } = await import("@/lib/cache");
    const { POST } = await import("@/app/api/chat/route");
    await POST(chatRequest("tell me about valkey"));
    await settle();

    expect(agentCache.llm.store).toHaveBeenCalled();
    expect(semanticCache.store).toHaveBeenCalled();
  });
});
