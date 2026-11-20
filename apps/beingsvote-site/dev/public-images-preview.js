// Local preview only. Synthetic election BEINGS-2026-TEST42. No real ballot codes, no network fetches on load.
import { fill, h, icon, callout } from "../public/js/ui.js";
import { headingWithHelp, labelWithHelp } from "../public/js/help.js";
import { DEFAULT_IMAGE_RETENTION_DAYS, IMAGE_RETENTION_MAX_DAYS, ballotImageFailure, retentionRange } from "../public/js/logic.js";
import { publicImagesCallout, publicImagesNotice, publicImageLookup } from "../public/js/public-images.js";

const ELECTION = "BEINGS-2026-TEST42";
const params = new URLSearchParams(location.search);
const startTheme = params.get("theme");
if (startTheme === "dark" || startTheme === "light") document.documentElement.setAttribute("data-theme", startTheme);
const view = params.get("view") || "create";

document.getElementById("theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
});

function field({ id, help, label, type = "text", value, min, max, hint }) {
  return h(
    "div",
    { class: "field" },
    help ? labelWithHelp(id, label, help) : h("label", { for: id }, label),
    h("input", { id, name: id, type, value: value ?? null, min, max, autocomplete: "off", spellcheck: "false", "aria-describedby": hint ? `${id}-hint` : null }),
    hint ? h("p", { id: `${id}-hint`, class: "hint" }, hint) : null,
  );
}

function createMock() {
  const days = field({
    id: "c-days",
    help: "create.days",
    label: "Keep ballot images for (days)",
    type: "number",
    value: String(DEFAULT_IMAGE_RETENTION_DAYS),
    min: 1,
    max: IMAGE_RETENTION_MAX_DAYS,
    hint: `1 to ${IMAGE_RETENTION_MAX_DAYS}. They are removed automatically afterwards.`,
  });
  const publicCb = h("input", { id: "c-public-images", type: "checkbox", checked: true });
  const publicRow = h("div", { class: "field check-row" }, publicCb, labelWithHelp("c-public-images", "Public ballot images", "create.publicImages"));
  const daysInput = days.querySelector("input");
  const daysHint = days.querySelector(".hint");
  const sync = () => {
    const on = publicCb.checked;
    const { min, max } = retentionRange(on);
    daysInput.min = String(min);
    daysInput.max = String(max);
    const n = Number(daysInput.value);
    if (!Number.isFinite(n) || n < min) daysInput.value = String(min);
    else if (n > max) daysInput.value = String(max);
    daysHint.textContent = on
      ? `30 to 60 days when pictures are public (${DEFAULT_IMAGE_RETENTION_DAYS} is the default). They are removed automatically afterwards. Fingerprints and readings stay on the chain.`
      : `1 to ${IMAGE_RETENTION_MAX_DAYS}. They are removed automatically afterwards.`;
  };
  publicCb.addEventListener("change", sync);
  sync();
  return h(
    "section",
    { class: "card" },
    ...headingWithHelp("h1", { id: "create-h" }, "Create a new election", "create.publicImages"),
    h("p", { class: "muted small" }, "Mock preview only. Election ", h("code", null, ELECTION), ". No real ballots or codes."),
    publicRow,
    days,
  );
}

function resultsMock() {
  return [
    h("p", { class: "muted small" }, "Mock preview only. Election ", h("code", null, ELECTION), ". No real ballots or codes. The lookup does not fetch until you press the button."),
    publicImagesNotice({ headingId: "r-public-images" }),
    publicImageLookup({ electionCode: ELECTION, headingId: "r-public-lookup" }),
  ];
}

function checkMock() {
  return h(
    "section",
    { class: "card", "aria-labelledby": "img-h" },
    h("h1", { id: "img-h" }, icon("image", { size: 22 }), "The scan of your ballot"),
    h("p", { class: "muted" }, "Mock preview only. Nothing is downloaded until you press the button."),
    publicImagesCallout(),
    h("p", { class: "muted" }, "The picture is not downloaded yet. The answers above already come from the ledger."),
    h("button", { class: "btn btn-primary", type: "button" }, icon("image", { size: 18 }), "View original ballot image"),
  );
}

function expiredMock() {
  const fail = ballotImageFailure(410, "Image expired");
  return [
    h("p", { class: "muted small" }, "Mock preview only. Election ", h("code", null, ELECTION), ". This is the message after the public keep-for window."),
    publicImagesNotice({ headingId: "r-public-images" }),
    h("section", { class: "card" }, h("h2", null, "Look up a ballot picture"), callout(fail.tone, fail.title, fail.text)),
  ];
}

const root = document.getElementById("app");
if (view === "results") fill(root, ...resultsMock());
else if (view === "check") fill(root, checkMock());
else if (view === "expired") fill(root, ...expiredMock());
else fill(root, createMock());
