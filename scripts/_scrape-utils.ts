/**
 * Shared utilities for the doc-ingest scripts.
 *
 * Adds:
 *   - Polite request pacing (a configurable delay between requests so we
 *     don't hammer valkey.io / redis.io).
 *   - Identifiable User-Agent with a contact email so site owners can reach
 *     us if we cause issues.
 *   - Sentence-aware chunking so we don't split mid-thought when a section
 *     happens to land on a token-budget boundary.
 *   - Robust HTML entity decoding via a single function.
 *
 * Constants are exported so individual ingest scripts can override them.
 */

import * as crypto from "crypto";

/** Default delay between successive HTTP requests, in ms. */
export const DEFAULT_REQUEST_DELAY_MS = 250;

/** ~4 chars/token approximation - matches lib/pricing.ts approximateTokens. */
const CHARS_PER_TOKEN = 4;

/** Default chunk budget (~tokens) before splitting. */
export const DEFAULT_MAX_TOKENS = 800;

/**
 * Identifier sent in the User-Agent header. Override via SCRAPE_USER_AGENT
 * to advertise a contact address the upstream site can reach you at - the
 * default below uses example.invalid so site owners get an obvious "this
 * is a placeholder" rather than a deliverable wrong address.
 */
export const USER_AGENT =
  process.env.SCRAPE_USER_AGENT ??
  "betterdb-playground-ingest/1.0 (+https://github.com/REPLACE-ME/playground-chat; contact: REPLACE-ME-BEFORE-PUBLISHING@example.invalid)";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Sleep helper for politeness pacing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sentence-aware chunker. Splits on sentence boundaries (`. `, `? `, `! `,
 * newline boundaries) before falling back to word splitting, so chunk
 * boundaries are usually on natural seams.
 */
export function chunkText(text: string, maxTokens: number = DEFAULT_MAX_TOKENS): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  // First pass: split into sentences. The regex preserves trailing
  // punctuation by splitting AFTER it.
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  for (const sent of sentences) {
    const sentTokens = estimateTokens(sent);
    if (sentTokens > maxTokens) {
      // Lone giant sentence - flush buffer then word-split.
      if (buf.length) {
        chunks.push(buf.join(" "));
        buf = [];
        bufTokens = 0;
      }
      chunks.push(...wordChunk(sent, maxTokens));
      continue;
    }
    if (bufTokens + sentTokens > maxTokens && buf.length) {
      chunks.push(buf.join(" "));
      buf = [];
      bufTokens = 0;
    }
    buf.push(sent);
    bufTokens += sentTokens;
  }
  if (buf.length) chunks.push(buf.join(" "));
  return chunks;
}

function wordChunk(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  for (const w of words) {
    const t = estimateTokens(w);
    if (bufTokens + t > maxTokens && buf.length) {
      chunks.push(buf.join(" "));
      buf = [];
      bufTokens = 0;
    }
    buf.push(w);
    bufTokens += t;
  }
  if (buf.length) chunks.push(buf.join(" "));
  return chunks;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(ENTITIES)) {
    out = out.replaceAll(k, v);
  }
  return out
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * HTML stripper. Crude but predictable: removes script/style blocks then all
 * tags, decodes common entities, collapses whitespace. We trade fidelity for
 * zero-dep simplicity here. If the markup ever becomes meaningfully complex
 * (tables you want to preserve, etc.) swap in `cheerio` or `linkedom`.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, ""),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function extractLinks(html: string, base: string): string[] {
  const re = /href="([^"]+)"/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const href = decodeEntities(raw);
    if (!href || href.startsWith("#")) continue;
    try {
      links.push(new URL(href, base).href);
    } catch {
      // skip invalid
    }
  }
  return [...new Set(links)];
}

export function makeId(parts: string[]): string {
  return crypto.createHash("md5").update(parts.join(":")).digest("hex").slice(0, 12);
}

export interface FetchOpts {
  delayMs?: number;
}

let lastFetchAt = 0;

/**
 * Polite fetch with a global per-process minimum interval between requests.
 * The first request goes immediately; subsequent requests sleep just long
 * enough to honour the configured delay.
 */
export async function politeFetchHtml(url: string, opts: FetchOpts = {}): Promise<string> {
  const delay = opts.delayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const sinceLast = Date.now() - lastFetchAt;
  if (sinceLast < delay) await sleep(delay - sinceLast);
  lastFetchAt = Date.now();

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}
