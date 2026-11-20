// Pure helpers for the on-chain staff roster. No DOM and no network.
// Names stay in the local roster. The chain stores wallets, positions, a salted name hash, and a fingerprint
// of the public roster. The salt is not in that fingerprint and not in the EIP-712 nameHash field's preimage on chain.
import { canonicalize, shortAddress } from "./format.js";
import { sameAddress } from "./logic.js";
import { cleanName, electionKindOf, lineView, orderedSeats, positionLabel, publicRoster, rosterProblems, OFFICER_DUTY, SCANNER_DUTY, SYSTEM_ADMIN_DUTY } from "./roster.js";

export const LOCK_ATTESTATION = "I have reviewed this staff roster and confirm it is accurate and complete";
export const TEST_STATEMENT = "This election was used and identified as a test election";
export const ADULT_ATTESTATION = "I attest that this staff member is a legal adult (18, or the age of majority where they live).";
export const SYSTEM_SIGNOFF_STATEMENT = "I verify that this roster's roles and wallets were set up correctly, and that each listed position's duties were verified complete.";
/** Duty text hashed into each position's close-out sheet. Officer, scanner, and system use the roster sentences. */
export const CLOSEOUT_DUTY = {
  admin: "Runs the election: the roster, opening and closing voting, and the published tally.",
  officer: OFFICER_DUTY,
  verifier: "Checks the published ballot images and the count, and signs what they find.",
  scanner: SCANNER_DUTY,
  system: SYSTEM_ADMIN_DUTY,
};
export const CLASSROOM_LABEL = "Classroom election (single administrator), not certified";
export const ADULT_NOTE = "Staff wallets must belong to legal adults. Bifrost's terms require 18, or the age of majority where that person lives. Students can audit a ballot on Check my ballot (check.html) without connecting a wallet.";

export const KIND_INDEX = { standard: 0, test: 1, classroom: 2 };
export const KIND_FROM_INDEX = ["standard", "test", "classroom"];
export const ROLE_INDEX = { admin: 0, officer: 1, verifier: 2, scanner: 3, system: 4 };

export const KIND_CHOICES = [
  { id: "standard", label: "Standard", detail: "Can be certified. Every position needs its own named adult and that person's own wallet. No position stays covered by the Election Administrator." },
  { id: "test", label: "Test", detail: "Always labelled Test. After you sign the test statement, you may sign for other positions. A test election is never certified." },
  { id: "classroom", label: "Classroom", detail: "One adult, the teacher or instructor, covers every position. Ballots are still counted on the chain. The result is labelled Classroom election (single administrator), not certified." },
];

export function kindLabel(kind) {
  if (kind === "test") return "Test";
  if (kind === "classroom") return CLASSROOM_LABEL;
  if (kind === "standard") return "Standard election";
  return "";
}

export function seatNoOf(id) {
  const match = /-(\d+)$/.exec(String(id ?? ""));
  if (!match) return 1;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 2 && n <= 8 ? n : 0;
}

export function staffDomain(verifyingContract, chainId = 114) {
  return { name: "B.E.I.N.G.S.", version: "1", chainId, verifyingContract };
}

export function positionId(ethers, roleName, seatId) {
  const role = ROLE_INDEX[roleName];
  const seatNo = seatNoOf(seatId);
  if (role == null || !seatNo) throw new Error("That roster line cannot be recorded.");
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint16"], [role, seatNo]));
}

/** The name the salt is mixed with. Extra spaces are collapsed. The salt is not part of this string. */
export function normalizedStaffName(first, last) {
  return `${cleanName(first)} ${cleanName(last)}`.trim();
}

/**
 * keccak256(abi.encode(salt, normalizedName)).
 * `salt` is a random 32-byte hex string. It is not hashed by itself and it is not stored on the chain.
 * A plain keccak256 of the name is a different value, so guessing the name does not confirm the chain record.
 */
