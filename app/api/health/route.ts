import { valkey } from "@/lib/valkey";

export const runtime = "nodejs";

export async function GET() {
  try {
    await valkey.ping();
    return Response.json({ valkey: "ok" });
  } catch {
    return Response.json({ valkey: "error" }, { status: 503 });
  }
}
