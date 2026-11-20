// @vitest-environment happy-dom
// The Install printer/scanner helper button on Create and Register (both render these cards).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELPER_BRIDGE_COMMAND, HELPER_DOWNLOAD, INSTALL_BUTTON_LABEL, INSTALL_STEPS, helperInstallPanel } from "../public/js/helper-install.js";
import { explainFindFailure, findFailureNeedsInstall, scannerFindCard } from "../public/js/scanner-station.js";
import { testPrintScanCard } from "../public/js/test-print-scan.js";

const site = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const memory = () => {
  const mem: Record<string, string> = {};
  return { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] };
};

function installLink(root: ParentNode) {
  const a = root.querySelector("[data-helper-install]");
  expect(a).toBeTruthy();
  expect(a?.textContent).toBe(INSTALL_BUTTON_LABEL);
  expect(a?.getAttribute("href")).toBe(HELPER_DOWNLOAD.href);
  expect(a?.getAttribute("download")).toBe(HELPER_DOWNLOAD.fileName);
  return a;
}

describe("helper install panel", () => {
  it("shows the download, the steps, and the zip SHA256", () => {
    expect(HELPER_DOWNLOAD.sha256).toMatch(/^[0-9a-f]{64}$/);
    const panel = helperInstallPanel({ handheld: false });
    installLink(panel);
    const text = panel.textContent ?? "";
    for (const step of INSTALL_STEPS) expect(text).toContain(step);
    expect(text).toContain(HELPER_DOWNLOAD.sha256);
    expect(panel.querySelector("[data-helper-sha]")?.getAttribute("data-helper-sha")).toBe(HELPER_DOWNLOAD.sha256);
    expect(text).toMatch(/Windows PC that has the printer and scanner/);
    expect(text).toMatch(/iPad or phone cannot run the helper/);
    expect(text).toMatch(/SmartScreen/);
    expect(text).toMatch(/Connect printer & scanner \(Windows PC\)/);
    expect(text).toMatch(/no window to keep open/i);
    expect(panel.querySelector("[data-helper-phone]")).toBeNull();
  });

  it("tells an iPad or phone to use the Windows PC", () => {
    const panel = helperInstallPanel({ handheld: true });
    const note = panel.querySelector("[data-helper-phone]");
    expect(note?.textContent).toMatch(/iPad or phone/);
    expect(note?.textContent).toMatch(/Windows PC/);
    expect(note?.textContent).toMatch(/cannot run on this device/);
  });
});

describe("Find and test cards", () => {
  it("points Not found at Connect, and keeps the command collapsed", async () => {
    const card = scannerFindCard({
      storage: memory() as any,
      fetchImpl: async () => {
        throw new TypeError("failed");
      },
    });
    expect(card.root.querySelector("[data-helper-install]")).toBeNull();
    expect(card.root.textContent).toContain("Connect printer & scanner (Windows PC)");
    card.findButton.click();
    await new Promise((r) => setTimeout(r, 30));
    const warn = card.root.querySelector(".callout-warn");
    expect(warn?.textContent).toMatch(/Not found/);
    expect(warn?.textContent).toMatch(/Connect printer & scanner \(Windows PC\)/);
    expect(warn?.textContent).not.toMatch(/node src\\cli/);
    expect(warn?.textContent).toMatch(/no window to keep open/i);
    const details = card.root.querySelector("[data-helper-advanced]");
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.textContent).toContain(HELPER_BRIDGE_COMMAND);
    expect(findFailureNeedsInstall("not-running")).toBe(true);
    expect(findFailureNeedsInstall("no-devices")).toBe(false);
    expect(explainFindFailure("not-running")).not.toMatch(/node src\\cli/);
  });

  it("does not offer another download when the test cannot start", async () => {
    const card = testPrintScanCard({
      storage: memory() as any,
      fetchImpl: async () => {
        throw new TypeError("failed");
      },
    });
    expect(card.root.querySelector("[data-helper-install]")).toBeNull();
    card.startButton.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(card.root.textContent).toMatch(/Could not start the test/);
    expect(card.root.querySelector("[data-helper-install]")).toBeNull();
    expect(card.root.textContent).toMatch(/Connect printer & scanner \(Windows PC\)/);
    expect(card.root.textContent).toMatch(/never blocked/);
    expect(card.root.textContent).toMatch(/no window to keep open/i);
  });

  it("is what Create and Register render, and Netlify rebuilds the zip", () => {
    const admin = readFileSync(site("public/js/admin.js"), "utf8");
    expect(admin).toMatch(/helperConnectCard\(\)\.root/);
    expect(admin).toMatch(/helperConnectCard\(\{/);
    expect(admin).toMatch(/testPrintScanCard\(\)\.root/);
    expect(admin).toMatch(/systemCheckCard\(\)\.root/);
    expect(admin).toMatch(/testPrintScanCard\(\{/);
    const toml = readFileSync(site("netlify.toml"), "utf8");
    expect(toml).toMatch(/node \.\.\/\.\.\/packages\/scanner-helper\/tools\/build-windows-bundle\.mjs/);
    expect(toml).toMatch(/http:\/\/\[::1\]:8765/);
    const sha = readFileSync(site("public/downloads/BEINGS-Scanner-Helper-Windows.sha256"), "utf8");
    const zipSha = HELPER_DOWNLOAD.zip?.sha256 || (HELPER_DOWNLOAD.fileName.endsWith(".zip") ? HELPER_DOWNLOAD.sha256 : "");
    expect(sha).toContain(zipSha);
  });
});
