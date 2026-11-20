import { BeingsError } from "./errors.js";
import { ballotKey } from "./codes.js";
import { keccakHex } from "./hash.js";
import { concatBytes, hexToBytes, toBytes32, type Hex } from "./hex.js";
import { ZERO_ROOT, merkleRoot } from "./merkle.js";
import { bubbleState, deriveResults, encodeResults, type BubbleState } from "./results.js";
import type { ConsensusThresholdsFile, ElectionQuestion, FillScores, ResultRules, Results, ThresholdPair } from "./types.js";

/**
 * Three-threshold Merkle consensus (spec 7.2).
 *
 * The same fill scores (0-100 per oval, computed once) are turned into a results string three times:
 *   A tight    — emptyBelow 10, markedAbove 55
 *   B standard — the election's own resultRules (default 15 / 50)
 *   C loose    — emptyBelow 20, markedAbove 45
 * Each pass builds one Merkle root. Matching roots mean the batch does not depend on the exact threshold.
 * A mismatch names the ballots, questions and ovals that moved, for a person to look at.
 *
 * Leaf (documented, deterministic):
 *   key    = keccak256(UTF-8 ballot code) when every ballot in the batch has a code,
 *            otherwise the 32-byte imageSha256 (used when codes must stay private).
 *            One batch uses one kind of key. The two trees are not comparable with each other.
 *   leaf   = keccak256( key (32 bytes) || keccak256(UTF-8 results string) (32 bytes) )
 *   order  = those leaves sorted ascending by byte order, then the sorted-pair tree in merkle.ts
 *            (parent = keccak256(min || max), a leftover node is promoted, empty root is 32 zero bytes).
 * Scan order does not change the root. Ballot codes are an input only. They are never written out.
 */
export const CONSENSUS_KIND = "beings-consensus/1";

export const CONSENSUS_LEAF_ORDER =
  "Leaves are keccak256(key || keccak256(results string)), sorted ascending by that hash before sorted-pair hashing. The report lists ballots by key, ascending.";

export const DEFAULT_TIGHT_RULES = { emptyBelow: 10, markedAbove: 55 } as const;
export const DEFAULT_STANDARD_RULES = { emptyBelow: 15, markedAbove: 50 } as const;
export const DEFAULT_LOOSE_RULES = { emptyBelow: 20, markedAbove: 45 } as const;

export type ConsensusPass = "tight" | "standard" | "loose";

export interface ConsensusThresholds {
  tight: ThresholdPair;
  standard: ThresholdPair;
  loose: ThresholdPair;
}

export interface ConsensusElection {
  /** Choice text is not used. A masked verifier file may omit it. */
  questions: { id: string; maxMarks: number; choices: { id: string }[] }[];
  resultRules: Pick<ResultRules, "emptyBelow" | "markedAbove">;
  consensusThresholds?: ConsensusThresholdsFile;
}

export interface ConsensusBallot {
  /** Used only to derive keccak256(code). Never copied into the report. */
  ballotCode?: string;
  /** 32 bytes of hex, with or without 0x. The leaf key when no code is given. */
  imageSha256?: string;
  fillScores: FillScores;
  /** Sheet number at the station. Not a secret. */
  page?: number;
}

export interface ConsensusOval {
  question: string;
  choice: string;
  fillScore: number;
  tight: BubbleState;
  standard: BubbleState;
  loose: BubbleState;
}

export interface ConsensusQuestion {
  id: string;
  tight: string;
  standard: string;
  loose: string;
}

export interface ConsensusFlag {
  ballotKey: Hex;
  imageSha256?: string;
  page?: number;
  /** Same idea as an unclear mark: a person compares the paper before this sheet is signed. */
  review: "human";
  questions: ConsensusQuestion[];
  ovals: ConsensusOval[];
}

export interface ConsensusReport {
  kind: typeof CONSENSUS_KIND;
  passed: boolean;
  needsHumanReview: boolean;
  keyMode: "ballotKey" | "imageSha256";
  leafOrder: typeof CONSENSUS_LEAF_ORDER;
  thresholds: ConsensusThresholds;
  roots: Record<ConsensusPass, Hex>;
  ballots: number;
  flags: ConsensusFlag[];
}

