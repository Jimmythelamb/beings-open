// @vitest-environment happy-dom
// iPad / iPhone checks on the admin page. No network, no wallet prompt, no scan, no upload.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IOS_DEVICE_BUTTON,
  IOS_SCANNER_NOTE,
  IOS_STATION_BUTTON,
  STATION_MEMORY_KEY,
  assessBrowser,
  assessStationPayload,
  assessWallet,
  buildAirPrintTestPdf,
  isAppleTouchDevice,
  parseStationAddress,
  probeStation,
} from "../public/js/ios-device-check.js";
import { systemCheckCard } from "../public/js/system-check.js";
import { testPrintScanCard } from "../public/js/test-print-scan.js";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const ADDR = "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D";

describe("iPad and iPhone detection", () => {
  it("recognises an iPhone, an iPad, and an iPad that reports itself as a Mac", () => {
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", maxTouchPoints: 5, platform: "iPhone" })).toBe(true);
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", maxTouchPoints: 5, platform: "iPad" })).toBe(true);
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 5, platform: "MacIntel" })).toBe(true);
  });
  it("does not treat a desktop Mac, Windows, or Android as this iPad check", () => {
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 0, platform: "MacIntel" })).toBe(false);
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 10, platform: "Win32" })).toBe(false);
    expect(isAppleTouchDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome Mobile", maxTouchPoints: 5, platform: "Linux armv8l" })).toBe(false);
    expect(isAppleTouchDevice(null)).toBe(false);
  });
});

describe("wallet, browser, and test print", () => {
  it("shortens the address and does not print the full one", () => {
    const pass = assessWallet({ hasInjected: true, address: ADDR, chainId: 114, balanceWei: 1n });
    expect(pass[0]?.level).toBe("ok");
    expect(pass[0]?.detail).toContain("Coston2");
    expect(pass[0]?.detail).toContain("C2FLR");
    expect(pass[0]?.detail).not.toContain(ADDR);
    const empty = assessWallet({ hasInjected: true, address: ADDR, chainId: "0x72", balanceWei: 0n });
    expect(empty[0]?.level).toBe("warn");
    expect(empty[0]?.detail).toMatch(/no C2FLR/);
    expect(empty[0]?.detail).not.toContain(ADDR);
    expect(assessWallet({ hasInjected: true, address: ADDR, chainId: 1, balanceWei: 5n })[0]?.detail).toMatch(/not on Flare Coston2/);
    expect(assessWallet({ hasInjected: false, address: null })[0]?.level).toBe("warn");
  });
  it("reports pass or fail for the browser features the admin pages need", () => {
    const mem = new Map<string, string>();
    const ok = assessBrowser({
      crypto: { subtle: { digest: () => Promise.resolve(new ArrayBuffer(0)) } },
      fetch: () => Promise.resolve(),
      localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) },
      Blob: class {},
      URL: { createObjectURL: () => "blob:test" },
    });
    expect(ok.map((c) => c.level)).toEqual(["ok", "ok", "ok", "ok"]);
    const bad = assessBrowser({});
    expect(bad.every((c) => c.level === "fail")).toBe(true);
    expect(bad.map((c) => c.id)).toEqual(["crypto", "fetch", "storage", "download"]);
  });
  it("builds a one-page TEST pdf with no election data", () => {
    const text = new TextDecoder().decode(buildAirPrintTestPdf());
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("TEST PAGE");
    expect(text).toContain("NOT A REAL BALLOT");
    expect(text).toContain("/Count 1");
    expect(text).not.toMatch(/BEINGS-\d{4}-/);
    expect(text).not.toMatch(/\b[0-9A-HJKMNP-TV-Z]{12}\b/);
  });
});

