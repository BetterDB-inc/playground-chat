import {
  MemoryStore,
  type MemoryStoreClient,
  type MemoryItem,
  type ConsolidateResult,
} from "@betterdb/agent-memory";
import { valkey } from "./valkey";
import { embedText } from "./embeddings";

/**
 * Cross-session long-term memory for the assistant, built on
 * `@betterdb/agent-memory`'s semantic `MemoryStore` tier over the same Valkey
 * client + OpenAI embedder the rest of the app already uses (see lib/cache.ts).
 *
 * Memories are scoped per visitor by `namespace = userId` (an anonymous
 * session-cookie id — see lib/session.ts), so a returning visitor gets back
 * what the assistant learned about them, with no login.
 */
export const MEMORY_NAME = process.env.MEMORY_NAME ?? "playground_mem";
const DEFAULT_RECALL_K = 5;

/** Compress memories older than this (default 14 days) into a single summary. */
const CONSOLIDATE_AFTER_SECONDS = Number(
  process.env.MEMORY_CONSOLIDATE_AFTER_SECONDS ?? 14 * 24 * 60 * 60,
);

/** Don't run consolidation for the same visitor more often than this (default 1h). */
const CONSOLIDATE_THROTTLE_SECONDS = Number(
  process.env.MEMORY_CONSOLIDATE_THROTTLE_SECONDS ?? 60 * 60,
);

export type ConsolidationSummarizer = (items: MemoryItem[]) => Promise<string>;

export const memoryStore = new MemoryStore({
  client: valkey as unknown as MemoryStoreClient,
  name: MEMORY_NAME,
  embedFn: embedText,
  // Register a discovery marker so this store shows up in the Monitor next to
  // the caches; best-effort, never blocks the request path.
  discovery: true,
});

let indexReady: Promise<void> | null = null;

/**
 * Idempotently create the FT vector index on first use (memoized). If the
 * bootstrap rejects (e.g. Valkey down at cold start) the cached promise is
 * cleared so the next call retries instead of failing forever.
 */
export function ensureMemoryIndex(): Promise<void> {
  if (indexReady === null) {
    indexReady = memoryStore.ensureIndex().catch((e) => {
      indexReady = null;
      throw e;
    });
  }
  return indexReady;
}

/** Recall this user's most relevant memories for the current message. */
export async function recallMemories(text: string, userId: string, k = DEFAULT_RECALL_K) {
  await ensureMemoryIndex();
  return memoryStore.recall(text, { namespace: userId, k });
}

/** Store a durable fact/preference learned about this user. */
export async function rememberFact(
  content: string,
  userId: string,
  opts: { importance?: number; tags?: string[] } = {},
) {
  await ensureMemoryIndex();
  return memoryStore.remember(content, {
    namespace: userId,
    importance: opts.importance,
    tags: opts.tags,
    source: "chat",
  });
}

/** List everything currently remembered about this user (for the Memory panel). */
export async function listMemories(userId: string, limit = 50) {
  await ensureMemoryIndex();
  return memoryStore.list({ namespace: userId, limit });
}

/**
 * True if `id` is a memory owned by `userId`. Used to authorize a governed
 * forget so a visitor can't file a deletion proposal for someone else's fact.
 */
export async function userOwnsMemory(userId: string, id: string): Promise<boolean> {
  await ensureMemoryIndex();
  const item = await memoryStore.get(id);
  return item !== null && item.namespace === userId;
}

/**
 * Acquire a short-lived per-user lock so consolidation runs at most once per
 * throttle window. SET NX EX is atomic, so concurrent turns can't both win.
 */
async function acquireConsolidateLock(userId: string): Promise<boolean> {
  const key = `${MEMORY_NAME}:consolidate_lock:${userId}`;
  const res = await valkey.set(key, "1", "EX", CONSOLIDATE_THROTTLE_SECONDS, "NX");
  return res === "OK";
}

/**
 * Compress this user's old memories into a summary, but no more than once per
 * throttle window. Returns null when the throttle lock is held (consolidation
 * skipped this turn). `summarize` turns a batch of items into one summary line.
 */
export async function maybeConsolidate(
  userId: string,
  summarize: ConsolidationSummarizer,
): Promise<ConsolidateResult | null> {
  const acquired = await acquireConsolidateLock(userId);
  if (!acquired) {
    return null;
  }
  await ensureMemoryIndex();
  return memoryStore.consolidate({
    namespace: userId,
    olderThanSeconds: CONSOLIDATE_AFTER_SECONDS,
    summarize,
    deleteSources: true,
    summaryImportance: 0.6,
    tags: ["summary"],
  });
}
