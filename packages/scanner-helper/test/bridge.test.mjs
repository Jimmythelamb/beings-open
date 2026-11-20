import { EventEmitter } from "node:events";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRequest, createBridge, parseScanRequest, parseStationWallet, redactHelperLog } from "../src/bridge.mjs";
import { scanOutcome } from "../src/testpage.mjs";
import { tmpRoot, writeBatch } from "./helpers.mjs";

describe("request checks", () => {
  const cfg = { port: 8765, origins: ["https://beingsvote.live"] };
  it("allows the Dapp origin on loopback", () => {
    expect(checkRequest({ method: "GET", host: "127.0.0.1:8765", origin: "https://beingsvote.live" }, cfg)).toBeNull();
    expect(checkRequest({ method: "POST", host: "localhost:8765", origin: "https://beingsvote.live", contentType: "application/json" }, cfg)).toBeNull();
  });
  it("blocks DNS rebinding, other sites, simple POSTs and odd methods", () => {
    expect(checkRequest({ method: "GET", host: "evil.example:8765", origin: null }, cfg).status).toBe(421);
    expect(checkRequest({ method: "GET", host: "127.0.0.1:8765", origin: "https://evil.example" }, cfg).status).toBe(403);
    expect(checkRequest({ method: "POST", host: "127.0.0.1:8765", origin: "https://beingsvote.live", contentType: "text/plain" }, cfg).status).toBe(415);
    expect(checkRequest({ method: "POST", host: "127.0.0.1:8765", origin: null, contentType: "application/json" }, cfg).status).toBe(403);
    expect(checkRequest({ method: "DELETE", host: "127.0.0.1:8765", origin: "https://beingsvote.live" }, cfg).status).toBe(405);
  });
  it("allows a private-network host only for read-only status", () => {
    const lan = { method: "GET", host: "192.168.1.50:8765", origin: "https://beingsvote.live" };
    expect(checkRequest({ ...lan, pathname: "/v1/station" }, cfg)).toBeNull();
    expect(checkRequest({ ...lan, method: "OPTIONS", pathname: "/v1/diagnostics" }, cfg)).toBeNull();
    expect(checkRequest({ ...lan, pathname: "/v1/health" }, cfg)).toBeNull();
    expect(checkRequest({ method: "GET", host: "printer.local:8765", origin: "https://beingsvote.live", pathname: "/v1/station" }, cfg)).toBeNull();
    expect(checkRequest({ ...lan, pathname: "/v1/scanners" }, cfg).status).toBe(421);
    expect(checkRequest({ ...lan, method: "POST", pathname: "/v1/scan", contentType: "application/json" }, cfg).status).toBe(421);
    expect(checkRequest({ ...lan, method: "POST", pathname: "/v1/diagnostics", contentType: "application/json" }, cfg).status).toBe(421);
    expect(checkRequest({ method: "GET", host: "8.8.8.8:8765", origin: "https://beingsvote.live", pathname: "/v1/station" }, cfg).status).toBe(421);
    expect(checkRequest({ ...lan, pathname: "/v1/station", origin: "https://evil.example" }, cfg).status).toBe(403);
  });
  it("validates a scan request and requires the hand count", () => {
    expect(parseScanRequest({ electionCode: "beings-2026-abc123", expectedPages: 7, operatorCountConfirmed: true })).toEqual({ electionCode: "BEINGS-2026-ABC123", expectedPages: 7, dpi: 300, deviceId: null, pageSize: "Letter" });
    expect(parseScanRequest({ electionCode: "x", expectedPages: 0, dpi: 72, pageSize: "B5", deviceId: 'a"; rm', operatorCountConfirmed: false }).errors).toHaveLength(6);
  });
});

