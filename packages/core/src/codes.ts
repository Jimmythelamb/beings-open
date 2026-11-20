import { BeingsError } from "./errors.js";
import { type Hex } from "./hex.js";
import { keccakHex } from "./hash.js";

/** Crockford base-32: digits and letters without I, L, O, U (spec 9.7). */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const BALLOT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
export const ELECTION_CODE_RE = /^BEINGS-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{6}$/;
export const BALLOT_CODE_LENGTH = 12;

/** Source of random bytes. Defaults to the platform CSPRNG; override ONLY in tests. */
export type RandomBytes = (length: number) => Uint8Array;

export const csprng: RandomBytes = (length) => {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new BeingsError("BAD_INPUT", "no CSPRNG available (globalThis.crypto.getRandomValues)");
  }
  const out = new Uint8Array(length);
  c.getRandomValues(out);
  return out;
};

function randomCrockford(length: number, rng: RandomBytes): string {
  const bytes = rng(length);
  if (bytes.length !== length) throw new BeingsError("BAD_INPUT", "random source returned the wrong length");
  let s = "";
  // 256 / 32 = 8 exactly, so masking the low 5 bits is unbiased.
  for (const b of bytes) s += CROCKFORD_ALPHABET[b & 31];
  return s;
}

export function isBallotCode(v: unknown): v is string {
  return typeof v === "string" && BALLOT_CODE_RE.test(v);
}

export function isElectionCode(v: unknown): v is string {
  return typeof v === "string" && ELECTION_CODE_RE.test(v);
}

/** A new random ballot code: 12 Crockford base-32 characters (60 bits), unformatted, e.g. `4F9Q7M2XHT8B`. */
export function newBallotCode(rng: RandomBytes = csprng): string {
  return randomCrockford(BALLOT_CODE_LENGTH, rng);
}

/**
 * `count` distinct ballot codes (uniqueness checked). Order is the generation order, which is random;
 * M2 still shuffles before printing.
 */
export function newBallotCodes(count: number, rng: RandomBytes = csprng): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new BeingsError("BAD_INPUT", "count must be a non-negative integer");
  const seen = new Set<string>();
  while (seen.size < count) seen.add(newBallotCode(rng));
  return [...seen];
}

/** Display form in groups of four: `4F9Q-7M2X-HT8B`. */
export function formatBallotCode(code: string): string {
  assertBallotCode(code);
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/**
 * Turn what a person typed or scanned into the strict 12-character form.
 * Upper-cases, drops dashes and spaces, and applies the standard Crockford look-alike rule (O to 0, I and L to 1).
 * Throws BAD_CODE if the result is not a valid ballot code (in particular U is never accepted).
 * [PROPOSED]: the spec fixes the alphabet but not input normalization; this is for the lookup page.
 */
export function normalizeBallotCode(input: string): string {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  assertBallotCode(s);
  return s;
}

export function assertBallotCode(code: string): void {
  if (!isBallotCode(code)) throw new BeingsError("BAD_CODE", "ballot code must be 12 Crockford base-32 characters");
}

export function assertElectionCode(code: string): void {
  if (!isElectionCode(code)) throw new BeingsError("BAD_CODE", "election code must match BEINGS-YYYY-XXXXXX");
}

/** On-chain ballot key: keccak256(bytes(ballotCode)) (spec 9.7). The code must be in strict 12-character form. */
export function ballotKey(ballotCode: string): Hex {
  assertBallotCode(ballotCode);
  return keccakHex(ballotCode);
}

/** On-chain election key: keccak256(bytes(electionCode)) (spec 9.7). */
export function electionKey(electionCode: string): Hex {
  assertElectionCode(electionCode);
  return keccakHex(electionCode);
}

/** New election code `BEINGS-<year>-<6 Crockford characters>`. Duplicate rejection is the registry's job. */
export function newElectionCode(year: number = new Date().getUTCFullYear(), rng: RandomBytes = csprng): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new BeingsError("BAD_INPUT", "year must have four digits");
  return `BEINGS-${year}-${randomCrockford(6, rng)}`;
}
