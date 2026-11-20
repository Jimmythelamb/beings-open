// The per-user setup script. Compiled with makensis when it is installed.
// The full exe (with the pinned Node runtime) is built by tools/build-windows-installer.mjs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const nsi = readFileSync(join(root, "windows/installer/beings-helper.nsi"), "utf8");

function hasMakensis() {
  try {
    execFileSync("makensis", ["-VERSION"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("setup script", () => {
  it("is a per-user installer with autostart, a hidden launcher, and an uninstaller", () => {
    expect(nsi).toMatch(/RequestExecutionLevel user/);
    expect(nsi).not.toMatch(/RequestExecutionLevel admin|RunAs/i);
    expect(nsi).toMatch(/\$LOCALAPPDATA\\BEINGS\\scanner-helper/);
    expect(nsi).toMatch(/HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
    expect(nsi).toMatch(/beings-helper/);
    expect(nsi).toMatch(/Launch-BEINGS-Helper\.vbs/);
    expect(nsi).toMatch(/Stop-BEINGS-Helper\.vbs/);
    expect(nsi).toMatch(/Start BEINGS helper/);
    expect(nsi).toMatch(/Stop BEINGS helper/);
    expect(nsi).toMatch(/Write-InstallStamp\.ps1/);
    expect(nsi).toMatch(/WriteUninstaller/);
    expect(nsi).toMatch(/Uninstall\\BEINGS scanner helper/);
    expect(nsi).toMatch(/Installed\. You can close this/);
    expect(nsi).toMatch(/More info, then Run anyway/);
    expect(nsi).not.toMatch(/SCANNER_UPLOAD_TOKEN/);
    expect(nsi).toMatch(/cli\.mjs\*bridge/);
  });

  it("compiles with makensis", () => {
    if (!hasMakensis()) return;
    const dir = mkdtempSync(join(tmpdir(), "beings-nsi-"));
    const stage = join(dir, "stage");
    execFileSync("mkdir", ["-p", stage]);
    writeFileSync(join(stage, "version.txt"), "0.2.0\r\n");
    writeFileSync(join(stage, "Write-InstallStamp.ps1"), "Write-Output installed\r\n");
    writeFileSync(join(stage, "Launch-BEINGS-Helper.vbs"), "' launch\r\n");
    writeFileSync(join(stage, "Stop-BEINGS-Helper.vbs"), "' stop\r\n");
    const out = join(dir, "BEINGS-Scanner-Helper-Setup.exe");
    const script = nsi.replaceAll("@VERSION@", "0.2.0").replaceAll("@STAGE@", stage).replaceAll("@OUT@", out);
    const nsiPath = join(dir, "setup.nsi");
    writeFileSync(nsiPath, script);
    execFileSync("makensis", ["-V2", nsiPath], { stdio: ["ignore", "pipe", "pipe"] });
    const exe = readFileSync(out);
    expect(exe.subarray(0, 2).toString()).toBe("MZ");
    expect(exe.length).toBeGreaterThan(10000);
  });
});
