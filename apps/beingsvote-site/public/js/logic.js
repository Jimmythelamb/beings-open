// Pure logic for the staff screens (verifier, election officer, election admin, system admin).
// No DOM, no network, no wallet: everything here takes plain values so it can be unit tested (test/staff-logic.test.ts)
// and so the screens only have to draw what it returns. Where a rule also exists in the contracts or in @beings/core,
// the same rule is written here and the tests check that they agree.
import { canonicalize, parseResult, splitLedgerResults, tallyFromResults } from "./format.js";

// ------------------------------------------------------------------ small validators
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
export const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const isAddress = (v) => typeof v === "string" && ADDRESS_RE.test(v);
export const isBytes32 = (v) => typeof v === "string" && BYTES32_RE.test(v);
export const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
export const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** A sha-256 in any of the usual spellings ("0x…" or bare, any case) -> 64 lower-case hex characters, else null. */
export function normHash(x) {
  const s = String(x ?? "").trim().replace(/^0x/i, "").toLowerCase();
  return HEX64_RE.test(s) ? s : null;
}

/** A scanner app fingerprint typed with or without "0x" (any case, surrounding spaces) -> "0x" + 64 lower-case hex, else null. */
export function normalizeAppFingerprint(x) {
  const bare = normHash(x);
  return bare ? `0x${bare}` : null;
}

/** Whole number from user text. Returns null for blanks, decimals, negatives and anything that isn't a plain number. */
export function parseCount(text) {
  const s = String(text ?? "").trim();
  if (!/^[0-9]{1,9}$/.test(s)) return null;
  return Number(s);
}

/** Every 0x address in a pasted list (commas, spaces or new lines). Invalid entries are reported, never guessed at. */
export function parseAddressList(text) {
  const parts = String(text ?? "").split(/[\s,;]+/).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const p of parts) (isAddress(p) ? (valid.includes(p) ? [] : valid) : invalid).push(p);
  return { valid, invalid };
}

// ------------------------------------------------------------------ wallet and network
export const COSTON2 = { id: 114, hex: "0x72" };

