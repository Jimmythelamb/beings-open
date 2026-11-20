// B.E.I.N.G.S. M4 ledger: Hardhat config.
// Networks: the in-process `hardhat` network for tests, and Flare's Coston2 test network (chain ID 114).
// Chain ID and RPC come from the election setup in the real system (architecture doc, Section 13); the defaults
// below are only for deploying the contracts in development.
require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");

const COSTON2_RPC = process.env.COSTON2_RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
// Deployer key: ONLY from the environment (see .env.example). Never commit a key.
const rawKey = (process.env.DEPLOYER_PRIVATE_KEY || "").trim();
const accounts = rawKey ? [rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`] : [];

/** @type import("hardhat/config").HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // TODO(confirm): Flare's FAQ says to compile for `london`; Flare's developer hub and starter kit use `cancun`.
      // `london` is the conservative choice (it avoids opcodes such as PUSH0 and MCOPY that an older node may reject).
      // Switch to "cancun" only after a test deployment and call on Coston2 confirms it works.
      evmVersion: "london",
    },
  },
  networks: {
    // In-process network for tests and gas measurement. chainId 114 so the core package's EIP-712 test vectors
    // (domain chainId 114) verify on-chain. Account #0 is the Hardhat default deployer (public test key).
    hardhat: {
      chainId: 114,
      allowUnlimitedContractSize: false,
    },
    coston2: {
      url: COSTON2_RPC,
      chainId: 114,
      accounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
