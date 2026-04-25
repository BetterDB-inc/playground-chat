/**
 * Best-effort secret scrubbing applied before user prompts are written to
 * the semantic cache or the request log stream.
 *
 * This is NOT a security boundary - users can paste anything. The goal is to
 * reduce the chance that an obviously-shaped credential (an API key, a JWT,
 * an AWS access key) ends up persisted in our cache or logs where another
 * operator might see it.
 *
 * We replace matches with a fixed token rather than dropping characters so
 * the message remains readable as a question.
 */

const REDACTED = "[REDACTED]";

interface Pattern {
  name: string;
  regex: RegExp;
}

// Keep patterns conservative - we'd rather miss a few than corrupt a normal
// question. Each pattern is anchored with surrounding context where possible.
const PATTERNS: Pattern[] = [
  // OpenAI-style keys: sk-..., sk-proj-..., sk-ant-...
  { name: "openai", regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  // Generic API-key-ish: 32+ char base64/hex tokens preceded by an obvious label
  {
    name: "labeled",
    regex:
      /\b(?:api[_-]?key|secret|token|password|bearer)\s*[:=]\s*['"]?[A-Za-z0-9._-]{16,}['"]?/gi,
  },
  // AWS access key id
  { name: "aws_akid", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub PAT (classic + fine-grained)
  { name: "github", regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: "github_fine", regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // Generic JWT (three base64url segments)
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // Slack tokens
  { name: "slack", regex: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live keys
  { name: "stripe", regex: /\b(?:sk|pk)_live_[A-Za-z0-9]{24,}\b/g },
];

export function scrubSecrets(input: string): string {
  let out = input;
  for (const { regex } of PATTERNS) {
    out = out.replace(regex, REDACTED);
  }
  return out;
}

/**
 * Returns true if the input looks like it contained at least one secret-shaped
 * token. Useful for telemetry / alerting (e.g. "X% of prompts contained
 * what looked like a credential").
 */
export function looksLikeSecret(input: string): boolean {
  return PATTERNS.some((p) => p.regex.test(input));
}
