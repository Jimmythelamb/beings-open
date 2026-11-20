// Voter lookup: ballot code -> plain-language ledger entry + the voter's own ballot image + "report a problem".
import { labelWithHelp, headingWithHelp } from "./help.js";
import { h, icon, badge, callout, spinner, setTitle, fmtDate, copyText, toast, explorerAddress, extLink, term } from "./ui.js";
import { CONFIG, fetchImageApi as fetch, resolveImagePath } from "./config.js";
import { discoverElections, getElection, loadElectionFile, getBallotEntry, loadEthers, REASONS } from "./chain.js";
import { normalizeBallotCode, normalizeElectionCode, formatBallotCode, splitLedgerResults, describeResult, sha256Hex, shortHash } from "./format.js";
import { createBallotImageView, isPublicBallotImages } from "./logic.js";
import { publicImagesCallout } from "./public-images.js";
import { electionTextFromFragment, isCheckDocumentPath, urlWithoutElectionFragment } from "./check-link.js";

const LAST_ELECTION = "beings.lastElection";
let ballotImage = null;

/** Forget the picture from the previous lookup, including one that is still downloading. */
function dropBallotImage() {
  const url = ballotImage?.reset();
  ballotImage = null;
  if (url) URL.revokeObjectURL(url);
}

export async function renderVoter(ctx) {
  const { root, query } = ctx;
  setTitle("Check my ballot");
  const loc = ctx.location ?? (typeof location !== "undefined" ? location : { pathname: "/", search: "", hash: "" });
  const hash = ctx.hash ?? loc.hash ?? "";
  const checkFile = ctx.checkPage ?? isCheckDocumentPath(loc.pathname);
  // The receipt link puts the election code in the fragment. The ballot code is never taken from the address.
  const carried = electionTextFromFragment(hash) || query.get("e") || query.get("election") || "";
  const fromLink = normalizeElectionCode(carried) || (carried ? String(carried).trim().toUpperCase() : "");
  const cleared = urlWithoutElectionFragment({ pathname: loc.pathname, search: loc.search || "", hash, checkFile });
  if (cleared != null && carried) {
    const replace = ctx.replaceState ?? ((...args) => history.replaceState(...args));
    replace(null, "", cleared);
  }
  const results = h("div", { class: "voter-results", "aria-live": "polite" });
  const remembered = (() => {
    try {
      return localStorage.getItem(LAST_ELECTION) ?? "";
    } catch {
      return "";
    }
  })();
  const datalist = h("datalist", { id: "known-elections" });
  const form = h(
    "form",
    { class: "card form", novalidate: true, autocomplete: "off" },
    field({ id: "v-election", help: "check.election", label: "Election code", hint: "Printed on your ballot and on the receipt. A square on the receipt can fill this in. It looks like BEINGS-2026-ABC123.", placeholder: "BEINGS-2026-ABC123", value: fromLink || remembered, list: "known-elections", capital: true }),
    field({ id: "v-ballot", help: "check.ballot", label: "Ballot code", hint: "The 12 letters and numbers on your receipt. You type this yourself. Dashes and capital letters don't matter.", placeholder: "XXXX-XXXX-XXXX", capital: true, mono: true }),
    h("button", { class: "btn btn-primary btn-lg", type: "submit" }, icon("search", { size: 18 }), "Find my ballot"),
    h("p", { class: "muted small privacy-note" }, icon("lock", { size: 14 }), " Your ballot code is only used to look up your own entry. It stays out of the web address, and your name is never on the ledger."),
  );
  form.append(datalist);

  const intro = h(
    "header",
    { class: "page-head" },
    h("h1", null, "Check my ballot"),
    h("p", { class: "lead" }, "Voted on paper? Your receipt has a ballot code. Enter it here to see exactly how your ballot was recorded on the public ledger. You can then choose to view the scan."),
  );
  root.replaceChildren(intro, form, results, helpCard());

  // known elections to suggest (names are loaded in the background; the form works without them)
  discoverElections().then(({ elections }) => {
    if (!ctx.current()) return;
    datalist.replaceChildren(...elections.map((e) => h("option", { value: e.code })));
  }).catch(() => {});

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const eInput = form.querySelector("#v-election");
    const bInput = form.querySelector("#v-ballot");
    const eErr = form.querySelector("#v-election-err");
    const bErr = form.querySelector("#v-ballot-err");
    eErr.textContent = bErr.textContent = "";
    eInput.removeAttribute("aria-invalid");
    bInput.removeAttribute("aria-invalid");
    const code = normalizeElectionCode(eInput.value);
    const strict = normalizeBallotCode(bInput.value);
    let bad = null;
    if (!code) (eErr.textContent = "That doesn't look like an election code. Check it against your receipt: BEINGS, a year, then six letters or numbers."), eInput.setAttribute("aria-invalid", "true"), (bad = bad ?? eInput);
    if (!strict) (bErr.textContent = "A ballot code has 12 letters and numbers (for example 4F9Q-7M2X-HT8B). Please check for a missing or extra character."), bInput.setAttribute("aria-invalid", "true"), (bad = bad ?? bInput);
    if (bad) return bad.focus();
    try {
      localStorage.setItem(LAST_ELECTION, code);
    } catch {
      /* private mode */
    }
    form.querySelector("button[type=submit]").disabled = true;
    results.replaceChildren(h("div", { class: "card" }, spinner("Looking up your ballot on the ledger…")));
    try {
      await lookup(results, code, strict, ctx);
    } finally {
      form.querySelector("button[type=submit]").disabled = false;
    }
  });
  // Do not look the ballot up from the link. The voter types the ballot code and presses the button.
  // Focus runs after the router moves focus to the heading, so the cursor is ready for the ballot code.
  if (fromLink) setTimeout(() => form.querySelector("#v-ballot")?.focus(), 0);
}

