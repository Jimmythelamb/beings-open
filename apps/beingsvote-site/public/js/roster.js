// Election staff roster. Kept beside the election file, under the election code, on this computer.
// It is not a field of the fingerprinted election file: that file's schema rejects extra fields, and its
// fingerprint is fixed when the election is created. Names and wallets may be shown. Ballot codes must not.
//
// A staff member signs a claim with their own wallet, over a separate WalletConnect session. The Election
// Administrator then signs an approval with the wallet already connected on this computer. No contract checks
// either signature yet. The sentence people see is ROSTER_NOTE.
import { looksLikeBallotCode } from "./record.js";
import { ELECTION_CODE_RE } from "./format.js";
import { isAddress, isBytes32, sameAddress } from "./logic.js";

export const ROSTER_SCHEMA = "beings-staff-roster/1";
export const EXECUTIVE_STAFF_SCHEMA = "beings-executive-staff-record/1";
export const ROSTER_KEY_PREFIX = "beings.staffRoster.";

/** Same words as the Staff page System admin card, tooltip, and system page lead. */
export const SYSTEM_ADMIN_DUTY = "Sets up and monitors local resources and connections: scanner computers and helpers, printers, and the network and image-service connections. Has no authority over ballot choices or certification.";

/** Shown on every Election officer line, the same way the System admin duty is shown. */
export const OFFICER_DUTY = "Receives the printed ballots, gives them to voters, collects them, brings them to scanning and witnesses the scan, then stores the paper ballots in the required secure storage area.";

/** The Scanner operator runs the equipment. An Election officer still co-signs each print run and each scan batch. */
export const SCANNER_DUTY = "Runs the printer and scanner and the helper: prints blank ballots and feeds scan batches. Does not handle the paper alone. An Election officer co-signs each print run and each scan batch.";

/** Plain sentence under the roster controls, and the note stored with the public download. */
export const ROSTER_NOTE = "A line with no name is covered by the Election Administrator's sign-in. Once a name is entered, that person must link their own crypto-wallet by scanning the QR with Bifrost and signing, and you must approve them, before the position is active. Saved on this computer and in the election download. Readable names stay off the chain. Crypto-wallets, positions, and a fingerprint of this roster can be recorded on the roster contract.";

/** Shown with the roster. The salt itself is never in this sentence. */
export const NAME_SALT_NOTE = "Each name stored on the chain is a salted fingerprint. The salt stays in the confidential Executive staff record and on this computer. It is left out of the public download.";

export const EXECUTIVE_STAFF_NOTE = "Confidential Executive staff record. Each name salt stays in this file and on the administrator's computer. It is not in the public download and it is not written on the chain.";

/** Same words as ROSTER_NOTE. Kept so older imports still find the public note. */
export const SIGNING_GAP = ROSTER_NOTE;

export const ROSTER_ROLES = [
  { id: "admin", label: "Election Administrator", line: "Election Administrator" },
  { id: "officer", label: "Election officer", line: "Election officer", duty: OFFICER_DUTY },
  { id: "verifier", label: "Verifier", line: "Verifier" },
  { id: "scanner", label: "Scanner operator", line: "Scanner operator", duty: SCANNER_DUTY },
  { id: "system", label: "System admin", line: "System admin", duty: SYSTEM_ADMIN_DUTY },
];

/** Roles the administrator may add another line for. System admin and Election admin stay one line each. */
export const ADDABLE_ROLES = ["officer", "verifier", "scanner"];

