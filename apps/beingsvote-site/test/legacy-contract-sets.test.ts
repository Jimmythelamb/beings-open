// @vitest-environment happy-dom
// Current contracts are the ballot-pool set. Reads of elections that still live on the previous
// Coston2 deployment fall back to that set. Nothing here sends a transaction.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FetchRequest, FetchResponse, Interface, ethers } from "ethers";
import { beforeAll, describe, expect, it } from "vitest";
import { ABI } from "../public/js/abi.js";
import { CONFIG, contractAddress, contractSets, contractSetsForRead } from "../public/js/config.js";
import { discoverElections, getBallotEntry, getElection, getTally, loadLedgerHistory } from "../public/js/chain.js";
import { DEFAULT_LEDGER_ADDRESS, DEFAULT_REGISTRY_ADDRESS, DEFAULT_VERIFIER_REGISTRY_ADDRESS, loadConfig } from "../src/config.js";

const registryIface = new Interface(ABI.registry);
const ledgerIface = new Interface(ABI.ledger);
const tallyIface = new Interface(ABI.tally);
const ZERO = "0x" + "00".repeat(32);
const ORGANIZER = "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB";
const sel = (iface: Interface, name: string) => iface.getFunction(name)!.selector.toLowerCase();
const SEL = {
  elections: sel(registryIface, "elections"),
  poolEnforced: sel(registryIface, "poolEnforced"),
  latestVersion: sel(registryIface, "latestVersion"),
  deviceCount: sel(registryIface, "deviceCount"),
  recordCount: sel(ledgerIface, "recordCount"),
  spoiledCount: sel(ledgerIface, "spoiledCount"),
  correctionCount: sel(ledgerIface, "correctionCount"),
  records: sel(ledgerIface, "records"),
  spoiled: sel(ledgerIface, "spoiled"),
  head: sel(ledgerIface, "head"),
  resultCount: sel(tallyIface, "resultCount"),
  getResult: sel(tallyIface, "getResult"),
  perQuestion: sel(tallyIface, "perQuestion"),
};

const CURRENT = {
  registry: CONFIG.contracts.registry.toLowerCase(),
  ledger: CONFIG.contracts.ledger.toLowerCase(),
  tally: CONFIG.contracts.tally.toLowerCase(),
};
const legacySet = CONFIG.legacySets[0];
if (!legacySet) throw new Error("config.js is missing the pre-pool set");
const LEGACY = {
  registry: legacySet.contracts.registry.toLowerCase(),
  ledger: legacySet.contracts.ledger.toLowerCase(),
  tally: legacySet.contracts.tally.toLowerCase(),
};

type Home = "current" | "legacy" | "none";
let home: Home = "legacy";
const rpcCalls: { to: string; data: string }[] = [];
const httpCalls: string[] = [];

function emptyElection() {
  return registryIface.encodeFunctionResult("elections", ["0x0000000000000000000000000000000000000000", 0, 0, 0, 0, 0, 0, ZERO]);
}
function liveElection() {
  return registryIface.encodeFunctionResult("elections", [ORGANIZER, 2, 4, 4, 1, 1_700_000_000, 1_700_003_600, "0x" + "ab".repeat(32)]);
}

