/**
 * Deterministic cross-language test vectors for @beings/core. Everything here is derived from fixed inputs
 * (the TEST-ONLY private keys below are public and worthless; never use them anywhere real).
 * `npm run gen:vectors -w @beings/core` writes them to test-vectors/*.json; the unit tests fail if the committed
 * files differ from what the code produces, so any behaviour change is a visible diff. The Python port of M7
 * (architecture doc) is meant to be driven by these files.
 */
import { Wallet, getCreateAddress } from "ethers";
import {
  applyCorrections,
  ballotKey,
  ballotListRoot,
  canonicalize,
  deriveQuestionResult,
  eip712Domain,
  electionKey,
  encodeResults,
  entryLeaf,
  keccakHex,
  keccakJson,
  layoutHash,
  sha256Json,
  merkleProof,
  merkleRoot,
  merkleRootOfEntries,
  readingDigest,
  noticeDigest,
  noticeMessage,
  readingMessage,
  recordSha256,
  reconcile,
  reportHash,
  resultsHash,
  scoresHash,
  sha256Hex,
  signNotice,
  signReading,
  signReport,
  signReview,
  tallyQuestions,
  type BallotRecord,
  type Correction,
  type LedgerEntry,
  type NoticeInput,
  type ReadingInput,
  type UnsignedVerifierReport,
} from "../src/index.js";

export const TEST_KEYS = {
  device1: "REDACTED-TEST-VECTOR",
  device2: "REDACTED-TEST-VECTOR",
  reviewer: "REDACTED-TEST-VECTOR",
  node: "REDACTED-TEST-VECTOR",
} as const;

export const ELECTION_CODE = "BEINGS-2026-K7M4Q2";
export const QUESTION_ORDER = ["q1", "q2"] as const;
/** Hardhat account #0 (the deployer in the ledger package tests); public, worthless. */
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/**
 * Contract addresses are those of a fresh chain deployed by DEPLOYER in this order (see packages/ledger scripts/deploy.js):
 * BallotLedger (nonce 0), ElectionRegistry (1), Tally (2), VerifierRegistry (3). Deploying in this order on a fresh
 * network makes these test vectors verify on-chain.
 */
export const VERIFYING_CONTRACT = getCreateAddress({ from: DEPLOYER, nonce: 0 }); // BallotLedger = 0x5FbDB...
export const NOTICE_VERIFYING_CONTRACT = getCreateAddress({ from: DEPLOYER, nonce: 3 }); // VerifierRegistry

const w = (k: keyof typeof TEST_KEYS) => new Wallet(TEST_KEYS[k]);

export const SAMPLE_CODES = ["4F9Q7M2XHT8B", "B3N6D0YK5E1W", "0123456789AB", "CDEFGHJKMNPQ", "RSTVWXYZ0123"];

function sampleEntries(): LedgerEntry[] {
  const mk = (i: number, results: Record<string, string>, reviewed = false): LedgerEntry => ({
    electionCode: ELECTION_CODE,
    ballotCode: SAMPLE_CODES[i] as string,
    results,
    imageSha256: sha256Hex(`image-${i}`),
    recordSha256: sha256Hex(`record-${i}`),
    reviewed,
  });
  return [
    mk(0, { q1: "V:c1", q2: "V:c2" }),
    mk(1, { q1: "U", q2: "V:c1" }, true),
    mk(2, { q1: "B", q2: "O" }),
    mk(3, { q1: "V:c3", q2: "V:c1" }),
    mk(4, { q1: "V:c1", q2: "B" }),
  ];
}

const sampleCorrections = (): Correction[] => [
  { electionCode: ELECTION_CODE, ballotCode: SAMPLE_CODES[1] as string, questionId: "q1", prevIndex: 0, from: "U", to: "V:c2", reason: "faint-mark", by: w("reviewer").address },
  { electionCode: ELECTION_CODE, ballotCode: SAMPLE_CODES[1] as string, questionId: "q1", prevIndex: 1, from: "V:c2", to: "V:c1", reason: "other", by: w("reviewer").address },
];