const SIG = /^0x[0-9a-fA-F]{130}$/;
const NAME_RE = /^[\p{L}][\p{L}\p{M} .'-]{0,39}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE_RE = /^[0-9a-zA-Z]{16,64}$/;

/** Shown on the Election Administrator line and in Election admin step 1. */
export const REGISTER_ADMIN_LABEL = "Register your name and wallet to start an election";

/** Words used in the signed message when the election does not have an id yet. */
export const NEW_ELECTION_ID = "new election";

/** A registration signed before an election id exists, until it is copied onto a roster. */
export const PENDING_ADMIN_KEY = "beings.adminRegistration";
const roleIndex = Object.fromEntries(ROSTER_ROLES.map((r, i) => [r.id, i]));

/** Chosen once, then recorded on the roster contract. Empty until the administrator picks one. */
export const ELECTION_KINDS = ["standard", "test", "classroom"];

export function electionKindOf(roster) {
  const kind = roster?.electionKind;
  return ELECTION_KINDS.includes(kind) ? kind : "";
}

export function setElectionKind(roster, kind) {
  if (!ELECTION_KINDS.includes(kind)) throw new Error("Choose Standard, Test, or Classroom.");
  return { ...roster, electionKind: kind };
}

export const roleMeta = (id) => ROSTER_ROLES.find((r) => r.id === id) ?? null;
export const rosterStorageKey = (code) => `${ROSTER_KEY_PREFIX}${String(code ?? "").trim().toUpperCase()}`;

export function cleanName(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

const blankSeat = (role, id = role) => ({ id, role, firstName: "", lastName: "", address: "", nameSalt: "", claim: null, grant: null });

const SALT_RE = /^0x[0-9a-fA-F]{64}$/;

/** A stored salt, or "" when it is missing or all zeros. The salt never goes on the chain. */
export function readNameSalt(raw) {
  const salt = String(raw ?? "");
  if (!SALT_RE.test(salt) || /^0x0{64}$/i.test(salt)) return "";
  return salt;
}

/** 32 random bytes, hex-encoded. Generated in the browser for one staff entry. */
export function freshNameSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  if (/^0x0{64}$/i.test(hex)) return freshNameSalt();
  return hex;
}

/** Keep an existing salt. A named seat with none gets a new one. An unnamed seat keeps none. */
export function withNameSalts(roster, { randomSalt = freshNameSalt } = {}) {
  const seats = (roster?.seats ?? []).map((seat) => {
    const named = !!(cleanName(seat.firstName) && cleanName(seat.lastName));
    if (!named) return { ...seat, nameSalt: "" };
    const existing = readNameSalt(seat.nameSalt);
    if (existing) return { ...seat, nameSalt: existing };
    return { ...seat, nameSalt: randomSalt() };
  });
  return { ...roster, seats };
}

export function emptyRoster(electionCode, { organizerAddress = "" } = {}) {
  const seats = ROSTER_ROLES.map((r) => blankSeat(r.id));
  if (isAddress(organizerAddress)) seats[0].address = organizerAddress;
  return { schema: ROSTER_SCHEMA, electionCode: String(electionCode ?? "").trim().toUpperCase(), electionKind: "", seats };
}

export function positionLabel(role) {
  return roleMeta(role)?.line ?? String(role ?? "");
}

/** EIP-191 text the staff wallet signs. The address is not in the sentence; it is recovered from the signature. */
export function buildClaimMessage({ firstName, lastName, position, electionCode, nonce, signedAt }) {
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  const pos = String(position ?? "").trim();
  const code = String(electionCode ?? "").trim();
  const n = String(nonce ?? "").trim();
  const t = String(signedAt ?? "").trim();
  if (!first || !last) throw new Error("A staff claim needs a first and last name.");
  if (!pos) throw new Error("A staff claim needs a position.");
  if (!ELECTION_CODE_RE.test(code)) throw new Error("A staff claim needs an election code.");
  if (!NONCE_RE.test(n)) throw new Error("A staff claim needs a nonce.");
  if (!ISO_TIME.test(t)) throw new Error("A staff claim needs a time.");
  return `B.E.I.N.G.S. staff claim: I, ${first} ${last}, hold this wallet and accept the position ${pos} for election ${code}. Nonce ${n}, ${t}`;
}

/** EIP-191 text the Election Administrator signs with the wallet already connected on this computer. */
export function buildApprovalMessage({ adminName, adminWallet, firstName, lastName, staffWallet, position, electionCode, claimHash, signedAt }) {
  const name = cleanName(adminName);
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  const pos = String(position ?? "").trim();
  const code = String(electionCode ?? "").trim();
  const t = String(signedAt ?? "").trim();
  const hash = String(claimHash ?? "").trim();
  if (!name) throw new Error("Approval needs the Election Administrator's name.");
  if (!isAddress(adminWallet || "")) throw new Error("Approval needs the Election Administrator's wallet.");
  if (!first || !last) throw new Error("Approval needs the staff member's name.");
  if (!isAddress(staffWallet || "")) throw new Error("Approval needs the staff wallet.");
  if (!pos) throw new Error("Approval needs a position.");
  if (!ELECTION_CODE_RE.test(code)) throw new Error("Approval needs an election code.");
  if (!isBytes32(hash)) throw new Error("Approval needs the staff signature hash.");
  if (!ISO_TIME.test(t)) throw new Error("Approval needs a time.");
  return `B.E.I.N.G.S. staff approval: I, Election Administrator ${name} (${adminWallet}), verified the identity of ${first} ${last} in person and authorize wallet ${staffWallet} as ${pos} for election ${code}. Claim signature hash ${hash}. ${t}`;
}

export function claimMessage(seat, electionCode) {
  return buildClaimMessage({
    firstName: seat?.firstName,
    lastName: seat?.lastName,
    position: positionLabel(seat?.role),
    electionCode,
    nonce: seat?.claim?.nonce,
    signedAt: seat?.claim?.signedAt,
  });
}

/**
 * EIP-191 text the Election Administrator signs.
 * `electionId` is the election code, or the words "new election" when there is no id yet.
 * `at` is an ISO-8601 time, such as 2026-11-16T01:30:00.000Z.
 */
export function adminRegistrationMessage({ firstName, lastName, address, electionId, at }) {
  const name = `${cleanName(firstName)} ${cleanName(lastName)}`.trim();
  const id = String(electionId ?? "").trim();
  const election = !id || id.toLowerCase() === NEW_ELECTION_ID ? NEW_ELECTION_ID : id;
  return `B.E.I.N.G.S. Election Administrator registration: I, ${name}, hold wallet ${address} and will administer election ${election}. ${at}`;
}

const REG_RE = /^B\.E\.I\.N\.G\.S\. Election Administrator registration: I, (.+), hold wallet (0x[0-9a-fA-F]{40}) and will administer election (.+)\. (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** Pull the name, wallet, election id, and time back out of a registration message. */
export function parseAdminRegistration(message) {
  const m = REG_RE.exec(String(message ?? ""));
  if (!m || !ISO_TIME.test(m[4])) return null;
  return { name: m[1], address: m[2], electionId: m[3], at: m[4] };
}

/**
 * The stored message still describes this seat. A message signed as "new election" stays valid
 * after it is copied onto the roster for the election that was then given an id.
 */
export function registrationIsCurrent(seat, electionId) {
  const reg = seat?.registration;
  if (!reg || typeof reg !== "object" || reg.message == null) return false;
  const parsed = parseAdminRegistration(reg.message);
  if (!parsed || !SIG.test(String(reg.signature ?? ""))) return false;
  const name = `${cleanName(seat.firstName)} ${cleanName(seat.lastName)}`.trim();
  if (parsed.name !== name || !sameAddress(parsed.address, seat.address)) return false;
  const expected = !electionId || String(electionId).toLowerCase() === NEW_ELECTION_ID ? NEW_ELECTION_ID : String(electionId).trim();
  if (parsed.electionId !== expected && parsed.electionId !== NEW_ELECTION_ID) return false;
  if (parsed.electionId !== NEW_ELECTION_ID && expected !== NEW_ELECTION_ID && parsed.electionId !== expected) return false;
  const again = adminRegistrationMessage({ firstName: seat.firstName, lastName: seat.lastName, address: parsed.address, electionId: parsed.electionId, at: parsed.at });
  return reg.message === again;
}

export function approvalMessage(seat, electionCode, grantor) {
  return buildApprovalMessage({
    adminName: seat?.grant?.adminName,
    adminWallet: grantor || seat?.grant?.grantor,
    firstName: seat?.firstName,
    lastName: seat?.lastName,
    staffWallet: seat?.address,
    position: positionLabel(seat?.role),
    electionCode,
    claimHash: seat?.grant?.claimHash,
    signedAt: seat?.grant?.signedAt,
  });
}

/** @deprecated Use approvalMessage. The stored field is still `grant`. */
export function grantMessage(seat, electionCode, grantor) {
  return approvalMessage(seat, electionCode, grantor);
}

function sameHex(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function readClaim(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signature = String(raw.signature ?? "");
  const message = String(raw.message ?? "");
  if (!SIG.test(signature) || !message) return null;
  return {
    message,
    signature,
    address: isAddress(raw.address) ? raw.address : "",
    nonce: String(raw.nonce ?? ""),
    signedAt: String(raw.signedAt ?? ""),
  };
}

function readGrant(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signature = String(raw.signature ?? "");
  const message = String(raw.message ?? "");
  if (!SIG.test(signature) || !message || !isAddress(raw.grantor || "")) return null;
  return {
    message,
    signature,
    grantor: raw.grantor,
    signedAt: String(raw.signedAt ?? ""),
    claimHash: String(raw.claimHash ?? ""),
    adminName: cleanName(raw.adminName),
    adultAttested: raw.adultAttested === true,
  };
}

function readChainClaim(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signature = String(raw.signature ?? "");
  const nonce = String(raw.nonce ?? "");
  const nameHash = String(raw.nameHash ?? "");
  if (!SIG.test(signature) || !/^[1-9][0-9]{0,77}$/.test(nonce) || !isBytes32(nameHash)) return null;
  return { signature, nonce, nameHash };
}

function hashesMatch(seat, hashSignature) {
  if (typeof hashSignature !== "function") return true;
  try {
    return sameHex(String(hashSignature(seat.claim.signature) ?? ""), String(seat.grant?.claimHash ?? ""));
  } catch {
    return false;
  }
}

function recovers(message, signature, expected, verifyMessage) {
  if (typeof verifyMessage !== "function") return true;
  return signatureMatches(message, signature, expected, verifyMessage);
}

/** One seat per required role, plus extra officer, verifier, or scanner lines. Drops anything else. */
export function normalizeRoster(raw, { electionCode, organizerAddress = "" } = {}) {
  const code = String(electionCode || raw?.electionCode || "").trim().toUpperCase();
  const base = emptyRoster(code, { organizerAddress });
  if (!raw || typeof raw !== "object" || raw.schema !== ROSTER_SCHEMA || !Array.isArray(raw.seats)) return base;
  const incoming = raw.seats.filter((s) => s && typeof s === "object");
  const seats = ROSTER_ROLES.map((r) => {
    const found = incoming.find((s) => s.id === r.id && s.role === r.id) ?? incoming.find((s) => s.role === r.id && s.id === r.id);
    if (!found) return blankSeat(r.id);
    return {
      id: r.id,
      role: r.id,
      firstName: cleanName(found.firstName),
      lastName: cleanName(found.lastName),
      address: isAddress(found.address) ? found.address : "",
      claim: null,
      grant: null,
      chainClaim: null,
    };
  });
  const admin = seats[0];
  if (isAddress(organizerAddress) && !sameAddress(admin.address, organizerAddress)) {
    admin.address = organizerAddress;
  }
  const extras = [];
  for (const s of incoming) {
    if (!ADDABLE_ROLES.includes(s.role)) continue;
    if (typeof s.id !== "string" || !new RegExp(`^${s.role}-\\d+$`).test(s.id)) continue;
    if (seats.some((x) => x.id === s.id) || extras.some((x) => x.id === s.id)) continue;
    extras.push({
      id: s.id,
      role: s.role,
      firstName: cleanName(s.firstName),
      lastName: cleanName(s.lastName),
      address: isAddress(s.address) ? s.address : "",
      claim: null,
      grant: null,
      chainClaim: null,
    });
  }
  const originals = new Map(incoming.filter((s) => s.id).map((s) => [s.id, s]));
  for (const s of [...seats, ...extras]) {
    const src = originals.get(s.id);
    if (!src) continue;
    // Keep a signature that fails its check, so the page can warn instead of silently dropping it.
    s.claim = readClaim(src.claim);
    s.grant = readGrant(src.grant);
    s.chainClaim = readChainClaim(src.chainClaim);
    s.nameSalt = readNameSalt(src.nameSalt);
    s.registration = registrationIsCurrent({ ...s, registration: src.registration }, code) ? { message: src.registration.message, signature: src.registration.signature } : null;
  }
  const electionKind = ELECTION_KINDS.includes(raw.electionKind) ? raw.electionKind : "";
  return { schema: ROSTER_SCHEMA, electionCode: code, electionKind, systemSignOff: readSystemSignOff(raw.systemSignOff), seats: [...seats, ...extras] };
}

export function orderedSeats(roster) {
  return [...(roster?.seats ?? [])].sort((a, b) => (roleIndex[a.role] ?? 99) - (roleIndex[b.role] ?? 99) || String(a.id).localeCompare(String(b.id)));
}

/** Both names and a wallet. The administrator line can still show its wallet before the name is typed. */
export function seatFilled(seat) {
  return !!(seat?.firstName && seat?.lastName && isAddress(seat.address ?? ""));
}

/** The stored claim sentence still matches this name, position, nonce and time, and the signature recovers when a checker is passed. */
export function claimIsCurrent(seat, electionCode, verifyMessage) {
  try {
    if (!seat?.claim || seat.id === "admin") return false;
    if (!SIG.test(String(seat.claim.signature ?? ""))) return false;
    if (!isAddress(seat.address) || !isAddress(seat.claim.address) || !sameAddress(seat.claim.address, seat.address)) return false;
    if (seat.claim.message !== claimMessage(seat, electionCode)) return false;
    return recovers(seat.claim.message, seat.claim.signature, seat.address, verifyMessage);
  } catch {
    return false;
  }
}

/** The stored approval still matches this line, the claim hash, and the administrator wallet. */
export function grantIsCurrent(seat, electionCode, organizerAddress = "", hashSignature, verifyMessage) {
  try {
    if (!seat?.grant || !claimIsCurrent(seat, electionCode, verifyMessage)) return false;
    if (!SIG.test(String(seat.grant.signature ?? ""))) return false;
    const grantor = organizerAddress || seat.grant.grantor;
    if (!isAddress(grantor) || !sameAddress(seat.grant.grantor, grantor)) return false;
    if (isAddress(organizerAddress) && !sameAddress(seat.grant.grantor, organizerAddress)) return false;
    if (seat.grant.message !== approvalMessage(seat, electionCode, seat.grant.grantor)) return false;
    if (!hashesMatch(seat, hashSignature)) return false;
    return recovers(seat.grant.message, seat.grant.signature, seat.grant.grantor, verifyMessage);
  } catch {
    return false;
  }
}

/**
 * How one roster line should read.
 * A staff line with no name is covered by the Election Administrator's sign-in. That wallet is not copied
 * onto the line. As soon as a name is entered, the coverage stops until that person links their own wallet
 * and the administrator approves them.
 * The administrator line always shows the creating wallet, and Open where the name is still blank.
 */
export function lineView(seat, { electionCode, organizerAddress = "", verifyMessage, hashSignature } = {}) {
  const meta = roleMeta(seat.role) ?? { line: seat.role, label: seat.role };
  const named = !!(seat.firstName && seat.lastName);
  const started = !!(seat.firstName || seat.lastName);
  const addr = isAddress(seat.address) ? seat.address : "";
  const isAdmin = seat.id === "admin";
  const covered = !isAdmin && !started;
  const coveringWallet = covered && isAddress(organizerAddress) ? organizerAddress : "";
  let status = "open";
  let address = "";
  if (isAdmin) {
    address = addr || (isAddress(organizerAddress) ? organizerAddress : "");
    if (named && registrationIsCurrent(seat, electionCode)) status = "registered";
  } else if (covered) {
    status = "covered";
  } else if (!named) {
    status = "incomplete";
  } else if (!addr) {
    status = "named";
  } else if (grantIsCurrent(seat, electionCode, organizerAddress, hashSignature, verifyMessage)) {
    status = "approved";
    address = addr;
  } else if (claimIsCurrent(seat, electionCode, verifyMessage)) {
    status = "linked";
    address = addr;
  } else {
    status = "unverified";
    address = addr;
  }
  const active = status === "covered" || status === "approved" || status === "registered";
  return {
    id: seat.id,
    role: seat.role,
    label: meta.label,
    line: meta.line,
    duty: meta.duty ?? "",
    showElectionId: isAdmin,
    open: isAdmin && !named,
    covered,
    active,
    name: named ? `${seat.firstName} ${seat.lastName}` : isAdmin ? "Open" : "",
    address,
    coveringWallet,
    status,
    claimSignedAt: status === "linked" || status === "approved" ? seat.claim?.signedAt ?? "" : "",
    grantSignedAt: status === "approved" ? seat.grant?.signedAt ?? "" : "",
  };
}

export function rosterProblems(roster) {
  const p = [];
  if (!roster || roster.schema !== ROSTER_SCHEMA) p.push("This isn't a staff roster.");
  if (!ELECTION_CODE_RE.test(String(roster?.electionCode ?? ""))) p.push("The election code must look like BEINGS-2026-ABC123.");
  const seats = roster?.seats ?? [];
  for (const role of ROSTER_ROLES) {
    if (!seats.some((s) => s.id === role.id && s.role === role.id)) p.push(`${role.line} is missing its line.`);
  }
  const seenAddr = new Map();
  for (const s of seats) {
    if (!roleMeta(s.role)) p.push(`Unknown role ${s.role}.`);
    for (const part of [s.firstName, s.lastName]) {
      if (!part) continue;
      if (!NAME_RE.test(part)) p.push(`${roleMeta(s.role)?.line ?? s.role}: use a name of up to 40 letters.`);
      if (looksLikeBallotCode(part)) p.push("A name looks like a ballot code. Ballot codes never go on the roster.");
    }
    if (s.address && !isAddress(s.address)) p.push(`${roleMeta(s.role)?.line ?? "A seat"}: that isn't a wallet address.`);
    if (isAddress(s.address)) {
      const k = s.address.toLowerCase();
      if (seenAddr.has(k)) p.push("Each wallet can be on one roster line.");
      else seenAddr.set(k, s.id);
    }
    if ((s.firstName || s.lastName) && !(s.firstName && s.lastName)) p.push(`${roleMeta(s.role)?.line ?? "A seat"} needs both a first and a last name.`);
  }
  return p;
}

export function applyEdits(roster, edits, { organizerAddress = "" } = {}) {
  const byId = new Map((edits ?? []).map((e) => [e.id, e]));
  const seats = roster.seats.map((seat) => {
    const e = byId.get(seat.id);
    if (!e) return seat;
    const firstName = cleanName(e.firstName);
    const lastName = cleanName(e.lastName);
    let address = String(e.address ?? "").trim();
    if (seat.id === "admin" && isAddress(organizerAddress)) address = sameAddress(seat.address, organizerAddress) ? seat.address : organizerAddress;
    if (seat.id !== "admin" && !firstName && !lastName) address = "";
    const sameAddr = seat.address.toLowerCase() === address.toLowerCase();
    const nameChanged = firstName !== seat.firstName || lastName !== seat.lastName;
    const changed = nameChanged || !sameAddr;
    return {
      ...seat,
      firstName,
      lastName,
      address: sameAddr ? seat.address : address,
      nameSalt: nameChanged ? "" : readNameSalt(seat.nameSalt),
      claim: changed ? null : seat.claim,
      grant: changed ? null : seat.grant,
      registration: changed ? null : seat.registration,
      chainClaim: changed ? null : seat.chainClaim,
    };
  });
  return { ...roster, seats };
}

export function addSeat(roster, role) {
  if (!ADDABLE_ROLES.includes(role)) throw new Error("That role already has its one line.");
  let n = 2;
  while (roster.seats.some((s) => s.id === `${role}-${n}`)) n += 1;
  return { ...roster, seats: [...roster.seats, blankSeat(role, `${role}-${n}`)] };
}

export function removeSeat(roster, id) {
  const seat = roster.seats.find((s) => s.id === id);
  if (!seat || !String(id).includes("-")) throw new Error("That line stays on the roster.");
  return { ...roster, seats: roster.seats.filter((s) => s.id !== id) };
}

/** Store a staff signature and the wallet recovered from it. Clears any approval. Does not itself recover the signature. */
export function recordLinkedClaim(roster, seatId, { signature, nonce, signedAt, address } = {}) {
  if (!SIG.test(String(signature ?? ""))) throw new Error("The claim signature doesn't look like a wallet signature.");
  if (!isAddress(address || "")) throw new Error("The staff wallet address is missing.");
  let found = false;
  const seats = roster.seats.map((s) => {
    if (s.id !== seatId) return s;
    found = true;
    if (s.id === "admin") throw new Error("The Election Administrator wallet is the one that created the election.");
    if (!s.firstName || !s.lastName) throw new Error("Enter a first and last name before linking a wallet.");
    const draft = { ...s, address, claim: { nonce, signedAt, address, signature, message: "" } };
    const message = claimMessage(draft, roster.electionCode);
    return { ...s, address, claim: { message, signature, address, nonce, signedAt }, grant: null, chainClaim: null };
  });
  if (!found) throw new Error("That roster line isn't there.");
  return { ...roster, seats };
}

export function recordClaim(roster, seatId, proof) {
  return recordLinkedClaim(roster, seatId, proof);
}

/** Store the administrator's approval. `claimHash` is the hash of the staff signature. Does not itself recover the signature. */
export function recordChainClaim(roster, seatId, { signature, nonce, nameHash } = {}) {
  if (!SIG.test(String(signature ?? ""))) throw new Error("The chain signature doesn't look like a wallet signature.");
  if (!/^[1-9][0-9]{0,77}$/.test(String(nonce ?? ""))) throw new Error("The chain statement needs a nonce.");
  if (!isBytes32(nameHash || "")) throw new Error("The chain statement needs a name fingerprint.");
  let found = false;
  const seats = roster.seats.map((s) => {
    if (s.id !== seatId) return s;
    found = true;
    if (s.id === "admin") throw new Error("The Election Administrator wallet is the one that created the election.");
    return { ...s, chainClaim: { signature, nonce: String(nonce), nameHash } };
  });
  if (!found) throw new Error("That roster line isn't there.");
  return { ...roster, seats };
}

export function recordApproval(roster, seatId, { signature, signedAt, grantor, adminName, claimHash, adultAttested = false } = {}) {
  if (!SIG.test(String(signature ?? ""))) throw new Error("The approval signature doesn't look like a wallet signature.");
  if (!isAddress(grantor || "")) throw new Error("Approval needs the Election Administrator's wallet.");
  let found = false;
  const seats = roster.seats.map((s) => {
    if (s.id !== seatId) return s;
    found = true;
    if (!claimIsCurrent(s, roster.electionCode)) throw new Error("This role has no staff signature to approve.");
    const grant = { adminName, claimHash, signedAt, grantor, signature, message: "" };
    const message = approvalMessage({ ...s, grant }, roster.electionCode, grantor);
    return { ...s, grant: { message, signature, grantor, signedAt, claimHash, adminName: cleanName(adminName), adultAttested: adultAttested === true } };
  });
  if (!found) throw new Error("That roster line isn't there.");
  return { ...roster, seats };
}

/**
 * Write the Election Administrator's name, wallet, and EIP-191 registration onto the admin line.
 * `verify(message, signature)` must return the signer address. A signature that does not recover `address` is refused.
 */
export function recordAdminRegistration(roster, { firstName, lastName, address, signature, at, electionId, verify }) {
  if (!isAddress(address)) throw new Error("Register with the connected wallet.");
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  if (!NAME_RE.test(first) || !NAME_RE.test(last)) throw new Error("Enter a first and last name, up to 40 letters.");
  const id = !electionId || String(electionId).toLowerCase() === NEW_ELECTION_ID ? NEW_ELECTION_ID : String(electionId).trim();
  const message = adminRegistrationMessage({ firstName: first, lastName: last, address, electionId: id, at });
  if (!SIG.test(String(signature ?? ""))) throw new Error("The registration signature doesn't look like a wallet signature.");
  if (typeof verify !== "function" || !signatureMatches(message, signature, address, verify)) throw new Error("That signature doesn't match this wallet. Nothing was saved.");
  let found = false;
  const seats = roster.seats.map((s) => {
    if (s.id !== "admin") return s;
    found = true;
    return { ...s, firstName: first, lastName: last, address, claim: null, grant: null, registration: { message, signature } };
  });
  if (!found) throw new Error("The Election Administrator line isn't on this roster.");
  return { ...roster, seats };
}

function readPending(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(PENDING_ADMIN_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const seat = { id: "admin", role: "admin", firstName: raw.firstName, lastName: raw.lastName, address: raw.address, registration: { message: raw.message, signature: raw.signature } };
    if (!registrationIsCurrent(seat, NEW_ELECTION_ID)) return null;
    return seat;
  } catch {
    return null;
  }
}

/** The registration stored for this election, or the one signed as "new election" when no id existed yet. */
export function readAdminRegistration(storage, electionId) {
  const id = !electionId || String(electionId).toLowerCase() === NEW_ELECTION_ID ? NEW_ELECTION_ID : String(electionId).trim();
  if (id !== NEW_ELECTION_ID && ELECTION_CODE_RE.test(id)) {
    const admin = loadRoster(storage, id).seats.find((s) => s.id === "admin");
    if (admin && registrationIsCurrent(admin, id)) return { firstName: admin.firstName, lastName: admin.lastName, address: admin.address, message: admin.registration.message, signature: admin.registration.signature, electionId: parseAdminRegistration(admin.registration.message).electionId };
  }
  const pending = readPending(storage);
  if (!pending) return null;
  return { firstName: pending.firstName, lastName: pending.lastName, address: pending.address, message: pending.registration.message, signature: pending.registration.signature, electionId: NEW_ELECTION_ID };
}

/**
 * Keep a verified registration with the roster.
 * A real election code is saved on that election's roster. "new election" waits until a code exists.
 */
export function saveAdminRegistration(storage, roster) {
  const admin = roster.seats.find((s) => s.id === "admin");
  const code = roster.electionCode;
  if (!registrationIsCurrent(admin, code)) throw new Error("The registration doesn't match this roster.");
  if (!ELECTION_CODE_RE.test(String(code ?? ""))) {
    storage.setItem(PENDING_ADMIN_KEY, JSON.stringify({ firstName: admin.firstName, lastName: admin.lastName, address: admin.address, message: admin.registration.message, signature: admin.registration.signature }));
    return roster;
  }
  saveRoster(storage, roster);
  storage.removeItem(PENDING_ADMIN_KEY);
  return roster;
}

/** Copy a "new election" registration onto this roster once, when the administrator line is still empty. */
export function adoptPendingRegistration(roster, storage) {
  const admin = roster.seats.find((s) => s.id === "admin");
  if (!admin || registrationIsCurrent(admin, roster.electionCode)) return roster;
  const pending = readPending(storage);
  if (!pending) return roster;
  const seat = { ...admin, firstName: pending.firstName, lastName: pending.lastName, address: pending.address, claim: null, grant: null, registration: pending.registration };
  if (!registrationIsCurrent(seat, roster.electionCode)) return roster;
  storage.removeItem(PENDING_ADMIN_KEY);
  return { ...roster, seats: roster.seats.map((s) => (s.id === "admin" ? seat : s)) };
}

export function recordGrant(roster, seatId, proof) {
  return recordApproval(roster, seatId, proof);
}

/** Clear the wallet, the staff signature and the approval. The name stays, so the line can be linked again. */
export function unlinkSeat(roster, id) {
  if (id === "admin") throw new Error("The Election Administrator wallet is the one that created the election.");
  let found = false;
  const seats = roster.seats.map((s) => {
    if (s.id !== id) return s;
    found = true;
    return { ...s, address: "", claim: null, grant: null, chainClaim: null };
  });
  if (!found) throw new Error("That roster line isn't there.");
  return { ...roster, seats };
}

/**
 * Check every stored signature. A failure is a warning string. The roster is not rewritten.
 * `verifyMessage(message, signature)` returns the signer. `hashSignature(signature)` hashes the staff signature.
 */
export function verifyRosterSignatures(roster, { verifyMessage, hashSignature, organizerAddress = "" } = {}) {
  const warnings = [];
  if (typeof verifyMessage !== "function") return warnings;
  for (const s of orderedSeats(roster)) {
    if (!s || s.id === "admin") continue;
    const who = `${positionLabel(s.role)}${s.firstName || s.lastName ? ` ${cleanName(s.firstName)} ${cleanName(s.lastName)}`.trimEnd() : ""}`;
    if (s.claim && !claimIsCurrent(s, roster?.electionCode, verifyMessage)) {
      warnings.push(`${who}: the staff signature on file does not match this name and wallet. Treat the wallet as not verified.`);
    }
    if (s.grant && !grantIsCurrent(s, roster?.electionCode, organizerAddress, hashSignature, verifyMessage)) {
      warnings.push(`${who}: the approval signature on file does not match the Election Administrator. The approval is not verified.`);
    }
  }
  return warnings;
}

/** Local check only. `verifyMessage(message, signature)` returns the signer address. The ledger does not do this. */
export function signatureMatches(message, signature, expectedAddress, verifyMessage) {
  try {
    const signer = verifyMessage(message, signature);
    return typeof signer === "string" && isAddress(expectedAddress) && signer.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/** The one sentence under the roster controls. Per-line state is the badge on the line, not this paragraph. */
export function rosterSigningReport() {
  return [ROSTER_NOTE];
}

function assertNoBallotCodes(value, where) {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/^ballotCodes$/i.test(k)) throw new Error(`${where}: ballot codes must not be in the roster.`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === "string" && looksLikeBallotCode(v)) throw new Error(`${where}: "${path}" looks like a ballot code.`);
  };
  walk(value, "$");
}

function readSystemSignOff(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signature = String(raw.signature ?? "");
  if (!SIG.test(signature) || !isBytes32(raw.rosterHash) || !isBytes32(raw.dutiesHash) || !isBytes32(raw.positionSetHash)) return null;
  if (!Array.isArray(raw.positionIds) || !Array.isArray(raw.sheetHashes) || raw.positionIds.length !== raw.sheetHashes.length) return null;
  if (!raw.positionIds.every((id) => isBytes32(id)) || !raw.sheetHashes.every((id) => isBytes32(id))) return null;
  return {
    statement: String(raw.statement ?? ""),
    signature,
    rosterHash: raw.rosterHash,
    dutiesHash: raw.dutiesHash,
    positionSetHash: raw.positionSetHash,
    positionIds: raw.positionIds.map(String),
    sheetHashes: raw.sheetHashes.map(String),
    signer: isAddress(raw.signer) ? raw.signer : "",
  };
}

/** Keep a System admin close-out signature on this computer. It is not part of the public roster fingerprint. */
export function recordSystemSignOffLocal(roster, proof) {
  const systemSignOff = readSystemSignOff(proof);
  if (!systemSignOff) throw new Error("The System admin sign-off is incomplete.");
  return { ...roster, systemSignOff };
}

/**
 * Confidential Executive staff record. This is the administrator's download copy.
 * Name salts are included. Ballot codes are refused. Do not attach this to the public download.
 */
export function executiveStaffRecord(roster) {
  const problems = rosterProblems(roster);
  if (problems.length) throw new Error(problems.join(" "));
  for (const seat of roster.seats ?? []) {
    if (cleanName(seat.firstName) && cleanName(seat.lastName) && !readNameSalt(seat.nameSalt)) {
      throw new Error("Save the roster on this computer before downloading the confidential staff record.");
    }
  }
  const view = {
    schema: EXECUTIVE_STAFF_SCHEMA,
    confidential: true,
    electionCode: roster.electionCode,
    electionKind: electionKindOf(roster),
    note: EXECUTIVE_STAFF_NOTE,
    systemSignOff: readSystemSignOff(roster.systemSignOff),
    seats: orderedSeats(roster).map((s) => ({
      id: s.id,
      role: s.role,
      firstName: s.firstName,
      lastName: s.lastName,
      address: isAddress(s.address) ? s.address : "",
      nameSalt: readNameSalt(s.nameSalt),
      chainClaim: s.chainClaim ? { signature: s.chainClaim.signature, nonce: s.chainClaim.nonce, nameHash: s.chainClaim.nameHash } : null,
    })),
  };
  assertNoBallotCodes(view, "executive staff record");
  return view;
}

/** Public view: names, wallets, and the signed messages. No salts, no ballot codes. Not part of the election file. */
export function publicRoster(roster) {
  const problems = rosterProblems(roster);
  if (problems.length) throw new Error(problems.join(" "));
  const view = {
    schema: ROSTER_SCHEMA,
    electionCode: roster.electionCode,
    electionKind: electionKindOf(roster),
    keptWith: "Stored beside the election file on this computer, under the election code. Not inside the fingerprinted election file.",
    signing: ROSTER_NOTE,
    seats: orderedSeats(roster).map((s) => {
      const organizer = roster.seats.find((x) => x.id === "admin")?.address || "";
      const line = lineView(s, { electionCode: roster.electionCode, organizerAddress: organizer });
      return {
        id: s.id,
        role: s.role,
        label: line.line,
        firstName: s.firstName,
        lastName: s.lastName,
        address: line.address,
        coveredByAdministrator: line.covered,
        coveringWallet: line.coveringWallet,
        active: line.active,
        status: line.status,
        open: line.open,
        claim: s.claim,
        grant: s.grant,
        registration: registrationIsCurrent(s, roster.electionCode) ? s.registration : null,
      };
    }),
  };
  assertNoBallotCodes(view, "staff roster");
  return view;
}

/**
 * Attach the roster beside a public election-file wrapper. Does not put it inside `file`,
 * so the file fingerprint stays the one registered on the ledger. Refuses a wrapper whose file still has ballot codes.
 */
export function withPublicRoster(wrapper, roster, rosterHash = "") {
  if (!wrapper || typeof wrapper !== "object" || !wrapper.file) throw new Error("Public copy is missing.");
  if (Array.isArray(wrapper.file.ballotCodes) && wrapper.file.ballotCodes.length) throw new Error("The public copy still has ballot codes.");
  const staffRoster = publicRoster(roster);
  const extra = "Staff names and wallets are in staffRoster, beside the file, not inside the fingerprinted election file. Ballot codes stay out. rosterHash, when present, is the fingerprint anyone can match to the chain. It is not inside the hashed roster.";
  const note = wrapper.note ? `${wrapper.note} ${extra}` : extra;
  const out = { ...wrapper, note, staffRoster };
  if (isBytes32(rosterHash)) out.rosterHash = rosterHash;
  return out;
}

export function loadRoster(storage, electionCode, { organizerAddress = "" } = {}) {
  let raw = null;
  try {
    raw = JSON.parse(storage?.getItem(rosterStorageKey(electionCode)) || "null");
  } catch {
    raw = null;
  }
  return normalizeRoster(raw, { electionCode, organizerAddress });
}

export function saveRoster(storage, roster) {
  const next = withNameSalts(roster);
  const problems = rosterProblems(next);
  if (problems.length) throw new Error(problems.join(" "));
  assertNoBallotCodes(next, "staff roster");
  storage.setItem(rosterStorageKey(next.electionCode), JSON.stringify(next));
  return next;
}

export function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