function rpcAnswer(to: string, data: string): { result: string } | { error: string } {
  const addr = to.toLowerCase();
  const id = data.slice(0, 10).toLowerCase();
  const onLegacy = addr === LEGACY.registry || addr === LEGACY.ledger || addr === LEGACY.tally;
  const hasElection = (onLegacy && home === "legacy") || (!onLegacy && home === "current");
  if (id === SEL.elections) return { result: hasElection ? liveElection() : emptyElection() };
  if (id === SEL.poolEnforced) {
    if (onLegacy) return { error: "execution reverted" };
    return { result: registryIface.encodeFunctionResult("poolEnforced", [false]) };
  }
  if (id === SEL.latestVersion) return { result: registryIface.encodeFunctionResult("latestVersion", [["local", "0x" + "11".repeat(32), 5]]) };
  if (id === SEL.deviceCount) return { result: registryIface.encodeFunctionResult("deviceCount", [1]) };
  if (id === SEL.recordCount) return { result: ledgerIface.encodeFunctionResult("recordCount", [2]) };
  if (id === SEL.spoiledCount) return { result: ledgerIface.encodeFunctionResult("spoiledCount", [0]) };
  if (id === SEL.correctionCount) return { result: ledgerIface.encodeFunctionResult("correctionCount", [0]) };
  if (id === SEL.resultCount) return { result: tallyIface.encodeFunctionResult("resultCount", [1]) };
  if (id === SEL.records) return { result: ledgerIface.encodeFunctionResult("records", ["V:c1", "0x" + "ab".repeat(32), "0x" + "cd".repeat(32), 10, false]) };
  if (id === SEL.spoiled) return { result: ledgerIface.encodeFunctionResult("spoiled", [false]) };
  if (id === SEL.head) return { result: ledgerIface.encodeFunctionResult("head", [0]) };
  if (id === SEL.getResult) {
    return {
      result: tallyIface.encodeFunctionResult("getResult", [[1, "0x" + "22".repeat(32), [4, 4, 4, 2, 0, 0, 2], 0, 1, ORGANIZER, "", "cid", "0x" + "33".repeat(32), 9]]),
    };
  }
  if (id === SEL.perQuestion) return { result: tallyIface.encodeFunctionResult("perQuestion", [2, 0, 0, 0]) };
  return { error: `unexpected call ${id} to ${to}` };
}

function answerRpc(payload: unknown) {
  const list = Array.isArray(payload) ? payload : [payload];
  const out = list.map((req: { id?: number; method?: string; params?: [{ to?: string; data?: string }] }) => {
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x72" };
    if (req.method === "eth_call" && req.params?.[0]?.to && req.params[0].data) {
      rpcCalls.push({ to: req.params[0].to, data: req.params[0].data });
      const decided = rpcAnswer(req.params[0].to, req.params[0].data);
      if ("error" in decided) return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: decided.error } };
      return { jsonrpc: "2.0", id: req.id, result: decided.result };
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: req.method ?? "unknown" } };
  });
  return Array.isArray(payload) ? out : out[0];
}

