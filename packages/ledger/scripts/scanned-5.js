// Puts the 5 REAL scanned ballots (pages 1-5 of /workspace/scans/ballot-scan.pdf) on the ledger in a NEW election,
// runs the whole lifecycle, then independently re-reads everything from the chain and compares.
//
//   npx hardhat run scripts/scanned-5.js                     # dry run on the in-process network (fresh contracts)
//   npx hardhat run scripts/scanned-5.js --network coston2   # SENDS REAL (test-network) REDACTED-BALLOT-CODE
//
// How the new election relates to the old one (BEINGS-2026-4CRWX2, closed, 34-ballot list, only page 1 recorded):
//   * The election file is the sample file with the SAME content: title, questions q1-q3, choices, result rules, privacy,
//     layoutHash. Only electionCode (new), ballotCodes (the 5 scanned codes), registeredVoters (5) differ.
//   * The ballots keep the codes printed in their QR (REDACTED-BALLOT-CODE, REDACTED-BALLOT-CODE, REDACTED-BALLOT-CODE, REDACTED-BALLOT-CODE, REDACTED-BALLOT-CODE).
//     The QR also carries the OLD election code; that is only a printed label. The chain keys a ballot by
//     keccak256(ballotCode) inside an election, so the same code can be recorded in a new election. The new election's
//     ballotListRoot is the Merkle root of exactly these 5 codes (registered at createElection), so each code is "listed".
//     The signed reading and the ballot record carry the NEW election code.
//   * Lifecycle: createElection (ballotCount 5) -> registerDevice -> openElection -> submitBatch (5 records, one tx)
//     -> closeElection -> postTally (Final when reconciliation mask is 0).
//
// Inputs: $SCAN_DIR/page{1..5}-result.json (omr.py + omr_finish.mjs, rerun for this election), default /workspace/scans/rerun.
// The deployer key comes from the environment (.env) only; the device key is generated in memory, signs off-chain and is
// never printed or saved. Output (no keys): deployments/<network>-scanned-5.json (+ election file and ballot list copies)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { deployAll } = require("./lib/deploy-lib");

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(__dirname, "..", "..", "ballot-gen", "sample", "output");
const SCAN_DIR = process.env.SCAN_DIR || "/workspace/scans/rerun";
const MAX_FEE = ethers.parseEther(process.env.MAX_FEE || "5"); // abort if the up-front estimate exceeds this (C2FLR)
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const fmt = (w) => ethers.formatEther(w);
const N = 5;

