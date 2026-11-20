// @vitest-environment happy-dom
// A receipt link fills in the election code from the URL fragment, then removes it.
// It never fills in a ballot code and it does not look the ballot up until the voter asks.
// The lookup still reads the current contracts and, when the election is not there, the pre-pool set.
import { FetchRequest, FetchResponse, Interface, ethers } from "ethers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ABI } from "../public/js/abi.js";
import { electionTextFromFragment, hashAfterReadingElection, routeFromLocation, urlWithoutElectionFragment } from "../public/js/check-link.js";
import { CONFIG } from "../public/js/config.js";
import { renderVoter } from "../public/js/voter.js";

const ELECTION = "BEINGS-2026-K7M4Q2";
const BALLOT = "AAAAAAAAAAAA";
const RECEIPT_HASH = `#e=${ELECTION}&b=${BALLOT}`;

const registryIface = new Interface(ABI.registry);
const ledgerIface = new Interface(ABI.ledger);
const tallyIface = new Interface(ABI.tally);
const ZERO = "0x" + "00".repeat(32);
const ORGANIZER = "0x2222222222222222222222222222222222222222";
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
};

const CURRENT = CONFIG.contracts.registry.toLowerCase();
const LEGACY = CONFIG.legacySets[0]!.contracts.registry.toLowerCase();
const rpcCalls: { to: string; data: string }[] = [];
let home: "current" | "legacy" | "none" = "none";

function rpcAnswer(to: string, data: string): { result: string } | { error: string } {
  const addr = to.toLowerCase();
  const id = data.slice(0, 10).toLowerCase();
  const onLegacy = addr === LEGACY;
  const hasElection = (onLegacy && home === "legacy") || (!onLegacy && home === "current");
  if (id === SEL.elections) {
    const status = hasElection ? 2 : 0;
    const organizer = hasElection ? ORGANIZER : "0x0000000000000000000000000000000000000000";
    return { result: registryIface.encodeFunctionResult("elections", [organizer, status, 4, 4, 1, 1_700_000_000, 1_700_003_600, ZERO]) };
  }
  if (id === SEL.poolEnforced) {
    if (onLegacy) return { error: "execution reverted" };
    return { result: registryIface.encodeFunctionResult("poolEnforced", [false]) };
  }
  if (id === SEL.latestVersion) return { result: registryIface.encodeFunctionResult("latestVersion", [["local", "0x" + "11".repeat(32), 5]]) };
  if (id === SEL.deviceCount) return { result: registryIface.encodeFunctionResult("deviceCount", [1]) };
  if (id === SEL.recordCount) return { result: ledgerIface.encodeFunctionResult("recordCount", [1]) };
  if (id === SEL.spoiledCount) return { result: ledgerIface.encodeFunctionResult("spoiledCount", [0]) };
  if (id === SEL.correctionCount) return { result: ledgerIface.encodeFunctionResult("correctionCount", [0]) };
  if (id === SEL.resultCount) return { result: tallyIface.encodeFunctionResult("resultCount", [0]) };
  if (id === SEL.records) return { result: ledgerIface.encodeFunctionResult("records", ["V:c1", "0x" + "ab".repeat(32), "0x" + "cd".repeat(32), 10, false]) };
  if (id === SEL.spoiled) return { result: ledgerIface.encodeFunctionResult("spoiled", [false]) };
  if (id === SEL.head) return { result: ledgerIface.encodeFunctionResult("head", [0]) };
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
  FetchRequest.registerGetUrl(async (req: { body?: Uint8Array | null }) => {
    const text = req.body ? new TextDecoder().decode(req.body) : "null";
    const answered = answerRpc(JSON.parse(text));
    return new FetchResponse(200, "OK", { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify(answered)));
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("elections.json")) return new Response(JSON.stringify({ elections: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ message: "OK", result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  document.body.replaceChildren();
});

function electionCalls() {
  return rpcCalls.filter((c) => c.data.slice(0, 10).toLowerCase() === SEL.elections).map((c) => c.to.toLowerCase());
}

describe("fragment parser", () => {
  it("reads the election code from the fragment and ignores a ballot code", () => {
    expect(electionTextFromFragment(RECEIPT_HASH)).toBe(ELECTION);
    expect(electionTextFromFragment(`#/check?e=${ELECTION}&b=${BALLOT}`)).toBe(ELECTION);
    expect(electionTextFromFragment(`#/check?election=${ELECTION}`)).toBe(ELECTION);
    expect(electionTextFromFragment("#/results")).toBe("");
    expect(hashAfterReadingElection(RECEIPT_HASH, { checkFile: true })).toBe("");
    expect(hashAfterReadingElection(RECEIPT_HASH, { checkFile: false })).toBe("#/check");
    expect(urlWithoutElectionFragment({ pathname: "/check.html", search: "", hash: RECEIPT_HASH, checkFile: true })).toBe("/check.html");
    expect(routeFromLocation({ pathname: "/check.html", hash: "" }).path).toBe("/check");
    expect(routeFromLocation({ pathname: "/check.html", hash: RECEIPT_HASH }).path).toBe("/check");
    expect(routeFromLocation({ pathname: "/", hash: "#/results" }).path).toBe("/results");
    const url = `https://beingsvote.live/check.html#e=${ELECTION}`;
    expect(new URL(url).search).toBe("");
    expect(electionTextFromFragment(new URL(url).hash)).toBe(ELECTION);
  });
});

describe("Check my ballot page", () => {
  async function open(hash: string, path = "/check.html") {
    window.history.replaceState(null, "", `${path}${hash}`);
    const root = document.createElement("div");
    document.body.append(root);
    rpcCalls.length = 0;
    await renderVoter({ root, query: routeFromLocation({ pathname: path, hash: window.location.hash }).query, current: () => true });
    return root;
  }

  it("prefills the election, leaves the ballot blank, clears the fragment, and does not look anything up", async () => {
    const root = await open(RECEIPT_HASH);
    const election = root.querySelector<HTMLInputElement>("#v-election");
    const ballot = root.querySelector<HTMLInputElement>("#v-ballot");
    expect(election?.value).toBe(ELECTION);
    expect(ballot?.value).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/check.html");
    expect(window.location.search).toBe("");
    expect(root.querySelector(".voter-results")?.textContent).toBe("");
    expect(root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(electionCalls()).toEqual([]);
  });

  it("looks up on the current set and the pre-pool set only after the voter submits", async () => {
    home = "legacy";
    const root = await open(`#e=${ELECTION}`);
    const ballot = root.querySelector<HTMLInputElement>("#v-ballot");
    if (!ballot) throw new Error("ballot field missing");
    ballot.value = BALLOT;
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(root.textContent).toContain("Your ballot is on the ledger");
    const calls = electionCalls();
    expect(calls).toContain(CURRENT);
    expect(calls).toContain(LEGACY);
    expect(root.querySelector<HTMLInputElement>("#v-ballot")?.value).toBe(BALLOT);

    home = "current";
    rpcCalls.length = 0;
    const root2 = await open("#e=BEINGS-2026-TST001");
    const ballot2 = root2.querySelector<HTMLInputElement>("#v-ballot");
    if (!ballot2) throw new Error("ballot field missing");
    ballot2.value = BALLOT;
    root2.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(root2.textContent).toContain("Your ballot is on the ledger");
    const currentCalls = electionCalls();
    expect(currentCalls).toContain(CURRENT);
    expect(currentCalls).not.toContain(LEGACY);
  });
});
