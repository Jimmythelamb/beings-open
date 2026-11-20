// Browser build of the ballot designer: the SAME layout and drawing code as @beings/ballot-gen, so a PDF made on the
// website reads with the same mark reader (packages/scanner/prototype) and has the same layout fingerprint.
export { buildLayout, buildPlan, makeFonts, checkPageUrl, CHECK_PAGE_PATH, PUBLIC_SITE_ORIGIN } from "../../../../packages/ballot-gen/src/plan.ts";
export { renderPdf } from "../../../../packages/ballot-gen/src/render.ts";
export { PDFDocument } from "pdf-lib";
