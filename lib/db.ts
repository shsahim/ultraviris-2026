import "server-only";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import mysql from "mysql2/promise";

declare global {
  // eslint-disable-next-line no-var
  var _dbPoolPromise: Promise<mysql.Pool> | undefined;
  // eslint-disable-next-line no-var
  var _cacheWarmStarted: boolean | undefined;
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

// Optional TLS for the MySQL connection. mysql2 ships predefined CA bundles, so
// `MYSQL_SSL="Amazon RDS"` uses the RDS CA; `MYSQL_SSL=true` enables TLS with
// default verification. Unset (the default) means no TLS, matching prior behavior.
function sslOption(): mysql.PoolOptions["ssl"] | undefined {
  const ssl = process.env.MYSQL_SSL;
  if (!ssl) return undefined;
  if (ssl.toLowerCase() === "true") return {};
  return ssl;
}

// Connection options shared by both the tunneled and direct pools. `host`/`port`
// differ: the tunnel points at a local forwarded port, while a direct pool points
// straight at MYSQL_HOST.
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
    ...(ssl ? { ssl } : {}),
  };
}

// True when we should reach the database through an SSH tunnel (local dev).
// An explicit DB_USE_SSH_TUNNEL flag always wins; otherwise we tunnel only when
// an SSH host is configured. In prod (inside the VPC) leave SSH_HOST unset so
// the app connects directly to RDS via security groups.
function useSshTunnel(): boolean {
  const flag = process.env.DB_USE_SSH_TUNNEL;
  if (flag !== undefined && flag !== "") {
    return /^(1|true|yes|on)$/i.test(flag);
  }
  return Boolean(process.env.SSH_HOST);
}

// Connects straight to MYSQL_HOST:MYSQL_PORT. Used in prod, where the app runs
// inside the VPC and reaches RDS through security-group rules (no tunnel).
function createDirectPool(): mysql.Pool {
  const host = process.env.MYSQL_HOST ?? "127.0.0.1";
  const port = Number(process.env.MYSQL_PORT ?? 3306);
  return mysql.createPool(poolOptions(host, port));
}

// Opens an SSH connection using a locally-stored private key, then exposes a
// local TCP server that forwards every connection to the remote MySQL host
// over the tunnel ("Standard TCP/IP over SSH"). The mysql2 pool then connects
// to that local port.
async function createTunneledPool(): Promise<mysql.Pool> {
  const { Client } = await import("ssh2");
  const ssh = new Client();

  await new Promise<void>((resolve, reject) => {
    ssh
      .on("ready", () => resolve())
      .on("error", reject)
      .connect({
        host: process.env.SSH_HOST,
        port: Number(process.env.SSH_PORT ?? 22),
        username: process.env.SSH_USER,
        privateKey: loadPrivateKey(),
        passphrase: process.env.SSH_PASSPHRASE || undefined,
        keepaliveInterval: 10000,
      });
  });

  // The MySQL host/port as seen *from* the SSH server (often 127.0.0.1:3306).
  const dbHost = process.env.MYSQL_HOST ?? "127.0.0.1";
  const dbPort = Number(process.env.MYSQL_PORT ?? 3306);

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

  // Tear down the tunnel if the SSH connection drops so the next query rebuilds it.
  ssh.on("close", () => {
    server.close();
    global._dbPoolPromise = undefined;
  });

  return mysql.createPool(poolOptions("127.0.0.1", localPort));
}

function scheduleWarmCache(): void {
  if (global._cacheWarmStarted) return;
  global._cacheWarmStarted = true;
  void import("@/lib/warm")
    .then(({ warmCache }) => warmCache())
    .catch(() => {});
}

export function getPool(): Promise<mysql.Pool> {
  if (!global._dbPoolPromise) {
    scheduleWarmCache();
    const create = useSshTunnel()
      ? createTunneledPool()
      : Promise.resolve(createDirectPool());
    global._dbPoolPromise = create.catch((err) => {
      // Don't cache a failed setup so the next call can retry.
      global._dbPoolPromise = undefined;
      throw err;
    });
  }
  return global._dbPoolPromise;
}

export async function query<T = unknown>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = await getPool();
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}
