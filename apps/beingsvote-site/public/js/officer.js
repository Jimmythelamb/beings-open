// Election officer screen: what a polling-station officer needs on the day. Whether the election is open, whether the
// paper counts add up, which ballots were spoiled, what the scanners have recorded so far.
// Reads need no wallet. The two writes (mark a ballot spoiled, clear a flagged tally) go through the connected wallet
// and only for the roles the contracts allow (organizer or reviewer; reviewer).
import { fill, h, icon, badge, callout, spinner, setTitle, fmtDate, extLink, explorerTx, toast } from "./ui.js";
import { state, subscribe } from "./roles.js";
import { getTally, loadLedgerHistory, loadSpoiled, loadElectionStaff, loadReviewEvents, ballotKeyOf, getChainHead, getElection } from "./chain.js";
import { STATUS_TEXT, shortHash, splitLedgerResults, parseResult, choiceLabel, normalizeBallotCode, shortAddress } from "./format.js";
import { stationReconciliation, parseCount, electionActions, sameAddress, rulesFromMask, ageText } from "./logic.js";
import { sendTx } from "./tx.js";
import { reloadPage, pageHead, roleAccess, electionPicker, loadElectionContext, notFoundCard, errorCard, statGrid, kvList, dataTable, flagList, hashText, field, busy, questionsOf } from "./staff.js";

const PATH = "/officer";
const ZERO = "0x" + "00".repeat(32);
const FEED = 15;
const REFRESH_MS = 30_000;
const storeKey = (code) => `beings.station.${code}`;

function loadSaved(code) {
  try {
    return JSON.parse(localStorage.getItem(storeKey(code)) ?? "{}");
  } catch {
    return {};
  }
}
function save(code, v) {
  try {
    localStorage.setItem(storeKey(code), JSON.stringify(v));
  } catch {
    /* private mode: the numbers just aren't remembered */
  }
}

export async function renderOfficer(ctx) {
  const { root } = ctx;
  setTitle("Election officer");
  const pickerSlot = h("div");
  const body = h("div", { class: "stack" });
  fill(root, 
    h("a", { class: "back", href: "#/staff" }, "← All staff roles"),
    pageHead("officer", { lead: "A clear view of the polling station: is voting open, do the paper counts add up, and what have the scanners recorded so far." }),
    roleAccess(ctx, { roleId: "officer", detail: "Reading this page stays open. A crypto-wallet is needed to mark a ballot spoiled or sign off a review." }),
    pickerSlot,
    body,
  );
  let code;
  try {
    code = await electionPicker(ctx, pickerSlot, PATH);
  } catch {
    fill(pickerSlot, errorCard(null, () => renderOfficer(ctx)));
    return;
  }
  if (!ctx.current()) return;
  if (!code) return fill(body, h("section", { class: "card" }, callout("info", "No elections found yet", "When an election is registered on the ledger it will appear here.")));
  fill(body, h("section", { class: "card" }, spinner("Reading the ledger…")));
  try {
    const ec = await loadElectionContext(code);
    if (!ctx.current()) return;
    if (!ec) return fill(body, notFoundCard(code));
    const data = await readAll(ec.election, ec.file);
    if (!ctx.current()) return;
    fill(body, ...officerBody(ctx, ec, data));
  } catch (e) {
    console.error(e);
    if (ctx.current()) fill(body, errorCard(null, () => renderOfficer(ctx)));
  }
}

async function readAll(el, file) {
  const [history, spoiled, staff, reviews] = await Promise.all([loadLedgerHistory(el), loadSpoiled(el).catch(() => []), loadElectionStaff(el).catch(() => ({ devices: [], reviewers: [] })), loadReviewEvents(el).catch(() => ({ required: [], cleared: [] }))]);
  const questions = questionsOf(file, history.records);
  const tally = el.resultCount > 0 ? await getTally(el, questions.length) : null;
  const head = await getChainHead().catch(() => null);
  return { el, history, spoiled, staff, reviews, questions, tally, head };
}

