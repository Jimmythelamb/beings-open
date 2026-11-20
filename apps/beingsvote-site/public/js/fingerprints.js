// Fingerprints the organizer no longer types: the ballot layout fingerprint comes from the ballot designer, the scanner
// build fingerprint comes from the site's approved list (scanner-builds.js). This module also describes, in plain words,
// every value the ledger records for an election, for the "What was recorded, and why it matters" section, and does the
// in-browser "Check it yourself" comparisons. Pure functions only (hashing helpers are passed in), so it is fully tested.
import { SCANNER_BUILDS } from "./scanner-builds.js";
import { normHash, isAddress } from "./logic.js";

const bare = (x) => normHash(x);
const with0x = (x) => (bare(x) ? `0x${bare(x)}` : null);
const same = (a, b) => bare(a) != null && bare(a) === bare(b);

// ------------------------------------------------------------------ approved scanner builds
/** Entries the create form uses automatically. */
export const defaultBuilds = (builds = SCANNER_BUILDS) => builds.filter((b) => b.default && bare(b.sha256));

/** The catalogue entry for a fingerprint (with or without 0x), or null. */
export const findBuild = (hash, builds = SCANNER_BUILDS) => builds.find((b) => same(b.sha256, hash)) ?? null;

/** Fingerprints typed one per line (or separated by spaces/commas). { hashes: bare hex[], bad: original text[] }. */
export function parseHashList(text) {
  const parts = String(text ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const hashes = [];
  const bad = [];
  for (const p of parts) {
    const h = bare(p);
    if (!h) bad.push(p);
    else if (!hashes.includes(h)) hashes.push(h);
  }
  return { hashes, bad };
}

// ------------------------------------------------------------------ create form
export const FIELD_LABEL = { layoutHash: "Ballot layout fingerprint", approvedAppHashes: "Approved scanner build" };

/**
 * The two fingerprints for a new election, chosen automatically.
 *  - layout: the designer's fingerprint, unless the organizer typed one under "Advanced" (then that one, if valid).
 *  - scanner builds: the site's default approved builds, unless "Advanced: use a different scanner build" is on, in
 *    which case the builds ticked there plus any pasted fingerprints.
 * Returns { layoutHash, layoutSource, approvedAppHashes, appsSource, problems: [{ field, message }] } with bare hex.
 */
export function resolveCreateFingerprints({ designedLayoutHash = null, layoutOverride = "", useAppsOverride = false, appsSelected = [], appsPasted = "", builds = SCANNER_BUILDS } = {}) {
  const problems = [];
  let layoutHash = null;
  let layoutSource = null;
  if (String(layoutOverride ?? "").trim()) {
    layoutHash = bare(layoutOverride);
    layoutSource = "advanced";
    if (!layoutHash) problems.push({ field: "layoutHash", message: "The layout fingerprint typed under Advanced isn't 64 hex characters. Clear that box to use the one the ballot designer makes." });
  } else if (bare(designedLayoutHash)) {
    layoutHash = bare(designedLayoutHash);
    layoutSource = "designed";
  } else {
    problems.push({ field: "layoutHash", message: "The ballot hasn't been designed yet. Type the election name and every question with its choices, then press \"Design the ballot\"; the fingerprint is filled in for you." });
  }

  let approvedAppHashes = [];
  let appsSource;
  if (useAppsOverride) {
    appsSource = "advanced";
    const picked = (appsSelected ?? []).map(bare).filter(Boolean);
    const pasted = parseHashList(appsPasted);
    if (pasted.bad.length) problems.push({ field: "approvedAppHashes", message: `This scanner build fingerprint isn't 64 hex characters: ${pasted.bad[0].slice(0, 20)}${pasted.bad[0].length > 20 ? "…" : ""}. Fix it or remove it.` });
    approvedAppHashes = [...new Set([...picked, ...pasted.hashes])];
    if (!approvedAppHashes.length && !pasted.bad.length) problems.push({ field: "approvedAppHashes", message: "Tick at least one scanner build under Advanced, or turn Advanced off to use the site's approved build." });
  } else {
    appsSource = "default";
    approvedAppHashes = defaultBuilds(builds).map((b) => bare(b.sha256));
    if (!approvedAppHashes.length) problems.push({ field: "approvedAppHashes", message: "This site has no approved scanner build set up yet. Choose one under \"Advanced: use a different scanner build\"." });
  }
  return { layoutHash, layoutSource, approvedAppHashes, appsSource, problems };
}

// ------------------------------------------------------------------ Register Scanner/Printer (registerDevice)
/**
 * Everything the "Register Scanner/Printer" button needs, checked before the wallet is asked.
 * approved: the election file's approvedAppHashes. Returns { ok, problems: string[], address, appHash (0x…), build, title, lines, facts }.
 */
export function registerStationPlan({ address, appHash, approved = [], status, isOrganizer, electionCode, builds = SCANNER_BUILDS }) {
  const problems = [];
  const addr = String(address ?? "").trim();
  if (status !== 1) problems.push("A Scanner/Printer can only be registered while the election is in Setup (before voting opens). After that the list is fixed.");
  if (!isOrganizer) problems.push("Only the election's organizer wallet can register a Scanner/Printer.");
  if (!isAddress(addr)) problems.push("The station's wallet address doesn't look right (0x followed by 40 characters).");
  const app = with0x(appHash);
  if (!app) problems.push("Choose the scanner build fingerprint (64 hex characters).");
  const approvedList = (approved ?? []).map(bare).filter(Boolean);
  if (app && approvedList.length && !approvedList.includes(bare(app))) problems.push("That scanner build isn't one this election approved. Pick one from the election's approved list.");
  const build = app ? findBuild(app, builds) : null;
  return {
    ok: problems.length === 0,
    problems,
    address: addr,
    appHash: app,
    build,
    title: "Register Scanner/Printer",
    lines: [
      "This approves one Local Scanner/Printer station for this election: from now on, ballot readings signed by this station's wallet are accepted by the ledger, and the ledger records which scanner build it runs.",
      "It can only be done during Setup, before voting opens, and only by the organizer. It doesn't move any money; it costs a small network fee.",
    ],
    facts: [["Election", electionCode ?? ""], ["Station wallet", addr], ["Scanner build", build ? `${build.label}` : "not in this site's list"], ["Build fingerprint", app ?? ""]],
  };
}

/** Each registered station checked against the election's approved builds, plus whether the quorum is met. */
export function stationStatus(devices = [], approved = [], quorum = 1) {
  const list = (approved ?? []).map(bare).filter(Boolean);
  const rows = devices.map((d) => ({ address: d.address, appHash: with0x(d.appHash) ?? d.appHash, approved: list.includes(bare(d.appHash)), build: findBuild(d.appHash) }));
  return { rows, count: rows.length, quorum, quorumMet: rows.length >= quorum, allApproved: rows.every((r) => r.approved) };
}

// ------------------------------------------------------------------ "What was recorded, and why it matters"
export const RECORDED_WHY = {
  electionFile:
    "A fingerprint (SHA-256) of the whole election file: the name, questions, choices, dates, rules and the secret list of ballot codes. Change a single letter and the fingerprint changes completely. It was written on the ledger before voting, so nobody, not even the organizer, can quietly reword a question or add ballots later without the mismatch showing.",
  ballotList:
    "One number that stands for the whole list of ballot codes (a Merkle root). The codes themselves stay secret, but each voter can later prove their own ballot was on the original list, and nobody can slip in extra ballots after printing without this number changing.",
  layout:
    "A fingerprint of the ballot design: where every question and bubble sits on the page. The scanner reads marks using this design, so recording it proves the paper that was printed and the design the scanner used are the same. It was made automatically when the ballot was designed, from the election's name, code and questions.",
  scannerBuilds:
    "Which scanner software the election trusts. Only a Scanner/Printer station running one of these builds should be registered, and the ledger stores the build next to each station. Anyone can later ask: was the software that read the ballots the software that was approved?",
  stations:
    "The Local Scanner/Printer stations allowed to record ballots, each identified by its signing crypto-wallet. In a classroom this is usually one scanner/printer run through one signing crypto-wallet. The ledger accepts readings only from these crypto-wallets, and only stations registered during Setup count, so nobody can add a scanner once voting has started.",
  merkleRoot:
    "One number that stands for every recorded ballot reading in the official count. Anyone with the ledger can rebuild it; if a single reading were changed, added or left out, the number would not match. It ties the totals to the individual ballots.",
  results:
    "A fingerprint of the official results file posted with the tally. If someone shares a results file later, you can check it is the exact one the organizer posted, not an edited copy.",
  record:
    "A fingerprint of the long-term election record: the public questions, the results file and any signed notes from officials. Recording it means anyone can check years from now that none of those files were changed.",
};

const ITEM_NAMES = {
  electionFile: "Election file fingerprint",
  ballotList: "Ballot code list fingerprint",
  layout: "Ballot layout fingerprint",
  scannerBuilds: "Approved scanner build",
  stations: "Local Scanner/Printer stations",
  merkleRoot: "Ballot readings fingerprint (Merkle root of the count)",
  results: "Official results file fingerprint",
  record: "Election record fingerprint",
};

/**
 * The list shown in "What was recorded, and why it matters". stage "preview" (before Create) or "created".
 * Each item: { id, name, value (0x… or null), values?: [{ value, label, tone, note }], why, check: { kind, … } | null, pending?: text }.
 */
export function recordedItems({ stage = "created", fileSha256, ballotListRoot, layoutHash, approvedAppHashes = [], devices, quorum = 1, merkleRoot, resultsSha256, recordSha256, builds = SCANNER_BUILDS } = {}) {
  const preview = stage === "preview";
  const zero = (x) => !x || /^0x0{64}$/i.test(x);
  const items = [];
  items.push({ id: "electionFile", name: ITEM_NAMES.electionFile, value: with0x(fileSha256), why: RECORDED_WHY.electionFile, check: { kind: preview ? "computed" : "election-file", expected: with0x(fileSha256) }, pending: fileSha256 ? null : "Made when you prepare the election." });
  items.push({ id: "ballotList", name: ITEM_NAMES.ballotList, value: zero(ballotListRoot) ? null : with0x(ballotListRoot), why: RECORDED_WHY.ballotList, check: { kind: preview ? "computed" : "ballot-list", expected: with0x(ballotListRoot) }, pending: "Made when you prepare the election." });
  items.push({ id: "layout", name: ITEM_NAMES.layout, value: with0x(layoutHash), why: RECORDED_WHY.layout, check: { kind: "layout", expected: with0x(layoutHash) }, pending: "Not in the public copy of the election file." });
  items.push({
    id: "scannerBuilds",
    name: approvedAppHashes.length > 1 ? "Approved scanner builds" : ITEM_NAMES.scannerBuilds,
    value: approvedAppHashes.length === 1 ? with0x(approvedAppHashes[0]) : null,
    values: approvedAppHashes.map((x) => {
      const b = findBuild(x, builds);
      return { value: with0x(x) ?? String(x), label: b ? b.label : "Not in this site's approved list", tone: b ? (b.kind === "agreed-label" ? "info" : "ok") : "warn", note: b ? (b.kind === "agreed-label" ? "An agreed label for the station's setup, not a hash of its software." : `SHA-256 of ${b.file ?? "the build"}; you can recompute it.`) : "This site can't say what software this fingerprint stands for." };
    }),
    why: RECORDED_WHY.scannerBuilds,
    check: { kind: "build-file", expected: approvedAppHashes.map(with0x).filter(Boolean) },
    pending: "None recorded.",
  });
  if (devices || preview) {
    const st = stationStatus(devices ?? [], approvedAppHashes, quorum);
    items.push({
      id: "stations",
      name: ITEM_NAMES.stations,
      value: null,
      values: st.rows.map((r) => ({ value: r.address, label: r.build ? `runs ${r.build.label}` : `runs build ${String(r.appHash).slice(0, 10)}…`, tone: r.approved ? "ok" : "bad", note: r.approved ? "Its build is on the election's approved list." : "Its build is NOT on the election's approved list." })),
      why: RECORDED_WHY.stations,
      check: preview ? null : { kind: "stations", status: st },
      pending: preview ? `You register the Scanner/Printer after creating the election, during Setup (${quorum} needed before voting can open).` : `None registered yet (${quorum} needed before voting can open).`,
    });
  }
  if (!preview) {
    items.push({ id: "merkleRoot", name: ITEM_NAMES.merkleRoot, value: zero(merkleRoot) ? null : with0x(merkleRoot), why: RECORDED_WHY.merkleRoot, check: zero(merkleRoot) ? null : { kind: "link", href: "#/verifier", text: "Recount it on the Verifier screen" }, pending: "Recorded when the official tally is posted." });
    items.push({ id: "results", name: ITEM_NAMES.results, value: zero(resultsSha256) ? null : with0x(resultsSha256), why: RECORDED_WHY.results, check: zero(resultsSha256) ? null : { kind: "results-file", expected: with0x(resultsSha256) }, pending: "Recorded when the official tally is posted." });
    if (recordSha256) items.push({ id: "record", name: ITEM_NAMES.record, value: with0x(recordSha256), why: RECORDED_WHY.record, check: { kind: "link", href: "#record-h", text: "See the election record panel" }, pending: null });
  }
  return items;
}

// ------------------------------------------------------------------ Check it yourself (in the browser)
/** Result of a check: { ok: true|false|null, message }. null = can't be decided from this input. */
const result = (ok, message) => ({ ok, message });

/** The election file someone loaded vs the ledger's fingerprint. deps: { sha256Hex(bytes) -> hex, canonicalize, utf8 }. */
export async function checkElectionFileText(text, expected, { sha256Hex, canonicalize, utf8 }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return result(false, "That file isn't JSON. Choose the election file (.json) you saved when the election was created.");
  }
  if (json?.publicCopy) return result(null, "This is the public copy. The secret ballot codes were removed from it, so by design it can't match. Use the secret full file; it is read only in this browser and never uploaded.");
  const file = json?.file && json.file.electionCode ? json.file : json;
  const got = "0x" + (await sha256Hex(utf8(canonicalize(file))));
  return same(got, expected) ? result(true, `Match. This file's fingerprint is ${got}, the same as on the ledger.`) : result(false, `No match. This file's fingerprint is ${got}, not the one on the ledger. It may be a different election or an edited copy.`);
}

