#!/usr/bin/env node
// Build the downloadable Windows scanner helper folder.
// Teachers do not need git, npm, or Node already on PATH. The zip vendors the helper
// sources plus the production dependency pdf-lib (pinned by tools/windows-bundle-deps/package-lock.json).
// It does not contain SCANNER_UPLOAD_TOKEN, a private election file, or a wallet key.
//
//   node tools/build-windows-bundle.mjs
//   node tools/build-windows-bundle.mjs --out /tmp/helper.zip --no-publish
//
// The default run writes:
//   apps/beingsvote-site/public/downloads/BEINGS-Scanner-Helper-Windows.zip
//   apps/beingsvote-site/public/downloads/BEINGS-Scanner-Helper-Windows.sha256
//   apps/beingsvote-site/public/downloads/helper-download.js
// Netlify runs this during the site build (base directory apps/beingsvote-site).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const helperRoot = resolve(here, "..");
const repoRoot = resolve(here, "../../..");
const publishDir = resolve(repoRoot, "apps/beingsvote-site/public/downloads");
const lockPath = resolve(here, "windows-bundle-deps/package-lock.json");

export const ZIP_NAME = "BEINGS-Scanner-Helper-Windows.zip";
export const ZIP_ROOT = "BEINGS-Scanner-Helper-Windows";
export const BUNDLE_HREF = "/downloads/BEINGS-Scanner-Helper-Windows.zip";
export const SETUP_NAME = "BEINGS-Scanner-Helper-Setup.exe";
export const SETUP_HREF = "/downloads/BEINGS-Scanner-Helper-Setup.exe";

const INCLUDE_DIRS = ["src", "windows", "fixtures", "docs"];
const CACHE_DIR = join(tmpdir(), "beings-scanner-helper-bundle-cache");

function parseArgs(argv) {
  const opt = { publish: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-publish") opt.publish = false;
    else if (a === "--publish") opt.publish = true;
    else if (a === "--out") opt.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opt;
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function readCString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const z = slice.indexOf(0);
  return slice.subarray(0, z === -1 ? slice.length : z).toString("utf8");
}

function parsePax(text) {
  const rec = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!Number.isInteger(len) || len <= 0) break;
    const body = text.slice(space + 1, i + len).replace(/\n$/, "");
    const eq = body.indexOf("=");
    if (eq > 0) rec[body.slice(0, eq)] = body.slice(eq + 1);
    i += len;
  }
  return rec;
}

