import { describe, expect, it } from "vitest";
import {
  CONSENSUS_KIND,
  BeingsError,
  consensusReport,
  electionFileProblems,
  isValid,
  schemaIssues,
  type ElectionFile,
} from "../src/index.js";
import { deepClone, spec } from "./helpers.js";

const CODE_A = "4F9Q7M2XHT8B";
const CODE_B = "7K3NPQRSTVW2";
const IMAGE_A = "ab".repeat(32);
const IMAGE_B = "cd".repeat(32);

const election = {
  questions: [
    { id: "q1", text: "Chair", maxMarks: 1, choices: [{ id: "c1", text: "Ada" }, { id: "c2", text: "Bea" }] },
  ],
  resultRules: { emptyBelow: 15, markedAbove: 50 },
};

function sheet(code: string, scores: { c1: number; c2: number }, page: number, image = IMAGE_A) {
  return { ballotCode: code, imageSha256: image, fillScores: { q1: scores }, page };
}

describe("three-threshold Merkle consensus", () => {
  it("matching roots when every oval is clearly empty or clearly marked", () => {
    const report = consensusReport(election, [
      sheet(CODE_A, { c1: 100, c2: 0 }, 1, IMAGE_A),
      sheet(CODE_B, { c1: 0, c2: 0 }, 2, IMAGE_B),
    ]);
    expect(report.kind).toBe(CONSENSUS_KIND);
    expect(report.passed).toBe(true);
    expect(report.needsHumanReview).toBe(false);
    expect(report.flags).toEqual([]);
    expect(report.roots.tight).toBe(report.roots.standard);
    expect(report.roots.standard).toBe(report.roots.loose);
    expect(report.roots.tight).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.thresholds).toEqual({
      tight: { emptyBelow: 10, markedAbove: 55 },
      standard: { emptyBelow: 15, markedAbove: 50 },
      loose: { emptyBelow: 20, markedAbove: 45 },
    });
  });

  it("flags the one oval whose fill score flips between passes", () => {
    const report = consensusReport(election, [
      sheet(CODE_A, { c1: 52, c2: 0 }, 1, IMAGE_A),
      sheet(CODE_B, { c1: 100, c2: 0 }, 2, IMAGE_B),
    ]);
    expect(report.passed).toBe(false);
    expect(report.needsHumanReview).toBe(true);
    expect(report.roots.tight).not.toBe(report.roots.standard);
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0]).toMatchObject({
      page: 1,
      imageSha256: IMAGE_A,
      review: "human",
      questions: [{ id: "q1", tight: "U", standard: "V:c1", loose: "V:c1" }],
      ovals: [{ question: "q1", choice: "c1", fillScore: 52, tight: "unclear", standard: "marked", loose: "marked" }],
    });
  });

  it("builds the same roots whatever order the ballots are given", () => {
    const first = sheet(CODE_A, { c1: 100, c2: 0 }, 1, IMAGE_A);
    const second = sheet(CODE_B, { c1: 0, c2: 80 }, 2, IMAGE_B);
    const forward = consensusReport(election, [first, second]);
    const backward = consensusReport(election, [second, first]);
    expect(backward.roots).toEqual(forward.roots);
    expect(backward.passed).toBe(true);
    const imagesOnly = [
      { imageSha256: IMAGE_B, fillScores: second.fillScores },
      { imageSha256: IMAGE_A, fillScores: first.fillScores },
    ];
    const byImage = consensusReport(election, imagesOnly);
    const byImageReversed = consensusReport(election, [...imagesOnly].reverse());
    expect(byImage.keyMode).toBe("imageSha256");
    expect(byImageReversed.roots).toEqual(byImage.roots);
    expect(byImage.roots).not.toEqual(forward.roots);
  });

  it("never writes a ballot code, including when a sheet is flagged", () => {
    const flagged = consensusReport(election, [sheet(CODE_A, { c1: 52, c2: 0 }, 1, IMAGE_A)]);
    const agreed = consensusReport(election, [sheet(CODE_A, { c1: 0, c2: 0 }, 1, IMAGE_A), sheet(CODE_B, { c1: 90, c2: 0 }, 2, IMAGE_B)]);
    for (const report of [flagged, agreed]) {
      const text = JSON.stringify(report);
      expect(text).not.toContain(CODE_A);
      expect(text).not.toContain(CODE_B);
      expect(text).not.toContain("ballotCode");
    }
    expect(flagged.flags[0]?.ballotKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses consensusThresholds from the election file when they are set", () => {
    const custom = {
      ...election,
      consensusThresholds: {
        tight: { emptyBelow: 5, markedAbove: 90 },
        loose: { emptyBelow: 30, markedAbove: 40 },
      },
    };
    const report = consensusReport(custom, [sheet(CODE_A, { c1: 52, c2: 0 }, 1)]);
    expect(report.thresholds.tight).toEqual({ emptyBelow: 5, markedAbove: 90 });
    expect(report.thresholds.standard).toEqual({ emptyBelow: 15, markedAbove: 50 });
    expect(report.thresholds.loose).toEqual({ emptyBelow: 30, markedAbove: 40 });
    expect(report.passed).toBe(false);
    expect(report.flags[0]?.questions[0]).toMatchObject({ tight: "U", standard: "V:c1", loose: "V:c1" });
  });

  it("rejects an overlapping optional pair in the election file", () => {
    const file = deepClone(spec<ElectionFile>("election-example"));
    file.consensusThresholds = { tight: { emptyBelow: 80, markedAbove: 10 } };
    expect(schemaIssues("electionFile", file)).toEqual([]);
    expect(isValid("electionFile", file)).toBe(true);
    expect(electionFileProblems(file).join("\n")).toMatch(/consensusThresholds\.tight/);
    const bad = deepClone(file);
    bad.consensusThresholds = { loose: { emptyBelow: 10, markedAbove: 45 } };
    expect(electionFileProblems(bad)).toEqual([]);
    expect(() => consensusReport(election, [])).not.toThrow();
    expect(() => consensusReport({ ...election, consensusThresholds: { tight: { emptyBelow: 80, markedAbove: 10 } } }, [])).toThrow(BeingsError);
  });
});
