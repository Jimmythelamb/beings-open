#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateElection } from "./generate.js";
import { writeOutputs } from "./files.js";

const HELP = `beings-ballots: B.E.I.N.G.S. ballot generator (M2)

Usage:
  beings-ballots --election <file.json> --count <N> --out <dir> [--force]

  --election  election file (core schema). "ballotCodes" may be missing or empty; "electionCode" is made if missing.
  --count     number of ballots to print, including spares (required unless the file already lists ballotCodes)
  --out       output directory
  --force     overwrite existing output files (this makes NEW ballot codes)
  --site-origin  https origin encoded in the receipt QR (default https://beingsvote.live)

Writes ballots.pdf (Letter, one ballot per page, shuffled), ballot-layout.json, election-file.json (with ballotCodes),
ballot-list.json (codes, keys, ballotListRoot) and manifest.json (hashes and the createElection arguments).
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      election: { type: "string" },
      count: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "site-origin": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!values.election || !values.out) {
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(values.election, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${values.election}: ${(e as Error).message}`);
  }
  let count: number | undefined;
  if (values.count !== undefined) {
    if (!/^[0-9]+$/.test(values.count)) throw new Error("--count must be a whole number");
    count = Number(values.count);
  }
  const g = await generateElection(json, { ...(count === undefined ? {} : { count }), ...(values["site-origin"] ? { siteOrigin: values["site-origin"] } : {}) });
  const files = writeOutputs(g, values.out, values.force);
  process.stdout.write(`Election ${g.electionFile.electionCode}: ${g.ballotList.count} ballots\n`);
  for (const f of files) process.stdout.write(`  wrote ${f}\n`);
  process.stdout.write(`  ballotListRoot ${g.ballotList.ballotListRoot}\n  election file sha256 ${g.electionFileSha256}\n  layout sha256 ${g.layoutSha256}\n`);
  for (const w of g.warnings) process.stdout.write(`  warning: ${w}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
