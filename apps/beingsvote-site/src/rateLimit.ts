// Best-effort fixed-window limiter, kept in memory. A serverless function may run several instances, so this is a second
// line of defence (it stops one client hammering one instance, and bounds RPC lookups made for unauthenticated callers).
// The hard, shared limit is the platform `rateLimit` in the function's config.
export class FixedWindowLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Count one request for `key`. Returns false once the key is over the limit for the current window. */
  allow(key: string, nowMs: number): boolean {
    if (this.hits.size > 5000) this.sweep(nowMs); // bound memory
    const h = this.hits.get(key);
    if (!h || nowMs - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private sweep(nowMs: number): void {
    for (const [k, h] of this.hits) if (nowMs - h.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * Client address for the in-memory limiter.
 * Prefer the platform header the edge actually sets: Netlify's `x-nf-client-connection-ip`, then Cloudflare's
 * `cf-connecting-ip` (the runtime overwrites it, so a caller cannot pick their own bucket). The first
 * `x-forwarded-for` hop is only a last resort: a client can spoof it.
 */
export function clientKey(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ??
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
