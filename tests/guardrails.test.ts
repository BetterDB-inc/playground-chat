import { describe, it, expect } from "vitest";
import { validateInputSync } from "@/lib/guardrails";

describe("validateInputSync", () => {
  it("rejects non-string input", () => {
    expect(validateInputSync(undefined).ok).toBe(false);
    expect(validateInputSync(123).ok).toBe(false);
    expect(validateInputSync({}).ok).toBe(false);
  });

  it("rejects too-short queries", () => {
    expect(validateInputSync("a").ok).toBe(false);
  });

  it("rejects too-long queries", () => {
    expect(validateInputSync("x".repeat(1001)).ok).toBe(false);
  });

  it("rejects ASCII control characters", () => {
    expect(validateInputSync("hello\u0007world").ok).toBe(false);
  });

  it("accepts normal questions", () => {
    expect(validateInputSync("What is FT.SEARCH?").ok).toBe(true);
  });

  it("accepts queries containing tabs and newlines", () => {
    expect(validateInputSync("line one\nline two\twith tab").ok).toBe(true);
  });
});
