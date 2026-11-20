import { TypedDataEncoder, verifyTypedData, getAddress, isAddress, type TypedDataDomain, type TypedDataField } from "ethers";
import { BeingsError } from "./errors.js";
import { ballotKey, electionKey } from "./codes.js";
import { keccakHex, keccakJson } from "./hash.js";
import { type Hex } from "./hex.js";
import { encodeResults, resultsHash } from "./results.js";
import type { BallotRecord, FillScores, Results, UnsignedVerifierReport, VerifierReport } from "./types.js";

/** Flare Coston2 testnet chain ID (spec 13). */
export const COSTON2_CHAIN_ID = 114;
/** EIP-712 domain `name` for every B.E.I.N.G.S. signature. */
export const DOMAIN_NAME = "B.E.I.N.G.S.";
export const DOMAIN_VERSION = "1";

/**
 * EIP-712 domain. [PROPOSED] (the spec names the typed structs but not the domain): name "B.E.I.N.G.S.",
 * version "1", chainId (default Coston2 = 114) and, when known, the `verifyingContract` that checks the signature
 * on-chain (BallotLedger for Reading and Review, VerifierRegistry for VerifierReport). Without a
 * verifyingContract the field is left out of the domain entirely (for off-chain-only use and tests).
 * The contract author must use the same domain; see README.
 */
export function eip712Domain(opts: { chainId?: number; verifyingContract?: string } = {}): TypedDataDomain {
  const chainId = opts.chainId ?? COSTON2_CHAIN_ID;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new BeingsError("BAD_INPUT", "chainId must be a positive integer");
  const domain: TypedDataDomain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId };
  if (opts.verifyingContract !== undefined) {
    if (!isAddress(opts.verifyingContract)) throw new BeingsError("BAD_INPUT", "verifyingContract is not an address");
    domain.verifyingContract = getAddress(opts.verifyingContract.toLowerCase());
  }
  return domain;
}

/**
 * EIP-712 type definitions. `Reading` is exactly as in spec 10.2:
 *   Reading(bytes32 electionKey, bytes32 ballotKey, bytes32 resultsHash, bytes32 imageSha256, bytes32 scoresHash)
 * `Review` and `VerifierReport` are [PROPOSED] from the spec's prose (reviewer signs keccak256(results);
 * node signs keccak256(JCS(report without signature))).
 */
export const READING_TYPES: Record<string, TypedDataField[]> = {
  Reading: [
    { name: "electionKey", type: "bytes32" },
    { name: "ballotKey", type: "bytes32" },
    { name: "resultsHash", type: "bytes32" },
    { name: "imageSha256", type: "bytes32" },
    { name: "scoresHash", type: "bytes32" },
  ],
};
export const REVIEW_TYPES: Record<string, TypedDataField[]> = {
  Review: [
    { name: "electionKey", type: "bytes32" },
    { name: "ballotKey", type: "bytes32" },
    { name: "resultsHash", type: "bytes32" },
  ],
};
export const REPORT_TYPES: Record<string, TypedDataField[]> = {
  VerifierReport: [
    { name: "electionKey", type: "bytes32" },
    { name: "tallyVersion", type: "uint32" },
    { name: "reportHash", type: "bytes32" },
  ],
};

export interface TypedData<M> {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: M;
}

/** Anything that can sign EIP-712 data: an ethers `Wallet` / `HDNodeWallet` / `Signer`, a JSON-RPC signer, ... */
export interface TypedDataSigner {
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string>;
}

/** What a phone signs for one ballot. */
export interface ReadingInput {
  electionCode: string;
  ballotCode: string;
  /** This phone's results for ALL questions. */
  results: Results;
  /** SHA-256 hex (64 chars, optional 0x) of the redacted image this phone produced. */
  imageSha256: string;
  /** This phone's fill-score table, questionId -> choiceId -> 0-100. */
  fillScores: FillScores;
  /** Question order used to join `results` (election file order). Default: numeric question-ID order. */
  questionOrder?: readonly string[];
}

export interface ReadingMessage {
  electionKey: Hex;
  ballotKey: Hex;
  resultsHash: Hex;
  imageSha256: Hex;
  scoresHash: Hex;
}

function imageToBytes32(sha256hex: string): Hex {
  const h = sha256hex.startsWith("0x") ? sha256hex.slice(2) : sha256hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new BeingsError("BAD_HEX", "imageSha256 must be 64 hex characters");
  return `0x${h.toLowerCase()}`;
}

/** `scoresHash`: keccak256 of the JCS canonical fill-score table. */
export function scoresHash(fillScores: FillScores): Hex {
  return keccakJson(fillScores);
}

export function readingMessage(r: ReadingInput): ReadingMessage {
  return {
    electionKey: electionKey(r.electionCode),
    ballotKey: ballotKey(r.ballotCode),
    resultsHash: resultsHash(r.results, r.questionOrder),
    imageSha256: imageToBytes32(r.imageSha256),
    scoresHash: scoresHash(r.fillScores),
  };
}

