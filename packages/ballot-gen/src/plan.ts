/**
 * The ballot page plan: one function from an election file to (a) the public ballot LAYOUT (IC2, [PROPOSED]) and
 * (b) the drawing instructions for the PDF. The PDF is drawn FROM the plan, so the layout and the paper cannot drift.
 *
 * Units are millimetres. Internally the plan uses PAGE coordinates (origin top-left of the page, y down); the public
 * layout is expressed in the FRAME of the registration marks (origin = centre of the top-left marker, x right, y down),
 * which is what the scanner (M3) can recover from the photo, whatever the paper position or camera distance.
 */
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import QRCode from "qrcode";
import { BeingsError, type ElectionFile } from "@beings/core";

export const MM_TO_PT = 72 / 25.4;

export const PAGE = { widthMm: 215.9, heightMm: 279.4 } as const; // US Letter
export const LAYOUT_VERSION = 3; // v2: the receipt is torn off (bottom marks above the tear line). v3: question ids (Q1) and choice ids (c2) are printed, the choice text moved right
export const QR_PAYLOAD_PREFIX = "BEINGS1";

/** Registration markers: solid black squares. TL is larger so the page orientation is unambiguous. */
export const MARKER_INSET_MM = 14; // page edge to the TOP markers' centres and to the left/right markers' centres
/**
 * The receipt below the tear line is removed BEFORE scanning, so the scanned body must be self-contained:
 * the bottom markers sit ABOVE the tear line, with this much clear paper between the lower edge of a marker
 * and the tear, so a ragged tear cannot clip them.
 */
export const BOTTOM_MARKER_Y_MM = 228; // page y of the bottom markers' centres
export const TEAR_LINE_Y_MM = 241; // page y of the dashed tear line
export const TEAR_CLEARANCE_MM = 8; // minimum clear paper between a bottom marker's lower edge and the tear line
export const MARKER_SIZE_MM = { TL: 10, TR: 8, BL: 8, BR: 8 } as const;

/** Ovals: grey drop-out outline, about 6 x 4.5 mm (spec 6.1: 5 to 6 mm across). */
export const OVAL = { widthMm: 6, heightMm: 4.5, sampleScale: 0.8, baselineRing: [1.25, 1.6] as [number, number] };
export const OVAL_OUTLINE_GREY = 0.68;
export const OVAL_PITCH_MM = [9, 8.5, 8]; // centre to centre, tried in order (spec 6.1: at least 8 mm)

export const QR_MODULE_MM = 0.8;
export const QR_QUIET_MODULES = 4;

/**
 * Public site the receipt QR opens. Callers (the website, the CLI) pass the configured origin.
 * The default is the live site. A preview hostname is never the default.
 */
export const PUBLIC_SITE_ORIGIN = "https://beingsvote.live";
/** Check my ballot page. The election code is carried in the fragment (`#e=`), never in the query string. */
export const CHECK_PAGE_PATH = "/check.html";
/**
 * Receipt QR module size. A finder pattern is 7 modules across. The scanner treats solid squares
 * from 6 mm up as registration marks (`qr_select.MIN_MARKER_MM`), so this stays strictly under 6/7 mm.
 * It is also smaller than the machine-read QR (0.8 mm), and it is printed only below the tear line.
 */
export const RECEIPT_QR_MODULE_MM = 0.7;
export const RECEIPT_QR_QUIET_MODULES = 4;
export const SCANNER_MIN_MARKER_MM = 6;

const ORIGIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

export function siteOriginOf(given?: string): string {
  const origin = (given ?? PUBLIC_SITE_ORIGIN).replace(/\/+$/, "");
  if (!ORIGIN_RE.test(origin)) throw new BeingsError("BAD_INPUT", "site origin must be an https origin with no path, query or fragment");
  return origin;
}

/** URL encoded in the receipt QR. The fragment holds the election code and nothing else. */
export function checkPageUrl(electionCode: string, siteOrigin?: string): string {
  const url = `${siteOriginOf(siteOrigin)}${CHECK_PAGE_PATH}#e=${encodeURIComponent(electionCode)}`;
  if (url.includes("?") || !url.includes("#e=") || url.includes("|")) throw new BeingsError("BAD_INPUT", "the receipt link must keep the election code in the fragment");
  return url;
}

