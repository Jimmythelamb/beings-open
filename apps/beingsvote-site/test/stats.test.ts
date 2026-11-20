// Live stats ticker: the numbers (stats.js) from mocked explorer/RPC answers, the cache, and the view (ticker.js).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import * as S0 from "../public/js/stats.js";
const S: any = S0;
const { TOPICS, computeStats, txFees, toC2, tickerItems, fetchRawStats, loadStats, fmtC2, ago, CACHE_KEY, STATS_EXPLAIN } = S;

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
const word = (n: number) => n.toString(16).padStart(64, "0");
const K1 = "0x" + "11".repeat(32);
const K2 = "0x" + "22".repeat(32);
const GWEI = 10n ** 9n;
let li = 0;
const row = (topic0: string, key: string, { block, tx, gas, price = 500n * GWEI, time = 1_700_000_000, data = "0x" }: any) => ({ topics: [topic0, key, null, null], data, blockNumber: hex(block), logIndex: hex(li++), transactionHash: tx, gasUsed: hex(gas), gasPrice: hex(price), timeStamp: hex(time) });
const status = (key: string, from: number, to: number, o: any) => row(TOPICS.StatusChanged, key, { ...o, data: "0x" + word(from) + word(to) });

// Election 1: created, opened, 3 ballots (one batch of 2 + one single), closed, tallied. Election 2: created + opened.
const registryLogs = [
  row(TOPICS.ElectionCreated, K1, { block: 100, tx: "0xc1", gas: 200_000 }),
  status(K1, 0, 1, { block: 100, tx: "0xc1", gas: 200_000 }), // same tx as create: counted once
  status(K1, 1, 2, { block: 110, tx: "0xo1", gas: 40_000 }),
  status(K1, 2, 3, { block: 130, tx: "0xx1", gas: 30_000 }),
  status(K1, 3, 4, { block: 140, tx: "0xt1", gas: 300_000 }),
  row(TOPICS.ElectionCreated, K2, { block: 200, tx: "0xc2", gas: 400_000, price: 1000n * GWEI, time: 1_700_000_500 }),
  status(K2, 1, 2, { block: 210, tx: "0xo2", gas: 40_000 }),
  { ...row("0xdeadbeef", "0x" + "00".repeat(12) + "ab".repeat(20), { block: 50, tx: "0xsetup", gas: 99_999 }) }, // LedgerSet-style: not an election
];
const ledgerLogs = [
  row(TOPICS.BallotAccepted, K1, { block: 120, tx: "0xb1", gas: 300_000, time: 1_700_000_100 }),
  row(TOPICS.BallotAccepted, K1, { block: 120, tx: "0xb1", gas: 300_000, time: 1_700_000_100 }),
  row(TOPICS.BallotAccepted, K1, { block: 125, tx: "0xb2", gas: 200_000, time: 1_700_000_200 }),
];
const head = { number: hex(1000), timestamp: hex(1_700_001_000) };
const older = { number: hex(900), timestamp: hex(1_700_000_750) };
const NOW = 1_700_001_004_000;
const fee = (gas: number, gwei = 500) => Number(BigInt(gas) * BigInt(gwei) * GWEI) / 1e18;

