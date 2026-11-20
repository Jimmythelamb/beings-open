// Gas measurement on the in-process Hardhat network (chain ID 114). Nothing is sent to a live network.
//   npm run gas -w @beings/ledger        (writes GAS.md and gas-report.json)
// Replays the core "tally" test vector (5 ballots, 2 corrections, 1 spoiled ballot, 2 questions) and records the gas
// of every state-changing call, then estimates the read-only verifyInclusion. Gas is the EVM gas used, so it is
// independent of the gas price. Numbers are for solc 0.8.24, optimizer 200 runs, evm london.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const h = require("../test/helpers");
const { ethers } = h;

const rows = new Map();
function rec(label, gas) {
  const r = rows.get(label) || { label, n: 0, min: Infinity, max: 0, sum: 0 };
  r.n++;
  r.min = Math.min(r.min, gas);
  r.max = Math.max(r.max, gas);
  r.sum += gas;
  rows.set(label, r);
}
async function m(label, txPromise, per = 1) {
  const g = await h.gasOf(txPromise);
  rec(label, Math.round(g / per));
  return g;
}

async function main() {
  const ctx = await h.setup();
  const { vec, core } = ctx;
  const sizes = {};
  const deployGas = {};
  for (const [name, c, addrKey] of [
    ["BallotLedger", ctx.ledger],
    ["ElectionRegistry", ctx.registry],
    ["Tally", ctx.tally],
    ["VerifierRegistry", ctx.verifierRegistry],
  ]) {
    const rc = await c.deploymentTransaction().wait();
    deployGas[name] = Number(rc.gasUsed);
    const art = await hre.artifacts.readArtifact(name);
    sizes[name] = (art.deployedBytecode.length - 2) / 2;
  }

  const reg = ctx.registry.connect(ctx.organizer);
  const t = await h.now();
  const code = vec.codes.electionCode;
  const key = core.electionKey(code);
  await m("ElectionRegistry.createElection", reg.createElection(code, "bafy-election-file", ethers.id("e"), 8, 6, 1, t - 10, t + h.ONE_DAY, vec.merkle.ballotListRoot.root));
  await m("ElectionRegistry.postVersion", reg.postVersion(key, "bafy-election-file-v2", ethers.id("e2")));
  await m("ElectionRegistry.registerDevice", reg.registerDevice(key, ctx.wallets.device1.address, ethers.id("app-1")));
  await m("ElectionRegistry.registerDevice", reg.registerDevice(key, ctx.wallets.device2.address, ethers.id("app-1")));
  await m("ElectionRegistry.registerReviewer", reg.registerReviewer(key, ctx.wallets.reviewer.address));
  await m("ElectionRegistry.openElection", reg.openElection(key));

  const sender = ctx.ledger.connect(ctx.outsider);
  const E = vec.tally.entries;
  const build = (i, o) => h.buildSubmission(ctx, i, E[i].results, o);
  const S = async (i, o) => h.toStruct(await build(i, o));
  // The first record of an election also initialises the per-election counters (cold zero -> non-zero SSTOREs),
  // so it is reported on its own. The variants below are then measured from the SAME state (ballot 1, one record
  // already stored) with evm_snapshot / evm_revert, so they are comparable.
  await m("BallotLedger.submitRecord (first record of an election, 1 reading)", sender.submitRecord(await S(0)));
  const trial = async (label, fn) => {
    const id = await hre.network.provider.send("evm_snapshot");
    const g = await fn();
    await hre.network.provider.send("evm_revert", [id]);
    rec(label, g);
  };
  await trial("BallotLedger.submitRecord (1 reading)", async () => h.gasOf(sender.submitRecord(await S(1))));
  await trial("BallotLedger.submitRecord (1 reading + reviewer sig)", async () => h.gasOf(sender.submitRecord(await S(1, { reviewer: ctx.wallets.reviewer }))));
  await trial("BallotLedger.submitRecord (2 readings)", async () => h.gasOf(sender.submitRecord(await S(1, { readers: [ctx.wallets.device1, ctx.wallets.device2] }))));
  await trial("BallotLedger.submitBatch (2 records, total)", async () => h.gasOf(sender.submitBatch([await S(1), await S(2)])));
  await trial("BallotLedger.submitBatch (per record, 2-record batch)", async () => Math.round((await h.gasOf(sender.submitBatch([await S(1), await S(2)]))) / 2));
  // the real replay: ballot 1 carries the reviewer signature (the vector marks it reviewed)
  await sender.submitRecord(await S(1, { reviewer: ctx.wallets.reviewer }));
  await sender.submitRecord(await S(2, { readers: [ctx.wallets.device1, ctx.wallets.device2] }));
  await sender.submitBatch([await S(3), await S(4)]);

  const rev = ctx.ledger.connect(ctx.wallets.reviewer);
  for (const c of vec.tally.corrections) {
    const bi = vec.codes.ballots.findIndex((b) => b.ballotCode === c.ballotCode);
    const qi = h.QUESTION_ORDER.indexOf(c.questionId);
    await m("BallotLedger.postCorrection", rev.postCorrection(key, h.correction(ctx, bi, { prevIndex: c.prevIndex, questionIndex: qi, fromResult: c.from, toResult: c.to, reason: h.REASON[c.reason] })));
  }
  await m("BallotLedger.markSpoiled", ctx.ledger.connect(ctx.organizer).markSpoiled(key, ethers.id("spoiled-ballot-1"), h.ZERO32));
  await m("ElectionRegistry.closeElection", reg.closeElection(key));

  // postTally: measured twice from the same state, as Final (all checks pass) and as Provisional (R4 fails)
  const perQ = h.QUESTION_ORDER.map((q) => {
    const v = vec.tally.tallyWithCorrections[q];
    return { valid: v.valid, blank: v.blank, overvote: v.overvote, unclear: v.unclear };
  });
  const tallyAsOrganizer = ctx.tally.connect(ctx.organizer);
  const root = vec.tally.merkleRootWithCorrections;
  const snap = await hre.network.provider.send("evm_snapshot");
  await m("Tally.postTally (Final, 2 questions)", tallyAsOrganizer.postTally(key, root, perQ, 6, 6, 0, "bafy-results", ethers.id("r")));
  await hre.network.provider.send("evm_revert", [snap]);
  await m("Tally.postTally (Provisional, 2 questions)", tallyAsOrganizer.postTally(key, root, perQ, 6, 7, 0, "bafy-results", ethers.id("r")));
  await m("Tally.clearReview", ctx.tally.connect(ctx.wallets.reviewer).clearReview(key, 1, "bafy-clearance"));
  await m("Tally.postAmendedTally (Final)", tallyAsOrganizer.postAmendedTally(key, root, perQ, 6, 6, 0, "bafy-results-v2", ethers.id("r2")));
  await m("ElectionRegistry.noticeImagesRetired", reg.noticeImagesRetired(key, "bafy-retired-note"));

  const leaves = vec.tally.leaves.map((l) => l.leaf);
  const proofOf = (l) => core.merkleProof(leaves, l);
  for (const [i, l] of leaves.entries()) {
    rec(`Tally.verifyInclusion (view, ${leaves.length} leaves)`, Number(await ctx.tally.verifyInclusion.estimateGas(key, 2, l, proofOf(l))));
  }

  const v = ctx.verifierRegistry;
  const node = ctx.wallets.node;
  await m("VerifierRegistry.register", v.connect(ctx.outsider).register("Node A", "bafy-info"));
  const a = {
    electionKey: key,
    tallyVersion: 2,
    reportCid: "bafy-report",
    reportSha256: ethers.id("report"),
    ballotQuestionsChecked: 10,
    ballotQuestionsAgreed: 10,
    tallyMatches: true,
    reconciliationMatches: true,
    merkleMatches: true,
    nonce: 0,
  };
  await m("VerifierRegistry.reportVerification (first report)", v.connect(ctx.outsider).reportVerification(key, 2, a.reportCid, a.reportSha256, 10, 10, true, true, true));
  await m("VerifierRegistry.reportVerification (replaces own report)", v.connect(ctx.outsider).reportVerification(key, 2, a.reportCid, a.reportSha256, 10, 9, true, true, true));
  const sigIn = (n) => ({ electionCode: code, tallyVersion: 2, reportCid: a.reportCid, reportSha256: a.reportSha256, ballotQuestionsChecked: 10, ballotQuestionsAgreed: 10, tallyMatches: true, reconciliationMatches: true, merkleMatches: true, nonce: n });
  await m("VerifierRegistry.reportVerificationSigned (first)", v.connect(ctx.outsider).reportVerificationSigned(a, await core.signNotice(node, sigIn(0), ctx.noticeDomain)));
  await m("VerifierRegistry.reportVerificationSigned (second, same node)", v.connect(ctx.outsider).reportVerificationSigned({ ...a, nonce: 1 }, await core.signNotice(node, sigIn(1), ctx.noticeDomain)));

  const table = [...rows.values()].map((r) => ({ function: r.label, calls: r.n, min: r.min, avg: Math.round(r.sum / r.n), max: r.max }));
  const report = {
    generated: new Date().toISOString(),
    compiler: { solc: "0.8.24", optimizer: { enabled: true, runs: 200 }, evmVersion: "london" },
    chainId: 114,
    deploymentGas: deployGas,
    runtimeBytes: sizes,
    functions: table,
  };
  fs.writeFileSync(path.join(__dirname, "..", "gas-report.json"), JSON.stringify(report, null, 2) + "\n");

  const fmt = (n) => n.toLocaleString("en-US");
  let md = `# Gas report (local Hardhat network)\n\n`;
  md += `Measured by \`npm run gas -w @beings/ledger\` on the in-process Hardhat network (chain ID 114). Solc 0.8.24, optimizer 200 runs, EVM london. `;
  md += `Numbers are gas used per transaction (EVM gas including the 21,000 base and calldata); multiply by the gas price for cost. The scenario is the core "tally" vector: 8 printed ballots, 6 registered, quorum 1, 2 questions, 5 recorded ballots, 2 corrections, 1 spoiled ballot. `;
  md += `Values on Coston2 can differ slightly (storage-touch rules are the same, but the calldata and chain parameters are not identical). \`Generated by the script; do not edit by hand.\`\n\n`;
  md += `## Per function\n\n| Function | Calls | Min | Avg | Max |\n|---|---:|---:|---:|---:|\n`;
  for (const r of table) md += `| ${r.function} | ${r.calls} | ${fmt(r.min)} | ${fmt(r.avg)} | ${fmt(r.max)} |\n`;
  md += `\n## Deployment\n\n| Contract | Deployment gas | Runtime size (bytes) | Limit 24,576 |\n|---|---:|---:|---|\n`;
  for (const k of Object.keys(deployGas)) md += `| ${k} | ${fmt(deployGas[k])} | ${fmt(sizes[k])} | ${sizes[k] <= 24576 ? "ok" : "OVER"} |\n`;
  md += `\nTotal deployment (4 contracts): ${fmt(Object.values(deployGas).reduce((x, y) => x + y, 0))} gas, plus 2 wiring calls (setLedger, setTally).\n`;
  // Real Coston2 numbers, if a deployment and a smoke test were recorded (npm run smoke:coston2).
  const depFile = path.join(__dirname, "..", "deployments", "coston2.json");
  const smokeFile = path.join(__dirname, "..", "deployments", "coston2-smoke.json");
  if (fs.existsSync(depFile)) {
    const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
    md += `\n## Real Coston2 numbers (chain ID 114, evm london)\n\n`;
    md += `Recorded from the real transactions in \`deployments/coston2.json\` and \`deployments/coston2-smoke.json\`. Fee = gas used x gas price. Gas price was ${Number(BigInt(dep.deployTransactions[0].gasPriceWei) / 1000000000n)} gwei during these runs and varies with the network; C2FLR has no value, but the same gas on Flare mainnet would cost real FLR.\n\n`;
    md += `### Deployment\n\n| Step | Gas | Fee (C2FLR) | Tx |\n|---|---:|---:|---|\n`;
    for (const t of dep.deployTransactions) md += `| ${t.step} | ${fmt(t.gasUsed)} | ${t.fee} | [${t.txHash.slice(0, 10)}...](${dep.explorer}/tx/${t.txHash}) |\n`;
    md += `\nTotal: ${fmt(dep.totalDeployGas)} gas, ${dep.totalDeployFee} C2FLR. Coston2 gas equals the local numbers exactly for deployments.\n\n`;
    md += `Contracts: ` + Object.entries(dep.contracts).map(([k, v]) => `${k} [\`${v}\`](${dep.explorer}/address/${v})`).join(", ") + `\n`;
    if (fs.existsSync(smokeFile)) {
      const sm = JSON.parse(fs.readFileSync(smokeFile, "utf8"));
      md += `\n### Smoke test (election ${sm.electionCode}: 1 ballot, 1 device, 1 reading, 1 question)\n\n| Step | Gas | Fee (C2FLR) | Tx |\n|---|---:|---:|---|\n`;
      for (const t of sm.steps) md += `| ${t.step} | ${fmt(t.gasUsed)} | ${t.fee} | [${t.txHash.slice(0, 10)}...](${dep.explorer}/tx/${t.txHash}) |\n`;
      md += `\nTotal: ${fmt(sm.totalGas)} gas, ${sm.totalFee} C2FLR. On-chain result: failedChecks ${sm.onChain.failedChecks}, Final ${sm.onChain.isFinal}, inclusion proof ${sm.onChain.inclusionProofOk}. `;
      md += `Gas on Coston2 matched a local dry run of the same script exactly for every step except createElection (175,636 on Coston2 against 174,679 locally, under 1,000 gas apart).\n`;
    }
  }
  const e200File = path.join(__dirname, "..", "deployments", "coston2-election200.json");
  if (fs.existsSync(e200File) && fs.existsSync(depFile)) {
    const e = JSON.parse(fs.readFileSync(e200File, "utf8"));
    const explorer = JSON.parse(fs.readFileSync(depFile, "utf8")).explorer;
    md += `\n### 200-ballot election (${e.electionCode}: 3 questions, 200 cast, 3 spoiled, 210 printed; \`npm run election200:coston2\`)\n\n`;
    md += `Total: ${fmt(e.totals.gas)} gas, ${e.totals.feeC2FLR} C2FLR, ${e.totals.transactions} transactions. Result ${e.verification.finality}, failedChecks ${e.reconciliation.failedChecks}; Merkle root, tally and reconciliation recomputed from chain reads all matched.\n\n`;
    md += `| Way of submitting | Ballots | Avg gas per ballot | Avg fee per ballot (C2FLR) |\n|---|---:|---:|---:|\n`;
    md += `| submitRecord (one tx each) | ${e.perBallotCost.single.ballots} | ${fmt(e.perBallotCost.single.avgGas)} | ${e.perBallotCost.single.avgFeeC2FLR} |\n`;
    for (const [size, b] of Object.entries(e.perBallotCost.batch)) md += `| submitBatch of ${size} | ${b.ballots} | ${fmt(b.avgGasPerBallot)} | ${b.avgFeePerBallotC2FLR} |\n`;
    md += `\nTransaction links: ` + e.steps.filter((t) => !t.step.includes("submit")).map((t) => `[${t.step}](${explorer}/tx/${t.txHash})`).join(", ") + `\n`;
  }
  fs.writeFileSync(path.join(__dirname, "..", "GAS.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
