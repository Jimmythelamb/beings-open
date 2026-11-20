// Hashing and key derivation. These MUST agree with @beings/core (packages/core/src/codes.ts and hash.ts):
//   electionKey = keccak256(utf8(electionCode))   ballotKey = keccak256(utf8(ballotCode, strict 12-char form))
// This site is standalone (it is deployed alone), so it re-implements the few lines it needs; test/chain.test.ts
// cross-checks them against @beings/core when the monorepo is present.
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

const encoder = new TextEncoder();

export const BALLOT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
export const ELECTION_CODE_RE = /^BEINGS-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{6}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const KECCAK_HEX_RE = /^0x[0-9a-f]{64}$/;

/** SHA-256 of bytes: 64 lower-case hex characters, no 0x (spec 9.7). */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? encoder.encode(data) : data));
}

/** keccak-256 of a string's UTF-8 bytes: 0x + 64 lower-case hex characters. */
export function keccakHex(data: string): string {
  return `0x${bytesToHex(keccak_256(encoder.encode(data)))}`;
}

export function isElectionCode(v: unknown): v is string {
  return typeof v === "string" && ELECTION_CODE_RE.test(v);
}

/** 64 lower-case hex characters, accepting an optional 0x prefix and mixed case. */
export function normalizeImageSha256(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^0x/, "");
  return SHA256_HEX_RE.test(s) ? s : null;
}

/** What a voter types or scans to the strict 12-character form (same rules as core `normalizeBallotCode`). Returns null if invalid. */
export function normalizeBallotCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return BALLOT_CODE_RE.test(s) ? s : null;
}

/** On-chain election key. The code must already be a valid election code. */
export function electionKey(electionCode: string): string {
  if (!isElectionCode(electionCode)) throw new Error("bad election code");
  return keccakHex(electionCode);
}

/** On-chain ballot key = the "ballot code hash" stored in blob metadata. The code must be in strict 12-character form. */
export function ballotKey(ballotCode: string): string {
  if (!BALLOT_CODE_RE.test(ballotCode)) throw new Error("bad ballot code");
  return keccakHex(ballotCode);
}

/** Blob key: `<electionCode>/<sha256hex>`. Namespaced by election so identical bytes in two elections never collide. */
export function blobKey(electionCode: string, imageSha256: string): string {
  if (!isElectionCode(electionCode)) throw new Error("bad election code");
  if (!SHA256_HEX_RE.test(imageSha256)) throw new Error("bad image hash");
  return `${electionCode}/${imageSha256}`;
}
