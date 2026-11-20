// Delegated batch signing for one already-open Coston2 election.
// The browser never stores a server private key. Dry-run is the default.
// This file does not create elections, register scanners, open voting, or upload pictures.
import { CONFIG } from "./config.js";
import { canonicalize } from "./format.js";
import { readingTypedData, submitRecordArgs, utf8, isAddress, isBytes32, sameAddress } from "./logic.js";

export const GAS_RESERVE_BPS = 200;
export const OPERATIONS_BPS = 9800;
export const DEFAULT_CONTINGENCY_BPS = 2000;
export const MAX_SEND_ATTEMPTS = 3;

export const COSTON2_ALLOWLIST = {
  chainId: 114,
  registry: CONFIG.contracts.registry,
  ledger: CONFIG.contracts.ledger,
};

const FORBIDDEN = new Set(["ballotcode", "privatekey", "mnemonic", "seedphrase", "secret"]);

const deskBlock = "DESK8Q is already open. Only its registered scanner can sign, and a new scanner cannot be added after opening. This service address is not that scanner.";

export function manifestHash(manifest) {
  return canonicalize(manifest);
}

function walkForbidden(value, problems) {
  if (Array.isArray(value)) {
    for (const item of value) walkForbidden(item, problems);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key.toLowerCase())) problems.push(`Remove ${key} from the batch. Ballot codes and keys do not belong in it.`);
    walkForbidden(value[key], problems);
  }
}

function asWei(value) {
  try {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Problems that make the batch unauthorized. Does not talk to the network. */
export function validateManifest(manifest, now, allowlist = COSTON2_ALLOWLIST) {
  const problems = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, problems: ["This is not a batch authorization."] };
  }
  walkForbidden(manifest, problems);
  if (manifest.schemaVersion !== "1") problems.push("This batch uses an unsupported authorization version.");
  if (typeof manifest.batchId !== "string" || manifest.batchId.length < 8) problems.push("The batch needs a stable id.");
  if (typeof manifest.clientId !== "string" || !manifest.clientId.trim()) problems.push("The batch needs the client it belongs to.");
  if (typeof manifest.electionCode !== "string" || !manifest.electionCode.trim()) problems.push("The batch needs an election code.");
  if (manifest.chainId !== allowlist.chainId) problems.push("This service signs only on Coston2 (chain id 114).");
  const contracts = manifest.contracts ?? {};
  if (!isAddress(contracts.registry) || contracts.registry.toLowerCase() !== allowlist.registry.toLowerCase()) problems.push("The registry address is not the Coston2 registry.");
  if (!isAddress(contracts.ledger) || contracts.ledger.toLowerCase() !== allowlist.ledger.toLowerCase()) problems.push("The ledger address is not the Coston2 ledger.");
  if (!isAddress(manifest.scanner)) problems.push("The authorized scanner address is missing.");
  if (!Number.isInteger(manifest.expiresAt) || manifest.expiresAt <= now) problems.push("This batch authorization has expired.");
  const cap = asWei(manifest.gasCapWei);
  if (cap == null || cap <= 0n) problems.push("The batch needs a Coston2 gas cap in wei.");
  const contingency = manifest.contingencyBps == null ? DEFAULT_CONTINGENCY_BPS : manifest.contingencyBps;
  if (!Number.isInteger(contingency) || contingency < 0 || contingency > 10000) problems.push("The contingency rate is not a whole number from 0 to 10000.");
  if (!Number.isInteger(manifest.fiatMinorPerItem) || manifest.fiatMinorPerItem < 1) problems.push("Gas has no customer price yet. Nothing will be signed or sent.");
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) problems.push("The batch is empty.");
  const ids = new Set();
  const keys = new Set();
  for (const item of manifest.items ?? []) {
    if (!item || typeof item.itemId !== "string") {
      problems.push("Every ballot in the batch needs an item id.");
      continue;
    }
    if (ids.has(item.itemId)) problems.push("The same item id appears twice.");
    ids.add(item.itemId);
    if (!isBytes32(item.ballotKey)) problems.push(`${item.itemId} has no ballot hash.`);
    else if (keys.has(item.ballotKey.toLowerCase())) problems.push("The same ballot hash appears twice.");
    else keys.add(item.ballotKey.toLowerCase());
    if (typeof item.resultsString !== "string" || item.resultsString.length === 0) problems.push(`${item.itemId} has no result string.`);
    else if (item.resultsString.split("|").some((seg) => seg !== "B" && seg !== "O" && seg !== "U" && !/^V:c[1-9][0-9]{0,2}(?:\+c[1-9][0-9]{0,2})*$/.test(seg))) problems.push(`${item.itemId} has a result that this service will not rewrite or guess.`);
    if (!isBytes32(item.imageSha256)) problems.push(`${item.itemId} has no picture hash.`);
    if (!isBytes32(item.scoresHash)) problems.push(`${item.itemId} has no score hash.`);
    if (!isBytes32(item.recordSha256)) problems.push(`${item.itemId} has no record hash.`);
  }
  if (manifest.electionCode === "BEINGS-2026-SGN001") problems.push("BEINGS-2026-SGN001 is not approved for creation or recording.");
  return { ok: problems.length === 0, problems };
}

