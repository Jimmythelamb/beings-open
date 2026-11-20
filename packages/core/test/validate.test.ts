import { describe, expect, it } from "vitest";
import {
  SCHEMA_NAMES,
  SchemaValidationError,
  correctionProblems,
  electionFileProblems,
  isValid,
  parseAndValidate,
  schemaIssues,
  sha256Json,
  validate,
  type ElectionFile,
  type SchemaName,
} from "../src/index.js";
import { deepClone, spec } from "./helpers.js";

const examples: [SchemaName, string][] = [
  ["electionFile", "election-example"],
  ["electionFile", "election-example-with-layout"],
  ["ballotRecord", "record-example"],
  ["ledgerEntry", "ledger-entry-example"],
  ["tally", "tally-example-final"],
  ["tally", "tally-example-provisional"],
  ["verifierReport", "verifier-report-example"],
];

describe("schemas from spec section 11", () => {
  it("all six schemas are available and compile", () => {
    expect(SCHEMA_NAMES.sort()).toEqual(["ballotRecord", "correction", "electionFile", "ledgerEntry", "tally", "verifierReport"]);
    for (const n of SCHEMA_NAMES) expect(() => schemaIssues(n, {})).not.toThrow();
  });

  it.each(examples)("spec example validates: %s / %s", (name, file) => {
    expect(schemaIssues(name, spec(file))).toEqual([]);
    expect(() => validate(name, spec(file))).not.toThrow();
    expect(isValid(name, spec(file))).toBe(true);
  });

  it("a correction example validates", () => {
    const c = { electionCode: "BEINGS-2026-K7M4Q2", ballotCode: "4F9Q7M2XHT8B", questionId: "q1", prevIndex: 0, from: "U", to: "V:c2", reason: "faint-mark", by: "0x2222222222222222222222222222222222222222" };
    expect(schemaIssues("correction", c)).toEqual([]);
    expect(schemaIssues("correction", { ...c, reason: "because" }).length).toBeGreaterThan(0);
    // the spec schema leaves from/to/electionCode as free strings: correctionProblems covers them
    expect(schemaIssues("correction", { ...c, to: "maybe" })).toEqual([]);
    expect(correctionProblems(c as never)).toEqual([]);
    expect(correctionProblems({ ...c, to: "maybe" } as never)).toEqual(["to is not a valid result string"]);
    expect(correctionProblems({ ...c, to: "U" } as never)).toEqual(["from and to are identical"]);
    expect(correctionProblems({ ...c, electionCode: "x" } as never)).toEqual(["electionCode is not a valid election code"]);
    expect(schemaIssues("correction", { ...c, extra: 1 }).length).toBeGreaterThan(0);
  });

  it("rejects missing required fields and unknown properties (additionalProperties false)", () => {
    const rec = spec<Record<string, unknown>>("record-example");
    const { ballotCode: _b, ...missing } = rec;
    void _b;
    expect(isValid("ballotRecord", missing)).toBe(false);
    expect(isValid("ballotRecord", { ...rec, surprise: true })).toBe(false);
    expect(isValid("ledgerEntry", { ...spec<object>("ledger-entry-example"), extra: 1 })).toBe(false);
  });

  it("rejects bad codes, hashes and results", () => {
    const rec = spec<Record<string, unknown>>("record-example");
    for (const bad of [
      { ballotCode: "4F9Q7M2XHT8U" },
      { ballotCode: "4f9q7m2xht8b" },
      { electionCode: "BEINGS-2026-K7M4QI" },
      { results: { q1: "V:c1", q2: "maybe" } },
    ]) expect(isValid("ballotRecord", { ...rec, ...bad }), JSON.stringify(bad)).toBe(false);
    const le = spec<Record<string, unknown>>("ledger-entry-example");
    expect(isValid("ledgerEntry", { ...le, imageSha256: "0x" + "a".repeat(64) })).toBe(false);
    expect(isValid("ledgerEntry", { ...le, imageSha256: "A".repeat(64) })).toBe(false);
    expect(isValid("ledgerEntry", { ...le, recordSha256: "abc" })).toBe(false);
  });

  it("rejects fill scores out of range", () => {
    const rec = deepClone(spec<{ readings: { fillScores: Record<string, Record<string, number>> }[] }>("record-example"));
    (rec.readings[0] as { fillScores: Record<string, Record<string, number>> }).fillScores["q1"]!["c1"] = 101;
    expect(isValid("ballotRecord", rec)).toBe(false);
  });

  it("rejects bad tally numbers and merkle root format", () => {
    const t = deepClone(spec<{ perQuestion: { q1: { valid: number } }; merkleRoot: string }>("tally-example-final"));
    t.perQuestion.q1.valid = -1;
    expect(isValid("tally", t)).toBe(false);
    const t2 = deepClone(spec<{ merkleRoot: string }>("tally-example-final"));
    t2.merkleRoot = "0xABCDEF";
    expect(isValid("tally", t2)).toBe(false);
  });

  it("requires every R1-R6 key in tally.checks", () => {
    const t = deepClone(spec<{ checks: Record<string, boolean> }>("tally-example-final"));
    delete t.checks["R3_issuedLePrinted"];
    expect(isValid("tally", t)).toBe(false);
  });

  it("an unsupported schemaVersion fails with code SCHEMA_VERSION", () => {
    const rec = { ...spec<object>("record-example"), schemaVersion: "0.2" };
    try {
      validate("ballotRecord", rec);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
      expect((e as SchemaValidationError).code).toBe("SCHEMA_VERSION");
    }
    const noVersion = deepClone(spec<Record<string, unknown>>("record-example"));
    delete noVersion["schemaVersion"];
    expect(() => validate("ballotRecord", noVersion)).toThrowError(expect.objectContaining({ code: "SCHEMA_MISMATCH" }));
  });

  it("SchemaValidationError lists issues with paths", () => {
    try {
      validate("ledgerEntry", { ...spec<object>("ledger-entry-example"), reviewed: "yes" });
      expect.unreachable();
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err.schemaName).toBe("ledgerEntry");
      expect(err.issues.some((i) => i.path === "/reviewed")).toBe(true);
    }
  });

  it("non-objects and unknown schema names fail closed", () => {
    for (const v of [null, 1, "x", [], undefined]) expect(isValid("tally", v)).toBe(false);
    expect(() => schemaIssues("nope" as SchemaName, {})).toThrow();
  });

  it("parseAndValidate handles JSON text", () => {
    const text = JSON.stringify(spec("ledger-entry-example"));
    expect(parseAndValidate("ledgerEntry", text).ballotCode).toBe("4F9Q7M2XHT8B");
    expect(() => parseAndValidate("ledgerEntry", "{")).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
    expect(() => parseAndValidate("ledgerEntry", "{}")).toThrowError(expect.objectContaining({ code: "SCHEMA_MISMATCH" }));
  });
});

