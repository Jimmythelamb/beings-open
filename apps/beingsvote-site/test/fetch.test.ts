import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/fetch.js";
import { handleUpload } from "../src/upload.js";
import { ballotKey } from "../src/codes.js";
import { DEFAULT_LEDGER_ADDRESS, DEFAULT_LEGACY_LEDGER_ADDRESSES } from "../src/config.js";
import { BALLOT, ELECTION, MockStore, NOW, PNG, PNG_HASH, encodeRecord, fakeRpc, testConfig, uploadRequest } from "./helpers.js";

async function seeded(retentionDays = "14") {
  const store = new MockStore();
  await handleUpload(uploadRequest({ headers: { "x-retention-days": retentionDays } }), { store, config: testConfig(), now: () => NOW });
  return store;
}
const recorded = () => encodeRecord({ imageSha256: PNG_HASH, acceptedAt: 1_780_000_000 });
const get = (store: MockStore, rpc: ReturnType<typeof fakeRpc>, opts: { election?: string | null; code?: string | null; query?: string; now?: Date } = {}) => {
  const u = new URL("https://beingsvote.test/api/images");
  if (opts.election !== null) u.searchParams.set("election", opts.election ?? ELECTION);
  if (opts.query) u.search += (u.search ? "&" : "?") + opts.query;
  const headers: Record<string, string> = {};
  if (opts.code !== null) headers["x-ballot-code"] = opts.code ?? BALLOT;
  return handleFetch(new Request(u, { headers }), { store, config: testConfig(), now: () => opts.now ?? NOW, fetchImpl: rpc.fetchImpl });
};

describe("voter fetch (chain lookup)", () => {
  it("returns the image for a recorded ballot, with private no-store headers", async () => {
    const rpc = fakeRpc(recorded());
    const res = await get(await seeded(), rpc);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-image-sha256")).toBe(PNG_HASH);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // the eth_call asked for exactly records(electionKey, ballotKey) on the configured contract
    const call = rpc.calls[0] as { method: string; params: [{ to: string; data: string }, string] };
    expect(call.method).toBe("eth_call");
    expect(call.params[0].to).toBe(DEFAULT_LEDGER_ADDRESS);
    expect(rpc.calls).toHaveLength(1);
    expect(call.params[0].data.endsWith(ballotKey(BALLOT).slice(2))).toBe(true);
  });

  it("falls back to a legacy ledger when the current one has no record", async () => {
    const legacy = DEFAULT_LEGACY_LEDGER_ADDRESSES[0]!;
    const rpc = fakeRpc(recorded());
    const real = rpc.fetchImpl;
    const calls: string[] = [];
    rpc.fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body) as { params: [{ to: string }] };
      calls.push(body.params[0].to);
      const to = body.params[0].to.toLowerCase();
      if (to === DEFAULT_LEDGER_ADDRESS.toLowerCase()) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: encodeRecord({ imageSha256: "00".repeat(32), acceptedAt: 0 }) }) };
      }
      return real(url, init);
    };
    const res = await get(await seeded(), rpc);
    expect(res.status).toBe(200);
    expect(calls.map((a) => a.toLowerCase())).toEqual([DEFAULT_LEDGER_ADDRESS.toLowerCase(), legacy.toLowerCase()]);
  });

  it("answers 502 when the current ledger misses and a legacy ledger cannot be read", async () => {
    const rpc = fakeRpc(recorded());
    rpc.fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body) as { params: [{ to: string }] };
      const to = body.params[0].to.toLowerCase();
      if (to === DEFAULT_LEDGER_ADDRESS.toLowerCase()) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: encodeRecord({ imageSha256: "00".repeat(32), acceptedAt: 0 }) }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    };
    expect((await get(await seeded(), rpc)).status).toBe(502);
  });

  it("normalizes a ballot code typed with dashes and lower case", async () => {
    const res = await get(await seeded(), fakeRpc(recorded()), { code: "4f9q-7m2x-ht8b" });
    expect(res.status).toBe(200);
  });

  it("accepts the code in the query string as a fallback", async () => {
    const res = await get(await seeded(), fakeRpc(recorded()), { code: null, query: `ballotCode=${BALLOT}` });
    expect(res.status).toBe(200);
  });

  it("404 when the ballot is not recorded on-chain (acceptedAt = 0)", async () => {
    const res = await get(await seeded(), fakeRpc(encodeRecord({ imageSha256: "00".repeat(32), acceptedAt: 0 })));
    expect(res.status).toBe(404);
  });

  it("404 when the chain's hash has no stored image (wrong ballot cannot reach someone else's image)", async () => {
    const res = await get(await seeded(), fakeRpc(encodeRecord({ imageSha256: "ab".repeat(32), acceptedAt: 5 })));
    expect(res.status).toBe(404);
  });

  it("404 when the stored blob belongs to a different ballot hash", async () => {
    const store = await seeded();
    store.map.get(`${ELECTION}/${PNG_HASH}`)!.metadata.ballotCodeHash = ballotKey("AAAAAAAAAAAA");
    expect((await get(store, fakeRpc(recorded()))).status).toBe(404);
  });

  it("400 without a ballot code, with a bad code or with a bad election", async () => {
    const store = await seeded();
    expect((await get(store, fakeRpc(recorded()), { code: null })).status).toBe(400);
    expect((await get(store, fakeRpc(recorded()), { code: "4F9Q7M2XHT8U" })).status).toBe(400);
    expect((await get(store, fakeRpc(recorded()), { election: null })).status).toBe(400);
    expect((await get(store, fakeRpc(recorded()), { election: "x/../y" })).status).toBe(400);
  });

  it("never consults the chain for malformed input", async () => {
    const rpc = fakeRpc(recorded());
    await get(await seeded(), rpc, { code: "bad" });
    expect(rpc.calls.length).toBe(0);
  });

  it("410 once past deleteAfter (even before the daily cleanup has run), and the hash is still shown", async () => {
    const res = await get(await seeded("14"), fakeRpc(recorded()), { now: new Date("2026-11-15T12:00:00.000Z") });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { imageSha256: string }).imageSha256).toBe(PNG_HASH);
  });

  it("500 if the stored bytes no longer hash to the on-chain value", async () => {
    const store = await seeded();
    store.map.get(`${ELECTION}/${PNG_HASH}`)!.data[12] = (store.map.get(`${ELECTION}/${PNG_HASH}`)!.data[12] ?? 0) ^ 1;
    expect((await get(store, fakeRpc(recorded()))).status).toBe(500);
  });

  it("502 when the RPC fails; nothing is served", async () => {
    for (const r of [{ error: "boom" }, { httpStatus: 503 }, "0x", "0x1234"] as const) {
      const res = await get(await seeded(), fakeRpc(r as never));
      expect(res.status).toBe(502);
    }
  });

  it("has no listing: no parameter reaches a blob except through the chain record", async () => {
    // Asking for a hash directly is ignored: only the ballot's own on-chain hash is served.
    const store = await seeded();
    const res = await get(store, fakeRpc(encodeRecord({ imageSha256: "cd".repeat(32), acceptedAt: 9 })), { query: `imageHash=${PNG_HASH}&prefix=${ELECTION}` });
    expect(res.status).toBe(404);
  });
});

