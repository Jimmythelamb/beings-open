// Live stats for the ticker at the top of every page. Everything is computed from real, public, read-only data:
//   - contract event logs from the Coston2 block explorer's Etherscan-style API (the public RPC refuses log searches
//     wider than 30 blocks). Each log row carries its transaction's gasUsed and gasPrice, so fees are MEASURED.
//   - two JSON-RPC calls to Coston2 for the newest block and an older one (block number, block time, block age).
// No wallet, no keys, no writes. Results are cached in sessionStorage for 60 s. Pure functions are exported for tests.
import { CONFIG, contractSets } from "./config.js";

/** Event topic hashes (keccak-256 of the event signatures; checked in the tests). */
export const TOPICS = {
  ElectionCreated: "0x90cdb48933869b331a5b811ce46bb72a2a9bfe45a2900da62da44f4bb16bff9f", // registry
  StatusChanged: "0x4d7781468081641aba2c04c3349fcf5830b9fedac1b7aaffabc1f1dc6b8883fb", // registry
  BallotAccepted: "0x3c75ef74c64dd4aad39e9b6497ace8a084e7d32b88c35bb7abe71f946182e891", // ledger
};
export const STATUS_NAMES = ["none", "setup", "open", "closed", "tallied"];
export const CACHE_KEY = "beings.stats.v1";
export const CACHE_MS = 60_000;
export const BLOCK_SAMPLE = 100; // block time is averaged over this many recent blocks
const WEI = 10n ** 18n;

const hexNum = (x) => (x == null || x === "" ? 0 : Number.parseInt(String(x), 16));
const hexBig = (x) => {
  try {
    return x == null || x === "" ? 0n : BigInt(x);
  } catch {
    return 0n;
  }
};
/** wei (bigint) -> C2FLR (number). */
export const toC2 = (wei) => Number(wei / 10n ** 9n) / 1e9;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const order = (a, b) => hexNum(a.blockNumber) - hexNum(b.blockNumber) || hexNum(a.logIndex) - hexNum(b.logIndex);

/** One fee per transaction: gasUsed × gasPrice from the explorer log row (several logs can share one transaction). */
export function txFees(rows) {
  const m = new Map();
  for (const r of rows) if (r?.transactionHash && !m.has(r.transactionHash)) m.set(r.transactionHash, { fee: hexBig(r.gasUsed) * hexBig(r.gasPrice), block: hexNum(r.blockNumber), time: hexNum(r.timeStamp) });
  return m;
}

/**
 * The numbers, from raw explorer log rows (registry, ledger, tally) and two blocks ({number, timestamp} as hex).
 * `now`: ms. Never invents a value: anything that can't be derived is null.
 */