async function main() {
  const net = hre.network.name;
  if (net !== "hardhat" && net !== "coston2") throw new Error(`Unexpected network ${net}`);
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account (set DEPLOYER_PRIVATE_KEY in packages/ledger/.env). Nothing was sent.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 114n) throw new Error(`Expected chain ID 114, got ${chainId}. Nothing was sent.`);
  const core = await import("@beings/core");

  // ---- the 5 scans ----
  const scans = [];
  for (let p = 1; p <= N; p++) {
    const s = readJson(path.join(SCAN_DIR, `page${p}-result.json`));
    if (!s.onBallotList || s.coreValidationProblems.length) throw new Error(`Page ${p} has problems: ${JSON.stringify(s.coreValidationProblems)}. Nothing was sent.`);
    if (s.unclearOvals.length) throw new Error(`Page ${p} has unclear ovals. Nothing was sent.`);
    scans.push({ page: p, ...s });
  }
  const codes = scans.map((s) => s.ballotCode);
  if (new Set(codes).size !== N) throw new Error("duplicate ballot codes. Nothing was sent.");

  // ---- new election file: same content and layout as the sample, new code and ballot list ----
  const base = readJson(path.join(SAMPLE_DIR, "election-file.json"));
  const oldList = readJson(path.join(SAMPLE_DIR, "ballot-list.json"));
  const oldElectionCode = base.electionCode;
  for (const c of codes) if (!oldList.ballots.some((b) => b.ballotCode === c)) throw new Error(`${c} is not on the original ballot list. Nothing was sent.`);
  const electionCode = process.env.ELECTION_CODE || core.newElectionCode(2026);
  const eKey = core.electionKey(electionCode);
  const electionFile = { ...base, electionCode, ballotCodes: [...codes].sort(), registeredVoters: N };
  core.validate("electionFile", electionFile);
  const efProblems = core.electionFileProblems(electionFile, { requireLayoutHash: true });
  if (efProblems.length) throw new Error(`election file problems: ${JSON.stringify(efProblems)}. Nothing was sent.`);
  if (electionFile.layoutHash !== readJson(path.join(SAMPLE_DIR, "manifest.json")).layoutHash) throw new Error("layoutHash changed. Nothing was sent.");
  const order = electionFile.questions.map((q) => q.id);
  const fileSha = "0x" + core.sha256Json(electionFile);
  const listRoot = core.ballotListRoot(codes);
  const ballotList = { schemaVersion: "0.1", electionCode, electionKey: eKey, count: N, ballotListRoot: listRoot, ballots: codes.map((c) => ({ ballotCode: c, ballotKey: core.ballotKey(c) })) };

  // ---- contracts ----
  let c, addresses;
  if (net === "hardhat") {
    const d = await deployAll(ethers, admin);
    c = { ledger: d.ledger, registry: d.registry, tally: d.tally };
    addresses = d.addresses;
  } else {
    const dep = readJson(path.join(__dirname, "..", "deployments", "coston2.json"));
    const at = async (name, addr) => (await ethers.getContractFactory(name, admin)).attach(addr);
    c = { ledger: await at("BallotLedger", dep.contracts.BallotLedger), registry: await at("ElectionRegistry", dep.contracts.ElectionRegistry), tally: await at("Tally", dep.contracts.Tally) };
    addresses = { ledger: dep.contracts.BallotLedger, registry: dep.contracts.ElectionRegistry, tally: dep.contracts.Tally };
  }
  const ledgerAddr = await c.ledger.getAddress();
  if ((await c.registry.elections(eKey)).status !== 0n) throw new Error(`Election ${electionCode} already exists on this network. Nothing was sent.`);

  // ---- cost estimate (abort before sending anything) ----
  const startBalance = await ethers.provider.getBalance(admin.address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  const estGas = 260_000 + 80_000 + 40_000 + 5 * 170_000 + 40_000 + 450_000;
  const worst = (BigInt(estGas) * gasPrice * 13n) / 10n;
  console.log(`Election ${electionCode}. Estimate: ${estGas} gas x ${gasPrice / 1000000000n} gwei, worst case ${fmt(worst)} C2FLR; balance ${fmt(startBalance)}`);
  if (worst > MAX_FEE || worst > startBalance) throw new Error("Estimated cost is over the limit or the balance. Nothing was sent.");

  // ---- device, signed readings, records ----
  const device = ethers.Wallet.createRandom(); // signs off-chain only; never printed or saved
  const appHash = "0x" + core.sha256Hex(fs.readFileSync(path.join(__dirname, "..", "..", "scanner", "prototype", "omr.py")));
  const domain = core.eip712Domain({ chainId: 114, verifyingContract: ledgerAddr });
  const today = new Date().toISOString().slice(0, 10);
  const records = [], entries = [], subs = [];
  for (const s of scans) {
    const input = { electionCode, ballotCode: s.ballotCode, results: s.results, imageSha256: s.imageSha256, fillScores: s.fillScores, questionOrder: order };
    const signature = await core.signReading(device, input, domain);
    const record = {
      schemaVersion: "0.1", electionCode, ballotCode: s.ballotCode, results: s.results,
      readings: [{ device: device.address, imageSha256: s.imageSha256, fillScores: s.fillScores, results: s.results, signature }],
      review: { required: false }, scannedOn: today,
    };
    core.validate("ballotRecord", record);
    if (core.checkRecordSignatures(record, domain, order).agreeingValidReadings !== 1) throw new Error(`page ${s.page}: reading signature does not verify offline. Nothing was sent.`);
    const recordSha = core.recordSha256(record);
    const entry = core.ledgerEntryFromRecord(record);
    records.push({ page: s.page, record, recordSha });
    entries.push(entry);
    subs.push({
      electionKey: eKey, ballotKey: core.ballotKey(s.ballotCode), results: core.encodeResults(s.results, order),
      imageSha256: "0x" + s.imageSha256, recordSha256: "0x" + recordSha,
      readings: [{ device: device.address, imageSha256: "0x" + s.imageSha256, scoresHash: core.scoresHash(s.fillScores), sig: signature }],
      reviewer: ethers.ZeroAddress, reviewerSig: "0x",
    });
  }
  const leaves = entries.map((e) => core.entryLeaf(e));
  const root = core.merkleRoot(leaves);
  const tallyQ = core.tallyQuestions(entries, [], { election: electionFile });
  const perQ = order.map((q) => ({ valid: tallyQ[q].valid, blank: tallyQ[q].blank, overvote: tallyQ[q].overvote, unclear: tallyQ[q].unclear }));
  const registered = N, issued = N, unusedReturned = 0;
  const rec = core.reconcile({ registered, issued, unusedReturned }, { registeredInElectionFile: N, printed: N, cast: N, spoiled: 0, perQuestion: tallyQ, expectedQuestions: order });
  console.log("Off-chain reconcile failedChecks:", rec.failedChecks);
  if (rec.failedChecks !== 0) throw new Error("off-chain reconciliation does not pass. Nothing was sent.");

  // ---- lifecycle ----
  const steps = [];
  const send = async (name, txPromise, extra = {}) => {
    const tx = await txPromise;
    const rc = await tx.wait();
    const price = rc.gasPrice ?? tx.gasPrice;
    const fee = rc.gasUsed * price;
    steps.push({ step: name, txHash: tx.hash, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), gasPriceWei: price.toString(), feeWei: fee.toString(), fee: fmt(fee), status: Number(rc.status), ...extra });
    console.log(`${name}: block ${rc.blockNumber} gas ${rc.gasUsed} fee ${fmt(fee)} tx ${tx.hash}`);
    return rc;
  };
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const cid = `local-unpublished:${electionCode}`;
  await send("ElectionRegistry.createElection", c.registry.createElection(electionCode, cid, fileSha, N, N, electionFile.quorum, now - 120, now + 3600, listRoot));
  await send("ElectionRegistry.registerDevice", c.registry.registerDevice(eKey, device.address, appHash));
  await send("ElectionRegistry.openElection", c.registry.openElection(eKey));
  await send("BallotLedger.submitBatch (5 records, pages 1-5)", c.ledger.submitBatch(subs), { records: N, ballotCodes: codes });
  await send("ElectionRegistry.closeElection", c.registry.closeElection(eKey));
  await send("Tally.postTally (3 questions)", c.tally.postTally(eKey, root, perQ, registered, issued, unusedReturned, `${cid}:results`, "0x" + core.sha256Json({ tallyQ, root })));

  // ---- independent re-read from the chain (reads only; nothing from the objects above except the election file and codes) ----
  const onEntries = [], perBallot = [];
  for (let i = 0; i < N; i++) {
    const code = codes[i], bk = core.ballotKey(code);
    const [r, sp] = await Promise.all([c.ledger.records(eKey, bk), c.ledger.spoiled(eKey, bk)]);
    const decoded = core.decodeResults(r.results, order);
    onEntries.push({ electionCode, ballotCode: code, results: decoded, imageSha256: r.imageSha256.slice(2), recordSha256: r.recordSha256.slice(2), reviewed: r.reviewed });
    const listed = await c.registry.ballotListed(eKey, bk, core.merkleProof(codes.map(core.ballotKey), bk));
    perBallot.push({
      page: i + 1, ballotCode: code, ballotKey: bk, onChainResults: r.results, expectedResults: scans[i].resultsString,
      resultsMatch: r.results === scans[i].resultsString,
      resultsHashMatch: ethers.keccak256(ethers.toUtf8Bytes(r.results)) === scans[i].resultsHash,
      imageHashMatch: r.imageSha256 === "0x" + scans[i].imageSha256,
      recordHashMatch: r.recordSha256 === "0x" + records[i].recordSha,
      acceptedAt: Number(r.acceptedAt), acceptedAtIso: new Date(Number(r.acceptedAt) * 1000).toISOString(), reviewed: r.reviewed, spoiled: sp, onBallotList: listed,
    });
  }
  const cast = Number(await c.ledger.recordCount(eKey));
  const spoiledN = Number(await c.ledger.spoiledCount(eKey));
  const corrections = Number(await c.ledger.correctionCount(eKey));
  const reTally = core.tallyQuestions(onEntries, [], { election: electionFile });
  const reLeaves = onEntries.map((e) => core.entryLeaf(e));
  const reRoot = core.merkleRoot(reLeaves);
  const el = await c.registry.elections(eKey);
  const res = await c.tally.getResult(eKey, 1);
  const stored = [];
  for (let q = 0; q < order.length; q++) {
    const t = await c.tally.perQuestion(eKey, 1, q);
    stored.push({ valid: Number(t.valid), blank: Number(t.blank), overvote: Number(t.overvote), unclear: Number(t.unclear) });
  }
  const expectPerQ = order.map((q) => ({ valid: reTally[q].valid, blank: reTally[q].blank, overvote: reTally[q].overvote, unclear: reTally[q].unclear }));
  const reRec = core.reconcile({ registered, issued, unusedReturned }, { registeredInElectionFile: N, printed: Number(el.ballotCount), cast, spoiled: spoiledN, perQuestion: reTally, expectedQuestions: order });
  const proofs = [];
  for (let i = 0; i < N; i++) proofs.push({ page: i + 1, ballotCode: codes[i], leaf: reLeaves[i], onChainVerified: await c.tally.verifyInclusion(eKey, 1, reLeaves[i], core.merkleProof(reLeaves, reLeaves[i])) });
  const wrongLeafRejected = (await c.tally.verifyInclusion(eKey, 1, ethers.id("not a ballot"), core.merkleProof(reLeaves, reLeaves[0]))) === false;
  const finality = Number(res.finality) === 1 ? "Final" : "Provisional";
  const statusNames = ["None", "Setup", "Open", "Closed", "Tallied"];
  const verification = {
    recordsOnChain: cast, spoiledOnChain: spoiledN, correctionsOnChain: corrections, resultCount: Number(await c.tally.resultCount(eKey)),
    electionOnChain: { organizer: el.organizer, status: Number(el.status), statusName: statusNames[Number(el.status)] ?? String(el.status), ballotCount: Number(el.ballotCount), registeredVoters: Number(el.registeredVoters), quorum: Number(el.quorum), ballotListRoot: el.ballotListRoot, fileSha256: (await c.registry.latestVersion(eKey)).fileSha256, deviceRegistered: Number(await c.registry.roles(eKey, device.address)) !== 0 },
    electionFileShaMatches: (await c.registry.latestVersion(eKey)).fileSha256 === fileSha,
    ballotListRootMatches: el.ballotListRoot === listRoot,
    perBallot, allBallotsMatch: perBallot.every((b) => b.resultsMatch && b.resultsHashMatch && b.imageHashMatch && b.recordHashMatch && !b.spoiled && b.onBallotList),
    tallyFromChainRecords: Object.fromEntries(order.map((q) => [q, reTally[q]])),
    storedTally: stored, tallyRecomputedMatchesStored: JSON.stringify(expectPerQ) === JSON.stringify(stored),
    tallyRecomputedMatchesOrganizer: JSON.stringify(expectPerQ) === JSON.stringify(perQ),
    merkleRootRecomputed: reRoot, merkleRootStored: res.merkleRoot, merkleRootMatches: reRoot === res.merkleRoot && reRoot === root,
    reconciliationRecomputedFailedChecks: reRec.failedChecks, reconciliationStoredFailedChecks: Number(res.failedChecks),
    reconciliationMatches: reRec.failedChecks === Number(res.failedChecks),
    storedRecon: { registered: Number(res.recon.registered), printed: Number(res.recon.printed), issued: Number(res.recon.issued), cast: Number(res.recon.cast), spoiled: Number(res.recon.spoiled), unusedReturned: Number(res.recon.unusedReturned), unissued: Number(res.recon.unissued) },
    isFinal: await c.tally.isFinal(eKey), finality, inclusionProofs: proofs, inclusionProofsAllOk: proofs.every((p) => p.onChainVerified), wrongLeafRejected,
  };
  console.log("Verification:", JSON.stringify({ ...verification, perBallot: perBallot.map((b) => [b.page, b.onChainResults, b.resultsMatch && b.imageHashMatch && b.recordHashMatch]) }));

  const endBalance = await ethers.provider.getBalance(admin.address);
  const totalFee = steps.reduce((s, x) => s + BigInt(x.feeWei), 0n);
  const explorer = net === "coston2" ? "https://coston2-explorer.flare.network" : null;
  const out = {
    network: net, chainId: 114, electionCode, electionKey: eKey, derivedFromElection: oldElectionCode,
    contracts: addresses, deployer: admin.address, deviceAddress: device.address,
    electionFile, electionFileSha256: fileSha, layoutHash: electionFile.layoutHash, ballotList,
    ballots: scans.map((s, i) => ({ page: s.page, ballotCode: s.ballotCode, ballotKey: core.ballotKey(s.ballotCode), resultsString: s.resultsString, resultsHash: s.resultsHash, fillScores: s.fillScores, imageFile: s.imageFile, imageSha256: "0x" + s.imageSha256, recordSha256: "0x" + records[i].recordSha, leaf: leaves[i] })),
    tally: { perQuestion: Object.fromEntries(order.map((q) => [q, tallyQ[q]])), merkleRoot: root, registered, issued, unusedReturned, reconcileFailedChecks: rec.failedChecks },
    steps: steps.map((s) => ({ ...s, explorerUrl: explorer ? `${explorer}/tx/${s.txHash}` : null })),
    totals: { transactions: steps.length, gas: steps.reduce((s, x) => s + x.gasUsed, 0), feeC2FLR: fmt(totalFee), feeWei: totalFee.toString() },
    verification, balanceBeforeC2FLR: fmt(startBalance), balanceAfterC2FLR: fmt(endBalance),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.writeFileSync(path.join(dir, `${net}-scanned-5.json`), JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(path.join(SCAN_DIR, "new-election-file.json"), JSON.stringify(electionFile, null, 2) + "\n");
  fs.writeFileSync(path.join(SCAN_DIR, "new-ballot-records.json"), JSON.stringify(records.map((r) => r.record), null, 2) + "\n");
  console.log(`total gas ${out.totals.gas}, total fee ${out.totals.feeC2FLR} C2FLR, finality ${finality}, balance ${out.balanceAfterC2FLR}`);
  const ok = verification.allBallotsMatch && cast === N && spoiledN === 0 && verification.tallyRecomputedMatchesStored && verification.merkleRootMatches && verification.reconciliationMatches &&
    verification.reconciliationStoredFailedChecks === 0 && verification.isFinal && verification.inclusionProofsAllOk && wrongLeafRejected && verification.ballotListRootMatches && verification.electionFileShaMatches && verification.electionOnChain.deviceRegistered && verification.electionOnChain.status === 4;
  if (!ok) throw new Error(`Finished, but at least one read-back check failed (see deployments/${net}-scanned-5.json)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
