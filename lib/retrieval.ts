import { Retriever, type RetrieverClient } from "@betterdb/retrieval";
import { valkey } from "./valkey";
import { embedText } from "./embeddings";

/**
 * Documentation retrieval over @betterdb/retrieval's `Retriever`, replacing the
 * hand-rolled FT.SEARCH in lib/rag.ts. One index over the Valkey/Redis/Dragonfly/
 * BetterDB docs corpus; the doc body is the embedded `text`, with title/source/
 * kind/url as filterable fields. The store registers a discovery marker so it
 * shows up in the Monitor next to the caches and memory.
 */
export const DOCS_INDEX = process.env.DOCS_INDEX ?? "betterdb_docs";

export const retriever = new Retriever({
  client: valkey as unknown as RetrieverClient,
  name: DOCS_INDEX,
  embedFn: embedText,
  schema: {
    fields: {
      title: { type: "text" },
      source: { type: "tag" },
      kind: { type: "tag" },
      url: { type: "tag" },
    },
    vector: { algorithm: "hnsw", metric: "cosine" },
  },
});
