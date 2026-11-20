// Optional test print and scan: advisory copy, status storage, mock helper, synthetic fingerprint.
// No network, no wallet, no real election files, no secrets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ballotKey } from "../src/codes.js";
import {
  PREVIEW_NOTE,
  TEST_INTRO,
  TEST_MOBILE_TITLE,
  TEST_MOBILE_UNAVAILABLE,
  TEST_STORAGE_KEY,
  explainTestStartFailure,
  describePrintResult,
  prepareTestPage,
  printTestPage,
  readStoredTestStatus,
  scanAndReadTestPage,
  testPrintScanAdvisory,
  testPrintScanCard,
  writeStoredTestStatus,
} from "../public/js/test-print-scan.js";

const site = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));

const SYNTHETIC_CODE = "TESTPRNTSC01";
const SYNTHETIC_KEY = "0xbb39023f85d1ff8cb6e6cd1fa77bcf8e4f0d611c563f51032655096dd9dc1e51";

describe("synthetic test fingerprint", () => {
  it("matches the site's ballotKey of the fixed fake test code", () => {
    expect(SYNTHETIC_CODE).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(ballotKey(SYNTHETIC_CODE)).toBe(SYNTHETIC_KEY);
    expect(SYNTHETIC_CODE).not.toMatch(/DESK|SGN00/);
  });
});

describe("print method", () => {
  it("names Windows built-in printing and keeps SumatraPDF as a fallback only", () => {
    const builtIn = describePrintResult({ method: "Windows built-in", mocked: false });
    expect(builtIn).toMatch(/Windows built-in/);
    expect(builtIn).toMatch(/actual size/);
    expect(builtIn).toMatch(/No PDF app was opened/);
    expect(builtIn).not.toMatch(/PrintTo/);
    const fallback = describePrintResult({ method: "SumatraPDF", mocked: false });
    expect(fallback).toMatch(/SumatraPDF/);
    expect(fallback).toMatch(/already installed/);
    expect(fallback).toMatch(/actual size/);
    expect(PREVIEW_NOTE).toMatch(/does not print/);
  });
});

describe("advisory", () => {
  it("never tells the teacher they must confirm or run the test before registering", () => {
    const unconfirmed = testPrintScanAdvisory({ confirmed: null, testStatus: null });
    expect(unconfirmed).toMatch(/accounted for by hash/i);
    expect(unconfirmed).toMatch(/still register/i);
    expect(unconfirmed).not.toMatch(/must confirm|stays off|cannot register/i);

    const skipped = testPrintScanAdvisory({ confirmed: { scannerName: "Brother" }, testStatus: { status: "skipped" } });
    expect(skipped).toMatch(/optional|has not been completed/i);
    expect(skipped).toMatch(/not blocked/i);

    const failed = testPrintScanAdvisory({ confirmed: { scannerName: "Brother" }, testStatus: { status: "fail" } });
    expect(failed).toMatch(/did not pass/i);
    expect(failed).toMatch(/not blocked|register anyway/i);

    const mocked = testPrintScanAdvisory({ confirmed: { scannerName: "Brother" }, testStatus: { status: "mocked" } });
    expect(mocked).toMatch(/stand-in/i);
    expect(mocked).toMatch(/optional|still register/i);

    expect(testPrintScanAdvisory({ confirmed: { scannerName: "Brother" }, testStatus: { status: "pass" } })).toBeNull();
  });
  it("mentions that the test is optional in the intro", () => {
    expect(TEST_INTRO).toMatch(/Optional/);
    expect(TEST_INTRO).toMatch(/never blocked/);
    expect(TEST_INTRO).toMatch(/accounted for by hash/);
    expect(TEST_INTRO).toMatch(/not a real ballot/);
  });
});

describe("status storage", () => {
  it("stores only pass/fail/skipped/mocked, never a ballot code or picture", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] };
    writeStoredTestStatus(storage as any, { status: "pass", at: "2026-11-11T09:00:00-07:00", mocked: false });
    expect(readStoredTestStatus(storage as any)).toEqual({ status: "pass", at: "2026-11-11T09:00:00-07:00", mocked: false });
    expect(JSON.stringify(mem)).not.toMatch(/TESTPRNTSC01|ballotCode|privateKey|base64/i);
    expect(Object.keys(mem)[0]).toBe(TEST_STORAGE_KEY);
    writeStoredTestStatus(storage as any, { status: "nope" } as any);
    expect(readStoredTestStatus(storage as any)?.status).toBe("pass");
    writeStoredTestStatus(storage as any, null);
    expect(readStoredTestStatus(storage as any)).toBeNull();
  });
});

