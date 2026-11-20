// Cross-checks of the Solidity code against the committed @beings/core test vectors: Merkle roots and proofs,
// reconciliation bit masks, and the results-string splitter.
const { expect } = require("chai");
const { ethers, loadCore, readVector } = require("./helpers");

describe("core test vectors vs Solidity", () => {
  let h, core;
  before(async () => {
    core = await loadCore();
    h = await (await ethers.getContractFactory("ReconcileHarness")).deploy();
  });

  describe("Merkle (OpenZeppelin-compatible sorted pairs)", () => {
    const sets = readVector("merkle").sets;
    it("every committed proof verifies against its committed root on-chain", async () => {
      let checked = 0;
      for (const set of sets) {
        for (const p of set.proofs) {
          expect(await h.verifyMerkle(p.proof, set.root, p.leaf), `n=${set.leaves.length}`).to.equal(true);
          checked++;
        }
      }
      expect(checked).to.be.gt(15);
    });

    it("a proof does not verify another leaf or another root", async () => {
      const set = sets.find((s) => s.leaves.length === 8);
      const [a, b] = set.proofs;
      expect(await h.verifyMerkle(a.proof, set.root, b.leaf)).to.equal(false);
      expect(await h.verifyMerkle(a.proof, sets.find((s) => s.leaves.length === 5).root, a.leaf)).to.equal(false);
    });

    it("a single-leaf tree has the leaf as its root and an empty proof; the empty root is zero", async () => {
      const one = sets.find((s) => s.leaves.length === 1);
      expect(one.root).to.equal(one.leaves[0]);
      expect(await h.verifyMerkle([], one.root, one.leaves[0])).to.equal(true);
      expect(sets.find((s) => s.leaves.length === 0).root).to.equal("0x" + "00".repeat(32));
    });
  });

  describe("reconciliation bit mask (R1=1 .. R6=32)", () => {
    const cases = readVector("reconcile");
    const toStruct = (c) => ({
      registered: c.organizer.registered,
      printed: c.ledger.printed,
      issued: c.organizer.issued,
      cast: c.ledger.cast,
      spoiled: c.ledger.spoiled,
      unusedReturned: c.organizer.unusedReturned,
      unissued: c.counts.unissued,
    });
    const perQ = (c) => Object.keys(c.ledger.perQuestion).sort().map((q) => c.ledger.perQuestion[q]);

    for (const c of cases) {
      it(`${c.name} -> mask ${c.failedChecks}`, async () => {
        expect(await h.failedChecks(toStruct(c), c.ledger.registeredInElectionFile, perQ(c))).to.equal(c.failedChecks);
        expect(await h.unissued(c.ledger.printed, c.organizer.issued)).to.equal(c.counts.unissued);
      });
    }

    it("covers every rule at least once across the vectors", () => {
      const seen = cases.reduce((m, c) => m | c.failedChecks, 0);
      expect(seen).to.equal(63);
    });

    it("never underflows: spoiled > issued and printed < issued", async () => {
      const r = { registered: 5, printed: 1, issued: 2, cast: 0, spoiled: 9, unusedReturned: 0, unissued: 0 };
      const mask = await h.failedChecks(r, 5, [{ valid: 0, blank: 0, overvote: 0, unclear: 0 }]);
      expect(Number(mask) & 4).to.equal(4); // R3
      expect(await h.unissued(1, 2)).to.equal(0);
    });
  });

  describe("results string", () => {
    it("splits on | and compares segments by hash", async () => {
      const [found, hash] = await h.segmentHash("V:c1|U|B", 1);
      expect(found).to.equal(true);
      expect(hash).to.equal(ethers.id("U"));
      expect((await h.segmentHash("V:c1|U|B", 2))[1]).to.equal(ethers.id("B"));
      expect((await h.segmentHash("V:c1|U|B", 0))[1]).to.equal(ethers.id("V:c1"));
      expect((await h.segmentHash("V:c1|U|B", 3))[0]).to.equal(false);
      expect((await h.segmentHash("", 0))[0]).to.equal(false);
    });

    it("agrees with the core encoder for the committed vectors", async () => {
      const enc = readVector("results").encoded;
      for (const e of enc) {
        const parts = e.encoded.split("|");
        for (let i = 0; i < parts.length; i++) {
          expect((await h.segmentHash(e.encoded, i))[1]).to.equal(ethers.id(parts[i]));
        }
        expect(ethers.id(e.encoded)).to.equal(e.hash);
      }
    });
  });
});
