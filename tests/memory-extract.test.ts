import { describe, it, expect } from "vitest";
import { parseFacts } from "../lib/memory-extract";

describe("parseFacts", () => {
  it("parses a clean JSON array of facts", () => {
    const out = parseFacts('[{"content":"uses Python","importance":0.8,"tags":["lang"]}]');
    expect(out).toEqual([{ content: "uses Python", importance: 0.8, tags: ["lang"] }]);
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure!\n```json\n[{"content":"prefers concise answers","importance":0.6,"tags":["pref"]}]\n```';
    expect(parseFacts(raw)).toEqual([
      { content: "prefers concise answers", importance: 0.6, tags: ["pref"] },
    ]);
  });

  it("returns [] for an empty array or no JSON", () => {
    expect(parseFacts("[]")).toEqual([]);
    expect(parseFacts("nothing durable here")).toEqual([]);
    expect(parseFacts("not json {")).toEqual([]);
  });

  it("defaults/clamps importance and drops bad items", () => {
    const out = parseFacts(
      '[{"content":"builds trading systems"},{"importance":0.5},{"content":"x","importance":9,"tags":["a",1,"b"]}]',
    );
    expect(out).toEqual([
      { content: "builds trading systems", importance: 0.5, tags: [] },
      { content: "x", importance: 1, tags: ["a", "b"] },
    ]);
  });

  it("caps at 5 facts and trims long content", () => {
    const many = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({ content: `fact ${i}`, importance: 0.5, tags: [] })),
    );
    expect(parseFacts(many)).toHaveLength(5);
    const long = parseFacts(`[{"content":"${"z".repeat(400)}","importance":0.5,"tags":[]}]`);
    expect(long[0]?.content.length).toBe(280);
  });
});
