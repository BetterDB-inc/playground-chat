import { readStats } from "@/lib/stats";

export const runtime = "nodejs";

export async function GET() {
  try {
    const stats = await readStats();
    return Response.json(stats, {
      headers: {
        "Cache-Control": "s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (e) {
    console.error("Stats error:", e);
    return Response.json({ error: "Failed to read stats" }, { status: 500 });
  }
}
