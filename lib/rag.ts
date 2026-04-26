import { valkey } from "./valkey";
import { embedToBuffer } from "./embeddings";
import { cmd, escapeSearchValue, escapeTagValue } from "./valkey-cmd";

/**
 * RAG layer over the `docs_idx` index produced by scripts/build-index.ts.
 * All queries go through `cmd()` so RediSearch reserved characters in user
 * input get escaped consistently (otherwise an LLM-supplied value containing
 * `:` or `(` produces a malformed query).
 */

export interface DocResult {
  id: string;
  title: string;
  content: string;
  source: string;
  kind: string;
  url: string;
  score: number;
}

/** Indexed sources. Add a new entry here AND wire an ingest script for it. */
export type DocSource = "valkey" | "redis" | "dragonfly" | "betterdb";

/** Source values valid for command lookups (BetterDB has no commands). */
export type CommandSource = Exclude<DocSource, "betterdb">;

export async function vectorSearch(
  query: string,
  source?: DocSource,
  limit = 5,
): Promise<DocResult[]> {
  const qVec = await embedToBuffer(query);
  const filter = source ? `@source:{${escapeTagValue(source)}}` : "*";

  const raw = await cmd<unknown[]>(
    valkey,
    "FT.SEARCH",
    "docs_idx",
    `(${filter})=>[KNN ${limit} @embedding $vec]`,
    "PARAMS",
    "2",
    "vec",
    qVec,
    "RETURN",
    "6",
    "title",
    "content",
    "source",
    "kind",
    "url",
    "__embedding_score",
    "DIALECT",
    "2",
  );
  return parseSearchResults(raw);
}

export async function getCommandByName(
  name: string,
  source?: CommandSource,
): Promise<DocResult | null> {
  // RediSearch tokenises on whitespace and punctuation. Command names like
  // "FT.SEARCH" must be queried as escaped literals or the dot is treated as
  // a separator and we get false matches.
  const normalized = escapeSearchValue(name.toUpperCase().replace(/\s+/g, "-"));
  const srcFilter = source ? `@source:{${escapeTagValue(source)}} ` : "";
  const query = `${srcFilter}@title:${normalized}`;

  const raw = await cmd<unknown[]>(
    valkey,
    "FT.SEARCH",
    "docs_idx",
    query,
    "LIMIT",
    "0",
    "1",
    "RETURN",
    "5",
    "title",
    "content",
    "source",
    "url",
    "kind",
  );
  const results = parseSearchResults(raw);
  return results[0] ?? null;
}

const MODULE_QUERY_TERMS: Record<string, string> = {
  "valkey-search": "valkey-search vector search index",
  "valkey-bloom": "bloom filter probabilistic data structure",
  "valkey-json": "json document storage",
  "valkey-ldap": "ldap authentication",
};

export async function getModuleInfo(module: string): Promise<DocResult | null> {
  const term = MODULE_QUERY_TERMS[module.toLowerCase()] ?? module;
  const r = await vectorSearch(term, "valkey", 1);
  return r[0] ?? null;
}

/**
 * Look up a BetterDB topic. Mirrors getModuleInfo but scoped to the
 * betterdb source so the LLM has a focused way to ask "what does BetterDB
 * do for X" without polluting the result with adjacent OSS docs.
 */
export async function getBetterDbInfo(topic: string): Promise<DocResult[]> {
  return vectorSearch(topic, "betterdb", 3);
}

/**
 * FT.SEARCH reply is `[total, key1, [field, value, ...], key2, [...], ...]`.
 * We defensively check the count before treating subsequent entries as keys.
 */
function parseSearchResults(raw: unknown[]): DocResult[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const total = typeof raw[0] === "number" ? raw[0] : Number(raw[0]);
  if (!total || total <= 0) return [];

  const results: DocResult[] = [];
  for (let i = 1; i < raw.length; i += 2) {
    const key = typeof raw[i] === "string" ? (raw[i] as string) : String(raw[i] ?? "");
    const fields = raw[i + 1];
    if (!Array.isArray(fields)) continue;

    const map: Record<string, string> = {};
    for (let j = 0; j < fields.length; j += 2) {
      const k = String(fields[j] ?? "");
      const v = String(fields[j + 1] ?? "");
      if (k) map[k] = v;
    }
    const id = key.replace(/^doc:/, "");
    results.push({
      id,
      title: map["title"] ?? "",
      content: map["content"] ?? "",
      source: map["source"] ?? "",
      kind: map["kind"] ?? "",
      url: map["url"] ?? "",
      score: parseFloat(map["__embedding_score"] ?? "1"),
    });
  }
  return results;
}