function field({ id, label, hint, placeholder, value, list, capital, mono, help }) {
  return h(
    "div",
    { class: "field" },
    help ? labelWithHelp(id, label, help) : h("label", { for: id }, label),
    h("input", { id, name: id, type: "text", inputmode: "text", autocomplete: "off", autocapitalize: capital ? "characters" : null, spellcheck: "false", placeholder, value: value || null, list, class: mono ? "mono" : null, "aria-describedby": `${id}-hint ${id}-err`, required: true }),
    h("p", { id: `${id}-hint`, class: "hint" }, hint),
    h("p", { id: `${id}-err`, class: "field-error", role: "alert" }),
  );
}

function helpCard() {
  return h(
    "section",
    { class: "card soft", "aria-labelledby": "voter-help" },
    h("h2", { id: "voter-help" }, "Good to know"),
    h(
      "ul",
      { class: "plain-list" },
      h("li", null, h("strong", null, "Your name isn't on the ledger. "), "The ledger only holds the marks that were read from your ballot, linked to the code on your receipt. Keep that code private, because anyone who has it can look up your ballot."),
      h("li", null, h("strong", null, "Not found? "), "Ballots appear after they have been scanned. Check the code, and that you picked the right election."),
      h("li", null, h("strong", null, "The scan is temporary. "), "The picture of your ballot is kept for a limited time and then deleted. Its fingerprint stays on the ledger permanently."),
    ),
  );
}

