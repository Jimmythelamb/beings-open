// The deploy script. Only the in-process network is ever used here. Nothing is sent to Coston2.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { hre, ethers, network, setup, readVector } = require("./helpers");
const { main, preflight } = require("../scripts/deploy");

describe("deploy script (in-process network only)", () => {
  const out = path.join(__dirname, "..", "deployments", "hardhat.json");
  let log;
  beforeEach(async () => {
    await network.provider.send("hardhat_reset");
    log = console.log;
    console.log = () => {};
  });
  afterEach(() => {
    console.log = log;
  });

  it("deploys the four contracts, wires them, and reproduces the vector verifyingContract addresses", async () => {
    const r = await main(hre);
    const vec = readVector("eip712");
    expect(r.addresses.ledger).to.equal(vec.domain.verifyingContract);
    expect(r.addresses.verifierRegistry).to.equal(vec.notice.domain.verifyingContract);
    expect(await r.registry.ledger()).to.equal(r.addresses.ledger);
    expect(await r.registry.tally()).to.equal(r.addresses.tally);
    expect(await r.ledger.registry()).to.equal(r.addresses.registry);
    const file = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(file.chainId).to.equal(114);
    expect(file.contracts.BallotLedger).to.equal(r.addresses.ledger);
    expect(JSON.stringify(file)).to.not.match(/private|key":/i);
  });

  it("is git-ignored output: deployments/hardhat.json is not committed", () => {
    const gi = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".gitignore"), "utf8");
    expect(gi).to.include("packages/ledger/deployments/hardhat.json");
    expect(gi).to.match(/^\.env$/m);
  });

  it("refuses to run with no deployer account (Coston2 without DEPLOYER_PRIVATE_KEY) and sends nothing", async () => {
    const fake = { network: { name: "coston2" }, ethers: { getSigners: async () => [], provider: {} } };
    await expect(preflight(fake)).to.be.rejectedWith(/DEPLOYER_PRIVATE_KEY.*Nothing was sent/s);
    await expect(main(fake)).to.be.rejectedWith(/Nothing was sent/);
  });

  it("refuses the wrong chain ID", async () => {
    const fake = {
      network: { name: "coston2" },
      ethers: { getSigners: async () => [{}], provider: { getNetwork: async () => ({ chainId: 1n }) } },
    };
    await expect(preflight(fake)).to.be.rejectedWith(/Expected chain ID 114.*got 1/);
  });

  it("refuses an unfunded live deployer", async () => {
    const fake = {
      network: { name: "coston2" },
      ethers: {
        getSigners: async () => [{ address: "0x0000000000000000000000000000000000000001" }],
        provider: { getNetwork: async () => ({ chainId: 114n }), getBalance: async () => 0n },
      },
    };
    await expect(main(fake)).to.be.rejectedWith(/no balance.*Nothing was sent/s);
  });

  it("the Coston2 network config reads the key only from the environment", () => {
    const cfg = require("../hardhat.config.js");
    expect(cfg.networks.coston2.chainId).to.equal(114);
    expect(cfg.networks.hardhat.chainId).to.equal(114);
    const src = fs.readFileSync(path.join(__dirname, "..", "hardhat.config.js"), "utf8");
    expect(src).to.include("process.env.DEPLOYER_PRIVATE_KEY");
    expect(src).to.not.match(/0x[0-9a-fA-F]{64}/);
  });
});
