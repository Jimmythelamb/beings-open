// @vitest-environment happy-dom
// Connect printer & scanner: four states, the seen flag, protocol fallback, version compare, and a 403 preview.
import { describe, expect, it } from "vitest";
import {
  ALREADY_LABEL,
  CONNECT_LABEL,
  HEALTH_TIMEOUT_MS,
  HELPER_DOWNLOADED_AT_KEY,
  HELPER_SEEN_KEY,
  PROTOCOL_FALLBACK,
  PROTOCOL_URL,
  START_LABEL,
  START_WAIT_MS,
  compareVersions,
  connectState,
  connectStatusElement,
  downloadIsRecent,
  forbiddenOriginMessage,
  helperConnectCard,
  isUpdateAvailable,
  launchHelperProtocol,
  probeHelper,
  relinkStation,
  waitForHelper,
} from "../public/js/helper-connect.js";
import { FIND_TIMEOUT_MS, printerPortRank, pickDevices } from "../public/js/scanner-station.js";

const memory = () => {
  const mem: Record<string, string> = {};
  return {
    mem,
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
  };
};

const brotherScanner = { deviceId: "{X}\\0001", name: "Brother DCP-L2640DW", manufacturer: "Brother", connection: "network" };
const brw = { name: "Brother DCP-L2640DW", driver: "Brother DCP-L2640DW Printer", port: "BRW123456789ABC", connection: "network", status: "Normal" };
const wsd = { name: "Brother DCP-L2640DW (WSD)", driver: "Brother DCP-L2640DW Printer", port: "WSD-1234", connection: "network", status: "Normal" };

function text(node: ParentNode) {
  return node.textContent ?? "";
}

describe("version compare", () => {
  it("treats a lower helper version as an update, and equal or newer as current", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.2.0")).toBe(1);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(isUpdateAvailable("0.1.0", "0.2.0")).toBe(true);
    expect(isUpdateAvailable("0.2.0", "0.2.0")).toBe(false);
    expect(isUpdateAvailable("", "0.2.0")).toBe(false);
  });
});