describe("remote station status", () => {
  const sample = { ok: true, version: "0.2.0", scanners: [{ name: "Brother DCP-L2640DW", manufacturer: "Brother" }, { name: "iPad Camera", manufacturer: "Apple" }], printers: [{ name: "Brother DCP-L2640DW series" }, { name: "Microsoft Print to PDF" }] };

  it("reports version, sheet-fed scanner, and printer, and ignores a camera", () => {
    const rows = assessStationPayload(sample);
    expect(rows.find((r) => r.id === "reach")?.level).toBe("ok");
    expect(rows.find((r) => r.id === "version")?.detail).toContain("0.2.0");
    expect(rows.find((r) => r.id === "scanner")?.detail).toContain("Brother DCP-L2640DW");
    expect(rows.find((r) => r.id === "scanner")?.detail).not.toMatch(/iPad Camera/);
    expect(rows.find((r) => r.id === "printer")?.detail).toContain("Brother");
    expect(rows.find((r) => r.id === "printer")?.detail).not.toMatch(/Print to PDF/);
  });
  it("accepts only a local address and always calls the read-only status path", () => {
    expect(parseStationAddress("192.168.1.20").statusUrl).toBe("http://192.168.1.20:8765/v1/station");
    expect(parseStationAddress("https://printer.local:8443/v1/scan").statusUrl).toBe("https://printer.local:8443/v1/station");
    expect(parseStationAddress("https://example.com").ok).toBe(false);
    expect(parseStationAddress("8.8.8.8").ok).toBe(false);
  });
  it("reads status with GET and does not scan or upload", async () => {
    const calls: { url: string; method?: string }[] = [];
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] };
    const result = await probeStation({
      raw: "192.168.1.20",
      pageProtocol: "http:",
      storage,
      fetchImpl: async (url: string, opts?: { method?: string }) => {
        calls.push({ url: String(url), method: opts?.method });
        if (opts?.method !== "GET" || !String(url).endsWith("/v1/station")) throw new Error("not a read-only status read");
        return { ok: true, status: 200, json: async () => sample };
      },
    });
    expect(calls).toEqual([{ url: "http://192.168.1.20:8765/v1/station", method: "GET" }]);
    expect(result.checks.find((c) => c.id === "scanner")?.level).toBe("ok");
    expect(JSON.parse(mem[STATION_MEMORY_KEY])).toEqual(["http://192.168.1.20:8765"]);
    expect(result.requested).toBe("http://192.168.1.20:8765/v1/station");
    expect(calls.some((c) => /\/v1\/scan|\/v1\/test|\/v1\/diagnostics\/fix/.test(c.url))).toBe(false);
  });
  it("explains mixed content and a blocked local network instead of a generic error", async () => {
    let called = false;
    const mixed = await probeStation({
      raw: "192.168.1.20",
      pageProtocol: "https:",
      fetchImpl: async () => {
        called = true;
        throw new Error("should not be called");
      },
    });
    expect(called).toBe(false);
    expect(mixed.checks.find((c) => c.id === "reach")?.detail).toMatch(/secure local access/);
    expect(mixed.checks.find((c) => c.id === "reach")?.detail).toMatch(/plain HTTP/);
    const blocked = await probeStation({
      raw: "https://printer.local",
      pageProtocol: "https:",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(blocked.checks.find((c) => c.id === "reach")?.detail).toMatch(/secure local access|blocked the call/);
    expect(blocked.checks.map((c) => c.detail).join(" ")).toMatch(/Nothing was scanned or uploaded/);
  });
});

describe("admin page controls", () => {
  it("shows the iPad device check and a calm scanner note instead of the helper warning", async () => {
    const card = systemCheckCard({
      ios: true,
      fetchImpl: async () => {
        throw new TypeError("no helper");
      },
      printImpl: async () => ({ printed: true, opened: true }),
      walletFacts: async () => ({ hasInjected: true, address: ADDR, chainId: 114, balanceWei: 2n }),
      featureEnv: {
        crypto: { subtle: { digest: () => Promise.resolve(new ArrayBuffer(0)) } },
        fetch: () => Promise.resolve(),
        localStorage: { getItem: () => "1", setItem: () => {}, removeItem: () => {} },
        Blob: class {},
        URL: { createObjectURL: () => "blob:test" },
      },
    });
    expect(card.iosButton?.textContent).toBe(IOS_DEVICE_BUTTON);
    card.runButton.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(card.root.textContent).toContain(IOS_SCANNER_NOTE);
    expect(card.root.textContent).toMatch(/Windows PC or the local server/);
    expect(card.root.textContent).toMatch(/camera is not used/);
    expect(card.root.textContent).not.toMatch(/Helper not running/);
    card.iosButton?.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(card.root.textContent).toMatch(/Pass: Test print/);
    expect(card.root.textContent).toMatch(/Pass: Wallet/);
    expect(card.root.textContent).not.toContain(ADDR);
    expect(card.root.textContent).toMatch(/Pass: Cryptography/);
    expect(card.root.textContent).toContain(IOS_SCANNER_NOTE);
  });
  it("offers the remote scanner test on iOS and keeps the helper test off this device", async () => {
    const calls: string[] = [];
    const card = testPrintScanCard({
      mobile: true,
      ios: true,
      pageProtocol: "http:",
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetchImpl: (async (url: string, opts?: { method?: string }) => {
        calls.push(`${opts?.method ?? "GET"} ${url}`);
        if (opts?.method !== "GET" || !String(url).endsWith("/v1/station")) throw new Error("unexpected " + url);
        return { ok: true, status: 200, json: async () => sampleStation() };
      }) as any,
    });
    expect(card.root.textContent).toContain(IOS_STATION_BUTTON);
    expect(card.stationButton).toBeTruthy();
    card.startButton.click();
    expect(calls).toEqual([]);
    card.stationInput.value = "10.0.0.8";
    card.stationButton.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toEqual(["GET http://10.0.0.8:8765/v1/station"]);
    expect(card.root.textContent).toMatch(/Pass: Station reachable/);
    expect(card.root.textContent).toMatch(/Helper version 0\.2\.0/);
    expect(card.root.textContent).not.toMatch(/\/v1\/scan|\/v1\/test/);
  });
});

function sampleStation() {
  return { version: "0.2.0", scanners: [{ name: "Brother DCP-L2640DW" }], printers: [{ name: "Brother DCP-L2640DW series" }] };
}

describe("setup form stylesheet", () => {
  it("uses a shrinking grid and groups the ballot image options", () => {
    const css = src("../public/css/app.css");
    const admin = src("../public/js/admin.js");
    expect(admin).toMatch(/h\("div", \{ class: "grid" \}, nameIn, codeIn, opens, closes, reg, quorum\)/);
    expect(admin).toMatch(/publicRow,\s*days,/);
    expect(admin).toContain("ballot-image-options");
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/min-width: 0/);
    expect(css).toContain("ballot-image-options");
    expect(css).toMatch(/height: 48px/);
  });
});
