/**
 * Input validation for the chat route.
 *
 * Two layers, in order:
 *  1. Lightweight syntactic checks (length, emptiness, control chars).
 *     Cheap, runs synchronously, catches obvious garbage.
 *  2. OpenAI Moderation (free endpoint, ~50ms). Optional - controlled by
 *     `MODERATION_ENABLED` env var. When enabled, blocks responses flagged
 *     for hate/violence/self-harm/sexual content.
 *
 * We deliberately do NOT regex-match for "prompt injection" patterns - that
 * approach was a dead end (trivial to bypass with rephrasing or encoding) and
 * provides false confidence. The system prompt's scope guard plus the tools'
 * narrow scope is the actual injection defence; whatever the user types,
 * the model can only return information from the indexed Valkey/Redis docs.
 */

const MAX_QUERY_CHARS = 1000;

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function validateInputSync(input: unknown): GuardResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "Input must be a string." };
  }
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return { ok: false, reason: "Query is too short (minimum 2 characters)." };
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      reason: `Query is too long (maximum ${MAX_QUERY_CHARS} characters).`,
    };
  }
  // Reject ASCII control characters except tab/newline (common copy-paste
  // artefacts that confuse downstream tokenisers).
  if (/[\u0000-\u0008\u000b-\u001f]/.test(trimmed)) {
    return { ok: false, reason: "Query contains invalid control characters." };
  }
  return { ok: true };
}

/**
 * OpenAI Moderation check. Best-effort - if the moderation API is unreachable
 * or returns an error, we let the request through (fail-open) rather than
 * deny on infrastructure problems.
 */
export async function moderateInput(input: string): Promise<GuardResult> {
  if (process.env.MODERATION_ENABLED !== "true") return { ok: true };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: true };

  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: true };
    const json = (await res.json()) as {
      results?: { flagged?: boolean }[];
    };
    const flagged = json.results?.[0]?.flagged ?? false;
    if (flagged) {
      return {
        ok: false,
        reason: "Query was flagged by content moderation. Please rephrase.",
      };
    }
    return { ok: true };
  } catch {
    // Fail-open on infrastructure errors.
    return { ok: true };
  }
}
