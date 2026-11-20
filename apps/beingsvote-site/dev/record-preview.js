// LOCAL PREVIEW ONLY (not shipped: lives in dev/, outside public/). Renders the Results page for a MOCK election with the
// new "Election record and organizer notes" panel, and the admin "Notes and the election record" card.
// Mock data: a throwaway wallet made in this browser signs the note; no real ballot code, no real key, nothing is sent.
//   python3 -m http.server 8890  (from apps/beingsvote-site)  then open  http://localhost:8890/dev/record-preview.html?theme=dark
import { electionView, recordPanelView } from "../public/js/results.js";
import { notesCard } from "../public/js/notes-ui.js";
import { h, fill, callout } from "../public/js/ui.js";
import * as R from "../public/js/record.js";

const ethers = window.ethers;
const q = new URLSearchParams(location.search);
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
const CODE = "BEINGS-2026-QB1TTH";
const KEY = ethers.id(CODE);
const wallet = ethers.Wallet.createRandom();
const TEXT = "Check R6 failed because the registered-voter number posted with the tally was 7, while the registry still lists 6 registered voters — the number fixed when the election was created. Six students voted, and one teacher cast a 7th ballot but was not supposed to vote. All 7 recorded ballots stay as read, and the official counts stay as posted. This is a classroom test. This note is an explanation; it does not change the counts or clear the flag.";

const pubRes = await fetch("../public/data/elections/BEINGS-2026-QB1TTH.json");
const pub = await pubRes.json();
const questions = pub.file.questions;
const el = { code: CODE, key: KEY, organizer: wallet.address, status: 4, ballotCount: 7, registeredVoters: 6, recordCount: 7, opensAt: 1794300000, closesAt: 1794350000, version: { fileSha256: "0x8b0eb63413ffbc42de9d018c6dd83a4f19a9c4eb35537062a10eb3d83cfa5c43", cid: "local-unpublished:" + CODE }, resultCount: 1 };
const perQuestion = [{ valid: 7, blank: 0, overvote: 0, unclear: 0 }, { valid: 7, blank: 0, overvote: 0, unclear: 0 }];
const tally = { version: 1, final: false, failedChecks: 32, perQuestion, recon: { registered: 7, printed: 7, issued: 7, cast: 7, spoiled: 0, unusedReturned: 0, unissued: 0 } };
const recount = [{ ...perQuestion[0], byChoice: { c1: 1, c2: 4, c3: 0, c4: 2 } }, { ...perQuestion[1], byChoice: { c1: 3, c2: 2, c3: 2 } }];

const note = R.draftNote({ electionCode: CODE, electionKey: KEY, tallyVersion: 1, author: wallet.address, role: "organizer", checks: ["R6"], text: TEXT, createdAt: "2026-11-11T01:58:26.000Z" });
const td = R.noteTypedData(note, ethers.keccak256);
const signed = R.attachSignature(note, await wallet.signTypedData(td.domain, td.types, td.message), { keccak256: ethers.keccak256, verifyTypedData: ethers.verifyTypedData });
const noteSha = await R.noteFileSha256(signed);
const model = {
  code: CODE,
  failedIds: ["R6"],
  final: false,
  notesContract: q.get("anchored") === "1",
  manifest: { retention: { keepUntil: null }, files: [] },
  manifestSha256: "0x3c035c243545d93b7ad6812b09a94ce27543643e03e9da77f44800a55442b425",
  manifestAnchor: q.get("anchored") === "1" ? null : undefined,
  files: [
    { path: "election.public.json", role: "public-election-copy", sha256: "1a5671c88468433337660292f5835897ef17df38f96cc1720609f15f77b87df7", state: "match" },
    { path: "notes/organizer-note-1.json", role: "official-note", sha256: noteSha.slice(2), state: "match" },
    { path: "results.json", role: "results-doc", sha256: "554e8a21ff93f2c382963eebe8b6c21105eca12a15ef1ee840eaeda2229622e1", state: "match", matchesOnChainResultsHash: true },
  ],
  notes: [{ path: "notes/organizer-note-1.json", note: signed, signed: true, sig: R.verifyNoteSignature(signed, { keccak256: ethers.keccak256, verifyTypedData: ethers.verifyTypedData }), role: { confirmed: true, actual: "organizer" }, noteSha256: noteSha, anchor: q.get("anchored") === "1" ? { author: wallet.address, role: "organizer", tallyVersion: 1, postedAt: 1794362400, index: 0 } : undefined }],
  url: null,
  bytes: {},
};

const app = document.getElementById("app");
const banner = callout("info", "Local preview, mock data", "Synthetic wallet made in this browser; no real ballot code or key. Nothing here reads or changes the ledger.");
if (q.get("view") === "admin") {
  fill(app, banner, notesCard({ ...el, organizer: "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB" }));
} else {
  const blocks = electionView({ el, fileRes: { file: pub.file, check: "unverifiable" }, questions, tally, recount, history: { records: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [ethers.id(`mock-ballot-${i}`), "V:c1|V:c1"])), corrections: [] }, metrics: null });
  const recon = blocks.findIndex((b) => b?.getAttribute?.("aria-labelledby") === "recon-h");
  const panel = h("section", { class: "card record-panel", "aria-labelledby": "record-h" });
  fill(panel, ...recordPanelView(model));
  blocks.splice(recon + 1, 0, panel);
  fill(app, banner, ...(q.get("only") === "record" ? [blocks[recon], panel] : blocks));
}
document.body.dataset.ready = "1";
if (q.get("scroll") === "record") document.getElementById("record-h")?.scrollIntoView();
if (q.get("scroll") === "recon") document.getElementById("recon-h")?.scrollIntoView();
