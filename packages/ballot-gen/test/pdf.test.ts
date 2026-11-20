import { beforeAll, describe, expect, it } from "vitest";
import * as jsqrModule from "jsqr";
import { PDFDocument } from "pdf-lib";
import { generateElection, qrPayload, groupCode, MARKER_INSET_MM, PAGE, type GeneratedElection } from "../src/index.js";
import { darkBoxMm, grey, hasPoppler, pdfText, pdfTextCrop, renderPage, sampleElection, seededRng, writePdf } from "./helpers.js";

// jsqr is CommonJS: the function is the module itself or under `.default`, depending on the loader.
const jsQR = ((jsqrModule as unknown as { default?: unknown }).default ?? jsqrModule) as typeof import("jsqr").default;
const COUNT = 12;
let g: GeneratedElection;
let pdfPath: string;
const DPI = 200;
const px = DPI / 25.4;
/** layout mm (marker frame, origin = top-left marker centre) -> page mm */
const toPage = (v: number): number => v + MARKER_INSET_MM;
const pageBox = (b: { x: number; y: number; width: number; height: number }) => ({ x: toPage(b.x), y: toPage(b.y), w: b.width, h: b.height });

/** Decode the QR whose symbol sits in a page-mm box. The crop includes the quiet zone. */
function decodeQrBox(png: { data: Uint8Array | Buffer; width: number; height: number }, dpi: number, box: { x: number; y: number; w: number; h: number }): string | null {
  const scale = dpi / 25.4;
  const pad = 5;
  const x0 = Math.max(0, Math.floor((box.x - pad) * scale));
  const y0 = Math.max(0, Math.floor((box.y - pad) * scale));
  const x1 = Math.min(png.width, Math.ceil((box.x + box.w + pad) * scale));
  const y1 = Math.min(png.height, Math.ceil((box.y + box.h + pad) * scale));
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * png.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      data[d] = png.data[s] as number;
      data[d + 1] = png.data[s + 1] as number;
      data[d + 2] = png.data[s + 2] as number;
      data[d + 3] = 255;
    }
  }
  return jsQR(data, w, h)?.data ?? null;
}

beforeAll(async () => {
  g = await generateElection(sampleElection(), { count: COUNT, rng: seededRng(11) });
  pdfPath = writePdf(g.pdf);
});

describe("PDF structure", () => {
  it("has one US Letter page per ballot", async () => {
    const doc = await PDFDocument.load(g.pdf);
    expect(doc.getPageCount()).toBe(COUNT);
    for (const p of doc.getPages()) {
      expect(p.getWidth()).toBeCloseTo(612, 0);
      expect(p.getHeight()).toBeCloseTo(792, 0);
    }
    expect(PAGE.widthMm).toBeCloseTo(215.9, 1);
  });

  it("is byte-identical for the same inputs (no timestamps)", async () => {
    const input = { ...sampleElection(), electionCode: "BEINGS-2026-K7M4Q2" };
    const a = await generateElection(input, { count: 5, rng: seededRng(5) });
    const b = await generateElection(input, { count: 5, rng: seededRng(5) });
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
  });
});

