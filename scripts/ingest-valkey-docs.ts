#!/usr/bin/env tsx
/**
 * Fetches Valkey commands and topics pages, parses them into docs,
 * and writes JSONL to data/valkey-docs.jsonl.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface Doc {
  id: string;
  source: "valkey";
  kind: "command" | "topic";
  title: string;
  url: string;
  content: string;
}

const COMMANDS_URL = "https://valkey.io/commands/";
const TOPICS_URL = "https://valkey.io/topics/";
const OUT_FILE = path.join(process.cwd(), "data", "valkey-docs.jsonl");
const MAX_TOKENS = 800;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

function makeId(source: string, title: string, idx?: number): string {
  const base = `${source}:${title}${idx !== undefined ? `:${idx}` : ""}`;
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

function extractLinks(html: string, base: string): string[] {
  const re = /href="([^"]+)"/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("#")) continue;
    try {
      const abs = new URL(href, base).href;
      links.push(abs);
    } catch {
      // skip invalid
    }
  }
  return [...new Set(links)];
}

async function ingestCommands(): Promise<Doc[]> {
  console.log("Fetching Valkey commands index…");
  const html = await fetchHtml(COMMANDS_URL);
  const commandLinks = extractLinks(html, COMMANDS_URL).filter((l) =>
    l.startsWith("https://valkey.io/commands/") && l !== COMMANDS_URL
  );
  const uniqueLinks = [...new Set(commandLinks)].slice(0, 200);
  console.log(`Found ${uniqueLinks.length} command pages.`);

  const docs: Doc[] = [];
  for (const url of uniqueLinks) {
    try {
      const page = await fetchHtml(url);
      const titleMatch = /<h1[^>]*>([^<]+)<\/h1>/i.exec(page);
      const title = titleMatch ? titleMatch[1].trim() : url.split("/").at(-1) ?? "unknown";
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const body = mainMatch ? stripHtml(mainMatch[1]) : stripHtml(page);
      if (body.length < 20) continue;
      const chunks = chunkText(body);
      chunks.forEach((content, i) => {
        docs.push({
          id: makeId("valkey-cmd", title, chunks.length > 1 ? i : undefined),
          source: "valkey",
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
  return docs;
}

async function ingestTopics(): Promise<Doc[]> {
  console.log("Fetching Valkey topics index…");
  const html = await fetchHtml(TOPICS_URL);
  const topicLinks = extractLinks(html, TOPICS_URL).filter((l) =>
    l.startsWith("https://valkey.io/topics/") && l !== TOPICS_URL
  );
  const uniqueLinks = [...new Set(topicLinks)].slice(0, 100);
  console.log(`Found ${uniqueLinks.length} topic pages.`);

  const docs: Doc[] = [];
  for (const url of uniqueLinks) {
    try {
      const page = await fetchHtml(url);
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const content = mainMatch ? mainMatch[1] : page;

      // Split by H2/H3 headings
      const sections = content.split(/<h[23][^>]*>/i);
      for (const section of sections) {
        const headingMatch = /^([^<]+)<\/h[23]>/i.exec(section);
        const sectionTitle = headingMatch
          ? headingMatch[1].trim()
          : url.split("/").at(-1) ?? "topic";
        const text = stripHtml(section);
        if (text.length < 30) continue;
        const chunks = chunkText(text);
        chunks.forEach((chunk, i) => {
          docs.push({
            id: makeId("valkey-topic", `${url}:${sectionTitle}`, chunks.length > 1 ? i : undefined),
            source: "valkey",
            kind: "topic",
            title: chunks.length > 1 ? `${sectionTitle} (${i + 1})` : sectionTitle,
            url,
            content: chunk,
          });
        });
      }
    } catch (e) {
      console.warn(`  skip ${url}: ${e}`);
    }
  }
  return docs;
}

async function main() {
  const [commands, topics] = await Promise.all([ingestCommands(), ingestTopics()]);
  const all = [...commands, ...topics];
  console.log(`Total docs: ${all.length}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, all.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`Written to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
