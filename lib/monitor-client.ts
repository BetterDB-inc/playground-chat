/**
 * Thin HTTP client for the BetterDB Monitor REST API.
 * Wraps the same /api/mcp/* endpoints that the betterdb-mcp stdio server calls,
 * so the optimize agent can drive the full proposal lifecycle with plain fetch().
 *
 * Required env vars:
 *   BETTERDB_URL          Full base URL of your Monitor instance (no trailing slash)
 *   BETTERDB_TOKEN        MCP bearer token from Monitor → Settings → Tokens
 *   BETTERDB_INSTANCE_ID  Connection ID of the Valkey instance to optimize
 */

const RAW_URL = process.env.BETTERDB_URL ?? "";
const TOKEN = process.env.BETTERDB_TOKEN ?? "";

// Auto-detect whether Monitor is behind /api (deployed) or / (local dev).
// We probe once and cache the result for the lifetime of this module.
let detectedPrefix: "/api" | "" | null = null;

async function detectPrefix(): Promise<"/api" | ""> {
  for (const prefix of ["/api", ""] as const) {
    try {
      const res = await fetch(`${RAW_URL}${prefix}/mcp/instances`, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return prefix;
    } catch {
      // try next
    }
  }
  return "/api";
}

async function monitorFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!RAW_URL) throw new Error("BETTERDB_URL is not set");
  if (!TOKEN) throw new Error("BETTERDB_TOKEN is not set");

  if (detectedPrefix === null) {
    detectedPrefix = await detectPrefix();
  }

  const url = `${RAW_URL}${detectedPrefix}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `Monitor API ${method} ${path} → ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      if (parsed.message) msg = parsed.message;
      else if (parsed.error) msg = parsed.error;
    } catch { /* use default */ }
    throw new Error(msg);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export const monitorGet = (path: string) => monitorFetch("GET", path);
export const monitorPost = (path: string, body: unknown) =>
  monitorFetch("POST", path, body);

export function requireInstanceId(): string {
  const id = process.env.BETTERDB_INSTANCE_ID ?? "";
  if (!id) throw new Error("BETTERDB_INSTANCE_ID is not set");
  return id;
}
