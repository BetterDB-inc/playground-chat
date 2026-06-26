#!/usr/bin/env tsx
/**
 * Reads JSONL doc files and ingests them into the docs index via
 * @betterdb/retrieval's Retriever (which owns the FT vector schema and embeds
 * each doc's body through the configured OpenAI embedder).
 *
 * Run the ingest-*.ts scrapers first to produce the data/*.jsonl files.
 *
 * Note: the Retriever embeds one doc at a time, so a large corpus means many
 * embedding calls — fine for an occasional offline ingest of this demo corpus.
 */

import * as fs from "fs";
import * as path from "path";
import { retriever, DOCS_INDEX } from "../lib/retrieval";
import { valkey } from "../lib/valkey";
import { validateEnv } from "../lib/env";

interface Doc {
  id: string;
  source: string;
  kind: string;
  title: string;
  url: string;
  content: string;
}

const BATCH_SIZE = Number(process.env.BUILD_INDEX_BATCH ?? 16);

async function main() {
  validateEnv();

  const files = [
    path.join(process.cwd(), "data", "valkey-docs.jsonl"),
    path.join(process.cwd(), "data", "redis-docs.jsonl"),
    path.join(process.cwd(), "data", "dragonfly-docs.jsonl"),
    path.join(process.cwd(), "data", "betterdb-docs.jsonl"),
  ].filter(fs.existsSync);

  if (files.length === 0) {
    console.error("No JSONL files found. Run the ingest scripts first.");
    process.exit(1);
  }
  console.log(`Indexing ${files.length} source(s) into "${DOCS_INDEX}":`);
  for (const f of files) console.log(`  - ${path.basename(f)}`);

  const docs: Doc[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    docs.push(...lines.map((l) => JSON.parse(l) as Doc));
  }
  console.log(`Loaded ${docs.length} docs.`);

  // Full rebuild: drop the index and clear existing doc hashes first, so docs
  // removed from the JSONL (or renamed ids) don't linger. Dropping the index
  // alone isn't enough — valkey-search re-indexes any hash under the key
  // prefix, so the stale hashes have to go too.
  await retriever.dropIndex().catch(() => undefined);
  await clearDocKeys();
  await retriever.createIndex();

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    await retriever.upsert(
      batch.map((d) => ({
        id: d.id,
        // Embed the title alongside the body so command names and headings
        // influence the vector — title-driven queries (e.g. "FT.SEARCH")
        // otherwise regress to body-only similarity.
        text: `${d.title}\n\n${d.content}`,
        fields: { title: d.title, source: d.source, kind: d.kind, url: d.url },
      })),
    );
    console.log(`upserted ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`);
  }

  await waitForBackfill();

  console.log("Done.");
  await valkey.quit();
}

/**
 * Delete every existing doc hash under the retriever's key prefix
 * (`${DOCS_INDEX}:`) so a full re-ingest starts clean. SCAN + batched DEL so a
 * large corpus doesn't block on one huge command.
 */
async function clearDocKeys(): Promise<void> {
  const pattern = `${DOCS_INDEX}:*`;
  let cursor = "0";
  let cleared = 0;
  do {
    const [next, keys] = await valkey.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length > 0) {
      await valkey.del(...keys);
      cleared += keys.length;
    }
  } while (cursor !== "0");
  if (cleared > 0) {
    console.log(`Cleared ${cleared} stale doc key(s).`);
  }
}

/**
 * Block until valkey-search finishes backfilling the vector index. Without
 * this the script can exit mid-backfill, so queries run right after ingest
 * return partial or empty results.
 */
async function waitForBackfill(timeoutMs = 60_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await retriever.health().catch(() => null);
    // `health().percentIndexed` is already normalized to a 0-100 scale by the
    // SDK's parsePercentIndexed (it scales a 0-1 fraction up), so 100 means
    // fully indexed regardless of whether valkey-search reports a fraction or a
    // percent. Require numDocs > 0 so an empty index can't read as complete.
    if (health !== null && health.numDocs > 0 && health.percentIndexed >= 100) {
      console.log(`Index backfilled: ${health.numDocs} docs.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn("Backfill did not reach 100% before timeout; continuing anyway.");
}

// The shared valkey singleton keeps the event loop alive even after quit() in
// some environments, so exit explicitly rather than letting the script hang.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
