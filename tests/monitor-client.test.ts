import { describe, it, expect, afterEach } from "vitest";
import { isMonitorConfigured } from "../lib/monitor-client";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("isMonitorConfigured", () => {
  it("is true only when URL + token + instance are all set", () => {
    delete process.env.BETTERDB_URL;
    delete process.env.BETTERDB_TOKEN;
    delete process.env.BETTERDB_INSTANCE_ID;
    expect(isMonitorConfigured()).toBe(false);

    process.env.BETTERDB_URL = "https://m";
    process.env.BETTERDB_TOKEN = "tok";
    expect(isMonitorConfigured()).toBe(false);

    process.env.BETTERDB_INSTANCE_ID = "inst-1";
    expect(isMonitorConfigured()).toBe(true);
  });
});
