import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  recall: vi.fn(),
  remember: vi.fn(),
  list: vi.fn(),
  ensureIndex: vi.fn(),
}));

vi.mock("@betterdb/agent-memory", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    recall: mocks.recall,
    remember: mocks.remember,
    list: mocks.list,
    ensureIndex: mocks.ensureIndex,
  })),
}));
vi.mock("../lib/valkey", () => ({ valkey: {} }));
vi.mock("../lib/embeddings", () => ({ embedText: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.recall.mockResolvedValue([]);
  mocks.remember.mockResolvedValue("mem-id");
  mocks.list.mockResolvedValue({ items: [], total: 0 });
  mocks.ensureIndex.mockResolvedValue(undefined);
});

describe("lib/memory", () => {
  it("recallMemories scopes by namespace=userId and ensures the index first", async () => {
    const { recallMemories } = await import("../lib/memory");
    await recallMemories("hello", "user-1", 3);
    expect(mocks.ensureIndex).toHaveBeenCalledTimes(1);
    expect(mocks.recall).toHaveBeenCalledWith("hello", { namespace: "user-1", k: 3 });
  });

  it("rememberFact stamps namespace + source=chat and forwards importance/tags", async () => {
    const { rememberFact } = await import("../lib/memory");
    await rememberFact("prefers dark mode", "user-1", { importance: 0.8, tags: ["pref"] });
    expect(mocks.remember).toHaveBeenCalledWith(
      "prefers dark mode",
      expect.objectContaining({
        namespace: "user-1",
        source: "chat",
        importance: 0.8,
        tags: ["pref"],
      }),
    );
  });

  it("listMemories scopes by namespace", async () => {
    const { listMemories } = await import("../lib/memory");
    const res = await listMemories("user-1");
    expect(mocks.list).toHaveBeenCalledWith({ namespace: "user-1", limit: 50 });
    expect(res).toEqual({ items: [], total: 0 });
  });

  it("memoizes the index bootstrap across calls", async () => {
    const { recallMemories } = await import("../lib/memory");
    await recallMemories("a", "u");
    await recallMemories("b", "u");
    expect(mocks.ensureIndex).toHaveBeenCalledTimes(1);
  });
});