describe("connect states", () => {
  const publishedVersion = "0.2.0";
  it("offers a download when the helper was never seen", () => {
    const state = connectState({ probe: { ok: false, reason: "not-running" }, seen: false, publishedVersion });
    expect(state.state).toBe("not-installed");
    const el = connectStatusElement({ state: state.state });
    expect(el.getAttribute("data-connect-state")).toBe("not-installed");
    expect(el.querySelector("[data-helper-download]")).toBeTruthy();
    expect(text(el)).toMatch(/More info, then Run anyway/);
    expect(text(el)).toMatch(/not code-signed/);
    expect(text(el)).toMatch(/no window to keep open/i);
    expect(el.querySelector("[data-helper-already]")?.textContent).toBe(ALREADY_LABEL);
  });

  it("remembers a recent download and does not offer it again", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(downloadIsRecent("2026-11-16T11:00:00Z", now)).toBe(true);
    expect(downloadIsRecent("2026-11-10T11:00:00Z", now)).toBe(false);
    const state = connectState({ probe: { ok: false, reason: "not-running" }, seen: false, downloadedAt: "2026-11-16T11:00:00Z", now, publishedVersion });
    expect(state.recentDownload).toBe(true);
    const el = connectStatusElement({ state: "not-installed", recentDownload: true });
    expect(el.querySelector("[data-helper-download]")).toBeNull();
    expect(el.querySelector("[data-helper-recent-download]")?.textContent).toMatch(/downloaded the installer recently/);
    expect(el.querySelector("[data-helper-download-again]")).toBeTruthy();
  });

  it("shows start steps when the seen flag is set and the helper is not running", () => {
    const state = connectState({ probe: { ok: false, reason: "not-running" }, seen: true, publishedVersion });
    expect(state.state).toBe("installed-not-running");
    const el = connectStatusElement({ state: state.state });
    expect(el.querySelector("[data-helper-download]")).toBeNull();
    expect(el.querySelector("[data-helper-start]")?.textContent).toBe(START_LABEL);
    expect(text(el)).toMatch(/Start menu/);
    expect(text(el)).toContain(PROTOCOL_FALLBACK);
    expect(text(el)).toMatch(/no window to keep open/i);
  });

  it("shows scanner and printer checkmarks when the helper is running", () => {
    const state = connectState({
      probe: { ok: true, health: { version: "0.2.0" }, station: { scanners: [brotherScanner], printers: [brw] } },
      seen: true,
      publishedVersion,
    });
    expect(state.state).toBe("running");
    const linked = relinkStation({ scanners: [brotherScanner], printers: [brw, wsd] }, { choice: { deviceId: brotherScanner.deviceId, name: brotherScanner.name } });
    expect(linked.scanner?.deviceId).toBe(brotherScanner.deviceId);
    expect(linked.printer?.port).toMatch(/^BRW/);
    const el = connectStatusElement({ state: "running", scanner: linked.scanner, printer: linked.printer, restoredScanner: true });
    expect(el.querySelector("[data-connect-device='scanner']")?.textContent).toMatch(/Brother DCP-L2640DW/);
    expect(el.querySelector("[data-connect-device='printer']")?.textContent).toMatch(/BRW123456789ABC/);
    expect(el.querySelectorAll(".icon").length).toBeGreaterThan(0);
    expect(el.querySelector("[data-helper-download]")).toBeNull();
    expect(text(el)).toMatch(/confirmed before/);
  });

  it("shows Update available when the running helper is older than the published one", () => {
    const state = connectState({
      probe: { ok: true, health: { version: "0.1.0", installedAt: "2026-11-01T00:00:00Z" } },
      seen: true,
      publishedVersion,
    });
    expect(state.state).toBe("update-available");
    const el = connectStatusElement({ state: state.state, version: "0.1.0", publishedVersion, scanner: brotherScanner, printer: brw });
    expect(el.querySelector("[data-helper-update]")?.textContent).toMatch(/Update available/);
    expect(el.querySelector("[data-helper-update]")?.textContent).toMatch(/0\.1\.0/);
    expect(el.querySelector("[data-helper-download]")).toBeTruthy();
  });
});

describe("403 and protocol fallback", () => {
  it("explains a preview origin without offering a download", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: "no" }) });
    const probe = await probeHelper({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"] });
    expect(probe.reason).toBe("forbidden-origin");
    const el = connectStatusElement({ state: "forbidden", pageOrigin: "https://deploy-preview-3--beingsvote.netlify.app" });
    expect(text(el)).toMatch(/preview page/);
    expect(text(el)).toMatch(/--allow-origin https:\/\/deploy-preview-3--beingsvote\.netlify\.app/);
    expect(text(el)).toMatch(/https:\/\/beingsvote\.live/);
    expect(el.querySelector("[data-helper-download]")).toBeNull();
    expect(forbiddenOriginMessage("https://deploy-preview-3--beingsvote.netlify.app")).toMatch(/Stop BEINGS helper/);
  });

  it("falls back to the Start menu when the protocol cannot start the helper", async () => {
    const flags = memory();
    flags.setItem(HELPER_SEEN_KEY, "1");
    let t = 0;
    const opened: string[] = [];
    const card = helperConnectCard({
      probeOnLoad: false,
      flagStorage: flags as any,
      storage: memory() as any,
      choiceStorage: memory() as any,
      publishedVersion: "0.2.0",
      openImpl: (url: string) => {
        opened.push(url);
        return false;
      },
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      fetchImpl: async () => { throw new TypeError("down"); },
    });
    card.connectButton.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(CONNECT_LABEL).toBe("Connect printer & scanner (Windows PC)");
    expect(card.root.textContent).toContain(CONNECT_LABEL);
    expect(card.root.querySelector("[data-connect-state]")?.getAttribute("data-connect-state")).toBe("installed-not-running");
    const start = card.root.querySelector("[data-helper-start]") as HTMLButtonElement;
    start.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([PROTOCOL_URL]);
    expect(t).toBeGreaterThanOrEqual(START_WAIT_MS);
    expect(card.root.querySelector("[data-protocol-fallback]")?.textContent).toContain(PROTOCOL_FALLBACK);
    expect(card.root.querySelector("[data-helper-download]")).toBeNull();
    expect(launchHelperProtocol(() => false)).toBe(false);
    expect(launchHelperProtocol(() => true)).toBe(true);
  });
});

