import { NextResponse } from "next/server";
import { sendContactEmail } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 maximum
const MAX_MESSAGE_LENGTH = 5000;

// Cap submissions per IP to curb spam and runaway SES cost.
const RATE_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 }; // 5 / 10 min

export async function POST(request: Request) {
  const ip = clientIp(request.headers);
  const limit = rateLimit(`contact:${ip}`, RATE_LIMIT);
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many messages. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    // Hidden honeypot field: real users never fill it, bots usually do.
    const honeypot =
      typeof body.company === "string" ? body.company.trim() : "";

    // Silently accept (pretend success) so bots don't learn they were caught.
    if (honeypot) {
      return NextResponse.json({ ok: true });
    }

    if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) {
      return NextResponse.json(
        { ok: false, error: "A valid email is required." },
        { status: 400 }
      );
    }
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Message cannot be empty." },
        { status: 400 }
      );
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        {
          ok: false,
          error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`,
        },
        { status: 400 }
      );
    }

    await sendContactEmail({ fromEmail: email, message });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to send contact email:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to send message. Please try again later." },
      { status: 500 }
    );
  }
}