export function chainIdNumber(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : /^0x/i.test(String(v)) ? parseInt(String(v), 16) : Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** "ok" = on the right network, "wrong" = connected somewhere else, "unknown" = nothing to compare. */
export function networkState(chainId, expected = COSTON2.id) {
  const n = chainIdNumber(chainId);
  if (n == null) return "unknown";
  return n === expected ? "ok" : "wrong";
}

/** The `wallet_addEthereumChain` parameters for Coston2 (the wallet asks the user before it adds anything). */
export function walletChainParams(config) {
  return {
    chainId: `0x${config.chainId.toString(16)}`,
    chainName: "Flare Testnet Coston2",
    nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: [config.explorer],
  };
}

// ------------------------------------------------------------------ errors in plain words
const REVERTS = {
  AlreadySet: "That value was already set and can't be set twice.",
  BadElectionCode: "The election code isn't in the BEINGS-YEAR-XXXXXX form.",
  BadParameters: "One of the election settings isn't allowed (ballots, quorum, opening and closing times, fingerprint or file link).",
  CloseNotAllowed: "Only the election's organizer can close voting yet. Anyone can close it one day after the scheduled closing time.",
  ElectionExists: "An election with that code is already on the ledger. Use a new code.",
  NotDeployer: "Only the wallet that deployed the contracts can do this.",
  NotEnoughDevices: "Not enough Local Scanner/Printer stations are registered yet to open the election (quorum not met).",
  NotOrganizer: "This wallet isn't the organizer of this election.",
  NotTally: "Only the Tally contract can do that.",
  RoleTaken: "That address already has a role in this election.",
  TooEarly: "It isn't the scheduled opening time yet.",
  UnknownElection: "That election isn't on the ledger.",
  WrongStatus: "The election isn't in the right stage for this step.",
  ZeroAddress: "The all-zero address isn't allowed.",
  AlreadyRecorded: "That ballot is already on the ledger.",
  PoolProofRequired: "This election only accepts ballots from its ballot pool, and this submission has no proof.",
  BallotNotInPool: "That ballot is not in this election's ballot pool.",
  ProofCountMismatch: "Each ballot in the batch needs its own pool proof.",
  BallotsLocked: "Voting has reached its opening time, so no more ballots can be added.",
  PoolNotEnforced: "This election was created before ballot-pool checks. Ballots cannot be added to it.",
  DuplicateBallotRoot: "That ballot list is already approved for this election.",
  BallotCountOverflow: "That would make the ballot count too large.",
  UnknownBallotRoot: "That is not one of this election's approved ballot lists.",
  BallotCapReached: "The ledger already has as many ballots as were registered. No more can be added.",
  EmptyResults: "A ballot record needs a result for every question.",
  NoReadings: "A ballot record needs a signature from a scanning wallet.",
  NotADevice: "This wallet is not a registered scanning wallet for this election.",
  DuplicateDevice: "The same scanning wallet signed this ballot twice.",
  BadSignature: "The signature does not match this ballot, these scores, or this ledger.",
  ImageHashMismatch: "The picture fingerprint on the record does not match the one that was signed.",
  QuorumNotMet: "Not enough registered scanning wallets have signed this ballot.",
  BadCorrection: "That change isn't allowed.",
  BallotSpoiledAlready: "That ballot is already marked spoiled.",
  ElectionNotOpen: "The election has to be open or closed for this step.",
  NotOrganizerOrReviewer: "Only the organizer or a registered reviewer can do this.",
  UnknownBallot: "No record exists for that ballot.",
  EmptyClearanceCid: "Add a link or note describing the review that was done.",
  NoQuestions: "The tally needs at least one question.",
  NoTally: "There is no published tally to amend.",
  NotLatestVersion: "That isn't the latest tally version.",
  NotProvisional: "That tally has no open review (it is already final or cleared).",
  NotReviewer: "Only a registered reviewer can clear a review.",
  TooManyQuestions: "Too many questions for one tally.",
  WrongElectionStatus: "The election isn't in the right stage for this step (voting must be closed to post the first tally).",
  AgreedExceedsChecked: "The 'agreed' number can't be larger than the 'checked' number.",
  BadTallyVersion: "That tally version doesn't exist yet.",
  StringTooLong: "One of the text fields is too long (31 characters at most for a name or link).",
  NotAuthorized: "Only this election's organizer, a registered reviewer or a registered scanner wallet can post a note.",
  NotTallied: "Notes can be posted once the official tally is published.",
  EmptyNoteHash: "The note's fingerprint is missing.",
  EmptyCid: "Add where the note is kept (a link or path).",
  CidTooLong: "The link is too long (256 bytes at most).",
  DisplayNameTooLong: "The display name is too long (64 bytes at most).",
  DuplicateNote: "This exact note is already on the ledger, so it wasn't posted twice.",
  AdultAttestationRequired: "A standard or test approval has to include the legal-adult attestation.",
  AdminAlreadyRecorded: "The Election Administrator is already recorded for this election. The election type cannot be changed.",
  AdminNotRecorded: "Record the Election Administrator on the roster contract before this step.",
  BadElectionKind: "The election type has to be Standard, Test, or Classroom.",
  ClassroomIsSingleAdmin: "A classroom election is run by one administrator. Other staff wallets are not recorded.",
  StaffingBlocksLock: "A standard election cannot open until every position has its own approved wallet and none is covered by the Election Administrator.",
  TestAttestationRequired: "A test election with a covered or missing position needs the signed test statement before the roster can be locked.",
  RosterIsLocked: "The roster is locked. A later change has to be recorded as an amendment.",
  NotATestElection: "That statement is only for an election that was recorded as a test.",
  BadRosterSignature: "The signature does not match this roster, this chain, or this contract.",
  NotAHandler: "That wallet is not an approved Election officer for this election.",
  NotAScanner: "That wallet is not an approved Scanner operator. An officer cannot sign as the scanner.",
  ScannerNotOnThisStep: "Storing the paper ballots is signed by an Election officer only.",
  NotASystemAdmin: "This sign-off has to be signed by the System admin wallet recorded on the roster.",
  SignOffIncomplete: "The System admin sign-off has to list every filled position and a duty sheet for each one.",
  SignOffStale: "That sign-off is for a different roster fingerprint. Review the current roster and sign again.",
  AlreadySigned: "This roster already has a System admin sign-off for the same positions.",
  NotSignOffParty: "Only the organizer or the recorded System admin can record this sign-off.",
};

export function isUserRejected(err) {
  return err?.code === "ACTION_REJECTED" || err?.code === 4001 || err?.info?.error?.code === 4001 || err?.code === 5000 || err?.info?.error?.code === 5000 /* WalletConnect's "user rejected" */ || /user (rejected|denied)/i.test(String(err?.message ?? ""));
}

/** One calm sentence for an error from the wallet or the chain. Never throws; unknown errors keep their own short message. */
export function explainError(err) {
  if (isUserRejected(err)) return "You declined in your wallet, so nothing was sent.";
  const name = err?.revert?.name ?? err?.errorName ?? /reverted with custom error '([A-Za-z]+)/.exec(String(err?.shortMessage ?? err?.message ?? ""))?.[1];
  if (name && REVERTS[name]) {
    const args = err?.revert?.args ?? err?.errorArgs;
    const status = name === "WrongStatus" || name === "WrongElectionStatus" || name === "NotTallied" ? ["", "getting ready", "open", "closed", "results published"][Number(args?.[0])] : null;
    return REVERTS[name] + (status ? ` (It is currently ${status}.)` : "");
  }
  if (err?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(String(err?.message ?? ""))) return "This wallet doesn't have enough C2FLR (test coin) to pay the network fee. Get free test coin from the Coston2 faucet.";
  if (err?.code === -32002) return "Your wallet already has a request waiting. Open it and answer it first.";
  if (err?.code === 4902) return "Your wallet doesn't know the Coston2 network yet. Add it, then try again.";
  const msg = String(err?.shortMessage ?? err?.reason ?? err?.message ?? err ?? "Something went wrong.");
  return msg.length > 220 ? `${msg.slice(0, 217)}…` : msg;
}

// ------------------------------------------------------------------ reconciliation (spec 8.3 / 10.3, mirrors ReconcileLib and core reconcile())
export const RULES = [
  { id: "R1", bit: 1, title: "Cast ≤ issued", plain: "No more ballots were counted than were handed out." },
  { id: "R2", bit: 2, title: "Issued − spoiled ≤ registered", plain: "No more ballots were handed out than there are registered voters (spoiled ones are replaced, so they don't count twice)." },
  { id: "R3", bit: 4, title: "Issued ≤ printed", plain: "No more ballots were handed out than were printed." },
  { id: "R4", bit: 8, title: "Issued = cast + spoiled + unused", plain: "Every ballot handed out is accounted for: counted, spoiled, or returned unused." },
  { id: "R5", bit: 16, title: "Each question adds up to the ballots cast", plain: "For every question, choices + blank + overvote + unclear equals the number of ballots counted." },
  { id: "R6", bit: 32, title: "Registered = the election file", plain: "The registered-voter number at the close matches what was fixed before voting." },
];

const countOk = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Count reconciliation R1..R6, the same rules as the Solidity ReconcileLib and @beings/core `reconcile()`.
 * organizer = { registered, issued, unusedReturned }; ledger = { registeredInElectionFile, printed, cast, spoiled, perQuestion: [{valid,blank,overvote,unclear}] }.
 * A failing rule sets its bit; malformed numbers throw (never silently pass).
 */
export function reconcile(organizer, ledger) {
  const { registered, issued, unusedReturned } = organizer;
  const { registeredInElectionFile, printed, cast, spoiled } = ledger;
  for (const [name, v] of Object.entries({ registered, issued, unusedReturned, registeredInElectionFile, printed, cast, spoiled })) {
    if (!countOk(v)) throw new Error(`${name} must be a whole number, 0 or more`);
  }
  const details = [];
  const add = (rule, passed, message, skipped = false) => details.push({ rule, bit: RULES.find((r) => r.id === rule).bit, passed, skipped, message });
  add("R1", cast <= issued, `cast ${cast} ≤ issued ${issued}`);
  if (registered === 0) add("R2", true, "skipped: no register (registered = 0)", true);
  else add("R2", issued - spoiled <= registered, `issued ${issued} − spoiled ${spoiled} = ${issued - spoiled} ≤ registered ${registered}`);
  add("R3", issued <= printed, `issued ${issued} ≤ printed ${printed}`);
  add("R4", issued === cast + spoiled + unusedReturned, `issued ${issued} = cast ${cast} + spoiled ${spoiled} + unused ${unusedReturned} (= ${cast + spoiled + unusedReturned})`);
  const bad = [];
  (ledger.perQuestion ?? []).forEach((t, i) => {
    for (const k of ["valid", "blank", "overvote", "unclear"]) if (!countOk(t[k])) throw new Error(`question ${i + 1} ${k} must be a whole number, 0 or more`);
    if (t.valid + t.blank + t.overvote + t.unclear !== cast) bad.push(i + 1);
  });
  add("R5", bad.length === 0, bad.length === 0 ? `every question adds up to ${cast}` : `questions ${bad.join(", ")} don't add up to ${cast}`);
  add("R6", registered === registeredInElectionFile, `registered at close ${registered} = election file ${registeredInElectionFile}`);
  let failedChecks = 0;
  for (const d of details) if (!d.passed) failedChecks |= d.bit;
  return { failedChecks, details, counts: { registered, printed, issued, cast, spoiled, unusedReturned, unissued: Math.max(0, printed - issued) } };
}

/** [{...rule, passed}] for a failedChecks bit mask (0 = all passed). */
export function rulesFromMask(mask) {
  const m = Number(mask) || 0;
  return RULES.map((r) => ({ ...r, passed: (m & r.bit) === 0 }));
}

/**
 * The polling-station count view. Everything the station knows, checked against the ledger.
 * input: { registered, printed, cast, spoiled, issued?, unusedReturned? } (issued / unusedReturned are null until the station enters them).
 * Returns { rows, issues, status, unaccounted } where status is "ok" | "review" | "incomplete".
 * Cast may never exceed registered (when a register is used) or issued; any mismatch is a review flag, never silently fixed.
 */
export function stationReconciliation(input) {
  const { registered, printed, cast, spoiled } = input;
  const issued = input.issued ?? null;
  const unused = input.unusedReturned ?? null;
  const issues = [];
  const flag = (id, level, title, detail) => issues.push({ id, level, title, detail });

  if (registered > 0 && cast > registered) flag("cast>registered", "bad", "More ballots counted than registered voters", `${cast} ballots are on the ledger but only ${registered} voters are registered.`);
  if (cast + spoiled > printed) flag("over-printed", "bad", "More ballots used than were printed", `${cast} counted + ${spoiled} spoiled = ${cast + spoiled}, but only ${printed} were printed.`);
  if (issued != null) {
    if (cast > issued) flag("cast>issued", "bad", "More ballots counted than were handed out", `${cast} counted but only ${issued} handed out (rule R1).`);
    if (issued > printed) flag("issued>printed", "bad", "More ballots handed out than were printed", `${issued} handed out but only ${printed} printed (rule R3).`);
    if (registered > 0 && issued - spoiled > registered) flag("issued>registered", "bad", "More ballots handed out than registered voters", `${issued} handed out − ${spoiled} spoiled = ${issued - spoiled}, which is more than ${registered} registered (rule R2).`);
    if (cast + spoiled > issued) flag("accounted>issued", "bad", "Counted and spoiled ballots add up to more than were handed out", `${cast} + ${spoiled} = ${cast + spoiled}, more than ${issued} handed out.`);
    if (unused != null && issued !== cast + spoiled + unused) {
      const diff = issued - (cast + spoiled + unused);
      flag("unaccounted", "bad", `${Math.abs(diff)} ballot${Math.abs(diff) === 1 ? "" : "s"} ${diff > 0 ? "can't be accounted for" : "too many accounted for"}`, `Handed out ${issued} = counted ${cast} + spoiled ${spoiled} + returned unused ${unused} should balance, but they add up to ${cast + spoiled + unused} (rule R4).`);
    }
  }
  const unaccounted = issued != null && unused != null ? issued - (cast + spoiled + unused) : null;
  const incomplete = issued == null || unused == null;
  if (incomplete && !issues.some((i) => i.level === "bad")) flag("incomplete", "warn", "Enter the station's own counts to finish the check", "The ledger knows how many ballots were counted and spoiled. Enter how many were handed out and how many came back unused.");

  const rows = [
    { id: "registered", label: "Registered voters", value: registered, source: "election file", known: true },
    { id: "printed", label: "Ballots printed", value: printed, source: "election file", known: true },
    { id: "issued", label: "Handed out", value: issued, source: "station count", known: issued != null },
    { id: "cast", label: "Counted (cast)", value: cast, source: "ledger", known: true },
    { id: "spoiled", label: "Spoiled", value: spoiled, source: "ledger", known: true },
    { id: "unused", label: "Returned unused", value: unused, source: "station count", known: unused != null },
  ];
  const status = issues.some((i) => i.level === "bad") ? "review" : incomplete ? "incomplete" : "ok";
  const turnout = registered > 0 ? Math.round((cast / registered) * 1000) / 10 : null;
  return { rows, issues, status, unaccounted, turnout };
}

// ------------------------------------------------------------------ election actions (what the registry will accept)
export const STATUS_NAMES = ["None", "Setup", "Open", "Closed", "Tallied"];

/**
 * What the organizer may do next, and exactly what is in the way. Mirrors ElectionRegistry.openElection/closeElection
 * and Tally.postTally. now / opensAt / closesAt are unix seconds. isOrganizer = the connected wallet created the election.
 */
export function electionActions({ status, now, opensAt, closesAt, deviceCount, quorum, isOrganizer, closeGrace = 86400 }) {
  const openBlockers = [];
  if (status !== 1) openBlockers.push(status === 0 ? "This election isn't on the ledger." : "Voting can only be opened from the 'getting ready' stage.");
  else {
    if (!isOrganizer) openBlockers.push("Only the organizer's crypto-wallet can open voting.");
    if (deviceCount < quorum) openBlockers.push(`Register ${quorum - deviceCount} more Scanner/Printer station${quorum - deviceCount === 1 ? "" : "s"} (quorum is ${quorum}, ${deviceCount} registered).`);
    if (now < opensAt) openBlockers.push("It isn't the scheduled opening time yet.");
  }
  const closeBlockers = [];
  if (status !== 2) closeBlockers.push("Voting can only be closed while it is open.");
  else if (!isOrganizer && now <= closesAt + closeGrace) closeBlockers.push("Only the organizer can close early. Anyone can close it one day after the scheduled closing time.");
  const tallyBlockers = [];
  if (status !== 3) tallyBlockers.push(status === 4 ? "A tally is already published. Use an amended tally to correct it." : "Voting must be closed before the tally can be published.");
  else if (!isOrganizer) tallyBlockers.push("Only the organizer's crypto-wallet can publish the tally.");
  return { canOpen: openBlockers.length === 0, openBlockers, canClose: closeBlockers.length === 0, closeBlockers, canPostTally: tallyBlockers.length === 0, tallyBlockers, canAmend: status === 4 && isOrganizer };
}

/** Setup-stage edits (Scanner/Printer stations, reviewers) are only allowed while the election is getting ready. */
export const canRegisterRoles = ({ status, isOrganizer }) => status === 1 && isOrganizer;

// ------------------------------------------------------------------ tally comparison
const FIELDS = ["valid", "blank", "overvote", "unclear"];

/** Official on-chain per-question totals vs the totals recomputed from the ledger. */
export function compareTally(official, recount) {
  if (!official || !official.length) return { checked: false, matches: null, perQuestion: [], differences: [] };
  const perQuestion = official.map((o, i) => {
    const r = recount[i];
    const fields = Object.fromEntries(FIELDS.map((f) => [f, { official: o[f], recount: r ? r[f] : null, match: !!r && o[f] === r[f] }]));
    return { index: i, matches: !!r && FIELDS.every((f) => fields[f].match), fields };
  });
  const missing = recount.length !== official.length;
  const differences = [];
  for (const q of perQuestion) for (const f of FIELDS) if (!q.fields[f].match) differences.push({ question: q.index + 1, field: f, official: q.fields[f].official, recount: q.fields[f].recount });
  return { checked: true, matches: !missing && perQuestion.every((q) => q.matches), perQuestion, differences };
}

/** How many ballot-questions are readable and consistent with the election file (the verifier's "agreed" number). */
export function auditEntries(resultStrings, questions) {
  let checked = 0;
  let agreed = 0;
  const problems = [];
  resultStrings.forEach((s, bi) => {
    const segs = splitLedgerResults(s);
    if (segs.length !== questions.length) problems.push({ ballot: bi, question: null, problem: `has ${segs.length} answers, the election has ${questions.length} questions` });
    questions.forEach((q, qi) => {
      checked++;
      const p = parseResult(segs[qi]);
      if (!p) return problems.push({ ballot: bi, question: qi, problem: "unreadable entry" });
      if (p.kind === "V") {
        const unknown = p.choices.filter((id) => !q.choices.some((c) => c.id === id));
        if (unknown.length) return problems.push({ ballot: bi, question: qi, problem: `unknown choice ${unknown.join(", ")}` });
        if (q.maxMarks && p.choices.length > q.maxMarks) return problems.push({ ballot: bi, question: qi, problem: `${p.choices.length} marks counted but at most ${q.maxMarks} allowed` });
      }
      agreed++;
    });
  });
  return { checked, agreed, problems };
}

/** Counts of special entries across a set of ledger strings: unclear, overvote, blank per all questions. */
export function summarizeEntries(resultStrings, questions) {
  const t = tallyFromResults(resultStrings, questions);
  return t.reduce((a, q) => ({ unclear: a.unclear + q.unclear, overvote: a.overvote + q.overvote, blank: a.blank + q.blank, unreadable: a.unreadable + q.unreadable }), { unclear: 0, overvote: 0, blank: 0, unreadable: 0 });
}

// ------------------------------------------------------------------ images: compare what the ledger fingerprinted with what the store holds
/**
 * onChain = imageSha256 values from BallotAccepted events; store = the sha256 names in the verifier manifest.
 * Sets, as in packages/verifier: a store image the ledger never saw, or a ledger fingerprint with no image, is a flag.
 */
export function compareImageSets(onChain, store) {
  const a = new Set(onChain.map(normHash).filter(Boolean));
  const b = new Set(store.map(normHash).filter(Boolean));
  const matched = [...a].filter((x) => b.has(x));
  return {
    onChain: a.size,
    inStore: b.size,
    matched,
    missingFromStore: [...a].filter((x) => !b.has(x)),
    notOnLedger: [...b].filter((x) => !a.has(x)),
  };
}

/** One downloaded image: its name (expected hash), the hash of the bytes that arrived, and the ledger's set. */
export function classifyImage(expected, actual, ledgerSet) {
  const e = normHash(expected);
  const a = normHash(actual);
  if (!e || !a) return "failed";
  if (a !== e) return "tampered";
  return ledgerSet.has(e) ? "verified" : "not-on-ledger";
}

export function summarizeImageChecks(items, setCompare) {
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    manifest: setCompare.inStore,
    downloaded: items.filter((i) => i.status !== "failed" && i.status !== "pending").length,
    verified: count("verified"),
    tampered: items.filter((i) => i.status === "tampered").map((i) => i.sha256),
    failed: items.filter((i) => i.status === "failed").map((i) => ({ sha256: i.sha256, reason: i.reason })),
    notOnLedger: [...new Set([...items.filter((i) => i.status === "not-on-ledger").map((i) => i.sha256), ...setCompare.notOnLedger])],
    missingFromStore: setCompare.missingFromStore,
  };
}