function officerBody(ctx, ec, first) {
  let D = first;
  const code = ec.election.code;
  const saved = loadSaved(code);
  const statusSlot = h("section", { class: "card", "aria-labelledby": "o-status" });
  const reconSlot = h("section", { class: "card", "aria-labelledby": "o-recon" });
  const reviewSlot = h("div");
  const spoiledSlot = h("section", { class: "card", "aria-labelledby": "o-spoiled" });
  const feedSlot = h("section", { class: "card", "aria-labelledby": "o-feed" });
  const scanSlot = h("section", { class: "card", "aria-labelledby": "o-scan" });

  // ------------------------------------------------ inputs the station keeps by hand (not on the ledger until the tally is posted)
  const issuedIn = h("input", { id: "o-issued", name: "issued", inputmode: "numeric", autocomplete: "off", value: saved.issued ?? "", placeholder: "e.g. 120", "aria-describedby": "o-issued-hint" });
  const unusedIn = h("input", { id: "o-unused", name: "unused", inputmode: "numeric", autocomplete: "off", value: saved.unused ?? "", placeholder: "e.g. 18", "aria-describedby": "o-unused-hint" });
  const recon = h("div");
  const paintRecon = () => {
    const el = D.el;
    const issued = parseCount(issuedIn.value);
    const unused = parseCount(unusedIn.value);
    const bad = (v, t) => t.value.trim() !== "" && v === null;
    const result = stationReconciliation({ registered: el.registeredVoters, printed: el.ballotCount, cast: el.recordCount, spoiled: el.spoiledCount, issued, unusedReturned: unused });
    const tone = result.status === "ok" ? "ok" : result.status === "review" ? "bad" : "warn";
    fill(recon, 
      h("div", { class: "badges" }, badge(result.status === "ok" ? "Everything adds up" : result.status === "review" ? "Needs review" : "Waiting for your counts", tone, result.status === "ok" ? "check" : "alert"), result.turnout != null ? badge(`Turnout so far ${result.turnout}%`, "info") : null),
      bad(issued, issuedIn) || bad(unused, unusedIn) ? callout("warn", "Whole numbers only", "Type a plain number such as 120, with no letters or decimals.") : null,
      dataTable([{ key: "label", label: "Count" }, { key: "value", label: "Number", num: true }, { key: "source", label: "Where it comes from" }], result.rows.map((r) => ({ label: r.label, value: r.known ? r.value : "—", source: r.known ? r.source : "enter below", _class: null })), { caption: "Station counts" }),
      result.unaccounted != null && result.unaccounted !== 0 ? callout("bad", `${Math.abs(result.unaccounted)} ballot${Math.abs(result.unaccounted) === 1 ? "" : "s"} ${result.unaccounted > 0 ? "can't be accounted for" : "too many accounted for"}`, "Handed out should equal counted + spoiled + returned unused. Check the paper tally sheets before closing the station.") : null,
      flagList(result.issues.map((i) => ({ level: i.level === "bad" ? "bad" : "warn", title: i.title, detail: i.detail })), "Counted ballots never exceed handed-out or registered voters, and every ballot is accounted for."),
    );
  };
  const onInput = () => {
    save(code, { issued: issuedIn.value, unused: unusedIn.value });
    paintRecon();
  };
  issuedIn.addEventListener("input", onInput);
  unusedIn.addEventListener("input", onInput);
  const prefill = h("button", { class: "btn btn-sm", type: "button" }, "Use the figures from the posted tally");
  prefill.addEventListener("click", () => {
    if (!D.tally) return;
    issuedIn.value = String(D.tally.recon.issued);
    unusedIn.value = String(D.tally.recon.unusedReturned);
    onInput();
  });

  const paintRoot = () => {
    const el = D.el;
    const now = Math.floor(Date.now() / 1000);
    const wallet = state.address;
    const isOrganizer = sameAddress(wallet, el.organizer);
    const acts = electionActions({ status: el.status, now, opensAt: el.opensAt, closesAt: el.closesAt, deviceCount: el.deviceCount, quorum: el.quorum, isOrganizer });
    const st = STATUS_TEXT[el.status];

    // status card
    fill(statusSlot, 
      h("h2", { id: "o-status" }, icon("clipboard", { size: 22 }), ec.name),
      h("div", { class: "badges" }, badge(st.label, el.status === 2 ? "ok" : "info"), badge(`${el.deviceCount} of ${el.quorum} scanner phones`, el.deviceCount >= el.quorum ? "ok" : "warn"), D.tally ? badge(D.tally.final ? "Tally final" : "Tally under review", D.tally.final ? "ok" : "warn") : null),
      h("p", null, st.blurb),
      statGrid([["Opens", fmtDate(el.opensAt)], ["Closes", fmtDate(el.closesAt)], ["Ballots recorded", el.recordCount], ["Spoiled", el.spoiledCount], ["Corrections", el.correctionCount]]),
      el.status === 1 && acts.openBlockers.length ? callout("info", "Not open yet", acts.openBlockers.join(" "), "info") : null,
      el.status === 2 && now > el.closesAt ? callout("warn", "Past the scheduled closing time", "Voting is still open on the ledger. The organizer can close it; anyone can close it one day after the scheduled time.", "alert") : null,
      h("p", { class: "muted small" }, "Opening and closing voting are done by the election administrator. ", h("a", { href: `#/admin?e=${code}` }, "Open the admin screen"), D.head ? ` · Latest block ${ageText(Math.max(0, now - D.head.timestamp))} old.` : ""),
    );

    // reconciliation card
    fill(reconSlot, 
      h("h2", { id: "o-recon" }, icon("chart", { size: 22 }), "Do the counts add up?"),
      h("p", null, "Compare the ledger with the paper count at your station. The ledger knows how many ballots were counted and spoiled. Only you know how many ballots were handed out and how many came back unused, so type those in. Anything that doesn't add up is flagged for review. Nothing is changed for you."),
      h("div", { class: "row" }, h("div", { class: "field" }, h("label", { for: "o-issued" }, "Ballots handed out"), issuedIn, h("p", { id: "o-issued-hint", class: "hint" }, "From the issue log / sign-in sheet.")), h("div", { class: "field" }, h("label", { for: "o-unused" }, "Ballots returned unused"), unusedIn, h("p", { id: "o-unused-hint", class: "hint" }, "Blank ballots handed back at close."))),
      D.tally ? h("div", { class: "actions" }, prefill) : null,
      recon,
      D.tally ? h("p", { class: "muted small" }, `The official tally (version ${D.tally.version}) says ${D.tally.recon.issued} handed out, ${D.tally.recon.cast} cast, ${D.tally.recon.spoiled} spoiled, ${D.tally.recon.unusedReturned} unused.`) : h("p", { class: "muted small" }, "These figures aren't stored on the ledger until the administrator publishes the tally. They stay in this browser only."),
    );
    paintRecon();

    // review (tally flagged)
    fill(reviewSlot, ...(D.tally ? [reviewCard(isOrganizer)] : []));

    // spoiled
    fill(spoiledSlot, spoiledCard(isOrganizer));

    // feed
    fill(feedSlot, feedCard());

    // scanner guidance
    fill(scanSlot, scannerCard());
  };

  // ------------------------------------------------ tally review
  function reviewCard() {
    const t = D.tally;
    const flagged = t.failedChecks > 0;
    const isReviewer = D.staff.reviewers.some((r) => sameAddress(r.address, state.address));
    const note = h("input", { id: "o-note", placeholder: "Optional: link to your review note (ipfs://… or https://…)", autocomplete: "off", "aria-label": "Review note link" });
    const clearBtn = h("button", { class: "btn btn-primary", type: "button", disabled: !(isReviewer && !t.final) }, "Sign off this review");
    clearBtn.addEventListener("click", () =>
      busy(clearBtn, "Working…", async () => {
        const cid = note.value.trim() || `local-unpublished:review-${code}-v${t.version}`;
        const r = await sendTx({
          contract: "tally",
          method: "clearReview",
          args: [D.el.key, t.version, cid],
          title: "Sign off the review of this tally",
          lines: ["You are saying that you looked at the reconciliation checks that failed and that this tally can stand. This marks the tally Final. Anyone can still re-count it from the public ledger."],
          facts: [["Election", code], ["Tally version", String(t.version)], ["Failed checks", rulesFromMask(t.failedChecks).filter((x) => !x.passed).map((x) => x.id).join(", ") || "none"], ["Review note", cid]],
          confirmText: "Sign off",
        });
        if (r.status === "failed") toast(r.message);
        if (r.status === "sent") (toast("Review signed off."), reloadPage());
      }),
    );
    return h(
      "section",
      { class: "card", "aria-labelledby": "o-review" },
      h("h2", { id: "o-review" }, icon("shield", { size: 22 }), "Review of the published tally"),
      flagged ? callout(t.final ? "ok" : "warn", t.final ? "Reviewed and signed off" : "This tally is waiting for review", `Rules that failed: ${rulesFromMask(t.failedChecks).filter((x) => !x.passed).map((x) => `${x.id} (${x.title})`).join(", ")}.`, t.final ? "check" : "alert") : callout("ok", "No checks failed", `Tally version ${t.version} passed every reconciliation rule${t.final ? " and is final" : ""}.`, "check"),
      D.reviews.cleared.length ? h("p", { class: "muted small" }, "Signed off by ", D.reviews.cleared.map((c) => shortAddress(c.reviewer)).join(", "), ".") : null,
      flagged && !t.final
        ? h(
            "div",
            null,
            !state.address ? h("p", { class: "hint" }, "Connect a reviewer wallet to sign this off.") : !isReviewer ? h("p", { class: "hint" }, "Only a reviewer registered for this election can sign off. The administrator registers reviewers during setup.") : null,
            h("div", { class: "row" }, note),
            h("div", { class: "actions" }, clearBtn),
          )
        : null,
    );
  }

  // ------------------------------------------------ spoiled ballots
  function spoiledCard(isOrganizer) {
    const isReviewer = D.staff.reviewers.some((r) => sameAddress(r.address, state.address));
    const may = (isOrganizer || isReviewer) && (D.el.status === 2 || D.el.status === 3);
    const spoilIn = h("input", { id: "o-spoil", placeholder: "Spoiled ballot code (12 characters)", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", class: "plain-mono", "aria-label": "Code of the spoiled ballot" });
    const replIn = h("input", { id: "o-repl", placeholder: "Replacement ballot code (if one was issued)", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", class: "plain-mono", "aria-label": "Code of the replacement ballot" });
    const btn = h("button", { class: "btn", type: "button", disabled: !may }, "Mark as spoiled");
    btn.addEventListener("click", () =>
      busy(btn, "Working…", async () => {
        const a = normalizeBallotCode(spoilIn.value);
        if (!a) return toast("That doesn't look like a ballot code. They have 12 letters and numbers.");
        const b = replIn.value.trim() ? normalizeBallotCode(replIn.value) : null;
        if (replIn.value.trim() && !b) return toast("The replacement code doesn't look right.");
        const [aKey, bKey] = await Promise.all([ballotKeyOf(a), b ? ballotKeyOf(b) : ZERO]);
        const r = await sendTx({
          contract: "ledger",
          method: "markSpoiled",
          args: [D.el.key, aKey, bKey],
          title: "Mark a ballot as spoiled",
          lines: ["The ledger will record that this ballot was spoiled and can never be counted. This can't be undone. Only a ballot that has not been scanned can be marked."],
          facts: [["Election", code], ["Spoiled ballot", a], ["Replacement", b ?? "none"]],
          confirmText: "Mark spoiled",
        });
        if (r.status === "failed") toast(r.message);
        if (r.status === "sent") (toast("Marked as spoiled."), reloadPage());
      }),
    );
    return h(
      "section",
      { class: "card", "aria-labelledby": "o-spoiled" },
      h("h2", { id: "o-spoiled" }, icon("x", { size: 22 }), "Spoiled ballots"),
      h("p", null, `${D.spoiled.length} ballot${D.spoiled.length === 1 ? " has" : "s have"} been marked spoiled. A voter who makes a mistake hands the ballot back and gets a new one. The spoiled one is recorded here so it can never be counted.`),
      dataTable([{ key: "k", label: "Spoiled ballot (hashed)" }, { key: "r", label: "Replacement (hashed)" }], D.spoiled.map((s) => ({ k: hashText(s.ballotKey, 10, 6), r: s.replacedByKey === ZERO ? "none" : hashText(s.replacedByKey, 10, 6) })), { caption: "Spoiled ballots", empty: "None so far." }),
      h("h3", null, "Mark a ballot as spoiled"),
      may
        ? null
        : h("p", { class: "hint" }, !state.address ? "Connect the organizer's or a reviewer's wallet to do this." : D.el.status !== 2 && D.el.status !== 3 ? "Ballots can only be marked spoiled while voting is open or just closed." : "Only the organizer or a registered reviewer can do this."),
      h("div", { class: "row" }, spoilIn, replIn),
      h("div", { class: "actions" }, btn),
    );
  }

  // ------------------------------------------------ read-only ledger feed
  function feedCard() {
    const entries = Object.entries(D.history.details).reverse().slice(0, FEED);
    const q = D.questions;
    const text = (results) =>
      splitLedgerResults(results)
        .map((seg, i) => {
          const p = parseResult(seg);
          return !p ? "unreadable" : p.kind === "V" ? p.choices.map((id) => choiceLabel(q[i], id)).join(" + ") : { B: "blank", O: "overvote", U: "unclear" }[p.kind] ?? seg;
        })
        .join(" · ");
    return h(
      "section",
      { class: "card", "aria-labelledby": "o-feed" },
      h("h2", { id: "o-feed" }, icon("search", { size: 22 }), "What the scanners have recorded"),
      h("p", null, `${D.el.recordCount} ballot${D.el.recordCount === 1 ? "" : "s"} on the ledger. The newest ${Math.min(FEED, entries.length)} are below, with the ballot identified only by a hash. This page refreshes itself every 30 seconds.`),
      dataTable([{ key: "n", label: "#", num: true }, { key: "k", label: "Ballot (hashed)" }, { key: "a", label: "Recorded answers" }, { key: "s", label: "Notes" }], entries.map(([key, d], i) => ({ n: D.el.recordCount - i, k: hashText(key, 8, 6), a: h("span", { class: "small" }, text(d.results)), s: h("span", { class: "badges" }, d.reviewed ? badge("Reviewed", "info") : null, /(^|\|)(U|O)(\||$)/.test(d.results) ? badge("Needs a look", "warn") : null) })), { caption: "Latest ledger entries", empty: "No ballots have been recorded yet." }),
      h("p", { class: "muted small" }, "Entries are read-only. A scanner's record can't be edited here. Corrections are made by reviewers with evidence, and the original always stays visible."),
    );
  }

  // ------------------------------------------------ scanner guidance
  function scannerCard() {
    const devices = D.staff.devices;
    const ok = D.el.deviceCount >= D.el.quorum;
    return h(
      "section",
      { class: "card", "aria-labelledby": "o-scan" },
      h("h2", { id: "o-scan" }, icon("image", { size: 22 }), "Scanning phones and uploads"),
      callout(ok ? "ok" : "warn", ok ? "Enough scanning phones are registered" : "More scanning phones are needed", `${D.el.deviceCount} registered, ${D.el.quorum} needed before voting can open (the same ballot must be agreed by that many phones).`, ok ? "check" : "alert"),
      dataTable([{ key: "a", label: "Phone" }, { key: "h", label: "App fingerprint" }, { key: "t", label: "" }], devices.map((d) => ({ a: hashText(d.address, 8, 6), h: hashText(d.appHash, 8, 6), t: extLink(explorerTx(d.tx), "registered") })), { caption: "Registered scanning phones", empty: "No scanning phones are registered yet." }),
      h("h3", null, "At the station"),
      h(
        "ol",
        { class: "plain-list" },
        h("li", null, "Scan each ballot with a registered phone. Each scan is signed by the phone and recorded on the ledger. It appears in the list above within a minute."),
        h("li", null, "The phone also uploads a picture of the ballot. Keep the phone online until it says the upload finished."),
        h("li", null, "If a ballot comes up “unclear”, set it aside for a reviewer. Don't try to fix it by re-scanning."),
        h("li", null, "Put every scanned paper ballot in the sealed box. The paper is the original record."),
        h("li", null, "At close, count the ballots handed out and returned unused, then enter them above."),
      ),
      h("p", { class: "muted small" }, "The ledger count above should rise by one for every ballot scanned. If it stalls, check the phone's connection and ask the administrator to look at the system status page."),
    );
  }

  // ------------------------------------------------ refresh
  const timer = setInterval(async () => {
    if (!ctx.current()) return clearInterval(timer);
    if (document.hidden) return;
    try {
      const el = await getElection(code);
      if (!el || !ctx.current()) return;
      D = await readAll(el, ec.file);
      if (ctx.current()) paintRoot();
    } catch {
      /* keep the last good view */
    }
  }, REFRESH_MS);
  const off = subscribe(() => {
    if (!ctx.current()) return off();
    paintRoot();
  });
  paintRoot();
  return [statusSlot, reconSlot, reviewSlot, spoiledSlot, feedSlot, scanSlot];
}