describe("the numbers (computeStats)", () => {
  it("topic hashes are the keccak-256 of the contract event signatures", () => {
    expect(TOPICS.ElectionCreated).toBe(ethers.id("ElectionCreated(bytes32,string,address)"));
    expect(TOPICS.StatusChanged).toBe(ethers.id("StatusChanged(bytes32,uint8,uint8)"));
    expect(TOPICS.BallotAccepted).toBe(ethers.id("BallotAccepted(bytes32,bytes32,string,bytes32,bytes32,bool)"));
    for (const t of ["ElectionCreated", "StatusChanged", "BallotAccepted"]) expect(src(`../../../packages/ledger/contracts/interfaces/I${t === "BallotAccepted" ? "BallotLedger" : "ElectionRegistry"}.sol`)).toContain(`event ${t}(`);
  });
  it("counts elections by their latest status, and ballots", () => {
    const s = computeStats({ registryLogs, ledgerLogs, head, older, now: NOW });
    expect(s.elections.created).toBe(2);
    expect(s.elections.byStatus).toEqual({ setup: 0, open: 1, closed: 0, tallied: 1 });
    expect(s.ballots.recorded).toBe(3);
    expect(s.ballots.lastAt).toBe(1_700_000_200_000);
    expect(s.elections.lastCreatedAt).toBe(1_700_000_500_000);
  });
  it("fees are gasUsed × gasPrice per transaction, one per transaction even when it logged several events", () => {
    const s = computeStats({ registryLogs, ledgerLogs, head, older, now: NOW });
    expect(s.cost.createAvg).toBeCloseTo((fee(200_000) + fee(400_000, 1000)) / 2, 12);
    expect(s.cost.createLatest).toBeCloseTo(fee(400_000, 1000), 12);
    expect(s.cost.perBallotAvg).toBeCloseTo((fee(300_000) + fee(200_000)) / 3, 12); // the batch tx counted once
    expect(s.cost.perBallotLatest).toBeCloseTo(fee(200_000), 12);
    // whole election 1: create(+status) + open + close + tally + 2 recording txs
    const whole1 = fee(200_000) + fee(40_000) + fee(30_000) + fee(300_000) + fee(300_000) + fee(200_000);
    expect(s.cost.wholeCount).toBe(1);
    expect(s.cost.wholeAvg).toBeCloseTo(whole1, 12);
    expect(s.cost.wholeMedian).toBeCloseTo(whole1, 12);
    expect(s.cost.wholeLatestBallots).toBe(3);
    expect(txFees(ledgerLogs).size).toBe(2);
    expect(toC2(10n ** 18n)).toBe(1);
  });
  it("speed: average block time over the sample, and the newest block's age", () => {
    const s = computeStats({ registryLogs, ledgerLogs, head, older, now: NOW });
    expect(s.speed).toEqual({ blockTime: 2.5, headAge: 4, headNumber: 1000 });
  });
  it("never invents: with no data every derived number is null and the ticker leaves it out", () => {
    const s = computeStats({ now: NOW });
    expect(s.elections.created).toBe(0);
    expect(s.cost).toMatchObject({ createAvg: null, perBallotAvg: null, wholeCount: 0, wholeMedian: null });
    expect(s.speed).toEqual({ blockTime: null, headAge: null, headNumber: null });
    const ids = tickerItems(s, NOW).map((i: any) => i.id);
    expect(ids).toEqual(["elections", "ballots", "source"]);
  });
  it("ticker items: plain labels, measured vs estimated, the play-money badge", () => {
    const items = tickerItems(computeStats({ registryLogs, ledgerLogs, head, older, now: NOW }), NOW);
    const by = Object.fromEntries(items.map((i: any) => [i.id, i]));
    expect(by.network).toMatchObject({ label: "Coston2 test network", value: "block #1,000", badge: "Test network, play money", kind: "live" });
    expect(by.elections.value).toBe("2 (1 open · 1 tallied)");
    expect(by.ballots.value).toBe("3");
    expect(by.last.value).toBe("13 minutes ago");
    expect(by.speed).toMatchObject({ value: "≈2.5 s", kind: "measured", note: "confirm ≈5 s (estimated)" });
    expect(by.create.kind).toBe("measured");
    expect(by.perBallot.value).toMatch(/^≈0\.\d+ C2FLR each$/);
    expect(by.whole.note).toMatch(/^median of 1 tallied · latest .* for 3 ballots$/);
    expect(by.source.label).toBe("Data read live from the chain");
    expect(fmtC2(0.0791)).toBe("0.079 C2FLR");
    expect(fmtC2(1.332)).toBe("1.33 C2FLR");
    expect(fmtC2(null)).toBeNull();
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe("3 hours ago");
    expect(ago(NOW - 1000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * 86400_000, NOW)).toBe("5 days ago");
    for (const [t, d] of STATS_EXPLAIN) expect(d.length, t).toBeGreaterThan(60);
  });
});

