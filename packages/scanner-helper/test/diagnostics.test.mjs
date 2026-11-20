import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport, choosePrinter, interpretSpoolerStatus, printerAttemptOrder, printerPortKind, shouldTryAnotherPrinter, probeImageStore, supersedeSyntheticTests, systemCheckImageStoreUrl, unresolvedSyntheticBatches } from "../src/diagnostics.mjs";
import { DEFAULT_IMAGE_STORE_URL } from "../src/upload.mjs";
import { writeBatch } from "./helpers.mjs";

const wsd = { deviceId: "a", name: "Brother DCP-L2640DW [94ddf81050c9]", manufacturer: "Microsoft" };
const lan = { deviceId: "b", name: "Brother DCP-L2640DW LAN", manufacturer: "Brother" };
const brotherPrinter = { name: "Brother DCP-L2640DW series", port: "IP_192.168.1.50", status: "Normal", default: true, connection: "network" };

function report(extra = {}) {
  return buildDiagnosticsReport({
    version: "0.1.0",
    nodeVersion: "22.23.4",
    pdfLib: { present: true, version: "1.17.1" },
    sumatraPath: "C:\\Users\\teacher\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe",
    printers: [brotherPrinter, { name: "Microsoft Print to PDF", port: "PORTPROMPT:", status: "Normal" }],
    scanners: [wsd, lan],
    printerReachable: true,
    outputWritable: true,
    store: { ok: true, status: 400, error: false },
    unresolved: [],
    signInStart: false,
    ...extra,
  });
}

describe("diagnostics report", () => {
  it("prefers a Brother BRW direct port over a WSD queue", () => {
    const brw = { name: "Brother DCP-L2640DW", port: "BRW123456789ABC", status: "Normal", default: false };
    const wsdPrinter = { name: "Brother DCP-L2640DW Printer", port: "WSD-999", status: "Normal", default: true };
    expect(choosePrinter([wsdPrinter, brw]).port).toBe("BRW123456789ABC");
    expect(choosePrinter([brotherPrinter]).port).toBe("IP_192.168.1.50");
    expect(printerPortKind("BRWA8C1D2E3F4")).toBe("brw");
    expect(printerAttemptOrder([wsdPrinter, brw]).map((p) => p.port)).toEqual(["BRW123456789ABC", "WSD-999"]);
  });

  it("explains a Brother direct port instead of saying the address is missing", () => {
    const r = report({ printers: [{ name: "Brother DCP-L2640DW Printer", port: "BRWA8C1D2E3F4", status: "Normal", default: true }], printerReachable: null });
    const net = r.checks.find((c) => c.id === "printer-network");
    expect(net.level).toBe("ok");
    expect(net.detail).toMatch(/Brother direct port/);
    expect(net.detail).not.toMatch(/did not give a network address/);
    const printers = r.checks.find((c) => c.id === "printers");
    expect(printers.options[0].name).toBe("Brother DCP-L2640DW Printer");
  });

  it("reads spooler bits: error, printed, and still waiting", () => {
    expect(interpretSpoolerStatus({ jobStatus: 2, status: "Error" }).state).toBe("error");
    expect(interpretSpoolerStatus({ jobStatus: 128, status: "Printed" }).state).toBe("printed");
    expect(interpretSpoolerStatus({ gone: true }).state).toBe("printed");
    expect(interpretSpoolerStatus({ jobStatus: 16, status: "Printing" }).state).toBe("pending");
    expect(shouldTryAnotherPrinter({ spool: { state: "error" }, detail: "blocked" })).toBe(true);
    expect(shouldTryAnotherPrinter({ spool: { state: "printed" }, detail: "" })).toBe(false);
    expect(shouldTryAnotherPrinter({ spool: { state: "pending" }, detail: "still in the queue" })).toBe(false);
    expect(shouldTryAnotherPrinter({ spool: { state: "error" }, detail: "the PDF has 2 page(s) but 1 ballot(s) are expected. Not printing." })).toBe(false);
  });

  it("auto-picks the Brother driver and offers only the safe fixes", () => {
    const r = report();
    expect(r.ok).toBe(true);
    const scanners = r.checks.find((c) => c.id === "scanners");
    expect(scanners.detail).toMatch(/Brother DCP-L2640DW LAN/);
    expect(scanners.fix).toBe("remember-scanner");
    expect(scanners.autoPick.deviceId).toBe("b");
    const signin = r.checks.find((c) => c.id === "signin");
    expect(signin.fix).toBe("signin-start");
    expect(signin.level).toBe("info");
    const printing = r.checks.find((c) => c.id === "sumatra");
    expect(printing.level).toBe("ok");
    expect(printing.method).toBe("Windows built-in");
    expect(printing.detail).toMatch(/Windows built-in printing will be used/);
    expect(printing.detail).toMatch(/actual size/);
    expect(JSON.stringify(r)).not.toMatch(/SCANNER_UPLOAD_TOKEN|privateKey|ballotCode|TESTPRNTSC01/);
  });

  it("names two different models and does not offer to guess", () => {
    const r = report({ scanners: [lan, { deviceId: "c", name: "HP LaserJet Pro M404", manufacturer: "HP" }] });
    const scanners = r.checks.find((c) => c.id === "scanners");
    expect(scanners.level).toBe("fail");
    expect(scanners.detail).toMatch(/Brother DCP-L2640DW LAN/);
    expect(scanners.detail).toMatch(/HP LaserJet Pro M404/);
    expect(scanners.fix).toBeNull();
    expect(r.ok).toBe(false);
  });

  it("says Windows built-in printing will be used when SumatraPDF is missing", () => {
    const r = report({ sumatraPath: null });
    const printing = r.checks.find((c) => c.id === "sumatra");
    expect(printing.level).toBe("ok");
    expect(printing.method).toBe("Windows built-in");
    expect(printing.detail).toMatch(/Windows built-in printing will be used/);
    expect(printing.detail).toMatch(/not installed, and that is fine/);
    expect(printing.detail).not.toMatch(/PrintTo/);
    expect(printing.whatToDo).toBeNull();
    expect(printing.fix).toBeNull();
  });

  it("explains an unreachable printer without a fix button", () => {
    const r = report({ printerReachable: false });
    const net = r.checks.find((c) => c.id === "printer-network");
    expect(net.level).toBe("warn");
    expect(net.detail).toMatch(/192\.168\.1\.50/);
    expect(net.whatToDo).toMatch(/Wi-Fi|same network/);
    expect(net.fix).toBeNull();
  });

  it("offers to supersede only a leftover synthetic test batch", () => {
    const root = mkdtempSync(join(tmpdir(), "beings-diag-"));
    writeBatch(join(root, "TEST00"), "batch-20261113-120000", { pages: 1, electionCode: "BEINGS-2026-TEST00" });
    writeBatch(join(root, "REAL99"), "batch-20261113-120100", { pages: 1, electionCode: "BEINGS-2026-REAL99" });
    expect(unresolvedSyntheticBatches(root).map((b) => b.batchId)).toEqual(["batch-20261113-120000"]);
    const r = report({ unresolved: unresolvedSyntheticBatches(root) });
    const row = r.checks.find((c) => c.id === "synthetic-batches");
    expect(row.fix).toBe("supersede-synthetic-test");
    expect(row.detail).toMatch(/batch-20261113-120000/);
    expect(row.detail).not.toMatch(/REAL99/);
    const done = supersedeSyntheticTests(root);
    expect(done.superseded).toEqual(["batch-20261113-120000"]);
    expect(unresolvedSyntheticBatches(root)).toEqual([]);
    expect(unresolvedSyntheticBatches(join(root, "REAL99"))).toEqual([]);
  });
});

