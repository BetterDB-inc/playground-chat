import { valkey } from "@/lib/valkey";
import { retriever } from "@/lib/retrieval";

export const runtime = "nodejs";

/**
 * Liveness + readiness probe for the playground.
 *
 * Reports each precondition individually so a failing dependency surfaces
 * a meaningful diagnosis rather than an opaque 503:
 *   - valkey:    can we reach Valkey?
 *   - openaiKey: is OPENAI_API_KEY configured (presence-only - does not
 *                make a network call)?
 *   - index:     does the docs retrieval index exist? Probed through the
 *                Retriever so it always targets the real index name
 *                (`${DOCS_INDEX}:idx`), not a hard-coded one.
 */
export async function GET() {
  const result = {
    valkey: "unknown" as "ok" | "error" | "unknown",
    openaiKey: process.env.OPENAI_API_KEY ? "ok" : "missing",
    index: "unknown" as "ok" | "missing" | "error" | "unknown",
  };

  try {
    await valkey.ping();
    result.valkey = "ok";
  } catch {
    result.valkey = "error";
  }

  try {
    await retriever.health();
    result.index = "ok";
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const missing =
      msg.includes("not found") || msg.includes("unknown index") || msg.includes("no such index");
    result.index = missing ? "missing" : "error";
  }

  const ok = result.valkey === "ok" && result.openaiKey === "ok" && result.index === "ok";

  return Response.json(result, { status: ok ? 200 : 503 });
}
