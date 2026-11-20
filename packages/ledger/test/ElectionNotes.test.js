// ElectionNotes: append-only official notes / record fingerprints for a tallied election.
// In-process Hardhat network only (chain ID 114). Nothing here touches a live network.
const { expect } = require("chai");
const { ethers, setup, snapshotHooks, openElection, createElection, STATUS, ZERO32 } = require("./helpers");

const ROLE = { None: 0, Organizer: 1, Device: 2, Reviewer: 3 };
const CID = "https://beingsvote.live/data/records/BEINGS-2026-QB1TTH/notes/organizer-note-1.json";
const SHA = "0x" + "ab".repeat(32);
const SHA2 = "0x" + "cd".repeat(32);
const PER_Q = [
  { valid: 0, blank: 0, overvote: 0, unclear: 0 },
  { valid: 0, blank: 0, overvote: 0, unclear: 0 },
];

describe("ElectionNotes", () => {
  let ctx, notes, key;
  before(async () => {
    ctx = await setup();
    const F = await ethers.getContractFactory("ElectionNotes", ctx.signers[0]);
    notes = await F.deploy(await ctx.registry.getAddress());
    await notes.waitForDeployment();
  });
  snapshotHooks();

  /** Open (organizer + device1 + device2 + reviewer), close, post an empty tally => Tallied, version 1. */
  async function tallied() {
    key = await openElection(ctx);
    await ctx.registry.connect(ctx.organizer).closeElection(key);
    await ctx.tally.connect(ctx.organizer).postTally(key, ethers.id("root"), PER_Q, 7, 0, 0, "local-unpublished:x", ethers.id("results"));
    expect((await ctx.registry.elections(key)).status).to.equal(BigInt(STATUS.Tallied));
    return key;
  }
  const post = (who, o = {}) => {
    const p = { key, ver: 1, sha: SHA, cid: CID, ...o };
    const c = notes.connect(who);
    return p.name === undefined ? c.postNote(p.key, p.ver, p.sha, p.cid) : c.postNoteWithName(p.key, p.ver, p.sha, p.cid, p.name);
  };

  describe("deployment", () => {
    it("reads the Tally address from the registry and has no admin surface", async () => {
      expect(await notes.registry()).to.equal(await ctx.registry.getAddress());
      expect(await notes.tally()).to.equal(await ctx.tally.getAddress());
      const fns = notes.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
      expect(fns).to.deep.equal(["MAX_CID_BYTES", "MAX_DISPLAY_NAME_BYTES", "getNote", "noteCount", "noteIndexPlusOne", "postNote", "postNoteWithName", "registry", "roleOf", "tally"]);
      const writes = notes.interface.fragments.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name).sort();
      expect(writes).to.deep.equal(["postNote", "postNoteWithName"]);
    });
    it("refuses a zero registry, and a registry whose tally is not wired yet", async () => {
      const F = await ethers.getContractFactory("ElectionNotes", ctx.signers[0]);
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
      const R = await ethers.getContractFactory("ElectionRegistry", ctx.signers[0]);
      const bare = await R.deploy();
      await expect(F.deploy(await bare.getAddress())).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  describe("permissions (roles read from the registry)", () => {
    beforeEach(tallied);
    it("organizer posts with role Organizer", async () => {
      await expect(post(ctx.organizer)).to.emit(notes, "NotePosted");
      expect((await notes.getNote(key, 0)).role).to.equal(ROLE.Organizer);
    });
    it("a registered Device (scanning staff) posts with role Device", async () => {
      await post(ctx.wallets.device1);
      const n = await notes.getNote(key, 0);
      expect(n.role).to.equal(ROLE.Device);
      expect(n.author).to.equal(ctx.wallets.device1.address);
    });
    it("a registered Reviewer posts with role Reviewer", async () => {
      await post(ctx.wallets.reviewer);
      expect((await notes.getNote(key, 0)).role).to.equal(ROLE.Reviewer);
    });
    it("a wallet with no role is refused", async () => {
      await expect(post(ctx.outsider)).to.be.revertedWithCustomError(notes, "NotAuthorized");
      await expect(post(ctx.signers[0])).to.be.revertedWithCustomError(notes, "NotAuthorized");
    });
    it("roles are per election: a device of one election can't post on another", async () => {
      const other = "BEINGS-2026-ZZZZZ9";
      const org2 = ctx.signers[3];
      const k2 = await createElection(ctx, { code: other, from: org2 });
      await ctx.registry.connect(org2).registerDevice(k2, ctx.wallets.device2.address, ethers.id("app-1"));
      await ctx.registry.connect(org2).openElection(k2);
      await ctx.registry.connect(org2).closeElection(k2);
      await ctx.tally.connect(ctx.signers[3]).postTally(k2, ethers.id("root"), PER_Q, 6, 0, 0, "c", ethers.id("r"));
      // election 1's organizer, device1 and reviewer have no role in election 2
      await expect(post(ctx.organizer, { key: k2 })).to.be.revertedWithCustomError(notes, "NotAuthorized");
      await expect(post(ctx.wallets.device1, { key: k2 })).to.be.revertedWithCustomError(notes, "NotAuthorized");
      await expect(post(ctx.wallets.reviewer, { key: k2 })).to.be.revertedWithCustomError(notes, "NotAuthorized");
      await post(ctx.signers[3], { key: k2 });
      expect((await notes.getNote(k2, 0)).role).to.equal(ROLE.Organizer);
      expect(await notes.noteCount(key)).to.equal(0n);
    });
    it("roleOf reports what a wallet would post as", async () => {
      expect(await notes.roleOf(key, ctx.organizer.address)).to.equal(ROLE.Organizer);
      expect(await notes.roleOf(key, ctx.wallets.device2.address)).to.equal(ROLE.Device);
      expect(await notes.roleOf(key, ctx.wallets.reviewer.address)).to.equal(ROLE.Reviewer);
      expect(await notes.roleOf(key, ctx.outsider.address)).to.equal(ROLE.None);
      expect(await notes.roleOf(ethers.id("nope"), ctx.organizer.address)).to.equal(ROLE.None);
    });
  });

  describe("status gating", () => {
    it("unknown election", async () => {
      await expect(notes.connect(ctx.organizer).postNote(ethers.id("nope"), 1, SHA, CID)).to.be.revertedWithCustomError(notes, "UnknownElection");
    });
    it("Setup, Open and Closed are refused; Tallied is accepted", async () => {
      key = await createElection(ctx);
      await expect(post(ctx.organizer)).to.be.revertedWithCustomError(notes, "NotTallied").withArgs(STATUS.Setup);
      const reg = ctx.registry.connect(ctx.organizer);
      await reg.registerDevice(key, ctx.wallets.device1.address, ethers.id("app-1"));
      await reg.openElection(key);
      await expect(post(ctx.organizer)).to.be.revertedWithCustomError(notes, "NotTallied").withArgs(STATUS.Open);
      await reg.closeElection(key);
      await expect(post(ctx.organizer)).to.be.revertedWithCustomError(notes, "NotTallied").withArgs(STATUS.Closed);
      await ctx.tally.connect(ctx.organizer).postTally(key, ethers.id("root"), PER_Q, 6, 0, 0, "c", ethers.id("r"));
      await expect(post(ctx.organizer)).to.emit(notes, "NotePosted");
    });
    it("tallyVersion must be an existing version (1..resultCount)", async () => {
      await tallied();
      await expect(post(ctx.organizer, { ver: 0 })).to.be.revertedWithCustomError(notes, "BadTallyVersion").withArgs(0, 1);
      await expect(post(ctx.organizer, { ver: 2 })).to.be.revertedWithCustomError(notes, "BadTallyVersion").withArgs(2, 1);
      await ctx.tally.connect(ctx.organizer).postAmendedTally(key, ethers.id("root2"), PER_Q, 6, 0, 0, "c2", ethers.id("r2"));
      await post(ctx.organizer, { ver: 2 });
      await post(ctx.organizer, { ver: 1, sha: SHA2 }); // a note about the earlier version is still allowed
      expect(await notes.noteCount(key)).to.equal(2n);
    });
  });

  describe("input checks", () => {
    beforeEach(tallied);
    it("rejects an empty hash and an empty or oversized pointer", async () => {
      await expect(post(ctx.organizer, { sha: ZERO32 })).to.be.revertedWithCustomError(notes, "EmptyNoteHash");
      await expect(post(ctx.organizer, { cid: "" })).to.be.revertedWithCustomError(notes, "EmptyCid");
      await expect(post(ctx.organizer, { cid: "x".repeat(257) })).to.be.revertedWithCustomError(notes, "CidTooLong").withArgs(257);
      await post(ctx.organizer, { cid: "x".repeat(256) });
    });
    it("display name: optional, at most 64 BYTES (multi-byte characters count as bytes)", async () => {
      await expect(post(ctx.organizer, { name: "a".repeat(65) })).to.be.revertedWithCustomError(notes, "DisplayNameTooLong").withArgs(65);
      await expect(post(ctx.organizer, { name: "é".repeat(33) })).to.be.revertedWithCustomError(notes, "DisplayNameTooLong").withArgs(66);
      await post(ctx.organizer, { name: "a".repeat(64) });
      await post(ctx.organizer, { name: "", sha: SHA2 });
      const evs = await notes.queryFilter(notes.filters.NotePosted(key));
      expect(evs.map((e) => e.args.displayName)).to.deep.equal(["a".repeat(64), ""]);
    });
  });

  describe("append-only and duplicates", () => {
    beforeEach(tallied);
    it("the same note hash can't be posted twice for an election, by anyone", async () => {
      await post(ctx.organizer);
      await expect(post(ctx.organizer)).to.be.revertedWithCustomError(notes, "DuplicateNote").withArgs(0);
      await expect(post(ctx.wallets.reviewer)).to.be.revertedWithCustomError(notes, "DuplicateNote").withArgs(0);
      await expect(post(ctx.organizer, { name: "Organizer" })).to.be.revertedWithCustomError(notes, "DuplicateNote").withArgs(0);
      expect(await notes.noteIndexPlusOne(key, SHA)).to.equal(1n);
    });
    it("keeps every note in posting order (a correction is a new note)", async () => {
      await post(ctx.organizer);
      await post(ctx.wallets.reviewer, { sha: SHA2, cid: "ipfs://bafy-second" });
      expect(await notes.noteCount(key)).to.equal(2n);
      expect((await notes.getNote(key, 0)).noteSha256).to.equal(SHA);
      expect((await notes.getNote(key, 1)).author).to.equal(ctx.wallets.reviewer.address);
      expect((await notes.queryFilter(notes.filters.NotePosted(key)))[1].args.cid).to.equal("ipfs://bafy-second");
      expect(await notes.noteIndexPlusOne(key, SHA2)).to.equal(2n);
      await expect(notes.getNote(key, 2)).to.be.reverted;
    });
    it("posting a note changes nothing in the tally or registry (counts, failed checks, finality, status)", async () => {
      const before = await ctx.tally.getResult(key, 1);
      const elBefore = await ctx.registry.elections(key);
      await post(ctx.organizer);
      await post(ctx.wallets.reviewer, { sha: SHA2 });
      const after = await ctx.tally.getResult(key, 1);
      expect(after.failedChecks).to.equal(before.failedChecks);
      expect(after.finality).to.equal(before.finality);
      expect(after.recon).to.deep.equal(before.recon);
      expect(after.resultsSha256).to.equal(before.resultsSha256);
      expect(await ctx.tally.resultCount(key)).to.equal(1n);
      expect(await ctx.tally.isFinal(key)).to.equal(false);
      expect(await ctx.registry.elections(key)).to.deep.equal(elBefore);
    });
  });

  describe("event and stored contents", () => {
    beforeEach(tallied);
    it("NotePosted(electionKey, author, role, tallyVersion, noteSha256, cid, displayName, timestamp) matches storage", async () => {
      const tx = await post(ctx.wallets.reviewer, { name: "Ms. Example, reviewer" });
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
      await expect(tx).to.emit(notes, "NotePosted").withArgs(key, ctx.wallets.reviewer.address, ROLE.Reviewer, 1, SHA, CID, "Ms. Example, reviewer", ts);
      const ev = rc.logs.map((l) => notes.interface.parseLog(l)).find((e) => e && e.name === "NotePosted");
      expect(ev.fragment.inputs.map((i) => [i.name, i.indexed])).to.deep.equal([
        ["electionKey", true], ["author", true], ["role", false], ["tallyVersion", false], ["noteSha256", false], ["cid", false], ["displayName", false], ["timestamp", false],
      ]);
      const n = await notes.getNote(key, 0);
      expect([n.author, Number(n.role), Number(n.tallyVersion), Number(n.postedAt), n.noteSha256]).to.deep.equal([ctx.wallets.reviewer.address, ROLE.Reviewer, 1, ts, SHA]);
      expect(ev.args.cid).to.equal(CID);
      expect(ev.args.displayName).to.equal("Ms. Example, reviewer");
    });
    it("events can be filtered by election and by author", async () => {
      await post(ctx.organizer);
      await post(ctx.wallets.device1, { sha: SHA2 });
      const byKey = await notes.queryFilter(notes.filters.NotePosted(key));
      const byDevice = await notes.queryFilter(notes.filters.NotePosted(null, ctx.wallets.device1.address));
      expect(byKey).to.have.length(2);
      expect(byDevice).to.have.length(1);
      expect(byDevice[0].args.noteSha256).to.equal(SHA2);
    });
  });

  describe("gas (in-process network; see scripts/notes-gas.js for the report)", () => {
    it("deploy and postNote stay under the planning ceilings", async () => {
      const F = await ethers.getContractFactory("ElectionNotes", ctx.signers[0]);
      const c = await F.deploy(await ctx.registry.getAddress());
      const deployGas = Number((await c.deploymentTransaction().wait()).gasUsed);
      await tallied();
      const g1 = Number((await (await c.connect(ctx.organizer).postNote(key, 1, SHA, CID)).wait()).gasUsed);
      const g2 = Number((await (await c.connect(ctx.organizer).postNoteWithName(key, 1, SHA2, CID, "x".repeat(64))).wait()).gasUsed);
      expect(deployGas).to.be.below(1_200_000);
      expect(g1).to.be.below(200_000);
      expect(g2).to.be.below(220_000);
    });
  });
});

describe("deploy-notes script (in-process network only)", () => {
  const { checkFee, main } = require("../scripts/deploy-notes");
  it("refuses a live send without an approved cap, or above it", () => {
    expect(checkFee({ gas: 900000n, gasPriceWei: 1000000000000n, approvedMaxFeeWei: undefined }).ok).to.equal(false);
    expect(checkFee({ gas: 900000n, gasPriceWei: 1000000000000n, approvedMaxFeeWei: "899999999999999999" }).ok).to.equal(false);
    expect(checkFee({ gas: 900000n, gasPriceWei: 1000000000000n, approvedMaxFeeWei: "900000000000000000" }).ok).to.equal(true);
  });
  it("dry run deploys ElectionNotes wired to the registry's Tally", async () => {
    await require("hardhat").network.provider.send("hardhat_reset");
    const out = await main();
    expect(out.network).to.equal("hardhat");
    expect(out.gasUsed).to.be.below(1_200_000);
    const c = await ethers.getContractAt("ElectionNotes", out.ElectionNotes);
    expect(await c.tally()).to.equal(out.tally);
  });
});
