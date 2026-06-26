import { generateText, type LanguageModel } from "ai";

/**
 * Pulls DURABLE facts about the *user* out of a chat turn so they can be
 * remembered across sessions. Conservative by design: stable preferences /
 * identity / goals only — never transient questions or documentation facts —
 * so the demo's memory stays signal, not noise.
 */
export interface ExtractedFact {
  content: string;
  importance: number;
  tags: string[];
}

const EXTRACT_SYSTEM = [
  "You extract DURABLE facts about the USER from a single chat turn — stable",
  "preferences, identity, goals, or working context worth remembering across",
  'sessions (e.g. "uses Python", "building a trading system", "prefers concise',
  'answers"). Do NOT extract: transient questions, one-off requests, or any',
  "documentation fact about Valkey / Redis / Dragonfly / BetterDB themselves.",
  "If nothing durable is present, return an empty array.",
  "",
  'Return ONLY a JSON array. Each item: {"content": string, "importance":',
  'number 0..1, "tags": string[]}. Keep content short and self-contained.',
].join(" ");

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Parse the model's reply into validated facts. Tolerant of fences/prose. */
export function parseFacts(raw: string): ExtractedFact[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (match === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (x): x is { content: string; importance?: unknown; tags?: unknown } =>
        x != null && typeof (x as { content?: unknown }).content === "string",
    )
    .map((x) => ({
      content: x.content.trim().slice(0, 280),
      importance: clamp01(typeof x.importance === "number" ? x.importance : 0.5),
      tags: Array.isArray(x.tags)
        ? (x.tags.filter((t) => typeof t === "string") as string[]).slice(0, 5)
        : [],
    }))
    .filter((f) => f.content.length > 0)
    .slice(0, 5);
}

/** Run the extraction LLM over a turn and return durable facts (empty on error). */
export async function extractFacts(
  model: LanguageModel,
  userText: string,
  assistantText: string,
): Promise<ExtractedFact[]> {
  const { text } = await generateText({
    model,
    system: EXTRACT_SYSTEM,
    prompt: `User said:\n${userText}\n\nAssistant replied:\n${assistantText.slice(0, 500)}\n\nExtract durable facts about the user as a JSON array.`,
  });
  return parseFacts(text);
}
