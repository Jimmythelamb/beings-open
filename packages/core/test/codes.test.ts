import { describe, expect, it } from "vitest";
import {
  BALLOT_CODE_RE,
  BeingsError,
  CROCKFORD_ALPHABET,
  ballotKey,
  electionKey,
  formatBallotCode,
  isBallotCode,
  isElectionCode,
  keccakHex,
  newBallotCode,
  newBallotCodes,
  newElectionCode,
  normalizeBallotCode,
} from "../src/index.js";

describe("ballot codes", () => {
  it("alphabet is Crockford base-32 without I, L, O, U", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
    for (const ch of "ILOU") expect(CROCKFORD_ALPHABET).not.toContain(ch);
  });

  it("generates 12 valid characters", () => {
    for (let i = 0; i < 200; i++) {
      const c = newBallotCode();
      expect(c).toMatch(BALLOT_CODE_RE);
      expect(isBallotCode(c)).toBe(true);
    }
  });

  it("maps random bytes to the alphabet deterministically (injected rng)", () => {
    const rng = (n: number) => Uint8Array.from({ length: n }, (_, i) => i); // 0..11
    expect(newBallotCode(rng)).toBe("0123456789AB");
    const rng2 = (n: number) => Uint8Array.from({ length: n }, (_, i) => 255 - i); // low 5 bits: 31, 30, ...
    expect(newBallotCode(rng2)).toBe("ZYXWVTSRQPNM");
  });

  it("uses all alphabet symbols roughly uniformly (CSPRNG smoke test)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) for (const ch of newBallotCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    for (const n of counts.values()) expect(n).toBeGreaterThan(200); // expected 375 each
  });

  it("generates distinct batches", () => {
    const codes = newBallotCodes(500);
    expect(new Set(codes).size).toBe(500);
    // a source that repeats forever cannot yield 2 distinct codes only if it never varies: use a varying one
    let n = 0;
    const rng = (len: number) => Uint8Array.from({ length: len }, () => (n++ / 12) | 0);
    expect(new Set(newBallotCodes(3, rng)).size).toBe(3);
  });

  it("rejects wrong shapes", () => {
    for (const c of ["", "4F9Q7M2XHT8", "4F9Q7M2XHT8BB", "4f9q7m2xht8b", "4F9Q7M2XHT8U", "4F9Q7M2XHT8I", "4F9Q-7M2X-HT8B", "4F9Q7M2XHT8O", "4F9Q7M2XHT8L"]) {
      expect(isBallotCode(c), c).toBe(false);
      expect(() => ballotKey(c), c).toThrowError(expect.objectContaining({ code: "BAD_CODE" }));
    }
  });

  it("formats and normalizes", () => {
    expect(formatBallotCode("4F9Q7M2XHT8B")).toBe("4F9Q-7M2X-HT8B");
    expect(normalizeBallotCode("4f9q-7m2x ht8b")).toBe("4F9Q7M2XHT8B");
    expect(normalizeBallotCode("OIL0-0000-0000")).toBe("011000000000"); // look-alikes
    expect(() => normalizeBallotCode("4F9Q7M2XHT8U")).toThrow(BeingsError);
    expect(() => normalizeBallotCode("4F9Q")).toThrow(BeingsError);
  });
});

describe("keys", () => {
  it("ballotKey = keccak256(ASCII bytes of the code)", () => {
    expect(ballotKey("4F9Q7M2XHT8B")).toBe(keccakHex("4F9Q7M2XHT8B"));
    expect(ballotKey("4F9Q7M2XHT8B")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ballotKey("4F9Q7M2XHT8B")).not.toBe(ballotKey("B3N6D0YK5E1W"));
  });

  it("electionKey = keccak256(election code)", () => {
    expect(electionKey("BEINGS-2026-K7M4Q2")).toBe(keccakHex("BEINGS-2026-K7M4Q2"));
    expect(() => electionKey("BEINGS-26-K7M4Q2")).toThrow(BeingsError);
    expect(() => electionKey("BEINGS-2026-K7M4QU")).toThrow(BeingsError);
  });

  it("election codes", () => {
    const c = newElectionCode(2026);
    expect(c).toMatch(/^BEINGS-2026-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(isElectionCode(c)).toBe(true);
    expect(isElectionCode("BEINGS-2026-K7M4Q2")).toBe(true);
    expect(isElectionCode("beings-2026-k7m4q2")).toBe(false);
    expect(() => newElectionCode(26)).toThrow(BeingsError);
    expect(newElectionCode(undefined)).toMatch(/^BEINGS-\d{4}-/);
  });
});
