// "What was recorded, and why it matters": every fingerprint and value the ledger keeps for an election, in plain words,
// each with a copy button and, where a browser can do it, a "Check it yourself" button that recomputes the value from a
// file on this computer and compares. Files chosen here are read in this browser only; nothing is uploaded or signed.
import { h, icon, badge, callout, copyText } from "./ui.js";
import { headingWithHelp } from "./help.js";
import { shortHash, shortAddress } from "./format.js";
import { canonicalize, sha256Hex } from "./format.js";
import { merkleRoot, utf8 } from "./logic.js";
import { designLayout } from "./ballotpdf.js";
import { checkElectionFileText, checkBallotListText, checkLayout, checkResultsText, checkBuildBytes } from "./fingerprints.js";

const STAGE_LEAD = {
  preview: "Nothing is on the ledger yet. When you press \"Create it on the ledger\", these values are written there for good. You don't need to type or copy any of them; this list is here so you can see what is being promised and why.",
  created: "These values are on the public ledger. None of them reveals a ballot code or how anyone voted. Together they let anyone, years from now, check that the election wasn't changed after the fact.",
};

/** A shortened value with a copy button (full value in the title and for screen readers). */
export function valueWithCopy(value, { label = "value", address = false } = {}) {
  if (!value) return h("span", { class: "muted" }, "—");
  const shown = address ? shortAddress(value) : shortHash(value, 10, 8);
  return h("span", { class: "fp-value" }, h("code", { class: "code", title: value }, shown), h("span", { class: "sr-only" }, ` (full value ${value})`), h("button", { class: "icon-btn", type: "button", "aria-label": `Copy ${label}`, title: "Copy", onClick: () => copyText(value, "Copied") }, icon("copy", { size: 16 })));
}

function resultLine(slot, r) {
  const tone = r.ok === true ? "ok" : r.ok === false ? "bad" : "info";
  const title = r.ok === true ? "It matches" : r.ok === false ? "It doesn't match" : "Can't tell from this file";
  slot.replaceChildren(callout(tone === "bad" ? "warn" : tone, title, r.message, r.ok === true ? "check" : "alert"));
}

/** A file picker that reads the chosen file here and runs `run(fileObject)`. */
function filePicker({ id, label, accept, run, slot }) {
  const input = h("input", { type: "file", id, accept, class: "sr-only-file" });
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    slot.replaceChildren(h("p", { class: "muted small" }, "Checking…"));
    try {
      resultLine(slot, await run(f));
    } catch (e) {
      resultLine(slot, { ok: null, message: String(e?.message ?? e) });
    }
  });
  return h("label", { class: "btn btn-sm file-btn", for: id }, icon("search", { size: 16 }), label, input);
}

/** Helpers the "Check it yourself" buttons need: hashing here in the browser, and the ballot re-design. */
export function checkDeps() {
  return {
    sha256Hex,
    canonicalize,
    utf8,
    merkleRoot,
    design: (f) => designLayout(f),
    getKeccak: async () => {
      const { getEthers } = await import("./chain.js");
      const ethers = await getEthers();
      return (b) => ethers.keccak256(b);
    },
  };
}