function call(port, { method = "GET", path, origin = "https://beingsvote.live", body, host }) {
  return new Promise((res, rej) => {
    const headers = { host: host ?? `127.0.0.1:${port}` };
    if (origin) headers.origin = origin;
    if (body) headers["content-type"] = "application/json";
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (resp) => {
      let d = "";
      resp.on("data", (c) => (d += c));
      resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, json: d ? JSON.parse(d) : null }));
    });
    r.on("error", rej);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("bridge server (fake PowerShell)", () => {
  let bridge;
  let port;
  const root = tmpRoot();
  const spawned = [];
  const fakeSpawn = (cmd, args) => {
    spawned.push(args);
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => {
      if (args.includes("-ListDevices")) p.stdout.emit("data", JSON.stringify([{ deviceId: "{X}\\0001", name: "Brother DCP-L2640DW", connection: "network" }]));
      else if (args.includes("-ListPrinters")) p.stdout.emit("data", JSON.stringify([{ name: "Brother DCP-L2640DW series", driver: "Brother DCP-L2640DW Printer", port: "WSD-xxx", connection: "network", status: "Normal" }, { name: "Microsoft Print to PDF", driver: "Microsoft Print To PDF", port: "PORTPROMPT:", connection: "other", status: "Normal" }]));
      else p.stdout.emit("data", 'noise\n{"ok":true,"batchId":"batch-20261109-202954","state":"CAPTURED"}\n');
      p.emit("close", 0);
    }, 5);
    return p;
  };
  beforeAll(async () => {
    writeBatch(join(root, "TSTAAA"), "batch-20261109-202954", { pages: 2 });
    port = 18765 + Math.floor(Math.random() * 1000);
    bridge = createBridge({ outputRoot: root, port, spawnImpl: fakeSpawn, stationWallet: { address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", label: "Classroom station" } });
    await bridge.listen();
  });
  afterAll(() => bridge.close());

  it("binds to loopback only", () => {
    expect(bridge.server.address().address).toBe("127.0.0.1");
    if (bridge.server6?.listening) expect(bridge.server6.address().address).toBe("::1");
  });
  it("answers health, with CORS only for allowed origins", async () => {
    const ok = await call(port, { path: "/v1/health" });
    expect(ok.status).toBe(200);
    expect(ok.json.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ok.json.installedAt).toBeNull();
    expect(ok.json.service).toBe("beings-scanner-bridge");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://beingsvote.live");
    expect((await call(port, { path: "/v1/health", origin: "https://evil.example" })).status).toBe(403);
    expect((await call(port, { path: "/v1/health", host: "attacker.example:" + port })).status).toBe(421);
  });
  it("answers the private-network preflight", async () => {
    const r = await call(port, { method: "OPTIONS", path: "/v1/scan" });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-private-network"]).toBe("true");
  });
  it("lists scanners through the PowerShell script", async () => {
    const r = await call(port, { path: "/v1/scanners" });
    expect(r.json.scanners[0].name).toMatch(/Brother/);
    expect(spawned.at(-1)).toContain("-ListDevices");
  });
  it("lists printers through the print script", async () => {
    const r = await call(port, { path: "/v1/printers" });
    expect(r.status).toBe(200);
    expect(r.json.printers.some((p) => /Brother/.test(p.name))).toBe(true);
    expect(spawned.at(-1)).toContain("-ListPrinters");
  });
  it("answers a read-only station status with devices and the public wallet only", async () => {
    const r = await call(port, { path: "/v1/station" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.scanners[0].name).toMatch(/Brother/);
    expect(r.json.printers.some((p) => /Brother/.test(p.name))).toBe(true);
    expect(r.json.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.json).toHaveProperty("installedAt");
    expect(r.json.stationWallet).toEqual({ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", label: "Classroom station" });
    expect(JSON.stringify(r.json)).not.toMatch(/privateKey|mnemonic|seed/i);
    const remote = await call(port, { path: "/v1/station", host: `192.168.1.50:${port}` });
    expect(remote.status).toBe(200);
    expect(remote.json.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(remote.headers["access-control-allow-origin"]).toBe("https://beingsvote.live");
    expect((await call(port, { method: "POST", path: "/v1/scan", host: `192.168.1.50:${port}`, body: { electionCode: "BEINGS-2026-TSTAAA", expectedPages: 1, operatorCountConfirmed: true } })).status).toBe(421);
    expect((await call(port, { path: "/v1/scanners", host: `printer.local:${port}` })).status).toBe(421);
  });
  it("lists batches with hashes and states, never images", async () => {
    const r = await call(port, { path: "/v1/elections/BEINGS-2026-TSTAAA/batches" });
    expect(r.json.batches).toHaveLength(1);
    expect(r.json.batches[0]).toMatchObject({ batchId: "batch-20261109-202954", state: "CAPTURED", recordable: false, savedPages: 2, expectedPages: 2 });
    expect(JSON.stringify(r.json)).not.toMatch(/page-01\.png|base64/);
  });
  it("seals a batch on request", async () => {
    const r = await call(port, { method: "POST", path: "/v1/elections/BEINGS-2026-TSTAAA/batches/batch-20261109-202954/seal", body: {} });
    expect(r.status).toBe(200);
    expect(r.json.batch.state).toBe("SEALED");
  });
  it("starts one scan with fixed arguments, refuses bad input", async () => {
    expect((await call(port, { method: "POST", path: "/v1/scan", body: { electionCode: "BEINGS-2026-TSTAAA", expectedPages: 7 } })).status).toBe(400);
    const r = await call(port, { method: "POST", path: "/v1/scan", body: { electionCode: "BEINGS-2026-TSTAAA", expectedPages: 7, operatorCountConfirmed: true } });
    expect(r.status).toBe(202);
    const args = spawned.at(-1);
    expect(args.slice(args.indexOf("-ElectionCode"), args.indexOf("-ElectionCode") + 4)).toEqual(["-ElectionCode", "BEINGS-2026-TSTAAA", "-ExpectedPages", "7"]);
    expect(args).toContain("-DeviceId");
    expect(args[args.indexOf("-DeviceId") + 1]).toBe("{X}\\0001");
    await new Promise((res) => setTimeout(res, 30));
    const s = await call(port, { path: "/v1/scan" });
    expect(s.json).toMatchObject({ running: false, exitCode: 0, result: { batchId: "batch-20261109-202954", state: "CAPTURED" } });
  });
});

describe("parseStationWallet", () => {
  it("accepts a public address and optional label", () => {
    expect(parseStationWallet({ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", label: "Room 12" })).toEqual({ wallet: { address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", label: "Room 12" } });
    expect(parseStationWallet(null)).toEqual({ wallet: null });
  });
  it("refuses a file that looks like it contains a secret, and does not return it", () => {
    const r = parseStationWallet({ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", privateKey: "0xabc" });
    expect(r.error).toMatch(/secret/i);
    expect(r).not.toHaveProperty("wallet");
    expect(JSON.stringify(r)).not.toMatch(/0xabc/);
  });
  it("refuses a value that is not a public 0x address", () => {
    expect(parseStationWallet({ address: "not-an-address" }).error).toMatch(/public 0x address/);
  });
});

describe("optional test print and scan endpoints", () => {
  let bridge;
  let port;
  const root = tmpRoot();
  beforeAll(async () => {
    port = 19765 + Math.floor(Math.random() * 1000);
    bridge = createBridge({ outputRoot: root, port, spawnImpl: () => { throw new Error("PowerShell should not run for the mock test"); }, allowMockTest: true });
    await bridge.listen();
  });
  afterAll(() => bridge.close());

  it("describes the synthetic test page and serves only that PDF", async () => {
    const r = await call(port, { path: "/v1/test" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.synthetic).toBe(true);
    expect(r.json.electionCode).toBe("BEINGS-2026-TEST00");
    expect(r.json.electionName).toMatch(/NOT A REAL BALLOT/);
    expect(r.json.ballotCode).toBe("TESTPRNTSC01");
    expect(r.json.mockTest).toBe(true);
    const pdf = await fetch(`http://127.0.0.1:${port}/v1/test/page.pdf`, { headers: { origin: "https://beingsvote.live", host: `127.0.0.1:${port}` } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toMatch(/application\/pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("prints as a mocked stand-in off Windows and scan-and-reads the bundled picture", async () => {
    const printed = await call(port, { method: "POST", path: "/v1/test/print", body: { printerName: "Brother DCP-L2640DW series" } });
    expect(printed.status).toBe(200);
    expect(printed.json.ok).toBe(true);
    expect(printed.json.mocked).toBe(true);
    expect(printed.json.printed).toBe(false);
    const read = await call(port, { method: "POST", path: "/v1/test/scan-and-read", body: { mock: true } });
    expect(read.status).toBe(200);
    expect(read.json.ok).toBe(true);
    expect(read.json.mocked).toBe(true);
    expect(read.json.pass).toBe(true);
    expect(read.json.ballotKey).toBe("0xbb39023f85d1ff8cb6e6cd1fa77bcf8e4f0d611c563f51032655096dd9dc1e51");
    expect(read.json.message).toMatch(/stand-in picture/);
    expect(JSON.stringify(read.json)).not.toMatch(/privateKey|SCANNER_UPLOAD_TOKEN|DESK8Q/);
  });

  it("refuses a client-supplied election file or picture", async () => {
    const r = await call(port, { method: "POST", path: "/v1/test/scan-and-read", body: { mock: true, electionPath: "/tmp/secret.json" } });
    expect(r.status).toBe(400);
    expect(r.json.errors.join(" ")).toMatch(/does not accept an election file/);
  });

  it("advertises the test on /v1/health", async () => {
    const r = await call(port, { path: "/v1/health" });
    expect(r.json.testPrintScan).toBe(true);
    expect(r.json.mockTest).toBe(true);
  });
});

describe("test print and scan with mock disabled", () => {
  let bridge;
  let port;
  const root = tmpRoot();
  beforeAll(async () => {
    port = 19865 + Math.floor(Math.random() * 1000);
    bridge = createBridge({ outputRoot: root, port, spawnImpl: () => { throw new Error("no"); }, allowMockTest: false });
    await bridge.listen();
  });
  afterAll(() => bridge.close());

  it("rejects mock:true when the helper has mock disabled", async () => {
    const r = await call(port, { method: "POST", path: "/v1/test/scan-and-read", body: { mock: true } });
    expect(r.status).toBe(400);
    expect(r.json.errors.join(" ")).toMatch(/mock test is not enabled/);
  });
});

describe("silent test print and saved scan picture", () => {
  let bridge;
  let port;
  const root = tmpRoot();
  const spawned = [];
  const fakeSpawn = (_cmd, args) => {
    spawned.push(args);
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => {
      if (args.includes("-ListPrinters")) {
        p.stdout.emit("data", JSON.stringify([
          { name: "Brother DCP-L2640DW Printer", port: "BRWA8C1D2E3F4", status: "Normal", default: true },
          { name: "Brother DCP-L2640DW", port: "WSD-1", status: "Normal", default: false },
        ]));
        p.emit("close", 0);
        return;
      }
      const name = args[args.indexOf("-PrinterName") + 1];
      if (name === "Brother DCP-L2640DW Printer") {
        p.stdout.emit("data", JSON.stringify({ ok: false, printed: false, method: "Windows built-in", printer: name, message: "Windows put the job on the queue and then reported: Error", spooler: { jobStatus: 2, status: "Error", gone: false } }));
        p.emit("close", 6);
        return;
      }
      p.stdout.emit("data", JSON.stringify({ ok: true, printed: true, method: "Windows built-in", printer: name, spooler: { gone: true, jobStatus: 0, status: "left the queue" } }));
      p.emit("close", 0);
    }, 5);
    return p;
  };
  beforeAll(async () => {
    port = 19965 + Math.floor(Math.random() * 1000);
    bridge = createBridge({ outputRoot: root, port, spawnImpl: fakeSpawn, allowMockTest: false });
    await bridge.listen();
  });
  afterAll(() => bridge.close());

  it("starts PowerShell in STA, skips a queue the spooler rejected, and reports the queue that worked", async () => {
    const r = await call(port, { method: "POST", path: "/v1/test/print", body: { printerName: "Brother DCP-L2640DW Printer" } });
    expect(r.status).toBe(200);
    expect(r.json.printed).toBe(true);
    expect(r.json.printerName).toBe("Brother DCP-L2640DW");
    expect(r.json.attempts.map((a) => a.outcome)).toEqual(["error", "printed"]);
    expect(spawned.some((args) => args.includes("-STA"))).toBe(true);
    expect(r.json.message).toMatch(/Windows built-in/);
  });

  it("serves the saved scan picture and redacts the helper log", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(root, "_synthetic-test-print-scan");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last-page.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const png = await fetch(`http://127.0.0.1:${port}/v1/test/last-page.png`, { headers: { origin: "https://beingsvote.live" } });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toMatch(/image\/png/);
    expect(png.headers.get("access-control-allow-origin")).toBe("https://beingsvote.live");
    const outcome = scanOutcome({ readError: "reader stopped", hasImage: true });
    expect(outcome.pass).toBe(false);
    expect(outcome.imageUrl).toBe("/v1/test/last-page.png");
    expect(outcome.message).toMatch(/saved a picture/);
    expect(redactHelperLog("token SCANNER_UPLOAD_TOKEN=secret wallet 0xfB2A3F83F2362566341b8edfB008a0C42A52d73D")).not.toMatch(/secret|0xfB2A/);
  });
});
