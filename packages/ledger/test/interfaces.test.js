// Sanity checks that the interface artifacts compile and expose the functions the spec lists (spec section 10).
const { expect } = require("chai");
const hre = require("hardhat");

const expected = {
  IElectionRegistry: ["createElection", "postVersion", "registerDevice", "registerReviewer", "openElection", "closeElection", "markTallied", "noticeImagesRetired", "latestVersion", "versionCount"],
  IBallotLedger: ["submitRecord", "submitBatch", "postCorrection", "markSpoiled", "recordCount", "spoiledCount", "correctionCount"],
  ITally: ["postTally", "clearReview", "postAmendedTally", "isFinal", "verifyInclusion"],
  IVerifierRegistry: ["register", "reportVerification", "reportVerificationSigned"],
};

describe("contract interfaces", () => {
  for (const [name, fns] of Object.entries(expected)) {
    it(`${name} exposes the spec functions`, async () => {
      const artifact = await hre.artifacts.readArtifact(name);
      const have = artifact.abi.filter((x) => x.type === "function").map((x) => x.name);
      for (const f of fns) expect(have, f).to.include(f);
    });
  }

  it("BallotLedger Reading type string matches @beings/core", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../contracts/interfaces/IBallotLedger.sol"), "utf8");
    expect(src).to.include("Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)");
  });

  it("targets Coston2 (chain ID 114)", () => {
    expect(hre.config.networks.coston2.chainId).to.equal(114);
    expect(hre.config.solidity.compilers[0].settings.evmVersion).to.equal("london");
  });
});
