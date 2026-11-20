// Public results: election list and one election's results, read live from Coston2.
import { labelWithHelp, headingWithHelp } from "./help.js";
import { h, fill, icon, badge, callout, spinner, skeleton, setTitle, fmtDate, extLink, explorerAddress, copyText } from "./ui.js";
import { CONFIG } from "./config.js";
import { discoverElections, getElection, loadElectionFile, getTally, loadLedgerHistory, getVerifierMetrics, loadElectionStaff, loadElectionRecord, getNoteAnchors, notesConfigured, registryRoleOf, getEthers } from "./chain.js";
import { STATUS_TEXT, tallyFromResults, applyCorrections, percent, shortHash, shortAddress, normalizeElectionCode, splitLedgerResults, parseResult } from "./format.js";
import { renderExplainer } from "./explain.js";
import { rulesFromMask, buildZip, isPublicBallotImages } from "./logic.js";
import { publicImagesNotice, publicImageLookup } from "./public-images.js";
import { recordedItems } from "./fingerprints.js";
import { recordedSection, checkDeps } from "./recorded-ui.js";
import { failedCheckIds, verifyNoteSignature, confirmRole, noteFileSha256, ROLE_LABEL, ROLE_EXPLANATION } from "./record.js";

const statusTone = ["neutral", "info", "ok", "warn", "ok"];

export const statusBadge = (status) => badge(STATUS_TEXT[status].label, statusTone[status], status === 4 ? "check" : undefined);

function errorBox(retry, message) {
  return h("div", { class: "card" }, callout("warn", "We couldn't reach the Flare test network", message ?? "This is usually temporary. Your connection or the public network may be busy."), h("button", { class: "btn", type: "button", onClick: retry }, "Try again"));
}

// ------------------------------------------------------------------ list
export async function renderResultsList(ctx) {
  const { root } = ctx;
  setTitle("Election results");
  const header = h(
    "header",
    { class: "page-head" },
    h("h1", null, "Election results"),
    h("p", { class: "lead" }, "Every election below is read live from a public ledger. Pick one to see the results and how they were checked."),
  );
  const list = h("div", { class: "grid" }, skeleton(4), skeleton(4));
  const note = h("div");

  const form = h(
    "form",
    { class: "inline-form card", novalidate: true },
    labelWithHelp("find-code", "Have an election code? Look it up", "results.lookup"),
    h(
      "div",
      { class: "row" },
      h("input", { id: "find-code", name: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "BEINGS-2026-ABC123", "aria-describedby": "find-hint find-err" }),
      h("button", { class: "btn btn-primary", type: "submit" }, "Open"),
    ),
    h("p", { id: "find-hint", class: "hint" }, "It looks like BEINGS-, a year, and six letters or numbers."),
    h("p", { id: "find-err", class: "field-error", role: "alert" }),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = normalizeElectionCode(form.code.value);
    const err = form.querySelector("#find-err");
    if (!code) {
      err.textContent = "That doesn't look like an election code. Check it against your receipt or notice.";
      form.code.setAttribute("aria-invalid", "true");
      form.code.focus();
      return;
    }
    location.hash = `#/results/${code}`;
  });

  root.replaceChildren(header, list, note, form);

  const load = async () => {
    list.replaceChildren(skeleton(4), skeleton(4));
    try {
      const { elections, discovered } = await discoverElections();
      const cards = (
        await Promise.all(
          elections.map(async (hint) => {
            try {
              const el = await getElection(hint.code, hint);
              if (!el) return null;
              const f = await loadElectionFile(el).catch(() => null);
              return { el, name: f?.file?.name };
            } catch {
              return null;
            }
          }),
        )
      ).filter(Boolean);
      if (!ctx.current()) return;
      cards.sort((a, b) => b.el.version.postedAt - a.el.version.postedAt);
      list.replaceChildren(...cards.map(electionCard));
      if (!cards.length) list.replaceChildren(callout("info", "No elections found yet", "When an election is registered on the ledger it will appear here."));
      note.replaceChildren(...(discovered ? [] : [h("p", { class: "muted small" }, "Showing the elections this site knows about. The live search for new ones is unavailable right now.")]));
    } catch (e) {
      if (ctx.current()) list.replaceChildren(errorBox(load));
    }
  };
  await load();
}

