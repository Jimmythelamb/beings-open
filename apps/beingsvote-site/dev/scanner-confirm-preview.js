// LOCAL PREVIEW ONLY (dev/, not deployed). The helper responses are mocked in this page.
// Nothing talks to a real scanner, wallet or the ledger. Used to photograph found / not found / confirmed / test states.
//   python3 -m http.server 8891 --bind 127.0.0.1   (from apps/beingsvote-site)
//   http://127.0.0.1:8891/dev/scanner-confirm-preview.html?theme=light|dark&view=create|register&state=idle|found|notfound|confirmed|skipped|pass|fail|mocked
import { fill, h, callout, icon } from "../public/js/ui.js";
import { headingWithHelp, labelWithHelp } from "../public/js/help.js";
import { helperConnectCard } from "../public/js/helper-connect.js";
import { testPrintScanCard, testPrintScanAdvisory } from "../public/js/test-print-scan.js";
import { systemCheckCard } from "../public/js/system-check.js";

const q = new URLSearchParams(location.search);
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
const view = q.get("view") ?? "create";
const state = q.get("state") ?? "idle";
const app = document.getElementById("app");

const brother = {
  ok: true,
  service: "beings-scanner-bridge",
  scanners: [{ deviceId: "{X}\\0001", name: "Brother DCP-L2640DW", manufacturer: "Brother", connection: "network" }],
  printers: [
    { name: "Brother DCP-L2640DW series", driver: "Brother DCP-L2640DW Printer", connection: "network", status: "Normal" },
    { name: "Microsoft Print to PDF", driver: "Microsoft Print To PDF", connection: "other", status: "Normal" },
  ],
  stationWallet: null,
  errors: [],
};

const findState = ["skipped", "pass", "fail", "mocked"].includes(state) ? "confirmed" : state;
const twoScanners = {
  ...brother,
  scanners: [
    { deviceId: "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000", name: "Brother DCP-L2640DW [94ddf81050c9]", manufacturer: "Microsoft", port: "urn:uuid:example:ScannerService", connection: "network" },
    { deviceId: "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0002", name: "Brother DCP-L2640DW LAN", manufacturer: "Brother", port: "AUTO", connection: "network" },
  ],
};

