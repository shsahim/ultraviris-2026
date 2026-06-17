import "server-only";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

// Module-level (per server process) cache. Survives across requests and is
// warmed on first DB connection via lib/db.ts → lib/warm.ts.
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Returns a cached value for `key`, loading and storing it on a miss.
 * Concurrent misses for the same key share a single in-flight load.
 */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  const existing = inflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = loader()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, promise);
  return promise;
}

export function invalidateAll(): void {
  store.clear();
}

export function invalidateKey(key: string): void {
  store.delete(key);
}

export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}