function electionCard({ el, name }) {
  const s = STATUS_TEXT[el.status];
  return h(
    "a",
    { class: "card card-link election-card", href: `#/results/${el.code}` },
    h("div", { class: "card-top" }, statusBadge(el.status), h("code", { class: "code" }, el.code)),
    h("h2", null, name ?? "Election"),
    h("p", { class: "muted" }, s.blurb),
    h(
      "dl",
      { class: "stats" },
      h("div", null, h("dt", null, "Ballots counted"), h("dd", null, `${el.recordCount}`, h("span", { class: "muted" }, ` of ${el.ballotCount} printed`))),
      h("div", null, h("dt", null, "Voting window"), h("dd", { class: "small" }, fmtDate(el.opensAt, { timeStyle: undefined }))),
    ),
    h("span", { class: "link-cta" }, el.status === 4 ? "See results" : "See details", icon("arrow", { size: 16 })),
  );
}

// ------------------------------------------------------------------ one election
function synthesizeQuestions(records, n) {
  const max = Array.from({ length: n }, () => 0);
  for (const s of Object.values(records)) {
    splitLedgerResults(s).forEach((seg, i) => {
      const p = parseResult(seg);
      if (p?.kind === "V") for (const id of p.choices) max[i] = Math.max(max[i], Number(id.slice(1)));
    });
  }
  return max.map((m, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}`, maxMarks: 1, choices: Array.from({ length: Math.max(m, 1) }, (_, j) => ({ id: `c${j + 1}`, text: `Choice ${j + 1}` })), synthetic: true }));
}

export async function renderElection(ctx) {
  const { root, params } = ctx;
  const code = normalizeElectionCode(params.code);
  setTitle(code ?? "Election");
  if (!code) {
    root.replaceChildren(h("div", { class: "card" }, callout("warn", "That isn't an election code", "Election codes look like BEINGS-2026-ABC123."), h("a", { class: "btn", href: "#/results" }, "Back to all elections")));
    return;
  }
  root.replaceChildren(h("a", { class: "back", href: "#/results" }, "← All elections"), h("div", { class: "card" }, spinner("Reading the ledger…"), skeleton(5)));

  const run = async () => {
    try {
      const { elections } = await discoverElections().catch(() => ({ elections: [] }));
      const hint = elections.find((e) => e.code === code) ?? {};
      const el = await getElection(code, hint);
      if (!ctx.current()) return;
      if (!el) {
        root.replaceChildren(h("a", { class: "back", href: "#/results" }, "← All elections"), h("div", { class: "card" }, callout("info", "We couldn't find that election", `The ledger has no election with the code ${code}. Check for typos, or that you're looking at the right network (this site reads the Flare Coston2 test network).`), h("a", { class: "btn", href: "#/results" }, "See all elections")));
        return;
      }
      const hasTally = el.resultCount > 0;
      const [fileRes, history] = await Promise.all([loadElectionFile(el).catch(() => null), hasTally ? loadLedgerHistory(el).catch(() => null) : Promise.resolve(null)]);
      if (!ctx.current()) return;
      const questions = fileRes?.file?.questions ?? (history && Object.keys(history.records).length ? synthesizeQuestions(history.records, splitLedgerResults(Object.values(history.records)[0]).length) : []);
      const tally = hasTally && questions.length ? await getTally(el, questions.length) : null;
      const recount = history && questions.length ? tallyFromResults(Object.values(applyCorrections(history.records, history.corrections)), questions) : null;
      const metrics = await getVerifierMetrics(el).catch(() => null);
      if (!ctx.current()) return;
      root.replaceChildren(...electionView({ el, fileRes, questions, tally, recount, history, metrics }));
      root.querySelector("h1")?.focus?.();
    } catch (e) {
      if (ctx.current()) root.replaceChildren(h("a", { class: "back", href: "#/results" }, "← All elections"), errorBox(run));
    }
  };
  await run();
}

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("dt", null, label), h("dd", null, value, sub ? h("span", { class: "muted small" }, ` ${sub}`) : null));
}