const COL_LEFT = 24;
const COL_RIGHT = 190;
const OVAL_CX = 32;
/**
 * Printed ids (v3). Choice id: small, light grey, to the RIGHT of its oval, starting `CHOICE_ID_X - OVAL_CX` mm from the
 * oval centre. The scanner's baseline ring reaches `baselineRing[1] * OVAL.widthMm / 2` = 4.8 mm from the centre
 * (x 36.8), so the id starts 1.2 mm beyond the ring, and the choice text starts after the id.
 */
export const CHOICE_ID = { x: 38, sizePt: 6.5, grey: 0.6 };
export const QUESTION_ID = { sizePt: 9, grey: 0.4 };
const LABEL_X = 45;
const QUESTIONS_TOP = 104;
const QUESTIONS_BOTTOM = 223; // last oval row must end above the bottom markers' centre line (228)
const CUT_Y = TEAR_LINE_Y_MM;

export type FontKey = "regular" | "bold" | "mono";
export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutOval {
  choiceId: string;
  /** Where the choice id (for example `c2`) is printed, marker frame, mm. Light grey, outside the oval and its baseline ring. */
  idBox: Box;
  /** Centre in the marker frame, mm. */
  center: Point;
  /** Same point as fractions of the marker rectangle (0..1 across and down): scale-free for the scanner. */
  uv: Point;
  widthMm: number;
  heightMm: number;
}
export interface LayoutQuestion {
  id: string;
  maxMarks: number;
  headingBox: Box;
  /** Where the question id is printed (for example `Q1` for `q1`), marker frame, mm. */
  idBox: Box;
  ovals: LayoutOval[];
}
export interface BallotLayout {
  schemaVersion: "0.1";
  layoutVersion: number;
  electionCode: string;
  units: "mm";
  origin: string;
  page: { size: "Letter"; widthMm: number; heightMm: number };
  frame: { widthMm: number; heightMm: number };
  markers: { id: "TL" | "TR" | "BL" | "BR"; shape: "square"; sizeMm: number; center: Point }[];
  oval: { shape: "ellipse"; widthMm: number; heightMm: number; outline: string; sampleScale: number; baselineRingScale: [number, number] };
  qr: { payloadFormat: string; errorCorrection: "M"; moduleMm: number; quietZoneModules: number; modules: number; /** the QR symbol itself (dark modules); the quiet zone lies outside it and must stay blank */ bbox: Box };
  ballotCodeText: { bbox: Box; format: string };
  /** Human-readable election code on the ballot body (above the tear). Not a scan mark. */
  electionCodeText: { bbox: Box; format: string };
  /** Human-readable election code on the tear-off receipt. */
  receiptElectionCodeText: { bbox: Box; format: string };
  /**
   * QR on the receipt only. Payload is an https link whose fragment is the election code.
   * It is not the machine-read QR (`qr`) and must not use the BEINGS1 payload.
   */
  receiptQr: {
    purpose: "voter-check-link";
    payloadFormat: string;
    url: string;
    errorCorrection: "M";
    moduleMm: number;
    quietZoneModules: number;
    modules: number;
    bbox: Box;
  };
  /** Page-frame y (mm, marker frame) of the dashed tear line. Everything the scanner reads lies ABOVE it; the receipt below is torn off first. */
  tearLineY: number;
  /** The receipt below the tear line: ballot code, note. Not scanned. */
  receiptStub: Box;
  examplesPanel: Box;
  questions: LayoutQuestion[];
  redaction: { keep: string[]; note: string };
}

export type DrawOp =
  | { op: "text"; text: string; x: number; y: number; size: number; font: FontKey; grey?: number; align?: "left" | "right" | "center" }
  | { op: "rect"; x: number; y: number; w: number; h: number; fill?: number; stroke?: number; strokeMm?: number }
  | { op: "line"; x1: number; y1: number; x2: number; y2: number; grey: number; mm: number; dash?: number[] }
  | { op: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill?: number; stroke?: number; strokeMm?: number };

export interface BallotSlots {
  codeText: { x: number; y: number; size: number; font: FontKey };
  qr: { x: number; y: number; moduleMm: number; modules: number };
  stubCode: { x: number; y: number; size: number; font: FontKey };
}

export interface BallotPlan {
  layout: BallotLayout;
  /** Everything identical on every ballot. */
  staticOps: DrawOp[];
  /** Where the ballot-specific items (code text, QR, receipt code) go, page coordinates. */
  slots: BallotSlots;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export async function makeFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  };
}

