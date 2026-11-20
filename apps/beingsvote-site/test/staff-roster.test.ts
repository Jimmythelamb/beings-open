// Staff roster chain rules. Synthetic names and wallets only.
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { keccak256, toUtf8Bytes, AbiCoder, TypedDataEncoder } from "ethers";
import { emptyRoster, loadRoster, memoryStorage, publicRoster, saveRoster, setElectionKind } from "../public/js/roster.js";
import { submissionGate } from "../public/js/logic.js";
import { rosterReviewCard, systemSignOffCard } from "../public/js/roster-review.js";
import {
  CLASSROOM_LABEL,
  LOCK_ATTESTATION,
  SYSTEM_SIGNOFF_STATEMENT,
  TEST_STATEMENT,
  assessRosterReview,
  assembleSystemSignOff,
  closeOutSheetHash,
  custodyTypedData,
  lockAllowed,
  lockTypedData,
  personNameHash,
  rosterFileHash,
  staffDomain,
  systemSignOffTypedData,
} from "../public/js/staff-roster.js";

const CODE = "BEINGS-2026-RST4XY";
const ADMIN = "0x1111111111111111111111111111111111111111";
const OFFICER = "0x2222222222222222222222222222222222222222";
const OFFICER_2 = "0x3333333333333333333333333333333333333333";
const CONTRACT = "0x4444444444444444444444444444444444444444";

const ethersLike = {
  keccak256: (v: string) => keccak256(v),
  toUtf8Bytes,
  AbiCoder: { defaultAbiCoder: () => AbiCoder.defaultAbiCoder() },
};

describe("election type and two ballot handlers", () => {
  it("refuses a standard lock when fewer than two officers are recorded, and allows test and classroom", () => {
    const standard = setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "standard");
    const one = assessRosterReview(standard, {
      organizerAddress: ADMIN,
      chain: { configured: true, known: true, kind: "standard", seats: { officer: { wallet: OFFICER, covered: false } } },
    });
    expect(one.blocking).toBe(true);
    expect(one.certifiedPossible).toBe(false);
    expect(one.problems.some((p) => /two Election officers/.test(p.text) && p.blocking)).toBe(true);
    expect(lockAllowed({ kind: "standard", problems: one.problems, reviewTicked: true, adminRecorded: true })).toBe(false);

    const two = assessRosterReview(standard, {
      organizerAddress: ADMIN,
      chain: {
        configured: true,
        known: true,
        kind: "standard",
        seats: {
          officer: { wallet: OFFICER, covered: false },
          "officer-2": { wallet: OFFICER_2, covered: false },
        },
      },
    });
    expect(two.problems.some((p) => /two Election officers/.test(p.text))).toBe(false);

    const test = assessRosterReview(setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "test"), {
      organizerAddress: ADMIN,
      chain: { configured: true, known: true, kind: "test", seats: { officer: { wallet: OFFICER, covered: false } } },
    });
    expect(test.problems.some((p) => /two Election officers/.test(p.text))).toBe(false);
    expect(test.certifiedPossible).toBe(false);

    const classroom = assessRosterReview(setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "classroom"), {
      organizerAddress: ADMIN,
      chain: { configured: true, known: true, kind: "classroom", locked: false, seats: { officer: { wallet: "", covered: true } } },
    });
    expect(classroom.label).toBe(CLASSROOM_LABEL);
    expect(classroom.problems.some((p) => /two Election officers/.test(p.text))).toBe(false);
    expect(classroom.certifiedPossible).toBe(false);
  });

  it("keeps the lock button disabled until the attestation is ticked, and until a standard roster has two handlers", () => {
    const roster = setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "standard");
    const chain = { configured: true, known: true, kind: "standard", address: CONTRACT, electionId: keccak256(toUtf8Bytes(CODE)), seats: { officer: { wallet: OFFICER, covered: false } } };
    const card = rosterReviewCard({
      roster,
      organizerAddress: ADMIN,
      chain,
      canEdit: true,
      hashRoster: async () => "0x" + "ab".repeat(32),
      signTyped: async () => ({ status: "signed", signature: "0x" + "11".repeat(65) }),
      onLock: () => {},
    });
    const button = card.querySelector("#roster-lock-btn") as HTMLButtonElement;
    const box = card.querySelector("#roster-lock-attest") as HTMLInputElement;
    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain("two Election officers");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((card.querySelector("#roster-lock-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(card.textContent).toContain(LOCK_ATTESTATION);
    expect(card.textContent).toContain("legal adult");
  });

  it("builds EIP-712 data for this chain and contract, and a stable roster fingerprint", () => {
    const roster = setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "classroom");
    const hash = rosterFileHash(roster, ethersLike);
    expect(hash).toBe(rosterFileHash(roster, ethersLike));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const domain = staffDomain(CONTRACT);
    expect(domain).toMatchObject({ name: "B.E.I.N.G.S.", version: "1", chainId: 114, verifyingContract: CONTRACT });
    const typed = lockTypedData({ verifyingContract: CONTRACT, electionId: keccak256(toUtf8Bytes(CODE)), rosterHash: hash });
    expect(typed.message.attestation).toBe(LOCK_ATTESTATION);
    expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.message)).toMatch(/^0x/);
    const custody = custodyTypedData({ verifyingContract: CONTRACT, electionId: typed.message.electionId, action: 1, subjectHash: hash, officer: OFFICER, scanner: OFFICER_2, nonce: 1 });
    expect(custody.primaryType).toBe("CustodyWitness");
    expect(custody.message).toMatchObject({ action: 1, officer: OFFICER, scanner: OFFICER_2 });
    const stored = custodyTypedData({ verifyingContract: CONTRACT, electionId: typed.message.electionId, action: 3, subjectHash: hash, officer: OFFICER, scanner: "0x0000000000000000000000000000000000000000", nonce: 2 });
    expect(stored.message.action).toBe(3);
    expect(TEST_STATEMENT).toContain("test election");
  });

  it("blocks a ballot from a wallet that is not an approved scanner once scanners are recorded", () => {
    const open = { chainId: 114, verifyingContract: "0xabc", ledger: "0xabc", role: 1, status: 2, found: false, spoiled: false, quorum: 1, signer: OFFICER, device: OFFICER };
    expect(submissionGate(open).ok).toBe(true);
    expect(submissionGate({ ...open, approvedScanners: [OFFICER_2] }).reason).toMatch(/Scanner operator/);
    expect(submissionGate({ ...open, approvedScanners: [OFFICER] }).ok).toBe(true);
    expect(submissionGate({ ...open, approvedScanners: [] }).ok).toBe(true);
  });
});