// ------------------------------------------------------------------ fetching, with a mocked network
function mockNet({ failRpc = false, registryPages = [registryLogs] }: any = {}) {
  const calls: string[] = [];
  let regPage = 0;
  const fetchFn = async (url: string, init: any = {}) => {
    calls.push(init.method === "POST" ? `rpc:${JSON.parse(init.body).map((b: any) => b.params[0]).join(",")}` : url);
    const ok = (j: any) => ({ ok: true, status: 200, json: async () => j });
    if (init.method === "POST") {
      if (failRpc) return { ok: false, status: 503, json: async () => ({}) };
      const [b] = JSON.parse(init.body);
      return ok([{ jsonrpc: "2.0", id: 1, result: b.params[0] === "latest" ? head : older }]);
    }
    const u = new URL(url);
    expect(u.searchParams.get("module")).toBe("logs");
    expect(u.searchParams.get("toBlock")).toBe("latest");
    const addr = u.searchParams.get("address");
    if (addr === "0xR") return ok({ message: "OK", result: registryPages[Math.min(regPage++, registryPages.length - 1)] });
    if (addr === "0xL") return ok({ message: "OK", result: ledgerLogs });
    return ok({ message: "No logs found", result: [] });
  };
  return { fetchFn, calls };
}
const config: any = { rpcUrl: "https://rpc.example", explorer: "https://explorer.example", deployBlock: 7, contracts: { registry: "0xR", ledger: "0xL", tally: "0xT", verifiers: "0xV" } };
class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("reading (read-only, few calls) and the 60 s cache", () => {
  it("uses 3 explorer log reads from the deploy block and 2 RPC block reads; nothing else", async () => {
    const { fetchFn, calls } = mockNet();
    const raw = await fetchRawStats({ fetchFn, config });
    expect(calls.filter((c) => c.startsWith("https://explorer.example/api")).length).toBe(3);
    expect(calls.every((c) => !c.startsWith("https://explorer") || c.includes("fromBlock=7"))).toBe(true);
    expect(calls.filter((c) => c.startsWith("rpc:"))).toEqual(["rpc:latest", `rpc:${hex(1000 - 100)}`]);
    expect(raw.registryLogs.length).toBe(registryLogs.length);
    expect(src("../public/js/stats.js")).not.toMatch(/eth_send|eth_sign|personal_sign|privateKey/);
  });
  it("also reads each legacy contract set, starting at that set's deploy block", async () => {
    const { fetchFn, calls } = mockNet();
    await fetchRawStats({
      fetchFn,
      config: {
        ...config,
        legacySets: [{ id: "pre-pool", deployBlock: 3, contracts: { registry: "0xR2", ledger: "0xL2", tally: "0xT2", verifiers: "0xV2" } }],
      },
    });
    const explorer = calls.filter((c) => c.startsWith("https://explorer.example/api"));
    expect(explorer).toHaveLength(6);
    expect(explorer.filter((c) => c.includes("fromBlock=7"))).toHaveLength(3);
    expect(explorer.filter((c) => c.includes("fromBlock=3"))).toHaveLength(3);
    expect(explorer.some((c) => c.includes("address=0xR2"))).toBe(true);
    expect(explorer.some((c) => c.includes("address=0xL2"))).toBe(true);
  });
  it("pages the explorer from the next block when a page is full (1000 rows)", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(TOPICS.BallotAccepted, K1, { block: 300 + i, tx: hex(i), gas: 1 }));
    const { fetchFn, calls } = mockNet({ registryPages: [full, registryLogs] });
    await fetchRawStats({ fetchFn, config });
    const reg = calls.filter((c) => c.includes("address=0xR"));
    expect(reg.length).toBe(2);
    expect(reg[1]).toContain("fromBlock=1300");
  });
  it("caches for 60 s in sessionStorage, then reads again", async () => {
    const store = new MemStore();
    const { fetchFn, calls } = mockNet();
    let t = NOW;
    const a = await loadStats({ fetchFn, storage: store, now: () => t, config });
    expect(a.cached).toBeUndefined();
    expect(JSON.parse(store.getItem(CACHE_KEY)!).stats.ballots.recorded).toBe(3);
    const n = calls.length;
    t += 59_000;
    const b = await loadStats({ fetchFn, storage: store, now: () => t, config });
    expect(b.cached).toBe(true);
    expect(calls.length).toBe(n);
    t += 2_000;
    await loadStats({ fetchFn, storage: store, now: () => t, config });
    expect(calls.length).toBe(2 * n);
  });
  it("an RPC failure throws (the ticker then says stats are unavailable); nothing is cached", async () => {
    const store = new MemStore();
    const { fetchFn } = mockNet({ failRpc: true });
    await expect(loadStats({ fetchFn, storage: store, now: () => NOW, config })).rejects.toThrow(/RPC answered 503/);
    expect(store.getItem(CACHE_KEY)).toBeNull();
  });
});

