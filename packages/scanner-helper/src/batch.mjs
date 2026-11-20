// Pure rules for a scan batch under the INCIDENT-001 protocol. No file system, no network: callers pass in what was read.
//
// A batch folder (made by windows/Scan-BeingsBatch.ps1) holds:
//   page-01.png ...         the lossless page images
//   manifest.json           written live while scanning; state CAPTURING -> CAPTURED | INCOMPLETE | INTERRUPTED
//   batch.log               append-only event log
//   DONE.txt                the seal: one DONE line, written only by `beings-batch seal` after every check passed
//   SUPERSEDED.txt          one SUPERSEDED line; the batch is kept for audit and is never recorded
//   QUARANTINED.txt         written by `seal` when a check failed; explains why
// A batch is recordable only when it has a valid DONE line whose manifest fingerprint matches, and no SUPERSEDED line.

export const MANIFEST_SCHEMA = "beings-scan-batch/1";
export const STATES = Object.freeze(["CAPTURING", "CAPTURED", "INCOMPLETE", "INTERRUPTED", "SEALED", "SUPERSEDED", "QUARANTINED"]);
export const ELECTION_CODE_RE = /^BEINGS-\d{4}-[A-Z0-9]{6}$/;
export const BATCH_ID_RE = /^batch-\d{8}-\d{6}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** batch-YYYYMMDD-HHMMSS from a local Date. */
export function batchIdFor(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `batch-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** "page-07.png" for index 7 (2 digits up to 99, then 3). */
export const pageFileName = (index, width = 2) => `page-${String(index).padStart(width, "0")}.png`;

// ------------------------------------------------------------------ seal and supersede lines
/** DONE line. Every value is a token without spaces so the line can be parsed back exactly. */
export function formatDoneLine({ electionCode, batchId, pages, manifestSha256, sealedAt, decoded = "no" }) {
  return `DONE ${MANIFEST_SCHEMA} election=${electionCode} batch=${batchId} pages=${pages} manifestSha256=${manifestSha256} decoded=${decoded} sealedAt=${sealedAt}`;
}

export function parseDoneLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const done = lines.filter((l) => l.startsWith("DONE "));
  if (done.length !== 1) return { error: done.length ? "more than one DONE line" : "no DONE line" };
  const [, schema, ...rest] = done[0].split(/\s+/);
  if (schema !== MANIFEST_SCHEMA) return { error: `unknown seal format ${schema}` };
  const kv = Object.fromEntries(rest.map((t) => t.split("=")).filter((a) => a.length === 2));
  const pages = Number(kv.pages);
  if (!ELECTION_CODE_RE.test(kv.election ?? "")) return { error: "DONE line has no valid election code" };
  if (!BATCH_ID_RE.test(kv.batch ?? "")) return { error: "DONE line has no valid batch id" };
  if (!Number.isSafeInteger(pages) || pages < 1) return { error: "DONE line has no page count" };
  if (!HEX64.test(kv.manifestSha256 ?? "")) return { error: "DONE line has no manifest fingerprint" };
  return { electionCode: kv.election, batchId: kv.batch, pages, manifestSha256: kv.manifestSha256, decoded: kv.decoded ?? "no", sealedAt: kv.sealedAt ?? null };
}

export function formatSupersededLine({ batchId, reason, replacedBy, at }) {
  const clean = String(reason ?? "").replace(/[\r\n"]+/g, " ").trim();
  if (!clean) throw new Error("A reason is required to supersede a batch.");
  return `SUPERSEDED batch=${batchId} replacedBy=${replacedBy || "none"} at=${at} reason="${clean}"`;
}

export function parseSupersededLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("SUPERSEDED "));
  if (!line) return null;
  const m = /^SUPERSEDED batch=(\S+) replacedBy=(\S+) at=(\S+) reason="(.*)"$/.exec(line);
  return m ? { batchId: m[1], replacedBy: m[2] === "none" ? null : m[2], at: m[3], reason: m[4] } : { batchId: null, replacedBy: null, at: null, reason: "unparsed" };
}

// ------------------------------------------------------------------ manifest checks
/** Shape of manifest.json. Returns a list of problems (empty when fine). */
export function manifestShapeProblems(m) {
  const p = [];
  if (!m || typeof m !== "object") return ["manifest.json is not an object"];
  if (m.schema !== MANIFEST_SCHEMA) p.push(`manifest schema is ${m.schema ?? "missing"}, expected ${MANIFEST_SCHEMA}`);
  if (!ELECTION_CODE_RE.test(m.electionCode ?? "")) p.push("manifest has no valid election code");
  if (!BATCH_ID_RE.test(m.batchId ?? "")) p.push("manifest has no valid batch id");
  if (!Number.isSafeInteger(m.expectedPages) || m.expectedPages < 1) p.push("manifest has no expected page count (it must be set before the feeder starts)");
  if (!STATES.includes(m.state)) p.push(`manifest state ${m.state ?? "missing"} is not a known state`);
  if (!Array.isArray(m.pages)) p.push("manifest has no page list");
  return p;
}

/** Saved vs expected page count. */
export function pageCountCheck(m) {
  const saved = Array.isArray(m?.pages) ? m.pages.length : 0;
  const expected = m?.expectedPages ?? null;
  return { saved, expected, ok: Number.isSafeInteger(expected) && saved === expected, message: saved === expected ? `${saved} of ${expected} pages` : `${saved} of ${expected} pages saved: INCOMPLETE, do not record this batch` };
}

/**
 * Full check of one batch against the files on disk.
 * `files` maps a page file name to { bytes, sha256, width, height } as measured now, or is missing the name when the file is absent.
 * Returns { problems, warnings }. Problems block sealing.
 */
export function checkBatch(m, files) {
  const problems = manifestShapeProblems(m);
  const warnings = [];
  if (problems.length) return { problems, warnings };
  if (m.state === "INTERRUPTED" || m.state === "INCOMPLETE") problems.push(`the scan ended ${m.state}${m.stateReason ? ` (${m.stateReason})` : ""}`);
  if (m.state === "CAPTURING") problems.push("the scan never finished (state CAPTURING): it was killed or is still running");
  const count = pageCountCheck(m);
  if (!count.ok) problems.push(count.message);
  const seenIdx = new Set();
  const seenHash = new Map();
  const dims = new Map();
  m.pages.forEach((pg, i) => {
    const where = `page ${pg?.index ?? i + 1}`;
    if (!pg || typeof pg !== "object") return problems.push(`${where}: not an entry`);
    if (pg.index !== i + 1) problems.push(`${where}: pages are not numbered 1..n in order`);
    if (seenIdx.has(pg.index)) problems.push(`${where}: listed twice`);
    seenIdx.add(pg.index);
    const sha = String(pg.sha256 ?? "").toLowerCase();
    if (!HEX64.test(sha)) problems.push(`${where}: no SHA-256 in the manifest`);
    if (seenHash.has(sha)) problems.push(`${where}: same image bytes as page ${seenHash.get(sha)} (duplicate image)`);
    else seenHash.set(sha, pg.index);
    const f = files?.[pg.file];
    if (!f) return problems.push(`${where}: file ${pg.file} is missing`);
    if (!f.bytes) problems.push(`${where}: file is empty`);
    if (pg.bytes != null && pg.bytes !== f.bytes) problems.push(`${where}: size changed since scanning (${pg.bytes} -> ${f.bytes} bytes)`);
    if (f.sha256 !== sha) problems.push(`${where}: the bytes on disk no longer match the manifest fingerprint`);
    if (f.width && f.height) {
      const k = `${f.width}x${f.height}`;
      dims.set(k, [...(dims.get(k) ?? []), pg.index]);
      if (pg.width && (pg.width !== f.width || pg.height !== f.height)) problems.push(`${where}: image size differs from the manifest`);
    } else problems.push(`${where}: not a readable PNG`);
  });
  if (dims.size > 1) problems.push(`pages have different sizes: ${[...dims].map(([k, v]) => `${k} (pages ${v.join(", ")})`).join("; ")}`);
  const only = dims.size === 1 ? [...dims.keys()][0] : null;
  if (only && m.dpi && m.pageSize) {
    const [w, h] = only.split("x").map(Number);
    const exp = PAGE_SIZES_IN[m.pageSize];
    if (exp && (Math.abs(w / m.dpi - exp[0]) > 0.15 || Math.abs(h / m.dpi - exp[1]) > 0.15)) warnings.push(`pages are ${(w / m.dpi).toFixed(2)}x${(h / m.dpi).toFixed(2)} in at ${m.dpi} dpi, but ${m.pageSize} (${exp[0]}x${exp[1]} in) was declared. The reader may still find the marks; check it.`);
  }
  for (const f of Object.keys(files ?? {})) if (/^page-\d+\.png$/i.test(f) && !m.pages.some((p) => p.file === f)) problems.push(`${f} is in the folder but not in the manifest`);
  return { problems, warnings };
}

export const PAGE_SIZES_IN = Object.freeze({ Letter: [8.5, 11], Legal: [8.5, 14], A4: [8.27, 11.69] });

/**
 * State of a batch as the recording gate sees it.
 * { manifest, manifestSha256, doneText, supersededText, quarantinedText } -> { state, recordable, reasons }
 */
export function batchStatus({ manifest, manifestSha256, doneText, supersededText, quarantinedText }) {
  const reasons = [];
  if (supersededText) {
    const s = parseSupersededLine(supersededText);
    return { state: "SUPERSEDED", recordable: false, reasons: [`superseded${s?.replacedBy ? ` by ${s.replacedBy}` : ""}: ${s?.reason ?? ""}`] };
  }
  if (!manifest) return { state: "INCOMPLETE", recordable: false, reasons: ["no manifest.json"] };
  if (doneText) {
    const d = parseDoneLine(doneText);
    if (d.error) reasons.push(`seal is not valid: ${d.error}`);
    else {
      if (d.manifestSha256 !== manifestSha256) reasons.push("manifest.json changed after it was sealed");
      if (d.batchId !== manifest.batchId || d.electionCode !== manifest.electionCode) reasons.push("seal names a different batch or election");
      if (d.pages !== manifest.pages?.length || d.pages !== manifest.expectedPages) reasons.push("seal page count does not match the manifest");
    }
    if (!reasons.length) return { state: "SEALED", recordable: true, reasons: [], seal: d };
    return { state: "QUARANTINED", recordable: false, reasons };
  }
  if (quarantinedText) return { state: "QUARANTINED", recordable: false, reasons: [String(quarantinedText).trim().split(/\r?\n/)[0]] };
  const st = manifest.state;
  reasons.push(st === "CAPTURED" ? "captured but not sealed yet: run `beings-batch seal`" : `scan state ${st}: do not record this batch`);
  return { state: st === "CAPTURED" ? "CAPTURED" : st, recordable: false, reasons };
}

/** Refuse anything that is not SEALED. Throws with a plain message. */
export function assertRecordable(status, batchId = "this batch") {
  if (!status.recordable) throw new Error(`${batchId} is ${status.state} and must not be read for recording: ${status.reasons.join("; ")}`);
}

// ------------------------------------------------------------------ cross-batch rules
/**
 * Same image bytes in more than one live (not superseded) batch of an election.
 * batches: [{ batchId, state, pages: [{ index, sha256 }] }]. Returns [{ sha256, places: [{ batchId, index }] }].
 * A superseded batch may share images with its replacement only if the superseded batch was never recorded,
 * so superseded batches are ignored here; recording from them is refused by batchStatus instead.
 */
export function crossBatchDuplicateImages(batches) {
  const seen = new Map();
  for (const b of batches) {
    if (b.state === "SUPERSEDED") continue;
    for (const p of b.pages ?? []) {
      const k = String(p.sha256 ?? "").toLowerCase();
      if (!k) continue;
      seen.set(k, [...(seen.get(k) ?? []), { batchId: b.batchId, index: p.index }]);
    }
  }
  return [...seen].filter(([, v]) => new Set(v.map((x) => x.batchId)).size > 1).map(([sha256, places]) => ({ sha256, places }));
}

/**
 * Batches that block a new scan for the same election: anything not SEALED and not SUPERSEDED.
 * (A finished, sealed batch does not block. An interrupted one must be superseded or resolved first.)
 */
export function unresolvedBatches(batches) {
  return batches.filter((b) => b.state !== "SEALED" && b.state !== "SUPERSEDED");
}

/**
 * Ballot-code checks on the reader's output for one batch. Codes are never echoed: problems name the page.
 * readings: [{ page, ballotCode|null }]; ballotCodes: the election's list; otherBatches: [{ batchId, codes: Set }]
 */
export function codeChecks(readings, ballotCodes, otherBatches = []) {
  const problems = [];
  const list = new Set(ballotCodes ?? []);
  const first = new Map();
  for (const r of readings) {
    if (!r.ballotCode) {
      problems.push(`page ${r.page}: the ballot code could not be read (manual review)`);
      continue;
    }
    if (!list.has(r.ballotCode)) problems.push(`page ${r.page}: the ballot code is not on this election's list`);
    if (first.has(r.ballotCode)) problems.push(`page ${r.page}: same ballot code as page ${first.get(r.ballotCode)}`);
    else first.set(r.ballotCode, r.page);
    for (const o of otherBatches) if (o.codes?.has(r.ballotCode)) problems.push(`page ${r.page}: this ballot code is also in ${o.batchId}`);
  }
  return problems;
}
