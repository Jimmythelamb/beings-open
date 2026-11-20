// Optional localhost bridge so the Dapp (in a browser on the polling PC) can list scanners, start a scan batch and get
// its manifest back. It binds to 127.0.0.1 and ::1 only, checks Host and Origin, has no tokens, never signs and never uploads.
// Ordinary endpoints never return images or ballot codes. The optional /v1/test/* endpoints may return the bundled
// synthetic test page (a fixed fake code, clearly labelled, never from a real election) so the teacher can print and
// check it. See docs/BRIDGE-SECURITY.md.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ELECTION_CODE_RE, BATCH_ID_RE } from "./batch.mjs";
import { listBatches, loadBatch, sealBatch } from "./fsbatch.mjs";
import {
  loadSyntheticElection,
  mockTestAllowed,
  parseTestPrintRequest,
  parseTestScanRequest,
  readFixturePdf,
  readFixturePng,
  readSyntheticTestImage,
  scanOutcome,
  testPageInfo,
} from "./testpage.mjs";
import { pickScanner } from "./pick-scanner.mjs";
import { buildDiagnosticsReport, choosePrinter, findSumatra, hostReachable, interpretSpoolerStatus, outputFolderWritable, printerAttemptOrder, printerHost, probeImageStore, shouldTryAnotherPrinter, supersedeSyntheticTests, systemCheckImageStoreUrl, unresolvedSyntheticBatches } from "./diagnostics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SCAN_SCRIPT = resolve(here, "../windows/Scan-BeingsBatch.ps1");
export const PRINT_SCRIPT = resolve(here, "../windows/Print-BeingsBallots.ps1");
export const DEFAULT_ORIGINS = Object.freeze(["https://beingsvote.live", "http://localhost:8888", "http://127.0.0.1:8888"]);
export const DEFAULT_PORT = 8765;
/** GET (and the CORS preflight) may name a private-network Host. Every other route stays loopback-only. */
export const READ_ONLY_STATUS_PATHS = new Set(["/v1/health", "/v1/station", "/v1/diagnostics"]);

