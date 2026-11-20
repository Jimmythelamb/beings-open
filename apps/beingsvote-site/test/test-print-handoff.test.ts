// @vitest-environment happy-dom
// The system check's chosen printer must reach the test-print card, and a scan must show a picture plus a confirmation.
import { describe, expect, it } from "vitest";
import { systemCheckCard } from "../public/js/system-check.js";
import { describePrintResult, rememberDetectedPrinters, scanResultView, testPrintScanCard } from "../public/js/test-print-scan.js";

const report = {
  ok: true,
  checks: [
    { id: "helper", level: "ok", title: "Helper", detail: "The scanner helper is running." },
    {
      id: "printers",
      level: "ok",
      title: "Printers",
      detail: "The check will use Brother DCP-L2640DW Printer.",
      chosen: { name: "Brother DCP-L2640DW Printer", port: "BRWA8C1D2E3F4" },
      options: [
        { name: "Brother DCP-L2640DW Printer", port: "BRWA8C1D2E3F4" },
        { name: "Brother DCP-L2640DW", port: "WSD-1" },
      ],
    },
  ],
};

describe("printer handoff", () => {
  it("carries the system check's queues into the test card and names the one that will be used", async () => {
    const check = systemCheckCard({
      handheld: false,
      fetchImpl: async (url: string) => {
        if (String(url).includes("/v1/diagnostics")) return { ok: true, status: 200, text: async () => JSON.stringify(report) };
        throw new TypeError("no");
      },
    });
    check.runButton.click();
    await new Promise((r) => setTimeout(r, 40));
    const card = testPrintScanCard({
      storage: sessionStorage,
      fetchImpl: async () => {
        throw new TypeError("helper must not be called just to show the printer");
      },
    });
    expect(card.root.textContent).toMatch(/This test will print to "Brother DCP-L2640DW Printer"/);
    expect(card.root.textContent).not.toMatch(/No printer is confirmed/);
    expect(card.printerSelect.value).toBe("Brother DCP-L2640DW Printer");
    expect([...card.printerSelect.options].map((o) => o.value)).toEqual(["Brother DCP-L2640DW Printer", "Brother DCP-L2640DW"]);
    card.printerSelect.value = "Brother DCP-L2640DW";
    card.printerSelect.dispatchEvent(new Event("change"));
    expect(card.root.textContent).toMatch(/This test will print to "Brother DCP-L2640DW"/);
  });

  it("says when Windows did not print, instead of claiming the page was sent", () => {
    const text = describePrintResult({
      ok: false,
      printed: false,
      printerName: "Brother DCP-L2640DW Printer",
      message: "Windows built-in printing did not finish: The current thread is not an STA thread. No PDF app was opened. Nothing was printed.",
      attempts: [{ name: "Brother DCP-L2640DW Printer", outcome: "error" }],
    });
    expect(text).toMatch(/did not finish/);
    expect(text).toMatch(/Nothing was confirmed on paper|Nothing was printed/);
    expect(text).not.toMatch(/^Printed with Windows built-in/);
    const ok = describePrintResult({ printed: true, method: "Windows built-in", printerName: "Brother DCP-L2640DW" });
    expect(ok).toMatch(/Windows built-in/);
    expect(ok).toMatch(/actual size/);
    expect(ok).toMatch(/No PDF app was opened/);
    expect(ok).toMatch(/Brother DCP-L2640DW/);
  });
});

describe("scan confirmation", () => {
  it("shows the scanned thumbnail and a pass or fail line", async () => {
    rememberDetectedPrinters(sessionStorage, { chosen: "Brother DCP-L2640DW", printers: [{ name: "Brother DCP-L2640DW", port: "BRW1" }] });
    const calls: string[] = [];
    const card = testPrintScanCard({
      storage: sessionStorage,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/v1/test/prepare")) {
          return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, electionName: "SYNTHETIC TEST PAGE — NOT A REAL BALLOT" }) };
        }
        if (String(url).includes("/v1/test/scan-and-read")) {
          return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, pass: false, mocked: false, message: "The scanner's picture was saved. The check did not pass.", imageUrl: "/v1/test/last-page.png", checks: [{ id: "code", ok: false, label: "The reading did not recover a ballot code", help: "The code was not read." }] }) };
        }
        if (String(url).includes("/v1/test/last-page.png")) {
          return { ok: true, status: 200, blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" }) };
        }
        throw new Error("unexpected " + url);
      }) as any,
    });
    card.startButton.click();
    await new Promise((r) => setTimeout(r, 30));
    card.scanButton.click();
    await new Promise((r) => setTimeout(r, 40));
    expect(card.root.textContent).toMatch(/Test print and scan did not pass/);
    expect(card.root.textContent).toMatch(/picture was saved/);
    const img = card.root.querySelector("img.test-scan-thumb");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("alt")).toBe("Scanned test page");
    expect(calls.some((u) => u.includes("/v1/test/last-page.png"))).toBe(true);
    const view = scanResultView({ error: "timeout", json: null });
    expect(view.message).toMatch(/stopped waiting/);
    expect(view.pass).toBe(false);
  });
});