describe("salted name fingerprints and the system sign-off", () => {
  it("mixes a per-person salt into the name hash and keeps that salt out of the public fingerprint", () => {
    const saltA = "0x" + "11".repeat(32);
    const saltB = "0x" + "22".repeat(32);
    const salted = personNameHash(ethersLike, "Ada", "Lovelace", saltA);
    const plain = keccak256(toUtf8Bytes("Ada Lovelace"));
    expect(salted).not.toBe(plain);
    expect(personNameHash(ethersLike, "Ada", "Lovelace", saltB)).not.toBe(salted);
    expect(salted).toBe(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [saltA, "Ada Lovelace"])));
    expect(() => personNameHash(ethersLike, "Ada", "Lovelace", "0x" + "00".repeat(32))).toThrow(/salt/);
    let roster = setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "standard");
    roster = { ...roster, seats: roster.seats.map((seat) => (seat.id === "system" ? { ...seat, firstName: "Ada", lastName: "Lovelace", nameSalt: saltA } : seat)) };
    const hash = rosterFileHash(roster, ethersLike);
    const swapped = { ...roster, seats: roster.seats.map((seat) => (seat.id === "system" ? { ...seat, nameSalt: saltB } : seat)) };
    expect(rosterFileHash(swapped, ethersLike)).toBe(hash);
    expect(JSON.stringify(publicRoster(roster))).not.toContain(saltA);
    expect(JSON.stringify(publicRoster(roster))).not.toContain("nameSalt");
  });

  it("binds the close-out signature to the duty sheets and the position ids they cover", () => {
    const electionId = keccak256(toUtf8Bytes(CODE));
    const position = keccak256(AbiCoder.defaultAbiCoder().encode(["uint8", "uint16"], [4, 1]));
    const duty = "Sets up and monitors the scanner computers.";
    const assembled = assembleSystemSignOff(ethersLike, {
      electionId,
      rosterHash: "0x" + "ab".repeat(32),
      seats: [{ id: "system", role: "system", label: "System admin", duty, wallet: OFFICER, positionId: position }],
    });
    expect(assembled.lines[0].sheetHash).toBe(closeOutSheetHash(ethersLike, { electionId, positionId: position, role: "system", duty, wallet: OFFICER }));
    const typed = systemSignOffTypedData({
      verifyingContract: CONTRACT,
      electionId,
      rosterHash: assembled.rosterHash,
      dutiesHash: assembled.dutiesHash,
      positionSetHash: assembled.positionSetHash,
    });
    expect(typed.primaryType).toBe("SystemSignOff");
    expect(typed.message.statement).toBe(SYSTEM_SIGNOFF_STATEMENT);
    expect(typed.types.SystemSignOff.map((field) => field.name)).not.toContain("nameSalt");
    expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.message)).toMatch(/^0x/);
  });

  it("shows the System admin the duties and records a signature only after the statement is ticked", async () => {
    const prepared = {
      contract: CONTRACT,
      electionId: keccak256(toUtf8Bytes(CODE)),
      rosterHash: "0x" + "ab".repeat(32),
      dutiesHash: "0x" + "cd".repeat(32),
      positionSetHash: "0x" + "ef".repeat(32),
      positionIds: ["0x" + "01".repeat(32)],
      sheetHashes: ["0x" + "02".repeat(32)],
      lines: [{ role: "system", label: "System admin", duty: "Sets up machines", wallet: OFFICER, positionId: "0x" + "01".repeat(32), sheetHash: "0x" + "02".repeat(32) }],
    };
    let signed: any = null;
    const card = systemSignOffCard({
      electionCode: CODE,
      kind: "standard",
      status: 3,
      prepared,
      connectedAddress: OFFICER,
      contractReady: true,
      onSign: async (payload) => {
        signed = payload;
      },
    });
    expect(card.textContent).toContain("cannot be certified");
    expect(card.textContent).toContain("Sets up machines");
    expect((card.querySelector("#system-signoff-btn") as HTMLButtonElement).disabled).toBe(true);
    const box = card.querySelector("#system-signoff-attest") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    const live = card.querySelector("#system-signoff-btn") as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    live.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signed.statement).toBe(SYSTEM_SIGNOFF_STATEMENT);
    expect(signed.typed.message.dutiesHash).toBe(prepared.dutiesHash);
    expect(signed.positionIds).toEqual(prepared.positionIds);
    expect(signed.sheetHashes).toEqual(prepared.sheetHashes);

    const classroom = systemSignOffCard({
      electionCode: CODE,
      kind: "classroom",
      status: 3,
      prepared: { ...prepared, lines: [] },
      contractReady: true,
      connectedAddress: OFFICER,
    });
    expect(classroom.textContent).toContain("optional");
    expect(classroom.textContent).toContain("not certified");
    const testKind = systemSignOffCard({
      electionCode: CODE,
      kind: "test",
      status: 3,
      prepared,
      recorded: true,
      current: true,
      contractReady: true,
      connectedAddress: OFFICER,
    });
    expect(testKind.textContent).toContain("disclosed");
    expect((testKind.querySelector("#system-signoff-btn") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("roster storage keeps the election type", () => {
  it("remembers standard, test, or classroom and drops anything else", () => {
    const store = memoryStorage();
    saveRoster(store, setElectionKind(emptyRoster(CODE, { organizerAddress: ADMIN }), "test"));
    expect(loadRoster(store, CODE, { organizerAddress: ADMIN }).electionKind).toBe("test");
    const bad = JSON.parse(store.getItem("beings.staffRoster." + CODE) as string);
    bad.electionKind = "practice";
    store.setItem("beings.staffRoster." + CODE, JSON.stringify(bad));
    expect(loadRoster(store, CODE, { organizerAddress: ADMIN }).electionKind).toBe("");
  });
});
