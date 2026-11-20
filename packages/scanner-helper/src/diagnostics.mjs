// Fixed PC checks for the Create / Register "Run system check" button.
// Nothing here uploads, signs, or calls an AI service. The only writes are the
// three fixes the teacher clicks: supersede a leftover synthetic-test batch,
// and (on Windows) a Startup shortcut for this helper. Remembering the scanner
// is done in the browser, not here.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { BATCH_ID_RE } from "./batch.mjs";
import { supersedeBatch } from "./fsbatch.mjs";
import { isMicrosoftDriver, pickScanner } from "./pick-scanner.mjs";
import { resolveUploadUrl } from "./upload.mjs";

export const HELPER_VERSION_FALLBACK = "0.1.0";
export const SYNTHETIC_SHORT = "TEST00";
export const SYNTHETIC_TEST_DIR = "_synthetic-test-print-scan";
export const FIX_SUPERSEDE = "supersede-synthetic-test";
export const FIX_SIGNIN = "signin-start";
export const FIX_REMEMBER = "remember-scanner";
const SUPERSEDE_REASON = "synthetic test batch left unfinished; superseded from the system check";

const VIRTUAL_PRINTER = /one[\s-]?note|microsoft print to pdf|microsoft xps|\bfax\b|send to onenote|adobe pdf|pdf24|bullzip|dopdf|cutepdf|print to pdf|redirected\b/i;

export function isVirtualPrinterName(name) {
  return VIRTUAL_PRINTER.test(String(name ?? ""));
}

export function printerHost(port) {
  const p = String(port ?? "").trim();
  if (!p || /^(USB|PORTPROMPT|NUL:|FILE:|SHRFAX:|BRW)/i.test(p)) return null;
  const ip = p.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (ip) return ip[1];
  const labeled = p.match(/^IP_(.+)$/i);
  if (labeled && labeled[1] && !/^WSD/i.test(labeled[1])) return labeled[1];
  return null;
}

/** usb, brw (Brother direct), ip, wsd, or other. A BRW port has no IP in its name. */
export function printerPortKind(port) {
  const p = String(port ?? "");
  if (/^USB/i.test(p)) return "usb";
  if (/^BRW/i.test(p) || /\bBRW[0-9A-F]{4,}/i.test(p)) return "brw";
  if (/^WSD/i.test(p) || /\bWSD\b/i.test(p)) return "wsd";
  if (/^IP_/i.test(p) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(p)) return "ip";
  return "other";
}

export function printerOnline(status) {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s || s === "unknown" || s === "0" || s === "other") return "unknown";
  if (/offline|error|door|jam|no paper|not available|unavailable/.test(s)) return "offline";
  if (/normal|idle|ready|printing|online|warm/.test(s)) return "online";
  return "unknown";
}

/** Lower is better. A Brother BRW direct port beats a WSD queue for the same machine. */
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

export function choosePrinter(printers) {
  const list = (Array.isArray(printers) ? printers : []).filter((p) => p && p.name && !isVirtualPrinterName(p.name));
  const brother = list.filter((p) => /brother/i.test(String(p.name ?? "")) || /brother/i.test(String(p.driver ?? "")));
  const pool = brother.length ? brother : list;
  const ranked = [...pool].sort((a, b) => {
    const byPort = printerPortRank(a) - printerPortRank(b);
    if (byPort) return byPort;
    const ad = a.default === true || a.isDefault === true ? 0 : 1;
    const bd = b.default === true || b.isDefault === true ? 0 : 1;
    return ad - bd;
  });
  return ranked[0] || null;
}

/** Every real queue, best first. The test print tries the next one when the spooler reports an error. */
export function printerAttemptOrder(printers) {
  const list = (Array.isArray(printers) ? printers : []).filter((p) => p && p.name && !isVirtualPrinterName(p.name));
  return [...list].sort((a, b) => {
    const byPort = printerPortRank(a) - printerPortRank(b);
    if (byPort) return byPort;
    const ad = a.default === true || a.isDefault === true ? 0 : 1;
    const bd = b.default === true || b.isDefault === true ? 0 : 1;
    return ad - bd;
  });
}

