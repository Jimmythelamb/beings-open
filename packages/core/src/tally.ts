import { BeingsError } from "./errors.js";
import { keccakJson } from "./hash.js";
import type { Hex } from "./hex.js";
import { merkleRoot } from "./merkle.js";
import { parseResult } from "./results.js";
import type { Correction, ElectionFile, LedgerEntry, QuestionTally, Results } from "./types.js";

/** A ledger entry whose `results` are the effective results after corrections. */
export type EffectiveEntry = LedgerEntry;

/**
 * Apply correction entries to ledger entries (spec 7.3, 11.3, 12.2). Pure; inputs are not modified.
 *
 * `corrections` must be in ledger posting order. Resolving the spec's ambiguity about `prevIndex`:
 * corrections are numbered 1, 2, 3... in posting order within the election ([PROPOSED]); `prevIndex` 0 is
 * the original record and `prevIndex` n is the n-th correction. (On-chain, `corrections[electionKey]` is a
 * 0-based array, so contract index = prevIndex - 1; the 1-based number is what chain heads store, because
 * 0 is reserved for "original".)
 *
 * The effective result of a (ballot, question) is the last entry of its chain. Fail closed (BAD_CORRECTION) if:
 * the ballot or question is unknown; prevIndex is not the current head of that chain (chains must be linear);
 * `from` is not the currently effective result; or `to` is not a valid result string.
 * Corrections for other elections are rejected.
 */
export function applyCorrections(entries: readonly LedgerEntry[], corrections: readonly Correction[] = []): EffectiveEntry[] {
  const byBallot = new Map<string, EffectiveEntry>();
  for (const e of entries) {
    if (byBallot.has(e.ballotCode)) throw new BeingsError("BAD_INPUT", `duplicate ledger entry for ballot ${e.ballotCode}`);
    byBallot.set(e.ballotCode, { ...e, results: { ...e.results } });
  }
  const election = entries[0]?.electionCode;
  for (const e of entries) {
    if (e.electionCode !== election) throw new BeingsError("BAD_INPUT", "ledger entries from different elections");
  }
  const heads = new Map<string, number>(); // `${ballotCode}|${questionId}` -> head index (0 = original)
  corrections.forEach((c, i) => {
    const index = i + 1;
    const where = `correction #${index} (${c.ballotCode} ${c.questionId})`;
    if (election !== undefined && c.electionCode !== election) throw new BeingsError("BAD_CORRECTION", `${where}: wrong election`);
    const entry = byBallot.get(c.ballotCode);
    if (!entry) throw new BeingsError("BAD_CORRECTION", `${where}: no ledger entry for this ballot`);
    const current = entry.results[c.questionId];
    if (current === undefined) throw new BeingsError("BAD_CORRECTION", `${where}: question not in the ballot's results`);
    const key = `${c.ballotCode}|${c.questionId}`;
    const head = heads.get(key) ?? 0;
    if (c.prevIndex !== head) throw new BeingsError("BAD_CORRECTION", `${where}: prevIndex ${c.prevIndex} is not the chain head ${head}`);
    if (c.from !== current) throw new BeingsError("BAD_CORRECTION", `${where}: from ${JSON.stringify(c.from)} is not the effective result ${JSON.stringify(current)}`);
    try {
      parseResult(c.to);
    } catch {
      throw new BeingsError("BAD_CORRECTION", `${where}: invalid result ${JSON.stringify(c.to)}`);
    }
    entry.results[c.questionId] = c.to;
    heads.set(key, index);
  });
  return [...byBallot.values()];
}

/** Problems with a ledger entry's results relative to the election file (empty = fine). */
export function entryProblems(entry: Pick<LedgerEntry, "ballotCode" | "results">, election: Pick<ElectionFile, "questions">): string[] {
  const problems: string[] = [];
  const qs = new Map(election.questions.map((q) => [q.id, q]));
  for (const [qid, r] of Object.entries(entry.results)) {
    const q = qs.get(qid);
    if (!q) {
      problems.push(`${entry.ballotCode}: unknown question ${qid}`);
      continue;
    }
    let parsed;
    try {
      parsed = parseResult(r);
    } catch {
      problems.push(`${entry.ballotCode} ${qid}: invalid result ${JSON.stringify(r)}`);
      continue;
    }
    if (parsed.kind === "V") {
      const known = new Set(q.choices.map((c) => c.id));
      for (const c of parsed.choices) if (!known.has(c)) problems.push(`${entry.ballotCode} ${qid}: unknown choice ${c}`);
      if (parsed.choices.length > q.maxMarks) problems.push(`${entry.ballotCode} ${qid}: ${parsed.choices.length} marks exceeds maxMarks ${q.maxMarks}`);
    }
  }
  return problems;
}

