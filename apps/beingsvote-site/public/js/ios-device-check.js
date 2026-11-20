// Device-side checks for an iPad or iPhone on the election admin page.
// Nothing here starts a scan, uploads a picture, or sends a transaction.
// The test sheet is a one-page TEST page with no election and no ballot code.
import { h, fill, callout } from "./ui.js";
import { shortAddress } from "./format.js";
import { COSTON2, chainIdNumber } from "./logic.js";
import { isVirtualPrinter } from "./scanner-station.js";

export const IOS_DEVICE_BUTTON = "Test this iPad / iPhone";
export const IOS_STATION_BUTTON = "Test scanner from this iPad / iPhone";
export const STATION_MEMORY_KEY = "beings.iosStation.v1";
export const STATION_STATUS_PATH = "/v1/station";

export const IOS_SCANNER_NOTE =
  "This iPad or iPhone does not run the scanner helper, and the camera is not used for scanning. Scanning runs on the Windows PC or the local server next to the sheet-fed scanner.";

/** iPhone, iPad, iPod, and iPadOS that reports itself as a Mac but has a touch screen. */
export function isAppleTouchDevice(nav) {
  if (!nav) return false;
  const ua = String(nav.userAgent ?? "");
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  const points = Number(nav.maxTouchPoints ?? 0);
  return /Mac/i.test(String(nav.platform ?? "")) && points > 1;
}

export function isPrivateIPv4(name) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(name ?? ""));
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return false;
  const [a, b] = n;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLocalStationHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (isPrivateIPv4(host)) return true;
  if (!host.endsWith(".local")) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local$/.test(host);
}

/** Turn a typed local address into the read-only station URL. Never keeps a path the person typed. */
export function parseStationAddress(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Enter the scanner station's address, such as 192.168.1.20." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That address is not valid." };
  }
  if (url.username || url.password) return { ok: false, error: "Leave out any user name or password." };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Use an http or https address on the local network." };
  if (!isLocalStationHost(url.hostname)) return { ok: false, error: "Use a local address: a private network number such as 192.168.1.20, or a name ending in .local. This check does not call the public internet." };
  const port = url.port || "8765";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: "That port is not valid." };
  const host = url.hostname.includes(":") && !url.hostname.startsWith("[") ? `[${url.hostname}]` : url.hostname;
  const origin = `${url.protocol}//${host}:${port}`;
  return { ok: true, origin, statusUrl: `${origin}${STATION_STATUS_PATH}`, protocol: url.protocol, hostname: url.hostname };
}

export function readStationMemory(storage) {
  try {
    const raw = storage?.getItem?.(STATION_MEMORY_KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x)).filter(Boolean).slice(0, 5);
  } catch {
    return [];
  }
}

export function rememberStation(storage, origin) {
  if (!storage || !origin) return;
  const next = [origin, ...readStationMemory(storage).filter((x) => x !== origin)].slice(0, 5);
  storage.setItem(STATION_MEMORY_KEY, JSON.stringify(next));
}

function asWei(v) {
  if (v == null || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Wallet facts for the checklist. The detail uses a shortened address, never the full one. */
export function assessWallet({ hasInjected = false, address = null, chainId = null, balanceWei = null } = {}) {
  if (!hasInjected && !address) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: "No wallet is available in this browser. Open this page in the wallet app's browser, or connect a wallet, then run the check again. This check does not ask the wallet to sign or send anything." }];
  }
  if (!address) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: "A wallet is installed, but it is not connected. Connect it, then run the check again. This check does not ask the wallet to sign or send anything." }];
  }
  const who = shortAddress(address);
  const chain = chainIdNumber(chainId);
  if (chain == null) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: `Wallet ${who} is connected, but its network could not be read. Switch it to Flare Coston2 (chain ${COSTON2.id}) and try again.` }];
  }
  if (chain !== COSTON2.id) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: `Wallet ${who} is not on Flare Coston2 (chain ${COSTON2.id}). Switch to Coston2, then run the check again.` }];
  }
  const wei = asWei(balanceWei);
  if (wei == null) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: `Wallet ${who} is on Flare Coston2, but the C2FLR balance could not be read.` }];
  }
  if (wei <= 0n) {
    return [{ id: "wallet", level: "warn", title: "Wallet", detail: `Wallet ${who} is on Flare Coston2 but has no C2FLR. Get free test coin from the Coston2 faucet before you create an election.` }];
  }
  return [{ id: "wallet", level: "ok", title: "Wallet", detail: `Wallet ${who} is on Flare Coston2 and has C2FLR.` }];
}

