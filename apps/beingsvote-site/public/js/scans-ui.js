// All ballot scans panel: a thumbnail grid, a full-size viewer, Verify all, and Download all.
// Pictures stay off the public results page. This module only renders what the caller already loaded.
import { fill, h, icon, badge, callout, spinner } from "./ui.js";
import { headingWithHelp } from "./help.js";
import { hashPreview, scanBadge, scanDisplayName, summarizeScans, scanImageFileName } from "./scans.js";
import { shortHash } from "./format.js";

let viewer = null;

function revokeMap(urls) {
  if (!urls) return;
  for (const url of urls.values()) {
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
  }
  urls.clear();
}

/** Build (or refresh) object URLs for downloaded pictures. Returns a Map hash -> url. */
export function urlsForBlobs(blobs, previous) {
  const next = new Map();
  if (blobs) {
    for (const [hash, b] of blobs) {
      const type = b.contentType || (b.ext === "pdf" ? "application/pdf" : b.ext === "png" ? "image/png" : "image/jpeg");
      next.set(hash, URL.createObjectURL(new Blob([b.bytes], { type })));
    }
  }
  if (previous) revokeMap(previous);
  return next;
}

function statusBadge(status) {
  const info = scanBadge(status);
  return badge(info.label, info.tone, status === "match" ? "check" : status === "mismatch" ? "alert" : status === "expired" || status === "missing" ? "info" : undefined);
}

function hashLine(label, hex) {
  if (!hex) return h("p", { class: "scan-hash muted small" }, `${label}: not available`);
  return h("p", { class: "scan-hash small" }, `${label}: `, h("code", { title: hex, class: "wrap" }, hashPreview(hex)));
}

function mediaFor(item, url, { full = false } = {}) {
  const type = item.contentType || "";
  const name = scanDisplayName(item);
  const alt = item.onLedger
    ? `Scan of ${name}. Recorded reading: ${item.readingLabel || "not available"}.`
    : `A stored ballot picture that is not on the ledger (${name}).`;
  if (!url) {
    const label = item.status === "expired" ? "Image expired" : item.status === "missing" ? "Image missing" : item.status === "failed" ? "Could not load" : "No picture";
    return h("div", { class: "scan-placeholder", role: "img", "aria-label": label }, h("span", null, label));
  }
  if (/pdf/i.test(type)) {
    return full
      ? h("iframe", { src: url, title: alt, class: "scan-frame" })
      : h("div", { class: "scan-placeholder scan-pdf", role: "img", "aria-label": alt }, h("span", null, "PDF"));
  }
  return h("img", { src: url, alt, class: full ? "scan-full-img" : "scan-thumb-img" });
}

function thumbButton(item, url, onOpen) {
  const viewable = !!url;
  const btn = h(
    "button",
    {
      type: "button",
      class: `scan-thumb scan-thumb-${item.status}`,
      disabled: !viewable,
      "aria-label": `Open ${scanDisplayName(item)}, ${scanBadge(item.status).label}`,
    },
    h("div", { class: "scan-thumb-media" }, mediaFor(item, url)),
    h("div", { class: "scan-thumb-meta" },
      h("div", { class: "scan-thumb-top" },
        h("strong", null, scanDisplayName(item)),
        statusBadge(item.status),
      ),
      h("p", { class: "scan-reading small" }, item.readingLabel || "No recorded reading"),
      hashLine("Recorded", item.recordedHash),
      hashLine("Computed", item.computedHash),
    ),
  );
  if (viewable) btn.addEventListener("click", () => onOpen(item));
  return btn;
}

function closeViewer() {
  if (!viewer) return;
  const { dialog, onClose } = viewer;
  viewer = null;
  dialog.close();
  dialog.remove();
  onClose?.();
}

