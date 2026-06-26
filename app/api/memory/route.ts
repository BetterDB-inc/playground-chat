import { readUserId } from "@/lib/session";
import { listMemories } from "@/lib/memory";
import { isMonitorConfigured } from "@/lib/monitor-client";

export const runtime = "nodejs";

/**
 * Lists what the assistant remembers about the current anonymous visitor.
 * Scoped by the `pg_uid` cookie → no cookie means nothing to show.
 * `forgetEnabled` tells the UI whether the governed-forget flow is available
 * (a Monitor must be wired up).
 */
export async function GET(req: Request) {
  const forgetEnabled = isMonitorConfigured();
  const userId = readUserId(req);
  if (userId === null) {
    return Response.json({ items: [], total: 0, forgetEnabled });
  }
  try {
    const result = await listMemories(userId);
    return Response.json(
      { ...result, forgetEnabled },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("memory list error:", e);
    return Response.json({ error: "Failed to list memories" }, { status: 500 });
  }
}
