#!/usr/bin/env node
// beings-blind-reread: an independent second reading of every ballot image from a MASKED copy (ovals only),
// compared with the on-chain record by imageSha256. Read-only: no key, no transaction.
//
//   beings-blind-reread --election BEINGS-2026-XXXXXX --images ./verified-images \
//       --election-file election-file.json --layout ballot-layout.json [--out ./blind-reread] \
//       [--rpc <url>] [--ledger 0x...] [--from-block N] [--to-block N] [--chunk 30]   (chain, read-only)
//       [--chain-records records.json]   (offline instead of the RPC: [{imageSha256, results}])
//       [--reader opencv | --reader-cmd "<command>"] [--python python3] [--keep-ids] [--strict]
//
// Exit code: 0 no mismatch, 2 at least one mismatch (with --strict: any image that is not a match), 1 could not run.
import { JsonRpcProvider } from "ethers";
import { resolve } from "node:path";
import { formatConsensusSummary } from "@beings/core";
import { blindExitCode, blindReread, formatBlindSummary, writeBlindFiles } from "./blind.js";
import { runConsensus, writeConsensusFiles } from "./consensusFiles.js";
import { BLIND_FLAGS, listImageFiles, loadBlindInputs, readChainRecordsFile, requireElection } from "./blindCommon.js";
import { intFlag, parseFlags } from "./cliArgs.js";
import { COSTON2_BALLOT_LEDGER, COSTON2_LEDGER_DEPLOY_BLOCK, COSTON2_RPC_URL, readLedgerImages, type LogSource } from "./imageVerify.js";

const USAGE = `usage: beings-blind-reread --election <code> --images <dir> ${BLIND_FLAGS} [--out <dir>] [--chain-records <file> | --rpc <url> --ledger <address> --from-block N --to-block N --chunk 30]`;

async function main(): Promise<number> {
  const a = parseFlags(process.argv.slice(2));
  if (a.help || a.h) {
    console.log(USAGE);
    return 0;
  }
  const election = requireElection(a, USAGE);
  if (typeof a.images !== "string") throw new Error(`--images <directory> is required\n${USAGE}`);
  const inputs = loadBlindInputs(a, election);
  const out = resolve(typeof a.out === "string" ? a.out : "blind-reread");
  const images = listImageFiles(a.images);
  if (images.length === 0) throw new Error(`no .png/.jpg images in ${a.images}`);

  let chain;
  if (typeof a["chain-records"] === "string") {
    chain = readChainRecordsFile(a["chain-records"]);
    console.error(`chain records from ${a["chain-records"]} (offline): ${chain.size} image hash(es)`);
  } else {
    const provider = new JsonRpcProvider(typeof a.rpc === "string" ? a.rpc : COSTON2_RPC_URL, undefined, { staticNetwork: true });
    console.error("reading the ledger (BallotAccepted events, read-only)...");
    const ledger = await readLedgerImages(provider as unknown as LogSource, election, {
      ledgerAddress: typeof a.ledger === "string" ? a.ledger : COSTON2_BALLOT_LEDGER,
      fromBlock: intFlag(a, "from-block") ?? COSTON2_LEDGER_DEPLOY_BLOCK,
      ...(intFlag(a, "to-block") !== undefined ? { toBlock: intFlag(a, "to-block")! } : {}),
      ...(intFlag(a, "chunk") !== undefined ? { chunk: Math.max(1, intFlag(a, "chunk")!) } : {}),
      concurrency: 4,
    });
    console.error(`  ${ledger.records} record(s) in blocks ${ledger.fromBlock}-${ledger.toBlock}`);
    chain = ledger.entries ?? new Map();
  }

  console.error(`masking and re-reading ${images.length} image(s)...`);
  const { report, maskManifest } = await blindReread({
    electionCode: election,
    election: inputs.election,
    layoutPath: inputs.layoutPath,
    images,
    chain,
    outDir: out,
    reader: inputs.reader,
    python: inputs.python,
    keepIds: inputs.keepIds,
    onProgress: (d, t) => console.error(`  ${d}/${t}`),
  });
  writeBlindFiles(out, report, maskManifest);
  console.log(formatBlindSummary(report));
  const scored = report.entries.filter((e) => e.fillScores);
  if (scored.length) {
    const consensus = runConsensus({
      election: inputs.election,
      ballots: scored.map((e) => ({ imageSha256: e.imageSha256, fillScores: e.fillScores! })),
    });
    writeConsensusFiles(out, consensus, { report: "consensus-report.json", summary: "consensus-summary.txt" });
    console.log(formatConsensusSummary(consensus));
  }
  console.log(`files: ${out} (masked/, masked-manifest.json, report.json, summary.txt, consensus-report.json, consensus-summary.txt)`);
  return blindExitCode(report, inputs.strict);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
