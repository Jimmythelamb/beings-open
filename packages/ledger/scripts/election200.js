// A 200-ballot test election on the deployed contracts.
//
//   npx hardhat run scripts/election200.js                     # dry run on the in-process network (fresh contracts)
//   npx hardhat run scripts/election200.js --network coston2   # SENDS REAL (test-network) TRANSACTIONS, about 25 C2FLR
//
// Environment (all optional): ELECTION200_SEED (default 20261101), ELECTION200_BUDGET (C2FLR, default 60).
// The deployer key comes from the environment only (.env). The throw-away "device" is generated in memory, only signs
// off-chain, and is never printed or saved. The output file has no keys: deployments/<network>-election200.json
//
// Flow: create (3 questions: yes/no, one-of-four, approve-up-to-2-of-5) -> register device -> open -> submit 200 ballots
// (20 single submitRecord, the rest in submitBatch of 5, 10, 20 and 30) -> mark 3 ballots spoiled -> close ->
// tally and reconcile off-chain with @beings/core -> postTally -> independently re-read every record from the chain,
// recompute tally, reconciliation and Merkle root, compare with what the Tally contract stored, check inclusion proofs.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { deployAll } = require("./lib/deploy-lib");

const SEED = Number(process.env.ELECTION200_SEED || 20261101);
const BUDGET = ethers.parseEther(process.env.ELECTION200_BUDGET || "60");
const N_CAST = 200;
const N_SPARE = 10; // printed = 210
const N_SPOILED = 3;
const SINGLES = 20;
const BATCH_PLAN = [5, 5, 5, 5, 10, 10, 10, 10, 20, 20, 20, 30, 30]; // 20 + 40 + 60 + 60 = 180
if (SINGLES + BATCH_PLAN.reduce((a, b) => a + b, 0) !== N_CAST) throw new Error("batch plan must cover 200 ballots");

