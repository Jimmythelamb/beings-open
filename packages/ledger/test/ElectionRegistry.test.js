const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, setup, snapshotHooks, createElection, openElection, now, ONE_DAY, STATUS, ZERO32 } = require("./helpers");

describe("ElectionRegistry", () => {
  let ctx;
  before(async () => {
    ctx = await setup();
  });
  snapshotHooks();

  const reg = () => ctx.registry.connect(ctx.organizer);

  describe("wiring", () => {
    it("is wired once by the deployer", async () => {
      expect(await ctx.registry.ledger()).to.equal(ctx.addresses.ledger);
      expect(await ctx.registry.tally()).to.equal(ctx.addresses.tally);
      await expect(ctx.registry.setLedger(ctx.outsider.address)).to.be.revertedWithCustomError(ctx.registry, "AlreadySet");
      await expect(ctx.registry.setTally(ctx.outsider.address)).to.be.revertedWithCustomError(ctx.registry, "AlreadySet");
      await expect(ctx.registry.connect(ctx.outsider).setLedger(ctx.outsider.address)).to.be.revertedWithCustomError(ctx.registry, "NotDeployer");
    });

    it("deploys in the documented order (the core vectors' verifyingContract is the ledger)", async () => {
      expect(ctx.addresses.ledger).to.equal(ctx.vec.eip712.domain.verifyingContract);
      expect(ctx.addresses.verifierRegistry).to.equal(ctx.vec.eip712.notice.domain.verifyingContract);
    });
  });

  describe("createElection", () => {
    it("stores the election under keccak256(electionCode) and posts version 0", async () => {
      const key = await createElection(ctx);
      expect(key).to.equal(ctx.vec.codes.electionKey);
      const e = await ctx.registry.elections(key);
      expect(e.organizer).to.equal(ctx.organizer.address);
      expect(e.status).to.equal(STATUS.Setup);
      expect(e.ballotCount).to.equal(8);
      expect(e.quorum).to.equal(1);
      expect(e.ballotListRoot).to.equal(ctx.vec.merkle.ballotListRoot.root);
      expect(await ctx.registry.versionCount(key)).to.equal(1);
      const v = await ctx.registry.latestVersion(key);
      expect(v.cid).to.equal("bafy-election-file");
    });

    it("emits ElectionCreated, VersionPosted and StatusChanged", async () => {
      const t = await now();
      await expect(
        ctx.registry.connect(ctx.organizer).createElection(ctx.vec.codes.electionCode, "cid", ethers.id("f"), 8, 6, 1, t, t + 100, ZERO32)
      )
        .to.emit(ctx.registry, "ElectionCreated")
        .withArgs(ctx.vec.codes.electionKey, ctx.vec.codes.electionCode, ctx.organizer.address)
        .and.to.emit(ctx.registry, "VersionPosted")
        .and.to.emit(ctx.registry, "StatusChanged");
    });

    it("rejects a duplicate code, a bad format and bad parameters", async () => {
      await createElection(ctx);
      await expect(createElection(ctx)).to.be.revertedWithCustomError(ctx.registry, "ElectionExists");
      for (const code of ["", "BEINGS-26-K7M4Q2", "beings-2026-K7M4Q2", "BEINGS-2026-K7M4Q", "BEINGS-2026-K7M4QI", "BEINGS-2026-K7M4Q2X", "BEINGS-20A6-K7M4Q2"]) {
        await expect(createElection(ctx, { code }), code).to.be.revertedWithCustomError(ctx.registry, "BadElectionCode");
      }
      const t = await now();
      const bad = (o) => createElection(ctx, { code: "BEINGS-2026-AAAAAA", ...o });
      await expect(bad({ ballotCount: 0 })).to.be.revertedWithCustomError(ctx.registry, "BadParameters");
      await expect(bad({ quorum: 0 })).to.be.revertedWithCustomError(ctx.registry, "BadParameters");
      await expect(bad({ opensAt: t + 10, closesAt: t + 10 })).to.be.revertedWithCustomError(ctx.registry, "BadParameters");
    });
  });

  describe("setup", () => {
    it("lets only the organizer register devices, reviewers and versions, during Setup only", async () => {
      const key = await createElection(ctx);
      const d = ctx.wallets.device1.address;
      await expect(ctx.registry.connect(ctx.outsider).registerDevice(key, d, ZERO32)).to.be.revertedWithCustomError(ctx.registry, "NotOrganizer");
      await expect(reg().registerDevice(key, d, ethers.id("app")))
        .to.emit(ctx.registry, "DeviceRegistered")
        .withArgs(key, d, ethers.id("app"));
      expect(await ctx.registry.roles(key, d)).to.equal(1);
      expect(await ctx.registry.deviceCount(key)).to.equal(1);
      await expect(reg().registerDevice(key, d, ZERO32)).to.be.revertedWithCustomError(ctx.registry, "RoleTaken");
      await expect(reg().registerReviewer(key, d)).to.be.revertedWithCustomError(ctx.registry, "RoleTaken");
      await expect(reg().registerDevice(key, ethers.ZeroAddress, ZERO32)).to.be.revertedWithCustomError(ctx.registry, "ZeroAddress");

      await expect(reg().registerReviewer(key, ctx.wallets.reviewer.address)).to.emit(ctx.registry, "ReviewerRegistered");
      expect(await ctx.registry.roles(key, ctx.wallets.reviewer.address)).to.equal(2);

      await reg().postVersion(key, "bafy-v2", ethers.id("v2"));
      expect(await ctx.registry.versionCount(key)).to.equal(2);
      expect((await ctx.registry.latestVersion(key)).cid).to.equal("bafy-v2");
      expect((await ctx.registry.getVersion(key, 0)).cid).to.equal("bafy-election-file");
      await expect(reg().postVersion(key, "", ethers.id("v3"))).to.be.revertedWithCustomError(ctx.registry, "BadParameters");
    });

    it("rejects unknown elections", async () => {
      const key = ethers.id("nope");
      await expect(reg().registerDevice(key, ctx.outsider.address, ZERO32)).to.be.revertedWithCustomError(ctx.registry, "UnknownElection");
      await expect(ctx.registry.latestVersion(key)).to.be.revertedWithCustomError(ctx.registry, "UnknownElection");
      await expect(reg().closeElection(key)).to.be.revertedWithCustomError(ctx.registry, "UnknownElection");
    });
  });

  describe("status flow", () => {
    it("needs at least `quorum` devices and opensAt to open, then flows Open -> Closed", async () => {
      const t = await now();
      const key = await createElection(ctx, { quorum: 2, opensAt: t + 1000, closesAt: t + 2000 });
      await expect(reg().openElection(key)).to.be.revertedWithCustomError(ctx.registry, "NotEnoughDevices").withArgs(0, 2);
      await reg().registerDevice(key, ctx.wallets.device1.address, ZERO32);
      await reg().registerDevice(key, ctx.wallets.device2.address, ZERO32);
      await expect(reg().openElection(key)).to.be.revertedWithCustomError(ctx.registry, "TooEarly");
      await time.increaseTo(t + 1001);
      await expect(reg().openElection(key)).to.emit(ctx.registry, "StatusChanged").withArgs(key, STATUS.Setup, STATUS.Open);
      await expect(reg().registerDevice(key, ctx.outsider.address, ZERO32)).to.be.revertedWithCustomError(ctx.registry, "WrongStatus");
      await expect(reg().closeElection(key)).to.emit(ctx.registry, "StatusChanged").withArgs(key, STATUS.Open, STATUS.Closed);
      await expect(reg().closeElection(key)).to.be.revertedWithCustomError(ctx.registry, "WrongStatus");
    });

    it("lets anyone close only after closesAt + 1 day", async () => {
      const key = await openElection(ctx);
      const e = await ctx.registry.elections(key);
      await expect(ctx.registry.connect(ctx.outsider).closeElection(key)).to.be.revertedWithCustomError(ctx.registry, "CloseNotAllowed");
      await time.increaseTo(Number(e.closesAt) + ONE_DAY + 1);
      await ctx.registry.connect(ctx.outsider).closeElection(key);
      expect((await ctx.registry.elections(key)).status).to.equal(STATUS.Closed);
    });

    it("markTallied is for the Tally contract only", async () => {
      const key = await openElection(ctx);
      await expect(reg().markTallied(key)).to.be.revertedWithCustomError(ctx.registry, "NotTally");
    });

    it("noticeImagesRetired is organizer-only and only after close", async () => {
      const key = await openElection(ctx);
      await expect(reg().noticeImagesRetired(key, "bafy-note")).to.be.revertedWithCustomError(ctx.registry, "WrongStatus");
      await reg().closeElection(key);
      await expect(ctx.registry.connect(ctx.outsider).noticeImagesRetired(key, "n")).to.be.revertedWithCustomError(ctx.registry, "NotOrganizer");
      await expect(reg().noticeImagesRetired(key, "bafy-note")).to.emit(ctx.registry, "ImagesRetired");
    });
  });

  describe("ballot list (Merkle root of ballot keys, core vector)", () => {
    it("ballotListed accepts every core proof and rejects strangers", async () => {
      const key = await createElection(ctx);
      const keys = ctx.vec.merkle.ballotListRoot.codes.map((c) => ctx.core.ballotKey(c));
      for (const k of keys) {
        expect(await ctx.registry.ballotListed(key, k, ctx.core.merkleProof(keys, k))).to.equal(true);
      }
      const stranger = ctx.core.ballotKey("ZZZZZZZZZZZZ");
      expect(await ctx.registry.ballotListed(key, stranger, ctx.core.merkleProof(keys, keys[0]))).to.equal(false);
    });

    it("never matches when no list root was registered", async () => {
      const key = await createElection(ctx, { ballotListRoot: ZERO32 });
      expect(await ctx.registry.ballotListed(key, ZERO32, [])).to.equal(false);
    });
  });
});