export function computeStats({ registryLogs = [], ledgerLogs = [], tallyLogs = [], head = null, older = null, now = Date.now() }) {
  const reg = [...registryLogs].sort(order);
  const led = [...ledgerLogs].sort(order);
  const created = reg.filter((r) => r.topics?.[0] === TOPICS.ElectionCreated);
  const keys = new Set(created.map((r) => r.topics[1]));
  // status: the last StatusChanged per election ("to" is the second data word)
  const status = new Map([...keys].map((k) => [k, 1]));
  for (const r of reg) if (r.topics?.[0] === TOPICS.StatusChanged && keys.has(r.topics[1])) status.set(r.topics[1], hexNum("0x" + String(r.data).slice(2 + 64, 2 + 128)));
  const byStatus = { setup: 0, open: 0, closed: 0, tallied: 0 };
  for (const s of status.values()) if (STATUS_NAMES[s] in byStatus) byStatus[STATUS_NAMES[s]]++;

  // ballots
  const ballots = led.filter((r) => r.topics?.[0] === TOPICS.BallotAccepted && keys.has(r.topics[1]));
  const lastBallot = ballots.length ? hexNum(ballots[ballots.length - 1].timeStamp) * 1000 : null;

  // fees (measured): create = the ElectionCreated transactions; per ballot = recording transactions ÷ ballots
  const createFees = created.map((r) => toC2(hexBig(r.gasUsed) * hexBig(r.gasPrice)));
  const recTx = txFees(ballots);
  const recTotal = [...recTx.values()].reduce((a, t) => a + t.fee, 0n);
  const perBallot = ballots.length ? toC2(recTotal) / ballots.length : null;
  const latestRec = ballots.length ? recTx.get(ballots[ballots.length - 1].transactionHash) : null;
  const latestRecCount = latestRec ? ballots.filter((b) => b.transactionHash === ballots[ballots.length - 1].transactionHash).length : 0;

  // whole election (tallied only): every transaction that logged an event for that election on any of the 3 contracts
  const byKey = new Map();
  for (const r of [...reg, ...led, ...tallyLogs]) {
    const k = r.topics?.[1];
    if (!keys.has(k)) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const whole = [];
  for (const k of keys) {
    if (status.get(k) !== 4) continue;
    const fees = txFees(byKey.get(k) ?? []);
    const total = [...fees.values()].reduce((a, t) => a + t.fee, 0n);
    const lastBlock = Math.max(...[...fees.values()].map((t) => t.block));
    const nBallots = ballots.filter((b) => b.topics[1] === k).length;
    whole.push({ key: k, c2: toC2(total), txs: fees.size, ballots: nBallots, lastBlock });
  }
  whole.sort((a, b) => a.lastBlock - b.lastBlock);

  // speed
  let blockTime = null;
  let headAge = null;
  let headNumber = null;
  if (head?.number) {
    headNumber = hexNum(head.number);
    headAge = Math.max(0, Math.round(now / 1000 - hexNum(head.timestamp)));
    if (older?.number && hexNum(head.number) > hexNum(older.number)) blockTime = (hexNum(head.timestamp) - hexNum(older.timestamp)) / (hexNum(head.number) - hexNum(older.number));
  }

  return {
    at: now,
    elections: { created: created.length, byStatus, lastCreatedAt: created.length ? hexNum(created[created.length - 1].timeStamp) * 1000 : null },
    ballots: { recorded: ballots.length, lastAt: lastBallot },
    cost: {
      createAvg: avg(createFees),
      createLatest: createFees.length ? createFees[createFees.length - 1] : null,
      perBallotAvg: perBallot,
      perBallotLatest: latestRec && latestRecCount ? toC2(latestRec.fee) / latestRecCount : null,
      wholeCount: whole.length,
      wholeAvg: avg(whole.map((w) => w.c2)),
      wholeLatest: whole.length ? whole[whole.length - 1].c2 : null,
      wholeLatestBallots: whole.length ? whole[whole.length - 1].ballots : null,
      wholeMedian: whole.length ? [...whole.map((w) => w.c2)].sort((a, b) => a - b)[Math.floor((whole.length - 1) / 2)] : null,
    },
    speed: { blockTime, headAge, headNumber },
  };
}

// ------------------------------------------------------------------ fetching (read-only)
async function explorerAll(fetchFn, explorer, address, fromBlock) {
  const out = [];
  let from = fromBlock;
  for (let page = 0; page < 10; page++) {
    const u = new URL("/api", explorer);
    u.search = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: String(from), toBlock: "latest" }).toString();
    const res = await fetchFn(u.toString(), { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.result)) {
      if (/no logs found/i.test(j.message ?? "")) break;
      throw new Error(`explorer: ${j.message ?? "unexpected answer"}`);
    }
    out.push(...j.result);
    if (j.result.length < 1000) break;
    from = hexNum(j.result[j.result.length - 1].blockNumber) + 1;
  }
  return out;
}

async function rpc(fetchFn, url, calls) {
  const body = calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params }));
  const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`RPC answered ${res.status}`);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : [j];
  return calls.map((_, i) => {
    const r = arr.find((x) => x.id === i + 1);
    if (!r || r.error) throw new Error(r?.error?.message ?? "RPC error");
    return r.result;
  });
}

/** Raw data: explorer log reads for the current set and each legacy set, plus 2 RPC calls. */
export async function fetchRawStats({ fetchFn = globalThis.fetch.bind(globalThis), config = CONFIG } = {}) {
  const sets = contractSets(config);
  const jobs = [rpc(fetchFn, config.rpcUrl, [["eth_getBlockByNumber", ["latest", false]]])];
  for (const set of sets) {
    const c = set.contracts;
    jobs.push(explorerAll(fetchFn, config.explorer, c.registry, set.deployBlock));
    jobs.push(explorerAll(fetchFn, config.explorer, c.ledger, set.deployBlock));
    jobs.push(explorerAll(fetchFn, config.explorer, c.tally, set.deployBlock).catch(() => [])); // only adds amended-tally fees
  }
  const results = await Promise.all(jobs);
  const [head] = results[0];
  const registryLogs = [];
  const ledgerLogs = [];
  const tallyLogs = [];
  for (let i = 0; i < sets.length; i++) {
    registryLogs.push(...results[1 + i * 3]);
    ledgerLogs.push(...results[2 + i * 3]);
    tallyLogs.push(...results[3 + i * 3]);
  }
  let older = null;
  if (head?.number) {
    const n = Math.max(0, hexNum(head.number) - BLOCK_SAMPLE);
    [older] = await rpc(fetchFn, config.rpcUrl, [["eth_getBlockByNumber", ["0x" + n.toString(16), false]]]).catch(() => [null]);
  }
  return { registryLogs, ledgerLogs, tallyLogs, head: head && { number: head.number, timestamp: head.timestamp }, older: older && { number: older.number, timestamp: older.timestamp } };
}

