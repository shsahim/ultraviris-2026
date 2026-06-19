/**
 * Database access for CLI scripts. Same connection logic as lib/db.ts but
 * without the `server-only` guard (which breaks under tsx).
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import mysql from "mysql2/promise";

let poolPromise: Promise<mysql.Pool> | undefined;
let progress: (msg: string) => void = () => {};

const SSH_TIMEOUT_MS = 30_000;
const MYSQL_TIMEOUT_MS = 30_000;

export function setDbProgress(fn: (msg: string) => void): void {
  progress = fn;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith("~")) {
    return filePath.replace(/^~/, os.homedir());
  }
  return filePath;
}

function loadPrivateKey(): Buffer {
  const keyPath = process.env.SSH_PRIVATE_KEY_PATH;
  if (!keyPath) {
    throw new Error("SSH_PRIVATE_KEY_PATH is not set");
  }
  return readFileSync(expandHome(keyPath));
}

function sslOption(): mysql.PoolOptions["ssl"] | undefined {
  const ssl = process.env.MYSQL_SSL;
  if (!ssl) return undefined;
  if (ssl.toLowerCase() === "true") return {};
  return ssl;
}

function poolOptions(host: string, port: number): mysql.PoolOptions {
  const ssl = sslOption();
  return {
    host,
    port,
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
    queueLimit: 0,
    connectTimeout: MYSQL_TIMEOUT_MS,
    ...(ssl ? { ssl } : {}),
  };
}

function sshTunnelEnabled(): boolean {
  const flag = process.env.DB_USE_SSH_TUNNEL;
  if (flag !== undefined && flag !== "") {
    return /^(1|true|yes|on)$/i.test(flag);
  }
  return Boolean(process.env.SSH_HOST);
}

function createDirectPool(): mysql.Pool {
  const host = process.env.MYSQL_HOST ?? "127.0.0.1";
  const port = Number(process.env.MYSQL_PORT ?? 3306);
  progress(`Opening direct MySQL connection to ${host}:${port} …`);
  return mysql.createPool(poolOptions(host, port));
}

async function createTunneledPool(): Promise<mysql.Pool> {
  const sshHost = process.env.SSH_HOST;
  const sshPort = Number(process.env.SSH_PORT ?? 22);
  progress(`Opening SSH connection to ${sshHost}:${sshPort} …`);

  const { Client } = await import("ssh2");
  const ssh = new Client();

  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      progress(`  … still waiting for SSH (${elapsed}s)`);
    }, 5000);

    const fail = (err: Error) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reject(err);
    };

    const timeout = setTimeout(() => {
      ssh.destroy();
      fail(
        new Error(
          `SSH connection to ${sshHost} timed out after ${SSH_TIMEOUT_MS / 1000}s`
        )
      );
    }, SSH_TIMEOUT_MS);

    ssh
      .on("ready", () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        progress("SSH connection ready.");
        resolve();
      })
      .on("error", (err) => fail(err))
      .connect({
        host: sshHost,
        port: sshPort,
        username: process.env.SSH_USER,
        privateKey: loadPrivateKey(),
        passphrase: process.env.SSH_PASSPHRASE || undefined,
        keepaliveInterval: 10000,
        readyTimeout: SSH_TIMEOUT_MS,
      });
  });

  const dbHost = process.env.MYSQL_HOST ?? "127.0.0.1";
  const dbPort = Number(process.env.MYSQL_PORT ?? 3306);
  progress(`Starting local tunnel to MySQL at ${dbHost}:${dbPort} …`);

  const server = net.createServer((socket) => {
    ssh.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      dbHost,
      dbPort,
      (err, stream) => {
        if (err) {
          socket.destroy(err);
          return;
        }
        socket.pipe(stream).pipe(socket);
      }
    );
  });

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("Failed to bind local SSH tunnel port"));
      }
    });
  });

  progress(`Tunnel listening on 127.0.0.1:${localPort}.`);

  ssh.on("close", () => {
    server.close();
    poolPromise = undefined;
  });

  return mysql.createPool(poolOptions("127.0.0.1", localPort));
}

export function getPool(): Promise<mysql.Pool> {
  if (!poolPromise) {
    const create = sshTunnelEnabled()
      ? createTunneledPool()
      : Promise.resolve(createDirectPool());
    poolPromise = create.catch((err) => {
      poolPromise = undefined;
      throw err;
    });
  }
  return poolPromise;
}

/** Connect and verify with SELECT 1 before running queries. */
export async function connectDatabase(): Promise<void> {
  const pool = await getPool();
  progress("Running MySQL ping (SELECT 1) …");
  await pool.query("SELECT 1");
  progress("Database ready.");
}

export async function query<T = unknown>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = await getPool();
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise;
  await pool.end();
  poolPromise = undefined;
}
