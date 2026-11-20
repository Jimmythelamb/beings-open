import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickScanner } from "../src/pick-scanner.mjs";

const wsd = { deviceId: "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000", name: "Brother DCP-L2640DW [94ddf81050c9]", manufacturer: "Microsoft", port: "urn:uuid:example:ScannerService", connection: "network" };
const lan = { deviceId: "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0002", name: "Brother DCP-L2640DW LAN", manufacturer: "Brother", port: "AUTO", connection: "unknown" };
const hp = { deviceId: "{X}\\0003", name: "HP LaserJet Pro M404", manufacturer: "HP", connection: "network" };

describe("pickScanner", () => {
  it("keeps the Brother driver when Windows lists the same model twice", () => {
    const r = pickScanner([wsd, lan]);
    expect(r.ok).toBe(true);
    expect(r.auto).toBe(true);
    expect(r.sameModel).toBe(true);
    expect(r.device.deviceId).toBe(lan.deviceId);
    expect(r.device.name).toMatch(/LAN/);
  });
  it("does not guess when the scanners are different models", () => {
    const r = pickScanner([lan, hp]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Brother DCP-L2640DW LAN/);
    expect(r.error).toMatch(/HP LaserJet Pro M404/);
    expect(r.error).toMatch(/Choose the one on this desk/);
  });
  it("returns the only scanner without calling it a guess", () => {
    const r = pickScanner([lan]);
    expect(r).toMatchObject({ ok: true, auto: false, device: lan });
  });
});

describe("Select-BeingsScanner.ps1", () => {
  it("picks the Brother LAN entry and refuses two models", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "../windows/Select-BeingsScanner.ps1");
    const out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
      . $env:BEINGS_SELECT
      $wsd = [pscustomobject]@{ deviceId = 'a'; name = 'Brother DCP-L2640DW [94ddf81050c9]'; manufacturer = 'Microsoft' }
      $lan = [pscustomobject]@{ deviceId = 'b'; name = 'Brother DCP-L2640DW LAN'; manufacturer = 'Brother' }
      $hp = [pscustomobject]@{ deviceId = 'c'; name = 'HP LaserJet Pro M404'; manufacturer = 'HP' }
      $same = Select-BeingsScanner @($wsd, $lan)
      $diff = Select-BeingsScanner @($lan, $hp)
      if (-not $same.ok -or $same.device.deviceId -ne 'b') { Write-Output 'same-fail'; exit 1 }
      if ($diff.ok) { Write-Output 'diff-fail'; exit 1 }
      if ($diff.error -notmatch 'Brother DCP-L2640DW LAN' -or $diff.error -notmatch 'HP LaserJet Pro M404') { Write-Output $diff.error; exit 1 }
      Write-Output 'picked'
    `], { env: { ...process.env, BEINGS_SELECT: script }, encoding: "utf8" });
    expect(out).toMatch(/picked/);
  });
});