function paintViewer(index) {
  if (!viewer) return;
  const { items, urls, body, dialog, live } = viewer;
  const viewable = items.filter((i) => urls.get(i.recordedHash || i.storeHash));
  if (!viewable.length) return closeViewer();
  const i = ((index % viewable.length) + viewable.length) % viewable.length;
  viewer.index = i;
  const item = viewable[i];
  const url = urls.get(item.recordedHash || item.storeHash);
  const title = scanDisplayName(item);
  fill(
    body,
    h("div", { class: "scan-viewer-stage" }, mediaFor(item, url, { full: true })),
    h("div", { class: "scan-viewer-meta" },
      h("div", { class: "scan-thumb-top" }, h("h3", { id: "scan-viewer-title" }, title), statusBadge(item.status)),
      h("p", { class: "scan-reading" }, item.readingLabel || "No recorded reading"),
      hashLine("Recorded hash", item.recordedHash),
      hashLine("Computed hash", item.computedHash),
      item.reason ? h("p", { class: "muted small" }, item.reason) : null,
      h("p", { class: "muted small" }, `${i + 1} of ${viewable.length}`),
    ),
  );
  live.textContent = `${title}, ${scanBadge(item.status).label}. ${item.readingLabel || ""}`;
  dialog.querySelector(".scan-prev").disabled = viewable.length < 2;
  dialog.querySelector(".scan-next").disabled = viewable.length < 2;
}

export function openScanViewer({ items, urls, start, returnFocus }) {
  closeViewer();
  const viewable = items.filter((i) => urls.get(i.recordedHash || i.storeHash));
  if (!viewable.length) return;
  const startIndex = Math.max(0, viewable.findIndex((i) => i === start || i.id === start?.id));
  const body = h("div", { class: "scan-viewer-body" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const prev = h("button", { type: "button", class: "btn scan-prev", "aria-label": "Previous ballot" }, icon("arrow", { size: 18 }), " Previous");
  const next = h("button", { type: "button", class: "btn scan-next", "aria-label": "Next ballot" }, "Next ", icon("arrow", { size: 18 }));
  const closeBtn = h("button", { type: "button", class: "icon-btn lg scan-viewer-close", "aria-label": "Close picture" }, icon("x", { size: 20 }));
  // Flip the previous arrow visually via CSS; the icon itself points right.
  const dialog = h(
    "dialog",
    { class: "scan-viewer", "aria-labelledby": "scan-viewer-title" },
    h("div", { class: "dialog-card scan-viewer-card" },
      h("div", { class: "dialog-head" }, h("h2", { id: "scan-viewer-title" }, "Ballot picture"), closeBtn),
      body,
      h("div", { class: "scan-viewer-actions actions" }, prev, next),
      live,
    ),
  );
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeViewer(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); paintViewer(viewer.index - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); paintViewer(viewer.index + 1); }
  };
  prev.addEventListener("click", () => paintViewer(viewer.index - 1));
  next.addEventListener("click", () => paintViewer(viewer.index + 1));
  closeBtn.addEventListener("click", () => closeViewer());
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeViewer(); });
  dialog.addEventListener("keydown", onKey);
  document.body.append(dialog);
  viewer = { dialog, body, live, items, urls, index: startIndex, onClose: () => { dialog.removeEventListener("keydown", onKey); returnFocus?.focus?.(); } };
  dialog.showModal();
  paintViewer(startIndex);
  closeBtn.focus();
}

export function closeScanViewer() {
  closeViewer();
}

function summaryBox(summary) {
  if (!summary) return null;
  const tone = summary.allMatch ? "ok" : summary.mismatch.length || summary.failed.length ? "bad" : summary.missing.length || summary.expired.length || summary.notOnLedger.length ? "warn" : "info";
  const lists = [];
  const add = (title, rows, fmt) => {
    if (!rows.length) return;
    lists.push(h("div", { class: "scan-flag-list" }, h("h3", null, title), h("ul", { class: "plain-list" }, rows.map((r) => h("li", null, fmt(r))))));
  };
  add("Mismatches", summary.mismatch, (r) => `${r.label || "A ballot"}: recorded ${r.recordedHash ? shortHash(r.recordedHash, 8, 6) : "—"}, computed ${r.computedHash ? shortHash(r.computedHash, 8, 6) : "—"}`);
  add("Missing pictures", summary.missing, (r) => `${r.label || "A ballot"} (${r.recordedHash ? shortHash(r.recordedHash, 8, 6) : "no hash"})`);
  add("Expired pictures", summary.expired, (r) => `${r.label || "A ballot"} (${r.recordedHash ? shortHash(r.recordedHash, 8, 6) : "no hash"})`);
  add("Pictures not on the ledger", summary.notOnLedger, (r) => `${r.label ? `${r.label}: ` : ""}${r.storeHash ? shortHash(r.storeHash, 8, 6) : "unknown"}`);
  add("Could not load", summary.failed, (r) => `${r.label || "A picture"}: ${r.reason || "failed"}`);
  return h(
    "div",
    { class: "scan-summary" },
    callout(tone, summary.headline, [
      `${summary.match} matched, ${summary.mismatch.length} mismatched, ${summary.missing.length} missing, ${summary.expired.length} expired.`,
      summary.expiredOmitted ? ` The store also left out ${summary.expiredOmitted} expired picture${summary.expiredOmitted === 1 ? "" : "s"}.` : "",
    ].join("")),
    lists.length ? h("div", { class: "scan-flags" }, ...lists) : null,
  );
}

