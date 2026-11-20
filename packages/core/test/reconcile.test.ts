import { describe, expect, it } from "vitest";
import {
  BeingsError,
  CHECK_BITS,
  buildTallyFile,
  checksFromMask,
  failedRules,
  isValid,
  maskFromChecks,
  reconcile,
  type LedgerCounts,
  type OrganizerCounts,
} from "../src/index.js";
import { spec } from "./helpers.js";

const org: OrganizerCounts = { registered: 120, issued: 123, unusedReturned: 1 };
const led = (o: Partial<LedgerCounts> = {}): LedgerCounts => ({
  registeredInElectionFile: 120,
  printed: 130,
  cast: 119,
  spoiled: 3,
  perQuestion: { q1: { valid: 100, blank: 8, overvote: 6, unclear: 5 }, q2: { valid: 105, blank: 9, overvote: 3, unclear: 2 } },
  ...o,
});

describe("reconcile R1-R6 (spec 8.3 and 10.3)", () => {
  it("bit values", () => {
    expect(CHECK_BITS).toEqual({ R1: 1, R2: 2, R3: 4, R4: 8, R5: 16, R6: 32 });
  });

  it("worked example passes everything (mask 0)", () => {
    const r = reconcile(org, led());
    expect(r.failedChecks).toBe(0);
    expect(Object.values(r.checks).every(Boolean)).toBe(true);
    expect(r.counts).toEqual({ registered: 120, printed: 130, issued: 123, cast: 119, spoiled: 3, unusedReturned: 1, unissued: 7 });
  });

  it("provisional example: only R4 fails (mask 8)", () => {
    const r = reconcile({ ...org, unusedReturned: 0 }, led());
    expect(r.failedChecks).toBe(8);
    expect(r.checks).toMatchObject({ R1: true, R2: true, R3: true, R4: false, R5: true, R6: true });
  });

  it("R1: cast > issued", () => {
    const r = reconcile({ ...org, issued: 118, unusedReturned: 0 }, led({ spoiled: 0 }));
    expect(r.checks.R1).toBe(false);
    expect(r.failedChecks & 1).toBe(1);
  });
  it("R1 boundary: cast == issued passes", () => {
    expect(reconcile({ registered: 0, issued: 10, unusedReturned: 0 }, led({ registeredInElectionFile: 0, printed: 10, cast: 10, spoiled: 0, perQuestion: { q1: { valid: 10, blank: 0, overvote: 0, unclear: 0 } } })).checks.R1).toBe(true);
  });

  it("R2: issued - spoiled > registered", () => {
    const r = reconcile({ ...org, registered: 119 }, led({ registeredInElectionFile: 119 }));
    expect(r.failedChecks).toBe(2);
  });
  it("R2 boundary: issued - spoiled == registered passes (120 <= 120)", () => {
    expect(reconcile(org, led()).checks.R2).toBe(true);
  });
  it("R2 is skipped (passes) with no register, and flagged skipped in the details", () => {
    const r = reconcile({ ...org, registered: 0 }, led({ registeredInElectionFile: 0 }));
    expect(r.checks.R2).toBe(true);
    expect(r.details.find((d) => d.rule === "R2")?.skipped).toBe(true);
    expect(r.failedChecks).toBe(0);
  });

  it("R3: issued > printed", () => {
    expect(reconcile(org, led({ printed: 122 })).failedChecks).toBe(4);
  });
  it("R3 boundary: issued == printed passes and unissued is 0", () => {
    const r = reconcile(org, led({ printed: 123 }));
    expect(r.checks.R3).toBe(true);
    expect(r.counts.unissued).toBe(0);
  });
  it("unissued is clamped at 0 when R3 fails", () => {
    const r = reconcile(org, led({ printed: 120 }));
    expect(r.counts.unissued).toBe(0);
    expect(r.checks.R3).toBe(false);
  });

  it("R4: issued must equal cast + spoiled + unused", () => {
    expect(reconcile({ ...org, unusedReturned: 2 }, led()).failedChecks).toBe(8);
    expect(reconcile({ ...org, issued: 124 }, led()).failedChecks & 8).toBe(8);
  });

  it("R5: a question that does not sum to cast", () => {
    const r = reconcile(org, led({ perQuestion: { q1: { valid: 100, blank: 8, overvote: 6, unclear: 4 }, q2: { valid: 105, blank: 9, overvote: 3, unclear: 2 } } }));
    expect(r.failedChecks).toBe(16);
    expect(r.details.find((d) => d.rule === "R5")?.message).toContain("q1");
  });
  it("R5: a missing expected question fails; no questions at all passes unless expected", () => {
    expect(reconcile(org, led({ expectedQuestions: ["q1", "q2", "q3"] })).failedChecks).toBe(16);
    expect(reconcile(org, led({ perQuestion: {} })).failedChecks).toBe(0);
    expect(reconcile(org, led({ perQuestion: {}, expectedQuestions: ["q1"] })).failedChecks).toBe(16);
  });

  it("R6: register changed after the file was fixed", () => {
    expect(reconcile({ ...org, registered: 121 }, led()).failedChecks).toBe(32);
  });

  it("combines failed bits", () => {
    // issued 100 < cast 119 (R1), 100 != 119+3+1 (R4)
    const r = reconcile({ ...org, issued: 100 }, led());
    expect(r.failedChecks).toBe(1 | 8);
    expect(failedRules(r.failedChecks)).toEqual(["R1", "R4"]);
    expect(reconcile({ registered: 1, issued: 200, unusedReturned: 0 }, led({ registeredInElectionFile: 2, printed: 10, cast: 1, spoiled: 0, perQuestion: { q1: { valid: 0, blank: 0, overvote: 0, unclear: 0 } } })).failedChecks).toBe(2 | 4 | 8 | 16 | 32);
  });

  it("rejects malformed counts (throws, never silently passes)", () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => reconcile({ ...org, issued: bad }, led()), String(bad)).toThrow(BeingsError);
      expect(() => reconcile(org, led({ cast: bad })), String(bad)).toThrow(BeingsError);
    }
    expect(() => reconcile(org, led({ perQuestion: { q1: { valid: -1, blank: 0, overvote: 0, unclear: 0 } } }))).toThrow(BeingsError);
  });
});