export function electionView({ el, fileRes, questions, tally, recount, history, metrics }) {
  const file = fileRes?.file;
  const s = STATUS_TEXT[el.status];
  const name = file?.name ?? "Election";
  const small = file?.privacy?.minBreakdownSize && el.recordCount < file.privacy.minBreakdownSize ? file.privacy.minBreakdownSize : null;

  const head = h(
    "header",
    { class: "card election-head" },
    h("div", { class: "card-top" }, statusBadge(el.status), tally ? badge(tally.final ? "Final" : "Under review", tally.final ? "ok" : "warn", tally.final ? "check" : "alert") : null),
    h("h1", { tabindex: "-1" }, name),
    h("p", { class: "lead" }, s.blurb),
    h(
      "dl",
      { class: "stats" },
      stat("Election code", h("code", { class: "code" }, el.code, " ", h("button", { class: "icon-btn", type: "button", "aria-label": "Copy election code", onClick: () => copyText(el.code, "Election code copied") }, icon("copy", { size: 16 })))),
      stat("Ballots counted", `${el.recordCount}`, `of ${el.ballotCount} printed`),
      stat("Voting window", `${fmtDate(el.opensAt, { timeStyle: undefined })} – ${fmtDate(el.closesAt, { timeStyle: undefined })}`),
    ),
    h("div", { class: "actions" }, h("a", { class: "btn btn-primary", href: `#/check?election=${el.code}` }, icon("ticket", { size: 18 }), "Check my ballot"), h("button", { class: "btn", type: "button", onClick: () => document.getElementById("how-h")?.scrollIntoView({ behavior: "smooth" }) }, "How this is verified")),
  );

  const blocks = [head];

  if (isPublicBallotImages(file)) {
    blocks.push(publicImagesNotice({ headingId: "r-public-images" }), publicImageLookup({ electionCode: el.code, headingId: "r-public-lookup" }));
  }

  if (!tally) {
    blocks.push(
      h(
        "div",
        { class: "card" },
        callout("info", "Results aren't published yet", el.status >= 3 ? "Voting has closed. The official count will appear here as soon as it is posted to the ledger." : "Results appear here after voting closes and the official count is posted. Until then, only the number of ballots recorded is shown."),
        h("p", { class: "big-number" }, h("span", null, el.recordCount), h("span", { class: "muted" }, ` ballot${el.recordCount === 1 ? "" : "s"} recorded so far`)),
      ),
    );
  } else {
    if (!tally.final) {
      const ids = failedCheckIds(tally.failedChecks);
      blocks.push(callout("warn", "These results are still under review", ids.length ? `${ids.length} automatic check${ids.length === 1 ? "" : "s"} (${ids.join(", ")}) didn't pass, so a reviewer must look before the result is final. See "Do the numbers add up?" below.` : "A reviewer must look before the result is final."));
    }
    if (small) blocks.push(callout("info", "A very small election", `With fewer than ${small} ballots, results can hint at how individuals voted, so real elections hold back small breakdowns. This is a test election and the data is already public on the ledger, so it is shown here in full.`, "info"));
    if (!file) blocks.push(callout("info", "Question wording isn't available", "The election file with the question and choice names couldn't be loaded, so choices are shown by number as they are written on the ledger."));
    questions.forEach((q, i) => blocks.push(questionCard(q, i, tally.perQuestion[i], recount?.[i])));
  }

  blocks.push(reconCard(el, tally));
  if (tally && el.record) blocks.push(recordPanel(el, tally));
  blocks.push(recordedPanelLazy(el, file, tally));
  blocks.push(renderExplainer({ checks: buildChecks({ el, fileRes, questions, tally, recount, history, metrics }) }));
  blocks.push(h("p", { class: "muted small" }, "Read live from the Flare Coston2 test network (chain 114). ", extLink(explorerAddress(el.contractSet?.contracts?.tally ?? CONFIG.contracts.tally), "See the totals contract"), "."));
  return [h("a", { class: "back", href: "#/results" }, "← All elections"), ...blocks];
}

