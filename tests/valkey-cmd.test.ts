import { describe, it, expect } from "vitest";
import { escapeSearchValue, escapeTagValue } from "@/lib/valkey-cmd";

describe("escapeSearchValue", () => {
  it("escapes RediSearch reserved punctuation", () => {
    expect(escapeSearchValue("FT.SEARCH")).toBe("FT\\.SEARCH");
    expect(escapeSearchValue("a:b@c")).toBe("a\\:b\\@c");
  });

  it("escapes whitespace", () => {
    expect(escapeSearchValue("hello world")).toBe("hello\\ world");
  });

  it("leaves plain alphanumerics alone", () => {
    expect(escapeSearchValue("ABCxyz123")).toBe("ABCxyz123");
  });
});

describe("escapeTagValue", () => {
  it("escapes braces, comma, backslash", () => {
    expect(escapeTagValue("a,b")).toBe("a\\,b");
    expect(escapeTagValue("{x}")).toBe("\\{x\\}");
    expect(escapeTagValue("a\\b")).toBe("a\\\\b");
  });

  it("leaves typical tag values alone", () => {
    expect(escapeTagValue("valkey")).toBe("valkey");
  });
});
