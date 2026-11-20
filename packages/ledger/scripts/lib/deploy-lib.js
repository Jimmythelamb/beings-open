// Shared by scripts/deploy.js, scripts/gas-report.js and the tests: deploys the four contracts in a fixed order.
//
// ORDER MATTERS. BallotLedger is deployed FIRST and the registry is the SECOND contract, so that
//   BallotLedger      = createAddress(deployer, nonce)
//   ElectionRegistry  = createAddress(deployer, nonce + 1)   (the ledger needs this address in its constructor)
//   Tally             = createAddress(deployer, nonce + 2)
//   VerifierRegistry  = createAddress(deployer, nonce + 3)
// On a fresh chain with Hardhat account #0 (nonce 0) these are the verifyingContract addresses used by the
// core package's EIP-712 test vectors. Wiring (setLedger, setTally) happens after, so it does not shift them.
const { getCreateAddress } = require("ethers");

/**
 * @param {import("ethers").Signer} deployer
 * @param {typeof import("hardhat").ethers} ethers  hardhat-ethers helper
 * @returns {Promise<{ledger, registry, tally, verifierRegistry, addresses: Record<string,string>, deployer: string, deployBlock: number}>}
 */
async function deployAll(ethers, deployer) {
  const from = await deployer.getAddress();
  const nonce = await deployer.getNonce();
  const predicted = {
    ledger: getCreateAddress({ from, nonce }),
    registry: getCreateAddress({ from, nonce: nonce + 1 }),
    tally: getCreateAddress({ from, nonce: nonce + 2 }),
    verifierRegistry: getCreateAddress({ from, nonce: nonce + 3 }),
  };

  const wait = async (c) => {
    await c.waitForDeployment();
    return c;
  };
  const Ledger = await ethers.getContractFactory("BallotLedger", deployer);
  const Registry = await ethers.getContractFactory("ElectionRegistry", deployer);
  const Tally = await ethers.getContractFactory("Tally", deployer);
  const Verifier = await ethers.getContractFactory("VerifierRegistry", deployer);

  const ledger = await wait(await Ledger.deploy(predicted.registry));
  const registry = await wait(await Registry.deploy());
  const tally = await wait(await Tally.deploy(predicted.registry, predicted.ledger));
  const verifierRegistry = await wait(await Verifier.deploy());

  const actual = {
    ledger: await ledger.getAddress(),
    registry: await registry.getAddress(),
    tally: await tally.getAddress(),
    verifierRegistry: await verifierRegistry.getAddress(),
  };
  for (const k of Object.keys(predicted)) {
    if (actual[k] !== predicted[k]) throw new Error(`deploy order broke: ${k} is ${actual[k]}, expected ${predicted[k]}`);
  }

  await (await registry.setLedger(actual.ledger)).wait();
  await (await registry.setTally(actual.tally)).wait();

  return {
    ledger,
    registry,
    tally,
    verifierRegistry,
    addresses: actual,
    deployer: from,
    deployBlock: await ethers.provider.getBlockNumber(),
  };
}

module.exports = { deployAll };
