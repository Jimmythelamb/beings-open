// Election admin screen: create an election, set up its Local Scanner/Printer stations and reviewers, open and close voting, publish the
// tally. Every one of these is a real transaction from the connected wallet (the election's organizer), shown on a
// confirmation card first. Viewing an election needs no wallet.

import { fill, h, icon, badge, callout, spinner, setTitle, fmtDate, extLink, explorerTx, toast } from "./ui.js";
import { ROLE_INFO, state, subscribe } from "./roles.js";
import { getTally, loadLedgerHistory, loadElectionStaff, getCloseGrace, keccakBytes, getEthers, loadElectionRecord, readStaffRoster, registrySupportsBallotPool } from "./chain.js";
import { applyCorrections, tallyFromResults, canonicalize, sha256Hex, STATUS_TEXT, shortHash, shortAddress } from "./format.js";
import {
  electionActions, canRegisterRoles, sameAddress, isAddress, isBytes32, parseCount, parseAddressList, reconcile, rulesFromMask, merkleRoot, ledgerMerkle, utf8,
  validateElectionFile, publicElectionCopy, summarizeElectionFile, retentionDeadline, draftElectionFile, newElectionCode, newBallotCodes, IMAGE_RETENTION_MAX_DAYS, DEFAULT_IMAGE_RETENTION_DAYS, isPublicBallotImages, retentionRange, normHash, unixFromIso, normalizeAppFingerprint, printedBallots, DEFAULT_SPARE_PERCENT,
  ballotPoolProof, ballotPoolsFromFile, allBallotCodes, electoralBodyPool, reprintNote, createElectionCall,
} from "./logic.js";
import { helpToggle, headingWithHelp, labelWithHelp } from "./help.js";
import { designLayout, ballotPdf } from "./ballotpdf.js";
import { sendTx, signWithCard } from "./tx.js";
import { importCard } from "./printed.js";
import { delegatedCard } from "./delegated-ui.js";
import { notesCard } from "./notes-ui.js";
import { SCANNER_BUILDS } from "./scanner-builds.js";
import { defaultBuilds, findBuild, resolveCreateFingerprints, registerStationPlan, recordedItems, FIELD_LABEL } from "./fingerprints.js";
import { recordedSection, valueWithCopy, checkDeps } from "./recorded-ui.js";
import { walletInfoBox, createReminder } from "./wallet-info.js";
import { CONFIG, contractAddress, fetchImageApi, resolveImagePath } from "./config.js";
import { buildScanList, packScanArchive, scanZipName, summarizeScans, verifyAllScans } from "./scans.js";
import { accessHint, scanPanel, urlsForBlobs } from "./scans-ui.js";
import { publicImagesStaffNote } from "./public-images.js";
import { registerEnabled, readScannerChoice } from "./scanner-station.js";
import { helperConnectCard } from "./helper-connect.js";
import { systemCheckCard } from "./system-check.js";
import { PREVIEW_NOTE, openPdfBytesInNewTab, testPrintScanCard, testPrintScanAdvisory } from "./test-print-scan.js";
import { administratorGuide, liveWallet, reloadPage, pageHead, electionStartGuide, electionPicker, loadElectionContext, notFoundCard, errorCard, statGrid, kvList, dataTable, flagList, hashText, downloadBlob, field, busy, questionsOf } from "./staff.js";
import { revealStartHere } from "./start-here.js";
import { rosterCard } from "./roster-ui.js";
import { rosterReviewCard } from "./roster-review.js";
import { loadRoster, saveRoster, saveAdminRegistration, withPublicRoster, lineView, adoptPendingRegistration, registrationIsCurrent, electionKindOf } from "./roster.js";
import { ADULT_ATTESTATION, KIND_INDEX, ROLE_INDEX, approvalTypedData, claimTypedData, kindLabel, positionId, rosterFileHash, seatNoOf } from "./staff-roster.js";
const PATH = "/admin";

function administratorName(code, organizer) {
  const seat = loadRoster(localStorage, code, { organizerAddress: organizer }).seats.find((s) => s.id === "admin");
  if (!seat) return "";
  const line = lineView(seat, { electionCode: code, organizerAddress: organizer });
  return line.name === "Open" ? "" : line.name;
}

export async function renderAdmin(ctx) {
  const { root } = ctx;
  setTitle(ROLE_INFO.admin.label);
  const pickerSlot = h("div");
  const body = h("div", { class: "stack" });
  const createSlot = h("div");
  const top = [
    h("a", { class: "back", href: "#/staff" }, "← All staff roles"),
    pageHead("admin", { body: administratorGuide() }),
    electionStartGuide(ctx),
  ];
  // Directions stay at the top. Arriving from Create election, the form is next, so later election details cannot push it down the page.
  const creating = ctx.query.get("new") === "1";
  fill(root, ...top, ...(creating ? [createSlot, pickerSlot, body] : [pickerSlot, body, createSlot]));
  fill(createSlot, importCard(ctx), createCard(ctx));
  document.dispatchEvent(new CustomEvent("beings:election-draft"));
  const land = () => {
    if (ctx.query.get("new") !== "1" || !ctx.current()) return;
    // After this turn, so the route's focus on the page heading does not pull the view back up.
    setTimeout(() => ctx.current() && revealStartHere(), 0);
  };
  let code;
  try {
    code = await electionPicker(ctx, pickerSlot, PATH);
  } catch {
    fill(pickerSlot, errorCard(null, () => renderAdmin(ctx)));
    land();
    return;
  }
  if (!ctx.current()) return;
  if (!code) {
    fill(body, h("section", { class: "card" }, callout("info", "No elections yet", "Create the first one below.")));
    land();
    return;
  }
  fill(body, h("section", { class: "card" }, spinner("Reading the election from the ledger…")));
  try {
    const ec = await loadElectionContext(code);
    if (!ctx.current()) return;
    if (!ec) {
      fill(body, notFoundCard(code));
      land();
      return;
    }
    const [staff, grace] = await Promise.all([loadElectionStaff(ec.election).catch(() => ({ devices: [], reviewers: [] })), getCloseGrace().catch(() => 86400)]);
    if (!ctx.current()) return;
    fill(body, ...manageBody(ctx, ec, staff, grace));
  } catch (e) {
    console.error(e);
    if (ctx.current()) fill(body, errorCard(null, () => renderAdmin(ctx)));
  }
  land();
}

function readLocalJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result))); }
      catch { reject(new Error("That file is not JSON.")); }
    };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

function unwrapSecret(json) {
  if (json?.publicCopy) return { error: "This is the public copy. Ballot codes were removed. Use the secret full file." };
  const file = Array.isArray(json?.ballotCodes) ? json : json?.file;
  if (!file || !Array.isArray(file.ballotCodes) || file.ballotCodes.length === 0) return { error: "This file has no ballot codes. Use the secret full file." };
  return { file };
}

/**
 * Add verified ballots before opening, and log a reprint of a damaged ballot.
 * Codes stay in the secret file the organizer downloads. The chain receives a root, a count, or a ballot hash.
 */
