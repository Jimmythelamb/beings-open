// Run the existing mark reader (packages/scanner/prototype/omr.py + omr_finish.mjs) over a SEALED batch and write an
// UNSIGNED readings file for human review. It never signs, never uploads and never touches the ledger.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRecordable, codeChecks } from "./batch.mjs";
import { consensusReport, formatConsensusSummary } from "./consensus.mjs";
import { loadBatch, sha256 } from "./fsbatch.mjs";
import { poolsOf, proofForCode } from "./pool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PROTOTYPE_DIR = resolve(here, "../../scanner/prototype");
export const READINGS_KIND = "beings-readings/unsigned-1";

/** Load the full (secret) election file. A public copy has no ballot codes and is refused. */
export function loadFullElectionFile(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json?.publicCopy) throw new Error("This is the public copy of the election file. The reader needs the secret full file (with ballot codes).");
  const file = json?.file && Array.isArray(json.file.ballotCodes) ? json.file : json;
  if (!Array.isArray(file?.ballotCodes) || !file.ballotCodes.length) throw new Error("This election file has no ballot codes. Use the secret full file you saved when the election was created.");
  if (!Array.isArray(file.questions)) throw new Error("This election file has no questions.");
  return file;
}

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => res({ code: -1, out, err: String(e.message) }));
    p.on("close", (code) => res({ code, out, err }));
  });
}

/**
 * Default page reader: omr.py then omr_finish.mjs. Returns the omr_finish result object, or { error }.
 * workDir receives page-XX.omr.json, page-XX.result.json and page-XX.debug.png (private: they show the ballot code).
 */
export function makeOmrPageReader({ python = process.env.BEINGS_PYTHON || (process.platform === "win32" ? "python" : "python3"), node = process.execPath, prototypeDir = PROTOTYPE_DIR } = {}) {
  return async ({ imagePath, page, layoutPath, ballotListPath, electionPath, workDir }) => {
    const stem = join(workDir, `page-${String(page).padStart(2, "0")}`);
    const r1 = await run(python, [join(prototypeDir, "omr.py"), "--image", imagePath, "--layout", layoutPath, "--ballot-list", ballotListPath, "--election", electionPath, "--out", `${stem}.omr.json`, "--debug", `${stem}.debug.png`]);
    if (r1.code !== 0 || !existsSync(`${stem}.omr.json`)) return { error: `mark reader failed: ${lastLine(r1.err) || `exit ${r1.code}`}` };
    const r2 = await run(node, [join(prototypeDir, "omr_finish.mjs"), `${stem}.omr.json`, electionPath, imagePath, `${stem}.result.json`], { cwd: prototypeDir });
    if (r2.code !== 0 || !existsSync(`${stem}.result.json`)) return { error: `results step failed: ${lastLine(r2.err) || `exit ${r2.code}`}` };
    return { ...JSON.parse(readFileSync(`${stem}.result.json`, "utf8")), resultFile: `${stem}.result.json` };
  };
}
// Error lines from the reader can contain a decoded code; keep only the exception's type.
const lastLine = (s) => (String(s).trim().split(/\r?\n/).pop() ?? "").replace(/[A-Z0-9]{12}/g, "<code>").slice(0, 200);

