import { randomBytes } from "crypto";

/**
 * Anonymous visitor identity for memory scoping. An opaque id is minted into an
 * httpOnly cookie on first visit and used as `namespace` for agent-memory, so a
 * returning visitor gets back what the assistant learned about them — no login,
 * privacy-friendly, fits a public demo.
 */
const COOKIE_NAME = "pg_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the visitor id from the request's Cookie header, or null if absent. */
export function readUserId(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  const captured = header.match(/(?:^|;\s*)pg_uid=([^;]+)/)?.[1];
  return captured !== undefined ? decodeURIComponent(captured) : null;
}

/** Mint a fresh opaque visitor id. */
export function mintUserId(): string {
  return `u_${randomBytes(16).toString("hex")}`;
}

/** Build the Set-Cookie header value for a visitor id. */
export function buildSetCookie(userId: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(userId)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax`;
}

/**
 * Resolve the visitor id, minting one if the cookie is absent. When `isNew`,
 * the caller must attach `setCookie` to the response so it persists.
 */
export function getOrCreateUserId(req: Request): {
  userId: string;
  isNew: boolean;
  setCookie: string | null;
} {
  const existing = readUserId(req);
  if (existing) {
    return { userId: existing, isNew: false, setCookie: null };
  }
  const userId = mintUserId();
  return { userId, isNew: true, setCookie: buildSetCookie(userId) };
}
