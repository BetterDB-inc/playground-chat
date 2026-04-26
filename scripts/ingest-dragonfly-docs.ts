#!/usr/bin/env tsx
/**
 * Fetches Dragonfly docs (Docusaurus site) via its sitemap and writes JSONL
 * to data/dragonfly-docs.jsonl.
 *
 * Filters: keeps everything under /docs/ except the search index page and
 * the empty category landing pages (which are just nav stubs).
 *
 * Politeness: see _scrape-utils.ts and the SCRAPE_DELAY_MS env var.
 */

import * as fs from "fs";
import * as path from "path";
import { chunkText, fetchSitemap, makeId, politeFetchHtml, stripHtml } from "./_scrape-utils";

interface Doc {
  id: string;
  source: "dragonfly";
  kind: "command" | "topic";
  title: string;
  url: string;
  content: string;
}

const SITEMAP_URL = "https://www.dragonflydb.io/sitemap.xml";
const OUT_FILE = path.join(process.cwd(), "data", "dragonfly-docs.jsonl");
const MAX_PAGES = Number(process.env.MAX_DRAGONFLY_PAGES ?? 500);

function classify(url: string): "command" | "topic" {
  return url.includes("/command-reference/") ? "command" : "topic";
}

async function main() {
  console.log("Fetching Dragonfly sitemap…");
  const all = await fetchSitemap(SITEMAP_URL);
  const docsUrls = all
    .filter((u) => u.startsWith("https://www.dragonflydb.io/docs/"))
    // Skip nav stubs (Docusaurus generates one URL per category container)
    // and the search page (no content).
    .filter((u) => !u.includes("/docs/category/") && !u.endsWith("/docs/search"))
    .slice(0, MAX_PAGES);
  console.log(`Found ${docsUrls.length} docs pages.`);

  const docs: Doc[] = [];
  for (const url of docsUrls) {
    try {
      const page = await politeFetchHtml(url);
      // Docusaurus wraps content in <article> on doc pages, with an <h1>
      // for the title. Fall back to <main> if <article> isn't present.
      const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page);
      const rawTitle = titleMatch?.[1]
        ? stripHtml(titleMatch[1])
        : (url.split("/").at(-1) ?? "untitled");
      const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(page);
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const region = articleMatch?.[1] ?? mainMatch?.[1] ?? page;
      const body = stripHtml(region);
      if (body.length < 30) continue;

      const kind = classify(url);
      const chunks = chunkText(body);
      chunks.forEach((content, i) => {
        docs.push({
          id: makeId(["dragonfly", url, String(chunks.length > 1 ? i : "")]),
          source: "dragonfly",
          kind,
          title: chunks.length > 1 ? `${rawTitle} (${i + 1})` : rawTitle,
          url,
          content,
        });
      });
    } catch (e) {
      console.warn(`  skip ${url}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`Total Dragonfly docs: ${docs.length}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`Written to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