/**
 * What a Win32 print job means. `gone: true` means the job left the queue (usually printed).
 * Error bits: 2 error, 32 offline, 64 paper out, 512 blocked, 1024 user intervention.
 * Success bits: 128 printed, 256 deleted, 4096 complete.
 */
export function interpretSpoolerStatus(job) {
  if (!job || typeof job !== "object") return { state: "unknown", ok: false, pending: false, detail: "Windows did not report the print job." };
  const bits = Number(job.jobStatus ?? job.JobStatus);
  const text = String(job.status ?? job.Status ?? "").trim();
  const names = [];
  if (Number.isFinite(bits) && bits > 0) {
    if (bits & 2) names.push("error");
    if (bits & 32) names.push("offline");
    if (bits & 64) names.push("out of paper");
    if (bits & 512) names.push("blocked");
    if (bits & 1024) names.push("needs someone at the printer");
    if (bits & 128) names.push("printed");
    if (bits & 4096) names.push("complete");
    if (bits & 16) names.push("printing");
    if (bits & 8) names.push("spooling");
  }
  const blob = `${text} ${names.join(" ")}`.toLowerCase();
  const errorBits = Number.isFinite(bits) && ((bits & 2) || (bits & 32) || (bits & 64) || (bits & 512) || (bits & 1024));
  const doneBits = Number.isFinite(bits) && ((bits & 128) || (bits & 256) || (bits & 4096));
  if (errorBits || (/error|offline|paper|blocked|intervention|failed/.test(blob) && !doneBits)) {
    return { state: "error", ok: false, pending: false, detail: text || names.filter((n) => n !== "printed" && n !== "complete").join(", ") || "The Windows print queue reported an error." };
  }
  if (job.gone === true || doneBits || /printed|complete|left the queue/.test(blob)) {
    return { state: "printed", ok: true, pending: false, detail: text || "The job left the Windows print queue." };
  }
  if (/printing|spool/.test(blob) || (Number.isFinite(bits) && ((bits & 16) || (bits & 8)))) {
    return { state: "pending", ok: false, pending: true, detail: text || "The job is still in the Windows print queue." };
  }
  return { state: "unknown", ok: false, pending: true, detail: text || "Windows did not say whether the page came out." };
}

/** Try another queue only when this one was refused or the spooler reported an error. A job still printing is left alone. */
export function shouldTryAnotherPrinter(outcome) {
  if (!outcome) return false;
  if (outcome.spool?.state === "printed" || outcome.spool?.state === "pending") return false;
  const detail = String(outcome.detail || outcome.json?.error || outcome.json?.message || "").toLowerCase();
  if (/could not count|no such file|page\(s\) but|not printing|pdf is missing|did not render/.test(detail)) return false;
  if (outcome.spool?.state === "error") return true;
  return /no printer named|does not have a printer|nothing was printed|did not finish|spool/.test(detail);
}

export function sumatraCandidates(env = {}) {
  const local = env.LOCALAPPDATA || env.HOME || "";
  const pf = env.ProgramFiles || "";
  const pf86 = env["ProgramFiles(x86)"] || "";
  return [local && join(local, "SumatraPDF", "SumatraPDF.exe"), pf && join(pf, "SumatraPDF", "SumatraPDF.exe"), pf86 && join(pf86, "SumatraPDF", "SumatraPDF.exe")].filter(Boolean);
}

export function findSumatra(env = {}, exists = existsSync) {
  for (const p of sumatraCandidates(env)) if (exists(p)) return p;
  return null;
}

/** Batch folders for the synthetic test only. Real election folders are never walked. */
export function unresolvedSyntheticBatches(outputRoot, exists = existsSync, readDir = readdirSync, isDir = (p) => existsSync(p) && statSync(p).isDirectory()) {
  if (!outputRoot) return [];
  const found = [];
  for (const folder of [join(outputRoot, SYNTHETIC_SHORT), join(outputRoot, SYNTHETIC_TEST_DIR)]) {
    if (!exists(folder)) continue;
    let names = [];
    try { names = readDir(folder); } catch { continue; }
    for (const name of names) {
      if (!BATCH_ID_RE.test(name)) continue;
      const dir = join(folder, name);
      if (!isDir(dir)) continue;
      if (exists(join(dir, "DONE.txt")) || exists(join(dir, "SUPERSEDED.txt"))) continue;
      found.push({ batchId: name, dir });
    }
  }
  return found;
}

