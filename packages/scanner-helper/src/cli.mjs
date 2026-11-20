#!/usr/bin/env node
// beings-batch: the Node side of the polling-PC scanner helper. Nothing here signs, records on the ledger, or prints
// ballot codes to the screen.
//
//   beings-batch status   <electionFolder>                     list batches and whether each may be recorded
//   beings-batch verify   <batchFolder>                        re-check counts and hashes (read-only)
//   beings-batch seal     <batchFolder> [--election-file F --layout L]   checks + DONE line (with decode if files given)
//   beings-batch supersede <batchFolder> --reason "..." [--replaced-by batch-...] [--force]
//   beings-batch read     <batchFolder> --election-file F --layout L --out readings.json
//   beings-batch upload   <batchFolder> --readings readings.json [--retention-days N] [--url U] [--include-flagged] [--approve batch-...]
//   --url and IMAGE_STORE_URL override the default R2 Worker origin.
//   beings-batch pdf-pages <ballots.pdf> [--expect N]
//   beings-batch bridge   --output-root <BEINGS-Scans folder> [--port 8765] [--allow-origin URL ...] [--station-address 0x... [--station-label NAME]] [--station-file path]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBatch, listBatches, sealBatch, supersedeBatch } from "./fsbatch.mjs";
import { checkBatch, pageCountCheck } from "./batch.mjs";
import { loadFullElectionFile, readBatch, readPages } from "./reader.mjs";
import { poolsOf } from "./pool.mjs";
import { planUpload, runUpload, writeReceipt, readJson } from "./upload.mjs";
import { countPdfPages, printPageCheck } from "./pdf.mjs";
import { createBridge, DEFAULT_ORIGINS, DEFAULT_PORT, parseStationWallet } from "./bridge.mjs";

export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    const v = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (k === "allow-origin") (opt[k] ??= []).push(v);
    else opt[k] = v;
  }
  return { pos, opt };
}

