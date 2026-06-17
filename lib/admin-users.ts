import "server-only";
import crypto from "node:crypto";
import { query } from "@/lib/db";

// Password hashing uses Node's built-in scrypt (a memory-hard KDF) so we don't
// pull in a native module — important for the standalone container build. The
// stored format is self-describing so the cost can be tuned later without
// invalidating existing hashes: "scrypt$N$r$p$<saltB64>$<hashB64>".
const KDF = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,190}$/;
const MIN_PASSWORD_LENGTH = 8;

export interface AdminUser {
  id: number;
  username: string;
  password_hash: string;
}

export interface AdminUserSummary {
  id: number;
  username: string;
  created_at: string;
  updated_at: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = (await scrypt(password, salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  })) as Buffer;
  return [
    "scrypt",
    KDF.N,
    KDF.r,
    KDF.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (![N, r, p].every(Number.isFinite) || expected.length === 0) return false;
  const actual = (await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: KDF.maxmem,
  })) as Buffer;
  return (
    actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  );
}

// One-time-per-process bootstrap: create the table and, if it's empty, seed an
// initial admin from ADMIN_PASSWORD (username = ADMIN_USERNAME, default "admin")
// so an existing single-password setup keeps working after this upgrade.
let readyPromise: Promise<void> | undefined;

async function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS admin_users (
           id INT AUTO_INCREMENT PRIMARY KEY,
           username VARCHAR(190) NOT NULL UNIQUE,
           password_hash VARCHAR(255) NOT NULL,
           created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );

      const seedPassword = process.env.ADMIN_PASSWORD;
      if (seedPassword) {
        const rows = await query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM admin_users"
        );
        if (Number(rows[0]?.n ?? 0) === 0) {
          const seedUser =
            (process.env.ADMIN_USERNAME ?? "admin").trim() || "admin";
          // Don't enforce the new min-length on the legacy seed password.
          await insertUser(seedUser, seedPassword, { validatePassword: false });
        }
      }
    })().catch((err) => {
      // Don't cache a failed bootstrap so the next call can retry.
      readyPromise = undefined;
      throw err;
    });
  }
  return readyPromise;
}

function assertValidUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error(
      "Username must be 3-190 characters: letters, numbers, and . _ - only."
    );
  }
}

function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  }
}

// Low-level insert (no bootstrap) so it can be called from ensureReady itself.
async function insertUser(
  username: string,
  password: string,
  options: { validatePassword?: boolean } = {}
): Promise<void> {
  const clean = username.trim();
  assertValidUsername(clean);
  if (options.validatePassword !== false) {
    assertValidPassword(password);
  }
  const hash = await hashPassword(password);
  await query(
    "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)",
    [clean, hash]
  );
}

export async function findUser(username: string): Promise<AdminUser | null> {
  await ensureReady();
  const rows = await query<AdminUser>(
    "SELECT id, username, password_hash FROM admin_users WHERE username = ? LIMIT 1",
    [username]
  );
  return rows[0] ?? null;
}

// A throwaway hash used to keep failed-login timing similar to success, so an
// attacker can't distinguish "no such user" from "wrong password" by latency.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  Buffer.alloc(64).toString("base64");

export async function verifyCredentials(
  username: string,
  password: string
): Promise<AdminUser | null> {
  const user = await findUser(username.trim());
  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? user : null;
}

export async function countUsers(): Promise<number> {
  await ensureReady();
  const rows = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM admin_users"
  );
  return Number(rows[0]?.n ?? 0);
}

// True when at least one admin can sign in. Falls back to whether a seed
// password is configured if the DB is unreachable, so the login page can still
// explain the state instead of erroring.
export async function hasAnyAdmin(): Promise<boolean> {
  try {
    return (await countUsers()) > 0;
  } catch {
    return Boolean(process.env.ADMIN_PASSWORD);
  }
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  await ensureReady();
  return query<AdminUserSummary>(
    "SELECT id, username, created_at, updated_at FROM admin_users ORDER BY username"
  );
}

export async function createUser(
  username: string,
  password: string
): Promise<void> {
  await ensureReady();
  const clean = username.trim();
  assertValidUsername(clean);
  const existing = await findUser(clean);
  if (existing) {
    throw new Error(`A user named "${clean}" already exists.`);
  }
  await insertUser(clean, password);
}

export async function changePassword(
  username: string,
  newPassword: string
): Promise<void> {
  await ensureReady();
  const clean = username.trim();
  assertValidPassword(newPassword);
  const hash = await hashPassword(newPassword);
  const result = await query<unknown>(
    "UPDATE admin_users SET password_hash = ? WHERE username = ?",
    [hash, clean]
  );
  // mysql2 returns an OkPacket (not an array) for UPDATE; guard for "not found".
  const affected = (result as unknown as { affectedRows?: number })
    .affectedRows;
  if (affected === 0) {
    throw new Error(`No user named "${clean}".`);
  }
}

export async function deleteUser(username: string): Promise<void> {
  await ensureReady();
  const clean = username.trim();
  if ((await countUsers()) <= 1) {
    throw new Error("Can't delete the last admin user.");
  }
  await query("DELETE FROM admin_users WHERE username = ?", [clean]);
}
