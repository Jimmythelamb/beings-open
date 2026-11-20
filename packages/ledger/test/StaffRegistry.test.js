// Staff roster contract. Synthetic names and wallets only. Nothing is sent to Coston2.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const h = require("./helpers");

const CODE = "BEINGS-2026-RST001";
const LOCK = "I have reviewed this staff roster and confirm it is accurate and complete";
const TEST_STATEMENT = "This election was used and identified as a test election";
const ADULT = "I attest that this staff member is a legal adult (18, or the age of majority where they live).";
const CLASSROOM = "Classroom election (single administrator), not certified";
const SYSTEM_SIGNOFF = "I verify that this roster's roles and wallets were set up correctly, and that each listed position's duties were verified complete.";
const ROLE = { Admin: 0, Officer: 1, Verifier: 2, Scanner: 3, System: 4 };
const KIND = { Standard: 0, Test: 1, Classroom: 2 };

const claimTypes = {
  StaffClaim: [
    { name: "electionId", type: "bytes32" },
    { name: "positionId", type: "bytes32" },
    { name: "wallet", type: "address" },
    { name: "nameHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};
const approvalTypes = {
  StaffApproval: [
    { name: "electionId", type: "bytes32" },
    { name: "positionId", type: "bytes32" },
    { name: "wallet", type: "address" },
    { name: "nameHash", type: "bytes32" },
    { name: "claimDigest", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "adultAttestation", type: "string" },
  ],
};
const lockTypes = {
  RosterLock: [
    { name: "electionId", type: "bytes32" },
    { name: "rosterHash", type: "bytes32" },
    { name: "attestation", type: "string" },
  ],
};
const testTypes = {
  TestElectionAttestation: [
    { name: "electionId", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
};
const coverTypes = {
  AdminCover: [
    { name: "electionId", type: "bytes32" },
    { name: "positionId", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
};
const signOffTypes = {
  SystemSignOff: [
    { name: "electionId", type: "bytes32" },
    { name: "rosterHash", type: "bytes32" },
    { name: "dutiesHash", type: "bytes32" },
    { name: "positionSetHash", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
};

function saltedNameHash(name) {
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`salt:${name}`));
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [salt, name]));
}

describe("StaffRegistry", function () {
  let ctx;
  let staff;
  let domain;

  before(async () => {
    ctx = await h.setup();
    const Factory = await ethers.getContractFactory("StaffRegistry");
    staff = await Factory.deploy(await ctx.registry.getAddress());
    await staff.waitForDeployment();
    domain = {
      name: "B.E.I.N.G.S.",
      version: "1",
      chainId: 114,
      verifyingContract: await staff.getAddress(),
    };
  });
  h.snapshotHooks();

  async function election(kind = KIND.Standard) {
    const key = await h.createElection(ctx, { code: CODE });
    await staff.connect(ctx.organizer).recordElectionAdmin(key, kind);
    return key;
  }

  async function proof(electionId, role, seatNo, wallet, nonce, name, signer = wallet, approver = ctx.organizer, signDomain = domain, adult = ADULT) {
    const positionId = await staff.positionIdOf(role, seatNo);
    const nameHash = saltedNameHash(name);
    const claim = { electionId, positionId, wallet: wallet.address, nameHash, nonce };
    const claimSig = await signer.signTypedData(signDomain, claimTypes, claim);
    const claimDigest = ethers.TypedDataEncoder.hash(domain, claimTypes, claim);
    const approval = { electionId, positionId, wallet: wallet.address, nameHash, claimDigest, nonce, adultAttestation: adult };
    const approvalSig = await approver.signTypedData(signDomain, approvalTypes, approval);
    return { role, seatNo, wallet: wallet.address, nameHash, nonce, adultAttestation: adult, claimSig, approvalSig, positionId };
  }

  async function fillAll(electionId) {
    const rows = [
      [ROLE.Officer, 1, ctx.signers[3], "Sam Park"],
      [ROLE.Officer, 2, ctx.signers[8], "Jo Hale"],
      [ROLE.Verifier, 1, ctx.signers[4], "Rita Cho"],
      [ROLE.Scanner, 1, ctx.signers[5], "Ned Ortiz"],
      [ROLE.System, 1, ctx.signers[6], "Ada Lovelace"],
    ];
    const proofs = [];
    for (const [role, seatNo, wallet, name] of rows) proofs.push(await proof(electionId, role, seatNo, wallet, 1, name));
    await staff.connect(ctx.organizer).recordStaffBatch(electionId, proofs);
    return proofs;
  }

  async function signLock(electionId, rosterHash, attestation = LOCK, signDomain = domain) {
    return ctx.organizer.signTypedData(signDomain, lockTypes, { electionId, rosterHash, attestation });
  }

  it("uses the Coston2 domain: chain id 114 and this contract", async () => {
    const d = await staff.eip712Domain();
    expect(d.chainId).to.equal(114n);
    expect(d.verifyingContract).to.equal(await staff.getAddress());
    expect(d.name).to.equal("B.E.I.N.G.S.");
    const pid = await staff.positionIdOf(ROLE.Officer, 1);
    expect(pid).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint16"], [ROLE.Officer, 1])));
  });

  it("records the organizer as Election Admin once, and keeps the test flag", async () => {
    const key = await h.createElection(ctx, { code: CODE });
    await expect(staff.connect(ctx.outsider).recordElectionAdmin(key, KIND.Standard)).to.be.revertedWithCustomError(staff, "NotOrganizer");
    await expect(staff.connect(ctx.organizer).recordElectionAdmin(key, KIND.Standard))
      .to.emit(staff, "ElectionAdminRecorded")
      .withArgs(key, ctx.organizer.address, KIND.Standard);
    await expect(staff.connect(ctx.organizer).recordElectionAdmin(key, KIND.Test)).to.be.revertedWithCustomError(staff, "AdminAlreadyRecorded");
    await expect(staff.connect(ctx.organizer).recordElectionAdmin(ethers.id("missing"), 9)).to.be.revertedWithCustomError(staff, "UnknownElection");
    const report = await staff.staffingReport(key);
    expect(report.known).to.equal(true);
    expect(report.kind).to.equal(KIND.Standard);
    expect(report.adminFilled).to.equal(true);
    const admin = await staff.seat(key, ROLE.Admin, 1);
    expect(admin.wallet).to.equal(ctx.organizer.address);
  });

  it("records several approvals in one transaction", async () => {
    const key = await election(KIND.Standard);
    const proofs = await fillAll(key);
    expect(await staff.positionCount(key)).to.equal(6);
    expect((await staff.staffingReport(key)).ballotHandlerCount).to.equal(2);
    const officer = await staff.seat(key, ROLE.Officer, 1);
    expect(officer.wallet).to.equal(ctx.signers[3].address);
    expect(officer.nameHash).to.equal(saltedNameHash("Sam Park"));
    expect(officer.nameHash).to.not.equal(ethers.id("Sam Park"));
    expect(await staff.isApproved(key, ctx.signers[4].address)).to.equal(true);
    expect(proofs).to.have.length(5);
    const [adminW, officerW, verifierW, distinct] = await staff.certificationSigners(key);
    expect(distinct).to.equal(true);
    expect(adminW).to.equal(ctx.organizer.address);
    expect(officerW).to.equal(ctx.signers[3].address);
    expect(verifierW).to.equal(ctx.signers[4].address);
  });

  it("refuses one wallet in two positions, including the administrator's wallet", async () => {
    const key = await election(KIND.Standard);
    const officer = await proof(key, ROLE.Officer, 1, ctx.signers[3], 1, "Sam Park");
    await staff.connect(ctx.organizer).recordStaff(key, officer);
    const again = await proof(key, ROLE.Verifier, 1, ctx.signers[3], 1, "Sam Park");
    await expect(staff.connect(ctx.organizer).recordStaff(key, again)).to.be.revertedWithCustomError(staff, "WalletInTwoPositions");
    const asAdmin = await proof(key, ROLE.Scanner, 1, ctx.organizer, 1, "Organizer Person");
    await expect(staff.connect(ctx.organizer).recordStaff(key, asAdmin)).to.be.revertedWithCustomError(staff, "WalletInTwoPositions");
    await expect(staff.connect(ctx.organizer).recordStaff(key, { ...officer, role: ROLE.Admin })).to.be.revertedWithCustomError(staff, "AdminFixed");
  });

  it("refuses a bad claim, a bad approval, the wrong chain, and the wrong contract", async () => {
    const key = await election(KIND.Standard);
    const wallet = ctx.signers[3];
    const good = await proof(key, ROLE.Officer, 1, wallet, 1, "Sam Park");

    const claimByAdmin = await proof(key, ROLE.Officer, 1, wallet, 1, "Sam Park", ctx.organizer, ctx.organizer);
    await expect(staff.connect(ctx.organizer).recordStaff(key, claimByAdmin)).to.be.revertedWithCustomError(staff, "BadRosterSignature");

    const approvalByStaff = await proof(key, ROLE.Officer, 1, wallet, 1, "Sam Park", wallet, wallet);
    await expect(staff.connect(ctx.organizer).recordStaff(key, approvalByStaff)).to.be.revertedWithCustomError(staff, "BadRosterSignature");

    const wrongChain = { ...domain, chainId: 1 };
    const wrongChainProof = await proof(key, ROLE.Officer, 1, wallet, 1, "Sam Park", wallet, ctx.organizer, wrongChain);
    await expect(staff.connect(ctx.organizer).recordStaff(key, wrongChainProof)).to.be.revertedWithCustomError(staff, "BadRosterSignature");

    const wrongContract = { ...domain, verifyingContract: ctx.organizer.address };
    const wrongContractProof = await proof(key, ROLE.Officer, 1, wallet, 1, "Sam Park", wallet, ctx.organizer, wrongContract);
    await expect(staff.connect(ctx.organizer).recordStaff(key, wrongContractProof)).to.be.revertedWithCustomError(staff, "BadRosterSignature");

    await expect(staff.connect(ctx.outsider).recordStaff(key, good)).to.be.revertedWithCustomError(staff, "NotOrganizer");
    await expect(staff.connect(ctx.organizer).recordStaffBatch(key, [])).to.be.revertedWithCustomError(staff, "EmptyBatch");
  });

  it("locks a complete real roster and then refuses a silent swap", async () => {
    const key = await election(KIND.Standard);
    await expect(staff.connect(ctx.organizer).lockRoster(key, ethers.id("roster"), LOCK, await signLock(key, ethers.id("roster")), "", "0x"))
      .to.be.revertedWithCustomError(staff, "StaffingBlocksLock");
    await fillAll(key);
    const hash = ethers.id("roster-file");
    const sig = await signLock(key, hash);
    const tx = await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, sig, "", "0x");
    const rc = await tx.wait();
    const block = await ethers.provider.getBlock(rc.blockNumber);
    await expect(tx).to.emit(staff, "RosterLocked");
    const stored = await staff.lockSignature(key);
    expect(stored).to.equal(sig);
    const report = await staff.staffingReport(key);
    expect(report.locked).to.equal(true);
    expect(report.lockedRosterHash).to.equal(hash);
    expect(report.lockedAt).to.equal(block.timestamp);
    expect(report.certifiedStaffingReady).to.equal(false);
    expect(report.systemSignOffRecorded).to.equal(false);
    expect(report.kind).to.equal(KIND.Standard);
    expect(report.testAttested).to.equal(false);
    expect(report.anyCovered).to.equal(false);

    const swapped = await proof(key, ROLE.Officer, 1, ctx.signers[7], 2, "Jo Hale");
    await expect(staff.connect(ctx.organizer).recordStaff(key, swapped)).to.be.revertedWithCustomError(staff, "RosterIsLocked");

    const reason = ethers.id("Jo Hale replaced Sam Park after they stepped down");
    const nextHash = ethers.id("roster-file-2");
    const amend = await staff.connect(ctx.organizer).amendStaff(key, swapped, nextHash, reason);
    const amendRc = await amend.wait();
    const amendBlock = await ethers.provider.getBlock(amendRc.blockNumber);
    const parsed = amendRc.logs.map((log) => staff.interface.parseLog(log)).find((e) => e && e.name === "RosterAmended");
    expect(parsed.args.oldWallet).to.equal(ctx.signers[3].address);
    expect(parsed.args.newWallet).to.equal(ctx.signers[7].address);
    expect(parsed.args.timestamp).to.equal(amendBlock.timestamp);
    expect(parsed.args.newRosterHash).to.equal(nextHash);
    const after = await staff.staffingReport(key);
    expect(after.lockedRosterHash).to.equal(hash);
    expect(after.currentRosterHash).to.equal(nextHash);
    expect((await staff.seat(key, ROLE.Officer, 1)).wallet).to.equal(ctx.signers[7].address);
    expect(await staff.isApproved(key, ctx.signers[3].address)).to.equal(false);
    await expect(staff.connect(ctx.organizer).lockRoster(key, ethers.id("again"), LOCK, await signLock(key, ethers.id("again")), "", "0x"))
      .to.be.revertedWithCustomError(staff, "AlreadyLocked");
  });

  it("rejects a reused nonce and a lock sentence that was changed", async () => {
    const key = await election(KIND.Standard);
    const first = await proof(key, ROLE.System, 1, ctx.signers[6], 1, "Ada Lovelace");
    await staff.connect(ctx.organizer).recordStaff(key, first);
    const replay = await proof(key, ROLE.System, 1, ctx.signers[6], 1, "Ada Lovelace");
    await expect(staff.connect(ctx.organizer).recordStaff(key, replay)).to.be.revertedWithCustomError(staff, "NonceUsed");
    for (const [role, seatNo, wallet, name] of [
      [ROLE.Officer, 1, ctx.signers[3], "Sam Park"],
      [ROLE.Officer, 2, ctx.signers[8], "Jo Hale"],
      [ROLE.Verifier, 1, ctx.signers[4], "Rita Cho"],
      [ROLE.Scanner, 1, ctx.signers[5], "Ned Ortiz"],
    ]) {
      await staff.connect(ctx.organizer).recordStaff(key, await proof(key, role, seatNo, wallet, 1, name));
    }
    const hash = ethers.id("roster");
    const bad = await signLock(key, hash, "I glanced at the roster");
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, "I glanced at the roster", bad, "", "0x")).to.be.revertedWithCustomError(staff, "BadAttestation");
  });

  it("lets a test election lock with gaps only after the test statement, and discloses that it cannot be certified", async () => {
    const key = await election(KIND.Test);
    const hash = ethers.id("test-roster");
    const lock = await signLock(key, hash);
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, lock, "", "0x")).to.be.revertedWithCustomError(staff, "TestAttestationRequired");
    await expect(staff.connect(ctx.organizer).attestTestElection(key, "this was a drill", "0x")).to.be.revertedWithCustomError(staff, "BadAttestation");
    const statementSig = await ctx.organizer.signTypedData(domain, testTypes, { electionId: key, statement: TEST_STATEMENT });
    await expect(staff.connect(ctx.organizer).attestTestElection(key, TEST_STATEMENT, statementSig))
      .to.emit(staff, "TestElectionAttested")
      .withArgs(key, ctx.organizer.address, ethers.id(TEST_STATEMENT), (stamp) => stamp > 0n);
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, lock, "", "0x"))
      .to.emit(staff, "RosterLocked")
      .withArgs(key, hash, ctx.organizer.address, lock, true, true, (stamp) => stamp > 0n);
    const report = await staff.staffingReport(key);
    expect(report.kind).to.equal(KIND.Test);
    expect(report.testAttested).to.equal(true);
    expect(report.certifiedStaffingReady).to.equal(false);
    expect(report.officerFilled).to.equal(false);

    const coverId = await staff.positionIdOf(ROLE.Officer, 1);
    const coverSig = await ctx.organizer.signTypedData(domain, coverTypes, { electionId: key, positionId: coverId, statement: TEST_STATEMENT });
    const next = ethers.id("test-roster-covered");
    await expect(staff.connect(ctx.organizer).coverPosition(key, ROLE.Officer, 1, TEST_STATEMENT, coverSig, next)).to.emit(staff, "StaffCovered");
    const covered = await staff.seat(key, ROLE.Officer, 1);
    expect(covered.coveredByAdmin).to.equal(true);
    expect(covered.wallet).to.equal(ethers.ZeroAddress);
    expect(await staff.isApproved(key, ctx.organizer.address)).to.equal(true);
    const [adminPos] = await staff.positionAt(key, 0);
    expect(await staff.isApproved(key, ctx.organizer.address)).to.equal(true);
    expect(adminPos).to.equal(await staff.positionIdOf(ROLE.Admin, 1));
    expect((await staff.staffingReport(key)).anyCovered).to.equal(true);
    expect((await staff.staffingReport(key)).certifiedStaffingReady).to.equal(false);
  });

  it("never reports a test election or a classroom election as ready to certify", async () => {
    const key = await election(KIND.Test);
    await fillAll(key);
    const hash = ethers.id("full-test");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    expect((await staff.staffingReport(key)).kind).to.equal(KIND.Test);
  });

  it("requires the legal-adult sentence on a standard approval", async () => {
    const key = await election(KIND.Standard);
    const missing = await proof(key, ROLE.Officer, 1, ctx.signers[3], 1, "Sam Park", ctx.signers[3], ctx.organizer, domain, "");
    await expect(staff.connect(ctx.organizer).recordStaff(key, missing)).to.be.revertedWithCustomError(staff, "AdultAttestationRequired");
    const said = await proof(key, ROLE.Officer, 1, ctx.signers[3], 1, "Sam Park");
    await staff.connect(ctx.organizer).recordStaff(key, said);
    expect((await staff.seat(key, ROLE.Officer, 1)).wallet).to.equal(ctx.signers[3].address);
  });

  it("records a classroom election as one administrator covering every other position", async () => {
    const key = await h.createElection(ctx, { code: CODE });
    await expect(staff.connect(ctx.organizer).recordElectionAdmin(key, 9)).to.be.revertedWithCustomError(staff, "BadElectionKind");
    await staff.connect(ctx.organizer).recordElectionAdmin(key, KIND.Classroom);
    const report = await staff.staffingReport(key);
    expect(report.kind).to.equal(KIND.Classroom);
    expect(report.anyCovered).to.equal(true);
    expect(report.adminFilled).to.equal(true);
    expect(report.officerFilled).to.equal(false);
    expect(report.certifiedStaffingReady).to.equal(false);
    expect(await staff.CLASSROOM_LABEL()).to.equal(CLASSROOM);
    for (const role of [ROLE.Officer, ROLE.Verifier, ROLE.Scanner, ROLE.System]) {
      const row = await staff.seat(key, role, 1);
      expect(row.coveredByAdmin).to.equal(true);
      expect(row.wallet).to.equal(ethers.ZeroAddress);
    }
    const other = await proof(key, ROLE.Officer, 2, ctx.signers[3], 1, "Sam Park");
    await expect(staff.connect(ctx.organizer).recordStaff(key, other)).to.be.revertedWithCustomError(staff, "ClassroomIsSingleAdmin");
    const hash = ethers.id("classroom-roster");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    const locked = await staff.staffingReport(key);
    expect(locked.locked).to.equal(true);
    expect(locked.certifiedStaffingReady).to.equal(false);
    expect(await staff.mayRecordBallots(key, ctx.signers[8].address)).to.equal(true);
    expect(await staff.isApproved(key, ctx.organizer.address)).to.equal(true);
    expect(await staff.isApprovedScanner(key, ctx.organizer.address)).to.equal(false);
  });

  it("refuses the test statement on a real election", async () => {
    const key = await election(KIND.Standard);
    await fillAll(key);
    const hash = ethers.id("real");
    const statementSig = await ctx.organizer.signTypedData(domain, testTypes, { electionId: key, statement: TEST_STATEMENT });
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), TEST_STATEMENT, statementSig))
      .to.be.revertedWithCustomError(staff, "NotATestElection");
    await expect(staff.connect(ctx.organizer).coverPosition(key, ROLE.Officer, 1, TEST_STATEMENT, statementSig, ethers.id("x")))
      .to.be.revertedWithCustomError(staff, "NotATestElection");
  });

  it("allows ballot recording by a recorded scanner wallet, and leaves elections with no roster alone", async () => {
    const unknown = ethers.id("no-such-election");
    expect(await staff.mayRecordBallots(unknown, ctx.signers[8].address)).to.equal(true);
    const key = await election(KIND.Standard);
    expect(await staff.mayRecordBallots(key, ctx.signers[8].address)).to.equal(true);
    expect(await staff.isApprovedScanner(key, ctx.signers[5].address)).to.equal(false);
    await fillAll(key);
    expect(await staff.isApprovedScanner(key, ctx.signers[5].address)).to.equal(true);
    expect(await staff.mayRecordBallots(key, ctx.signers[5].address)).to.equal(true);
    expect(await staff.mayRecordBallots(key, ctx.signers[3].address)).to.equal(false);
    expect(await staff.mayRecordBallots(key, ctx.organizer.address)).to.equal(false);
  });

  it("refuses to lock or certify a standard election with fewer than two ballot handlers", async () => {
    const key = await election(KIND.Standard);
    const one = await proof(key, ROLE.Officer, 1, ctx.signers[3], 1, "Sam Park");
    await staff.connect(ctx.organizer).recordStaff(key, one);
    for (const [role, wallet, name] of [
      [ROLE.Verifier, ctx.signers[4], "Rita Cho"],
      [ROLE.Scanner, ctx.signers[5], "Ned Ortiz"],
      [ROLE.System, ctx.signers[6], "Ada Lovelace"],
    ]) {
      await staff.connect(ctx.organizer).recordStaff(key, await proof(key, role, 1, wallet, 1, name));
    }
    expect((await staff.staffingReport(key)).ballotHandlerCount).to.equal(1);
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    const hash = ethers.id("one-handler");
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x")).to.be.revertedWithCustomError(staff, "StaffingBlocksLock");
    const shared = await proof(key, ROLE.Officer, 2, ctx.signers[3], 1, "Sam Park");
    await expect(staff.connect(ctx.organizer).recordStaff(key, shared)).to.be.revertedWithCustomError(staff, "WalletInTwoPositions");
    await staff.connect(ctx.organizer).recordStaff(key, await proof(key, ROLE.Officer, 2, ctx.signers[8], 1, "Jo Hale"));
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    expect((await staff.staffingReport(key)).ballotHandlerCount).to.equal(2);
  });

  it("lets a test election lock with one ballot handler", async () => {
    const key = await election(KIND.Test);
    await staff.connect(ctx.organizer).recordStaff(key, await proof(key, ROLE.Officer, 1, ctx.signers[3], 1, "Sam Park"));
    for (const [role, wallet, name] of [
      [ROLE.Verifier, ctx.signers[4], "Rita Cho"],
      [ROLE.Scanner, ctx.signers[5], "Ned Ortiz"],
      [ROLE.System, ctx.signers[6], "Ada Lovelace"],
    ]) {
      await staff.connect(ctx.organizer).recordStaff(key, await proof(key, role, 1, wallet, 1, name));
    }
    const hash = ethers.id("test-one-handler");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    expect((await staff.staffingReport(key)).locked).to.equal(true);
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    expect((await staff.staffingReport(key)).ballotHandlerCount).to.equal(1);
  });

  it("records an officer co-signature for a print run, a scan batch, and storing the ballots", async () => {
    const key = await election(KIND.Standard);
    await fillAll(key);
    const officer = ctx.signers[3].address;
    const scanner = ctx.signers[5].address;
    const custodyTypes = {
      CustodyWitness: [
        { name: "electionId", type: "bytes32" },
        { name: "action", type: "uint8" },
        { name: "subjectHash", type: "bytes32" },
        { name: "officer", type: "address" },
        { name: "scanner", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    };
    const print = { electionId: key, action: 1, subjectHash: ethers.id("print-run-1"), officer, scanner, nonce: 1 };
    const officerSig = await ctx.signers[3].signTypedData(domain, custodyTypes, print);
    const scannerSig = await ctx.signers[5].signTypedData(domain, custodyTypes, print);
    await expect(staff.connect(ctx.organizer).recordCustody(key, 1, print.subjectHash, officer, officer, 1, officerSig, scannerSig)).to.be.revertedWithCustomError(staff, "NotAScanner");
    const tx = await staff.connect(ctx.organizer).recordCustody(key, 1, print.subjectHash, officer, scanner, 1, officerSig, scannerSig);
    await expect(tx).to.emit(staff, "CustodyWitnessed").withArgs(key, 1, print.subjectHash, officer, scanner, (stamp) => stamp > 0n);
    const batch = { electionId: key, action: 2, subjectHash: ethers.id("scan-batch-1"), officer, scanner, nonce: 2 };
    await staff.connect(ctx.organizer).recordCustody(
      key, 2, batch.subjectHash, officer, scanner, 2,
      await ctx.signers[3].signTypedData(domain, custodyTypes, batch),
      await ctx.signers[5].signTypedData(domain, custodyTypes, batch),
    );
    const stored = { electionId: key, action: 3, subjectHash: ethers.id("stored"), officer, scanner: ethers.ZeroAddress, nonce: 3 };
    await expect(staff.connect(ctx.organizer).recordCustody(key, 3, stored.subjectHash, officer, scanner, 3, await ctx.signers[3].signTypedData(domain, custodyTypes, stored), "0x")).to.be.revertedWithCustomError(staff, "ScannerNotOnThisStep");
    await staff.connect(ctx.organizer).recordCustody(key, 3, stored.subjectHash, officer, ethers.ZeroAddress, 3, await ctx.signers[3].signTypedData(domain, custodyTypes, stored), "0x");
    expect(await staff.custodyCount(key)).to.equal(3);
    const note = await staff.custodyAt(key, 2);
    expect(note.action).to.equal(3);
    expect(note.officer).to.equal(officer);
    expect(note.scanner).to.equal(ethers.ZeroAddress);
    const wrongChain = { ...domain, chainId: 1 };
    const bad = { ...print, nonce: 4 };
    await expect(staff.connect(ctx.organizer).recordCustody(
      key, 1, bad.subjectHash, officer, scanner, 4,
      await ctx.signers[3].signTypedData(wrongChain, custodyTypes, bad),
      await ctx.signers[5].signTypedData(domain, custodyTypes, bad),
    )).to.be.revertedWithCustomError(staff, "BadRosterSignature");
  });

  async function closeElection(key) {
    await ctx.registry.connect(ctx.organizer).registerDevice(key, ctx.wallets.device1.address, ethers.id("app"));
    await ctx.registry.connect(ctx.organizer).openElection(key);
    await ctx.registry.connect(ctx.organizer).closeElection(key);
  }

  async function signOffParts(key, rosterHash, signer = ctx.signers[6]) {
    const n = Number(await staff.positionCount(key));
    const ids = [];
    const sheets = [];
    for (let i = 0; i < n; i++) {
      const row = await staff.positionAt(key, i);
      if (row.wallet !== ethers.ZeroAddress && row.coveredByAdmin === false) {
        ids.push(row[0]);
        sheets.push(ethers.keccak256(ethers.toUtf8Bytes(`duty-closeout-${row[0]}`)));
      }
    }
    const dutiesHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]", "bytes32[]"], [ids, sheets]));
    const positionSetHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [ids]));
    const message = { electionId: key, rosterHash, dutiesHash, positionSetHash, statement: SYSTEM_SIGNOFF };
    const signature = await signer.signTypedData(domain, signOffTypes, message);
    return { ids, sheets, dutiesHash, positionSetHash, signature };
  }

  function signOffProof(parts, rosterHash) {
    return { rosterHash, positionIds: parts.ids, sheetHashes: parts.sheets, statement: SYSTEM_SIGNOFF, signature: parts.signature };
  }

  it("requires the System admin sign-off before a standard election is certification-ready", async () => {
    const key = await election(KIND.Standard);
    await fillAll(key);
    const hash = ethers.id("standard-closeout");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    const parts = await signOffParts(key, hash);
    await expect(staff.connect(ctx.organizer).recordSystemSignOff(key, signOffProof(parts, hash)))
      .to.be.revertedWithCustomError(staff, "WrongStatus");
    await closeElection(key);
    const wrongSigner = await signOffParts(key, hash, ctx.organizer);
    await expect(staff.connect(ctx.organizer).recordSystemSignOff(key, signOffProof(wrongSigner, hash)))
      .to.be.revertedWithCustomError(staff, "BadRosterSignature");
    await expect(staff.connect(ctx.outsider).recordSystemSignOff(key, signOffProof(parts, hash)))
      .to.be.revertedWithCustomError(staff, "NotSignOffParty");
    const short = { ...parts, ids: parts.ids.slice(1), sheets: parts.sheets.slice(1) };
    const shortHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]", "bytes32[]"], [short.ids, short.sheets]));
    const shortSet = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [short.ids]));
    const shortSig = await ctx.signers[6].signTypedData(domain, signOffTypes, { electionId: key, rosterHash: hash, dutiesHash: shortHash, positionSetHash: shortSet, statement: SYSTEM_SIGNOFF });
    await expect(staff.connect(ctx.organizer).recordSystemSignOff(key, { rosterHash: hash, positionIds: short.ids, sheetHashes: short.sheets, statement: SYSTEM_SIGNOFF, signature: shortSig }))
      .to.be.revertedWithCustomError(staff, "SignOffIncomplete");
    const tx = await staff.connect(ctx.signers[6]).recordSystemSignOff(key, signOffProof(parts, hash));
    await expect(tx).to.emit(staff, "SystemSignOffRecorded").withArgs(key, ctx.signers[6].address, hash, parts.dutiesHash, true, (stamp) => stamp > 0n);
    expect(await staff.certifiedStaffingReady(key)).to.equal(true);
    const note = await staff.systemSignOff(key);
    expect(note.recorded).to.equal(true);
    expect(note.requiredForCertification).to.equal(true);
    expect(note.current).to.equal(true);
    expect(note.signer).to.equal(ctx.signers[6].address);
    expect(note.dutiesHash).to.equal(parts.dutiesHash);
    const listed = await staff.systemSignOffPositions(key);
    expect(listed.positionIds).to.deep.equal(parts.ids);
    expect(listed.sheetHashes).to.deep.equal(parts.sheets);
    await expect(staff.connect(ctx.organizer).recordSystemSignOff(key, signOffProof(parts, hash)))
      .to.be.revertedWithCustomError(staff, "AlreadySigned");
    const report = await staff.staffingReport(key);
    expect(report.systemSignOffRecorded).to.equal(true);
    expect(report.certifiedStaffingReady).to.equal(true);
  });

  it("records an optional System admin sign-off on a test election and still refuses to certify it", async () => {
    const key = await election(KIND.Test);
    await fillAll(key);
    const hash = ethers.id("test-closeout");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    await closeElection(key);
    const parts = await signOffParts(key, hash);
    await staff.connect(ctx.organizer).recordSystemSignOff(key, signOffProof(parts, hash));
    const note = await staff.systemSignOff(key);
    expect(note.recorded).to.equal(true);
    expect(note.requiredForCertification).to.equal(false);
    expect(note.current).to.equal(true);
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    expect((await staff.staffingReport(key)).kind).to.equal(KIND.Test);
  });

  it("discloses that a classroom election has no System admin sign-off and cannot be certified", async () => {
    const key = await h.createElection(ctx, { code: CODE });
    await staff.connect(ctx.organizer).recordElectionAdmin(key, KIND.Classroom);
    const hash = ethers.id("classroom-closeout");
    await staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x");
    await closeElection(key);
    const note = await staff.systemSignOff(key);
    expect(note.recorded).to.equal(false);
    expect(note.requiredForCertification).to.equal(false);
    expect(note.current).to.equal(false);
    expect(await staff.certifiedStaffingReady(key)).to.equal(false);
    await expect(staff.connect(ctx.organizer).recordSystemSignOff(key, { rosterHash: hash, positionIds: [ethers.id("missing")], sheetHashes: [ethers.id("sheet")], statement: SYSTEM_SIGNOFF, signature: "0x" }))
      .to.be.revertedWithCustomError(staff, "NotASystemAdmin");
  });

  it("refuses a lock after voting is open", async () => {
    const key = await election(KIND.Standard);
    await fillAll(key);
    await ctx.registry.connect(ctx.organizer).registerDevice(key, ctx.wallets.device1.address, ethers.id("app"));
    await ctx.registry.connect(ctx.organizer).openElection(key);
    const hash = ethers.id("too-late");
    await expect(staff.connect(ctx.organizer).lockRoster(key, hash, LOCK, await signLock(key, hash), "", "0x")).to.be.revertedWithCustomError(staff, "WrongStatus");
  });
});

