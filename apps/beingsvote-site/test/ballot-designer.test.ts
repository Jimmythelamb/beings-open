// Ballot designer (public/js/ballotpdf.js + vendor/ballot-gen.js): same layout fingerprint as @beings/ballot-gen,
// one page per ballot code, refuses a stale layout. Uses the SYNTHETIC sample election only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFDocument, PUBLIC_SITE_ORIGIN, checkPageUrl } from "../public/vendor/ballot-gen.js";
import { ballotPdf, designLayout, layoutInput, shuffleCodes } from "../public/js/ballotpdf.js";
import { CONFIG } from "../public/js/config.js";
import { draftElectionFile } from "../public/js/logic.js";

function draft(over: Record<string, unknown> = {}) {
  return draftElectionFile({
    name: "  Room 12 class rep  ",
    electionCode: "BEINGS-2026-TSTAAA",
    organizer: "0x2222222222222222222222222222222222222222",
    opensAt: "2026-11-16T16:00:00.000Z",
    closesAt: "2026-11-16T22:00:00.000Z",
    registeredVoters: 3,
    quorum: 1,
    retentionDays: 3,
    approvedAppHashes: ["cd".repeat(32)],
    layoutHash: null,
    ballotCodes: ["AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC", "DDDDDDDDDDDD"],
    questions: [
      { text: " Who should be class rep? ", choices: ["Alex", " Sam ", "Priya"], maxMarks: 1 },
      { text: "Pizza or tacos?", choices: ["Pizza", "Tacos"], maxMarks: 1 },
    ],
    ...over,
  });
}

describe("receipt link", () => {
  it("uses the configured public origin, never the page hostname, and leaves the ballot code out", async () => {
    expect(CONFIG.siteOrigin).toBe("https://beingsvote.live");
    expect(PUBLIC_SITE_ORIGIN).toBe("https://beingsvote.live");
    expect(readFileSync(fileURLToPath(new URL("../public/js/ballotpdf.js", import.meta.url)), "utf8")).not.toMatch(/location\.origin/);
    const d = await designLayout(draft());
    const url = checkPageUrl("BEINGS-2026-TSTAAA", CONFIG.siteOrigin);
    expect(url).toBe("https://beingsvote.live/check.html#e=BEINGS-2026-TSTAAA");
    expect(d.layout.receiptQr.url).toBe(url);
    expect(d.layout.receiptQr.url.includes("?")).toBe(false);
    expect(d.layout.qr.payloadFormat.startsWith("BEINGS1|")).toBe(true);
    expect(d.layout.qr.bbox).toEqual({ x: 146, y: 22, width: 23.2, height: 23.2 });
    for (const code of ["AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC", "DDDDDDDDDDDD"]) {
      expect(d.layout.receiptQr.url.includes(code)).toBe(false);
    }
    expect(d.layout.electionCodeText.bbox.y + d.layout.electionCodeText.bbox.height).toBeLessThan(d.layout.tearLineY);
    expect(d.layout.receiptQr.bbox.y).toBeGreaterThan(d.layout.tearLineY);
  });
});

describe("designer", () => {
  it("depends on the questions, not on ballot codes or dates", async () => {
    const a = await designLayout(draft());
    const b = await designLayout(draft({ ballotCodes: ["ZZZZZZZZZZZZ"], opensAt: "2027-01-01T00:00:00.000Z" }));
    const c = await designLayout(draft({ questions: [{ text: "Who should be class rep?", choices: ["Alex", "Sam", "Priya", "Jo"], maxMarks: 1 }] }));
    expect(a.layoutHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.layoutHash).toBe(a.layoutHash);
    expect(c.layoutHash).not.toBe(a.layoutHash);
    expect(a.layout.electionCode).toBe("BEINGS-2026-TSTAAA");
  });

  it("asks for a name and questions first", () => {
    expect(() => layoutInput({ electionCode: "X", name: "", questions: [] })).toThrow(/name, code and at least one question/);
  });

  it("makes one page per ballot code when the file's layoutHash matches", async () => {
    const d = await designLayout(draft());
    const file = draft({ layoutHash: d.layoutHash });
    const r = await ballotPdf(file);
    expect(r.pages).toBe(4);
    expect((await PDFDocument.load(r.pdf)).getPageCount()).toBe(4);
    expect(r.layoutHash).toBe(d.layoutHash);
  });

  it("refuses when the questions changed after the layout was designed", async () => {
    const d = await designLayout(draft());
    const changed = draft({ layoutHash: d.layoutHash, questions: [{ text: "Different?", choices: ["Yes", "No"], maxMarks: 1 }] });
    await expect(ballotPdf(changed)).rejects.toThrow(/Design the ballot again/);
  });

  it("refuses a file without ballot codes (a public copy)", async () => {
    await expect(ballotPdf({ ...draft(), ballotCodes: [] })).rejects.toThrow(/no ballot codes/);
  });

  it("shuffles to a permutation", () => {
    let i = 0;
    const rnd = (n: number) => Uint8Array.from({ length: n }, () => (i = (i * 37 + 11) % 256));
    const codes = ["A", "B", "C", "D", "E", "F"];
    const s = shuffleCodes(codes, rnd);
    expect([...s].sort()).toEqual(codes);
    expect(codes).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("the admin page designs the ballot and offers the PDF and layout after Prepare", () => {
    const admin = readFileSync(fileURLToPath(new URL("../public/js/admin.js", import.meta.url)), "utf8");
    expect(admin).toContain('"Design the ballot"');
    expect(admin).not.toContain("Design the ballot and fill this in");
    expect(admin).toMatch(/Download printable ballots/);
    expect(admin).toMatch(/"Preview"/);
    expect(admin).toMatch(/openPdfBytesInNewTab/);
    expect(admin).toMatch(/Download the ballot layout \(for the scanner\)/);
  });
});