function poolProofProblems(items) {
  const problems = [];
  for (const item of items ?? []) {
    const id = item?.itemId ?? "A ballot";
    if (!Array.isArray(item?.proof) || item.proof.some((part) => !isBytes32(part))) problems.push(`${id} needs a Merkle proof for this election's ballot pool.`);
    if (!Number.isInteger(item?.rootIndex) || item.rootIndex < 0) problems.push(`${id} needs the ballot-pool root it belongs to.`);
  }
  return problems;
}

export function resultCounts(items) {
  const counts = { B: 0, O: 0, U: 0, V: 0 };
  for (const item of items) {
    for (const seg of String(item.resultsString ?? "").split("|")) {
      if (seg === "B" || seg === "O" || seg === "U") counts[seg] += 1;
      else if (seg.startsWith("V:")) counts.V += 1;
    }
  }
  return counts;
}

export function splitPrepaid(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) return null;
  const gas = Math.floor((amountMinor * GAS_RESERVE_BPS) / 10000);
  return { gas, operations: amountMinor - gas };
}

function normKey(value) {
  return String(value ?? "").toLowerCase();
}

function itemCostWei(chain, contingencyBps) {
  if (chain?.submitRecordGas == null || chain?.fee?.maxFeePerGasWei == null) return null;
  const gas = asWei(String(chain.submitRecordGas));
  const price = asWei(String(chain.fee.maxFeePerGasWei));
  if (gas == null || price == null || gas <= 0n || price <= 0n) return null;
  return (gas * price * BigInt(10000 + contingencyBps)) / 10000n;
}

/** How a ballot hash compares with the ledger: absent, exact match, conflicting result, or present without a result. */
export function ledgerMatch(chain, item) {
  if (!chain || !item?.ballotKey) return "absent";
  const want = normKey(item.ballotKey);
  if (chain.recordedResults && typeof chain.recordedResults === "object") {
    for (const [key, value] of Object.entries(chain.recordedResults)) {
      if (normKey(key) === want) return value === item.resultsString ? "match" : "conflict";
    }
  }
  if ((chain.recordedBallotKeys ?? []).some((key) => normKey(key) === want)) return "unknown";
  return "absent";
}

