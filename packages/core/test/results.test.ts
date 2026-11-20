import { describe, expect, it } from "vitest";
import {
  BeingsError,
  bubbleState,
  decodeResults,
  deriveQuestionResult,
  deriveResults,
  encodeResults,
  formatResult,
  keccakHex,
  parseResult,
  resultsHash,
  sortQuestionIds,
} from "../src/index.js";

const rules = { emptyBelow: 15, markedAbove: 50 };

describe("parseResult / formatResult", () => {
  it("parses the five result forms", () => {
    expect(parseResult("V:c2")).toEqual({ kind: "V", choices: ["c2"] });
    expect(parseResult("V:c1+c3")).toEqual({ kind: "V", choices: ["c1", "c3"] });
    expect(parseResult("V:c2+c10+c100")).toEqual({ kind: "V", choices: ["c2", "c10", "c100"] });
    expect(parseResult("B")).toEqual({ kind: "B" });
    expect(parseResult("O")).toEqual({ kind: "O" });
    expect(parseResult("U")).toEqual({ kind: "U" });
  });

  it("rejects everything else (fail closed)", () => {
    const bad = ["", "V", "V:", "V:c", "V:c0", "V:c01", "v:c1", "b", "X", "V:c1+", "V:+c1", "V:c1 ", " B", "B\n", "V:c3+c1", "V:c1+c1", "V:c1,c2", "V:c1++c2", "V:c1000", "V:1", "UB"];
    for (const s of bad) expect(() => parseResult(s), JSON.stringify(s)).toThrowError(expect.objectContaining({ code: "BAD_RESULT" }));
    expect(() => parseResult(undefined as unknown as string)).toThrow(BeingsError);
    expect(() => parseResult(5 as unknown as string)).toThrow(BeingsError);
  });

  it("numeric, not lexical, ordering of choice IDs", () => {
    expect(parseResult("V:c2+c10").kind).toBe("V");
    expect(() => parseResult("V:c10+c2")).toThrow(BeingsError);
  });

  it("formats canonically", () => {
    expect(formatResult({ kind: "V", choices: ["c3", "c1"] })).toBe("V:c1+c3");
    expect(formatResult({ kind: "V", choices: ["c10", "c2"] })).toBe("V:c2+c10");
    expect(formatResult({ kind: "B" })).toBe("B");
    expect(() => formatResult({ kind: "V", choices: ["c1", "c1"] })).toThrow(BeingsError);
    expect(() => formatResult({ kind: "V", choices: [] })).toThrow(BeingsError);
  });
});

describe("bubbleState (spec 7.2)", () => {
  it("applies thresholds with inclusive unclear band", () => {
    expect(bubbleState(0, rules)).toBe("empty");
    expect(bubbleState(14, rules)).toBe("empty");
    expect(bubbleState(15, rules)).toBe("unclear");
    expect(bubbleState(50, rules)).toBe("unclear");
    expect(bubbleState(51, rules)).toBe("marked");
    expect(bubbleState(100, rules)).toBe("marked");
  });
  it("rejects bad scores and overlapping thresholds", () => {
    for (const s of [-1, 101, 1.5, NaN]) expect(() => bubbleState(s, rules), String(s)).toThrow(BeingsError);
    expect(() => bubbleState(10, { emptyBelow: 60, markedAbove: 50 })).toThrow(BeingsError);
    expect(bubbleState(10, { emptyBelow: 51, markedAbove: 50 })).toBe("empty"); // adjacent bands, no unclear band
  });
});

describe("deriveQuestionResult", () => {
  const d = (scores: Record<string, number>, max = 1) => deriveQuestionResult(scores, max, rules);
  it("one clear mark is valid", () => expect(d({ c1: 92, c2: 3, c3: 0 })).toBe("V:c1"));
  it("nothing marked is blank", () => expect(d({ c1: 0, c2: 14, c3: 1 })).toBe("B"));
  it("more marks than allowed is overvote", () => expect(d({ c1: 90, c2: 80, c3: 0 })).toBe("O"));
  it("multi-mark within maxMarks is valid, sorted", () => expect(d({ c3: 80, c2: 0, c1: 70 }, 2)).toBe("V:c1+c3"));
  it("an unclear bubble makes the question unclear", () => expect(d({ c1: 90, c2: 30, c3: 0 })).toBe("U"));
  it("overvote wins over unclear (spec: f > m first)", () => expect(d({ c1: 90, c2: 80, c3: 30 })).toBe("O"));
  it("unclear alone is unclear", () => expect(d({ c1: 15, c2: 50 })).toBe("U"));
  it("rejects bad maxMarks", () => expect(() => d({ c1: 0 }, 0)).toThrow(BeingsError));
});

describe("deriveResults", () => {
  const election = {
    resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"] as ["V", "B", "O", "U"] },
    questions: [
      { id: "q1", text: "", maxMarks: 1, choices: [{ id: "c1", text: "" }, { id: "c2", text: "" }] },
      { id: "q2", text: "", maxMarks: 1, choices: [{ id: "c1", text: "" }, { id: "c2", text: "" }] },
    ],
  };
  it("derives every question", () => {
    expect(deriveResults(election, { q1: { c1: 90, c2: 0 }, q2: { c1: 0, c2: 0 } })).toEqual({ q1: "V:c1", q2: "B" });
  });
  it("rejects scores that do not match the election", () => {
    expect(() => deriveResults(election, { q1: { c1: 90, c2: 0 } })).toThrow(/missing question q2/);
    expect(() => deriveResults(election, { q1: { c1: 1, c2: 0 }, q2: { c1: 0, c2: 0 }, q3: {} })).toThrow(/unknown question/);
    expect(() => deriveResults(election, { q1: { c1: 1 }, q2: { c1: 0, c2: 0 } })).toThrow(/do not match/);
    expect(() => deriveResults(election, { q1: { c1: 1, c9: 0 }, q2: { c1: 0, c2: 0 } })).toThrow(/do not match/);
  });
});

describe("encodeResults / resultsHash (spec 10.2)", () => {
  it("joins answers in question order with |", () => {
    expect(encodeResults({ q1: "V:c1", q2: "V:c2" })).toBe("V:c1|V:c2");
    expect(encodeResults({ q2: "B", q1: "O" })).toBe("O|B");
  });
  it("orders question ids numerically by default, or by an explicit order", () => {
    expect(sortQuestionIds(["q10", "q2", "q1"])).toEqual(["q1", "q2", "q10"]);
    expect(encodeResults({ q10: "B", q2: "U" })).toBe("U|B");
    expect(encodeResults({ q1: "B", q2: "U" }, ["q2", "q1"])).toBe("U|B");
  });
  it("validates", () => {
    expect(() => encodeResults({ q1: "V:c3+c1" })).toThrow(BeingsError);
    expect(() => encodeResults({ q1: "B" }, ["q1", "q2"])).toThrow(BeingsError);
    expect(() => encodeResults({ q1: "B" }, ["q2"])).toThrow(BeingsError);
  });
  it("hash is keccak256 of the encoded string", () => {
    expect(resultsHash({ q1: "V:c1", q2: "V:c2" })).toBe(keccakHex("V:c1|V:c2"));
  });
  it("decodes", () => {
    expect(decodeResults("V:c1|B", ["q1", "q2"])).toEqual({ q1: "V:c1", q2: "B" });
    expect(() => decodeResults("V:c1", ["q1", "q2"])).toThrow(BeingsError);
    expect(() => decodeResults("V:c1|nope", ["q1", "q2"])).toThrow(BeingsError);
  });
});
