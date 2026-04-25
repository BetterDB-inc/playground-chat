import { tool } from "ai";
import { z } from "zod";
import { agentCache } from "./cache";
import { vectorSearch, getCommandByName, getModuleInfo } from "./rag";
import type { ToolMeta } from "./types";

// Wrapper: checks agent-cache tool tier, calls fn on miss, stores result
async function cached<T>(
  name: string,
  args: object,
  fn: () => Promise<T>
): Promise<{ result: T; _meta: ToolMeta }> {
  const start = Date.now();
  const hit = await agentCache.tool.check(name, args);
  if (hit.hit && hit.response !== undefined) {
    return {
      result: JSON.parse(hit.response) as T,
      _meta: { name, hit: true, latencyMs: Date.now() - start },
    };
  }
  const result = await fn();
  await agentCache.tool.store(name, args, JSON.stringify(result));
  return {
    result,
    _meta: { name, hit: false, latencyMs: Date.now() - start },
  };
}

export const tools = {
  search_docs: tool({
    description:
      "Search the Valkey and Redis documentation using semantic similarity. " +
      "Use this for any question about commands, configuration, concepts, or features.",
    parameters: z.object({
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
      return cached("search_docs", { query, source, limit }, async () => {
        const src = source === "both" ? undefined : source;
        const results = await vectorSearch(query, src, limit);
        return results.map((r) => ({
          title: r.title,
          content: r.content,
          source: r.source,
          url: r.url,
          relevanceScore: r.score,
        }));
      });
    },
  }),

  get_command_reference: tool({
    description:
      "Look up the full reference for a specific Valkey or Redis command by name.",
    parameters: z.object({
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
          if (!doc)
            return {
              found: false,
              command: command.toUpperCase(),
              message: "Command not found in the indexed documentation.",
            };
          return {
            found: true,
            command: doc.title,
            content: doc.content,
            source: doc.source,
            url: doc.url,
          };
        }
      );
    },
  }),

  compare_commands: tool({
    description:
      "Compare how the same command (or two related commands) behaves in Valkey vs Redis OSS.",
    parameters: z.object({
      command_a: z.string().describe("First command name"),
      command_b: z
        .string()
        .optional()
        .describe(
          "Second command name. If omitted, compares command_a across Valkey and Redis."
        ),
      source: z
        .enum(["valkey", "redis", "both"])
        .optional()
        .default("both")
        .describe("Which sources to pull docs from"),
    }),
    execute: async ({ command_a, command_b, source = "both" }) => {
      return cached(
        "compare_commands",
        { command_a: command_a.toUpperCase(), command_b: command_b?.toUpperCase(), source },
        async () => {
          const srcA = source === "redis" ? "redis" : "valkey";
          const srcB = source === "valkey" ? "valkey" : "redis";
          const [docA, docB] = await Promise.all([
            getCommandByName(command_a, srcA),
            getCommandByName(command_b ?? command_a, srcB),
          ]);
          return {
            command_a: {
              name: command_a.toUpperCase(),
              source: srcA,
              found: !!docA,
              content: docA?.content ?? null,
              url: docA?.url ?? null,
            },
            command_b: {
              name: (command_b ?? command_a).toUpperCase(),
              source: srcB,
              found: !!docB,
              content: docB?.content ?? null,
              url: docB?.url ?? null,
            },
          };
        }
      );
    },
  }),

  get_module_info: tool({
    description:
      "Get information about a Valkey module: valkey-search, valkey-bloom, valkey-json, or valkey-ldap.",
    parameters: z.object({
      module: z
        .enum(["valkey-search", "valkey-bloom", "valkey-json", "valkey-ldap"])
        .describe("The Valkey module to look up"),
    }),
    execute: async ({ module }) => {
      return cached("get_module_info", { module }, async () => {
        const doc = await getModuleInfo(module);
        if (!doc)
          return {
            found: false,
            module,
            message: "Module info not found in the indexed documentation.",
          };
        return {
          found: true,
          module,
          title: doc.title,
          content: doc.content,
          url: doc.url,
        };
      });
    },
  }),
};
