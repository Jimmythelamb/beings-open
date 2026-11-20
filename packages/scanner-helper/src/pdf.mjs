// Page count of a ballot PDF, for the print step's check. Uses pdf-lib (already used by @beings/ballot-gen).
import { PDFDocument } from "pdf-lib";

export async function countPdfPages(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head !== "%PDF-") throw new Error("not a PDF file");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

/** Compare the PDF's pages with what the operator expects to print. */
export function printPageCheck(pages, expected) {
  if (expected == null) return { ok: true, message: `${pages} pages` };
  if (!Number.isSafeInteger(expected) || expected < 1) return { ok: false, message: "the expected page count must be a whole number of 1 or more" };
  return pages === expected ? { ok: true, message: `${pages} pages, as expected` } : { ok: false, message: `the PDF has ${pages} pages but ${expected} were expected: not printing` };
}
