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

  // Idempotent: creates the FT vector index if absent. Existing docs are
  // overwritten by id on re-ingest.
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
 * Block until valkey-search finishes backfilling the vector index. Without
 * this the script can exit mid-backfill, so queries run right after ingest
 * return partial or empty results.
 */
async function waitForBackfill(timeoutMs = 60_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await retriever.health().catch(() => null);
    if (health !== null && health.percentIndexed >= 100) {
      console.log(`Index backfilled: ${health.numDocs} docs.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn("Backfill did not reach 100% before timeout; continuing anyway.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