/** Rebuild the ballot list fingerprint from the secret full file. deps: { keccak(bytes) -> 0x…, merkleRoot(leaves, keccak), utf8 }. */
export function checkBallotListText(text, expected, { keccak, merkleRoot, utf8 }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return result(false, "That file isn't JSON.");
  }
  const file = json?.file && json.file.electionCode ? json.file : json;
  if (!Array.isArray(file?.ballotCodes) || !file.ballotCodes.length) return result(null, "This file has no ballot codes (it may be the public copy). Use the secret full file; it is read only in this browser.");
  const got = merkleRoot(file.ballotCodes.map((c) => keccak(utf8(c))), keccak);
  return same(got, expected) ? result(true, `Match. The ${file.ballotCodes.length} ballot codes in this file give the fingerprint on the ledger.`) : result(false, "No match. The ballot codes in this file don't give the fingerprint on the ledger.");
}

/** Re-design the ballot from the name, code and questions and compare. design(file) -> { layoutHash }. */
export async function checkLayout(file, expected, design) {
  if (!file?.questions?.length) return result(null, "The questions aren't available here, so the ballot can't be re-designed.");
  try {
    const d = await design(file);
    return same(d.layoutHash, expected) ? result(true, "Match. This page re-designed the ballot from the election's name, code and questions and got the same layout fingerprint.") : result(false, `No match. Re-designing from these questions gives ${with0x(d.layoutHash)}. The ballot may have been designed with another tool or edited questions.`);
  } catch (e) {
    return result(null, `Couldn't re-design the ballot here: ${e?.message ?? e}`);
  }
}

