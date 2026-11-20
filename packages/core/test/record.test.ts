import { describe, expect, it } from "vitest";
import { BeingsError, isValid, ledgerEntryFromRecord, recordSha256, sha256Hex, canonicalize, type BallotRecord } from "../src/index.js";
import { deepClone, spec } from "./helpers.js";

describe("record hashing", () => {
  const rec = spec<BallotRecord>("record-example");

  it("recordSha256 reproduces the hash printed in the spec's ledger-entry example (JCS + SHA-256)", () => {
    expect(recordSha256(rec)).toBe(spec<{ recordSha256: string }>("ledger-entry-example").recordSha256);
    expect(recordSha256(rec)).toBe("b3f92f79b07592ae70a4fbb5e2360f4e5c763ed0a6d9ac12101c567e0c60f156");
  });

  it("is over the canonical form, so key order does not matter, but content does", () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(rec) as BallotRecord;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(rec));
    expect(recordSha256(reordered)).toBe(recordSha256(rec));
    expect(recordSha256(rec)).toBe(sha256Hex(canonicalize(rec)));
    const changed = deepClone(rec);
    changed.results["q1"] = "V:c2";
    expect(recordSha256(changed)).not.toBe(recordSha256(rec));
  });

  it("ledgerEntryFromRecord reproduces the spec's ledger entry example exactly and validates", () => {
    const e = ledgerEntryFromRecord(rec);
    expect(e).toEqual(spec("ledger-entry-example"));
    expect(isValid("ledgerEntry", e)).toBe(true);
  });

  it("chooses the published image among the readings only", () => {
    const two = deepClone(rec);
    two.readings.push({ ...(two.readings[0] as BallotRecord["readings"][number]), imageSha256: "c".repeat(64) });
    expect(ledgerEntryFromRecord(two, { imageSha256: "c".repeat(64) }).imageSha256).toBe("c".repeat(64));
    expect(() => ledgerEntryFromRecord(two, { imageSha256: "d".repeat(64) })).toThrow(BeingsError);
  });

  it("reviewed is true only for a signed review", () => {
    const r = deepClone(rec);
    r.review = { required: true, reviewer: "0x2222222222222222222222222222222222222222", reason: "unclear", signature: "0x" + "11".repeat(65) };
    expect(ledgerEntryFromRecord(r).reviewed).toBe(true);
    r.review = { required: true };
    expect(ledgerEntryFromRecord(r).reviewed).toBe(false);
  });

  it("needs a reading", () => {
    const r = deepClone(rec);
    r.readings = [];
    expect(() => ledgerEntryFromRecord(r)).toThrow(BeingsError);
  });
});
