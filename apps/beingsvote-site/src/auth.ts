import { createHash, timingSafeEqual } from "node:crypto";
import { MIN_TOKEN_LENGTH } from "./config.js";

/** SHA-256 both sides first, so the comparison is over equal-length buffers and leaks neither content nor length. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export type AuthResult = "ok" | "unauthorized" | "not-configured";

/**
 * Check an `Authorization: Bearer <token>` header against the configured upload secret.
 * Fails closed: if the secret is missing or shorter than MIN_TOKEN_LENGTH, nothing is accepted ("not-configured").
 */
export function checkBearer(authorizationHeader: string | null, secret: string): AuthResult {
  if (secret.length < MIN_TOKEN_LENGTH) return "not-configured";
  const m = /^Bearer[ ]+(\S+)$/i.exec((authorizationHeader ?? "").trim());
  // Always run one comparison, so a missing header takes the same path as a wrong one.
  const presented = m?.[1] ?? "";
  const equal = constantTimeEqual(presented, secret);
  return m !== null && equal ? "ok" : "unauthorized";
}
