const { expect } = require("chai");
const { ethers, setup, snapshotHooks, ZERO32 } = require("./helpers");

describe("VerifierRegistry", () => {
  let ctx, v, node, eKey;
  before(async () => {
    ctx = await setup();
    v = ctx.verifierRegistry;
    node = ctx.wallets.node;
    eKey = ctx.vec.codes.electionKey;
  });
  snapshotHooks();

  const args = (o = {}) => ({
    electionKey: eKey,
    tallyVersion: 1,
    reportCid: "bafy-report",
    reportSha256: ethers.id("report"),
    ballotQuestionsChecked: 10,
    ballotQuestionsAgreed: 10,
    tallyMatches: true,
    reconciliationMatches: true,
    merkleMatches: true,
    nonce: 0,
    ...o,
  });
  const direct = (c, a) =>
    c.reportVerification(a.electionKey, a.tallyVersion, a.reportCid, a.reportSha256, a.ballotQuestionsChecked, a.ballotQuestionsAgreed, a.tallyMatches, a.reconciliationMatches, a.merkleMatches);
  const metrics = async () => {
    const m = await v.metrics(eKey);
    return [m.nodeCount, m.nodesAllAgree, m.nodesWithDisagreement, m.ballotQuestionsChecked, m.ballotQuestionsAgreed].map(Number);
  };

  it("registers a node, optionally and permissionlessly, and updates it", async () => {
    await expect(v.connect(ctx.outsider).register("Node A", "bafy-info")).to.emit(v, "NodeRegistered").withArgs(ctx.outsider.address, "Node A", "bafy-info");
    const first = (await v.nodes(ctx.outsider.address)).registeredAt;
    expect(first).to.be.gt(0);
    await v.connect(ctx.outsider).register("Node A2", "bafy-info2");
    const n = await v.nodes(ctx.outsider.address);
    expect(n.name).to.equal("Node A2");
    expect(n.registeredAt).to.equal(first);
  });

  it("anyone can report without registering; metrics count agreement", async () => {
    await expect(direct(v.connect(ctx.outsider), args())).to.emit(v, "VerificationReported").withArgs(eKey, ctx.outsider.address, 1, "bafy-report", args().reportSha256, 10, 10, true, true, true);
    expect(await metrics()).to.deep.equal([1, 1, 0, 10, 10]);
    await direct(v.connect(ctx.organizer), args({ ballotQuestionsAgreed: 9 }));
    expect(await metrics()).to.deep.equal([2, 1, 1, 20, 19]);
    await direct(v.connect(ctx.signers[3]), args({ tallyMatches: false }));
    expect(await metrics()).to.deep.equal([3, 1, 2, 30, 29]);
  });

  it("a node's later report replaces its earlier one in the metrics", async () => {
    await direct(v.connect(ctx.outsider), args({ ballotQuestionsAgreed: 5, merkleMatches: false }));
    expect(await metrics()).to.deep.equal([1, 0, 1, 10, 5]);
    await direct(v.connect(ctx.outsider), args({ tallyVersion: 2 }));
    expect(await metrics()).to.deep.equal([1, 1, 0, 10, 10]);
  });

  it("rejects agreed > checked and tally version 0", async () => {
    await expect(direct(v, args({ ballotQuestionsAgreed: 11 }))).to.be.revertedWithCustomError(v, "AgreedExceedsChecked");
    await expect(direct(v, args({ tallyVersion: 0 }))).to.be.revertedWithCustomError(v, "BadTallyVersion");
  });

  describe("reportVerificationSigned (VerificationNotice, [PROPOSED])", () => {
    const input = (a) => ({
      electionCode: ctx.vec.codes.electionCode,
      tallyVersion: a.tallyVersion,
      reportCid: a.reportCid,
      reportSha256: a.reportSha256,
      ballotQuestionsChecked: a.ballotQuestionsChecked,
      ballotQuestionsAgreed: a.ballotQuestionsAgreed,
      tallyMatches: a.tallyMatches,
      reconciliationMatches: a.reconciliationMatches,
      merkleMatches: a.merkleMatches,
      nonce: a.nonce,
    });
    const sign = (a, wallet = node) => ctx.core.signNotice(wallet, input(a), ctx.noticeDomain);

    it("domain separator and type hash match @beings/core", async () => {
      expect(await v.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(ctx.vec.eip712.notice.domain));
      expect(await v.NOTICE_TYPEHASH()).to.equal(ethers.id(ethers.TypedDataEncoder.from(ctx.core.NOTICE_TYPES).encodeType("VerificationNotice")));
    });

    it("accepts the committed notice signature from the core vector (relayed by a stranger)", async () => {
      const n = ctx.vec.eip712.notice;
      const a = args({ reportCid: n.input.reportCid, reportSha256: "0x" + n.input.reportSha256 });
      expect(ctx.core.noticeDigest(input(a), ctx.noticeDomain)).to.equal(n.digest);
      await expect(v.connect(ctx.outsider).reportVerificationSigned(a, n.signatureNode))
        .to.emit(v, "VerificationReported")
        .withArgs(eKey, node.address, 1, n.input.reportCid, a.reportSha256, 10, 10, true, true, true);
      expect(await v.nonces(node.address)).to.equal(1);
      expect(await metrics()).to.deep.equal([1, 1, 0, 10, 10]);
    });

    it("binds every field: an edited message recovers a different address, never the node", async () => {
      const a = args();
      const sig = await sign(a);
      // The recovered signer for an edited message is a random address whose nonce is 0, so it is not rejected by the
      // signature check. It is therefore attributed to that random address, never to `node`.
      const edited = { ...a, ballotQuestionsAgreed: 9 };
      const tx = await v.reportVerificationSigned(edited, sig);
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => v.interface.parseLog(l)).find((e) => e && e.name === "VerificationReported");
      expect(ev.args.node).to.not.equal(node.address);
      expect(await v.nonces(node.address)).to.equal(0);
    });

    it("rejects a bad signature and enforces the sequential nonce (no replay)", async () => {
      const a = args();
      await expect(v.reportVerificationSigned(a, "0x1234")).to.be.revertedWithCustomError(v, "BadSignature");
      await expect(v.reportVerificationSigned(a, "0x" + "00".repeat(65))).to.be.revertedWithCustomError(v, "BadSignature");
      const sig0 = await sign(a);
      await v.reportVerificationSigned(a, sig0);
      await expect(v.reportVerificationSigned(a, sig0)).to.be.revertedWithCustomError(v, "BadNonce").withArgs(1);

      const a1 = args({ nonce: 1, ballotQuestionsAgreed: 4, tallyVersion: 2 });
      await expect(v.reportVerificationSigned({ ...a1, nonce: 5 }, await sign({ ...a1, nonce: 5 }))).to.be.revertedWithCustomError(v, "BadNonce").withArgs(1);
      await v.reportVerificationSigned(a1, await sign(a1));
      expect(await v.nonces(node.address)).to.equal(2);
      expect(await metrics()).to.deep.equal([1, 0, 1, 10, 4]);
      // the old notice can no longer overwrite the newer one
      await expect(v.reportVerificationSigned(a, sig0)).to.be.revertedWithCustomError(v, "BadNonce").withArgs(2);
    });

    it("a notice signed for another contract is not attributed to the node", async () => {
      const a = args();
      const other = await ctx.core.signNotice(node, input(a), ctx.core.eip712Domain({ chainId: 114, verifyingContract: ctx.addresses.ledger }));
      await v.reportVerificationSigned(a, other);
      expect(await v.nonces(node.address)).to.equal(0);
    });
  });
});
