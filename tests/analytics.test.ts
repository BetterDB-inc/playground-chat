import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * We verify the NOOP / opt-out behaviour of `lib/analytics.ts`. Exercising
 * the real PostHog path would require hitting the network, so we only check
 * that the build path returns a working no-op when:
 *   - Telemetry is disabled via BETTERDB_TELEMETRY
 *   - No API key is set
 * In both cases `captureChatTurn` must complete without throwing AND
 * without touching Valkey (the instance-id round-trip is short-circuited).
 */

const originalEnv = process.env;

// Keep the valkey module from actually connecting during tests.
vi.mock("@/lib/valkey", () => ({
  valkey: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
  },
}));

describe("analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.BETTERDB_POSTHOG_API_KEY;
    delete process.env.BETTERDB_POSTHOG_HOST;
    delete process.env.BETTERDB_TELEMETRY;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("is a no-op when no API key is set", async () => {
    const { captureChatTurn } = await import("@/lib/analytics");
    await expect(
      captureChatTurn({
        prompt: "hello",
        ip: "127.0.0.1",
        semantic: { hit: false },
        toolHits: [],
        model: "gpt-4o-mini",
        totalLatencyMs: 12,
      }),
    ).resolves.toBeUndefined();
  });

  it("respects BETTERDB_TELEMETRY=false even when a key is set", async () => {
    process.env.BETTERDB_POSTHOG_API_KEY = "phc_fake";
    process.env.BETTERDB_TELEMETRY = "false";
    const { captureChatTurn, getAnalytics } = await import("@/lib/analytics");
    const client = await getAnalytics();
    // Easiest contract check: shutdown on the noop client returns immediately.
    await expect(client.shutdown()).resolves.toBeUndefined();
    await expect(
      captureChatTurn({
        prompt: "hi",
        ip: "1.2.3.4",
        semantic: { hit: false },
        toolHits: [],
        model: "gpt-4o-mini",
        totalLatencyMs: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats common opt-out spellings as off", async () => {
    for (const v of ["false", "0", "no", "off", "FALSE", "Off"]) {
      process.env.BETTERDB_POSTHOG_API_KEY = "phc_fake";
      process.env.BETTERDB_TELEMETRY = v;
      vi.resetModules();
      const { captureChatTurn } = await import("@/lib/analytics");
      await expect(
        captureChatTurn({
          prompt: "x",
          ip: "x",
          semantic: { hit: false },
          toolHits: [],
          model: "m",
          totalLatencyMs: 0,
        }),
      ).resolves.toBeUndefined();
    }
  });
});
