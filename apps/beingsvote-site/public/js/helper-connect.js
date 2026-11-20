// One button: Connect printer & scanner (Windows PC).
// Probes the helper on this computer, relinks a saved scanner, and offers a download
// only when the helper is not installed or an update is published.
import { h, icon, callout, fill } from "./ui.js";
import { HELPER_DOWNLOAD } from "../downloads/helper-download.js";
import { formatDownloadSize, helperLooksHandheld } from "./helper-install.js";
import {
  BRIDGE_PORT,
  classifyBridgeResponse,
  confirmationFromView,
  connectionLabel,
  describeStation,
  readScannerChoice,
  readStoredConfirmation,
  writeScannerChoice,
  writeStoredConfirmation,
} from "./scanner-station.js";

export const CONNECT_LABEL = "Connect printer & scanner (Windows PC)";
export const START_LABEL = "Start helper";
export const ALREADY_LABEL = "I already installed it";
export const HEALTH_TIMEOUT_MS = 2000;
export const STATION_TIMEOUT_MS = 10000;
export const START_WAIT_MS = 15000;
export const HELPER_SEEN_KEY = "beings.helperSeen.v1";
export const HELPER_DOWNLOADED_AT_KEY = "beings.helperDownloadedAt";
export const DOWNLOAD_REMEMBER_MS = 24 * 60 * 60 * 1000;
export const PROTOCOL_URL = "beings-helper://start";
export const CONNECT_BASES = Object.freeze([
  `http://127.0.0.1:${BRIDGE_PORT}`,
  `http://[::1]:${BRIDGE_PORT}`,
  `http://localhost:${BRIDGE_PORT}`,
]);

export const PROTOCOL_FALLBACK = "If Start helper did nothing, open the Start menu and choose Start BEINGS helper. The helper runs in the background. There is no window to keep open. It also starts when you sign in to Windows.";

const SMARTSCREEN = "If Windows SmartScreen appears, choose More info, then Run anyway. The setup file is not code-signed yet.";

export function publishedHelper() {
  const setup = HELPER_DOWNLOAD.setup || (HELPER_DOWNLOAD.fileName?.endsWith(".exe") ? HELPER_DOWNLOAD : null);
  const zip = HELPER_DOWNLOAD.zip || (HELPER_DOWNLOAD.fileName?.endsWith(".zip") ? HELPER_DOWNLOAD : null);
  return {
    version: HELPER_DOWNLOAD.version || "",
    setup: setup?.href ? setup : null,
    zip: zip?.href ? zip : null,
  };
}

/** Compare dotted versions. -1 when a is older than b. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map((n) => parseInt(n, 10));
  const pb = String(b ?? "").split(".").map((n) => parseInt(n, 10));
  const n = Math.max(pa.length, pb.length, 1);
  for (let i = 0; i < n; i++) {
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(installed, published) {
  if (!installed || !published) return false;
  return compareVersions(installed, published) < 0;
}

export function downloadIsRecent(iso, now = Date.now(), windowMs = DOWNLOAD_REMEMBER_MS) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= 0 && age < windowMs;
}

export function helperWasSeen(storage) {
  const v = storage?.getItem?.(HELPER_SEEN_KEY);
  return v != null && v !== "";
}

export function markHelperSeen(storage) {
  storage?.setItem?.(HELPER_SEEN_KEY, "1");
}

export function connectState({ probe, seen, downloadedAt, now = Date.now(), publishedVersion } = {}) {
  if (probe?.reason === "forbidden-origin") return { state: "forbidden", update: false, version: probe.health?.version || "" };
  if (probe?.ok) {
    const version = String(probe.health?.version || probe.station?.version || "");
    const update = isUpdateAvailable(version, publishedVersion);
    return { state: update ? "update-available" : "running", update, version };
  }
  if (seen) return { state: "installed-not-running", update: false, version: "" };
  return { state: "not-installed", update: false, version: "", recentDownload: downloadIsRecent(downloadedAt, now) };
}

async function getJson(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", signal: ctrl.signal, headers: { accept: "application/json" } });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "timeout" : "not-running" };
  } finally {
    clearTimeout(t);
  }
}

/** Health first (about 2s), then station (10s) on the first address that answers. */
export async function probeHelper({ fetchImpl = fetch, bases = CONNECT_BASES, healthTimeoutMs = HEALTH_TIMEOUT_MS, stationTimeoutMs = STATION_TIMEOUT_MS } = {}) {
  let last = { ok: false, reason: "not-running" };
  for (const base of bases) {
    const health = await getJson(fetchImpl, `${base}/v1/health`, healthTimeoutMs);
    const kind = classifyBridgeResponse(health);
    if (kind === "forbidden-origin") return { ok: false, reason: "forbidden-origin", base, health: health.json || null };
    if (kind === "not-running" || kind === "timeout") {
      last = { ok: false, reason: kind, base };
      continue;
    }
    if (kind !== "ok" && health.status !== 200) {
      last = { ok: false, reason: "not-running", base };
      continue;
    }
    const station = await getJson(fetchImpl, `${base}/v1/station`, stationTimeoutMs);
    const sk = classifyBridgeResponse(station);
    if (sk === "forbidden-origin") return { ok: false, reason: "forbidden-origin", base, health: health.json || null };
    if (sk === "ok" && station.json) return { ok: true, base, health: health.json || {}, station: station.json };
    if (sk === "timeout") return { ok: false, reason: "timeout", base, health: health.json || null };
    last = { ok: false, reason: "list-failed", base, health: health.json || null };
  }
  return last;
}

