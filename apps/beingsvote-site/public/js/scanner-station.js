// Find and confirm the Local Scanner/Printer on the teacher's polling PC.
// Browsers cannot list printers or scanners themselves. This page asks the optional
// localhost scanner-helper bridge (127.0.0.1:8765) for the devices Windows can see
// and, if configured, the station's public wallet address. The helper never holds a key.
import { fill, h, icon, callout } from "./ui.js";
import { isAddress } from "./logic.js";
import { shortAddress } from "./format.js";
import { helperCommandDetails } from "./helper-install.js";

export const BRIDGE_PORT = 8765;
export const BRIDGE_CANDIDATES = Object.freeze([`http://127.0.0.1:${BRIDGE_PORT}`, `http://localhost:${BRIDGE_PORT}`]);
export const FIND_TIMEOUT_MS = 10000;

/** Lower is better. A Brother BRW direct-port queue beats a WSD queue for the same machine. */
export function printerPortRank(printer) {
  const port = String(printer?.port ?? "");
  const name = String(printer?.name ?? "");
  const blob = `${port} ${name}`;
  if (/^BRW/i.test(port) || /\bBRW[0-9A-F]{4,}/i.test(blob)) return 0;
  if (/^IP_/i.test(port) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(port)) return 1;
  if (/^USB/i.test(port)) return 2;
  if (/^WSD/i.test(port) || /\bWSD\b/i.test(blob)) return 4;
  return 3;
}

function rankPrinters(list) {
  return [...list].sort((a, b) => printerPortRank(a) - printerPortRank(b));
}
export const CONFIRM_STORAGE_KEY = "beings.stationConfirm.v1";
export const SCANNER_CHOICE_KEY = "beings.scannerDevice.v1";

const MODEL_RE = /\b(dcp|mfc|hl)[- ]?[a-z0-9]+\b/i;

export function scannerModelKey(name) {
  const raw = String(name ?? "");
  const hit = raw.match(MODEL_RE);
  if (hit) return hit[0].toLowerCase().replace(/[- ]/g, "");
  return raw.replace(/\[[^\]]*\]/g, " ").replace(/\b(lan|series|wsd|usb|network|scanner|printer)\b/gi, " ").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export function isMicrosoftDriver(device) {
  return /^microsoft\b/i.test(String(device?.manufacturer ?? "").trim());
}

/** Same rule as the helper: one model listed twice keeps the maker's driver. Different models are not guessed. */
export function pickScanner(scanners) {
  const list = (Array.isArray(scanners) ? scanners : []).filter((s) => s && (s.deviceId || s.name));
  if (!list.length) return { ok: false, sameModel: false, error: "No scanners were found." };
  const keys = [...new Set(list.map((s) => scannerModelKey(s.name)).filter(Boolean))];
  const sameModel = keys.length <= 1;
  if (list.length === 1) return { ok: true, device: list[0], auto: false, sameModel };
  const own = list.filter((s) => !isMicrosoftDriver(s));
  const pool = own.length ? own : list;
  if (sameModel) return { ok: true, device: pool[0], auto: true, sameModel: true };
  const names = list.map((s) => s.name || s.deviceId).join("; ");
  return { ok: false, sameModel: false, error: `Several different scanners were found: ${names}. Choose the one on this desk.` };
}

export function readScannerChoice(storage) {
  try {
    const raw = storage?.getItem?.(SCANNER_CHOICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.deviceId) return null;
    return { deviceId: String(v.deviceId), name: v.name ? String(v.name) : "" };
  } catch {
    return null;
  }
}

export function writeScannerChoice(storage, choice) {
  if (!storage) return;
  if (!choice?.deviceId) {
    storage.removeItem(SCANNER_CHOICE_KEY);
    return;
  }
  storage.setItem(SCANNER_CHOICE_KEY, JSON.stringify({ deviceId: String(choice.deviceId), name: choice.name ? String(choice.name) : "" }));
}

// Virtual / file-only printers are not a classroom scanner/printer station.
const VIRTUAL_PRINTER = /one[\s-]?note|microsoft print to pdf|microsoft xps|\bfax\b|send to onenote|adobe pdf|pdf24|bullzip|dopdf|cutepdf|print to pdf|redirected\b|microsoft ips|onenote/i;

