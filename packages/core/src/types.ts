import type { Hex } from "./hex.js";

/** Hand-written types matching the JSON Schemas in `schemas/` (spec section 11, schemaVersion 0.1). */
export const SCHEMA_VERSION = "0.1" as const;

/** `V:c1`, `V:c1+c3`, `B`, `O` or `U` (spec 7.1). */
export type ResultString = string;
/** questionId -> result string */
export type Results = Record<string, ResultString>;
/** questionId -> choiceId -> fill score 0-100 */
export type FillScores = Record<string, Record<string, number>>;

export interface ElectionQuestion {
  id: string;
  text: string;
  maxMarks: number;
  choices: { id: string; text: string }[];
}

export interface ResultRules {
  emptyBelow: number;
  markedAbove: number;
  results: ["V", "B", "O", "U"];
  abstainButton?: boolean;
}

/** One fill-score pair. score < emptyBelow is empty; score > markedAbove is marked. */
export interface ThresholdPair {
  emptyBelow: number;
  markedAbove: number;
}

/**
 * Optional election-file field for the three-threshold re-read (spec 7.2).
 * A missing pair uses the default: tight 10/55, standard = resultRules, loose 20/45.
 */
export interface ConsensusThresholdsFile {
  tight?: ThresholdPair;
  standard?: ThresholdPair;
  loose?: ThresholdPair;
}

export interface ElectionFile {
  schemaVersion: "0.1";
  electionCode: string;
  version: number;
  supersedes?: string;
  name: string;
  organizerPublicKey: string;
  deviceAddresses?: string[];
  questions: ElectionQuestion[];
  resultRules: ResultRules;
  /** Optional. Three fill-score pairs for consensus. Omitted pairs use the spec defaults. */
  consensusThresholds?: ConsensusThresholdsFile;
  privacy: {
    redactImages: boolean;
    publishOrder: "sorted" | "shuffled";
    timeGranularity: "event" | "day" | "hour";
    minBreakdownSize: number;
  };
  imageStore?: { type: "ipfs" | "image-database" | "other"; description?: string };
  imageRetention?: {
    basis: "jurisdiction-rules" | "organizer-policy";
    ruleReference?: string;
    days?: number;
    afterRetention: "delete" | "officials-hold";
  };
  registeredVoters: number;
  ballotCodes: string[];
  /** SHA-256 hex of the canonical JSON of the ballot layout file. Optional for older files; written by M2. */
  layoutHash?: string;
  approvedAppHashes: string[];
  quorum: number;
  opensAt: string;
  closesAt: string;
}

export interface BallotReading {
  device: string;
  imageSha256: string;
  rawImageSha256?: string;
  imageRef?: string;
  fillScores: FillScores;
  results: Results;
  signature: string;
}

export interface BallotRecord {
  schemaVersion: "0.1";
  electionCode: string;
  ballotCode: string;
  results: Results;
  readings: BallotReading[];
  review: {
    required: boolean;
    reviewer?: string;
    reason?: "disagreement" | "unclear";
    signature?: string;
  };
  scannedOn?: string;
}

export interface LedgerEntry {
  electionCode: string;
  ballotCode: string;
  results: Results;
  imageSha256: string;
  recordSha256: string;
  reviewed: boolean;
}

export type CorrectionReason =
  | "faint-mark"
  | "erasure"
  | "stray-mark"
  | "glare-or-alignment"
  | "phone-misread"
  | "other";

export interface Correction {
  electionCode: string;
  ballotCode: string;
  questionId: string;
  /** 0 = the original record; otherwise the 1-based index of the correction this one replaces. */
  prevIndex: number;
  from: ResultString;
  to: ResultString;
  reason: CorrectionReason;
  note?: string;
  evidenceCid?: string;
  by: string;
}

export interface QuestionTally {
  valid: number;
  blank: number;
  overvote: number;
  unclear: number;
  byChoice?: Record<string, number>;
}

export interface ReconciliationCounts {
  registered: number;
  printed: number;
  issued: number;
  cast: number;
  spoiled: number;
  unusedReturned: number;
  unissued: number;
}

export interface TallyFile {
  schemaVersion: "0.1";
  electionCode: string;
  version: number;
  merkleRoot: Hex;
  perQuestion: Record<string, QuestionTally>;
  reconciliation: ReconciliationCounts;
  checks: {
    R1_castLeIssued: boolean;
    R2_issuedLeRegistered: boolean;
    R3_issuedLePrinted: boolean;
    R4_issuedEqualsParts: boolean;
    R5_questionSums: boolean;
    R6_registeredMatchesFile: boolean;
    [extra: string]: boolean;
  };
  status: "final" | "provisional";
  review?: { required: boolean; clearedBy?: string; clearanceCid?: string };
}

export interface VerifierReport {
  schemaVersion: "0.1";
  electionCode: string;
  tallyVersion: number;
  node: { address: string; operator?: string };
  software: { name: string; version: string; omrBuild: string; sourceSha256?: string };
  ledgerHead: Hex;
  scope: { mode: "all" | "sample"; ballotsChecked: number; sampleSeed?: string };
  hashChecks: {
    checked: number;
    failed: {
      ballotCode: string;
      reason: "hash-mismatch" | "image-missing" | "image-retired" | "image-unreadable";
    }[];
  };
  readChecks: {
    ballotQuestionsChecked: number;
    agreed: number;
    disagreed: number;
    disagreements: {
      ballotCode: string;
      questionId: string;
      posted: ResultString;
      nodeReading: ResultString;
      nodeFill?: Record<string, number>;
      postedWasReviewed?: boolean;
    }[];
  };
  tally: { matches: boolean };
  reconciliation: { matches: boolean; failedChecks?: number };
  merkle: { recomputedRoot: Hex; matches: boolean };
  createdAt: string;
  signature: string;
}

export type UnsignedVerifierReport = Omit<VerifierReport, "signature">;
