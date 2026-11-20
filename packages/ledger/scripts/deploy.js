// Deploys the B.E.I.N.G.S. contracts.
//
//   npx hardhat run scripts/deploy.js                       # dry run on the in-process Hardhat network (no key needed)
//   npx hardhat run scripts/deploy.js --network coston2     # Flare Coston2 test network (chain ID 114)
//
// The Coston2 deployer key is read ONLY from the environment (DEPLOYER_PRIVATE_KEY, normally from a git-ignored
// `.env`, see `.env.example`). It is never printed, never written to disk and never committed. The key must be a
// funded Coston2 test key (C2FLR from the Flare faucet).
// Writes deployments/<network>.json (addresses and block only).
const fs = require("fs");
const path = require("path");
const { deployAll } = require("./lib/deploy-lib");

const COSTON2_CHAIN_ID = 114n;

/** Throws a clear error if a live network is selected without a usable deployer key or on the wrong chain. */
async function preflight(hre) {
  const net = hre.network;
  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No deployer account for network "${net.name}". Set DEPLOYER_PRIVATE_KEY in packages/ledger/.env (see .env.example). ` +
        "Nothing was sent."
    );
  }
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId !== COSTON2_CHAIN_ID) {
    throw new Error(`Expected chain ID 114 (Coston2 or the in-process test network), got ${chainId}. Nothing was sent.`);
  }
  return signers[0];
}

async function main(hre = require("hardhat")) {
  const deployer = await preflight(hre);
  const live = hre.network.name !== "hardhat";
  if (live) {
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    if (balance === 0n) {
      throw new Error(`Deployer ${deployer.address} has no balance on ${hre.network.name}. Fund it from the Flare faucet. Nothing was sent.`);
    }
    console.log(`Deploying to ${hre.network.name} as ${deployer.address} (balance ${hre.ethers.formatEther(balance)})`);
  } else {
    console.log("Dry run on the in-process Hardhat network (chain ID 114). Nothing is deployed to a live network.");
  }

  const d = await deployAll(hre.ethers, deployer);
  const out = {
    network: hre.network.name,
    chainId: Number(COSTON2_CHAIN_ID),
    deployer: d.deployer,
    deployBlock: d.deployBlock,
    contracts: {
      BallotLedger: d.addresses.ledger,
      ElectionRegistry: d.addresses.registry,
      Tally: d.addresses.tally,
      VerifierRegistry: d.addresses.verifierRegistry,
    },
    eip712: { name: "B.E.I.N.G.S.", version: "1", chainId: Number(COSTON2_CHAIN_ID) },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hre.network.name}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.contracts, null, 2));
  console.log(`Wrote deployments/${hre.network.name}.json`);
  return { ...d, out };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { main, preflight };
