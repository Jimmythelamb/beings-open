// Long-term public election record and signed officials' notes. Pure logic: no DOM, no network, no wallet.
// Design: "B.E.I.N.G.S. long-term public election record", draft of 10 Nov 2026 (sections 4, 7.2, 8).
//
// Two file formats, both plain JSON, both fingerprinted over their RFC 8785 canonical form (the same rule the
// election file and the results file already follow, so pretty-printed and compact copies have the same fingerprint):
//
//   beings-election-note/1    one official's note (for example the organizer's explanation of a failed check),
//                             signed with EIP-712 by the author's wallet. A note EXPLAINS; it never changes counts.
//   beings-election-record/1  the record manifest: every public file in the record with its SHA-256, the on-chain
//                             facts it relates to, and the contract addresses. Its own SHA-256 is the record fingerprint.
//
// Signing (EIP-712), off-chain only:
//   domain  { name: "B.E.I.N.G.S.", version: "1", chainId: 114 }   (no verifyingContract: no contract checks it;
//                                                                     the ElectionNotes transaction itself proves who posted)
//   ElectionNote(bytes32 electionKey, uint32 tallyVersion, address author, uint8 role, bytes32 bodyHash)
//   bodyHash = keccak256(UTF-8 bytes of RFC 8785 JSON of the note WITHOUT its "signature" field)
//   role     = 1 organizer, 2 device (scanning staff), 3 reviewer   (= ElectionNotes.AuthorRole)
// On-chain (ElectionNotes.postNote): noteSha256 = SHA-256 of RFC 8785 JSON of the SIGNED note (signature included).
import { canonicalize, sha256Hex, ELECTION_CODE_RE } from "./format.js";

export const NOTE_SCHEMA = "beings-election-note/1";
export const RECORD_SCHEMA = "beings-election-record/1";
export const CHAIN_ID = 114;
/** Index = ElectionNotes.AuthorRole. */
export const NOTE_ROLES = ["none", "organizer", "device", "reviewer"];
export const ROLE_LABEL = { organizer: "Organizer", device: "Scanning staff", reviewer: "Reviewer" };
export const ROLE_EXPLANATION = { organizer: "organizer's explanation", device: "scanning staff's explanation", reviewer: "reviewer's explanation" };
export const NOTE_KINDS = ["explanation", "correction-notice", "staff-list", "general"];
export const MAX_DISPLAY_NAME_BYTES = 64; // = ElectionNotes.MAX_DISPLAY_NAME_BYTES
export const MAX_CID_BYTES = 256; // = ElectionNotes.MAX_CID_BYTES
export const MAX_TEXT_CHARS = 4000;
export const CHECK_IDS = ["R1", "R2", "R3", "R4", "R5", "R6"];
export const NAME_WARNING = "A display name is public and permanent. Once the note's fingerprint is posted, the chain cannot forget it, and anyone who downloaded the note keeps it. Leave it empty to be shown by role and wallet only.";

export const NOTE_TYPES = {
  ElectionNote: [
    { name: "electionKey", type: "bytes32" },
    { name: "tallyVersion", type: "uint32" },
    { name: "author", type: "address" },
    { name: "role", type: "uint8" },
    { name: "bodyHash", type: "bytes32" },
  ],
};
export const noteDomain = (chainId = CHAIN_ID) => ({ name: "B.E.I.N.G.S.", version: "1", chainId });

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const utf8Len = (s) => new TextEncoder().encode(String(s)).length;
const NOTE_FIELDS = ["schema", "electionCode", "electionKey", "chainId", "tallyVersion", "kind", "checks", "author", "role", "displayName", "createdAt", "text", "signature"];

// A ballot code is 12 Crockford base-32 characters, often written 4-4-4. Nothing that looks like one may go in a
// public note or record (a voter's code is their private receipt).
const CODE_LIKE = [/(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{12}(?![0-9A-Za-z])/, /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{4}[- ][0-9A-HJKMNP-TV-Z]{4}[- ][0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z])/];
/** True if the text contains something shaped like a ballot code (12 letters/digits, alone or as 4-4-4). */
export function looksLikeBallotCode(text) {
  return CODE_LIKE.some((re) => re.test(String(text ?? "")));
}

