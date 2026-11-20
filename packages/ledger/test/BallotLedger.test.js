const { expect } = require("chai");
const {
  ethers, setup, snapshotHooks, createElection, openElection, buildSubmission, toStruct, correction,
  REASON, ZERO32, QUESTION_ORDER,
} = require("./helpers");

describe("BallotLedger", () => {
  let ctx;
  let key;
  before(async () => {
    ctx = await setup();
  });
  snapshotHooks();
  beforeEach(async () => {
    key = await openElection(ctx);
  });

  const R = { q1: "V:c1", q2: "V:c2" };
  const submit = async (sub, from = ctx.outsider) => ctx.ledger.connect(from).submitRecord(toStruct(sub));
  const rec = async (i) => ctx.ledger.records(key, ctx.key.ballot(i));

  describe("EIP-712 against the core test vectors", () => {
    it("domain separator, type hashes and the vector digest match @beings/core", async () => {
      const { TypedDataEncoder } = ethers;
      expect(await ctx.ledger.domainSeparator()).to.equal(TypedDataEncoder.hashDomain(ctx.vec.eip712.domain));
      expect(await ctx.ledger.READING_TYPEHASH()).to.equal(ethers.id(TypedDataEncoder.from(ctx.core.READING_TYPES).encodeType("Reading")));
      expect(await ctx.ledger.REVIEW_TYPEHASH()).to.equal(ethers.id(TypedDataEncoder.from(ctx.core.REVIEW_TYPES).encodeType("Review")));
      const m = ctx.vec.eip712.reading.message;
      const structHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
          [await ctx.ledger.READING_TYPEHASH(), m.electionKey, m.ballotKey, m.resultsHash, m.imageSha256, m.scoresHash]
        )
      );
      const digest = ethers.keccak256(ethers.concat(["0x1901", await ctx.ledger.domainSeparator(), structHash]));
      expect(digest).to.equal(ctx.vec.eip712.reading.digest);
    });

    it("accepts the committed device1 signature for the committed reading (quorum 1)", async () => {
      const v = ctx.vec.eip712.reading;
      const sub = {
        electionKey: v.message.electionKey,
        ballotKey: v.message.ballotKey,
        results: ctx.core.encodeResults(v.input.results, QUESTION_ORDER),
        imageSha256: v.message.imageSha256,
        recordSha256: ethers.id("rec"),
        readings: [{ device: ctx.wallets.device1.address, imageSha256: v.message.imageSha256, scoresHash: v.message.scoresHash, sig: v.signatureDevice1 }],
        reviewer: ethers.ZeroAddress,
        reviewerSig: "0x",
      };
      expect(ethers.keccak256(ethers.toUtf8Bytes(sub.results))).to.equal(v.message.resultsHash);
      await expect(ctx.ledger.submitRecord(sub)).to.emit(ctx.ledger, "BallotAccepted").withArgs(key, v.message.ballotKey, "V:c1|V:c2", v.message.imageSha256, sub.recordSha256, false);
      // a flipped bit in the committed signature must not verify
      const bad = { ...sub, ballotKey: ctx.key.ballot(1), readings: [{ ...sub.readings[0] }] };
      await expect(ctx.ledger.submitRecord(bad)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
    });

    it("accepts the committed reviewer signature (Review) as the alternative to quorum", async () => {
      // The committed review is over ballot 1 of the vector election; the election `key` has quorum 1, so the
      // reviewer path is visible through the `reviewed` flag.
      const rv = ctx.vec.eip712.review;
      const base = await buildSubmission(ctx, 1, rv.input.results, { readers: [ctx.wallets.device1] });
      expect(base.results).to.equal("V:c1|V:c1");
      const withVectorReview = { ...toStruct(base), reviewer: ctx.wallets.reviewer.address, reviewerSig: rv.signatureReviewer };
      await expect(ctx.ledger.submitRecord(withVectorReview)).to.emit(ctx.ledger, "BallotAccepted").withArgs(key, ctx.key.ballot(1), "V:c1|V:c1", base.imageSha256, base.recordSha256, true);
      expect((await rec(1)).reviewed).to.equal(true);
    });
  });

  describe("submitRecord", () => {
    it("accepts a single-device record at quorum 1 and stores results and image hash", async () => {
      const sub = await buildSubmission(ctx, 0, R);
      await expect(submit(sub)).to.emit(ctx.ledger, "BallotAccepted");
      const r = await rec(0);
      expect(r.results).to.equal("V:c1|V:c2");
      expect(r.imageSha256).to.equal(sub.imageSha256);
      expect(r.reviewed).to.equal(false);
      expect(r.acceptedAt).to.be.gt(0);
      expect(await ctx.ledger.recordCount(key)).to.equal(1);
    });

    it("needs `quorum` distinct matching device signatures when quorum is 2", async () => {
      const k2 = await openElection(ctx, { code: "BEINGS-2026-QRM2XX", quorum: 2 });
      // signatures bind the election key, so build the readings with the other election's code
      const ctx2 = { ...ctx, vec: { ...ctx.vec, codes: { ...ctx.vec.codes, electionCode: "BEINGS-2026-QRM2XX" } } };
      const one = await buildSubmission(ctx2, 0, R, { readers: [ctx.wallets.device1] });
      await expect(submit(one)).to.be.revertedWithCustomError(ctx.ledger, "QuorumNotMet").withArgs(1, 2);
      const two = await buildSubmission(ctx2, 0, R, { readers: [ctx.wallets.device1, ctx.wallets.device2] });
      await expect(submit(two)).to.emit(ctx.ledger, "BallotAccepted");
    });

    it("rejects: duplicate device, non-device signer, wrong signer, tampered results, image mismatch, no readings", async () => {
      const good = await buildSubmission(ctx, 0, R, { readers: [ctx.wallets.device1] });

      const dup = await buildSubmission(ctx, 0, R, { readers: [ctx.wallets.device1, ctx.wallets.device1] });
      await expect(submit(dup)).to.be.revertedWithCustomError(ctx.ledger, "DuplicateDevice");

      const stranger = ethers.Wallet.createRandom();
      const notDevice = await buildSubmission(ctx, 0, R, { readers: [stranger] });
      await expect(submit(notDevice)).to.be.revertedWithCustomError(ctx.ledger, "NotADevice");

      const wrongSigner = toStruct(good);
      wrongSigner.readings = [{ ...good.readings[0], device: ctx.wallets.device2.address }];
      await expect(ctx.ledger.submitRecord(wrongSigner)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");

      const tampered = { ...toStruct(good), results: "V:c2|V:c2" };
      await expect(ctx.ledger.submitRecord(tampered)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");

      const otherImage = { ...toStruct(good), imageSha256: ethers.id("different image") };
      await expect(ctx.ledger.submitRecord(otherImage)).to.be.revertedWithCustomError(ctx.ledger, "ImageHashMismatch");

      await expect(ctx.ledger.submitRecord({ ...toStruct(good), readings: [] })).to.be.revertedWithCustomError(ctx.ledger, "NoReadings");
      await expect(ctx.ledger.submitRecord({ ...toStruct(good), results: "" })).to.be.revertedWithCustomError(ctx.ledger, "EmptyResults");

      const shortSig = toStruct(good);
      shortSig.readings = [{ ...good.readings[0], sig: "0x1234" }];
      await expect(ctx.ledger.submitRecord(shortSig)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");

      // high-s (malleable) form of a valid signature is refused
      const sig = ethers.Signature.from(good.readings[0].sig);
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = ethers.concat([sig.r, ethers.toBeHex(N - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
      const malleable = toStruct(good);
      malleable.readings = [{ ...good.readings[0], sig: highS }];
      await expect(ctx.ledger.submitRecord(malleable)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
    });

    it("rejects a duplicate ballot, a replay, and signatures from another election, chain domain or contract", async () => {
      const sub = await buildSubmission(ctx, 0, R);
      await submit(sub);
      await expect(submit(sub)).to.be.revertedWithCustomError(ctx.ledger, "AlreadyRecorded");

      const wrongContract = await buildSubmission({ ...ctx, domain: ctx.core.eip712Domain({ chainId: 114, verifyingContract: ctx.addresses.tally }) }, 1, R);
      await expect(submit(wrongContract)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
      const wrongChain = await buildSubmission({ ...ctx, domain: ctx.core.eip712Domain({ chainId: 1, verifyingContract: ctx.addresses.ledger }) }, 1, R);
      await expect(submit(wrongChain)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
    });

    it("enforces the election status and the printed-ballot cap", async () => {
      const closedKey = await createElection(ctx, { code: "BEINGS-2026-SETP11" });
      await expect(ctx.ledger.submitRecord({ ...toStruct(await buildSubmission(ctx, 0, R)), electionKey: closedKey })).to.be.revertedWithCustomError(ctx.ledger, "ElectionNotOpen");

      const k = await openElection(ctx, { code: "BEINGS-2026-CAPPED", ballotCount: 1 });
      const ctxC = { ...ctx, vec: { ...ctx.vec, codes: { ...ctx.vec.codes, electionCode: "BEINGS-2026-CAPPED" } } };
      await submit(await buildSubmission(ctxC, 0, R));
      await expect(submit(await buildSubmission(ctxC, 1, R))).to.be.revertedWithCustomError(ctx.ledger, "BallotCapReached");

      await ctx.registry.connect(ctx.organizer).closeElection(key);
      await expect(submit(await buildSubmission(ctx, 0, R))).to.be.revertedWithCustomError(ctx.ledger, "ElectionNotOpen");
    });

    it("rejects a reviewer who is not registered or whose signature is wrong", async () => {
      const notReviewer = await buildSubmission(ctx, 0, R, { reviewer: ctx.wallets.device2 });
      await expect(submit(notReviewer)).to.be.revertedWithCustomError(ctx.ledger, "NotAReviewer");

      const good = await buildSubmission(ctx, 0, R, { reviewer: ctx.wallets.reviewer });
      const wrongResults = await buildSubmission(ctx, 0, { q1: "V:c3", q2: "V:c2" }, { reviewer: ctx.wallets.reviewer });
      await expect(ctx.ledger.submitRecord({ ...toStruct(good), reviewerSig: wrongResults.reviewerSig })).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
      await expect(submit(good)).to.emit(ctx.ledger, "BallotAccepted").withArgs(key, ctx.key.ballot(0), "V:c1|V:c2", good.imageSha256, good.recordSha256, true);
    });
  });

  describe("submitBatch", () => {
    it("records many in one transaction", async () => {
      const subs = [];
      for (let i = 0; i < 4; i++) subs.push(toStruct(await buildSubmission(ctx, i, R)));
      await ctx.ledger.connect(ctx.outsider).submitBatch(subs);
      expect(await ctx.ledger.recordCount(key)).to.equal(4);
    });

    it("is all-or-nothing", async () => {
      const good = toStruct(await buildSubmission(ctx, 0, R));
      const bad = toStruct(await buildSubmission(ctx, 1, R));
      bad.results = "V:c3|V:c3";
      await expect(ctx.ledger.submitBatch([good, bad])).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
      expect(await ctx.ledger.recordCount(key)).to.equal(0);
    });
  });

  describe("markSpoiled", () => {
    it("lets organizer or reviewer spoil an unrecorded ballot, once; it can then never be recorded", async () => {
      const k = ctx.key.ballot(2);
      await expect(ctx.ledger.connect(ctx.outsider).markSpoiled(key, k, ZERO32)).to.be.revertedWithCustomError(ctx.ledger, "NotOrganizerOrReviewer");
      await expect(ctx.ledger.connect(ctx.organizer).markSpoiled(key, k, ctx.key.ballot(3)))
        .to.emit(ctx.ledger, "BallotSpoiled")
        .withArgs(key, k, ctx.key.ballot(3));
      expect(await ctx.ledger.spoiled(key, k)).to.equal(true);
      expect(await ctx.ledger.spoiledCount(key)).to.equal(1);
      await expect(ctx.ledger.connect(ctx.organizer).markSpoiled(key, k, ZERO32)).to.be.revertedWithCustomError(ctx.ledger, "BallotSpoiledAlready");
      await expect(submit(await buildSubmission(ctx, 2, R))).to.be.revertedWithCustomError(ctx.ledger, "BallotSpoiledAlready");
      await ctx.ledger.connect(ctx.wallets.reviewer).markSpoiled(key, ctx.key.ballot(4), ZERO32);
      expect(await ctx.ledger.spoiledCount(key)).to.equal(2);
    });

    it("cannot spoil a recorded ballot or name itself as the replacement", async () => {
      await submit(await buildSubmission(ctx, 0, R));
      await expect(ctx.ledger.connect(ctx.organizer).markSpoiled(key, ctx.key.ballot(0), ZERO32)).to.be.revertedWithCustomError(ctx.ledger, "AlreadyRecorded");
      await expect(ctx.ledger.connect(ctx.organizer).markSpoiled(key, ctx.key.ballot(1), ctx.key.ballot(1))).to.be.revertedWithCustomError(ctx.ledger, "BadCorrection");
    });
  });

  describe("postCorrection", () => {
    beforeEach(async () => {
      await submit(await buildSubmission(ctx, 1, { q1: "U", q2: "V:c1" }, { reviewer: ctx.wallets.reviewer }));
    });
    const post = (c, from = ctx.wallets.reviewer) => ctx.ledger.connect(from).postCorrection(key, c);

    it("chains the vector corrections (U -> V:c2 -> V:c1) with 1-based indexes", async () => {
      const [c1, c2] = ctx.vec.tally.corrections;
      expect(c1.prevIndex).to.equal(0);
      expect(c2.prevIndex).to.equal(1);
      await expect(post(correction(ctx, 1, { prevIndex: 0, fromResult: c1.from, toResult: c1.to, reason: REASON[c1.reason] })))
        .to.emit(ctx.ledger, "CorrectionPosted")
        .withArgs(key, ctx.key.ballot(1), 1, 0, 0, "U", "V:c2", REASON["faint-mark"], ZERO32);
      expect(await ctx.ledger.head(key, ctx.key.ballot(1), 0)).to.equal(1);
      await post(correction(ctx, 1, { prevIndex: 1, fromResult: c2.from, toResult: c2.to, reason: REASON[c2.reason] }));
      expect(await ctx.ledger.head(key, ctx.key.ballot(1), 0)).to.equal(2);
      expect(await ctx.ledger.correctionCount(key)).to.equal(2);
      const stored = await ctx.ledger.corrections(key, 1);
      expect(stored.toResult).to.equal("V:c1");
      expect(stored[8]).to.be.gt(0); // `at` is stamped by the contract
      // the original record is untouched
      expect((await ctx.ledger.records(key, ctx.key.ballot(1))).results).to.equal("U|V:c1");
    });

    it("allows the organizer too, but nobody else", async () => {
      await post(correction(ctx, 1, { by: ctx.organizer.address }), ctx.organizer);
      await expect(post(correction(ctx, 1, { prevIndex: 1, fromResult: "V:c2", toResult: "B", by: ctx.outsider.address }), ctx.outsider)).to.be.revertedWithCustomError(ctx.ledger, "NotOrganizerOrReviewer");
    });

    it("requires `by` to be the sender, a known ballot, the right prevIndex and fromResult", async () => {
      await expect(post(correction(ctx, 1, { by: ctx.outsider.address }))).to.be.revertedWithCustomError(ctx.ledger, "NotCorrectionAuthor");
      await expect(post(correction(ctx, 3))).to.be.revertedWithCustomError(ctx.ledger, "UnknownBallot");
      await expect(post(correction(ctx, 1, { prevIndex: 1 }))).to.be.revertedWithCustomError(ctx.ledger, "WrongPrevIndex").withArgs(0, 1);
      await expect(post(correction(ctx, 1, { fromResult: "B" }))).to.be.revertedWithCustomError(ctx.ledger, "WrongFromResult");
      // question 1 (second segment) has its own chain
      await expect(post(correction(ctx, 1, { questionIndex: 1, fromResult: "V:c1", toResult: "V:c2" }))).to.emit(ctx.ledger, "CorrectionPosted");
      await expect(post(correction(ctx, 1, { questionIndex: 2, fromResult: "x", toResult: "y" }))).to.be.revertedWithCustomError(ctx.ledger, "WrongFromResult");
      // second correction of q0 must start from the previous toResult
      await post(correction(ctx, 1));
      await expect(post(correction(ctx, 1, { prevIndex: 2, fromResult: "U", toResult: "V:c1" }))).to.be.revertedWithCustomError(ctx.ledger, "WrongFromResult");
    });

    it("rejects no-op corrections and a missing reason", async () => {
      await expect(post(correction(ctx, 1, { toResult: "U" }))).to.be.revertedWithCustomError(ctx.ledger, "BadCorrection");
      await expect(post(correction(ctx, 1, { toResult: "" }))).to.be.revertedWithCustomError(ctx.ledger, "BadCorrection");
      await expect(post(correction(ctx, 1, { reason: REASON.None }))).to.be.revertedWithCustomError(ctx.ledger, "BadCorrection");
    });

    it("is refused in Setup and still allowed after the election is closed", async () => {
      await ctx.registry.connect(ctx.organizer).closeElection(key);
      await expect(post(correction(ctx, 1))).to.emit(ctx.ledger, "CorrectionPosted");
      const setupKey = await createElection(ctx, { code: "BEINGS-2026-SETP22" });
      await expect(ctx.ledger.connect(ctx.organizer).postCorrection(setupKey, correction(ctx, 1, { by: ctx.organizer.address }))).to.be.revertedWithCustomError(ctx.ledger, "ElectionNotOpen");
    });
  });
});
