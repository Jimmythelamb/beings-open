const { expect } = require("chai");
const {
  ethers, setup, snapshotHooks, openElection, buildSubmission, toStruct, correction, REASON, STATUS, ZERO32, QUESTION_ORDER, hex,
} = require("./helpers");

describe("Tally", () => {
  let ctx, key;
  before(async () => {
    ctx = await setup();
  });
  snapshotHooks();

  const organizerTally = () => ctx.tally.connect(ctx.organizer);
  const toPerQ = (t) => QUESTION_ORDER.map((q) => ({ valid: t[q].valid, blank: t[q].blank, overvote: t[q].overvote, unclear: t[q].unclear }));
  const post = (perQ, o = {}) => {
    const p = { registered: 6, issued: 6, unusedReturned: 0, cid: "bafy-results", sha: ethers.id("results-file"), root: ethers.id("root"), ...o };
    return (o.from || organizerTally()).postTally(key, p.root, perQ, p.registered, p.issued, p.unusedReturned, p.cid, p.sha);
  };

  /** Replays the vector ledger on-chain: 5 recorded ballots (one reviewed), 2 corrections, 1 spoiled ballot. */
  async function replayVectorLedger() {
    key = await openElection(ctx);
    const reviewerLedger = ctx.ledger.connect(ctx.wallets.reviewer);
    for (const [i, e] of ctx.vec.tally.entries.entries()) {
      // image hashes are sha256("image-<i>") in both the vector and the helper, so the readings line up
      const rebuilt = await buildSubmission(ctx, i, e.results, { reviewer: e.reviewed ? ctx.wallets.reviewer : undefined, imageTag: `image-${i}` });
      expect(rebuilt.imageSha256).to.equal(hex(e.imageSha256));
      rebuilt.recordSha256 = hex(e.recordSha256);
      await ctx.ledger.connect(ctx.outsider).submitRecord(toStruct(rebuilt));
    }
    for (const c of ctx.vec.tally.corrections) {
      const qi = QUESTION_ORDER.indexOf(c.questionId);
      const bi = ctx.vec.codes.ballots.findIndex((b) => b.ballotCode === c.ballotCode);
      await reviewerLedger.postCorrection(key, correction(ctx, bi, { prevIndex: c.prevIndex, questionIndex: qi, fromResult: c.from, toResult: c.to, reason: REASON[c.reason] }));
    }
    await ctx.ledger.connect(ctx.organizer).markSpoiled(key, ethers.id("spoiled-ballot-1"), ZERO32);
    await ctx.registry.connect(ctx.organizer).closeElection(key);
  }

  /** Effective entries as read back from the chain (records + head correction), shaped as core ledger entries. */
  async function entriesFromChain() {
    const out = [];
    for (const [i, b] of ctx.vec.codes.ballots.entries()) {
      const r = await ctx.ledger.records(key, ctx.key.ballot(i));
      if (r.acceptedAt === 0n) continue;
      const segs = r.results.split("|");
      for (let q = 0; q < segs.length; q++) {
        const h = await ctx.ledger.head(key, ctx.key.ballot(i), q);
        if (h !== 0n) segs[q] = (await ctx.ledger.corrections(key, h - 1n)).toResult;
      }
      out.push({
        electionCode: ctx.vec.codes.electionCode,
        ballotCode: b.ballotCode,
        results: Object.fromEntries(QUESTION_ORDER.map((q, k) => [q, segs[k]])),
        imageSha256: r.imageSha256.slice(2),
        recordSha256: r.recordSha256.slice(2),
        reviewed: r.reviewed,
      });
    }
    return out;
  }

  describe("full replay of the core tally vector", () => {
    beforeEach(replayVectorLedger);

    it("on-chain effective results give exactly the vector leaves, Merkle root and per-question counts", async () => {
      const eff = await entriesFromChain();
      expect(eff.map((e) => ({ ballotCode: e.ballotCode, results: e.results }))).to.deep.equal(ctx.vec.tally.effectiveResults);
      const leaves = eff.map((e) => ctx.core.entryLeaf(e));
      expect(leaves).to.deep.equal(ctx.vec.tally.leaves.map((l) => l.leaf));
      const root = ctx.core.merkleRoot(leaves);
      expect(root).to.equal(ctx.vec.tally.merkleRootWithCorrections);

      // perQuestion counts recomputed from on-chain data equal the vector
      const counts = ctx.core.tallyQuestions(eff, [], {});
      for (const q of QUESTION_ORDER) {
        const v = ctx.vec.tally.tallyWithCorrections[q];
        expect([counts[q].valid, counts[q].blank, counts[q].overvote, counts[q].unclear]).to.deep.equal([v.valid, v.blank, v.overvote, v.unclear]);
      }
    });

    it("postTally with the vector root and counts: all checks pass, Final, status Tallied, inclusion proofs verify", async () => {
      const leaves = ctx.vec.tally.leaves.map((l) => l.leaf);
      const root = ctx.vec.tally.merkleRootWithCorrections;
      await expect(post(toPerQ(ctx.vec.tally.tallyWithCorrections), { root }))
        .to.emit(ctx.tally, "TallyPosted")
        .withArgs(key, 1, root, 6, 5, 1, 0, 0, 1, "bafy-results")
        .and.not.to.emit(ctx.tally, "ReviewRequired");
      const res = await ctx.tally.getResult(key, 1);
      expect(res.failedChecks).to.equal(0);
      expect(res.finality).to.equal(1);
      expect(res.recon.cast).to.equal(5); // read from the ledger
      expect(res.recon.spoiled).to.equal(1); // read from the ledger
      expect(res.recon.printed).to.equal(8); // read from the registry
      expect(res.recon.unissued).to.equal(2);
      expect(await ctx.tally.isFinal(key)).to.equal(true);
      expect((await ctx.registry.elections(key)).status).to.equal(STATUS.Tallied);
      expect((await ctx.tally.perQuestion(key, 1, 0)).valid).to.equal(4);

      for (const leaf of leaves) {
        expect(await ctx.tally.verifyInclusion(key, 1, leaf, ctx.core.merkleProof(leaves, leaf))).to.equal(true);
      }
      expect(await ctx.tally.verifyInclusion(key, 1, ethers.id("not a leaf"), ctx.core.merkleProof(leaves, leaves[0]))).to.equal(false);
      expect(await ctx.tally.verifyInclusion(key, 2, leaves[0], [])).to.equal(false);
      expect(await ctx.tally.verifyInclusion(key, 0, leaves[0], [])).to.equal(false);

      // the pre-correction leaf of the corrected ballot is NOT in the tree
      const preCorrection = ctx.core.entryLeaf(ctx.vec.tally.entries[1]);
      expect(leaves).to.not.include(preCorrection);
      expect(await ctx.tally.verifyInclusion(key, 1, preCorrection, ctx.core.merkleProof(leaves, leaves[1]))).to.equal(false);
    });

    it("a wrong per-question count (R5) makes it Provisional and emits ReviewRequired; a reviewer can clear it", async () => {
      const perQ = toPerQ(ctx.vec.tally.tallyWithCorrections);
      perQ[0].unclear = 1; // sums to 6 != cast 5
      await expect(post(perQ)).to.emit(ctx.tally, "ReviewRequired").withArgs(key, 1, 16);
      expect(await ctx.tally.isFinal(key)).to.equal(false);
      expect((await ctx.tally.getResult(key, 1)).finality).to.equal(0);

      await expect(ctx.tally.connect(ctx.outsider).clearReview(key, 1, "bafy-clear")).to.be.revertedWithCustomError(ctx.tally, "NotReviewer");
      await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 1, "")).to.be.revertedWithCustomError(ctx.tally, "EmptyClearanceCid");
      await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 2, "bafy-clear")).to.be.revertedWithCustomError(ctx.tally, "NotLatestVersion").withArgs(1);
      await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 1, "bafy-clear"))
        .to.emit(ctx.tally, "ReviewCleared")
        .withArgs(key, 1, ctx.wallets.reviewer.address, "bafy-clear");
      const res = await ctx.tally.getResult(key, 1);
      expect(res.finality).to.equal(1);
      expect(res.failedChecks).to.equal(16); // the failure stays on the record
      expect(res.clearedBy).to.equal(ctx.wallets.reviewer.address);
      expect(await ctx.tally.isFinal(key)).to.equal(true);
      await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 1, "again")).to.be.revertedWithCustomError(ctx.tally, "NotProvisional");
    });

    it("a count mismatch (R4: unusedReturned) is recorded as public failure, not a revert", async () => {
      await expect(post(toPerQ(ctx.vec.tally.tallyWithCorrections), { unusedReturned: 0, issued: 7 }))
        .to.emit(ctx.tally, "ReviewRequired")
        .withArgs(key, 1, 8);
      expect((await ctx.tally.getResult(key, 1)).recon.unissued).to.equal(1);
    });

    it("postAmendedTally adds version 2 and re-runs the checks; the old version stays readable", async () => {
      const good = toPerQ(ctx.vec.tally.tallyWithCorrections);
      await post(good, { root: ctx.vec.tally.merkleRootWithCorrections });
      const amendedRoot = ethers.id("amended-root");
      await expect(organizerTally().postAmendedTally(key, amendedRoot, good, 6, 6, 0, "bafy-results-v2", ethers.id("v2")))
        .to.emit(ctx.tally, "TallyPosted")
        .withArgs(key, 2, amendedRoot, 6, 5, 1, 0, 0, 1, "bafy-results-v2");
      expect(await ctx.tally.resultCount(key)).to.equal(2);
      expect((await ctx.tally.getResult(key, 1)).merkleRoot).to.equal(ctx.vec.tally.merkleRootWithCorrections);
      expect((await ctx.tally.getResult(key, 2)).merkleRoot).to.equal(amendedRoot);
      // a bad amendment is Provisional, and isFinal follows the LATEST version
      const bad = good.map((q) => ({ ...q }));
      bad[1].blank += 1;
      await organizerTally().postAmendedTally(key, amendedRoot, bad, 6, 6, 0, "bafy-v3", ethers.id("v3"));
      expect(await ctx.tally.isFinal(key)).to.equal(false);
      await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 2, "x")).to.be.revertedWithCustomError(ctx.tally, "NotLatestVersion").withArgs(3);
    });

    it("guards: organizer only, one initial tally, amended needs Tallied, closed election needed", async () => {
      const good = toPerQ(ctx.vec.tally.tallyWithCorrections);
      await expect(post(good, { from: ctx.tally.connect(ctx.outsider) })).to.be.revertedWithCustomError(ctx.tally, "NotOrganizer");
      await expect(organizerTally().postAmendedTally(key, ZERO32, good, 6, 6, 0, "c", ZERO32)).to.be.revertedWithCustomError(ctx.tally, "WrongElectionStatus");
      await expect(post([])).to.be.revertedWithCustomError(ctx.tally, "NoQuestions");
      await post(good);
      await expect(post(good)).to.be.revertedWithCustomError(ctx.tally, "WrongElectionStatus");
      await expect(ctx.tally.connect(ctx.outsider).postAmendedTally(key, ZERO32, good, 6, 6, 0, "c", ZERO32)).to.be.revertedWithCustomError(ctx.tally, "NotOrganizer");
    });
  });

  it("cannot tally an election that is still Open", async () => {
    key = await openElection(ctx);
    await expect(post([{ valid: 0, blank: 0, overvote: 0, unclear: 0 }], { registered: 6, issued: 0 })).to.be.revertedWithCustomError(ctx.tally, "WrongElectionStatus");
  });

  it("an empty election with a zero-register tally is Final when the counts agree", async () => {
    key = await openElection(ctx, { registeredVoters: 0 });
    await ctx.registry.connect(ctx.organizer).closeElection(key);
    await post([{ valid: 0, blank: 0, overvote: 0, unclear: 0 }], { registered: 0, issued: 0 });
    expect(await ctx.tally.isFinal(key)).to.equal(true);
  });

  it("the Tally results of different elections are independent", async () => {
    key = await openElection(ctx);
    expect(await ctx.tally.isFinal(key)).to.equal(false);
    expect(await ctx.tally.resultCount(key)).to.equal(0);
    await expect(ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 1, "x")).to.be.revertedWithCustomError(ctx.tally, "NoTally");
  });
});
