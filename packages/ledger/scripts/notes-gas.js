// ElectionNotes gas measurement on the in-process Hardhat network (chain ID 114). Nothing is sent to a live network,
// and no key from .env is used (the four contracts and ElectionNotes are deployed by Hardhat's public test account #0).
//   npx hardhat run scripts/notes-gas.js            (prints JSON; writes notes-gas-report.json)
// Optional: GAS_PRICES_GWEI="1152.13,522" to also print C2FLR at those prices, plus the estimate + 30% cap.
const fs = require("fs");
const path = require("path");
const h = require("../test/helpers");
const { ethers } = h;

const PER_Q = [
  { valid: 7, blank: 0, overvote: 0, unclear: 0 },
  { valid: 7, blank: 0, overvote: 0, unclear: 0 },
];
// Same lengths as the QB1TTH plan: site-hosted note / record manifest pointers.
const NOTE_CID = "https://beingsvote.live/data/records/BEINGS-2026-QB1TTH/notes/organizer-note-1.json";
const MANIFEST_CID = "https://beingsvote.live/data/records/BEINGS-2026-QB1TTH/manifest.json";

async function main() {
  const ctx = await h.setup();
  const deployer = ctx.signers[0];
  const F = await ethers.getContractFactory("ElectionNotes", deployer);
  const notes = await F.deploy(await ctx.registry.getAddress());
  const deployRc = await notes.deploymentTransaction().wait();
  const art = await require("hardhat").artifacts.readArtifact("ElectionNotes");

  const key = await h.openElection(ctx);
  await ctx.registry.connect(ctx.organizer).closeElection(key);
  await ctx.tally.connect(ctx.organizer).postTally(key, ethers.id("root"), PER_Q, 7, 0, 0, "local-unpublished:x", ethers.id("results"));
  const org = notes.connect(ctx.organizer);
  const g = async (p) => Number((await (await p).wait()).gasUsed);
  const rows = {
    deploy: Number(deployRc.gasUsed),
    firstNote_noName: await g(org.postNote(key, 1, ethers.id("note-1"), NOTE_CID)),
    secondNote_manifest_noName: await g(org.postNote(key, 1, ethers.id("manifest-1"), MANIFEST_CID)),
    thirdNote_64byteName: await g(org.postNoteWithName(key, 1, ethers.id("note-3"), NOTE_CID, "x".repeat(64))),
  };
  const out = {
    network: "hardhat (in-process, chainId 114)",
    compiler: "solc 0.8.24, optimizer 200 runs, evm london",
    runtimeBytecodeBytes: (art.deployedBytecode.length - 2) / 2,
    gas: rows,
    cidBytes: { note: NOTE_CID.length, manifest: MANIFEST_CID.length },
  };
  const prices = (process.env.GAS_PRICES_GWEI || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (prices.length) {
    out.costC2FLR = {};
    for (const p of prices) {
      const wei = ethers.parseUnits(p, "gwei");
      const fmt = (gas) => ethers.formatEther(BigInt(gas) * wei);
      const cap = (gas) => ethers.formatEther((BigInt(gas) * wei * 130n) / 100n);
      out.costC2FLR[`${p} gwei`] = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { estimate: fmt(v), capPlus30: cap(v) }]));
    }
  }
  fs.writeFileSync(path.join(__dirname, "..", "notes-gas-report.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
