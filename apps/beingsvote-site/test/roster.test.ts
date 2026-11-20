// Election staff roster. Synthetic names and wallets only. No network and no ballot codes in the public copy.
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Wallet, keccak256, verifyMessage } from "ethers";
import { publicElectionCopy } from "../public/js/logic.js";
import { ROLE_INFO } from "../public/js/roles.js";
import { shortAddress } from "../public/js/format.js";
import { rosterCard } from "../public/js/roster-ui.js";
import {
  EXECUTIVE_STAFF_SCHEMA,
  NAME_SALT_NOTE,
  ROSTER_NOTE,
  OFFICER_DUTY,
  SCANNER_DUTY,
  SYSTEM_ADMIN_DUTY,
  addSeat,
  applyEdits,
  buildApprovalMessage,
  buildClaimMessage,
  claimIsCurrent,
  executiveStaffRecord,
  emptyRoster,
  grantIsCurrent,
  lineView,
  loadRoster,
  memoryStorage,
  orderedSeats,
  publicRoster,
  recordApproval,
  recordLinkedClaim,
  rosterProblems,
  rosterSigningReport,
  adminRegistrationMessage,
  parseAdminRegistration,
  readAdminRegistration,
  recordAdminRegistration,
  registrationIsCurrent,
  saveAdminRegistration,
  saveRoster,
  signatureMatches,
  unlinkSeat,
  verifyRosterSignatures,
  withPublicRoster,
} from "../public/js/roster.js";

const CODE = "BEINGS-2026-RST4XY";
const ADMIN = "0x1111111111111111111111111111111111111111";
const SYSTEM = "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd";
const WHEN = "2026-11-16T01:00:00.000Z";
const LATER = "2026-11-16T01:05:00.000Z";
const NONCE = "abc12345abc12345abc12345abc12345";

const seat = (roster: any, id: string) => roster.seats.find((s: any) => s.id === id);
const hashSig = (signature: string) => keccak256(signature);

async function signedClaim(wallet: Wallet, roster: any, id: string, when = WHEN) {
  const live = seat(roster, id);
  const message = buildClaimMessage({
    firstName: live.firstName,
    lastName: live.lastName,
    position: lineView(live, { electionCode: CODE }).line,
    electionCode: CODE,
    nonce: NONCE,
    signedAt: when,
  });
  const signature = await wallet.signMessage(message);
  return recordLinkedClaim(roster, id, { signature, nonce: NONCE, signedAt: when, address: wallet.address });
}