export function readingTypedData(r: ReadingInput, domain: TypedDataDomain = eip712Domain()): TypedData<ReadingMessage> {
  return { domain, types: READING_TYPES, primaryType: "Reading", message: readingMessage(r) };
}

/** EIP-712 digest for a reading (what the device's key actually signs). */
export function readingDigest(r: ReadingInput, domain: TypedDataDomain = eip712Domain()): Hex {
  return TypedDataEncoder.hash(domain, READING_TYPES, readingMessage(r)) as Hex;
}

/** Sign a reading with a device key. Returns the 65-byte signature as 0x + 130 hex characters. */
export async function signReading(signer: TypedDataSigner, r: ReadingInput, domain: TypedDataDomain = eip712Domain()): Promise<Hex> {
  return (await signer.signTypedData(domain, READING_TYPES, { ...readingMessage(r) })) as Hex;
}

/** Address (EIP-55) that signed, or undefined if the signature is malformed (including high-s malleable form). */
function recover(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, message: Record<string, unknown>, signature: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return undefined;
  try {
    return verifyTypedData(domain, types, message, signature);
  } catch {
    return undefined;
  }
}

export function recoverReadingSigner(r: ReadingInput, signature: string, domain: TypedDataDomain = eip712Domain()): string | undefined {
  return recover(domain, READING_TYPES, { ...readingMessage(r) }, signature);
}

/** True iff `signature` is a valid EIP-712 signature over this reading by `expectedDevice`. Never throws on bad signatures. */
export function verifyReading(r: ReadingInput, signature: string, expectedDevice: string, domain: TypedDataDomain = eip712Domain()): boolean {
  if (!isAddress(expectedDevice)) return false;
  const who = recoverReadingSigner(r, signature, domain);
  return who !== undefined && who === getAddress(expectedDevice.toLowerCase());
}

// ---- Review (human reviewer signs the final results) ----

export interface ReviewInput {
  electionCode: string;
  ballotCode: string;
  results: Results;
  questionOrder?: readonly string[];
}

function reviewMessage(r: ReviewInput) {
  return { electionKey: electionKey(r.electionCode), ballotKey: ballotKey(r.ballotCode), resultsHash: resultsHash(r.results, r.questionOrder) };
}

export async function signReview(signer: TypedDataSigner, r: ReviewInput, domain: TypedDataDomain = eip712Domain()): Promise<Hex> {
  return (await signer.signTypedData(domain, REVIEW_TYPES, reviewMessage(r))) as Hex;
}

export function verifyReview(r: ReviewInput, signature: string, expectedReviewer: string, domain: TypedDataDomain = eip712Domain()): boolean {
  if (!isAddress(expectedReviewer)) return false;
  const who = recover(domain, REVIEW_TYPES, reviewMessage(r), signature);
  return who !== undefined && who === getAddress(expectedReviewer.toLowerCase());
}

// ---- Verifier report ----

/** keccak256 of the JCS form of the report WITHOUT its `signature` field (spec 11.5). */
export function reportHash(report: UnsignedVerifierReport | VerifierReport): Hex {
  const { signature: _ignored, ...rest } = report as VerifierReport;
  void _ignored;
  return keccakJson(rest);
}

function reportMessage(report: UnsignedVerifierReport | VerifierReport) {
  return { electionKey: electionKey(report.electionCode), tallyVersion: report.tallyVersion, reportHash: reportHash(report) };
}

export function reportTypedData(report: UnsignedVerifierReport | VerifierReport, domain: TypedDataDomain = eip712Domain()) {
  return { domain, types: REPORT_TYPES, primaryType: "VerifierReport", message: reportMessage(report) };
}

/** Sign a verifier report with the node key. Returns the signature; use `withSignature` or set `report.signature`. */
export async function signReport(signer: TypedDataSigner, report: UnsignedVerifierReport | VerifierReport, domain: TypedDataDomain = eip712Domain()): Promise<Hex> {
  return (await signer.signTypedData(domain, REPORT_TYPES, reportMessage(report))) as Hex;
}

/** True iff `report.signature` is valid and made by `report.node.address`. */
export function verifyReport(report: VerifierReport, domain: TypedDataDomain = eip712Domain()): boolean {
  if (!isAddress(report.node.address)) return false;
  const who = recover(domain, REPORT_TYPES, reportMessage(report), report.signature);
  return who !== undefined && who === getAddress(report.node.address.toLowerCase());
}

// ---- Verification notice (on-chain VerifierRegistry.reportVerificationSigned) ----

/**
 * [PROPOSED] EIP-712 type for the on-chain notice a verifier node signs so a relayer can submit it:
 * it binds EVERY argument the VerifierRegistry stores (counts, flags, report pointer and a per-node nonce), which the
 * `VerifierReport` signature (a hash of the report file) cannot. Domain verifyingContract = the VerifierRegistry.
 */
