/**
 * Best-effort client-IP detection across deploy targets.
 *
 * Vercel sets `x-real-ip` to the actual edge-detected client IP - that's the
 * trusted source. `x-forwarded-for` can be set or appended to by clients
 * upstream of the platform proxy, so we only fall back to it when no trusted
 * header is present (i.e. when running outside Vercel).
 *
 * Importantly, we never fall back to a literal "unknown" string: every IP-less
 * request gets a per-request opaque token so one misbehaving client can't
 * exhaust the rate limit for everyone else who's missing the header.
 */

import { createHmac, randomBytes } from "node:crypto";

const SHARED_FALLBACK_PREFIX = "anon:";

export function detectClientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();

  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp && cfConnectingIp.trim()) return cfConnectingIp.trim();

  // x-forwarded-for is a comma-separated chain. The leftmost entry is the
  // original client per RFC 7239, but it's untrusted unless we control the
  // proxy chain. On Vercel, x-real-ip is preferred (above); this is the
  // fallback for self-hosted deployments behind a known reverse proxy.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  // No trusted IP available - generate an opaque per-request token so this
  // client gets its own rate-limit bucket rather than sharing one with every
  // other unidentified caller.
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
