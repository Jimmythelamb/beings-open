import { describe, expect, it } from "vitest";
import { BALLOT_ROOT_AT_SELECTOR, POOL_ENFORCED_SELECTOR, checkBallotPool, verifySortedProof } from "../src/ballotPool.js";
import { ballotKey } from "../src/codes.js";
import { handleUpload } from "../src/upload.js";
import { ELECTION, MockStore, NOW, testConfig, uploadRequest } from "./helpers.js";

const CODE = "AAAAAAAAAAAA";
const KEY = ballotKey(CODE);

function rpc(enforced: boolean, root = KEY) {
  return async (_url: string, init: { body: string }) => {
    const data = (JSON.parse(init.body) as { params: [{ data: string }] }).params[0].data;
    const result = data.startsWith(`0x${POOL_ENFORCED_SELECTOR}`) ? `0x${"0".repeat(63)}${enforced ? "1" : "0"}` : root;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

describe("ballot pool check", () => {
  it("verifies a one-leaf proof and rejects a different leaf", () => {
    expect(verifySortedProof(KEY, KEY, [])).toBe(true);
    expect(verifySortedProof(KEY, ballotKey("BBBBBBBBBBBB"), [])).toBe(false);
    expect(verifySortedProof(KEY, KEY, ["0x" + "11".repeat(32)])).toBe(false);
  });

  it("allows an old registry and a pooled ballot with a proof, and refuses a pooled ballot without one", async () => {
    const opts = { rpcUrl: "https://rpc.example", registryAddress: "0x" + "11".repeat(20) };
    const down = await checkBallotPool({ electionCode: ELECTION, ballotKey: KEY, proof: null, rootIndex: 0 }, { ...opts, fetchImpl: async () => { throw new Error("down"); } });
    expect(down.ok).toBe(true);
    const old = await checkBallotPool({ electionCode: ELECTION, ballotKey: KEY, proof: null, rootIndex: 0 }, { ...opts, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } }) }) });
    expect(old.ok).toBe(true);
    const missing = await checkBallotPool({ electionCode: ELECTION, ballotKey: KEY, proof: null, rootIndex: 0 }, { ...opts, fetchImpl: rpc(true) });
    expect(missing.ok).toBe(false);
    const ok = await checkBallotPool({ electionCode: ELECTION, ballotKey: KEY, proof: [], rootIndex: 0 }, { ...opts, fetchImpl: rpc(true) });
    expect(ok.ok).toBe(true);
    const bad = await checkBallotPool({ electionCode: ELECTION, ballotKey: KEY, proof: ["0x" + "22".repeat(32)], rootIndex: 0 }, { ...opts, fetchImpl: rpc(true) });
    expect(bad.ok).toBe(false);
    expect(BALLOT_ROOT_AT_SELECTOR).toMatch(/^[0-9a-f]{8}$/);
  });

  it("the upload handler uses the pool check and never stores the code", async () => {
    const store = new MockStore();
    const refused = await handleUpload(uploadRequest({ headers: { "x-ballot-key": KEY } }), {
      store,
      config: testConfig(),
      now: () => NOW,
      poolCheck: async () => ({ ok: false, error: "this ballot is not in the election's ballot pool" }),
    });
    expect(refused.status).toBe(422);
    expect(store.map.size).toBe(0);
    const accepted = await handleUpload(uploadRequest({ headers: { "x-ballot-key": KEY, "x-ballot-proof": "", "x-ballot-root-index": "0" } }), {
      store,
      config: testConfig(),
      now: () => NOW,
      poolCheck: async () => ({ ok: true }),
    });
    expect(accepted.status).toBe(201);
    expect(JSON.stringify([...store.map.values()])).not.toContain(CODE);
  });
});
