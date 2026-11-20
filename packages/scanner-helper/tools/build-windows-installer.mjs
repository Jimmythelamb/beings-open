#!/usr/bin/env node
// Build the per-user Windows setup program (NSIS). No administrator password.
// Bundles the helper and a pinned official Node.js win-x64 node.exe.
//
//   node tools/build-windows-installer.mjs
//   node tools/build-windows-installer.mjs --out /tmp/BEINGS-Scanner-Helper-Setup.exe --no-publish
//
// Requires makensis (NSIS) on PATH. Code signing is not available: SmartScreen
// will offer More info, then Run anyway.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SETUP_HREF,
  SETUP_NAME,
  ZIP_NAME,
  BUNDLE_HREF,
  assertSafe,
  helperVersion,
  materialize,
  readSetupArtifact,
  stageFiles,
  writeHelperDownload,
} from "./build-windows-bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const publishDir = resolve(repoRoot, "apps/beingsvote-site/public/downloads");
const nsiTemplate = resolve(here, "../windows/installer/beings-helper.nsi");
const pin = JSON.parse(readFileSync(join(here, "node-win-x64.json"), "utf8"));

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

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function nodeZip() {
  const cached = join(tmpdir(), pin.file);
  try {
    const buf = readFileSync(cached);
    if (sha256(buf) === pin.sha256) return cached;
  } catch {
    /* download */
  }
  if (!pin.url.startsWith("https://nodejs.org/dist/")) throw new Error("refusing a Node.js URL that is not nodejs.org");
  const res = await fetch(pin.url, { redirect: "follow", signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Node.js download failed ${res.status}`);
  if (!String(res.url).startsWith("https://nodejs.org/")) throw new Error(`unexpected Node.js host ${res.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== pin.sha256) throw new Error("Node.js zip did not match the pinned SHA256 from nodejs.org");
  writeFileSync(cached, buf);
  return cached;
}

function extractNodeRuntime(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  execFileSync("unzip", ["-o", "-j", zipPath, "*/node.exe", "*/LICENSE", "-d", destDir], { stdio: ["ignore", "pipe", "pipe"] });
  const exe = join(destDir, "node.exe");
  if (!existsSync(exe) || statSync(exe).size < 1_000_000) throw new Error("node.exe was not in the official Node.js zip");
}

function compile(stage, outPath, version) {
  const script = readFileSync(nsiTemplate, "utf8")
    .replaceAll("@VERSION@", version)
    .replaceAll("@STAGE@", stage.replace(/\\/g, "/"))
    .replaceAll("@OUT@", outPath.replace(/\\/g, "/"));
  if (script.includes("@VERSION@") || script.includes("@STAGE@") || script.includes("@OUT@")) {
    throw new Error("installer script still has placeholders");
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "beings-nsi-"));
  const nsiPath = join(work, "beings-helper.built.nsi");
  writeFileSync(nsiPath, script);
  execFileSync("makensis", ["-V2", nsiPath], { stdio: ["ignore", "pipe", "pipe"] });
  const exe = readFileSync(outPath);
  if (exe.length < 50_000 || exe[0] !== 0x4d || exe[1] !== 0x5a) throw new Error("makensis did not write a Windows exe");
  return exe;
}

export async function buildWindowsInstaller({ out, publish } = {}) {
  const version = String(helperVersion()).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`helper version ${version} is not x.y.z`);
  const files = await stageFiles();
  assertSafe(files);
  const stage = join(tmpdir(), "beings-scanner-helper-setup-stage");
  materialize(stage, files);
  extractNodeRuntime(await nodeZip(), join(stage, "node"));
  const dest = out ? resolve(out) : join(publishDir, SETUP_NAME);
  mkdirSync(dirname(dest), { recursive: true });
  const exe = compile(stage, dest, version);
  const hash = sha256(exe);
  if (publish !== false) {
    mkdirSync(publishDir, { recursive: true });
    const published = join(publishDir, SETUP_NAME);
    if (resolve(published) !== resolve(dest)) writeFileSync(published, exe);
    writeFileSync(join(publishDir, "BEINGS-Scanner-Helper-Setup.sha256"), `${hash}  ${SETUP_NAME}\n`, "utf8");
    const zipPath = join(publishDir, ZIP_NAME);
    const zipBuf = existsSync(zipPath) ? readFileSync(zipPath) : null;
    writeHelperDownload({
      version,
      zip: zipBuf
        ? { href: BUNDLE_HREF, fileName: ZIP_NAME, sha256: sha256(zipBuf), bytes: zipBuf.length }
        : null,
      setup: readSetupArtifact(),
    });
  }
  return { exePath: dest, sha256: hash, bytes: exe.length, version };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const result = await buildWindowsInstaller({ out: opt.out, publish: opt.publish });
  process.stdout.write(`${result.sha256}  ${result.bytes} bytes  ${result.version}  ${result.exePath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
