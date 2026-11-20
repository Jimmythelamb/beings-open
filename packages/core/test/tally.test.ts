import { describe, expect, it } from "vitest";
import {
  BeingsError,
  applyCorrections,
  entryLeaf,
  entryProblems,
  keccakJson,
  merkleProof,
  merkleRoot,
  merkleRootOfEntries,
  tallyQuestions,
  verifyProof,
  type Correction,
  type LedgerEntry,
} from "../src/index.js";

const EC = "BEINGS-2026-K7M4Q2";
const CODES = ["4F9Q7M2XHT8B", "B3N6D0YK5E1W", "0123456789AB", "CDEFGHJKMNPQ"];
const entry = (i: number, results: Record<string, string>, reviewed = false): LedgerEntry => ({
  electionCode: EC,
  ballotCode: CODES[i] as string,
  results,
  imageSha256: "a".repeat(63) + String(i),
  recordSha256: "b".repeat(63) + String(i),
  reviewed,
});
const election = {
  questions: [
    { id: "q1", text: "", maxMarks: 1, choices: ["c1", "c2", "c3"].map((id) => ({ id, text: "" })) },
    { id: "q2", text: "", maxMarks: 2, choices: ["c1", "c2", "c3"].map((id) => ({ id, text: "" })) },
  ],
};
const corr = (i: number, q: string, prevIndex: number, from: string, to: string): Correction => ({
  electionCode: EC,
  ballotCode: CODES[i] as string,
  questionId: q,
  prevIndex,
  from,
  to,
  reason: "faint-mark",
  by: "0x2222222222222222222222222222222222222222",
});

const entries = () => [
  entry(0, { q1: "V:c1", q2: "V:c1+c2" }),
  entry(1, { q1: "U", q2: "V:c3" }, true),
  entry(2, { q1: "B", q2: "O" }),
  entry(3, { q1: "V:c1", q2: "B" }),
];

describe("tallyQuestions", () => {
  it("counts V/B/O/U and per-choice marks (multi-mark counts for each choice)", () => {
    const t = tallyQuestions(entries(), [], { election });
    expect(t["q1"]).toEqual({ valid: 2, blank: 1, overvote: 0, unclear: 1, byChoice: { c1: 2, c2: 0, c3: 0 } });
    expect(t["q2"]).toEqual({ valid: 2, blank: 1, overvote: 1, unclear: 0, byChoice: { c1: 1, c2: 1, c3: 1 } });
  });

  it("works without the election file (only seen choices appear)", () => {
    const t = tallyQuestions(entries());
    expect(t["q1"]?.byChoice).toEqual({ c1: 2 });
  });

  it("applies corrections before counting", () => {
    const t = tallyQuestions(entries(), [corr(1, "q1", 0, "U", "V:c2")], { election });
    expect(t["q1"]).toEqual({ valid: 3, blank: 1, overvote: 0, unclear: 0, byChoice: { c1: 2, c2: 1, c3: 0 } });
  });

  it("follows correction chains to the head", () => {
    const cs = [corr(1, "q1", 0, "U", "V:c2"), corr(1, "q1", 1, "V:c2", "V:c3"), corr(1, "q1", 2, "V:c3", "B")];
    const t = tallyQuestions(entries(), cs, { election });
    expect(t["q1"]).toMatchObject({ valid: 2, blank: 2, unclear: 0 });
  });

  it("every question sums to the number of ballots", () => {
    const t = tallyQuestions(entries(), [], { election });
    for (const q of Object.values(t)) expect(q.valid + q.blank + q.overvote + q.unclear).toBe(4);
  });

  it("an empty ledger gives zeros for every question", () => {
    const t = tallyQuestions([], [], { election });
    expect(t["q1"]).toEqual({ valid: 0, blank: 0, overvote: 0, unclear: 0, byChoice: { c1: 0, c2: 0, c3: 0 } });
  });

  it("a ballot missing a question is not counted for it (R5 will catch it)", () => {
    const t = tallyQuestions([entry(0, { q1: "V:c1" }), entry(1, { q1: "B", q2: "B" })], [], { election: undefined });
    expect(t["q2"]).toMatchObject({ valid: 0, blank: 1 });
  });

  it("with an election file, rejects unknown questions/choices and too many marks", () => {
    expect(() => tallyQuestions([entry(0, { q1: "V:c9", q2: "B" })], [], { election })).toThrowError(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => tallyQuestions([entry(0, { q1: "V:c1+c2", q2: "B" })], [], { election })).toThrow(/maxMarks/);
    expect(() => tallyQuestions([entry(0, { q1: "B", q9: "B" })], [], { election })).toThrow(/unknown question/);
    expect(entryProblems(entry(0, { q1: "V:c1", q2: "V:c1+c3" }), election)).toEqual([]);
  });

  it("rejects malformed results in the ledger", () => {
    expect(() => tallyQuestions([entry(0, { q1: "maybe" })])).toThrowError(expect.objectContaining({ code: "BAD_RESULT" }));
  });
});

