// Optional "Test print and scan" step. Talks only to the local scanner helper (127.0.0.1:8765).
// The helper generates a clearly labelled synthetic test page (fixed fake code, never from a real
// election), may print it, scans it, and checks the reading and ballot fingerprint. Nothing is
// recorded on the ledger or uploaded. Skipping never blocks Create or Register.
import { fill, h, icon, callout } from "./ui.js";
import { BRIDGE_CANDIDATES, FIND_TIMEOUT_MS, readScannerChoice } from "./scanner-station.js";
import { isMobileDevice } from "./logic.js";
import { iosStationPanel, isAppleTouchDevice } from "./ios-device-check.js";

export const TEST_STORAGE_KEY = "beings.testPrintScan.v1";
export const DETECTED_PRINTERS_KEY = "beings.detectedPrinters.v1";
const printerListeners = new Set();
export const TEST_PREPARE_TIMEOUT_MS = 8000;
export const TEST_PRINT_TIMEOUT_MS = 30000;
export const TEST_SCAN_TIMEOUT_MS = 120000;

export const TEST_INTRO =
  "Optional. This prints a clearly labelled synthetic test page (not a real ballot), scans it, and checks that the reading and its fingerprint match. Nothing is recorded on the ledger or uploaded. You can skip it; creating or registering is never blocked, because ballots are accounted for by hash.";

export const TEST_MOBILE_TITLE = "Run this on the printer computer";
export const TEST_MOBILE_UNAVAILABLE =
  "This print-and-scan test must be run from the computer connected to the printer and scanner, with the scanner helper running on that computer. A phone or tablet cannot run it. You can skip this step. Creating or registering is never blocked.";

/** What to say when the helper did not answer. Phones and tablets get the printer-computer wording; a desktop still says to start the helper here. */
export function explainTestStartFailure({ mobile = false, error } = {}) {
  if (error !== "not-running" && error !== "timeout") return null;
  if (mobile) return TEST_MOBILE_UNAVAILABLE;
  if (error === "timeout") return "The scanner helper did not answer in time. Wait a moment and try again, or skip this check.";
  return "The scanner helper on this computer did not answer. Use the computer that has the printer and scanner, start the helper, then try again. You can skip this check; creating or registering is never blocked.";
}

export function readStoredTestStatus(storage) {
  try {
    const raw = storage?.getItem?.(TEST_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !["skipped", "pass", "fail", "mocked"].includes(v.status)) return null;
    return { status: v.status, at: v.at ?? null, mocked: !!v.mocked };
  } catch {
    return null;
  }
}

export function writeStoredTestStatus(storage, value) {
  if (!storage) return;
  if (!value) {
    storage.removeItem(TEST_STORAGE_KEY);
    return;
  }
  const status = value.status;
  if (!["skipped", "pass", "fail", "mocked"].includes(status)) return;
  storage.setItem(TEST_STORAGE_KEY, JSON.stringify({ status, at: value.at ?? new Date().toISOString(), mocked: !!value.mocked }));
}

/** Plain-language advisory for Register (and similar). Never blocks; Create/Register stay available. */
export function testPrintScanAdvisory({ confirmed, testStatus, helperSeen } = {}) {
  const test = testStatus?.status ?? testStatus ?? null;
  if (test === "pass") {
    return confirmed
      ? null
      : "The test print and scan passed, but this computer has not confirmed a scanner/printer. You can still register: ballots are accounted for by hash, so any printer and scanner can work.";
  }
  if (test === "mocked") {
    return "The test used a stand-in picture, not a real scanner. On the polling PC, run the same test with the helper and the real machine to confirm the hardware. You can still register; this check is optional.";
  }
  if (test === "fail") {
    return "The test print and scan did not pass. You can try again, or register anyway: ballots are accounted for by hash, so creating and registering are not blocked.";
  }
  if (!confirmed) {
    return helperSeen === false
      ? "No scanner or printer was confirmed on this computer. That's okay: ballots are accounted for by hash, so any printer and scanner can theoretically work, and you can still register. A test print and scan is a helpful check when the helper is running on the polling PC."
      : "This computer has not confirmed a scanner/printer. That's okay: ballots are accounted for by hash, so any printer and scanner can theoretically work, and you can still register. A test print and scan is a helpful optional check.";
  }
  if (test === "skipped" || !test) {
    return "The optional test print and scan has not been completed. You can skip it and register now; ballots are accounted for by hash, so registration is not blocked.";
  }
  return null;
}