function mockFetchFor(kind) {
  return async (url, opts) => {
    const u = String(url);
    if (kind === "notfound") throw new TypeError("Failed to fetch");
    if (u.includes("/v1/health") && (kind === "found" || kind === "confirmed" || kind === "idle" || kind === "choose" || kind === "check")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, service: "beings-scanner-bridge", version: "0.2.0", installedAt: "2026-11-01T15:00:00Z" }), headers: { get: () => "application/json" } };
    }
    if (u.includes("/v1/station") && (kind === "found" || kind === "confirmed" || kind === "idle" || kind === "choose" || kind === "check")) {
      const body = kind === "choose" || kind === "check" ? twoScanners : brother;
      return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => "application/json" } };
    }
    if (u.includes("/v1/diagnostics")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({
        ok: false,
        service: "beings-scanner-bridge",
        version: "0.1.0",
        checks: [
          { id: "helper", level: "ok", title: "Helper", detail: "The scanner helper is running (version 0.1.0).", fix: null },
          { id: "node", level: "ok", title: "Node.js", detail: "Node.js 22.23.4 is running this helper.", fix: null },
          { id: "pdf-lib", level: "ok", title: "pdf-lib", detail: "pdf-lib 1.17.1 is installed with the helper.", fix: null },
          { id: "sumatra", level: "ok", title: "Printing", detail: "Windows built-in printing will be used. Windows draws each page and sends it straight to the chosen printer, single-sided, at actual size, with no app window. SumatraPDF is not installed, and that is fine.", method: "Windows built-in", fix: null },
          { id: "printers", level: "warn", title: "Printers", detail: "Printers: Brother DCP-L2640DW series (offline, default). The check will use \"Brother DCP-L2640DW series\".", chosen: { name: "Brother DCP-L2640DW series", online: "offline" }, whatToDo: "The chosen printer looks offline. Turn it on and check the paper. If it is on Wi-Fi, this PC and the printer need the same network.", fix: null },
          { id: "scanners", level: "warn", title: "Scanners", detail: "Windows listed 2 entries for the same model. The helper will use \"Brother DCP-L2640DW LAN\" (the maker's own driver, not the Microsoft one).", fix: "remember-scanner", autoPick: { deviceId: "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0002", name: "Brother DCP-L2640DW LAN" }, sameModel: true },
          { id: "printer-network", level: "warn", title: "Printer network", detail: "This PC could not reach the printer address 192.168.1.50.", whatToDo: "The printer may be off, or this PC may be on a different Wi-Fi network. Move them onto the same network and try again.", fix: null },
          { id: "output", level: "ok", title: "Scan folder", detail: "The helper can write the scan folder.", fix: null },
          { id: "image-store", level: "ok", title: "Image store", detail: "The image store at https://beings-ballot-images.beingsvote-test.workers.dev answered (HTTP 400). Nothing was uploaded.", fix: null },
          { id: "synthetic-batches", level: "ok", title: "Earlier test scans", detail: "No unfinished synthetic test batch was found.", fix: null },
          { id: "signin", level: "info", title: "Start at sign-in", detail: "The helper does not start when you sign in. That is fine. You can turn it on if you want.", fix: "signin-start" },
        ],
      }) };
    }
    if (u.includes("/v1/test/prepare")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, synthetic: true, electionCode: "BEINGS-2026-TEST00", electionName: "SYNTHETIC TEST PAGE — NOT A REAL BALLOT", ballotCode: "TESTPRNTSC01", ballotKey: "0xbb39023f85d1ff8cb6e6cd1fa77bcf8e4f0d611c563f51032655096dd9dc1e51", mockTest: true, pdfPath: "/v1/test/page.pdf" }) };
    }
    if (u.includes("/v1/test/print")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, printed: false, mocked: true, message: "Mock preview: no real printer was used." }) };
    }
    if (u.includes("/v1/test/scan-and-read")) {
      const pass = kind !== "fail";
      const mocked = kind === "mocked" || kind === "pass" || kind === "idle" || kind === "found" || kind === "confirmed";
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () =>
          JSON.stringify({
            ok: true,
            pass,
            mocked: pass && mocked,
            checks: [
              { id: "read", ok: pass, label: pass ? "The mark reader returned a reading" : "The mark reader could not read the page", help: pass ? "" : "Mock failure for the preview." },
              { id: "code", ok: pass, label: pass ? "The reading recovered the synthetic test code" : "The recovered code does not match the synthetic test page", help: pass ? "" : "Mock failure for the preview." },
              { id: "fingerprint", ok: pass, label: pass ? "The ballot fingerprint matches" : "The ballot fingerprint does not match", help: pass ? "" : "Mock failure for the preview." },
            ],
            help: pass ? "The test print and scan passed." : "The test print and scan did not pass.",
            message: pass && kind === "mocked" ? "No Windows scanner was used. The helper read the bundled stand-in picture." : pass ? "The test print and scan passed. Nothing was recorded or uploaded." : "The test print and scan did not pass. Nothing was recorded or uploaded.",
            ballotKey: "0xbb39023f85d1ff8cb6e6cd1fa77bcf8e4f0d611c563f51032655096dd9dc1e51",
          }),
      };
    }
    if (u.includes("/v1/test/page.pdf")) {
      return { ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4 mock"], { type: "application/pdf" }) };
    }
    throw new TypeError("Failed to fetch");
  };
}

const memory = {};
const storage = {
  getItem: (k) => memory[k] ?? null,
  setItem: (k, v) => (memory[k] = v),
  removeItem: (k) => delete memory[k],
};

const banner = callout("info", "Local preview, mock helper", "The scanner answers on this page are made up (Brother DCP-L2640DW, and a stand-in test page). Nothing here talks to a real helper, a wallet or the ledger.");

let confirmed = null;
let testStatus = null;
const advisory = h("div", { class: "register-advisory" });
const registerBtn = h("button", { class: "btn btn-primary", type: "button" }, icon("shield", { size: 18 }), "Register Scanner/Printer");

const sync = () => {
  registerBtn.disabled = view !== "register";
  const text = testPrintScanAdvisory({ confirmed, testStatus });
  fill(advisory, text ? callout("info", "Optional checks", text) : null);
};