// ------------------------------------------------------------------ flags the verifier can raise
/**
 * Findings from everything the verifier checked. Verifiers can only raise flags: nothing here changes a record.
 * facts: see test/staff-logic.test.ts for the full shape. Every key is optional; missing = not checked (no flag, no pass).
 */
export function buildFlags(f) {
  const flags = [];
  const add = (id, level, title, detail) => flags.push({ id, level, title, detail });
  if (f.tallyPosted === false) add("no-tally", "info", "No official tally yet", "The count hasn't been published, so there is nothing to compare your recount with yet.");
  if (f.tallyMatches === false) add("tally-mismatch", "bad", "Recount doesn't match the official tally", `${f.tallyDifferences?.length ?? "Some"} total${f.tallyDifferences?.length === 1 ? "" : "s"} differ between the ledger entries and the tally.`);
  if (f.failedChecks > 0) add("reconciliation-failed", "bad", "The published count reconciliation failed", `The tally was posted with ${f.failedChecks} failed check bit(s) (${rulesFromMask(f.failedChecks).filter((r) => !r.passed).map((r) => r.id).join(", ")}).`);
  if (f.reconciliationDrift === true) add("reconciliation-drift", "bad", "Reconciliation doesn't recompute", "Re-running the reconciliation rules over the posted counts gives a different result than the one stored on the ledger.");
  if (f.fileCheck === "mismatch") add("file-mismatch", "bad", "Election file doesn't match its fingerprint", "The election file's SHA-256 is different from the one recorded on the ledger.");
  if (f.fileCheck === "unverifiable") add("file-unverifiable", "warn", "Election file couldn't be verified", "Only a public copy was available, so its fingerprint can't be compared with the ledger. Load the full file to check it.");
  if (f.recordsRead != null && f.recordCount != null && f.recordsRead !== f.recordCount) add("record-count", "bad", "Ledger entries read differ from the on-chain count", `${f.recordsRead} entries were read from the event history but the ledger says ${f.recordCount}.`);
  if (f.unreadable > 0) add("unreadable", "bad", "Entries this tool can't read", `${f.unreadable} answer${f.unreadable === 1 ? "" : "s"} aren't in the expected form.`);
  if (f.auditProblems > 0) add("inconsistent", "bad", "Entries that break the election's rules", `${f.auditProblems} answer${f.auditProblems === 1 ? "" : "s"} name unknown choices or more marks than allowed.`);
  if (f.merkle?.checked && f.merkle.matches === false) add("merkle-mismatch", "bad", "Merkle root doesn't match", "The root recomputed from the ledger entries differs from the root in the official tally.");
  if (f.merkle && !f.merkle.checked) add("merkle-unchecked", "info", "Merkle root not checked", "Load the full election file (with ballot codes) to recompute the root. It needs the private ballot codes, so it can't be done from public data alone.");
  if (f.merkle?.unknownBallots > 0) add("unknown-ballots", "bad", "Ledger entries for ballots not in the election file", `${f.merkle.unknownBallots} recorded ballot${f.merkle.unknownBallots === 1 ? "" : "s"} have no matching code in the file you loaded.`);
  if (f.images) {
    if (f.images.tampered?.length) add("image-tampered", "bad", "Ballot images that don't match their fingerprint", `${f.images.tampered.length} downloaded image${f.images.tampered.length === 1 ? "" : "s"} hash to something other than what the store claimed.`);
    if (f.images.missingFromStore?.length) add("image-missing", "bad", "Ballots whose image is missing", `${f.images.missingFromStore.length} fingerprint${f.images.missingFromStore.length === 1 ? "" : "s"} on the ledger have no image in the store (it may have been removed or retired).`);
    if (f.images.notOnLedger?.length) add("image-extra", "warn", "Images the ledger never recorded", `${f.images.notOnLedger.length} image${f.images.notOnLedger.length === 1 ? "" : "s"} in the store have no fingerprint on the ledger.`);
    if (f.images.failed?.length) add("image-failed", "warn", "Images that couldn't be downloaded", `${f.images.failed.length} download${f.images.failed.length === 1 ? "" : "s"} failed. Try again.`);
  } else if (f.images === null) add("images-unchecked", "info", "Ballot images not checked", "Download the images to compare each one with the fingerprint on the ledger.");
  if (f.unclear > 0) add("unclear", "warn", "Answers flagged unclear", `${f.unclear} answer${f.unclear === 1 ? "" : "s"} were marked unclear by the scanner. They should have a human review or a correction.`);
  if (f.overvote > 0) add("overvote", "info", "Overvotes recorded", `${f.overvote} answer${f.overvote === 1 ? "" : "s"} had more marks than allowed and count for no choice.`);
  const order = { bad: 0, warn: 1, info: 2 };
  return flags.sort((a, b) => order[a.level] - order[b.level]);
}