export function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(ok);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

export async function hostReachable(host, probe = probeTcp) {
  if (!host) return null;
  for (const port of [9100, 80, 443]) {
    if (await probe(host, port)) return true;
  }
  return false;
}

function check(id, level, title, detail, extra = {}) {
  return { id, level, title, detail, fix: extra.fix ?? null, whatToDo: extra.whatToDo ?? null, ...extra.fields };
}

/**
 * Turn already-collected facts into the report the page shows.
 * Probes (network, disk, store) are passed in so tests do not touch the machine.
 */
export function buildDiagnosticsReport({
  version = HELPER_VERSION_FALLBACK,
  nodeVersion = process.versions.node,
  pdfLib = null,
  sumatraPath = null,
  printers = [],
  scanners = [],
  printerReachable = null,
  outputWritable = true,
  store = null,
  unresolved = [],
  signInStart = false,
} = {}) {
  const checks = [];
  checks.push(check("helper", "ok", "Helper", `The scanner helper is running (version ${version}).`));

  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  checks.push(nodeMajor >= 20
    ? check("node", "ok", "Node.js", `Node.js ${nodeVersion} is running this helper.`)
    : check("node", "fail", "Node.js", `Node.js ${nodeVersion || "unknown"} is too old.`, { whatToDo: "Run Install-BEINGS-Helper.cmd again. It downloads Node.js 20 or newer for this Windows user. An administrator password is not required." }));

  checks.push(pdfLib?.present
    ? check("pdf-lib", "ok", "pdf-lib", `pdf-lib ${pdfLib.version || ""} is installed with the helper.`.replace("  ", " "))
    : check("pdf-lib", "fail", "pdf-lib", "The helper cannot find pdf-lib, so it cannot open a ballot PDF.", { whatToDo: "Download the helper again from this page and run Install-BEINGS-Helper.cmd. Do not copy the folder out of the zip without its node_modules directory." }));

  const method = "Windows built-in";
  const printing = sumatraPath
    ? `Windows built-in printing will be used. Windows draws each page and sends it straight to the chosen printer, single-sided, at actual size, with no app window. SumatraPDF is already on this PC (${sumatraPath}) and is used only if that built-in print fails.`
    : "Windows built-in printing will be used. Windows draws each page and sends it straight to the chosen printer, single-sided, at actual size, with no app window. SumatraPDF is not installed, and that is fine.";
  checks.push(check("sumatra", "ok", "Printing", printing, { fields: { method, path: sumatraPath || null } }));

  const realPrinters = Array.isArray(printers) ? printers.filter((p) => p && p.name) : null;
  const chosen = realPrinters ? choosePrinter(realPrinters) : null;
  if (!realPrinters) {
    checks.push(check("printers", "fail", "Printers", "The helper could not ask Windows for the printer list.", { whatToDo: "Run this check on the Windows PC, with the helper running." }));
  } else if (!realPrinters.length) {
    checks.push(check("printers", "fail", "Printers", "Windows did not report a printer.", { whatToDo: "Turn the Brother on. In Settings > Bluetooth & devices > Printers & scanners, add it. USB: try another cable. Wi-Fi: the printer and this PC should be on the same network." }));
  } else {
    const lines = realPrinters.map((p) => {
      const online = printerOnline(p.status);
      const flags = [online === "unknown" ? "status unknown" : online, p.default || p.isDefault ? "default" : null, isVirtualPrinterName(p.name) ? "not a classroom printer" : null].filter(Boolean).join(", ");
      return `${p.name} (${flags})`;
    });
    const chosenOnline = chosen ? printerOnline(chosen.status) : "unknown";
    const level = !chosen ? "warn" : chosenOnline === "offline" ? "warn" : "ok";
    const detail = chosen
      ? `Printers: ${lines.join("; ")}. The check will use "${chosen.name}".`
      : `Printers: ${lines.join("; ")}. None of these look like the classroom printer.`;
    const options = realPrinters.filter((p) => !isVirtualPrinterName(p.name)).map((p) => ({ name: p.name, port: p.port ?? "" }));
    checks.push(check("printers", level, "Printers", detail, {
      whatToDo: chosenOnline === "offline" ? "The chosen printer looks offline. Turn it on and check the paper. If it is on Wi-Fi, this PC and the printer need the same network." : !chosen ? "Add the Brother in Printers & scanners. Microsoft Print to PDF is not the classroom printer." : null,
      fields: { chosen: chosen ? { name: chosen.name, port: chosen.port ?? null, status: chosen.status ?? null, online: chosenOnline } : null, options },
    }));
  }

  const scanList = Array.isArray(scanners) ? scanners : null;
  const picked = scanList ? pickScanner(scanList) : { ok: false };
  if (!scanList) {
    checks.push(check("scanners", "fail", "Scanners", "The helper could not ask Windows for the scanner list.", { whatToDo: "Run this check on the Windows PC, with the helper running." }));
  } else if (!scanList.length) {
    checks.push(check("scanners", "fail", "Scanners", "Windows did not report a scanner.", { whatToDo: "Turn the Brother on. For an all-in-one, add its scanner in Printers & scanners (WIA). USB: try another cable or port. Wi-Fi: same network as this PC." }));
  } else if (!picked.ok) {
    checks.push(check("scanners", "fail", "Scanners", picked.error, { whatToDo: "These are different machines, so the helper will not guess. In Find my scanner/printer, choose the one on this desk." }));
  } else if (scanList.length > 1 && picked.sameModel) {
    checks.push(check("scanners", "warn", "Scanners", `Windows listed ${scanList.length} entries for the same model. The helper will use "${picked.device.name}"${isMicrosoftDriver(picked.device) ? "" : " (the maker's own driver, not the Microsoft one)"}.`, {
      fix: FIX_REMEMBER,
      whatToDo: null,
      fields: { autoPick: { deviceId: picked.device.deviceId ?? null, name: picked.device.name ?? "" }, sameModel: true },
    }));
  } else {
    checks.push(check("scanners", "ok", "Scanners", `Scanner: ${picked.device.name}.`, { fields: { autoPick: { deviceId: picked.device.deviceId ?? null, name: picked.device.name ?? "" }, sameModel: true } }));
  }

  if (!chosen) {
    checks.push(check("printer-network", "warn", "Printer network", "No classroom printer was chosen, so its network address was not checked.", { whatToDo: "Add the Brother, then run the check again." }));
  } else {
    const host = printerHost(chosen.port);
    const kind = printerPortKind(chosen.port);
    if (kind === "usb") {
      checks.push(check("printer-network", "ok", "Printer network", "This printer is on USB, so there is no network address to check."));
    } else if (kind === "brw") {
      checks.push(check("printer-network", "ok", "Printer network", `The queue "${chosen.name}" uses a Brother direct port (${chosen.port}). Windows does not list an IP address for that kind of port. It is still a network printer. If a test page does not come out, pick the other Brother queue.`, { fields: { portKind: "brw" } }));
    } else if (kind === "wsd" && !host) {
      checks.push(check("printer-network", "warn", "Printer network", `The queue "${chosen.name}" uses a WSD port (${chosen.port || "unknown"}). A WSD queue often accepts a job and then does not print. Prefer a Brother direct port (BRW) or an IP port if one is listed.`, { whatToDo: "In the test print card, pick the other Brother queue and try again." }));
    } else if (!host) {
      checks.push(check("printer-network", "warn", "Printer network", `Windows did not give a network address for "${chosen.name}" (port ${chosen.port || "unknown"}).`, { whatToDo: "If the printer is on Wi-Fi and jobs do not come out, check that this PC and the printer are on the same network." }));
    } else if (printerReachable === true) {
      checks.push(check("printer-network", "ok", "Printer network", `This PC can reach the printer address ${host}.`));
    } else if (printerReachable === false) {
      checks.push(check("printer-network", "warn", "Printer network", `This PC could not reach the printer address ${host}.`, { whatToDo: "The printer may be off, or this PC may be on a different Wi-Fi network. Move them onto the same network and try again." }));
    } else {
      checks.push(check("printer-network", "warn", "Printer network", `The printer address is ${host}, but the check did not test it.`, { whatToDo: "Run the check again on the Windows PC that has the printer." }));
    }
  }

  checks.push(outputWritable
    ? check("output", "ok", "Scan folder", "The helper can write the scan folder.")
    : check("output", "fail", "Scan folder", "The helper cannot write its scan folder.", { whatToDo: "Choose a folder you can write to, such as Documents\\BEINGS-Scans. If Windows asks for an administrator password, that folder is the wrong place." }));

  const storeName = imageStorePhrase(store);
  if (!store) {
    checks.push(check("image-store", "warn", "Image store", "The image store was not checked.", { whatToDo: "Open this check from the beingsvote page on the scanning PC." }));
  } else if (store.ok) {
    checks.push(check("image-store", "ok", "Image store", `${storeName} answered (HTTP ${store.status}). Nothing was uploaded.`));
  } else if (store.error) {
    checks.push(check("image-store", "warn", "Image store", `This PC could not reach ${storeName.charAt(0).toLowerCase()}${storeName.slice(1)}.`, { whatToDo: "Check this PC's internet connection. The check only asks the store if it is there. It does not upload a picture." }));
  } else {
    checks.push(check("image-store", "warn", "Image store", `${storeName} answered HTTP ${store.status ?? "unknown"}, which is not the expected response.`, { whatToDo: "Try the page again in a few minutes. Nothing was uploaded." }));
  }

  if (unresolved.length) {
    const ids = unresolved.map((b) => b.batchId).join(", ");
    checks.push(check("synthetic-batches", "warn", "Earlier test scans", `An unfinished synthetic test batch is still in the scan folder (${ids}). It is not a real election.`, {
      fix: FIX_SUPERSEDE,
      whatToDo: "You can mark it superseded. That does not delete the files and does not touch a real election.",
    }));
  } else {
    checks.push(check("synthetic-batches", "ok", "Earlier test scans", "No unfinished synthetic test batch was found."));
  }

  checks.push(signInStart
    ? check("signin", "ok", "Start at sign-in", "The helper is set to start when you sign in to Windows.")
    : check("signin", "info", "Start at sign-in", "The helper does not start when you sign in. That is fine. You can turn it on if you want.", { fix: FIX_SIGNIN }));

  const fail = checks.some((c) => c.level === "fail");
  return { ok: !fail, service: "beings-scanner-bridge", version, checks };
}

