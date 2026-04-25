import { valkey } from "./valkey";

const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1536);

interface DocResult {
  id: string;
  title: string;
  content: string;
  source: string;
  kind: string;
  url: string;
  score: number;
}

async function embed(text: string): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
      input: text,
    }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const json = (await res.json()) as { data: [{ embedding: number[] }] };
  const arr = json.data[0].embedding;
  const buf = Buffer.alloc(arr.length * 4);
  arr.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

export async function vectorSearch(
  query: string,
  source?: string,
  limit = 5
): Promise<DocResult[]> {
  const qVec = await embed(query);

  // Build FT.SEARCH query
  let filter = "*";
  if (source && (source === "valkey" || source === "redis")) {
    filter = `@source:{${source}}`;
  }

  const args = [
    "docs_idx",
    `(${filter})=>[KNN ${limit} @embedding $vec AS __score]`,
    "PARAMS", "2", "vec", qVec,
    "SORTBY", "__score",
    "RETURN", "6", "title", "content", "source", "kind", "url", "__score",
    "DIALECT", "2",
  ];

  type ValkeyWithCall = typeof valkey & {
    call: (...a: unknown[]) => Promise<unknown>;
  };
  const raw = await (valkey as ValkeyWithCall).call("FT.SEARCH", ...args) as unknown[];
  return parseSearchResults(raw);
}

export async function getCommandByName(
  name: string,
  source?: string
): Promise<DocResult | null> {
  const normalized = name.toUpperCase().replace(/\s+/g, "-");
  const srcFilter = source ? `@source:{${source}} ` : "";
  const query = `${srcFilter}@title:${normalized}`;

  type ValkeyWithCall = typeof valkey & {
    call: (...a: unknown[]) => Promise<unknown>;
  };
  const raw = await (valkey as ValkeyWithCall).call(
    "FT.SEARCH", "docs_idx", query,
    "LIMIT", "0", "1",
    "RETURN", "5", "title", "content", "source", "url", "kind"
  ) as unknown[];

  const results = parseSearchResults(raw);
  return results[0] ?? null;
}

export async function getModuleInfo(module: string): Promise<DocResult | null> {
  const moduleMap: Record<string, string> = {
    "valkey-search": "valkey-search",
    "valkey-bloom": "bloom filter",
    "valkey-json": "json module",
    "valkey-ldap": "ldap",
  };
  const term = moduleMap[module.toLowerCase()] ?? module;
  return vectorSearch(term, "valkey", 1).then((r) => r[0] ?? null);
}

function parseSearchResults(raw: unknown[]): DocResult[] {
  if (!Array.isArray(raw) || raw.length < 1) return [];
  // Format: [count, key1, [field, value, ...], key2, ...]
  const results: DocResult[] = [];
  for (let i = 1; i < raw.length; i += 2) {
    const key = raw[i] as string;
    const fields = raw[i + 1] as string[];
    if (!Array.isArray(fields)) continue;
    const map: Record<string, string> = {};
    for (let j = 0; j < fields.length; j += 2) {
      map[fields[j]] = fields[j + 1] ?? "";
    }
    const id = key.replace(/^doc:/, "");
    results.push({
      id,
      title: map["title"] ?? "",
      content: map["content"] ?? "",
      source: map["source"] ?? "",
      kind: map["kind"] ?? "",
      url: map["url"] ?? "",
      score: parseFloat(map["__score"] ?? "1"),
    });
  }
  return results;
}
