/**
 * Token-gated diagnostic for verifying that client IP detection is working
 * after a deploy. Returns the raw values of every header we look at, plus
 * the IP our `detectClientIp` function settled on.
 *
 * Usage:
 *   curl -H "x-debug-token: $IP_DEBUG_TOKEN" https://your-app/api/debug/ip
 *
 * Auth model: required header `x-debug-token` must match `IP_DEBUG_TOKEN`
 * env var. If the env var is unset OR the header is missing/wrong, the
 * endpoint returns 404 (not 401) so it doesn't advertise its own existence
 * to scanners.
 */

import { detectClientIp } from "@/lib/client-ip";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const expected = process.env.IP_DEBUG_TOKEN;
  const provided = req.headers.get("x-debug-token");
  if (!expected || !provided || provided !== expected) {
    return new Response("Not Found", { status: 404 });
  }

  return Response.json({
    detected: detectClientIp(req),
    headers: {
      "cf-connecting-ip": req.headers.get("cf-connecting-ip"),
      "x-real-ip": req.headers.get("x-real-ip"),
      "x-forwarded-for": req.headers.get("x-forwarded-for"),
      "x-vercel-forwarded-for": req.headers.get("x-vercel-forwarded-for"),
      "x-vercel-ip-country": req.headers.get("x-vercel-ip-country"),
      "x-vercel-ip-region": req.headers.get("x-vercel-ip-region"),
      "x-vercel-ip-city": req.headers.get("x-vercel-ip-city"),
      "user-agent": req.headers.get("user-agent"),
    },
    runtime: {
      vercel: process.env.VERCEL === "1",
      vercelEnv: process.env.VERCEL_ENV ?? null,
      nodeEnv: process.env.NODE_ENV ?? null,
    },
  });
}
