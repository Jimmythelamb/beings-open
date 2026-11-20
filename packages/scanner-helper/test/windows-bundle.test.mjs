// The Windows download: vendored pdf-lib, the helper sources, no secrets.
// Install-BEINGS-Helper.ps1 is parsed here. It is not executed (no Windows, no nodejs.org download).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWindowsBundle, readZip } from "../tools/build-windows-bundle.mjs";

const helperRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(helperRoot, "../..");
const downloads = join(repoRoot, "apps/beingsvote-site/public/downloads");
const publishedZip = join(downloads, "BEINGS-Scanner-Helper-Windows.zip");
const ROOT = "BEINGS-Scanner-Helper-Windows/";

const SECRET_BODY = [
  /SCANNER_UPLOAD_TOKEN\s*=\s*['"]?[A-Za-z0-9_\-]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"privateKey"\s*:\s*"0x[0-9a-fA-F]{64}"/,
  /"mnemonic"\s*:\s*"/,
];

function textOf(files, suffix) {
  const f = files.find((x) => x.name === ROOT + suffix || x.name.endsWith("/" + suffix));
  expect(f, suffix).toBeTruthy();
  return f.data.toString("utf8");
}

describe("windows helper bundle", () => {
  it("zips cli.mjs and pdf-lib, hides secrets, and matches the published SHA256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beings-win-bundle-"));
    const first = await buildWindowsBundle({ out: join(dir, "a.zip"), publish: false });
    const second = await buildWindowsBundle({ out: join(dir, "b.zip"), publish: false });
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).toBe(second.bytes);
    expect(readFileSync(join(dir, "a.zip")).equals(readFileSync(join(dir, "b.zip")))).toBe(true);

    const files = readZip(readFileSync(first.zipPath));
    const names = files.map((f) => f.name);
    expect(names).toContain(ROOT + "src/cli.mjs");
    expect(names).toContain(ROOT + "node_modules/pdf-lib/package.json");
    expect(names.some((n) => n.startsWith(ROOT + "node_modules/pdf-lib/"))).toBe(true);
    expect(names).toContain(ROOT + "windows/Scan-BeingsBatch.ps1");
    expect(names).toContain(ROOT + "windows/Print-BeingsBallots.ps1");
    expect(names).toContain(ROOT + "fixtures/test-print-scan/SYNTHETIC-TEST-PAGE-NOT-A-REAL-BALLOT.pdf");
    expect(names).toContain(ROOT + "docs/BRIDGE-SECURITY.md");
    expect(names).toContain(ROOT + "Install-BEINGS-Helper.cmd");
    expect(names).toContain(ROOT + "Install-BEINGS-Helper.ps1");
    expect(names).toContain(ROOT + "Start-BEINGS-Helper.cmd");
    expect(names.some((n) => n.includes("/.env") || n.endsWith("/.env"))).toBe(false);
    expect(names.some((n) => n.includes("/node_modules/.bin/"))).toBe(false);
    expect(names.some((n) => n.endsWith(".map"))).toBe(false);
    expect(names.some((n) => /private[-_]?key|id_rsa/i.test(n))).toBe(false);

    const pdfLib = JSON.parse(textOf(files, "node_modules/pdf-lib/package.json"));
    expect(pdfLib.version).toBe("1.17.1");
    const cli = textOf(files, "src/cli.mjs");
    expect(cli).toMatch(/127\.0\.0\.1/);
    expect(cli).not.toMatch(/0\.0\.0\.0/);

    const election = JSON.parse(textOf(files, "fixtures/test-print-scan/election-file.json"));
    expect(election.name).toBe("SYNTHETIC TEST PAGE — NOT A REAL BALLOT");
    expect(election.electionCode).toBe("BEINGS-2026-TEST00");
    expect(election.privateKey).toBeUndefined();

    const start = textOf(files, "Start-BEINGS-Helper.cmd");
    expect(start).toContain("Launch-BEINGS-Helper.vbs");
    expect(start).toContain("wscript.exe");
    expect(start).not.toMatch(/keep open/i);
    expect(start.includes("\r\n")).toBe(true);
    const launch = textOf(files, "Launch-BEINGS-Helper.vbs");
    expect(launch).toContain("src\\cli.mjs");
    expect(launch).toContain("bridge --output-root");
    expect(launch).toContain("helper.log");
    expect(launch).toContain("beings-helper:");
    expect(launch).not.toMatch(/0\.0\.0\.0/);
    expect(textOf(files, "Stop-BEINGS-Helper.vbs")).toContain("cli.mjs");

    const installCmd = textOf(files, "Install-BEINGS-Helper.cmd");
    expect(installCmd).toMatch(/-ExecutionPolicy Bypass/);
    expect(installCmd).toMatch(/Install-BEINGS-Helper\.ps1/);
    expect(installCmd).not.toMatch(/RunAs/i);
    expect(installCmd.includes("\r\n")).toBe(true);

    const printPs = textOf(files, "windows/Print-BeingsBallots.ps1");
    expect(printPs).toMatch(/Windows\.Data\.Pdf\.PdfDocument/);
    expect(printPs).toMatch(/RenderToStreamAsync/);
    expect(printPs).toMatch(/System\.Drawing\.Printing\.PrintDocument/);
    expect(printPs).toMatch(/StandardPrintController/);
    expect(printPs).toMatch(/Windows built-in/);
    expect(printPs).not.toMatch(/-Verb\s+PrintTo|Verb PrintTo/);

    const scanPs = textOf(files, "windows/Scan-BeingsBatch.ps1");
    expect(scanPs).toMatch(/WIA_FORMAT_BMP/);
    expect(scanPs).toMatch(/BinaryData/);
    expect(scanPs).toMatch(/System\.Drawing/);
    expect(scanPs).toMatch(/step \$\{step\}/);
    expect(scanPs).not.toMatch(/FormatID/);
    expect(scanPs).not.toMatch(/WIA_FORMAT_PNG/);

    const ps1 = textOf(files, "Install-BEINGS-Helper.ps1");
    expect(ps1).toMatch(/https:\/\/nodejs\.org\/dist\//);
    expect(ps1).toMatch(/SHASUMS256\.txt/);
    expect(ps1).toMatch(/Windows built-in/);
    expect(ps1).not.toMatch(/sumatrapdfreader\.org/);
    expect(ps1).not.toMatch(/Install-SumatraPdf/);
    expect(ps1).toMatch(/LOCALAPPDATA/);
    expect(ps1).toMatch(/Start BEINGS helper/);
    expect(ps1).toMatch(/Stop BEINGS helper/);
    expect(ps1).toMatch(/Startup/);
    expect(ps1).toMatch(/will start in the background when you sign in/i);
    expect(ps1).toMatch(/beings-helper:\/\/start/);
    expect(ps1).toMatch(/Write-InstallStamp/);
    expect(ps1).toMatch(/Stop-BeingsHelper/);
    expect(ps1).toMatch(/no window to keep open/i);
    expect(ps1).not.toMatch(/RunAsAdministrator|Verb RunAs|Start-Process -Verb RunAs/i);
    expect(ps1).not.toMatch(/SCANNER_UPLOAD_TOKEN/);
    expect(ps1.includes("\r\n")).toBe(true);

    for (const f of files) {
      if (!/\.(mjs|js|json|md|txt|ps1|cmd)$/i.test(f.name)) continue;
      const text = f.data.toString("utf8");
      for (const re of SECRET_BODY) expect(text, f.name).not.toMatch(re);
    }

    const published = readFileSync(publishedZip);
    expect(published.equals(readFileSync(first.zipPath))).toBe(true);
    const shaFile = readFileSync(join(downloads, "BEINGS-Scanner-Helper-Windows.sha256"), "utf8").trim();
    expect(shaFile.startsWith(first.sha256)).toBe(true);
    const mod = readFileSync(join(downloads, "helper-download.js"), "utf8");
    expect(mod).toContain(first.sha256);
    expect(mod).toContain(String(first.bytes));
  }, 120000);

  it("parses the installer, the print script, and the scan script with PowerShell", () => {
    const paths = [
      join(helperRoot, "bundle/Install-BEINGS-Helper.ps1"),
      join(helperRoot, "bundle/Write-InstallStamp.ps1"),
      join(helperRoot, "bundle/Uninstall-BEINGS-Helper.ps1"),
      join(helperRoot, "windows/Print-BeingsBallots.ps1"),
      join(helperRoot, "windows/Scan-BeingsBatch.ps1"),
    ];
    for (const path of paths) {
      let out = "";
      try {
        out = execFileSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$errors=$null; $tokens=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile($env:BEINGS_PS1, [ref]$tokens, [ref]$errors); if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.ToString() }; exit 1 }; Write-Output 'parsed'",
          ],
          { env: { ...process.env, BEINGS_PS1: path }, encoding: "utf8" },
        );
      } catch (e) {
        const stderr = e.stderr ? String(e.stderr) : "";
        const stdout = e.stdout ? String(e.stdout) : "";
        throw new Error(`PowerShell parse failed for ${path}.\n${stdout}\n${stderr}`);
      }
      expect(out).toMatch(/parsed/);
    }
  });
});