async function requestJson(fetchImpl, { base, path, method = "GET", body, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = { method, signal: ctrl.signal, headers: { accept: "application/json" } };
    if (method === "POST") {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body ?? {});
    }
    const r = await fetchImpl(`${base}${path}`, opts);
    const contentType = r.headers?.get?.("content-type") ?? "";
    const text = await r.text();
    let json = null;
    if (!contentType.includes("application/pdf")) {
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    }
    return { status: r.status, json, ok: r.ok, text };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "timeout" : "not-running" };
  } finally {
    clearTimeout(t);
  }
}

async function withBases(fetchImpl, fn, { bases = BRIDGE_CANDIDATES, timeoutMs = FIND_TIMEOUT_MS } = {}) {
  let last = { error: "not-running" };
  for (const base of bases) {
    const r = await fn(base, timeoutMs);
    if (r?.error === "not-running" || r?.error === "timeout") {
      last = r;
      continue;
    }
    return { base, ...r };
  }
  return last;
}

export async function prepareTestPage({ fetchImpl = fetch, bases = BRIDGE_CANDIDATES, timeoutMs = TEST_PREPARE_TIMEOUT_MS } = {}) {
  return withBases(fetchImpl, (base, ms) => requestJson(fetchImpl, { base, path: "/v1/test/prepare", method: "POST", body: {}, timeoutMs: ms }), { bases, timeoutMs });
}

export async function printTestPage({ fetchImpl = fetch, bases = BRIDGE_CANDIDATES, timeoutMs = TEST_PRINT_TIMEOUT_MS, printerName } = {}) {
  return withBases(fetchImpl, (base, ms) => requestJson(fetchImpl, { base, path: "/v1/test/print", method: "POST", body: { printerName }, timeoutMs: ms }), { bases, timeoutMs });
}

export const PREVIEW_NOTE = "Preview only opens the PDF so you can look at it. It does not print. Your usual PDF app may open to show the file.";

/** Open a PDF URL in a new tab. Returns false when the browser blocks the tab. Never prints. */
export function openPdfInNewTab(url, openImpl) {
  const open = openImpl ?? (typeof window !== "undefined" ? window.open.bind(window) : null);
  if (!open) return false;
  const tab = open(url, "_blank", "noopener,noreferrer");
  return !!tab;
}

/** Open PDF bytes in a new tab. Returns false when the browser blocks the tab. Never prints. */
export function openPdfBytesInNewTab(bytes, openImpl) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const opened = openPdfInNewTab(url, openImpl);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return opened;
}

/** What the page says after the helper prints. A failed or unchecked job is not described as printed. */
export function describePrintResult(json) {
  if (!json) return "The helper did not say whether the page printed. You can press Preview to look at the page. Preview does not print.";
  if (json.mocked) return json.message || "The helper did not send this to a real printer on this computer. Press Preview to look at the page, or run the test on the polling PC.";
  const tried = Array.isArray(json.attempts) && json.attempts.length ? ` Queues tried: ${json.attempts.map((a) => `${a.name} (${a.outcome})`).join("; ")}.` : "";
  if (json.printed === false || json.ok === false || json.error) {
    return `${json.message || json.detail || json.error || "Windows did not print the page."}${tried} You can pick another queue, or press Preview and print that PDF from Adobe. Preview itself does not print.`;
  }
  if (json.pending) return `Windows accepted a job for "${json.printerName || "the chosen printer"}", but it is still in the print queue.${tried} Open the Windows print queue and look for an error.`;
  const where = json.printerName ? ` to "${json.printerName}"` : "";
  if (json.method === "Windows built-in") return `Printed with Windows built-in printing${where}, straight to that queue, at actual size, single-sided. No PDF app was opened. Collect that one sheet (it is labelled SYNTHETIC TEST PAGE — NOT A REAL BALLOT), then scan it.`;
  if (json.method === "SumatraPDF") return `Windows built-in printing did not finish, so the helper used SumatraPDF that was already installed. It printed quietly${where}, at actual size, single-sided. Collect that one sheet (it is labelled SYNTHETIC TEST PAGE — NOT A REAL BALLOT), then scan it.`;
  return json.message || `The test page was sent to the printer${where}. Collect that one sheet, then scan it.`;
}

