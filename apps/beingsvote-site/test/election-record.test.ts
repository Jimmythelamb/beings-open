// Long-term election record and officials' notes (public/js/record.js, results panel, admin ABI).
// Synthetic wallets and data only: no network, no real wallet, no ballot codes.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Interface, Wallet, keccak256, verifyTypedData, TypedDataEncoder, id as keccakId } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as RecordModule from "../public/js/record.js";
import { canonicalize } from "../public/js/format.js";
import { ABI as SiteAbi } from "../public/js/abi.js";
import { CONFIG, contractAddress } from "../public/js/config.js";
import { explainError } from "../public/js/logic.js";

// record.js is plain JS with JSDoc-free optional parameters; treat it as untyped here.
const R: any = RecordModule;
const ABI: any = SiteAbi;
const CODE = "BEINGS-2026-QB1TTH";
const KEY = keccakId(CODE).toLowerCase();
const WORDING_B =
  "Check R6 failed because the registered-voter number posted with the tally was 7, while the registry still lists 6 registered voters — the number fixed when the election was created. Six students voted, and one teacher cast a 7th ballot but was not supposed to vote. All 7 recorded ballots stay as read, and the official counts stay as posted. This is a classroom test. This note is an explanation; it does not change the counts or clear the flag.";
const organizer = Wallet.createRandom();
const stranger = Wallet.createRandom();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const deps = { keccak256, verifyTypedData };

const draft = (o: Record<string, unknown> = {}) =>
  R.draftNote({ electionCode: CODE, electionKey: KEY, tallyVersion: 1, author: organizer.address, role: "organizer", checks: ["R6"], text: WORDING_B, createdAt: "2026-11-11T01:58:26.000Z", ...o });

async function sign(note: any, w = organizer) {
  const td = R.noteTypedData(note, keccak256);
  return w.signTypedData(td.domain, td.types, td.message);
}

