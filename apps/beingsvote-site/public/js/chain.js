// Read-only access to the B.E.I.N.G.S. contracts on Coston2. No wallet is needed for anything in this file.
import { CONFIG, contractAddress, contractSets, contractSetsForRead } from "./config.js";
import { ABI, STATUS } from "./abi.js";
import { canonicalize, sha256Hex, normalizeElectionCode } from "./format.js";

let ethersPromise;
/** Load ethers v6: CDN first (with an integrity hash), then the copy served by this site. */
export function loadEthers() {
  if (window.ethers) return Promise.resolve(window.ethers);
  if (ethersPromise) return ethersPromise;
  const add = (src, integrity) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      if (integrity) {
        s.integrity = integrity;
        s.crossOrigin = "anonymous";
      }
      s.onload = () => (window.ethers ? resolve(window.ethers) : reject(new Error("ethers did not initialise")));
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(s);
    });
  ethersPromise = add(CONFIG.ethers.cdn, CONFIG.ethers.integrity)
    .catch(() => add(CONFIG.ethers.local))
    .catch((e) => {
      ethersPromise = undefined;
      throw e;
    });
  return ethersPromise;
}

let bundlesPromise;
/** One ethers bundle per contract set. Index 0 is the current set, which is the only set writes use. */
async function loadBundles() {
  if (bundlesPromise) return bundlesPromise;
  bundlesPromise = (async () => {
    const ethers = await loadEthers();
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
    const make = (addr, abi) => new ethers.Contract(addr, abi, provider);
    const notes = CONFIG.notesContract ? make(CONFIG.notesContract, ABI.notes) : null;
    return contractSets().map((set) => ({
      id: set.id,
      deployBlock: set.deployBlock,
      contracts: set.contracts,
      ethers,
      provider,
      registry: make(set.contracts.registry, ABI.registry),
      ledger: make(set.contracts.ledger, ABI.ledger),
      tally: make(set.contracts.tally, ABI.tally),
      verifiers: make(set.contracts.verifiers, ABI.verifiers),
      notes,
    }));
  })().catch((e) => {
    bundlesPromise = undefined;
    throw e;
  });
  return bundlesPromise;
}

async function getCtx() {
  const [current] = await loadBundles();
  return current;
}

async function bundlesFor(hint) {
  const all = await loadBundles();
  return contractSetsForRead(hint).map((set) => all.find((b) => b.id === set.id)).filter(Boolean);
}

async function bundleForElection(election) {
  const all = await loadBundles();
  const id = election?.contractSet?.id;
  if (!id) return all[0];
  return all.find((b) => b.id === id) ?? all[0];
}

function describeSet(bundle) {
  return { id: bundle.id, deployBlock: bundle.deployBlock, contracts: bundle.contracts };
}

export const getEthers = loadEthers;
export const getProvider = async () => (await getCtx()).provider;
export const getContracts = getCtx;

export async function electionKeyOf(code) {
  const { ethers } = await getCtx();
  return ethers.keccak256(ethers.toUtf8Bytes(code));
}
export async function ballotKeyOf(strictCode) {
  const { ethers } = await getCtx();
  return ethers.keccak256(ethers.toUtf8Bytes(strictCode));
}
export async function latestBlock() {
  return (await getCtx()).provider.getBlockNumber();
}

// ------------------------------------------------------------------ block explorer logs
// The public RPC refuses log searches wider than 30 blocks, so event history comes from the explorer's
// Etherscan-style API (read-only). Every number we compute from it is cross-checked against contract reads.
async function explorerLogs({ address, topic0, topic1, fromBlock }) {
  const out = [];
  let from = fromBlock;
  for (let page = 0; page < 50; page++) {
    const u = new URL("/api", CONFIG.explorer);
    u.search = new URLSearchParams({
      module: "logs",
      action: "getLogs",
      address,
      fromBlock: String(from),
      toBlock: "latest",
      topic0,
      ...(topic1 ? { topic1, topic0_1_opr: "and" } : {}),
    }).toString();
    const res = await fetch(u, { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.result)) {
      if (/no logs found/i.test(j.message ?? "")) break;
      throw new Error(`explorer: ${j.message ?? "unexpected answer"}`);
    }
    out.push(...j.result);
    if (j.result.length < 1000) break;
    from = parseInt(j.result[j.result.length - 1].blockNumber, 16) + 1; // next page
  }
  return out;
}

