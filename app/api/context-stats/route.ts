import { retriever } from "@/lib/retrieval";
import { memoryStore } from "@/lib/memory";

export const runtime = "nodejs";

/**
 * Context-layer stats for the metrics panel: retrieval index health and the
 * memory store gauge. Each source is independent and degrades to null if its
 * index doesn't exist yet (e.g. before the first ingest / first memory).
 */
export async function GET() {
  let retrieval: { numDocs: number; percentIndexed: number; indexingState: string } | null = null;
  try {
    const h = await retriever.health();
    retrieval = {
      numDocs: h.numDocs,
      percentIndexed: h.percentIndexed,
      indexingState: h.indexingState,
    };
  } catch {
    // index not created yet
  }

  let memory: { stored: number; evictions: number } | null = null;
  try {
    const s = await memoryStore.stats();
    memory = { stored: s.itemCount, evictions: s.evictions };
  } catch {
    // memory index not created yet
  }

  return Response.json({ retrieval, memory }, { headers: { "Cache-Control": "no-store" } });
}