export async function waitForHelper({ probe, waitMs = START_WAIT_MS, intervalMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const start = now();
  let last = { ok: false, reason: "not-running" };
  for (;;) {
    last = await probe();
    if (last?.ok || last?.reason === "forbidden-origin") return last;
    if (now() - start >= waitMs) return last;
    await sleep(intervalMs);
  }
}

/** Opens beings-helper://start. Returns false when the caller says the protocol cannot be used. */
export function launchHelperProtocol(openImpl) {
  const open = openImpl || defaultProtocolOpen;
  try {
    return open(PROTOCOL_URL) !== false;
  } catch {
    return false;
  }
}

function defaultProtocolOpen(url) {
  if (typeof document === "undefined") return false;
  const a = document.createElement("a");
  a.href = url;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}

export function forbiddenOriginMessage(pageOrigin) {
  const origin = pageOrigin || "https://THIS-PAGE";
  return `The helper is running, but it is not allowing this preview page. That is expected on a preview site. On the scanner computer, open the Start menu and choose Stop BEINGS helper. Then start it again from a command window, adding this page: node src\\cli.mjs bridge --output-root "%USERPROFILE%\\Documents\\BEINGS-Scans" --allow-origin ${origin} --allow-origin https://beingsvote.live. The live site https://beingsvote.live is already allowed.`;
}

/** Prefer a saved scanner and confirmation when Windows still lists them. */
export function relinkStation(payload, { choice, confirmation } = {}) {
  const view = describeStation(payload || {});
  const scanners = view.picked?.scanners || [];
  const printers = view.picked?.printers || [];
  let scanner = view.picked?.scanner || null;
  let printer = view.picked?.printer || null;
  let restoredScanner = false;
  if (choice?.deviceId) {
    const found = scanners.find((s) => s.deviceId === choice.deviceId);
    if (found) {
      scanner = found;
      restoredScanner = true;
    }
  }
  let restoredPrinter = false;
  if (confirmation?.printerName) {
    const found = printers.find((p) => p.name === confirmation.printerName);
    if (found) {
      printer = found;
      restoredPrinter = true;
    }
  }
  const restoredConfirm = !!(confirmation && scanner && (
    (confirmation.scannerDeviceId && confirmation.scannerDeviceId === scanner.deviceId)
    || (!confirmation.scannerDeviceId && confirmation.scannerName && confirmation.scannerName === scanner.name)
  ));
  return { view, scanner, printer, restoredScanner, restoredPrinter, restoredConfirm };
}

function deviceRow(kind, dev) {
  const ok = !!(dev && dev.name);
  const extra = ok && dev.port ? ` · ${dev.port}` : ok && dev.connection ? ` (${connectionLabel(dev.connection)})` : "";
  return h(
    "p",
    { class: ok ? "connect-device ok-line" : "connect-device", "data-connect-device": kind.toLowerCase() },
    ok ? icon("check", { size: 16 }) : null,
    ok ? `${kind}: ${dev.name}${extra}` : `${kind}: not reported`,
  );
}

function downloadLink(file, { again = false } = {}) {
  const size = formatDownloadSize(file.bytes);
  return h(
    "a",
    {
      class: again ? "hint" : "btn",
      href: file.href,
      download: file.fileName,
      "data-helper-download": again ? null : "1",
      "data-helper-download-again": again ? "1" : null,
    },
    again ? "Download again" : `Download ${file.fileName}`,
    size && !again ? ` (${size})` : "",
  );
}

function setupSteps() {
  return [
    "Double-click BEINGS-Scanner-Helper-Setup.exe.",
    SMARTSCREEN,
    "The setup window closes itself. The helper runs in the background. There is no window to keep open.",
    "Come back to this page and press Connect printer & scanner (Windows PC).",
  ];
}

/**
 * The body for one connect state. Used by the live card and by the screenshot preview.
 * protocolFallback true emphasizes the Start menu steps after beings-helper://start did not bring the helper up.
 */
export function connectStatusElement(model = {}) {
  const state = model.state || "not-installed";
  const pub = publishedHelper();
  const file = pub.setup || pub.zip;
  if (state === "forbidden") {
    return h("div", { "data-connect-state": "forbidden" }, callout("warn", "Preview page blocked", forbiddenOriginMessage(model.pageOrigin)));
  }
  if (state === "running" || state === "update-available") {
    const kids = [
      callout("ok", "Connected", "The helper is running in the background.", "check"),
      deviceRow("Scanner", model.scanner),
      deviceRow("Printer", model.printer),
    ];
    if (model.restoredScanner) kids.push(h("p", { class: "hint" }, "Using the scanner you confirmed before."));
    if (state === "update-available") {
      kids.push(h("p", { class: "hint", "data-helper-update": "1" }, `Update available. This computer is running helper ${model.version || "an older version"}. The site has ${model.publishedVersion || pub.version}.`));
      if (file) kids.push(h("p", { class: "actions" }, downloadLink(file)));
      kids.push(h("p", { class: "hint" }, SMARTSCREEN));
    }
    return h("div", { "data-connect-state": state }, ...kids);
  }
  if (state === "installed-not-running") {
    return h(
      "div",
      { "data-connect-state": "installed-not-running" },
      callout("info", "Helper is installed, but it is not running", "There is no window to keep open. Start the helper that is already on this PC."),
      h("ol", { class: "helper-steps" },
        h("li", null, "Press Start helper. This page will wait up to 15 seconds and check again."),
        h("li", null, "Open the Start menu and choose Start BEINGS helper if you would rather start it yourself."),
        h("li", null, "The helper runs in the background and also starts when you sign in to Windows."),
      ),
      h("p", { class: "actions" }, h("button", { class: "btn", type: "button", "data-helper-start": "1" }, START_LABEL)),
      h("p", { class: model.protocolFallback ? "hint" : "hint", "data-protocol-fallback": "1" }, PROTOCOL_FALLBACK),
    );
  }
  const recent = !!model.recentDownload;
  const kids = [
    h("p", { class: "hint" }, "Do this on the Windows PC that has the printer and scanner. An iPad or phone cannot run the helper. No administrator password is needed."),
  ];
  if (model.handheld) kids.push(h("p", { class: "hint", "data-helper-phone": "1" }, "You are on an iPad or phone. The helper cannot run on this device. Download the setup file here if you need to, then copy it to the Windows PC and double-click it there."));
  if (recent) {
    kids.push(h("p", { "data-helper-recent-download": "1" }, "You downloaded the installer recently. Open BEINGS-Scanner-Helper-Setup.exe from your Downloads folder and double-click it. ", SMARTSCREEN));
    if (file) kids.push(downloadLink(file, { again: true }));
  } else if (file) {
    kids.push(h("p", { class: "actions" }, downloadLink(file)));
    if (file.sha256) kids.push(h("p", { class: "helper-sha", "data-helper-sha": file.sha256 }, "SHA256 ", file.sha256));
  }
  kids.push(h("ol", { class: "helper-steps" }, ...setupSteps().map((step) => h("li", null, step))));
  kids.push(h("p", { class: "actions" }, h("button", { class: "btn", type: "button", "data-helper-already": "1" }, ALREADY_LABEL)));
  if (pub.zip && pub.setup) {
    kids.push(h("details", { class: "advanced" }, h("summary", null, "Zip fallback"), h("p", { class: "hint" }, "If the setup program will not run, download the zip, unzip it, and double-click Install-BEINGS-Helper.cmd. It installs the same helper."), h("p", null, h("a", { href: pub.zip.href, download: pub.zip.fileName }, pub.zip.fileName)), h("p", { class: "helper-sha" }, "SHA256 ", pub.zip.sha256 || "")));
  }
  return h("div", { "data-connect-state": "not-installed" }, ...kids);
}

/**
 * Connect card. onChange receives a confirmation when a scanner is linked, or null when it is not.
 * flagStorage remembers beings.helperSeen.v1 and beings.helperDownloadedAt (localStorage on the live page).
 */
export function helperConnectCard({ onChange, fetchImpl, storage, choiceStorage, flagStorage, pageOrigin, openImpl, now, sleep, publishedVersion, handheld, probeOnLoad = true } = {}) {
  const flags = flagStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const choices = choiceStorage ?? flags;
  const confirms = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  const pub = publishedHelper();
  const version = publishedVersion ?? pub.version;
  const out = h("div", { class: "find-station-out", role: "status" });
  const connectBtn = h("button", { class: "btn btn-primary", type: "button", "data-connect-printer": "1" }, icon("link", { size: 16 }), CONNECT_LABEL);
  let confirmation = null;
  const emit = (c) => {
    confirmation = c;
    onChange?.(c);
  };
  const clock = now || (() => Date.now());
  const phone = handheld ?? helperLooksHandheld();

  const paint = (probe, extra = {}) => {
    const seen = helperWasSeen(flags);
    const state = connectState({
      probe,
      seen,
      downloadedAt: flags?.getItem?.(HELPER_DOWNLOADED_AT_KEY) || "",
      now: clock(),
      publishedVersion: version,
    });
    let scanner = null;
    let printer = null;
    let restoredScanner = false;
    if (probe?.ok && probe.station) {
      const linked = relinkStation(probe.station, { choice: readScannerChoice(choices), confirmation: readStoredConfirmation(confirms) });
      scanner = linked.scanner;
      printer = linked.printer;
      restoredScanner = linked.restoredScanner;
      if (scanner?.deviceId) writeScannerChoice(choices, { deviceId: scanner.deviceId, name: scanner.name || "" });
      const conf = scanner
        ? (linked.restoredConfirm ? readStoredConfirmation(confirms) : confirmationFromView(linked.view, { scanner, printer }))
        : null;
      if (conf) writeStoredConfirmation(confirms, conf);
      else writeStoredConfirmation(confirms, null);
      emit(conf);
    } else if (probe) {
      emit(null);
    }
    const body = connectStatusElement({
      state: state.state,
      scanner,
      printer,
      restoredScanner,
      version: state.version,
      publishedVersion: version,
      pageOrigin,
      recentDownload: state.recentDownload,
      protocolFallback: !!extra.protocolFallback,
      handheld: phone,
    });
    fill(out, body);
    wire(body, extra);
  };

  const runProbe = () => probeHelper({
    fetchImpl: fetchImpl ?? (typeof fetch === "function" ? fetch : undefined),
  });

  const afterProbe = (probe, extra) => {
    if (probe?.ok || probe?.reason === "forbidden-origin") markHelperSeen(flags);
    paint(probe, extra);
    connectBtn.disabled = false;
  };

  function wire(body, extra) {
    body.querySelector("[data-helper-download]")?.addEventListener("click", () => {
      flags?.setItem?.(HELPER_DOWNLOADED_AT_KEY, new Date(clock()).toISOString());
    });
    body.querySelector("[data-helper-download-again]")?.addEventListener("click", () => {
      flags?.setItem?.(HELPER_DOWNLOADED_AT_KEY, new Date(clock()).toISOString());
    });
    body.querySelector("[data-helper-already]")?.addEventListener("click", async () => {
      markHelperSeen(flags);
      connectBtn.disabled = true;
      fill(out, h("p", { class: "muted" }, "Checking the helper on this computer…"));
      afterProbe(await runProbe(), extra);
    });
    body.querySelector("[data-helper-start]")?.addEventListener("click", async () => {
      const launched = launchHelperProtocol(openImpl);
      fill(out, h("p", { class: "muted" }, "Starting the helper…"));
      const probe = await waitForHelper({
        probe: runProbe,
        waitMs: START_WAIT_MS,
        sleep: sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
        now: clock,
      });
      afterProbe(probe, { protocolFallback: !launched || !probe?.ok });
    });
  }

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    fill(out, h("p", { class: "muted" }, "Checking the helper on this computer…"));
    afterProbe(await runProbe());
  });

  if (probeOnLoad) queueMicrotask(() => connectBtn.click());

  const root = h(
    "div",
    { class: "find-station helper-connect auto-block", "data-helper-connect": "1" },
    h("p", { class: "muted small" }, "This page cannot see a printer or scanner by itself. Press Connect printer & scanner (Windows PC) on the Windows PC that has them. The helper runs in the background. This check is optional."),
    h("div", { class: "actions" }, connectBtn),
    out,
  );
  return { root, connectButton: connectBtn, getConfirmation: () => confirmation };
}
