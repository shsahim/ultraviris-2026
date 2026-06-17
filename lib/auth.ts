import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import {
  findUser,
  hasAnyAdmin,
  verifyCredentials,
  type AdminUser,
} from "@/lib/admin-users";

const COOKIE_NAME = "uv_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours

// The session cookie is a stateless, signed token bound to the user's current
// password hash. Changing a user's password (or deleting them) therefore
// invalidates their existing sessions without needing a server-side store.
function tokenFor(username: string, passwordHash: string): string {
  const secret = process.env.ADMIN_SESSION_SECRET ?? "ultraviris-admin";
  return crypto
    .createHmac("sha256", secret)
    .update(`${username}:${passwordHash}`)
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

async function setSessionCookie(user: AdminUser): Promise<void> {
  const value = `${user.username}|${tokenFor(user.username, user.password_hash)}`;
  const store = await cookies();
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

// Verifies username + password and starts a session. Returns false on failure.
export async function login(
  username: string,
  password: string
): Promise<boolean> {
  const user = await verifyCredentials(username, password);
  if (!user) {
    return false;
  }
  await setSessionCookie(user);
  return true;
}

// Returns the signed-in username, or null. Re-derives the token from the user's
// current password hash so stale sessions (after a password change) are rejected.
export async function getSessionUsername(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) {
    return null;
  }
  const sep = raw.lastIndexOf("|");
  if (sep < 0) {
    return null;
  }
  const username = raw.slice(0, sep);
  const token = raw.slice(sep + 1);
  let user: AdminUser | null;
  try {
    user = await findUser(username);
  } catch {
    // DB unreachable — treat as unauthenticated rather than crashing the page.
    return null;
  }
  if (!user) {
    return null;
  }
  return safeEqual(token, tokenFor(user.username, user.password_hash))
    ? user.username
    : null;
}

export async function isAuthed(): Promise<boolean> {
  return (await getSessionUsername()) !== null;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

// True when at least one admin account exists (or can be seeded from env).
export async function isAdminConfigured(): Promise<boolean> {
  return hasAnyAdmin();
}