function questionCard(q, i, official, recount) {
  const headingId = `q-${i}`;
  const counts = q.choices.map((c) => ({ ...c, n: recount?.byChoice?.[c.id] ?? null }));
  const haveChoices = recount != null;
  if (haveChoices) counts.sort((a, b) => b.n - a.n); // biggest first; ties keep the order of the election file
  const top = haveChoices ? Math.max(0, ...counts.map((c) => c.n)) : 0;
  const base = official.valid;
  const bars = haveChoices
    ? h(
        "ul",
        { class: "bars" },
        counts.map((c) => {
          const pct = percent(c.n, base);
          const lead = top > 0 && c.n === top;
          return h(
            "li",
            { class: lead ? "bar-row top" : "bar-row" },
            h("div", { class: "bar-label" }, h("span", null, c.text, lead ? h("span", { class: "sr-only" }, " (most marks)") : null), h("span", { class: "bar-val" }, h("strong", null, c.n), h("span", { class: "muted" }, ` · ${pct}%`))),
            h("div", { class: "bar-track", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: `width:${Math.min(100, pct)}%` })),
          );
        }),
      )
    : callout("info", "Choice-by-choice counts are loading slowly", "The detailed ledger lines couldn't be fetched right now, so only the official totals are shown below.");
  const multi = q.maxMarks > 1;
  const match = recount ? recount.valid === official.valid && recount.blank === official.blank && recount.overvote === official.overvote && recount.unclear === official.unclear : null;
  return h(
    "section",
    { class: "card question", "aria-labelledby": headingId },
    h("p", { class: "eyebrow" }, `Question ${i + 1}`, multi ? ` · choose up to ${q.maxMarks}` : ""),
    h("h2", { id: headingId }, q.text),
    bars,
    multi && haveChoices ? h("p", { class: "muted small" }, `Each ballot could mark up to ${q.maxMarks} choices, so percentages are of ${official.valid} ballots with a valid answer and add up to more than 100%.`) : null,
    h(
      "dl",
      { class: "chips" },
      chip("Valid answers", official.valid, "Ballots with a clear answer to this question."),
      chip("Left blank", official.blank, "No mark was found. Counts as no answer."),
      chip("Overvotes", official.overvote, "More marks than allowed. Not counted for any choice."),
      chip("Unclear", official.unclear, "Needed a person to look. Shown here if still unresolved."),
    ),
    match === true ? h("p", { class: "ok-line" }, icon("check", { size: 16 }), "Our recount from the raw ledger lines matches the official totals.") : null,
    match === false ? callout("warn", "Recount differs from the official totals", "The numbers above come from the official tally on the ledger. Our own recount from the individual lines doesn't match, so treat this question as needing review.") : null,
  );
}

function chip(label, value, hint) {
  return h("div", { class: "chip" }, h("dt", null, label), h("dd", null, value), h("span", { class: "chip-hint" }, hint));
}