/** Results file vs the tally's resultsSha256 (canonical JSON, as the admin page computes it). */
export async function checkResultsText(text, expected, { sha256Hex, canonicalize, utf8 }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return result(false, "That file isn't JSON. Choose the results file (…-results.json).");
  }
  const got = "0x" + (await sha256Hex(utf8(canonicalize(json))));
  return same(got, expected) ? result(true, "Match. This is the exact results file the organizer posted.") : result(false, `No match. This file's fingerprint is ${got}. It isn't the posted results file, or it was edited.`);
}

/** Hash any file's raw bytes and compare with the approved builds. */
export async function checkBuildBytes(bytes, expectedList, { sha256Hex }, builds = SCANNER_BUILDS) {
  const got = "0x" + (await sha256Hex(bytes));
  if ((expectedList ?? []).some((e) => same(e, got))) {
    const b = findBuild(got, builds);
    return result(true, `Match. This file's SHA-256 is an approved build for this election${b ? ` (${b.label})` : ""}.`);
  }
  const agreed = (expectedList ?? []).map((e) => findBuild(e, builds)).filter((b) => b?.kind === "agreed-label");
  return result(false, `No match. This file's SHA-256 is ${got}.${agreed.length ? " Note: this election's approved value is an agreed test label, not a hash of a file, so no file will match it." : ""}`);
}
