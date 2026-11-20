// Deploys StaffRegistry beside the existing ElectionRegistry. It does not change the other four contracts.
//
//   npx hardhat run scripts/deploy-staff.js                         # dry run on the in-process network
//   STAFF_DEPLOY_MAX_FEE_WEI=<approved cap> npx hardhat run scripts/deploy-staff.js --network coston2
//
// This file is not run by CI and must not be run against Coston2 until the owner approves the fee.
// On Coston2 it refuses to send unless STAFF_DEPLOY_MAX_FEE_WEI is set to the approved cap (estimate + 30%),
// the chain id is 114, and the registry address matches deployments/coston2-pool.json.
// STAFF_DEPLOY_DRY_RUN=1 estimates gas for that live registry address and does not broadcast.
// The deployer key is read only from the environment (see deploy.js) and is never printed.
// A live run writes deployments/coston2-staff.json (address, block, gas, fee). It does not edit site config.
const fs = require("fs");
const path = require("path");
const { preflight } = require("./deploy");
const { deployAll } = require("./lib/deploy-lib");

function checkFee({ gas, gasPriceWei, approvedMaxFeeWei }) {
  if (approvedMaxFeeWei == null || approvedMaxFeeWei === "") return { ok: false, reason: "No approved fee cap (STAFF_DEPLOY_MAX_FEE_WEI). Nothing was sent." };
  const cap = BigInt(approvedMaxFeeWei);
  const worst = BigInt(gas) * BigInt(gasPriceWei);
  if (worst > cap) return { ok: false, reason: `Fee estimate ${worst} wei is above the approved cap ${cap} wei. Nothing was sent.` };
  return { ok: true, worst, cap };
}

const LIVE_REGISTRY = "0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A";

function liveRegistryAddress() {
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "coston2-pool.json"), "utf8"));
  const registryAddr = rec.contracts.ElectionRegistry;
  if (String(registryAddr).toLowerCase() !== LIVE_REGISTRY.toLowerCase()) {
    throw new Error("deployments/coston2-pool.json does not point at the live ElectionRegistry. Nothing was sent.");
  }
  return registryAddr;
}

async function main(hre = require("hardhat")) {
  const deployer = await preflight(hre);
  const live = hre.network.name !== "hardhat";
  const dryRun = process.env.STAFF_DEPLOY_DRY_RUN === "1";
  const { ethers } = hre;
  let registryAddr;
  if (live || dryRun) {
    registryAddr = liveRegistryAddress();
  } else {
    const d = await deployAll(ethers, deployer);
    registryAddr = d.addresses.registry;
  }

  const Factory = await ethers.getContractFactory("StaffRegistry");
  const txReq = await Factory.getDeployTransaction(registryAddr);
  const gas = await ethers.provider.estimateGas({ ...txReq, from: deployer.address });
  const fee = await ethers.provider.getFeeData();
  const gasPriceWei = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  if (dryRun) {
    const estimate = { dryRun: true, broadcast: false, gasEstimate: gas.toString(), ElectionRegistry: registryAddr };
    console.log(JSON.stringify(estimate));
    return estimate;
  }
  if (live) {
    const c = checkFee({ gas, gasPriceWei, approvedMaxFeeWei: process.env.STAFF_DEPLOY_MAX_FEE_WEI });
    if (!c.ok) throw new Error(c.reason);
    console.log(`Deploying StaffRegistry to ${hre.network.name}: estimate ${ethers.formatEther(c.worst)} C2FLR, approved cap ${ethers.formatEther(c.cap)} C2FLR`);
  }
  const staff = await Factory.deploy(registryAddr, live ? { gasLimit: gas, gasPrice: gasPriceWei } : {});
  const rc = await staff.deploymentTransaction().wait();
  const out = {
    network: hre.network.name,
    chainId: 114,
    StaffRegistry: await staff.getAddress(),
    ElectionRegistry: registryAddr,
    txHash: rc.hash,
    block: rc.blockNumber,
    gasUsed: Number(rc.gasUsed),
    gasPriceWei: String(rc.gasPrice ?? gasPriceWei),
    fee: ethers.formatEther(rc.gasUsed * (rc.gasPrice ?? gasPriceWei)),
    configKey: "staffRegistry",
  };
  if (live) {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "coston2-staff.json"), JSON.stringify(out, null, 2) + "\n");
  }
  console.log(JSON.stringify({ StaffRegistry: out.StaffRegistry, ElectionRegistry: out.ElectionRegistry, gasUsed: out.gasUsed, fee: out.fee }, null, 2));
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { main, checkFee, liveRegistryAddress, LIVE_REGISTRY };