describe("seen flag and relink", () => {
  it("sets beings.helperSeen.v1 on a successful probe and relinks the saved scanner", async () => {
    const flags = memory();
    const choices = memory();
    choices.setItem("beings.scannerDevice.v1", JSON.stringify({ deviceId: brotherScanner.deviceId, name: brotherScanner.name }));
    const confirms = memory();
    confirms.setItem("beings.stationConfirm.v1", JSON.stringify({ scannerName: brotherScanner.name, scannerDeviceId: brotherScanner.deviceId, printerName: brw.name, at: "2026-11-01T00:00:00Z" }));
    let confirmed: any = null;
    const card = helperConnectCard({
      probeOnLoad: false,
      flagStorage: flags as any,
      choiceStorage: choices as any,
      storage: confirms as any,
      publishedVersion: "0.2.0",
      onChange: (c) => { confirmed = c; },
      fetchImpl: async (url: string) => {
        const u = String(url);
        if (u.endsWith("/v1/health")) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, service: "beings-scanner-bridge", version: "0.2.0", installedAt: "2026-11-02T00:00:00Z" }) };
        if (u.endsWith("/v1/station")) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, scanners: [brotherScanner], printers: [wsd, brw], errors: [] }) };
        throw new Error(u);
      },
    });
    card.connectButton.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(flags.mem[HELPER_SEEN_KEY]).toBe("1");
    expect(card.root.querySelector("[data-connect-state]")?.getAttribute("data-connect-state")).toBe("running");
    expect(card.root.querySelector("[data-connect-device='printer']")?.textContent).toMatch(/BRW/);
    expect(confirmed?.scannerDeviceId).toBe(brotherScanner.deviceId);
    expect(confirmed?.printerName).toBe(brw.name);
  });

  it("I already installed it sets the flag without downloading", async () => {
    const flags = memory();
    const card = helperConnectCard({
      probeOnLoad: false,
      flagStorage: flags as any,
      storage: memory() as any,
      fetchImpl: async () => { throw new TypeError("down"); },
    });
    card.connectButton.click();
    await new Promise((r) => setTimeout(r, 20));
    const already = card.root.querySelector("[data-helper-already]") as HTMLButtonElement;
    already.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(flags.mem[HELPER_SEEN_KEY]).toBe("1");
    expect(card.root.querySelector("[data-connect-state]")?.getAttribute("data-connect-state")).toBe("installed-not-running");
    expect(card.root.querySelector("[data-helper-download]")).toBeNull();
  });
});

describe("timeouts and printer port", () => {
  it("waits about 2s for health and 10s to find a station", () => {
    expect(HEALTH_TIMEOUT_MS).toBe(2000);
    expect(FIND_TIMEOUT_MS).toBe(10000);
    expect(START_WAIT_MS).toBe(15000);
  });
  it("prefers the Brother BRW direct port over WSD", () => {
    expect(printerPortRank(brw)).toBeLessThan(printerPortRank(wsd));
    const picked = pickDevices([brotherScanner], [wsd, brw]);
    expect(picked.printer?.port).toBe("BRW123456789ABC");
  });
});

describe("waitForHelper", () => {
  it("returns as soon as health answers, and stops at the wait limit when it does not", async () => {
    let n = 0;
    let t = 0;
    const early = await waitForHelper({
      probe: async () => (++n >= 2 ? { ok: true, health: { version: "0.2.0" } } : { ok: false, reason: "not-running" }),
      waitMs: 15000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    expect(early.ok).toBe(true);
    expect(t).toBe(1000);
    t = 0;
    const late = await waitForHelper({
      probe: async () => ({ ok: false, reason: "not-running" }),
      waitMs: 3000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    expect(late.ok).toBe(false);
    expect(t).toBeGreaterThanOrEqual(3000);
  });
});