describe("staff roster records", () => {
  it("covers an unnamed line with the administrator sign-in and does not store that wallet on the line", () => {
    const roster = emptyRoster(CODE, { organizerAddress: ADMIN });
    expect(orderedSeats(roster).map((s) => s.role)).toEqual(["admin", "officer", "verifier", "scanner", "system"]);
    expect(seat(roster, "admin").address).toBe(ADMIN);
    for (const id of ["officer", "verifier", "scanner", "system"]) expect(seat(roster, id).address).toBe("");
    const system = lineView(seat(roster, "system"), { electionCode: CODE, organizerAddress: ADMIN });
    expect(system).toMatchObject({ covered: true, active: true, open: false, name: "", address: "", coveringWallet: ADMIN, line: "System admin", duty: SYSTEM_ADMIN_DUTY, status: "covered" });
    expect(system.duty).toBe(ROLE_INFO.system.blurb);
    expect(lineView(seat(roster, "officer"), { electionCode: CODE, organizerAddress: ADMIN }).duty).toBe(OFFICER_DUTY);
    expect(lineView(seat(roster, "scanner"), { electionCode: CODE, organizerAddress: ADMIN }).duty).toBe(SCANNER_DUTY);
    expect(OFFICER_DUTY).toMatch(/stores the paper ballots/);
    expect(SCANNER_DUTY).toMatch(/Does not handle the paper alone/);
    const admin = lineView(seat(roster, "admin"), { electionCode: CODE, organizerAddress: ADMIN });
    expect(admin).toMatchObject({ showElectionId: true, name: "Open", address: ADMIN, line: "Election Administrator", covered: false });
    const started = applyEdits(roster, [{ id: "system", firstName: "Ada", lastName: "" }], { organizerAddress: ADMIN });
    expect(lineView(seat(started, "system"), { electionCode: CODE, organizerAddress: ADMIN })).toMatchObject({ covered: false, active: false, status: "incomplete", coveringWallet: "" });
    const named = applyEdits(roster, [{ id: "system", firstName: "Ada", lastName: "Lovelace" }], { organizerAddress: ADMIN });
    expect(lineView(seat(named, "system"), { electionCode: CODE, organizerAddress: ADMIN })).toMatchObject({ status: "named", active: false, address: "", coveringWallet: "" });
    const back = applyEdits(named, [{ id: "system", firstName: "", lastName: "", address: SYSTEM }], { organizerAddress: ADMIN });
    expect(seat(back, "system").address).toBe("");
    expect(lineView(seat(back, "system"), { electionCode: CODE, organizerAddress: ADMIN }).status).toBe("covered");
  });

  it("rejects a ballot-code name and a second copy of the administrator wallet", () => {
    const roster = emptyRoster(CODE, { organizerAddress: ADMIN });
    seat(roster, "system").firstName = "AAAAAAAAAAAA";
    seat(roster, "system").lastName = "Ada";
    seat(roster, "system").address = SYSTEM;
    expect(rosterProblems(roster).join(" ")).toMatch(/ballot code/);
    seat(roster, "system").firstName = "Ada";
    seat(roster, "system").address = ADMIN;
    expect(rosterProblems(roster).join(" ")).toMatch(/one roster line/);
  });

  it("moves a line from a name, to a linked wallet, to an approval, and checks both signatures", async () => {
    const organizer = Wallet.createRandom();
    const sys = Wallet.createRandom();
    let roster = emptyRoster(CODE, { organizerAddress: organizer.address });
    roster = applyEdits(
      roster,
      [
        { id: "admin", firstName: "Grace", lastName: "Hopper" },
        { id: "system", firstName: "Ada", lastName: "Lovelace" },
      ],
      { organizerAddress: organizer.address },
    );
    expect(lineView(seat(roster, "system"), { electionCode: CODE, organizerAddress: organizer.address })).toMatchObject({ status: "named", active: false, covered: false });
    roster = applyEdits(roster, [{ id: "system", firstName: "Ada", lastName: "Lovelace", address: sys.address }], { organizerAddress: organizer.address });
    expect(lineView(seat(roster, "system"), { electionCode: CODE, verifyMessage }).status).toBe("unverified");

    roster = await signedClaim(sys, roster, "system");
    const claim = seat(roster, "system").claim;
    expect(signatureMatches(claim.message, claim.signature, sys.address, verifyMessage)).toBe(true);
    expect(claim.message).toBe(
      `B.E.I.N.G.S. staff claim: I, Ada Lovelace, hold this wallet and accept the position System admin for election ${CODE}. Nonce ${NONCE}, ${WHEN}`,
    );
    expect(lineView(seat(roster, "system"), { electionCode: CODE, verifyMessage }).status).toBe("linked");
    expect(verifyRosterSignatures(roster, { verifyMessage, hashSignature: hashSig, organizerAddress: organizer.address })).toEqual([]);

    const hash = hashSig(claim.signature);
    const approvalText = buildApprovalMessage({
      adminName: "Grace Hopper",
      adminWallet: organizer.address,
      firstName: "Ada",
      lastName: "Lovelace",
      staffWallet: sys.address,
      position: "System admin",
      electionCode: CODE,
      claimHash: hash,
      signedAt: LATER,
    });
    const approved = recordApproval(roster, "system", {
      signature: await organizer.signMessage(approvalText),
      signedAt: LATER,
      grantor: organizer.address,
      adminName: "Grace Hopper",
      claimHash: hash,
    });
    const grant = seat(approved, "system").grant;
    expect(signatureMatches(grant.message, grant.signature, organizer.address, verifyMessage)).toBe(true);
    expect(grantIsCurrent(seat(approved, "system"), CODE, organizer.address, hashSig, verifyMessage)).toBe(true);
    expect(lineView(seat(roster, "system"), { electionCode: CODE, organizerAddress: organizer.address, verifyMessage }).active).toBe(false);
    expect(lineView(seat(approved, "system"), { electionCode: CODE, organizerAddress: organizer.address, verifyMessage, hashSignature: hashSig })).toMatchObject({ status: "approved", active: true, covered: false });

    const stranger = Wallet.createRandom();
    const forged = recordApproval(roster, "system", {
      signature: await stranger.signMessage(approvalText.replace(organizer.address, stranger.address)),
      signedAt: LATER,
      grantor: stranger.address,
      adminName: "Grace Hopper",
      claimHash: hash,
    });
    expect(lineView(seat(forged, "system"), { electionCode: CODE, organizerAddress: organizer.address, verifyMessage, hashSignature: hashSig }).status).not.toBe("approved");
    expect(verifyRosterSignatures(forged, { verifyMessage, hashSignature: hashSig, organizerAddress: organizer.address }).join(" ")).toMatch(/approval signature/);
    expect(rosterSigningReport().join(" ")).toBe(ROSTER_NOTE);
    expect(ROSTER_NOTE).not.toMatch(/registerReviewer|registerDevice/);
  });

  it("clears the approval when the name or the wallet changes", async () => {
    const organizer = Wallet.createRandom();
    const sys = Wallet.createRandom();
    const other = Wallet.createRandom();
    let roster = applyEdits(
      emptyRoster(CODE, { organizerAddress: organizer.address }),
      [
        { id: "admin", firstName: "Grace", lastName: "Hopper" },
        { id: "system", firstName: "Ada", lastName: "Lovelace", address: sys.address },
      ],
      { organizerAddress: organizer.address },
    );
    roster = await signedClaim(sys, roster, "system");
    const hash = hashSig(seat(roster, "system").claim.signature);
    const text = buildApprovalMessage({
      adminName: "Grace Hopper",
      adminWallet: organizer.address,
      firstName: "Ada",
      lastName: "Lovelace",
      staffWallet: sys.address,
      position: "System admin",
      electionCode: CODE,
      claimHash: hash,
      signedAt: LATER,
    });
    roster = recordApproval(roster, "system", { signature: await organizer.signMessage(text), signedAt: LATER, grantor: organizer.address, adminName: "Grace Hopper", claimHash: hash });
    const renamed = applyEdits(roster, [{ id: "system", firstName: "Ada", lastName: "Byron", address: sys.address }], { organizerAddress: organizer.address });
    expect(seat(renamed, "system").claim).toBeNull();
    expect(seat(renamed, "system").grant).toBeNull();
    expect(lineView(seat(renamed, "system"), { electionCode: CODE, verifyMessage }).status).toBe("unverified");
    const rewallet = applyEdits(roster, [{ id: "system", firstName: "Ada", lastName: "Lovelace", address: other.address }], { organizerAddress: organizer.address });
    expect(seat(rewallet, "system").grant).toBeNull();
    expect(claimIsCurrent(seat(rewallet, "system"), CODE, verifyMessage)).toBe(false);
    const unlinked = unlinkSeat(roster, "system");
    expect(seat(unlinked, "system")).toMatchObject({ firstName: "Ada", lastName: "Lovelace", address: "", claim: null, grant: null });
    expect(lineView(seat(unlinked, "system"), { electionCode: CODE }).status).toBe("named");
  });

  it("warns on load when a stored signature does not recover", async () => {
    const organizer = Wallet.createRandom();
    const sys = Wallet.createRandom();
    let roster = applyEdits(
      emptyRoster(CODE, { organizerAddress: organizer.address }),
      [{ id: "admin", firstName: "Grace", lastName: "Hopper" }, { id: "system", firstName: "Ada", lastName: "Lovelace" }],
      { organizerAddress: organizer.address },
    );
    roster = await signedClaim(sys, roster, "system");
    const store = memoryStorage();
    saveRoster(store, roster);
    const loaded = loadRoster(store, CODE, { organizerAddress: organizer.address });
    expect(verifyRosterSignatures(loaded, { verifyMessage, hashSignature: hashSig, organizerAddress: organizer.address })).toEqual([]);
    expect(loaded.seats.find((s) => s.id === "system").claim.signature).toBe(seat(roster, "system").claim.signature);

    const broken = structuredClone(loaded);
    const wrong = await sys.signMessage("a different sentence");
    broken.seats.find((s) => s.id === "system").claim.signature = wrong;
    saveRoster(store, broken);
    const again = loadRoster(store, CODE, { organizerAddress: organizer.address });
    const warnings = verifyRosterSignatures(again, { verifyMessage, hashSignature: hashSig, organizerAddress: organizer.address });
    expect(warnings.join(" ")).toMatch(/not verified/);
    expect(lineView(seat(again, "system"), { electionCode: CODE, verifyMessage, hashSignature: hashSig }).status).toBe("unverified");
    expect(again.seats.find((s) => s.id === "system").claim.signature).toBe(wrong);
  });

  it("puts names and both signatures beside the public file and still strips ballot codes", async () => {
    const secret = "AAAAAAAAAAAA";
    const sys = Wallet.createRandom();
    const organizer = Wallet.createRandom();
    const file = { name: "Room", ballotCodes: [secret], organizerPublicKey: organizer.address };
    const pub = publicElectionCopy(file) as any;
    expect(pub.ballotCodes).toBeUndefined();
    let roster = applyEdits(
      emptyRoster(CODE, { organizerAddress: organizer.address }),
      [{ id: "admin", firstName: "Grace", lastName: "Hopper" }, { id: "system", firstName: "Ada", lastName: "Lovelace" }],
      { organizerAddress: organizer.address },
    );
    roster = await signedClaim(sys, roster, "system");
    const hash = hashSig(seat(roster, "system").claim.signature);
    const text = buildApprovalMessage({
      adminName: "Grace Hopper",
      adminWallet: organizer.address,
      firstName: "Ada",
      lastName: "Lovelace",
      staffWallet: sys.address,
      position: "System admin",
      electionCode: CODE,
      claimHash: hash,
      signedAt: LATER,
    });
    roster = recordApproval(roster, "system", { signature: await organizer.signMessage(text), signedAt: LATER, grantor: organizer.address, adminName: "Grace Hopper", claimHash: hash });
    const wrapped = withPublicRoster({ publicCopy: true, note: "Public copy.", file: pub }, roster) as any;
    expect(wrapped.file.ballotCodes).toBeUndefined();
    expect(wrapped.file.staffRoster).toBeUndefined();
    const system = wrapped.staffRoster.seats.find((s: any) => s.role === "system");
    expect(system.claim.message).toContain("Ada Lovelace");
    expect(system.claim.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(system.grant.message).toContain("Claim signature hash");
    expect(system.grant.grantor).toBe(organizer.address);
    expect(system.address).toBe(sys.address);
    expect(system.active).toBe(true);
    expect(system.coveredByAdministrator).toBe(false);
    const officer = wrapped.staffRoster.seats.find((s: any) => s.role === "officer");
    expect(officer).toMatchObject({ address: "", coveredByAdministrator: true, coveringWallet: organizer.address, active: true, status: "covered" });
    expect(wrapped.staffRoster.signing).toBe(ROSTER_NOTE);
    expect(JSON.stringify(wrapped)).not.toContain(secret);
    expect(JSON.stringify(wrapped)).not.toMatch(/registerReviewer|registerDevice/);
    expect(() => withPublicRoster({ file }, roster)).toThrow(/ballot codes/);
    const store = memoryStorage();
    saveRoster(store, roster);
    expect(loadRoster(store, CODE, { organizerAddress: organizer.address }).seats.find((s: any) => s.id === "admin").firstName).toBe("Grace");
    expect(() => addSeat(roster, "system")).toThrow(/one line/);
    const salted = saveRoster(memoryStorage(), roster);
    const salt = salted.seats.find((s: any) => s.id === "system").nameSalt;
    expect(salt).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(JSON.stringify(publicRoster(salted))).not.toContain(salt);
    expect(JSON.stringify(withPublicRoster({ publicCopy: true, note: "Public copy.", file: pub }, salted))).not.toContain(salt);
    const executive = executiveStaffRecord(salted);
    expect(executive.schema).toBe(EXECUTIVE_STAFF_SCHEMA);
    expect(executive.confidential).toBe(true);
    expect(executive.seats.find((s: any) => s.id === "system").nameSalt).toBe(salt);
    expect(executive.note).toMatch(/not in the public download/);
    expect(JSON.stringify(executive)).not.toContain(secret);
    const renamed = applyEdits(salted, [{ id: "system", firstName: "Grace", lastName: "Hopper" }], { organizerAddress: organizer.address });
    expect(renamed.seats.find((s: any) => s.id === "system").nameSalt).toBe("");
    expect(addSeat(roster, "verifier").seats.filter((s: any) => s.role === "verifier")).toHaveLength(2);
  });

  it("stores an EIP-191 Election Administrator registration and keeps the name and wallet read-only", async () => {
    const organizer = new Wallet(Wallet.createRandom().privateKey);
    const at = "2026-11-16T01:30:00.000Z";
    const message = adminRegistrationMessage({ firstName: "Grace", lastName: "Hopper", address: organizer.address, electionId: CODE, at });
    expect(message).toBe(`B.E.I.N.G.S. Election Administrator registration: I, Grace Hopper, hold wallet ${organizer.address} and will administer election ${CODE}. ${at}`);
    expect(adminRegistrationMessage({ firstName: "Grace", lastName: "Hopper", address: organizer.address, electionId: "", at })).toContain("election new election.");
    const signature = await organizer.signMessage(message);
    expect(verifyMessage(message, signature)).toBe(organizer.address);
    let roster = recordAdminRegistration(emptyRoster(CODE, { organizerAddress: organizer.address }), {
      firstName: "Grace",
      lastName: "Hopper",
      address: organizer.address,
      signature,
      at,
      electionId: CODE,
      verify: verifyMessage,
    });
    expect(registrationIsCurrent(seat(roster, "admin"), CODE)).toBe(true);
    expect(parseAdminRegistration(seat(roster, "admin").registration.message).electionId).toBe(CODE);
    const stranger = new Wallet(Wallet.createRandom().privateKey);
    const forged = await stranger.signMessage(message);
    expect(() => recordAdminRegistration(roster, { firstName: "Grace", lastName: "Hopper", address: organizer.address, signature: forged, at, electionId: CODE, verify: verifyMessage })).toThrow(/doesn't match this wallet/);
    const store = memoryStorage();
    saveAdminRegistration(store, roster);
    const loaded = loadRoster(store, CODE, { organizerAddress: organizer.address });
    expect(seat(loaded, "admin").registration.signature).toBe(signature);
    expect(seat(loaded, "admin").registration.message).toBe(message);
    expect(readAdminRegistration(store, CODE).firstName).toBe("Grace");
    const card = rosterCard({ electionCode: CODE, organizerAddress: organizer.address, storage: store, canEdit: () => true, connectedAddress: () => organizer.address, sign: async () => ({ status: "cancelled" }) });
    expect(card.textContent).toContain("Grace Hopper");
    expect(card.textContent).toContain("Registered");
    expect(card.querySelector("#roster-admin-first")).toBeNull();
    expect(card.querySelector(".register-admin-btn")).toBeNull();
    const wallet = card.querySelector("[aria-label='Election Administrator wallet']") as HTMLInputElement;
    expect(wallet.readOnly).toBe(true);
    expect(wallet.value).toBe(organizer.address);
    const openCard = rosterCard({ electionCode: CODE, organizerAddress: ADMIN, storage: memoryStorage(), canEdit: () => true, connectedAddress: () => null, sign: async () => ({ status: "cancelled" }) });
    expect(openCard.querySelector(".register-admin-btn")?.textContent).toBe("Register your name and wallet to start an election");
    expect(openCard.querySelector("#roster-admin-first")).toBeTruthy();
  });
});

describe("staff roster card", () => {
  it("shows the election id, an Open system admin line, and the plain note under the buttons", () => {
    const store = memoryStorage();
    const card = rosterCard({
      electionCode: CODE,
      organizerAddress: ADMIN,
      storage: store,
      canEdit: () => true,
      connectedAddress: () => null,
      sign: async () => ({ status: "cancelled" }),
      verifyMessage,
      hashSignature: hashSig,
    });
    const text = card.textContent ?? "";
    expect(text).toContain(`Election ID ${CODE}`);
    expect(text).toContain("Election Administrator");
    expect(text).toContain("System admin");
    expect(text).toContain("Open");
    expect(text).toContain("Covered by Election Administrator");
    expect(text).toContain("Readable names stay off the chain");
    expect(text).toContain(SYSTEM_ADMIN_DUTY);
    expect(text).toContain(ROSTER_NOTE);
    expect(text).toContain(NAME_SALT_NOTE);
    expect(card.querySelector("#roster-confidential-download")).toBeTruthy();
    expect(text).not.toMatch(/registerReviewer|registerDevice|has not granted/);
    expect(text).toContain(shortAddress(ADMIN));
    const copy = card.querySelector("[aria-label='Copy the Election Administrator wallet address']") as HTMLElement;
    expect(copy.getAttribute("title")).toBe(ADMIN);
    const code = card.querySelector("code[title]") as HTMLElement;
    expect(code.getAttribute("title")).toBe(ADMIN);
    expect(code.textContent).toBe(shortAddress(ADMIN));
  });

  it("links a wallet from a separate session, then approves only after the checkbox", async () => {
    const organizer = Wallet.createRandom();
    const sys = Wallet.createRandom();
    const store = memoryStorage();
    let signedWith: string[] = [];
    const card = rosterCard({
      electionCode: CODE,
      organizerAddress: organizer.address,
      storage: store,
      canEdit: () => true,
      connectedAddress: () => organizer.address,
      verifyMessage,
      hashSignature: hashSig,
      linkStaff: async ({ firstName, lastName, position, electionCode }) => {
        const message = buildClaimMessage({ firstName, lastName, position, electionCode, nonce: NONCE, signedAt: WHEN });
        const signature = await sys.signMessage(message);
        return { status: "signed", address: sys.address, message, signature, nonce: NONCE, signedAt: WHEN };
      },
      sign: async ({ message }: { message: string }) => {
        signedWith.push(message);
        return { status: "signed", signature: await organizer.signMessage(message) };
      },
    });
    const set = (field: string, value: string) => {
      const input = card.querySelector(`#roster-system-${field}`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const button = (label: string) => [...card.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
    const linkButton = () => card.querySelector("#roster-system-link") as HTMLButtonElement;
    set("first", "Ada");
    expect(linkButton().hidden).toBe(true);
    set("last", "Lovelace");
    expect(card.textContent).toContain("Named, waiting for wallet");
    expect(card.textContent).toContain("Not active yet");
    const link = linkButton();
    expect(link.hidden).toBe(false);
    (card.querySelector("#roster-admin-first") as HTMLInputElement).value = "Grace";
    (card.querySelector("#roster-admin-last") as HTMLInputElement).value = "Hopper";
    link.click();
    await new Promise((r) => setTimeout(r, 20));
    const saved = loadRoster(store, CODE, { organizerAddress: organizer.address });
    const system = saved.seats.find((s) => s.id === "system");
    expect(signatureMatches(system.claim.message, system.claim.signature, sys.address, verifyMessage)).toBe(true);
    expect(system.address).toBe(sys.address);
    const addr = card.querySelector("#roster-system-addr") as HTMLInputElement;
    expect(addr.readOnly).toBe(true);
    expect(addr.value).toBe(sys.address);
    expect(card.querySelector("[data-roster-status='linked']")).toBeTruthy();
    expect(card.textContent).toContain("Wallet linked (staff signed)");
    expect(card.textContent).toContain(WHEN);
    expect(card.textContent).toContain(shortAddress(sys.address));

    const approve = button("Approve with my wallet");
    expect(approve.disabled).toBe(true);
    approve.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(signedWith).toEqual([]);
    const box = card.querySelector("#roster-system-verified") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(approve.disabled).toBe(false);
    approve.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(signedWith[0]).toContain("B.E.I.N.G.S. staff approval:");
    expect(signedWith[0]).toContain("Grace Hopper");
    expect(signedWith[0]).toContain(sys.address);
    const after = loadRoster(store, CODE, { organizerAddress: organizer.address });
    const done = after.seats.find((s) => s.id === "system");
    expect(signatureMatches(done.grant.message, done.grant.signature, organizer.address, verifyMessage)).toBe(true);
    expect(lineView(done, { electionCode: CODE, organizerAddress: organizer.address, verifyMessage, hashSignature: hashSig }).status).toBe("approved");
    expect(card.textContent).toContain("Approved by admin (both signed)");
    expect(card.textContent).toContain(ROSTER_NOTE);
    expect(publicRoster(after).seats.find((s) => s.id === "system").grant.signature).toBe(done.grant.signature);

    (card.querySelector("#roster-system-last") as HTMLInputElement).value = "Byron";
    button("Save roster").click();
    const cleared = loadRoster(store, CODE, { organizerAddress: organizer.address }).seats.find((s) => s.id === "system");
    expect(cleared.lastName).toBe("Byron");
    expect(cleared.claim).toBeNull();
    expect(cleared.grant).toBeNull();
  });

  it("keeps a typed wallet as not verified, and unlink lets the line be linked again", async () => {
    const organizer = Wallet.createRandom();
    const sys = Wallet.createRandom();
    const store = memoryStorage();
    let links = 0;
    const card = rosterCard({
      electionCode: CODE,
      organizerAddress: organizer.address,
      storage: store,
      canEdit: () => true,
      connectedAddress: () => organizer.address,
      verifyMessage,
      hashSignature: hashSig,
      linkStaff: async ({ firstName, lastName, position, electionCode }) => {
        links += 1;
        const message = buildClaimMessage({ firstName, lastName, position, electionCode, nonce: NONCE, signedAt: WHEN });
        return { status: "signed", address: sys.address, message, signature: await sys.signMessage(message), nonce: NONCE, signedAt: WHEN };
      },
      sign: async () => ({ status: "cancelled" }),
    });
    const set = (field: string, value: string) => {
      const input = card.querySelector(`#roster-system-${field}`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const button = (label: string) => [...card.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
    set("first", "Ada");
    set("last", "Lovelace");
    set("addr", sys.address);
    button("Save roster").click();
    expect(card.querySelector("[data-roster-status='unverified']")).toBeTruthy();
    expect(card.textContent).toContain("Not verified");
    expect(loadRoster(store, CODE, { organizerAddress: organizer.address }).seats.find((s) => s.id === "system").claim).toBeNull();
    (card.querySelector("#roster-system-link") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(links).toBe(1);
    expect(card.querySelector("[data-roster-status='linked']")).toBeTruthy();
    button("Unlink").click();
    const cleared = loadRoster(store, CODE, { organizerAddress: organizer.address }).seats.find((s) => s.id === "system");
    expect(cleared.address).toBe("");
    expect(cleared.claim).toBeNull();
    expect(card.querySelector("[data-roster-status='named']")).toBeTruthy();
    expect((card.querySelector("#roster-system-link") as HTMLButtonElement).hidden).toBe(false);
  });

  it("shows the load-time warning on the card", async () => {
    const sys = Wallet.createRandom();
    const organizer = Wallet.createRandom();
    let roster = applyEdits(
      emptyRoster(CODE, { organizerAddress: organizer.address }),
      [{ id: "system", firstName: "Ada", lastName: "Lovelace" }],
      { organizerAddress: organizer.address },
    );
    roster = await signedClaim(sys, roster, "system");
    seat(roster, "system").claim.signature = await sys.signMessage("not the claim");
    const store = memoryStorage();
    saveRoster(store, roster);
    const card = rosterCard({
      electionCode: CODE,
      organizerAddress: organizer.address,
      storage: store,
      canEdit: () => false,
      verifyMessage,
      hashSignature: hashSig,
      sign: async () => ({ status: "cancelled" }),
    });
    expect(card.textContent).toMatch(/does not match this name and wallet/);
    expect(card.querySelector("[data-roster-status='unverified']")).toBeTruthy();
  });
});

describe("staff link stays off the administrator session", () => {
  it("the staff module does not touch the administrator wallet store", () => {
    const src = readFileSync("public/js/staff-link.js", "utf8");
    expect(src).not.toMatch(/from "\.\/roles\.js"/);
    expect(src).not.toMatch(/localStorage|beings\.wallet|privateKey|console\.log/);
  });
});
