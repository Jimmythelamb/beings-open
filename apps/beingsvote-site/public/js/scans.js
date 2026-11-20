// All ballot scans: join ledger entries with the image store, hash pictures in the browser,
// and pack a zip + manifest. No AI. Never includes a ballot code (the pictures themselves
// may show a printed code, which is why this view is not public).
import { normHash, compareImageSets, classifyImage, summarizeImageChecks, buildZip, verifierApiMessage } from "./logic.js";
import { splitLedgerResults, parseResult, choiceLabel, shortHash } from "./format.js";

export const SCAN_STATUSES = ["pending", "match", "mismatch", "missing", "expired", "not-on-ledger", "failed"];

const STATUS_BADGE = {
  pending: { tone: "neutral", label: "Not checked yet" },
  match: { tone: "ok", label: "Match" },
  mismatch: { tone: "bad", label: "Mismatch" },
  missing: { tone: "warn", label: "Image missing" },
  expired: { tone: "info", label: "Image expired" },
  "not-on-ledger": { tone: "warn", label: "Not on the ledger" },
  failed: { tone: "warn", label: "Could not load" },
};

export function scanBadge(status) {
  return STATUS_BADGE[status] ?? { tone: "neutral", label: String(status || "Unknown") };
}

/** Staff-facing one-line reading. Never uses "you". Questions are optional. */
export function scanReadingLabel(results, questions) {
  return splitLedgerResults(results).map((seg, i) => {
    const q = questions?.[i];
    const name = `Q${i + 1}`;
    const p = parseResult(seg);
    if (!p) return `${name}: unreadable`;
    if (p.kind === "V") return `${name}: ${p.choices.map((id) => choiceLabel(q, id)).join(" + ")}`;
    if (p.kind === "B") return `${name}: blank`;
    if (p.kind === "O") return `${name}: overvote`;
    if (p.kind === "U") return `${name}: unclear`;
    return `${name}: ${seg}`;
  }).join(" · ");
}

export function extensionFor(contentType) {
  if (/png/i.test(contentType || "")) return "png";
  if (/pdf/i.test(contentType || "")) return "pdf";
  if (/jpe?g/i.test(contentType || "")) return "jpg";
  return "bin";
}

/** Neutral label A1, A2, … — not a scan, print, or ledger sequence number. */
export function scanRowLabel(index) {
  return `A${index + 1}`;
}

export function scanDisplayName(item) {
  return item?.label || (item?.onLedger ? "Ballot" : "Extra picture");
}

/** Sort by hashed ballot key, then by recorded/store fingerprint. Never by recording or print order. */
export function scanSortKey(entry) {
  const key = String(entry.ballotKey || "").toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{64}$/.test(key)) return `k:${key}`;
  const hash = normHash(entry.imageSha256 || entry.recordedHash || entry.storeHash || "");
  return hash ? `h:${hash}` : "z:";
}

export function scanImageFileName(item) {
  const ext = extensionFor(item.contentType);
  const hash = normHash(item.recordedHash || item.computedHash || item.storeHash || "");
  const short = hash ? hash.slice(0, 12) : "unknown";
  const row = (item.label || "").replace(/^Ballot\s+/i, "").replace(/^Extra\s+/i, "") || "A1";
  if (item.onLedger) return `ballot-${row}-${short}.${ext}`;
  return `extra-${row}-${short}.${ext}`;
}

/**
 * Join ledger records with the verifier store manifest, then sort by hashed ballot key
 * (a value list, not recording or print order). Labels are Ballot A1, A2, … .
 * ledgerEntries: [{ ballotKey, results, imageSha256, reviewed? }]
 * storeImages: [{ imageHash, contentType, size?, uploadedAt? }]
 * Does not fetch or hash anything.
 */