describe("helper client (mock fetch)", () => {
  it("prepares, prints, and scan-and-reads through the loopback helper, treating a mocked pass as mocked", async () => {
    const fetchImpl = async (url: string, opts?: any) => {
      const u = String(url);
      if (u.endsWith("/v1/test/prepare") && opts?.method === "POST") {
        return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, synthetic: true, electionCode: "BEINGS-2026-TEST00", electionName: "SYNTHETIC TEST PAGE — NOT A REAL BALLOT", ballotCode: SYNTHETIC_CODE, ballotKey: SYNTHETIC_KEY, mockTest: true }) };
      }
      if (u.endsWith("/v1/test/print") && opts?.method === "POST") {
        const body = JSON.parse(opts.body);
        expect(body.printerName).toMatch(/Brother/);
        return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, printed: false, mocked: true, printerName: body.printerName }) };
      }
      if (u.endsWith("/v1/test/scan-and-read") && opts?.method === "POST") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () =>
            JSON.stringify({
              ok: true,
              pass: true,
              mocked: true,
              checks: [{ id: "code", ok: true, label: "The reading recovered the synthetic test code" }],
              ballotKey: SYNTHETIC_KEY,
              help: "passed",
            }),
        };
      }
      throw new Error("unexpected " + u);
    };
    const prep = await prepareTestPage({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"] });
    expect(prep.json.ok).toBe(true);
    expect(prep.json.electionName).toMatch(/SYNTHETIC TEST PAGE/);
    const printed = await printTestPage({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"], printerName: "Brother DCP-L2640DW series" });
    expect(printed.json.mocked).toBe(true);
    const read = await scanAndReadTestPage({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"] });
    expect(read.json.pass).toBe(true);
    expect(read.json.mocked).toBe(true);
    expect(JSON.stringify(read.json)).not.toMatch(/DESK8Q|SGN001|SGN005/);
  });
  it("treats a connection failure as the helper not running, and does not invent a pass", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await prepareTestPage({ fetchImpl: fetchImpl as any, bases: ["http://127.0.0.1:8765"] });
    expect(r.error).toBe("not-running");
    expect(r.json).toBeUndefined();
  });
});

describe("page copy", () => {
  it("does not keep the old 'registration stays off' wording in help or admin", () => {
    const help = readFileSync(site("public/js/help.js"), "utf8");
    const admin = readFileSync(site("public/js/admin.js"), "utf8");
    expect(help).not.toMatch(/Registration stays off/);
    expect(help).toMatch(/you can still register, because ballots are accounted for by hash/);
    expect(help).toMatch(/creating the election is never blocked/);
    expect(help).toMatch(/phone or tablet cannot run it/);
    expect(admin).toMatch(/testPrintScanCard\(\)/);
    expect(admin).not.toMatch(/Confirm the scanner\/printer first/);
  });
});

class CardEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  className = "";
  disabled = false;
  _hidden = false;
  style: any = {};
  dataset: any = {};
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "hidden") this._hidden = true;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: any[]) {
    this.children = c;
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({ target: this });
  }
  get hidden() {
    return this._hidden;
  }
  set hidden(v: boolean) {
    this._hidden = !!v;
    if (v) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  get text(): string {
    if (this.tagName === "#TEXT") return String((this as { textContent?: string }).textContent ?? "");
    return this.children.map((c) => (c instanceof CardEl ? c.text : String(c?.textContent ?? c))).join("");
  }
}
function installCardDom() {
  (globalThis as any).Node = CardEl;
  (globalThis as any).document = {
    createElement: (t: string) => new CardEl(t),
    createElementNS: (_ns: string, t: string) => new CardEl(t),
    createTextNode: (s: string) => Object.assign(new CardEl("#text"), { textContent: s }),
  };
}

describe("test card on a tablet", () => {
  it("shows the printer-computer message and does not call the helper", () => {
    installCardDom();
    let called = false;
    const card = testPrintScanCard({
      mobile: true,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetchImpl: (async () => {
        called = true;
        throw new Error("helper must not be called from a tablet");
      }) as any,
    });
    expect(card.root.text).toContain(TEST_MOBILE_TITLE);
    expect(card.root.text).toContain(TEST_MOBILE_UNAVAILABLE);
    card.startButton.click();
    expect(called).toBe(false);
    expect(card.root.text).toContain("You can skip this step");
    expect(card.root.text).not.toMatch(/this computer did not answer/);
  });
});

describe("preview", () => {
  it("opens the helper PDF in a new tab and does not print", async () => {
    installCardDom();
    let opened = "";
    let printed = false;
    const card = testPrintScanCard({
      mobile: false,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      openImpl: (url: string) => {
        opened = url;
        return {};
      },
      fetchImpl: (async (url: string, opts?: { method?: string }) => {
        const u = String(url);
        if (u.includes("/v1/test/print") || opts?.method === "POST" && u.includes("/print")) printed = true;
        if (u.includes("/v1/test/prepare")) {
          return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, electionName: "SYNTHETIC TEST PAGE — NOT A REAL BALLOT" }) };
        }
        throw new Error("unexpected " + u);
      }) as any,
    });
    card.startButton.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(card.previewButton.hidden).toBe(false);
    card.previewButton.click();
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:8765\/v1\/test\/page\.pdf$/);
    expect(printed).toBe(false);
    expect(card.root.text).toMatch(/does not print/);
  });
});

describe("helper not reachable", () => {
  it("on a phone or tablet, says to use the printer computer and that the step can be skipped", () => {
    for (const error of ["not-running", "timeout"]) {
      const msg = explainTestStartFailure({ mobile: true, error });
      expect(msg).toBe(TEST_MOBILE_UNAVAILABLE);
      expect(msg).toMatch(/computer connected to the printer and scanner/);
      expect(msg).toMatch(/scanner helper running/);
      expect(msg).toMatch(/skip this step/);
      expect(msg).toMatch(/never blocked/);
      expect(msg).not.toMatch(/this computer did not answer/);
    }
    expect(TEST_MOBILE_TITLE).toMatch(/printer computer/);
  });
  it("on a desktop, still says to start the helper on this computer, or to wait if it only timed out", () => {
    expect(explainTestStartFailure({ mobile: false, error: "not-running" })).toMatch(/start the helper/);
    expect(explainTestStartFailure({ mobile: false, error: "not-running" })).toMatch(/skip this check/);
    expect(explainTestStartFailure({ mobile: false, error: "timeout" })).toMatch(/did not answer in time/);
    expect(explainTestStartFailure({ mobile: false, error: "unexpected" })).toBeNull();
  });
});