/**
 * The All ballot scans card. `urls` is a Map of image hash -> object URL for pictures already loaded.
 */
export function scanPanel({
  items = [],
  urls = new Map(),
  summary = null,
  statusText = "",
  error = "",
  loading = false,
  progress = null,
  canAct = true,
  hint = null,
  onLoad,
  onVerify,
  onDownload,
  loadLabel = "Load pictures",
  verifyLabel = "Verify all",
  downloadLabel = "Download all",
  headingId = "scans-h",
  title = "All ballot scans",
  lead = "Look at every stored ballot picture, check each fingerprint in your browser, and save a zip with a manifest. This view is not public, because a scan can show the printed ballot code. No AI is used.",
} = {}) {
  const stats = summary || (items.length ? summarizeScans(items) : null);
  const loadedCount = items.filter((i) => urls.get(i.recordedHash || i.storeHash)).length;
  const loadBtn = onLoad ? h("button", { class: "btn btn-primary", type: "button", disabled: !canAct || loading }, icon("image", { size: 18 }), loadLabel) : null;
  const verifyBtn = onVerify ? h("button", { class: "btn", type: "button", disabled: !canAct || loading || !items.some((i) => i.status !== "missing") }, icon("shield", { size: 16 }), verifyLabel) : null;
  const downBtn = onDownload ? h("button", { class: "btn", type: "button", disabled: !canAct || loading || loadedCount === 0 }, icon("arrow", { size: 16 }), downloadLabel) : null;
  if (loadBtn && onLoad) loadBtn.addEventListener("click", onLoad);
  if (verifyBtn && onVerify) verifyBtn.addEventListener("click", onVerify);
  if (downBtn && onDownload) downBtn.addEventListener("click", onDownload);

  const open = (item) => openScanViewer({ items, urls, start: item, returnFocus: document.activeElement });
  const grid = items.length
    ? h("div", { class: "scan-grid", role: "list" }, items.map((item) => h("div", { role: "listitem" }, thumbButton(item, urls.get(item.recordedHash || item.storeHash), open))))
    : h("p", { class: "muted" }, "No ballots have been recorded for this election yet.");

  const bar = progress && progress.total
    ? h("div", { class: "bar-track", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: `width:${Math.round((progress.done / progress.total) * 100)}%` }))
    : null;

  return h(
    "section",
    { class: "card scan-panel", "aria-labelledby": headingId },
    ...headingWithHelp("h2", { id: headingId }, [icon("image", { size: 22 }), title], "scans.panel"),
    h("p", null, lead),
    hint,
    h("div", { class: "actions" }, loadBtn, verifyBtn, downBtn),
    bar,
    statusText ? h("p", { class: "muted", role: "status" }, statusText) : null,
    loading && !items.length ? spinner("Loading ballot pictures…") : null,
    error ? callout("warn", "The pictures could not be loaded", error) : null,
    stats ? summaryBox(stats) : null,
    grid,
  );
}

export function accessHint({ address, isOrganizer, isVerifier, page }) {
  if (!address) {
    return callout("info", "Connect a wallet to load the pictures", "The image store only answers a signed request from this election's organizer or a registered verifier. Signing costs nothing and sends nothing.", "wallet");
  }
  if (isOrganizer) return callout("ok", "You are the organizer", "You can load every stored picture for this election. Keep the download private: a scan can show a printed ballot code.", "unlock");
  if (isVerifier) return callout("info", "You are a registered verifier", "You can load the pictures to check them. Keep the download private: a scan can show a printed ballot code.", "shield");
  if (page === "admin") {
    return callout("warn", "This wallet can't load the pictures yet", "Only this election's organizer, or a registered verifier, may download the scans. You can register as a verifier on the Verifier page; it is open to anyone and costs a small network fee.", "lock");
  }
  return callout("warn", "Register this wallet first", "Use “Register as a verifier” in the wallet box above. Until then the store will refuse the download. The election organizer can also load the pictures from the Admin page.", "alert");
}
