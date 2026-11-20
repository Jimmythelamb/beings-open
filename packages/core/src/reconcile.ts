import { BeingsError } from "./errors.js";
import type { Hex } from "./hex.js";
import type { QuestionTally, ReconciliationCounts, TallyFile } from "./types.js";

/** Bit mask values (spec 10.3). 0 = every check passed. */
export const CHECK_BITS = {
  R1: 1,
  R2: 2,
  R3: 4,
  R4: 8,
  R5: 16,
  R6: 32,
} as const;
export type RuleId = keyof typeof CHECK_BITS;
export const RULE_IDS = Object.keys(CHECK_BITS) as RuleId[];
export const ALL_CHECKS_MASK = 63;

/** Keys of the `checks` object in the tally file (spec 11.4). */
export const CHECK_KEYS: Record<RuleId, string> = {
  R1: "R1_castLeIssued",
  R2: "R2_issuedLeRegistered",
  R3: "R3_issuedLePrinted",
  R4: "R4_issuedEqualsParts",
  R5: "R5_questionSums",
  R6: "R6_registeredMatchesFile",
};

/** Counts supplied by the organizer (from M1 check-in counts and the register). */
export interface OrganizerCounts {
  /** Registered voters at the close; 0 = no register used. */
  registered: number;
  /** Ballots handed out including replacements for spoiled ballots. */
  issued: number;
  /** Issued, returned unmarked or not cast, and not replaced. */
  unusedReturned: number;
}

/** Counts read from the ledger, the registry and the election file. */
export interface LedgerCounts {
  /** `registeredVoters` as fixed in the election file / registry before the vote (for R6). */
  registeredInElectionFile: number;
  /** Ballots printed incl. spares (length of the election file's ballot code list; registry `ballotCount`). */
  printed: number;
  /** Ballots with an accepted record on the ledger (`recordCount`). */
  cast: number;
  /** Spoiled ballots on the ledger (`spoiledCount`). */
  spoiled: number;
  /** Per-question tallies (from tallyQuestions, corrections applied). */
  perQuestion: Record<string, Pick<QuestionTally, "valid" | "blank" | "overvote" | "unclear">>;
  /** Optional: the election's question IDs. If given, a missing question fails R5. */
  expectedQuestions?: readonly string[];
}

export interface RuleDetail {
  rule: RuleId;
  bit: number;
  passed: boolean;
  skipped: boolean;
  message: string;
}

export interface ReconcileResult {
  /** Bit mask of FAILED checks (1 R1, 2 R2, 4 R3, 8 R4, 16 R5, 32 R6); 0 = all passed. */
  failedChecks: number;
  /** true = passed, per rule (the tally file's `checks` object). */
  checks: Record<RuleId, boolean>;
  details: RuleDetail[];
  /** The reconciliation counts block of the tally file (spec 11.4). */
  counts: ReconciliationCounts;
}

function assertCount(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new BeingsError("BAD_INPUT", `${name} must be a non-negative integer, got ${v}`);
}

/**
 * Count reconciliation, rules R1 to R6 (spec 8.3 and 10.3). Pure.
 *
 *  R1 cast <= issued
 *  R2 issued - spoiled <= registered   (skipped = passes when registered == 0, i.e. no register)
 *  R3 issued <= printed
 *  R4 issued == cast + spoiled + unusedReturned
 *  R5 for every question: valid + blank + overvote + unclear == cast
 *  R6 registered (at close) == registeredInElectionFile
 *
 * A failing rule never throws: it sets its bit. Malformed counts (negative, fractional) DO throw.
 * `counts.unissued` in the result is printed - issued, clamped at 0 because the tally schema requires a
 * non-negative count (R3 reports the underlying problem). Resolves a spec gap: the contract's unissued is a
 * uint32 and would underflow in that case.
 */
