/**
 * Runtime env validation. Called once during server boot and from scripts so
 * misconfiguration fails fast and loud instead of producing opaque 500s on
 * the first user request.
 */

import { EMBED_MODEL_DIMS } from "./pricing";

export interface ValidatedEnv {
  openaiKey: string;
  llmModel: string;
  embedModel: string;
  embedDim: number;
  valkeyUrl: string;
}

let cached: ValidatedEnv | null = null;

export function validateEnv(): ValidatedEnv {
  if (cached) return cached;

  const errors: string[] = [];

  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!openaiKey) errors.push("OPENAI_API_KEY is required");
  else if (!openaiKey.startsWith("sk-")) {
    errors.push("OPENAI_API_KEY does not look like an OpenAI key (expected to start with 'sk-')");
  }

  const llmModel = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const embedModel = process.env.EMBED_MODEL ?? "text-embedding-3-small";
  const embedDim = Number(process.env.EMBED_DIM ?? 1536);
  const valkeyUrl = process.env.VALKEY_URL ?? "redis://localhost:6399";

  // Guard against the classic "switched embed model but forgot to update DIM"
  // mistake - produces a corrupt index that fails opaquely on first query.
  const expectedDim = EMBED_MODEL_DIMS[embedModel];
  if (expectedDim && expectedDim !== embedDim) {
    errors.push(
      `EMBED_DIM=${embedDim} doesn't match EMBED_MODEL=${embedModel} (expected ${expectedDim}). ` +
        `Update one of them, then re-run pnpm build:index.`,
    );
  }

  if (errors.length > 0) {
    throw new Error("Environment validation failed:\n  - " + errors.join("\n  - "));
  }

  cached = { openaiKey, llmModel, embedModel, embedDim, valkeyUrl };
  return cached;
}

/** For tests / scripts that mutate env between runs. */
export function resetValidatedEnvForTests(): void {
  cached = null;
}