/** Stats, from the 60 s session cache when fresh. Throws if nothing can be read. */
export async function loadStats({ fetchFn, storage = globalThis.sessionStorage, now = () => Date.now(), config = CONFIG, force = false } = {}) {
  if (!force) {
    try {
      const c = JSON.parse(storage?.getItem(CACHE_KEY) ?? "null");
      if (c?.stats && now() - c.at < CACHE_MS) return { ...c.stats, cached: true };
    } catch {
      /* ignore a bad cache */
    }
  }
  const raw = await fetchRawStats({ fetchFn, config });
  const stats = computeStats({ ...raw, now: now() });
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ at: now(), stats }));
  } catch {
    /* storage full or blocked: fine */
  }
  return stats;
}

// ------------------------------------------------------------------ words
export function fmtC2(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const d = x >= 10 ? 1 : x >= 1 ? 2 : x >= 0.1 ? 2 : 3;
  return `${x.toFixed(d)} C2FLR`;
}
export function ago(ms, now = Date.now()) {
  if (ms == null) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
const n = (x) => Number(x).toLocaleString("en-US");

/** Plain explanations for "What is this?" (the site has no i18n layer; copy lives here, like help.js). */
export const STATS_EXPLAIN = [
  ["Network", "B.E.I.N.G.S. runs on Coston2, Flare's public test network. Its coins (C2FLR) are free play money with no real value. The block number counts every block the network has made; a higher number means the chain is still moving."],
  ["Elections created", "How many elections have been put on this ledger, read from the public ElectionCreated records. The brackets split them by where they are now: open for voting, or tallied (results published)."],
  ["Ballots recorded", "How many paper ballots have been scanned and permanently recorded, across every election, read from the public BallotAccepted records."],
  ["Last ballot recorded", "When the most recent ballot reading was written to the ledger, by the block's own clock."],
  ["Block time", "How often the network adds a new block, averaged over the last 100 blocks. A transaction you approve is normally confirmed in the next block or two, so this is roughly how long you wait. That wait is an estimate; the block time is measured."],
  ["Cost to create an election", "The fee actually paid for each createElection transaction so far (gas used × gas price, from the transaction receipts). Average and most recent. Measured, not estimated."],
  ["Cost per ballot recorded", "All the fees paid by the transactions that recorded ballots, divided by the number of ballots. Batches make each ballot cheaper. Measured from receipts."],
  ["Whole election", "For elections that reached a published tally: the sum of every fee paid for that election (create, register the Scanner/Printer, open, close, record ballots, tally). The median is the typical one; big test runs push the average up. Measured from receipts; your own election will differ because fees follow the gas price."],
];

/** The ticker items. kind: "live" (read now), "measured" (from receipts) or "estimated". */
export function tickerItems(s, now = Date.now()) {
  const items = [];
  if (s.speed.headNumber != null) items.push({ id: "network", label: "Coston2 test network", value: `block #${n(s.speed.headNumber)}`, kind: "live", badge: "Test network, play money" });
  const st = s.elections.byStatus;
  const split = [st.open ? `${st.open} open` : null, st.tallied ? `${st.tallied} tallied` : null].filter(Boolean).join(" · ");
  items.push({ id: "elections", label: "Elections created", value: `${n(s.elections.created)}${split ? ` (${split})` : ""}`, kind: "live" });
  items.push({ id: "ballots", label: "Ballots recorded", value: n(s.ballots.recorded), kind: "live" });
  if (s.ballots.lastAt) items.push({ id: "last", label: "Last ballot recorded", value: ago(s.ballots.lastAt, now), kind: "live" });
  if (s.speed.blockTime != null) items.push({ id: "speed", label: "New block every", value: `≈${s.speed.blockTime.toFixed(1)} s`, kind: "measured", note: `confirm ≈${Math.max(1, Math.round(s.speed.blockTime * 2))} s (estimated)` });
  if (s.cost.createAvg != null) items.push({ id: "create", label: "Create an election", value: `≈${fmtC2(s.cost.createAvg)} avg`, kind: "measured", note: `latest ${fmtC2(s.cost.createLatest)}` });
  if (s.cost.perBallotAvg != null) items.push({ id: "perBallot", label: "Record a ballot", value: `≈${fmtC2(s.cost.perBallotAvg)} each`, kind: "measured", note: s.cost.perBallotLatest != null ? `latest ${fmtC2(s.cost.perBallotLatest)}` : null });
  if (s.cost.wholeCount) items.push({ id: "whole", label: "Typical whole election", value: `≈${fmtC2(s.cost.wholeMedian)}`, kind: "measured", note: `median of ${s.cost.wholeCount} tallied · latest ${fmtC2(s.cost.wholeLatest)} for ${s.cost.wholeLatestBallots} ballot${s.cost.wholeLatestBallots === 1 ? "" : "s"}` });
  items.push({ id: "source", label: "Data read live from the chain", value: s.cached ? "updated within the last minute" : "just updated", kind: "live" });
  return items;
}