// ------------------------------------------------------------------ the view
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  classes = new Set<string>();
  hidden = false;
  style: any = { setProperty() {} };
  dataset: any = {};
  textContent = "";
  classList = {
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
    contains: (c: string) => this.classes.has(c),
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.attrs.class = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "hidden") this.hidden = true;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: any[]) {
    this.children = c;
  }
  addEventListener(t: string, fn: (e: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  fire(t: string) {
    for (const fn of this.listeners[t] ?? []) fn({ currentTarget: this, stopPropagation() {} });
  }
  querySelector(): any {
    return null;
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (c instanceof FakeEl ? c.text : String(c))).join("");
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = pred(this) ? [this] : [];
    for (const c of this.children) if (c instanceof FakeEl) out.push(...c.find(pred));
    return out;
  }
}
const cls = (e: FakeEl) => e.getAttribute("class") ?? "";
describe("the ticker view", () => {
  let T: any;
  beforeAll(async () => {
    (globalThis as any).Node = FakeEl;
    (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
    T = await import("../public/js/ticker.js");
  });
  afterAll(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).Node;
  });
  it("ready: two copies for a seamless loop (the second hidden from screen readers), pause button, What is this?", () => {
    const root = new FakeEl("div");
    T.paintTicker(root, { status: "ready", stats: computeStats({ registryLogs, ledgerLogs, head, older, now: NOW }) }, NOW);
    const lists: any[] = root.find((e) => e.tagName === "UL");
    expect(lists).toHaveLength(2);
    expect(lists[0].getAttribute("aria-hidden")).toBeNull();
    expect(lists[1].getAttribute("aria-hidden")).toBe("true");
    expect(lists[0].text).toContain("Elections created2 (1 open · 1 tallied)");
    expect(lists[0].text).toContain("measured");
    expect(root.classes.has("is-ready")).toBe(true);
    const pause: any = root.find((e) => cls(e).includes("ticker-pause"))[0];
    pause.fire("click");
    expect(root.classes.has("paused")).toBe(true);
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    expect(pause.getAttribute("aria-label")).toBe("Play the moving stats");
    const what: any = root.find((e) => e.getAttribute("aria-controls") === "ticker-explain")[0];
    const panel: any = root.find((e) => e.getAttribute("id") === "ticker-explain")[0];
    expect(panel.hidden).toBe(true);
    what.fire("click");
    expect(panel.hidden).toBe(false);
    expect(what.getAttribute("aria-expanded")).toBe("true");
    expect(panel.text).toContain("Measured means taken from real transaction receipts");
  });
  it("error: a calm message, no numbers; loading: a skeleton marked busy", () => {
    const root = new FakeEl("div");
    T.paintTicker(root, { status: "error" });
    expect(root.text).toContain("Live stats unavailable right now. Everything else on this page still works.");
    expect(root.text).not.toMatch(/\d+ C2FLR/);
    expect(root.classes.has("is-error")).toBe(true);
    T.paintTicker(root, { status: "loading" });
    expect(root.find((e) => e.getAttribute("aria-busy") === "true")).toHaveLength(1);
  });
  it("startTicker never blocks: it paints a skeleton first, then the stats, or the error", async () => {
    const root = new FakeEl("div");
    let resolve: any;
    T.startTicker(root, { load: () => new Promise((r) => (resolve = r)), every: 0 });
    expect(root.find((e) => e.getAttribute("aria-busy") === "true")).toHaveLength(1);
    resolve(computeStats({ registryLogs, ledgerLogs, head, older, now: NOW }));
    await new Promise((r) => setTimeout(r, 0));
    expect(root.classes.has("is-ready")).toBe(true);
    const bad = new FakeEl("div");
    T.startTicker(bad, { load: async () => Promise.reject(new Error("down")), every: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(bad.classes.has("is-error")).toBe(true);
  });
  it("sits in the header beside the logo, under the tools with the nav, and respects reduced motion", () => {
    const html = src("../public/index.html");
    expect(html).toMatch(/<div class="wrap header-row">\s*<a class="brand"[\s\S]*<div class="header-aside">\s*<div id="stats-ticker" class="stats-ticker" role="region" aria-label="Live B\.E\.I\.N\.G\.S\. stats">[\s\S]*aria-busy="true"[\s\S]*<div class="header-tools">[\s\S]*<nav id="nav" aria-label="Main">/);
    expect(html).not.toMatch(/<header class="site-header">\s*<div id="stats-ticker"/);
    expect(src("../public/js/app.js")).toMatch(/setTimeout\(\(\) => startTicker\(\), 0\)/);
    const css = src("../public/css/app.css");
    expect(css).toMatch(/\.header-aside\s*\{[^}]*grid-template-areas:\s*"ticker tools"\s*"nav nav"/);
    expect(css).toMatch(/\.ticker-bar \{[^}]*min-height: 2rem/);
    expect(css).toMatch(/\.stats-ticker:hover \.ticker-track, \.ticker-viewport:focus-within \.ticker-track[^{]*\{ animation-play-state: paused; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ticker-track \{ animation: none; width: auto; \}\s*\.ticker-list \{ flex-wrap: wrap;/);
    expect(css).not.toMatch(/#nav \{ order: 3; width: 100%/);
    const csp = src("../netlify.toml");
    expect(csp).toMatch(/connect-src[^"]*https:\/\/coston2-api\.flare\.network[^"]*https:\/\/coston2-explorer\.flare\.network/);
  });
});