describe("deploy-staff script (in-process network only)", function () {
  const fs = require("fs");
  const path = require("path");
  const { checkFee, main } = require("../scripts/deploy-staff");

  it("refuses a live send without an approved cap, or above it", () => {
    expect(checkFee({ gas: 3000000n, gasPriceWei: 1000000000n, approvedMaxFeeWei: undefined }).ok).to.equal(false);
    expect(checkFee({ gas: 3000000n, gasPriceWei: 1000000000n, approvedMaxFeeWei: "2999999999999999" }).ok).to.equal(false);
    expect(checkFee({ gas: 3000000n, gasPriceWei: 1000000000n, approvedMaxFeeWei: "3000000000000000" }).ok).to.equal(true);
  });

  it("points the live check at the pool deployment and the current ElectionRegistry", () => {
    const { liveRegistryAddress, LIVE_REGISTRY } = require("../scripts/deploy-staff");
    expect(LIVE_REGISTRY).to.equal("0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A");
    expect(liveRegistryAddress()).to.equal(LIVE_REGISTRY);
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-staff.js"), "utf8");
    expect(src).to.include("coston2-pool.json");
    expect(src).to.not.include("deployments/coston2.json");
  });

  it("dry-runs on the in-process network and does not change the recorded Coston2 file", async () => {
    const file = path.join(__dirname, "..", "deployments", "coston2-staff.json");
    const before = fs.readFileSync(file, "utf8");
    const rec = JSON.parse(before);
    expect(rec.network).to.equal("coston2");
    expect(rec.chainId).to.equal(114);
    expect(rec.deployer).to.equal("0xfB2A3F83F2362566341b8edfB008a0C42A52d73D");
    expect(rec.deployBlock).to.equal(37963247);
    expect(rec.contracts.StaffRegistry).to.equal("0x7e519d972e61929f54d9f316eA79F6BB51dAf635");
    expect(rec.contracts.ElectionRegistry).to.equal("0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A");
    expect(rec.deployTransactions).to.deep.equal([
      {
        step: "StaffRegistry",
        txHash: "0xf628baa51be82c51fa360ac7da10b0c902dd5de4ede45a14ad12ec53a03bb067",
        block: 37963247,
        gasUsed: "4751654",
        effectiveGasPriceWei: "518603913571",
        feeC2FLR: "2.464226360335296434",
        status: 1,
      },
    ]);
    await network.provider.send("hardhat_reset");
    const out = await main();
    expect(out.network).to.equal("hardhat");
    expect(out.chainId).to.equal(114);
    expect(out.StaffRegistry).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(out.gasUsed).to.be.above(1_000_000);
    expect(fs.readFileSync(file, "utf8")).to.equal(before);
    expect(JSON.stringify(out)).to.not.match(/privateKey|mnemonic/i);
  });
});
