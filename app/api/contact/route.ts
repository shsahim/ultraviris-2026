import { NextResponse } from "next/server";
import { sendContactEmail } from "@/lib/email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!EMAIL_RE.test(email)) {
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
