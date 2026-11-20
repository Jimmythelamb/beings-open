// Upload step: send the ballot pictures of a SEALED, REVIEWED batch to the image store (POST /api/images).
// It is an explicit operator step: a dry run by default; it sends only with --approve <batchId> matching this batch.
// The upload itself is @beings/scanner's CLI (packages/scanner/src/cli.ts: uploadScan), run once per page, so the
// headers, hashing and the ballot-key (only keccak of the code is sent) stay in one place.
// The token is read by that CLI from SCANNER_UPLOAD_TOKEN in the environment only. It is never a flag, never logged.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRecordable } from "./batch.mjs";
import { loadBatch, sha256 } from "./fsbatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SCANNER_CLI = resolve(here, "../../scanner/src/cli.ts");
/** New uploads go to the R2 Worker. --url and IMAGE_STORE_URL still override this. */
export const DEFAULT_IMAGE_STORE_URL = "https://beings-ballot-images.beingsvote-test.workers.dev";

/**
 * Explicit url wins, then IMAGE_STORE_URL, otherwise the Worker.
 * An empty string is treated as unset.
 */
export function resolveUploadUrl(explicit, env = process.env) {
  const flag = typeof explicit === "string" ? explicit.trim() : "";
  if (flag) return flag;
  const fromEnv = typeof env?.IMAGE_STORE_URL === "string" ? env.IMAGE_STORE_URL.trim() : "";
  if (fromEnv) return fromEnv;
  return DEFAULT_IMAGE_STORE_URL;
}

/**
 * Work out exactly what would be sent, and refuse on any mismatch. Pure apart from reading files.
 * readings: the object written by `beings-batch read` (after the operator reviewed it).
 */
export function planUpload(dir, readings, { retentionDays, includeFlagged = false } = {}) {
  const batch = loadBatch(dir);
  assertRecordable(batch.status, batch.batchId);
  const problems = [];
  if (readings?.kind !== "beings-readings/unsigned-1") problems.push("this is not a readings file from `beings-batch read`");
  if (readings?.batch?.batchId !== batch.batchId) problems.push("the readings file is for a different batch");
  if (readings?.batch?.manifestSha256 !== batch.manifestSha256) problems.push("the readings file was made from a different manifest (the batch changed since it was read)");
  if (readings?.electionCode !== batch.manifest.electionCode) problems.push("the readings file is for a different election");
  if (readings?.problems?.length) problems.push(`the readings file lists ${readings.problems.length} problem(s); resolve them before uploading`);
  const days = retentionDays ?? readings?.retentionDays;
  if (!Number.isSafeInteger(days) || days < 1) problems.push("retention days are unknown: pass --retention-days (the election file's imageRetention.days)");
  else if (readings?.retentionDays != null && readings.retentionDays !== days) problems.push(`--retention-days ${days} differs from the election file's ${readings.retentionDays}`);
  const flagged = new Set((readings?.review ?? []).map((r) => r.page));
  const items = [];
  const skipped = [];
  for (const r of readings?.readings ?? []) {
    const pg = batch.manifest.pages.find((p) => p.index === r.scan);
    if (!pg) {
      problems.push(`reading for page ${r.scan} has no page in the manifest`);
      continue;
    }
    if (flagged.has(r.scan) && !includeFlagged) {
      skipped.push({ page: r.scan, why: "flagged for review (use --include-flagged after checking it)" });
      continue;
    }
    const onDisk = batch.files[pg.file]?.sha256;
    if (onDisk !== String(pg.sha256).toLowerCase() || r.imageSha256 !== onDisk) {
      problems.push(`page ${r.scan}: picture bytes do not match the sealed manifest and the reading`);
      continue;
    }
    if (!r.ballotCode) {
      problems.push(`page ${r.scan}: no ballot code`);
      continue;
    }
    const item = { page: r.scan, file: join(dir, pg.file), imageSha256: onDisk, resultFile: join(dir, "reader", `page-${String(r.scan).padStart(2, "0")}.result.json`) };
    if (Array.isArray(r.ballotProof) && Number.isInteger(r.ballotRootIndex)) {
      item.ballotProof = r.ballotProof;
      item.ballotRootIndex = r.ballotRootIndex;
    }
    items.push(item);
  }
  for (const it of items) if (!existsSync(it.resultFile)) problems.push(`page ${it.page}: reader result file is missing`);
  return { batchId: batch.batchId, electionCode: batch.manifest.electionCode, retentionDays: days, items, skipped, problems };
}

function runCli(args, env) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--import", "tsx", SCANNER_CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env, shell: false, cwd: resolve(here, "../../scanner") });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => res({ code: -1, out, err: e.message }));
    p.on("close", (code) => res({ code, out, err }));
  });
}

/**
 * Send the planned pages, one at a time. Stops at the first refusal. Writes upload-receipt.json in the batch folder.
 * approve must equal the batch id (typed by the operator). url: the image store origin (https, or http://localhost for tests).
 * When url and IMAGE_STORE_URL are both unset, the upload goes to the R2 Worker.
 */
export async function runUpload(plan, { approve, url, env = process.env, send = runCli, now = () => new Date().toISOString() }) {
  if (plan.problems.length) throw new Error(`Not uploading: ${plan.problems.join("; ")}`);
  if (approve !== plan.batchId) throw new Error(`Not uploading: --approve must be exactly ${plan.batchId}`);
  if (!env.SCANNER_UPLOAD_TOKEN) throw new Error("Not uploading: SCANNER_UPLOAD_TOKEN is not set in this window's environment.");
  const target = resolveUploadUrl(url, env);
  const results = [];
  for (const it of plan.items) {
    const args = ["--file", it.file, "--result", it.resultFile, "--election", plan.electionCode, "--retention-days", String(plan.retentionDays), "--url", target];
    if (Array.isArray(it.ballotProof)) args.push("--ballot-proof", it.ballotProof.join(","), "--root-index", String(it.ballotRootIndex));
    const r = await send(args, env);
    const ok = r.code === 0;
    let parsed = null;
    try {
      parsed = ok ? JSON.parse(r.out) : null;
    } catch {
      parsed = null;
    }
    const safeErr = String(r.err || "").replace(env.SCANNER_UPLOAD_TOKEN, "<token>").replace(/[A-Z0-9]{12}/g, "<code>").trim().split(/\r?\n/).pop();
    results.push({ page: it.page, imageSha256: it.imageSha256, ok, status: parsed?.status ?? null, deleteAfter: parsed?.deleteAfter ?? null, error: ok ? null : safeErr || `exit ${r.code}` });
    if (!ok) break;
  }
  return { batchId: plan.batchId, electionCode: plan.electionCode, at: now(), sent: results.filter((r) => r.ok).length, planned: plan.items.length, skipped: plan.skipped, results };
}

export function writeReceipt(dir, receipt) {
  const p = join(dir, `upload-receipt-${receipt.at.replace(/[:.]/g, "")}.json`);
  writeFileSync(p, JSON.stringify(receipt, null, 2) + "\n");
  return p;
}

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export { sha256 };
