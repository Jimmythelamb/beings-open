import { BeingsError } from "./errors.js";

export type Hex = `0x${string}`;

const HEX_RE = /^[0-9a-fA-F]*$/;

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Accepts hex with or without 0x. Throws BAD_HEX on odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !HEX_RE.test(h)) {
    throw new BeingsError("BAD_HEX", "not valid hex bytes");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True for exactly 32 bytes of hex with a 0x prefix (any case). */
export function isBytes32(v: unknown): v is Hex {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** Normalize a 0x-prefixed bytes32 to lower case; throws BAD_HEX otherwise. */
export function toBytes32(v: string): Hex {
  if (!isBytes32(v)) throw new BeingsError("BAD_HEX", "expected 0x-prefixed 32-byte hex");
  return v.toLowerCase() as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