// ------------------------------------------------------------------ the signed verifier report
export const REPORT_SOFTWARE = { name: "beings-web-verifier", version: "0.1.0", omrBuild: "none: this tool re-checks the ledger, hashes and counts, not the ballot marks" };

/** The report body (everything except the signature). Fields that weren't checked say so (null / checked:false), never a made-up pass. */
export function buildVerifierReport(i) {
  return {
    schemaVersion: "0.1",
    kind: "web-verifier-report",
    electionCode: i.electionCode,
    tallyVersion: i.tallyVersion,
    node: { address: i.address },
    software: REPORT_SOFTWARE,
    ledgerHead: { block: i.block, recordCount: i.recordCount },
    ledger: { recordsRead: i.recordsRead, correctionsRead: i.correctionsRead, questionsChecked: i.audit.checked, questionsAgreed: i.audit.agreed },
    tally: { checked: i.tally.checked, matches: i.tally.matches, differences: i.tally.differences ?? [] },
    reconciliation: { checked: i.recon.checked, matches: i.recon.matches, failedChecks: i.recon.failedChecks ?? null },
    merkle: { checked: !!i.merkle?.checked, matches: i.merkle?.checked ? i.merkle.matches : null, recomputedRoot: i.merkle?.checked ? i.merkle.root : null, onChainRoot: i.merkle?.onChainRoot ?? null },
    images: i.images ? { checked: i.images.downloaded, verified: i.images.verified, tampered: i.images.tampered, missingFromStore: i.images.missingFromStore, notOnLedger: i.images.notOnLedger, failedDownloads: i.images.failed.length } : null,
    electionFile: { check: i.fileCheck ?? "unverifiable" },
    flags: i.flags.map((x) => ({ id: x.id, level: x.level, title: x.title })),
    createdAt: i.createdAt,
  };
}

/** The exact text that gets hashed (RFC 8785 JSON of the report without its signature). */
export function reportCanonical(report) {
  const { signature: _ignored, ...rest } = report;
  void _ignored;
  return canonicalize(rest);
}

/** EIP-712 typed data a verifier wallet signs (the same type @beings/core `signReport` uses). `reportHash` = keccak256(reportCanonical). */
export function reportTypedData({ electionKey, tallyVersion, reportHash, chainId = COSTON2.id }) {
  return {
    domain: { name: "B.E.I.N.G.S.", version: "1", chainId },
    types: { VerifierReport: [{ name: "electionKey", type: "bytes32" }, { name: "tallyVersion", type: "uint32" }, { name: "reportHash", type: "bytes32" }] },
    value: { electionKey, tallyVersion, reportHash },
  };
}

/**
 * Arguments for VerifierRegistry.reportVerification, or the reason it can't be sent honestly yet.
 * The contract has one yes/no for each of tally, reconciliation and Merkle, and no "not checked": so it is only offered once all three were really checked.
 */
export function onChainReportArgs(report, { electionKey, reportCid, reportSha256 }) {
  const missing = [];
  if (!(report.tallyVersion >= 1)) missing.push("an official tally has to be published first");
  if (!report.tally.checked) missing.push("the tally comparison");
  if (!report.reconciliation.checked) missing.push("the reconciliation check");
  if (!report.merkle.checked) missing.push("the Merkle root (load the full election file)");
  if (missing.length) return { ok: false, missing };
  const checked = report.ledger.questionsChecked;
  const agreed = Math.min(report.ledger.questionsAgreed, checked);
  return {
    ok: true,
    args: [electionKey, report.tallyVersion, reportCid, reportSha256, checked, agreed, report.tally.matches === true, report.reconciliation.matches === true, report.merkle.matches === true],
    summary: { checked, agreed, tallyMatches: report.tally.matches === true, reconciliationMatches: report.reconciliation.matches === true, merkleMatches: report.merkle.matches === true },
  };
}

// ------------------------------------------------------------------ the verifier's download request (must equal src/verifierAuth.ts)
export const VERIFIER_WINDOW_SECONDS = 300;
export const challengeMessage = (electionCode, unixSeconds) => `BEINGS-VERIFIER|${electionCode}|${unixSeconds}`;
/** Signature is reused for up to this long, then re-signed (the server accepts ±300 s). */
export const SIGNATURE_REUSE_SECONDS = 180;
export const signatureStillFresh = (signedAt, now) => now - signedAt >= 0 && now - signedAt < SIGNATURE_REUSE_SECONDS;

/** Plain-language meaning of a /api/verifier/images answer. */
export function verifierApiMessage(status) {
  switch (status) {
    case 401: return "The site didn't accept the signature. Check your computer's clock and try again.";
    case 403: return "This wallet isn't the election organizer or a registered verifier. Register as a verifier on the Verifier page, or connect the organizer wallet on the Admin page.";
    case 404: return "No images are stored for this election.";
    case 410: return "The images for this election have been retired (deleted after the retention period). The fingerprints stay on the ledger.";
    case 429: return "Too many requests. Wait a minute and try again.";
    case 500: case 502: case 503: return "The image store had a problem. Try again in a moment.";
    default: return `The image store answered ${status}.`;
  }
}

// ------------------------------------------------------------------ Merkle (browser recomputation; keccak is injected so this stays pure)
/** keccak: (Uint8Array) -> "0x…" 32-byte hex. Same rules as @beings/core merkle.ts: sorted leaves, sorted-pair hashing, odd node promoted. */
export function merkleRoot(leaves, keccak) {
  const norm = leaves.map((l) => l.toLowerCase());
  const sorted = [...norm].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error("duplicate leaf");
  if (sorted.length === 0) return `0x${"00".repeat(32)}`;
  let level = sorted;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (b === undefined) next.push(a);
      else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        next.push(keccak(hexBytes(lo + hi.slice(2))).toLowerCase());
      }
    }
    level = next;
  }
  return level[0];
}

/** Inclusion proof (sibling hashes, bottom to top). Same rules as merkleRoot and @beings/core. */
export function merkleProof(leaves, leaf, keccak) {
  const sorted = [...leaves.map((l) => l.toLowerCase())].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error("duplicate leaf");
  let idx = sorted.indexOf(String(leaf).toLowerCase());
  if (idx < 0) throw new Error("leaf is not in the tree");
  const levels = [sorted];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = cur[i + 1];
      if (b === undefined) next.push(a);
      else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        next.push(keccak(hexBytes(lo + hi.slice(2))).toLowerCase());
      }
    }
    levels.push(next);
  }
  const proof = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = levels[l][idx ^ 1];
    if (sib !== undefined) proof.push(sib);
    idx >>= 1;
  }
  return proof;
}

/** How many codes were added after creation. The codes themselves are not counted here as text. */
export function addedPoolCount(file) {
  const pools = file?.addedBallotPools;
  if (!Array.isArray(pools)) return 0;
  return pools.reduce((n, p) => n + (Array.isArray(p?.codes) ? p.codes.length : Array.isArray(p) ? p.length : 0), 0);
}

/** Code lists for proofs. Index 0 is the creation list. Later indexes are addBallots lists. */
export function ballotPoolsFromFile(file) {
  const pools = [Array.isArray(file?.ballotCodes) ? [...file.ballotCodes] : []];
  if (Array.isArray(file?.addedBallotPools)) {
    for (const pool of file.addedBallotPools) {
      if (Array.isArray(pool?.codes)) pools.push([...pool.codes]);
      else if (Array.isArray(pool)) pools.push([...pool]);
    }
  }
  return pools;
}

/** Every code in the pool: the creation list, then each added list. For local proofs and tallies only. */
export function allBallotCodes(file) {
  return ballotPoolsFromFile(file).flat();
}

/** The file as it was registered. Added pools are kept beside it and are not part of the creation fingerprint. */
export function creationElectionFile(file) {
  if (!file || typeof file !== "object" || !Array.isArray(file.addedBallotPools)) return file;
  const { addedBallotPools, ...rest } = file;
  return rest;
}

/**
 * Proof that `code` is in one pool. Returns the ballot key, the proof and which root it belongs to, or null.
 * The code is not included in the result.
 */
export function ballotPoolProof(pools, code, keccak) {
  const key = keccak(utf8(code)).toLowerCase();
  for (let rootIndex = 0; rootIndex < pools.length; rootIndex++) {
    const leaves = (pools[rootIndex] ?? []).map((c) => keccak(utf8(c)).toLowerCase());
    if (!leaves.includes(key)) continue;
    return { ballotKey: key, proof: merkleProof(leaves, key, keccak), rootIndex };
  }
  return null;
}

/**
 * Electoral-body turnout pool (spec 9.6). This is not the contract's scanner-signature quorum.
 * Extra ballots count only after they are verified and added. Unissued extras are reported as unused and do not count.
 */