export function resolveConsensusThresholds(election: ConsensusElection): ConsensusThresholds {
  const file = election.consensusThresholds ?? {};
  const standard = file.standard ?? {
    emptyBelow: election.resultRules?.emptyBelow ?? DEFAULT_STANDARD_RULES.emptyBelow,
    markedAbove: election.resultRules?.markedAbove ?? DEFAULT_STANDARD_RULES.markedAbove,
  };
  return {
    tight: assertPair("tight", file.tight ?? DEFAULT_TIGHT_RULES),
    standard: assertPair("standard", standard),
    loose: assertPair("loose", file.loose ?? DEFAULT_LOOSE_RULES),
  };
}

function assertPair(name: string, pair: ThresholdPair): ThresholdPair {
  if (!pair || typeof pair !== "object") throw new BeingsError("BAD_INPUT", `${name} thresholds are missing`);
  for (const key of ["emptyBelow", "markedAbove"] as const) {
    const n = pair[key];
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      throw new BeingsError("BAD_INPUT", `${name}.${key} must be an integer 0-100`);
    }
  }
  if (pair.emptyBelow > pair.markedAbove + 1) {
    throw new BeingsError("BAD_INPUT", `${name}: emptyBelow must be <= markedAbove + 1`);
  }
  return { emptyBelow: pair.emptyBelow, markedAbove: pair.markedAbove };
}

function imageKey(imageSha256: string): Hex {
  const h = imageSha256.startsWith("0x") || imageSha256.startsWith("0X") ? imageSha256.slice(2) : imageSha256;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new BeingsError("BAD_INPUT", "imageSha256 must be 32 bytes of hex");
  return toBytes32(`0x${h}`);
}

function displayImage(imageSha256: string | undefined): string | undefined {
  if (!imageSha256) return undefined;
  return imageKey(imageSha256).slice(2);
}

/** keccak256(key || keccak256(results string)). */
export function consensusLeaf(key: Hex, resultsString: string): Hex {
  return keccakHex(concatBytes(hexToBytes(toBytes32(key)), hexToBytes(keccakHex(resultsString))));
}

interface Prepared {
  key: Hex;
  imageSha256?: string;
  page?: number;
  fillScores: FillScores;
  byPass: Record<ConsensusPass, { results: Results; resultsString: string }>;
}

function prepareBallot(election: ConsensusElection, ballot: ConsensusBallot, thresholds: ConsensusThresholds, keyMode: "ballotKey" | "imageSha256"): Prepared {
  const key = keyMode === "ballotKey" ? ballotKey(ballot.ballotCode ?? "") : imageKey(ballot.imageSha256 ?? "");
  const byPass = {} as Prepared["byPass"];
  for (const pass of ["tight", "standard", "loose"] as const) {
    const rules: ResultRules = {
      emptyBelow: thresholds[pass].emptyBelow,
      markedAbove: thresholds[pass].markedAbove,
      results: ["V", "B", "O", "U"],
    };
    const results = deriveResults({ questions: election.questions as ElectionQuestion[], resultRules: rules }, ballot.fillScores);
    const resultsString = encodeResults(results, election.questions.map((q) => q.id));
    byPass[pass] = { results, resultsString };
  }
  const imageSha256 = displayImage(ballot.imageSha256);
  return {
    key,
    ...(imageSha256 ? { imageSha256 } : {}),
    ...(ballot.page !== undefined ? { page: ballot.page } : {}),
    fillScores: ballot.fillScores,
    byPass,
  };
}

function flagFor(election: ConsensusElection, row: Prepared, thresholds: ConsensusThresholds): ConsensusFlag | null {
  const questions: ConsensusQuestion[] = [];
  const ovals: ConsensusOval[] = [];
  for (const q of election.questions) {
    const tight = row.byPass.tight.results[q.id] as string;
    const standard = row.byPass.standard.results[q.id] as string;
    const loose = row.byPass.loose.results[q.id] as string;
    if (tight !== standard || standard !== loose) questions.push({ id: q.id, tight, standard, loose });
    const scores = row.fillScores[q.id] ?? {};
    for (const c of q.choices) {
      const fillScore = scores[c.id] as number;
      const states = {
        tight: bubbleState(fillScore, thresholds.tight),
        standard: bubbleState(fillScore, thresholds.standard),
        loose: bubbleState(fillScore, thresholds.loose),
      };
      if (states.tight !== states.standard || states.standard !== states.loose) {
        ovals.push({ question: q.id, choice: c.id, fillScore, ...states });
      }
    }
  }
  if (!questions.length && !ovals.length) return null;
  return {
    ballotKey: row.key,
    ...(row.imageSha256 ? { imageSha256: row.imageSha256 } : {}),
    ...(row.page !== undefined ? { page: row.page } : {}),
    review: "human",
    questions,
    ovals,
  };
}