describe("layoutHash in the election file", () => {
  const old = () => deepClone(spec<Record<string, unknown>>("election-example"));
  const withHash = () => deepClone(spec<Record<string, unknown>>("election-example-with-layout"));
  it("is optional: older files without it stay valid", () => {
    expect(old().layoutHash).toBeUndefined();
    expect(schemaIssues("electionFile", old())).toEqual([]);
  });
  it("accepts 64 lower-case hex characters and rejects anything else", () => {
    expect(schemaIssues("electionFile", withHash())).toEqual([]);
    for (const bad of ["", "abc", "0x" + "a".repeat(64), "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), 5]) {
      expect(isValid("electionFile", { ...withHash(), layoutHash: bad }), String(bad)).toBe(false);
    }
  });
  it("requireLayoutHash makes electionFileProblems demand it (ballot generator output)", () => {
    expect(electionFileProblems(old() as never)).toEqual([]);
    expect(electionFileProblems(old() as never, { requireLayoutHash: true })).toEqual([expect.stringMatching(/layoutHash is missing/)]);
    expect(electionFileProblems(withHash() as never, { requireLayoutHash: true })).toEqual([]);
  });
  it("changes the election file hash, so the layout is covered by the hash that goes on-chain", () => {
    expect(sha256Json(withHash())).not.toBe(sha256Json(old()));
    expect(sha256Json({ ...withHash(), layoutHash: "0".repeat(64) })).not.toBe(sha256Json(withHash()));
  });
});

describe("electionFileProblems (rules beyond JSON Schema)", () => {
  const good = () => deepClone(spec<ElectionFile>("election-example"));
  it("the spec example has none", () => expect(electionFileProblems(good())).toEqual([]));
  it("flags duplicates, bad ids, maxMarks, thresholds, dates, quorum", () => {
    const e = good();
    e.questions[0]!.choices.push({ id: "c1", text: "dup" });
    e.questions[1]!.maxMarks = 5;
    e.resultRules.emptyBelow = 80;
    e.closesAt = e.opensAt;
    e.quorum = 3;
    const p = electionFileProblems(e).join("\n");
    expect(p).toMatch(/duplicate choice id c1/);
    expect(p).toMatch(/maxMarks 5 exceeds/);
    expect(p).toMatch(/overlap/);
    expect(p).toMatch(/closesAt/);
    expect(p).toMatch(/quorum/);
    const f = good();
    f.questions[0]!.id = "q0";
    f.questions[1]!.id = "q0";
    expect(electionFileProblems(f).join("\n")).toMatch(/not canonical/);
    expect(electionFileProblems(f).join("\n")).toMatch(/duplicate question id/);
  });
});
