import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Lightweight liveness probe for an external uptime monitor (e.g. UptimeRobot,
// Pingdom, an ALB health check). Returns 200 when the app can reach the
// database, 503 otherwise. Intentionally returns no sensitive details.
export async function GET(): Promise<Response> {
  try {
    await query("SELECT 1");
    return Response.json({ status: "ok" }, { status: 200 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