/** Printers the system check found, so the test card can use them without a separate confirmation. */
export function rememberDetectedPrinters(storage, { printers = [], chosen = "" } = {}) {
  const list = (Array.isArray(printers) ? printers : []).filter((p) => p && p.name).map((p) => ({ name: String(p.name), port: p.port ? String(p.port) : "" }));
  const value = { chosen: chosen ? String(chosen) : list[0]?.name || "", printers: list };
  try { storage?.setItem?.(DETECTED_PRINTERS_KEY, JSON.stringify(value)); } catch { /* private mode */ }
  for (const fn of printerListeners) fn(value);
  return value;
}

export function readDetectedPrinters(storage) {
  try {
    const v = JSON.parse(storage?.getItem?.(DETECTED_PRINTERS_KEY) || "null");
    if (!v || !Array.isArray(v.printers)) return { chosen: "", printers: [] };
    return { chosen: v.chosen ? String(v.chosen) : "", printers: v.printers.filter((p) => p && p.name).map((p) => ({ name: String(p.name), port: p.port ? String(p.port) : "" })) };
  } catch {
    return { chosen: "", printers: [] };
  }
}

export function onDetectedPrinters(fn) {
  printerListeners.add(fn);
  return () => printerListeners.delete(fn);
}

export function scanResultView(r) {
  const j = r?.json ?? {};
  const pass = j.pass === true;
  const mocked = !!j.mocked;
  const message = j.message || j.help || j.error || (r?.error === "timeout" ? "The page stopped waiting. The scanner may still be working. Wait a moment and press Scan and check again." : r?.error ? "The helper did not return a scan result." : "The scan finished, but this page did not get a confirmation.");
  const title = pass && mocked ? "Test passed, with a stand-in picture" : pass ? "Test print and scan passed" : "Test print and scan did not pass";
  return { pass, mocked, message, title, tone: pass ? "ok" : "warn", imageUrl: j.imageUrl || null, checks: Array.isArray(j.checks) ? j.checks : [] };
}