describe("note schema beings-election-note/1", () => {
  it("drafts the QB1TTH organizer note (wording B, no display name)", () => {
    const n = draft();
    expect(n).toMatchObject({ schema: "beings-election-note/1", electionCode: CODE, electionKey: "0x06e8345f17b34f326ef65138757946e703c0e8bf4285628f6027a9503db54345", chainId: 114, tallyVersion: 1, role: "organizer", displayName: "", checks: ["R6"], kind: "explanation" });
    expect(R.validateNote(n)).toEqual([]);
    expect(n.signature).toBeUndefined();
  });
  it("rejects bad input with plain reasons", () => {
    expect(() => draft({ text: "  " })).toThrow(/text can't be empty/);
    expect(() => draft({ role: "voter" })).toThrow(/role must be/);
    expect(() => draft({ tallyVersion: 0 })).toThrow(/tallyVersion/);
    expect(() => draft({ checks: ["R7"] })).toThrow(/checks/);
    expect(() => draft({ electionCode: "BEINGS-26-X" })).toThrow(/electionCode/);
    expect(() => draft({ createdAt: "yesterday" })).toThrow(/createdAt/);
    expect(R.validateNote({ ...draft(), extra: 1 })).toContain('Unknown field "extra".');
  });
  it("display name: optional, 64 bytes at most (UTF-8), no control characters", () => {
    expect(draft({ displayName: "a".repeat(64) }).displayName).toHaveLength(64);
    expect(() => draft({ displayName: "a".repeat(65) })).toThrow(/64 bytes/);
    expect(() => draft({ displayName: "é".repeat(33) })).toThrow(/64 bytes/);
    expect(() => draft({ displayName: "Ms\u0007Lee" })).toThrow(/control/);
    expect(draft({ displayName: "  Ms. Lee  " }).displayName).toBe("Ms. Lee");
    expect(R.NAME_WARNING).toMatch(/chain cannot forget/);
  });
  it("refuses anything shaped like a ballot code, in the text or the name", () => {
    expect(R.looksLikeBallotCode("4F9Q7M2XHT8B")).toBe(true);
    expect(R.looksLikeBallotCode("code 4F9Q-7M2X-HT8B here")).toBe(true);
    expect(R.looksLikeBallotCode(CODE)).toBe(false);
    expect(R.looksLikeBallotCode("RECONCILIATION")).toBe(false);
    expect(R.looksLikeBallotCode("0x" + "ab".repeat(32))).toBe(false);
    expect(() => draft({ text: "My ballot 4F9Q7M2XHT8B was fine" })).toThrow(/ballot code/);
    expect(() => draft({ displayName: "4F9Q-7M2X-HT8B" })).toThrow(/ballot code/);
  });
});

describe("EIP-712 signing and browser-side verification", () => {
  it("typed data: domain without verifyingContract, ElectionNote type, bodyHash over RFC 8785 body", () => {
    const n = draft();
    const td = R.noteTypedData(n, keccak256);
    expect(td.domain).toEqual({ name: "B.E.I.N.G.S.", version: "1", chainId: 114 });
    expect(td.primaryType).toBe("ElectionNote");
    expect(TypedDataEncoder.from(td.types).encodeType("ElectionNote")).toBe("ElectionNote(bytes32 electionKey,uint32 tallyVersion,address author,uint8 role,bytes32 bodyHash)");
    expect(td.message.role).toBe(1);
    expect(td.message.bodyHash).toBe(keccak256(new TextEncoder().encode(canonicalize(n))));
  });
  it("a signed note verifies; the signature is ignored by bodyHash", async () => {
    const n = draft();
    const s = R.attachSignature(n, await sign(n), deps);
    const v = R.verifyNoteSignature(s, deps);
    expect(v.valid).toBe(true);
    expect(v.signer).toBe(organizer.address);
    expect(R.noteTypedData(s, keccak256).message.bodyHash).toBe(R.noteTypedData(n, keccak256).message.bodyHash);
  });
  it("one changed character, a changed role, author or tally version all fail", async () => {
    const s = R.attachSignature(draft(), await sign(draft()), deps);
    expect(R.verifyNoteSignature({ ...s, text: s.text.replace("7th", "8th") }, deps).valid).toBe(false);
    expect(R.verifyNoteSignature({ ...s, role: "reviewer" }, deps).valid).toBe(false);
    expect(R.verifyNoteSignature({ ...s, author: stranger.address }, deps).valid).toBe(false);
    expect(R.verifyNoteSignature({ ...s, tallyVersion: 2 }, deps).valid).toBe(false);
    expect(R.verifyNoteSignature({ ...s, signature: "0x1234" }, deps)).toMatchObject({ valid: false });
  });
  it("attachSignature refuses a signature from another wallet", async () => {
    const n = draft();
    expect(() => R.attachSignature(n, "0x" + "11".repeat(65), deps)).toThrow();
    const other = await sign(n, stranger);
    expect(() => R.attachSignature(n, other, deps)).toThrow(/not the note's author/);
  });
  it("confirmRole compares the claim with the registry", () => {
    const n = draft();
    expect(R.confirmRole(n, { organizer: organizer.address.toLowerCase(), role: "none" })).toEqual({ confirmed: true, actual: "organizer" });
    expect(R.confirmRole(n, { organizer: stranger.address, role: "device" })).toEqual({ confirmed: false, actual: "device" });
  });
  it("noteSha256 (posted on-chain) = SHA-256 of the RFC 8785 JSON of the signed note, however it is pretty-printed", async () => {
    const s = R.attachSignature(draft(), await sign(draft()), deps);
    const h = await R.noteFileSha256(s);
    expect(h).toBe("0x" + sha(canonicalize(s)));
    expect(await R.noteFileSha256(JSON.parse(JSON.stringify(s, null, 2)))).toBe(h);
    expect(h).not.toBe(await R.noteFileSha256(draft()));
  });
});

describe("record manifest beings-election-record/1", () => {
  const pub = JSON.parse(readFileSync(fileURLToPath(new URL("../public/data/elections/BEINGS-2026-QB1TTH.json", import.meta.url)), "utf8"));
  // The QB1TTH results file as the admin page built it (no ballot codes); its fingerprint is on-chain as resultsSha256.
  const results = {
    electionCode: CODE,
    merkleRoot: "0x6e7c7f54b6eff97879a3a52f50a03f923e317bb0353eb6b913ac185fbea8fc7f",
    perQuestion: [{ valid: 7, blank: 0, overvote: 0, unclear: 0 }, { valid: 7, blank: 0, overvote: 0, unclear: 0 }],
    counts: { registered: 7, printed: 7, issued: 7, cast: 7, spoiled: 0, unusedReturned: 0, unissued: 0 },
    failedChecks: 32,
    postedFrom: "web-admin",
  };
  const base = async (noteJson: any, extra: any = {}) =>
    R.buildRecordManifest({
      electionCode: CODE,
      electionKey: KEY,
      contracts: { ...CONFIG.contracts, notes: null },
      tallyVersion: 1,
      onChain: { resultsSha256: "0x554e8a21ff93f2c382963eebe8b6c21105eca12a15ef1ee840eaeda2229622e1", failedChecks: 32 },
      retention: { keepUntil: null },
      createdAt: "2026-11-11T01:58:26.000Z",
      files: [
        { path: "election.public.json", role: "public-election-copy", json: pub, matchesOnChainFileHash: false },
        { path: "results.json", role: "results-doc", json: results, matchesOnChainResultsHash: true },
        { path: "notes/organizer-note-1.json", role: "official-note", json: noteJson },
      ],
      ...extra,
    });

  it("the QB1TTH public copy has no ballot codes; the results file matches the on-chain resultsSha256", async () => {
    expect(pub.publicCopy).toBe(true);
    expect(pub.file.ballotCodes).toBeUndefined();
    expect(R.assertPublicJson(pub)).toBe(true);
    expect(await R.recordFileSha256({ json: results })).toBe("554e8a21ff93f2c382963eebe8b6c21105eca12a15ef1ee840eaeda2229622e1");
  });
  it("is deterministic and sorted, and the fingerprint is SHA-256 of its RFC 8785 form", async () => {
    const a = await base(draft());
    const b = await base(JSON.parse(JSON.stringify(draft())));
    expect(a.manifestSha256).toBe(b.manifestSha256);
    expect(a.manifest.files.map((f: any) => f.path)).toEqual(["election.public.json", "notes/organizer-note-1.json", "results.json"]);
    expect(a.manifestSha256).toBe("0x" + sha(canonicalize(a.manifest)));
    expect(await R.manifestSha256(a.manifest)).toBe(a.manifestSha256);
  });
  it("any changed file changes the fingerprint (signing the note too)", async () => {
    const a = await base(draft());
    const signed = R.attachSignature(draft(), await sign(draft()), deps);
    const b = await base(signed);
    expect(b.manifestSha256).not.toBe(a.manifestSha256);
  });
  it("refuses private material: a ballotCodes list, a code-shaped string, bad paths, duplicates", async () => {
    await expect(base(draft(), { files: [{ path: "x.json", role: "x", json: { file: { ballotCodes: ["4F9Q7M2XHT8B"] } } }] })).rejects.toThrow(/ballot codes/);
    await expect(base(draft(), { files: [{ path: "x.json", role: "x", json: { note: "4F9Q7M2XHT8B" } }] })).rejects.toThrow(/ballot code/);
    await expect(base(draft(), { files: [{ path: "../secret.json", role: "x", json: {} }] })).rejects.toThrow(/Bad file path/);
    await expect(base(draft(), { files: [{ path: "a.json", role: "x", json: {} }, { path: "a.json", role: "x", json: {} }] })).rejects.toThrow(/twice/);
    expect(R.assertPublicJson({ omitted: ["ballotCodes"], ballotCodes: [] })).toBe(true);
    await expect(base(draft(), { files: [{ path: "x.json", role: "x", json: { addedBallotPools: [{ codes: ["AAAAAAAAAAAA"] }] } }] })).rejects.toThrow(/ballot code/);
  });
  it("checkRecordFiles: match, mismatch and missing", async () => {
    const { manifest } = await base(draft());
    const ok = await R.checkRecordFiles(manifest, { "election.public.json": { json: pub }, "results.json": { json: results }, "notes/organizer-note-1.json": { json: draft() } });
    expect(ok.map((f: any) => f.state)).toEqual(["match", "match", "match"]);
    const bad = await R.checkRecordFiles(manifest, { "election.public.json": { json: pub }, "results.json": { json: { ...results, failedChecks: 2 } }, "notes/organizer-note-1.json": null });
    expect(bad.map((f: any) => f.state)).toEqual(["match", "missing", "mismatch"]);
  });
  it("failed-check bit mask to names", () => {
    expect(R.failedCheckIds(32)).toEqual(["R6"]);
    expect(R.failedCheckIds(0)).toEqual([]);
    expect(R.failedCheckIds(2 | 32)).toEqual(["R2", "R6"]);
  });
});

describe("ElectionNotes wiring in the site", () => {
  const artifact = fileURLToPath(new URL("../../../packages/ledger/artifacts/contracts/ElectionNotes.sol/ElectionNotes.json", import.meta.url));
  it.skipIf(!existsSync(artifact))("ABI.notes matches the compiled contract (functions, event, errors)", () => {
    const compiled = new Interface(JSON.parse(readFileSync(artifact, "utf8")).abi);
    const site = new Interface(ABI.notes);
    const sigs = (i: Interface, type: string) => i.fragments.filter((f) => f.type === type).map((f: any) => f.format("sighash")).sort();
    for (const t of ["function", "event", "error"]) expect(sigs(site, t)).toEqual(sigs(compiled, t));
  });
  it("roles index = ElectionNotes.AuthorRole; limits match the contract", () => {
    expect(R.NOTE_ROLES).toEqual(["none", "organizer", "device", "reviewer"]);
    expect(R.MAX_DISPLAY_NAME_BYTES).toBe(64);
    expect(R.MAX_CID_BYTES).toBe(256);
  });
  it("the notes contract is optional: empty by default, sendTx refuses an unset contract", () => {
    expect(CONFIG.notesContract).toBe("");
    expect(contractAddress("notes")).toBe("");
    expect(contractAddress("tally")).toBe(CONFIG.contracts.tally);
    expect(Object.keys(CONFIG.contracts)).toEqual(["registry", "ledger", "tally", "verifiers"]);
  });
  it("every ElectionNotes error has a plain-language explanation", () => {
    for (const name of ["NotAuthorized", "NotTallied", "EmptyNoteHash", "EmptyCid", "CidTooLong", "DisplayNameTooLong", "DuplicateNote", "BadTallyVersion", "UnknownElection", "ZeroAddress"]) {
      expect(explainError({ revert: { name, args: [3] } })).not.toMatch(/^Something went wrong/);
    }
    expect(explainError({ revert: { name: "NotTallied", args: [3] } })).toMatch(/closed/);
  });
});

// ------------------------------------------------------------------ the Results panel, rendered into a tiny fake DOM
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  className = "";
  hidden = false;
  style: any = {};
  dataset: any = {};
  textContent = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: any[]) {
    this.children = c;
  }
  addEventListener() {}
  querySelector(): any {
    return new FakeEl("button");
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (c instanceof FakeEl ? c.text : String(c))).join("");
  }
}
describe("Results panel view", () => {
  let view: typeof import("../public/js/results.js");
  beforeAll(async () => {
    (globalThis as any).Node = FakeEl;
    (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
    view = await import("../public/js/results.js");
  });
  afterAll(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).Node;
  });
  const model = async (o: any = {}) => {
    const s = R.attachSignature(draft(), await sign(draft()), deps);
    return {
      code: CODE,
      failedIds: ["R6"],
      final: false,
      notesContract: false,
      manifest: { retention: { keepUntil: null }, files: [] },
      manifestSha256: "0x" + "12".repeat(32),
      manifestAnchor: undefined,
      files: [{ path: "results.json", role: "results-doc", sha256: "554e8a21ff93f2c382963eebe8b6c21105eca12a15ef1ee840eaeda2229622e1", state: "match", matchesOnChainResultsHash: true }],
      notes: [{ path: "notes/organizer-note-1.json", note: s, signed: true, sig: R.verifyNoteSignature(s, deps), role: { confirmed: true, actual: "organizer" }, noteSha256: await R.noteFileSha256(s), anchor: undefined }],
      url: "https://example.invalid/manifest.json",
      bytes: {},
      ...o,
    };
  };
  const textOf = (nodes: any[]) => nodes.flat(Infinity).map((n: any) => (n instanceof FakeEl ? n.text : String(n ?? ""))).join(" ");
  it("labels the note as the organizer's explanation, not a ledger fact, with wallet, role, signature and hash", async () => {
    const m = await model();
    const t = textOf(view.recordPanelView(m));
    expect(t).toContain("Election record and organizer notes");
    expect(t).toContain("Organizer's explanation, not a ledger fact");
    expect(t).toContain("does not clear the flag");
    expect(t).toContain(organizer.address);
    expect(t).toContain("Organizer on the registry");
    expect(t).toContain("Signature valid");
    expect(t).toContain("Note fingerprint (SHA-256)");
    expect(t).toContain("Signed file only");
    expect(t).toContain("Download the record bundle (.zip)");
    expect(t).toContain("matches the results fingerprint on the ledger");
  });
  it("a tampered or unsigned note is shown as untrusted", async () => {
    const m = await model();
    const bad = { ...m.notes[0], sig: { valid: false, errors: ["The signature was not made by the note's author."] } };
    expect(textOf(view.recordPanelView({ ...m, notes: [bad] }))).toContain("Don't rely on this note");
    const unsigned = { ...m.notes[0], signed: false };
    expect(textOf(view.recordPanelView({ ...m, notes: [unsigned] }))).toContain("Not signed (draft)");
  });
  it("shows the ledger anchor when the notes contract is configured", async () => {
    const m = await model({ notesContract: true, manifestAnchor: null });
    m.notes[0].anchor = { author: organizer.address, role: "organizer", tallyVersion: 1, postedAt: 1794361971, index: 0 };
    const t = textOf(view.recordPanelView(m));
    expect(t).toContain("Fingerprint on the ledger");
    expect(t).toMatch(/Posted .* \(organizer\)/);
    expect(textOf(view.recordPanelView(await model({ notesContract: true, manifestAnchor: null })))).toContain("Not on the ledger yet");
  });
  it("no record: a short line, nothing else", () => {
    expect(textOf(view.recordPanelView(null))).toContain("No long-term record has been published");
  });
});
