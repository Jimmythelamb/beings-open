// Puts ONE real, scanned ballot on the ledger: creates the sample election (BEINGS-2026-4CRWX2) with its election file
// hash and ballotListRoot, registers a throw-away device, opens it, submits the scanned ballot with a device-signed
// Reading, closes, posts the tally, then reads the record back from the chain and compares it with what was read.
//
//   SCAN_DIR=/workspace/scans/out npx hardhat run scripts/scanned-ballot.js                     # dry run, in-process network
//   SCAN_DIR=/workspace/scans/out npx hardhat run scripts/scanned-ballot.js --network coston2   # SENDS REAL (test-network) TRANSACTIONS
//
// Inputs: $SCAN_RESULT (default $SCAN_DIR/page1-result.json, from packages/scanner/prototype/omr_finish.mjs) and the
// ballot-gen sample output ($SAMPLE_DIR, default ../ballot-gen/sample/output). The deployer key comes from the
// environment (.env) only; the device key is generated in memory, signs off-chain and is never printed or saved.
// Output (no keys): deployments/<network>-scanned-ballot.json and $SCAN_DIR/ballot-record.json
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { deployAll } = require("./lib/deploy-lib");

const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(__dirname, "..", "..", "ballot-gen", "sample", "output");
const SCAN_DIR = process.env.SCAN_DIR || "/workspace/scans/out";
const SCAN_RESULT = process.env.SCAN_RESULT || path.join(SCAN_DIR, "page1-result.json");
const MAX_FEE = ethers.parseEther(process.env.MAX_FEE || "5"); // abort if the up-front estimate exceeds this (C2FLR)
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

