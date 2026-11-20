// Verifier screen: the core of the no-trust design. A verifier downloads the evidence (ballot images, ledger entries),
// re-counts the election on their own computer, compares it with the official tally, and signs a report.
// Verifiers can only raise flags: nothing on this page can change a record. The two things it can write are the
// verifier's own registration and its own signed report, both through the connected wallet (tx.js).
import { fill, h, icon, badge, callout, spinner, setTitle, fmtDate, extLink, explorerAddress, explorerTx, toast } from "./ui.js";
import { CONFIG, fetchImageApi, resolveImagePath } from "./config.js";
import { state, subscribe } from "./roles.js";
import { getTally, loadLedgerHistory, getVerifierMetrics, loadVerifierReports, getChainHead, keccakBytes, getEthers } from "./chain.js";
import { applyCorrections, tallyFromResults, canonicalize, sha256Hex, STATUS_TEXT, shortHash, splitLedgerResults, parseResult, choiceLabel } from "./format.js";
import {
  reconcile, compareTally, auditEntries, summarizeEntries, buildFlags, buildVerifierReport, reportCanonical, reportTypedData, onChainReportArgs,
  challengeMessage, signatureStillFresh, verifierApiMessage, ledgerMerkle, normHash, rulesFromMask, explainError, sameAddress, isPublicBallotImages, allBallotCodes,
} from "./logic.js";
import { sendTx, signWithCard } from "./tx.js";
import { pageHead, roleAccess, electionPicker, loadElectionContext, notFoundCard, errorCard, statGrid, kvList, dataTable, flagList, hashText, downloadBlob, field, busy, questionsOf } from "./staff.js";
import { buildScanList, packScanArchive, scanZipName, summarizeScans, toLegacyImageState, verifyAllScans } from "./scans.js";
import { accessHint, scanPanel, urlsForBlobs } from "./scans-ui.js";
import { publicImagesStaffNote } from "./public-images.js";

const PATH = "/verifier";
const PAGE = 25;
const CONCURRENCY = 4;

export async function renderVerifier(ctx) {
  const { root } = ctx;
  setTitle("Verifier");
  const pickerSlot = h("div");
  const body = h("div", { class: "stack" });
  fill(root, 
    h("a", { class: "back", href: "#/staff" }, "← All staff roles"),
    pageHead("verifier", { lead: "Don't take our word for the count. Download the evidence, re-count it on your own computer, compare it with the official tally and sign what you find." }),
    roleAccess(ctx, { roleId: "verifier", detail: "Reading and re-counting stay open. A crypto-wallet is needed to download ballot images and to sign a report.", whenConnected: () => registrationBox(ctx) }),
    pickerSlot,
    body,
  );
  let code;
  try {
    code = await electionPicker(ctx, pickerSlot, PATH);
  } catch {
    fill(pickerSlot, errorCard(null, () => renderVerifier(ctx)));
    return;
  }
  if (!ctx.current()) return;
  if (!code) return fill(body, h("section", { class: "card" }, callout("info", "No elections found yet", "When an election is registered on the ledger it will appear here.")));
  fill(body, h("section", { class: "card" }, spinner("Reading every ledger entry for this election…")));
  try {
    const ec = await loadElectionContext(code);
    if (!ctx.current()) return;
    if (!ec) return fill(body, notFoundCard(code));
    const { election: el } = ec;
    const history = await loadLedgerHistory(el);
    const questions = questionsOf(ec.file, history.records);
    const [tally, metrics, reports, head] = await Promise.all([el.resultCount > 0 ? getTally(el, questions.length) : null, getVerifierMetrics(el).catch(() => null), loadVerifierReports(el).catch(() => null), getChainHead().catch(() => null)]);
    if (!ctx.current()) return;
    fill(body, ...verifierBody({ ctx, ec, el, history, questions, tally, metrics, reports, head }));
  } catch (e) {
    console.error(e);
    if (ctx.current()) fill(body, errorCard(null, () => renderVerifier(ctx)));
  }
}

