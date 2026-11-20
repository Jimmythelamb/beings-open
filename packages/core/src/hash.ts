import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalBytes } from "./canonical.js";
import { type Hex, bytesToHex } from "./hex.js";

const encoder = new TextEncoder();

/** Bytes to hash: raw bytes, or a string which is hashed as its UTF-8 encoding. */
export type HashInput = Uint8Array | string;

function toBytes(data: HashInput): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** SHA-256 for files and images (spec 9.7): 64 lower-case hex characters, NO 0x prefix. */
export function sha256Hex(data: HashInput): string {
  return bytesToHex(sha256(toBytes(data)));
}

/** keccak256 for EVM structures and Merkle trees (spec 9.7): 0x + 64 lower-case hex characters. */
export function keccakHex(data: HashInput): Hex {
  return `0x${bytesToHex(keccak_256(toBytes(data)))}`;
}

export function keccakBytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** SHA-256 of the RFC 8785 canonical form of a JSON value (for files such as the election file). */
export function sha256Json(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

/** keccak256 of the RFC 8785 canonical form of a JSON value. */
export function keccakJson(value: unknown): Hex {
  return keccakHex(canonicalBytes(value));
}

/**
 * `layoutHash` of an election file: SHA-256 (64 lower-case hex characters, no 0x) of the RFC 8785 canonical JSON of the
 * ballot layout file (IC2). The ballot generator (M2) writes it into the election file, so the election file hash that
 * goes on-chain covers the layout; the scanner (M3) and verifier (M6) recompute it from the layout they were given.
 */
export function layoutHash(layout: unknown): string {
  return sha256Json(layout);
}
