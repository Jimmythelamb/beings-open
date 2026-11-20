// LOCAL PREVIEW ONLY. Synthetic Brother names. Nothing talks to a helper, a wallet, or the ledger.
//   python3 -m http.server 8891 --bind 127.0.0.1   (from apps/beingsvote-site)
//   http://127.0.0.1:8891/dev/helper-connect-preview.html
import { fill, h } from "../public/js/ui.js";
import { connectStatusElement, CONNECT_LABEL } from "../public/js/helper-connect.js";

document.documentElement.dataset.theme = "light";

const scanner = { name: "Brother DCP-L2640DW", connection: "network" };
const printer = { name: "Brother DCP-L2640DW", port: "BRW123456789ABC", connection: "network" };

const shots = [
  ["Not installed", { state: "not-installed" }],
  ["Installed, not running", { state: "installed-not-running" }],
  ["Connected", { state: "running", scanner, printer, restoredScanner: true }],
  ["Update available", { state: "update-available", version: "0.1.0", publishedVersion: "0.2.0", scanner, printer }],
  ["Preview page blocked", { state: "forbidden", pageOrigin: "https://deploy-preview-3--beingsvote.netlify.app" }],
].filter(([, model]) => {
  const want = new URLSearchParams(location.search).get("state");
  return !want || want === model.state;
});

const app = document.getElementById("app");
fill(
  app,
  h("h1", null, "Connect printer & scanner"),
  h("p", { class: "muted" }, "Synthetic preview of the button states. These names are not from a real computer."),
  ...shots.map(([title, model]) =>
    h(
      "section",
      { class: "card helper-connect", "data-shot": model.state },
      h("h2", null, title),
      h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button" }, CONNECT_LABEL)),
      connectStatusElement(model),
    ),
  ),
);