export async function buildVectors(): Promise<Record<string, unknown>> {
  const domain = eip712Domain({ chainId: 114, verifyingContract: VERIFYING_CONTRACT });

  // --- canonical JSON (RFC 8785) ---
  const canonicalInputs: unknown[] = [
    { b: 2, a: 1 },
    [3, 1, 2],
    { "": 0, "\u20ac": "euro", "\r": "cr", "\ud83d\ude00": "smile", "1": "one", "\u0080": "c1", "\ud83d\udc7b": "ghost" },
    { n: [0, -0, 1e21, 1e-7, 123456789012345680000, 0.000001, 1.5, -1.5, 4.5, 2e-7] },
    { s: "line\nbreak \"quoted\" back\\slash \u0007 \u001f \u007f </script>" },
    { nested: { z: null, y: true, x: false, w: [] , v: {} } },
  ];
  const canonical = canonicalInputs.map((input) => ({ input, canonical: canonicalize(input) }));

  // --- hashes ---
  const hashInputs = ["", "abc", "B.E.I.N.G.S.", "\u00e9\u20ac\ud83d\ude00"];
  const hashes = hashInputs.map((s) => ({ utf8: s, sha256: sha256Hex(s), keccak256: keccakHex(s) }));

  // --- codes and keys ---
  const codes = {
    electionCode: ELECTION_CODE,
    electionKey: electionKey(ELECTION_CODE),
    ballots: SAMPLE_CODES.map((c) => ({ ballotCode: c, ballotKey: ballotKey(c) })),
  };

  // --- merkle ---
  const leafSets = [0, 1, 2, 3, 5, 8].map((n) => {
    const leaves = Array.from({ length: n }, (_, i) => keccakHex(`leaf-${i}`));
    return {
      leaves,
      root: merkleRoot(leaves),
      proofs: leaves.map((l) => ({ leaf: l, proof: merkleProof(leaves, l) })),
    };
  });
  const merkle = { sets: leafSets, ballotListRoot: { codes: SAMPLE_CODES, root: ballotListRoot(SAMPLE_CODES) } };

  // --- results ---
  const rules = { emptyBelow: 15, markedAbove: 50 };
  const derivation = [
    [{ c1: 92, c2: 3, c3: 0 }, 1],
    [{ c1: 0, c2: 0, c3: 0 }, 1],
    [{ c1: 90, c2: 80, c3: 0 }, 1],
    [{ c1: 90, c2: 80, c3: 0 }, 2],
    [{ c1: 90, c2: 30, c3: 0 }, 1],
    [{ c1: 90, c2: 30, c3: 0 }, 2],
    [{ c1: 90, c2: 80, c3: 70 }, 2],
    [{ c1: 15, c2: 50, c3: 0 }, 1],
    [{ c1: 14, c2: 51, c3: 0 }, 1],
    [{ c1: 70, c2: 0, c3: 80 }, 2],
  ].map(([scores, maxMarks]) => ({ scores, maxMarks, rules, result: deriveQuestionResult(scores as Record<string, number>, maxMarks as number, rules) }));
  const encoded = [
    { results: { q1: "V:c1", q2: "V:c2" }, questionOrder: ["q1", "q2"], encoded: encodeResults({ q1: "V:c1", q2: "V:c2" }, ["q1", "q2"]), hash: resultsHash({ q1: "V:c1", q2: "V:c2" }, ["q1", "q2"]) },
    { results: { q10: "B", q2: "V:c1+c3" }, questionOrder: null, encoded: encodeResults({ q10: "B", q2: "V:c1+c3" }), hash: resultsHash({ q10: "B", q2: "V:c1+c3" }) },
  ];

  // --- EIP-712 ---
  const fillScores = { q1: { c1: 92, c2: 3, c3: 0 }, q2: { c1: 2, c2: 88 } };
  const reading: ReadingInput = {
    electionCode: ELECTION_CODE,
    ballotCode: SAMPLE_CODES[0] as string,
    results: { q1: "V:c1", q2: "V:c2" },
    imageSha256: sha256Hex("image-0"),
    fillScores,
    questionOrder: [...QUESTION_ORDER],
  };
  const reviewInput = { electionCode: ELECTION_CODE, ballotCode: SAMPLE_CODES[1] as string, results: { q1: "V:c1", q2: "V:c1" }, questionOrder: [...QUESTION_ORDER] };
  const report: UnsignedVerifierReport = {
    schemaVersion: "0.1",
    electionCode: ELECTION_CODE,
    tallyVersion: 1,
    node: { address: w("node").address, operator: "Test node" },
    software: { name: "beings-verifier", version: "0.0.0", omrBuild: "test" },
    ledgerHead: keccakHex("ledger-head"),
    scope: { mode: "all", ballotsChecked: 5 },
    hashChecks: { checked: 5, failed: [] },
    readChecks: { ballotQuestionsChecked: 10, agreed: 10, disagreed: 0, disagreements: [] },
    tally: { matches: true },
    reconciliation: { matches: true },
    merkle: { recomputedRoot: keccakHex("root"), matches: true },
    createdAt: "2026-11-21T10:00:00Z",
  };
  const noticeInput: NoticeInput = {
    electionCode: ELECTION_CODE,
    tallyVersion: 1,
    reportCid: "bafy-test-report-cid",
    reportSha256: sha256Hex("report-0"),
    ballotQuestionsChecked: 10,
    ballotQuestionsAgreed: 10,
    tallyMatches: true,
    reconciliationMatches: true,
    merkleMatches: true,
    nonce: 0,
  };
  const noticeDomain = eip712Domain({ chainId: 114, verifyingContract: NOTICE_VERIFYING_CONTRACT });
  const notice = {
    note: "[PROPOSED] VerificationNotice for VerifierRegistry.reportVerificationSigned; domain verifyingContract is the VerifierRegistry (4th contract deployed by Hardhat account #0).",
    domain: noticeDomain,
    input: noticeInput,
    message: JSON.parse(JSON.stringify(noticeMessage(noticeInput), (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    digest: noticeDigest(noticeInput, noticeDomain),
    signatureNode: await signNotice(w("node"), noticeInput, noticeDomain),
  };

  const eip712 = {
    note: "TEST-ONLY private keys. Signatures are deterministic (RFC 6979).",
    domain,
    wallets: Object.fromEntries((Object.keys(TEST_KEYS) as (keyof typeof TEST_KEYS)[]).map((k) => [k, { privateKey: TEST_KEYS[k], address: w(k).address }])),
    reading: {
      input: reading,
      scoresHash: scoresHash(fillScores),
      message: readingMessage(reading),
      digest: readingDigest(reading, domain),
      signatureDevice1: await signReading(w("device1"), reading, domain),
    },
    review: { input: reviewInput, signatureReviewer: await signReview(w("reviewer"), reviewInput, domain) },
    report: { unsigned: report, reportHash: reportHash(report), signatureNode: await signReport(w("node"), report, domain) },
    notice,
  };

  // --- tally ---
  const entries = sampleEntries();
  const corrections = sampleCorrections();
  const effective = applyCorrections(entries, corrections);
  const election = {
    questions: [
      { id: "q1", text: "", maxMarks: 1, choices: [{ id: "c1", text: "" }, { id: "c2", text: "" }, { id: "c3", text: "" }] },
      { id: "q2", text: "", maxMarks: 1, choices: [{ id: "c1", text: "" }, { id: "c2", text: "" }] },
    ],
  };
  const tally = {
    entries,
    corrections,
    effectiveResults: effective.map((e) => ({ ballotCode: e.ballotCode, results: e.results })),
    tallyWithoutCorrections: tallyQuestions(entries, [], { election }),
    tallyWithCorrections: tallyQuestions(entries, corrections, { election }),
    leaves: effective.map((e) => ({ ballotCode: e.ballotCode, leaf: entryLeaf(e) })),
    merkleRootWithCorrections: merkleRootOfEntries(entries, corrections),
    merkleRootWithoutCorrections: merkleRootOfEntries(entries, []),
  };

  // --- reconciliation ---
  const base = { registered: 120, issued: 123, unusedReturned: 1 };
  const led = (o: object = {}) => ({ registeredInElectionFile: 120, printed: 130, cast: 119, spoiled: 3, perQuestion: { q1: { valid: 100, blank: 8, overvote: 6, unclear: 5 }, q2: { valid: 105, blank: 9, overvote: 3, unclear: 2 } }, ...o });
  const reconcileCases = [
    { name: "spec 8.3 worked example (all pass)", organizer: base, ledger: led() },
    { name: "spec 11.4 provisional example (R4)", organizer: { ...base, unusedReturned: 0 }, ledger: led() },
    { name: "R1 and R4 (cast > issued)", organizer: { ...base, issued: 118, unusedReturned: 0 }, ledger: led({ spoiled: 0 }) },
    { name: "R2 issued - spoiled > registered", organizer: { ...base, registered: 119 }, ledger: led({ registeredInElectionFile: 119 }) },
    { name: "R3 issued > printed", organizer: base, ledger: led({ printed: 120 }) },
    { name: "R5 question does not sum to cast", organizer: base, ledger: led({ perQuestion: { q1: { valid: 100, blank: 8, overvote: 6, unclear: 4 }, q2: { valid: 105, blank: 9, overvote: 3, unclear: 2 } } }) },
    { name: "R6 register changed", organizer: { ...base, registered: 121 }, ledger: led() },
    { name: "no register: R2 skipped, R6 needs 0 in file", organizer: { ...base, registered: 0 }, ledger: led({ registeredInElectionFile: 0 }) },
  ].map((c) => {
    const r = reconcile(c.organizer, c.ledger);
    return { ...c, failedChecks: r.failedChecks, counts: r.counts };
  });

  // --- full record hash ---
  const record: BallotRecord = {
    schemaVersion: "0.1",
    electionCode: ELECTION_CODE,
    ballotCode: SAMPLE_CODES[0] as string,
    results: reading.results,
    readings: [
      {
        device: w("device1").address,
        imageSha256: reading.imageSha256,
        fillScores,
        results: reading.results,
        signature: eip712.reading.signatureDevice1,
      },
    ],
    review: { required: false },
    scannedOn: "2026-11-20",
  };
  const records = { record, recordSha256: recordSha256(record), jcsKeccak: keccakJson(record) };

  // --- layout hash: a tiny stand-in layout (key order and number formats exercise the canonical form) ---
  const layout = {
    schemaVersion: "0.1",
    layoutVersion: 2,
    electionCode: ELECTION_CODE,
    units: "mm",
    frame: { widthMm: 187.9, heightMm: 214 },
    questions: [{ id: "q1", ovals: [{ choiceId: "c1", center: { x: 18, y: 25.5 }, uv: { x: 0.096, y: 0.119 } }] }],
  };
  const layoutHashes = { layout, canonical: canonicalize(layout), layoutHash: layoutHash(layout), sha256OfCanonical: sha256Json(layout) };

  return { hashes, canonical, codes, merkle, results: { derivation, encoded }, eip712, tally, reconcile: reconcileCases, records, layoutHash: layoutHashes };
}