// ------------------------------------------------------------------ register as a verifier
function registrationBox(ctx) {
  if (state.status === "checking") return null;
  if (state.roles.verifier) return h("p", { class: "muted small" }, icon("check", { size: 14 }), " Registered as a verifier node", state.details.verifier?.name ? ` (“${state.details.verifier.name}”).` : ".");
  const name = h("input", { id: "node-name", placeholder: "e.g. Riverside Library Verifiers", maxlength: 60, autocomplete: "off", "aria-label": "Name for your verifier node" });
  const info = h("input", { id: "node-info", placeholder: "Optional: link to who you are (ipfs://… or https://…)", autocomplete: "off", "aria-label": "Optional link about you" });
  const btn = h("button", { class: "btn btn-primary", type: "button" }, "Register as a verifier");
  btn.addEventListener("click", () =>
    busy(btn, "Working…", async () => {
      const n = name.value.trim();
      if (!n) return toast("Give your node a name first.");
      const r = await sendTx({
        contract: "verifiers",
        method: "register",
        args: [n, info.value.trim()],
        title: "Register as a verifier",
        lines: ["You are adding your crypto-wallet to the public list of verifier nodes, under the name you chose. Anyone may do this: it is how independent checkers announce themselves. It lets you download ballot images and publish reports."],
        facts: [["Node name", n], ["Link", info.value.trim() || "none"]],
      });
      if (r.status === "failed") toast(r.message);
      if (r.status === "sent") toast("You're registered.");
    }),
  );
  return h("div", { class: "register-box" }, callout("info", "This wallet isn't a registered verifier yet", "Registering is open to anyone and free apart from a small network fee. The image store serves registered verifiers, and this election's organizer.", "info"), h("div", { class: "row" }, name, info), h("div", { class: "actions" }, btn));
}

