import { describe, expect, it } from "vitest";
import { consensusReport as coreReport } from "../../core/src/consensus.ts";
import { consensusReport } from "../src/consensus.mjs";
import { buildReadings } from "../src/reader.mjs";

const CODE_A = "4F9Q7M2XHT8B";
const CODE_B = "7K3NPQRSTVW2";
const IMAGE_A = "ab".repeat(32);
const IMAGE_B = "cd".repeat(32);

const election = {
  electionCode: "BEINGS-2026-K7M4Q2",
  questions: [
    { id: "q1", text: "Chair", maxMarks: 1, choices: [{ id: "c1", text: "Ada" }, { id: "c2", text: "Bea" }] },
  ],
  resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"] },
};

function sheet(code, scores, page, image) {
  return { ballotCode: code, imageSha256: image, fillScores: { q1: scores }, page };
}

describe("helper three-threshold consensus", () => {
  it("matches the core library on the same scores", () => {
    const ballots = [sheet(CODE_A, { c1: 52, c2: 0 }, 1, IMAGE_A), sheet(CODE_B, { c1: 100, c2: 3 }, 2, IMAGE_B)];
    expect(consensusReport(election, ballots)).toEqual(coreReport(election, ballots));
  });

  it("agrees, and the root does not depend on ballot order", () => {
    const first = sheet(CODE_A, { c1: 100, c2: 0 }, 1, IMAGE_A);
    const second = sheet(CODE_B, { c1: 0, c2: 0 }, 2, IMAGE_B);
    const forward = consensusReport(election, [first, second]);
    const backward = consensusReport(election, [second, first]);
    expect(forward.passed).toBe(true);
    expect(forward.roots.tight).toBe(forward.roots.loose);
    expect(backward.roots).toEqual(forward.roots);
    expect(JSON.stringify(forward)).not.toContain(CODE_A);
    expect(JSON.stringify(backward)).not.toContain(CODE_B);
  });

  it("flags a fill score of 52, which is unclear on the tight pass and marked on the others", () => {
    const report = consensusReport(election, [sheet(CODE_A, { c1: 52, c2: 0 }, 3, IMAGE_A)]);
    expect(report.passed).toBe(false);
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0].ovals[0]).toMatchObject({ fillScore: 52, tight: "unclear", standard: "marked", loose: "marked" });
    expect(report.flags[0].questions[0]).toMatchObject({ tight: "U", standard: "V:c1", loose: "V:c1" });
    const text = JSON.stringify(report);
    expect(text).not.toContain(CODE_A);
    expect(text).not.toContain("ballotCode");
  });

  it("attaches a code-free consensus block to the unsigned readings, before anything is signed", () => {
    const batch = { batchId: "batch-test", manifestSha256: "ab".repeat(32), manifest: { pages: [{}, {}] } };
    const page = (n, code, scores, image) => ({
      page: n,
      file: `page-${n}.png`,
      ballotCode: code,
      imageSha256: image,
      fillScores: { q1: scores },
      results: { q1: scores.c1 > 50 ? "V:c1" : "B" },
      resultsString: scores.c1 > 50 ? "V:c1" : "B",
      resultsHash: "0x" + "11".repeat(32),
    });
    const agreed = buildReadings({
      batch,
      electionFile: election,
      pages: [page(1, CODE_A, { c1: 100, c2: 0 }, IMAGE_A), page(2, CODE_B, { c1: 0, c2: 0 }, IMAGE_B)],
    });
    expect(agreed.summary.consensus).toBe("pass");
    expect(agreed.consensus.passed).toBe(true);
    expect(JSON.stringify(agreed.consensus)).not.toContain(CODE_A);
    expect(agreed.consensus.summary).toMatch(/agree/);
    expect(agreed.note).toMatch(/Nothing here has been signed/);

    const flagged = buildReadings({
      batch,
      electionFile: election,
      pages: [page(1, CODE_A, { c1: 52, c2: 0 }, IMAGE_A)],
    });
    expect(flagged.summary.consensus).toBe("flag");
    expect(flagged.consensus.needsHumanReview).toBe(true);
    expect(flagged.review.some((r) => r.why.some((w) => w.includes("three-threshold consensus") && w.includes("fill 52")))).toBe(true);
    expect(JSON.stringify(flagged.consensus)).not.toContain(CODE_A);
    expect(JSON.stringify(flagged.review)).not.toContain(CODE_A);
  });
});
