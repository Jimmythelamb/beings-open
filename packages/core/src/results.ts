import { BeingsError } from "./errors.js";
import { keccakHex } from "./hash.js";
import type { Hex } from "./hex.js";
import type { ElectionFile, ElectionQuestion, FillScores, ResultRules, Results } from "./types.js";

export type ParsedResult =
  | { kind: "V"; choices: string[] }
  | { kind: "B" }
  | { kind: "O" }
  | { kind: "U" };

const RESULT_RE = /^(?:V:(c[1-9][0-9]{0,2}(?:\+c[1-9][0-9]{0,2})*)|B|O|U)$/;

function choiceNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * Parse a result string (IC13): `V:c2`, `V:c1+c3`, `B`, `O` or `U`.
 * THROWS (BAD_RESULT) on anything else, including non-canonical forms: choice IDs in a multi-mark result must be
 * in strictly ascending numeric order with no duplicates (so one result has exactly one string, and one hash).
 */
export function parseResult(s: string): ParsedResult {
  const m = typeof s === "string" ? RESULT_RE.exec(s) : null;
  if (!m) throw new BeingsError("BAD_RESULT", `invalid result string ${JSON.stringify(s)}`);
  if (m[1] === undefined) return { kind: s as "B" | "O" | "U" };
  const choices = m[1].split("+");
  for (let i = 1; i < choices.length; i++) {
    if (choiceNumber(choices[i] as string) <= choiceNumber(choices[i - 1] as string)) {
      throw new BeingsError("BAD_RESULT", `choice IDs must be strictly ascending in ${JSON.stringify(s)}`);
    }
  }
  return { kind: "V", choices };
}

/** Inverse of parseResult. Sorts choices ascending; throws on duplicates or bad IDs. */
export function formatResult(r: ParsedResult): string {
  if (r.kind !== "V") return r.kind;
  const sorted = [...r.choices].sort((a, b) => choiceNumber(a) - choiceNumber(b));
  const s = `V:${sorted.join("+")}`;
  parseResult(s); // validates ids and duplicates
  return s;
}

export type BubbleState = "empty" | "unclear" | "marked";

/** Spec 7.2: score < emptyBelow = empty; > markedAbove = marked; otherwise unclear (bounds inclusive). */
export function bubbleState(score: number, rules: Pick<ResultRules, "emptyBelow" | "markedAbove">): BubbleState {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new BeingsError("BAD_INPUT", `fill score must be an integer 0-100, got ${score}`);
  }
  if (rules.emptyBelow > rules.markedAbove + 1) {
    throw new BeingsError("BAD_INPUT", "thresholds overlap: emptyBelow must be <= markedAbove + 1");
  }
  if (score > rules.markedAbove) return "marked";
  if (score < rules.emptyBelow) return "empty";
  return "unclear";
}

/**
 * Spec 7.2 "Deriving the question result". f = marked, u = unclear, m = maxMarks:
 * f > m -> O (even if some bubbles are unclear); else u > 0 -> U; else f = 0 -> B; else V with the marked choice IDs.
 * `scores` maps choiceId -> fill score for ONE question.
 */
export function deriveQuestionResult(
  scores: Record<string, number>,
  maxMarks: number,
  rules: Pick<ResultRules, "emptyBelow" | "markedAbove">,
): string {
  if (!Number.isInteger(maxMarks) || maxMarks < 1) throw new BeingsError("BAD_INPUT", "maxMarks must be an integer >= 1");
  const marked: string[] = [];
  let unclear = 0;
  for (const [choiceId, score] of Object.entries(scores)) {
    const st = bubbleState(score, rules);
    if (st === "marked") marked.push(choiceId);
    else if (st === "unclear") unclear++;
  }
  if (marked.length > maxMarks) return "O";
  if (unclear > 0) return "U";
  if (marked.length === 0) return "B";
  return formatResult({ kind: "V", choices: marked });
}

/**
 * Derive the results for every question of an election from one reading's fill scores.
 * Throws BAD_INPUT unless the scores cover exactly the election's questions and each question's choices.
 */
export function deriveResults(election: Pick<ElectionFile, "questions" | "resultRules">, fillScores: FillScores): Results {
  const out: Results = {};
  const qids = new Set(election.questions.map((q) => q.id));
  for (const k of Object.keys(fillScores)) {
    if (!qids.has(k)) throw new BeingsError("BAD_INPUT", `fill scores include unknown question ${k}`);
  }
  for (const q of election.questions) {
    const scores = fillScores[q.id];
    if (!scores) throw new BeingsError("BAD_INPUT", `fill scores missing question ${q.id}`);
    assertSameChoices(q, scores);
    out[q.id] = deriveQuestionResult(scores, q.maxMarks, election.resultRules);
  }
  return out;
}

function assertSameChoices(q: ElectionQuestion, scores: Record<string, number>): void {
  const want = new Set(q.choices.map((c) => c.id));
  const got = Object.keys(scores);
  if (got.length !== want.size || got.some((c) => !want.has(c))) {
    throw new BeingsError("BAD_INPUT", `fill scores for ${q.id} do not match the election's choices`);
  }
}

/** Question IDs in numeric order (`q2` before `q10`): the default question order when no election file is at hand. */
export function sortQuestionIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The `results` string stored by `BallotLedger.Submission`: answers in question order joined by `|`,
 * e.g. `V:c1|V:c2` (spec 10.2). Order = `questionOrder` (the election file's question order) when given,
 * otherwise numeric question-ID order. Every result is validated with parseResult.
 */
export function encodeResults(results: Results, questionOrder?: readonly string[]): string {
  const order = questionOrder ?? sortQuestionIds(Object.keys(results));
  if (order.length !== Object.keys(results).length || order.some((q) => !(q in results))) {
    throw new BeingsError("BAD_INPUT", "questionOrder does not match the questions in results");
  }
  return order
    .map((q) => {
      const r = results[q] as string;
      parseResult(r);
      return r;
    })
    .join("|");
}

/** Inverse of encodeResults for a known question order. */
export function decodeResults(encoded: string, questionOrder: readonly string[]): Results {
  const parts = encoded.split("|");
  if (parts.length !== questionOrder.length) throw new BeingsError("BAD_RESULT", "wrong number of answers for the question order");
  const out: Results = {};
  questionOrder.forEach((q, i) => {
    const r = parts[i] as string;
    parseResult(r);
    out[q] = r;
  });
  return out;
}

/** `resultsHash` used in the EIP-712 Reading and Review types: keccak256(bytes(encodeResults(...))). */
export function resultsHash(results: Results, questionOrder?: readonly string[]): Hex {
  return keccakHex(encodeResults(results, questionOrder));
}
