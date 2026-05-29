import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "uv_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours

function expectedToken(): string {
  const password = process.env.ADMIN_PASSWORD ?? "";
  const secret = process.env.ADMIN_SESSION_SECRET ?? "ultraviris-admin";
  return crypto.createHmac("sha256", secret).update(password).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkPassword(input: string): boolean {
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    return false;
  }
  return safeEqual(input, password);
}

export async function isAuthed(): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) {
    return false;
  }
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) {
    return false;
  }
  return safeEqual(token, expectedToken());
}

export async function createSession(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}