function reconCard(el, tally) {
  if (!tally) return h("span");
  const r = tally.recon;
  return h(
    "section",
    { class: "card", "aria-labelledby": "recon-h" },
    headingWithHelp("h2", { id: "recon-h" }, "Do the numbers add up?", "results.counts"),
    h("p", { class: "muted" }, "Elections keep a tally of every printed ballot. The ledger refuses a count that doesn't balance."),
    h("dl", { class: "stats" }, stat("Registered voters", r.registered), stat("Ballots printed", r.printed), stat("Handed out", r.issued), stat("Counted", r.cast), stat("Spoiled & replaced", r.spoiled), stat("Unused, returned", r.unusedReturned), stat("Never handed out", r.unissued)),
    h("p", { class: tally.failedChecks === 0 ? "ok-line" : "warn-line" }, icon(tally.failedChecks === 0 ? "check" : "alert", { size: 16 }), tally.failedChecks === 0 ? "All automatic balance checks passed." : `${failedCheckIds(tally.failedChecks).length} balance check(s) did not pass: ${failedCheckIds(tally.failedChecks).join(", ")}.`),
    tally.failedChecks === 0
      ? null
      : h(
          "ul",
          { class: "rule-list", "aria-label": "Automatic balance checks" },
          rulesFromMask(tally.failedChecks).map((r) => h("li", { class: r.passed ? "rule-pass" : "rule-fail" }, icon(r.passed ? "check" : "alert", { size: 16 }), h("span", null, h("strong", null, r.id), " ", r.passed ? "passed" : "did not pass", ": ", r.plain))),
        ),
  );
}

// ------------------------------------------------------------------ what was recorded, and why it matters
/** Loads the registered stations (and the record fingerprint) in the background; the rest of the page never waits. */
function recordedPanelLazy(el, file, tally) {
  const section = h("section", { class: "card recorded-panel", "aria-labelledby": "recorded-h" }, h("h2", { id: "recorded-h" }, "What was recorded, and why it matters"), spinner("Reading what the ledger recorded…"));
  (async () => {
    const [staff, rec] = await Promise.all([loadElectionStaff(el).catch(() => null), el.record ? loadElectionRecord(el).catch(() => null) : null]);
    section.replaceWith(recordedPanelView({ el, file, tally, devices: staff?.devices ?? null, recordSha256: rec?.manifestSha256 ?? null }));
  })().catch(() => fill(section, h("h2", { id: "recorded-h" }, "What was recorded, and why it matters"), callout("info", "Couldn't read everything right now", "The results above don't depend on this list. Try again later.")));
  return section;
}

/** The section for already-loaded values (pure DOM, no network). Exported for the dev preview and tests. */
export function recordedPanelView({ el, file, tally, devices, recordSha256 }) {
  const items = recordedItems({ stage: "created", fileSha256: el.version.fileSha256, ballotListRoot: el.ballotListRoot, layoutHash: file?.layoutHash ?? null, approvedAppHashes: file?.approvedAppHashes ?? [], devices: devices ?? undefined, quorum: el.quorum, merkleRoot: tally?.merkleRoot, resultsSha256: tally?.resultsSha256, recordSha256 });
  return recordedSection(items, { stage: "created", file, deps: checkDeps(), id: "recorded-h" });
}

// ------------------------------------------------------------------ election record and officials' notes
/** Loads the record in the background so the rest of the page never waits for it. */
function recordPanel(el, tally) {
  const section = h("section", { class: "card record-panel", "aria-labelledby": "record-h" }, recordHeading(), spinner("Checking the election record and notes…"));
  (async () => {
    try {
      const model = await loadRecordModel(el, tally);
      fill(section, ...recordPanelView(model));
    } catch (e) {
      fill(section, recordHeading(), callout("info", "The election record couldn't be loaded right now", "The results above come from the ledger and don't depend on it. Try again later."));
    }
  })();
  return section;
}

const recordHeading = () => headingWithHelp("h2", { id: "record-h" }, [icon("book", { size: 22 }), "Election record and organizer notes"], "results.record");