export function buildScanList({ ledgerEntries = [], storeImages = [], questions = [], expiredOmitted = 0 } = {}) {
  const storeByHash = new Map();
  for (const img of storeImages) {
    const hash = normHash(img.imageHash);
    if (hash) storeByHash.set(hash, img);
  }
  const used = new Set();
  const recorded = ledgerEntries.map((entry) => {
    const recordedHash = normHash(entry.imageSha256);
    const stored = recordedHash ? storeByHash.get(recordedHash) : null;
    if (stored) used.add(recordedHash);
    const ballotKey = entry.ballotKey ? String(entry.ballotKey).toLowerCase() : "";
    const readingRaw = String(entry.results ?? "");
    return {
      ballotKey,
      readingRaw,
      readingLabel: scanReadingLabel(readingRaw, questions),
      recordedHash,
      storeHash: stored ? recordedHash : "",
      computedHash: "",
      contentType: stored?.contentType || "",
      size: typeof stored?.size === "number" ? stored.size : null,
      status: stored ? "pending" : "missing",
      reviewed: !!entry.reviewed,
      onLedger: true,
      reason: stored ? "" : "No picture is in the store for this ledger fingerprint. It may have expired, or it was never uploaded.",
    };
  });
  recorded.sort((a, b) => (scanSortKey(a) < scanSortKey(b) ? -1 : scanSortKey(a) > scanSortKey(b) ? 1 : 0));
  const items = recorded.map((item, i) => {
    const label = `Ballot ${scanRowLabel(i)}`;
    return { ...item, label, id: `ballot-${scanRowLabel(i)}` };
  });
  const extras = [...storeByHash.keys()].filter((h) => !used.has(h)).sort();
  extras.forEach((hash, i) => {
    const stored = storeByHash.get(hash);
    const label = `Extra ${scanRowLabel(i)}`;
    items.push({
      id: `extra-${scanRowLabel(i)}`,
      label,
      onLedger: false,
      ballotKey: "",
      readingRaw: "",
      readingLabel: "Not recorded on the ledger",
      recordedHash: "",
      storeHash: hash,
      computedHash: "",
      contentType: stored?.contentType || "",
      size: typeof stored?.size === "number" ? stored.size : null,
      status: "not-on-ledger",
      reviewed: false,
      reason: "This picture is in the store but no ledger entry has this fingerprint.",
    });
  });
  return { items, expiredOmitted: Number(expiredOmitted) || 0, setCompare: compareImageSets(ledgerEntries.map((e) => e.imageSha256), storeImages.map((s) => s.imageHash)) };
}

/** Set the computed SHA-256 of downloaded bytes and the resulting badge. */
export function applyComputedHash(item, computedHex, { httpStatus } = {}) {
  const next = { ...item };
  if (httpStatus === 410) {
    next.status = "expired";
    next.reason = "The picture has passed its keep-for period and is no longer available. The fingerprint stays on the ledger.";
    next.computedHash = "";
    return next;
  }
  if (httpStatus === 404) {
    next.status = "missing";
    next.reason = "No picture is stored for this ballot (yet).";
    next.computedHash = "";
    return next;
  }
  if (httpStatus && httpStatus !== 200) {
    next.status = "failed";
    next.reason = verifierApiMessage(httpStatus);
    next.computedHash = "";
    return next;
  }
  const computed = normHash(computedHex);
  next.computedHash = computed;
  const expected = next.recordedHash || next.storeHash;
  const ledgerSet = new Set([next.recordedHash].filter(Boolean));
  if (!expected || !computed) {
    next.status = "failed";
    next.reason = next.reason || "The picture could not be fingerprinted.";
    return next;
  }
  const classified = classifyImage(expected, computed, ledgerSet);
  if (classified === "tampered") {
    next.status = "mismatch";
    next.reason = "The picture's fingerprint is different from the one recorded on the ledger, so it should not be trusted.";
  } else if (classified === "not-on-ledger") {
    next.status = "not-on-ledger";
    next.reason = "This picture is in the store but no ledger entry has this fingerprint.";
  } else if (classified === "verified") {
    next.status = "match";
    next.reason = "";
  } else {
    next.status = "failed";
    next.reason = next.reason || "The picture could not be fingerprinted.";
  }
  return next;
}

