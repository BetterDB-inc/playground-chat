import Valkey, { type RedisOptions } from "iovalkey";

declare global {
  // eslint-disable-next-line no-var
  var _valkey: Valkey | undefined;
}

/**
 * Build the iovalkey options with production-ready defaults.
 *
 * Recognises the URL scheme:
 *   - `redis://`  → plaintext (fine for localhost / private network)
 *   - `rediss://` → TLS (required for any internet-exposed endpoint)
 *
 * Optional env vars:
 *   - VALKEY_TLS_REJECT_UNAUTHORIZED=false → accept self-signed certs (dev only)
 *   - VALKEY_CONNECT_TIMEOUT_MS            → defaults to 10_000
 *   - VALKEY_MAX_RETRIES_PER_REQUEST       → defaults to 3
 */
function buildOptions(url: string): RedisOptions {
  const useTls = url.startsWith("rediss://");
  const connectTimeout = Number(process.env.VALKEY_CONNECT_TIMEOUT_MS ?? 10_000);
  const maxRetriesPerRequest = Number(process.env.VALKEY_MAX_RETRIES_PER_REQUEST ?? 3);

  const opts: RedisOptions = {
    connectTimeout,
    maxRetriesPerRequest,
    enableReadyCheck: true,
    lazyConnect: false,
  };

  if (useTls) {
    opts.tls = {
      rejectUnauthorized: process.env.VALKEY_TLS_REJECT_UNAUTHORIZED !== "false",
    };
  }

  return opts;
}

/**
 * Create a fresh Valkey client. Use from short-lived scripts that should
 * `await client.quit()` on completion.
 */
export function createValkeyClient(): Valkey {
  const url = process.env.VALKEY_URL ?? "redis://localhost:6399";
  return new Valkey(url, buildOptions(url));
}

/**
 * Long-lived singleton for the Next.js server runtime.
 * Reuses across hot-reloads in dev and across warm function invocations on Vercel.
 */
export const valkey: Valkey = global._valkey ?? (global._valkey = createValkeyClient());
