#!/usr/bin/env tsx
/**
 * Fetches Valkey commands and topics pages, parses them into docs, and
 * writes JSONL to data/valkey-docs.jsonl.
 *
 * Politeness: a small delay sits between successive requests (see
 * SCRAPE_DELAY_MS env var, default 250ms). Override or remove only if you
 * own / coordinate with the upstream site.
 */

import * as fs from "fs";
import * as path from "path";
import { chunkText, extractLinks, makeId, politeFetchHtml, stripHtml } from "./_scrape-utils";

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

/** Cap how many pages we crawl per index - protects against runaway crawls. */
const MAX_COMMANDS = Number(process.env.MAX_COMMANDS ?? 200);
const MAX_TOPICS = Number(process.env.MAX_TOPICS ?? 100);

async function ingestCommands(): Promise<Doc[]> {
  console.log("Fetching Valkey commands index…");
  const html = await politeFetchHtml(COMMANDS_URL);
  const commandLinks = extractLinks(html, COMMANDS_URL).filter(
    (l) => l.startsWith("https://valkey.io/commands/") && l !== COMMANDS_URL,
  );
  const uniqueLinks = [...new Set(commandLinks)].slice(0, MAX_COMMANDS);
  console.log(`Found ${uniqueLinks.length} command pages.`);

  const docs: Doc[] = [];
  let i = 0;
  for (const url of uniqueLinks) {
    i++;
    try {
      const page = await politeFetchHtml(url);
      const titleMatch = /<h1[^>]*>([^<]+)<\/h1>/i.exec(page);
      const title = titleMatch?.[1] ? titleMatch[1].trim() : (url.split("/").at(-1) ?? "unknown");
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const body = mainMatch?.[1] ? stripHtml(mainMatch[1]) : stripHtml(page);
      if (body.length < 20) {
        if (i % 25 === 0)
          console.log(`  [${i}/${uniqueLinks.length}] ${title} (skipped, too short)`);
        continue;
      }
      const chunks = chunkText(body);
      chunks.forEach((content, idx) => {
        docs.push({
          id: makeId(["valkey-cmd", title, String(chunks.length > 1 ? idx : "")]),
          source: "valkey",
          kind: "command",
          title: chunks.length > 1 ? `${title} (${idx + 1})` : title,
          url,
          content,
        });
      });
      if (i % 25 === 0 || i === uniqueLinks.length) {
        console.log(`  [${i}/${uniqueLinks.length}] ${title} (${chunks.length} chunk(s))`);
      }
    } catch (e) {
      console.warn(
        `  [${i}/${uniqueLinks.length}] skip ${url}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return docs;
}

async function ingestTopics(): Promise<Doc[]> {
  console.log("Fetching Valkey topics index…");
  const html = await politeFetchHtml(TOPICS_URL);
  const topicLinks = extractLinks(html, TOPICS_URL).filter(
    (l) => l.startsWith("https://valkey.io/topics/") && l !== TOPICS_URL,
  );
  const uniqueLinks = [...new Set(topicLinks)].slice(0, MAX_TOPICS);
  console.log(`Found ${uniqueLinks.length} topic pages.`);

  const docs: Doc[] = [];
  let i = 0;
  for (const url of uniqueLinks) {
    i++;
    try {
      const page = await politeFetchHtml(url);
      if (i % 10 === 0 || i === uniqueLinks.length) {
        console.log(`  [${i}/${uniqueLinks.length}] ${url.split("/").at(-2) ?? url}`);
      }
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const content = mainMatch?.[1] ?? page;

      // Split on H2/H3 headings so each chunk has a coherent topic.
      const sections = content.split(/<h[23][^>]*>/i);
      for (const section of sections) {
        const headingMatch = /^([^<]+)<\/h[23]>/i.exec(section);
        const sectionTitle = headingMatch?.[1]
          ? headingMatch[1].trim()
          : (url.split("/").at(-1) ?? "topic");
        const text = stripHtml(section);
        if (text.length < 30) continue;
        const chunks = chunkText(text);
        chunks.forEach((chunk, i) => {
          docs.push({
            id: makeId(["valkey-topic", url, sectionTitle, String(chunks.length > 1 ? i : "")]),
            source: "valkey",
            kind: "topic",
            title: chunks.length > 1 ? `${sectionTitle} (${i + 1})` : sectionTitle,
            url,
            content: chunk,
          });
        });
      }
    } catch (e) {
      console.warn(`  skip ${url}:`, e instanceof Error ? e.message : e);
    }
  }
  return docs;
}

async function main() {
  // Sequential - both crawl the same host and we want to honour the global
  // pacing in politeFetchHtml.
  const commands = await ingestCommands();
  const topics = await ingestTopics();
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