let seq = 0;
/** The "Check it yourself" control for one item, or null. deps: hashing and design helpers (see recordedSection). */
export function checkControl(item, { file, deps }) {
  const c = item.check;
  if (!c) return null;
  const slot = h("div", { class: "fp-check-out", role: "status" });
  const id = `fp-check-${++seq}`;
  let control = null;
  if (c.kind === "computed") control = h("p", { class: "ok-line small" }, icon("check", { size: 16 }), "Computed on this page just now from what you entered.");
  else if (c.kind === "link") control = h("a", { class: "btn btn-sm", href: c.href }, c.text);
  else if (c.kind === "stations") {
    const s = c.status;
    control = h("p", { class: s.quorumMet && s.allApproved ? "ok-line small" : "warn-line small" }, icon(s.quorumMet && s.allApproved ? "check" : "alert", { size: 16 }), `${s.count} of ${s.quorum} needed registered${s.count ? (s.allApproved ? "; every one runs an approved build" : "; one or more run a build that isn't approved") : ""}. Checked against the ledger just now.`);
  } else if (c.kind === "layout") {
    if (!file?.questions?.length || !c.expected) return null;
    const btn = h("button", { class: "btn btn-sm", type: "button" }, icon("search", { size: 16 }), "Re-design the ballot and compare");
    btn.addEventListener("click", async () => {
      slot.replaceChildren(h("p", { class: "muted small" }, "Designing…"));
      resultLine(slot, await checkLayout(file, c.expected, deps.design));
    });
    control = btn;
  } else if (c.kind === "election-file") {
    control = filePicker({ id, label: "Choose the election file to compare", accept: "application/json,.json", slot, run: async (f) => checkElectionFileText(await f.text(), c.expected, deps) });
  } else if (c.kind === "ballot-list") {
    control = filePicker({ id, label: "Choose the secret full file to compare", accept: "application/json,.json", slot, run: async (f) => checkBallotListText(await f.text(), c.expected, { keccak: await deps.getKeccak(), merkleRoot: deps.merkleRoot, utf8: deps.utf8 }) });
  } else if (c.kind === "results-file") {
    control = filePicker({ id, label: "Choose the results file to compare", accept: "application/json,.json", slot, run: async (f) => checkResultsText(await f.text(), c.expected, deps) });
  } else if (c.kind === "build-file") {
    if (!c.expected.length) return null;
    control = filePicker({ id, label: "Choose a scanner software file to hash", accept: "", slot, run: async (f) => checkBuildBytes(new Uint8Array(await f.arrayBuffer()), c.expected, deps) });
  }
  if (!control) return null;
  return h("div", { class: "fp-check" }, h("p", { class: "fp-check-h" }, "Check it yourself"), control, slot);
}

function itemView(item, ctx) {
  const many = item.values && (item.values.length > 1 || item.id === "stations");
  const valuePart = many
    ? item.values.length
      ? h("ul", { class: "plain-list fp-values" }, item.values.map((v) => h("li", null, valueWithCopy(v.value, { label: item.name, address: item.id === "stations" }), " ", badge(v.label, v.tone), v.note ? h("span", { class: "muted small" }, ` ${v.note}`) : null)))
      : h("p", { class: "muted" }, item.pending)
    : item.value
      ? h("div", null, valueWithCopy(item.value, { label: item.name }), item.values?.[0] ? h("span", null, " ", badge(item.values[0].label, item.values[0].tone), h("span", { class: "muted small" }, ` ${item.values[0].note}`)) : null)
      : h("p", { class: "muted" }, item.pending ?? "Not recorded yet.");
  const hasValue = Boolean(item.value || item.values?.length);
  return h(
    "li",
    { class: "fp-item", "data-item": item.id },
    h("h3", { class: "fp-name" }, item.name),
    valuePart,
    h("details", { class: "fp-why", open: ctx.openWhy ? true : null }, h("summary", null, "Why it matters"), h("p", null, item.why)),
    hasValue ? checkControl(item, ctx) : null,
  );
}

/**
 * The whole section. items: from recordedItems(). opts: { stage, file (public or draft election file, for re-designing),
 * deps: { sha256Hex, canonicalize, utf8, design, getKeccak, merkleRoot }, openWhy }.
 */
export function recordedSection(items, { stage = "created", file = null, deps = {}, openWhy = false, id = "recorded-h" } = {}) {
  return h(
    "section",
    { class: "card recorded-panel", "aria-labelledby": id },
    headingWithHelp("h2", { id }, [icon("shield", { size: 22 }), "What was recorded, and why it matters"], "recorded.panel"),
    h("p", { class: "muted" }, STAGE_LEAD[stage] ?? STAGE_LEAD.created),
    h("ol", { class: "fp-list" }, items.map((it) => itemView(it, { file, deps, openWhy }))),
  );
}
