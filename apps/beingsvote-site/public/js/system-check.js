// "Run system check" on Create and Register. Talks only to the local helper.
// Copy report is plain text for a person to paste later. It does not call an AI service.
import { fill, h, callout } from "./ui.js";
import { BRIDGE_CANDIDATES, readScannerChoice, writeScannerChoice } from "./scanner-station.js";
import { helperLooksHandheld } from "./helper-install.js";
import { PREVIEW_NOTE, describePrintResult, fetchTestScanImage, openPdfInNewTab, prepareTestPage, printTestPage, rememberDetectedPrinters, scanAndReadTestPage, scanResultView } from "./test-print-scan.js";
import { state } from "./roles.js";
import { IOS_DEVICE_BUTTON, IOS_SCANNER_NOTE, checklistView, collectWalletFacts, isAppleTouchDevice, runDeviceChecks } from "./ios-device-check.js";

export const DIAG_TIMEOUT_MS = 20000;

const BALLOT_CODE = /\b[0-9A-HJKMNP-TV-Z]{12}\b/g;
const ADDRESS = /\b0x[0-9a-fA-F]{40,64}\b/g;

/** Strip secrets a report must never carry, even if a check detail accidentally included one. */
export function redactReportText(text) {
  let s = String(text ?? "");
  s = s.replace(/SCANNER_UPLOAD_TOKEN\s*=\s*\S+/gi, "SCANNER_UPLOAD_TOKEN=<removed>");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer <removed>");
  s = s.replace(/"(privateKey|mnemonic|seed|secret)"\s*:\s*"[^"]*"/gi, '"$1":"<removed>"');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<removed key>");
  s = s.replace(ADDRESS, "<removed address>");
  s = s.replace(BALLOT_CODE, "<removed code>");
  if (s.includes("%PDF") || s.includes("\u0089PNG")) s = s.replace(/%PDF[\s\S]*/g, "<removed file>").replace(/\u0089PNG[\s\S]*/g, "<removed file>");
  return s;
}

export function formatDiagnosticsReport(report) {
  const lines = ["BEINGS system check"];
  if (!report || !Array.isArray(report.checks)) {
    lines.push("No report.");
    return redactReportText(lines.join("\n"));
  }
  lines.push(report.ok ? "Nothing needs a fix before you try a test page." : "Something needs attention before a test page is likely to work.");
  for (const c of report.checks) {
    const mark = c.level === "ok" ? "OK" : c.level === "fail" ? "Needs attention" : c.level === "info" ? "Optional" : "Check";
    lines.push("");
    lines.push(`${mark}: ${c.title}`);
    lines.push(c.detail || "");
    if (c.whatToDo) lines.push(`What to do: ${c.whatToDo}`);
    if (c.fix === "remember-scanner" && c.autoPick?.name) lines.push(`Suggested scanner: ${c.autoPick.name}`);
  }
  lines.push("");
  lines.push("This note has no ballot codes, no upload token, and no wallet data. Nothing was uploaded.");
  return redactReportText(lines.join("\n"));
}

