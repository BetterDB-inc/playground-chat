import { valkey } from "@/lib/valkey";
import { cmd } from "@/lib/valkey-cmd";

export const runtime = "nodejs";

/**
 * Liveness + readiness probe for the playground.
 *
 * Reports each precondition individually so a failing dependency surfaces
 * a meaningful diagnosis rather than an opaque 503:
 *   - valkey:    can we reach Valkey?
 *   - openaiKey: is OPENAI_API_KEY configured (presence-only - does not
 *                make a network call)?
 *   - index:     does the docs_idx vector index exist?
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
    await cmd(valkey, "FT.INFO", "docs_idx");
    result.index = "ok";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.index = msg.includes("not found") ? "missing" : "error";
  }

  const ok = result.valkey === "ok" && result.openaiKey === "ok" && result.index === "ok";

  return Response.json(result, { status: ok ? 200 : 503 });
}
