// Find-and-confirm the Local Scanner/Printer: pure helpers, mock helper responses, CSP. No network, no wallet, no secrets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_CANDIDATES,
  pickScanner,
  classifyBridgeResponse,
  confirmationFromView,
  connectionLabel,
  describeStation,
  explainFindFailure,
  findStation,
  isVirtualPrinter,
  pickDevices,
  publicStationWallet,
  readStoredConfirmation,
  registerEnabled,
  writeStoredConfirmation,
} from "../public/js/scanner-station.js";

const site = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const brotherScanner = { deviceId: "{X}\\0001", name: "Brother DCP-L2640DW", manufacturer: "Brother", connection: "network" };
const brotherPrinter = { name: "Brother DCP-L2640DW series", driver: "Brother DCP-L2640DW Printer", connection: "network", status: "Normal" };
const pdfPrinter = { name: "Microsoft Print to PDF", driver: "Microsoft Print To PDF", connection: "other", status: "Normal" };
const classroomWallet = { address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", label: "Classroom station" };

describe("device picking", () => {
  it("keeps the Brother driver when the same model is listed twice", () => {
    const wsd = { deviceId: "a", name: "Brother DCP-L2640DW [94ddf81050c9]", manufacturer: "Microsoft", connection: "network" };
    const lan = { deviceId: "b", name: "Brother DCP-L2640DW LAN", manufacturer: "Brother", connection: "network" };
    const picked = pickScanner([wsd, lan]);
    expect(picked.ok).toBe(true);
    expect(picked.device.deviceId).toBe("b");
    const devices = pickDevices([wsd, lan], [brotherPrinter]);
    expect(devices.scannerNeedsChoice).toBe(true);
    expect(devices.scanner.deviceId).toBe("b");
    expect(devices.sameModel).toBe(true);
  });
  it("hides virtual printers and prefers a matching Brother pair", () => {
    expect(isVirtualPrinter(pdfPrinter)).toBe(true);
    expect(isVirtualPrinter(brotherPrinter)).toBe(false);
    const p = pickDevices([brotherScanner], [pdfPrinter, brotherPrinter]);
    expect(p.hiddenVirtual).toBe(1);
    expect(p.scanner.name).toMatch(/DCP-L2640DW/);
    expect(p.printer.name).toMatch(/DCP-L2640DW/);
    expect(p.scannerNeedsChoice).toBe(false);
  });
  it("asks for a choice when more than one real device is present", () => {
    const p = pickDevices([brotherScanner, { name: "Other Scanner", connection: "usb" }], [brotherPrinter, { name: "Office Laser", connection: "usb" }]);
    expect(p.scannerNeedsChoice).toBe(true);
    expect(p.printerNeedsChoice).toBe(true);
    expect(p.scanner.name).toMatch(/Brother/);
  });
  it("labels USB and Wi-Fi clearly", () => {
    expect(connectionLabel("usb")).toBe("USB");
    expect(connectionLabel("network")).toBe("Wi-Fi or network");
    expect(connectionLabel("unknown")).toBe("connection unknown");
  });
});

describe("describeStation", () => {
  it("titles a Brother all-in-one as Found: <model> and allows confirm", () => {
    const v = describeStation({ ok: true, scanners: [brotherScanner], printers: [brotherPrinter, pdfPrinter], stationWallet: classroomWallet, errors: [] });
    expect(v.kind).toBe("found");
    expect(v.title).toBe("Found: Brother DCP-L2640DW");
    expect(v.canConfirm).toBe(true);
    expect(v.wallet?.address).toBe(classroomWallet.address);
    const conf = confirmationFromView(v);
    expect(conf?.scannerName).toBe("Brother DCP-L2640DW");
    expect(conf?.printerName).toMatch(/DCP-L2640DW/);
    expect(conf?.stationWallet?.address).toBe(classroomWallet.address);
  });
  it("allows confirm with a warning when only a scanner is found", () => {
    const v = describeStation({ scanners: [brotherScanner], printers: [pdfPrinter], errors: [] });
    expect(v.kind).toBe("scanner-only");
    expect(v.canConfirm).toBe(true);
    expect(v.help).toMatch(/did not report a usable printer/i);
  });
  it("does not allow confirm when only a printer is found", () => {
    const v = describeStation({ scanners: [], printers: [brotherPrinter], errors: [] });
    expect(v.kind).toBe("printer-only");
    expect(v.canConfirm).toBe(false);
    expect(confirmationFromView(v)).toBeNull();
  });
  it("is Not found when the helper reports no devices", () => {
    const v = describeStation({ scanners: [], printers: [], errors: [] });
    expect(v.kind).toBe("no-devices");
    expect(v.canConfirm).toBe(false);
    expect(v.help).toMatch(/Printers & scanners/);
  });
  it("does not invent a wallet from a bad value", () => {
    expect(publicStationWallet({ address: "nope" })).toBeNull();
    expect(publicStationWallet(classroomWallet)?.address).toBe(classroomWallet.address);
  });
});

describe("failure help", () => {
  it("tells the teacher to use the polling PC and start the helper when it is not answering", () => {
    const t = explainFindFailure("not-running");
    expect(t).toMatch(/Not found/);
    expect(t).toMatch(/not a phone or tablet/);
    expect(t).toMatch(/scanner helper/);
    expect(t).toMatch(/Brother/);
    expect(t).toMatch(/Connect printer & scanner \(Windows PC\)/);
    expect(t).toMatch(/Start helper/);
    expect(t).toMatch(/no window to keep open/i);
    expect(t).not.toMatch(/node src\\cli/);
  });
  it("explains a preview-site origin refusal with --allow-origin and this page's address", () => {
    const t = explainFindFailure("forbidden-origin", { pageOrigin: "https://deploy-preview-3--beingsvote.netlify.app" });
    expect(t).toMatch(/not allowing this web page/);
    expect(t).toMatch(/--allow-origin https:\/\/deploy-preview-3--beingsvote\.netlify\.app/);
    expect(t).toMatch(/https:\/\/beingsvote\.live/);
  });
  it("explains an empty Windows device list without pretending a machine was seen", () => {
    expect(explainFindFailure("no-devices")).toMatch(/did not report a scanner/);
    expect(explainFindFailure("list-failed")).toMatch(/could not list devices/);
    expect(explainFindFailure("timeout")).toMatch(/no answer in time/);
  });
});

describe("register gating", () => {
  it("enables Register whenever the organizer can register, even without a confirmation", () => {
    expect(registerEnabled({ can: true, confirmed: null })).toBe(true);
    expect(registerEnabled({ can: true, confirmed: { scannerName: "Brother DCP-L2640DW" } })).toBe(true);
    expect(registerEnabled({ can: false, confirmed: { scannerName: "Brother DCP-L2640DW" } })).toBe(false);
    expect(registerEnabled({ can: false, confirmed: null })).toBe(false);
  });
});

describe("findStation (mock helper)", () => {
  it("returns the /v1/station payload from 127.0.0.1 when the helper answers", async () => {
    const payload = { ok: true, service: "beings-scanner-bridge", scanners: [brotherScanner], printers: [brotherPrinter], stationWallet: classroomWallet, errors: [] };
    const fetchImpl = async (url: string) => {
      if (String(url).startsWith("http://127.0.0.1:8765/v1/station")) return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      throw new Error("unexpected " + url);
    };
    const r = await findStation({ fetchImpl: fetchImpl as any, bases: [...BRIDGE_CANDIDATES] });
    expect(r.ok).toBe(true);
    expect(r.base).toBe("http://127.0.0.1:8765");
    expect((r as any).payload.scanners[0].name).toMatch(/Brother/);
  });
  it("treats a connection failure as not running, and does not invent a device", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await findStation({ fetchImpl: fetchImpl as any });
    expect(r).toEqual({ ok: false, reason: "not-running" });
  });
  it("treats 403 as a forbidden origin and stops (the helper is running)", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: "this web page is not allowed to use the scanner bridge" }) });
    const r = await findStation({ fetchImpl: fetchImpl as any });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("forbidden-origin");
  });
  it("falls back to health + scanners + printers on an older helper without /v1/station", async () => {
    const fetchImpl = async (url: string) => {
      const u = String(url);
      if (u.endsWith("/v1/station")) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) };
      if (u.endsWith("/v1/health")) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, service: "beings-scanner-bridge", scanning: false }) };
      if (u.endsWith("/v1/scanners")) return { ok: true, status: 200, text: async () => JSON.stringify({ scanners: [brotherScanner] }) };
      if (u.endsWith("/v1/printers")) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) };
      throw new Error(u);
    };
    const r = await findStation({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"] });
    expect(r.ok).toBe(true);
    expect((r as any).legacy).toBe(true);
    expect((r as any).payload.scanners[0].name).toMatch(/Brother/);
    expect((r as any).payload.printers).toEqual([]);
    expect((r as any).payload.stationWallet).toBeNull();
  });
  it("classifies timeout and 403 from a raw response", () => {
    expect(classifyBridgeResponse({ error: "timeout" })).toBe("timeout");
    expect(classifyBridgeResponse({ status: 403, json: { error: "no" } })).toBe("forbidden-origin");
    expect(classifyBridgeResponse({ status: 200, json: { ok: true, service: "beings-scanner-bridge", scanners: [] } })).toBe("ok");
  });
});

