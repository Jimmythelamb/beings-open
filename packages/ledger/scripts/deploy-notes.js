// Deploys ElectionNotes next to the existing four contracts. It changes none of them.
//
//   npx hardhat run scripts/deploy-notes.js                       # dry run on the in-process Hardhat network
//   NOTES_DEPLOY_MAX_FEE_WEI=<approved cap> npx hardhat run scripts/deploy-notes.js --network coston2
//
// LIVE DEPLOYS NEED A SEPARATE, EXPLICIT APPROVAL. On Coston2 the script refuses to send unless
// NOTES_DEPLOY_MAX_FEE_WEI is set to the fee cap that was approved (estimate + 30%), and it refuses if the fresh
// estimate (gas x current gas price) is above that cap, if the registry's wired Tally isn't the recorded one, or
// if the chain isn't 114. The deployer key comes only from the environment (see deploy.js) and is never printed.
// Writes deployments/<network>-notes.json (address, block, gas, fee).
const fs = require("fs");
const path = require("path");
const { preflight } = require("./deploy");
const { deployAll } = require("./lib/deploy-lib");

/** Pure check used before any live send. Returns { ok, reason }. */
function checkFee({ gas, gasPriceWei, approvedMaxFeeWei }) {
  if (approvedMaxFeeWei == null || approvedMaxFeeWei === "") return { ok: false, reason: "No approved fee cap (NOTES_DEPLOY_MAX_FEE_WEI). Nothing was sent." };
  const cap = BigInt(approvedMaxFeeWei);
  const worst = BigInt(gas) * BigInt(gasPriceWei);
  if (worst > cap) return { ok: false, reason: `Fee estimate ${worst} wei is above the approved cap ${cap} wei. Nothing was sent.` };
  return { ok: true, worst, cap };
}

async function main(hre = require("hardhat")) {
  const deployer = await preflight(hre);
  const live = hre.network.name !== "hardhat";
  const { ethers } = hre;
  let registryAddr;
  let expectedTally;
  if (live) {
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
    registryAddr = rec.contracts.ElectionRegistry;
    expectedTally = rec.contracts.Tally;
  } else {
    const d = await deployAll(ethers, deployer);
    registryAddr = d.addresses.registry;
    expectedTally = d.addresses.tally;
  }
  const registry = new ethers.Contract(registryAddr, ["function tally() view returns (address)"], deployer);
  const wired = await registry.tally();
  if (wired.toLowerCase() !== expectedTally.toLowerCase()) throw new Error(`Registry ${registryAddr} is wired to Tally ${wired}, expected ${expectedTally}. Nothing was sent.`);

  const F = await ethers.getContractFactory("ElectionNotes", deployer);
  const txReq = await F.getDeployTransaction(registryAddr);
  const gas = await ethers.provider.estimateGas({ ...txReq, from: deployer.address });
  const fee = await ethers.provider.getFeeData();
  const gasPriceWei = fee.gasPrice ?? fee.maxFeePerGas;
  if (live) {
    const c = checkFee({ gas, gasPriceWei, approvedMaxFeeWei: process.env.NOTES_DEPLOY_MAX_FEE_WEI });
    if (!c.ok) throw new Error(c.reason);
    console.log(`Deploying ElectionNotes to ${hre.network.name}: estimate ${ethers.formatEther(c.worst)} C2FLR, approved cap ${ethers.formatEther(c.cap)} C2FLR`);
  }
  const notes = await F.deploy(registryAddr, live ? { gasLimit: gas, gasPrice: gasPriceWei } : {});
  const rc = await notes.deploymentTransaction().wait();
  const out = {
    network: hre.network.name,
    chainId: 114,
    ElectionNotes: await notes.getAddress(),
    registry: registryAddr,
    tally: wired,
    txHash: rc.hash,
    block: rc.blockNumber,
    gasUsed: Number(rc.gasUsed),
    gasPriceWei: String(rc.gasPrice ?? gasPriceWei),
    fee: ethers.formatEther(rc.gasUsed * (rc.gasPrice ?? gasPriceWei)),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  if (live) fs.writeFileSync(path.join(dir, `${hre.network.name}-notes.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { main, checkFee };