export async function fetchTestScanImage({ fetchImpl, base, path = "/v1/test/last-page.png" } = {}) {
  if (!fetchImpl || !base || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    const r = await fetchImpl(`${String(base).replace(/\/+$/, "")}${path}`, { method: "GET" });
    if (!r?.ok || typeof r.blob !== "function") return null;
    const blob = await r.blob();
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export async function scanAndReadTestPage({ fetchImpl = fetch, bases = BRIDGE_CANDIDATES, timeoutMs = TEST_SCAN_TIMEOUT_MS, deviceId, mock } = {}) {
  const body = {};
  if (deviceId) body.deviceId = deviceId;
  if (mock) body.mock = true;
  return withBases(fetchImpl, (base, ms) => requestJson(fetchImpl, { base, path: "/v1/test/scan-and-read", method: "POST", body, timeoutMs: ms }), { bases, timeoutMs });
}

export async function fetchTestPdfBlob({ fetchImpl = fetch, bases = BRIDGE_CANDIDATES, timeoutMs = TEST_PREPARE_TIMEOUT_MS } = {}) {
  let last = { error: "not-running" };
  for (const base of bases) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/v1/test/page.pdf`, { method: "GET", signal: ctrl.signal });
      if (!r.ok) {
        last = { status: r.status, error: "unexpected" };
        continue;
      }
      const blob = await r.blob();
      return { base, blob, ok: true };
    } catch (e) {
      last = { error: e?.name === "AbortError" ? "timeout" : "not-running" };
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

function statusFromResult(r) {
  if (!r || r.error || (r.status && r.status >= 400 && !r.json)) return { status: "fail", mocked: false };
  const j = r.json ?? r;
  if (j.mocked && j.pass) return { status: "mocked", mocked: true };
  if (j.pass) return { status: "pass", mocked: !!j.mocked };
  return { status: "fail", mocked: !!j.mocked };
}

function checksList(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  return h(
    "ul",
    { class: "test-scan-checks" },
    ...checks.map((c) => h("li", { class: c.ok ? "ok" : "bad" }, c.ok ? "Pass: " : "Fail: ", c.label, c.ok ? "" : c.help ? ` — ${c.help}` : "")),
  );
}

/**
 * Interactive optional test card. onChange({ status, mocked }) fires on pass, fail, mocked, skip, or reset.
 * fetchImpl is injectable for tests and previews.
 */
export function testPrintScanCard({ onChange, fetchImpl, storage, getDevices, pageOrigin, mobile, ios, openImpl, pageProtocol } = {}) {
  void pageOrigin;
  const onPhone = mobile ?? (typeof navigator !== "undefined" && isMobileDevice(navigator.userAgent, navigator.maxTouchPoints, navigator.platform));
  const onIos = ios ?? isAppleTouchDevice(typeof navigator !== "undefined" ? navigator : null);
  const out = h("div", { class: "test-scan-out", role: "status" });
  const startBtn = h("button", { class: "btn", type: "button" }, icon("play", { size: 16 }), "Start test print and scan");
  const skipBtn = h("button", { class: "btn", type: "button" }, "Skip");
  const printHelperBtn = h("button", { class: "btn", type: "button", hidden: true }, "Print with the chosen printer");
  const previewBtn = h("button", { class: "btn", type: "button", hidden: true }, "Preview");
  const printBrowserBtn = h("button", { class: "btn", type: "button", hidden: true }, "Print from this browser");
  const scanBtn = h("button", { class: "btn btn-primary", type: "button", hidden: true }, "Scan and check");
  const againBtn = h("button", { class: "btn", type: "button", hidden: true }, "Try again");
  const actions = h("div", { class: "actions" }, startBtn, printHelperBtn, previewBtn, printBrowserBtn, scanBtn, skipBtn, againBtn);
  const printerStore = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  const printerNote = h("p", { class: "hint", "data-test-printer": "1" });
  const printerSelect = h("select", { id: "test-printer", "aria-label": "Printer for the test page" });
  const selectedPrinter = () => printerSelect.value || getDevices?.()?.printerName || "";
  const refreshPrinters = () => {
    const detected = readDetectedPrinters(printerStore);
    const confirmed = getDevices?.()?.printerName || "";
    const names = [];
    const preferred = detected.chosen || confirmed;
    if (preferred) names.push(preferred);
    if (confirmed && !names.includes(confirmed)) names.push(confirmed);
    for (const p of detected.printers) if (p.name && !names.includes(p.name)) names.push(p.name);
    const current = printerSelect.value && names.includes(printerSelect.value) ? printerSelect.value : preferred;
    printerSelect.replaceChildren(...(names.length ? names.map((n) => h("option", { value: n, selected: n === current ? true : null }, n)) : [h("option", { value: "" }, "No printer detected yet")]));
    if (current) printerSelect.value = current;
    const name = selectedPrinter();
    printerNote.textContent = name
      ? `This test will print to "${name}".`
      : "No printer is selected yet. Run the system check, then pick one of the printers it found. You can still press Preview or Print from this browser.";
    printHelperBtn.disabled = !name;
  };
  refreshPrinters();
  printerSelect.addEventListener("change", refreshPrinters);
  const stopPrinterWatch = onDetectedPrinters(() => refreshPrinters());
  void stopPrinterWatch;
  let previewBase = null;
  let prepared = null;
  let status = readStoredTestStatus(storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null));

  const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  const emit = (s) => {
    status = s;
    if (s && ["skipped", "pass", "fail", "mocked"].includes(s.status)) writeStoredTestStatus(store, s);
    else writeStoredTestStatus(store, null);
    onChange?.(s);
  };

  const hideFlowButtons = () => {
    printHelperBtn.hidden = true;
    previewBtn.hidden = true;
    printBrowserBtn.hidden = true;
    scanBtn.hidden = true;
  };

  const showIdle = (msg) => {
    startBtn.hidden = false;
    startBtn.disabled = false;
    skipBtn.hidden = false;
    againBtn.hidden = true;
    hideFlowButtons();
    fill(out, msg ? callout("info", "Not started", msg) : null);
  };

  const showPrepared = (info, extra) => {
    startBtn.hidden = true;
    skipBtn.hidden = false;
    againBtn.hidden = false;
    printHelperBtn.hidden = false;
    previewBtn.hidden = false;
    printBrowserBtn.hidden = false;
    scanBtn.hidden = false;
    refreshPrinters();
    const kids = [
      callout("info", "Synthetic test page ready", "This is not a real ballot. Print it at actual size, single-sided, then put that one sheet in the scanner and press Scan and check."),
      h("p", { class: "small" }, info?.electionName ?? "SYNTHETIC TEST PAGE — NOT A REAL BALLOT"),
      h("p", { class: "hint" }, "The page is labelled so it cannot be mistaken for a real ballot. Nothing is recorded or uploaded."),
    ];
    if (extra) kids.push(typeof extra === "string" ? h("p", { class: "hint" }, extra) : extra);
    if (!selectedPrinter()) kids.push(h("p", { class: "hint" }, "Pick a printer above before printing from the helper. You can press Preview to look at the page. Preview does not print. You can also skip this check."));
    fill(out, ...kids);
  };

  const showResult = async (r) => {
    startBtn.hidden = true;
    skipBtn.hidden = true;
    hideFlowButtons();
    againBtn.hidden = false;
    const view = scanResultView(r?.json || r?.error ? r : { json: r });
    const st = statusFromResult(r);
    if (!view.pass && st.status === "mocked") view.title = "Test passed, with a stand-in picture";
    let img = null;
    const base = r?.base || previewBase;
    if (view.imageUrl && base) {
      const src = await fetchTestScanImage({ fetchImpl: fetchImpl ?? (typeof fetch === "function" ? fetch : undefined), base, path: view.imageUrl });
      if (src) img = h("img", { class: "test-scan-thumb", alt: "Scanned test page", src });
      else img = h("p", { class: "hint" }, "The scanner saved a picture, but this page could not show it.");
    }
    fill(out, callout(view.tone, view.title, view.message, view.pass ? "check" : "alert"), img, checksList(view.checks));
    emit({ status: view.pass ? (view.mocked ? "mocked" : "pass") : "fail", at: new Date().toISOString(), mocked: view.mocked });
  };

  startBtn.addEventListener("click", async () => {
    if (onPhone) {
      startBtn.disabled = false;
      skipBtn.hidden = false;
      fill(out, callout("info", TEST_MOBILE_TITLE, TEST_MOBILE_UNAVAILABLE));
      return;
    }
    startBtn.disabled = true;
    fill(out, h("p", { class: "muted" }, "Preparing the synthetic test page…"));
    const r = await prepareTestPage({ fetchImpl: fetchImpl ?? (typeof fetch === "function" ? fetch : undefined) });
    if (r.error || !r.json?.ok) {
      startBtn.disabled = false;
      startBtn.hidden = false;
      skipBtn.hidden = false;
      hideFlowButtons();
      const offline = r.error === "timeout" || r.error === "not-running" || !r.json;
      const help =
        r.error === "timeout"
          ? "The scanner helper did not answer in time. Press Connect printer & scanner (Windows PC), then Start helper if it is already installed, and try again. There is no window to keep open. You can also skip this check."
          : offline
            ? "The scanner helper on this computer did not answer. On the Windows PC with the printer and scanner, press Connect printer & scanner (Windows PC). If the helper is already installed, press Start helper. There is no window to keep open. You can skip this check; creating or registering is never blocked."
            : explainTestStartFailure({ mobile: false, error: r.error }) || r.json?.error || "The helper could not prepare the synthetic test page.";
      fill(out, callout("warn", "Could not start the test", help));
      return;
    }
    prepared = r.json;
    previewBase = r.base || previewBase;
    showPrepared(prepared, r.json.mockTest ? h("p", { class: "hint" }, "This helper can use a stand-in picture if a real scanner is not available. On the polling PC, a real scan is preferred.") : null);
  });

  printHelperBtn.addEventListener("click", async () => {
    refreshPrinters();
    const printerName = selectedPrinter();
    if (!printerName) {
      showPrepared(prepared, "Pick a printer above first. You can press Preview to look at the page. Preview does not print.");
      return;
    }
    printHelperBtn.disabled = true;
    const r = await printTestPage({ fetchImpl: fetchImpl ?? fetch, printerName });
    printHelperBtn.disabled = !selectedPrinter();
    if (r.base) previewBase = r.base;
    if (r.error || !r.json) {
      showPrepared(prepared, "The helper did not answer about the print. You can press Preview to look at the page. Preview does not print.");
      return;
    }
    showPrepared(prepared, describePrintResult(r.json));
  });

  previewBtn.addEventListener("click", () => {
    const base = previewBase || BRIDGE_CANDIDATES[0];
    const url = `${String(base).replace(/\/+$/, "")}/v1/test/page.pdf`;
    const opened = openPdfInNewTab(url, openImpl);
    showPrepared(prepared, opened ? PREVIEW_NOTE : "The browser blocked the preview tab. Allow pop-ups for this site, then press Preview again. Preview does not print.");
  });

  printBrowserBtn.addEventListener("click", async () => {
    printBrowserBtn.disabled = true;
    const r = await fetchTestPdfBlob({ fetchImpl: fetchImpl ?? fetch });
    printBrowserBtn.disabled = false;
    if (!r.ok || !r.blob) {
      showPrepared(prepared, "The helper did not return the test PDF. Start the helper on this computer and try again.");
      return;
    }
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "SYNTHETIC-TEST-PAGE-NOT-A-REAL-BALLOT.pdf";
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showPrepared(prepared, "The synthetic test PDF was opened so you can print it from this browser at actual size, single-sided. Then put that one sheet in the scanner and press Scan and check.");
  });

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    fill(out, h("p", { class: "muted" }, "Scanning and reading the synthetic test page…"));
    const devices = getDevices?.() ?? {};
    const remembered = readScannerChoice(typeof localStorage !== "undefined" ? localStorage : null);
    const deviceId = devices.scannerDeviceId || remembered?.deviceId || "";
    const r = await scanAndReadTestPage({ fetchImpl: fetchImpl ?? fetch, deviceId: deviceId || undefined });
    scanBtn.disabled = false;
    if (r.base) previewBase = r.base;
    await showResult(r);
    if ((r.json && r.json.pass === false) || r.status >= 400) skipBtn.hidden = false;
  });

  skipBtn.addEventListener("click", () => {
    startBtn.hidden = false;
    startBtn.disabled = false;
    hideFlowButtons();
    againBtn.hidden = true;
    skipBtn.hidden = true;
    fill(out, callout("info", "Skipped", "The test print and scan was skipped. You can come back to it later. Creating or registering is never blocked, because ballots are accounted for by hash."));
    emit({ status: "skipped", at: new Date().toISOString(), mocked: false });
  });

  againBtn.addEventListener("click", () => {
    prepared = null;
    emit(null);
    showIdle();
    startBtn.click();
  });

  if (!status && onPhone) {
    fill(out, callout("info", TEST_MOBILE_TITLE, TEST_MOBILE_UNAVAILABLE));
  }

  if (status) {
    startBtn.hidden = false;
    skipBtn.hidden = status.status === "skipped";
    againBtn.hidden = false;
    hideFlowButtons();
    if (status.status === "skipped") {
      fill(out, callout("info", "Skipped", "The test print and scan was skipped. You can start it now if you want to. Creating or registering is never blocked."));
    } else if (status.status === "pass") {
      fill(out, callout("ok", "Test print and scan passed", "A previous check on this computer passed. You can run it again if you want to.", "check"));
    } else if (status.status === "mocked") {
      fill(out, callout("ok", "Test passed, with a stand-in picture", "A previous check used a stand-in picture, not a real scanner. On the polling PC, run it again with the real machine to confirm the hardware.", "check"));
    } else {
      fill(out, callout("warn", "Previous test did not pass", "You can try again, or skip this check. Creating or registering is never blocked."));
    }
  }

  const station = onIos ? iosStationPanel({ storage: typeof localStorage !== "undefined" ? localStorage : storage, fetchImpl, pageProtocol }) : null;
  const root = h(
    "div",
    { class: "test-print-scan auto-block", "data-test-print-scan": "1" },
    h("p", { class: "muted small" }, TEST_INTRO),
    h("div", { class: "field" }, h("label", { for: "test-printer" }, "Printer for the test page"), printerSelect, printerNote),
    actions,
    out,
    station?.root ?? null,
  );
  return {
    root,
    getStatus: () => status,
    startButton: startBtn,
    skipButton: skipBtn,
    printHelperButton: printHelperBtn,
    previewButton: previewBtn,
    printBrowserButton: printBrowserBtn,
    scanButton: scanBtn,
    stationButton: station?.button ?? null,
    stationInput: station?.input ?? null,
    printerSelect,
  };
}
