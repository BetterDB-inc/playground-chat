#!/usr/bin/env tsx
/**
 * Fetches BetterDB docs (Just-the-Docs / Jekyll site at docs.betterdb.com)
 * and writes JSONL to data/betterdb-docs.jsonl.
 *
 * Strategy: Just-the-Docs sites don't ship a sitemap by default, but their
 * left-rail nav lists every published page. We BFS from the home page
 * following any internal href that ends in .html or is a clean directory
 * path - so we discover pages even if the home page doesn't link them all
 * directly.
 *
 * Politeness: see _scrape-utils.ts and the SCRAPE_DELAY_MS env var.
 */

import * as fs from "fs";
import * as path from "path";
import { chunkText, extractLinks, makeId, politeFetchHtml, stripHtml } from "./_scrape-utils";

interface Doc {
  id: string;
  source: "betterdb";
  kind: "command" | "topic";
  title: string;
  url: string;
  content: string;
}

const ROOT = "https://docs.betterdb.com/";
const OUT_FILE = path.join(process.cwd(), "data", "betterdb-docs.jsonl");
const MAX_PAGES = Number(process.env.MAX_BETTERDB_PAGES ?? 200);

function isInternalDocPage(url: string): boolean {
  if (!url.startsWith(ROOT)) return false;
  // Skip asset directories and external link redirects.
  if (/\/assets\/|\/images\/|\.(png|jpe?g|svg|gif|css|js|ico|pdf)$/i.test(url)) {
    return false;
  }
  return true;
}

/**
 * Some nav links point at `/docs/<path>` (e.g. /docs/packages/semantic-cache),
 * but those pages actually live at `/<path>` — the `/docs/` form 404s. Collapse
 * the erroneous prefix so discovery reaches the real pages and doesn't dupe them.
 */
function normalizeUrl(url: string): string {
  return url.replace(`${ROOT}docs/`, ROOT);
}

async function discoverPages(): Promise<string[]> {
  const visited = new Set<string>();
  const found = new Set<string>([ROOT]);
  const queue: string[] = [ROOT];

  while (queue.length > 0 && found.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      const html = await politeFetchHtml(url);
      const links = extractLinks(html, url).filter(isInternalDocPage);
      for (const link of links) {
        // Strip URL fragments (#section) so we don't crawl the same page twice,
        // and fix the bogus /docs/ prefix some nav links carry.
        const base = link.split("#")[0];
        const clean = base ? normalizeUrl(base) : undefined;
        if (clean && !found.has(clean) && found.size < MAX_PAGES) {
          found.add(clean);
          queue.push(clean);
        }
      }
    } catch (e) {
      console.warn(`  discover skip ${url}:`, e instanceof Error ? e.message : e);
    }
  }
  return [...found];
}

async function main() {
  console.log("Discovering BetterDB doc pages…");
  const urls = await discoverPages();
  console.log(`Discovered ${urls.length} pages.`);

  const docs: Doc[] = [];
  for (const url of urls) {
    try {
      const page = await politeFetchHtml(url);
      // Just-the-Docs wraps the article body in <main id="main-content">
      // with an <h1> for the page title. Fall back gracefully.
      const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page);
      const rawTitle = titleMatch?.[1]
        ? stripHtml(titleMatch[1])
        : url.replace(ROOT, "").replace(/\.html$/, "") || "BetterDB Home";
      const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(page);
      const region = mainMatch?.[1] ?? page;
      const body = stripHtml(region);
      if (body.length < 30) continue;

      const chunks = chunkText(body);
      chunks.forEach((content, i) => {
        docs.push({
          id: makeId(["betterdb", url, String(chunks.length > 1 ? i : "")]),
          source: "betterdb",
          // BetterDB docs aren't a command reference - everything is a topic.
          kind: "topic",
          title: chunks.length > 1 ? `${rawTitle} (${i + 1})` : rawTitle,
          url,
          content,
        });
      });
    } catch (e) {
      console.warn(`  skip ${url}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`Total BetterDB docs: ${docs.length}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`Written to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
