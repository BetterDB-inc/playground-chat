/**
 * Best-effort client-IP detection across deploy targets.
 *
 * Priority:
 *   1. `cf-connecting-ip` - set ONLY when Cloudflare is in the request chain,
 *      and always carries the real client (Cloudflare also sets x-real-ip in
 *      that case, but to its own edge IP, which would mis-attribute every
 *      request). Checking this first handles the Cloudflare-in-front-of-Vercel
 *      and Cloudflare-in-front-of-anything cases correctly.
 *   2. `x-real-ip` - what Vercel's edge sets when no other CDN is in front.
 *      Vercel always populates this for inbound HTTP requests; client-supplied
 *      values are stripped at the edge so it's not spoofable through Vercel.
 *   3. `x-forwarded-for` - leftmost entry per RFC 7239. Untrusted unless we
 *      control the proxy chain; this is the fallback for self-hosted setups
 *      behind a known reverse proxy.
 *   4. Opaque per-request token - no trusted IP available. Each caller gets
 *      its own rate-limit bucket rather than sharing one with every other
 *      unidentified client; never fall back to a literal "unknown" string.
 *
 * Verify the priority is producing sensible IPs after a deploy via
 * GET /api/debug/ip?token=$IP_DEBUG_TOKEN (see app/api/debug/ip/route.ts).
 */

import { createHmac, randomBytes } from "node:crypto";

const SHARED_FALLBACK_PREFIX = "anon:";

export function detectClientIp(req: Request): string {
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp && cfConnectingIp.trim()) return cfConnectingIp.trim();

  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return SHARED_FALLBACK_PREFIX + randomBytes(8).toString("hex");
}

/**
 * Hash an IP for storage in logs. We use HMAC-SHA256 with a salt that rotates
 * daily, so an IP can't be re-identified across days even if logs leak.
 *
 * The salt comes from the `LOG_IP_SALT` env var if set (recommended for
 * production so all instances agree within a day), otherwise we derive a
 * stable per-day salt from a process-local seed. Same-day same-IP entries
 * within one process can be correlated for abuse investigation; cross-day
 * correlation requires the original salt.
 */
const PROCESS_SEED = randomBytes(16).toString("hex");

export function hashIp(ip: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const salt = (process.env.LOG_IP_SALT ?? PROCESS_SEED) + ":" + day;
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16);
}