export function summarizeScans(items, { expiredOmitted = 0, setCompare } = {}) {
  const list = items ?? [];
  const of = (s) => list.filter((i) => i.status === s);
  const ledger = list.filter((i) => i.onLedger);
  const matched = of("match");
  const checkable = ledger.filter((i) => i.status === "match" || i.status === "mismatch" || i.status === "pending" || i.status === "failed");
  const checked = ledger.filter((i) => i.status === "match" || i.status === "mismatch");
  const headline = checked.length
    ? `${matched.length} of ${checked.length} match`
    : ledger.length
      ? `${of("missing").length + of("expired").length} of ${ledger.length} missing or expired`
      : "No ballots are recorded yet";
  return {
    headline,
    ledger: ledger.length,
    inStore: list.filter((i) => i.status !== "missing" && i.status !== "expired").length,
    checked: checked.length,
    match: matched.length,
    mismatch: of("mismatch").map((i) => ({ label: i.label, ballotKey: i.ballotKey || null, recordedHash: i.recordedHash, computedHash: i.computedHash })),
    missing: of("missing").map((i) => ({ label: i.label, ballotKey: i.ballotKey || null, recordedHash: i.recordedHash })),
    expired: of("expired").map((i) => ({ label: i.label, ballotKey: i.ballotKey || null, recordedHash: i.recordedHash })),
    notOnLedger: of("not-on-ledger").map((i) => ({ label: i.label, storeHash: i.storeHash || i.computedHash })),
    failed: of("failed").map((i) => ({ label: i.label, recordedHash: i.recordedHash || i.storeHash, reason: i.reason })),
    pending: of("pending").length,
    expiredOmitted: Number(expiredOmitted) || 0,
    allMatch: checked.length > 0 && matched.length === checked.length && of("missing").length === 0 && of("expired").length === 0 && of("failed").length === 0 && of("not-on-ledger").length === 0,
    setCompare: setCompare ?? null,
    checkable: checkable.length,
  };
}

const MANIFEST_NOTE = "This archive does not include ballot codes, and it is not in print or scan order. Pictures are listed by hashed ballot key (Ballot A1, A2, …). Pictures may show a printed code; keep the zip private. Fingerprints were computed in the browser; no AI was used.";