/** Width of `text` in mm. Throws a friendly error for characters the built-in fonts cannot print. */
export function textWidthMm(fonts: Fonts, key: FontKey, size: number, text: string): number {
  try {
    return (fonts[key].widthOfTextAtSize(text, size) / MM_TO_PT);
  } catch {
    throw new BeingsError("BAD_INPUT", `ballot text ${JSON.stringify(text)} has characters the built-in ballot fonts cannot print (Latin-1 letters and punctuation only)`);
  }
}

export function wrapText(fonts: Fonts, key: FontKey, size: number, text: string, maxWidthMm: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const push = (): void => {
    if (cur) lines.push(cur);
    cur = "";
  };
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (textWidthMm(fonts, key, size, trial) <= maxWidthMm) {
      cur = trial;
      continue;
    }
    push();
    if (textWidthMm(fonts, key, size, w) <= maxWidthMm) {
      cur = w;
      continue;
    }
    for (const ch of w) {
      // a single word wider than the line: break it by characters
      if (textWidthMm(fonts, key, size, cur + ch) > maxWidthMm) push();
      cur += ch;
    }
  }
  push();
  return lines.length ? lines : [""];
}

const NUMBER_WORDS = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN"];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** Text on the ballot that tells the voter how many marks a question allows. */
export function marksNote(maxMarks: number): string {
  return maxMarks === 1 ? "Mark ONE" : `Mark up to ${numberWord(maxMarks)}`;
}

/** Display form of a ballot code, groups of four: `4F9Q-7M2X-HT8B` (same as core's formatBallotCode). */
export function groupCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

export function qrPayload(electionCode: string, ballotCode: string): string {
  return `${QR_PAYLOAD_PREFIX}|${electionCode}|${ballotCode}|L${LAYOUT_VERSION}`;
}

/** Number of QR modules per side for this election's payloads (all payloads have the same length). */
export function qrModuleCount(electionCode: string): number {
  const q = QRCode.create(qrPayload(electionCode, "0".repeat(12)), { errorCorrectionLevel: "M" });
  return q.modules.size;
}

export interface PlanOptions {
  /** Public https origin for the receipt QR. Defaults to https://beingsvote.live. */
  siteOrigin?: string;
}