describe("public hash fetch", () => {
  const policyOn = async () => ({ publicBallotImages: true, retentionDays: 30 });
  const policyOff = async () => ({ publicBallotImages: false, retentionDays: 30 });
  async function publicSeeded() {
    const store = new MockStore();
    await handleUpload(uploadRequest({ headers: { "x-retention-days": "30", "x-public-images": "true" } }), { store, config: testConfig(), now: () => NOW });
    return store;
  }
  const publicGet = (
    store: MockStore,
    rpc: ReturnType<typeof fakeRpc>,
    opts: { hash?: string | null; query?: string; header?: boolean; policyFor?: typeof policyOn | typeof policyOff | null; now?: Date; limiter?: import("../src/rateLimit.js").FixedWindowLimiter } = {},
  ) => {
    const u = new URL("https://beingsvote.test/api/images");
    u.searchParams.set("election", ELECTION);
    const hash = opts.hash === null ? "" : (opts.hash ?? PNG_HASH);
    const headers: Record<string, string> = {};
    if (opts.header !== false && hash) headers["x-image-sha256"] = hash;
    if (opts.query) u.search += (u.search ? "&" : "?") + opts.query;
    return handleFetch(new Request(u, { headers }), {
      store,
      config: testConfig(),
      now: () => opts.now ?? NOW,
      fetchImpl: rpc.fetchImpl,
      ...(opts.policyFor === null ? {} : { policyFor: opts.policyFor ?? policyOn }),
      ...(opts.limiter ? { publicLimiter: opts.limiter } : {}),
    });
  };

  it("serves one image by election code and fingerprint when the setting is on", async () => {
    const rpc = fakeRpc(recorded());
    const res = await publicGet(await publicSeeded(), rpc);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG));
    expect(res.headers.get("x-image-sha256")).toBe(PNG_HASH);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const call = rpc.calls[0] as { params: [{ data: string; to: string }] };
    expect(call.params[0].to).toBe(DEFAULT_LEDGER_ADDRESS);
    expect(rpc.calls).toHaveLength(1);
    expect(call.params[0].data.endsWith(ballotKey(BALLOT).slice(2))).toBe(true);
  });

  it("falls back to a legacy ledger for a public fingerprint that is only on the earlier set", async () => {
    const legacy = DEFAULT_LEGACY_LEDGER_ADDRESSES[0]!;
    const calls: string[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: [{ to: string }] };
      calls.push(body.params[0].to);
      const onCurrent = body.params[0].to.toLowerCase() === DEFAULT_LEDGER_ADDRESS.toLowerCase();
      const result = onCurrent ? encodeRecord({ imageSha256: "00".repeat(32), acceptedAt: 0 }) : recorded();
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const res = await publicGet(await publicSeeded(), { fetchImpl, calls: [] });
    expect(res.status).toBe(200);
    expect(calls.map((a) => a.toLowerCase())).toEqual([DEFAULT_LEDGER_ADDRESS.toLowerCase(), legacy.toLowerCase()]);
  });

  it("accepts the fingerprint in the query string (image or imageHash) and with a 0x prefix", async () => {
    const store = await publicSeeded();
    expect((await publicGet(store, fakeRpc(recorded()), { header: false, query: `image=${PNG_HASH}` })).status).toBe(200);
    expect((await publicGet(store, fakeRpc(recorded()), { header: false, query: `imageHash=0x${PNG_HASH}` })).status).toBe(200);
  });

  it("403 when the election setting is off, even if the blob was marked public", async () => {
    const res = await publicGet(await publicSeeded(), fakeRpc(recorded()), { policyFor: policyOff });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not public/);
  });

  it("404 when the setting is unknown and the blob was not marked public (fail closed)", async () => {
    const store = await seeded("14");
    const res = await publicGet(store, fakeRpc(recorded()), { policyFor: null });
    expect(res.status).toBe(404);
  });

  it("serves from metadata when the policy file cannot be loaded but the upload was marked public", async () => {
    const res = await publicGet(await publicSeeded(), fakeRpc(recorded()), { policyFor: null });
    expect(res.status).toBe(200);
  });

  it("410 Image expired after deleteAfter, and still names the hash", async () => {
    const res = await publicGet(await publicSeeded(), fakeRpc(recorded()), { now: new Date("2026-12-02T12:00:00.000Z") });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; imageSha256: string };
    expect(body.error).toBe("Image expired");
    expect(body.imageSha256).toBe(PNG_HASH);
  });

  it("404 when the fingerprint is not on the ledger for this election", async () => {
    const res = await publicGet(await publicSeeded(), fakeRpc(encodeRecord({ imageSha256: "ab".repeat(32), acceptedAt: 5 })));
    expect(res.status).toBe(404);
  });

  it("does not list: a prefix or a second hash does not change which blob is considered", async () => {
    const store = await publicSeeded();
    const res = await publicGet(store, fakeRpc(recorded()), { header: false, query: `image=${PNG_HASH}&prefix=${ELECTION}` });
    expect(res.status).toBe(200);
  });

  it("rate-limits unauthenticated hash lookups", async () => {
    const { FixedWindowLimiter } = await import("../src/rateLimit.js");
    const limiter = new FixedWindowLimiter(2);
    const store = await publicSeeded();
    const one = await publicGet(store, fakeRpc(recorded()), { limiter });
    const two = await publicGet(store, fakeRpc(recorded()), { limiter });
    const three = await publicGet(store, fakeRpc(recorded()), { limiter });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(three.status).toBe(429);
  });

  it("still uses the voter path when a ballot code is also present, even if the setting is off", async () => {
    const store = await seeded("14");
    const u = new URL("https://beingsvote.test/api/images");
    u.searchParams.set("election", ELECTION);
    u.searchParams.set("imageHash", PNG_HASH);
    const res = await handleFetch(new Request(u, { headers: { "x-ballot-code": BALLOT } }), {
      store,
      config: testConfig(),
      now: () => NOW,
      fetchImpl: fakeRpc(recorded()).fetchImpl,
      policyFor: policyOff,
    });
    expect(res.status).toBe(200);
  });
});