async function getDiagnostics(fetchImpl, timeoutMs) {
  let last = { error: "not-running" };
  for (const base of BRIDGE_CANDIDATES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/v1/diagnostics`, { method: "GET", signal: ctrl.signal, headers: { accept: "application/json" } });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!r.ok || !json?.checks) {
        last = { error: "unexpected", status: r.status, json };
        continue;
      }
      return { ok: true, base, json };
    } catch (e) {
      last = { error: e?.name === "AbortError" ? "timeout" : "not-running" };
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

async function postFix(fetchImpl, base, action) {
  const r = await fetchImpl(`${base}/v1/diagnostics/fix`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: r.ok && json?.ok !== false, json };
}

function checkRow(c, onFix) {
  const tone = c.level === "fail" ? "warn" : c.level === "ok" ? "ok" : "info";
  const extra = [];
  if (c.whatToDo) extra.push(h("p", { class: "hint" }, c.whatToDo));
  if (c.fix) {
    const label = c.fix === "remember-scanner" ? "Fix this: use this scanner" : c.fix === "supersede-synthetic-test" ? "Fix this: mark the test batch superseded" : "Fix this: start the helper at sign-in";
    const btn = h("button", { class: "btn btn-sm", type: "button" }, label);
    btn.addEventListener("click", () => onFix(c, btn));
    extra.push(h("p", { class: "actions" }, btn));
  }
  return h("div", { class: "system-check-row", "data-check": c.id }, callout(tone, c.title, h("div", null, h("p", null, c.detail || ""), ...extra)));
}

/**
 * The check panel. fetchImpl is injectable. choiceStorage defaults to localStorage.
 */
export function systemCheckCard({ fetchImpl, choiceStorage, handheld, ios, walletFacts, printImpl, featureEnv } = {}) {
  const out = h("div", { class: "system-check-out", role: "status" });
  const runBtn = h("button", { class: "btn", type: "button", "data-system-check": "1" }, "Run system check");
  const apple = ios ?? isAppleTouchDevice(typeof navigator !== "undefined" ? navigator : null);
  const iosBtn = apple ? h("button", { class: "btn", type: "button", "data-ios-device-check": "1" }, IOS_DEVICE_BUTTON) : null;
  const copyBtn = h("button", { class: "btn", type: "button", hidden: true }, "Copy report");
  const testBtn = h("button", { class: "btn", type: "button", hidden: true }, "Print and scan test page");
  const previewBtn = h("button", { class: "btn", type: "button", hidden: true }, "Preview");
  const logBtn = h("button", { class: "btn", type: "button" }, "Show helper log");
  let report = null;
  let base = null;
  const store = () => choiceStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const phone = handheld ?? helperLooksHandheld();

  const render = (node) => fill(out, node);

  const showReport = (json) => {
    report = json;
    copyBtn.hidden = false;
    testBtn.hidden = false;
    previewBtn.hidden = false;
    const rows = json.checks.map((c) => checkRow(c, async (check, btn) => {
      btn.disabled = true;
      if (check.fix === "remember-scanner" && check.autoPick?.deviceId) {
        writeScannerChoice(store(), { deviceId: check.autoPick.deviceId, name: check.autoPick.name || "" });
        btn.textContent = "Saved on this computer";
        return;
      }
      if (!base) {
        btn.disabled = false;
        return;
      }
      const r = await postFix(fetchImpl ?? fetch, base, check.fix);
      btn.textContent = r.ok ? "Done" : (r.json?.error || "Could not fix that");
      btn.disabled = !r.ok;
    }));
    const printers = json.checks?.find((c) => c.id === "printers");
    rememberDetectedPrinters(typeof sessionStorage !== "undefined" ? sessionStorage : null, { chosen: printers?.chosen?.name || "", printers: printers?.options || [] });
    render(h("div", { class: "system-check-report", "data-system-report": "1" }, callout(json.ok ? "ok" : "warn", json.ok ? "System check finished" : "System check found something to fix", json.ok ? "You can print and scan a test page when you are ready." : "Read the lines below. Fix this only does the three safe things: remember the scanner, set aside a leftover test batch, or start the helper when you sign in."), ...rows));
  };

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    copyBtn.hidden = true;
    testBtn.hidden = true;
    previewBtn.hidden = true;
    report = null;
    render(h("p", { class: "muted" }, "Checking this computer…"));
    const r = await getDiagnostics(fetchImpl ?? (typeof fetch === "function" ? fetch : undefined), DIAG_TIMEOUT_MS);
    runBtn.disabled = false;
    if (!r.ok) {
      const why = r.error === "timeout"
        ? "The helper did not answer in time. Press Connect printer & scanner (Windows PC), then Start helper if it is already installed, and press Run system check again. There is no window to keep open."
        : "This page could not reach the scanner helper on this computer. Press Connect printer & scanner (Windows PC) above. If it is already installed, press Start helper. There is no window to keep open.";
      if (apple) {
        render(callout("info", "Scanning stays with the scanner station", IOS_SCANNER_NOTE));
        return;
      }
      const phoneNote = phone ? h("p", { class: "hint", "data-helper-phone": "1" }, "You are on an iPad or phone. Run this check on the Windows PC that has the printer and scanner.") : null;
      render(h("div", null, callout("warn", "Helper not running", why), phoneNote));
      return;
    }
    base = r.base;
    showReport(r.json);
  });

  copyBtn.addEventListener("click", async () => {
    const text = formatDiagnosticsReport(report);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
    } catch {
      copyBtn.textContent = "Select the report and copy it";
    }
    const box = h("textarea", { class: "helper-sha", readonly: true, rows: 8, "data-system-report-text": "1" }, text);
    out.append(box);
  });

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    const prep = await prepareTestPage({ fetchImpl: fetchImpl ?? fetch });
    if (prep.error || !prep.json?.ok) {
      out.append(callout("warn", "Test page", "The helper could not prepare the test page."));
      testBtn.disabled = false;
      return;
    }
    const picked = out.parentElement?.querySelector("#system-check-printer")?.value;
    const printer = picked || report?.checks?.find((c) => c.id === "printers")?.chosen?.name;
    const deviceId = readScannerChoice(store())?.deviceId || report?.checks?.find((c) => c.id === "scanners")?.autoPick?.deviceId;
    let printNote = "No classroom printer was named, so nothing was sent to a printer.";
    if (printer) {
      const printed = await printTestPage({ fetchImpl: fetchImpl ?? fetch, printerName: printer });
      printNote = describePrintResult(printed.json);
    }
    const scanned = await scanAndReadTestPage({ fetchImpl: fetchImpl ?? fetch, deviceId });
    const view = scanResultView(scanned);
    let img = null;
    if (view.imageUrl && scanned.base) {
      const src = await fetchTestScanImage({ fetchImpl: fetchImpl ?? fetch, base: scanned.base, path: view.imageUrl });
      if (src) img = h("img", { class: "test-scan-thumb", alt: "Scanned test page", src });
    }
    out.append(callout(view.tone, view.title, `${printNote} ${view.message}`.trim(), view.pass ? "check" : "alert"), img);
    testBtn.disabled = false;
  });

  iosBtn?.addEventListener("click", async () => {
    iosBtn.disabled = true;
    render(h("p", { class: "muted" }, "Checking this iPad…"));
    try {
      const facts = walletFacts
        ? await walletFacts()
        : await collectWalletFacts({ ethereum: typeof window !== "undefined" ? window.ethereum : null, address: state.address, chainId: state.chainId });
      const checks = await runDeviceChecks({ env: featureEnv, wallet: facts, print: printImpl });
      render(checklistView(checks));
    } finally {
      iosBtn.disabled = false;
    }
  });

  logBtn.addEventListener("click", async () => {
    const origin = base || BRIDGE_CANDIDATES[0];
    try {
      const r = await (fetchImpl ?? fetch)(`${origin}/v1/log`, { headers: { accept: "application/json" } });
      const json = await r.json();
      out.append(h("textarea", { class: "helper-sha", readonly: true, rows: 8, "data-helper-log": "1" }, json?.text || "No helper log was found on this computer."));
    } catch {
      out.append(callout("warn", "Helper log", "The helper log could not be read."));
    }
  });

  previewBtn.addEventListener("click", () => {
    const origin = base || BRIDGE_CANDIDATES[0];
    const url = `${String(origin).replace(/\/+$/, "")}/v1/test/page.pdf`;
    const opened = openPdfInNewTab(url);
    out.append(callout("info", "Preview", opened ? PREVIEW_NOTE : "The browser blocked the preview tab. Allow pop-ups for this site, then press Preview again. Preview does not print."));
  });

  const root = h(
    "div",
    { class: "system-check auto-block", "data-system-check-panel": "1" },
    h("p", { class: "muted small" }, "Optional. This asks the helper what this computer can see: Node, the printer, the scanner, and whether Windows built-in printing can send a test page straight to the printer. It does not upload anything and it does not start a real election scan."),
    h("div", { class: "actions" }, runBtn, iosBtn, copyBtn, testBtn, previewBtn, logBtn),
    out,
  );
  return { root, runButton: runBtn, iosButton: iosBtn };
}