describe("mask helpers", () => {
  it("failedRules and checksFromMask / maskFromChecks round-trip for all 64 masks", () => {
    for (let m = 0; m <= 63; m++) {
      expect(maskFromChecks(checksFromMask(m))).toBe(m);
      expect(failedRules(m).reduce((n, r) => n | CHECK_BITS[r], 0)).toBe(m);
    }
    expect(() => failedRules(64)).toThrow(BeingsError);
    expect(() => failedRules(-1)).toThrow(BeingsError);
    expect(() => maskFromChecks({})).toThrow(BeingsError);
  });
  it("matches the spec examples' checks objects", () => {
    expect(maskFromChecks(spec<{ checks: Record<string, boolean> }>("tally-example-final").checks)).toBe(0);
    expect(maskFromChecks(spec<{ checks: Record<string, boolean> }>("tally-example-provisional").checks)).toBe(8);
  });
});

describe("buildTallyFile", () => {
  const perQuestion = spec<{ perQuestion: Record<string, never> }>("tally-example-final").perQuestion;
  const merkle = "0x5d1e9a3b7c2f4086a1d3e5f7092b4c6d8e0a1f3b5d7c9e2a4b6d8f0a1c3e5b79";
  const build = (o: Partial<OrganizerCounts>, clearance?: { clearedBy: string; clearanceCid?: string }) =>
    buildTallyFile({ electionCode: "BEINGS-2026-K7M4Q2", version: 1, merkleRoot: merkle, perQuestion, reconciliation: reconcile({ ...org, ...o }, led()), clearance });

  it("reproduces the spec's final example exactly", () => {
    expect(build({})).toEqual(spec("tally-example-final"));
  });
  it("reproduces the spec's provisional example exactly", () => {
    expect(build({ unusedReturned: 0 })).toEqual(spec("tally-example-provisional"));
  });
  it("output validates against the tally schema", () => {
    expect(isValid("tally", build({}))).toBe(true);
    expect(isValid("tally", build({ unusedReturned: 0 }))).toBe(true);
  });
  it("a cleared review turns provisional into final but keeps the failure on record", () => {
    const t = build({ unusedReturned: 0 }, { clearedBy: "0x2222222222222222222222222222222222222222", clearanceCid: "bafy123" });
    expect(t.status).toBe("final");
    expect(t.checks.R4_issuedEqualsParts).toBe(false);
    expect(t.review).toEqual({ required: true, clearedBy: "0x2222222222222222222222222222222222222222", clearanceCid: "bafy123" });
    expect(isValid("tally", t)).toBe(true);
  });
  it("clearance without a failure is ignored", () => {
    expect(build({}, { clearedBy: "0x2222222222222222222222222222222222222222" }).review).toEqual({ required: false });
  });
});