/** Organizer approval of one exact batch. This is not a ballot reading and does not replace the scanner's signature. */
export function batchApprovalTypedData(manifest, allowlist = COSTON2_ALLOWLIST) {
  return {
    domain: { name: "B.E.I.N.G.S.", version: "1", chainId: allowlist.chainId, verifyingContract: allowlist.registry },
    types: {
      BatchApproval: [
        { name: "manifestHash", type: "string" },
        { name: "clientId", type: "string" },
        { name: "electionCode", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "scanner", type: "address" },
        { name: "gasCapWei", type: "string" },
        { name: "contingencyBps", type: "uint256" },
        { name: "fiatMinorPerItem", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "BatchApproval",
    message: {
      manifestHash: manifestHash(manifest),
      clientId: manifest.clientId,
      electionCode: manifest.electionCode,
      chainId: manifest.chainId,
      scanner: manifest.scanner,
      gasCapWei: manifest.gasCapWei,
      contingencyBps: manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS,
      fiatMinorPerItem: manifest.fiatMinorPerItem,
      expiresAt: manifest.expiresAt,
    },
  };
}

/**
 * Plain-language readiness. `prepaid` is the client's own balance, never a faucet wallet.
 * `quote.fiatMinorPerItem` is optional and is not invented here.
 */
export function explainBatch({ manifest, chain, prepaid, quote, now, allowlist }) {
  const validation = validateManifest(manifest, now, allowlist);
  const blockers = [...validation.problems];
  const items = manifest?.items ?? [];
  const already = [];
  const todo = [];
  const mismatched = [];
  for (const item of items) {
    if (!item?.ballotKey) continue;
    const mark = ledgerMatch(chain, item);
    if (mark === "match") already.push(item);
    else if (mark === "conflict" || mark === "unknown") mismatched.push(item);
    else todo.push(item);
  }
  const counts = resultCounts(items);
  if (chain?.chainId != null && chain.chainId !== 114) blockers.push("The connected network is not Coston2. Nothing will be signed.");
  if (chain && !chain.missing && chain.status !== 2) blockers.push("Voting is not open. This service cannot register a scanner or open an election.");
  if (chain?.missing) blockers.push("This election is not on the ledger. This service cannot create one.");
  if (chain?.poolEnforced) blockers.push(...poolProofProblems(items));
  if (mismatched.length > 0) blockers.push("A ballot already on the ledger has a different result, or its stored result was not returned. It will not be replaced or signed again.");
  if (manifest?.electionCode === "BEINGS-2026-DESK8Q" && chain && !chain.missing && chain.scannerRole !== 1) blockers.push(deskBlock);
  else if (chain && !chain.missing && chain.status === 2 && chain.scannerRole !== 1) blockers.push("This service address is not a registered scanner for the open election. A scanner cannot be added after opening.");
  const rosterScanners = Array.isArray(chain?.approvedScanners) ? chain.approvedScanners : [];
  if (rosterScanners.length && !rosterScanners.some((a) => sameAddress(a, manifest?.scanner))) blockers.push("This service address is not an approved Scanner operator on the election roster. Nothing will be sent.");
  const contingency = manifest?.contingencyBps == null ? DEFAULT_CONTINGENCY_BPS : manifest.contingencyBps;
  const perItem = itemCostWei(chain, Number.isInteger(contingency) ? contingency : DEFAULT_CONTINGENCY_BPS);
  const estimatedWei = perItem == null ? null : perItem * BigInt(todo.length);
  const cap = asWei(manifest?.gasCapWei ?? "");
  if (estimatedWei == null && todo.length > 0 && validation.ok) blockers.push("The cost to record a ballot cannot be estimated yet. Nothing will be sent.");
  if (estimatedWei != null && cap != null && estimatedWei > cap) blockers.push("The estimated gas, including contingency, is over this batch's Coston2 cap.");
  const account = prepaid?.accounts?.[manifest?.clientId] ?? null;
  const split = account ? splitPrepaid(account.amountMinor) : null;
  if (!account || !split || typeof account.currency !== "string" || !account.currency) blockers.push("No prepaid balance is on file for this client. The faucet balance is not a customer budget, and the cost was not treated as zero.");
  if (quote && Number.isInteger(quote.fiatMinorPerItem) && quote.fiatMinorPerItem !== manifest?.fiatMinorPerItem) blockers.push("The gas price does not match the authorized batch.");
  const fiatEach = Number.isInteger(manifest?.fiatMinorPerItem) ? manifest.fiatMinorPerItem : null;
  const fiatEstimated = fiatEach != null && todo.length > 0 ? Math.ceil((fiatEach * todo.length * (10000 + (Number.isInteger(contingency) ? contingency : 0))) / 10000) : null;
  if (fiatEstimated == null && todo.length > 0 && validation.ok) blockers.push("Gas has no customer price yet. Nothing will be signed or sent.");
  if (fiatEstimated != null && split && fiatEstimated > split.gas) blockers.push("The priced gas, including contingency, is over the 2% gas reserve on this client's prepaid balance.");
  const paidAllowed = blockers.length === 0 && todo.length > 0;
  return {
    okManifest: validation.ok,
    blockers: [...new Set(blockers)],
    paidAllowed,
    summary: {
      ballots: items.length,
      alreadyRecorded: already.length,
      remaining: todo.length,
      ...counts,
    },
    cost: {
      estimatedWei: estimatedWei == null ? null : estimatedWei.toString(),
      perItemWei: perItem == null ? null : perItem.toString(),
      contingencyBps: contingency,
      gasCapWei: manifest?.gasCapWei ?? null,
      fiatGasMinor: fiatEstimated,
      gasReserveMinor: split?.gas ?? null,
      operationsMinor: split?.operations ?? null,
      currency: account?.currency ?? null,
      faucetIsNotPrepaid: true,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryDefault() {
  const map = new Map();
  return { load: (id) => map.get(id) ?? null, save: (id, value) => map.set(id, clone(value)) };
}

export function createBatchSession({ manifest, store = memoryDefault(), now = () => Math.floor(Date.now() / 1000), allowlist = COSTON2_ALLOWLIST } = {}) {
  const validation = validateManifest(manifest, now(), allowlist);
  if (!validation.ok) {
    return { ok: false, problems: validation.problems, session: null };
  }
  const sealed = manifestHash(manifest);
  const saved = store.load(manifest.batchId);
  const fresh = {
    sealed,
    manifest: clone(manifest),
    mode: "dry-run",
    approved: false,
    approver: null,
    paused: false,
    stopped: false,
    revoked: false,
    stopReason: "",
    inflight: false,
    nextNonce: null,
    spentWei: "0",
    reservedWei: "0",
    operationsSpentMinor: 0,
    fiatGasSpentMinor: 0,
    fiatGasReservedMinor: 0,
    activity: [],
    items: Object.fromEntries(manifest.items.map((item) => [item.itemId, {
      phase: "ready",
      attempts: 0,
      txHash: null,
      pendingNonce: null,
      reservedWei: "0",
      estimatedWei: "0",
      actualWei: null,
      resultsString: item.resultsString,
    }])),
  };
  let state = fresh;
  if (saved) {
    if (saved.sealed !== sealed) {
      return { ok: false, problems: ["The saved batch does not match this authorization. Nothing was resumed."], session: null };
    }
    state = { ...fresh, ...saved, manifest: clone(manifest), items: { ...fresh.items, ...saved.items }, inflight: false };
    for (const row of Object.values(state.items)) {
      if (row.phase === "signed" && BigInt(row.reservedWei || "0") > 0n) row.phase = "ambiguous";
    }
  }
  const sigs = new Map();
  const persist = () => store.save(manifest.batchId, { ...state, manifest: clone(state.manifest) });
  persist();

  const blocked = (reason) => ({
    ok: false,
    status: state.stopped ? "stopped" : state.revoked ? "revoked" : state.paused ? "paused" : "blocked",
    message: state.stopped || state.revoked ? `${reason} A transaction already broadcast cannot be undone.` : reason,
  });

  const gate = (currentManifest, chain, prepaid, quote) => {
    if (state.stopped || state.revoked) return blocked(state.stopReason || "This batch is stopped. A transaction already broadcast cannot be undone.");
    if (state.paused) return blocked("This batch is paused. Nothing new will be signed or sent.");
    if (manifestHash(currentManifest) !== state.sealed) {
      state.stopped = true;
      state.stopReason = "The batch changed after it was authorized. Nothing will be signed or sent.";
      persist();
      return blocked(state.stopReason);
    }
    const explained = explainBatch({ manifest: state.manifest, chain, prepaid, quote, now: now(), allowlist });
    if (!explained.paidAllowed && explained.summary.remaining > 0) return { ok: false, status: "blocked", message: explained.blockers[0] ?? "This batch is not ready.", explained };
    return { ok: true, explained };
  };

  const addActivity = (entry) => {
    state.activity.push({ at: now(), clientId: state.manifest.clientId, ...entry });
    persist();
  };

  const session = {
    get mode() { return state.mode; },
    get sealed() { return state.sealed; },
    explain(chain, prepaid, quote) {
      return explainBatch({ manifest: state.manifest, chain, prepaid, quote, now: now(), allowlist });
    },
    arm({ signature, chain, recover }) {
      if (state.stopped || state.revoked || state.paused) return blocked(state.stopReason || "This batch cannot leave dry run.");
      if (!chain?.organizer || !isAddress(chain.organizer)) return { ok: false, status: "blocked", message: "The organizer wallet is unknown, so this file cannot be approved." };
      const typed = batchApprovalTypedData(state.manifest, allowlist);
      let approver = null;
      try {
        approver = recover(typed.domain, typed.types, typed.message, signature);
      } catch {
        approver = null;
      }
      if (!approver || approver.toLowerCase() !== String(chain.organizer).toLowerCase()) {
        return { ok: false, status: "blocked", message: "The organizer has not approved this exact batch. The uploaded file is not approval, and it does not replace the scanner's signature." };
      }
      state.approved = true;
      state.approver = approver;
      state.mode = "armed";
      persist();
      return { ok: true, status: "armed", message: "The organizer approved this exact batch. The registered scanner must still sign each ballot. Nothing has been sent." };
    },
    pause() {
      state.paused = true;
      persist();
      return { ok: true, status: "paused", message: "Paused. Nothing new will be signed or sent. A transaction already broadcast cannot be undone." };
    },
    resume() {
      if (state.stopped || state.revoked) return blocked(state.stopReason || "This batch is stopped.");
      state.paused = false;
      persist();
      return { ok: true, status: state.mode };
    },
    stop(reason = "Stopped.") {
      state.stopped = true;
      state.stopReason = reason;
      persist();
      return { ok: true, status: "stopped", message: `${reason} A transaction already broadcast cannot be undone.` };
    },
    revoke() {
      state.revoked = true;
      state.stopped = true;
      state.stopReason = "The client revoked this batch.";
      persist();
      return { ok: true, status: "revoked", message: "Revoked. Nothing new will be signed or sent. A transaction already broadcast cannot be undone." };
    },
    noteOperations(clientId, activity, minor) {
      if (clientId !== state.manifest.clientId) return { ok: false, message: "This charge is for a different client. Balances are not shared." };
      if (!Number.isInteger(minor) || minor < 0) return { ok: false, message: "The operations charge is not a whole number of minor units." };
      const accountMinor = state.operationsBudgetMinor;
      if (!Number.isInteger(accountMinor)) return { ok: false, message: "No prepaid balance is on file, so this operations charge was not taken." };
      if (state.operationsSpentMinor + minor > accountMinor) return { ok: false, message: "This charge is over the 98% operations share of the prepaid balance." };
      state.operationsSpentMinor += minor;
      addActivity({ activity, kind: "actual", wei: "0", fiatMinor: minor, itemId: null, txHash: null });
      return { ok: true, remaining: accountMinor - state.operationsSpentMinor };
    },
    bindPrepaid(prepaid) {
      const account = prepaid?.accounts?.[state.manifest.clientId];
      const split = account ? splitPrepaid(account.amountMinor) : null;
      state.operationsBudgetMinor = split ? split.operations : null;
      state.gasBudgetMinor = split ? split.gas : null;
      persist();
      return split;
    },
    async sendNext({ manifest: current, sender, chain, prepaid, quote }) {
      if (state.mode !== "armed") return { ok: false, status: "dry-run", message: "Dry run only. Nothing was sent." };
      session.bindPrepaid(prepaid);
      if (state.inflight) return { ok: false, status: "busy", message: "A send is already in progress." };
      if (Object.values(state.items).some((entry) => entry.phase === "ambiguous")) return { ok: false, status: "ambiguous", message: "An unresolved broadcast must be checked before anything else is sent." };
      const check = gate(current, chain, prepaid, quote);
      if (!check.ok) return check;
      if (chain.nextNonce == null) return { ok: false, status: "blocked", message: "The account nonce is unknown. Nothing was sent." };
      const perItem = itemCostWei(chain, state.manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS);
      if (perItem == null) return { ok: false, status: "blocked", message: "The cost to record a ballot cannot be estimated yet. Nothing was sent." };
      const item = state.manifest.items.find((entry) => state.items[entry.itemId].phase === "signed" && sigs.has(entry.itemId));
      if (!item) return { ok: false, status: "idle", message: "Nothing is signed and waiting to send." };
      const row = state.items[item.itemId];
      if (row.attempts >= MAX_SEND_ATTEMPTS) {
        row.phase = "failed";
        persist();
        return { ok: false, status: "failed", message: "This ballot has used its retry limit. It was not sent again." };
      }
      const spent = BigInt(state.spentWei) + BigInt(state.reservedWei);
      if (spent + perItem > BigInt(state.manifest.gasCapWei)) return { ok: false, status: "blocked", message: "The reserved gas is over this batch's cap. Nothing was sent." };
      const fiatEach = quote?.fiatMinorPerItem;
      if (!Number.isInteger(fiatEach)) return { ok: false, status: "blocked", message: "Gas has no customer price yet. Nothing was sent." };
      const fiat = Math.ceil((fiatEach * (10000 + (state.manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS))) / 10000);
      if (!Number.isInteger(state.gasBudgetMinor) || state.fiatGasSpentMinor + state.fiatGasReservedMinor + fiat > state.gasBudgetMinor) return { ok: false, status: "blocked", message: "The priced gas is over the 2% reserve. Nothing was sent." };
      state.inflight = true;
      row.reservedWei = perItem.toString();
      row.estimatedWei = perItem.toString();
      state.reservedWei = (BigInt(state.reservedWei) + perItem).toString();
      if (state.nextNonce == null) state.nextNonce = chain.nextNonce;
      const nonce = state.nextNonce;
      row.pendingNonce = nonce;
      state.fiatGasReservedMinor += fiat;
      addActivity({ activity: "reserve", kind: "reserve", wei: perItem.toString(), fiatMinor: fiat, itemId: item.itemId, txHash: null });
      const held = sigs.get(item.itemId);
      const args = submitRecordArgs({
        electionKey: held.electionKey,
        ballotKey: item.ballotKey,
        resultsString: held.resultsString,
        imageSha256: item.imageSha256,
        recordSha256: item.recordSha256,
        scoresHash: item.scoresHash,
        device: state.manifest.scanner,
        signature: held.signature,
        ...(chain?.poolEnforced ? { proof: item.proof, rootIndex: item.rootIndex } : {}),
      });
      let outcome;
      try {
        outcome = await sender.send({ method: "submitRecord", to: allowlist.ledger, args, nonce });
      } catch {
        outcome = { status: "ambiguous" };
      }
      state.inflight = false;
      if (!outcome || outcome.status === "ambiguous") {
        row.phase = "ambiguous";
        row.txHash = outcome?.txHash ?? null;
        row.attempts += 1;
        persist();
        return { ok: false, status: "ambiguous", message: "The network did not confirm whether this transaction was broadcast. It must be checked before any retry. It was not sent again.", itemId: item.itemId };
      }
      if (outcome.status !== "submitted" || typeof outcome.txHash !== "string") {
        state.reservedWei = (BigInt(state.reservedWei) - perItem).toString();
        row.reservedWei = "0";
        state.fiatGasReservedMinor = Math.max(0, state.fiatGasReservedMinor - fiat);
        row.attempts += 1;
        row.phase = "signed";
        addActivity({ activity: "send-rejected", kind: "failure", wei: "0", fiatMinor: 0, itemId: item.itemId, txHash: null });
        persist();
        return { ok: false, status: row.phase, message: "The transaction was rejected before broadcast. Nothing was reserved for it." };
      }
      if (outcome.method && outcome.method !== "submitRecord") {
        state.stopped = true;
        state.stopReason = "The sender tried to use a call this service does not allow.";
        persist();
        return blocked(state.stopReason);
      }
      row.phase = "broadcast";
      row.txHash = outcome.txHash;
      state.nextNonce = nonce + 1;
      persist();
      return { ok: true, status: "broadcast", itemId: item.itemId, txHash: outcome.txHash };
    },
    reconcile(itemId, found) {
      const row = state.items[itemId];
      if (!row || (row.phase !== "ambiguous" && row.phase !== "broadcast")) return { ok: false, message: "There is no unresolved transaction for that item." };
      const reserved = BigInt(row.reservedWei || "0");
      if (!found) {
        if (row.phase === "ambiguous") {
          state.reservedWei = (BigInt(state.reservedWei) - reserved).toString();
          row.reservedWei = "0";
          state.fiatGasReservedMinor = Math.max(0, state.fiatGasReservedMinor - Math.ceil((state.manifest.fiatMinorPerItem * (10000 + (state.manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS))) / 10000));
          row.phase = sigs.has(itemId) ? "signed" : "ready";
          persist();
          return { ok: true, status: row.phase, message: "The transaction was not found. It can be tried again within the retry limit." };
        }
        return { ok: false, status: "broadcast", message: "A broadcast transaction still needs its receipt. It was not sent again." };
      }
      const actual = asWei(String(found.actualWei ?? ""));
      if (actual == null) return { ok: false, message: "The receipt has no gas cost, so it was not marked recorded or failed." };
      state.reservedWei = (BigInt(state.reservedWei) - reserved).toString();
      row.reservedWei = "0";
      row.actualWei = actual.toString();
      state.spentWei = (BigInt(state.spentWei) + actual).toString();
      row.txHash = found.txHash ?? row.txHash;
      if (Number.isInteger(row.pendingNonce)) state.nextNonce = Math.max(state.nextNonce ?? 0, row.pendingNonce + 1);
      const fiatHeld = Math.ceil((state.manifest.fiatMinorPerItem * (10000 + (state.manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS))) / 10000);
      state.fiatGasReservedMinor = Math.max(0, state.fiatGasReservedMinor - fiatHeld);
      if (found.mined && found.success) {
        state.fiatGasSpentMinor += fiatHeld;
        row.phase = "recorded";
        addActivity({ activity: "record", kind: "actual", wei: actual.toString(), fiatMinor: 0, itemId, txHash: row.txHash });
      } else {
        row.attempts += 1;
        row.phase = row.attempts >= MAX_SEND_ATTEMPTS ? "failed" : (sigs.has(itemId) ? "signed" : "ready");
        addActivity({ activity: "record-failed", kind: "failure", wei: actual.toString(), fiatMinor: 0, itemId, txHash: row.txHash });
      }
      persist();
      return { ok: true, status: row.phase };
    },
    receipt() {
      return {
        batchId: state.manifest.batchId,
        clientId: state.manifest.clientId,
        electionCode: state.manifest.electionCode,
        chainId: state.manifest.chainId,
        mode: state.mode,
        stopped: state.stopped,
        paused: state.paused,
        note: "Ballot codes and private keys are not included. A broadcast transaction cannot be undone from here.",
        summary: resultCounts(state.manifest.items),
        pictureRetention: "Not changed. Approved review retention is 14 days plus a 7-day margin. Dispute holds are not built.",
        items: state.manifest.items.map((item) => ({
          itemId: item.itemId,
          ballotKey: item.ballotKey,
          resultsString: state.items[item.itemId].resultsString,
          phase: state.items[item.itemId].phase,
          txHash: state.items[item.itemId].txHash,
          estimatedWei: state.items[item.itemId].estimatedWei,
          actualWei: state.items[item.itemId].actualWei,
          attempts: state.items[item.itemId].attempts,
        })),
        budget: {
          currency: null,
          gasReserveBps: GAS_RESERVE_BPS,
          operationsBps: OPERATIONS_BPS,
          operationsSpentMinor: state.operationsSpentMinor,
          fiatGasSpentMinor: state.fiatGasSpentMinor,
          spentWei: state.spentWei,
          reservedWei: state.reservedWei,
          gasCapWei: state.manifest.gasCapWei,
          contingencyBps: state.manifest.contingencyBps ?? DEFAULT_CONTINGENCY_BPS,
        },
        activity: state.activity,
      };
    },
  };

  async function signItems({ manifest: current, signer, chain, prepaid, quote, keccak }) {
    if (state.mode !== "armed") return { ok: false, status: "dry-run", message: "Dry run only. Nothing was signed.", planned: state.manifest.items.filter((item) => state.items[item.itemId].phase === "ready").length };
    const check = gate(current, chain, prepaid, quote);
    if (!check.ok) return check;
    session.bindPrepaid(prepaid);
    if (!signer || signer.address?.toLowerCase() !== state.manifest.scanner.toLowerCase()) return { ok: false, status: "blocked", message: "The signing key is not the authorized scanner. Nothing was signed." };
    if (typeof keccak !== "function") return { ok: false, status: "blocked", message: "The result hash could not be computed. Nothing was signed." };
      let signed = 0;
    const electionKey = keccak(utf8(state.manifest.electionCode));
    for (const item of state.manifest.items) {
      if (state.stopped || state.paused || state.revoked) break;
      const row = state.items[item.itemId];
      const mark = ledgerMatch(chain, item);
      if (mark === "conflict" || mark === "unknown") {
        state.stopped = true;
        state.stopReason = "A ballot already on the ledger has a different result. It will not be replaced.";
        persist();
        return blocked(state.stopReason);
      }
      if (mark === "match" || row.phase === "recorded" || row.phase === "skipped") {
        row.phase = "skipped";
        continue;
      }
      if (sigs.has(item.itemId) || row.phase === "broadcast" || row.phase === "ambiguous") continue;
      const resultsHash = keccak(utf8(item.resultsString));
      const typed = readingTypedData({
        electionKey,
        ballotKey: item.ballotKey,
        resultsHash,
        imageSha256: item.imageSha256,
        scoresHash: item.scoresHash,
        verifyingContract: allowlist.ledger,
      });
      if (typed.message.resultsHash.toLowerCase() !== resultsHash.toLowerCase()) {
        state.stopped = true;
        state.stopReason = "The result hash does not match the authorized result string.";
        persist();
        return blocked(state.stopReason);
      }
      const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
      sigs.set(item.itemId, { signature, resultsHash, resultsString: item.resultsString, electionKey });
      row.phase = "signed";
      signed += 1;
      addActivity({ activity: "sign", kind: "actual", wei: "0", fiatMinor: 0, itemId: item.itemId, txHash: null });
    }
    persist();
    return { ok: true, status: "signed", signed };
  }

  session.sign = signItems;

  return { ok: true, problems: [], session };
}
