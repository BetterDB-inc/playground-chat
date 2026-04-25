#!/usr/bin/env tsx
/**
 * Reads JSONL doc files, embeds them, and upserts into valkey-search.
 * Creates FT index docs_idx if it doesn't exist.
 */

import * as fs from "fs";
import * as path from "path";
import Valkey from "iovalkey";

interface Doc {
  id: string;
  source: string;
  kind: string;
  title: string;
  url: string;
  content: string;
}

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6399";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";
const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1536);
const BATCH_SIZE = 100;
const INDEX_NAME = "docs_idx";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Embed error: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function floatArrayToBuffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  arr.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

async function ensureIndex(client: Valkey): Promise<void> {
  try {
    await (client as unknown as { call: (...args: unknown[]) => Promise<unknown> }).call("FT.INFO", INDEX_NAME);
    console.log("Index already exists.");
  } catch {
    console.log("Creating index docs_idx…");
    await (client as unknown as { call: (...args: unknown[]) => Promise<unknown> }).call(
      "FT.CREATE",
      INDEX_NAME,
      "ON", "HASH",
      "PREFIX", "1", "doc:",
      "SCHEMA",
      "title", "TEXT", "WEIGHT", "2.0",
      "content", "TEXT",
      "source", "TAG",
      "kind", "TAG",
      "url", "TAG",
      "embedding", "VECTOR", "HNSW", "6",
      "TYPE", "FLOAT32",
      "DIM", String(EMBED_DIM),
      "DISTANCE_METRIC", "COSINE"
    );
    console.log("Index created.");
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

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

  const client = new Valkey(VALKEY_URL);
  await ensureIndex(client);

  let stored = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => `${d.title}\n\n${d.content}`);
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(docs.length / BATCH_SIZE)}…`);
    const embeddings = await embed(texts);

    const pipeline = client.pipeline();
    batch.forEach((doc, j) => {
      const key = `doc:${doc.id}`;
      const embBuf = floatArrayToBuffer(embeddings[j]);
      pipeline.hset(key, {
        title: doc.title,
        content: doc.content,
        source: doc.source,
        kind: doc.kind,
        url: doc.url,
        embedding: embBuf,
      });
    });
    await pipeline.exec();
    stored += batch.length;
    console.log(`  stored ${stored}/${docs.length}`);
  }

  await client.quit();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
