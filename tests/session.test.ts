import { describe, it, expect } from "vitest";
import {
  readUserId,
  mintUserId,
  buildSetCookie,
  getOrCreateUserId,
} from "../lib/session";

function reqWithCookie(cookie?: string): Request {
  return new Request("http://localhost/api/chat", {
    headers: cookie ? { cookie } : {},
  });
}

describe("lib/session", () => {
  it("reads an existing pg_uid cookie", () => {
    expect(readUserId(reqWithCookie("pg_uid=u_abc123; other=1"))).toBe("u_abc123");
  });

  it("returns null when no pg_uid cookie is present", () => {
    expect(readUserId(reqWithCookie("other=1"))).toBeNull();
    expect(readUserId(reqWithCookie())).toBeNull();
  });

  it("mints opaque, unique ids", () => {
    const a = mintUserId();
    const b = mintUserId();
    expect(a).toMatch(/^u_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("buildSetCookie is httpOnly + long-lived", () => {
    const c = buildSetCookie("u_x");
    expect(c).toContain("pg_uid=u_x");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toMatch(/Max-Age=\d{6,}/);
  });

  it("getOrCreateUserId reuses an existing id without a Set-Cookie", () => {
    const r = getOrCreateUserId(reqWithCookie("pg_uid=u_existing"));
    expect(r).toEqual({ userId: "u_existing", isNew: false, setCookie: null });
  });

  it("getOrCreateUserId mints + returns a Set-Cookie when absent", () => {
    const r = getOrCreateUserId(reqWithCookie());
    expect(r.isNew).toBe(true);
    expect(r.userId).toMatch(/^u_[0-9a-f]{32}$/);
    expect(r.setCookie).toContain(`pg_uid=${r.userId}`);
    expect(r.setCookie).toContain("HttpOnly");
  });
});