// ------------------------------------------------------------------ the page body
function verifierBody({ ctx, ec, el, history, questions, tally, metrics, reports, head }) {
  const file = ec.file;
  const allDetails = Object.entries(history.details);
  const corrected = applyCorrections(history.records, history.corrections);
  const resultStrings = Object.values(corrected);
  const recount = tallyFromResults(resultStrings, questions);
  const audit = auditEntries(resultStrings, questions);
  const special = summarizeEntries(resultStrings, questions);
  const tallyCmp = tally ? compareTally(tally.perQuestion, recount) : { checked: false, matches: null, perQuestion: [], differences: [] };

  // Reconciliation: re-run the rules over the posted numbers and compare with the mask the ledger stored.
  let recon = { checked: false, matches: null, failedChecks: null, drift: null, details: [] };
  if (tally) {
    try {
      const r = tally.recon;
      const mine = reconcile({ registered: r.registered, issued: r.issued, unusedReturned: r.unusedReturned }, { registeredInElectionFile: el.registeredVoters, printed: r.printed, cast: r.cast, spoiled: r.spoiled, perQuestion: tally.perQuestion });
      const countersAgree = r.cast === el.recordCount && r.spoiled === el.spoiledCount;
      const drift = mine.failedChecks !== tally.failedChecks || !countersAgree;
      recon = { checked: true, matches: !drift && mine.failedChecks === 0, failedChecks: tally.failedChecks, drift, details: mine.details, countersAgree };
    } catch {
      recon = { checked: true, matches: false, failedChecks: tally.failedChecks, drift: true, details: [], countersAgree: false };
    }
  }

  const V = {
    merkle: null, // { checked, matches, root, leaves, unknown, onChainRoot }
    images: null, // { items, setCompare, summary, blobs, expiredOmitted }
    urls: new Map(),
    scanItems: null,
    scanSummary: null,
    scanStatus: "",
    scanError: "",
    scanLoading: false,
    scanProgress: null,
    sig: null, // { code, ts, sig }
    report: null,
    signed: null,
    filter: "all",
    page: 0,
  };
  const flagsSlot = h("div");
  const reportSlot = h("div");
  const merkleSlot = h("div");
  const imagesSlot = h("div");
  const entriesSlot = h("div");

  const facts = () => ({
    tallyPosted: !!tally,
    tallyMatches: tally ? tallyCmp.matches : undefined,
    tallyDifferences: tallyCmp.differences,
    failedChecks: tally?.failedChecks,
    reconciliationDrift: tally ? recon.drift : undefined,
    fileCheck: ec.fileInfo?.check ?? "unverifiable",
    recordsRead: allDetails.length,
    recordCount: el.recordCount,
    unreadable: special.unreadable,
    auditProblems: audit.problems.length,
    merkle: tally ? (V.merkle ? { ...V.merkle, unknownBallots: V.merkle.unknown ?? 0 } : { checked: false }) : undefined,
    images: V.images ? V.images.summary : null,
    unclear: special.unclear,
    overvote: special.overvote,
  });

  const refresh = () => {
    const flags = buildFlags(facts());
    fill(flagsSlot, flagsCard(flags, tally));
    V.flags = flags;
    V.signed = null;
    V.createdAt = null;
    fill(reportSlot, reportCard());
  };

  // ---------------------------------------------------------------- glance
  const glance = h(
    "section",
    { class: "card", "aria-labelledby": "v-glance" },
    h("h2", { id: "v-glance" }, icon("search", { size: 22 }), ec.name),
    h("div", { class: "badges" }, badge(STATUS_TEXT[el.status].label, el.status === 4 ? "ok" : "info"), tally ? badge(tally.final ? "Final" : "Under review", tally.final ? "ok" : "warn") : badge("No tally yet", "neutral"), ec.fileInfo ? badge(ec.fileInfo.check === "verified" ? "Election file verified" : ec.fileInfo.check === "mismatch" ? "File fingerprint mismatch" : "Election file: public copy", ec.fileInfo.check === "verified" ? "ok" : ec.fileInfo.check === "mismatch" ? "bad" : "neutral") : badge("No election file", "warn")),
    statGrid([
      ["Ballots on the ledger", el.recordCount, `${allDetails.length} entries read`],
      ["Spoiled", el.spoiledCount],
      ["Corrections", el.correctionCount],
      ["Official tally", tally ? `version ${tally.version}` : "not posted"],
      ["Verifier nodes", metrics?.nodeCount ?? "—", metrics ? `${metrics.nodesAllAgree} fully agree` : null],
      ["Ledger block", head ? head.number.toLocaleString() : "—", head ? "read just now" : null],
    ]),
    h("p", { class: "muted small" }, "Election key ", hashText(el.key, 12, 8), " · ", extLink(explorerAddress(el.contractSet?.contracts?.ledger ?? CONFIG.contracts.ledger), "ballot ledger contract")),
  );

  // ---------------------------------------------------------------- step 1: all ballot scans
  const ledgerEntries = allDetails.map(([ballotKey, d]) => ({ ballotKey, results: corrected[ballotKey] ?? d.results, imageSha256: d.imageSha256, reviewed: d.reviewed }));
  V.scanItems = buildScanList({ ledgerEntries, storeImages: [], questions }).items;
  V.scanSummary = summarizeScans(V.scanItems);

  const imagesCard = () =>
    scanPanel({
      items: V.scanItems ?? [],
      urls: V.urls,
      summary: V.scanSummary,
      statusText: V.scanStatus,
      error: V.scanError,
      loading: V.scanLoading,
      progress: V.scanProgress,
      canAct: !!state.address && !V.scanLoading,
      hint: isPublicBallotImages(file)
        ? h("div", { class: "stack" }, accessHint({ address: state.address, isOrganizer: sameAddress(state.address, el.organizer), isVerifier: state.roles.verifier, page: "verifier" }), publicImagesStaffNote())
        : accessHint({ address: state.address, isOrganizer: sameAddress(state.address, el.organizer), isVerifier: state.roles.verifier, page: "verifier" }),
      onLoad: () => runScans(),
      onVerify: () => runScans(),
      onDownload: () => downloadScans(),
      loadLabel: V.images ? "Load pictures again" : "Load pictures",
      headingId: "v-img",
      title: "1. All ballot scans",
      lead: "Look at every stored ballot picture, fingerprint each one in your browser, and save a zip with a manifest. This view is not public, because a scan can show the printed ballot code. No AI is used.",
    });

  function adopt(items, blobs, setCompare, expiredOmitted) {
    V.scanItems = items;
    V.scanSummary = summarizeScans(items, { expiredOmitted, setCompare });
    V.urls = urlsForBlobs(blobs, V.urls);
    V.images = toLegacyImageState(items, setCompare, blobs, expiredOmitted);
  }

  async function runScans() {
    if (V.scanLoading) return;
    V.scanLoading = true;
    V.scanError = "";
    V.scanStatus = "Asking the store which pictures it holds…";
    V.scanProgress = null;
    fill(imagesSlot, imagesCard());
    try {
      const auth = await getAuth(el.code);
      if (!auth) {
        V.scanStatus = "";
        V.scanLoading = false;
        return fill(imagesSlot, imagesCard());
      }
      const headers = { "X-Verifier-Timestamp": String(auth.ts), "X-Verifier-Signature": auth.sig };
      const base = resolveImagePath("/api/verifier/images");
      const q = `?election=${encodeURIComponent(el.code)}`;
      const mres = await fetchImageApi(base + q, { headers, referrerPolicy: "no-referrer", cache: "no-store" });
      if (!mres.ok) {
        if (mres.status === 401 || mres.status === 403) V.sig = null;
        V.scanError = verifierApiMessage(mres.status);
        V.scanStatus = "";
        V.scanLoading = false;
        return fill(imagesSlot, imagesCard());
      }
      const manifest = await mres.json();
      const storeImages = Array.isArray(manifest.images) ? manifest.images : [];
      const built = buildScanList({ ledgerEntries, storeImages, questions, expiredOmitted: manifest.expiredOmitted ?? 0 });
      V.scanItems = built.items;
      V.scanSummary = summarizeScans(built.items, { expiredOmitted: built.expiredOmitted, setCompare: built.setCompare });
      fill(imagesSlot, imagesCard());
      const result = await verifyAllScans({
        items: built.items,
        concurrency: CONCURRENCY,
        fetchImage: async (hash) => {
          if (Date.now() / 1000 - auth.ts > 270) throw new Error("The sign-in note expired. Please load the pictures again.");
          const r = await fetchImageApi(`${base}/${hash}${q}`, { headers, referrerPolicy: "no-referrer", cache: "no-store" });
          if (!r.ok) return { ok: false, status: r.status };
          return { ok: true, status: 200, bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") || "" };
        },
        hashBytes: (bytes) => sha256Hex(bytes),
        onProgress: ({ done, total, items }) => {
          V.scanItems = items;
          V.scanProgress = { done, total };
          V.scanStatus = `Checked ${done} of ${total} pictures…`;
          fill(imagesSlot, imagesCard());
        },
      });
      adopt(result.items, result.blobs, built.setCompare, built.expiredOmitted);
      V.scanStatus = V.scanSummary.headline + ".";
      V.scanLoading = false;
      V.scanProgress = null;
      fill(imagesSlot, imagesCard());
      refresh();
    } catch (e) {
      V.scanError = explainError(e);
      V.scanStatus = "";
      V.scanLoading = false;
      V.scanProgress = null;
      fill(imagesSlot, imagesCard());
    }
  }

  function downloadScans() {
    if (!V.images?.blobs?.size) return toast("Load the pictures first.");
    const zip = packScanArchive({
      electionCode: el.code,
      items: V.scanItems,
      blobs: V.images.blobs,
      summary: V.scanSummary,
      generatedAt: new Date().toISOString(),
      date: new Date(),
    });
    downloadBlob(scanZipName(el.code), zip, "application/zip");
  }

  async function getAuth(code) {
    const now = Math.floor(Date.now() / 1000);
    if (V.sig && V.sig.code === code && signatureStillFresh(V.sig.ts, now)) return V.sig;
    const r = await signWithCard({
      title: "Sign in to load ballot pictures",
      lines: ["Your crypto-wallet signs a short note saying who you are and which election you want. The image store checks that this crypto-wallet is a registered verifier or this election's organizer. The signature is good for five minutes and can't be used for anything else."],
      facts: [["Note you sign", challengeMessage(code, "<time now>")], ["Wallet", state.address]],
      confirmText: "Sign",
      sign: async (signer) => {
        const ts = Math.floor(Date.now() / 1000);
        return { ts, sig: await signer.signMessage(challengeMessage(code, ts)) };
      },
    });
    if (r.status === "signed") return (V.sig = { code, ...r.signature });
    if (r.status === "failed") toast(r.message);
    return null;
  }


  // ---------------------------------------------------------------- step 2: entries
  const entryCard = () => {
    const rows = allDetails
      .map(([key, d]) => {
        const final = corrected[key];
        const segs = splitLedgerResults(final);
        const correctedFlag = final !== d.results;
        const kinds = segs.map((s) => parseResult(s)?.kind ?? "?");
        const flagged = kinds.some((k) => k === "U" || k === "O" || k === "?") || correctedFlag;
        const imgStatus = V.images?.items.find((i) => i.sha256 === normHash(d.imageSha256))?.status;
        return { key, final, d, correctedFlag, flagged: flagged || imgStatus === "tampered", imgStatus };
      })
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const view = V.filter === "flagged" ? rows.filter((r) => r.flagged) : rows;
    const pages = Math.max(1, Math.ceil(view.length / PAGE));
    V.page = Math.min(V.page, pages - 1);
    const slice = view.slice(V.page * PAGE, V.page * PAGE + PAGE);
    const answerText = (r) => splitLedgerResults(r.final).map((seg, i) => { const p = parseResult(seg); const t = !p ? `unreadable (${seg})` : p.kind === "V" ? p.choices.map((id) => choiceLabel(questions[i], id)).join(" + ") : { B: "blank", O: "overvote", U: "unclear" }[p.kind] ?? seg; return `Q${i + 1}: ${t}`; }).join(" · ");
    const table = dataTable(
      [{ key: "k", label: "Ballot (hashed)" }, { key: "a", label: "What the ledger says" }, { key: "i", label: "Image fingerprint" }, { key: "s", label: "Notes" }],
      slice.map((r) => ({
        k: hashText(r.key, 8, 6),
        a: h("span", { class: "small" }, answerText(r)),
        i: hashText(r.d.imageSha256, 8, 6),
        s: h("span", { class: "badges" }, r.correctedFlag ? badge("Corrected", "warn") : null, r.d.reviewed ? badge("Reviewed", "info") : null, r.imgStatus === "verified" ? badge("Image ok", "ok", "check") : null, r.imgStatus === "tampered" ? badge("Image differs", "bad", "alert") : null),
      })),
      { caption: "Ledger entries", empty: V.filter === "flagged" ? "No flagged entries. Everything on the ledger is readable and unremarkable." : "No ballots have been recorded yet." },
    );
    const sel = h("select", { id: "v-filter", "aria-label": "Which entries to show" }, h("option", { value: "all", selected: V.filter === "all" }, `All entries (${rows.length})`), h("option", { value: "flagged", selected: V.filter === "flagged" }, `Only flagged (${rows.filter((r) => r.flagged).length})`));
    sel.addEventListener("change", () => ((V.filter = sel.value), (V.page = 0), fill(entriesSlot, entryCard())));
    const nav = pages > 1 ? h("div", { class: "actions" }, h("button", { class: "btn btn-sm", type: "button", disabled: V.page === 0, onClick: () => ((V.page -= 1), fill(entriesSlot, entryCard())) }, "← Previous"), h("span", { class: "muted", role: "status" }, `Page ${V.page + 1} of ${pages}`), h("button", { class: "btn btn-sm", type: "button", disabled: V.page >= pages - 1, onClick: () => ((V.page += 1), fill(entriesSlot, entryCard())) }, "Next →")) : null;
    return h(
      "section",
      { class: "card", "aria-labelledby": "v-entries" },
      h("h2", { id: "v-entries" }, icon("clipboard", { size: 22 }), "2. Ledger entries"),
      h("p", null, `Every ballot's recorded answer, with corrections applied. They are listed by a hash of the ballot code, not in scanning order, so nobody can match an entry to a person.`),
      audit.problems.length ? callout("bad", `${audit.problems.length} entr${audit.problems.length === 1 ? "y breaks" : "ies break"} the election's rules`, audit.problems.slice(0, 3).map((p) => `Ballot ${p.ballot + 1}${p.question != null ? `, question ${p.question + 1}` : ""}: ${p.problem}`).join("; ")) : null,
      h("div", { class: "row" }, sel),
      table,
      nav,
    );
  };

  // ---------------------------------------------------------------- step 3: recount
  const recountCard = () => {
    const rows = [];
    questions.forEach((q, qi) => {
      const o = tally?.perQuestion[qi];
      const r = recount[qi];
      for (const f of ["valid", "blank", "overvote", "unclear"]) {
        const diff = o ? o[f] !== r[f] : false;
        rows.push({ q: `${qi + 1}. ${q.text}`, f: { valid: "Valid", blank: "Blank", overvote: "Overvote", unclear: "Unclear" }[f], o: o ? o[f] : "—", r: r[f], ok: !o ? badge("no tally yet", "neutral") : diff ? badge("Differs", "bad", "x") : badge("Match", "ok", "check"), _class: diff ? "row-bad" : null });
      }
    });
    const choiceRows = questions.flatMap((q, qi) => q.choices.map((c) => ({ q: `${qi + 1}. ${q.text}`, c: c.text, n: recount[qi].byChoice[c.id] ?? 0 })));
    return h(
      "section",
      { class: "card", "aria-labelledby": "v-recount" },
      h("h2", { id: "v-recount" }, icon("chart", { size: 22 }), "3. Re-count and compare"),
      h("p", null, "This page just counted every ledger entry itself (with corrections applied) and compared the totals with the ones the officials posted."),
      !tally ? callout("info", "No official tally yet", "Your own recount is below. It will be compared as soon as the officials post the tally.") : tallyCmp.matches ? callout("ok", "Your recount matches the official tally", "Every total agrees, for every question.", "check") : callout("bad", "Your recount does NOT match the official tally", `${tallyCmp.differences.length} total${tallyCmp.differences.length === 1 ? "" : "s"} differ. This is raised as a flag below.`, "alert"),
      dataTable([{ key: "q", label: "Question" }, { key: "f", label: "Kind" }, { key: "o", label: "Official", num: true }, { key: "r", label: "Your recount", num: true }, { key: "ok", label: "" }], rows, { caption: "Official tally against your recount" }),
      h("details", { class: "details" }, h("summary", null, "Votes for each choice (your recount)"), dataTable([{ key: "q", label: "Question" }, { key: "c", label: "Choice" }, { key: "n", label: "Marks", num: true }], choiceRows, { caption: "Marks per choice" })),
      h("h3", null, "Do the numbers add up? (rules R1 to R6)"),
      !tally ? h("p", { class: "muted" }, "Checked once the tally is posted.") : recon.details.length
        ? h("ul", { class: "checks" }, recon.details.map((d) => h("li", { class: `check check-${d.skipped ? "pending" : d.passed ? "pass" : "fail"}` }, h("span", { class: "check-icon" }, icon(d.passed ? "check" : "x", { size: 18 })), h("div", null, h("strong", null, `${d.rule}: ${d.message}`)))))
        : null,
      tally && recon.drift ? callout("bad", "The stored reconciliation doesn't recompute", `The ledger stored failed-check bits ${tally.failedChecks}; recomputing from the posted counts${recon.countersAgree ? "" : " (and the ledger's own counters)"} disagrees.`) : null,
      tally && !recon.drift && tally.failedChecks > 0 ? callout("warn", "The posted reconciliation failed", `Rules failed: ${rulesFromMask(tally.failedChecks).filter((r) => !r.passed).map((r) => r.id).join(", ")}.`) : null,
    );
  };

  // ---------------------------------------------------------------- step 4: merkle
  const merkleCard = () => {
    const fileInput = h("input", { type: "file", id: "v-file", accept: "application/json,.json", "aria-describedby": "v-file-hint" });
    const out = h("div", { role: "status" });
    const paint = () => {
      fill(out, 
        !V.merkle ? null : !V.merkle.checked ? callout("warn", "That file couldn't be used", V.merkle.reason ?? "") : V.merkle.matches ? callout("ok", "Merkle root matches", `${V.merkle.leaves} entries rebuilt into root ${shortHash(V.merkle.root, 10, 8)}, the same root the officials posted.`, "check") : callout("bad", "Merkle root does NOT match", `Rebuilt ${shortHash(V.merkle.root, 10, 8)} but the ledger has ${shortHash(V.merkle.onChainRoot, 10, 8)}.`, "alert"),
      );
    };
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        if (f.size > 20_000_000) throw new Error("That file is too large to be an election file.");
        const json = JSON.parse(await f.text());
        const full = json.file ?? json;
        if (!Array.isArray(full.ballotCodes) || !full.ballotCodes.length) throw new Error("This file has no ballot codes. The public copy leaves them out, so it can't rebuild the root. The organizer holds the full file.");
        if (full.electionCode !== el.code) throw new Error(`This file is for ${full.electionCode ?? "another election"}, not ${el.code}.`);
        const fileHash = "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(full))));
        if (fileHash !== el.version.fileSha256.toLowerCase()) throw new Error("This file's fingerprint doesn't match the one on the ledger, so it isn't the file the election was registered with.");
        const ethers = await getEthers();
        const keccak = (bytes) => ethers.keccak256(bytes);
        const records = Object.entries(history.details).map(([ballotKey, d]) => ({ ballotKey, results: corrected[ballotKey], imageSha256: d.imageSha256, recordSha256: d.recordSha256, reviewed: d.reviewed }));
        const m = ledgerMerkle({ electionCode: el.code, records, codes: allBallotCodes(full), questions, keccak });
        const onChainRoot = tally?.merkleRoot ?? null;
        V.merkle = { checked: !!tally, matches: tally ? m.root.toLowerCase() === onChainRoot.toLowerCase() && m.unknown === 0 : null, root: m.root, leaves: m.leaves, unknown: m.unknown, onChainRoot, reason: tally ? null : "No official tally yet, so there is no root to compare with." };
      } catch (e) {
        V.merkle = { checked: false, reason: String(e?.message ?? e) };
      }
      paint();
      refresh();
    });
    paint();
    return h(
      "section",
      { class: "card", "aria-labelledby": "v-merkle" },
      h("h2", { id: "v-merkle" }, icon("link", { size: 22 }), "4. Merkle root (optional, needs the full election file)"),
      h("p", null, "The official tally includes a single fingerprint (a Merkle root) of every ledger entry together with its ballot code. To rebuild it you need the election file that includes the secret ballot codes. The organizer or a co-verifier can give you that file. It is read in your browser and never uploaded."),
      h("div", { class: "field" }, h("label", { for: "v-file" }, "Full election file (JSON)"), fileInput, h("p", { id: "v-file-hint", class: "hint" }, "The file's fingerprint is checked against the ledger first.")),
      out,
    );
  };

  // ---------------------------------------------------------------- flags + report
  const flagsCard = (flags, t) =>
    h(
      "section",
      { class: "card", "aria-labelledby": "v-flags" },
      h("h2", { id: "v-flags" }, icon("flag", { size: 22 }), "Flags you can raise"),
      h("p", null, "Anything that doesn't add up is listed here. Verifiers can only flag problems; they can't change, hide or delete a record."),
      flagList(flags, t ? "Everything this page was able to check agrees with the ledger." : "Nothing wrong so far. There is no official tally to compare with yet."),
    );

  const reportCard = () => {
    const address = state.address;
    if (V.signed && V.signed.signer !== address) V.signed = null;
    const base = {
      electionCode: el.code,
      tallyVersion: tally?.version ?? 0,
      address: address ?? "0x0000000000000000000000000000000000000000",
      block: head?.number ?? 0,
      recordCount: el.recordCount,
      recordsRead: allDetails.length,
      correctionsRead: history.corrections.length,
      audit,
      tally: { checked: tallyCmp.checked, matches: tallyCmp.matches, differences: tallyCmp.differences },
      recon: { checked: recon.checked, matches: recon.checked ? recon.matches : null, failedChecks: recon.failedChecks },
      merkle: V.merkle && V.merkle.checked ? { checked: true, matches: V.merkle.matches, root: V.merkle.root, onChainRoot: V.merkle.onChainRoot } : { checked: false, onChainRoot: tally?.merkleRoot ?? null },
      images: V.images ? V.images.summary : null,
      fileCheck: ec.fileInfo?.check ?? "unverifiable",
      flags: V.flags ?? [],
      createdAt: (V.createdAt ??= new Date().toISOString()),
    };
    const report = buildVerifierReport(base);
    V.report = report;
    const signBtn = h("button", { class: "btn btn-primary", type: "button", disabled: !address }, icon("shield", { size: 18 }), "Sign and download report");
    signBtn.addEventListener("click", () => busy(signBtn, "Waiting for signature…", () => signReport(report)));
    const onchain = onChainReportArgs(report, { electionKey: el.key, reportCid: V.signed ? `local-unpublished:${V.signed.reportHash.slice(2, 14)}` : "local-unpublished", reportSha256: V.signed?.reportHash ?? "0x" });
    const pubBtn = h("button", { class: "btn", type: "button", disabled: !(address && state.roles.verifier && V.signed && onchain.ok) }, "Publish on the ledger");
    pubBtn.addEventListener("click", () => busy(pubBtn, "Working…", () => publish(onchain)));
    return h(
      "section",
      { class: "card", "aria-labelledby": "v-report" },
      h("h2", { id: "v-report" }, icon("shield", { size: 22 }), "5. Your signed report"),
      h("p", null, "A short record of exactly what you checked and found. It is signed with your crypto-wallet (EIP-712), so anyone can confirm it came from you and wasn't altered. Things you didn't check are marked “not checked”, never as a pass."),
      kvList([
        ["Election", `${el.code}, tally version ${report.tallyVersion || "none"}`],
        ["Entries read", `${report.ledger.recordsRead} of ${el.recordCount} (${report.ledger.questionsAgreed} of ${report.ledger.questionsChecked} answers consistent)`],
        ["Tally", report.tally.checked ? (report.tally.matches ? "matches" : "differs") : "not checked"],
        ["Reconciliation", report.reconciliation.checked ? (report.reconciliation.matches ? "passes" : "fails") : "not checked"],
        ["Merkle root", report.merkle.checked ? (report.merkle.matches ? "matches" : "differs") : "not checked"],
        ["Ballot images", report.images ? `${report.images.verified} verified, ${report.images.tampered.length} tampered, ${report.images.missingFromStore.length} missing` : "not checked"],
        ["Flags", report.flags.length ? `${report.flags.length} (${report.flags.filter((f) => f.level === "bad").length} serious)` : "none"],
      ]),
      !address ? callout("info", "Connect a crypto-wallet to sign", "You can read the report without a crypto-wallet, but signing needs one.", "wallet") : null,
      h("div", { class: "actions" }, signBtn, h("button", { class: "btn", type: "button", onClick: () => downloadBlob(`${el.code}-unsigned-report.json`, JSON.stringify(report, null, 2), "application/json") }, "Download unsigned copy")),
      V.signed ? callout("ok", "Signed", `Signed by ${state.address}. The file was saved to your downloads. Hash ${shortHash(V.signed.reportHash, 10, 8)}.`, "check") : null,
      h("h3", null, "Publish on the public ledger"),
      onchain.ok ? h("p", null, "Posts a short summary (counts and yes/no results) to the verifier contract, so everyone can see your result next to other verifiers'. Your signed file stays with you; only its fingerprint goes on the ledger.") : callout("neutral", "Not ready to publish", `The ledger records a yes or no for the tally, the reconciliation and the Merkle root, so all three must have been checked: still needed: ${onchain.missing.join("; ")}.`),
      onchain.ok ? h("div", { class: "actions" }, pubBtn) : null,
      onchain.ok && !V.signed ? h("p", { class: "hint" }, "Sign the report first. Its fingerprint is what gets published.") : null,
    );
  };

  async function signReport(report) {
    const reportHash = await keccakBytes(new TextEncoder().encode(reportCanonical(report)));
    const td = reportTypedData({ electionKey: el.key, tallyVersion: report.tallyVersion, reportHash });
    const r = await signWithCard({
      title: "Sign your verification report",
      lines: ["Your crypto-wallet signs a fingerprint of the report so others can tell it came from you. Nothing is published by this step."],
      facts: [["Report fingerprint", reportHash], ["Election", el.code]],
      confirmText: "Sign report",
      sign: (signer) => signer.signTypedData(td.domain, td.types, td.value),
    });
    if (r.status === "signed") {
      V.signed = { reportHash, signature: r.signature, signer: state.address };
      const signed = { ...report, signature: { scheme: "eip712", signer: state.address, reportHash, signature: r.signature } };
      downloadBlob(`${el.code}-verifier-report.json`, JSON.stringify(signed, null, 2), "application/json");
      fill(reportSlot, reportCard());
    } else if (r.status === "failed") toast(r.message);
  }

  async function publish(onchain) {
    const args = onChainReportArgs(V.report, { electionKey: el.key, reportCid: `local-unpublished:${V.signed.reportHash.slice(2, 14)}`, reportSha256: V.signed.reportHash });
    if (!args.ok) return;
    const s = args.summary;
    const r = await sendTx({
      contract: "verifiers",
      method: "reportVerification",
      args: args.args,
      title: "Publish your verification result",
      lines: ["This adds your result to the public record for this election. It doesn't change any ballot, tally or other verifier's report."],
      facts: [["Answers checked / consistent", `${s.checked} / ${s.agreed}`], ["Tally matches", s.tallyMatches ? "yes" : "no"], ["Reconciliation matches", s.reconciliationMatches ? "yes" : "no"], ["Merkle root matches", s.merkleMatches ? "yes" : "no"], ["Report fingerprint", V.signed.reportHash]],
      confirmText: "Publish my result",
    });
    if (r.status === "sent") toast("Your result is on the ledger.");
    else if (r.status === "failed") toast(r.message);
  }

  // ---------------------------------------------------------------- other verifiers
  const othersCard = () =>
    h(
      "section",
      { class: "card", "aria-labelledby": "v-others" },
      h("h2", { id: "v-others" }, icon("users", { size: 22 }), "Other verifiers' published results"),
      reports === null ? h("p", { class: "muted" }, "The list of published reports couldn't be read just now.") : dataTable(
        [{ key: "n", label: "Verifier" }, { key: "v", label: "Tally version", num: true }, { key: "c", label: "Answers agreed", num: true }, { key: "t", label: "Tally" }, { key: "r", label: "Reconciliation" }, { key: "m", label: "Merkle" }, { key: "x", label: "" }],
        reports.map((r) => ({ n: hashText(r.node, 8, 6), v: r.tallyVersion, c: `${r.agreed} / ${r.checked}`, t: yn(r.tallyMatches), r: yn(r.reconciliationMatches), m: yn(r.merkleMatches), x: extLink(explorerTx(r.tx), "tx") })),
        { caption: "Published verifier reports", empty: "No verifier has published a result for this election yet. Yours could be the first." },
      ),
    );

  const blocks = [glance, imagesSlot, entriesSlot, recountCard(), merkleSlot, flagsSlot, reportSlot, othersCard()];
  fill(imagesSlot, imagesCard());
  fill(entriesSlot, entryCard());
  fill(merkleSlot, tally ? merkleCard() : h("section", { class: "card" }, h("h2", null, icon("link", { size: 22 }), "4. Merkle root"), h("p", { class: "muted" }, "Available once the official tally is posted.")));
  refresh();
  // keep the image step honest when the wallet connects or registers
  const off = subscribe(() => {
    if (!ctx.current()) return off();
    fill(imagesSlot, imagesCard());
    fill(reportSlot, reportCard());
  });
  return blocks;
}

const yn = (v) => badge(v ? "Yes" : "No", v ? "ok" : "bad");