export function buildScanManifest({ electionCode, generatedAt, items, summary }) {
  return {
    election: electionCode,
    generatedAt,
    note: MANIFEST_NOTE,
    summary: {
      headline: summary.headline,
      ledger: summary.ledger,
      match: summary.match,
      mismatch: summary.mismatch.length,
      missing: summary.missing.length,
      expired: summary.expired.length,
      notOnLedger: summary.notOnLedger.length,
      failed: summary.failed.length,
      expiredOmitted: summary.expiredOmitted,
    },
    ballots: items.map((item) => ({
      label: item.label || scanDisplayName(item),
      ballotKey: item.ballotKey || null,
      reading: item.readingRaw || null,
      readingLabel: item.readingLabel || null,
      recordedHash: item.recordedHash || null,
      computedHash: item.computedHash || null,
      status: item.status,
      filename: item.status === "missing" || item.status === "expired" || item.status === "failed" ? null : scanImageFileName(item),
      contentType: item.contentType || null,
    })),
  };
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildScanManifestCsv(items) {
  const header = ["label", "ballotKey", "reading", "readingLabel", "recordedHash", "computedHash", "status", "filename"];
  const lines = [header.join(",")];
  for (const item of items) {
    const filename = item.status === "missing" || item.status === "expired" || item.status === "failed" ? "" : scanImageFileName(item);
    lines.push([
      item.label || scanDisplayName(item),
      item.ballotKey || "",
      item.readingRaw || "",
      item.readingLabel || "",
      item.recordedHash || "",
      item.computedHash || "",
      item.status,
      filename,
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Files for buildZip: images (when bytes are present) plus manifest.json and manifest.csv. */
export function scanArchiveFiles({ electionCode, items, blobs, summary, generatedAt }) {
  const files = [];
  for (const item of items) {
    const key = item.recordedHash || item.storeHash;
    const blob = key ? blobs?.get(key) : null;
    if (!blob?.bytes) continue;
    files.push({ name: scanImageFileName({ ...item, contentType: blob.contentType || item.contentType }), bytes: blob.bytes });
  }
  const manifest = buildScanManifest({ electionCode, generatedAt, items, summary });
  const json = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const csv = new TextEncoder().encode(buildScanManifestCsv(items));
  files.push({ name: "manifest.json", bytes: json });
  files.push({ name: "manifest.csv", bytes: csv });
  return files;
}

export function scanZipName(electionCode) {
  return `${electionCode}-ballot-scans.zip`;
}

export function packScanArchive(opts) {
  return buildZip(scanArchiveFiles(opts), opts.date ?? new Date(opts.generatedAt ?? 0));
}

/** Recursively look for a ballot-code field or a 12-character code key. Used by tests. */
export function manifestContainsBallotCodeKey(value) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^ballotCodes?$/i.test(k) || k === "code" && /ballot/i.test(String(v))) return true;
      if (manifestContainsBallotCodeKey(v)) return true;
    }
  }
  return false;
}

/**
 * Download and hash every picture that can be fetched. Pure besides the injected fetch/hash.
 * fetchImage(hash) -> { ok, status, bytes?: Uint8Array, contentType?: string }
 * hashBytes(Uint8Array) -> hex
 */
export async function verifyAllScans({ items, fetchImage, hashBytes, onProgress, concurrency = 4 }) {
  const next = items.map((i) => ({ ...i }));
  const blobs = new Map();
  const targets = next
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== "missing" && item.status !== "expired" && (item.recordedHash || item.storeHash));
  let done = 0;
  const total = targets.length;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const { item, index } = targets[cursor++];
      const hash = item.recordedHash || item.storeHash;
      try {
        const res = await fetchImage(hash);
        if (!res?.ok) {
          next[index] = applyComputedHash(item, "", { httpStatus: res?.status ?? 0 });
        } else {
          const bytes = res.bytes;
          const computed = await hashBytes(bytes);
          const updated = applyComputedHash({ ...item, contentType: res.contentType || item.contentType }, computed);
          next[index] = updated;
          if (updated.status === "match" || updated.status === "mismatch" || updated.status === "not-on-ledger") {
            blobs.set(hash, { bytes, contentType: res.contentType || item.contentType, ext: extensionFor(res.contentType || item.contentType) });
          }
        }
      } catch (e) {
        next[index] = { ...item, status: "failed", reason: String(e?.message ?? e), computedHash: "" };
      }
      done++;
      onProgress?.({ done, total, items: next });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, worker));
  return { items: next, blobs };
}

export function hashPreview(hex, front = 10, back = 8) {
  return shortHash(hex, front, back);
}

const LEGACY_STATUS = { match: "verified", mismatch: "tampered", failed: "failed", pending: "pending", "not-on-ledger": "not-on-ledger" };

/** Shape the existing verifier flags / report still expect. */
export function toLegacyImageState(items, setCompare, blobs, expiredOmitted = 0) {
  const legacyItems = items
    .filter((i) => Object.prototype.hasOwnProperty.call(LEGACY_STATUS, i.status) || i.status === "pending")
    .map((i) => ({
      sha256: i.storeHash || i.recordedHash,
      contentType: i.contentType,
      status: LEGACY_STATUS[i.status] ?? i.status,
      reason: i.reason,
    }))
    .filter((i) => i.sha256);
  const legacyBlobs = new Map();
  if (blobs) {
    for (const [hash, b] of blobs) legacyBlobs.set(hash, { bytes: b.bytes, ext: b.ext || "bin" });
  }
  return {
    items: legacyItems,
    setCompare,
    blobs: legacyBlobs,
    expiredOmitted,
    summary: summarizeImageChecks(legacyItems, setCompare),
  };
}
