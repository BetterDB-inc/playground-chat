#!/usr/bin/env tsx
/**
 * Pretty-prints the last 100 entries from the playground log stream.
 * Usage: pnpm tail:logs
 */

import { createValkeyClient } from "../lib/valkey";

const STREAM_KEY = process.env.LOG_STREAM_KEY ?? "playground:logs";

type XrangeEntry = [string, string[]];

async function main() {
  const client = createValkeyClient();

  const entries = await (
    client as unknown as {
      xrevrange: (
        key: string,
        end: string,
        start: string,
        count: string,
        countVal: string,
      ) => Promise<XrangeEntry[]>;
    }
  ).xrevrange(STREAM_KEY, "+", "-", "COUNT", "100");

  if (!entries || entries.length === 0) {
    console.log("No log entries found.");
    await client.quit();
    return;
  }

  console.log(`\n=== Playground Logs (last ${entries.length}) ===\n`);

  for (const [id, fields] of entries) {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const k = fields[i];
      if (!k) continue;
      map[k] = fields[i + 1] ?? "";
    }

    const ts = map["ts"] ?? id;
    // Logger now stores hashed IPs; fall back to legacy "ip" field for old entries.
    const ip = map["ip_hash"] ?? map["ip"] ?? "?";
    const q = (map["q"] ?? "").slice(0, 80);
    const semHit = map["semantic_hit"] === "true" ? "HIT" : "MISS";
    const toolHits = map["tool_hits"] ?? "";
    const tokIn = map["tokens_in"] ?? "-";
    const tokOut = map["tokens_out"] ?? "-";
    const costUsd = map["cost_usd"] ? `$${parseFloat(map["cost_usd"]).toFixed(5)}` : "-";
    const savedUsd = map["saved_usd"] ? `$${parseFloat(map["saved_usd"]).toFixed(5)}` : "-";

    console.log(`[${ts}] ${ip}`);
    console.log(`  Q: ${q}`);
    console.log(`  Semantic: ${semHit}  Tools: ${toolHits || "none"}`);
    console.log(`  Tokens in/out: ${tokIn}/${tokOut}  Cost: ${costUsd}  Saved: ${savedUsd}`);
    console.log();
  }

  await client.quit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