export function personNameHash(ethers, first, last, salt) {
  const name = normalizedStaffName(first, last);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(salt ?? "")) || /^0x0{64}$/i.test(String(salt))) {
    throw new Error("A staff name fingerprint needs a salt that stays off the chain.");
  }
  if (!name) throw new Error("A staff name fingerprint needs a first and last name.");
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [salt, name]));
}

/**
 * Fingerprint of the public roster. Salts, the confidential Executive record, and this hash itself
 * are not inside the hashed object, so publishing the fingerprint does not publish a salt.
 */
export function rosterFileHash(roster, ethers) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalize(publicRoster(roster))));
}

/** keccak256 of one position's duty and close-out sheet. The sheet lists the duty and the position it covers. */
export function closeOutSheetHash(ethers, { electionId, positionId: pid, role, duty, wallet }) {
  const body = canonicalize({
    schema: "beings-duty-closeout/1",
    electionId,
    positionId: pid,
    role,
    duty: String(duty ?? ""),
    wallet: String(wallet ?? "").toLowerCase(),
    dutiesVerifiedComplete: true,
  });
  return ethers.keccak256(ethers.toUtf8Bytes(body));
}

/** The two digests the System admin signs: the duty sheets, and the set of position ids those sheets cover. */
export function systemSignOffDigests(ethers, positionIds, sheetHashes) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return {
    dutiesHash: ethers.keccak256(coder.encode(["bytes32[]", "bytes32[]"], [positionIds, sheetHashes])),
    positionSetHash: ethers.keccak256(coder.encode(["bytes32[]"], [positionIds])),
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Positions a close-out sign-off covers. When the chain roster is known, those wallets win.
 * Covered lines and blank wallets are left out. Each row carries its duty and will later carry a sheet hash.
 */
export function signOffSeats({ roster, chain, ethers, organizerAddress = "" }) {
  const fromChain = chain?.known && chain.seats && Object.keys(chain.seats).length > 0;
  const source = fromChain
    ? Object.entries(chain.seats).map(([id, row]) => ({ id, role: String(id).split("-")[0], wallet: row?.wallet || "", covered: !!row?.covered }))
    : orderedSeats(roster).map((seat) => {
        const line = lineView(seat, { electionCode: roster?.electionCode, organizerAddress });
        return { id: seat.id, role: seat.role, wallet: line.address || "", covered: line.covered, label: line.line };
      });
  const seats = [];
  for (const row of source) {
    if (ROLE_INDEX[row.role] == null || row.covered) continue;
    if (!row.wallet || row.wallet.toLowerCase() === ZERO_ADDRESS) continue;
    seats.push({
      id: row.id,
      role: row.role,
      label: row.label || positionLabel(row.role),
      duty: CLOSEOUT_DUTY[row.role] || "",
      wallet: row.wallet,
      positionId: positionId(ethers, row.role, row.id),
    });
  }
  return seats;
}

export function assembleSystemSignOff(ethers, { electionId, rosterHash, seats }) {
  const lines = seats.map((seat) => ({
    ...seat,
    sheetHash: closeOutSheetHash(ethers, { electionId, positionId: seat.positionId, role: seat.role, duty: seat.duty, wallet: seat.wallet }),
  }));
  const positionIds = lines.map((line) => line.positionId);
  const sheetHashes = lines.map((line) => line.sheetHash);
  return { lines, positionIds, sheetHashes, rosterHash, electionId, ...systemSignOffDigests(ethers, positionIds, sheetHashes) };
}

// nameHash is keccak256(abi.encode(salt, normalizedName)). The salt is not a field: putting it here would publish it.
const CLAIM_FIELDS = [
  { name: "electionId", type: "bytes32" },
  { name: "positionId", type: "bytes32" },
  { name: "wallet", type: "address" },
  { name: "nameHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
];

export function claimTypedData({ verifyingContract, electionId, positionId: pid, wallet, nameHash, nonce, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: { StaffClaim: CLAIM_FIELDS },
    primaryType: "StaffClaim",
    message: { electionId, positionId: pid, wallet, nameHash, nonce },
  };
}

export function approvalTypedData({ verifyingContract, electionId, positionId: pid, wallet, nameHash, claimDigest, nonce, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: {
      StaffApproval: [
        ...CLAIM_FIELDS.slice(0, 4),
        { name: "claimDigest", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "adultAttestation", type: "string" },
      ],
    },
    primaryType: "StaffApproval",
    message: { electionId, positionId: pid, wallet, nameHash, claimDigest, nonce, adultAttestation: ADULT_ATTESTATION },
  };
}

export function lockTypedData({ verifyingContract, electionId, rosterHash, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: {
      RosterLock: [
        { name: "electionId", type: "bytes32" },
        { name: "rosterHash", type: "bytes32" },
        { name: "attestation", type: "string" },
      ],
    },
    primaryType: "RosterLock",
    message: { electionId, rosterHash, attestation: LOCK_ATTESTATION },
  };
}

export function testTypedData({ verifyingContract, electionId, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: {
      TestElectionAttestation: [
        { name: "electionId", type: "bytes32" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "TestElectionAttestation",
    message: { electionId, statement: TEST_STATEMENT },
  };
}

export function chainLineStatus(seat, chain) {
  if (!chain?.configured) return "off";
  const on = chain.seats?.[seat.id];
  if (seat.id === "admin") {
    if (!chain.known) return "not-recorded";
    return chain.locked ? "locked" : "recorded";
  }
  if (on?.covered) return chain.locked ? "locked" : "recorded";
  if (!on?.wallet) return "not-recorded";
  if (isAddressLike(seat.address) && !sameAddress(on.wallet, seat.address)) return "not-recorded";
  return chain.locked ? "locked" : "recorded";
}

function isAddressLike(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

const APPROVAL_WORD = {
  covered: "Covered by Election Administrator",
  incomplete: "Needs a first and last name",
  named: "Named, waiting for a wallet",
  unverified: "Not verified",
  linked: "Wallet linked, not approved",
  approved: "Approved",
  registered: "Registered",
  open: "Open",
};

export const CHAIN_WORD = {
  off: "Not on a roster contract yet",
  "not-recorded": "Not recorded",
  recorded: "Recorded",
  locked: "Locked",
};

/**
 * What the review screen lists, and which problems block the lock.
 * Test elections may lock with warnings after the test statement. Classroom elections are one administrator.
 * Only a clean standard roster can later be certified.
 */
export function assessRosterReview(roster, { organizerAddress = "", chain = null, verifyMessage, hashSignature } = {}) {
  const localKind = electionKindOf(roster);
  const kind = chain?.known ? chain.kind || localKind : localKind;
  const problems = [];
  const push = (text, blocking) => problems.push({ text, blocking });

  if (!kind) push("Choose Standard, Test, or Classroom. That choice is recorded with the Election Administrator and cannot be changed.", true);
  if (chain?.known && localKind && chain.kind && localKind !== chain.kind) {
    push(`The chain already records this as ${kindLabel(chain.kind)}. That choice cannot be changed.`, true);
  }
  if (chain?.configured && !chain.known) push("The Election Administrator is not recorded on the chain yet.", true);

  for (const text of rosterProblems(roster)) {
    if (/wallet can be on one roster line/i.test(text)) push(text, true);
  }
  if (kind === "standard") {
    const handlers = orderedSeats(roster).filter((seat) => seat.role === "officer");
    const recorded = chain?.known
      ? Object.entries(chain.seats || {}).filter(([id, row]) => (id === "officer" || id.startsWith("officer-")) && row?.wallet && !row.covered).length
      : handlers.filter((seat) => {
          const line = lineView(seat, { electionCode: roster.electionCode, organizerAddress, verifyMessage, hashSignature });
          return line.status === "approved" && seat.grant?.adultAttested === true;
        }).length;
    if (recorded < 2) {
      push("A standard election needs two Election officers to handle the paper ballots. Each must be a different named adult, with their own linked and approved wallet.", true);
    }
  }

  const lines = orderedSeats(roster).map((seat) => {
    const line = lineView(seat, { electionCode: roster.electionCode, organizerAddress, verifyMessage, hashSignature });
    const chainStatus = chainLineStatus(seat, chain || { configured: false });
    const who = positionLabel(seat.role);
    if (seat.id !== "admin") {
      if (kind === "classroom" && (seat.firstName || seat.lastName)) {
        push(`${who} has a name. A classroom election is run by one administrator. Clear that line, or choose Standard or Test before recording the administrator.`, true);
      }
      if (kind === "standard" || kind === "test") {
        const blocking = kind === "standard";
        if (line.covered) push(`${who} is still covered by the Election Administrator.`, blocking);
        else if (line.status === "incomplete" || line.status === "named" || line.status === "unverified" || line.status === "linked") {
          push(`${who} is not approved yet.`, blocking);
        } else if (line.status === "approved" && !seat.grant?.adultAttested) {
          push(`${who} needs the legal-adult attestation before it can be recorded.`, blocking);
        } else if (line.status === "approved" && chain?.configured && chainStatus === "not-recorded") {
          push(`${who} is approved but not recorded on the chain yet.`, blocking);
        }
      }
    }
    return {
      id: seat.id,
      position: line.line || who,
      name: line.name || (line.covered ? "Covered by Election Administrator" : "—"),
      wallet: line.address ? shortAddress(line.address) : line.coveringWallet ? shortAddress(line.coveringWallet) : "—",
      approval: APPROVAL_WORD[line.status] || line.status,
      chain: CHAIN_WORD[chainStatus] || chainStatus,
      chainStatus,
      problem: false,
    };
  });

  const blocking = problems.some((p) => p.blocking);
  return {
    kind,
    label: kindLabel(kind),
    lines,
    problems,
    blocking,
    certifiedPossible: kind === "standard" && problems.length === 0,
    systemSignOffRequired: kind === "standard",
    systemSignOffOptional: kind === "test" || kind === "classroom",
    adultNote: ADULT_NOTE,
  };
}

/** The lock button's rule. The review box is always required. A test with warnings also needs the test statement. */
export function lockAllowed({ kind, problems = [], reviewTicked = false, testTicked = false, adminRecorded = true } = {}) {
  if (!adminRecorded || !kind || !reviewTicked) return false;
  if (problems.some((p) => p.blocking)) return false;
  if (kind === "test" && problems.length > 0 && !testTicked) return false;
  if (kind === "standard" && problems.length > 0) return false;
  return true;
}

/**
 * An Election officer signs this. action 1 is a print run, 2 a scan batch, 3 ballots stored.
 * Print and scan also name the Scanner operator. Ballots stored uses the zero address for the scanner.
 * The print and scan screens that ask for these signatures are not built yet.
 */
export function systemSignOffTypedData({ verifyingContract, electionId, rosterHash, dutiesHash, positionSetHash, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: {
      SystemSignOff: [
        { name: "electionId", type: "bytes32" },
        { name: "rosterHash", type: "bytes32" },
        { name: "dutiesHash", type: "bytes32" },
        { name: "positionSetHash", type: "bytes32" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "SystemSignOff",
    message: { electionId, rosterHash, dutiesHash, positionSetHash, statement: SYSTEM_SIGNOFF_STATEMENT },
  };
}

export function custodyTypedData({ verifyingContract, electionId, action, subjectHash, officer, scanner, nonce, chainId = 114 }) {
  return {
    domain: staffDomain(verifyingContract, chainId),
    types: {
      CustodyWitness: [
        { name: "electionId", type: "bytes32" },
        { name: "action", type: "uint8" },
        { name: "subjectHash", type: "bytes32" },
        { name: "officer", type: "address" },
        { name: "scanner", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "CustodyWitness",
    message: { electionId, action, subjectHash, officer, scanner, nonce },
  };
}

export function freshNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const n = BigInt(hex);
  return n === 0n ? "1" : n.toString();
}
