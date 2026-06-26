import { retriever } from "@/lib/retrieval";
import { memoryStore } from "@/lib/memory";
import { readContextCounters } from "@/lib/stats";

export const runtime = "nodejs";

/**
 * Context-layer stats for the metrics panel: retrieval index health + query
 * activity, and the memory store gauge + recall activity. The index/store
 * gauges degrade to null if their index doesn't exist yet (before the first
 * ingest / first memory); the activity counters are always available.
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

  const counters = await readContextCounters().catch(() => null);

  return Response.json(
    { retrieval, memory, counters },
    { headers: { "Cache-Control": "no-store" } },
  );
}
