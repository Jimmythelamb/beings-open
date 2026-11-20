import { describe, expect, it } from "vitest";
import { ballotKey, blobKey, electionKey, keccakHex, normalizeBallotCode, sha256Hex } from "../src/codes.js";
import { RECORDS_SELECTOR } from "../src/chain.js";
import { BALLOT, ELECTION, PNG, PNG_HASH } from "./helpers.js";

describe("key derivation", () => {
  it("sha256 matches known vectors", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(PNG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(PNG)).toBe(PNG_HASH);
  });

  it("keccak and the on-chain keys match the @beings/core values", () => {
    // Vectors produced by @beings/core electionKey()/ballotKey().
    expect(electionKey(ELECTION)).toBe("0x295b9ab082f3aa26f44be188a6875800eba91602309fa46d0526247af6233aaf");
    expect(ballotKey(BALLOT)).toBe("0x024613ef5cc15cb497c14840be49b61aea2dfdcd0be74ecde3939d43e5321f9e");
    expect(keccakHex("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("the records(bytes32,bytes32) selector is the standard one", () => {
    expect(RECORDS_SELECTOR).toMatch(/^[0-9a-f]{8}$/);
  });

  it("blob keys are <electionCode>/<sha256> and validated", () => {
    expect(blobKey(ELECTION, PNG_HASH)).toBe(`${ELECTION}/${PNG_HASH}`);
    expect(() => blobKey("nope", PNG_HASH)).toThrow();
    expect(() => blobKey(ELECTION, "ABC")).toThrow();
    expect(() => blobKey(ELECTION, PNG_HASH.toUpperCase())).toThrow();
    expect(() => blobKey(ELECTION, "../" + PNG_HASH.slice(3))).toThrow();
  });

  it("the same image in two elections gets two different keys", () => {
    expect(blobKey("BEINGS-2026-4CRWX2", PNG_HASH)).not.toBe(blobKey("BEINGS-2026-AAAAAA", PNG_HASH));
  });

  it("ballot codes are normalized like @beings/core and invalid ones refused", () => {
    expect(normalizeBallotCode("4f9q-7m2x-ht8b")).toBe("4F9Q7M2XHT8B");
    expect(normalizeBallotCode(" 4F9Q 7M2X HT8B ")).toBe("4F9Q7M2XHT8B");
    expect(normalizeBallotCode("OIL0OIL0OIL0")).toBe("011001100110");
    expect(normalizeBallotCode("4F9Q7M2XHT8U")).toBeNull(); // U is never valid
    expect(normalizeBallotCode("short")).toBeNull();
    expect(() => ballotKey("4f9q7m2xht8b")).toThrow(); // strict form only
  });
});
