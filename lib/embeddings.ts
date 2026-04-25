/**
 * Single embedding helper used by the API route, the RAG layer, and all
 * scripts. Centralising avoids drift in error handling, timeout, and
 * model selection.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface EmbedOptions {
  model?: string;
  timeoutMs?: number;
  apiKey?: string;
}

/**
 * Embed a single string. Returns the raw float vector.
 */
export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const result = await embedBatch([text], opts);
  if (!result[0]) {
    throw new Error("OpenAI embed returned no vector");
  }
  return result[0];
}

/**
 * Embed multiple strings in one OpenAI call. Order of returned vectors
 * matches input order regardless of the API's `index` field.
 */
export async function embedBatch(inputs: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings");
  }
  const model = opts.model ?? process.env.EMBED_MODEL ?? "text-embedding-3-small";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI embed failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Float32 little-endian buffer suitable for valkey-search VECTOR fields.
 */
export function floatArrayToBuffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i] ?? 0, i * 4);
  return buf;
}

/**
 * Convenience wrapper that returns the buffer directly. Used by the RAG
 * layer when querying.
 */
export async function embedToBuffer(text: string, opts: EmbedOptions = {}): Promise<Buffer> {
  const vec = await embedText(text, opts);
  return floatArrayToBuffer(vec);
}