/** Unpack a gzip npm tarball into { name, data } records. Names stay as stored (usually package/...). */
export function untar(raw) {
  const buf = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const out = [];
  let off = 0;
  let longName = null;
  let pax = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    let blank = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { blank = false; break; }
    if (blank) break;
    const name = readCString(header, 0, 100);
    const size = parseInt(readCString(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar size for ${name}`);
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = readCString(header, 345, 155);
    off += 512;
    const data = Buffer.from(buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
    if (typeflag === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      pax = parsePax(data.toString("utf8"));
      continue;
    }
    const full = (pax && pax.path) || longName || (prefix ? `${prefix}/${name}` : name);
    longName = null;
    pax = null;
    if (typeflag !== "0" && typeflag !== "\0") continue;
    if (!full || full.split("/").includes("..")) throw new Error(`refusing tar path ${full}`);
    out.push({ name: full.replace(/\\/g, "/"), data });
  }
  return out;
}

function verifyIntegrity(buf, integrity, label) {
  const m = /^([a-z0-9]+)-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!m) throw new Error(`missing integrity for ${label}`);
  const got = createHash(m[1]).update(buf).digest("base64");
  if (got !== m[2]) throw new Error(`integrity mismatch for ${label}`);
}

/** Production packages from the pinned lockfile: node_modules-relative name -> { resolved, integrity }. */
export function lockPackages(lock = JSON.parse(readFileSync(lockPath, "utf8"))) {
  const pkgs = lock.packages ?? {};
  const out = [];
  for (const [key, meta] of Object.entries(pkgs)) {
    if (!key.startsWith("node_modules/")) continue;
    if (!meta.resolved || !meta.integrity) throw new Error(`lock entry ${key} has no resolved tarball`);
    if (!meta.resolved.startsWith("https://registry.npmjs.org/")) throw new Error(`refusing non-registry tarball for ${key}`);
    out.push({ path: key, version: meta.version, resolved: meta.resolved, integrity: meta.integrity });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!out.some((p) => p.path === "node_modules/pdf-lib")) throw new Error("lockfile is missing pdf-lib");
  return out;
}

async function fetchTarball(pkg) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheName = createHash("sha256").update(pkg.integrity).digest("hex") + ".tgz";
  const cachePath = join(CACHE_DIR, cacheName);
  try {
    const cached = readFileSync(cachePath);
    verifyIntegrity(cached, pkg.integrity, pkg.path);
    return cached;
  } catch {
    /* download */
  }
  const res = await fetch(pkg.resolved, { redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download failed ${res.status} ${pkg.resolved}`);
  if (!String(res.url).startsWith("https://registry.npmjs.org/")) throw new Error(`unexpected download host ${res.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  verifyIntegrity(buf, pkg.integrity, pkg.path);
  writeFileSync(cachePath, buf);
  return buf;
}

function npmPackageFiles(tarball) {
  const files = [];
  for (const entry of untar(tarball)) {
    if (!entry.name.startsWith("package/")) continue;
    const rel = entry.name.slice("package/".length);
    if (!rel || rel.endsWith("/")) continue;
    // Source maps and the upstream yarn lock are not needed to import pdf-lib.
    if (rel.endsWith(".map") || rel === "yarn.lock") continue;
    files.push({ name: rel, data: entry.data });
  }
  if (!files.some((f) => f.name === "package.json")) throw new Error("tarball has no package.json");
  return files;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * A stored (uncompressed) zip. Fixed DOS date 1980-01-01 so the bytes, and therefore
 * the SHA256, do not depend on the clock or on zlib.
 */
export function zipStore(files) {
  const entries = files.map((f) => ({
    name: String(f.name).replace(/\\/g, "/").replace(/^\/+/, ""),
    data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data),
  }));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length >= 65535) throw new Error("zip has too many files");
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = 0;
  const date = 33;
  for (const e of entries) {
    if (!e.name || e.name.split("/").includes("..")) throw new Error(`refusing zip path ${e.name}`);
    if (seen.has(e.name)) throw new Error(`duplicate zip path ${e.name}`);
    seen.add(e.name);
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameBuf.length), u16(0),
      nameBuf, e.data,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Read a stored zip written by zipStore. Used as a self-check and by tests. */
export function readZip(buf) {
  const files = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) throw new Error(`bad zip local header at ${off}`);
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const comp = buf.readUInt32LE(off + 18);
    const uncomp = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    const data = Buffer.from(buf.subarray(dataStart, dataStart + comp));
    if (method !== 0 || comp !== uncomp) throw new Error(`zip entry ${name} is not stored`);
    if (crc32(data) !== crc) throw new Error(`zip crc mismatch for ${name}`);
    files.push({ name, data });
    off = dataStart + comp;
  }
  return files;
}

function bundlePackageJson() {
  const own = JSON.parse(readFileSync(join(helperRoot, "package.json"), "utf8"));
  return Buffer.from(JSON.stringify({
    name: own.name,
    version: own.version,
    private: true,
    type: "module",
    description: "B.E.I.N.G.S. polling-PC scanner helper for Windows. The bridge listens on 127.0.0.1 and ::1 only. This folder has no upload token and no private election file.",
    dependencies: { "pdf-lib": "1.17.1" },
  }, null, 2) + "\n", "utf8");
}

function infoText() {
  return Buffer.from([
    "BEINGS scanner helper for Windows",
    "Prefer BEINGS-Scanner-Helper-Setup.exe. This zip is the fallback: double-click Install-BEINGS-Helper.cmd.",
    "The helper runs in the background (no console window) and starts when you sign in.",
    "The bridge listens only on 127.0.0.1:8765 and [::1]:8765.",
    "pdf-lib 1.17.1 and its production dependencies are in node_modules.",
    "This folder does not contain SCANNER_UPLOAD_TOKEN, a wallet key, or a private election file.",
    "The fixtures/test-print-scan folder is a synthetic test page, not a real ballot.",
    "",
  ].join("\r\n"), "utf8");
}

export function helperVersion() {
  return JSON.parse(readFileSync(join(helperRoot, "package.json"), "utf8")).version;
}

export async function stageFiles() {
  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  const add = (zipName, data) => files.push({ name: `${ZIP_ROOT}/${zipName.replace(/\\/g, "/")}`, data });

  for (const dir of INCLUDE_DIRS) {
    const abs = join(helperRoot, dir);
    for (const file of walkFiles(abs)) {
      const rel = relative(helperRoot, file).split(sep).join("/");
      add(rel, readFileSync(file));
    }
  }
  const readme = join(helperRoot, "README.md");
  add("README.md", readFileSync(readme));
  for (const name of [
    "Install-BEINGS-Helper.cmd",
    "Install-BEINGS-Helper.ps1",
    "Start-BEINGS-Helper.cmd",
    "Launch-BEINGS-Helper.vbs",
    "Stop-BEINGS-Helper.vbs",
    "Write-InstallStamp.ps1",
    "Uninstall-BEINGS-Helper.ps1",
    "README-INSTALL.txt",
  ]) {
    add(name, readFileSync(join(helperRoot, "bundle", name)));
  }
  add("package.json", bundlePackageJson());
  add("version.txt", Buffer.from(String(helperVersion()).trim() + "\r\n", "utf8"));
  add("BUNDLE-INFO.txt", infoText());

  for (const pkg of lockPackages()) {
    const tarball = await fetchTarball(pkg);
    for (const file of npmPackageFiles(tarball)) {
      add(`${pkg.path}/${file.name}`, file.data);
    }
  }
  return files;
}

export function assertSafe(files) {
  const secretName = /(^|\/)\.env($|\.)|id_rsa|private[-_]?key/i;
  const secretBody = [
    /SCANNER_UPLOAD_TOKEN\s*=\s*['"]?[A-Za-z0-9_\-]{12,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /"privateKey"\s*:\s*"0x[0-9a-fA-F]{64}"/,
    /"mnemonic"\s*:\s*"/,
  ];
  for (const f of files) {
    if (secretName.test(f.name)) throw new Error(`refusing to bundle ${f.name}`);
    if (f.name.includes("/node_modules/.bin/") || f.name.endsWith("/.package-lock.json")) throw new Error(`refusing to bundle ${f.name}`);
    const textish = /\.(mjs|js|json|md|txt|ps1|cmd|vbs|html|css)$/i.test(f.name);
    if (!textish) continue;
    const text = f.data.toString("utf8");
    for (const re of secretBody) {
      if (re.test(text)) throw new Error(`refusing secret-looking content in ${f.name}`);
    }
  }
  const need = [
    `${ZIP_ROOT}/src/cli.mjs`,
    `${ZIP_ROOT}/node_modules/pdf-lib/package.json`,
    `${ZIP_ROOT}/windows/Scan-BeingsBatch.ps1`,
    `${ZIP_ROOT}/fixtures/test-print-scan/election-file.json`,
    `${ZIP_ROOT}/docs/BRIDGE-SECURITY.md`,
    `${ZIP_ROOT}/Install-BEINGS-Helper.cmd`,
    `${ZIP_ROOT}/Install-BEINGS-Helper.ps1`,
    `${ZIP_ROOT}/Start-BEINGS-Helper.cmd`,
    `${ZIP_ROOT}/Launch-BEINGS-Helper.vbs`,
    `${ZIP_ROOT}/Stop-BEINGS-Helper.vbs`,
    `${ZIP_ROOT}/Write-InstallStamp.ps1`,
    `${ZIP_ROOT}/Uninstall-BEINGS-Helper.ps1`,
    `${ZIP_ROOT}/version.txt`,
  ];
  for (const n of need) if (!files.some((f) => f.name === n)) throw new Error(`bundle is missing ${n}`);
  const election = files.find((f) => f.name.endsWith("fixtures/test-print-scan/election-file.json"));
  const parsed = JSON.parse(election.data.toString("utf8"));
  if (parsed.name !== "SYNTHETIC TEST PAGE — NOT A REAL BALLOT" || parsed.electionCode !== "BEINGS-2026-TEST00") {
    throw new Error("fixture election file is not the synthetic test page");
  }
  const pdfLib = JSON.parse(files.find((f) => f.name.endsWith("node_modules/pdf-lib/package.json")).data.toString("utf8"));
  if (pdfLib.version !== "1.17.1") throw new Error(`expected pdf-lib 1.17.1, found ${pdfLib.version}`);
}

export function materialize(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const rel = f.name.slice(ZIP_ROOT.length + 1);
    const dest = join(dir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.data);
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function readSetupArtifact(dir = publishDir) {
  const exe = join(dir, SETUP_NAME);
  try {
    const buf = readFileSync(exe);
    return { href: SETUP_HREF, fileName: SETUP_NAME, sha256: sha256(buf), bytes: buf.length };
  } catch {
    return null;
  }
}

/** Primary download is the setup exe when it is already published. The zip stays as zip. */
export function helperDownloadModule({ version, zip, setup }) {
  const primary = setup || zip;
  const lines = [
    "// Generated by packages/scanner-helper/tools/build-windows-bundle.mjs. Do not edit by hand.",
    "export const HELPER_DOWNLOAD = {",
    `  version: ${JSON.stringify(version)},`,
    `  href: ${JSON.stringify(primary.href)},`,
    `  fileName: ${JSON.stringify(primary.fileName)},`,
    `  sha256: ${JSON.stringify(primary.sha256)},`,
    `  bytes: ${primary.bytes},`,
  ];
  if (setup && zip) {
    lines.push(
      "  zip: {",
      `    href: ${JSON.stringify(zip.href)},`,
      `    fileName: ${JSON.stringify(zip.fileName)},`,
      `    sha256: ${JSON.stringify(zip.sha256)},`,
      `    bytes: ${zip.bytes},`,
      "  },",
    );
  }
  lines.push("};", "");
  return lines.join("\n");
}

export function writeHelperDownload({ version, zip, setup }) {
  mkdirSync(publishDir, { recursive: true });
  writeFileSync(join(publishDir, "helper-download.js"), helperDownloadModule({ version, zip, setup }), "utf8");
}

export async function buildWindowsBundle({ out, publish } = {}) {
  const files = await stageFiles();
  assertSafe(files);
  const stage = join(tmpdir(), "beings-scanner-helper-stage");
  materialize(stage, files);
  try {
    execFileSync(process.execPath, ["src/cli.mjs"], { cwd: stage, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  } catch (e) {
    const err = e.stderr ? e.stderr.toString() : e.message;
    throw new Error(`staged helper did not load (pdf-lib or cli.mjs): ${err}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const zip = zipStore(files);
  const check = readZip(zip);
  if (check.length !== files.length) throw new Error("zip self-check lost a file");
  const byName = new Map(check.map((f) => [f.name, f.data]));
  for (const f of files) {
    const got = byName.get(f.name);
    if (!got || !got.equals(f.data)) throw new Error(`zip self-check mismatch for ${f.name}`);
  }
  const hash = sha256(zip);
  const dest = out ? resolve(out) : join(publishDir, ZIP_NAME);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, zip);
  if (publish !== false) {
    mkdirSync(publishDir, { recursive: true });
    const publishedZip = join(publishDir, ZIP_NAME);
    if (resolve(publishedZip) !== resolve(dest)) writeFileSync(publishedZip, zip);
    writeFileSync(join(publishDir, "BEINGS-Scanner-Helper-Windows.sha256"), `${hash}  ${ZIP_NAME}\n`, "utf8");
    writeHelperDownload({
      version: helperVersion(),
      zip: { href: BUNDLE_HREF, fileName: ZIP_NAME, sha256: hash, bytes: zip.length },
      setup: readSetupArtifact(),
    });
  }
  return { zipPath: dest, sha256: hash, bytes: zip.length, files: files.map((f) => f.name) };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const result = await buildWindowsBundle({ out: opt.out, publish: opt.publish });
  process.stdout.write(`${result.sha256}  ${result.bytes} bytes  ${result.zipPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}

export function hashFile(path) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}
