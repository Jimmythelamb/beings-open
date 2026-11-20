const DAY_MS = 86_400_000;

/**
 * Whole days from a header or form value; null if missing or not a positive integer.
 */
export function parseRetentionDays(retentionDays: unknown): number | null {
  const days = typeof retentionDays === "string" && /^\d{1,5}$/.test(retentionDays.trim()) ? Number(retentionDays) : retentionDays;
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1) return null;
  return days;
}

/**
 * deleteAfter (ISO 8601, UTC) = now + retentionDays, with retentionDays a whole number from minDays to maxDays.
 * Returns null if retentionDays is not acceptable (so the caller can answer 400).
 */
export function computeDeleteAfter(now: Date, retentionDays: unknown, maxDays: number, minDays = 1): string | null {
  const days = parseRetentionDays(retentionDays);
  if (days === null || days < minDays || days > maxDays) return null;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** Parse a stored deleteAfter; null if it is missing or not a valid date. */
export function parseDeleteAfter(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** True once `now` has reached deleteAfter. A missing or invalid value is NOT treated as expired (the cleanup reports it). */
export function isExpired(deleteAfter: unknown, now: Date): boolean {
  const t = parseDeleteAfter(deleteAfter);
  return t !== null && now.getTime() >= t;
}
