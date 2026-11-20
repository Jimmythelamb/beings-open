// End-to-end smoke test of the deployed contracts: create one election, register a device, open it, submit one
// record, close it, post a tally. Records the real gas, fee and tx hash of every step.
//
//   npx hardhat run scripts/smoke.js                     # dry run on the in-process network (deploys fresh contracts)
//   npx hardhat run scripts/smoke.js --network coston2   # SENDS REAL (test-network) TRANSACTIONS from the .env key
//
// On coston2 it uses the addresses in deployments/coston2.json and the deployer key from the environment only.
// The "device" that signs the reading is a throw-away wallet generated in memory; it never sends a transaction and
// its key is never printed or saved. Output (no keys): deployments/<network>-smoke.json
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { deployAll } = require("./lib/deploy-lib");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomSuffix = () => Array.from(ethers.randomBytes(6), (b) => CROCKFORD[b % 32]).join("");

async function main() {
  const net = hre.network.name;
  if (net !== "hardhat" && net !== "coston2") throw new Error(`Unexpected network ${net}`);
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account (set DEPLOYER_PRIVATE_KEY in packages/ledger/.env). Nothing was sent.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 114n) throw new Error(`Expected chain ID 114, got ${chainId}. Nothing was sent.`);

  const core = await import("@beings/core");
  let c;
  if (net === "hardhat") {
    const d = await deployAll(ethers, admin);
    c = { ledger: d.ledger, registry: d.registry, tally: d.tally };
  } else {
    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "coston2.json"), "utf8"));
    const at = async (name, addr) => (await ethers.getContractFactory(name, admin)).attach(addr);
    c = {
      ledger: await at("BallotLedger", dep.contracts.BallotLedger),
      registry: await at("ElectionRegistry", dep.contracts.ElectionRegistry),
      tally: await at("Tally", dep.contracts.Tally),
    };
  }
  const ledgerAddr = await c.ledger.getAddress();

  const startBalance = await ethers.provider.getBalance(admin.address);
  const steps = [];
  const send = async (name, txPromise) => {
    const tx = await txPromise;
    const rc = await tx.wait();
    const price = rc.gasPrice ?? tx.gasPrice;
    const fee = rc.gasUsed * price;
    steps.push({ step: name, txHash: tx.hash, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), gasPriceWei: price.toString(), feeWei: fee.toString(), fee: ethers.formatEther(fee) });
    console.log(`${name}: gas ${rc.gasUsed} fee ${ethers.formatEther(fee)} tx ${tx.hash}`);
    return rc;
  };

  // election data
  const electionCode = `BEINGS-2026-${randomSuffix()}`;
  const ballotCode = "4F9Q7M2XHT8B";
  const questionOrder = ["q1"];
  const results = { q1: "V:c1" };
  const imageSha256 = core.sha256Hex("smoke-test-image");
  const fillScores = { q1: { c1: 90, c2: 1 } };
  const eKey = core.electionKey(electionCode);
  const device = ethers.Wallet.createRandom(); // signs off-chain only
  const now = (await ethers.provider.getBlock("latest")).timestamp;

  const leaf = core.entryLeaf({ electionCode, ballotCode, results, imageSha256, recordSha256: core.sha256Hex("smoke-test-record"), reviewed: false });
  const root = core.merkleRoot([leaf]);

  await send("ElectionRegistry.createElection", c.registry.createElection(electionCode, "bafy-smoke-test-election", ethers.id("smoke-test-election-file"), 1, 1, 1, now - 120, now + 3600, ethers.ZeroHash));
  await send("ElectionRegistry.registerDevice", c.registry.registerDevice(eKey, device.address, ethers.id("smoke-test-app")));
  await send("ElectionRegistry.openElection", c.registry.openElection(eKey));

  const domain = core.eip712Domain({ chainId: 114, verifyingContract: ledgerAddr });
  const input = { electionCode, ballotCode, results, imageSha256, fillScores, questionOrder };
  const sub = {
    electionKey: eKey,
    ballotKey: core.ballotKey(ballotCode),
    results: core.encodeResults(results, questionOrder),
    imageSha256: "0x" + imageSha256,
    recordSha256: "0x" + core.sha256Hex("smoke-test-record"),
    readings: [{ device: device.address, imageSha256: "0x" + imageSha256, scoresHash: core.scoresHash(fillScores), sig: await core.signReading(device, input, domain) }],
    reviewer: ethers.ZeroAddress,
    reviewerSig: "0x",
  };
  await send("BallotLedger.submitRecord (1 reading)", c.ledger.submitRecord(sub));
  await send("ElectionRegistry.closeElection", c.registry.closeElection(eKey));
  await send("Tally.postTally (1 question)", c.tally.postTally(eKey, root, [{ valid: 1, blank: 0, overvote: 0, unclear: 0 }], 1, 1, 0, "bafy-smoke-test-results", ethers.id("smoke-test-results")));

  const result = await c.tally.getResult(eKey, 1);
  const final = await c.tally.isFinal(eKey);
  const verified = await c.tally.verifyInclusion(eKey, 1, leaf, []);
  const endBalance = await ethers.provider.getBalance(admin.address);
  const totalFee = steps.reduce((s, x) => s + BigInt(x.feeWei), 0n);
  const out = {
    network: net,
    chainId: 114,
    electionCode,
    electionKey: eKey,
    ballotCode,
    steps,
    totalGas: steps.reduce((s, x) => s + x.gasUsed, 0),
    totalFee: ethers.formatEther(totalFee),
    onChain: { failedChecks: Number(result.failedChecks), isFinal: final, inclusionProofOk: verified },
    balanceBefore: ethers.formatEther(startBalance),
    balanceAfter: ethers.formatEther(endBalance),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}-smoke.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.onChain), `total fee ${out.totalFee}`, `balance ${out.balanceAfter}`);
  if (out.onChain.failedChecks !== 0 || !final || !verified) throw new Error("Smoke test finished but the tally is not Final / inclusion failed");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
