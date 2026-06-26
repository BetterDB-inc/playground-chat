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

// Auto-detect whether Monitor is behind /api (deployed) or / (local dev).
//
// Design:
// - Env vars are read inside functions (not at module scope) so tests and
//   runtime env changes take effect without a module reload.
// - A separate in-flight promise (prefixInFlight) serialises concurrent
//   cold-start callers so only one probe runs at a time.
// - A TTL-based cache (PREFIX_TTL_MS) ensures the prefix is re-probed
//   periodically so a Monitor path change takes effect eventually without
//   needing a process restart.
// - 404s from legitimate "resource not found" responses are NOT used to
//   reset the prefix — that caused spurious re-probes on every deleted cache.
//   The TTL handles stale prefixes instead.

const PREFIX_TTL_MS = 5 * 60 * 1000; // re-probe every 5 minutes

let prefixCache: { value: "/api" | ""; resolvedAt: number } | null = null;
let prefixInFlight: Promise<"/api" | ""> | null = null;

async function detectPrefix(url: string, token: string): Promise<"/api" | ""> {
  for (const prefix of ["/api", ""] as const) {
    try {
      const res = await fetch(`${url}${prefix}/mcp/instances`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return prefix;
      // 401 means the Monitor is reachable but the token is wrong — no point
      // trying the other prefix, fail immediately with a clear message.
      if (res.status === 401) {
        throw new Error(
          "BetterDB Monitor rejected the token (401) — check BETTERDB_TOKEN in Vercel env vars",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) throw err;
      // try next prefix
    }
  }
  throw new Error(
    "BetterDB Monitor not reachable — check BETTERDB_URL and BETTERDB_TOKEN",
  );
}

function resolvePrefix(url: string, token: string): Promise<"/api" | ""> {
  // Invalidate expired cache so a Monitor path change takes effect eventually.
  if (prefixCache && Date.now() - prefixCache.resolvedAt > PREFIX_TTL_MS) {
    prefixCache = null;
  }
  if (prefixCache) return Promise.resolve(prefixCache.value);

  if (!prefixInFlight) {
    prefixInFlight = detectPrefix(url, token)
      .then((value) => {
        prefixCache = { value, resolvedAt: Date.now() };
        prefixInFlight = null;
        return value;
      })
      .catch((err: unknown) => {
        prefixInFlight = null; // allow retry on next call
        throw err;
      });
  }
  return prefixInFlight;
}

async function monitorFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  // Read env vars here (not at module scope) so tests and runtime changes work.
  const url = (process.env.BETTERDB_URL ?? "").replace(/\/+$/, "");
  const token = process.env.BETTERDB_TOKEN ?? "";

  if (!url) throw new Error("BETTERDB_URL is not set");
  if (!token) throw new Error("BETTERDB_TOKEN is not set");

  const prefix = await resolvePrefix(url, token);
  const fullUrl = `${url}${prefix}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // 5s cap: the route's AbortController fires at 45s and doesn't propagate
    // into tool fetches. Keeping this low ensures in-flight fetches complete
    // well within the 55s maxDuration even if they start near the deadline.
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `Monitor API ${method} ${path} → ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      const detail = parsed.message ?? parsed.error;
      if (detail) msg = `${msg}: ${detail}`;
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

/**
 * Whether a Monitor is wired up (URL + token + instance). Used to gate the
 * governed-forget UI: without a Monitor, the Forget button degrades to a
 * disabled state instead of erroring.
 */
export function isMonitorConfigured(): boolean {
  return Boolean(
    process.env.BETTERDB_URL && process.env.BETTERDB_TOKEN && process.env.BETTERDB_INSTANCE_ID,
  );
}
