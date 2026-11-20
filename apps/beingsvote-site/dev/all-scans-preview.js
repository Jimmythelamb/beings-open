// Local preview only. Synthetic election BEINGS-2026-TEST42, made-up hashes, drawn pictures. No real ballot codes.
import { fill, h } from "../public/js/ui.js";
import { buildScanList, applyComputedHash, summarizeScans, packScanArchive, scanZipName } from "../public/js/scans.js";
import { scanPanel, urlsForBlobs, openScanViewer } from "../public/js/scans-ui.js";

const ELECTION = "BEINGS-2026-TEST42";
const H = (n) => n.toString(16).padStart(2, "0").repeat(32);
const KEY = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);

const questions = [
  { id: "q1", text: "Class president", maxMarks: 1, choices: [{ id: "c1", text: "Alex" }, { id: "c2", text: "Blair" }] },
  { id: "q2", text: "Picnic day", maxMarks: 1, choices: [{ id: "c1", text: "Friday" }, { id: "c2", text: "Saturday" }] },
];

const ledgerEntries = [
  { ballotKey: KEY(4), results: "U|B", imageSha256: H(0xdd) },
  { ballotKey: KEY(1), results: "V:c1|V:c2", imageSha256: H(0xaa) },
  { ballotKey: KEY(5), results: "B|B", imageSha256: H(0xee) },
  { ballotKey: KEY(3), results: "O|V:c1", imageSha256: H(0xcc) },
  { ballotKey: KEY(2), results: "V:c2|B", imageSha256: H(0xbb) },
];

function paintPng(label, bg, fg) {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 560;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(24, 24, 372, 512);
  ctx.fillStyle = fg;
  ctx.font = "bold 28px Inter, sans-serif";
  ctx.fillText("Sample ballot", 48, 90);
  ctx.font = "20px Inter, sans-serif";
  ctx.fillText(label, 48, 140);
  ctx.fillText("Synthetic preview — no real codes", 48, 180);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 3;
  ctx.strokeRect(48, 230, 28, 28);
  ctx.beginPath();
  ctx.moveTo(52, 244);
  ctx.lineTo(72, 244);
  ctx.stroke();
  ctx.fillText("Alex", 90, 254);
  ctx.strokeRect(48, 280, 28, 28);
  ctx.fillText("Blair", 90, 304);
  const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0));
  return { bytes, contentType: "image/png", ext: "png" };
}

const blobs = new Map([
  [H(0xaa), paintPng("Alex, Saturday", "#e8f5e9", "#14532d")],
  [H(0xbb), paintPng("Blair, blank", "#e3f2fd", "#1e3a8a")],
  [H(0xcc), paintPng("Overvote on Q1", "#fff8e1", "#78350f")],
]);

const built = buildScanList({
  ledgerEntries,
  storeImages: [
    { imageHash: H(0xaa), contentType: "image/png", size: blobs.get(H(0xaa)).bytes.length },
    { imageHash: H(0xbb), contentType: "image/png", size: blobs.get(H(0xbb)).bytes.length },
    { imageHash: H(0xcc), contentType: "image/png", size: blobs.get(H(0xcc)).bytes.length },
    { imageHash: H(0xff), contentType: "image/png", size: 12 },
  ],
  questions,
  expiredOmitted: 1,
});

let items = built.items.map((item) => {
  if (item.recordedHash === H(0xaa)) return applyComputedHash(item, H(0xaa));
  if (item.recordedHash === H(0xbb)) return applyComputedHash(item, H(0x11));
  if (item.recordedHash === H(0xcc)) return applyComputedHash(item, H(0xcc));
  if (item.recordedHash === H(0xdd)) return { ...item, status: "expired", reason: "The picture has passed its keep-for period and is no longer available. The fingerprint stays on the ledger." };
  if (item.recordedHash === H(0xee)) return item; // missing
  if (item.storeHash === H(0xff)) return { ...item, status: "not-on-ledger" };
  return item;
});
// Force a true mismatch for the Blair ballot (Ballot A2 after sorting by key)
items = items.map((item) => (item.recordedHash === H(0xbb) ? applyComputedHash(item, H(0x11)) : item));

const summary = summarizeScans(items, { expiredOmitted: 1, setCompare: built.setCompare });
const urls = urlsForBlobs(blobs);

const startTheme = new URLSearchParams(location.search).get("theme");
if (startTheme === "dark" || startTheme === "light") document.documentElement.setAttribute("data-theme", startTheme);

function theme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
}
document.getElementById("theme-btn").addEventListener("click", () => (theme(), paint()));

function paint() {
  const root = document.getElementById("app");
  fill(
    root,
    h("p", { class: "muted small" }, "Mock preview only. Election ", h("code", null, ELECTION), ". No real ballots or codes."),
    scanPanel({
      items,
      urls,
      summary,
      canAct: true,
      hint: h("p", { class: "muted small" }, "In the real site this card lives on Admin and Verifier only, after a wallet signature. Pictures are listed as Ballot A1, A2, … by hashed ballot key, not print or scan order. The public results page does not show this gallery."),
      onLoad: () => {},
      onVerify: () => {},
      onDownload: () => {
        const zip = packScanArchive({ electionCode: ELECTION, items, blobs, summary, generatedAt: "2026-11-10T22:00:00.000Z", date: new Date("2026-11-10T22:00:00Z") });
        const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = scanZipName(ELECTION);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      headingId: "preview-scans",
      title: "All ballot scans",
    }),
  );
}

paint();
if (new URLSearchParams(location.search).has("viewer")) {
  openScanViewer({ items, urls, start: items[0], returnFocus: document.getElementById("theme-btn") });
}
