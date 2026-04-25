#!/usr/bin/env tsx
/**
 * Seeds the semantic cache with curated Valkey/Redis FAQ pairs from
 * data/faq.jsonl so the first users see instant cached responses.
 *
 * Each entry is stored with `model`, `inputTokens`, and `outputTokens` so
 * subsequent semantic-cache hits report a real `costSaved` (the LLM call
 * we'd have made if the cache had missed).
 */

import * as fs from "fs";
import * as path from "path";
import { semanticCache, initCaches } from "../lib/cache";
import { embedText } from "../lib/embeddings";
import { validateEnv } from "../lib/env";
import { approximateTokens } from "../lib/pricing";

interface FaqRow {
  q: string;
  a: string;
}

async function main() {
  const env = validateEnv();
  // embedText reads OPENAI_API_KEY internally; force a probe so a missing
  // key fails fast before we try to seed.
  await embedText("probe");

  const faqPath = path.join(process.cwd(), "data", "faq.jsonl");
  if (!fs.existsSync(faqPath)) {
    console.error(`Missing ${faqPath}. Add curated FAQ entries first.`);
    process.exit(1);
  }
  const rows = fs
    .readFileSync(faqPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FaqRow);

  await initCaches();

  console.log(`Seeding ${rows.length} FAQ pairs into semantic cache…`);
  let stored = 0;
  for (const { q, a } of rows) {
    try {
      await semanticCache.store(q, a, {
        model: env.llmModel,
        // We didn't actually call the LLM to generate these answers, so token
        // counts are estimated from text length. Keeps reported savings
        // consistent with what a real call would have charged.
        inputTokens: approximateTokens(q),
        outputTokens: approximateTokens(a),
      });
      stored++;
      process.stdout.write(`\r  ${stored}/${rows.length}`);
    } catch (e) {
      console.warn(`\n  Failed to store "${q.slice(0, 40)}…":`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\nDone. ${stored} entries seeded.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