describe("confirmation storage", () => {
  it("stores and clears only public device names and an optional public address", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] };
    const conf = { at: "2026-11-10T22:40:00-08:00", scannerName: "Brother DCP-L2640DW", scannerConnection: "network", printerName: "Brother DCP-L2640DW series", printerConnection: "network", stationWallet: classroomWallet, kind: "found" };
    writeStoredConfirmation(storage as any, conf);
    expect(readStoredConfirmation(storage as any)?.scannerName).toBe("Brother DCP-L2640DW");
    expect(JSON.stringify(mem)).not.toMatch(/privateKey|mnemonic/i);
    writeStoredConfirmation(storage as any, null);
    expect(readStoredConfirmation(storage as any)).toBeNull();
  });
});

describe("page wiring and CSP", () => {
  const admin = readFileSync(site("public/js/admin.js"), "utf8");
  const toml = readFileSync(site("netlify.toml"), "utf8");
  it("puts Find my scanner/printer and the optional test print and scan on Create and Register, without blocking either", () => {
    expect(admin).toMatch(/headingWithHelp\("h3", null, "Connect printer & scanner", "create\.findScanner"\)/);
    expect(admin).toMatch(/headingWithHelp\("h3", \{ class: "find-heading" \}, "Connect printer & scanner", "admin\.findScanner"\)/);
    expect(admin).toMatch(/helperConnectCard\(\)\.root/);
    expect(admin).toMatch(/helperConnectCard\(\{/);
    expect(admin).toMatch(/headingWithHelp\("h3", null, "Test print and scan", "create\.testPrintScan"\)/);
    expect(admin).toMatch(/headingWithHelp\("h3", \{ class: "find-heading" \}, "Test print and scan", "admin\.testPrintScan"\)/);
    expect(admin).toMatch(/registerEnabled\(\{ can, confirmed \}\)/);
    expect(admin).toMatch(/testPrintScanAdvisory/);
    expect(admin).not.toMatch(/Confirm the scanner\/printer first/);
  });
  it("allows the page to talk only to the loopback helper, with no connect-src wildcards", () => {
    const csp = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
    expect(csp).toMatch(/http:\/\/127\.0\.0\.1:8765/);
    expect(csp).toMatch(/http:\/\/localhost:8765/);
    const connect = (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src ")) ?? "").split(/\s+/).slice(1);
    expect(connect.some((x) => x.includes("*"))).toBe(false);
  });
});
