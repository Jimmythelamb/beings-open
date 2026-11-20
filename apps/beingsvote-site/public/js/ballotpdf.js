// Ballot designer: the printable ballot PDF and the ballot layout fingerprint, made in the browser with the same
// layout and drawing code as @beings/ballot-gen (bundled in vendor/ballot-gen.js, loaded only when needed).
// The layout depends only on the election code, name and questions, so its fingerprint can be put into the election
// file before the file itself is fingerprinted. The PDF adds the secret ballot codes, one ballot per page, in a random
// print order. Nothing is uploaded: the PDF is made and downloaded on this computer.
import { canonicalize, sha256Hex } from "./format.js";
import { CONFIG } from "./config.js";

let vendor = null;
/** Load the bundled generator once. `loader` is replaceable in tests. */
export async function loadBallotGen(loader = () => import("../vendor/ballot-gen.js")) {
  vendor ??= await loader();
  return vendor;
}

/** The only parts of an election file the ballot layout depends on. */
export function layoutInput(file) {
  if (!file || typeof file !== "object") throw new Error("No election to design.");
  const { electionCode, name, questions } = file;
  if (!electionCode || !name || !Array.isArray(questions) || !questions.length) throw new Error("Fill in the election name, code and at least one question first.");
  return { electionCode, name, questions };
}

/** sha-256 hex (64 lower-case characters) of the layout's canonical JSON: the same value as core's layoutHash(). */
export async function layoutFingerprint(layout) {
  return sha256Hex(new TextEncoder().encode(canonicalize(layout)));
}

/** Design the layout for a (draft) election file. Returns { layout, layoutHash }. */
export async function designLayout(file, gen) {
  const g = gen ?? (await loadBallotGen());
  const layout = await g.buildLayout(layoutInput(file), { siteOrigin: CONFIG.siteOrigin });
  return { layout, layoutHash: await layoutFingerprint(layout) };
}

/** Unbiased shuffle with a crypto random source (the print order is never written anywhere). */
export function shuffleCodes(codes, randomBytes) {
  const a = [...codes];
  const below = (n) => {
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const b = randomBytes(4);
      const v = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
      if (v < limit) return v % n;
    }
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The printable PDF for a prepared election file (with ballot codes and layoutHash).
 * Refuses when the file's layoutHash is not the layout this designer draws (questions changed after designing).
 * Returns { pdf: Uint8Array, pages, layout, layoutHash }.
 */
export async function ballotPdf(file, { randomBytes, gen } = {}) {
  if (!Array.isArray(file?.ballotCodes) || !file.ballotCodes.length) throw new Error("This election file has no ballot codes. Prepare the election first, or load the secret full file.");
  const g = gen ?? (await loadBallotGen());
  const doc = await g.PDFDocument.create();
  const fonts = await g.makeFonts(doc);
  const plan = await g.buildPlan(layoutInput(file), fonts, { siteOrigin: CONFIG.siteOrigin });
  const layoutHash = await layoutFingerprint(plan.layout);
  if (file.layoutHash && String(file.layoutHash).replace(/^0x/i, "").toLowerCase() !== layoutHash) throw new Error("The ballot layout fingerprint in this file is not the layout drawn from its name and questions. Design the ballot again before preparing, so the printed paper matches what goes on the ledger.");
  const rnd = randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const order = shuffleCodes(file.ballotCodes, rnd);
  const pdf = await g.renderPdf({ plan, electionCode: file.electionCode, ballotCodes: order }, async () => ({ doc, fonts }));
  const pages = (await g.PDFDocument.load(pdf)).getPageCount();
  if (pages !== file.ballotCodes.length) throw new Error(`The PDF has ${pages} pages but there are ${file.ballotCodes.length} ballot codes.`);
  return { pdf, pages, layout: plan.layout, layoutHash };
}
