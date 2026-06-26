import { MemoryStore, type MemoryStoreClient } from "@betterdb/agent-memory";
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

export const memoryStore = new MemoryStore({
  client: valkey as unknown as MemoryStoreClient,
  name: MEMORY_NAME,
  embedFn: embedText,
  // Register a discovery marker so this store shows up in the Monitor next to
  // the caches; best-effort, never blocks the request path.
  discovery: true,
});

let indexReady: Promise<void> | null = null;

/** Idempotently create the FT vector index on first use (memoized). */
export function ensureMemoryIndex(): Promise<void> {
  if (indexReady === null) {
    indexReady = memoryStore.ensureIndex();
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
