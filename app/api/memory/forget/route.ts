import { readUserId } from "@/lib/session";
import { MEMORY_NAME } from "@/lib/memory";
import { monitorPost, requireInstanceId, isMonitorConfigured } from "@/lib/monitor-client";

export const runtime = "nodejs";

/**
 * Governed forget: does NOT delete directly. Creates a memory-forget *proposal*
 * in the Monitor (Phase 13c), which an operator approves before anything is
 * removed — the human-in-the-loop governance story. Degrades cleanly (503) when
 * no Monitor is configured so the UI can show a disabled button.
 */
export async function POST(req: Request) {
  const userId = readUserId(req);
  if (userId === null) {
    return Response.json({ error: "No session" }, { status: 400 });
  }
  if (!isMonitorConfigured()) {
    return Response.json(
      {
        error: "monitor_unavailable",
        message: "Governed forget requires a connected BetterDB Monitor.",
      },
      { status: 503 },
    );
  }

  let body: { id?: unknown };
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (id === "") {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const result = await monitorPost(
      `/mcp/instance/${requireInstanceId()}/memory-proposals/forget`,
      {
        memory_name: MEMORY_NAME,
        id,
        reasoning: "Visitor requested removal of this memory from the playground chat Memory panel.",
      },
    );
    return Response.json(result);
  } catch (e) {
    console.error("memory forget proposal failed:", e);
    return Response.json(
      { error: "forget_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 502 },
    );
  }
}