export function outputFolderWritable(outputRoot) {
  try {
    mkdirSync(outputRoot, { recursive: true });
    const probe = join(outputRoot, ".beings-write-test");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Only the two synthetic locations. A client cannot name a folder. */
export function supersedeSyntheticTests(outputRoot) {
  const pending = unresolvedSyntheticBatches(outputRoot);
  const done = [];
  for (const b of pending) {
    supersedeBatch(b.dir, { reason: SUPERSEDE_REASON });
    done.push(b.batchId);
  }
  return { ok: true, superseded: done };
}

/** Where the system check reads. Same default as an upload: the R2 Worker, unless IMAGE_STORE_URL is set. */
export function systemCheckImageStoreUrl(env = process.env) {
  return resolveUploadUrl(undefined, env);
}

function imageStorePhrase(store) {
  let origin = "";
  try {
    if (store?.url) origin = new URL(store.url).origin;
  } catch {
    origin = "";
  }
  return origin ? `The image store at ${origin}` : "The image store";
}

export async function probeImageStore(origin, fetchImpl = fetch) {
  let url;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") return { ok: false, error: true, status: null, url: null };
    url = new URL("/api/images", base).toString();
  } catch {
    return { ok: false, error: true, status: null, url: null };
  }
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4000) });
    const status = res.status;
    let json = false;
    try {
      const text = await res.text();
      const t = text.trim();
      json = t.startsWith("{") || t.startsWith("[");
    } catch {
      json = false;
    }
    return { ok: status >= 400 && status < 500 && json, status, error: false, url };
  } catch {
    return { ok: false, error: true, status: null, url };
  }
}