describe("image store probe", () => {
  it("treats a 4xx JSON answer as reachable and does not send a body", async () => {
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return { status: 400, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ error: "election required" }) };
    };
    const r = await probeImageStore("https://beingsvote.live", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(400);
    expect(r.url).toBe("https://beingsvote.live/api/images");
    expect(seen.url).toBe("https://beingsvote.live/api/images");
    expect(seen.opts.method).toBe("GET");
    expect(seen.opts.body).toBeUndefined();
  });

  it("points the system check at the R2 Worker unless IMAGE_STORE_URL is set", async () => {
    expect(systemCheckImageStoreUrl({})).toBe(DEFAULT_IMAGE_STORE_URL);
    expect(DEFAULT_IMAGE_STORE_URL).toBe("https://beings-ballot-images.beingsvote-test.workers.dev");
    expect(systemCheckImageStoreUrl({ IMAGE_STORE_URL: "https://other.example" })).toBe("https://other.example");
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, method: opts.method, body: opts.body };
      return { status: 400, text: async () => JSON.stringify({ error: "election required" }) };
    };
    const r = await probeImageStore(systemCheckImageStoreUrl({}), fetchImpl);
    expect(r.ok).toBe(true);
    expect(seen.url).toBe("https://beings-ballot-images.beingsvote-test.workers.dev/api/images");
    expect(seen.method).toBe("GET");
    expect(seen.body).toBeUndefined();
    const named = report({ store: { ok: true, status: 400, error: false, url: seen.url } });
    const row = named.checks.find((c) => c.id === "image-store");
    expect(row.detail).toBe("The image store at https://beings-ballot-images.beingsvote-test.workers.dev answered (HTTP 400). Nothing was uploaded.");
    expect(row.detail).not.toMatch(/beingsvote\.live/);
  });
});