/** Solid black runs of a QR symbol, in page millimetres. */
function qrDrawOps(payload: string, x: number, y: number, moduleMm: number, expectedModules: number): DrawOp[] {
  const q = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const n = q.modules.size;
  if (n !== expectedModules) throw new BeingsError("BAD_INPUT", `QR code has ${n} modules, the layout expects ${expectedModules}`);
  const ops: DrawOp[] = [];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!q.modules.get(row, col)) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < n && q.modules.get(row, end + 1)) end++;
      ops.push({ op: "rect", x: x + col * moduleMm, y: y + row * moduleMm, w: (end - col + 1) * moduleMm, h: moduleMm, fill: 0 });
      col = end + 1;
    }
  }
  return ops;
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export async function buildPlan(election: Pick<ElectionFile, "electionCode" | "name" | "questions">, givenFonts?: Fonts, options?: PlanOptions): Promise<BallotPlan> {
  const fonts = givenFonts ?? (await makeFonts(await PDFDocument.create()));
  const ops: DrawOp[] = [];
  const text = (t: string, x: number, y: number, size: number, font: FontKey = "regular", extra: Partial<Extract<DrawOp, { op: "text" }>> = {}): void => {
    textWidthMm(fonts, font, size, t); // validates characters early
    ops.push({ op: "text", text: t, x, y, size, font, ...extra });
  };

  // ---- registration markers (page coordinates of their centres)
  const W = PAGE.widthMm;
  const H = PAGE.heightMm;
  const m = MARKER_INSET_MM;
  const bm = BOTTOM_MARKER_Y_MM;
  const centres = { TL: { x: m, y: m }, TR: { x: W - m, y: m }, BL: { x: m, y: bm }, BR: { x: W - m, y: bm } };
  if (CUT_Y - (bm + MARKER_SIZE_MM.BL / 2) < TEAR_CLEARANCE_MM) throw new BeingsError("BAD_INPUT", "bottom markers are too close to the tear line");
  void H;
  for (const id of ["TL", "TR", "BL", "BR"] as const) {
    const s = MARKER_SIZE_MM[id];
    ops.push({ op: "rect", x: centres[id].x - s / 2, y: centres[id].y - s / 2, w: s, h: s, fill: 0 });
  }
  const frameW = centres.TR.x - centres.TL.x;
  const frameH = centres.BL.y - centres.TL.y;
  const toFrame = (p: Point): Point => ({ x: r3(p.x - centres.TL.x), y: r3(p.y - centres.TL.y) });
  const toBox = (x: number, y: number, w: number, h: number): Box => ({ ...toFrame({ x, y }), width: r3(w), height: r3(h) });

  // ---- title (election name)
  const titleLines = wrapText(fonts, "bold", 14, election.name, 150);
  if (titleLines.length > 2) throw new BeingsError("BAD_INPUT", "the election name is too long for the ballot header (two lines at most)");
  titleLines.forEach((l, i) => text(l, W / 2, 24 + 6 * i, 14, "bold", { align: "center" }));

  // ---- ballot code (text) and QR slots
  text("BALLOT CODE", COL_LEFT, 40, 7, "bold", { grey: 0.35 });
  const codeSize = 20;
  const codeSlot = { x: COL_LEFT, y: 49, size: codeSize, font: "mono" as FontKey };
  const sampleCode = groupCode("0".repeat(12));
  const codeW = textWidthMm(fonts, "mono", codeSize, sampleCode);
  const codeBox = toBox(COL_LEFT, 49 - 6.2, codeW, 8.2);

  // Election code, human-readable, in the gap between the ballot code and the machine-read QR.
  // The gap is sized for the widest Crockford code so every election fits without moving the QR.
  const modules = qrModuleCount(election.electionCode);
  const qrSide = modules * QR_MODULE_MM;
  const qrX = 160;
  const qrY = 36;
  const qrBox = toBox(qrX, qrY, qrSide, qrSide);
  const quietLeft = qrX - QR_QUIET_MODULES * QR_MODULE_MM;
  const widestCode = "BEINGS-2026-WWWWWW";
  let headerSize = 13;
  let headerW = textWidthMm(fonts, "bold", headerSize, widestCode);
  const headerXMin = COL_LEFT + codeW + 4;
  while (headerXMin + headerW > quietLeft - 1.5 && headerSize > 9) {
    headerSize -= 0.5;
    headerW = textWidthMm(fonts, "bold", headerSize, widestCode);
  }
  if (headerXMin + headerW > quietLeft - 1.5) throw new BeingsError("BAD_INPUT", "the election code does not fit between the ballot code and the scan QR");
  const headerX = headerXMin;
  text("ELECTION", headerX, 40, 7, "bold", { grey: 0.35 });
  text(election.electionCode, headerX, 49, headerSize, "bold");
  const headerActualW = textWidthMm(fonts, "bold", headerSize, election.electionCode);
  const headerCap = (0.75 * headerSize) / MM_TO_PT;
  const electionCodeBox = toBox(headerX, 49 - headerCap, headerActualW, (0.95 * headerSize) / MM_TO_PT);
  if (overlaps(electionCodeBox, { ...qrBox, x: qrBox.x - QR_QUIET_MODULES * QR_MODULE_MM, width: qrBox.width + QR_QUIET_MODULES * QR_MODULE_MM })) {
    throw new BeingsError("BAD_INPUT", "the printed election code overlaps the scan QR");
  }

  // ---- instructions
  const boxX = COL_LEFT;
  const boxW = 130;
  const boxY = 54;
  let y = boxY + 5.5;
  const instr: DrawOp[] = [];
  const pushLines = (lines: string[], size: number, font: FontKey, leading: number, x = boxX + 3): void => {
    for (const l of lines) {
      textWidthMm(fonts, font, size, l);
      instr.push({ op: "text", text: l, x, y, size, font });
      y += leading;
    }
  };
  pushLines(wrapText(fonts, "bold", 10, "Fill in the oval completely. Do not write anything on this ballot.", boxW - 6), 10, "bold", 4.6);
  y += 0.6;
  for (const b of [
    "Use a dark felt pen, marker or ballpoint pen. Avoid red, orange or yellow ink and highlighters. Pencil may be read as unclear.",
    "Mark no more than the number shown for each question.",
    "Spoiled it? Ask for a new ballot.",
  ]) {
    const lines = wrapText(fonts, "regular", 8, b, boxW - 9);
    instr.push({ op: "text", text: "-", x: boxX + 3, y, size: 8, font: "regular" });
    pushLines(lines, 8, "regular", 3.7, boxX + 6);
    y += 0.5;
  }
  const boxH = y - boxY - 1.5;
  if (boxY + boxH > 82) throw new BeingsError("BAD_INPUT", "instructions do not fit their panel");
  ops.push({ op: "rect", x: boxX, y: boxY, w: boxW, h: boxH, stroke: 0.55, strokeMm: 0.3 });
  ops.push(...instr);

  // ---- examples of right and wrong marks (spec 6.3). Not read by the scanner.
  const exY = 86;
  const exH = 14;
  const colW = (COL_RIGHT - COL_LEFT) / 5;
  const exBox = toBox(COL_LEFT, exY, COL_RIGHT - COL_LEFT, exH);
  const examples: { head: string; sub: string; draw: (cx: number, cy: number) => DrawOp[] }[] = [
    { head: "RIGHT", sub: "fill completely", draw: (cx, cy) => [{ op: "ellipse", cx, cy, rx: 3, ry: 2.25, fill: 0 }] },
    {
      head: "WRONG",
      sub: "tick or cross",
      draw: (cx, cy) => [
        { op: "line", x1: cx - 2, y1: cy, x2: cx - 0.6, y2: cy + 1.6, grey: 0, mm: 0.4 },
        { op: "line", x1: cx - 0.6, y1: cy + 1.6, x2: cx + 2.6, y2: cy - 2, grey: 0, mm: 0.4 },
      ],
    },
    { head: "WRONG", sub: "dot or thin line", draw: (cx, cy) => [{ op: "ellipse", cx, cy, rx: 0.5, ry: 0.5, fill: 0 }] },
    { head: "WRONG", sub: "circled", draw: (cx, cy) => [{ op: "ellipse", cx, cy, rx: 5, ry: 3.8, stroke: 0, strokeMm: 0.35 }] },
    { head: "WRONG", sub: "half filled", draw: (cx, cy) => [{ op: "rect", x: cx - 3, y: cy - 2.25, w: 3, h: 4.5, fill: 0 }] },
  ];
  examples.forEach((ex, i) => {
    const cx = COL_LEFT + colW * i + 6;
    const cy = exY + 5.5;
    ops.push({ op: "ellipse", cx, cy, rx: OVAL.widthMm / 2, ry: OVAL.heightMm / 2, stroke: OVAL_OUTLINE_GREY, strokeMm: 0.26 });
    ops.push(...ex.draw(cx, cy));
    text(ex.head, cx + 8.5, cy - 0.6, 7, "bold");
    text(ex.sub, cx + 8.5, cy + 2.6, 6.5, "regular");
  });
  ops.push({ op: "line", x1: COL_LEFT, y1: 102, x2: COL_RIGHT, y2: 102, grey: 0.75, mm: 0.25 });

  // ---- questions
  /** Box of a printed id given its left edge, baseline (page mm), font size (pt) and width: cap height above, a little below. */
  const idBoxOf = (x: number, baseline: number, sizePt: number, w: number): Box => {
    const sMm = sizePt / MM_TO_PT;
    return toBox(x, baseline - 0.75 * sMm, w, 0.95 * sMm);
  };
  const qidW = Math.max(...election.questions.map((q) => textWidthMm(fonts, "bold", QUESTION_ID.sizePt, q.id.toUpperCase()))) + 2.5;
  const qOut = (pitch: number): { ops: DrawOp[]; questions: LayoutQuestion[]; bottom: number } => {
    const qops: DrawOp[] = [];
    const qs: LayoutQuestion[] = [];
    let cur = QUESTIONS_TOP;
    election.questions.forEach((q, qi) => {
      const note = marksNote(q.maxMarks);
      const noteW = textWidthMm(fonts, "bold", 9, note);
      const headLines = wrapText(fonts, "bold", 11, q.text, COL_RIGHT - COL_LEFT - noteW - 4 - qidW);
      const headTop = cur;
      // question id (Q1) in front of the heading, on the same baseline
      const qidText = q.id.toUpperCase();
      qops.push({ op: "text", text: qidText, x: COL_LEFT, y: headTop + 4, size: QUESTION_ID.sizePt, font: "bold", grey: QUESTION_ID.grey });
      const qidBox = idBoxOf(COL_LEFT, headTop + 4, QUESTION_ID.sizePt, textWidthMm(fonts, "bold", QUESTION_ID.sizePt, qidText));
      headLines.forEach((l, i) => qops.push({ op: "text", text: l, x: COL_LEFT + qidW, y: headTop + 4 + 5 * i, size: 11, font: "bold" }));
      qops.push({ op: "text", text: note, x: COL_RIGHT, y: headTop + 4, size: 9, font: "bold", align: "right", grey: 0.3 });
      const headBottom = headTop + 5 * headLines.length + 1;
      let rowTop = headBottom;
      const ovals: LayoutOval[] = [];
      for (const c of q.choices) {
        const labelLines = wrapText(fonts, "regular", 10.5, c.text, COL_RIGHT - LABEL_X);
        if (labelLines.length > 2) throw new BeingsError("BAD_INPUT", `${q.id}/${c.id}: choice text is too long for the ballot (two lines at most)`);
        const cy = rowTop + pitch / 2;
        qops.push({ op: "ellipse", cx: OVAL_CX, cy, rx: OVAL.widthMm / 2, ry: OVAL.heightMm / 2, stroke: OVAL_OUTLINE_GREY, strokeMm: 0.26 });
        // choice id (c2): small and light, beside the oval, vertically centred on it
        const idBase = cy + (0.36 * CHOICE_ID.sizePt) / MM_TO_PT;
        qops.push({ op: "text", text: c.id, x: CHOICE_ID.x, y: idBase, size: CHOICE_ID.sizePt, font: "regular", grey: CHOICE_ID.grey });
        const cidBox = idBoxOf(CHOICE_ID.x, idBase, CHOICE_ID.sizePt, textWidthMm(fonts, "regular", CHOICE_ID.sizePt, c.id));
        labelLines.forEach((l, i) => qops.push({ op: "text", text: l, x: LABEL_X, y: cy + 1.35 + 4.6 * i, size: 10.5, font: "regular" }));
        const c0 = toFrame({ x: OVAL_CX, y: cy });
        ovals.push({ choiceId: c.id, idBox: cidBox, center: c0, uv: { x: r3(c0.x / frameW), y: r3(c0.y / frameH) }, widthMm: OVAL.widthMm, heightMm: OVAL.heightMm });
        rowTop += pitch + (labelLines.length - 1) * 4.6;
      }
      qs.push({ id: q.id, maxMarks: q.maxMarks, headingBox: toBox(COL_LEFT, headTop, COL_RIGHT - COL_LEFT, headBottom - headTop), idBox: qidBox, ovals });
      cur = rowTop + 1;
      if (qi < election.questions.length - 1) {
        qops.push({ op: "line", x1: COL_LEFT, y1: cur + 1, x2: COL_RIGHT, y2: cur + 1, grey: 0.85, mm: 0.2 });
        cur += 4;
      }
    });
    return { ops: qops, questions: qs, bottom: cur };
  };
  let chosen: ReturnType<typeof qOut> | undefined;
  for (const pitch of OVAL_PITCH_MM) {
    const t = qOut(pitch);
    if (t.bottom <= QUESTIONS_BOTTOM) {
      chosen = t;
      break;
    }
  }
  if (!chosen) {
    const need = qOut(OVAL_PITCH_MM[OVAL_PITCH_MM.length - 1] as number).bottom;
    throw new BeingsError("BAD_INPUT", `the questions do not fit on one Letter page (need ${r3(need - QUESTIONS_TOP)} mm of ${QUESTIONS_BOTTOM - QUESTIONS_TOP} mm at the tightest oval spacing); reduce the number of choices or shorten the text`);
  }
  ops.push(...chosen.ops);

  // ---- tear line and tear-off receipt (below the tear line: not scanned, no registration marks, no ovals)
  ops.push({ op: "line", x1: COL_LEFT + 9, y1: CUT_Y, x2: COL_RIGHT, y2: CUT_Y, grey: 0.35, mm: 0.35, dash: [2.2, 1.6] });
  // scissors icon (vector, so it needs no special font): two finger loops and two crossing blades, pointing along the line
  {
    const sx = COL_LEFT + 5.5;
    ops.push({ op: "ellipse", cx: sx - 2.2, cy: CUT_Y - 1.5, rx: 1.1, ry: 1.1, stroke: 0.2, strokeMm: 0.3 });
    ops.push({ op: "ellipse", cx: sx - 2.2, cy: CUT_Y + 1.5, rx: 1.1, ry: 1.1, stroke: 0.2, strokeMm: 0.3 });
    ops.push({ op: "line", x1: sx - 1.2, y1: CUT_Y - 1.1, x2: sx + 2.6, y2: CUT_Y + 0.9, grey: 0.2, mm: 0.35 });
    ops.push({ op: "line", x1: sx - 1.2, y1: CUT_Y + 1.1, x2: sx + 2.6, y2: CUT_Y - 0.9, grey: 0.2, mm: 0.35 });
  }
  text("TEAR HERE", COL_LEFT + 11, CUT_Y - 1.4, 7, "bold", { grey: 0.2 });

  // Receipt QR: an https link with the election code in the fragment. No ballot code.
  // It sits below the tear, clear of the corner zones the scanner uses for registration marks.
  const checkUrl = checkPageUrl(election.electionCode, options?.siteOrigin);
  const receiptModules = QRCode.create(checkUrl, { errorCorrectionLevel: "M" }).modules.size;
  const receiptSide = receiptModules * RECEIPT_QR_MODULE_MM;
  const receiptQuiet = RECEIPT_QR_QUIET_MODULES * RECEIPT_QR_MODULE_MM;
  if (7 * RECEIPT_QR_MODULE_MM >= SCANNER_MIN_MARKER_MM) throw new BeingsError("BAD_INPUT", "receipt QR finder pattern could be read as a registration mark");
  // Stay out of the right-hand corner (20 mm) and out of the neighbourhood the scanner
  // searches around the bottom-right registration mark (8 mm past its centre, plus a small gap).
  const qrRight = Math.min(PAGE.widthMm - 21, PAGE.widthMm - MARKER_INSET_MM - 8 - 1.5);
  const receiptQrX = r3(qrRight - receiptSide);
  const receiptQrY = CUT_Y + 4.5;
  if (receiptQrY - receiptQuiet <= CUT_Y) throw new BeingsError("BAD_INPUT", "receipt QR quiet zone crosses the tear line");
  if (receiptQrX + receiptSide > qrRight + 0.01) throw new BeingsError("BAD_INPUT", "receipt QR enters the corner-mark margin");
  const textRight = receiptQrX - receiptQuiet - 2;
  const textW = textRight - COL_LEFT;
  if (textW < 70) throw new BeingsError("BAD_INPUT", "receipt text column is too narrow");
  const widestReceipt = textWidthMm(fonts, "bold", 12, widestCode);
  if (widestReceipt > textW) throw new BeingsError("BAD_INPUT", "the election code does not fit on the receipt");

  const stubName = wrapText(fonts, "regular", 7.5, election.name, Math.max(20, textW - 22))[0] ?? "";
  text(`RECEIPT  ${stubName}`, COL_LEFT, CUT_Y + 6.2, 7.5, "bold");
  text("ELECTION", COL_LEFT, CUT_Y + 11.4, 7, "bold", { grey: 0.35 });
  const receiptCodeSize = 12;
  text(election.electionCode, COL_LEFT, CUT_Y + 16.6, receiptCodeSize, "bold");
  const receiptCodeW = textWidthMm(fonts, "bold", receiptCodeSize, election.electionCode);
  const receiptCap = (0.75 * receiptCodeSize) / MM_TO_PT;
  const receiptElectionBox = toBox(COL_LEFT, CUT_Y + 16.6 - receiptCap, receiptCodeW, (0.95 * receiptCodeSize) / MM_TO_PT);
  const stubSlot = { x: COL_LEFT, y: CUT_Y + 24.6, size: 16, font: "mono" as FontKey };
  const note = wrapText(fonts, "regular", 8, "Keep this receipt private. Scan the square to open this election, then type your ballot code.", textW);
  if (note.length > 2) throw new BeingsError("BAD_INPUT", "receipt note does not fit");
  note.forEach((l, i) => text(l, COL_LEFT, CUT_Y + 30 + 3.6 * i, 8, "regular"));
  const noteBottom = CUT_Y + 30 + 3.6 * Math.max(0, note.length - 1) + 3.2;
  const qrBottom = receiptQrY + receiptSide + receiptQuiet;
  const stubBottom = Math.max(noteBottom, qrBottom);
  if (stubBottom > PAGE.heightMm - 2) throw new BeingsError("BAD_INPUT", "receipt does not fit on the page");
  ops.push(...qrDrawOps(checkUrl, receiptQrX, receiptQrY, RECEIPT_QR_MODULE_MM, receiptModules));
  const receiptQrBox = toBox(receiptQrX, receiptQrY, receiptSide, receiptSide);
  const stubBox = toBox(COL_LEFT, CUT_Y + 2, qrRight - COL_LEFT, stubBottom - (CUT_Y + 2));
  if (receiptQrBox.y <= toFrame({ x: 0, y: CUT_Y }).y) throw new BeingsError("BAD_INPUT", "receipt QR is not below the tear line");
  if (overlaps(receiptQrBox, qrBox)) throw new BeingsError("BAD_INPUT", "receipt QR overlaps the scan QR");

  const layout: BallotLayout = {
    schemaVersion: "0.1",
    layoutVersion: LAYOUT_VERSION,
    electionCode: election.electionCode,
    units: "mm",
    origin: "centre of the top-left (TL) registration marker; x to the right, y down, in mm on the printed page",
    page: { size: "Letter", widthMm: PAGE.widthMm, heightMm: PAGE.heightMm },
    frame: { widthMm: r3(frameW), heightMm: r3(frameH) },
    markers: (["TL", "TR", "BL", "BR"] as const).map((id) => ({ id, shape: "square" as const, sizeMm: MARKER_SIZE_MM[id], center: toFrame(centres[id]) })),
    oval: { shape: "ellipse", widthMm: OVAL.widthMm, heightMm: OVAL.heightMm, outline: "light grey drop-out colour", sampleScale: OVAL.sampleScale, baselineRingScale: OVAL.baselineRing },
    qr: { payloadFormat: `${QR_PAYLOAD_PREFIX}|<electionCode>|<ballotCode>|L<layoutVersion>`, errorCorrection: "M", moduleMm: QR_MODULE_MM, quietZoneModules: QR_QUIET_MODULES, modules, bbox: qrBox },
    ballotCodeText: { bbox: codeBox, format: "groups of four joined by '-', for example 4F9Q-7M2X-HT8B (the QR payload holds the code without dashes)" },
    electionCodeText: { bbox: electionCodeBox, format: "BEINGS-YYYY-XXXXXX, printed in full" },
    receiptElectionCodeText: { bbox: receiptElectionBox, format: "BEINGS-YYYY-XXXXXX, printed in full on the receipt" },
    receiptQr: {
      purpose: "voter-check-link",
      payloadFormat: `${PUBLIC_SITE_ORIGIN}${CHECK_PAGE_PATH}#e=<electionCode>`,
      url: checkUrl,
      errorCorrection: "M",
      moduleMm: RECEIPT_QR_MODULE_MM,
      quietZoneModules: RECEIPT_QR_QUIET_MODULES,
      modules: receiptModules,
      bbox: receiptQrBox,
    },
    tearLineY: toFrame({ x: 0, y: CUT_Y }).y,
    receiptStub: stubBox,
    examplesPanel: exBox,
    questions: chosen.questions,
    redaction: {
      keep: ["questions[].ovals", "questions[].ovals[].idBox", "questions[].idBox", "qr.bbox", "ballotCodeText.bbox"],
      note: "Everything outside these regions may be blurred or cropped before an image is published (spec 3.2). The receipt below tearLineY, including receiptQr, is torn off before the ballot is cast and scanning. receiptQr is a web link that carries the election code only. It is not the machine-read QR. examplesPanel is printed text, not a mark to be read.",
    },
  };
  return {
    layout,
    staticOps: ops,
    slots: { codeText: codeSlot, qr: { x: qrX, y: qrY, moduleMm: QR_MODULE_MM, modules }, stubCode: stubSlot },
  };
}

/** The public layout alone (no PDF needed): anyone can re-derive it from the election file. */
export async function buildLayout(election: Pick<ElectionFile, "electionCode" | "name" | "questions">, options?: PlanOptions): Promise<BallotLayout> {
  return (await buildPlan(election, undefined, options)).layout;
}