/** Plain-language list of problems with a note (empty = fine). `signed` requires a signature. */
export function validateNote(note, { signed = false } = {}) {
  const e = [];
  if (!note || typeof note !== "object" || Array.isArray(note)) return ["The note isn't a JSON object."];
  for (const k of Object.keys(note)) if (!NOTE_FIELDS.includes(k)) e.push(`Unknown field "${k}".`);
  if (note.schema !== NOTE_SCHEMA) e.push(`schema must be "${NOTE_SCHEMA}".`);
  if (!ELECTION_CODE_RE.test(String(note.electionCode ?? ""))) e.push("electionCode must look like BEINGS-2026-ABC123.");
  if (!BYTES32.test(String(note.electionKey ?? ""))) e.push("electionKey must be 0x and 64 lower-case hex characters.");
  if (note.chainId !== CHAIN_ID) e.push(`chainId must be ${CHAIN_ID} (Flare Coston2).`);
  if (!Number.isSafeInteger(note.tallyVersion) || note.tallyVersion < 1 || note.tallyVersion > 0xffffffff) e.push("tallyVersion must be a whole number, 1 or more.");
  if (!NOTE_KINDS.includes(note.kind)) e.push(`kind must be one of ${NOTE_KINDS.join(", ")}.`);
  if (!Array.isArray(note.checks) || note.checks.some((c) => !CHECK_IDS.includes(c)) || new Set(note.checks).size !== note.checks.length) e.push("checks must be a list of distinct check names (R1 to R6), possibly empty.");
  if (!ADDRESS.test(String(note.author ?? ""))) e.push("author must be a wallet address.");
  if (!["organizer", "device", "reviewer"].includes(note.role)) e.push("role must be organizer, device or reviewer.");
  if (typeof note.displayName !== "string") e.push("displayName must be a string (empty for none).");
  else {
    if (utf8Len(note.displayName) > MAX_DISPLAY_NAME_BYTES) e.push(`displayName is longer than ${MAX_DISPLAY_NAME_BYTES} bytes.`);
    if (/[\u0000-\u001f\u007f]/.test(note.displayName)) e.push("displayName can't contain control characters.");
    if (note.displayName !== note.displayName.trim()) e.push("displayName can't start or end with spaces.");
  }
  if (!ISO.test(String(note.createdAt ?? ""))) e.push("createdAt must be an ISO time in UTC, like 2026-11-10T00:00:00.000Z.");
  if (typeof note.text !== "string" || !note.text.trim()) e.push("text can't be empty.");
  else if (note.text.length > MAX_TEXT_CHARS) e.push(`text is longer than ${MAX_TEXT_CHARS} characters.`);
  if ([note.text, note.displayName].some(looksLikeBallotCode)) e.push("The note contains something that looks like a ballot code. Ballot codes are private and never go in a public note.");
  if (signed && !SIG.test(String(note.signature ?? ""))) e.push("signature is missing or malformed.");
  if (!signed && note.signature !== undefined && !SIG.test(String(note.signature))) e.push("signature is malformed.");
  return e;
}

/** A new unsigned note. Throws with every problem listed if the input isn't valid. */
export function draftNote({ electionCode, electionKey, tallyVersion, author, role, text, checks = [], kind = "explanation", displayName = "", createdAt = new Date().toISOString(), chainId = CHAIN_ID }) {
  const note = { schema: NOTE_SCHEMA, electionCode, electionKey: String(electionKey ?? "").toLowerCase(), chainId, tallyVersion, kind, checks: [...checks].sort(), author, role, displayName: String(displayName ?? "").trim(), createdAt, text: String(text ?? "").trim() };
  const errs = validateNote(note);
  if (errs.length) throw new Error(errs.join(" "));
  return note;
}

/** The note without its signature: what bodyHash covers. */
export function noteBody(note) {
  const { signature: _ignored, ...rest } = note;
  void _ignored;
  return rest;
}
export const noteBodyCanonical = (note) => canonicalize(noteBody(note));

/**
 * EIP-712 typed data for a note. `keccak256` is (Uint8Array) => 0x hex (for example ethers.keccak256).
 * Returns { domain, types, primaryType, message } — pass domain/types/message to signer.signTypedData.
 */
export function noteTypedData(note, keccak256) {
  const bodyHash = keccak256(new TextEncoder().encode(noteBodyCanonical(note))).toLowerCase();
  return {
    domain: noteDomain(note.chainId),
    types: NOTE_TYPES,
    primaryType: "ElectionNote",
    message: { electionKey: note.electionKey, tallyVersion: note.tallyVersion, author: note.author, role: NOTE_ROLES.indexOf(note.role), bodyHash },
  };
}

/** The value posted on-chain as noteSha256: 0x + SHA-256 of the RFC 8785 JSON of the whole (signed) note. */
export async function noteFileSha256(note) {
  return "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(note))));
}

/** The signed note (a copy with `signature` set). Checks the signature first; throws if it isn't the author's. */
export function attachSignature(note, signature, { keccak256, verifyTypedData }) {
  const signed = { ...noteBody(note), signature };
  const v = verifyNoteSignature(signed, { keccak256, verifyTypedData });
  if (!v.valid) throw new Error(v.signer ? `This signature is from ${v.signer}, not the note's author ${note.author}.` : "That signature doesn't check out.");
  return signed;
}

/**
 * Check a signed note's EIP-712 signature in the browser (no wallet needed). Never throws.
 * `verifyTypedData` is ethers.verifyTypedData (returns the signer address). Result: { valid, signer, bodyHash, errors }.
 */
