#!/usr/bin/env node
// beings-consensus: re-read fill scores that were already computed, at three thresholds, and compare Merkle roots.
// Read-only. No key, no transaction, no second scan. Ballot codes in a readings file are hashed and never written out.
//
//   beings-consensus --scores scores.json --out ./consensus
//   beings-consensus --readings readings.json --election-file election-file.json --out ./consensus
//
// Exit code: 0 the three roots match, 2 they do not (a person should look), 1 could not run.
import { resolve } from "node:path";
import { parseFlags } from "./cliArgs.js";
import { consensusExitCode, loadConsensusInputs, runConsensus, writeConsensusFiles } from "./consensusFiles.js";
import { formatConsensusSummary } from "@beings/core";

const USAGE = `usage: beings-consensus (--scores <scores.json> | --readings <readings.json> --election-file <election-file.json>) --out <dir>`;

async function main(): Promise<number> {
  const a = parseFlags(process.argv.slice(2));
  if (a.help || a.h) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a.out !== "string") throw new Error(`--out <directory> is required\n${USAGE}`);
  const inputs = loadConsensusInputs({
    ...(typeof a.scores === "string" ? { scores: a.scores } : {}),
    ...(typeof a.readings === "string" ? { readings: a.readings } : {}),
    ...(typeof a["election-file"] === "string" ? { electionFile: a["election-file"] } : {}),
  });
  const report = runConsensus(inputs);
  const out = resolve(a.out);
  writeConsensusFiles(out, report);
  console.log(formatConsensusSummary(report));
  console.log(`files: ${out} (report.json, summary.txt)`);
  return consensusExitCode(report);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
