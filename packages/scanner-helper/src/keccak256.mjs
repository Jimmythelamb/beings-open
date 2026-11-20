// keccak256 (not SHA3-256) with no dependencies, so the polling-PC helper can hash leaves
// without adding a package to the Windows bundle. Checked against @noble/hashes in tests.
const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rot[x][y]
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x, n) {
  if (n === 0) return x;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
}

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    const d = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) s[i] = (s[i] ^ d[i % 5]) & MASK;
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        s[i] = (b[i] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK) & b[((x + 2) % 5) + 5 * y])) & MASK;
      }
    }
    s[0] = (s[0] ^ RC[round]) & MASK;
  }
}

function absorb(s, block) {
  for (let i = 0; i < block.length; i += 8) {
    let v = 0n;
    for (let j = 0; j < 8; j++) v |= BigInt(block[i + j]) << BigInt(8 * j);
    s[i / 8] ^= v;
  }
  keccakF(s);
}

/** keccak256 of raw bytes. Returns 32 bytes. */
export function keccak256Bytes(data) {
  const rate = 136;
  const s = Array.from({ length: 25 }, () => 0n);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let i = 0;
  while (i + rate <= bytes.length) {
    absorb(s, bytes.subarray(i, i + rate));
    i += rate;
  }
  const block = new Uint8Array(rate);
  block.set(bytes.subarray(i));
  block[bytes.length - i] ^= 0x01;
  block[rate - 1] ^= 0x80;
  absorb(s, block);
  const out = new Uint8Array(32);
  for (let n = 0; n < 32; n++) out[n] = Number((s[n >> 3] >> BigInt((n & 7) * 8)) & 0xffn);
  return out;
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** keccak256 as 0x + 64 lower-case hex. A string is hashed as UTF-8. */
export function keccak256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return `0x${toHex(keccak256Bytes(bytes))}`;
}
