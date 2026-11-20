// Customer view of one authorized batch. Dry-run until a service outside this browser is armed.
// This screen does not hold a signing key and does not create elections.
import { labelWithHelp } from "./help.js";
import { h, icon, callout } from "./ui.js";
import { downloadBlob, kvList } from "./staff.js";
import { readDelegatedSnapshot } from "./chain.js";
import { createBatchSession, explainBatch } from "./delegated.js";

export function delegatedCard(electionCode) {
  const status = h("div");
  const file = h("input", { id: "batch-file", type: "file", accept: "application/json,.json" });
  let session = null;
  let manifest = null;
  const paint = (title, text, tone, extra) => {
    status.replaceChildren(callout(tone, title, text), extra ?? null);
  };
  const summaryList = (explained) => kvList([
    ["Ballots in this batch", String(explained.summary.ballots)],
    ["Already on the ledger", String(explained.summary.alreadyRecorded)],
    ["Still to record", String(explained.summary.remaining)],
    ["Blank answers kept", String(explained.summary.B)],
    ["Overvotes kept", String(explained.summary.O)],
    ["Unclear answers kept", String(explained.summary.U)],
    ["Gas estimate", explained.cost.estimatedWei == null ? "Not available yet" : `${explained.cost.estimatedWei} wei, including ${explained.cost.contingencyBps / 100}% contingency`],
    ["Customer gas price", explained.cost.fiatGasMinor == null ? "Not set. Paid signing stays off." : `${explained.cost.fiatGasMinor} minor units`],
  ]);
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    chosen.text().then((text) => {
      manifest = JSON.parse(text);
      const opened = createBatchSession({ manifest });
      if (!opened.ok) {
        session = null;
        paint("This batch cannot be used", opened.problems[0], "warn");
        return;
      }
      session = opened.session;
      const explained = explainBatch({ manifest, chain: null, prepaid: null, quote: null, now: Math.floor(Date.now() / 1000) });
      paint(
        "Dry run. The ledger has not been checked yet.",
        "Nothing has been signed or sent. This browser does not hold a signing key.",
        "info",
        h("div", null, explained.blockers.length ? h("ul", { class: "plain-list" }, explained.blockers.map((line) => h("li", null, line))) : null, summaryList(explained)),
      );
    }).catch(() => paint("That file isn't a batch", "Nothing was read from it.", "warn"));
  });
  const check = h("button", { class: "btn btn-primary", type: "button" }, "Check readiness");
  check.addEventListener("click", () => {
    if (!session || !manifest) return paint("Choose the batch file first", "Nothing was checked.", "info");
    if (manifest.electionCode !== electionCode) {
      paint("This batch is for a different election", "Open the election named in the batch, or choose the matching file. Nothing was signed.", "warn");
      return;
    }
    check.disabled = true;
    readDelegatedSnapshot(manifest.electionCode, manifest.scanner, manifest.items.map((item) => item.ballotKey)).then((chain) => {
      check.disabled = false;
      const explained = session.explain(chain, null, null);
      const tone = explained.blockers.length ? "warn" : "ok";
      const title = explained.blockers.length ? "Not ready to sign" : "Ready for a dry run";
      paint(title, explained.blockers[0] ?? "The batch matches this open election. Signing still happens only on the scanner service, and only after dry run is turned off there.", tone, h("div", null, explained.blockers.length > 1 ? h("ul", { class: "plain-list" }, explained.blockers.map((line) => h("li", null, line))) : null, summaryList(explained)));
    }).catch(() => {
      check.disabled = false;
      paint("The ledger didn't answer", "Nothing was signed or sent.", "warn");
    });
  });
  const stop = h("button", { class: "btn", type: "button" }, "Stop this batch");
  stop.addEventListener("click", () => {
    if (!session) return;
    const result = session.stop("Stopped from the admin page.");
    paint("Stopped", result.message, "warn");
  });
  const download = h("button", { class: "btn", type: "button" }, "Download the receipt");
  download.addEventListener("click", () => {
    if (!session) return paint("Choose the batch file first", "There is no receipt yet.", "info");
    downloadBlob(`${manifest.electionCode}-batch-receipt.json`, JSON.stringify(session.receipt(), null, 2), "application/json");
  });
  return h(
    "section",
    { class: "card", id: "a-batch", "aria-labelledby": "batch-h" },
    h("h2", { id: "batch-h" }, icon("clipboard", { size: 22 }), "Sign a prepared batch"),
    h("p", null, "Choosing a file does not approve it. Your own wallet, the one that created the election, has to approve that exact batch. The registered scanner still has to sign every ballot. This page does neither, and it never stores a signing key."),
    h("p", { class: "muted small" }, "Picture retention is not changed here. The approved review period is 14 days plus a 7-day margin. Dispute holds, voter confirmation, and a global verifier consensus are not part of this step."),
    h("div", { class: "field" }, labelWithHelp("batch-file", "Batch authorization file", "printed.batch"), file),
    h("div", { class: "actions" }, check, stop, download),
    status,
  );
}