function storageWorks(storage) {
  if (!storage) return false;
  const key = "beings.ios-feature-check";
  try {
    storage.setItem(key, "1");
    const ok = storage.getItem(key) === "1";
    storage.removeItem(key);
    return ok;
  } catch {
    return false;
  }
}

/** Features the admin pages need. Each row is pass or fail. */
export function assessBrowser(env = {}) {
  const subtle = typeof env.crypto?.subtle?.digest === "function";
  const net = typeof env.fetch === "function";
  const store = storageWorks(env.localStorage);
  const blob = typeof env.Blob === "function" && typeof env.URL?.createObjectURL === "function";
  return [
    { id: "crypto", level: subtle ? "ok" : "fail", title: "Cryptography", detail: subtle ? "This browser can hash and check fingerprints (crypto.subtle)." : "This browser is missing crypto.subtle, which the admin pages need." },
    { id: "fetch", level: net ? "ok" : "fail", title: "Network", detail: net ? "This browser can call the ledger and a station (fetch)." : "This browser cannot make network requests (fetch), which the admin pages need." },
    { id: "storage", level: store ? "ok" : "fail", title: "Saved on this device", detail: store ? "This browser can remember choices on this device (localStorage)." : "This browser is blocking saved data (localStorage). Private mode sometimes does that. The admin pages need it for the roster and station choices." },
    { id: "download", level: blob ? "ok" : "fail", title: "Saving a file", detail: blob ? "This browser can build a file to print or download (Blob)." : "This browser cannot build a file to print or download (Blob)." },
  ];
}

