import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, isBytes32, keccakHex, sha256Hex, sha256Json, keccakJson, layoutHash, toBytes32, BeingsError } from "../src/index.js";

describe("hashes", () => {
  it("sha256 known answers, lower-case hex without 0x", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex("abc"));
  });

  it("keccak256 known answers (Ethereum keccak, not NIST SHA-3), 0x-prefixed", () => {
    expect(keccakHex("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccakHex("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(keccakHex("transfer(address,uint256)").slice(0, 10)).toBe("0xa9059cbb"); // ERC-20 selector
  });

  it("strings are hashed as UTF-8", () => {
    expect(sha256Hex("\u00e9")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });

  it("JSON hashes are over the canonical form", () => {
    expect(sha256Json({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
    expect(keccakJson({ b: 1, a: 2 })).toBe(keccakHex('{"a":2,"b":1}'));
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(bytesToHex(b)).toBe("0001feff");
    expect(Array.from(hexToBytes("0x0001feff"))).toEqual(Array.from(b));
    expect(Array.from(hexToBytes("0001FEFF"))).toEqual(Array.from(b));
  });
  it("rejects bad hex", () => {
    for (const h of ["abc", "zz", "0xg0"]) expect(() => hexToBytes(h), h).toThrow(BeingsError);
  });
  it("bytes32 helpers", () => {
    const ok = "0x" + "AB".repeat(32);
    expect(isBytes32(ok)).toBe(true);
    expect(toBytes32(ok)).toBe("0x" + "ab".repeat(32));
    expect(isBytes32("0x1234")).toBe(false);
    expect(isBytes32("ab".repeat(32))).toBe(false);
    expect(() => toBytes32("0x12")).toThrow(BeingsError);
  });
});

describe("layoutHash", () => {
  it("is SHA-256 of the canonical JSON (key order does not matter), 64 hex, no 0x", () => {
    const a = { b: [1, 2.5], a: { y: 1, x: 0.096 } };
    const b = { a: { x: 0.096, y: 1 }, b: [1, 2.5] };
    expect(layoutHash(a)).toBe(layoutHash(b));
    expect(layoutHash(a)).toBe(sha256Hex('{"a":{"x":0.096,"y":1},"b":[1,2.5]}'));
    expect(layoutHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