export const NOTICE_TYPES: Record<string, TypedDataField[]> = {
  VerificationNotice: [
    { name: "electionKey", type: "bytes32" },
    { name: "tallyVersion", type: "uint32" },
    { name: "reportCidHash", type: "bytes32" },
    { name: "reportSha256", type: "bytes32" },
    { name: "ballotQuestionsChecked", type: "uint64" },
    { name: "ballotQuestionsAgreed", type: "uint64" },
    { name: "tallyMatches", type: "bool" },
    { name: "reconciliationMatches", type: "bool" },
    { name: "merkleMatches", type: "bool" },
    { name: "nonce", type: "uint256" },
  ],
};

export interface NoticeInput {
  electionCode: string;
  tallyVersion: number;
  /** The report's content id (stored on-chain as a string; signed as its keccak256). */
  reportCid: string;
  /** SHA-256 hex (64 chars, optional 0x) of the report file. */
  reportSha256: string;
  ballotQuestionsChecked: number | bigint;
  ballotQuestionsAgreed: number | bigint;
  tallyMatches: boolean;
  reconciliationMatches: boolean;
  merkleMatches: boolean;
  /** Must equal VerifierRegistry.nonces(node) when submitted. */
  nonce: number | bigint;
}

export function noticeMessage(n: NoticeInput) {
  return {
    electionKey: electionKey(n.electionCode),
    tallyVersion: n.tallyVersion,
    reportCidHash: keccakHex(n.reportCid),
    reportSha256: imageToBytes32(n.reportSha256),
    ballotQuestionsChecked: BigInt(n.ballotQuestionsChecked),
    ballotQuestionsAgreed: BigInt(n.ballotQuestionsAgreed),
    tallyMatches: n.tallyMatches,
    reconciliationMatches: n.reconciliationMatches,
    merkleMatches: n.merkleMatches,
    nonce: BigInt(n.nonce),
  };
}

export function noticeDigest(n: NoticeInput, domain: TypedDataDomain = eip712Domain()): Hex {
  return TypedDataEncoder.hash(domain, NOTICE_TYPES, noticeMessage(n)) as Hex;
}

export async function signNotice(signer: TypedDataSigner, n: NoticeInput, domain: TypedDataDomain = eip712Domain()): Promise<Hex> {
  return (await signer.signTypedData(domain, NOTICE_TYPES, noticeMessage(n))) as Hex;
}

export function verifyNotice(n: NoticeInput, signature: string, expectedNode: string, domain: TypedDataDomain = eip712Domain()): boolean {
  if (!isAddress(expectedNode)) return false;
  const who = recover(domain, NOTICE_TYPES, noticeMessage(n), signature);
  return who !== undefined && who === getAddress(expectedNode.toLowerCase());
}

// ---- Whole record check ----

export interface RecordCheck {
  /** One entry per reading: signature valid for `reading.device` over the reading's own results/image/scores. */
  readingSignaturesValid: boolean[];
  /** One entry per reading: reading.results equals the record's results. */
  readingResultsMatchRecord: boolean[];
  /** Distinct device addresses across the readings. */
  distinctDevices: boolean;
  /** Undefined when no review is present; otherwise whether the reviewer's signature over record.results is valid. */
  reviewSignatureValid: boolean | undefined;
  /** Number of readings that are valid AND agree with the record's results. */
  agreeingValidReadings: number;
}

/**
 * Offline check of a full ballot record's signatures (what the BallotLedger does on-chain, minus the device roles).
 * Pure; does not decide acceptance: compare `agreeingValidReadings` with the election's quorum yourself
 * (or a valid review), and check `devices` against the election's deviceAddresses.
 * `questionOrder` = election file question order (default numeric).
 */
export function checkRecordSignatures(record: BallotRecord, domain: TypedDataDomain = eip712Domain(), questionOrder?: readonly string[]): RecordCheck {
  const sigOk: boolean[] = [];
  const agree: boolean[] = [];
  for (const rd of record.readings) {
    let ok = false;
    let same = false;
    try {
      ok = verifyReading(
        { electionCode: record.electionCode, ballotCode: record.ballotCode, results: rd.results, imageSha256: rd.imageSha256, fillScores: rd.fillScores, questionOrder },
        rd.signature,
        rd.device,
        domain,
      );
      same = encodeResults(rd.results, questionOrder) === encodeResults(record.results, questionOrder);
    } catch {
      /* malformed readings count as invalid */
    }
    sigOk.push(ok);
    agree.push(same);
  }
  const devices = record.readings.map((r) => (isAddress(r.device) ? getAddress(r.device.toLowerCase()) : r.device));
  let reviewSignatureValid: boolean | undefined;
  if (record.review.signature !== undefined && record.review.reviewer !== undefined) {
    try {
      reviewSignatureValid = verifyReview({ electionCode: record.electionCode, ballotCode: record.ballotCode, results: record.results, questionOrder }, record.review.signature, record.review.reviewer, domain);
    } catch {
      reviewSignatureValid = false;
    }
  }
  return {
    readingSignaturesValid: sigOk,
    readingResultsMatchRecord: agree,
    distinctDevices: new Set(devices).size === devices.length,
    reviewSignatureValid,
    agreeingValidReadings: sigOk.filter((v, i) => v && agree[i]).length,
  };
}

