import "server-only";

// A small in-process fixed-window rate limiter. Counters live in module memory,
// so limits are enforced PER SERVER PROCESS — adequate for a single instance or
// a small ASG. If the app is scaled out widely and you need globally-consistent
// limits, back this with a shared store (e.g. ElastiCache/Redis or DynamoDB).

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the current window ends
}

const buckets = new Map<string, Bucket>();

// Prune expired buckets opportunistically once the map grows past this size so
// it can't grow unbounded under a flood of unique keys (e.g. spoofed IPs).
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitOptions {
  /** Max allowed requests within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** True when the request is within the limit and should be allowed. */
  ok: boolean;
  /** Requests remaining in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (for a Retry-After header). */
  retryAfterSeconds: number;
}

/**
 * Records a hit for `key` and reports whether it's within `limit` per
 * `windowMs`. Callers decide the key (e.g. `contact:<ip>`), so the same limiter
 * can guard multiple independent actions.
 */
export function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions
): RateLimitResult {
  const now = Date.now();

  if (buckets.size > MAX_BUCKETS) {
    sweep(now);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: limit - existing.count,
    retryAfterSeconds: 0,
  };
}

/**
 * Best-effort client IP from proxy headers. Behind an ALB/CloudFront the real
 * client is the first entry in `x-forwarded-for`. Falls back to "unknown" so a
 * missing header collapses to a single shared bucket rather than bypassing the
 * limit entirely.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Clears all counters. Exposed for tests. */
export function _resetRateLimits(): void {
  buckets.clear();
}
