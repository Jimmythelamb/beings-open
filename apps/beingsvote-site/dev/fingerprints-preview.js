// LOCAL PREVIEW ONLY (dev/, not deployed). Mock data: a throwaway wallet made in this browser, a made-up election
// BEINGS-2026-TEST42 and made-up values. Nothing reads or changes the ledger; no transaction can be sent from here
// (the Register button is shown but the organizer check uses a mock election).
//   python3 -m http.server 8891 --bind 127.0.0.1   (from apps/beingsvote-site)
//   http://127.0.0.1:8891/dev/fingerprints-preview.html?theme=light&view=create|admin|results
import { createCard, stationRegistration } from "../public/js/admin.js";
import { recordedPanelView } from "../public/js/results.js";
import { state } from "../public/js/roles.js";
import { h, fill, callout } from "../public/js/ui.js";
import { headingWithHelp } from "../public/js/help.js";
import { designLayout } from "../public/js/ballotpdf.js";
import { walletInfoBox } from "../public/js/wallet-info.js";

const ethers = window.ethers;
const q = new URLSearchParams(location.search);
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
const view = q.get("view") ?? "create";
const wallet = ethers.Wallet.createRandom(); // mock organizer, never funded, never used to send
const CODE = "BEINGS-2026-TEST42";
const QB_APP = "06694fe1cdf4766e89d713efca9c78dcf82f413b8de2907fff946aa895695527";
const app = document.getElementById("app");
const banner = callout("info", "Local preview, mock data", "Made-up election and a throwaway wallet made in this browser. Nothing here reads or changes the ledger.");

if (view === "create") {
  state.address = wallet.address;
  state.status = "ready";
  const card = createCard({ query: new URLSearchParams("new=1") });
  fill(app, banner, card);
} else {
  const file = {
    name: "Room 12 class rep (mock)",
    electionCode: CODE,
    layoutHash: null, // set below by designing the mock ballot, so "Check it yourself" can match
    approvedAppHashes: [QB_APP],
    questions: [{ id: "q1", text: "Who should be class rep?", maxMarks: 1, choices: [{ id: "c1", text: "Alex" }, { id: "c2", text: "Sam" }] }],
  };
  file.layoutHash = (await designLayout(file)).layoutHash;
  const el = { code: CODE, key: ethers.id(CODE), status: view === "admin" ? 1 : 4, quorum: 1, organizer: wallet.address, ballotListRoot: ethers.id("mock-list"), version: { fileSha256: ethers.id("mock-file") } };
  const devices = view === "admin" ? [] : [{ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", appHash: "0x" + QB_APP }];
  const tally = view === "admin" ? null : { merkleRoot: ethers.id("mock-merkle"), resultsSha256: ethers.id("mock-results") };
  const blocks = [banner];
  if (view === "admin") {
    blocks.push(h("section", { class: "card" }, h("h2", null, "Running the election"), headingWithHelp("h3", null, "Local Scanner/Printer (0)", "admin.device"), h("p", { class: "muted" }, "None registered yet."), stationRegistration({ el, file, can: true, isOrganizer: true, done: () => {} }), headingWithHelp("h3", null, "Open and close voting", "admin.openClose"), walletInfoBox({ variant: "admin", open: q.get("walletopen") === "1" })));
  }
  blocks.push(recordedPanelView({ el, file, tally, devices, recordSha256: view === "admin" ? null : ethers.id("mock-record") }));
  fill(app, ...blocks);
}
document.body.dataset.ready = "1";