const find = helperConnectCard({
  fetchImpl: mockFetchFor(findState === "idle" ? "found" : findState),
  storage,
  pageOrigin: "https://deploy-preview-3--example.netlify.app",
  onChange: (c) => {
    confirmed = c;
    sync();
  },
});
const test = testPrintScanCard({
  fetchImpl: mockFetchFor(state),
  storage,
  getDevices: () => ({ printerName: confirmed?.printerName || "", scannerDeviceId: confirmed?.scannerDeviceId || "" }),
  onChange: (s) => {
    testStatus = s;
    sync();
  },
});
testStatus = test.getStatus();

const findBlock = h(
  "div",
  { class: view === "register" ? "find-station-wrap" : "find-station-wrap auto-block" },
  headingWithHelp("h3", null, "Connect printer & scanner", view === "register" ? "admin.findScanner" : "create.findScanner"),
  find.root,
  systemCheckCard({ fetchImpl: mockFetchFor(state) }).root,
  headingWithHelp("h3", null, "Test print and scan", view === "register" ? "admin.testPrintScan" : "create.testPrintScan"),
  test.root,
  view === "register" ? advisory : null,
);

const quorum = h(
  "div",
  { class: "field" },
  labelWithHelp("c-quorum-preview", "Local Scanner/Printer", "create.quorum"),
  h("input", { id: "c-quorum-preview", type: "number", value: "1", min: "1", max: "4" }),
  h("p", { class: "hint" }, "How many scanner/printer stations must be registered before voting opens. A classroom uses 1."),
);

const page = view === "register"
  ? h(
      "section",
      { class: "card" },
      h("h2", null, "Running the election"),
      headingWithHelp("h3", null, "Local Scanner/Printer (0)", "admin.device"),
      h("p", { class: "muted" }, "None registered yet."),
      h(
        "div",
        { class: "station-card" },
        h("h4", null, "Register Scanner/Printer"),
        h("p", { class: "small" }, "Approve the station that will scan this election's ballots. ", h("strong", null, "Only during Setup, before voting opens.")),
        findBlock,
        h("div", { class: "field" }, h("label", { for: "a-dev-pick" }, "Station wallet"), h("select", { id: "a-dev-pick" }, h("option", null, "B.E.I.N.G.S. classroom signing wallet (Coston2 test) (0xfB2A…d73D)"), h("option", null, "Paste a different wallet address…"))),
        h("div", { class: "actions" }, registerBtn),
      ),
    )
  : h(
      "details",
      { class: "card details-card", open: true },
      h("summary", null, h("h2", { class: "inline-h" }, icon("ticket", { size: 22 }), "Create a new election")),
      h("p", null, "Creating a new election will create a new quantified list of unique ballot codes which will become verified, certified and permanent blockchain ledger entries."),
      h("div", { class: "grid" }, quorum, h("div", { class: "field" }, h("label", { for: "c-days-preview" }, "Keep ballot images for (days)"), h("input", { id: "c-days-preview", type: "number", value: "30", min: "1" }), h("p", { class: "hint" }, "1 to 365. They are removed automatically afterwards."))),
      findBlock,
    );

fill(app, banner, page);

async function applyState() {
  if (state === "check") {
    const btn = document.querySelector("[data-system-check]");
    btn?.click();
    const start = Date.now();
    while (Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 30));
      if (document.querySelector("[data-system-report]")) break;
    }
  }
  if (findState !== "idle" && state !== "check") {
    find.findButton.click();
    const start = Date.now();
    while (Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 30));
      if (findState === "notfound") {
        if (find.findButton.disabled === false && find.root.querySelector(".callout-warn")) break;
      } else if (find.confirmButton && !find.confirmButton.hidden) {
        break;
      }
    }
    if ((findState === "confirmed" || ["skipped", "pass", "fail", "mocked"].includes(state)) && !find.confirmButton.hidden) {
      find.confirmButton.click();
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (state === "skipped") {
    test.skipButton.click();
  } else if (state === "pass" || state === "fail" || state === "mocked") {
    test.startButton.click();
    const start = Date.now();
    while (Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 30));
      if (!test.scanButton.hidden) break;
    }
    if (!test.scanButton.hidden) test.scanButton.click();
    await new Promise((r) => setTimeout(r, 80));
  }
  sync();
}

await applyState();
document.body.dataset.ready = "1";
document.body.dataset.state = state;