// conservative per-call gas for the up-front estimate (measured: single ~150-167k, per batched record ~132k)
const EST = { createElection: 200_000, registerDevice: 75_000, openElection: 35_000, single: 180_000, batched: 150_000, markSpoiled: 90_000, closeElection: 30_000, postTally: 450_000 };

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const rngBytes = (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
const pickWeighted = (weights) => {
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i;
  return weights.length - 1;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const QUESTIONS = [
  { id: "q1", text: "Adopt the proposed bylaw change?", maxMarks: 1, choices: [{ id: "c1", text: "Yes" }, { id: "c2", text: "No" }], weights: [56, 44] },
  { id: "q2", text: "Choose one candidate for chair.", maxMarks: 1, choices: ["Avery", "Blake", "Casey", "Drew"].map((t, i) => ({ id: `c${i + 1}`, text: t })), weights: [35, 30, 20, 15] },
  { id: "q3", text: "Approve up to two of five projects.", maxMarks: 2, choices: ["Park", "Library", "Bridge", "Pool", "Bus"].map((t, i) => ({ id: `c${i + 1}`, text: t })), weights: [30, 25, 20, 15, 10] },
];
const QORDER = QUESTIONS.map((q) => q.id);
const STATE_WEIGHTS = [86, 8, 3.5, 2.5]; // V, B, O, U

/** One question's result string and plausible fill scores. */
function drawQuestion(q) {
  const s = pickWeighted(STATE_WEIGHTS);
  const scores = Object.fromEntries(q.choices.map((c) => [c.id, int(0, 6)]));
  const chooseDistinct = (k) => {
    const pool = q.choices.map((c, i) => ({ id: c.id, w: q.weights[i] }));
    const out = [];
    while (out.length < k) {
      const i = pickWeighted(pool.map((p) => p.w));
      out.push(pool[i].id);
      pool.splice(i, 1);
    }
    return out.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  };
  if (s === 0) {
    const k = q.maxMarks === 2 ? (rand() < 0.3 ? 1 : 2) : 1;
    const ch = chooseDistinct(k);
    for (const c of ch) scores[c] = int(86, 98);
    return { result: `V:${ch.join("+")}`, scores };
  }
  if (s === 1) return { result: "B", scores };
  if (s === 2) {
    for (const c of chooseDistinct(q.maxMarks + 1 > q.choices.length ? q.choices.length : q.maxMarks + 1)) scores[c] = int(86, 98);
    return { result: "O", scores };
  }
  scores[chooseDistinct(1)[0]] = int(40, 60);
  return { result: "U", scores };
}

const fmt = (w) => ethers.formatEther(w);
const sec = (ms) => Math.round(ms / 100) / 10;

async function main() {
  const t0 = Date.now();
  const net = hre.network.name;
  if (net !== "hardhat" && net !== "coston2") throw new Error(`Unexpected network ${net}`);
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account (set DEPLOYER_PRIVATE_KEY in packages/ledger/.env). Nothing was sent.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 114n) throw new Error(`Expected chain ID 114, got ${chainId}. Nothing was sent.`);
  const core = await import("@beings/core");

  let c, addresses;
  if (net === "hardhat") {
    const d = await deployAll(ethers, admin);
    c = { ledger: d.ledger, registry: d.registry, tally: d.tally };
    addresses = d.addresses;
  } else {
    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "coston2.json"), "utf8"));
    const at = async (name, addr) => (await ethers.getContractFactory(name, admin)).attach(addr);
    c = { ledger: await at("BallotLedger", dep.contracts.BallotLedger), registry: await at("ElectionRegistry", dep.contracts.ElectionRegistry), tally: await at("Tally", dep.contracts.Tally) };
    addresses = { ledger: dep.contracts.BallotLedger, registry: dep.contracts.ElectionRegistry, tally: dep.contracts.Tally };
  }
  const ledgerAddr = await c.ledger.getAddress();

  // ---- cost estimate and abort check (before anything is sent) ----
  const startBalance = await ethers.provider.getBalance(admin.address);
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  const nBatched = N_CAST - SINGLES;
  const estGas = EST.createElection + EST.registerDevice + EST.openElection + SINGLES * EST.single + nBatched * EST.batched + N_SPOILED * EST.markSpoiled + EST.closeElection + EST.postTally;
  const estCost = BigInt(estGas) * gasPrice;
  const worstCost = (estCost * 13n) / 10n; // +30% price margin
  console.log(`Estimate: ${estGas.toLocaleString("en-US")} gas x ${gasPrice / 1000000000n} gwei = ${fmt(estCost)} C2FLR (with +30% margin ${fmt(worstCost)}); budget ${fmt(BUDGET)}; balance ${fmt(startBalance)}`);
  if (worstCost > BUDGET) throw new Error(`Estimated cost ${fmt(worstCost)} exceeds the budget ${fmt(BUDGET)} C2FLR. Nothing was sent.`);
  if (worstCost > startBalance) throw new Error(`Estimated cost ${fmt(worstCost)} exceeds the balance ${fmt(startBalance)}. Nothing was sent.`);
  const blockGasLimit = (await ethers.provider.getBlock("latest")).gasLimit;

  // ---- election data (seeded) ----
  const electionCode = core.newElectionCode(2026);
  const eKey = core.electionKey(electionCode);
  const allCodes = core.newBallotCodes(N_CAST + N_SPARE, rngBytes);
  const castCodes = allCodes.slice(0, N_CAST);
  const spoilCodes = allCodes.slice(N_CAST, N_CAST + N_SPOILED); // spares that were spoiled and replaced (replacements = the cast ballots)
  const listRoot = core.ballotListRoot(allCodes);
  const electionFile = { electionCode, title: "Test election, 200 ballots", questions: QUESTIONS.map(({ weights, ...q }) => q), ballotListRoot: listRoot };
  const fileSha = "0x" + core.sha256Json(electionFile);
  const election = { questions: electionFile.questions };

  const device = ethers.Wallet.createRandom(); // signs off-chain only; never printed or saved
  const domain = core.eip712Domain({ chainId: 114, verifyingContract: ledgerAddr });
  const entries = []; // what the organizer expects: LedgerEntry per cast ballot
  const subs = [];
  for (let i = 0; i < N_CAST; i++) {
    const results = {};
    const fillScores = {};
    for (const q of QUESTIONS) {
      const d = drawQuestion(q);
      results[q.id] = d.result;
      fillScores[q.id] = d.scores;
    }
    const imageSha256 = core.sha256Hex(`election200-image-${electionCode}-${i}`);
    const recordSha256 = core.sha256Hex(`election200-record-${electionCode}-${i}`);
    const ballotCode = castCodes[i];
    entries.push({ electionCode, ballotCode, results, imageSha256, recordSha256, reviewed: false });
    const input = { electionCode, ballotCode, results, imageSha256, fillScores, questionOrder: QORDER };
    subs.push({
      electionKey: eKey,
      ballotKey: core.ballotKey(ballotCode),
      results: core.encodeResults(results, QORDER),
      imageSha256: "0x" + imageSha256,
      recordSha256: "0x" + recordSha256,
      readings: [{ device: device.address, imageSha256: "0x" + imageSha256, scoresHash: core.scoresHash(fillScores), sig: await core.signReading(device, input, domain) }],
      reviewer: ethers.ZeroAddress,
      reviewerSig: "0x",
    });
  }

  // ---- send helper with running cost guard ----
  const steps = [];
  let spent = 0n;
  const send = async (name, txPromise, extra = {}) => {
    const t = Date.now();
    const tx = await txPromise;
    const rc = await tx.wait();
    const price = rc.gasPrice ?? tx.gasPrice;
    const fee = rc.gasUsed * price;
    spent += fee;
    steps.push({ step: name, txHash: tx.hash, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), gasPriceWei: price.toString(), feeWei: fee.toString(), fee: fmt(fee), seconds: sec(Date.now() - t), ...extra });
    if (spent > BUDGET) throw new Error(`Budget exceeded after ${name}: spent ${fmt(spent)} > ${fmt(BUDGET)}. Stopping.`);
    return rc;
  };
  const phase = {};
  const timed = async (name, fn) => {
    const t = Date.now();
    await fn();
    phase[name] = sec(Date.now() - t);
    console.log(`${name}: ${phase[name]} s, spent so far ${fmt(spent)} C2FLR`);
  };

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await timed("setup (create, register device, open)", async () => {
    await send("ElectionRegistry.createElection", c.registry.createElection(electionCode, "bafy-election200-election-file", fileSha, N_CAST + N_SPARE, N_CAST, 1, now - 120, now + 6 * 3600, listRoot));
    await send("ElectionRegistry.registerDevice", c.registry.registerDevice(eKey, device.address, ethers.id("election200-app")));
    await send("ElectionRegistry.openElection", c.registry.openElection(eKey));
  });

  // gas check for the biggest batch against the block gas limit
  const biggest = Math.max(...BATCH_PLAN);
  const bigEst = await c.ledger.submitBatch.estimateGas(subs.slice(SINGLES, SINGLES + biggest));
  console.log(`Largest batch (${biggest}) estimateGas ${bigEst} vs block gas limit ${blockGasLimit}`);
  if (bigEst * 2n > blockGasLimit) throw new Error("largest batch is above half the block gas limit; reduce BATCH_PLAN");

  await timed(`submit ${SINGLES} single records`, async () => {
    for (let i = 0; i < SINGLES; i++) await send("BallotLedger.submitRecord", c.ledger.submitRecord(subs[i]), { records: 1 });
  });
  let cursor = SINGLES;
  await timed(`submit ${N_CAST - SINGLES} records in batches`, async () => {
    for (const size of BATCH_PLAN) {
      await send("BallotLedger.submitBatch", c.ledger.submitBatch(subs.slice(cursor, cursor + size)), { records: size });
      cursor += size;
    }
  });

  await timed(`mark ${N_SPOILED} spoiled, close`, async () => {
    for (const code of spoilCodes) await send("BallotLedger.markSpoiled", c.ledger.markSpoiled(eKey, core.ballotKey(code), ethers.ZeroHash));
    await send("ElectionRegistry.closeElection", c.registry.closeElection(eKey));
  });

  // ---- off-chain tally and reconciliation (organizer side, from what was submitted) ----
  const registered = N_CAST;
  const issued = N_CAST + N_SPOILED; // every spoiled ballot was replaced by a cast one
  const unusedReturned = 0;
  const tally = core.tallyQuestions(entries, [], { election });
  const rec = core.reconcile(
    { registered, issued, unusedReturned },
    { registeredInElectionFile: N_CAST, printed: N_CAST + N_SPARE, cast: N_CAST, spoiled: N_SPOILED, perQuestion: tally, expectedQuestions: QORDER },
  );
  const leaves = entries.map((e) => core.entryLeaf(e));
  const root = core.merkleRoot(leaves);
  const perQ = QORDER.map((q) => ({ valid: tally[q].valid, blank: tally[q].blank, overvote: tally[q].overvote, unclear: tally[q].unclear }));
  console.log("Off-chain reconcile: failedChecks", rec.failedChecks, "root", root);

  await timed("post tally", async () => {
    await send("Tally.postTally (3 questions)", c.tally.postTally(eKey, root, perQ, registered, issued, unusedReturned, "bafy-election200-results", "0x" + core.sha256Json({ tally, root })));
  });

  // ---- independent re-read from the chain ----
  const verification = {};
  await timed("independent verification (reads only)", async () => {
    const onEntries = [];
    for (let s = 0; s < allCodes.length; s += 25) {
      const chunk = allCodes.slice(s, s + 25);
      const got = await Promise.all(chunk.map(async (code) => {
        const bk = core.ballotKey(code);
        const [r, sp] = await Promise.all([c.ledger.records(eKey, bk), c.ledger.spoiled(eKey, bk)]);
        return { code, r, sp };
      }));
      for (const { code, r, sp } of got) {
        if (r.acceptedAt > 0n) {
          onEntries.push({ electionCode, ballotCode: code, results: core.decodeResults(r.results, QORDER), imageSha256: r.imageSha256.slice(2), recordSha256: r.recordSha256.slice(2), reviewed: r.reviewed });
        } else if (!sp) continue;
      }
    }
    const cast = Number(await c.ledger.recordCount(eKey));
    const spoiledN = Number(await c.ledger.spoiledCount(eKey));
    const corrections = Number(await c.ledger.correctionCount(eKey));
    const reTally = core.tallyQuestions(onEntries, [], { election });
    const reLeaves = onEntries.map((e) => core.entryLeaf(e));
    const reRoot = core.merkleRoot(reLeaves);
    const reRec = core.reconcile({ registered, issued, unusedReturned }, { registeredInElectionFile: N_CAST, printed: N_CAST + N_SPARE, cast, spoiled: spoiledN, perQuestion: reTally, expectedQuestions: QORDER });
    const res = await c.tally.getResult(eKey, 1);
    const stored = [];
    for (let q = 0; q < QORDER.length; q++) {
      const t = await c.tally.perQuestion(eKey, 1, q);
      stored.push({ valid: Number(t.valid), blank: Number(t.blank), overvote: Number(t.overvote), unclear: Number(t.unclear) });
    }
    const expectPerQ = QORDER.map((q) => ({ valid: reTally[q].valid, blank: reTally[q].blank, overvote: reTally[q].overvote, unclear: reTally[q].unclear }));
    // inclusion proofs: first, last and 5 random leaves
    const picks = [0, reLeaves.length - 1, ...Array.from({ length: 5 }, () => int(1, reLeaves.length - 2))];
    const proofs = [];
    for (const i of picks) {
      const ok = await c.tally.verifyInclusion(eKey, 1, reLeaves[i], core.merkleProof(reLeaves, reLeaves[i]));
      proofs.push({ ballotCode: onEntries[i].ballotCode, leaf: reLeaves[i], onChainVerified: ok });
    }
    const negative = await c.tally.verifyInclusion(eKey, 1, ethers.id("not a ballot"), core.merkleProof(reLeaves, reLeaves[0]));
    Object.assign(verification, {
      recordsOnChain: cast,
      spoiledOnChain: spoiledN,
      correctionsOnChain: corrections,
      recordsReadBack: onEntries.length,
      tallyRecomputedMatchesStored: JSON.stringify(expectPerQ) === JSON.stringify(stored),
      tallyRecomputedMatchesOrganizer: JSON.stringify(expectPerQ) === JSON.stringify(perQ),
      merkleRootRecomputed: reRoot,
      merkleRootStored: res.merkleRoot,
      merkleRootMatches: reRoot === res.merkleRoot && reRoot === root,
      reconciliationRecomputedFailedChecks: reRec.failedChecks,
      reconciliationStoredFailedChecks: Number(res.failedChecks),
      reconciliationMatches: reRec.failedChecks === Number(res.failedChecks),
      storedRecon: { registered: Number(res.recon.registered), printed: Number(res.recon.printed), issued: Number(res.recon.issued), cast: Number(res.recon.cast), spoiled: Number(res.recon.spoiled), unusedReturned: Number(res.recon.unusedReturned), unissued: Number(res.recon.unissued) },
      isFinal: await c.tally.isFinal(eKey),
      finality: Number(res.finality) === 1 ? "Final" : "Provisional",
      inclusionProofs: proofs,
      inclusionProofsAllOk: proofs.every((p) => p.onChainVerified),
      wrongLeafRejected: negative === false,
    });
  });

  // ---- results ----
  const group = (pred) => steps.filter(pred);
  const sum = (a, k) => a.reduce((s, x) => s + Number(x[k]), 0);
  const singles = group((s) => s.step === "BallotLedger.submitRecord");
  const batches = group((s) => s.step === "BallotLedger.submitBatch");
  const bySize = {};
  for (const b of batches) (bySize[b.records] ??= []).push(b);
  const perBallot = {
    single: { ballots: singles.length, avgGas: Math.round(sum(singles, "gasUsed") / singles.length), avgFeeC2FLR: fmt(singles.reduce((s, x) => s + BigInt(x.feeWei), 0n) / BigInt(singles.length)) },
    batch: Object.fromEntries(Object.entries(bySize).map(([size, bs]) => {
      const n = bs.length * Number(size);
      const gas = sum(bs, "gasUsed");
      const fee = bs.reduce((s, x) => s + BigInt(x.feeWei), 0n);
      return [size, { batches: bs.length, ballots: n, avgGasPerBallot: Math.round(gas / n), avgFeePerBallotC2FLR: fmt(fee / BigInt(n)) }];
    })),
  };
  const allBatchGas = sum(batches, "gasUsed");
  const allBatchFee = batches.reduce((s, x) => s + BigInt(x.feeWei), 0n);
  perBallot.allBatched = { ballots: N_CAST - SINGLES, avgGasPerBallot: Math.round(allBatchGas / (N_CAST - SINGLES)), avgFeePerBallotC2FLR: fmt(allBatchFee / BigInt(N_CAST - SINGLES)) };
  const endBalance = await ethers.provider.getBalance(admin.address);
  const out = {
    network: net,
    chainId: 114,
    seed: SEED,
    electionCode,
    electionKey: eKey,
    contracts: addresses,
    ballots: { printed: N_CAST + N_SPARE, cast: N_CAST, spoiled: N_SPOILED, ballotListRoot: listRoot },
    questions: electionFile.questions.map((q) => ({ id: q.id, text: q.text, maxMarks: q.maxMarks, choices: q.choices.map((x) => x.text) })),
    tally: Object.fromEntries(QORDER.map((q) => [q, tally[q]])),
    reconciliation: { organizer: { registered, issued, unusedReturned }, failedChecks: rec.failedChecks, checks: rec.checks, counts: rec.counts },
    merkleRoot: root,
    estimate: { gas: estGas, gasPriceWei: gasPrice.toString(), costC2FLR: fmt(estCost), withMarginC2FLR: fmt(worstCost), budgetC2FLR: fmt(BUDGET) },
    verification,
    perBallotCost: perBallot,
    phasesSeconds: phase,
    totals: { transactions: steps.length, gas: sum(steps, "gasUsed"), feeC2FLR: fmt(spent), elapsedSeconds: sec(Date.now() - t0) },
    balanceBeforeC2FLR: fmt(startBalance),
    balanceAfterC2FLR: fmt(endBalance),
    steps,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}-election200.json`), JSON.stringify(out, null, 2) + "\n");

  console.log(JSON.stringify({ electionCode, tally: out.tally && Object.fromEntries(QORDER.map((q) => [q, [tally[q].valid, tally[q].blank, tally[q].overvote, tally[q].unclear]])), failedChecks: rec.failedChecks, finality: verification.finality, totals: out.totals, perBallot: out.perBallotCost, balanceAfter: out.balanceAfterC2FLR }, null, 1));
  const ok = verification.tallyRecomputedMatchesStored && verification.merkleRootMatches && verification.reconciliationMatches && verification.inclusionProofsAllOk && verification.wrongLeafRejected && verification.recordsReadBack === N_CAST;
  if (!ok) throw new Error("Verification mismatch, see " + `deployments/${net}-election200.json`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