describe("applyCorrections", () => {
  it("does not modify its input", () => {
    const es = entries();
    const before = JSON.stringify(es);
    applyCorrections(es, [corr(1, "q1", 0, "U", "V:c2")]);
    expect(JSON.stringify(es)).toBe(before);
  });

  it("chains are per ballot and question", () => {
    const out = applyCorrections(entries(), [corr(1, "q1", 0, "U", "V:c2"), corr(1, "q2", 0, "V:c3", "V:c1"), corr(2, "q1", 0, "B", "V:c3")]);
    expect(out[1]?.results).toEqual({ q1: "V:c2", q2: "V:c1" });
    expect(out[2]?.results).toEqual({ q1: "V:c3", q2: "O" });
  });

  const fail = (cs: Correction[], msg: RegExp) => expect(() => applyCorrections(entries(), cs)).toThrowError(expect.objectContaining({ code: "BAD_CORRECTION", message: expect.stringMatching(msg) }));

  it("fails closed on a stale or wrong prevIndex (forked chain)", () => {
    fail([corr(1, "q1", 0, "U", "V:c2"), corr(1, "q1", 0, "U", "V:c3")], /prevIndex 0 is not the chain head 1/);
    fail([corr(1, "q1", 1, "U", "V:c2")], /prevIndex 1 is not the chain head 0/);
  });
  it("fails closed when `from` is not the effective result", () => {
    fail([corr(1, "q1", 0, "B", "V:c2")], /not the effective result/);
  });
  it("fails closed on unknown ballot, question, election, or invalid `to`", () => {
    fail([{ ...corr(1, "q1", 0, "U", "V:c2"), ballotCode: "ZZZZZZZZZZZZ" }], /no ledger entry/);
    fail([corr(1, "q9", 0, "U", "V:c2")], /question not in/);
    fail([{ ...corr(1, "q1", 0, "U", "V:c2"), electionCode: "BEINGS-2026-AAAAAA" }], /wrong election/);
    fail([corr(1, "q1", 0, "U", "V:c3+c1")], /invalid result/);
  });
  it("rejects duplicate entries and mixed elections", () => {
    expect(() => applyCorrections([entry(0, { q1: "B" }), entry(0, { q1: "B" })])).toThrow(BeingsError);
    expect(() => applyCorrections([entry(0, { q1: "B" }), { ...entry(1, { q1: "B" }), electionCode: "BEINGS-2026-AAAAAA" }])).toThrow(BeingsError);
  });
});

describe("Merkle root over entries", () => {
  it("the leaf is keccak256(JCS(ledger entry))", () => {
    const e = entry(0, { q2: "B", q1: "V:c1" });
    expect(entryLeaf(e)).toBe(keccakJson({ ballotCode: e.ballotCode, electionCode: EC, imageSha256: e.imageSha256, recordSha256: e.recordSha256, results: { q1: "V:c1", q2: "B" }, reviewed: false }));
  });

  it("ignores unknown extra fields on an entry object", () => {
    const e = entry(0, { q1: "B" });
    expect(entryLeaf({ ...e, junk: 1 } as LedgerEntry)).toBe(entryLeaf(e));
  });

  it("root depends on corrections and not on entry order", () => {
    const es = entries();
    const cs = [corr(1, "q1", 0, "U", "V:c2")];
    const r0 = merkleRootOfEntries(es);
    const r1 = merkleRootOfEntries(es, cs);
    expect(r0).not.toBe(r1);
    expect(merkleRootOfEntries([...es].reverse(), cs)).toBe(r1);
  });

  it("proofs for entries verify against the root (as the lookup page does)", () => {
    const es = entries();
    const effective = applyCorrections(es, []);
    const leaves = effective.map(entryLeaf);
    const root = merkleRoot(leaves);
    expect(root).toBe(merkleRootOfEntries(es));
    for (const l of leaves) expect(verifyProof(root, l, merkleProof(leaves, l))).toBe(true);
  });

  it("a change to any field changes the root", () => {
    const es = entries();
    const r = merkleRootOfEntries(es);
    const flipped = entries();
    (flipped[3] as LedgerEntry).reviewed = true;
    expect(merkleRootOfEntries(flipped)).not.toBe(r);
  });
});
