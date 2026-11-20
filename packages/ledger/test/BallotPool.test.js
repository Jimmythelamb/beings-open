// Ballot pool (spec v0.8 sections 9.5–9.7). Synthetic codes only. Nothing here is a real ballot.
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers, setup, snapshotHooks, createElection, openElection, now, ONE_DAY, QUESTION_ORDER, hex } = require("./helpers");

const CODES = ["AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC"];
const ADDED = ["DDDDDDDDDDDD", "EEEEEEEEEEEE"];
const STRANGER = "FFFFFFFFFFFF";

describe("Ballot pool", () => {
  let ctx;
  before(async () => {
    ctx = await setup();
  });
  snapshotHooks();

  const reg = () => ctx.registry.connect(ctx.organizer);
  const rootOf = (codes) => ctx.core.ballotListRoot(codes);
  const proofOf = (codes, code) => ctx.core.merkleProof(codes.map(ctx.core.ballotKey), ctx.core.ballotKey(code));

  async function submission(electionCode, ballotCode) {
    const { core } = ctx;
    const results = { q1: "V:c1", q2: "V:c2" };
    const imageSha256 = core.sha256Hex(`image-${ballotCode}`);
    const fillScores = { q1: { c1: 90, c2: 1, c3: 0 }, q2: { c1: 1, c2: 90 } };
    const input = { electionCode, ballotCode, results, imageSha256, fillScores, questionOrder: QUESTION_ORDER };
    const device = ctx.wallets.device1;
    return {
      electionKey: core.electionKey(electionCode),
      ballotKey: core.ballotKey(ballotCode),
      results: core.encodeResults(results, QUESTION_ORDER),
      imageSha256: hex(imageSha256),
      recordSha256: hex(core.sha256Hex(`record-${ballotCode}`)),
      readings: [{
        device: device.address,
        imageSha256: hex(imageSha256),
        scoresHash: core.scoresHash(fillScores),
        sig: await core.signReading(device, input, ctx.domain),
      }],
      reviewer: ethers.ZeroAddress,
      reviewerSig: "0x",
    };
  }

  async function createPooled(code, codes, opensAt, closesAt) {
    await reg().createPooledElection(code, "bafy-election-file", ethers.id("election-file"), codes.length, codes.length, 1, opensAt, closesAt, rootOf(codes));
    return ctx.core.electionKey(code);
  }

  async function arm(key) {
    await reg().registerDevice(key, ctx.wallets.device1.address, ethers.id("app-1"));
    const opensAt = Number((await ctx.registry.elections(key)).opensAt);
    if ((await now()) < opensAt) await time.increaseTo(opensAt);
    await reg().openElection(key);
  }

  const submit = (sub, proof, rootIndex) => ctx.ledger.connect(ctx.outsider).submitRecord(sub, proof, rootIndex);

  it("accepts a listed code and rejects an unlisted code and a bad proof, through submitRecord and submitBatch", async () => {
    const t = await now();
    const code = "BEINGS-2026-ADD001";
    const key = await createPooled(code, CODES, t - 10, t + ONE_DAY);
    expect(await ctx.registry.poolEnforced(key)).to.equal(true);
    await arm(key);

    const listed = await submission(code, CODES[0]);
    const proof = proofOf(CODES, CODES[0]);
    await expect(submit(listed, proof, 0)).to.emit(ctx.ledger, "BallotAccepted");
    expect(await ctx.ledger.recordCount(key)).to.equal(1);

    const unlisted = await submission(code, STRANGER);
    await expect(submit(unlisted, proof, 0)).to.be.revertedWithCustomError(ctx.ledger, "BallotNotInPool").withArgs(unlisted.ballotKey);
    const badProof = proof.length ? [proof[0] === ethers.ZeroHash ? ethers.id("not-a-sibling") : ethers.ZeroHash, ...proof.slice(1)] : [ethers.id("not-a-sibling")];
    const second = await submission(code, CODES[1]);
    await expect(submit(second, badProof, 0)).to.be.revertedWithCustomError(ctx.ledger, "BallotNotInPool").withArgs(second.ballotKey);
    await expect(ctx.ledger.submitRecord(second)).to.be.revertedWithCustomError(ctx.ledger, "PoolProofRequired");

    const batch = [await submission(code, CODES[1]), await submission(code, CODES[2])];
    const proofs = [proofOf(CODES, CODES[1]), proofOf(CODES, CODES[2])];
    await ctx.ledger.connect(ctx.outsider).submitBatch(batch, proofs, [0, 0]);
    expect(await ctx.ledger.recordCount(key)).to.equal(3);

    const mixed = [await submission(code, CODES[0]), await submission(code, STRANGER)];
    await expect(ctx.ledger.submitBatch(mixed, [proofOf(CODES, CODES[0]), proof], [0, 0])).to.be.revertedWithCustomError(ctx.ledger, "AlreadyRecorded");
    await expect(ctx.ledger.submitBatch([await submission(code, STRANGER)], [proof], [0])).to.be.revertedWithCustomError(ctx.ledger, "BallotNotInPool");
    await expect(ctx.ledger.submitBatch([await submission(code, STRANGER)])).to.be.revertedWithCustomError(ctx.ledger, "PoolProofRequired");
    expect(await ctx.ledger.recordCount(key)).to.equal(3);
  });

  it("accepts a code added before opening, and the tally's printed count includes it", async () => {
    const t = await now();
    const code = "BEINGS-2026-NEW001";
    const key = await createPooled(code, CODES, t + 1000, t + ONE_DAY);
    const addedRoot = rootOf(ADDED);
    await expect(reg().addBallots(key, addedRoot, ADDED.length)).to.emit(ctx.registry, "BallotsAdded").withArgs(key, addedRoot, ADDED.length, CODES.length + ADDED.length);
    expect(await ctx.registry.ballotRootCount(key)).to.equal(2);
    expect(await ctx.registry.ballotRootAt(key, 1)).to.equal(addedRoot);
    expect((await ctx.registry.elections(key)).ballotCount).to.equal(CODES.length + ADDED.length);

    await arm(key);
    const added = await submission(code, ADDED[0]);
    await expect(submit(added, proofOf(ADDED, ADDED[0]), 1)).to.emit(ctx.ledger, "BallotAccepted");
    await expect(submit(await submission(code, ADDED[0]), proofOf(CODES, CODES[0]), 0)).to.be.revertedWithCustomError(ctx.ledger, "BallotNotInPool");

    await reg().closeElection(key);
    const perQ = [
      { valid: 1, blank: 0, overvote: 0, unclear: 0 },
      { valid: 1, blank: 0, overvote: 0, unclear: 0 },
    ];
    await ctx.tally.connect(ctx.organizer).postTally(key, ethers.id("pool-root"), perQ, CODES.length, 1, 0, "bafy-results", ethers.id("results"));
    const res = await ctx.tally.getResult(key, 1);
    expect(res.recon.printed).to.equal(CODES.length + ADDED.length);
    expect(res.recon.cast).to.equal(1);
    expect(res.recon.unissued).to.equal(CODES.length + ADDED.length - 1);
  });

  it("rejects addBallots at and after opening, from anyone who is not the organizer, and on an old election", async () => {
    const t = await now();
    const code = "BEINGS-2026-PAST01";
    const key = await createPooled(code, CODES, t + 500, t + ONE_DAY);
    await expect(ctx.registry.connect(ctx.outsider).addBallots(key, rootOf(ADDED), ADDED.length)).to.be.revertedWithCustomError(ctx.registry, "NotOrganizer");
    await time.increaseTo(t + 500);
    await expect(reg().addBallots(key, rootOf(ADDED), ADDED.length)).to.be.revertedWithCustomError(ctx.registry, "BallotsLocked");
    await time.increaseTo(t + 800);
    await expect(reg().addBallots(key, rootOf(ADDED), ADDED.length)).to.be.revertedWithCustomError(ctx.registry, "BallotsLocked");

    const oldKey = await createElection(ctx, { code: "BEINGS-2026-KEEP01" });
    expect(await ctx.registry.poolEnforced(oldKey)).to.equal(false);
    await expect(reg().addBallots(oldKey, rootOf(ADDED), 1)).to.be.revertedWithCustomError(ctx.registry, "PoolNotEnforced");
  });

  it("rejects a second record for the same code even when that code is in two approved roots", async () => {
    const t = await now();
    const code = "BEINGS-2026-SAME01";
    const first = ["AAAAAAAAAAAA", "BBBBBBBBBBBB"];
    const second = ["AAAAAAAAAAAA", "CCCCCCCCCCCC"];
    const key = await createPooled(code, first, t + 100, t + ONE_DAY);
    await reg().addBallots(key, rootOf(second), second.length);
    await arm(key);
    const sub = await submission(code, "AAAAAAAAAAAA");
    await submit(sub, proofOf(first, "AAAAAAAAAAAA"), 0);
    await expect(submit(sub, proofOf(second, "AAAAAAAAAAAA"), 1)).to.be.revertedWithCustomError(ctx.ledger, "AlreadyRecorded");
    expect(await ctx.ledger.recordCount(key)).to.equal(1);
  });

  it("leaves an election created the old way able to record without a proof", async () => {
    const key = await openElection(ctx, { code: "BEINGS-2026-KEEP02" });
    expect(await ctx.registry.poolEnforced(key)).to.equal(false);
    const { buildSubmission, toStruct } = require("./helpers");
    const ctxOld = { ...ctx, vec: { ...ctx.vec, codes: { ...ctx.vec.codes, electionCode: "BEINGS-2026-KEEP02" } } };
    const sub = toStruct(await buildSubmission(ctxOld, 0, { q1: "V:c1", q2: "V:c2" }));
    await expect(ctx.ledger.submitRecord(sub)).to.emit(ctx.ledger, "BallotAccepted");
    const stranger = await submission("BEINGS-2026-KEEP02", STRANGER);
    await expect(ctx.ledger.submitRecord(stranger)).to.emit(ctx.ledger, "BallotAccepted");
    expect(await ctx.ledger.recordCount(key)).to.equal(2);
  });

  it("logs a reprint by ballot key and still accepts only one record", async () => {
    const t = await now();
    const code = "BEINGS-2026-RPR001";
    const key = await createPooled(code, CODES, t - 10, t + ONE_DAY);
    const reasonHash = ethers.id("torn before it was cast");
    await expect(ctx.registry.connect(ctx.outsider).noteReprint(key, ctx.core.ballotKey(CODES[1]), reasonHash, proofOf(CODES, CODES[1]), 0)).to.be.revertedWithCustomError(ctx.registry, "NotOrganizer");
    await expect(reg().noteReprint(key, ctx.core.ballotKey(STRANGER), reasonHash, proofOf(CODES, CODES[0]), 0)).to.be.revertedWithCustomError(ctx.registry, "BallotNotInPool");
    await expect(reg().noteReprint(key, ctx.core.ballotKey(CODES[1]), reasonHash, proofOf(CODES, CODES[1]), 0))
      .to.emit(ctx.registry, "ReprintNoted")
      .withArgs(key, ctx.core.ballotKey(CODES[1]), reasonHash, ctx.organizer.address);
    await arm(key);
    const sub = await submission(code, CODES[1]);
    await submit(sub, proofOf(CODES, CODES[1]), 0);
    await expect(submit(sub, proofOf(CODES, CODES[1]), 0)).to.be.revertedWithCustomError(ctx.ledger, "AlreadyRecorded");
  });

  it("deploys the registry and the ledger in one Coston2-sized transaction each", async () => {
    for (const contract of [ctx.registry, ctx.ledger]) {
      const rc = await contract.deploymentTransaction().wait();
      expect(Number(rc.gasUsed)).to.be.greaterThan(500_000);
      expect(Number(rc.gasUsed)).to.be.lessThan(8_000_000);
    }
  });
});