export function reconcile(organizer: OrganizerCounts, ledger: LedgerCounts): ReconcileResult {
  const { registered, issued, unusedReturned } = organizer;
  const { registeredInElectionFile, printed, cast, spoiled, perQuestion } = ledger;
  assertCount("registered", registered);
  assertCount("issued", issued);
  assertCount("unusedReturned", unusedReturned);
  assertCount("registeredInElectionFile", registeredInElectionFile);
  assertCount("printed", printed);
  assertCount("cast", cast);
  assertCount("spoiled", spoiled);

  const details: RuleDetail[] = [];
  const add = (rule: RuleId, passed: boolean, message: string, skipped = false): void => {
    details.push({ rule, bit: CHECK_BITS[rule], passed, skipped, message });
  };

  add("R1", cast <= issued, `cast ${cast} <= issued ${issued}`);

  if (registered === 0) add("R2", true, "skipped: no register (registered = 0)", true);
  else add("R2", issued - spoiled <= registered, `issued ${issued} - spoiled ${spoiled} = ${issued - spoiled} <= registered ${registered}`);

  add("R3", issued <= printed, `issued ${issued} <= printed ${printed}`);
  add("R4", issued === cast + spoiled + unusedReturned, `issued ${issued} == cast ${cast} + spoiled ${spoiled} + unusedReturned ${unusedReturned} (= ${cast + spoiled + unusedReturned})`);

  const badQuestions: string[] = [];
  for (const [qid, t] of Object.entries(perQuestion)) {
    for (const k of ["valid", "blank", "overvote", "unclear"] as const) assertCount(`${qid}.${k}`, t[k]);
    if (t.valid + t.blank + t.overvote + t.unclear !== cast) badQuestions.push(qid);
  }
  for (const qid of ledger.expectedQuestions ?? []) if (!(qid in perQuestion)) badQuestions.push(qid);
  add("R5", badQuestions.length === 0, badQuestions.length === 0 ? `every question sums to cast ${cast}` : `V+B+O+U != cast ${cast} for: ${badQuestions.join(", ")}`);

  add("R6", registered === registeredInElectionFile, `registered at close ${registered} == election file ${registeredInElectionFile}`);

  let failedChecks = 0;
  const checks = {} as Record<RuleId, boolean>;
  for (const d of details) {
    checks[d.rule] = d.passed;
    if (!d.passed) failedChecks |= d.bit;
  }
  return {
    failedChecks,
    checks,
    details,
    counts: { registered, printed, issued, cast, spoiled, unusedReturned, unissued: Math.max(0, printed - issued) },
  };
}

/** Rules that failed in a bit mask, e.g. 9 -> ["R1", "R4"]. Throws on bits outside 0-63. */
export function failedRules(mask: number): RuleId[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > ALL_CHECKS_MASK) throw new BeingsError("BAD_INPUT", "failedChecks mask must be an integer 0-63");
  return RULE_IDS.filter((r) => (mask & CHECK_BITS[r]) !== 0);
}

/** Tally-file `checks` object (true = passed) from a failedChecks mask. */
export function checksFromMask(mask: number): TallyFile["checks"] {
  const failed = new Set(failedRules(mask));
  const out: Record<string, boolean> = {};
  for (const r of RULE_IDS) out[CHECK_KEYS[r]] = !failed.has(r);
  return out as TallyFile["checks"];
}

/** Inverse of checksFromMask. Throws if a required key is missing. */
export function maskFromChecks(checks: Record<string, boolean>): number {
  let mask = 0;
  for (const r of RULE_IDS) {
    const v = checks[CHECK_KEYS[r]];
    if (typeof v !== "boolean") throw new BeingsError("BAD_INPUT", `checks.${CHECK_KEYS[r]} missing`);
    if (!v) mask |= CHECK_BITS[r];
  }
  return mask;
}

export interface BuildTallyOptions {
  electionCode: string;
  /** 1 = original; higher = amended (spec 11.4). */
  version: number;
  merkleRoot: Hex;
  perQuestion: Record<string, QuestionTally>;
  reconciliation: ReconcileResult;
  /** A registered reviewer has cleared a flagged result (spec 8.4): status becomes final, failed checks stay recorded. */
  clearance?: { clearedBy: string; clearanceCid?: string };
}

/**
 * Assemble the tally file (spec 11.4) from computed pieces. Status is "final" only if failedChecks == 0 or a
 * review was cleared (spec 10.3); `review.required` is true whenever any check failed, and stays true after
 * clearance so the failure remains on the public record.
 */
export function buildTallyFile(o: BuildTallyOptions): TallyFile {
  const failed = o.reconciliation.failedChecks !== 0;
  const cleared = o.clearance !== undefined;
  const file: TallyFile = {
    schemaVersion: "0.1",
    electionCode: o.electionCode,
    version: o.version,
    merkleRoot: o.merkleRoot,
    perQuestion: o.perQuestion,
    reconciliation: o.reconciliation.counts,
    checks: checksFromMask(o.reconciliation.failedChecks),
    status: !failed || cleared ? "final" : "provisional",
    review: { required: failed },
  };
  if (failed && o.clearance) {
    file.review = { required: true, clearedBy: o.clearance.clearedBy, ...(o.clearance.clearanceCid ? { clearanceCid: o.clearance.clearanceCid } : {}) };
  }
  return file;
}
