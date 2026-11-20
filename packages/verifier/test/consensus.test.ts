import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConsensusInputs, runConsensus, writeConsensusFiles } from "../src/consensusFiles.js";

const CODE = "4F9Q7M2XHT8B";
const IMAGE = "ab".repeat(32);

const election = {
  questions: [{ id: "q1", text: "Chair", maxMarks: 1, choices: [{ id: "c1", text: "Ada" }, { id: "c2", text: "Bea" }] }],
  resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"] as ["V", "B", "O", "U"] },
};

describe("beings-consensus files", () => {
  it("writes a report and a summary, and drops the ballot code", () => {
    const dir = mkdtempSync(join(tmpdir(), "beings-consensus-"));
    const scores = join(dir, "scores.json");
    writeFileSync(scores, JSON.stringify({
      ...election,
      ballots: [{ ballotCode: CODE, imageSha256: IMAGE, fillScores: { q1: { c1: 52, c2: 0 } }, page: 1 }],
    }));
    const inputs = loadConsensusInputs({ scores });
    const report = runConsensus(inputs);
    writeConsensusFiles(dir, report);
    const written = readFileSync(join(dir, "report.json"), "utf8");
    const summary = readFileSync(join(dir, "summary.txt"), "utf8");
    expect(written).not.toContain(CODE);
    expect(summary).not.toContain(CODE);
    expect(written).not.toContain("ballotCode");
    expect(report.passed).toBe(false);
    expect(report.flags[0]?.ovals[0]).toMatchObject({ fillScore: 52, tight: "unclear", standard: "marked", loose: "marked" });
    expect(summary).toMatch(/human look/);
    expect(summary).toMatch(/fill 52/);
  });

  it("agrees when the same scores are clear on every pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "beings-consensus-"));
    const readings = join(dir, "readings.json");
    const electionFile = join(dir, "election.json");
    writeFileSync(electionFile, JSON.stringify(election));
    writeFileSync(readings, JSON.stringify({
      readings: [{ ballotCode: CODE, scan: 2, imageSha256: IMAGE, fillScores: { q1: { c1: 0, c2: 100 } } }],
    }));
    const report = runConsensus(loadConsensusInputs({ readings, electionFile }));
    expect(report.passed).toBe(true);
    expect(report.roots.tight).toBe(report.roots.loose);
    expect(JSON.stringify(report)).not.toContain(CODE);
  });
});
