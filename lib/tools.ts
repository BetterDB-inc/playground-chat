import { tool } from "ai";
import { z } from "zod";
import { agentCache } from "./cache";
import {
  vectorSearch,
  getCommandByName,
  getModuleInfo,
  type DocResult,
  type DocSource,
} from "./rag";
import { estimateEmbedCost, approximateTokens } from "./pricing";
import type { ToolMeta } from "./types";

/**
 * Wrapper around `agentCache.tool` that:
 *   1. Normalises the cache key (lowercase, trim, collapse whitespace) so
 *      paraphrased queries hit the cache more often.
 *   2. Estimates the dollar cost of the underlying call (embedding + tokens
 *      consumed by the response) and stores it on miss, so the cache can
 *      report `costSavedMicros` accurately on future hits.
 *   3. Returns a `_meta` payload the chat route uses to render per-turn
 *      cache metrics.
 */

interface CachedOpts {
  /** Estimated USD cost the wrapped function would incur on a miss. */
  costEstimateUsd?: number;
}

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      out[k] = v.trim().toLowerCase().replace(/\s+/g, " ");
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function cached<T>(
  name: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  opts: CachedOpts = {},
): Promise<{ result: T; _meta: ToolMeta }> {
  const start = Date.now();
  const key = normalizeArgs(args);
  const hit = await agentCache.tool.check(name, key);
  if (hit.hit && hit.response !== undefined) {
    return {
      result: JSON.parse(hit.response) as T,
      _meta: { name, hit: true, latencyMs: Date.now() - start },
    };
  }
  const result = await fn();
  await agentCache.tool.store(name, key, JSON.stringify(result), {
    cost: opts.costEstimateUsd,
  });
  return {
    result,
    _meta: { name, hit: false, latencyMs: Date.now() - start },
  };
}

const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

/**
 * Estimate the dollar cost of a vectorSearch call (embedding the query string)
 * so a cache hit can report it as `costSaved`.
 */
function vectorSearchCost(query: string): number {
  return estimateEmbedCost(EMBED_MODEL, approximateTokens(query));
}

export const tools = {
  search_docs: tool({
    description:
      "Search the Valkey and Redis documentation using semantic similarity. " +
      "Use this for any question about commands, configuration, concepts, or features.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      source: z
        .enum(["valkey", "redis", "both"])
        .optional()
        .describe("Limit search to a specific source. Default: both"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of results to return. Default: 5"),
    }),
    execute: async ({ query, source, limit = 5 }) => {
      return cached(
        "search_docs",
        { query, source, limit },
        async () => {
          const src: DocSource | undefined =
            source === "valkey" || source === "redis" ? source : undefined;
          const results = await vectorSearch(query, src, limit);
          return results.map(projectDoc);
        },
        { costEstimateUsd: vectorSearchCost(query) },
      );
    },
  }),

  get_command_reference: tool({
    description: "Look up the full reference for a specific Valkey or Redis command by name.",
    inputSchema: z.object({
      command: z.string().describe("Command name, e.g. XADD, FT.SEARCH, HSET"),
      source: z
        .enum(["valkey", "redis"])
        .optional()
        .describe("Which documentation to look in. Default: valkey"),
    }),
    execute: async ({ command, source = "valkey" }) => {
      return cached(
        "get_command_reference",
        { command: command.toUpperCase(), source },
        async () => {
          const doc = await getCommandByName(command, source);
          if (!doc) {
            return {
              found: false,
              command: command.toUpperCase(),
              message: "Command not found in the indexed documentation.",
            };
          }
          return {
            found: true,
            command: doc.title,
            content: doc.content,
            source: doc.source,
            url: doc.url,
          };
        },
        // No embedding involved - only an FT.SEARCH text query.
        { costEstimateUsd: 0 },
      );
    },
  }),

  compare_commands: tool({
    description:
      "Compare how the same command (or two related commands) behaves in Valkey vs Redis OSS.",
    inputSchema: z.object({
      command_a: z.string().describe("First command name"),
      command_b: z
        .string()
        .optional()
        .describe("Second command name. If omitted, compares command_a across Valkey and Redis."),
      source: z
        .enum(["valkey", "redis", "both"])
        .optional()
        .describe("Which sources to pull docs from. Default: both"),
    }),
    execute: async ({ command_a, command_b, source = "both" }) => {
      return cached(
        "compare_commands",
        {
          command_a: command_a.toUpperCase(),
          command_b: command_b?.toUpperCase(),
          source,
        },
        async () => {
          // Source-pair logic:
          //   "both"   → command_a from valkey, command_b from redis (cross-source compare)
          //   "valkey" → both halves from valkey (intra-source compare of two commands)
          //   "redis"  → both halves from redis
          const [srcA, srcB]: [DocSource, DocSource] =
            source === "both" ? ["valkey", "redis"] : [source, source];
          const [docA, docB] = await Promise.all([
            getCommandByName(command_a, srcA),
            getCommandByName(command_b ?? command_a, srcB),
          ]);
          return {
            command_a: makeComparePart(command_a, srcA, docA),
            command_b: makeComparePart(command_b ?? command_a, srcB, docB),
          };
        },
        { costEstimateUsd: 0 },
      );
    },
  }),

  get_module_info: tool({
    description:
      "Get information about a Valkey module: valkey-search, valkey-bloom, valkey-json, or valkey-ldap.",
    inputSchema: z.object({
      // We use `module_name` rather than `module` because the latter shadows
      // the JS-reserved identifier when destructured in `execute` below,
      // which trips up the AI SDK's tool() generic inference.
      module_name: z
        .enum(["valkey-search", "valkey-bloom", "valkey-json", "valkey-ldap"])
        .describe("The Valkey module to look up"),
    }),
    execute: async ({ module_name }) => {
      return cached(
        "get_module_info",
        { module_name },
        async () => {
          const doc = await getModuleInfo(module_name);
          if (!doc) {
            return {
              found: false,
              module: module_name,
              message: "Module info not found in the indexed documentation.",
            };
          }
          return {
            found: true,
            module: module_name,
            title: doc.title,
            content: doc.content,
            url: doc.url,
          };
        },
        { costEstimateUsd: vectorSearchCost(module_name) },
      );
    },
  }),
};

function projectDoc(r: DocResult) {
  return {
    title: r.title,
    content: r.content,
    source: r.source,
    url: r.url,
    relevanceScore: r.score,
  };
}

function makeComparePart(name: string, src: DocSource, doc: DocResult | null) {
  return {
    name: name.toUpperCase(),
    source: src,
    found: !!doc,
    content: doc?.content ?? null,
    url: doc?.url ?? null,
  };
}