/** One page, marked TEST, with no election and no ballot code. */
export function buildAirPrintTestPdf() {
  const lines = [
    "B.E.I.N.G.S.",
    "TEST PAGE",
    "NOT A REAL BALLOT",
    "AirPrint check from an iPad or iPhone.",
    "No election. No ballot code. No voter data.",
    "Do not count this sheet.",
  ];
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let y = 700;
  const cmds = ["BT", "/F1 22 Tf"];
  for (const line of lines) {
    cmds.push(`1 0 0 1 72 ${y} Tm (${esc(line)}) Tj`);
    y -= 36;
  }
  cmds.push("ET");
  const stream = cmds.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/** Open the TEST sheet for AirPrint. print() opens the system dialog; the PDF is the share-sheet path. */
export function openAirPrintTest({ doc, print, open } = {}) {
  const documentRef = doc ?? (typeof document !== "undefined" ? document : null);
  const doPrint = print ?? (typeof window !== "undefined" && typeof window.print === "function" ? () => window.print() : null);
  const doOpen = open ?? (typeof window !== "undefined" && typeof window.open === "function" ? window.open.bind(window) : null);
  if (documentRef?.body) {
    const sheet = documentRef.createElement("section");
    sheet.className = "ios-airprint-sheet";
    sheet.setAttribute("data-ios-airprint", "1");
    for (const [tag, text] of [
      ["p", "B.E.I.N.G.S."],
      ["h1", "TEST PAGE"],
      ["p", "NOT A REAL BALLOT"],
      ["p", "This sheet checks AirPrint from an iPad or iPhone."],
      ["p", "No election. No ballot code. No voter data."],
      ["p", "Do not count this sheet."],
    ]) {
      const el = documentRef.createElement(tag);
      el.textContent = text;
      sheet.append(el);
    }
    documentRef.body.append(sheet);
    const remove = () => sheet.remove();
    documentRef.defaultView?.addEventListener?.("afterprint", remove, { once: true });
    setTimeout(remove, 60_000);
  }
  let printed = false;
  try {
    if (doPrint) {
      doPrint();
      printed = true;
    }
  } catch {
    printed = false;
  }
  let opened = false;
  try {
    if (doOpen && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(new Blob([buildAirPrintTestPdf()], { type: "application/pdf" }));
      opened = !!doOpen(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch {
    opened = false;
  }
  return { printed, opened };
}

export function assessPrint(result) {
  if (result?.printed || result?.opened) {
    return { id: "print", level: "ok", title: "Test print", detail: "A one-page TEST sheet was opened. It is marked TEST and has no election data. Use the share or print dialog and choose AirPrint. Nothing was scanned or uploaded." };
  }
  return { id: "print", level: "warn", title: "Test print", detail: "The TEST sheet could not be opened. Allow pop-ups for this site, then try again. Nothing was sent to a printer by itself." };
}

const CAMERA = /camera|webcam|facetime|iphone|ipad/i;

export function assessStationPayload(json) {
  const version = typeof json?.version === "string" ? json.version : "";
  const scanners = Array.isArray(json?.scanners) ? json.scanners : [];
  const printers = Array.isArray(json?.printers) ? json.printers : [];
  const sheet = scanners.filter((s) => s && s.name && !CAMERA.test(`${s.name} ${s.manufacturer ?? ""}`));
  const realPrinters = printers.filter((p) => p && p.name && !isVirtualPrinter(p));
  const names = (list) => list.map((x) => x.name).join(", ");
  return [
    { id: "reach", level: "ok", title: "Station reachable", detail: "The scanner station answered its read-only status. Nothing was scanned or uploaded." },
    { id: "version", level: version ? "ok" : "warn", title: "Helper version", detail: version ? `Helper version ${version}.` : "The station answered, but it did not report a helper version." },
    {
      id: "scanner",
      level: sheet.length ? "ok" : "warn",
      title: "Sheet-fed scanner",
      detail: sheet.length ? `A sheet-fed scanner was reported: ${names(sheet)}.` : "No sheet-fed scanner was reported. This check does not use the iPad camera. Scanning stays on the station next to the scanner.",
    },
    { id: "printer", level: realPrinters.length ? "ok" : "warn", title: "Printer", detail: realPrinters.length ? `A printer was reported: ${names(realPrinters)}.` : "No printer was reported by the station." },
  ];
}

export function explainStationFailure(reason, { status, loopback = false } = {}) {
  if (reason === "mixed-content") return "This page is secure (HTTPS). An iPad or iPhone will not call a scanner station that only speaks plain HTTP, even on the same Wi-Fi. The station needs secure local access set up (HTTPS on the scanner computer, or a local server this page is allowed to call). Nothing was scanned or uploaded.";
  if (reason === "timeout") return "The station did not answer in time. Check that the helper is running on the scanner computer and that this iPad is on the same network. Nothing was scanned or uploaded.";
  if (status === 403) return "The helper refused this page. Its read-only status allows https://beingsvote.live. Start the helper with this page's address if you are on a different site. Nothing was scanned or uploaded.";
  if (status === 404) return "This helper does not offer the read-only station status yet. Update the helper on the scanner computer. Nothing was scanned or uploaded.";
  if (status === 421) return "The helper does not answer that host name on its read-only status. Use the station's private network address or a .local name. Nothing was scanned or uploaded.";
  if (reason === "blocked" && loopback) return "Nothing answered on this iPad at that address. The helper runs on the Windows PC or local server next to the scanner, not on the iPad. Enter that computer's address. If this page is HTTPS, the station needs secure local access. Nothing was scanned or uploaded.";
  if (reason === "blocked") return "The browser blocked the call. A secure page on an iPad cannot reach another computer on the local network until that station has secure local access set up, and this site is only allowed to call the helper on localhost by itself. Nothing was scanned or uploaded.";
  return "The iPad could not read the station. Check the address and that the helper is running. If this page is HTTPS, the station needs secure local access. Nothing was scanned or uploaded.";
}

function failureChecks(detail) {
  return [
    { id: "reach", level: "warn", title: "Station reachable", detail },
    { id: "version", level: "warn", title: "Helper version", detail: "Not checked, because the station did not answer." },
    { id: "scanner", level: "info", title: "Sheet-fed scanner", detail: IOS_SCANNER_NOTE },
    { id: "printer", level: "warn", title: "Printer", detail: "Not checked, because the station did not answer." },
  ];
}

/**
 * GET the station status only. fetchImpl is injectable. pageProtocol is this page's protocol ("https:" or "http:").
 */
export async function probeStation({ raw, fetchImpl, pageProtocol = "https:", storage, timeoutMs = 8000 } = {}) {
  const parsed = parseStationAddress(raw);
  if (!parsed.ok) return { checks: failureChecks(parsed.error), requested: null };
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (pageProtocol === "https:" && parsed.protocol === "http:") {
    return { checks: failureChecks(explainStationFailure("mixed-content")), requested: null };
  }
  const fetchFn = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchFn) return { checks: failureChecks(explainStationFailure("blocked", { loopback })), requested: parsed.statusUrl };
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(parsed.statusUrl, { method: "GET", signal: ctrl?.signal, headers: { accept: "application/json" } });
    if (timer) clearTimeout(timer);
    if (!response?.ok) {
      return { checks: failureChecks(explainStationFailure("http", { status: response?.status, loopback })), requested: parsed.statusUrl };
    }
    let json = null;
    try {
      json = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object") return { checks: failureChecks("The station answered, but not with a status report. Nothing was scanned or uploaded."), requested: parsed.statusUrl };
    try {
      if (storage) rememberStation(storage, parsed.origin);
    } catch {
      /* Remembering the address is optional. A full disk must not hide a status that arrived. */
    }
    return { checks: assessStationPayload(json), requested: parsed.statusUrl };
  } catch (e) {
    if (timer) clearTimeout(timer);
    const reason = e?.name === "AbortError" ? "timeout" : "blocked";
    return { checks: failureChecks(explainStationFailure(reason, { loopback })), requested: parsed.statusUrl };
  }
}

export async function collectWalletFacts({ ethereum, address = null, chainId = null } = {}) {
  const req = ethereum && typeof ethereum.request === "function" ? ethereum.request.bind(ethereum) : null;
  let addr = address;
  let chain = chainIdNumber(chainId);
  if (req) {
    try {
      if (!addr) {
        const accounts = await req({ method: "eth_accounts" });
        addr = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null;
      }
    } catch {
      /* the wallet did not share an account; leave it unconnected */
    }
    try {
      if (chain == null) chain = chainIdNumber(await req({ method: "eth_chainId" }));
    } catch {
      chain = chain ?? null;
    }
  }
  let balanceWei = null;
  if (addr && req && chain === COSTON2.id) {
    try {
      balanceWei = BigInt(await req({ method: "eth_getBalance", params: [addr, "latest"] }));
    } catch {
      balanceWei = null;
    }
  }
  return { hasInjected: !!ethereum || !!address, address: addr, chainId: chain, balanceWei };
}

export async function runDeviceChecks({ env, wallet, print } = {}) {
  const browser = assessBrowser(env ?? (typeof globalThis !== "undefined" ? globalThis : {}));
  const facts = wallet ?? { hasInjected: false, address: null, chainId: null, balanceWei: null };
  const printed = print ? await print() : openAirPrintTest();
  return [
    assessPrint(printed),
    ...assessWallet(facts),
    ...browser,
    { id: "scanner", level: "info", title: "Scanner", detail: IOS_SCANNER_NOTE },
  ];
}

const MARK = { ok: "Pass", warn: "Warning", fail: "Fail", info: "Note" };

export function checklistView(items) {
  return h(
    "ul",
    { class: "ios-check-list", "data-ios-checklist": "1" },
    ...(items ?? []).map((c) => {
      const tone = c.level === "ok" ? "ok" : c.level === "fail" ? "bad" : c.level === "info" ? "info" : "warn";
      return h("li", { class: `ios-check ios-check-${c.level}`, "data-check": c.id }, callout(tone, `${MARK[c.level] ?? "Warning"}: ${c.title}`, c.detail));
    }),
  );
}

/** Address box and read-only probe. Shown on iOS in Test print and scan. */
export function iosStationPanel({ storage, fetchImpl, pageProtocol } = {}) {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const input = h("input", {
    id: "ios-station-address",
    name: "ios-station-address",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "192.168.1.20 or printer.local",
    "aria-describedby": "ios-station-hint",
  });
  const remembered = readStationMemory(store);
  const pick = remembered.length
    ? h(
        "select",
        { id: "ios-station-remembered", "aria-label": "Remembered scanner stations" },
        h("option", { value: "" }, "Remembered stations"),
        ...remembered.map((a) => h("option", { value: a }, a)),
      )
    : null;
  pick?.addEventListener("change", () => {
    if (pick.value) input.value = pick.value.replace(/^https?:\/\//, "");
  });
  const btn = h("button", { class: "btn", type: "button", "data-ios-station-check": "1" }, IOS_STATION_BUTTON);
  const out = h("div", { class: "ios-station-out", role: "status" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    fill(out, h("p", { class: "muted" }, "Reading the station status…"));
    const protocol = pageProtocol ?? (typeof location !== "undefined" ? location.protocol : "https:");
    const result = await probeStation({ raw: input.value, fetchImpl, pageProtocol: protocol, storage: store });
    fill(out, checklistView(result.checks));
    btn.disabled = false;
  });
  const root = h(
    "div",
    { class: "ios-station-test", "data-ios-station-test": "1" },
    h("p", { id: "ios-station-hint", class: "hint" }, "Enter the local address of the Windows PC or local server next to the sheet-fed scanner. This only reads status. It does not scan or upload, and it does not use the camera."),
    pick,
    h("div", { class: "field" }, h("label", { for: "ios-station-address" }, "Scanner station address"), input),
    h("div", { class: "actions" }, btn),
    out,
  );
  return { root, button: btn, input, output: out };
}