export function electoralBodyPool({ registeredVoters, verifiedExtras = 0, unissuedExtras = 0 }) {
  for (const [name, v] of Object.entries({ registeredVoters, verifiedExtras, unissuedExtras })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a whole number, 0 or more`);
  }
  return { quorumPool: registeredVoters + verifiedExtras, verifiedExtras, unissuedExtras, unusedAtClose: unissuedExtras };
}

/** Off-chain reprint note (spec 9.7). Names the ballot by its key, never by its code. */
export function reprintNote({ electionCode, ballotKey, reason, author, at }) {
  const text = String(reason ?? "").trim();
  if (!ELECTION_RE.test(electionCode ?? "")) throw new Error("The reprint note needs an election code.");
  if (!isBytes32(ballotKey)) throw new Error("The reprint note names the ballot by its hash.");
  if (!text) throw new Error("A reprint note needs a reason.");
  if (BALLOT_RE.test(text.replace(/[\s-]/g, "").toUpperCase())) throw new Error("The reason must not contain a ballot code.");
  return { schema: "beings-reprint-note/1", electionCode, ballotKey: ballotKey.toLowerCase(), reason: text, author, at };
}

export function hexBytes(hex) {
  const s = hex.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const utf8 = (s) => new TextEncoder().encode(s);

/** "V:c1|B|V:c2+c3" with question order -> { q1: "V:c1", q2: "B", … } (as the Merkle leaf wants it). Throws if the count is off. */
export function resultsObject(resultString, questions) {
  const segs = splitLedgerResults(resultString);
  if (segs.length !== questions.length) throw new Error("wrong number of answers for the question order");
  return Object.fromEntries(questions.map((q, i) => [q.id, segs[i]]));
}

/**
 * Merkle leaf = keccak256(JCS({electionCode, ballotCode, results, imageSha256, recordSha256, reviewed})), hashes without 0x (@beings/core entryLeaf).
 * records: [{ ballotKey, results (corrections applied), imageSha256, recordSha256, reviewed }]; codes: the full election file's ballotCodes.
 * keccak: (Uint8Array) -> 0x hex;  ballotKeyOf: (code) -> 0x keccak256 of its UTF-8.
 */
export function ledgerMerkle({ electionCode, records, codes, questions, keccak }) {
  const byKey = new Map(codes.map((c) => [keccak(utf8(c)).toLowerCase(), c]));
  const leaves = [];
  let unknown = 0;
  for (const r of records) {
    const code = byKey.get(r.ballotKey.toLowerCase());
    if (!code) {
      unknown++;
      continue;
    }
    const entry = { electionCode, ballotCode: code, results: resultsObject(r.results, questions), imageSha256: normHash(r.imageSha256), recordSha256: normHash(r.recordSha256), reviewed: !!r.reviewed };
    leaves.push(keccak(utf8(canonicalize(entry))));
  }
  return { root: merkleRoot(leaves, keccak), leaves: leaves.length, unknown };
}

// ------------------------------------------------------------------ ZIP (store only, no compression): bulk image download without a build step
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, bytes: Uint8Array }]. Names are plain ASCII/UTF-8 file names. Returns the .zip bytes. */
export function buildZip(files, date = new Date(0)) {
  const dosTime = ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.bytes.length, true);
    local.setUint32(22, f.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.bytes.length, true);
    c.setUint32(24, f.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.bytes.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) (out.set(p, at), (at += p.length));
  return out;
}

// ------------------------------------------------------------------ election file (admin)
export const IMAGE_RETENTION_MAX_DAYS = 365; // the site's default MAX_RETENTION_DAYS (src/config.ts)
export const DEFAULT_IMAGE_RETENTION_DAYS = 30;
export const PUBLIC_IMAGE_RETENTION_MIN_DAYS = 30;
export const PUBLIC_IMAGE_RETENTION_MAX_DAYS = 60;

/** True only when the election file explicitly sets publicBallotImages: true. Missing means off. */
export function isPublicBallotImages(file) {
  return file?.publicBallotImages === true;
}

export function retentionRange(publicOn, maxSiteDays = IMAGE_RETENTION_MAX_DAYS) {
  return publicOn
    ? { min: PUBLIC_IMAGE_RETENTION_MIN_DAYS, max: Math.min(PUBLIC_IMAGE_RETENTION_MAX_DAYS, maxSiteDays) }
    : { min: 1, max: maxSiteDays };
}

/** 64 lower-case hex characters, accepting an optional 0x prefix and mixed case. */
export function normalizeImageSha256(input) {
  const s = String(input ?? "").trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

export function newElectionCode(year, randomBytes) {
  const b = randomBytes(6);
  let s = "";
  for (const x of b) s += CROCKFORD[x & 31];
  return `BEINGS-${year}-${s}`;
}

export function newBallotCodes(count, randomBytes) {
  const seen = new Set();
  while (seen.size < count) {
    const b = randomBytes(12);
    let s = "";
    for (const x of b) s += CROCKFORD[x & 31];
    seen.add(s);
  }
  return [...seen];
}

const BALLOT_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const ELECTION_RE = /^BEINGS-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{6}$/;

/** Unix seconds from an RFC 3339 string, or null. */
export function unixFromIso(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(String(s)) ? Math.floor(t / 1000) : null;
}

/** Problems with an election file before it goes anywhere near the ledger. Empty list = fine to create. */
export function validateElectionFile(f, { maxRetentionDays = IMAGE_RETENTION_MAX_DAYS } = {}) {
  const p = [];
  const bad = (field, message) => p.push({ field, message });
  if (!f || typeof f !== "object") return [{ field: "file", message: "This isn't an election file." }];
  if (!ELECTION_RE.test(f.electionCode ?? "")) bad("electionCode", "The election code must look like BEINGS-2026-ABC123.");
  if (typeof f.name !== "string" || !f.name.trim() || f.name.length > 200) bad("name", "Give the election a name (up to 200 characters).");
  if (!Array.isArray(f.questions) || f.questions.length === 0) bad("questions", "Add at least one question.");
  else if (f.questions.length > 255) bad("questions", "At most 255 questions.");
  else {
    const ids = new Set();
    f.questions.forEach((q, i) => {
      const n = i + 1;
      if (!/^q[0-9]{1,3}$/.test(q.id ?? "") || ids.has(q.id)) bad(`question ${n}`, "Every question needs its own id (q1, q2, …).");
      ids.add(q.id);
      if (!q.text?.trim()) bad(`question ${n}`, "Write the question.");
      if (!Array.isArray(q.choices) || q.choices.length < 2) bad(`question ${n}`, "A question needs at least two choices.");
      else {
        if (q.choices.some((c) => !/^c[0-9]{1,3}$/.test(c.id ?? "")) || new Set(q.choices.map((c) => c.id)).size !== q.choices.length) bad(`question ${n}`, "Choice ids must be different.");
        if (q.choices.some((c) => !c.text?.trim())) bad(`question ${n}`, "Every choice needs text.");
        if (!Number.isInteger(q.maxMarks) || q.maxMarks < 1 || q.maxMarks > q.choices.length) bad(`question ${n}`, "Marks allowed must be at least 1 and no more than the number of choices.");
      }
    });
  }
  if (!nonNegInt(f.registeredVoters)) bad("registeredVoters", "Registered voters must be a whole number (0 if no register is used).");
  if (!Number.isInteger(f.quorum) || f.quorum < 1 || f.quorum > 4) bad("quorum", "Local Scanner/Printer stations that must be registered: between 1 and 4.");
  if (!Array.isArray(f.approvedAppHashes) || f.approvedAppHashes.length < 1 || f.approvedAppHashes.some((x) => !/^[0-9a-f]{64}$/.test(x))) bad("approvedAppHashes", "Add at least one approved scanner-app fingerprint (64 lower-case hex characters).");
  if (!isAddress(f.organizerPublicKey)) bad("organizerPublicKey", "The organizer address isn't valid.");
  const o = unixFromIso(f.opensAt);
  const c = unixFromIso(f.closesAt);
  if (o == null) bad("opensAt", "Opening time isn't a valid date and time.");
  if (c == null) bad("closesAt", "Closing time isn't a valid date and time.");
  if (o != null && c != null && c <= o) bad("closesAt", "Voting has to close after it opens.");
  if (!Array.isArray(f.ballotCodes) || f.ballotCodes.length === 0) bad("ballotCodes", "The file needs its list of ballot codes.");
  else {
    if (f.ballotCodes.some((x) => !BALLOT_RE.test(x))) bad("ballotCodes", "Some ballot codes aren't 12 letters and numbers.");
    if (new Set(f.ballotCodes).size !== f.ballotCodes.length) bad("ballotCodes", "Ballot codes must all be different.");
    if (nonNegInt(f.registeredVoters) && f.registeredVoters > f.ballotCodes.length) bad("ballotCodes", "There are fewer ballots than registered voters.");
  }
  if (f.layoutHash != null && !HEX64_RE.test(f.layoutHash)) bad("layoutHash", "The ballot layout fingerprint must be 64 hex characters.");
  if (f.layoutHash == null) bad("layoutHash", "Add the ballot layout fingerprint (SHA-256 of the layout file) so the ledger covers what was printed.");
  if (f.publicBallotImages != null && typeof f.publicBallotImages !== "boolean") bad("publicBallotImages", "Public ballot images must be yes or no.");
  const publicOn = f.publicBallotImages === true;
  const range = retentionRange(publicOn, maxRetentionDays);
  const r = f.imageRetention;
  if (!r) bad("imageRetention", "Say how many days ballot images are kept.");
  else if (!Number.isInteger(r.days) || r.days < range.min || r.days > range.max) {
    bad("imageRetention", publicOn
      ? `When ballot pictures are public, they can only be kept ${range.min} to ${range.max} days.`
      : `Image retention must be 1 to ${maxRetentionDays} days.`);
  } else if (!["delete", "officials-hold"].includes(r.afterRetention) || !["jurisdiction-rules", "organizer-policy"].includes(r.basis)) bad("imageRetention", "Retention needs a basis and an after-retention choice.");
  return p;
}

/** The pieces of ElectionRegistry.createElection. fileSha256 / ballotListRoot are computed by the caller (async hashing). */
export function createElectionArgs(file, { cid, fileSha256, ballotListRoot }) {
  return [file.electionCode, cid, fileSha256, file.ballotCodes.length, file.registeredVoters, file.quorum, unixFromIso(file.opensAt), unixFromIso(file.closesAt), ballotListRoot];
}

/** `createPooledElection` when this registry has the ballot-pool flag, otherwise the original `createElection`. */
export function createElectionCall(file, computed, poolEnforced) {
  return { method: poolEnforced ? "createPooledElection" : "createElection", args: createElectionArgs(file, computed) };
}

/** A copy of the election file that is safe to publish: the secret ballot codes, including any added later, removed. */
export function publicElectionCopy(file) {
  const { ballotCodes, addedBallotPools, ...rest } = file;
  const added = addedPoolCount({ addedBallotPools });
  const copy = { ...rest, ballotCount: (ballotCodes?.length ?? 0) + added };
  if (added > 0) {
    copy.addedBallotCount = added;
    copy.addedBallotRoots = (addedBallotPools ?? []).map((pool) => ({
      count: Array.isArray(pool?.codes) ? pool.codes.length : Array.isArray(pool) ? pool.length : 0,
      ...(isBytes32(pool?.root) ? { root: String(pool.root).toLowerCase() } : {}),
    }));
  }
  return copy;
}

/** Plain facts about the file for the "view election" panel. */
export function summarizeElectionFile(f) {
  return {
    name: f.name,
    code: f.electionCode,
    questions: (f.questions ?? []).map((q) => ({ id: q.id, text: q.text, maxMarks: q.maxMarks, choices: (q.choices ?? []).map((c) => ({ id: c.id, text: c.text })) })),
    questionCount: (f.questions ?? []).length,
    choiceCount: (f.questions ?? []).reduce((n, q) => n + (q.choices?.length ?? 0), 0),
    registeredVoters: f.registeredVoters,
    ballotCount: f.ballotCodes?.length ?? null,
    quorum: f.quorum,
    layoutHash: f.layoutHash ?? null,
    retentionDays: f.imageRetention?.days ?? null,
    afterRetention: f.imageRetention?.afterRetention ?? null,
    publicBallotImages: f.publicBallotImages === true,
    hasBallotCodes: Array.isArray(f.ballotCodes),
  };
}

/** Day the stored images are due to be deleted: days after the election closes. */
export function retentionDeadline(closesAtUnix, days) {
  if (!closesAtUnix || !Number.isInteger(days) || days < 1) return null;
  return closesAtUnix + days * 86400;
}

/** Spare ballots default: 0% (:James-Hugh: Lamb., 10 Nov 2026). Used when the designer is skipped or the box is left empty. */
export const DEFAULT_SPARE_PERCENT = 0;
/** Ballots to print: registered voters plus a spare percentage, rounded up, at least 1. Same formula as before. */
export function printedBallots(registered, sparePercent = DEFAULT_SPARE_PERCENT) {
  const r = Number(registered);
  const sp = String(sparePercent ?? "").trim() === "" || !Number.isFinite(Number(sparePercent)) ? DEFAULT_SPARE_PERCENT : Math.max(0, Number(sparePercent));
  return Math.max(Math.ceil((Number.isFinite(r) && r > 0 ? r : 0) * (1 + sp / 100)), 1);
}
/** Build an election file from the admin form values. Defaults match the test election. */
export function draftElectionFile(v) {
  const questions = v.questions.map((q, i) => ({
    id: `q${i + 1}`,
    text: q.text.trim(),
    maxMarks: q.maxMarks,
    choices: q.choices.map((c, j) => ({ id: `c${j + 1}`, text: c.trim() })),
  }));
  return {
    schemaVersion: "0.1",
    version: 1,
    name: v.name.trim(),
    organizerPublicKey: v.organizer,
    questions,
    resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"], abstainButton: false },
    privacy: { redactImages: true, publishOrder: "sorted", timeGranularity: "event", minBreakdownSize: 10 },
    imageRetention: { basis: "organizer-policy", days: v.retentionDays, afterRetention: "delete" },
    publicBallotImages: v.publicBallotImages === true,
    registeredVoters: v.registeredVoters,
    approvedAppHashes: v.approvedAppHashes ?? [],
    quorum: v.quorum,
    opensAt: v.opensAt,
    closesAt: v.closesAt,
    electionCode: v.electionCode,
    ballotCodes: [...v.ballotCodes].sort(),
    layoutHash: v.layoutHash,
  };
}

// ------------------------------------------------------------------ network health (system admin)
/** "fresh" under half a minute, "slow" under five, "stale" after that (Coston2 makes a block about every 1.8 s). */
export function blockFreshness(ageSeconds) {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return "unknown";
  return ageSeconds < 30 ? "fresh" : ageSeconds < 300 ? "slow" : "stale";
}

export function ageText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

/** Are the four contracts wired to each other as config.js says? facts = what each contract reports about its neighbours. */
export function wiringChecks(contracts, facts) {
  const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  return [
    { id: "registry.ledger", label: "ElectionRegistry points at this BallotLedger", pass: eq(facts.registryLedger, contracts.ledger) },
    { id: "registry.tally", label: "ElectionRegistry points at this Tally", pass: eq(facts.registryTally, contracts.tally) },
    { id: "ledger.registry", label: "BallotLedger reads this ElectionRegistry", pass: eq(facts.ledgerRegistry, contracts.registry) },
    { id: "tally.registry", label: "Tally reads this ElectionRegistry", pass: eq(facts.tallyRegistry, contracts.registry) },
    { id: "tally.ledger", label: "Tally reads this BallotLedger", pass: eq(facts.tallyLedger, contracts.ledger) },
  ];
}

export function shortList(items, max = 3) {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

// ------------------------------------------------------------------ phone wallets (WalletConnect)
/** A WalletConnect / Reown project ID is 32 hex characters (copied from cloud.reown.com). Anything else counts as "not set". */
export function isWalletConnectProjectId(v) {
  return typeof v === "string" && /^[0-9a-f]{32}$/i.test(v.trim());
}

/** True when the site has a usable project ID in its public settings, so the phone-wallet option can be shown. */
export function walletConnectConfigured(config) {
  return isWalletConnectProjectId(config?.walletConnectProjectId);
}

/** Which ways of connecting to offer. `reason` is the plain-words note shown when an option is off. */
export function walletChoices({ hasInjected, projectId }) {
  const phoneOn = isWalletConnectProjectId(projectId);
  return {
    browser: {
      available: !!hasInjected,
      reason: hasInjected ? "" : "No browser wallet was found in this browser. A wallet extension such as MetaMask, or a wallet app's built-in browser, provides one.",
    },
    phone: {
      available: phoneOn,
      reason: phoneOn ? "" : "Connecting a phone wallet with a QR code isn't switched on for this site yet.",
    },
  };
}

/** Phones and tablets, including iPads that pretend to be Macs. Only used to decide what to show first, never to block anything. */
export function isMobileDevice(userAgent, maxTouchPoints = 0, platform = "") {
  const ua = String(userAgent ?? "");
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return true;
  return /Mac/i.test(String(platform)) && Number(maxTouchPoints) > 1;
}

/**
 * Links that open a phone wallet app straight onto a WalletConnect pairing link. `uri` is the `wc:…` string.
 * Bifrost is first: it is Flare's wallet, and its docs say to open it with `bifrostwallet://wc?uri=`
 * (https://docs.bifrostwallet.com/integrate/walletconnect/connect/). The raw `wc:` link stays for "Open your wallet app".
 */
export function walletDeepLinks(uri) {
  if (typeof uri !== "string" || !/^wc:[^\s]+$/.test(uri)) return [];
  const q = encodeURIComponent(uri);
  return [
    { id: "bifrost", name: "Bifrost Wallet", href: `bifrostwallet://wc?uri=${q}` },
    { id: "any", name: "My wallet app", href: uri },
    { id: "metamask", name: "MetaMask", href: `https://metamask.app.link/wc?uri=${q}` },
    { id: "trust", name: "Trust Wallet", href: `https://link.trustwallet.com/wc?uri=${q}` },
    { id: "rainbow", name: "Rainbow", href: `https://rnbwapp.com/wc?uri=${q}` },
  ];
}

/** A QR matrix (rows of booleans, true = dark) as ONE SVG path, so the code can be drawn without inline styles or markup strings. */
export function qrSvgPath(matrix, quiet = 4) {
  const n = Array.isArray(matrix) ? matrix.length : 0;
  if (!n || matrix.some((row) => !Array.isArray(row) || row.length !== n)) throw new Error("The QR matrix must be square.");
  const parts = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!matrix[y][x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && matrix[y][x]) x++; // one rectangle per run of dark modules keeps the path short
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`);
    }
  }
  return { size: n + quiet * 2, d: parts.join("") };
}

/** Options for the WalletConnect provider: Coston2 is "optional" so a wallet that doesn't list it can still connect and be asked to switch. */
export function walletConnectOptions(config, origin) {
  return {
    projectId: String(config.walletConnectProjectId).trim(),
    optionalChains: [config.chainId],
    showQrModal: false, // the site draws its own QR dialog (the library's pop-up needs inline styles the CSP forbids)
    rpcMap: { [config.chainId]: config.rpcUrl },
    metadata: {
      name: "B.E.I.N.G.S.",
      description: "Blockchain-audited paper ballots (Coston2 test network)",
      url: origin,
      icons: [`${origin}/favicon.svg`],
    },
  };
}

/** What the browser remembers about the last connection: "browser", "walletconnect" or nothing. ("1" is what the first version stored.) */
export function savedWalletKind(raw) {
  if (raw === "1" || raw === "browser") return "browser";
  if (raw === "walletconnect") return "walletconnect";
  return null;
}

/** Shown with a failed connection so a blocked relay is not mistaken for a broken site. */
export const WALLET_FIREWALL_NOTE = "If a firewall is blocking the connection, allow relay.walletconnect.org and relay.walletconnect.com, then try again.";

/** The wallet's own reason, plus a short firewall note. A decline stays a decline and does not add the note. */
export function explainWalletConnectError(e) {
  const msg = String(e?.message ?? e ?? "").trim();
  if (isUserRejected(e) || /declin/i.test(msg)) return "The request was declined in your wallet. Nothing was shared.";
  const reason = !msg || msg === "undefined" ? "The wallet connection failed." : msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
  return `${reason} ${WALLET_FIREWALL_NOTE}`;
}

// ------------------------------------------------------------------ printed ballots: import an existing election file, then sign one reading
// The "Create a new election" form mints new ballot codes. This path keeps the codes already printed.
// Nothing here talks to a wallet or the network.

const RESULT_KIND = { B: "blank", O: "overvote", U: "unclear", V: "valid" };

/** EIP-712 Reading, the same type the ledger checks. `verifyingContract` is the BallotLedger address. */
export const READING_TYPES = {
  Reading: [
    { name: "electionKey", type: "bytes32" },
    { name: "ballotKey", type: "bytes32" },
    { name: "resultsHash", type: "bytes32" },
    { name: "imageSha256", type: "bytes32" },
    { name: "scoresHash", type: "bytes32" },
  ],
};

export function readingTypedData({ electionKey, ballotKey, resultsHash, imageSha256, scoresHash, verifyingContract }) {
  if (!isAddress(verifyingContract)) throw new Error("The ledger address is missing, so this reading cannot be signed.");
  return {
    domain: { name: "B.E.I.N.G.S.", version: "1", chainId: 114, verifyingContract },
    types: READING_TYPES,
    primaryType: "Reading",
    message: { electionKey, ballotKey, resultsHash, imageSha256, scoresHash },
  };
}

/** Fingerprint of the printed code list. `keccak` is (Uint8Array) -> 0x hex, the same one the Merkle helper uses. */
export function ballotListRootOf(codes, keccak) {
  return merkleRoot(codes.map((c) => keccak(utf8(c))), keccak);
}

/** A copy of the file with a new opening and closing time. Codes, questions and layout fingerprint stay put. */
export function withSchedule(file, opensAt, closesAt) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("This isn't an election file.");
  return { ...file, opensAt, closesAt };
}

/** Pull the election file out of a raw file or a `{ file }` wrapper. Public copies and readings files are refused. */
export function unwrapElectionImport(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "This file isn't an election file." };
  if (json.publicCopy) return { error: "This is the public copy. The ballot codes were removed, so it cannot register the printed ballots. Use the full file." };
  if (Array.isArray(json.readings) && !Array.isArray(json.ballotCodes)) return { error: "This is a readings file. Choose it in the readings step, not as the election file." };
  const file = Array.isArray(json.ballotCodes) ? json : json.file;
  if (!file || typeof file !== "object" || !Array.isArray(file.ballotCodes)) return { error: "This file has no ballot codes. The printed ballots cannot be registered from it." };
  return { file };
}

/**
 * Whether this file may be registered.
 * A manifest fingerprint that disagrees is a problem only when the schedule was not deliberately edited:
 * editing the schedule produces a new fingerprint on purpose, and the ballot-list root must still match.
 */
export function importProblems({ file, manifest, fileSha256, ballotListRoot, datesChanged, baselineSha256 }) {
  const problems = validateElectionFile(file);
  const ce = manifest?.createElection ?? null;
  if (manifest && !ce) problems.push({ field: "manifest", message: "This manifest has no createElection block." });
  if (ce) {
    if (ce.electionCode && ce.electionCode !== file.electionCode) problems.push({ field: "manifest", message: "The manifest is for a different election code." });
    if (ce.ballotListRoot && String(ce.ballotListRoot).toLowerCase() !== String(ballotListRoot).toLowerCase()) problems.push({ field: "ballotListRoot", message: "The ballot-list fingerprint does not match the codes in this file." });
    if (ce.ballotCount != null && Number(ce.ballotCount) !== file.ballotCodes.length) problems.push({ field: "ballotCount", message: "The manifest's ballot count does not match this file." });
    const claimed = normHash(ce.fileSha256);
    const got = normHash(fileSha256);
    const baseline = normHash(baselineSha256);
    // A new fingerprint is accepted only when the schedule changed and the file, with the old schedule put back, still matches the manifest.
    if (claimed && got && claimed !== got && !(datesChanged && baseline === claimed)) problems.push({ field: "fileSha256", message: "The file fingerprint does not match the manifest. The file was changed, or this is a different file." });
  }
  return problems;
}

/** How an on-chain election compares with the file in hand. `chain` null means it is not registered. */
export function chainAgrees(file, chain, { fileSha256, ballotListRoot }) {
  if (!chain) return { state: "absent" };
  const sameRoot = String(chain.ballotListRoot).toLowerCase() === String(ballotListRoot).toLowerCase();
  const sameFile = normHash(chain.fileSha256 ?? chain.version?.fileSha256) === normHash(fileSha256);
  const sameCount = Number(chain.ballotCount) === file.ballotCodes.length + addedPoolCount(file);
  const sameCode = chain.code === file.electionCode;
  if (sameRoot && sameFile && sameCount && sameCode) return { state: "match" };
  return { state: "conflict", sameRoot, sameFile, sameCount, sameCode };
}

function choiceNumber(id) {
  return Number(String(id).slice(1));
}

function formatChoices(ids) {
  const sorted = [...ids].sort((a, b) => choiceNumber(a) - choiceNumber(b));
  return `V:${sorted.join("+")}`;
}

/** The result one question must have, from its fill scores and the election's own thresholds. Does not "fix" a mark. */
export function deriveQuestion(scores, maxMarks, rules) {
  const marked = [];
  let unclear = 0;
  for (const [id, score] of Object.entries(scores)) {
    if (!Number.isInteger(score) || score < 0 || score > 100) return { error: "a fill score is not a whole number from 0 to 100" };
    const state = score > rules.markedAbove ? "marked" : score < rules.emptyBelow ? "empty" : "unclear";
    if (state === "marked") marked.push(id);
    else if (state === "unclear") unclear += 1;
  }
  if (marked.length > maxMarks) return { result: "O" };
  if (unclear > 0) return { result: "U" };
  if (marked.length === 0) return { result: "B" };
  const result = formatChoices(marked);
  if (!parseResult(result)) return { error: "the marked choices are not a valid result" };
  return { result };
}

function bareHash(v) {
  return normHash(v);
}

function as0x(hex) {
  const h = bareHash(hex);
  return h ? `0x${h}` : null;
}

/** One reading from an omr result, a readings list, or `{ readings: [...] }`. */
export function unwrapReadings(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.readings)) return json.readings;
  if (json && typeof json === "object" && json.fillScores && (json.ballotCode || json.results || json.resultsString)) return [json];
  return null;
}

/**
 * Check one reading against the election file and recompute its hashes.
 * A supplied result that is not what the scores produce under the file's thresholds is rejected.
 * `keccak` is (Uint8Array) -> 0x hex.
 */
export function assessReading(raw, file, keccak) {
  const problems = [];
  const bad = (message) => problems.push(message);
  if (!raw || typeof raw !== "object") return { problems: ["This entry isn't a reading."] };
  const code = typeof raw.ballotCode === "string" ? raw.ballotCode.replace(/[\s-]/g, "").toUpperCase() : "";
  if (!BALLOT_RE.test(code)) bad("The ballot code isn't 12 letters and numbers.");
  else if (!file.ballotCodes.includes(code)) bad("This ballot code is not in the election file.");
  const scores = raw.fillScores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) bad("Fill scores are missing.");
  const supplied = raw.results && typeof raw.results === "object" && !Array.isArray(raw.results) ? raw.results : null;
  const rules = file.resultRules;
  if (!rules || !Number.isInteger(rules.emptyBelow) || !Number.isInteger(rules.markedAbove)) bad("The election file has no mark thresholds.");
  const derived = {};
  if (scores && rules && Array.isArray(file.questions)) {
    const known = new Set(file.questions.map((q) => q.id));
    for (const id of Object.keys(scores)) if (!known.has(id)) bad(`Fill scores include ${id}, which is not a question in this election.`);
    for (const q of file.questions) {
      const row = scores[q.id];
      if (!row || typeof row !== "object") {
        bad(`Fill scores are missing ${q.id}.`);
        continue;
      }
      const want = new Set((q.choices ?? []).map((c) => c.id));
      const got = Object.keys(row);
      if (got.length !== want.size || got.some((c) => !want.has(c))) bad(`Fill scores for ${q.id} don't match its choices.`);
      const one = deriveQuestion(row, q.maxMarks, rules);
      if (one.error) bad(`${q.id}: ${one.error}`);
      else derived[q.id] = one.result;
      if (supplied && supplied[q.id] !== undefined && one.result && supplied[q.id] !== one.result) bad(`${q.id} says ${supplied[q.id]} but the scores produce ${one.result}. The reading was not changed.`);
    }
  }
  const results = derived;
  if (supplied) {
    for (const q of file.questions ?? []) {
      if (!(q.id in supplied)) bad(`The result for ${q.id} is missing.`);
      else if (!parseResult(supplied[q.id])) bad(`The result for ${q.id} isn't a valid B, O, U or V entry.`);
    }
  }
  const order = (file.questions ?? []).map((q) => q.id);
  let resultsString = null;
  if (!problems.length) {
    resultsString = order.map((q) => results[q]).join("|");
    if (typeof raw.resultsString === "string" && raw.resultsString !== resultsString) bad("The joined result string does not match the scores. The reading was not changed.");
  }
  const image = bareHash(raw.imageSha256);
  if (!image) bad("The picture fingerprint must be 64 hex characters.");
  let scoresHash = null;
  let resultsHash = null;
  let ballotKey = null;
  let electionKey = null;
  if (!problems.length) {
    scoresHash = keccak(utf8(canonicalize(scores))).toLowerCase();
    resultsHash = keccak(utf8(resultsString)).toLowerCase();
    ballotKey = keccak(utf8(code)).toLowerCase();
    electionKey = keccak(utf8(file.electionCode)).toLowerCase();
    const claimedScores = as0x(raw.scoresHash);
    const claimedResults = as0x(raw.resultsHash);
    if (claimedScores && claimedScores !== scoresHash) bad("The scores fingerprint in the file does not match these scores.");
    if (claimedResults && claimedResults !== resultsHash) bad("The results fingerprint in the file does not match these results.");
  }
  if (raw.electionCode && raw.electionCode !== file.electionCode) bad("This reading names a different election.");
  if (problems.length) return { problems };
  const counts = { B: 0, O: 0, U: 0, V: 0 };
  for (const q of order) counts[results[q] === "B" || results[q] === "O" || results[q] === "U" ? results[q] : "V"] += 1;
  return {
    problems: [],
    reading: {
      scan: Number.isInteger(raw.scan) ? raw.scan : null,
      ballotCode: code,
      ballotKey,
      electionKey,
      results,
      resultsString,
      fillScores: scores,
      imageSha256: image,
      scoresHash,
      resultsHash,
      counts,
    },
  };
}

/** Check a whole readings file. Duplicate ballot codes are refused. Problems name the row, not the code. */
export function assessReadings(json, file, keccak) {
  const list = unwrapReadings(json);
  if (!list) return { problems: ["This isn't a readings file."], readings: [] };
  if (list.length === 0) return { problems: ["The readings file is empty."], readings: [] };
  const problems = [];
  const readings = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    const label = Number.isInteger(raw?.scan) ? `Scan ${raw.scan}` : `Row ${i + 1}`;
    const one = assessReading(raw, file, keccak);
    if (one.problems.length) {
      for (const p of one.problems) problems.push(`${label}: ${p}`);
      return;
    }
    if (seen.has(one.reading.ballotCode)) problems.push(`${label}: the same ballot appears more than once in this file.`);
    seen.add(one.reading.ballotCode);
    readings.push(one.reading);
  });
  return { problems, readings };
}

