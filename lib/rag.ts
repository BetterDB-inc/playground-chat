import { retriever } from "./retrieval";
import type { QueryHit } from "@betterdb/retrieval";

/**
 * RAG layer over the docs index, now backed by @betterdb/retrieval's Retriever
 * (vector KNN + tag filters). The exported surface is unchanged so the chat
 * route and tools don't change; only the internals swapped from hand-rolled
 * FT.SEARCH to the SDK.
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

/** Map a retrieval QueryHit (doc body = `text`, metadata = `fields`) to DocResult. */
function hitToDoc(hit: QueryHit): DocResult {
  const title = hit.fields.title ?? "";
  return {
    id: hit.id,
    title,
    // Ingest embeds `${title}\n\n${body}` so titles influence the vector; strip
    // that prefix back off here so `content` is body-only and the title isn't
    // duplicated in RAG context / cached tool payloads.
    content: stripTitlePrefix(hit.text, title),
    source: hit.fields.source ?? "",
    kind: hit.fields.kind ?? "",
    url: hit.fields.url ?? "",
    score: hit.score,
  };
}

/** Remove a leading `${title}\n\n` the ingest prepended, if present. */
function stripTitlePrefix(text: string, title: string): string {
  if (title === "") {
    return text;
  }
  const prefix = `${title}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export async function vectorSearch(
  query: string,
  source?: DocSource,
  limit = 5,
): Promise<DocResult[]> {
  const hits = await retriever.query({
    text: query,
    k: limit,
    filter: source ? { source } : undefined,
  });
  return hits.map(hitToDoc);
}

/** Canonical command form for matching: strip punctuation/space, uppercase. */
function canonicalCommand(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function getCommandByName(
  name: string,
  source?: CommandSource,
): Promise<DocResult | null> {
  // Vector NN alone can surface a near-neighbour with similar wording, so pull
  // a handful of candidates and require an exact command-name match on title.
  // No match → not documented (better than returning the wrong command).
  const normalized = name.toUpperCase().replace(/\s+/g, "-");
  const hits = await retriever.query({
    text: normalized,
    k: 10,
    filter: source ? { source } : undefined,
  });
  const target = canonicalCommand(name);
  const exact = hits.find((hit) => canonicalCommand(hit.fields.title ?? "") === target);
  return exact ? hitToDoc(exact) : null;
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
 * Look up a BetterDB topic. Mirrors getModuleInfo but scoped to the betterdb
 * source so the LLM has a focused way to ask "what does BetterDB do for X".
 */
export async function getBetterDbInfo(topic: string): Promise<DocResult[]> {
  return vectorSearch(topic, "betterdb", 3);
}
