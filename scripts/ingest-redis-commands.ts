#!/usr/bin/env tsx
/**
 * Fetches Redis OSS command docs and writes JSONL to data/redis-docs.jsonl.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

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
const MAX_TOKENS = 800;

function chunkText(text: string, maxTokens = MAX_TOKENS): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const w of words) {
    const t = Math.ceil(w.length / 4);
    if (count + t > maxTokens && current.length > 0) {
      chunks.push(current.join(" "));
      current = [];
      count = 0;
    }
    current.push(w);
    count += t;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}

function makeId(title: string, idx?: number): string {
  const base = `redis:${title}${idx !== undefined ? `:${idx}` : ""}`;
  return crypto.createHash("md5").update(base).digest("hex").slice(0, 12);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "BetterDB-playground-ingest/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function extractCommandLinks(html: string, base: string): string[] {
  const re = /href="([^"]+)"/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    try {
      const abs = new URL(href, base).href;
      // Only OSS command pages (exclude cloud, enterprise, etc.)
      if (
        abs.startsWith("https://redis.io/docs/latest/commands/") &&
        abs !== base &&
        !abs.includes("?") &&
        !abs.includes("#")
      ) {
        links.push(abs);
      }
    } catch {
      // skip
    }
  }
  return [...new Set(links)];
}

async function main() {
  console.log("Fetching Redis commands index…");
  const html = await fetchHtml(COMMANDS_URL);
  const links = extractCommandLinks(html, COMMANDS_URL).slice(0, 200);
  console.log(`Found ${links.length} command pages.`);

  const docs: Doc[] = [];
  for (const url of links) {
    try {
      const page = await fetchHtml(url);
      const titleMatch = /<h1[^>]*>([^<]+)<\/h1>/i.exec(page);
      const title = titleMatch ? titleMatch[1].trim() : url.split("/").at(-2) ?? "unknown";
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const body = mainMatch ? stripHtml(mainMatch[1]) : stripHtml(page);
      if (body.length < 20) continue;
      const chunks = chunkText(body);
      chunks.forEach((content, i) => {
        docs.push({
          id: makeId(title, chunks.length > 1 ? i : undefined),
          source: "redis",
          kind: "command",
          title: chunks.length > 1 ? `${title} (${i + 1})` : title,
          url,
          content,
        });
      });
    } catch (e) {
      console.warn(`  skip ${url}: ${e}`);
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