/** Everything the panel shows, verified here in the browser. Exported for the dev preview and tests. */
export async function loadRecordModel(el, tally) {
  const rec = await loadElectionRecord(el);
  if (!rec) return null;
  const ethers = await getEthers();
  const notes = [];
  for (const n of rec.notes) {
    const sig = n.note.signature ? verifyNoteSignature(n.note, { keccak256: ethers.keccak256, verifyTypedData: ethers.verifyTypedData }) : { valid: false, signer: null, errors: ["Not signed yet (draft)."] };
    const actualRole = await registryRoleOf(el, n.note.author).catch(() => null);
    const role = actualRole == null ? { confirmed: null, actual: null } : confirmRole(n.note, { organizer: el.organizer, role: actualRole });
    notes.push({ ...n, signed: Boolean(n.note.signature), sig, role, noteSha256: await noteFileSha256(n.note) });
  }
  const anchors = await getNoteAnchors(el, [rec.manifestSha256, ...notes.map((n) => n.noteSha256)]).catch(() => undefined);
  for (const n of notes) n.anchor = anchors ? anchors[n.noteSha256] ?? null : undefined;
  return {
    code: el.code,
    failedIds: failedCheckIds(tally.failedChecks),
    final: tally.final,
    notesContract: notesConfigured(),
    manifest: rec.manifest,
    manifestSha256: rec.manifestSha256,
    manifestAnchor: anchors ? anchors[rec.manifestSha256] ?? null : undefined,
    files: rec.files,
    notes,
    url: rec.url,
    bytes: rec.bytes,
  };
}

const short = (x) => shortHash(x, 10, 8);
const fmtIso = (iso) => fmtDate(Math.floor(Date.parse(iso) / 1000));

/** The panel's content for a loaded model (pure DOM, no network). */
export function recordPanelView(m) {
  if (!m) return [recordHeading(), h("p", { class: "muted" }, "No long-term record has been published for this election yet.")];
  const mode = !m.notesContract ? "file" : anchored(m.manifestAnchor) || m.notes.some((n) => anchored(n.anchor)) ? "anchored" : "pending";
  const modeBadge = mode === "anchored" ? badge("Fingerprint on the ledger", "ok", "check") : mode === "pending" ? badge("Not on the ledger yet", "warn", "alert") : badge("Signed file only", "neutral", "info");
  const parts = [
    recordHeading(),
    h("div", { class: "badges" }, modeBadge, m.failedIds.length ? badge(`Explains ${m.failedIds.join(", ")}`, "warn", "flag") : null, m.final ? null : badge("Result still under review", "warn")),
    h(
      "p",
      { class: "muted" },
      mode === "file"
        ? "These notes and files are published with this website and signed by the official's wallet. Their fingerprints are not on the ledger yet (the notes contract isn't set up), so for now they are checked by signature and fingerprint only."
        : "These notes and files are published with this website. Their fingerprints are checked here in your browser against the public ledger.",
    ),
  ];
  for (const n of m.notes) parts.push(noteView(n, m));
  parts.push(recordFilesView(m));
  return parts;
}