async function main() {
  const net = hre.network.name;
  if (net !== "hardhat" && net !== "coston2") throw new Error(`Unexpected network ${net}`);
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account (set DEPLOYER_PRIVATE_KEY in packages/ledger/.env). Nothing was sent.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 114n) throw new Error(`Expected chain ID 114, got ${chainId}. Nothing was sent.`);
  const core = await import("@beings/core");

  const manifest = readJson(path.join(SAMPLE_DIR, "manifest.json"));
  const electionFile = readJson(path.join(SAMPLE_DIR, "election-file.json"));
  const list = readJson(path.join(SAMPLE_DIR, "ballot-list.json"));
  const scan = readJson(SCAN_RESULT);
  const ce = manifest.createElection;

  // ---- checks before anything is sent ----
  const order = electionFile.questions.map((q) => q.id);
  const fileSha = "0x" + core.sha256Json(electionFile);
  if (fileSha !== ce.fileSha256 || ce.fileSha256 !== "0x" + manifest.electionFileSha256) throw new Error("election-file.json does not match the manifest hash. Nothing was sent.");
  if (core.ballotListRoot(list.ballots.map((b) => b.ballotCode)) !== ce.ballotListRoot) throw new Error("ballot-list.json does not match the ballotListRoot. Nothing was sent.");
  if (!scan.onBallotList || scan.coreValidationProblems.length) throw new Error(`The scan has problems: ${JSON.stringify(scan.coreValidationProblems)}. Nothing was sent.`);
  const ballotCode = scan.ballotCode;
  const results = scan.results;
  const imageSha256 = scan.imageSha256;
  const fillScores = scan.fillScores;
  const electionCode = ce.electionCode;
  const eKey = core.electionKey(electionCode);
  if (eKey !== ce.electionKey) throw new Error("electionKey mismatch. Nothing was sent.");

  let c;
  if (net === "hardhat") {
    const d = await deployAll(ethers, admin);
    c = { ledger: d.ledger, registry: d.registry, tally: d.tally };
  } else {
    const dep = readJson(path.join(__dirname, "..", "deployments", "coston2.json"));
    const at = async (name, addr) => (await ethers.getContractFactory(name, admin)).attach(addr);
    c = { ledger: await at("BallotLedger", dep.contracts.BallotLedger), registry: await at("ElectionRegistry", dep.contracts.ElectionRegistry), tally: await at("Tally", dep.contracts.Tally) };
  }
  const ledgerAddr = await c.ledger.getAddress();
  if ((await c.registry.elections(eKey)).status !== 0n) throw new Error(`Election ${electionCode} already exists on this network. Nothing was sent.`);

  const startBalance = await ethers.provider.getBalance(admin.address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  const estGas = 200_000 + 75_000 + 35_000 + 200_000 + 30_000 + 450_000;
  const worst = (BigInt(estGas) * gasPrice * 13n) / 10n;
  console.log(`Estimate: ${estGas} gas x ${gasPrice / 1000000000n} gwei, worst case ${ethers.formatEther(worst)} C2FLR; balance ${ethers.formatEther(startBalance)}`);
  if (worst > MAX_FEE || worst > startBalance) throw new Error("Estimated cost is over the limit or the balance. Nothing was sent.");

  const steps = [];
  const send = async (name, txPromise) => {
    const tx = await txPromise;
    const rc = await tx.wait();
    const price = rc.gasPrice ?? tx.gasPrice;
    const fee = rc.gasUsed * price;
    steps.push({ step: name, txHash: tx.hash, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), gasPriceWei: price.toString(), feeWei: fee.toString(), fee: ethers.formatEther(fee), status: Number(rc.status) });
    console.log(`${name}: block ${rc.blockNumber} gas ${rc.gasUsed} fee ${ethers.formatEther(fee)} tx ${tx.hash}`);
    return rc;
  };

  // ---- the device and the signed reading ----
  const device = ethers.Wallet.createRandom(); // signs off-chain only; never printed or saved
  const appHash = "0x" + core.sha256Hex(fs.readFileSync(path.join(__dirname, "..", "..", "scanner", "prototype", "omr.py")));
  const domain = core.eip712Domain({ chainId: 114, verifyingContract: ledgerAddr });
  const input = { electionCode, ballotCode, results, imageSha256, fillScores, questionOrder: order };
  const signature = await core.signReading(device, input, domain);
  const record = {
    schemaVersion: "0.1",
    electionCode,
    ballotCode,
    results,
    readings: [{ device: device.address, imageSha256, fillScores, results, signature }],
    review: { required: false },
    scannedOn: new Date().toISOString().slice(0, 10), // schema format "date"
  };
  core.validate("ballotRecord", record);
  const rcheck = core.checkRecordSignatures(record, domain, order);
  if (rcheck.agreeingValidReadings !== 1) throw new Error("the reading signature does not verify offline. Nothing was sent.");
  const recordSha = core.recordSha256(record);
  fs.mkdirSync(SCAN_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCAN_DIR, "ballot-record.json"), JSON.stringify(record, null, 2) + "\n");
  const entry = core.ledgerEntryFromRecord(record);
  const leaf = core.entryLeaf(entry);
  const root = core.merkleRoot([leaf]);

  const tallyQ = core.tallyQuestions([entry], [], { election: electionFile });
  const perQ = order.map((q) => ({ valid: tallyQ[q].valid, blank: tallyQ[q].blank, overvote: tallyQ[q].overvote, unclear: tallyQ[q].unclear }));
  const registered = ce.registeredVoters;
  const issued = 1; // one ballot was handed out for this test
  const unusedReturned = 0;
  const rec = core.reconcile({ registered, issued, unusedReturned }, { registeredInElectionFile: ce.registeredVoters, printed: ce.ballotCount, cast: 1, spoiled: 0, perQuestion: tallyQ, expectedQuestions: order });
  console.log("Off-chain reconcile failedChecks:", rec.failedChecks);

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await send("ElectionRegistry.createElection", c.registry.createElection(electionCode, `local-unpublished:${electionCode}`, fileSha, ce.ballotCount, ce.registeredVoters, ce.quorum, now - 120, now + 3600, ce.ballotListRoot));
  await send("ElectionRegistry.registerDevice", c.registry.registerDevice(eKey, device.address, appHash));
  await send("ElectionRegistry.openElection", c.registry.openElection(eKey));
  const sub = {
    electionKey: eKey,
    ballotKey: core.ballotKey(ballotCode),
    results: core.encodeResults(results, order),
    imageSha256: "0x" + imageSha256,
    recordSha256: "0x" + recordSha,
    readings: [{ device: device.address, imageSha256: "0x" + imageSha256, scoresHash: core.scoresHash(fillScores), sig: signature }],
    reviewer: ethers.ZeroAddress,
    reviewerSig: "0x",
  };
  const submitRc = await send("BallotLedger.submitRecord (1 reading)", c.ledger.submitRecord(sub));
  await send("ElectionRegistry.closeElection", c.registry.closeElection(eKey));
  await send("Tally.postTally (3 questions)", c.tally.postTally(eKey, root, perQ, registered, issued, unusedReturned, `local-unpublished:${electionCode}:results`, "0x" + core.sha256Json({ tallyQ, root })));

  // ---- read everything back from the chain ----
  const bk = core.ballotKey(ballotCode);
  const r = await c.ledger.records(eKey, bk);
  const onChain = {
    results: r.results,
    resultsHash: ethers.keccak256(ethers.toUtf8Bytes(r.results)),
    imageSha256: r.imageSha256,
    recordSha256: r.recordSha256,
    acceptedAt: Number(r.acceptedAt),
    acceptedAtIso: new Date(Number(r.acceptedAt) * 1000).toISOString(),
    reviewed: r.reviewed,
  };
  const election = await c.registry.elections(eKey);
  const recordCount = Number(await c.ledger.recordCount(eKey));
  const t = await c.tally.getResult(eKey, 1);
  const isFinal = await c.tally.isFinal(eKey);
  const inclusion = await c.tally.verifyInclusion(eKey, 1, leaf, []);
  const decoded = core.decodeResults(r.results, order);
  const checks = {
    resultsMatchScan: r.results === scan.resultsString,
    resultsHashMatches: onChain.resultsHash === scan.resultsHash,
    imageHashMatches: r.imageSha256 === "0x" + imageSha256,
    recordHashMatches: r.recordSha256 === "0x" + recordSha,
    leafFromChainMatches: core.entryLeaf({ electionCode, ballotCode, results: decoded, imageSha256: r.imageSha256.slice(2), recordSha256: r.recordSha256.slice(2), reviewed: r.reviewed }) === leaf,
    recordCount,
    tallyFailedChecks: Number(t.failedChecks),
    tallyIsFinal: isFinal,
    inclusionProofOk: inclusion,
  };
  console.log("On-chain record:", JSON.stringify(onChain));
  console.log("Checks:", JSON.stringify(checks));

  const endBalance = await ethers.provider.getBalance(admin.address);
  const totalFee = steps.reduce((s, x) => s + BigInt(x.feeWei), 0n);
  const explorer = net === "coston2" ? "https://coston2-explorer.flare.network" : null;
  const out = {
    network: net, chainId: 114, electionCode, electionKey: eKey, ballotCode, ballotKey: bk,
    contracts: { BallotLedger: ledgerAddr, ElectionRegistry: await c.registry.getAddress(), Tally: await c.tally.getAddress() },
    deviceAddress: device.address,
    electionFileSha256: fileSha, ballotListRoot: ce.ballotListRoot, layoutHash: electionFile.layoutHash,
    resultsString: scan.resultsString, imageSha256: "0x" + imageSha256, recordSha256: "0x" + recordSha,
    steps: steps.map((s) => ({ ...s, explorerUrl: explorer ? `${explorer}/tx/${s.txHash}` : null })),
    totalGas: steps.reduce((s, x) => s + x.gasUsed, 0), totalFee: ethers.formatEther(totalFee),
    registryStatus: Number(election.status), onChain, checks,
    tally: { merkleRoot: root, perQuestion: perQ, registered, issued, unusedReturned, reconcileFailedChecks: rec.failedChecks },
    balanceBefore: ethers.formatEther(startBalance), balanceAfter: ethers.formatEther(endBalance),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.writeFileSync(path.join(dir, `${net}-scanned-ballot.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`total gas ${out.totalGas}, total fee ${out.totalFee} C2FLR, balance ${out.balanceAfter}`);
  const ok = checks.resultsMatchScan && checks.resultsHashMatches && checks.imageHashMatches && checks.recordHashMatches && checks.leafFromChainMatches && recordCount === 1 && checks.tallyFailedChecks === 0 && isFinal && inclusion;
  if (!ok) throw new Error("Finished, but at least one read-back check failed (see above)");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
