import { describe, it, expect } from "vitest";
import { scrubSecrets, looksLikeSecret } from "@/lib/secrets";

describe("scrubSecrets", () => {
  it("redacts OpenAI sk- keys", () => {
    const input = "my key is sk-proj-OzGRApaFvIaiv8Tt6qlDBexYjoQLrAOuzcgKlFO4dYQc";
    const out = scrubSecrets(input);
    expect(out).not.toContain("OzGRApaFvIaiv8Tt6qlDBexYjoQLrAOuzcgKlFO4dYQc");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts AWS access key ids", () => {
    expect(scrubSecrets("token AKIAIOSFODNN7EXAMPLE here")).toBe("token [REDACTED] here");
    expect(scrubSecrets("creds ASIAIOSFODNN7EXAMPLE end")).toBe("creds [REDACTED] end");
  });

  it("redacts GitHub PATs", () => {
    expect(scrubSecrets("token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa right")).toContain(
      "[REDACTED]",
    );
  });

  it("redacts JWT-shaped tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrubSecrets(`bearer ${jwt}`)).toContain("[REDACTED]");
  });

  it("leaves normal questions alone", () => {
    const q = "How do I use FT.SEARCH with KNN in valkey-search?";
    expect(scrubSecrets(q)).toBe(q);
  });

  it("looksLikeSecret detects shaped credentials", () => {
    expect(looksLikeSecret("hello world")).toBe(false);
    expect(looksLikeSecret("api_key=abcdef1234567890abcd")).toBe(true);
  });
});
