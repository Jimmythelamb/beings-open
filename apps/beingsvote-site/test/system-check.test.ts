// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { formatDiagnosticsReport, redactReportText, systemCheckCard } from "../public/js/system-check.js";
import { SCANNER_CHOICE_KEY } from "../public/js/scanner-station.js";

const sample = {
  ok: false,
  checks: [
    { id: "helper", level: "ok", title: "Helper", detail: "The scanner helper is running (version 0.1.0).", fix: null },
    { id: "sumatra", level: "ok", title: "Printing", detail: "Windows built-in printing will be used. SumatraPDF is not installed, and that is fine.", method: "Windows built-in", whatToDo: null, fix: null },
    { id: "scanners", level: "warn", title: "Scanners", detail: "Windows listed 2 entries for the same model. The helper will use \"Brother DCP-L2640DW LAN\".", fix: "remember-scanner", autoPick: { deviceId: "b", name: "Brother DCP-L2640DW LAN" } },
    { id: "printer-network", level: "warn", title: "Printer network", detail: "This PC could not reach the printer address 192.168.1.50.", whatToDo: "The printer may be off, or this PC may be on a different Wi-Fi network.", fix: null },
  ],
};

describe("report redaction", () => {
  it("removes tokens, wallet addresses, ballot codes, and file contents", () => {
    const dirty = formatDiagnosticsReport({
      ok: false,
      checks: [
        { id: "x", level: "fail", title: "Leak", detail: "token SCANNER_UPLOAD_TOKEN=super-secret-value code TESTPRNTSC01 wallet 0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", whatToDo: "Bearer abc.def.ghi" },
      ],
    });
    expect(dirty).not.toMatch(/super-secret-value/);
    expect(dirty).not.toMatch(/TESTPRNTSC01/);
    expect(dirty).not.toMatch(/0xfB2A3F83F2362566341b8edfB008a0C42A52d73D/);
    expect(dirty).not.toMatch(/abc\.def\.ghi/);
    expect(dirty).toMatch(/<removed/);
    expect(redactReportText("%PDF-1.4 secret page")).not.toMatch(/%PDF/);
    expect(formatDiagnosticsReport(sample)).toMatch(/Brother DCP-L2640DW LAN/);
    expect(formatDiagnosticsReport(sample)).toMatch(/Windows built-in/);
  });
});

describe("Run system check", () => {
  it("shows the report, a fix, and the install steps when the helper is down", async () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] };
    const card = systemCheckCard({
      handheld: false,
      choiceStorage: storage as any,
      fetchImpl: async (url: string) => {
        if (String(url).includes("/v1/diagnostics/fix")) return { ok: true, text: async () => JSON.stringify({ ok: true }) };
        if (String(url).includes("/v1/diagnostics")) return { ok: true, status: 200, text: async () => JSON.stringify(sample) };
        throw new TypeError("no helper");
      },
    });
    expect(card.root.textContent).toMatch(/Run system check/);
    card.runButton.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(card.root.textContent).toMatch(/Brother DCP-L2640DW LAN/);
    expect(card.root.textContent).toMatch(/Fix this: use this scanner/);
    expect(card.root.textContent).toMatch(/different Wi-Fi|same network|Wi-Fi/);
    expect(card.root.textContent).toMatch(/Copy report/);
    const fix = [...card.root.querySelectorAll("button")].find((b) => b.textContent?.includes("use this scanner"));
    fix?.click();
    expect(JSON.parse(mem[SCANNER_CHOICE_KEY]).deviceId).toBe("b");

    const down = systemCheckCard({
      handheld: true,
      fetchImpl: async () => {
        throw new TypeError("no helper");
      },
    });
    down.runButton.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(down.root.textContent).toMatch(/Connect printer & scanner \(Windows PC\)/);
    expect(down.root.textContent).toMatch(/no window to keep open/);
    expect(down.root.textContent).toMatch(/iPad or phone/);
    expect(down.root.textContent).toMatch(/Windows PC/);
  });
});