function poolTools(el, isOrganizer, now, done) {
  if (!el.poolEnforced) return null;
  const beforeOpen = el.status === 1 && now < el.opensAt;
  const countIn = h("input", { id: "a-add-count", inputmode: "numeric", placeholder: "How many", autocomplete: "off", "aria-label": "Number of verified ballots to add" });
  const secretIn = h("input", { id: "a-add-file", type: "file", accept: "application/json,.json" });
  const saveAdded = h("input", { id: "a-add-saved", type: "checkbox" });
  const addBtn = h("button", { class: "btn", type: "button", disabled: !isOrganizer || !beforeOpen }, "Add them on the ledger");
  let pending = null;
  secretIn.addEventListener("change", () => { pending = null; saveAdded.checked = false; addBtn.disabled = !isOrganizer || !beforeOpen; });
  addBtn.addEventListener("click", () => busy(addBtn, "Working…", async () => {
    if (!beforeOpen) return toast("Voting has reached its opening time. No more ballots can be added.");
    const count = parseCount(countIn.value);
    if (count == null || count < 1 || count > 500) return toast("Enter how many verified ballots to add, from 1 to 500.");
    if (!saveAdded.checked || !pending || pending.count !== count) return toast("Prepare the secret file first, save it, and tick the box. Nothing was sent.");
    const quorum = electoralBodyPool({ registeredVoters: el.registeredVoters, verifiedExtras: count, unissuedExtras: 0 });
    const r = await sendTx({
      contract: "registry",
      method: "addBallots",
      args: [el.key, pending.root, count],
      title: "Add verified ballots",
      lines: [
        "These ballots join the pool only because you verified each one was issued to a member of the Electoral Body. Unissued extras are not added, and they do not count toward turnout.",
        `After this, the turnout pool counts ${quorum.quorumPool} (registered voters plus these verified ballots). No ballot code is written on the ledger.`,
        "This is allowed only before the opening time.",
      ],
      facts: [["Election", el.code], ["Ballots added", String(count)], ["New authorized total", String(el.ballotCount + count)], ["List fingerprint", hashText(pending.root, 10, 8)]],
      confirmText: "Add ballots",
    });
    done(r, "Verified ballots added.");
  }));
  const prepBtn = h("button", { class: "btn", type: "button", disabled: !isOrganizer || !beforeOpen }, "Prepare the secret file");
  prepBtn.addEventListener("click", () => busy(prepBtn, "Working…", async () => {
    const count = parseCount(countIn.value);
    if (count == null || count < 1 || count > 500) return toast("Enter how many verified ballots to add, from 1 to 500.");
    let base = { electionCode: el.code };
    if (secretIn.files?.[0]) {
      const unwrapped = unwrapSecret(await readLocalJson(secretIn.files[0]));
      if (unwrapped.error) return toast(unwrapped.error);
      if (unwrapped.file.electionCode !== el.code) return toast("That file is for a different election.");
      base = unwrapped.file;
    }
    const codes = newBallotCodes(count, (n) => crypto.getRandomValues(new Uint8Array(n)));
    const ethers = await getEthers();
    const keccak = (b) => ethers.keccak256(b);
    const root = merkleRoot(codes.map((c) => keccak(utf8(c))), keccak);
    const next = { ...base, addedBallotPools: [...(base.addedBallotPools ?? []), { count, root, codes }] };
    pending = { count, root };
    downloadBlob(`${el.code}-SECRET-added-ballots.json`, JSON.stringify(next, null, 2), "application/json");
    toast("The secret file downloaded. Keep it private. It is the only copy of these codes.");
  }));

  const reprintFile = h("input", { id: "a-reprint-file", type: "file", accept: "application/json,.json" });
  const reprintCode = h("input", { id: "a-reprint-code", type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "Ballot code to reprint" });
  const reprintReason = h("input", { id: "a-reprint-reason", autocomplete: "off", "aria-label": "Why it was reprinted" });
  const reprintBtn = h("button", { class: "btn", type: "button", disabled: !isOrganizer }, "Log the reprint");
  reprintBtn.addEventListener("click", () => busy(reprintBtn, "Working…", async () => {
    if (!reprintFile.files?.[0]) return toast("Choose the secret election file. The code is checked on this computer only.");
    const unwrapped = unwrapSecret(await readLocalJson(reprintFile.files[0]));
    if (unwrapped.error) return toast(unwrapped.error);
    if (unwrapped.file.electionCode !== el.code) return toast("That file is for a different election.");
    const typed = reprintCode.value.trim();
    reprintCode.value = "";
    if (!typed) return toast("Enter the ballot code. It stays on this computer.");
    const ethers = await getEthers();
    const keccak = (b) => ethers.keccak256(b);
    const found = ballotPoolProof(ballotPoolsFromFile(unwrapped.file), typed, keccak);
    if (!found) return toast("That code is not in the loaded file's ballot pool. Nothing was sent.");
    let note;
    try {
      note = reprintNote({ electionCode: el.code, ballotKey: found.ballotKey, reason: reprintReason.value, author: state.address, at: new Date().toISOString() });
    } catch (e) {
      return toast(String(e?.message ?? e));
    }
    const reasonHash = keccak(utf8(canonicalize(note)));
    downloadBlob(`${el.code}-reprint-note.json`, JSON.stringify(note, null, 2), "application/json");
    const r = await sendTx({
      contract: "registry",
      method: "noteReprint",
      args: [el.key, found.ballotKey, reasonHash, found.proof, found.rootIndex],
      title: "Log a reprinted ballot",
      lines: [
        "A damaged ballot reprinted with its own code can be scanned once. The ledger still accepts only one record for that code, so the original and the reprint cannot both count.",
        "This note records who reprinted it, when, and why. It names the ballot by its hash, not by the code, and it does not record a vote.",
      ],
      facts: [["Election", el.code], ["Ballot hash", hashText(found.ballotKey, 10, 8)], ["Reason", note.reason]],
      confirmText: "Log reprint",
    });
    done(r, "Reprint noted.");
  }));

  return h("div", null,
    h("h3", null, "Ballot pool"),
    beforeOpen
      ? h("div", null,
        h("p", null, "Add ballots for members of the Electoral Body who were verified after you created the election. Do this before the opening time. Each added ballot is a new code in your secret file. Unissued spares stay out of the pool and are reported as unused at the close."),
        h("div", { class: "row" }, countIn, secretIn),
        h("p", { class: "hint" }, "Optional: choose the secret full file to fold the new codes into it. If you skip that, the download is a file you must keep with the original."),
        h("div", { class: "actions" }, prepBtn),
        h("div", { class: "field check-row" }, saveAdded, h("label", { for: "a-add-saved" }, "I have saved the updated secret file, and these ballots were issued to verified members.")),
        h("div", { class: "actions" }, addBtn),
      )
      : h("p", { class: "muted" }, el.status === 1 ? "The opening time has passed, so no more ballots can be added." : "Ballots can only be added before voting opens."),
    h("h3", null, "Reprint a damaged ballot"),
    h("p", null, "Reprint it with the same code and log the reason. The code is not written on the ledger. If both the original and the reprint are scanned, only the first record counts."),
    h("div", { class: "row" }, reprintFile, reprintCode, reprintReason, reprintBtn),
  );
}