function noteView(n, m) {
  const note = n.note;
  const who = ROLE_EXPLANATION[note.role] ?? "official's explanation";
  const sigLine = !n.signed ? badge("Not signed (draft)", "warn", "alert") : n.sig.valid ? badge("Signature valid", "ok", "check") : badge("Signature does NOT check out", "bad", "x");
  const roleLine = n.role.confirmed == null ? badge("Role not checked", "neutral") : n.role.confirmed ? badge(`${ROLE_LABEL[note.role]} on the registry`, "ok", "check") : badge(`Not the ${note.role} on the registry`, "bad", "x");
  const anchorText = n.anchor === undefined ? "Not on the ledger (signed file only)" : n.anchor ? `Posted ${fmtDate(n.anchor.postedAt)} by ${shortAddress(n.anchor.author)} (${n.anchor.role})` : anchored(m.manifestAnchor) ? "Covered by the record fingerprint on the ledger" : "Not posted yet";
  const trusted = n.signed && n.sig.valid && n.role.confirmed !== false;
  return h(
    "article",
    { class: `note-card${trusted ? "" : " note-untrusted"}`, "aria-label": `${who}` },
    h("p", { class: "note-label" }, icon("info", { size: 16 }), h("strong", null, `${capital(who)}, not a ledger fact`)),
    h("p", { class: "muted small" }, "It does not change the posted counts and does not clear the flag. The numbers above come from the ledger."),
    note.checks?.length ? h("p", { class: "small" }, "About check", note.checks.length === 1 ? " " : "s ", h("strong", null, note.checks.join(", ")), ` · tally version ${note.tallyVersion}`) : null,
    h("blockquote", { class: "note-text" }, note.text),
    !trusted ? callout("warn", "Don't rely on this note", n.signed ? n.sig.errors?.join(" ") || "The signature or role doesn't check out." : "This is an unsigned draft.") : null,
    h("div", { class: "badges" }, sigLine, roleLine),
    h(
      "dl",
      { class: "kvs" },
      kv("Author wallet", extLink(explorerAddress(note.author), note.author)),
      kv("Role", `${ROLE_LABEL[note.role] ?? note.role}${n.role.actual && !n.role.confirmed ? ` (the registry says: ${n.role.actual})` : ""}`),
      note.displayName ? kv("Display name", `${note.displayName} (chosen by the author; public)`) : null,
      kv("Written", fmtIso(note.createdAt)),
      kv("Note fingerprint (SHA-256)", h("code", { class: "plain-mono", title: n.noteSha256 }, short(n.noteSha256))),
      kv("On the ledger", anchorText),
    ),
  );
}

function recordFilesView(m) {
  const label = { "public-election-copy": "Questions (public copy)", "results-doc": "Official results file", "official-note": "Signed note" };
  const fileNote = (f) =>
    f.state !== "match" ? (f.state === "missing" ? "couldn't be fetched" : "fingerprint does NOT match")
      : f.matchesOnChainResultsHash ? "matches the results fingerprint on the ledger"
      : f.role === "public-election-copy" ? "ballot codes removed, so it can't match the registered file fingerprint"
      : "matches the record";
  const download = h("button", { class: "btn", type: "button", onClick: () => downloadRecord(m) }, "Download the record bundle (.zip)");
  return h(
    "div",
    { class: "record-files" },
    h("h3", null, "The record"),
    h("dl", { class: "kvs" }, kv("Record fingerprint (SHA-256 of the manifest)", h("code", { class: "plain-mono", title: m.manifestSha256 }, short(m.manifestSha256))), kv("On the ledger", m.manifestAnchor === undefined ? "Not on the ledger (signed file only)" : m.manifestAnchor ? `Posted ${fmtDate(m.manifestAnchor.postedAt)} by ${shortAddress(m.manifestAnchor.author)}` : "Not posted yet"), kv("Kept until", m.manifest.retention?.keepUntil ? fmtIso(m.manifest.retention.keepUntil) : "not decided yet")),
    h("ul", { class: "rule-list" }, m.files.map((f) => h("li", { class: f.state === "match" ? "rule-pass" : "rule-fail" }, icon(f.state === "match" ? "check" : "alert", { size: 16 }), h("span", null, h("strong", null, label[f.role] ?? f.path), " ", h("code", { class: "plain-mono small", title: f.sha256 }, short(f.sha256)), " · ", fileNote(f))))),
    h("div", { class: "actions" }, download, m.url ? extLink(m.url, "Open the manifest") : null),
  );
}