/** Totals of blank, overvote, unclear and ordinary answers. Not a winner. */
export function readingTally(readings) {
  const out = { ballots: readings.length, B: 0, O: 0, U: 0, V: 0 };
  for (const r of readings) for (const k of ["B", "O", "U", "V"]) out[k] += r.counts[k];
  return out;
}

/**
 * Whether one signed reading may be submitted. `status` is the registry enum (2 = open).
 * `role` 1 = scanning wallet. `quorum` above 1 needs more signatures than this screen collects.
 */
export function submissionGate({ chainId, verifyingContract, ledger, role, status, found, spoiled, quorum, signer, device, approvedScanners = null }) {
  if (chainId !== 114) return { ok: false, reason: "The wallet is not on Coston2 (chain id 114). Nothing was signed or sent." };
  if (!ledger || !verifyingContract || String(verifyingContract).toLowerCase() !== String(ledger).toLowerCase()) return { ok: false, reason: "The signature is not for this site's ballot ledger. Nothing was sent." };
  if (spoiled) return { ok: false, reason: "This ballot is marked spoiled on the ledger. It was not submitted again." };
  if (found) return { ok: false, reason: "This ballot is already on the ledger. It was not submitted again." };
  if (status !== 2) return { ok: false, reason: "Voting is not open for this election yet. Register the scanning wallet and open voting first. Nothing was sent." };
  if (role !== 1) return { ok: false, reason: "This wallet is not a registered scanning wallet for this election. Register it on the admin page before voting opens. Nothing was sent." };
  if (Array.isArray(approvedScanners) && approvedScanners.length > 0 && !approvedScanners.some((a) => a && device && String(a).toLowerCase() === String(device).toLowerCase())) {
    return { ok: false, reason: "This wallet is not an approved Scanner operator on the election roster. Nothing was sent." };
  }
  if (!quorum || quorum > 1) return { ok: false, reason: "This election needs more than one scanning wallet to agree, and this screen signs with the one wallet you connected. Nothing was sent." };
  if (!signer || !device || signer.toLowerCase() !== device.toLowerCase()) return { ok: false, reason: "The signature is not from the connected wallet. Nothing was sent." };
  return { ok: true };
}

