#!/usr/bin/env tsx
/**
 * Reads JSONL doc files, embeds them, and upserts into valkey-search.
 * Creates the FT index `docs_idx` after data is written.
 *
 * Performance note: we drop the index BEFORE inserting and recreate it
 * AFTER the bulk write completes. valkey-search would otherwise re-index
 * each HSET synchronously (very slow for 3k+ docs); the post-bulk
 * `FT.CREATE` triggers one efficient backfill pass instead.
 */

import * as fs from "fs";
import * as path from "path";
import type Valkey from "iovalkey";
import { createValkeyClient } from "../lib/valkey";
import { embedBatch, floatArrayToBuffer } from "../lib/embeddings";
import { validateEnv } from "../lib/env";
import { cmd } from "../lib/valkey-cmd";

interface Doc {
  id: string;
  source: string;
  kind: string;
  title: string;
  url: string;
  content: string;
}

const BATCH_SIZE = Number(process.env.BUILD_INDEX_BATCH ?? 16);
const INDEX_NAME = "docs_idx";

async function dropIndexIfExists(client: Valkey): Promise<void> {
  try {
    await cmd(client, "FT.DROPINDEX", INDEX_NAME);
    console.log("Dropped existing index.");
  } catch {
    // index didn't exist; fine
  }
}

async function createIndex(client: Valkey, dim: number): Promise<void> {
  console.log(`Creating index ${INDEX_NAME} (DIM=${dim})…`);
  await cmd(
    client,
    "FT.CREATE",
    INDEX_NAME,
    "ON",
    "HASH",
    "PREFIX",
    "1",
    "doc:",
    "SCHEMA",
    "title",
    "TEXT",
    "content",
    "TEXT",
    "source",
    "TAG",
    "kind",
    "TAG",
    "url",
    "TAG",
    "embedding",
    "VECTOR",
    "HNSW",
    "6",
    "TYPE",
    "FLOAT32",
    "DIM",
    String(dim),
    "DISTANCE_METRIC",
    "COSINE",
  );
  console.log("Index created. Backfill will run in background.");
}

async function waitForBackfill(client: Valkey): Promise<void> {
  // FT.INFO returns alternating field/value entries. Poll until backfill
  // completes - the script's exit code then reflects an index that's ready
  // to serve queries.
  const POLL_INTERVAL_MS = 1_000;
  while (true) {
    const info = await cmd<unknown[]>(client, "FT.INFO", INDEX_NAME);
    const flat: Record<string, string> = {};
    for (let i = 0; i < info.length - 1; i += 2) {
      flat[String(info[i])] = String(info[i + 1]);
    }
    const pct = Number(flat["backfill_complete_percent"] ?? 0);
    const numDocs = Number(flat["num_docs"] ?? 0);
    console.log(`backfill ${(pct * 100).toFixed(1)}% - num_docs=${numDocs}`);
    if (pct >= 1) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  const env = validateEnv();

  const files = [
    path.join(process.cwd(), "data", "valkey-docs.jsonl"),
    path.join(process.cwd(), "data", "redis-docs.jsonl"),
  ].filter(fs.existsSync);

  if (!files.length) {
    console.error("No JSONL files found. Run ingest scripts first.");
    process.exit(1);
  }

  const docs: Doc[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    docs.push(...lines.map((l) => JSON.parse(l) as Doc));
  }
  console.log(`Loaded ${docs.length} docs.`);

  const client = createValkeyClient();
  await dropIndexIfExists(client);

  let stored = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => `${d.title}\n\n${d.content}`);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(docs.length / BATCH_SIZE);
    console.log(
      `[${batchNum}/${totalBatches}] embed ${texts.length} inputs (~${texts.reduce((s, t) => s + t.length, 0)} chars)`,
    );
    const t0 = Date.now();
    const embeddings = await embedBatch(texts, { model: env.embedModel });
    console.log(`[${batchNum}/${totalBatches}] embed done in ${Date.now() - t0}ms`);

    // Defensive: refuse to write a partial batch. A short embeddings array
    // means OpenAI didn't return one vector per input - usually a transient
    // upstream issue. Bailing here is safer than silently indexing only some
    // of the docs and producing a quietly incomplete corpus.
    if (embeddings.length !== batch.length) {
      throw new Error(
        `embed returned ${embeddings.length} vectors for ${batch.length} inputs ` +
          `(batch ${batchNum}/${totalBatches}); aborting to avoid a partial index. ` +
          `Re-run pnpm build:index to retry.`,
      );
    }

    const pipeline = client.pipeline();
    batch.forEach((doc, j) => {
      const vec = embeddings[j];
      // The length check above guarantees `vec` is defined; this narrows TS.
      if (!vec) return;
      pipeline.hset(
        `doc:${doc.id}`,
        "title",
        doc.title,
        "content",
        doc.content,
        "source",
        doc.source,
        "kind",
        doc.kind,
        "url",
        doc.url,
        "embedding",
        floatArrayToBuffer(vec),
      );
    });
    const t1 = Date.now();
    const pipeResults = await pipeline.exec();
    // pipeline.exec returns null on connection drop, or an array of
    // [err, result] tuples. Surface any per-command failure rather than
    // continuing with partial writes.
    if (!pipeResults) {
      throw new Error(`pipeline returned null on batch ${batchNum} (connection lost?)`);
    }
    const failed = pipeResults.filter(([err]) => err !== null);
    if (failed.length > 0) {
      throw new Error(
        `${failed.length}/${pipeResults.length} HSETs failed in batch ${batchNum}: ` +
          (failed[0]?.[0]?.message ?? "unknown error"),
      );
    }
    stored += batch.length;
    console.log(
      `[${batchNum}/${totalBatches}] pipeline done in ${Date.now() - t1}ms · stored ${stored}/${docs.length}`,
    );
  }

  await createIndex(client, env.embedDim);
  await waitForBackfill(client);

  await client.quit();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