export function isVirtualPrinter(p) {
  const name = String(p?.name ?? "");
  const driver = String(p?.driver ?? "");
  return VIRTUAL_PRINTER.test(name) || VIRTUAL_PRINTER.test(driver);
}

export function connectionLabel(connection) {
  const c = String(connection ?? "").toLowerCase();
  if (c === "usb") return "USB";
  if (c === "network") return "Wi-Fi or network";
  if (c === "other" || c === "unknown" || !c) return "connection unknown";
  return connection;
}

/** Register is allowed whenever the organizer can act during Setup. Confirmation is optional (advisory only). */
export function registerEnabled({ can }) {
  return !!can;
}

/** Refuse anything that is not a public 0x address. Pure. */
export function publicStationWallet(input) {
  if (input == null) return null;
  const address = String(input.address ?? input).trim();
  if (!isAddress(address) && !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const label = input.label != null ? String(input.label).trim() : "";
  return { address, label: label || null };
}

export function pickDevices(scanners, printers) {
  const scanList = Array.isArray(scanners) ? scanners.filter((s) => s && (s.name || s.deviceId)) : [];
  const allPrinters = Array.isArray(printers) ? printers.filter((p) => p && p.name) : [];
  const realPrinters = allPrinters.filter((p) => !isVirtualPrinter(p));
  const hiddenVirtual = allPrinters.length - realPrinters.length;
  const preferBrother = (list) => {
    const b = list.filter((x) => /brother/i.test(String(x.name ?? "")) || /brother/i.test(String(x.manufacturer ?? "")) || /brother/i.test(String(x.driver ?? "")));
    return b.length ? b : list;
  };
  const decision = pickScanner(scanList);
  const scanChoices = decision.ok ? [decision.device, ...preferBrother(scanList).filter((s) => s !== decision.device)] : preferBrother(scanList);
  const printerChoices = (() => {
    const preferred = preferBrother(realPrinters);
    const scanName = String(scanChoices[0]?.name ?? "").toLowerCase();
    const token = (scanName.match(/dcp[- ]?[a-z0-9]+|mfc[- ]?[a-z0-9]+|hl[- ]?[a-z0-9]+/i) ?? [])[0];
    const pool = token
      ? (() => {
          const match = preferred.filter((p) => String(p.name).toLowerCase().includes(token.toLowerCase()));
          return match.length ? match : preferred;
        })()
      : preferred;
    return rankPrinters(pool);
  })();
  return {
    scanners: scanList,
    printers: realPrinters,
    hiddenVirtual,
    scanner: scanChoices[0] ?? null,
    printer: printerChoices[0] ?? null,
    sameModel: decision.sameModel !== false && decision.ok,
    scannerChoiceError: decision.ok ? null : decision.error,
    scannerNeedsChoice: scanList.length > 1,
    printerNeedsChoice: realPrinters.length > 1,
  };
}

export function describeStation(payload) {
  const scanners = payload?.scanners ?? [];
  const printers = payload?.printers ?? [];
  const picked = pickDevices(scanners, printers);
  const wallet = publicStationWallet(payload?.stationWallet);
  const listFailed = Array.isArray(payload?.errors) && payload.errors.length > 0 && !picked.scanner && !picked.printer;
  if (listFailed) {
    return { kind: "list-failed", title: "Not found", canConfirm: false, help: explainFindFailure("list-failed"), picked, wallet, errors: payload.errors };
  }
  if (!picked.scanner && !picked.printer) {
    return { kind: "no-devices", title: "Not found", canConfirm: false, help: explainFindFailure("no-devices"), picked, wallet, errors: payload?.errors ?? [] };
  }
  const scannerName = picked.scanner?.name ?? null;
  const printerName = picked.printer?.name ?? null;
  const modelToken = (scannerName && (scannerName.match(/dcp[- ]?[a-z0-9]+|mfc[- ]?[a-z0-9]+|hl[- ]?[a-z0-9]+/i) ?? [])[0]) || "";
  const sameFamily = !!(scannerName && printerName && modelToken && printerName.toLowerCase().includes(modelToken.toLowerCase()));
  let title;
  let kind;
  let canConfirm;
  if (picked.scanner && picked.printer) {
    title = sameFamily || scannerName === printerName ? `Found: ${scannerName}` : `Found: ${scannerName} and ${printerName}`;
    kind = "found";
    canConfirm = true;
  } else if (picked.scanner) {
    title = `Found a scanner: ${scannerName}`;
    kind = "scanner-only";
    canConfirm = true;
  } else {
    title = `Found a printer: ${printerName}`;
    kind = "printer-only";
    canConfirm = false;
  }
  return { kind, title, canConfirm, picked, wallet, errors: payload?.errors ?? [], help: kind === "scanner-only" ? "A scanner is visible, but Windows did not report a usable printer (virtual printers such as Print to PDF are ignored). Check the Brother is added as a printer in Settings > Bluetooth & devices > Printers & scanners." : kind === "printer-only" ? "A printer is visible, but Windows did not report a scanner. For an all-in-one, check it is on and that its scanner was added in Printers & scanners (WIA). You can confirm only when a scanner is found." : null };
}

export function explainFindFailure(reason, { pageOrigin } = {}) {
  const origin = pageOrigin || (typeof location !== "undefined" ? location.origin : "");
  if (reason === "forbidden-origin") {
    const cmd = `node src\\cli.mjs bridge --output-root "%USERPROFILE%\\Documents\\BEINGS-Scans" --allow-origin ${origin || "https://THIS-PAGE"} --allow-origin https://beingsvote.live`;
    return `The helper is running, but it is not allowing this web page to ask it. That is expected on a preview site. On the scanner computer, stop the helper (Ctrl+C) and start it again, adding this page's address with --allow-origin. If you use --allow-origin, also pass https://beingsvote.live if you still want the live site. Example: ${cmd}`;
  }
  if (reason === "no-devices") {
    return "The helper is running, but Windows did not report a scanner or a usable printer. Check the Brother is on, and that it was added in Settings > Bluetooth & devices > Printers & scanners. USB: try another cable or port. Wi-Fi: the machine and this computer should be on the same network.";
  }
  if (reason === "list-failed") {
    return "The helper is running, but it could not list devices (Windows or the listing script did not answer). Check that the helper was started on this computer, then press Find again.";
  }
  if (reason === "timeout") {
    return "Not found. This page waited for the scanner helper on this computer and got no answer in time. Press Connect printer & scanner (Windows PC). If the helper is installed, press Start helper and wait. There is no window to keep open.";
  }
  // not-running, blocked, unexpected — the helper did not answer.
  // The raw node command stays in the collapsed Advanced detail, not in this sentence.
  return "Not found. This page asked the scanner helper on this computer and did not get an answer. Use the Windows PC that has the printer and scanner, not a phone or tablet. Press Connect printer & scanner (Windows PC). If you already installed the helper, press Start helper. There is no window to keep open. The helper also starts when you sign in to Windows. Check the Brother is on and, for Wi-Fi models, that it was added in Printers & scanners. Your browser may also ask whether this page can talk to your computer: choose Allow.";
}

/** True when the helper did not answer, so the collapsed command belongs with the Not found message. */
export function findFailureNeedsInstall(reason) {
  return reason !== "no-devices" && reason !== "list-failed" && reason !== "forbidden-origin";
}

export function classifyBridgeResponse({ error, status, json } = {}) {
  if (error === "timeout") return "timeout";
  if (error) return "not-running";
  if (status === 403) return "forbidden-origin";
  if (status === 404) return "legacy";
  if (status && status >= 500) return "list-failed";
  if (status && status >= 400) return "unexpected";
  if (json && (Array.isArray(json.scanners) || json.ok === true || json.service === "beings-scanner-bridge")) return "ok";
  return "unexpected";
}

async function getJson(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", signal: ctrl.signal, headers: { accept: "application/json" } });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: r.status, json };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "timeout" : "not-running" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask the local helper for the station. Tries 127.0.0.1 then localhost.
 * Prefers GET /v1/station; falls back to /v1/health + /v1/scanners [+ /v1/printers] on older helpers.
 * Never invents a device: if the helper does not answer, the result is a failure reason.
 */
export async function findStation({ fetchImpl = fetch, timeoutMs = FIND_TIMEOUT_MS, bases = BRIDGE_CANDIDATES } = {}) {
  let lastReason = "not-running";
  for (const base of bases) {
    const station = await getJson(fetchImpl, `${base}/v1/station`, timeoutMs);
    let kind = classifyBridgeResponse(station);
    if (kind === "forbidden-origin") return { ok: false, reason: "forbidden-origin", base };
    if (kind === "timeout") {
      lastReason = "timeout";
      continue;
    }
    if (kind === "not-running") {
      lastReason = "not-running";
      continue;
    }
    if (kind === "ok" && station.json) return { ok: true, base, payload: station.json };
    if (kind === "legacy" || (kind !== "ok" && station.status === 404)) {
      const health = await getJson(fetchImpl, `${base}/v1/health`, timeoutMs);
      if (classifyBridgeResponse(health) === "forbidden-origin") return { ok: false, reason: "forbidden-origin", base };
      if (classifyBridgeResponse(health) !== "ok" && health.status !== 200) {
        lastReason = classifyBridgeResponse(health) === "timeout" ? "timeout" : "not-running";
        continue;
      }
      const sc = await getJson(fetchImpl, `${base}/v1/scanners`, timeoutMs);
      const pr = await getJson(fetchImpl, `${base}/v1/printers`, timeoutMs);
      if (classifyBridgeResponse(sc) === "forbidden-origin") return { ok: false, reason: "forbidden-origin", base };
      const scanners = sc.json?.scanners ?? [];
      const printers = pr.json?.printers ?? [];
      const errors = [];
      if (sc.status !== 200) errors.push("could not list scanners");
      if (pr.status !== 200 && pr.status !== 404) errors.push("could not list printers");
      return { ok: true, base, payload: { ok: errors.length === 0, service: "beings-scanner-bridge", scanners, printers, stationWallet: null, errors }, legacy: true };
    }
    if (kind === "list-failed") return { ok: false, reason: "list-failed", base, payload: station.json };
    lastReason = kind;
  }
  return { ok: false, reason: lastReason };
}

export function confirmationFromView(view, { scanner, printer } = {}) {
  if (!view?.canConfirm) return null;
  const s = scanner ?? view.picked.scanner;
  const p = printer ?? view.picked.printer;
  if (!s) return null;
  return {
    at: new Date().toISOString(),
    scannerName: s.name ?? "",
    scannerConnection: s.connection ?? "",
    scannerDeviceId: s.deviceId ?? "",
    printerName: p?.name ?? "",
    printerConnection: p?.connection ?? "",
    stationWallet: view.wallet,
    kind: view.kind,
  };
}

export function readStoredConfirmation(storage) {
  try {
    const raw = storage?.getItem?.(CONFIRM_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.scannerName) return null;
    return v;
  } catch {
    return null;
  }
}

export function writeStoredConfirmation(storage, confirmation) {
  if (!storage) return;
  if (!confirmation) {
    storage.removeItem(CONFIRM_STORAGE_KEY);
    return;
  }
  storage.setItem(CONFIRM_STORAGE_KEY, JSON.stringify(confirmation));
}

function deviceLine(kind, dev) {
  if (!dev) return `${kind}: not reported`;
  const conn = connectionLabel(dev.connection);
  return `${kind}: ${dev.name}${conn ? ` (${conn})` : ""}`;
}

function foundBody(view, { confirmed = false, scanner, printer } = {}) {
  const s = scanner ?? view.picked.scanner;
  const p = printer ?? view.picked.printer;
  const kids = [h("p", { class: "find-device-name" }, confirmed ? `Confirmed: ${s?.name ?? view.title.replace(/^Found: /, "")}` : view.title)];
  kids.push(h("p", { class: "small" }, deviceLine("Scanner", s)));
  kids.push(h("p", { class: "small" }, deviceLine("Printer", p)));
  if (view.picked.hiddenVirtual) kids.push(h("p", { class: "hint" }, `${view.picked.hiddenVirtual} virtual printer${view.picked.hiddenVirtual === 1 ? " was" : "s were"} hidden (for example Print to PDF).`));
  if (view.wallet) kids.push(h("p", { class: "small" }, "Station wallet (public address, from the helper): ", h("code", { class: "code" }, shortAddress(view.wallet.address)), view.wallet.label ? ` · ${view.wallet.label}` : ""));
  else kids.push(h("p", { class: "hint" }, "The helper does not know a station wallet. It never holds a key. You still choose or paste the public signing address when you register the station."));
  if (view.help) kids.push(h("p", { class: "hint" }, view.help));
  if (confirmed) kids.push(h("p", { class: "hint" }, "You can find again if this is the wrong machine or you have moved to another computer."));
  return kids;
}

export const FIND_INTRO = "This page cannot see a printer or scanner by itself. On the computer that has the printer, press Connect printer & scanner (Windows PC). The helper runs in the background. This check is optional: creating or registering is never blocked, because ballots are accounted for by hash. A test print and scan is a helpful next step.";

/**
 * Interactive Find / confirm card. onChange(confirmation | null) fires when the teacher confirms, clears, or finds again.
 * fetchImpl is injectable for tests and previews; the live page uses window.fetch to localhost.
 */
export function scannerFindCard({ onChange, fetchImpl, storage, choiceStorage, pageOrigin } = {}) {
  const out = h("div", { class: "find-station-out", role: "status" });
  const findBtn = h("button", { class: "btn", type: "button" }, icon("search", { size: 16 }), "Find my scanner/printer");
  const confirmBtn = h("button", { class: "btn btn-primary", type: "button", hidden: true }, "Yes, this is my scanner/printer");
  const againBtn = h("button", { class: "btn", type: "button", hidden: true }, "Find again");
  const remembered = () => choiceStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const scanSel = h("select", { class: "find-pick", "aria-label": "Scanner to confirm", hidden: true });
  const printSel = h("select", { class: "find-pick", "aria-label": "Printer to confirm", hidden: true });
  const pickRow = h("div", { class: "find-picks", hidden: true }, h("div", { class: "field" }, h("label", null, "Scanner"), scanSel), h("div", { class: "field" }, h("label", null, "Printer"), printSel));
  const actions = h("div", { class: "actions" }, findBtn, confirmBtn, againBtn);
  let view = null;
  let confirmation = null;

  const emit = (c) => {
    confirmation = c;
    onChange?.(c);
  };

  const selectedDevices = () => {
    if (!view) return {};
    const scanners = view.picked.scanners;
    const printers = view.picked.printers;
    const scanner = !scanSel.hidden && scanSel.value ? scanners.find((s) => (s.deviceId || s.name) === scanSel.value) ?? view.picked.scanner : view.picked.scanner;
    const printer = !printSel.hidden && printSel.value ? printers.find((p) => p.name === printSel.value) ?? view.picked.printer : view.picked.printer;
    return { scanner, printer };
  };

  const showIdle = (msg) => {
    view = null;
    confirmBtn.hidden = true;
    againBtn.hidden = true;
    pickRow.hidden = true;
    findBtn.hidden = false;
    findBtn.disabled = false;
    fill(out, msg ? callout("info", "Not started", msg) : null);
  };

  const showFailure = (reason) => {
    view = null;
    confirmBtn.hidden = true;
    againBtn.hidden = false;
    pickRow.hidden = true;
    findBtn.hidden = false;
    findBtn.disabled = false;
    fill(
      out,
      callout("warn", "Not found", explainFindFailure(reason, { pageOrigin })),
      findFailureNeedsInstall(reason) ? helperCommandDetails() : null,
    );
    emit(null);
  };

  const remember = (scanner) => {
    if (scanner?.deviceId) writeScannerChoice(remembered(), { deviceId: scanner.deviceId, name: scanner.name ?? "" });
  };
  const fillPicks = (v) => {
    const saved = readScannerChoice(remembered());
    const savedOk = saved && v.picked.scanners.some((s) => s.deviceId === saved.deviceId);
    scanSel.replaceChildren(...v.picked.scanners.map((s) => {
      const selected = savedOk ? s.deviceId === saved.deviceId : s === v.picked.scanner;
      const who = s.manufacturer ? `${s.manufacturer}, ` : "";
      return h("option", { value: s.deviceId || s.name, selected: selected ? true : null }, `${s.name} (${who}${connectionLabel(s.connection)})`);
    }));
    printSel.replaceChildren(...v.picked.printers.map((p) => h("option", { value: p.name, selected: p === v.picked.printer ? true : null }, `${p.name} (${connectionLabel(p.connection)})`)));
    const chosenId = savedOk ? saved.deviceId : (v.picked.scanner?.deviceId || "");
    if (chosenId) scanSel.value = chosenId;
    scanSel.hidden = !v.picked.scannerNeedsChoice;
    printSel.hidden = !v.picked.printerNeedsChoice;
    pickRow.hidden = scanSel.hidden && printSel.hidden;
    remember(selectedDevices().scanner || v.picked.scanner);
  };

  const showFound = (v) => {
    view = v;
    findBtn.hidden = true;
    againBtn.hidden = false;
    confirmBtn.hidden = !v.canConfirm;
    confirmBtn.disabled = !v.canConfirm;
    fillPicks(v);
    const tone = v.kind === "found" ? "ok" : v.canConfirm ? "info" : "warn";
    const heading = v.kind === "found" ? "Found" : v.canConfirm ? "Found, with a warning" : "Not a complete station";
    const choiceHint = !v.picked.scannerNeedsChoice ? null : h("p", { class: "hint" }, v.picked.sameModel ? "Windows listed more than one entry for the same scanner. The selected one is the maker's own driver when that is available. The test scan uses this choice." : "Windows listed different scanners. Choose the one on this desk. The test scan uses this choice.");
    fill(out, callout(tone, heading, "", v.kind === "found" ? "check" : "alert"), h("div", { class: "find-found" }, ...foundBody(v, selectedDevices())), choiceHint);
  };

  const showConfirmed = (v, conf) => {
    view = v;
    findBtn.hidden = true;
    confirmBtn.hidden = true;
    againBtn.hidden = false;
    pickRow.hidden = true;
    fill(out, callout("ok", "Confirmed", "", "check"), h("div", { class: "find-found" }, ...foundBody(v, { confirmed: true, scanner: { name: conf.scannerName, connection: conf.scannerConnection }, printer: conf.printerName ? { name: conf.printerName, connection: conf.printerConnection } : null })));
  };

  const refreshFoundBody = () => {
    if (!view || confirmation) return;
    const body = out.querySelector(".find-found");
    if (body) fill(body, ...foundBody(view, selectedDevices()));
  };
  scanSel.addEventListener("change", () => {
    refreshFoundBody();
    remember(selectedDevices().scanner);
  });
  printSel.addEventListener("change", refreshFoundBody);

  findBtn.addEventListener("click", async () => {
    findBtn.disabled = true;
    confirmBtn.hidden = true;
    pickRow.hidden = true;
    fill(out, h("p", { class: "muted" }, "Asking the scanner helper on this computer…"));
    const result = await findStation({ fetchImpl: fetchImpl ?? (typeof fetch === "function" ? fetch : undefined) });
    if (!result.ok) return showFailure(result.reason);
    const v = describeStation(result.payload);
    if (!v.canConfirm && (v.kind === "no-devices" || v.kind === "list-failed" || v.kind === "printer-only")) {
      if (v.kind === "printer-only") {
        showFound(v);
        emit(null);
        return;
      }
      showFailure(v.kind);
      return;
    }
    showFound(v);
    emit(null);
  });

  confirmBtn.addEventListener("click", () => {
    if (!view?.canConfirm) return;
    const conf = confirmationFromView(view, selectedDevices());
    if (!conf) return;
    writeStoredConfirmation(storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null), conf);
    showConfirmed(view, conf);
    emit(conf);
  });

  againBtn.addEventListener("click", () => {
    writeStoredConfirmation(storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null), null);
    emit(null);
    findBtn.disabled = false;
    findBtn.hidden = false;
    confirmBtn.hidden = true;
    againBtn.hidden = true;
    pickRow.hidden = true;
    fill(out);
    findBtn.click();
  });

  const stored = readStoredConfirmation(storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null));
  if (stored) {
    const fakeView = {
      kind: stored.kind || "found",
      title: `Found: ${stored.scannerName}`,
      canConfirm: true,
      picked: { scanner: { name: stored.scannerName, connection: stored.scannerConnection }, printer: stored.printerName ? { name: stored.printerName, connection: stored.printerConnection } : null, scanners: [], printers: [], hiddenVirtual: 0, scannerNeedsChoice: false, printerNeedsChoice: false },
      wallet: stored.stationWallet ?? null,
      help: null,
    };
    showConfirmed(fakeView, stored);
    confirmation = stored;
    // Defer so the caller can attach onChange after the element is built.
    queueMicrotask(() => emit(stored));
  }

  const root = h(
    "div",
    { class: "find-station auto-block", "data-find-station": "1" },
    h("p", { class: "muted small" }, FIND_INTRO),
    pickRow,
    actions,
    out,
  );
  return { root, getConfirmation: () => confirmation, findButton: findBtn, confirmButton: confirmBtn };
}
