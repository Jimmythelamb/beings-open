// Build the bundled synthetic test-page fixtures (PDF, PNG, election file, layout).
// Uses @beings/ballot-gen on the fixed fake election only. Never reads a real or private election file.
// Run from the monorepo with:  npx tsx packages/scanner-helper/tools/build-test-page-fixture.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { generateElection } from "../../ballot-gen/src/generate.ts";
import {
  SYNTHETIC_BALLOT_CODE,
  SYNTHETIC_BALLOT_KEY,
  SYNTHETIC_ELECTION_CODE,
  SYNTHETIC_ELECTION_NAME,
  fixturePaths,
} from "../src/testpage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../fixtures/test-print-scan");

const input = {
  schemaVersion: "0.1",
  version: 1,
  name: SYNTHETIC_ELECTION_NAME,
  organizerPublicKey: "0x0000000000000000000000000000000000000001",
  questions: [
    {
      id: "q1",
      text: "Is this a test print and scan? (not a real vote)",
      maxMarks: 1,
      choices: [
        { id: "c1", text: "Yes" },
        { id: "c2", text: "No" },
      ],
    },
  ],
  resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"], abstainButton: false },
  privacy: { redactImages: true, publishOrder: "sorted", timeGranularity: "event", minBreakdownSize: 10 },
  registeredVoters: 1,
  approvedAppHashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  quorum: 1,
  opensAt: "2026-11-11T16:00:00Z",
  closesAt: "2026-11-11T22:00:00Z",
  electionCode: SYNTHETIC_ELECTION_CODE,
  ballotCodes: [SYNTHETIC_BALLOT_CODE],
};

function stampPdf(bytes) {
  // pdf-lib y is from the bottom. The ballot receipt/stub is the bottom ~38 mm of a Letter page.
  // Stamping only there keeps the marks, QR and alignment boxes untouched.
  return (async () => {
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const { width } = page.getSize();
    const banner = "SYNTHETIC TEST PAGE — NOT A REAL BALLOT";
    const size = 9;
    const textWidth = font.widthOfTextAtSize(banner, size);
    page.drawRectangle({ x: 18, y: 8, width: width - 36, height: 28, color: rgb(1, 1, 1), borderColor: rgb(0.15, 0.15, 0.15), borderWidth: 1 });
    page.drawText(banner, { x: (width - textWidth) / 2, y: 18, size, font, color: rgb(0.1, 0.1, 0.1) });
    return await doc.save();
  })();
}

const g = await generateElection(input, { count: 1, rng: () => { throw new Error("rng should not be used: codes and election code are fixed"); } });
if (g.electionFile.ballotCodes[0] !== SYNTHETIC_BALLOT_CODE) throw new Error("generator changed the synthetic code");
if (g.electionFile.electionCode !== SYNTHETIC_ELECTION_CODE) throw new Error("generator changed the synthetic election code");

const stamped = await stampPdf(g.pdf);
mkdirSync(outDir, { recursive: true });
const paths = fixturePaths(outDir);
writeFileSync(paths.electionFile, JSON.stringify(g.electionFile, null, 2) + "\n");
writeFileSync(paths.layout, JSON.stringify(g.layout, null, 2) + "\n");
writeFileSync(paths.pdf, stamped);
writeFileSync(
  paths.meta,
  JSON.stringify(
    {
      synthetic: true,
      note: "Bundled fixture for the optional test print and scan. Not a real election. Do not record or upload.",
      electionCode: SYNTHETIC_ELECTION_CODE,
      electionName: SYNTHETIC_ELECTION_NAME,
      ballotCode: SYNTHETIC_BALLOT_CODE,
      ballotKey: SYNTHETIC_BALLOT_KEY,
      layoutHash: g.layoutHash,
      electionFileSha256: g.electionFileSha256,
    },
    null,
    2,
  ) + "\n",
);

const pdftoppm = process.env.PDFTOPPM || "pdftoppm";
const pngStem = join(outDir, "test-page");
execFileSync(pdftoppm, ["-png", "-r", "300", "-f", "1", "-l", "1", "-singlefile", paths.pdf, pngStem], { stdio: "inherit" });
if (!existsSync(paths.png)) throw new Error("pdftoppm did not write test-page.png");

console.log("Wrote fixtures to", outDir);
console.log("PDF bytes", stamped.length, "PNG bytes", readFileSync(paths.png).length);
