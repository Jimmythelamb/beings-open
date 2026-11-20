/** Draws the ballots (one per page, US Letter) from a plan. Pure PDF drawing, no layout decisions. */
import { PDFDocument, grayscale, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { BeingsError } from "@beings/core";
import { MM_TO_PT, PAGE, QR_QUIET_MODULES, groupCode, makeFonts, qrPayload, textWidthMm, type BallotPlan, type DrawOp, type Fonts } from "./plan.js";

const pt = (mm: number): number => mm * MM_TO_PT;

function drawOp(page: PDFPage, fonts: Fonts, op: DrawOp): void {
  const H = pt(PAGE.heightMm);
  const Y = (mm: number): number => H - pt(mm);
  switch (op.op) {
    case "text": {
      let x = pt(op.x);
      const w = pt(textWidthMm(fonts, op.font, op.size, op.text));
      if (op.align === "right") x -= w;
      else if (op.align === "center") x -= w / 2;
      page.drawText(op.text, { x, y: Y(op.y), size: op.size, font: fonts[op.font], color: grayscale(op.grey ?? 0) });
      break;
    }
    case "rect":
      page.drawRectangle({
        x: pt(op.x),
        y: Y(op.y + op.h),
        width: pt(op.w),
        height: pt(op.h),
        ...(op.fill !== undefined ? { color: grayscale(op.fill) } : {}),
        ...(op.stroke !== undefined ? { borderColor: grayscale(op.stroke), borderWidth: pt(op.strokeMm ?? 0.3) } : {}),
      });
      break;
    case "line":
      page.drawLine({ start: { x: pt(op.x1), y: Y(op.y1) }, end: { x: pt(op.x2), y: Y(op.y2) }, thickness: pt(op.mm), color: grayscale(op.grey), ...(op.dash ? { dashArray: op.dash.map(pt) } : {}) });
      break;
    case "ellipse":
      page.drawEllipse({
        x: pt(op.cx),
        y: Y(op.cy),
        xScale: pt(op.rx),
        yScale: pt(op.ry),
        ...(op.fill !== undefined ? { color: grayscale(op.fill) } : {}),
        ...(op.stroke !== undefined ? { borderColor: grayscale(op.stroke), borderWidth: pt(op.strokeMm ?? 0.3) } : {}),
      });
      break;
  }
}

/** QR code as solid black vector squares (runs of dark modules merged per row), at an exact physical size. */
function drawQr(page: PDFPage, payload: string, plan: BallotPlan): void {
  const q = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const n = q.modules.size;
  const { x, y, moduleMm, modules } = plan.slots.qr;
  if (n !== modules) throw new BeingsError("BAD_INPUT", `QR code has ${n} modules, the layout expects ${modules}`);
  const H = pt(PAGE.heightMm);
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!q.modules.get(row, col)) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < n && q.modules.get(row, end + 1)) end++;
      page.drawRectangle({ x: pt(x + col * moduleMm), y: H - pt(y + (row + 1) * moduleMm), width: pt((end - col + 1) * moduleMm), height: pt(moduleMm), color: grayscale(0) });
      col = end + 1;
    }
  }
  void QR_QUIET_MODULES;
}

export interface RenderInput {
  plan: BallotPlan;
  electionCode: string;
  /** Ballot codes in PRINT order (one page each). */
  ballotCodes: readonly string[];
}

/** Renders the batch PDF. Deterministic: the same inputs give the same bytes. */
export async function renderPdf(input: RenderInput, makeDoc?: () => Promise<{ doc: PDFDocument; fonts: Fonts }>): Promise<Uint8Array> {
  const { plan, electionCode, ballotCodes } = input;
  const { doc, fonts } = makeDoc ? await makeDoc() : await (async () => { const d = await PDFDocument.create(); return { doc: d, fonts: await makeFonts(d) }; })();
  const fixed = new Date(Date.UTC(2026, 0, 1));
  doc.setTitle(`Ballots ${electionCode}`);
  doc.setProducer("@beings/ballot-gen");
  doc.setCreator("@beings/ballot-gen");
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  for (const code of ballotCodes) {
    const page = doc.addPage([pt(PAGE.widthMm), pt(PAGE.heightMm)]);
    for (const op of plan.staticOps) drawOp(page, fonts, op);
    const c = plan.slots.codeText;
    drawOp(page, fonts, { op: "text", text: groupCode(code), x: c.x, y: c.y, size: c.size, font: c.font });
    const s = plan.slots.stubCode;
    drawOp(page, fonts, { op: "text", text: groupCode(code), x: s.x, y: s.y, size: s.size, font: s.font });
    drawQr(page, qrPayload(electionCode, code), plan);
  }
  return doc.save({ useObjectStreams: false });
}