const say = (s) => process.stdout.write(s + "\n");

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  const need = (k) => {
    if (typeof opt[k] !== "string") throw new Error(`--${k} is required`);
    return opt[k];
  };
  switch (cmd) {
    case "status": {
      const list = listBatches(resolve(pos[0] ?? "."));
      if (!list.length) say("No batch folders here.");
      for (const b of list) say(`${b.batchId}  ${b.status.state.padEnd(11)} ${b.status.recordable ? "RECORDABLE" : "not recordable"}  ${pageCountCheck(b.manifest ?? {}).message}${b.status.reasons.length ? `  (${b.status.reasons.join("; ")})` : ""}`);
      return 0;
    }
    case "verify": {
      const b = loadBatch(resolve(pos[0]));
      const r = b.manifest ? checkBatch(b.manifest, b.files) : { problems: b.status.reasons, warnings: [] };
      say(`${b.batchId}: ${b.status.state}${b.status.recordable ? " (recordable)" : ""}`);
      for (const p of r.problems) say(`  PROBLEM ${p}`);
      for (const w of r.warnings) say(`  warning ${w}`);
      if (!r.problems.length) say("  pages, sizes and fingerprints all match the manifest");
      return r.problems.length ? 2 : 0;
    }
    case "seal": {
      const dir = resolve(pos[0]);
      let decode = null;
      let ballotCodes = null;
      if (opt["election-file"]) {
        const electionPath = resolve(need("election-file"));
        const layoutPath = resolve(need("layout"));
        const electionFile = loadFullElectionFile(electionPath);
        ballotCodes = poolsOf(electionFile).flat();
        decode = async (batch) => (await readPages(batch, { electionFile, electionPath, layoutPath, workDir: resolve(dir, "reader") })).map((p) => ({ page: p.page, ballotCode: p.error ? null : p.ballotCode ?? null }));
      }
      const r = await sealBatch(dir, { electionDir: dirname(dir), decode, ballotCodes });
      for (const w of r.warnings) say(`warning: ${w}`);
      if (r.sealed) {
        say(r.already ? "Already sealed." : `SEALED. ${r.line}`);
        if (!decode) say("Note: ballot codes were not decoded at seal time. `read` will still refuse duplicates and codes not on the list.");
        return 0;
      }
      say("NOT SEALED. INCOMPLETE / QUARANTINED: do not record this batch.");
      for (const p of r.problems) say(`  - ${p}`);
      return 2;
    }
    case "supersede": {
      const r = supersedeBatch(resolve(pos[0]), { reason: need("reason"), replacedBy: typeof opt["replaced-by"] === "string" ? opt["replaced-by"] : null, force: !!opt.force });
      say(r.already ? "Already superseded." : r.line);
      return 0;
    }
    case "read": {
      const out = resolve(need("out"));
      const r = await readBatch(resolve(pos[0]), { electionPath: resolve(need("election-file")), layoutPath: resolve(need("layout")), outPath: out });
      say(`Read ${r.summary.read} of ${r.summary.pages} pages. ${r.summary.needsReview} need a human look. ${r.summary.problems} problem(s).`);
      for (const p of r.problems) say(`  PROBLEM ${p}`);
      for (const v of r.review) say(`  review page ${v.page}: ${v.why.join("; ")}`);
      if (r.consensus?.summary) say(r.consensus.summary);
      say(`Unsigned readings written to ${out} (private: it holds ballot codes). Nothing was signed or recorded.`);
      return r.problems.length ? 2 : 0;
    }
    case "upload": {
      const dir = resolve(pos[0]);
      const readings = readJson(resolve(need("readings")));
      const plan = planUpload(dir, readings, { retentionDays: opt["retention-days"] ? Number(opt["retention-days"]) : undefined, includeFlagged: !!opt["include-flagged"] });
      say(`Upload plan for ${plan.batchId} (${plan.electionCode}): ${plan.items.length} picture(s), keep ${plan.retentionDays} days.`);
      for (const it of plan.items) say(`  page ${it.page}  sha256 ${it.imageSha256}`);
      for (const s of plan.skipped) say(`  skip page ${s.page}: ${s.why}`);
      for (const p of plan.problems) say(`  PROBLEM ${p}`);
      if (plan.problems.length) return 2;
      if (typeof opt.approve !== "string") {
        say(`Dry run only. To send, set SCANNER_UPLOAD_TOKEN in this window and re-run with --approve ${plan.batchId}`);
        return 0;
      }
      const receipt = await runUpload(plan, { approve: opt.approve, url: typeof opt.url === "string" ? opt.url : undefined });
      const p = writeReceipt(dir, receipt);
      say(`Sent ${receipt.sent} of ${receipt.planned}. Receipt: ${p}`);
      for (const r of receipt.results.filter((x) => !x.ok)) say(`  page ${r.page} FAILED: ${r.error}`);
      return receipt.sent === receipt.planned ? 0 : 2;
    }
    case "pdf-pages": {
      const pages = await countPdfPages(new Uint8Array(readFileSync(resolve(pos[0]))));
      const c = printPageCheck(pages, opt.expect ? Number(opt.expect) : null);
      say(JSON.stringify({ pages, ok: c.ok, message: c.message }));
      return c.ok ? 0 : 2;
    }
    case "bridge": {
      const port = opt.port ? Number(opt.port) : DEFAULT_PORT;
      const origins = opt["allow-origin"]?.length ? opt["allow-origin"] : DEFAULT_ORIGINS;
      let stationWallet = null;
      if (typeof opt["station-file"] === "string") {
        let raw;
        try {
          raw = JSON.parse(readFileSync(resolve(opt["station-file"]), "utf8"));
        } catch {
          throw new Error("could not read --station-file as JSON");
        }
        const parsed = parseStationWallet(raw);
        if (parsed.error) throw new Error(parsed.error);
        stationWallet = parsed.wallet;
      }
      if (typeof opt["station-address"] === "string") {
        const parsed = parseStationWallet({ address: opt["station-address"], label: typeof opt["station-label"] === "string" ? opt["station-label"] : "" });
        if (parsed.error) throw new Error(parsed.error);
        stationWallet = parsed.wallet;
      }
      const helperRoot = dirname(fileURLToPath(import.meta.url));
      const logPath = process.env.BEINGS_HELPER_LOG || (existsSync(join(helperRoot, "../install.json")) ? join(helperRoot, "../helper.log") : "");
      const log = (s) => {
        say(`[bridge] ${s}`);
        if (!logPath) return;
        try { appendFileSync(logPath, `${new Date().toISOString()} ${s}\n`); } catch { /* keep serving */ }
      };
      const b = createBridge({ outputRoot: resolve(need("output-root")), port, origins, stationWallet, log });
      const a = await b.listen();
      const walletLine = stationWallet ? ` Station wallet (public address only): ${stationWallet.address}.` : " No station wallet configured (the helper never holds a key).";
      const also6 = b.server6?.listening ? ` and http://[::1]:${a.port}` : "";
      log(`listening on http://127.0.0.1:${a.port}${also6}`);
      say(`Scanner bridge listening on http://127.0.0.1:${a.port}${also6} for ${origins.join(", ")}.${walletLine} Ctrl+C to stop.`);
      return new Promise(() => {});
    }
    default:
      say("usage: beings-batch status|verify|seal|supersede|read|upload|pdf-pages|bridge ... (see the comment at the top of src/cli.mjs)");
      return cmd ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    },
  );
}
