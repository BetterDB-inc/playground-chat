interface GuardResult {
  ok: boolean;
  reason?: string;
}

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:an?\s+)?(?:evil|uncensored|unfiltered|jailbroken)/i,
  /forget\s+(?:your\s+)?(?:previous\s+)?(?:instructions?|rules?|system\s+prompt)/i,
  /\[system\]/i,
  /<\|im_start\|>/i,
  /\[\[INST\]\]/i,
  /###\s*instruction/i,
];

export function validateInput(input: string): GuardResult {
  if (!input || typeof input !== "string") {
    return { ok: false, reason: "Input must be a non-empty string." };
  }

  const trimmed = input.trim();

  if (trimmed.length < 2) {
    return { ok: false, reason: "Query is too short (minimum 2 characters)." };
  }

  if (trimmed.length > 500) {
    return {
      ok: false,
      reason: "Query is too long (maximum 500 characters).",
    };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "Query contains disallowed content.",
      };
    }
  }

  return { ok: true };
}
