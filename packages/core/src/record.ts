import { sha256Json } from "./hash.js";
import { BeingsError } from "./errors.js";
import type { BallotRecord, LedgerEntry } from "./types.js";

/**
 * `recordSha256` (spec 11.2): SHA-256 (64 hex, no 0x) of the canonical (JCS) full record file.
 * The hash covers the whole record including readings and signatures.
 */
export function recordSha256(record: BallotRecord): string {
  return sha256Json(record);
}

/**
 * The permanent ledger entry for a record. `imageSha256` is the published image's hash; the spec says it must equal
 * one of the readings' `imageSha256` but not which, so the default is the first reading's ([PROPOSED]);
 * pass `imageSha256` to choose another (it must still be one of the readings').
 * `reviewed` = the record carries a review (a reviewer signed).
 */
export function ledgerEntryFromRecord(record: BallotRecord, opts: { imageSha256?: string } = {}): LedgerEntry {
  const first = record.readings[0];
  if (!first) throw new BeingsError("BAD_INPUT", "record has no readings");
  const imageSha256 = opts.imageSha256 ?? first.imageSha256;
  if (!record.readings.some((r) => r.imageSha256 === imageSha256)) {
    throw new BeingsError("BAD_INPUT", "published image hash must equal one of the readings' imageSha256");
  }
  return {
    electionCode: record.electionCode,
    ballotCode: record.ballotCode,
    results: record.results,
    imageSha256,
    recordSha256: recordSha256(record),
    reviewed: record.review.signature !== undefined && record.review.reviewer !== undefined,
  };
}
