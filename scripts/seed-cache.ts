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

interface FaqRow {
  q: string;
  a: string;
}

/**
 * What a real chat turn for a typical FAQ question costs at runtime.
 *
 * The chat pipeline is NOT a one-shot prompt-and-answer; for any user
 * question it loads the system prompt, embeds tool schemas, calls 2-3
 * tools whose results get inserted into the context window, then
 * generates the answer. The token bill ends up around 4-6k input + a
 * few hundred output for gpt-4o-mini.
 *
 * If we stored just `approximateTokens(q)` and `approximateTokens(a)`,
 * cache hits would report savings ~50x lower than what the user actually
 * avoided spending. We use representative production values instead so
 * the displayed `costSaved` reflects reality.
 *
 * Tune via FAQ_REPRESENTATIVE_INPUT_TOKENS / FAQ_REPRESENTATIVE_OUTPUT_TOKENS
 * if your real chat turns burn meaningfully different token counts.
 */
const REPRESENTATIVE_INPUT_TOKENS = Number(
  process.env.FAQ_REPRESENTATIVE_INPUT_TOKENS ?? 5000,
);
const REPRESENTATIVE_OUTPUT_TOKENS = Number(
  process.env.FAQ_REPRESENTATIVE_OUTPUT_TOKENS ?? 300,
);

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
        // See REPRESENTATIVE_*_TOKENS above. We deliberately do NOT use the
        // FAQ text length here; that would massively underreport savings.
        inputTokens: REPRESENTATIVE_INPUT_TOKENS,
        outputTokens: REPRESENTATIVE_OUTPUT_TOKENS,
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