/**
 * Compare three readings of the same fill scores. `ballotCode`, when passed, is hashed and then dropped.
 * The returned object never contains a ballot code.
 */
export function consensusReport(election: ConsensusElection, ballots: readonly ConsensusBallot[]): ConsensusReport {
  if (!election?.questions?.length) throw new BeingsError("BAD_INPUT", "consensus needs the election questions");
  const thresholds = resolveConsensusThresholds(election);
  const codes = ballots.map((b) => b.ballotCode).filter((c): c is string => typeof c === "string" && c.length > 0);
  const coded = ballots.filter((b) => b.ballotCode);
  if (coded.length && coded.length !== ballots.length) {
    throw new BeingsError("BAD_INPUT", "consensus ballots must all use a ballot key, or all use an image hash");
  }
  const keyMode = coded.length ? "ballotKey" : "imageSha256";
  const rows = ballots.map((b) => prepareBallot(election, b, thresholds, keyMode));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) throw new BeingsError("BAD_INPUT", "duplicate ballot key in consensus");
    seen.add(row.key);
  }
  const roots = {} as Record<ConsensusPass, Hex>;
  for (const pass of ["tight", "standard", "loose"] as const) {
    const leaves = rows.map((row) => consensusLeaf(row.key, row.byPass[pass].resultsString));
    roots[pass] = leaves.length ? merkleRoot(leaves) : ZERO_ROOT;
  }
  const passed = roots.tight === roots.standard && roots.standard === roots.loose;
  const flags = passed ? [] : rows.map((row) => flagFor(election, row, thresholds)).filter((f): f is ConsensusFlag => f !== null);
  const report: ConsensusReport = {
    kind: CONSENSUS_KIND,
    passed,
    needsHumanReview: !passed,
    keyMode,
    leafOrder: CONSENSUS_LEAF_ORDER,
    thresholds,
    roots,
    ballots: rows.length,
    flags,
  };
  assertNoBallotCodes(report, codes);
  return report;
}

function assertNoBallotCodes(report: unknown, codes: string[]): void {
  const text = JSON.stringify(report);
  for (const code of codes) {
    if (text.includes(JSON.stringify(code))) throw new BeingsError("BAD_INPUT", "consensus report would include a ballot code");
  }
}

/** Plain-language summary. Safe to print: it is built only from the report. */
export function formatConsensusSummary(report: ConsensusReport): string {
  const t = report.thresholds;
  const band = (p: ConsensusPass) => `${p} ${t[p].emptyBelow}/${t[p].markedAbove}`;
  const sheets = (n: number) => `${n} ${n === 1 ? "ballot" : "ballots"}`;
  const lines = [
    report.passed
      ? `Consensus: the three readings of these same scans agree (${sheets(report.ballots)}).`
      : `Consensus: the three readings do not agree. ${sheets(report.flags.length)} flagged for a human look.`,
    `Thresholds: ${band("tight")} (pass A), ${band("standard")} (pass B), ${band("loose")} (pass C).`,
    `Roots: tight ${report.roots.tight}`,
    `       standard ${report.roots.standard}`,
    `       loose ${report.roots.loose}`,
  ];
  if (report.passed) lines.push("Nothing in this check was signed.");
  for (const f of report.flags) {
    const who = [f.page !== undefined ? `page ${f.page}` : "", f.imageSha256 ? `image ${f.imageSha256.slice(0, 12)}` : "", `key ${f.ballotKey.slice(0, 10)}`].filter(Boolean).join(", ");
    lines.push(`  ${who}`);
    for (const q of f.questions) lines.push(`    ${q.id}: tight ${q.tight}, standard ${q.standard}, loose ${q.loose}`);
    for (const o of f.ovals) lines.push(`    ${o.question}/${o.choice} fill ${o.fillScore}: tight ${o.tight}, standard ${o.standard}, loose ${o.loose}`);
  }
  if (!report.passed) lines.push("A person should look at the flagged sheets before anything is signed.");
  return lines.join("\n");
}
