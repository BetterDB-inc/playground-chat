import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../lib/retrieval", () => ({ retriever: { query }, DOCS_INDEX: "betterdb_docs" }));

import { vectorSearch, getCommandByName, getBetterDbInfo } from "../lib/rag";

beforeEach(() => {
  query.mockReset();
});

describe("lib/rag (retrieval-backed)", () => {
  it("vectorSearch maps QueryHit -> DocResult and passes the source filter", async () => {
    query.mockResolvedValue([
      {
        id: "d1",
        score: 0.12,
        text: "Valkey is a key-value store.",
        fields: { title: "What is Valkey?", source: "valkey", kind: "faq", url: "https://x" },
      },
    ]);
    const res = await vectorSearch("what is valkey", "valkey", 3);
    expect(query).toHaveBeenCalledWith({ text: "what is valkey", k: 3, filter: { source: "valkey" } });
    expect(res).toEqual([
      {
        id: "d1",
        title: "What is Valkey?",
        content: "Valkey is a key-value store.",
        source: "valkey",
        kind: "faq",
        url: "https://x",
        score: 0.12,
      },
    ]);
  });

  it("vectorSearch omits the filter when no source", async () => {
    query.mockResolvedValue([]);
    await vectorSearch("anything");
    expect(query).toHaveBeenCalledWith({ text: "anything", k: 5, filter: undefined });
  });

  it("getCommandByName normalizes the name and returns the top hit", async () => {
    query.mockResolvedValue([
      {
        id: "c1",
        score: 0.05,
        text: "FT.SEARCH runs a query.",
        fields: { title: "FT.SEARCH", source: "valkey", kind: "command", url: "u" },
      },
    ]);
    const res = await getCommandByName("ft search", "valkey");
    expect(query).toHaveBeenCalledWith({ text: "FT-SEARCH", k: 1, filter: { source: "valkey" } });
    expect(res?.content).toBe("FT.SEARCH runs a query.");
  });

  it("getCommandByName returns null on no hits", async () => {
    query.mockResolvedValue([]);
    expect(await getCommandByName("nope")).toBeNull();
  });

  it("getBetterDbInfo scopes to betterdb, top 3", async () => {
    query.mockResolvedValue([]);
    await getBetterDbInfo("vector search");
    expect(query).toHaveBeenCalledWith({ text: "vector search", k: 3, filter: { source: "betterdb" } });
  });
});