function downloadRecord(m) {
  const files = Object.entries(m.bytes ?? {}).map(([name, bytes]) => ({ name: `${m.code}-record/${name}`, bytes }));
  const zip = buildZip(files);
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const a = h("a", { href: url, download: `${m.code}-record.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const kv = (k, v) => h("div", { class: "kv" }, h("dt", null, k), h("dd", null, v));
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const anchored = (a) => a && typeof a === "object";

function buildChecks({ el, fileRes, questions, tally, recount, history, metrics }) {
  const checks = [];
  // 1. election file
  if (!fileRes) checks.push({ state: "na", title: "The question list matches the ledger", detail: "We couldn't load the election file to compare it." });
  else if (fileRes.check === "verified") checks.push({ state: "pass", title: "The question list matches the ledger", detail: `The fingerprint (${shortHash(el.version.fileSha256)}) of the election file is the one registered before voting.` });
  else if (fileRes.check === "mismatch") checks.push({ state: "fail", title: "The question list does NOT match the ledger", detail: "The election file we loaded has a different fingerprint than the one registered on the ledger. Don't rely on the wording shown." });
  else checks.push({ state: "pending", title: "The question list matches the ledger", detail: `The election was registered with fingerprint ${shortHash(el.version.fileSha256)}. The file was never published to a public storage network, so this page uses a copy of its questions that can't be fingerprint-checked (a private list of ballot codes was removed from it). The vote counts below don't depend on it.` });
  // 2. lines
  if (!history) checks.push({ state: tally ? "na" : "pending", title: "Every ballot line is on the ledger", detail: tally ? "We couldn't fetch the individual ledger lines right now." : "The ledger lines are read once results are published." });
  else {
    const n = Object.keys(history.records).length;
    checks.push({ state: n === el.recordCount ? "pass" : "fail", title: "Every ballot line is on the ledger", detail: `We read ${n} ballot line${n === 1 ? "" : "s"}; the ledger says ${el.recordCount} ${el.recordCount === 1 ? "was" : "were"} accepted.` });
  }
  // 3. recount
  if (recount && tally) {
    const bad = recount.filter((r, i) => r.valid !== tally.perQuestion[i].valid || r.blank !== tally.perQuestion[i].blank || r.overvote !== tally.perQuestion[i].overvote || r.unclear !== tally.perQuestion[i].unclear).length;
    checks.push({ state: bad === 0 ? "pass" : "fail", title: "Our recount matches the official totals", detail: bad === 0 ? `This page counted the ballot lines itself, question by question, and got the same totals as the official tally${history.corrections.length ? ` (after applying ${history.corrections.length} public correction${history.corrections.length === 1 ? "" : "s"})` : ""}.` : `${bad} question(s) differ between our recount and the official totals.` });
  } else checks.push({ state: "na", title: "Our recount matches the official totals", detail: tally ? "Not available right now." : "Available once results are published." });
  // 4. reconciliation
  if (tally) checks.push({ state: tally.failedChecks === 0 ? "pass" : "fail", title: "Counts balance", detail: tally.failedChecks === 0 ? `Registered, printed, handed out, counted, spoiled and returned ballots add up (${tally.recon.cast} counted).` : `${failedCheckIds(tally.failedChecks).length} automatic balance check(s) failed: ${failedCheckIds(tally.failedChecks).join(", ")}.` });
  // 5. finality
  if (tally) checks.push({ state: tally.final ? "pass" : "pending", title: "The result is final", detail: tally.final ? "No open review. This is the final result unless a later public correction amends it." : "A reviewer still needs to clear this result." });
  // 6. verifiers
  if (metrics) {
    if (metrics.nodeCount === 0) checks.push({ state: "pending", title: "Independent verifiers agree", detail: "No independent verifier has published a report for this election yet." });
    else checks.push({ state: metrics.nodesWithDisagreement === 0 ? "pass" : "fail", title: "Independent verifiers agree", detail: `${metrics.nodeCount} verifier${metrics.nodeCount === 1 ? "" : "s"} reported: ${metrics.nodesAllAgree} agree${metrics.nodesWithDisagreement ? `, ${metrics.nodesWithDisagreement} disagree` : ""}.` });
  }
  return checks;
}