export interface TallyOptions {
  /** When given: results are checked against it (unknown question/choice or too many marks THROW), and every
   *  question and choice appears in the output even with zero counts. */
  election?: Pick<ElectionFile, "questions">;
}

/**
 * Tally ballot results per question (spec 7.4, 11.4): valid, blank, overvote, unclear and `byChoice`
 * (each marked choice of a valid result gets +1, so a multi-mark `V:c1+c3` adds one to `valid` and to c1 and c3).
 * Corrections are applied first (applyCorrections). An unresolved U stays unclear and counts for no choice.
 *
 * A ballot that lacks a question is NOT an error here: it simply is not counted for that question, so
 * reconciliation rule R5 (V+B+O+U = cast) is what flags it, as the spec intends.
 */
export function tallyQuestions(
  entries: readonly LedgerEntry[],
  corrections: readonly Correction[] = [],
  options: TallyOptions = {},
): Record<string, QuestionTally> {
  const effective = applyCorrections(entries, corrections);
  const out: Record<string, QuestionTally> = {};
  const { election } = options;
  if (election) {
    for (const q of election.questions) {
      out[q.id] = { valid: 0, blank: 0, overvote: 0, unclear: 0, byChoice: Object.fromEntries(q.choices.map((c) => [c.id, 0])) };
    }
    const problems = effective.flatMap((e) => entryProblems(e, election));
    if (problems.length > 0) throw new BeingsError("BAD_INPUT", `ledger results do not fit the election file: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`);
  }
  for (const e of effective) {
    for (const [qid, r] of Object.entries(e.results)) {
      const t = (out[qid] ??= { valid: 0, blank: 0, overvote: 0, unclear: 0, byChoice: {} });
      const p = parseResult(r);
      switch (p.kind) {
        case "V": {
          t.valid++;
          const by = (t.byChoice ??= {});
          for (const c of p.choices) by[c] = (by[c] ?? 0) + 1;
          break;
        }
        case "B":
          t.blank++;
          break;
        case "O":
          t.overvote++;
          break;
        case "U":
          t.unclear++;
          break;
      }
    }
  }
  // stable key order for byChoice (numeric) so output files are reproducible
  for (const t of Object.values(out)) {
    if (t.byChoice) {
      t.byChoice = Object.fromEntries(Object.entries(t.byChoice).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))));
    }
  }
  return out;
}

/**
 * Merkle leaf for one ballot: keccak256(JCS(final ledger entry with corrections applied)) (spec 10.3).
 * Resolving the spec's "final record": the leaf is over the LEDGER ENTRY view
 * `{electionCode, ballotCode, results, imageSha256, recordSha256, reviewed}` with `results` replaced by the
 * effective results, NOT the full record file, because the full record (fill scores, signatures) is only kept
 * for the retention period while the Merkle root must stay verifiable from chain data alone. `reviewed` is
 * kept as posted. [PROPOSED]: confirm with the Tally contract author.
 */
export function entryLeaf(effectiveEntry: LedgerEntry): Hex {
  const { electionCode, ballotCode, results, imageSha256, recordSha256, reviewed } = effectiveEntry;
  const clean: LedgerEntry = { electionCode, ballotCode, results: results as Results, imageSha256, recordSha256, reviewed };
  return keccakJson(clean);
}

/** Merkle root over all final entries (corrections applied). Order-independent. */
export function merkleRootOfEntries(entries: readonly LedgerEntry[], corrections: readonly Correction[] = []): Hex {
  return merkleRoot(applyCorrections(entries, corrections).map(entryLeaf));
}