function splitHostPort(host) {
  const h = String(host ?? "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const m = /^\[([0-9a-f:]+)\]:(\d+)$/.exec(h);
    return m ? { name: m[1], port: m[2] } : null;
  }
  const m = /^([^:]+):(\d+)$/.exec(h);
  return m ? { name: m[1], port: m[2] } : null;
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

function isLocalStatusName(name) {
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  if (isPrivateIPv4(name)) return true;
  if (name === "::1" || /^fe[89ab][0-9a-f]:/.test(name) || /^f[cd][0-9a-f]{0,2}:/.test(name)) return true;
  if (!name.endsWith(".local")) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local$/.test(name);
}

/** Loopback is always allowed. A private or .local Host is allowed only for read-only status. */
export function statusHostAllowed(host, { port = DEFAULT_PORT, readOnly = false } = {}) {
  const parts = splitHostPort(host);
  if (!parts || parts.port !== String(port)) return false;
  if (parts.name === "127.0.0.1" || parts.name === "localhost" || parts.name === "::1") return true;
  return readOnly && isLocalStatusName(parts.name);
}

/** Strip secrets from the helper log before the page shows it. */
export function redactHelperLog(text) {
  return String(text ?? "")
    .replace(/SCANNER_UPLOAD_TOKEN\s*=\s*\S+/gi, "SCANNER_UPLOAD_TOKEN=<removed>")
    .replace(/Bearer\s+\S+/gi, "Bearer <removed>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<removed key>")
    .replace(/\b0x[0-9a-fA-F]{40,64}\b/g, "<removed address>");
}

/** Version from package.json. installedAt from install.json when the Windows setup program wrote it. */
export function readInstallMeta(root = join(here, ".."), readFile = readFileSync) {
  let version = "0.2.0";
  try {
    const pkg = JSON.parse(readFile(join(root, "package.json"), "utf8"));
    if (pkg?.version) version = String(pkg.version);
  } catch { /* keep fallback */ }
  let installedAt = null;
  try {
    const inst = JSON.parse(readFile(join(root, "install.json"), "utf8"));
    if (typeof inst?.installedAt === "string" && inst.installedAt) installedAt = inst.installedAt;
  } catch { /* not installed by the setup program */ }
  return { version, installedAt };
}

/** Decide whether a request may be served. Pure. Returns null when fine, else { status, error }. */
export function checkRequest({ method, host, origin, contentType, pathname }, { port = DEFAULT_PORT, origins = DEFAULT_ORIGINS } = {}) {
  // DNS-rebinding guard. Loopback hosts always. A private-network or .local Host is accepted only for
  // read-only status (GET /v1/health, /v1/station, /v1/diagnostics and their preflight), so an iPad can
  // ask a station that is reached through secure local access. Scan, seal, print and fix stay loopback-only.
  const readOnly = (method === "GET" || method === "OPTIONS") && READ_ONLY_STATUS_PATHS.has(pathname);
  if (!statusHostAllowed(host, { port, readOnly })) return { status: 421, error: "wrong Host header" };
  if (origin != null && !origins.includes(origin)) return { status: 403, error: "this web page is not allowed to use the scanner bridge" };
  if (method === "POST") {
    if (origin == null) return { status: 403, error: "POST needs an Origin header" };
    if (!/^application\/json\b/i.test(String(contentType ?? ""))) return { status: 415, error: "POST body must be application/json" };
  }
  if (!["GET", "POST", "OPTIONS"].includes(method)) return { status: 405, error: "method not allowed" };
  return null;
}

/** Validate a start-scan request body. Pure. */
export function parseScanRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const electionCode = String(b.electionCode ?? "").trim().toUpperCase();
  if (!ELECTION_CODE_RE.test(electionCode)) errors.push("electionCode must look like BEINGS-2026-ABC123");
  const expectedPages = Number(b.expectedPages);
  if (!Number.isSafeInteger(expectedPages) || expectedPages < 1 || expectedPages > 1000) errors.push("expectedPages must be a whole number from 1 to 1000");
  const dpi = b.dpi == null ? 300 : Number(b.dpi);
  if (![150, 200, 300, 600].includes(dpi)) errors.push("dpi must be 150, 200, 300 or 600");
  const deviceId = b.deviceId == null ? null : String(b.deviceId);
  if (deviceId != null && (deviceId.length > 200 || /[\r\n"`$]/.test(deviceId))) errors.push("deviceId is not valid");
  const pageSize = b.pageSize == null ? "Letter" : String(b.pageSize);
  if (!["Letter", "Legal", "A4"].includes(pageSize)) errors.push("pageSize must be Letter, Legal or A4");
  if (b.operatorCountConfirmed !== true) errors.push("the operator must confirm the paper was counted by hand (operatorCountConfirmed: true)");
  return errors.length ? { errors } : { electionCode, expectedPages, dpi, deviceId, pageSize };
}

/** Public view of a batch: counts, hashes and state. Never file paths outside the scans folder, never images or codes. */
export function batchView(b) {
  return {
    batchId: b.batchId,
    state: b.status.state,
    recordable: b.status.recordable,
    reasons: b.status.reasons,
    electionCode: b.manifest?.electionCode ?? null,
    expectedPages: b.manifest?.expectedPages ?? null,
    savedPages: b.manifest?.pages?.length ?? 0,
    manifestSha256: b.manifestSha256,
    pages: (b.manifest?.pages ?? []).map((p) => ({ index: p.index, sha256: p.sha256, width: p.width, height: p.height })),
  };
}

const shortCode = (code) => code.replace(/^BEINGS-\d{4}-/, "");


const SECRET_FIELD = /^(private[_-]?key|mnemonic|seed|secret|secretKey|privkey)$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Public station wallet only. Pure. Never accepts a private key or mnemonic: if a secret-looking
 * field is present, the whole value is refused and not returned.
 */
export function parseStationWallet(input) {
  if (input == null || input === "") return { wallet: null };
  const obj = typeof input === "string" ? { address: input } : input;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "station wallet must be a public address" };
  for (const k of Object.keys(obj)) {
    if (SECRET_FIELD.test(k) && obj[k] != null && String(obj[k]).length) {
      return { error: "this station file looks like it contains a secret; not loaded. The helper never holds a wallet key. Use only the public address." };
    }
  }
  const address = String(obj.address ?? obj.stationAddress ?? "").trim();
  if (!ADDRESS_RE.test(address)) return { error: "station address must be a public 0x address (40 hex characters)" };
  const label = obj.label != null ? String(obj.label).trim().slice(0, 80) : "";
  return { wallet: { address, label: label || null } };
}

function parseDeviceList(out, label) {
  try {
    const v = JSON.parse(String(out || "[]"));
    return Array.isArray(v) ? { list: v } : { error: `could not list ${label}` };
  } catch {
    return { error: `could not list ${label}` };
  }
}

export function createBridge({ outputRoot, port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, powershell = "powershell.exe", spawnImpl = spawn, stationWallet = null, allowMockTest, log = () => {} }) {
  if (!outputRoot) throw new Error("outputRoot is required");
  const allowMock = mockTestAllowed({ allowMockTest });
  const installMeta = readInstallMeta();
  let job = null; // one scan at a time
  const runScript = (script, args, { sta = false } = {}) =>
    new Promise((res) => {
      // -STA: PrintDocument and the Windows PDF renderer fail from the default MTA thread.
      const staFlag = sta ? ["-STA"] : [];
      const p = spawnImpl(powershell, ["-NoProfile", ...staFlag, "-ExecutionPolicy", "Bypass", "-File", script, ...args], { shell: false, windowsHide: true });
      let out = "";
      let err = "";
      p.stdout?.on("data", (d) => (out += d));
      p.stderr?.on("data", (d) => (err += d));
      p.on("close", (code) => res({ code, out, err }));
      p.on("error", (e) => res({ code: -1, out, err: e.message }));
    });
  const runPs = (args) => runScript(SCAN_SCRIPT, args);
  const lastJson = (out) => {
    try { return JSON.parse(String(out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "null"); } catch { return null; }
  };
  const resolveScanner = async (deviceId) => {
    if (deviceId) return { deviceId };
    const listed = await runPs(["-ListDevices", "-Json"]);
    if (listed.code !== 0) return { error: "could not list scanners" };
    const parsed = parseDeviceList(listed.out, "scanners");
    if (parsed.error) return { error: parsed.error };
    const pick = pickScanner(parsed.list);
    if (!pick.ok) return { error: pick.error };
    if (!pick.device?.deviceId) return { error: "the scanner has no device id" };
    return { deviceId: pick.device.deviceId, auto: pick.auto, name: pick.device.name };
  };
  const printMessage = (method) => {
    if (method === "Windows built-in") return "Printed with Windows built-in printing, straight to the printer, at actual size, single-sided. No PDF app was opened. Collect that one sheet (it is labelled SYNTHETIC TEST PAGE — NOT A REAL BALLOT), then scan it.";
    if (method === "SumatraPDF") return "Windows built-in printing did not finish, so the helper used SumatraPDF that was already installed. It printed quietly, at actual size, single-sided. Collect that one sheet (it is labelled SYNTHETIC TEST PAGE — NOT A REAL BALLOT), then scan it.";
    return "The synthetic test page was sent to the printer. Collect that one sheet (it is labelled SYNTHETIC TEST PAGE — NOT A REAL BALLOT), then scan it.";
  };
  const stationPayload = async () => {
    const [sc, pr] = await Promise.all([runScript(SCAN_SCRIPT, ["-ListDevices", "-Json"]), runScript(PRINT_SCRIPT, ["-ListPrinters", "-Json"])]);
    const errors = [];
    let scanners = [];
    let printers = [];
    if (sc.code !== 0) errors.push("could not list scanners");
    else {
      const parsed = parseDeviceList(sc.out, "scanners");
      if (parsed.error) errors.push(parsed.error);
      else scanners = parsed.list;
    }
    if (pr.code !== 0) errors.push("could not list printers");
    else {
      const parsed = parseDeviceList(pr.out, "printers");
      if (parsed.error) errors.push(parsed.error);
      else printers = parsed.list;
    }
    return { ok: errors.length === 0, service: "beings-scanner-bridge", version: installMeta.version, installedAt: installMeta.installedAt, scanning: !!job?.running, scanners, printers, stationWallet: stationWallet ?? null, errors };
  };

  const onRequest = async (req, res) => {
    const origin = req.headers.origin ?? null;
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const cors = (extra = {}) => {
      const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra };
      if (origin && origins.includes(origin)) Object.assign(headers, { "access-control-allow-origin": origin, vary: "Origin" });
      return headers;
    };
    const send = (status, obj) => {
      res.writeHead(status, cors({ "content-type": "application/json" }));
      res.end(JSON.stringify(obj));
    };
    const sendBytes = (status, { type, body, filename, inline = true }) => {
      const disp = `${inline ? "inline" : "attachment"}; filename="${filename}"`;
      res.writeHead(status, cors({ "content-type": type, "content-disposition": disp }));
      res.end(body);
    };
    const bad = checkRequest({ method: req.method, host: req.headers.host, origin, contentType: req.headers["content-type"], pathname: url.pathname }, { port, origins });
    if (bad) return send(bad.status, { error: bad.error });
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true", "access-control-max-age": "600", vary: "Origin" });
      return res.end();
    }
    try {
      if (req.method === "GET" && url.pathname === "/v1/health") return send(200, { ok: true, service: "beings-scanner-bridge", version: installMeta.version, installedAt: installMeta.installedAt, scanning: !!job?.running, testPrintScan: true, mockTest: allowMock });
      if (req.method === "GET" && url.pathname === "/v1/scanners") {
        const r = await runPs(["-ListDevices", "-Json"]);
        if (r.code !== 0) return send(502, { error: "could not list scanners" });
        const parsed = parseDeviceList(r.out, "scanners");
        if (parsed.error) return send(502, { error: parsed.error });
        return send(200, { scanners: parsed.list });
      }
      if (req.method === "GET" && url.pathname === "/v1/printers") {
        const r = await runScript(PRINT_SCRIPT, ["-ListPrinters", "-Json"]);
        if (r.code !== 0) return send(502, { error: "could not list printers" });
        const parsed = parseDeviceList(r.out, "printers");
        if (parsed.error) return send(502, { error: parsed.error });
        return send(200, { printers: parsed.list });
      }
      if (req.method === "GET" && url.pathname === "/v1/station") return send(200, await stationPayload());
      const m = /^\/v1\/elections\/(BEINGS-\d{4}-[A-Z0-9]{6})\/batches(?:\/(batch-\d{8}-\d{6}))?(\/seal)?$/.exec(url.pathname);
      if (m && req.method === "GET" && !m[3]) {
        const dir = join(outputRoot, shortCode(m[1]));
        if (m[2]) return existsSync(join(dir, m[2])) ? send(200, batchView(loadBatch(join(dir, m[2])))) : send(404, { error: "no such batch" });
        return send(200, { batches: listBatches(dir).map(batchView) });
      }
      if (m && req.method === "POST" && m[2] && m[3]) {
        const dir = join(outputRoot, shortCode(m[1]), m[2]);
        if (!BATCH_ID_RE.test(m[2]) || !existsSync(dir)) return send(404, { error: "no such batch" });
        const r = await sealBatch(dir, { electionDir: join(outputRoot, shortCode(m[1])) });
        return send(r.sealed ? 200 : 409, { sealed: r.sealed, problems: r.problems, warnings: r.warnings, batch: batchView(loadBatch(dir)) });
      }
      if (req.method === "POST" && url.pathname === "/v1/scan") {
        if (job?.running) return send(409, { error: "a scan is already running" });
        const body = await readBody(req);
        const p = parseScanRequest(body);
        if (p.errors) return send(400, { errors: p.errors });
        const resolved = await resolveScanner(p.deviceId);
        if (resolved.error) return send(409, { error: resolved.error, message: resolved.error });
        const args = ["-ElectionCode", p.electionCode, "-ExpectedPages", String(p.expectedPages), "-Dpi", String(p.dpi), "-PageSize", p.pageSize, "-OutputRoot", outputRoot, "-OperatorCountConfirmed", "-Json", "-DeviceId", resolved.deviceId];
        job = { running: true, started: new Date().toISOString(), electionCode: p.electionCode, result: null };
        const current = job;
        runPs(args).then((r) => {
          current.running = false;
          current.exitCode = r.code;
          try {
            current.result = JSON.parse(r.out.trim().split(/\r?\n/).pop() || "null");
          } catch {
            current.result = null;
          }
          log(`scan finished exit=${r.code}`);
        });
        return send(202, { started: true, electionCode: p.electionCode, poll: `/v1/elections/${p.electionCode}/batches` });
      }
      if (req.method === "GET" && url.pathname === "/v1/scan") return send(200, job ? { running: job.running, exitCode: job.exitCode ?? null, electionCode: job.electionCode, result: job.result } : { running: false });
      if (req.method === "GET" && (url.pathname === "/v1/test" || url.pathname === "/v1/test/prepare")) {
        return send(200, { ...testPageInfo(), mockTest: allowMock, pdfPath: "/v1/test/page.pdf" });
      }
      if (req.method === "POST" && url.pathname === "/v1/test/prepare") {
        await readBody(req);
        return send(200, { ...testPageInfo(), mockTest: allowMock, pdfPath: "/v1/test/page.pdf" });
      }
      if (req.method === "GET" && url.pathname === "/v1/test/page.pdf") {
        try {
          const pdf = readFixturePdf();
          return sendBytes(200, { type: "application/pdf", body: pdf, filename: "SYNTHETIC-TEST-PAGE-NOT-A-REAL-BALLOT.pdf", inline: true });
        } catch (e) {
          return send(500, { error: "the synthetic test PDF is missing" });
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/test/last-page.png") {
        const file = join(outputRoot, "_synthetic-test-print-scan", "last-page.png");
        if (!existsSync(file)) return send(404, { error: "no scanned test page yet", message: "No scanned test page is saved yet." });
        return sendBytes(200, { type: "image/png", body: readFileSync(file), filename: "test-scan.png", inline: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/log") {
        const candidates = [process.env.BEINGS_HELPER_LOG, join(here, "../helper.log")].filter(Boolean);
        let text = "";
        for (const file of candidates) {
          try {
            if (!existsSync(file)) continue;
            text = readFileSync(file, "utf8").split(/\r?\n/).slice(-80).join("\n");
            break;
          } catch { /* try the next file */ }
        }
        return send(200, { ok: true, text: redactHelperLog(text) || "No helper log was found on this computer." });
      }
      if (req.method === "POST" && url.pathname === "/v1/test/print") {
        const body = await readBody(req);
        const p = parseTestPrintRequest(body);
        if (p.errors) return send(400, { errors: p.errors });
        if (allowMock && process.platform !== "win32") {
          return send(200, { ok: true, printed: false, mocked: true, printerName: p.printerName, message: "This computer is not running the Windows print script. On the polling PC, the helper will send the synthetic test page to the chosen printer. You can also download the PDF from /v1/test/page.pdf and print it from this browser." });
        }
        const listed = await runScript(PRINT_SCRIPT, ["-ListPrinters", "-Json"], { sta: true });
        const printers = listed.code === 0 && !parseDeviceList(listed.out, "printers").error ? parseDeviceList(listed.out, "printers").list : [];
        const names = [];
        if (p.printerName) names.push(p.printerName);
        for (const printer of printerAttemptOrder(printers)) if (!names.includes(printer.name)) names.push(printer.name);
        const attempts = [];
        let winner = null;
        for (const name of names.slice(0, 3)) {
          const pdfPath = loadSyntheticElection().paths.pdf;
          const r = await runScript(PRINT_SCRIPT, ["-PdfPath", pdfPath, "-PrinterName", name, "-ExpectedPages", "1", "-Json"], { sta: true });
          const json = lastJson(r.out) || {};
          const spool = interpretSpoolerStatus(json.spooler || {});
          const detail = String(json.message || json.error || r.err || r.out || "").replace(/\s+/g, " ").trim().slice(0, 500);
          const outcome = json.printed === true || spool.state === "printed" ? "printed" : spool.state === "pending" ? "pending" : "error";
          const attempt = { name, outcome, detail: detail || spool.detail };
          attempts.push(attempt);
          winner = { json, spool, detail, name, outcome };
          log(`test print ${name} -> ${outcome} exit=${r.code}`);
          if (!shouldTryAnotherPrinter({ spool, detail, json })) break;
        }
        const printed = winner?.outcome === "printed";
        const pending = winner?.outcome === "pending";
        const message = printed ? printMessage(winner.json?.method) : (winner?.detail || winner?.spool?.detail || "Windows did not print the test page.");
        return send(200, { ok: printed, printed, pending, mocked: false, printerName: winner?.name || p.printerName, method: winner?.json?.method || null, message, attempts, error: printed ? null : message });
      }
      if (req.method === "POST" && url.pathname === "/v1/test/scan-and-read") {
        const body = await readBody(req);
        const p = parseTestScanRequest(body, { allowMock });
        if (p.errors) return send(400, { errors: p.errors });
        const useMock = p.mock || (allowMock && process.platform !== "win32");
        if (useMock) {
          const png = readFixturePng();
          const result = await readSyntheticTestImage(png.path);
          return send(200, { ok: true, mocked: true, ...result, message: "No Windows scanner was used. The helper read the bundled stand-in picture of the synthetic test page. On the polling PC, run the same test with the helper and the real scanner to confirm the hardware." });
        }
        if (job?.running) return send(409, { error: "a scan is already running" });
        const resolved = await resolveScanner(p.deviceId);
        if (resolved.error) return send(409, { ok: false, error: resolved.error, message: resolved.error, mocked: false });
        const testRoot = join(outputRoot, "_synthetic-test-print-scan");
        const args = ["-ElectionCode", "BEINGS-2026-TEST00", "-ExpectedPages", "1", "-Dpi", "300", "-PageSize", "Letter", "-OutputRoot", testRoot, "-OperatorCountConfirmed", "-Json", "-DeviceId", resolved.deviceId];
        job = { running: true, started: new Date().toISOString(), electionCode: "BEINGS-2026-TEST00", result: null, test: true };
        const current = job;
        try {
          const r = await runPs(args);
          current.running = false;
          current.exitCode = r.code;
          let parsed = null;
          try { parsed = JSON.parse((r.out || "").trim().split(/\r?\n/).pop() || "null"); } catch { parsed = null; }
          current.result = parsed;
          if (r.code !== 0) {
            const detail = parsed?.reason || parsed?.error || lastJson(r.out)?.reason || String(r.err || r.out || "").trim().split(/\r?\n/).filter(Boolean).pop();
            const message = detail || "The test scan did not finish. Nothing was uploaded.";
            return send(200, { ok: false, pass: false, error: message, message, step: parsed?.step ?? null, mocked: false });
          }
          const png = findNewestTestPng(testRoot);
          let readResult = null;
          let readError = null;
          if (png) {
            const dest = join(testRoot, "last-page.png");
            mkdirSync(testRoot, { recursive: true });
            copyFileSync(png, dest);
            try {
              readResult = await readSyntheticTestImage(dest);
            } catch (e) {
              readError = e?.message || String(e);
            }
          }
          const body = scanOutcome({ readResult, readError, hasImage: !!png });
          return send(200, body);
        } finally {
          current.running = false;
          // Drop the batch folder so the next test is not blocked, but keep last-page.png for the page to show.
          try { rmSync(join(testRoot, "TEST00"), { recursive: true, force: true }); } catch { /* keep going */ }
        }
      }
      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/v1/diagnostics") {
        if (req.method === "POST") await readBody(req);
        const [sc, pr] = await Promise.all([runPs(["-ListDevices", "-Json"]), runScript(PRINT_SCRIPT, ["-ListPrinters", "-Json"])]);
        const scanners = sc.code === 0 && !parseDeviceList(sc.out, "scanners").error ? parseDeviceList(sc.out, "scanners").list : null;
        const printers = pr.code === 0 && !parseDeviceList(pr.out, "printers").error ? parseDeviceList(pr.out, "printers").list : null;
        const chosen = printers ? choosePrinter(printers) : null;
        const host = chosen ? printerHost(chosen.port) : null;
        let version = "0.1.0";
        try { version = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version || version; } catch { /* keep fallback */ }
        let pdfLib = { present: false, version: null };
        try {
          const { createRequire } = await import("node:module");
          const pkg = createRequire(import.meta.url)("pdf-lib/package.json");
          pdfLib = { present: true, version: pkg.version };
        } catch { /* not installed */ }
        const startup = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Start BEINGS helper.lnk");
        const store = await probeImageStore(systemCheckImageStoreUrl());
        return send(200, buildDiagnosticsReport({
          version,
          pdfLib,
          sumatraPath: findSumatra(process.env),
          printers,
          scanners,
          printerReachable: host ? await hostReachable(host) : null,
          outputWritable: outputFolderWritable(outputRoot),
          store,
          unresolved: unresolvedSyntheticBatches(outputRoot),
          signInStart: existsSync(startup),
        }));
      }
      if (req.method === "POST" && url.pathname === "/v1/diagnostics/fix") {
        const body = await readBody(req);
        const action = String(body?.action || "");
        if (action === "supersede-synthetic-test") return send(200, supersedeSyntheticTests(outputRoot));
        if (action === "signin-start") {
          if (process.platform !== "win32") return send(400, { ok: false, error: "Sign-in start can only be set on the Windows PC." });
          const vbs = [join(here, "../Launch-BEINGS-Helper.vbs"), join(here, "../bundle/Launch-BEINGS-Helper.vbs")].find((p) => existsSync(p));
          const startCmd = vbs || [join(here, "../Start-BEINGS-Helper.cmd"), join(here, "../bundle/Start-BEINGS-Helper.cmd")].find((p) => existsSync(p));
          if (!startCmd) return send(400, { ok: false, error: "Start-BEINGS-Helper was not found. Run the setup program first." });
          const startup = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
          const lnk = join(startup, "Start BEINGS helper.lnk");
          const target = vbs ? "wscript.exe" : "cmd.exe";
          const startArgs = vbs ? `//B "${startCmd}"` : `/d /c "${startCmd}"`;
          const windowStyle = vbs ? 7 : 1;
          const command = "$dir = Split-Path -Parent $env:BEINGS_STARTUP_LNK; if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }; $w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut($env:BEINGS_STARTUP_LNK); $s.TargetPath = Join-Path $env:SystemRoot (Join-Path 'System32' $env:BEINGS_START_TARGET); $s.Arguments = $env:BEINGS_START_ARGS; $s.WorkingDirectory = Split-Path -Parent $env:BEINGS_START_CMD; $s.WindowStyle = [int]$env:BEINGS_START_STYLE; $s.Description = 'Start BEINGS scanner helper'; $s.Save()";
          const ran = await new Promise((res) => {
            const child = spawnImpl("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { shell: false, windowsHide: true, env: { ...process.env, BEINGS_START_CMD: startCmd, BEINGS_START_TARGET: target, BEINGS_START_ARGS: startArgs, BEINGS_START_STYLE: String(windowStyle), BEINGS_STARTUP_LNK: lnk } });
            child.on("close", (code) => res(code));
            child.on("error", () => res(-1));
          });
          if (ran !== 0) return send(500, { ok: false, error: "Windows could not add the sign-in shortcut." });
          return send(200, { ok: true });
        }
        return send(400, { ok: false, error: "That fix is not available from the helper." });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      log(`error ${e.message}`);
      return send(500, { error: "bridge error" });
    }
  };
  const server = createServer(onRequest);
  const server6 = createServer(onRequest);
  return {
    server,
    server6,
    listen: () => new Promise((resolve, reject) => {
      const fail = (err) => reject(err);
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", fail);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(server.address());
        };
        const onV6Error = (err) => {
          log(`ipv6 loopback not bound: ${err?.code || err?.message || err}`);
          finish();
        };
        server6.once("error", onV6Error);
        server6.listen(port, "::1", () => {
          server6.removeListener("error", onV6Error);
          finish();
        });
      });
    }),
    close: () => new Promise((resolve) => {
      let left = 2;
      const done = () => { if (--left === 0) resolve(); };
      server.close(done);
      if (server6.listening) server6.close(done);
      else done();
    }),
  };
}


function findNewestTestPng(root) {
  if (!existsSync(root)) return null;
  const stack = [root];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const pth = join(dir, e.name);
      if (e.isDirectory()) stack.push(pth);
      else if (/\.png$/i.test(e.name)) {
        try { found.push({ p: pth, m: statSync(pth).mtimeMs }); } catch { /* skip */ }
      }
    }
  }
  found.sort((a, b) => b.m - a.m);
  return found[0]?.p ?? null;
}

function readBody(req) {
  return new Promise((res, rej) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > 16 * 1024) {
        rej(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        res(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        res(null);
      }
    });
  });
}
