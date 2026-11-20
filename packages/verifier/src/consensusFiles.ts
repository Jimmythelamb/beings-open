// Three-threshold consensus over fill scores that were already computed (no second scan, no chain write).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { consensusReport, formatConsensusSummary, type ConsensusBallot, type ConsensusElection, type ConsensusReport } from "@beings/core";

export interface ConsensusInputs {
  election: ConsensusElection;
  ballots: ConsensusBallot[];
}

function asElection(json: unknown): ConsensusElection {
  const wrapped = json as { file?: ConsensusElection; questions?: unknown; resultRules?: ConsensusElection["resultRules"]; consensusThresholds?: ConsensusElection["consensusThresholds"] };
  const file = wrapped?.file && Array.isArray(wrapped.file.questions) ? wrapped.file : (json as ConsensusElection);
  if (!Array.isArray(file?.questions) || !file.resultRules) throw new Error("the election file has no questions or resultRules");
  return {
    questions: file.questions,
    resultRules: file.resultRules,
    ...(file.consensusThresholds ? { consensusThresholds: file.consensusThresholds } : {}),
  };
}

/** `--scores` is `{ questions, resultRules, consensusThresholds?, ballots }`. A readings file also needs `--election-file`. */
export function loadConsensusInputs(opts: { scores?: string; readings?: string; electionFile?: string }): ConsensusInputs {
  if (opts.scores) {
    const json = JSON.parse(readFileSync(resolve(opts.scores), "utf8")) as { ballots?: ConsensusBallot[] };
    if (!Array.isArray(json.ballots)) throw new Error("--scores file needs a ballots array of {fillScores, imageSha256 or ballotCode}");
    return { election: asElection(json), ballots: json.ballots };
  }
  if (opts.readings && opts.electionFile) {
    const readings = JSON.parse(readFileSync(resolve(opts.readings), "utf8")) as { readings?: { ballotCode?: string; imageSha256?: string; fillScores?: ConsensusBallot["fillScores"]; scan?: number; page?: number }[] };
    if (!Array.isArray(readings.readings)) throw new Error("the readings file has no readings array");
    const ballots: ConsensusBallot[] = [];
    for (const row of readings.readings) {
      if (!row.fillScores) continue;
      ballots.push({
        ...(row.ballotCode ? { ballotCode: row.ballotCode } : {}),
        ...(row.imageSha256 ? { imageSha256: row.imageSha256 } : {}),
        fillScores: row.fillScores,
        ...(row.scan !== undefined ? { page: row.scan } : row.page !== undefined ? { page: row.page } : {}),
      });
    }
    return { election: asElection(JSON.parse(readFileSync(resolve(opts.electionFile), "utf8"))), ballots };
  }
  throw new Error("pass --scores <file>, or both --readings <file> and --election-file <file>");
}

export function runConsensus(inputs: ConsensusInputs): ConsensusReport {
  return consensusReport(inputs.election, inputs.ballots);
}

export function writeConsensusFiles(outDir: string, report: ConsensusReport, names: { report?: string; summary?: string } = {}): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, names.report ?? "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, names.summary ?? "summary.txt"), formatConsensusSummary(report) + "\n");
}

export function consensusExitCode(report: ConsensusReport): number {
  return report.passed ? 0 : 2;
}
