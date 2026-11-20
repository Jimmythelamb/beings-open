import { Wallet, TypedDataEncoder, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import {
  COSTON2_CHAIN_ID,
  READING_TYPES,
  checkRecordSignatures,
  eip712Domain,
  electionKey,
  ballotKey,
  keccakHex,
  keccakJson,
  readingDigest,
  readingMessage,
  readingTypedData,
  recoverReadingSigner,
  reportHash,
  resultsHash,
  scoresHash,
  signReading,
  signReport,
  signReview,
  verifyReading,
  verifyReport,
  verifyReview,
  type BallotRecord,
  type ReadingInput,
  type UnsignedVerifierReport,
  type VerifierReport,
} from "../src/index.js";
import { deepClone } from "./helpers.js";

const device = new Wallet("0x" + "11".repeat(32));
const device2 = new Wallet("0x" + "22".repeat(32));
const reviewer = new Wallet("0x" + "33".repeat(32));
const node = new Wallet("0x" + "44".repeat(32));
const domain = eip712Domain({ verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });

const reading: ReadingInput = {
  electionCode: "BEINGS-2026-K7M4Q2",
  ballotCode: "4F9Q7M2XHT8B",
  results: { q1: "V:c1", q2: "V:c2" },
  imageSha256: "a3f1c0de5b7e9a2d4c6b8f1e3a5c7d9b0f2e4a6c8d1b3f5e7a9c0d2b4f6e8a1c",
  fillScores: { q1: { c1: 92, c2: 3, c3: 0 }, q2: { c1: 2, c2: 88 } },
  questionOrder: ["q1", "q2"],
};

describe("domain", () => {
  it("defaults to Coston2 and omits verifyingContract unless given", () => {
    expect(COSTON2_CHAIN_ID).toBe(114);
    expect(eip712Domain()).toEqual({ name: "B.E.I.N.G.S.", version: "1", chainId: 114 });
    expect(domain.verifyingContract).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(eip712Domain({ chainId: 31337 }).chainId).toBe(31337);
  });
  it("rejects bad input", () => {
    expect(() => eip712Domain({ verifyingContract: "0x123" })).toThrow();
    expect(() => eip712Domain({ chainId: 0 })).toThrow();
  });
});

describe("Reading (spec 10.2 typed data)", () => {
  it("type string matches the spec exactly", () => {
    expect(TypedDataEncoder.from(READING_TYPES).encodeType("Reading")).toBe(
      "Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)",
    );
  });

  it("message fields are derived as documented", () => {
    const m = readingMessage(reading);
    expect(m.electionKey).toBe(electionKey("BEINGS-2026-K7M4Q2"));
    expect(m.ballotKey).toBe(ballotKey("4F9Q7M2XHT8B"));
    expect(m.resultsHash).toBe(keccakHex("V:c1|V:c2"));
    expect(m.resultsHash).toBe(resultsHash(reading.results, ["q1", "q2"]));
    expect(m.imageSha256).toBe("0x" + reading.imageSha256);
    expect(m.scoresHash).toBe(keccakJson(reading.fillScores));
    expect(scoresHash(reading.fillScores)).toBe(m.scoresHash);
  });

  it("sign then verify round-trips and recovers the device address", async () => {
    const sig = await signReading(device, reading, domain);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(verifyReading(reading, sig, device.address, domain)).toBe(true);
    expect(recoverReadingSigner(reading, sig, domain)).toBe(device.address);
    expect(verifyReading(reading, sig, device.address.toLowerCase(), domain)).toBe(true);
  });

  it("matches ethers' own typed-data verification and digest (interop)", async () => {
    const sig = await signReading(device, reading, domain);
    const td = readingTypedData(reading, domain);
    expect(verifyTypedData(td.domain, td.types, td.message, sig)).toBe(device.address);
    expect(readingDigest(reading, domain)).toBe(TypedDataEncoder.hash(td.domain, td.types, td.message));
  });

  it("signatures are deterministic", async () => {
    expect(await signReading(device, reading, domain)).toBe(await signReading(device, reading, domain));
  });

  it("any tampered field invalidates the signature", async () => {
    const sig = await signReading(device, reading, domain);
    const variants: ReadingInput[] = [
      { ...reading, results: { q1: "V:c2", q2: "V:c2" } },
      { ...reading, ballotCode: "B3N6D0YK5E1W" },
      { ...reading, electionCode: "BEINGS-2026-AAAAAA" },
      { ...reading, imageSha256: "b".repeat(64) },
      { ...reading, fillScores: { q1: { c1: 91, c2: 3, c3: 0 }, q2: { c1: 2, c2: 88 } } },
    ];
    for (const v of variants) expect(verifyReading(v, sig, device.address, domain)).toBe(false);
  });

  it("is bound to the domain (chain and contract) so it cannot be replayed", async () => {
    const sig = await signReading(device, reading, domain);
    expect(verifyReading(reading, sig, device.address, eip712Domain({ verifyingContract: domain.verifyingContract as string, chainId: 1 }))).toBe(false);
    expect(verifyReading(reading, sig, device.address, eip712Domain({ verifyingContract: "0x" + "12".repeat(20) }))).toBe(false);
    expect(verifyReading(reading, sig, device.address, eip712Domain())).toBe(false);
  });

  it("a different signer, or a wrong expected address, fails", async () => {
    const sig = await signReading(device, reading, domain);
    expect(verifyReading(reading, sig, device2.address, domain)).toBe(false);
    expect(verifyReading(reading, await signReading(device2, reading, domain), device.address, domain)).toBe(false);
    expect(verifyReading(reading, sig, "not an address", domain)).toBe(false);
  });

  it("malformed signatures return false and never throw", async () => {
    const sig = await signReading(device, reading, domain);
    for (const bad of ["", "0x", "0x1234", sig.slice(0, -2), sig + "00", "0x" + "00".repeat(65), "0x" + "ff".repeat(65), sig.replace(/^0x/, "")]) {
      expect(verifyReading(reading, bad, device.address, domain), bad.slice(0, 12)).toBe(false);
    }
  });

  it("rejects the malleable high-s twin of a valid signature", async () => {
    const sig = await signReading(device, reading, domain);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = sig.slice(2, 66);
    const s = BigInt("0x" + sig.slice(66, 130));
    const v = parseInt(sig.slice(130, 132), 16);
    const highS = "0x" + r + (n - s).toString(16).padStart(64, "0") + (v === 27 ? "1c" : "1b");
    expect(verifyReading(reading, highS, device.address, domain)).toBe(false);
  });

  it("rejects bad inputs when building the message", () => {
    expect(() => readingMessage({ ...reading, imageSha256: "xyz" })).toThrow();
    expect(() => readingMessage({ ...reading, results: { q1: "nope", q2: "B" } })).toThrow();
    expect(() => readingMessage({ ...reading, ballotCode: "short" })).toThrow();
  });

  it("question order changes the signed hash (so it must come from the election file)", () => {
    const a = readingMessage({ ...reading, results: { q1: "B", q2: "O" }, questionOrder: ["q1", "q2"] });
    const b = readingMessage({ ...reading, results: { q1: "B", q2: "O" }, questionOrder: ["q2", "q1"] });
    expect(a.resultsHash).not.toBe(b.resultsHash);
  });
});

describe("Review", () => {
  const rv = { electionCode: reading.electionCode, ballotCode: reading.ballotCode, results: { q1: "V:c1", q2: "V:c2" }, questionOrder: ["q1", "q2"] };
  it("round-trips and detects tampering", async () => {
    const sig = await signReview(reviewer, rv, domain);
    expect(verifyReview(rv, sig, reviewer.address, domain)).toBe(true);
    expect(verifyReview({ ...rv, results: { q1: "V:c3", q2: "V:c2" } }, sig, reviewer.address, domain)).toBe(false);
    expect(verifyReview(rv, sig, device.address, domain)).toBe(false);
    expect(verifyReview(rv, "0x00", reviewer.address, domain)).toBe(false);
  });
  it("a Review signature is not a valid Reading signature (type separation)", async () => {
    const sig = await signReview(reviewer, rv, domain);
    expect(verifyReading(reading, sig, reviewer.address, domain)).toBe(false);
  });
});

describe("Verifier report", () => {
  const unsigned: UnsignedVerifierReport = {
    schemaVersion: "0.1",
    electionCode: "BEINGS-2026-K7M4Q2",
    tallyVersion: 1,
    node: { address: node.address, operator: "Test node" },
    software: { name: "beings-verifier", version: "0.0.0", omrBuild: "test" },
    ledgerHead: keccakHex("head"),
    scope: { mode: "all", ballotsChecked: 5 },
    hashChecks: { checked: 5, failed: [] },
    readChecks: { ballotQuestionsChecked: 10, agreed: 10, disagreed: 0, disagreements: [] },
    tally: { matches: true },
    reconciliation: { matches: true },
    merkle: { recomputedRoot: keccakHex("root"), matches: true },
    createdAt: "2026-11-21T10:00:00Z",
  };

  it("reportHash ignores the signature field and is over the JCS form", () => {
    expect(reportHash(unsigned)).toBe(keccakJson(unsigned));
    expect(reportHash({ ...unsigned, signature: "0x" + "00".repeat(65) } as VerifierReport)).toBe(reportHash(unsigned));
  });

  it("sign and verify, then detect any edit to the report", async () => {
    const signature = await signReport(node, unsigned, domain);
    const report: VerifierReport = { ...unsigned, signature };
    expect(verifyReport(report, domain)).toBe(true);
    const edited = deepClone(report);
    edited.readChecks.agreed = 9;
    expect(verifyReport(edited, domain)).toBe(false);
    const edited2 = deepClone(report);
    edited2.tallyVersion = 2;
    expect(verifyReport(edited2, domain)).toBe(false);
    expect(verifyReport({ ...report, node: { address: device.address } }, domain)).toBe(false);
    expect(verifyReport({ ...report, signature: "0x12" }, domain)).toBe(false);
  });
});

describe("checkRecordSignatures", () => {
  it("checks every reading and the review of a full record", async () => {
    const mk = async (w: Wallet): Promise<BallotRecord["readings"][number]> => ({
      device: w.address,
      imageSha256: reading.imageSha256,
      fillScores: reading.fillScores,
      results: reading.results,
      signature: await signReading(w, reading, domain),
    });
    const record: BallotRecord = {
      schemaVersion: "0.1",
      electionCode: reading.electionCode,
      ballotCode: reading.ballotCode,
      results: reading.results,
      readings: [await mk(device), await mk(device2)],
      review: { required: false },
    };
    const ok = checkRecordSignatures(record, domain, ["q1", "q2"]);
    expect(ok).toMatchObject({ readingSignaturesValid: [true, true], readingResultsMatchRecord: [true, true], distinctDevices: true, agreeingValidReadings: 2, reviewSignatureValid: undefined });

    // reading 2 claims a different result than the record: valid signature, but disagrees
    const r2 = deepClone(record);
    (r2.readings[1] as BallotRecord["readings"][number]).results = { q1: "V:c2", q2: "V:c2" };
    const c2 = checkRecordSignatures(r2, domain, ["q1", "q2"]);
    expect(c2.readingSignaturesValid).toEqual([true, false]); // the signature covered the original results
    expect(c2.agreeingValidReadings).toBe(1);

    // duplicate device
    const dup = deepClone(record);
    (dup.readings[1] as BallotRecord["readings"][number]).device = device.address;
    expect(checkRecordSignatures(dup, domain, ["q1", "q2"]).distinctDevices).toBe(false);

    // forged signature
    const forged = deepClone(record);
    (forged.readings[0] as BallotRecord["readings"][number]).signature = "0x" + "11".repeat(65);
    expect(checkRecordSignatures(forged, domain, ["q1", "q2"]).readingSignaturesValid).toEqual([false, true]);

    // review
    const rv = { electionCode: reading.electionCode, ballotCode: reading.ballotCode, results: record.results, questionOrder: ["q1", "q2"] };
    const reviewed = deepClone(record);
    reviewed.review = { required: true, reviewer: reviewer.address, reason: "unclear", signature: await signReview(reviewer, rv, domain) };
    expect(checkRecordSignatures(reviewed, domain, ["q1", "q2"]).reviewSignatureValid).toBe(true);
    reviewed.results = { q1: "V:c3", q2: "V:c2" };
    expect(checkRecordSignatures(reviewed, domain, ["q1", "q2"]).reviewSignatureValid).toBe(false);
  });
});
