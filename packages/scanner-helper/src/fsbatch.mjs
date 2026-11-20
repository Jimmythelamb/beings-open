// File-system side of a scan batch: read a batch folder, seal it, supersede it, list an election's batches.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { pngSize } from "./png.mjs";
import { BATCH_ID_RE, batchStatus, checkBatch, codeChecks, crossBatchDuplicateImages, formatDoneLine, formatSupersededLine } from "./batch.mjs";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const nowIso = () => new Date().toISOString();

/** Everything about one batch folder, measured now. */
export function loadBatch(dir) {
  const manifestPath = join(dir, "manifest.json");
  let manifest = null;
  let manifestSha256 = null;
  let manifestError = null;
  if (existsSync(manifestPath)) {
    const raw = readFileSync(manifestPath);
    manifestSha256 = sha256(raw);
    try {
      manifest = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
    } catch (e) {
      manifestError = `manifest.json is not valid JSON: ${e.message}`;
    }
  }
  const files = {};
  for (const name of readdirSync(dir)) {
    if (!/^page-\d+\.png$/i.test(name)) continue;
    const buf = readFileSync(join(dir, name));
    const size = pngSize(buf);
    files[name] = { bytes: buf.length, sha256: sha256(buf), width: size?.width ?? null, height: size?.height ?? null };
  }
  const doneText = readText(join(dir, "DONE.txt"));
  const supersededText = readText(join(dir, "SUPERSEDED.txt"));
  const quarantinedText = readText(join(dir, "QUARANTINED.txt"));
  let status = manifestError ? { state: "QUARANTINED", recordable: false, reasons: [manifestError] } : batchStatus({ manifest, manifestSha256, doneText, supersededText, quarantinedText });
  if (status.recordable) {
    // a sealed batch is only recordable while every picture still has the bytes it was sealed with
    const changed = manifest.pages.filter((p) => files[p.file]?.sha256 !== String(p.sha256).toLowerCase()).map((p) => p.index);
    if (changed.length) status = { state: "QUARANTINED", recordable: false, reasons: [`picture(s) changed or missing since sealing: page ${changed.join(", ")}`] };
  }
  return { dir, batchId: manifest?.batchId ?? basename(dir), manifest, manifestSha256, files, status };
}

/** All batch folders under an election folder (e.g. BEINGS-Scans\QB1TTH), oldest first. */
export function listBatches(electionDir) {
  if (!existsSync(electionDir)) return [];
  return readdirSync(electionDir)
    .filter((n) => BATCH_ID_RE.test(n) && statSync(join(electionDir, n)).isDirectory())
    .sort()
    .map((n) => loadBatch(join(electionDir, n)));
}

function log(dir, line) {
  appendFileSync(join(dir, "batch.log"), `${nowIso()} ${line}\n`);
}

/**
 * Seal a batch: every INCIDENT-001 check, then one DONE line. On any failure, QUARANTINED.txt explains why and no DONE is written.
 * opts.decode: optional async (batch) -> [{ page, ballotCode|null }] plus opts.ballotCodes, to require readable, distinct, listed codes.
 * opts.otherCodes: [{ batchId, codes:Set }] from other live batches' readings.
 */
export async function sealBatch(dir, { electionDir, decode, ballotCodes, otherCodes = [], now = nowIso } = {}) {
  const b = loadBatch(dir);
  if (b.status.state === "SEALED") return { sealed: true, already: true, problems: [], warnings: [], batch: b };
  if (b.status.state === "SUPERSEDED") return { sealed: false, problems: ["this batch is SUPERSEDED and can't be sealed"], warnings: [], batch: b };
  const { problems, warnings } = b.manifest ? checkBatch(b.manifest, b.files) : { problems: b.status.reasons, warnings: [] };
  if (!problems.length && electionDir) {
    const siblings = listBatches(electionDir).filter((o) => o.batchId !== b.batchId);
    const all = [...siblings, b].map((o) => ({ batchId: o.batchId, state: o === b ? "CAPTURED" : o.status.state, pages: o.manifest?.pages ?? [] }));
    for (const d of crossBatchDuplicateImages(all)) if (d.places.some((p) => p.batchId === b.batchId)) problems.push(`page ${d.places.find((p) => p.batchId === b.batchId).index}: the same image bytes are already in ${d.places.filter((p) => p.batchId !== b.batchId).map((p) => p.batchId).join(", ")}`);
    if (b.manifest?.electionCode && siblings.some((s) => s.manifest && s.manifest.electionCode !== b.manifest.electionCode)) warnings.push("this election folder holds batches for another election code");
  }
  let decoded = "no";
  if (!problems.length && decode) {
    const reads = await decode(b);
    problems.push(...codeChecks(reads, ballotCodes ?? [], otherCodes));
    decoded = "yes";
  }
  if (problems.length) {
    writeFileSync(join(dir, "QUARANTINED.txt"), `QUARANTINED at=${now()} batch=${b.batchId}\n${problems.map((p) => `- ${p}`).join("\n")}\nDo not record this batch. Fix the cause, or supersede it and scan the full stack again into a new batch.\n`);
    log(dir, `QUARANTINED ${problems.length} problem(s)`);
    return { sealed: false, problems, warnings, batch: b };
  }
  const line = formatDoneLine({ electionCode: b.manifest.electionCode, batchId: b.batchId, pages: b.manifest.pages.length, manifestSha256: b.manifestSha256, sealedAt: now(), decoded });
  const q = join(dir, "QUARANTINED.txt");
  if (existsSync(q)) renameSync(q, join(dir, `QUARANTINED-resolved-${now().replace(/[:.]/g, "")}.txt`)); // keep the earlier finding for audit
  writeFileSync(join(dir, "DONE.txt"), line + "\n");
  log(dir, line);
  return { sealed: true, problems: [], warnings, line, batch: loadBatch(dir) };
}

/** Mark a batch SUPERSEDED. A reason is required. Sealed batches need force, because recording from them may already have started. */
export function supersedeBatch(dir, { reason, replacedBy, force = false, now = nowIso }) {
  const b = loadBatch(dir);
  if (b.status.state === "SUPERSEDED") return { ok: true, already: true };
  if (b.status.state === "SEALED" && !force) throw new Error("This batch is SEALED. Superseding it does not undo anything already recorded from it. Re-run with --force if you are sure nothing from it was recorded.");
  const line = formatSupersededLine({ batchId: b.batchId, reason, replacedBy, at: now() });
  writeFileSync(join(dir, "SUPERSEDED.txt"), line + "\n");
  log(dir, line);
  return { ok: true, line };
}