/** Read every page of a batch (no seal check here: sealBatch uses this before DONE, readBatch after). */
export async function readPages(batch, { electionFile, electionPath, layoutPath, readPage = makeOmrPageReader(), workDir }) {
  mkdirSync(workDir, { recursive: true });
  // omr.py wants a ballot-list.json. It holds secret codes: write it to a private temp folder and remove it afterwards.
  const tmp = mkdtempSync(join(tmpdir(), "beings-blist-"));
  const ballotListPath = join(tmp, "ballot-list.json");
  writeFileSync(ballotListPath, JSON.stringify({ electionCode: electionFile.electionCode, ballots: electionFile.ballotCodes.map((ballotCode) => ({ ballotCode })) }));
  try {
    chmodSync(ballotListPath, 0o600);
  } catch {
    /* windows */
  }
  const out = [];
  try {
    for (const pg of batch.manifest.pages) {
      const imagePath = join(batch.dir, pg.file);
      const r = await readPage({ imagePath, page: pg.index, layoutPath, ballotListPath, electionPath, workDir });
      out.push({ page: pg.index, file: pg.file, manifestSha256: pg.sha256, ...r });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/** Build the readings file (unsigned) from page results. Pure. */
export function buildReadings({ batch, electionFile, pages, otherCodes = [], keccak = null }) {
  const problems = [];
  const readings = [];
  const review = [];
  for (const p of pages) {
    if (p.error) {
      review.push({ page: p.page, why: [p.error] });
      continue;
    }
    if (p.imageSha256 !== String(p.manifestSha256).toLowerCase()) problems.push(`page ${p.page}: the reader hashed different bytes than the sealed manifest`);
    const why = [...(p.coreValidationProblems ?? []).map((x) => String(x).replace(/[A-Z0-9]{12}/g, "<code>")), ...(p.unclearOvals?.length ? [`unclear marks: ${p.unclearOvals.join(", ")}`] : []), ...(p.lowConfidenceOvals?.length ? [`close to a threshold: ${p.lowConfidenceOvals.join(", ")}`] : [])];
    if (why.length) review.push({ page: p.page, why });
    const row = { scan: p.page, ballotCode: p.ballotCode ?? null, electionCode: electionFile.electionCode, fillScores: p.fillScores, results: p.results, resultsString: p.resultsString, resultsHash: p.resultsHash, imageSha256: p.imageSha256, imageFile: p.file };
    if (keccak && p.ballotCode) {
      const found = proofForCode(electionFile, p.ballotCode, keccak);
      if (found) {
        row.ballotProof = found.proof;
        row.ballotRootIndex = found.rootIndex;
      }
    }
    readings.push(row);
  }
  problems.push(...codeChecks(pages.map((p) => ({ page: p.page, ballotCode: p.error ? null : p.ballotCode ?? null })), poolsOf(electionFile).flat(), otherCodes));
  const counts = { B: 0, O: 0, U: 0, V: 0 };
  for (const r of readings) for (const v of Object.values(r.results ?? {})) counts[v === "B" || v === "O" || v === "U" ? v : "V"] += 1;
  const consensus = consensusFromReadings(electionFile, readings);
  if (!consensus.passed) {
    for (const f of consensus.flags) {
      const bits = f.ovals.map((o) => `${o.question}/${o.choice} fill ${o.fillScore} (${o.tight} / ${o.standard} / ${o.loose})`);
      const why = `three-threshold consensus disagrees${bits.length ? `: ${bits.join(", ")}` : ""}`;
      const existing = f.page !== undefined ? review.find((v) => v.page === f.page) : undefined;
      if (existing) existing.why.push(why);
      else if (f.page !== undefined) review.push({ page: f.page, why: [why] });
    }
  }
  return {
    kind: READINGS_KIND,
    private: true,
    note: "UNSIGNED readings for review. Contains ballot codes: keep private. The consensus block does not. Nothing here has been signed, uploaded or recorded.",
    electionCode: electionFile.electionCode,
    retentionDays: electionFile.imageRetention?.days ?? null,
    batch: { batchId: batch.batchId, manifestSha256: batch.manifestSha256, pages: batch.manifest.pages.length },
    summary: { pages: pages.length, read: readings.length, needsReview: review.length, problems: problems.length, perQuestionResults: counts, consensus: consensus.passed ? "pass" : "flag" },
    consensus,
    problems,
    review,
    readings,
  };
}

/** Re-read the scores already on each sheet at three thresholds. Codes stay in the readings rows, not in this block. */
function consensusFromReadings(electionFile, readings) {
  const rows = readings.filter((r) => r.fillScores);
  const allCoded = rows.length > 0 && rows.every((r) => r.ballotCode);
  const ballots = rows.map((r) => ({
    ...(allCoded ? { ballotCode: r.ballotCode } : {}),
    imageSha256: r.imageSha256,
    fillScores: r.fillScores,
    page: r.scan,
  }));
  const report = consensusReport(electionFile, ballots);
  return { ...report, summary: formatConsensusSummary(report) };
}

/** The whole read step: refuse anything not SEALED, re-hash, read, write the readings file. Returns the readings object. */
export async function readBatch(dir, { electionPath, layoutPath, outPath, readPage, otherCodes = [] }) {
  const batch = loadBatch(dir);
  assertRecordable(batch.status, batch.batchId);
  for (const pg of batch.manifest.pages) if (batch.files[pg.file]?.sha256 !== String(pg.sha256).toLowerCase()) throw new Error(`page ${pg.index}: the bytes on disk no longer match the sealed manifest. Do not record this batch.`);
  const electionFile = loadFullElectionFile(electionPath);
  if (electionFile.electionCode !== batch.manifest.electionCode) throw new Error(`This batch is for ${batch.manifest.electionCode} but the election file is for ${electionFile.electionCode}.`);
  const pages = await readPages(batch, { electionFile, electionPath, layoutPath, readPage, workDir: join(dir, "reader") });
  let keccak = null;
  try {
    const { keccak256 } = await import("ethers");
    keccak = (bytes) => keccak256(bytes);
  } catch {
    keccak = null;
  }
  const readings = buildReadings({ batch, electionFile, pages, otherCodes, keccak });
  if (outPath) writeFileSync(outPath, JSON.stringify(readings, null, 2) + "\n");
  return readings;
}

export { sha256 };