export function verifyNoteSignature(note, { keccak256, verifyTypedData }) {
  const errors = validateNote(note, { signed: true });
  if (errors.length) return { valid: false, signer: null, bodyHash: null, errors };
  try {
    const td = noteTypedData(note, keccak256);
    const signer = verifyTypedData(td.domain, td.types, td.message, note.signature);
    const valid = typeof signer === "string" && signer.toLowerCase() === note.author.toLowerCase();
    return { valid, signer, bodyHash: td.message.bodyHash, errors: valid ? [] : ["The signature was not made by the note's author."] };
  } catch (err) {
    return { valid: false, signer: null, bodyHash: null, errors: [`The signature can't be read: ${String(err?.message ?? err).slice(0, 120)}`] };
  }
}

/**
 * Compare the note's claimed role with the registry. `registry` = { organizer, roleOf(address) => "device" | "reviewer" | "none" }
 * (roleOf may be a plain value lookup). Returns { confirmed, actual }.
 */
export function confirmRole(note, { organizer, role }) {
  const actual = organizer && note.author.toLowerCase() === String(organizer).toLowerCase() ? "organizer" : role ?? "none";
  return { confirmed: actual === note.role, actual };
}

// ------------------------------------------------------------------ record manifest

/** SHA-256 for a record file: RFC 8785 for JSON (parsed value), raw bytes otherwise. Returns 64 hex (no 0x). */
export async function recordFileSha256({ json, bytes }) {
  if (json !== undefined) return sha256Hex(new TextEncoder().encode(canonicalize(json)));
  return sha256Hex(bytes);
}

/** Refuse anything private: a "ballotCodes" key with entries, or any string shaped like a ballot code. */
export function assertPublicJson(value, where = "file") {
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/^ballotCodes$/i.test(k) && (!Array.isArray(x) || x.length > 0)) throw new Error(`${where}: "${path}.${k}" holds ballot codes. The public record must never include them.`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === "string" && looksLikeBallotCode(v)) throw new Error(`${where}: "${path}" holds something shaped like a ballot code.`);
  };
  walk(value, "$");
  return true;
}

/**
 * Build the record manifest. files: [{ path, role, json? | bytes?, ...extra }] (extra keys such as
 * matchesOnChainResultsHash are copied). Every JSON file is checked with assertPublicJson.
 * Returns { manifest, manifestSha256 } (0x + 64 hex).
 */
export async function buildRecordManifest({ electionCode, electionKey, chainId = CHAIN_ID, contracts, tallyVersion, onChain, retention, createdAt, files, mirrors = [] }) {
  if (!ELECTION_CODE_RE.test(String(electionCode))) throw new Error("electionCode must look like BEINGS-2026-ABC123.");
  if (!BYTES32.test(String(electionKey))) throw new Error("electionKey must be 0x and 64 lower-case hex characters.");
  const seen = new Set();
  const entries = [];
  for (const f of files) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(f.path) || f.path.includes("..") || f.path === "manifest.json") throw new Error(`Bad file path in the record: ${f.path}`);
    if (seen.has(f.path)) throw new Error(`Listed twice: ${f.path}`);
    seen.add(f.path);
    if (f.json !== undefined) assertPublicJson(f.json, f.path);
    const { path, role, json, bytes, ...extra } = f;
    const sha256 = await recordFileSha256({ json, bytes });
    entries.push({ path, role, hashOf: json !== undefined ? "rfc8785-json" : "bytes", sha256, ...extra });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { schema: RECORD_SCHEMA, electionCode, electionKey, chainId, tallyVersion, createdAt, contracts, onChain, retention, mirrors, files: entries };
  assertPublicJson(manifest, "manifest.json");
  return { manifest, manifestSha256: "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(manifest)))) };
}

export async function manifestSha256(manifest) {
  return "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(manifest))));
}

/**
 * Check fetched files against the manifest. fetched: { [path]: { json? , bytes? } | null } (null = couldn't fetch).
 * Returns [{ path, role, expected, actual, state: "match" | "mismatch" | "missing" }].
 */
export async function checkRecordFiles(manifest, fetched) {
  const out = [];
  for (const f of manifest.files ?? []) {
    const got = fetched[f.path];
    if (!got) {
      out.push({ ...f, expected: f.sha256, actual: null, state: "missing" });
      continue;
    }
    const actual = f.hashOf === "bytes" ? await sha256Hex(got.bytes) : await recordFileSha256({ json: got.json });
    out.push({ ...f, expected: f.sha256, actual, state: actual === f.sha256 ? "match" : "mismatch" });
  }
  return out;
}

/** Plain-language names of the failed checks in a failedChecks bit mask, e.g. 32 -> ["R6"]. */
export function failedCheckIds(mask) {
  const m = Number(mask) || 0;
  return CHECK_IDS.filter((_, i) => (m & (1 << i)) !== 0);
}
