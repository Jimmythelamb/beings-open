// Shared test helpers. Core (@beings/core) is an ES module built to dist/, so it is loaded with dynamic import.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;
const { deployAll } = require("../scripts/lib/deploy-lib");

const VECTOR_DIR = path.join(__dirname, "..", "..", "core", "test-vectors");
const readVector = (name) => JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, `${name}.json`), "utf8"));

let corePromise;
const loadCore = () => (corePromise ??= import("@beings/core"));

const ONE_DAY = 86400;
const REASON = { None: 0, "faint-mark": 1, erasure: 2, "stray-mark": 3, "glare-or-alignment": 4, "phone-misread": 5, other: 6 };
const STATUS = { None: 0, Setup: 1, Open: 2, Closed: 3, Tallied: 4 };
const ZERO32 = "0x" + "00".repeat(32);

const hex = (h) => (h.startsWith("0x") ? h : "0x" + h);

/**
 * Fresh chain (chain ID 114, nonce 0 for account #0), all contracts deployed in the documented order, plus the
 * core test-vector wallets funded and connected. Call once per file in `before`, then use `snapshotHooks`.
 */
async function setup() {
  await network.provider.send("hardhat_reset");
  const core = await loadCore();
  const vec = {
    eip712: readVector("eip712"),
    codes: readVector("codes"),
    merkle: readVector("merkle"),
    tally: readVector("tally"),
    reconcile: readVector("reconcile"),
  };
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const d = await deployAll(ethers, deployer);

  const wallets = {};
  for (const [name, w] of Object.entries(vec.eip712.wallets)) {
    wallets[name] = new ethers.Wallet(w.privateKey, ethers.provider);
    await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
  }
  const key = {
    election: core.electionKey(vec.codes.electionCode),
    ballot: (i) => core.ballotKey(vec.codes.ballots[i].ballotCode),
  };
  return {
    core,
    vec,
    deployer,
    organizer: signers[1],
    outsider: signers[2],
    signers,
    wallets,
    ...d,
    key,
    domain: core.eip712Domain({ chainId: 114, verifyingContract: d.addresses.ledger }),
    noticeDomain: core.eip712Domain({ chainId: 114, verifyingContract: d.addresses.verifierRegistry }),
  };
}

/** mocha hooks: snapshot after `before`, restore before each test. Use after `before(async () => ctx = await setup())`. */
function snapshotHooks() {
  let id;
  before(async () => {
    id = await network.provider.send("evm_snapshot");
  });
  beforeEach(async () => {
    await network.provider.send("evm_revert", [id]);
    id = await network.provider.send("evm_snapshot");
  });
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/** createElection with the vector election code. Organizer = ctx.organizer. Returns the election key. */
async function createElection(ctx, o = {}) {
  const t = await now();
  const p = {
    ballotCount: 8,
    registeredVoters: 6,
    quorum: 1,
    opensAt: t - 10,
    closesAt: t + ONE_DAY,
    ballotListRoot: ctx.vec.merkle.ballotListRoot.root,
    code: ctx.vec.codes.electionCode,
    ...o,
  };
  await ctx.registry
    .connect(o.from || ctx.organizer)
    .createElection(p.code, "bafy-election-file", ethers.id("election-file"), p.ballotCount, p.registeredVoters, p.quorum, p.opensAt, p.closesAt, p.ballotListRoot);
  return ctx.core.electionKey(p.code);
}

/** Create, register devices (device1, device2) and the reviewer, and open. */
async function openElection(ctx, o = {}) {
  const key = await createElection(ctx, o);
  const reg = ctx.registry.connect(ctx.organizer);
  await reg.registerDevice(key, ctx.wallets.device1.address, ethers.id("app-1"));
  await reg.registerDevice(key, ctx.wallets.device2.address, ethers.id("app-1"));
  await reg.registerReviewer(key, ctx.wallets.reviewer.address);
  await reg.openElection(key);
  return key;
}

const QUESTION_ORDER = ["q1", "q2"];

/**
 * Build a Submission (the BallotLedger struct) for ballot index `i` with `results` (object qid -> result).
 * `readers` = wallets that sign matching readings; `reviewer` = wallet that signs a Review (optional).
 */
async function buildSubmission(ctx, i, results, { readers = [ctx.wallets.device1], reviewer, imageTag } = {}) {
  const { core, vec } = ctx;
  const electionCode = vec.codes.electionCode;
  const ballotCode = vec.codes.ballots[i].ballotCode;
  const imageSha256 = core.sha256Hex(imageTag || `image-${i}`);
  const fillScores = { q1: { c1: 90, c2: 1, c3: 0 }, q2: { c1: 1, c2: 90 } };
  const input = { electionCode, ballotCode, results, imageSha256, fillScores, questionOrder: QUESTION_ORDER };
  const readings = [];
  for (const w of readers) {
    readings.push({
      device: w.address,
      imageSha256: hex(imageSha256),
      scoresHash: core.scoresHash(fillScores),
      sig: await core.signReading(w, input, ctx.domain),
    });
  }
  let reviewerAddr = ethers.ZeroAddress;
  let reviewerSig = "0x";
  if (reviewer) {
    reviewerAddr = reviewer.address;
    reviewerSig = await core.signReview(reviewer, { electionCode, ballotCode, results, questionOrder: QUESTION_ORDER }, ctx.domain);
  }
  return {
    electionKey: core.electionKey(electionCode),
    ballotKey: core.ballotKey(ballotCode),
    results: core.encodeResults(results, QUESTION_ORDER),
    imageSha256: hex(imageSha256),
    recordSha256: hex(core.sha256Hex(`record-${i}`)),
    readings,
    reviewer: reviewerAddr,
    reviewerSig,
    _input: input,
  };
}

/** Strip test-only fields before sending to the contract. */
const toStruct = ({ _input, ...s }) => s;

function correction(ctx, i, o = {}) {
  return {
    ballotKey: ctx.key.ballot(i),
    prevIndex: 0,
    questionIndex: 0,
    fromResult: "U",
    toResult: "V:c2",
    reason: REASON["faint-mark"],
    evidenceSha256: ZERO32,
    by: ctx.wallets.reviewer.address,
    at: 0,
    ...o,
  };
}

async function gasOf(txPromise) {
  const rc = await (await txPromise).wait();
  return Number(rc.gasUsed);
}

module.exports = {
  hre,
  ethers,
  network,
  loadCore,
  readVector,
  setup,
  snapshotHooks,
  now,
  createElection,
  openElection,
  buildSubmission,
  toStruct,
  correction,
  gasOf,
  ONE_DAY,
  REASON,
  STATUS,
  ZERO32,
  QUESTION_ORDER,
  hex,
};