// ------------------------------------------------------------------ one election
function manageBody(ctx, ec, staff, grace) {
  const el = ec.election;
  const file = ec.file;
  const code = el.code;
  const done = (r, okText) => {
    if (r.status === "failed") toast(r.message);
    if (r.status === "sent") (toast(okText), reloadPage());
  };
  const slot = (id) => h("section", { class: "card", "aria-labelledby": id });
  const overview = slot("a-over");
  const life = slot("a-life");
  const reviewSlot = h("div", { id: "roster-review-slot" });
  const staffChain = { configured: !!contractAddress("staff"), known: false, locked: false, kind: "", seats: {}, scannerWallets: [], address: contractAddress("staff"), electionId: el.key, systemSignOffRecorded: false, systemSignOffCurrent: false };
  const tallySlot = slot("a-tally");
  const retire = slot("a-retire");
  const scansSlot = h("div", { id: "a-scans-wrap" });
  const scans = {
    items: [],
    urls: new Map(),
    blobs: new Map(),
    summary: null,
    statusText: "",
    error: "",
    loading: false,
    progress: null,
    setCompare: null,
    expiredOmitted: 0,
    sig: null,
    entries: null,
    questions: [],
  };

  const paint = () => {
    const now = Math.floor(Date.now() / 1000);
    const isOrganizer = sameAddress(state.address, el.organizer);
    const acts = electionActions({ status: el.status, now, opensAt: el.opensAt, closesAt: el.closesAt, deviceCount: el.deviceCount, quorum: el.quorum, isOrganizer, closeGrace: grace });
    const sum = file ? summarizeElectionFile(file) : null;
    const st = STATUS_TEXT[el.status];
    const retention = file?.imageRetention ?? null;
    const deadline = retention ? retentionDeadline(el.closesAt, retention.days) : null;

    fill(overview, 
      h("h2", { id: "a-over" }, icon("clipboard", { size: 22 }), ec.name),
      h("div", { class: "badges" }, badge(st.label, el.status === 2 ? "ok" : "info"), badge(ec.fileInfo ? (ec.fileInfo.check === "verified" ? "File fingerprint verified" : ec.fileInfo.check === "mismatch" ? "File fingerprint mismatch" : "Public copy of the file") : "No election file found", ec.fileInfo?.check === "verified" ? "ok" : ec.fileInfo?.check === "mismatch" ? "bad" : "neutral"), isOrganizer ? badge("You are the organizer", "ok", "unlock") : badge("Organizer: " + shortAddress(el.organizer), "neutral")),
      statGrid([["Opens", fmtDate(el.opensAt)], ["Closes", fmtDate(el.closesAt)], ["Ballots printed", el.ballotCount], ["Registered voters", el.registeredVoters], ["Local Scanner/Printer", `${el.deviceCount} of ${el.quorum} registered`], ["Recorded", el.recordCount]]),
      kvList([
        ["Election code", h("code", { class: "code" }, code)],
        ["Election file fingerprint", hashText(el.version.fileSha256, 14, 10)],
        ["Ballot list fingerprint", hashText(el.ballotListRoot, 14, 10)],
        ["Ballot pool", el.poolEnforced ? `Checked. ${1 + (el.addedRoots?.length ?? 0)} approved list${(el.addedRoots?.length ?? 0) === 0 ? "" : "s"} (the creation list${(el.addedRoots?.length ?? 0) ? ` plus ${el.addedRoots.length} added` : ""}).` : "Not checked. This election was created before ballot-pool enforcement."],
        ["Ballot layout fingerprint", sum?.layoutHash ? hashText(sum.layoutHash, 14, 10) : "not in the public copy"],
        ["Ballot images kept for", retention ? `${retention.days} days after closing${deadline ? ` (until ${fmtDate(deadline)})` : ""}, then ${retention.afterRetention === "delete" ? "deleted" : "held by officials"}` : "not set in the public copy"],
        ["Public ballot images", file ? (isPublicBallotImages(file) ? "On — anyone with the election code and a picture's fingerprint can view that picture, for 30 to 60 days" : "Off") : "not set in the public copy"],
        ["File stored at", el.version.cid.startsWith("local-unpublished") ? "kept by the organizer, not published" : el.version.cid],
      ]),
      sum
        ? h("details", { class: "details" }, h("summary", null, `${sum.questionCount} question${sum.questionCount === 1 ? "" : "s"}, ${sum.choiceCount} choices`), h("ol", { class: "plain-list" }, sum.questions.map((q) => h("li", null, h("strong", null, q.text), ` (choose up to ${q.maxMarks}): `, q.choices.map((c) => c.text).join(", ")))))
        : null,
    );

    // lifecycle
    const people = (list, empty, extra) => (list.length ? h("ul", { class: "plain-list" }, list.map((p) => h("li", null, hashText(p.address, 10, 6), extra?.(p)))) : h("p", { class: "muted" }, empty));
    const can = isOrganizer && canRegisterRoles({ status: el.status, isOrganizer });
    const station = stationRegistration({ el, file, can, isOrganizer, done });
    const revIn = h("input", { id: "a-rev", placeholder: "Reviewer address 0x…", autocomplete: "off", spellcheck: "false", class: "plain-mono", "aria-label": "Reviewer wallet address" });
    const revBtn = h("button", { class: "btn", type: "button", disabled: !can }, "Register reviewer");
    revBtn.addEventListener("click", () =>
      busy(revBtn, "Working…", async () => {
        const a = revIn.value.trim();
        if (!isAddress(a)) return toast("That doesn't look like a wallet address (0x followed by 40 characters).");
        done(await sendTx({ contract: "registry", method: "registerReviewer", args: [el.key, a], title: "Register a reviewer", lines: ["This wallet will be able to mark ballots spoiled and sign off a flagged tally. It can't change recorded ballots. This can only be done before voting opens."], facts: [["Election", code], ["Reviewer", a]], confirmText: "Register reviewer" }), "Reviewer registered.");
      }),
    );
    const mustLock = staffChain.configured && staffChain.known && !staffChain.locked && el.status === 1;
    const openBtn = h("button", { class: "btn btn-primary", type: "button", disabled: mustLock ? !isOrganizer : !acts.canOpen }, icon("unlock", { size: 18 }), mustLock ? "Review the roster" : "Open voting");
    openBtn.addEventListener("click", () => {
      if (mustLock) {
        document.getElementById("roster-review-h")?.focus();
        return;
      }
      busy(openBtn, "Working…", async () => done(await sendTx({ contract: "registry", method: "openElection", args: [el.key], title: "Open voting", lines: ["Scanners will be able to record ballots from now on. You can't go back to setup afterwards."], facts: [["Election", code], ["Local Scanner/Printer stations", `${el.deviceCount} of ${el.quorum}`], ["Scheduled closing", fmtDate(el.closesAt)]], confirmText: "Open voting" }), "Voting is open."));
    });
    const closeBtn = h("button", { class: "btn btn-primary", type: "button", disabled: !acts.canClose }, icon("lock", { size: 18 }), "Close voting");
    closeBtn.addEventListener("click", () =>
      busy(closeBtn, "Working…", async () => done(await sendTx({ contract: "registry", method: "closeElection", args: [el.key], title: "Close voting", lines: ["No more ballots can be recorded after this. Counting and the official tally come next."], facts: [["Election", code], ["Ballots recorded", String(el.recordCount)]], confirmText: "Close voting" }), "Voting is closed.")),
    );
    fill(life, 
      h("h2", { id: "a-life" }, icon("gear", { size: 22 }), "Running the election"),
      !isOrganizer ? callout("info", state.address ? "Not this election's organizer" : "Connect the organizer's crypto-wallet", state.address ? `Only ${shortAddress(el.organizer)} can change this election. You can still see everything below.` : "Reading is open to everyone. Changes need the organizer's crypto-wallet.", "lock") : null,
      headingWithHelp("h3", null, `Local Scanner/Printer (${staff.devices.length})`, "admin.device"),
      people(staff.devices, "None registered yet.", (p) => { const b = findBuild(p.appHash); const ok = (file?.approvedAppHashes ?? []).some((x) => normHash(x) === normHash(p.appHash)); return h("span", { class: "muted small" }, " · build ", hashText(p.appHash, 8, 6), b ? ` (${b.label})` : "", " ", file ? badge(ok ? "approved build" : "build not approved", ok ? "ok" : "bad") : null); }),
      el.status === 1 ? station : null,
      headingWithHelp("h3", null, `Reviewers (${staff.reviewers.length})`, "admin.reviewer"),
      people(staff.reviewers, "None registered yet."),
      el.status === 1 ? h("div", { class: "row" }, revIn, revBtn) : null,
      el.status === 1 && !can && isOrganizer ? null : el.status === 1 && !isOrganizer ? h("p", { class: "hint" }, "Registering a Scanner/Printer or a reviewer is open to the organizer only, before voting opens.") : null,
      headingWithHelp("h3", null, "Open and close voting", "admin.openClose"),
      walletInfoBox({ variant: "admin", open: false, administratorName: administratorName(code, el.organizer) }),
      h("div", { class: "actions" }, openBtn, closeBtn),
      el.status === 1 && acts.openBlockers.length ? h("ul", { class: "plain-list hint" }, acts.openBlockers.map((b) => h("li", null, b))) : null,
      el.status === 2 && acts.closeBlockers.length ? h("ul", { class: "plain-list hint" }, acts.closeBlockers.map((b) => h("li", null, b))) : null,
      el.status > 2 ? h("p", { class: "muted" }, "Voting is over.") : null,
      poolTools(el, isOrganizer, now, done),
    );
    if (staffChain.configured && el.status === 1) {
      const rosterNow = loadRoster(localStorage, code, { organizerAddress: el.organizer });
      fill(reviewSlot, rosterReviewCard({
        roster: rosterNow,
        organizerAddress: el.organizer,
        chain: staffChain,
        canEdit: isOrganizer,
        hashRoster: async (r) => rosterFileHash(r, await getEthers()),
        signTyped: (typed, title) => signWithCard({ title: title || "Sign", lines: ["Your crypto-wallet will show the statement. Signing is free."], confirmText: "Sign", sign: (signer) => signer.signTypedData(typed.domain, typed.types, typed.message) }),
        onLock: (payload) => lockThenOpen(payload, el, code, grace),
        onRecordAdmin: async () => {
          const kindName = electionKindOf(loadRoster(localStorage, code, { organizerAddress: el.organizer }));
          if (KIND_INDEX[kindName] == null) return toast("Choose Standard, Test, or Classroom on the roster first. That choice cannot be changed after it is recorded.");
          done(await sendTx({ contract: "staff", method: "recordElectionAdmin", args: [el.key, KIND_INDEX[kindName]], title: "Record the Election Administrator", lines: [`This election will be recorded as ${kindLabel(kindName)}. That cannot be changed.`], facts: [["Election", code], ["Type", kindLabel(kindName)]], confirmText: "Record administrator" }), "Election Administrator recorded.");
        },
      }));
    } else if (staffChain.locked) {
      const standard = staffChain.kind === "standard";
      const sentence = standard
        ? (staffChain.systemSignOffCurrent
          ? "The System admin close-out sign-off is recorded. A standard election requires it before the roster is certification-ready."
          : "A standard election is not certification-ready until the System admin signs the close-out verification of roles, wallets, and duties.")
        : "A System admin close-out sign-off is optional for this election. If it is signed, it is disclosed. This election is not certified.";
      fill(reviewSlot, h("section", { class: "card" },
        h("h2", null, "Staff roster"),
        h("p", null, `The roster fingerprint is locked${staffChain.kind ? `: ${kindLabel(staffChain.kind)}` : ""}.`),
        h("p", null, sentence),
        h("p", null, h("a", { href: `#/system?e=${code}` }, "Open the System admin close-out")),
      ));
    } else fill(reviewSlot);

    fill(tallySlot, ...tallyParts(isOrganizer, acts));
    fill(retire, ...retireParts(isOrganizer, deadline, retention));
    paintScans();
  };

  function paintScans() {
    const isOrganizer = sameAddress(state.address, el.organizer);
    fill(scansSlot, scanPanel({
      items: scans.items,
      urls: scans.urls,
      summary: scans.summary,
      statusText: scans.statusText,
      error: scans.error,
      loading: scans.loading,
      progress: scans.progress,
      canAct: !!state.address && !scans.loading,
      hint: isPublicBallotImages(file)
        ? h("div", { class: "stack" }, accessHint({ address: state.address, isOrganizer, isVerifier: state.roles.verifier, page: "admin" }), publicImagesStaffNote())
        : accessHint({ address: state.address, isOrganizer, isVerifier: state.roles.verifier, page: "admin" }),
      onLoad: () => runAdminScans(),
      onVerify: () => runAdminScans(),
      onDownload: () => downloadAdminScans(),
      loadLabel: scans.blobs.size ? "Load pictures again" : "Load pictures",
      headingId: "a-scans",
      title: "All ballot scans",
    }));
  }

  async function ensureScanEntries() {
    if (scans.entries) return;
    const history = await loadLedgerHistory(el);
    const questions = questionsOf(file, history.records);
    const results = applyCorrections(history.records, history.corrections);
    scans.entries = Object.entries(history.details).map(([ballotKey, d]) => ({ ballotKey, results: results[ballotKey] ?? d.results, imageSha256: d.imageSha256, reviewed: d.reviewed }));
    scans.questions = questions;
    const built = buildScanList({ ledgerEntries: scans.entries, storeImages: [], questions });
    scans.items = built.items;
    scans.summary = summarizeScans(built.items, { setCompare: built.setCompare });
    scans.setCompare = built.setCompare;
  }

  async function getScanAuth() {
    const now = Math.floor(Date.now() / 1000);
    if (scans.sig && scans.sig.code === code && signatureStillFresh(scans.sig.ts, now)) return scans.sig;
    const r = await signWithCard({
      title: "Sign in to load ballot pictures",
      lines: ["Your crypto-wallet signs a short note saying who you are and which election you want. The image store checks that this crypto-wallet is the organizer of this election or a registered verifier. The signature is good for five minutes and can't be used for anything else."],
      facts: [["Note you sign", challengeMessage(code, "<time now>")], ["Wallet", state.address]],
      confirmText: "Sign",
      sign: async (signer) => {
        const ts = Math.floor(Date.now() / 1000);
        return { ts, sig: await signer.signMessage(challengeMessage(code, ts)) };
      },
    });
    if (r.status === "signed") return (scans.sig = { code, ...r.signature });
    if (r.status === "failed") toast(r.message);
    return null;
  }

  async function runAdminScans() {
    if (scans.loading) return;
    scans.loading = true;
    scans.error = "";
    scans.statusText = "Reading the ledger entries…";
    scans.progress = null;
    paintScans();
    try {
      await ensureScanEntries();
      const auth = await getScanAuth();
      if (!auth) {
        scans.loading = false;
        scans.statusText = "";
        return paintScans();
      }
      scans.statusText = "Asking the store which pictures it holds…";
      paintScans();
      const headers = { "X-Verifier-Timestamp": String(auth.ts), "X-Verifier-Signature": auth.sig };
      const base = resolveImagePath("/api/verifier/images");
      const q = `?election=${encodeURIComponent(code)}`;
      const mres = await fetchImageApi(base + q, { headers, referrerPolicy: "no-referrer", cache: "no-store" });
      if (!mres.ok) {
        if (mres.status === 401 || mres.status === 403) scans.sig = null;
        scans.error = verifierApiMessage(mres.status);
        scans.statusText = "";
        scans.loading = false;
        return paintScans();
      }
      const manifest = await mres.json();
      const storeImages = Array.isArray(manifest.images) ? manifest.images : [];
      const built = buildScanList({ ledgerEntries: scans.entries, storeImages, questions: scans.questions, expiredOmitted: manifest.expiredOmitted ?? 0 });
      scans.setCompare = built.setCompare;
      scans.expiredOmitted = built.expiredOmitted;
      scans.items = built.items;
      scans.summary = summarizeScans(built.items, { expiredOmitted: built.expiredOmitted, setCompare: built.setCompare });
      paintScans();
      const result = await verifyAllScans({
        items: built.items,
        concurrency: 4,
        fetchImage: async (hash) => {
          if (Date.now() / 1000 - auth.ts > 270) throw new Error("The sign-in note expired. Please load the pictures again.");
          const r = await fetchImageApi(`${base}/${hash}${q}`, { headers, referrerPolicy: "no-referrer", cache: "no-store" });
          if (!r.ok) return { ok: false, status: r.status };
          return { ok: true, status: 200, bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") || "" };
        },
        hashBytes: (bytes) => sha256Hex(bytes),
        onProgress: ({ done, total, items }) => {
          scans.items = items;
          scans.progress = { done, total };
          scans.statusText = `Checked ${done} of ${total} pictures…`;
          paintScans();
        },
      });
      scans.items = result.items;
      scans.blobs = result.blobs;
      scans.urls = urlsForBlobs(result.blobs, scans.urls);
      scans.summary = summarizeScans(result.items, { expiredOmitted: scans.expiredOmitted, setCompare: scans.setCompare });
      scans.statusText = scans.summary.headline + ".";
      scans.loading = false;
      scans.progress = null;
      paintScans();
    } catch (e) {
      scans.error = explainError(e);
      scans.statusText = "";
      scans.loading = false;
      scans.progress = null;
      paintScans();
    }
  }

  function downloadAdminScans() {
    if (!scans.blobs.size) return toast("Load the pictures first.");
    const zip = packScanArchive({
      electionCode: code,
      items: scans.items,
      blobs: scans.blobs,
      summary: scans.summary,
      generatedAt: new Date().toISOString(),
      date: new Date(),
    });
    downloadBlob(scanZipName(code), zip, "application/zip");
  }

  // ------------------------------------------------ publish tally
  function tallyParts(isOrganizer, acts) {
    const parts = [h("h2", { id: "a-tally" }, icon("chart", { size: 22 }), "Publish the official tally")];
    if (el.status < 3) return [...parts, h("p", { class: "muted" }, "Available once voting is closed.")];
    if (el.status === 4 && !acts.canAmend && !state.address) parts.push(callout("info", "Tally already published", "Anyone can compare it with the ledger from the Verifier screen.", "check"));
    const fileIn = h("input", { type: "file", id: "a-full", accept: "application/json,.json" });
    const regIn = h("input", { id: "a-reg", inputmode: "numeric", value: String(el.registeredVoters), "aria-label": "Registered voters at close" });
    const issIn = h("input", { id: "a-iss", inputmode: "numeric", placeholder: "Ballots handed out", "aria-label": "Ballots handed out" });
    const unIn = h("input", { id: "a-unu", inputmode: "numeric", placeholder: "Returned unused", "aria-label": "Ballots returned unused" });
    const cidIn = h("input", { id: "a-cid", placeholder: "Optional: where the full results are published (ipfs://…)", autocomplete: "off", "aria-label": "Published results link" });
    const out = h("div", { role: "status" });
    const postBtn = h("button", { class: "btn btn-primary", type: "button", disabled: true }, el.status === 4 ? "Post amended tally" : "Post tally");
    let prepared = null;
    const prepBtn = h("button", { class: "btn", type: "button" }, "Check the numbers");
    prepBtn.addEventListener("click", () =>
      busy(prepBtn, "Working…", async () => {
        prepared = null;
        postBtn.disabled = true;
        try {
          const f = fileIn.files?.[0];
          if (!f) throw new Error("Load the full election file first. It has the secret ballot codes the tally fingerprint is built from.");
          const full = JSON.parse(await f.text());
          const fullFile = full.file ?? full;
          if (fullFile.electionCode !== code) throw new Error(`This file is for ${fullFile.electionCode ?? "another election"}, not ${code}.`);
          if (!Array.isArray(fullFile.ballotCodes)) throw new Error("This file has no ballot codes. Use the full file you saved when you created the election.");
          const fileHash = "0x" + (await sha256Hex(utf8(canonicalize(fullFile))));
          if (fileHash !== el.version.fileSha256.toLowerCase()) throw new Error("This file isn't the one the election was registered with (the fingerprint differs).");
          const registered = parseCount(regIn.value), issued = parseCount(issIn.value), unused = parseCount(unIn.value);
          if (registered == null || issued == null || unused == null) throw new Error("Fill in registered voters, ballots handed out and ballots returned unused as whole numbers.");
          const history = await loadLedgerHistory(el);
          const questions = fullFile.questions;
          const results = applyCorrections(history.records, history.corrections);
          const counts = tallyFromResults(Object.values(results), questions);
          const perQ = counts.map((c) => ({ valid: c.valid, blank: c.blank, overvote: c.overvote, unclear: c.unclear }));
          const ethers = await getEthers();
          const keccak = (b) => ethers.keccak256(b);
          const records = Object.entries(history.details).map(([ballotKey, d]) => ({ ballotKey, results: results[ballotKey], imageSha256: d.imageSha256, recordSha256: d.recordSha256, reviewed: d.reviewed }));
          const m = ledgerMerkle({ electionCode: code, records, codes: allBallotCodes(fullFile), questions, keccak });
          if (m.unknown) throw new Error(`${m.unknown} recorded ballot${m.unknown === 1 ? "" : "s"} aren't in this file's code list.`);
          const rec = reconcile({ registered, issued, unusedReturned: unused }, { registeredInElectionFile: el.registeredVoters, printed: el.ballotCount, cast: el.recordCount, spoiled: el.spoiledCount, perQuestion: perQ });
          const resultsDoc = { electionCode: code, merkleRoot: m.root, perQuestion: perQ, counts: rec.counts, failedChecks: rec.failedChecks, postedFrom: "web-admin" };
          const resultsSha = "0x" + (await sha256Hex(utf8(canonicalize(resultsDoc))));
          const cid = cidIn.value.trim() || `local-unpublished:${resultsSha.slice(2, 14)}`;
          prepared = { m, perQ, registered, issued, unused, rec, resultsDoc, resultsSha, cid };
          postBtn.disabled = !(isOrganizer && (el.status === 3 || el.status === 4));
          fill(out, 
            rec.failedChecks === 0 ? callout("ok", "Every reconciliation rule passes", `The tally will be final once posted. ${m.leaves} ballots, Merkle root ${shortHash(m.root, 10, 8)}.`, "check") : callout("warn", "Some reconciliation rules fail", `Rules failing: ${rulesFromMask(rec.failedChecks).filter((r) => !r.passed).map((r) => r.id).join(", ")}. The tally can still be posted, but it will be marked for review by a reviewer before it is final. Check your paper counts first.`, "alert"),
            dataTable([{ key: "q", label: "Question" }, { key: "v", label: "Valid", num: true }, { key: "b", label: "Blank", num: true }, { key: "o", label: "Overvote", num: true }, { key: "u", label: "Unclear", num: true }], perQ.map((p, i) => ({ q: `${i + 1}. ${questions[i].text}`, v: p.valid, b: p.blank, o: p.overvote, u: p.unclear })), { caption: "Totals to post" }),
            h("div", { class: "actions" }, h("button", { class: "btn btn-sm", type: "button", onClick: () => downloadBlob(`${code}-results.json`, JSON.stringify(resultsDoc, null, 2), "application/json") }, "Download the results file")),
            !isOrganizer ? h("p", { class: "hint" }, "Only the organizer's crypto-wallet can post it.") : null,
          );
        } catch (e) {
          fill(out, callout("warn", "Can't prepare the tally yet", String(e?.message ?? e)));
        }
      }),
    );
    postBtn.addEventListener("click", () =>
      busy(postBtn, "Working…", async () => {
        if (!prepared) return;
        const p = prepared;
        done(
          await sendTx({
            contract: "tally",
            method: el.status === 4 ? "postAmendedTally" : "postTally",
            args: [el.key, p.m.root, p.perQ, p.registered, p.issued, p.unused, p.cid, p.resultsSha],
            title: el.status === 4 ? "Post an amended tally" : "Post the official tally",
            lines: ["The totals and the count reconciliation go on the public ledger for anyone to check. " + (el.status === 4 ? "This adds a new version; earlier versions stay visible." : "The election moves to 'Results published'.")],
            facts: [["Election", code], ["Ballots counted", String(el.recordCount)], ["Handed out / unused", `${p.issued} / ${p.unused}`], ["Reconciliation", p.rec.failedChecks === 0 ? "all rules pass" : `fails ${rulesFromMask(p.rec.failedChecks).filter((r) => !r.passed).map((r) => r.id).join(", ")}`], ["Merkle root", p.m.root]],
            confirmText: "Post tally",
          }),
          "Tally posted.",
        );
      }),
    );
    parts.push(
      el.status === 4
        ? h("p", null, "A tally is already on the ledger. If a mistake was found, the organizer can post an amended version. The original stays visible.")
        : h("p", null, "Posting adds the totals to the ledger together with the count reconciliation (the rules R1 to R6). This page recounts the ledger for you, so the numbers can't be mistyped; you only add the paper counts."),
      h("div", { class: "field" }, labelWithHelp("a-full", "Full election file (JSON)", "admin.fullFile"), fileIn, h("p", { class: "hint" }, "The file you saved when you created the election. It is read in your browser only.")),
      headingWithHelp("h3", null, "Paper counts", "admin.paperCounts"),
      h("div", { class: "row" }, h("div", { class: "field" }, h("label", { for: "a-reg" }, "Registered at close"), regIn), h("div", { class: "field" }, h("label", { for: "a-iss" }, "Handed out"), issIn), h("div", { class: "field" }, h("label", { for: "a-unu" }, "Returned unused"), unIn)),
      h("div", { class: "row" }, cidIn),
      h("div", { class: "actions" }, prepBtn, postBtn),
      out,
    );
    return parts;
  }

  // ------------------------------------------------ images retired
  function retireParts(isOrganizer, deadline, retention) {
    const noteIn = h("input", { id: "a-note", placeholder: "Optional: link to the retirement note", autocomplete: "off", "aria-label": "Retirement note link" });
    const may = isOrganizer && (el.status === 3 || el.status === 4);
    const btn = h("button", { class: "btn", type: "button", disabled: !may }, "Publish the notice");
    btn.addEventListener("click", () =>
      busy(btn, "Working…", async () => {
        const note = noteIn.value.trim() || `local-unpublished:images-retired-${code}`;
        done(await sendTx({ contract: "registry", method: "noticeImagesRetired", args: [el.key, note], title: "Publish a notice that images were retired", lines: ["This adds a public notice that the stored ballot images were deleted or archived under the retention rule. It changes nothing else; it is not what deletes the images."], facts: [["Election", code], ["Retention", retention ? `${retention.days} days` : "not set"], ["Note", note]], confirmText: "Publish notice" }), "Notice published.");
      }),
    );
    return [
      headingWithHelp("h2", { id: "a-retire" }, [icon("image", { size: 22 }), "Ballot image retention"], "admin.retire"),
      h("p", null, retention ? `Ballot images are kept ${retention.days} days after closing${deadline ? `, until ${fmtDate(deadline)}` : ""}. The image store removes them automatically after that. Once it has, publish a notice here so the public record says so.` : "The retention period isn't in the public copy of the election file. It is fixed when the election is created."),
      el.status < 3 ? h("p", { class: "muted" }, "Available once voting is closed.") : h("div", null, h("div", { class: "row" }, noteIn), h("div", { class: "actions" }, btn), !may ? h("p", { class: "hint" }, "Only the organizer's crypto-wallet can publish this.") : null),
    ];
  }

  // repaint only when the connected wallet really changes, so typed values survive other wallet updates
  let seen = null;
  liveWallet(ctx, () => {
    const sig = `${state.address ?? ""}|${state.status}`;
    if (sig === seen) return;
    seen = sig;
    paint();
  });
  const roster = rosterCard({
    electionCode: code,
    organizerAddress: el.organizer,
    storage: localStorage,
    canEdit: () => sameAddress(state.address, el.organizer),
    connectedAddress: () => state.address,
    chain: () => staffChain,
    staffContract: contractAddress("staff"),
    electionId: el.key,
    onRecordChain: (rosterNow) => recordApproved(rosterNow, el, code),
    onSaved: () => { if (ctx.current()) paint(); },
    watch: (fn) => {
      const off = subscribe(() => {
        if (!ctx.current()) return off();
        fn();
      });
    },
  });
  const recorded = h("section", { class: "card recorded-panel", "aria-labelledby": "a-recorded" }, h("h2", { id: "a-recorded" }, "What was recorded, and why it matters"), spinner("Reading what the ledger recorded…"));
  loadRecordedSection(el, file, staff).then((sec) => recorded.replaceWith(sec)).catch(() => fill(recorded, h("h2", { id: "a-recorded" }, "What was recorded, and why it matters"), callout("info", "Couldn't read everything right now", "Try reloading the page. Nothing here changes the election.")));
  ensureScanEntries().then(() => { if (ctx.current()) paintScans(); }).catch(() => {});
  if (staffChain.configured) readStaffRoster(el.key).then((r) => { Object.assign(staffChain, r); if (ctx.current()) paint(); }).catch(() => {});
  return [roster, reviewSlot, overview, recorded, scansSlot, delegatedCard(code), life, tallySlot, notesCard(el), retire];
}

async function recordAdminForNewElection(electionCode, organizer) {
  if (!contractAddress("staff")) return;
  const kindName = electionKindOf(loadRoster(localStorage, electionCode, { organizerAddress: organizer }));
  if (KIND_INDEX[kindName] == null) return;
  const ethers = await getEthers();
  const key = ethers.keccak256(ethers.toUtf8Bytes(electionCode));
  const recorded = await sendTx({ contract: "staff", method: "recordElectionAdmin", args: [key, KIND_INDEX[kindName]], title: "Record the Election Administrator", lines: [`This election is ${kindLabel(kindName)}. That choice cannot be changed.`], facts: [["Election", electionCode], ["Type", kindLabel(kindName)]], confirmText: "Record administrator" });
  if (recorded.status === "failed") toast(recorded.message);
}

async function recordApproved(roster, el, code) {
  if (!contractAddress("staff")) return toast("The roster contract is not on this site yet. Nothing was sent.");
  const ethers = await getEthers();
  const ready = roster.seats.filter((seat) => seat.id !== "admin" && seat.chainClaim && seat.grant?.adultAttested && lineView(seat, { electionCode: code, organizerAddress: el.organizer }).status === "approved");
  if (!ready.length) return toast("Approve each person, including the legal-adult attestation, and have them sign for the chain. Nothing was sent.");
  const proofs = [];
  for (const seat of ready) {
    const pid = positionId(ethers, seat.role, seat.id);
    const claimTd = claimTypedData({ verifyingContract: contractAddress("staff"), electionId: el.key, positionId: pid, wallet: seat.address, nameHash: seat.chainClaim.nameHash, nonce: seat.chainClaim.nonce });
    const claimDigest = ethers.TypedDataEncoder.hash(claimTd.domain, claimTd.types, claimTd.message);
    const approvalTd = approvalTypedData({ verifyingContract: contractAddress("staff"), electionId: el.key, positionId: pid, wallet: seat.address, nameHash: seat.chainClaim.nameHash, claimDigest, nonce: seat.chainClaim.nonce });
    const signed = await signWithCard({ title: `Record ${seat.firstName} ${seat.lastName}`, lines: [ADULT_ATTESTATION, "Signing is free. Recording the crypto-wallet is the step that pays the network fee."], facts: [["Crypto-wallet", seat.address]], confirmText: "Sign", sign: (signer) => signer.signTypedData(approvalTd.domain, approvalTd.types, approvalTd.message) });
    if (signed.status !== "signed") return;
    proofs.push([ROLE_INDEX[seat.role], seatNoOf(seat.id), seat.address, seat.chainClaim.nameHash, seat.chainClaim.nonce, ADULT_ATTESTATION, seat.chainClaim.signature, signed.signature]);
  }
  const method = proofs.length === 1 ? "recordStaff" : "recordStaffBatch";
  const args = proofs.length === 1 ? [el.key, proofs[0]] : [el.key, proofs];
  const r = await sendTx({ contract: "staff", method, args, title: "Record roster on-chain", lines: ["This writes the approved crypto-wallets and positions. Names stay off the chain."], facts: [["Election", code], ["Lines", String(proofs.length)]], confirmText: "Record roster" });
  if (r.status === "failed") toast(r.message);
  if (r.status === "sent") { toast("Roster recorded on the chain."); reloadPage(); }
}

async function lockThenOpen(payload, el, code, grace) {
  const locked = await sendTx({
    contract: "staff",
    method: "lockRoster",
    args: [el.key, payload.rosterHash, payload.attestation, payload.attestationSig, payload.testStatement || "", payload.testSig || "0x"],
    title: "Lock the staff roster",
    lines: ["This stores the roster fingerprint and your signed review. Names stay off the chain. Name salts stay in the confidential staff record.", payload.kind === "classroom" ? "This is a classroom election run by one administrator. It cannot be certified. A System admin sign-off is optional and is disclosed if it is signed." : payload.kind === "test" ? "This is a test election. It cannot be certified. A System admin sign-off is optional and is disclosed if it is signed." : "A standard election needs two Election officers handling the paper ballots, every other position filled, and the System admin's close-out sign-off before it can be certified."],
    facts: [["Election", code], ["Type", payload.label || ""]],
    confirmText: "Lock the roster",
  });
  if (locked.status !== "sent") {
    if (locked.status === "failed") toast(locked.message);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const actsNow = electionActions({ status: el.status, now, opensAt: el.opensAt, closesAt: el.closesAt, deviceCount: el.deviceCount, quorum: el.quorum, isOrganizer: true, closeGrace: grace });
  if (!actsNow.canOpen) {
    toast("The roster is locked. Voting is not open yet.");
    reloadPage();
    return;
  }
  const opened = await sendTx({ contract: "registry", method: "openElection", args: [el.key], title: "Open voting", lines: ["The roster fingerprint is locked. Scanners can record ballots from now on."], facts: [["Election", code]], confirmText: "Open voting" });
  if (opened.status === "failed") toast(opened.message);
  if (opened.status === "sent") { toast("Voting is open."); reloadPage(); }
}

// ------------------------------------------------------------------ Register Scanner/Printer (registerDevice)
/** Values recorded for an election on the ledger, read in the background for the admin page. */
async function loadRecordedSection(el, file, staff) {
  const tally = el.resultCount > 0 ? await getTally(el, file?.questions?.length ?? 0).catch(() => null) : null;
  const rec = el.record ? await loadElectionRecord(el).catch(() => null) : null;
  const items = recordedItems({ stage: "created", fileSha256: el.version.fileSha256, ballotListRoot: el.ballotListRoot, layoutHash: file?.layoutHash ?? null, approvedAppHashes: file?.approvedAppHashes ?? [], devices: staff.devices, quorum: el.quorum, merkleRoot: tally?.merkleRoot, resultsSha256: tally?.resultsSha256, recordSha256: rec?.manifestSha256 });
  return recordedSection(items, { stage: "created", file, deps: checkDeps(), id: "a-recorded", openWhy: true });
}

/**
 * The organizer approves one Local Scanner/Printer station for this election (ElectionRegistry.registerDevice, Setup only).
 * Station wallet: one the site knows (CONFIG.scannerStations) or a pasted address. Scanner build: chosen automatically
 * from the election's approved list, changeable under "Advanced".
 */
export function stationRegistration({ el, file, can, isOrganizer, done }) {
  const known = (CONFIG.scannerStations ?? []).filter((s) => isAddress(s.address));
  const approved = (file?.approvedAppHashes ?? []).map((x) => normHash(x)).filter(Boolean);
  const out = h("div", { role: "status", class: "station-out" });
  const pasteIn = h("input", { id: "a-dev", placeholder: "Station wallet address 0x…", autocomplete: "off", spellcheck: "false", class: "plain-mono", "aria-label": "Scanner/Printer station wallet address" });
  const PASTE = "__paste";
  const stationSel = known.length ? h("select", { id: "a-dev-pick", "aria-label": "Scanner/Printer station wallet" }, known.map((s) => h("option", { value: s.address }, `${s.label} (${shortAddress(s.address)})`)), h("option", { value: PASTE }, "Paste a different wallet address…")) : null;
  const pasteRow = h("div", { class: "field", hidden: stationSel ? true : null }, h("label", { for: "a-dev" }, "Station wallet address"), pasteIn);
  stationSel?.addEventListener("change", () => (pasteRow.hidden = stationSel.value !== PASTE));
  const address = () => (stationSel && stationSel.value !== PASTE ? stationSel.value : pasteIn.value.trim());

  const autoBuild = approved[0] ?? null;
  const b0 = autoBuild ? findBuild(autoBuild) : null;
  const appSel = approved.length > 1 ? h("select", { id: "a-app", "aria-label": "Scanner build fingerprint" }, approved.map((x) => h("option", { value: x }, `${findBuild(x)?.label ?? "Unlisted build"} (${shortHash("0x" + x, 8, 6)})`))) : null;
  const appPaste = h("input", { id: "a-app-paste", placeholder: "Or paste a fingerprint (64 hex, 0x optional)", autocomplete: "off", class: "plain-mono", "aria-label": "Scanner build fingerprint (paste)" });
  const app = () => normalizeAppFingerprint(appPaste.value) ?? (appPaste.value.trim() ? appPaste.value.trim() : appSel ? appSel.value : autoBuild);
  const a = helpToggle("admin.appFingerprint", { label: "scanner build fingerprint" });

  const btn = h("button", { class: "btn btn-primary", type: "button", disabled: true }, icon("shield", { size: 18 }), "Register Scanner/Printer");
  let confirmed = null;
  let testStatus = null;
  const advisory = h("div", { class: "register-advisory" });
  const syncRegister = () => {
    btn.disabled = !registerEnabled({ can, confirmed });
    const text = testPrintScanAdvisory({ confirmed, testStatus });
    fill(advisory, text ? callout("info", "Optional checks", text) : null);
  };
  const devicesFromConfirm = () => ({
    printerName: confirmed?.printerName || "",
    scannerDeviceId: confirmed?.scannerDeviceId || readScannerChoice(typeof localStorage !== "undefined" ? localStorage : null)?.deviceId || "",
  });
  const test = testPrintScanCard({
    getDevices: devicesFromConfirm,
    onChange: (s) => {
      testStatus = s;
      syncRegister();
    },
  });
  testStatus = test.getStatus();
  const find = helperConnectCard({
    onChange: (c) => {
      confirmed = c;
      if (c?.stationWallet?.address) {
        const addr = c.stationWallet.address;
        const match = known.find((s) => s.address.toLowerCase() === addr.toLowerCase());
        if (stationSel && match) {
          stationSel.value = match.address;
          pasteRow.hidden = true;
        } else {
          if (stationSel) {
            stationSel.value = PASTE;
            pasteRow.hidden = false;
          }
          pasteIn.value = addr;
        }
      }
      syncRegister();
    },
  });
  syncRegister();
  btn.addEventListener("click", () =>
    busy(btn, "Working…", async () => {
      if (!registerEnabled({ can, confirmed })) return fill(out, callout("warn", "Not ready to register", "Only the organizer can register a station, and only during Setup."));
      const plan = registerStationPlan({ address: address(), appHash: app(), approved, status: el.status, isOrganizer, electionCode: el.code });
      if (!plan.ok) return fill(out, callout("warn", "Not sent: a few things need fixing", plan.problems.join(" ")));
      const r = await sendTx({ contract: "registry", method: "registerDevice", args: [el.key, plan.address, plan.appHash], title: plan.title, lines: plan.lines, facts: plan.facts, confirmText: "Register Scanner/Printer" });
      if (r.status === "sent") fill(out, callout("ok", "Scanner/Printer registered", `${shortAddress(plan.address)} can now record ballots for ${el.code}. The page will refresh to show it in the list.`, "check"));
      else if (r.status === "failed") fill(out, callout("warn", "Registration failed", `${r.message} Nothing was changed on the ledger.`));
      else fill(out, callout("info", "Cancelled", "Nothing was sent."));
      done(r, "Scanner/Printer registered.");
    }),
  );
  return h(
    "div",
    { class: "station-card" },
    h("h4", null, "Register Scanner/Printer"),
    h("p", { class: "small" }, "Approve the station that will scan this election's ballots. Its signing crypto-wallet is what the ledger trusts; in a classroom this is one scanner/printer run through one signing crypto-wallet. ", h("strong", null, "Only during Setup, before voting opens."), " It costs a small network fee and moves no money."),
    headingWithHelp("h3", { class: "find-heading" }, "Connect printer & scanner", "admin.findScanner"),
    find.root,
    systemCheckCard().root,
    headingWithHelp("h3", { class: "find-heading" }, "Test print and scan", "admin.testPrintScan"),
    test.root,
    advisory,
    stationSel ? h("div", { class: "field" }, h("label", { for: "a-dev-pick" }, "Station wallet"), stationSel) : null,
    pasteRow,
    h("div", { class: "field" }, h("div", { class: "label-row" }, h("span", { class: "label" }, "Scanner build (chosen for you from this election's approved list)"), a.button), a.panel, autoBuild ? h("p", null, valueWithCopy("0x" + autoBuild, { label: "scanner build fingerprint" }), " ", b0 ? badge(b0.label, b0.kind === "agreed-label" ? "info" : "ok") : badge("Unlisted build", "warn")) : h("p", { class: "muted small" }, "This election's public copy doesn't list its approved builds here, so paste the fingerprint under Advanced.")),
    h("details", { class: "advanced", open: autoBuild ? null : true }, h("summary", null, "Advanced: use a different scanner build"), appSel ? h("div", { class: "field" }, h("label", { for: "a-app" }, "Approved build"), appSel) : null, h("div", { class: "field" }, h("label", { for: "a-app-paste" }, "Paste a fingerprint"), appPaste), h("p", { class: "hint" }, "Only builds this election approved are accepted by the check before sending.")),
    h("div", { class: "actions" }, btn),
    out,
  );
}

// ------------------------------------------------------------------ create an election
/** Printable ballots for a prepared file: the PDF (secret codes, keep private) and the layout the mark reader needs. */
function printParts(file, designed) {
  const status = h("div", { role: "status" });
  const matches = designed && designed.layoutHash === file.layoutHash;
  const pdfBtn = h("button", { class: "btn", type: "button", disabled: !matches }, icon("ticket", { size: 16 }), `Download printable ballots (${file.ballotCodes.length} pages, PDF)`);
  pdfBtn.addEventListener("click", () =>
    busy(pdfBtn, "Drawing the ballots…", async () => {
      try {
        const r = await ballotPdf(file);
        downloadBlob(`${file.electionCode}-ballots.pdf`, r.pdf, "application/pdf");
        fill(status, callout("ok", "Ballots ready to print", `${r.pages} pages, one ballot each, in a random order. When the helper prints, Windows built-in printing sends the job straight to the printer at actual size, single-sided. Keep this PDF private: it holds the ballot codes.`, "check"));
      } catch (e) {
        fill(status, callout("warn", "Couldn't make the PDF", String(e?.message ?? e)));
      }
    }),
  );
  const previewBtn = h("button", { class: "btn", type: "button", disabled: !matches }, "Preview");
  previewBtn.addEventListener("click", () =>
    busy(previewBtn, "Drawing the ballots…", async () => {
      try {
        const r = await ballotPdf(file);
        const opened = openPdfBytesInNewTab(r.pdf);
        fill(status, callout("info", "Preview", opened ? `${PREVIEW_NOTE} Keep this PDF private: it holds the ballot codes.` : "The browser blocked the preview tab. Allow pop-ups for this site, then press Preview again. Nothing was sent to the printer."));
      } catch (e) {
        fill(status, callout("warn", "Couldn't make the PDF", String(e?.message ?? e)));
      }
    }),
  );
  const layoutBtn = h("button", { class: "btn", type: "button", disabled: !matches, onClick: () => downloadBlob(`${file.electionCode}-ballot-layout.json`, JSON.stringify(designed.layout, null, 2), "application/json") }, "Download the ballot layout (for the scanner)");
  return h(
    "div",
    { class: "stack" },
    headingWithHelp("h3", null, "Print the ballots", "create.print"),
    matches
      ? h("p", { class: "muted small" }, "Made on this computer with the same ballot design the scanner reads. The layout file is not secret; the scanner's mark reader needs it.")
      : callout("info", "No printable PDF from this page", "The layout fingerprint isn't the one this page designs from your questions (one was typed under Advanced, or the questions changed). Print with the tool that made that layout, or clear the Advanced box and prepare again."),
    h("div", { class: "actions" }, pdfBtn, previewBtn, layoutBtn),
    status,
  );
}

const val0 = (f) => f.querySelector("input,textarea").value;

export function createCard(ctx) {
  const open = ctx.query.get("new") === "1";
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  const year = new Date().getFullYear();
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const start = new Date(Math.ceil((Date.now() + 3600e3) / 3600e3) * 3600e3);
  const codeIn = field({ id: "c-code", help: "create.code", label: "Election code", value: newElectionCode(year, randomBytes), mono: true, hint: "Made for you. It is what people type to find the election." });
  const nameIn = field({ id: "c-name", help: "create.name", label: "Election name", placeholder: "e.g. Riverside Library Board 2026" });
  const opens = field({ id: "c-open", help: "create.opens", label: "Voting opens", type: "datetime-local", value: local(start), hint: "In your own time zone." });
  const closes = field({ id: "c-close", help: "create.closes", label: "Voting closes", type: "datetime-local", value: local(new Date(start.getTime() + 10 * 3600e3)) });
  const reg = field({ id: "c-reg", help: "create.registered", label: "Registered voters", type: "number", value: "100", min: 0, hint: "0 if there is no voter list." });
  // Spare ballots are decided in the ballot design step (shown after "Design the ballot"), 0% unless changed there.
  const spare = field({ id: "c-spare", help: "create.spare", label: "Extra ballots to print (%)", type: "number", value: String(DEFAULT_SPARE_PERCENT), min: 0, max: 200, hint: "Spares for mistakes, 0 if you print exactly one per voter. Printed = registered + this, rounded up." });
  const quorum = field({ id: "c-quorum", help: "create.quorum", label: "Local Scanner/Printer", type: "number", value: "1", min: 1, max: 4, hint: "How many scanner/printer stations must be registered before voting opens. A classroom uses 1." });
  const days = field({ id: "c-days", help: "create.days", label: "Keep ballot images for (days)", type: "number", value: String(DEFAULT_IMAGE_RETENTION_DAYS), min: 1, max: IMAGE_RETENTION_MAX_DAYS, hint: `1 to ${IMAGE_RETENTION_MAX_DAYS}. They are removed automatically afterwards.` });
  const publicCb = h("input", { id: "c-public-images", type: "checkbox" });
  const publicRow = h("div", { class: "field check-row" }, publicCb, labelWithHelp("c-public-images", "Public ballot images", "create.publicImages"));
  const daysInput = days.querySelector("input");
  const daysHint = days.querySelector(".hint");
  const syncRetentionField = () => {
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
  publicCb.addEventListener("change", syncRetentionField);
  const layout = field({ id: "c-layout", help: "create.layout", label: "Ballot layout fingerprint made elsewhere (optional)", mono: true, placeholder: "leave empty to use the one the designer makes", hint: "Only if the ballots were designed with another tool. 64 hex characters; 0x at the start is fine." });
  const apps = field({ id: "c-apps", help: "create.apps", label: "Other scanner build fingerprints (optional)", rows: 2, mono: true, placeholder: "one per line, 64 hex characters each", hint: "Added to the builds ticked above. 0x at the start is optional." });
  // Scanner build: the site's approved default goes in automatically; "Advanced" lets the organizer pick or paste others.
  const defaults = defaultBuilds();
  const appsUse = h("input", { id: "c-apps-use", type: "checkbox" });
  const buildChecks = SCANNER_BUILDS.map((b, i) => {
    const cb = h("input", { id: `c-build-${i}`, type: "checkbox", value: b.sha256, checked: b.default ? true : null });
    return { cb, row: h("div", { class: "field check-row" }, cb, h("label", { for: `c-build-${i}` }, b.label, " ", h("code", { class: "code small", title: b.sha256 }, shortHash("0x" + b.sha256, 8, 6)), h("span", { class: "muted small" }, ` · ${b.kind === "agreed-label" ? "agreed test label" : "SHA-256 of " + (b.file ?? "a file")}`))) };
  });
  const appsBox = h("div", { class: "stack", hidden: true }, buildChecks.map((x) => x.row), apps);
  appsUse.addEventListener("change", () => (appsBox.hidden = !appsUse.checked));
  const scannerBlock = h(
    "div",
    { class: "stack auto-block" },
    headingWithHelp("h3", null, "Scanner build", "create.scannerBuild"),
    defaults.length
      ? h("p", null, "Filled in for you: ", h("strong", null, defaults.map((b) => b.label).join(", ")), " ", valueWithCopy("0x" + defaults[0].sha256, { label: "scanner build fingerprint" }))
      : callout("warn", "No approved scanner build is set up on this site", "Choose one under Advanced below."),
    h("details", { class: "advanced", open: defaults.length ? null : true }, h("summary", null, "Advanced: use a different scanner build"), h("div", { class: "field check-row" }, appsUse, h("label", { for: "c-apps-use" }, "Use a different scanner build for this election")), appsBox),
  );
  const cidIn = field({ id: "c-cid", help: "create.cid", label: "Where the election file is published (optional)", mono: true, placeholder: "ipfs://… leave empty to keep the file private", hint: "If empty, the file stays with you and the ledger notes it as unpublished." });

  const qList = h("div", { class: "stack" });
  let qCount = 0;
  const addQuestion = (text = "", choices = "", max = 1) => {
    const n = ++qCount;
    const row = h(
      "fieldset",
      { class: "q-row" },
      h("legend", null, `Question ${n}`),
      h("div", { class: "field" }, labelWithHelp(`c-q${n}`, "Question", "create.questions"), h("input", { id: `c-q${n}`, "data-q": "text", value: text, autocomplete: "off", placeholder: "e.g. Who should be chair?" })),
      h("div", { class: "field" }, h("label", { for: `c-c${n}` }, "Choices (one per line)"), h("textarea", { id: `c-c${n}`, "data-q": "choices", rows: 3, placeholder: "Alex Kim\nSam Ortiz" }, choices)),
      h("div", { class: "field" }, labelWithHelp(`c-m${n}`, "Choices a voter may mark", "create.maxMarks"), h("input", { id: `c-m${n}`, "data-q": "max", type: "number", min: 1, value: String(max) })),
      h("button", { class: "btn btn-sm", type: "button", onClick: () => (row.remove(), renumber()) }, "Remove this question"),
    );
    qList.append(row);
  };
  const renumber = () => [...qList.children].forEach((r, i) => (r.querySelector("legend").textContent = `Question ${i + 1}`));
  addQuestion();

  const out = h("div", { role: "status" });
  const prepBtn = h("button", { class: "btn btn-primary", type: "button" }, "Prepare the election");
  const readForm = () => {
    const val = (f) => f.querySelector("input,textarea").value;
    const questions = [...qList.children].map((r) => ({ text: r.querySelector('[data-q="text"]').value, choices: r.querySelector('[data-q="choices"]').value.split("\n").map((s) => s.trim()).filter(Boolean), maxMarks: Number(r.querySelector('[data-q="max"]').value) }));
    const registered = Number(val(reg));
    const printed = printedBallots(registered, val(spare));
    const opensIso = Number.isNaN(Date.parse(val(opens))) ? "" : new Date(val(opens)).toISOString();
    const closesIso = Number.isNaN(Date.parse(val(closes))) ? "" : new Date(val(closes)).toISOString();
    return { name: val(nameIn), electionCode: val(codeIn).trim().toUpperCase(), opensAt: opensIso, closesAt: closesIso, registeredVoters: registered, printed: Math.max(printed, 1), quorum: Number(val(quorum)), retentionDays: Number(val(days)), publicBallotImages: publicCb.checked, layoutHash: null, approvedAppHashes: [], cid: val(cidIn).trim(), questions };
  };
  // Ballot designer: the layout fingerprint comes from the code, name and questions typed above.
  const designOut = h("div", { role: "status" });
  const layoutInput = layout.querySelector("input");
  const designFromForm = async () => {
    const v = readForm();
    const draft = draftElectionFile({ ...v, organizer: null, ballotCodes: [] });
    if (!draft.name || draft.questions.some((q) => !q.text || !q.choices.length)) throw new Error("Give the election a name, and every question its text and at least one choice.");
    return designLayout(draft);
  };
  const spareInput = spare.querySelector("input");
  const printedLine = h("p", { class: "small", role: "status" });
  const showPrinted = () => {
    const r = Number(val0(reg));
    printedLine.replaceChildren(h("strong", null, `${printedBallots(r, spareInput.value)} ballots will be printed`), ` (${Number.isFinite(r) ? r : 0} registered + ${spareInput.value || 0}% spares, rounded up).`);
  };
  spareInput.addEventListener("input", showPrinted);
  reg.querySelector("input").addEventListener("input", showPrinted);
  const designBtn = h("button", { class: "btn", type: "button" }, icon("ticket", { size: 16 }), "Design the ballot");
  designBtn.addEventListener("click", () =>
    busy(designBtn, "Designing…", async () => {
      try {
        const d = await designFromForm();
        showPrinted();
        fill(designOut,
          callout("ok", "Ballot designed", `${d.layout.questions.length} question${d.layout.questions.length === 1 ? " fits" : "s fit"} on one Letter page. Its layout fingerprint is filled in for you; you don't need to copy it. If you change the name, code or questions, it is designed again automatically when you prepare the election.`, "check"),
          h("p", null, "Ballot layout fingerprint: ", valueWithCopy("0x" + d.layoutHash, { label: "ballot layout fingerprint" }), " ", badge("filled in automatically", "ok", "check")),
          h("div", { class: "spare-step" }, spare, printedLine),
        );
      } catch (e) {
        fill(designOut, callout("warn", "Can't design the ballot yet", String(e?.message ?? e)));
      }
    }),
  );
  prepBtn.addEventListener("click", () =>
    busy(prepBtn, "Working…", async () => {
      fill(out, );
      if (!state.address) return fill(out, callout("warn", "Connect your wallet first", "The election is created from your crypto-wallet, and you become its organizer.", "wallet"));
      const v = readForm();
      let designed = null;
      try {
        designed = await designFromForm();
      } catch {
        designed = null; // the checks below explain what is missing
      }
      // Both fingerprints are chosen automatically (designer + the site's approved build); Advanced overrides them.
      const fp = resolveCreateFingerprints({ designedLayoutHash: designed?.layoutHash, layoutOverride: layoutInput.value, useAppsOverride: appsUse.checked, appsSelected: buildChecks.filter((x) => x.cb.checked).map((x) => x.cb.value), appsPasted: apps.querySelector("textarea").value });
      if (fp.problems.length) return fill(out, callout("warn", "A few things need fixing", "Nothing was created. Fix these and press Prepare again."), h("ul", { class: "plain-list" }, fp.problems.map((p) => h("li", null, h("strong", null, `${FIELD_LABEL[p.field] ?? p.field}: `), p.message))));
      v.layoutHash = fp.layoutHash;
      v.approvedAppHashes = fp.approvedAppHashes;
      let file;
      try {
        file = draftElectionFile({ ...v, organizer: state.address, ballotCodes: newBallotCodes(v.printed, randomBytes) });
      } catch (e) {
        return fill(out, callout("warn", "Check the questions", String(e?.message ?? e)));
      }
      const problems = validateElectionFile(file);
      if (problems.length) return fill(out, callout("warn", "A few things need fixing", "Fix these and try again."), h("ul", { class: "plain-list" }, problems.map((p) => h("li", null, h("strong", null, `${p.field}: `), p.message))));
      const ethers = await getEthers();
      const keccak = (b) => ethers.keccak256(b);
      const fileSha256 = "0x" + (await sha256Hex(utf8(canonicalize(file))));
      const ballotListRoot = merkleRoot(file.ballotCodes.map((c) => keccak(utf8(c))), keccak);
      const cid = v.cid || `local-unpublished:${file.electionCode}`;
      const poolEnforced = await registrySupportsBallotPool();
      const call = createElectionCall(file, { cid, fileSha256, ballotListRoot }, poolEnforced);
      const pub = { publicCopy: true, note: "Public copy of the election file for display. The private list of ballot codes was removed, so its fingerprint will not match the on-chain one.", omitted: ["ballotCodes"], omittedCount: file.ballotCodes.length, electionCode: file.electionCode, electionFileSha256: fileSha256, file: publicElectionCopy(file) };
      try {
        const prepared = adoptPendingRegistration(loadRoster(localStorage, file.electionCode, { organizerAddress: state.address }), localStorage);
        const adminSeat = prepared.seats.find((s) => s.id === "admin");
        if (registrationIsCurrent(adminSeat, prepared.electionCode)) saveAdminRegistration(localStorage, prepared);
        else saveRoster(localStorage, prepared);
      } catch {
        /* A bad roster name must not block creating the election. The roster card explains it. */
      }
      delete pub.file.ballotCount;
      const saved = h("input", { id: "c-saved", type: "checkbox" });
      const createBtn = h("button", { class: "btn btn-primary", type: "button", disabled: true }, "Create it on the ledger");
      const syncCreate = () => {
        const kind = electionKindOf(loadRoster(localStorage, file.electionCode, { organizerAddress: state.address }));
        createBtn.disabled = !saved.checked || !kind;
      };
      saved.addEventListener("change", syncCreate);
      createBtn.addEventListener("click", () =>
        busy(createBtn, "Working…", async () => {
          const r = await sendTx({
            contract: "registry",
            method: call.method,
            args: call.args,
            title: "Create the election on the ledger",
            lines: [
              "Your crypto-wallet becomes this election's organizer. The election file's fingerprint and the list of ballot codes' fingerprint are fixed on the ledger. They can't be edited later.",
              poolEnforced
                ? "This election checks the ballot pool. A scanned ballot counts only when its code is on the list in your secret file, or on a list you add before voting opens. The codes themselves are not written on the ledger."
                : "This ledger does not have ballot-pool checks yet, so this election is created the old way. New elections check the pool once the updated contracts are the ones this site uses.",
            ],
            facts: [["Election code", file.electionCode], ["Name", file.name], ["Ballots printed", String(file.ballotCodes.length)], ["Registered voters", String(file.registeredVoters)], ["Opens", file.opensAt], ["Closes", file.closesAt], ["File fingerprint", fileSha256]],
            confirmText: "Create election",
          });
          if (r.status === "failed") toast(r.message);
          if (r.status === "sent") {
            await recordAdminForNewElection(file.electionCode, state.address);
            toast("Election created.");
            location.hash = `#${PATH}?e=${file.electionCode}`;
            reloadPage();
          }
        }),
      );
      const preparedRoster = rosterCard({
        electionCode: file.electionCode,
        organizerAddress: state.address,
        storage: localStorage,
        canEdit: () => sameAddress(state.address, file.organizerPublicKey),
        connectedAddress: () => state.address,
        watch: (fn) => {
          const off = subscribe(() => {
            if (!ctx.current()) return off();
            fn();
          });
        },
        onSaved: syncCreate,
      });
      fill(out, 
        preparedRoster,
        callout("ok", "Ready to create", `${file.ballotCodes.length} ballot codes were generated. Nothing is on the ledger yet.`, "check"),
        kvList([["Election", `${file.name} (${file.electionCode})`], ["Questions", String(file.questions.length)], ["Ballots to print", `${file.ballotCodes.length} (${file.registeredVoters} registered + spares)`], ["Images kept for", file.publicBallotImages ? `Public for ${file.imageRetention.days} days, then removed` : `${file.imageRetention.days} days after closing (not public)`], ["Organizer", shortAddress(state.address)]]),
        recordedSection(recordedItems({ stage: "preview", fileSha256, ballotListRoot, layoutHash: file.layoutHash, approvedAppHashes: file.approvedAppHashes, devices: [], quorum: file.quorum }), { stage: "preview", file, deps: checkDeps(), id: "c-recorded", openWhy: true }),
        headingWithHelp("h3", null, "Your two files", "create.files"),
        callout("warn", "Save the secret file before you continue", "The ballot codes exist only in this file. If you lose it, nobody can print ballots or rebuild the tally fingerprint, and there is no way to get it back. Keep it private; the public copy is safe to share.", "alert"),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => downloadBlob(`${file.electionCode}-SECRET-full-file.json`, JSON.stringify(file, null, 2), "application/json") }, icon("lock", { size: 16 }), "Download the secret full file"), h("button", { class: "btn", type: "button", onClick: () => downloadBlob(`${file.electionCode}.json`, JSON.stringify(withPublicRoster(pub, loadRoster(localStorage, file.electionCode, { organizerAddress: state.address })), null, 2), "application/json") }, "Download the public copy")),
        h("p", { class: "muted small" }, "To show the election's name and questions on the public site, add the public copy to the site's data/elections folder or publish the file and give its link above."),
        printParts(file, designed),
        h("p", { class: "hint" }, "Choose Standard, Test, or Classroom on the roster above. That choice is recorded on the chain and cannot be changed. A standard election also needs two Election officers to handle the paper ballots."),
        walletInfoBox({ variant: "confirm", open: true }),
        h("div", { class: "field check-row" }, saved, h("label", { for: "c-saved" }, "I have saved the secret full file somewhere safe.")),
        h("div", { class: "actions" }, createBtn),
        createReminder(),
      );
    }),
  );
  const details = h(
    "details",
    { class: "card details-card start-here", open: open || null, id: "start-here" },
    h("summary", { "data-start-here": "1" }, h("p", { class: "start-here-kicker" }, "Start here"), h("h2", { class: "inline-h" }, icon("ticket", { size: 22 }), "Create a new election")),
    h("p", null, "Creating a new election will create a new quantified list of unique ballot codes which will become verified, certified and permanent blockchain ledger entries."),
    walletInfoBox({ variant: "full" }),
    h("div", { class: "grid" }, nameIn, codeIn, opens, closes, reg, quorum),
    h("div", { class: "ballot-image-options" }, publicRow,
    days,),
    h("div", { class: "find-station-wrap auto-block" }, headingWithHelp("h3", null, "Connect printer & scanner", "create.findScanner"), helperConnectCard().root, systemCheckCard().root, headingWithHelp("h3", null, "Test print and scan", "create.testPrintScan"), testPrintScanCard().root),
    h("h3", null, "Questions"),
    qList,
    h("div", { class: "actions" }, h("button", { class: "btn btn-sm", type: "button", onClick: () => addQuestion() }, "Add another question")),
    h(
      "div",
      { class: "stack auto-block" },
      headingWithHelp("h3", null, "Ballot design", "create.design"),
      h("p", { class: "muted small" }, "Design the ballot once your questions are in. Its layout fingerprint and the number of ballots to print are set here, so you never type a fingerprint."),
      h("div", { class: "actions" }, designBtn),
      designOut,
      h("details", { class: "advanced" }, h("summary", null, "Advanced: use a layout fingerprint made elsewhere"), layout),
    ),
    scannerBlock,
    cidIn,
    h("div", { class: "actions" }, prepBtn),
    h("p", { class: "muted small" }, "Preparing is free and happens on this computer only. Your wallet is asked only at the final step, \"Create it on the ledger\"."),
    out,
  );
  return details;
}
