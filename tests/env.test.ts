import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv, resetValidatedEnvForTests } from "@/lib/env";

const originalEnv = process.env;

describe("validateEnv", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetValidatedEnvForTests();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetValidatedEnvForTests();
  });

  it("rejects when OPENAI_API_KEY is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => validateEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("rejects when OPENAI_API_KEY doesn't look like a key", () => {
    process.env.OPENAI_API_KEY = "totally-not-an-openai-key";
    expect(() => validateEnv()).toThrow(/sk-/);
  });

  it("rejects on EMBED_DIM mismatch with model", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBED_MODEL = "text-embedding-3-small";
    process.env.EMBED_DIM = "999";
    expect(() => validateEnv()).toThrow(/EMBED_DIM/);
  });

  it("accepts a matching dim/model pair", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.EMBED_MODEL = "text-embedding-3-large";
    process.env.EMBED_DIM = "3072";
    const env = validateEnv();
    expect(env.embedDim).toBe(3072);
  });
});