async function decodeLogs(contract, eventName, rawLogs) {
  const iface = contract.interface;
  const out = [];
  for (const l of rawLogs) {
    try {
      const parsed = iface.parseLog({ topics: l.topics.filter(Boolean), data: l.data });
      if (parsed && parsed.name === eventName) out.push({ args: parsed.args, block: parseInt(l.blockNumber, 16), tx: l.transactionHash });
    } catch {
      /* not ours */
    }
  }
  return out;
}

// ------------------------------------------------------------------ elections
let knownCache;
async function knownElections() {
  if (!knownCache) {
    knownCache = fetch(CONFIG.knownElectionsUrl, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : { elections: [] }))
      .then((j) => j.elections ?? [])
      .catch(() => []);
  }
  return knownCache;
}

/** Codes of every election we can find: the bundled list plus every ElectionCreated event on the current registry and each legacy registry. */
export async function discoverElections() {
  const bundles = await loadBundles();
  const map = new Map();
  for (const k of await knownElections()) map.set(k.code, { code: k.code, file: k.file, record: k.record, ...(k.set ? { set: k.set } : {}) });
  let discovered = true;
  for (const c of bundles) {
    try {
      const logs = await explorerLogs({ address: c.contracts.registry, topic0: c.registry.interface.getEvent("ElectionCreated").topicHash, fromBlock: c.deployBlock });
      for (const e of await decodeLogs(c.registry, "ElectionCreated", logs)) {
        const code = e.args.electionCode;
        const prev = map.get(code);
        if (!prev) map.set(code, { code, set: c.id });
        else if (!prev.set) prev.set = c.id;
      }
    } catch {
      discovered = false;
    }
  }
  return { elections: [...map.values()], discovered };
}

const toNum = (x) => Number(x);

/** On-chain summary of one election, or null if the code is not on the current ledger or any legacy ledger.
 *  `hint.set` (or a registry address) is tried first when the caller already knows the deployment. */
export async function getElection(codeInput, hint = {}) {
  const code = normalizeElectionCode(codeInput);
  if (!code) throw new Error("That doesn't look like an election code. They look like BEINGS-2026-ABC123.");
  const key = await electionKeyOf(code);
  const bundles = await bundlesFor(hint);
  let lastError = null;
  for (const c of bundles) {
    let e;
    try {
      e = await c.registry.elections(key);
    } catch (err) {
      lastError = err;
      continue;
    }
    const status = toNum(e.status);
    if (status === 0) continue;
    let poolEnforced = false;
    let addedRoots = [];
    try {
      poolEnforced = Boolean(await c.registry.poolEnforced(key));
      if (poolEnforced) {
        const n = toNum(await c.registry.ballotRootCount(key));
        for (let i = 1; i < n; i++) addedRoots.push(await c.registry.ballotRootAt(key, i));
      }
    } catch {
      poolEnforced = false;
      addedRoots = [];
    }
    const [version, recordCount, spoiledCount, correctionCount, resultCount, deviceCount] = await Promise.all([
      c.registry.latestVersion(key),
      c.ledger.recordCount(key),
      c.ledger.spoiledCount(key),
      c.ledger.correctionCount(key),
      c.tally.resultCount(key),
      c.registry.deviceCount(key),
    ]);
    return {
      code,
      key,
      file: hint.file,
      record: hint.record,
      contractSet: describeSet(c),
      organizer: e.organizer,
      status,
      statusName: STATUS[status],
      ballotCount: toNum(e.ballotCount),
      registeredVoters: toNum(e.registeredVoters),
      quorum: toNum(e.quorum),
      opensAt: toNum(e.opensAt),
      closesAt: toNum(e.closesAt),
      ballotListRoot: e.ballotListRoot,
      version: { cid: version.cid, fileSha256: version.fileSha256, postedAt: toNum(version.postedAt) },
      recordCount: toNum(recordCount),
      spoiledCount: toNum(spoiledCount),
      correctionCount: toNum(correctionCount),
      resultCount: toNum(resultCount),
      deviceCount: toNum(deviceCount),
      poolEnforced,
      addedRoots,
    };
  }
  if (lastError) throw lastError;
  return null;
}