beforeAll(() => {
  (window as unknown as { ethers: typeof ethers }).ethers = ethers;
  // ethers talks to the RPC through its own getUrl hook, not window.fetch. Explorer logs use window.fetch.
  FetchRequest.registerGetUrl(async (req: { body?: Uint8Array | null }) => {
    const text = req.body ? new TextDecoder().decode(req.body) : "null";
    const answered = answerRpc(JSON.parse(text));
    return new FetchResponse(200, "OK", { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify(answered)));
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    httpCalls.push(url);
    if (init?.method === "POST") {
      const body = answerRpc(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("elections.json")) {
      return new Response(JSON.stringify({ elections: [{ code: "BEINGS-2026-WMRHGH", set: "pre-pool", file: "data/elections/BEINGS-2026-WMRHGH.json" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const parsed = new URL(url, "https://coston2-explorer.flare.network");
    const address = (parsed.searchParams.get("address") ?? "").toLowerCase();
    if (address === LEGACY.registry) {
      const key = ethers.id("BEINGS-2026-CHAIN1");
      const encoded = registryIface.encodeEventLog(registryIface.getEvent("ElectionCreated")!, [key, "BEINGS-2026-CHAIN1", ORGANIZER]);
      return new Response(
        JSON.stringify({
          message: "OK",
          result: [{ address, topics: encoded.topics, data: encoded.data, blockNumber: "0x10", transactionHash: "0x" + "ee".repeat(32) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (address === LEGACY.ledger || address === CURRENT.ledger) {
      return new Response(JSON.stringify({ message: "OK", result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "No logs found", result: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = fetchImpl as typeof fetch;
});

describe("contract set config", () => {
  const PREV_LEDGER = "0xF579913c90b86f102Fff8D07c6c16f465495013C";
  const PREV_REGISTRY = "0x651A078e51B69Eff17e22950573EbE0252f43E63";
  const PREV_TALLY = "0x9844040a1B4BEC18a384d68F29cE2bd5D24cB4f4";
  const PREV_VERIFIERS = "0xdb6A83242139E3b7D47c31588d8d06c64CE94316";

  it("points new elections at the ballot-pool contracts and keeps the previous set as a legacy read", () => {
    expect(CONFIG.deployBlock).toBe(37873904);
    expect(CONFIG.contracts).toEqual({
      registry: DEFAULT_REGISTRY_ADDRESS,
      ledger: DEFAULT_LEDGER_ADDRESS,
      tally: "0xeDaBF1D8597FC4CA0aB71fcF0E91a0be966E7892",
      verifiers: DEFAULT_VERIFIER_REGISTRY_ADDRESS,
    });
    expect(contractAddress("registry")).toBe(DEFAULT_REGISTRY_ADDRESS);
    expect(contractAddress("ledger")).toBe(DEFAULT_LEDGER_ADDRESS);
    expect(CONFIG.legacySets).toEqual([
      {
        id: "pre-pool",
        deployBlock: 37317124,
        contracts: { registry: PREV_REGISTRY, ledger: PREV_LEDGER, tally: PREV_TALLY, verifiers: PREV_VERIFIERS },
      },
    ]);
    const ids = (sets: ({ id: string } | null)[]) => sets.map((s) => s?.id ?? null);
    expect(ids(contractSets())).toEqual(["current", "pre-pool"]);
    expect(ids(contractSetsForRead({ set: "pre-pool" }))).toEqual(["pre-pool", "current"]);
    expect(ids(contractSetsForRead({ contractSet: { id: PREV_REGISTRY } }))).toEqual(["pre-pool", "current"]);
    expect(ids(contractSetsForRead({}))).toEqual(["current", "pre-pool"]);
  });

  it("tags the five existing elections as living on the pre-pool set", () => {
    const list = JSON.parse(readFileSync(resolve(__dirname, "../public/data/elections.json"), "utf8"));
    expect(list.elections.map((e: { code: string; set: string }) => [e.code, e.set])).toEqual([
      ["BEINGS-2026-WMRHGH", "pre-pool"],
      ["BEINGS-2026-4CRWX2", "pre-pool"],
      ["BEINGS-2026-75D8PK", "pre-pool"],
      ["BEINGS-2026-2MJTDK", "pre-pool"],
      ["BEINGS-2026-QB1TTH", "pre-pool"],
    ]);
  });

  it("lets Netlify and Worker env vars replace the current addresses without dropping the legacy list unless that list is set", () => {
    const cfg = loadConfig({});
    expect(cfg.ledgerAddress).toBe(DEFAULT_LEDGER_ADDRESS);
    expect(cfg.registryAddress).toBe(DEFAULT_REGISTRY_ADDRESS);
    expect(cfg.verifierRegistryAddress).toBe(DEFAULT_VERIFIER_REGISTRY_ADDRESS);
    expect(cfg.legacyLedgerAddresses).toEqual([PREV_LEDGER]);
    expect(cfg.legacyRegistryAddresses).toEqual([PREV_REGISTRY]);
    expect(cfg.legacyVerifierRegistryAddresses).toEqual([PREV_VERIFIERS]);
    const overridden = loadConfig({ LEDGER_ADDRESS: "0x" + "ab".repeat(20), LEGACY_LEDGER_ADDRESSES: "" });
    expect(overridden.ledgerAddress).toBe("0x" + "ab".repeat(20));
    expect(overridden.legacyLedgerAddresses).toEqual([]);
    expect(overridden.legacyRegistryAddresses).toEqual([PREV_REGISTRY]);
  });
});

describe("browser reads fall back to the legacy set", () => {
  it("finds an election that exists only on the previous registry, and reads its tally and ballot there", async () => {
    home = "legacy";
    rpcCalls.length = 0;
    const el = await getElection("BEINGS-2026-WMRHGH", { set: "pre-pool", file: "data/elections/BEINGS-2026-WMRHGH.json" });
    if (!el) throw new Error("legacy election was not found");
    expect(el.contractSet.id).toBe("pre-pool");
    expect(el.statusName).toBe("Open");
    expect(el.recordCount).toBe(2);
    expect(el.poolEnforced).toBe(false);
    expect(el.file).toBe("data/elections/BEINGS-2026-WMRHGH.json");
    const registries = rpcCalls.filter((c) => c.data.slice(0, 10).toLowerCase() === SEL.elections).map((c) => c.to.toLowerCase());
    expect(registries[0]).toBe(LEGACY.registry);
    expect(registries.includes(CURRENT.registry)).toBe(false);

    rpcCalls.length = 0;
    const tally = await getTally(el, 1);
    expect(tally?.version).toBe(1);
    expect(tally?.perQuestion[0]?.valid).toBe(2);
    expect(rpcCalls.every((c) => c.to.toLowerCase() === LEGACY.tally)).toBe(true);

    rpcCalls.length = 0;
    httpCalls.length = 0;
    const entry = await getBallotEntry(el, "AAAAAAAAAAAA", 1);
    expect(entry.found).toBe(true);
    expect(entry.results).toBe("V:c1");
    expect(rpcCalls.every((c) => c.to.toLowerCase() === LEGACY.ledger)).toBe(true);

    httpCalls.length = 0;
    const history = await loadLedgerHistory(el);
    expect(history.records).toEqual({});
    const ledgerLogs = httpCalls.filter((u) => u.toLowerCase().includes(LEGACY.ledger));
    expect(ledgerLogs.length).toBeGreaterThan(0);
    expect(ledgerLogs.every((u) => u.includes("fromBlock=37317124"))).toBe(true);
    expect(httpCalls.some((u) => u.toLowerCase().includes(CURRENT.ledger))).toBe(false);
  });

  it("stops at the current set when the election is there", async () => {
    home = "current";
    rpcCalls.length = 0;
    const el = await getElection("BEINGS-2026-NEW001");
    expect(el?.contractSet.id).toBe("current");
    expect(el?.poolEnforced).toBe(false);
    const tos = new Set(rpcCalls.map((c) => c.to.toLowerCase()));
    expect(tos.has(CURRENT.registry)).toBe(true);
    expect(tos.has(CURRENT.ledger)).toBe(true);
    expect(tos.has(LEGACY.registry)).toBe(false);
    expect(tos.has(LEGACY.ledger)).toBe(false);
  });

  it("returns null only after both sets say the code is absent", async () => {
    home = "none";
    rpcCalls.length = 0;
    expect(await getElection("BEINGS-2026-ZZZZZZ")).toBeNull();
    const tos = rpcCalls.map((c) => c.to.toLowerCase());
    expect(tos).toContain(CURRENT.registry);
    expect(tos).toContain(LEGACY.registry);
  });

  it("discovers bundled elections and ElectionCreated logs from the legacy registry", async () => {
    httpCalls.length = 0;
    const { elections, discovered } = await discoverElections();
    const byCode = new Map(elections.map((e) => [e.code, e]));
    expect(byCode.get("BEINGS-2026-WMRHGH")?.set).toBe("pre-pool");
    expect(byCode.get("BEINGS-2026-CHAIN1")?.set).toBe("pre-pool");
    expect(discovered).toBe(true);
    const registries = httpCalls.filter((u) => u.includes("topic0="));
    expect(registries.some((u) => u.toLowerCase().includes(CURRENT.registry) && u.includes("fromBlock=37873904"))).toBe(true);
    expect(registries.some((u) => u.toLowerCase().includes(LEGACY.registry) && u.includes("fromBlock=37317124"))).toBe(true);
  });
});