async function lookup(out, code, strict, ctx) {
  dropBallotImage();
  try {
    const { elections } = await discoverElections().catch(() => ({ elections: [] }));
    const hint = elections.find((e) => e.code === code) ?? {};
    const el = await getElection(code, hint);
    if (!ctx.current()) return;
    if (!el) {
      out.replaceChildren(h("div", { class: "card" }, callout("warn", "We couldn't find that election", `The ledger has no election called ${code}. Please check the election code on your receipt.`)));
      return;
    }
    const fileRes = await loadElectionFile(el).catch(() => null);
    const questions = fileRes?.file?.questions ?? null;
    // number of questions: from the file, else read as many as the ledger line has (handled after the first read)
    let entry = await getBallotEntry(el, strict, questions?.length ?? 0);
    if (!ctx.current()) return;
    if (!entry.found) {
      out.replaceChildren(notFound(el, entry, strict));
      return;
    }
    const segs = splitLedgerResults(entry.results);
    let qs = questions;
    if (!qs) qs = segs.map((_, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}`, maxMarks: 1, choices: [] }));
    else if (qs.length !== segs.length) entry.mismatch = true;
    // corrections: re-read now that the question count is known if we did not have the file
    if (!questions) entry = await getBallotEntry(el, strict, segs.length);
    ballotImage = createBallotImageView();
    const view = h("div", { class: "voter-view" });
    view.append(foundHeader(el, entry, fileRes?.file), answersCard(qs, segs, entry), imageCard(el, entry, strict, fileRes?.file), reportCard(el, entry, qs), technicalCard(el, entry));
    out.replaceChildren(view);
    view.querySelector("h2")?.focus?.();
  } catch (e) {
    dropBallotImage();
    out.replaceChildren(h("div", { class: "card" }, callout("warn", "We couldn't read the ledger just now", "The connection to the Flare test network failed. Nothing is wrong with your ballot. Please try again in a moment.")));
  }
}

function notFound(el, entry, strict) {
  return h(
    "div",
    { class: "card" },
    callout("warn", "We couldn't find this ballot code in this election", entry.spoiled ? "This ballot code was marked as spoiled (replaced by another ballot), so it was not counted." : "Either the code has a typo, it belongs to a different election, or the ballot hasn't been scanned yet."),
    h("p", null, "Codes you typed: ", h("code", { class: "code" }, formatBallotCode(strict)), " for ", h("code", { class: "code" }, el.code), "."),
    h("ul", { class: "plain-list" }, h("li", null, "Compare each character with your receipt. We treat the letter O as 0 and I or L as 1, the same way the ballots were printed."), h("li", null, el.status < 2 ? "Voting hasn't started yet." : el.status === 2 ? "Voting is still open, so your ballot may not have been scanned yet." : "If everything looks right, contact your election officer and give them the election code. You can also use “Report a problem” once your ballot is found.")),
  );
}

function foundHeader(el, entry, file) {
  return h(
    "section",
    { class: "card found", "aria-labelledby": "found-h" },
    h("div", { class: "found-top" }, h("span", { class: "found-icon" }, icon("check", { size: 28 })), h("div", null, h("h2", { id: "found-h", tabindex: "-1" }, "Your ballot is on the ledger"), h("p", { class: "muted" }, `${file?.name ?? el.code} · recorded ${fmtDate(entry.acceptedAt)}`))),
    h("div", { class: "badges" }, badge("Counted", "ok", "check"), entry.reviewed ? badge("Checked by a reviewer", "info", "users") : badge("Read automatically", "neutral"), entry.corrections.length ? badge("Corrected publicly", "warn", "alert") : null),
  );
}

function answersCard(qs, segs, entry) {
  const items = qs.map((q, i) => {
    const corr = entry.corrections.find((c) => c.questionIndex === i);
    const seg = corr ? corr.to : segs[i];
    const d = describeResult(seg, q);
    return h(
      "li",
      { class: `answer answer-${d.tone}` },
      h("p", { class: "eyebrow" }, `Question ${i + 1}`),
      h("h3", null, q.text),
      h("p", { class: "answer-title" }, icon(d.tone === "ok" ? "check" : d.tone === "info" ? "info" : "alert", { size: 18 }), d.title),
      h("p", { class: "muted" }, d.detail),
      corr ? h("p", { class: "correction" }, icon("flag", { size: 16 }), `A public correction on ${fmtDate(corr.at)} changed this answer (reason: ${REASONS[corr.reason] ?? "other"}). The original reading was ${describeResult(corr.from, q).title.toLowerCase()}.`) : null,
      h("p", { class: "raw" }, "On the ledger: ", h("code", null, seg)),
    );
  });
  return h(
    "section",
    { class: "card", "aria-labelledby": "ans-h" },
    headingWithHelp("h2", { id: "ans-h" }, "What the ledger says about your ballot", "check.results"),
    h("p", { class: "muted" }, "The ledger stores one short line per ballot. Here it is in plain words, question by question."),
    entry.mismatch ? callout("warn", "The question list doesn't match", "The ledger line has a different number of answers than the question list we have, so check the raw lines carefully.") : null,
    h("ol", { class: "answers" }, items),
  );
}

function imageCard(el, entry, strict, file) {
  const box = h("div", { id: "image-body" });
  const button = h("button", { id: "view-ballot-image", class: "btn btn-primary", type: "button" }, icon("image", { size: 18 }), "View original ballot image");
  const showChoice = () => {
    button.disabled = false;
    box.replaceChildren(
      h("p", { class: "muted" }, "The picture is not downloaded yet. The answers above already come from the ledger."),
      button,
    );
  };
  button.addEventListener("click", () => {
    button.disabled = true;
    box.replaceChildren(spinner("Fetching your ballot image…"));
    const view = ballotImage;
    if (!view) return showChoice();
    view.load({
      fetchImage: () => fetch(`${resolveImagePath(CONFIG.imagesApi)}?election=${encodeURIComponent(el.code)}`, { headers: { "X-Ballot-Code": strict }, cache: "no-store", referrerPolicy: "no-referrer" }),
      hashBytes: (bytes) => sha256Hex(bytes),
      objectUrlFor: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
      expectedHash: entry.imageSha256,
    }).then((result) => {
      if (result.revoke) URL.revokeObjectURL(result.revoke);
      if (result.previous) URL.revokeObjectURL(result.previous);
      if (result.status === "duplicate" || result.status === "stale") return;
      if (result.status === "error") {
        button.disabled = false;
        box.replaceChildren(callout(result.tone, result.title, result.text), button);
        return;
      }
      const media = result.type === "application/pdf"
        ? h("iframe", { src: result.url, title: "Your ballot scan", class: "ballot-frame" })
        : h("img", { src: result.url, alt: "Scan of your ballot. The answers are the marked bubbles.", class: "ballot-img" });
      box.replaceChildren(
        h("div", { class: "ballot-media" }, media),
        result.matches
          ? callout("ok", "This is exactly the picture recorded on the ledger", ["We computed the fingerprint (SHA-256) of this picture in your browser and compared it with the one on the ledger: ", h("code", null, shortHash(result.hex, 10, 8)), ". They are identical."])
          : callout("bad", "This picture does NOT match the ledger", "The picture's fingerprint is different from the one recorded on the ledger, so it should not be trusted. Please report this."),
        h("p", { class: "small" }, h("a", { href: result.url, target: "_blank", rel: "noopener", class: "btn btn-sm" }, "Open full size")),
      );
    }).catch(() => {
      button.disabled = false;
      box.replaceChildren(callout("warn", "We couldn't load the picture", "The image service didn't answer. Your ledger entry above is not affected."), button);
    });
  });
  showChoice();
  return h(
    "section",
    { class: "card", "aria-labelledby": "img-h" },
    h("h2", { id: "img-h" }, icon("image", { size: 22 }), "The scan of your ballot"),
    h("p", { class: "muted" }, "Compare the marks you see here with the answers above. Nothing is downloaded until you press the button. We then check that the picture is exactly the one fingerprinted on the ledger."),
    isPublicBallotImages(file) ? publicImagesCallout() : null,
    box,
  );
}

function technicalCard(el, entry) {
  const row = (label, value) => h("div", { class: "kv" }, h("dt", null, label), h("dd", null, h("code", { class: "wrap" }, value), " ", h("button", { class: "icon-btn", type: "button", "aria-label": `Copy ${label}`, onClick: () => copyText(value, "Copied") }, icon("copy", { size: 14 }))));
  return h(
    "details",
    { class: "card details" },
    h("summary", null, "For the curious: the raw record"),
    h(
      "dl",
      { class: "kvs" },
      row("Ledger line", entry.results),
      row("Ballot key (hash of your code)", entry.ballotKey),
      row("Scan fingerprint (SHA-256)", entry.imageSha256),
      row("Full record fingerprint", entry.recordSha256),
    ),
    h("p", { class: "muted small" }, "The ledger line is the answer to each question, in order, separated by “|”. ", h("code", null, "V:c3"), " means a vote for choice 3, ", h("code", null, "V:c1+c4"), " two votes, ", h("code", null, "B"), " blank, ", h("code", null, "O"), " overvote, ", h("code", null, "U"), " unclear. Your ballot key is a one-way scramble of your code; it lets the ledger find your line without storing the code. ", extLink(explorerAddress(el.contractSet?.contracts?.ledger ?? CONFIG.contracts.ledger), "See the ledger contract"), "."),
  );
}

function reportCard(el, entry, qs) {
  const wrap = h("section", { class: "card", "aria-labelledby": "report-h" });
  const open = h("button", { class: "btn", type: "button", "aria-expanded": "false", "aria-controls": "report-form" }, icon("flag", { size: 18 }), "Report a problem");
  wrap.append(h("h2", { id: "report-h" }, "Something look wrong?"), h("p", { class: "muted" }, "If an answer doesn't match how you marked your ballot, or the picture looks wrong, tell the election officers. If they agree, they post a public correction on the ledger. Nothing is ever erased, and your original entry stays visible."), open);
  const formBox = h("div", { id: "report-form", hidden: true });
  wrap.append(formBox);
  open.addEventListener("click", () => {
    const show = formBox.hidden;
    formBox.hidden = !show;
    open.setAttribute("aria-expanded", String(show));
    if (show && !formBox.firstChild) {
      formBox.append(reportForm(el, entry, qs));
    }
    if (show) formBox.querySelector("select")?.focus();
  });
  return wrap;
}

function reportForm(el, entry, qs) {
  const form = h(
    "form",
    { class: "report-form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "r-q" }, "Which part?"), h("select", { id: "r-q" }, h("option", { value: "all" }, "The whole ballot"), qs.map((q, i) => h("option", { value: String(i + 1) }, `Question ${i + 1}: ${q.text}`)))),
    h("div", { class: "field" }, h("label", { for: "r-kind" }, "What's the problem?"), h("select", { id: "r-kind" }, h("option", { value: "answer" }, "The recorded answer isn't how I marked it"), h("option", { value: "image" }, "The picture is wrong, cut off or unreadable"), h("option", { value: "missing" }, "Something is missing from my ballot"), h("option", { value: "other" }, "Something else"))),
    h("div", { class: "field" }, h("label", { for: "r-text" }, "Tell us what happened (optional)"), h("textarea", { id: "r-text", rows: "4", placeholder: "For example: I marked Chloe, but the ledger says I left it blank." }), h("p", { class: "hint" }, "Please don't include your name or ballot code. You can add contact details if you'd like a reply.")),
    h("button", { class: "btn btn-primary", type: "submit" }, "Prepare my report"),
  );
  const result = h("div", { "aria-live": "polite" });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = form.querySelector("#r-q");
    const kind = form.querySelector("#r-kind");
    const text = form.querySelector("#r-text").value.trim();
    const body = [
      "B.E.I.N.G.S. ballot problem report",
      `Election: ${el.code}`,
      `Ballot key (a hash; it does not reveal the ballot code): ${entry.ballotKey}`,
      `Part: ${q.selectedOptions[0].text}`,
      `Problem: ${kind.selectedOptions[0].text}`,
      `Details: ${text || "(none given)"}`,
      `Prepared: ${new Date().toISOString()}`,
    ].join("\n");
    const pre = h("pre", { class: "report-text", tabindex: "0", "aria-label": "Your report text" }, body);
    const subject = `Ballot problem report ${el.code}`;
    const actions = h(
      "div",
      { class: "actions" },
      h("button", { class: "btn btn-primary", type: "button", onClick: () => copyText(body, "Report copied") }, icon("copy", { size: 18 }), "Copy report"),
      h("button", { class: "btn", type: "button", onClick: () => download(`ballot-report-${el.code}.txt`, body) }, "Download as a file"),
      CONFIG.reportEmail ? h("a", { class: "btn", href: `mailto:${CONFIG.reportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` }, "Email it to the officers") : null,
    );
    result.replaceChildren(
      callout("info", "Your report is ready", CONFIG.reportEmail ? "Send it to the election officers. It doesn't contain your ballot code or your name." : "Reports aren't sent from this page yet. Copy or download it and give it to your election officer. It doesn't contain your ballot code or your name."),
      pre,
      actions,
    );
    pre.focus();
  });
  return h("div", null, form, result);
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Report downloaded");
}