/** True when this registry has the ballot-pool flag. An older deployed registry reverts the call, which means it does not. */
export async function registrySupportsBallotPool() {
  try {
    const c = await getCtx();
    await c.registry.poolEnforced(`0x${"00".repeat(32)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The election file (question text, choice names). Order tried: the ledger's CID (if it is an IPFS CID), then the
 * public copy shipped with this site. Result: { file, source, check } where check is
 * "verified" (fingerprint matches the ledger), "mismatch", or "unverifiable".
 */
export async function loadElectionFile(election) {
  const cid = election.version.cid;
  const ipfs = /^ipfs:\/\/(.+)$/.exec(cid)?.[1] ?? (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})/.test(cid) ? cid : null);
  if (ipfs) {
    try {
      const res = await fetch(CONFIG.ipfsGateway + ipfs, { referrerPolicy: "no-referrer" });
      if (res.ok) {
        const file = await res.json();
        const sha = "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(file))));
        return { file, source: "ipfs", check: sha === election.version.fileSha256.toLowerCase() ? "verified" : "mismatch" };
      }
    } catch {
      /* fall through to the bundled copy */
    }
  }
  if (election.file) {
    try {
      const res = await fetch(election.file, { cache: "no-cache" });
      if (res.ok) {
        const j = await res.json();
        const file = j.file ?? j;
        if (j.publicCopy) return { file, source: "site-copy", check: "unverifiable", note: j.note, omitted: j.omitted };
        const sha = "0x" + (await sha256Hex(new TextEncoder().encode(canonicalize(file))));
        return { file, source: "site-copy", check: sha === election.version.fileSha256.toLowerCase() ? "verified" : "mismatch" };
      }
    } catch {
      /* none */
    }
  }
  return null;
}

/** Latest official tally: { version, finality, failedChecks, merkleRoot, recon, perQuestion[], postedAt } or null. */
export async function getTally(election, questionCount) {
  if (election.resultCount === 0) return null;
  const c = await bundleForElection(election);
  const version = election.resultCount;
  const r = await c.tally.getResult(election.key, version);
  const perQuestion = await Promise.all(
    Array.from({ length: questionCount }, async (_, i) => {
      const q = await c.tally.perQuestion(election.key, version, i);
      return { valid: toNum(q.valid), blank: toNum(q.blank), overvote: toNum(q.overvote), unclear: toNum(q.unclear) };
    }),
  );
  const recon = r.recon;
  return {
    version,
    final: toNum(r.finality) === 1,
    failedChecks: toNum(r.failedChecks),
    merkleRoot: r.merkleRoot,
    postedAt: toNum(r.postedAt),
    resultsCid: r.resultsCid,
    resultsSha256: r.resultsSha256,
    recon: Object.fromEntries(["registered", "printed", "issued", "cast", "spoiled", "unusedReturned", "unissued"].map((k) => [k, toNum(recon[k])])),
    perQuestion,
  };
}

/** Every ballot's ledger entry and every correction for an election, from the chain's event history. */
export async function loadLedgerHistory(election) {
  const c = await bundleForElection(election);
  const [accepted, corrected] = await Promise.all([
    explorerLogs({ address: c.contracts.ledger, topic0: c.ledger.interface.getEvent("BallotAccepted").topicHash, topic1: election.key, fromBlock: c.deployBlock }),
    explorerLogs({ address: c.contracts.ledger, topic0: c.ledger.interface.getEvent("CorrectionPosted").topicHash, topic1: election.key, fromBlock: c.deployBlock }),
  ]);
  const records = {};
  const details = {};
  for (const e of await decodeLogs(c.ledger, "BallotAccepted", accepted)) {
    records[e.args.ballotKey] = e.args.results;
    details[e.args.ballotKey] = { results: e.args.results, imageSha256: e.args.imageSha256, recordSha256: e.args.recordSha256, reviewed: e.args.reviewed };
  }
  const corrections = (await decodeLogs(c.ledger, "CorrectionPosted", corrected)).map((e) => ({
    ballotKey: e.args.ballotKey,
    index: toNum(e.args.index),
    questionIndex: toNum(e.args.questionIndex),
    toResult: e.args.toResult,
  }));
  return { records, details, corrections };
}

export async function getVerifierMetrics(electionOrKey) {
  const key = typeof electionOrKey === "string" ? electionOrKey : electionOrKey?.key;
  const c = await bundleForElection(typeof electionOrKey === "string" ? null : electionOrKey);
  const m = await c.verifiers.metrics(key);
  return {
    nodeCount: toNum(m.nodeCount),
    nodesAllAgree: toNum(m.nodesAllAgree),
    nodesWithDisagreement: toNum(m.nodesWithDisagreement),
    checked: Number(m.ballotQuestionsChecked),
    agreed: Number(m.ballotQuestionsAgreed),
  };
}

// ------------------------------------------------------------------ one ballot
/** The ledger's entry for one ballot code (strict 12-character form), including any corrections. null = not recorded. */
export async function getBallotEntry(election, strictBallotCode, questionCount) {
  const c = await bundleForElection(election);
  const bKey = await ballotKeyOf(strictBallotCode);
  const [rec, wasSpoiled] = await Promise.all([c.ledger.records(election.key, bKey), c.ledger.spoiled(election.key, bKey)]);
  const acceptedAt = toNum(rec.acceptedAt);
  if (acceptedAt === 0) return { found: false, ballotKey: bKey, spoiled: wasSpoiled };
  const heads = await Promise.all(Array.from({ length: questionCount }, (_, i) => c.ledger.head(election.key, bKey, i)));
  const corrections = [];
  for (let q = 0; q < heads.length; q++) {
    const idx = toNum(heads[q]);
    if (idx > 0) {
      const cor = await c.ledger.corrections(election.key, idx - 1);
      corrections.push({ questionIndex: q, index: idx, from: cor.fromResult, to: cor.toResult, reason: toNum(cor.reason), at: toNum(cor.at) });
    }
  }
  return {
    found: true,
    ballotKey: bKey,
    results: rec.results,
    imageSha256: rec.imageSha256,
    recordSha256: rec.recordSha256,
    acceptedAt,
    reviewed: rec.reviewed,
    spoiled: wasSpoiled,
    corrections,
  };
}

// ------------------------------------------------------------------ roles (used by roles.js)
export async function readRoleFacts(address, elections) {
  const bundles = await loadBundles();
  const c = bundles[0];
  const deployer = await c.registry.deployer();
  let node = { name: "", infoCid: "", registeredAt: 0 };
  for (const b of bundles) {
    try {
      const n = await b.verifiers.nodes(address);
      if (toNum(n.registeredAt) > 0) {
        node = n;
        break;
      }
    } catch {
      /* try the next verifier registry */
    }
  }
  const perElection = await Promise.all(
    elections.map(async (el) => {
      const b = await bundleForElection(el);
      const [e, role] = await Promise.all([b.registry.elections(el.key), b.registry.roles(el.key, address)]);
      return { code: el.code, key: el.key, organizer: e.organizer, role: toNum(role) };
    }),
  );
  return { deployer, node: { name: node.name, registeredAt: toNum(node.registeredAt) }, perElection };
}

export const REASONS = ["None", "Faint mark", "Erasure", "Stray mark", "Glare or alignment", "Phone misread", "Other"];


// ------------------------------------------------------------------ staff screens (read side)
// Everything below only reads. Writes live in tx.js and go through the connected wallet.

/** Ballots the organizer marked spoiled (BallotSpoiled events) for one election: [{ ballotKey, replacedByKey }]. */
export async function loadSpoiled(election) {
  const c = await bundleForElection(election);
  const logs = await explorerLogs({ address: c.contracts.ledger, topic0: c.ledger.interface.getEvent("BallotSpoiled").topicHash, topic1: election.key, fromBlock: c.deployBlock });
  return (await decodeLogs(c.ledger, "BallotSpoiled", logs)).map((e) => ({ ballotKey: e.args.ballotKey, replacedByKey: e.args.replacedByKey }));
}

/** Scanning phones and reviewers registered for an election, from the registry's events, each re-checked with a contract read. */
export async function loadElectionStaff(election) {
  const c = await bundleForElection(election);
  const [dev, rev] = await Promise.all(
    ["DeviceRegistered", "ReviewerRegistered"].map((name) =>
      explorerLogs({ address: c.contracts.registry, topic0: c.registry.interface.getEvent(name).topicHash, topic1: election.key, fromBlock: c.deployBlock }).then((l) => decodeLogs(c.registry, name, l)),
    ),
  );
  const devices = await Promise.all(dev.map(async (e) => ({ address: e.args.device, appHash: e.args.appHash, tx: e.tx, role: toNum(await c.registry.roles(election.key, e.args.device)) })));
  const reviewers = await Promise.all(rev.map(async (e) => ({ address: e.args.reviewer, tx: e.tx, role: toNum(await c.registry.roles(election.key, e.args.reviewer)) })));
  return { devices: devices.filter((d) => d.role === 1), reviewers: reviewers.filter((r) => r.role === 2) };
}

/** Pending / past review requests on the tally (ReviewRequired and ReviewCleared events). */
export async function loadReviewEvents(election) {
  const c = await bundleForElection(election);
  const [req, clr] = await Promise.all(
    ["ReviewRequired", "ReviewCleared"].map((name) =>
      explorerLogs({ address: c.contracts.tally, topic0: c.tally.interface.getEvent(name).topicHash, topic1: election.key, fromBlock: c.deployBlock }).then((l) => decodeLogs(c.tally, name, l)),
    ),
  );
  return {
    required: req.map((e) => ({ version: toNum(e.args.version), failedChecks: toNum(e.args.failedChecks), tx: e.tx })),
    cleared: clr.map((e) => ({ version: toNum(e.args.version), reviewer: e.args.reviewer, clearanceCid: e.args.clearanceCid, tx: e.tx })),
  };
}

/** Every address that ever registered as a verifier (NodeRegistered events), each re-read from the registry. */
export async function loadVerifierNodes() {
  const bundles = await loadBundles();
  const seen = new Map();
  for (const c of bundles) {
    try {
      const logs = await explorerLogs({ address: c.contracts.verifiers, topic0: c.verifiers.interface.getEvent("NodeRegistered").topicHash, fromBlock: c.deployBlock });
      const events = await decodeLogs(c.verifiers, "NodeRegistered", logs);
      for (const e of events) {
        const addr = e.args.node.toLowerCase();
        if (!seen.has(addr)) seen.set(addr, { e, c });
      }
    } catch {
      /* one registry's history can fail without hiding the others */
    }
  }
  return Promise.all(
    [...seen.values()].map(async ({ e, c }) => {
      const n = await c.verifiers.nodes(e.args.node);
      return { address: e.args.node, name: n.name, infoCid: n.infoCid, registeredAt: toNum(n.registeredAt), tx: e.tx };
    }),
  );
}

/** Verification reports published on-chain for an election (VerificationReported events). */
export async function loadVerifierReports(election) {
  const c = await bundleForElection(election);
  const logs = await explorerLogs({ address: c.contracts.verifiers, topic0: c.verifiers.interface.getEvent("VerificationReported").topicHash, topic1: election.key, fromBlock: c.deployBlock });
  return (await decodeLogs(c.verifiers, "VerificationReported", logs)).map((e) => ({
    node: e.args.node,
    tallyVersion: toNum(e.args.tallyVersion),
    reportCid: e.args.reportCid,
    checked: Number(e.args.ballotQuestionsChecked),
    agreed: Number(e.args.ballotQuestionsAgreed),
    tallyMatches: e.args.tallyMatches,
    reconciliationMatches: e.args.reconciliationMatches,
    merkleMatches: e.args.merkleMatches,
    tx: e.tx,
  }));
}

/** One wallet's facts: is it a verifier, what role has it in this election, is it the deployer. */
export async function getWalletFacts(address, election) {
  const bundles = await loadBundles();
  const current = bundles[0];
  const electionBundle = election ? await bundleForElection(election) : current;
  let node = { name: "", registeredAt: 0 };
  for (const b of bundles) {
    try {
      const n = await b.verifiers.nodes(address);
      if (toNum(n.registeredAt) > 0) {
        node = n;
        break;
      }
    } catch {
      /* try the next verifier registry */
    }
  }
  const [deployer, role] = await Promise.all([current.registry.deployer(), election ? electionBundle.registry.roles(election.key, address) : 0]);
  return {
    verifier: toNum(node.registeredAt) > 0 ? { name: node.name, registeredAt: toNum(node.registeredAt) } : null,
    deployer: deployer.toLowerCase() === address.toLowerCase(),
    role: toNum(role), // 0 none, 1 device, 2 reviewer
    isOrganizer: !!election && election.organizer.toLowerCase() === address.toLowerCase(),
  };
}

/**
 * Read-only facts for a delegated batch. Does not estimate `submitRecord`: that call reverts
 * without a device signature, and a missing estimate must stay missing rather than become zero.
 * `ballotKeys` are hashes already on the manifest. Ballot codes are not accepted here.
 */
export async function readDelegatedSnapshot(electionCode, scanner, ballotKeys) {
  const election = await getElection(electionCode);
  const c = election ? await bundleForElection(election) : await getCtx();
  if (!election) {
    return { chainId: CONFIG.chainId, missing: true, status: 0, scannerRole: 0, recordedBallotKeys: [], recordedResults: {}, fee: null, submitRecordGas: null, nextNonce: null };
  }
  const role = toNum(await c.registry.roles(election.key, scanner));
  const recordedResults = {};
  for (const key of ballotKeys) {
    const rec = await c.ledger.records(election.key, key);
    if (toNum(rec.acceptedAt) > 0) recordedResults[String(key).toLowerCase()] = rec.results;
  }
  let fee = null;
  let nextNonce = null;
  try {
    const fd = await c.ethers.provider.getFeeData();
    fee = {
      gasPriceWei: fd.gasPrice == null ? null : fd.gasPrice.toString(),
      maxFeePerGasWei: fd.maxFeePerGas == null ? null : fd.maxFeePerGas.toString(),
    };
  } catch {
    fee = null;
  }
  try {
    nextNonce = Number(await c.ethers.provider.getTransactionCount(scanner, "pending"));
  } catch {
    nextNonce = null;
  }
  return {
    chainId: CONFIG.chainId,
    missing: false,
    status: election.status,
    poolEnforced: election.poolEnforced === true,
    organizer: election.organizer,
    scannerRole: role,
    recordedBallotKeys: Object.keys(recordedResults),
    recordedResults,
    fee,
    submitRecordGas: null,
    nextNonce,
  };
}

/** Seconds a non-organizer must wait after closesAt before anyone can close an election. */
export async function getCloseGrace() {
  try {
    return toNum(await (await getCtx()).registry.CLOSE_GRACE());
  } catch {
    return 86400;
  }
}

/** Keccak-256 of bytes, as 0x hex (for the browser-side Merkle check). */
export async function keccakBytes(bytes) {
  return (await getCtx()).ethers.keccak256(bytes);
}

/** The last block's number and age, for the network health card. */
export async function getChainHead() {
  const c = await getCtx();
  const started = performance.now();
  const block = await c.provider.getBlock("latest");
  return { number: block.number, timestamp: Number(block.timestamp), latencyMs: Math.round(performance.now() - started) };
}

/** What each contract says about its neighbours, plus whether code is deployed at each address. */
export async function getWiringFacts() {
  const c = await getCtx();
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  const staffAddress = contractAddress("staff");
  const staff = staffAddress ? new c.ethers.Contract(staffAddress, ABI.staff, c.provider) : null;
  const [registryLedger, registryTally, ledgerRegistry, tallyRegistry, tallyLedger, deployer, grace, staffRegistry] = await Promise.all([
    safe(() => c.registry.ledger()),
    safe(() => c.registry.tally()),
    safe(() => c.ledger.registry()),
    safe(() => c.tally.registry()),
    safe(() => c.tally.ledger()),
    safe(() => c.registry.deployer()),
    safe(() => c.registry.CLOSE_GRACE()),
    staff ? safe(() => staff.registry()) : undefined,
  ]);
  const code = {};
  const addresses = staffAddress ? { ...CONFIG.contracts, staff: staffAddress } : CONFIG.contracts;
  await Promise.all(Object.entries(addresses).map(async ([k, a]) => (code[k] = (await safe(() => c.provider.getCode(a))) ?? "0x")));
  return { registryLedger, registryTally, ledgerRegistry, tallyRegistry, tallyLedger, deployer, closeGrace: grace == null ? null : toNum(grace), staffAddress: staffAddress || "", staffRegistry, hasCode: Object.fromEntries(Object.entries(code).map(([k, v]) => [k, v !== "0x"])) };
}

/** Is a same-origin or outside service answering at all? Any HTTP answer below 500 counts as reachable. */
export async function pingService(url, init = {}) {
  const started = performance.now();
  const doFetch = init.fetchImpl ?? fetch;
  const { fetchImpl: _fetchImpl, ...rest } = init;
  try {
    const res = await doFetch(url, { method: "GET", cache: "no-store", referrerPolicy: "no-referrer", ...rest });
    return { ok: res.status < 500, status: res.status, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), error: String(e?.message ?? e) };
  }
}

// ------------------------------------------------------------------ long-term record and officials' notes (record.js)
export const notesConfigured = () => Boolean(CONFIG.notesContract);

/** "organizer" | "device" | "reviewer" | "none" for `address` in this election, read from the registry. */
export async function registryRoleOf(election, address) {
  if (String(address).toLowerCase() === String(election.organizer).toLowerCase()) return "organizer";
  const c = await bundleForElection(election);
  return ["none", "device", "reviewer"][Number(await c.registry.roles(election.key, address))] ?? "none";
}

/**
 * The election's public record (manifest + files) from this site, with every fingerprint re-computed here.
 * Returns null if the election has no record. { manifest, manifestSha256, url, files: [{...entry, state}], notes: [{ path, note }], bytes: {path: Uint8Array} }.
 */
export async function loadElectionRecord(election) {
  if (!election.record) return null;
  const { manifestSha256, checkRecordFiles } = await import("./record.js");
  const res = await fetch(election.record, { cache: "no-cache" });
  if (!res.ok) throw new Error(`record manifest answered ${res.status}`);
  const manifestBytes = new Uint8Array(await res.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const base = new URL(election.record, location.href);
  const fetched = {};
  const bytes = { "manifest.json": manifestBytes };
  await Promise.all(
    (manifest.files ?? []).map(async (f) => {
      try {
        const r = await fetch(new URL(f.path, base), { cache: "no-cache" });
        if (!r.ok) return (fetched[f.path] = null);
        const b = new Uint8Array(await r.arrayBuffer());
        bytes[f.path] = b;
        fetched[f.path] = f.hashOf === "bytes" ? { bytes: b } : { json: JSON.parse(new TextDecoder().decode(b)) };
      } catch {
        fetched[f.path] = null;
      }
    }),
  );
  const files = await checkRecordFiles(manifest, fetched);
  const notes = files.filter((f) => f.role === "official-note" && fetched[f.path]?.json).map((f) => ({ path: f.path, note: fetched[f.path].json, state: f.state }));
  return { manifest, manifestSha256: await manifestSha256(manifest), url: base.href, files, notes, bytes };
}

/**
 * Which fingerprints are posted on the ElectionNotes contract for this election. Null when the contract isn't
 * configured. Result: { [sha]: { author, role, tallyVersion, postedAt } | null }.
 */
export async function getNoteAnchors(election, shas) {
  const c = await getCtx();
  if (!c.notes) return null;
  const out = {};
  await Promise.all(
    shas.map(async (sha) => {
      const i = Number(await c.notes.noteIndexPlusOne(election.key, sha));
      if (!i) return (out[sha] = null);
      const n = await c.notes.getNote(election.key, i - 1);
      out[sha] = { author: n.author, role: ["none", "organizer", "device", "reviewer"][Number(n.role)], tallyVersion: toNum(n.tallyVersion), postedAt: toNum(n.postedAt), index: i - 1 };
    }),
  );
  return out;
}

const STAFF_ROLES = ["admin", "officer", "verifier", "scanner", "system"];
const STAFF_KINDS = ["standard", "test", "classroom"];

/** On-chain staff roster for one election. `configured` is false until CONFIG.staffRegistry is set. */
export async function readStaffRoster(electionKey) {
  const address = contractAddress("staff");
  const empty = {
    configured: !!address,
    known: false,
    kind: "",
    locked: false,
    testAttested: false,
    certifiedStaffingReady: false,
    systemSignOffRecorded: false,
    systemSignOffCurrent: false,
    ballotHandlerCount: 0,
    seats: {},
    scannerWallets: [],
    address: address || "",
    electionId: electionKey,
  };
  if (!address) return empty;
  try {
    const { ethers, provider } = await getCtx();
    const c = new ethers.Contract(address, ABI.staff, provider);
    const report = await c.staffingReport(electionKey);
    const known = Boolean(report.known);
    let systemSignOffRecorded = Boolean(report.systemSignOffRecorded);
    let systemSignOffCurrent = false;
    if (known) {
      try {
        const note = await c.systemSignOff(electionKey);
        systemSignOffRecorded = Boolean(note.recorded);
        systemSignOffCurrent = Boolean(note.current);
      } catch {
        systemSignOffCurrent = false;
      }
    }
    const seats = {};
    const scannerWallets = [];
    if (known) {
      const n = Number(await c.positionCount(electionKey));
      for (let i = 0; i < n; i++) {
        const row = await c.positionAt(electionKey, i);
        const role = STAFF_ROLES[Number(row.role)] || "unknown";
        const seatNo = Number(row.seatNo);
        const id = seatNo <= 1 ? role : `${role}-${seatNo}`;
        const covered = Boolean(row.coveredByAdmin);
        seats[id] = { wallet: row.wallet, covered };
        if (role === "scanner" && row.wallet && row.wallet !== ethers.ZeroAddress && !covered) scannerWallets.push(row.wallet);
      }
    }
    return {
      ...empty,
      known,
      kind: STAFF_KINDS[Number(report.kind)] || "",
      testAttested: Boolean(report.testAttested),
      locked: Boolean(report.locked),
      lockedRosterHash: report.lockedRosterHash,
      currentRosterHash: report.currentRosterHash,
      certifiedStaffingReady: Boolean(report.certifiedStaffingReady),
      systemSignOffRecorded,
      systemSignOffCurrent,
      anyCovered: Boolean(report.anyCovered),
      ballotHandlerCount: Number(report.ballotHandlerCount || 0),
      seats,
      scannerWallets,
    };
  } catch {
    return empty;
  }
}
