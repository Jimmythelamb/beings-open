import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { countPdfPages, printPageCheck } from "../src/pdf.mjs";
import { main } from "../src/cli.mjs";

async function pdf(n, useObjectStreams = true) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([612, 792]);
  return d.save({ useObjectStreams });
}

describe("print page check", () => {
  it("counts pages in compressed and plain PDFs", async () => {
    expect(await countPdfPages(await pdf(7))).toBe(7);
    expect(await countPdfPages(await pdf(3, false))).toBe(3);
  });
  it("refuses a non-PDF", async () => {
    await expect(countPdfPages(new TextEncoder().encode("hello"))).rejects.toThrow(/not a PDF/);
  });
  it("compares with the expected count", () => {
    expect(printPageCheck(7, 7).ok).toBe(true);
    expect(printPageCheck(6, 7)).toEqual({ ok: false, message: "the PDF has 6 pages but 7 were expected: not printing" });
    expect(printPageCheck(6, 0).ok).toBe(false);
  });
  it("cli pdf-pages exits 2 on a mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beings-pdf-"));
    const p = join(dir, "b.pdf");
    writeFileSync(p, await pdf(4));
    expect(await main(["pdf-pages", p, "--expect", "4"])).toBe(0);
    expect(await main(["pdf-pages", p, "--expect", "5"])).toBe(2);
  });
});