describe.skipIf(!hasPoppler)("PDF content (rendered with poppler)", () => {
  it("every page shows its own printed code, twice, and every ballot code appears exactly once", () => {
    const seen: string[] = [];
    for (let page = 1; page <= COUNT; page++) {
      const text = pdfText(pdfPath, page);
      const found = [...text.matchAll(/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/g)].map((m) => (m[1] as string).replace(/-/g, ""));
      expect(found).toHaveLength(2);
      expect(found[0]).toBe(found[1]);
      expect(text).toContain("Fill in the oval completely. Do not write anything on this ballot.");
      expect(text).toContain("Spoiled it? Ask for a new ballot.");
      expect(text.split(g.electionFile.electionCode).length - 1).toBeGreaterThanOrEqual(2);
      seen.push(found[0] as string);
    }
    expect([...seen].sort()).toEqual([...g.electionFile.ballotCodes]); // same set as the list (list is sorted)
    expect(new Set(seen).size).toBe(COUNT);
    expect(seen.every((c) => g.electionFile.ballotCodes.includes(c))).toBe(true);
    expect(seen).not.toEqual([...seen].sort()); // shuffled: print order is not the sorted list order
  });

  it("below the tear line the receipt shows the election code, the ballot code and its own QR, and the corners stay blank", () => {
    const png = renderPage(pdfPath, 1, DPI);
    const tearPage = toPage(g.layout.tearLineY);
    // text: crop pdftotext to the area below the line (pdftotext pixel units at 72 dpi)
    const tearPt = Math.round((tearPage * 72) / 25.4);
    const below = pdfTextCrop(pdfPath, 1, tearPt + 2);
    const printed = (/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(pdfText(pdfPath, 1))?.[1]) as string;
    expect(below).toContain(printed);
    expect(below).toContain(g.electionFile.electionCode);
    expect(below).toContain("Keep this receipt private. Scan the square to open this election, then type your ballot code.");
    expect(below).not.toMatch(/Mark ONE|Fill in the oval|Botanical garden|Yes/);
    expect(pdfText(pdfPath, 1)).toContain("TEAR HERE");
    const rq = g.layout.receiptQr.bbox;
    const qrWin = { x0: toPage(rq.x) - 1, y0: toPage(rq.y) - 1, x1: toPage(rq.x + rq.width) + 1, y1: toPage(rq.y + rq.height) + 1 };
    // pixels outside the receipt QR: text strokes only (a registration mark is >= 8 mm)
    const block = Math.round(4 * px);
    let maxRun = 0;
    for (let x = 0; x + block < png.width; x += 2) {
      let run = 0;
      const xmm = x / px;
      for (let y = Math.round((tearPage + 1) * px); y < png.height; y++) {
        const ymm = y / px;
        if (xmm >= qrWin.x0 && xmm <= qrWin.x1 && ymm >= qrWin.y0 && ymm <= qrWin.y1) {
          run = 0;
          continue;
        }
        if (grey(png, x, y) < 60) { run++; maxRun = Math.max(maxRun, run); } else run = 0;
      }
    }
    expect(maxRun).toBeLessThan(block);
    expect(darkBoxMm(png, DPI, { x0: qrWin.x0, y0: qrWin.y0, x1: qrWin.x1, y1: qrWin.y1 }, 128)).not.toBeNull();
    // the corner margins stay blank, so the receipt QR cannot sit where a registration mark would
    expect(darkBoxMm(png, DPI, { x0: 0, y0: tearPage + 1, x1: 20, y1: PAGE.heightMm }, 128)).toBeNull();
    expect(darkBoxMm(png, DPI, { x0: PAGE.widthMm - 20, y0: tearPage + 1, x1: PAGE.widthMm, y1: PAGE.heightMm }, 128)).toBeNull();
    // the dashed line itself is at the stated y
    const lineBox = darkBoxMm(png, DPI, { x0: 60, y0: tearPage - 1, x1: 180, y1: tearPage + 1 }, 200)!;
    expect(Math.abs((lineBox.y0 + lineBox.y1) / 2 - tearPage)).toBeLessThan(0.3);
  });

  it("no registration mark or oval is drawn below the tear line, and the bottom marks sit clear above it (pixels)", () => {
    const png = renderPage(pdfPath, 1, DPI);
    const tearPage = toPage(g.layout.tearLineY);
    for (const id of ["BL", "BR"] as const) {
      const m = g.layout.markers.find((x) => x.id === id)!;
      const cx = toPage(m.center.x), cy = toPage(m.center.y);
      const b = darkBoxMm(png, DPI, { x0: cx - 8, y0: cy - 8, x1: cx + 8, y1: tearPage + 20 }, 128)!;
      expect(b.y1).toBeLessThan(tearPage - 8 + 0.3);
    }
    for (const q of g.layout.questions) for (const o of q.ovals) {
      const b = darkBoxMm(png, DPI, { x0: toPage(o.center.x) - 4.5, y0: toPage(o.center.y) - 3.8, x1: toPage(o.center.x) + 4.5, y1: toPage(o.center.y) + 3.8 }, 235)!;
      expect(b.y1).toBeLessThan(tearPage);
    }
  });

  it("prints every question and choice text", () => {
    const text = pdfText(pdfPath, 1);
    for (const q of g.electionFile.questions) {
      expect(text).toContain(q.text);
      for (const c of q.choices) expect(text).toContain(c.text);
    }
    expect(text).toContain("Mark up to TWO");
    expect(text).toContain("Mark ONE");
  });

  it("the scan QR and the receipt QR decode to different payloads, and the receipt link has no ballot code", () => {
    for (const page of [1, 2, 7, COUNT]) {
      const png = renderPage(pdfPath, page, DPI);
      const text = pdfText(pdfPath, page);
      const printed = (/\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(text)?.[1] as string).replace(/-/g, "");
      const scan = decodeQrBox(png, DPI, pageBox(g.layout.qr.bbox));
      expect(scan, `scan QR page ${page}`).not.toBeNull();
      expect(scan).toBe(qrPayload(g.electionFile.electionCode, printed));
      expect(scan).toBe(`BEINGS1|${g.electionFile.electionCode}|${printed}|L${g.layout.layoutVersion}`);
      const receipt = decodeQrBox(png, DPI, pageBox(g.layout.receiptQr.bbox));
      expect(receipt, `receipt QR page ${page}`).toBe(g.layout.receiptQr.url);
      expect(receipt!.startsWith("https://")).toBe(true);
      expect(receipt).not.toContain("?");
      expect(receipt).not.toContain(printed);
      expect(receipt).not.toContain("BEINGS1");
      expect(receipt).toBe(`https://beingsvote.live/check.html#e=${g.electionFile.electionCode}`);
      expect(groupCode(printed)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  it("the layout matches the drawn page: markers, QR, ovals", () => {
    const png = renderPage(pdfPath, 1, DPI);
    const tol = 0.35; // mm; one pixel at 200 dpi is 0.127 mm
    // corner markers: solid black squares of the stated size at the stated centres
    for (const m of g.layout.markers) {
      const cx = toPage(m.center.x), cy = toPage(m.center.y), h = m.sizeMm / 2;
      const b = darkBoxMm(png, DPI, { x0: cx - h - 3, y0: cy - h - 3, x1: cx + h + 3, y1: cy + h + 3 }, 128)!;
      expect(b.x0).toBeCloseTo(cx - h, 0);
      expect(Math.abs(b.x0 - (cx - h))).toBeLessThan(tol);
      expect(Math.abs(b.x1 - (cx + h))).toBeLessThan(tol);
      expect(Math.abs(b.y0 - (cy - h))).toBeLessThan(tol);
      expect(Math.abs(b.y1 - (cy + h))).toBeLessThan(tol);
      expect(grey(png, Math.round(cx * px), Math.round(cy * px))).toBeLessThan(30);
    }
    // QR: dark modules fill exactly the module grid at the stated position (bbox = the symbol itself; the quiet zone lies outside it and is blank)
    const qb = g.layout.qr.bbox;
    expect(qb.width).toBeCloseTo(g.layout.qr.modules * g.layout.qr.moduleMm, 2);
    const d = darkBoxMm(png, DPI, { x0: toPage(qb.x) - 1, y0: toPage(qb.y) - 1, x1: toPage(qb.x + qb.width) + 1, y1: toPage(qb.y + qb.height) + 1 }, 128)!;
    expect(Math.abs(d.x0 - (toPage(qb.x)))).toBeLessThan(tol);
    expect(Math.abs(d.y0 - (toPage(qb.y)))).toBeLessThan(tol);
    expect(Math.abs(d.x1 - (toPage(qb.x + qb.width)))).toBeLessThan(tol);
    expect(Math.abs(d.y1 - (toPage(qb.y + qb.height)))).toBeLessThan(tol);
    // ovals: empty light-grey ellipse of the stated size and centre
    let n = 0;
    for (const q of g.layout.questions) {
      for (const o of q.ovals) {
        const cx = toPage(o.center.x), cy = toPage(o.center.y);
        expect(grey(png, Math.round(cx * px), Math.round(cy * px)), `${q.id}/${o.choiceId} centre is blank paper`).toBeGreaterThan(245);
        const b = darkBoxMm(png, DPI, { x0: cx - 4.5, y0: cy - 3.8, x1: cx + 4.5, y1: cy + 3.8 }, 235)!;
        expect(b, `${q.id}/${o.choiceId} outline`).not.toBeNull();
        expect(Math.abs((b.x0 + b.x1) / 2 - cx)).toBeLessThan(tol);
        expect(Math.abs((b.y0 + b.y1) / 2 - cy)).toBeLessThan(tol);
        expect(Math.abs(b.x1 - b.x0 - o.widthMm)).toBeLessThan(0.7); // plus the outline stroke
        expect(Math.abs(b.y1 - b.y0 - o.heightMm)).toBeLessThan(0.7);
        // drop-out colour: the outline is light grey, never black
        const darkest = darkBoxMm(png, DPI, { x0: cx - 4.5, y0: cy - 3.8, x1: cx + 4.5, y1: cy + 3.8 }, 120);
        expect(darkest).toBeNull();
        n++;
      }
    }
    expect(n).toBe(11);
  });
});

describe.skipIf(!hasPoppler)("printed question and choice ids (layout v3)", () => {
  const png = (): ReturnType<typeof renderPage> => renderPage(pdfPath, 1, DPI);
  const ring = (): number => g.layout.oval.baselineRingScale[1];
  /** the scanner's outermost sampling zone around an oval: the baseline ring, in mm from the centre */
  const zone = (o: { widthMm: number; heightMm: number }): { rx: number; ry: number } => ({ rx: (o.widthMm * ring()) / 2, ry: (o.heightMm * ring()) / 2 });

  it("the text of every id is on the page: Q1..Q3 and c1..cN per question (and the ids agree with the election file)", () => {
    const text = pdfText(pdfPath, 1);
    for (const q of g.electionFile.questions) {
      expect(text, q.id).toMatch(new RegExp(`\\b${q.id.toUpperCase()}\\b`));
      for (const c of q.choices) expect(text, `${q.id}/${c.id}`).toMatch(new RegExp(`\\b${c.id}\\b`));
    }
    for (const lq of g.layout.questions) {
      const eq = g.electionFile.questions.find((x) => x.id === lq.id)!;
      expect(lq.ovals.map((o) => o.choiceId)).toEqual(eq.choices.map((c) => c.id));
    }
  });

  it("layout: no id box overlaps any oval zone (oval + baseline ring) with at least 1 mm to spare, none overlaps another id box, all lie inside the frame above the tear line", () => {
    const L = g.layout;
    const boxes: { name: string; b: { x: number; y: number; width: number; height: number } }[] = [];
    for (const q of L.questions) {
      boxes.push({ name: `${q.id} id`, b: q.idBox });
      for (const o of q.ovals) boxes.push({ name: `${q.id}/${o.choiceId} id`, b: o.idBox });
    }
    const gap = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): number =>
      Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1); // > 0: separated by that many mm; <= 0: touching or overlapping
    const asRect = (b: { x: number; y: number; width: number; height: number }) => ({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height });
    const zones = L.questions.flatMap((q) => q.ovals.map((o) => { const z = zone(o); return { name: `${q.id}/${o.choiceId}`, r: { x0: o.center.x - z.rx, y0: o.center.y - z.ry, x1: o.center.x + z.rx, y1: o.center.y + z.ry } }; }));
    expect(zones).toHaveLength(11);
    for (const { name, b } of boxes) {
      for (const z of zones) expect(gap(asRect(b), z.r), `${name} vs oval zone ${z.name}`).toBeGreaterThanOrEqual(1);
      expect(b.x).toBeGreaterThan(0);
      expect(b.x + b.width).toBeLessThan(L.frame.widthMm);
      expect(b.y + b.height).toBeLessThan(L.tearLineY);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(gap(asRect(boxes[i]!.b), asRect(boxes[j]!.b)), `${boxes[i]!.name} vs ${boxes[j]!.name}`).toBeGreaterThan(0);
    // each choice id sits to the right of its own oval, level with it
    for (const q of L.questions) for (const o of q.ovals) {
      expect(o.idBox.x).toBeGreaterThan(o.center.x + zone(o).rx);
      expect(Math.abs(o.idBox.y + o.idBox.height / 2 - o.center.y)).toBeLessThan(1.2);
    }
    // the ids stay in the redaction keep list (a published image must still show which oval is which)
    expect(L.redaction.keep).toEqual(expect.arrayContaining(["questions[].idBox", "questions[].ovals[].idBox"]));
  });

  it("pixels: the ids are drawn where the layout says, in light grey, and never touch an oval zone", () => {
    const img = png();
    const tol = 0.4;
    for (const q of g.layout.questions) {
      for (const o of q.ovals) {
        const cx = toPage(o.center.x), cy = toPage(o.center.y), z = zone(o);
        const bx0 = toPage(o.idBox.x), by0 = toPage(o.idBox.y), bx1 = bx0 + o.idBox.width, by1 = by0 + o.idBox.height;
        // (a) the id's ink lies inside its box (give or take anti-aliasing) ...
        const win = { x0: bx0 - 0.8, y0: by0 - 1, x1: bx1 + 0.8, y1: by1 + 1 };
        const ink = darkBoxMm(img, DPI, win, 250);
        expect(ink, `${q.id}/${o.choiceId} id is printed`).not.toBeNull();
        expect(ink!.x0).toBeGreaterThan(bx0 - tol);
        expect(ink!.x1).toBeLessThan(bx1 + tol);
        expect(ink!.y0).toBeGreaterThan(by0 - tol);
        expect(ink!.y1).toBeLessThan(by1 + tol);
        // (b) ... and it is light: no pixel as dark as 0.5 grey (the ids are 0.6 grey; the oval outline is 0.68)
        expect(darkBoxMm(img, DPI, win, 120), `${q.id}/${o.choiceId} id is light`).toBeNull();
        // (c) the oval zone itself holds only the oval's own outline: between the outline and the ring edge the paper is blank
        const zoneWin = { x0: cx - z.rx - 0.5, y0: cy - z.ry - 0.5, x1: cx + z.rx + 0.5, y1: cy + z.ry + 0.5 };
        const inner = { x0: cx - o.widthMm / 2 - 0.45, y0: cy - o.heightMm / 2 - 0.45, x1: cx + o.widthMm / 2 + 0.45, y1: cy + o.heightMm / 2 + 0.45 };
        for (const strip of [
          { x0: zoneWin.x0, y0: zoneWin.y0, x1: zoneWin.x1, y1: inner.y0 }, // above the outline
          { x0: zoneWin.x0, y0: inner.y1, x1: zoneWin.x1, y1: zoneWin.y1 }, // below it
          { x0: zoneWin.x0, y0: inner.y0, x1: inner.x0, y1: inner.y1 }, // left of it
          { x0: inner.x1, y0: inner.y0, x1: zoneWin.x1, y1: inner.y1 }, // right of it
        ]) expect(darkBoxMm(img, DPI, strip, 250), `${q.id}/${o.choiceId} ring zone is blank`).toBeNull();
        // (d) the id starts clear of the zone: the whole gap between them is blank paper
        expect(darkBoxMm(img, DPI, { x0: cx + z.rx + 0.5, y0: cy - z.ry, x1: bx0 - 0.4, y1: cy + z.ry }, 250), `${q.id}/${o.choiceId} gap`).toBeNull();
        // (e) and the id's ink never enters the zone
        expect(ink!.x0).toBeGreaterThan(cx + z.rx + 0.5);
      }
      // question id: darker than the choice ids but still not black text; the heading text starts clear of it
      const b = q.idBox;
      const x0 = toPage(b.x), y0 = toPage(b.y), x1 = x0 + b.width, y1 = y0 + b.height;
      const ink = darkBoxMm(img, DPI, { x0: x0 - 0.8, y0: y0 - 1, x1: x1 + 0.8, y1: y1 + 1 }, 250)!;
      expect(ink, `${q.id} id is printed`).not.toBeNull();
      expect(ink.x0).toBeGreaterThan(x0 - tol);
      expect(ink.x1).toBeLessThan(x1 + tol);
      expect(darkBoxMm(img, DPI, { x0: x0 - 0.8, y0: y0 - 1, x1: x1 + 0.8, y1: y1 + 1 }, 60), `${q.id} id is grey, not black`).toBeNull();
      expect(darkBoxMm(img, DPI, { x0: x1 + 0.3, y0: y0 - 1, x1: x1 + 2.0, y1: y1 + 1 }, 250), `${q.id} gap before heading`).toBeNull();
    }
  });
});
