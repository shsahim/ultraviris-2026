import { timingSafeEqual } from "node:crypto";
import { runHealthCheckAndAlert } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(req: Request): Promise<Response> {
  const expected = process.env.HEALTH_CHECK_SECRET;
  if (!expected) {
    return Response.json(
      { error: "HEALTH_CHECK_SECRET is not configured." },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const queryToken = new URL(req.url).searchParams.get("token");
  const provided = bearer ?? queryToken;

  if (!tokenMatches(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runHealthCheckAndAlert();
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Health check failed.",
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
