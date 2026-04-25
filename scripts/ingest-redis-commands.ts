#!/usr/bin/env tsx
/**
 * Fetches Redis OSS command docs and writes JSONL to data/redis-docs.jsonl.
 *
 * Politeness: see _scrape-utils.ts and the SCRAPE_DELAY_MS env var.
 */

import * as fs from "fs";
import * as path from "path";
import { chunkText, decodeEntities, makeId, politeFetchHtml, stripHtml } from "./_scrape-utils";

interface Doc {
  id: string;
  source: "redis";
  kind: "command" | "topic";
  title: string;
  url: string;
  content: string;
}

const COMMANDS_URL = "https://redis.io/docs/latest/commands/";
const OUT_FILE = path.join(process.cwd(), "data", "redis-docs.jsonl");
const MAX_COMMANDS = Number(process.env.MAX_COMMANDS ?? 200);

function extractCommandLinks(html: string, base: string): string[] {
  const re = /href="([^"]+)"/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const href = decodeEntities(raw);
    if (!href) continue;
    try {
      const abs = new URL(href, base).href;
      if (
        abs.startsWith("https://redis.io/docs/latest/commands/") &&
        abs !== base &&
        !abs.includes("?") &&
        !abs.includes("#")
      ) {
        links.push(abs);
      }
    } catch {
      // skip invalid
    }
  }
  return [...new Set(links)];
}

async function main() {
  console.log("Fetching Redis commands index…");
  const html = await politeFetchHtml(COMMANDS_URL);
  const links = extractCommandLinks(html, COMMANDS_URL).slice(0, MAX_COMMANDS);
  console.log(`Found ${links.length} command pages.`);

  const docs: Doc[] = [];
  for (const url of links) {
    try {
      const page = await politeFetchHtml(url);
      const titleMatch = /<h1[^>]*>([^<]+)<\/h1>/i.exec(page);
      const title = titleMatch?.[1] ? titleMatch[1].trim() : (url.split("/").at(-2) ?? "unknown");
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const body = mainMatch?.[1] ? stripHtml(mainMatch[1]) : stripHtml(page);
      if (body.length < 20) continue;
      const chunks = chunkText(body);
      chunks.forEach((content, i) => {
        docs.push({
          id: makeId(["redis", title, String(chunks.length > 1 ? i : "")]),
          source: "redis",
          kind: "command",
          title: chunks.length > 1 ? `${title} (${i + 1})` : title,
          url,
          content,
        });
      });
    } catch (e) {
      console.warn(`  skip ${url}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`Total Redis docs: ${docs.length}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`Written to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