/** The ballot record whose SHA-256 is stored on the ledger. The signature is already inside it. */
export function ballotRecord({ electionCode, ballotCode, results, fillScores, imageSha256, device, signature }) {
  return {
    schemaVersion: "0.1",
    electionCode,
    ballotCode,
    results,
    readings: [{ device, imageSha256, fillScores, results, signature }],
    review: { required: false },
  };
}

/** Arguments for BallotLedger.submitRecord: one reading, no reviewer. */
export function submitRecordArgs({ electionKey, ballotKey, resultsString, imageSha256, recordSha256, scoresHash, device, signature, proof = null, rootIndex = 0 }) {
  const zero = "0x0000000000000000000000000000000000000000";
  const submission = [electionKey, ballotKey, resultsString, imageSha256, recordSha256, [[device, imageSha256, scoresHash, signature]], zero, "0x"];
  if (Array.isArray(proof)) return [submission, proof, rootIndex];
  return [submission];
}

const KIND_WORD = RESULT_KIND;
/** A wallet step counts only when it actually returned a signature or a sent transaction. */
export function walletProduced(step, field) {
  if (!step || step.status === "cancelled" || step.status === "failed") return null;
  const value = step[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resultWord(result) {
  if (result === "B" || result === "O" || result === "U") return KIND_WORD[result];
  return "a filled choice";
}

/**
 * Plain text for a failed ballot-image download. The ledger entry is already on screen;
 * none of these messages replace it.
 */
export function ballotImageFailure(status, errorText, bodyIsJson = true) {
  if (status === 410) {
    return { tone: "info", title: "Image expired", text: "Ballot pictures are kept for a limited time, then removed. Fingerprints and readings stay on the chain." };
  }
  if (status === 404 && !bodyIsJson) {
    return { tone: "warn", title: "This page has no picture service", text: "The answers above are from the ledger. This website did not answer with the image service, so this does not mean the scan is missing from the public site." };
  }
  if (status === 404) {
    return { tone: "info", title: "No picture is stored for this ballot (yet)", text: errorText || "The ledger has your entry, but the scan image isn't available from this site." };
  }
  if (status === 429) return { tone: "warn", title: "Too many lookups", text: "Please wait a minute and try again." };
  return { tone: "warn", title: "We couldn't load the picture", text: errorText || `The image service answered ${status}. Your ledger entry above is not affected.` };
}

/** Compare a downloaded picture's SHA-256 with the hash stored on the ledger. */
export function pictureMatchesLedger(actualHex, ledgerHex) {
  const onChain = String(ledgerHex ?? "").toLowerCase().replace(/^0x/, "");
  const got = String(actualHex ?? "").toLowerCase().replace(/^0x/, "");
  return { matches: got.length === 64 && got === onChain, hex: got, onChain };
}

/**
 * One ballot's optional picture. Nothing is fetched until `load`. A second `load` while
 * the first is running does not fetch again. `reset` (a new ballot lookup) makes the
 * in-flight result stale and hands back any object URL the page must revoke.
 */
export function createBallotImageView() {
  let generation = 0;
  let inflight = false;
  let objectUrl = null;
  return {
    reset() {
      generation += 1;
      inflight = false;
      const old = objectUrl;
      objectUrl = null;
      return old;
    },
    async load({ fetchImage, hashBytes, objectUrlFor, expectedHash }) {
      if (inflight) return { status: "duplicate" };
      const gen = generation;
      inflight = true;
      const stale = () => gen !== generation;
      try {
        const res = await fetchImage();
        if (stale()) return { status: "stale" };
        if (!res.ok) {
          let errorText = "";
          let bodyIsJson = false;
          try {
            const body = await res.json();
            bodyIsJson = !!body && typeof body === "object";
            errorText = typeof body?.error === "string" ? body.error : "";
          } catch {
            /* a static server's 404 page is not the image service */
          }
          if (stale()) return { status: "stale" };
          inflight = false;
          return { status: "error", ...ballotImageFailure(res.status, errorText, bodyIsJson) };
        }
        const bytes = await res.arrayBuffer();
        if (stale()) return { status: "stale" };
        const hex = await hashBytes(bytes);
        if (stale()) return { status: "stale" };
        const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : "";
        const url = objectUrlFor(bytes, type);
        if (stale()) return { status: "stale", revoke: url };
        const previous = objectUrl;
        objectUrl = url;
        inflight = false;
        return { status: "ready", url, type, previous, ...pictureMatchesLedger(hex, expectedHash) };
      } catch {
        if (stale()) return { status: "stale" };
        inflight = false;
        return { status: "error", tone: "warn", title: "We couldn't load the picture", text: "The image service didn't answer. Your ledger entry above is not affected." };
      }
    },
  };
}
