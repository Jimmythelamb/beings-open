#!/usr/bin/env node
// beings-verify-images: download every ballot image of an election from the image store (verifier-only, signed
// challenge) and check each one against the manifest and the on-chain BallotLedger.
//
//   VERIFIER_PRIVATE_KEY=0x... beings-verify-images --election BEINGS-2026-XXXXXX --out ./images \
//       [--url https://beingsvote.live] [--rpc https://coston2-api.flare.network/ext/C/rpc] \
//       [--ledger 0x...] [--from-block N] [--to-block N] [--chunk 30] [--concurrency 4]
//
// The private key comes from the environment only (never a flag, so it does not land in shell history) and is
// never printed or written; only the address it controls is shown. Exit code: 0 all good, 2 discrepancies, 1 error.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { isElectionCode } from "@beings/core";
import { blindExitCode, blindReread, formatBlindSummary, writeBlindFiles } from "./blind.js";
import { BLIND_FLAGS, listImageFiles, loadBlindInputs } from "./blindCommon.js";
import { intFlag, parseFlags as parse } from "./cliArgs.js";
import {
  COSTON2_BALLOT_LEDGER,
  COSTON2_LEDGER_DEPLOY_BLOCK,
  COSTON2_RPC_URL,
  DEFAULT_STORE_URL,
  StoreClient,
  imageFileName,
  readLedgerImages,
  verifyImages,
  type LogSource,
} from "./imageVerify.js";

const USAGE = `usage: VERIFIER_PRIVATE_KEY=0x... beings-verify-images --election <code> --out <dir> [--url ${DEFAULT_STORE_URL}] [--rpc <url>] [--ledger <address>] [--from-block N] [--to-block N] [--chunk 30] [--concurrency 4] [--blind-reread ${BLIND_FLAGS}]`;

async function main(): Promise<number> {
  const a = parse(process.argv.slice(2));
  if (a.help || a.h) {
    console.log(USAGE);
    return 0;
  }
  const election = a.election;
  if (typeof election !== "string" || !isElectionCode(election)) throw new Error(`--election <BEINGS-YYYY-XXXXXX> is required\n${USAGE}`);
  if (typeof a.out !== "string") throw new Error(`--out <directory> is required\n${USAGE}`);
  const key = process.env.VERIFIER_PRIVATE_KEY?.trim();
  if (!key) throw new Error("set VERIFIER_PRIVATE_KEY in the environment (the key of a registered verifier address)");
  let wallet: Wallet;
  try {
    wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
  } catch {
    throw new Error("VERIFIER_PRIVATE_KEY is not a valid private key"); // never echo the value
  }
  const blind = a["blind-reread"] === true ? loadBlindInputs(a, election) : undefined; // fail on bad blind flags before any download
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });

  const provider = new JsonRpcProvider(typeof a.rpc === "string" ? a.rpc : COSTON2_RPC_URL, undefined, { staticNetwork: true });
  const store = new StoreClient({ storeUrl: typeof a.url === "string" ? a.url : DEFAULT_STORE_URL, election, signer: wallet });
  const concurrency = intFlag(a, "concurrency") ?? 4;
  console.error(`verifier ${wallet.address}, election ${election}`);

  console.error("reading the ledger (BallotAccepted events)...");
  let lastPct = -1;
  const ledger = await readLedgerImages(provider as unknown as LogSource, election, {
    ledgerAddress: typeof a.ledger === "string" ? a.ledger : COSTON2_BALLOT_LEDGER,
    fromBlock: intFlag(a, "from-block") ?? COSTON2_LEDGER_DEPLOY_BLOCK,
    ...(intFlag(a, "to-block") !== undefined ? { toBlock: intFlag(a, "to-block")! } : {}),
    ...(intFlag(a, "chunk") !== undefined ? { chunk: Math.max(1, intFlag(a, "chunk")!) } : {}),
    concurrency,
    onProgress: (d, t) => {
      const pct = Math.floor((d / t) * 10) * 10;
      if (pct !== lastPct) console.error(`  ledger scan ${Math.floor((d / t) * 100)}%`);
      lastPct = pct;
    },
  });
  console.error(`  ${ledger.records} record(s), ${ledger.hashes.size} distinct image hash(es), blocks ${ledger.fromBlock}-${ledger.toBlock}`);

  console.error("downloading and checking images...");
  const { report, manifest } = await verifyImages({
    election,
    signerAddress: wallet.address,
    store,
    ledger,
    concurrency,
    onVerified: (entry, bytes) => writeFileSync(join(out, imageFileName(entry)), bytes),
    onProgress: (d, t) => {
      if (d === t || d % 25 === 0) console.error(`  ${d}/${t}`);
    },
  });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`election ${report.election}: ${report.verified.length} verified, ${report.problems.length} problem(s); manifest ${report.manifestCount}, on-chain ${report.onChain.distinctImageHashes} distinct`);
  for (const p of report.problems) console.log(`  ${p.kind.toUpperCase()} ${p.imageHash}: ${p.detail}`);
  console.log(report.ok ? "OK: every image matches the manifest and the ledger, and every ledger image hash was served." : "DISCREPANCIES FOUND (see report.json). Unverified images were not saved.");
  console.log(`files: ${out}`);
  let code = report.ok ? 0 : 2;
  if (blind) {
    // Layer 2: re-read the images that passed layer 1 from masked copies and compare with the on-chain results.
    console.error("blind re-read: masking and re-reading the verified images...");
    const images = listImageFiles(out).filter((i) => report.verified.some((h) => i.path.includes(h)));
    const blindOut = join(out, "blind");
    const { report: br, maskManifest } = await blindReread({
      electionCode: election,
      election: blind.election,
      layoutPath: blind.layoutPath,
      images,
      chain: ledger.entries ?? new Map(),
      outDir: blindOut,
      reader: blind.reader,
      python: blind.python,
      keepIds: blind.keepIds,
    });
    writeBlindFiles(blindOut, br, maskManifest);
    console.log(formatBlindSummary(br));
    console.log(`blind re-read files: ${blindOut}`);
    code = Math.max(code, blindExitCode(br, blind.strict));
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
