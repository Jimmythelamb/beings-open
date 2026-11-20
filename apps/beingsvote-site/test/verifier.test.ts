import { Interface, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain.js";
import { DEFAULT_LEGACY_REGISTRY_ADDRESSES, DEFAULT_LEGACY_VERIFIER_REGISTRY_ADDRESSES, DEFAULT_REGISTRY_ADDRESS, DEFAULT_VERIFIER_REGISTRY_ADDRESS, parseAddressList } from "../src/config.js";
import { electionKey, sha256Hex } from "../src/codes.js";
import { FixedWindowLimiter } from "../src/rateLimit.js";
import { challengeMessage, recoverVerifier } from "../src/verifierAuth.js";
import { handleVerifierImages, type Manifest } from "../src/verifierImages.js";
import { ballotKey } from "../src/codes.js";
import { BALLOT, ELECTION, MockStore, NOW, PNG, PNG_HASH, testConfig } from "./helpers.js";

const OTHER_ELECTION = "BEINGS-2026-AAAAAA";
const verifier = new Wallet("0x" + "11".repeat(32));
const stranger = new Wallet("0x" + "22".repeat(32));
const organizer = new Wallet("0x" + "33".repeat(32));
const nowSec = Math.floor(NOW.getTime() / 1000);
const regIface = new Interface(["function nodes(address node) view returns (string name, string infoCid, uint64 registeredAt)"]);
const electionsIface = new Interface([
  "function elections(bytes32 key) view returns (address organizer, uint8 status, uint32 ballotCount, uint32 registeredVoters, uint8 quorum, uint64 opensAt, uint64 closesAt, bytes32 ballotListRoot)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

const sign = (w: Wallet, election: string, ts: number | string) => w.signMessage(challengeMessage(election, ts));

async function signedRequest(path: string, o: { wallet?: Wallet; signFor?: string; ts?: number; election?: string | null; method?: string } = {}): Promise<Request> {
  const ts = o.ts ?? nowSec;
  const wallet = o.wallet ?? verifier;
  const u = new URL(`https://beingsvote.test${path}`);
  if (o.election !== null) u.searchParams.set("election", o.election ?? ELECTION);
  const headers: Record<string, string> = {
    "x-verifier-timestamp": String(ts),
    "x-verifier-signature": await sign(wallet, o.signFor ?? o.election ?? ELECTION, ts),
    "x-nf-client-connection-ip": "203.0.113.7",
  };
  return new Request(u, { method: o.method ?? "GET", headers });
}

/** A fake chain: VerifierRegistry.nodes and ElectionRegistry.elections. Records every eth_call. */
function fakeRegistry(registeredAddresses: string[], fail?: "http", organizers: Record<string, string> = {}) {
  const calls: { to: string; data: string; kind: "nodes" | "elections" }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { params: [{ to: string; data: string }] };
    const data = body.params[0].data;
    if (fail) {
      calls.push({ ...body.params[0], kind: "nodes" });
      return { ok: false, status: 500, json: async () => ({}) };
    }
    try {
      const [addr] = regIface.decodeFunctionData("nodes", data);
      calls.push({ ...body.params[0], kind: "nodes" });
      const reg = registeredAddresses.map((a) => a.toLowerCase()).includes(String(addr).toLowerCase());
      const result = regIface.encodeFunctionResult("nodes", [reg ? "node" : "", "", reg ? 1_780_000_000n : 0n]);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    } catch {
      const [key] = electionsIface.decodeFunctionData("elections", data);
      calls.push({ ...body.params[0], kind: "elections" });
      const keyHex = String(key).toLowerCase();
      let found = ZERO;
      for (const [code, addr] of Object.entries(organizers)) {
        if (electionKey(code).toLowerCase() === keyHex) found = addr;
      }
      const result = electionsIface.encodeFunctionResult("elections", [found, 0, 0, 0, 0, 0, 0, "0x" + "00".repeat(32)]);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }
  };
  return { fetchImpl, calls };
}

const meta = (hash: string, deleteAfter: string, over: Record<string, unknown> = {}) =>
  ({ electionCode: ELECTION, ballotCodeHash: ballotKey(BALLOT), contentType: "image/png", size: PNG.byteLength, uploadedAt: "2026-10-30T09:00:00.000Z", deleteAfter, ...over }) as never;

async function seed() {
  const store = new MockStore();
  const png2 = new Uint8Array([...PNG, 99]);
  await store.set(`${ELECTION}/${PNG_HASH}`, PNG, { metadata: meta(PNG_HASH, "2026-11-15T12:00:00.000Z") });
  await store.set(`${ELECTION}/${sha256Hex(png2)}`, png2, { metadata: meta("", "2026-11-20T12:00:00.000Z", { size: png2.byteLength, ballotCodeHash: ballotKey("AAAAAAAAAAAA") }) });
  const old = new Uint8Array([...PNG, 7]);
  await store.set(`${ELECTION}/${sha256Hex(old)}`, old, { metadata: meta("", "2026-10-31T00:00:00.000Z", { size: old.byteLength }) });
  await store.set(`${OTHER_ELECTION}/${PNG_HASH}`, PNG, { metadata: meta("", "2026-11-15T12:00:00.000Z", { electionCode: OTHER_ELECTION }) });
  return { store, png2, old };
}

const run = (req: Request, store: MockStore, o: { over?: object; registered?: string[]; organizers?: Record<string, string>; now?: Date; limiter?: FixedWindowLimiter } = {}) => {
  const reg = fakeRegistry(o.registered ?? [], undefined, o.organizers ?? {});
  return {
    reg,
    res: handleVerifierImages(req, {
      store,
      config: testConfig({ verifierAuthMode: "allowlist", verifierAddresses: [verifier.address.toLowerCase()], ...o.over }),
      now: () => o.now ?? NOW,
      fetchImpl: reg.fetchImpl,
      registryCache: new Map(),
      organizerCache: new Map(),
      limiter: o.limiter ?? new FixedWindowLimiter(1000),
    }),
  };
};
const status = async (req: Request, store: MockStore, o = {}) => (await run(req, store, o).res).status;

describe("verifier signature auth (allowlist)", () => {
  it("accepts a valid, fresh signature from an allowlisted address", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images"), store)).toBe(200);
  });

  it("the signed message is exactly BEINGS-VERIFIER|<election>|<timestamp>, recovered by EIP-191", () => {
    expect(challengeMessage(ELECTION, 1780000000)).toBe(`BEINGS-VERIFIER|${ELECTION}|1780000000`);
  });

  it("recovers the signer's address from the headers", async () => {
    const sig = await sign(verifier, ELECTION, nowSec);
    expect(recoverVerifier(ELECTION, String(nowSec), sig, NOW)).toEqual({ address: verifier.address.toLowerCase() });
  });

  it("refuses an expired challenge (older than 5 minutes) and one from the future", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { ts: nowSec - 301 }), store)).toBe(401);
    expect(await status(await signedRequest("/api/verifier/images", { ts: nowSec + 301 }), store)).toBe(401);
    // the edges of the window are still fine
    expect(await status(await signedRequest("/api/verifier/images", { ts: nowSec - 300 }), store)).toBe(200);
    expect(await status(await signedRequest("/api/verifier/images", { ts: nowSec + 300 }), store)).toBe(200);
  });

  it("a signature made for another election does not work for this one", async () => {
    const { store } = await seed();
    const res = await run(await signedRequest("/api/verifier/images", { signFor: OTHER_ELECTION }), store).res;
    expect(res.status).toBe(403); // it recovers to some other address, which is nobody
  });

  it("a signature over a different timestamp than the header claims does not work", async () => {
    const { store } = await seed();
    const req = await signedRequest("/api/verifier/images");
    const headers = new Headers(req.headers);
    headers.set("x-verifier-timestamp", String(nowSec + 1));
    expect(await status(new Request(req.url, { headers }), store)).toBe(403);
  });

  it("refuses an address that is not on the allowlist, and registry membership does not help in allowlist mode", async () => {
    const { store } = await seed();
    const { res, reg } = run(await signedRequest("/api/verifier/images", { wallet: stranger }), store, { registered: [stranger.address] });
    expect((await res).status).toBe(403);
    expect(reg.calls.filter((c) => c.kind === "nodes").length).toBe(0); // allowlist mode never asks the verifier registry
    expect(reg.calls.some((c) => c.kind === "elections")).toBe(true); // it does ask whether this wallet is the organizer
  });

  it("401 for missing, malformed or garbage headers", async () => {
    const { store } = await seed();
    const url = `https://beingsvote.test/api/verifier/images?election=${ELECTION}`;
    const good = await signedRequest("/api/verifier/images");
    const sig = good.headers.get("x-verifier-signature")!;
    const cases: Record<string, string>[] = [
      {},
      { "x-verifier-timestamp": String(nowSec) },
      { "x-verifier-signature": sig },
      { "x-verifier-timestamp": "yesterday", "x-verifier-signature": sig },
      { "x-verifier-timestamp": "0" + nowSec, "x-verifier-signature": sig },
      { "x-verifier-timestamp": String(nowSec), "x-verifier-signature": "0x1234" },
      { "x-verifier-timestamp": String(nowSec), "x-verifier-signature": "0x" + "00".repeat(65) },
    ];
    for (const headers of cases) expect(await status(new Request(url, { headers }), store)).toBe(401);
  });

  it("503 in allowlist mode with an empty list (fails closed)", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images"), store, { over: { verifierAuthMode: "allowlist", verifierAddresses: [] } })).toBe(503);
  });

  it("answers errors with no-store and never leaks image data", async () => {
    const { store } = await seed();
    const res = await run(await signedRequest("/api/verifier/images", { wallet: stranger }), store).res;
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});

describe("verifier auth via the on-chain VerifierRegistry", () => {
  it("accepts a registered address in registry mode and asks the registry's nodes(address) on the configured contract", async () => {
    const { store } = await seed();
    const { res, reg } = run(await signedRequest("/api/verifier/images", { wallet: stranger }), store, { over: { verifierAuthMode: "registry", verifierAddresses: [] }, registered: [stranger.address] });
    expect((await res).status).toBe(200);
    expect(reg.calls[0]!.to).toBe(DEFAULT_VERIFIER_REGISTRY_ADDRESS);
    expect(regIface.decodeFunctionData("nodes", reg.calls[0]!.data)[0]).toBe(stranger.address);
  });

  it("accepts an address registered only on a legacy VerifierRegistry", async () => {
    const { store } = await seed();
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { params: [{ to: string; data: string }] };
      calls.push(body.params[0].to);
      const onLegacy = body.params[0].to.toLowerCase() === DEFAULT_LEGACY_VERIFIER_REGISTRY_ADDRESSES[0]!.toLowerCase();
      const result = regIface.encodeFunctionResult("nodes", [onLegacy ? "node" : "", "", onLegacy ? 1_780_000_000n : 0n]);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const res = await handleVerifierImages(await signedRequest("/api/verifier/images", { wallet: stranger }), {
      store,
      config: testConfig({ verifierAuthMode: "registry", verifierAddresses: [] }),
      now: () => NOW,
      fetchImpl,
      registryCache: new Map(),
      organizerCache: new Map(),
      limiter: new FixedWindowLimiter(100),
    });
    expect(res.status).toBe(200);
    expect(calls.map((a) => a.toLowerCase())).toEqual([
      DEFAULT_VERIFIER_REGISTRY_ADDRESS.toLowerCase(),
      DEFAULT_LEGACY_VERIFIER_REGISTRY_ADDRESSES[0]!.toLowerCase(),
    ]);
  });

  it("accepts the organizer recorded on a legacy ElectionRegistry", async () => {
    const { store } = await seed();
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { params: [{ to: string; data: string }] };
      const to = body.params[0].to;
      calls.push(to);
      const onLegacy = to.toLowerCase() === DEFAULT_LEGACY_REGISTRY_ADDRESSES[0]!.toLowerCase();
      const result = electionsIface.encodeFunctionResult("elections", [onLegacy ? organizer.address : ZERO, onLegacy ? 2 : 0, 0, 0, 0, 0, 0, "0x" + "00".repeat(32)]);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const res = await handleVerifierImages(await signedRequest("/api/verifier/images", { wallet: organizer }), {
      store,
      config: testConfig({ verifierAuthMode: "allowlist", verifierAddresses: [] }),
      now: () => NOW,
      fetchImpl,
      registryCache: new Map(),
      organizerCache: new Map(),
      limiter: new FixedWindowLimiter(100),
    });
    expect(res.status).toBe(200);
    expect(calls.map((a) => a.toLowerCase())).toEqual([
      DEFAULT_REGISTRY_ADDRESS.toLowerCase(),
      DEFAULT_LEGACY_REGISTRY_ADDRESSES[0]!.toLowerCase(),
    ]);
  });

  it("refuses an unregistered address in registry mode", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { wallet: stranger }), store, { over: { verifierAuthMode: "registry", verifierAddresses: [] }, registered: [verifier.address] })).toBe(403);
  });

  it("registry mode ignores the allowlist; either mode accepts both sources", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images"), store, { over: { verifierAuthMode: "registry" }, registered: [] })).toBe(403);
    expect(await status(await signedRequest("/api/verifier/images"), store, { over: { verifierAuthMode: "either" }, registered: [] })).toBe(200); // allowlisted
    expect(await status(await signedRequest("/api/verifier/images", { wallet: stranger }), store, { over: { verifierAuthMode: "either" }, registered: [stranger.address] })).toBe(200); // registered
    expect(await status(await signedRequest("/api/verifier/images", { wallet: stranger }), store, { over: { verifierAuthMode: "either" }, registered: [] })).toBe(403);
  });

  it("registry mode is allowed with an empty allowlist (no 503) and an RPC failure is a 502, not a pass", async () => {
    const { store } = await seed();
    const reg = fakeRegistry([], "http");
    const res = await handleVerifierImages(await signedRequest("/api/verifier/images", { wallet: stranger }), {
      store,
      config: testConfig({ verifierAuthMode: "registry", verifierAddresses: [] }),
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      registryCache: new Map(),
      limiter: new FixedWindowLimiter(100),
    });
    expect(res.status).toBe(502);
  });

  it("the default config (no VERIFIER_AUTH_MODE, no VERIFIER_ADDRESSES) admits any registered verifier, refuses others, never 503", async () => {
    const { store } = await seed();
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({ SCANNER_UPLOAD_TOKEN: "x".repeat(32) });
    const go = async (wallet: typeof stranger, registered: string[]) => {
      const reg = fakeRegistry(registered);
      return (await handleVerifierImages(await signedRequest("/api/verifier/images", { wallet }), { store, config: cfg, now: () => NOW, fetchImpl: reg.fetchImpl, registryCache: new Map(), limiter: new FixedWindowLimiter(100) })).status;
    };
    expect(await go(stranger, [stranger.address])).toBe(200);
    expect(await go(stranger, [])).toBe(403);
  });

  it("caches the registry answer briefly so a bulk download makes one lookup, not one per image", async () => {
    const { store } = await seed();
    const reg = fakeRegistry([stranger.address]);
    const cache = new Map();
    for (let i = 0; i < 3; i++) {
      const res = await handleVerifierImages(await signedRequest("/api/verifier/images", { wallet: stranger }), {
        store, config: testConfig({ verifierAuthMode: "registry", verifierAddresses: [] }), now: () => NOW, fetchImpl: reg.fetchImpl, registryCache: cache, limiter: new FixedWindowLimiter(100),
      });
      expect(res.status).toBe(200);
    }
    expect(reg.calls.length).toBe(1);
  });

  it("the default VERIFIER_AUTH_MODE is registry (open verification), unknown values fall back to it; bad addresses in the list are dropped", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig({ VERIFIER_AUTH_MODE: "open" }).verifierAuthMode).toBe("registry");
    expect(loadConfig({}).verifierAuthMode).toBe("registry");
    expect(loadConfig({}).verifierAddresses).toEqual([]);
    expect(loadConfig({ VERIFIER_AUTH_MODE: "allowlist" }).verifierAuthMode).toBe("allowlist");
    expect(loadConfig({ VERIFIER_AUTH_MODE: "Either" }).verifierAuthMode).toBe("either");
    expect(parseAddressList(`${verifier.address}, 0xnope ,${stranger.address.toUpperCase().replace("0X", "0x")}\n${verifier.address}`)).toEqual([verifier.address.toLowerCase(), stranger.address.toLowerCase()]);
  });
});

describe("organizer access to bulk images", () => {
  it("accepts a signed request from this election's organizer, even in allowlist mode and even when the allowlist is empty", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { wallet: organizer }), store, {
      over: { verifierAuthMode: "allowlist", verifierAddresses: [] },
      organizers: { [ELECTION]: organizer.address },
    })).toBe(200);
    expect(await status(await signedRequest("/api/verifier/images", { wallet: organizer }), store, {
      organizers: { [ELECTION]: organizer.address },
    })).toBe(200);
  });

  it("does not let the organizer of a different election through", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { wallet: organizer }), store, {
      over: { verifierAuthMode: "registry", verifierAddresses: [] },
      organizers: { [OTHER_ELECTION]: organizer.address },
    })).toBe(403);
  });

  it("still admits a registered verifier when the organizer is someone else", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { wallet: stranger }), store, {
      over: { verifierAuthMode: "registry", verifierAddresses: [] },
      registered: [stranger.address],
      organizers: { [ELECTION]: organizer.address },
    })).toBe(200);
  });
});

describe("manifest", () => {
  it("lists imageHash, contentType, size and uploadedAt for this election only, sorted, with no ballot hash", async () => {
    const { store, png2 } = await seed();
    const res = await run(await signedRequest("/api/verifier/images"), store).res;
    expect(res.status).toBe(200);
    const m = (await res.json()) as Manifest;
    expect(m.election).toBe(ELECTION);
    expect(m.count).toBe(2);
    expect(m.expiredOmitted).toBe(1);
    expect(m.images.map((i) => i.imageHash)).toEqual([PNG_HASH, sha256Hex(png2)].sort());
    const e = m.images.find((i) => i.imageHash === PNG_HASH)!;
    expect(e).toEqual({ imageHash: PNG_HASH, contentType: "image/png", size: PNG.byteLength, uploadedAt: "2026-10-30T09:00:00.000Z" });
    const text = JSON.stringify(m).toLowerCase();
    expect(text).not.toContain("ballotcodehash");
    expect(text).not.toContain(ballotKey(BALLOT).slice(2));
    expect(text).not.toContain(ballotKey("AAAAAAAAAAAA").slice(2));
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("an election with no images gives an empty manifest, and another election's images never leak in", async () => {
    const { store } = await seed();
    const res = await run(await signedRequest("/api/verifier/images", { election: "BEINGS-2026-BBBBBB" }), store).res;
    expect(((await res.json()) as Manifest).count).toBe(0);
  });

  it("requires a valid election code (400) before anything else", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { election: null }), store)).toBe(400);
    expect(await status(await signedRequest("/api/verifier/images", { election: "../x" }), store)).toBe(400);
  });

  it("only GET is allowed", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest("/api/verifier/images", { method: "DELETE" }), store)).toBe(405);
  });
});

describe("single image", () => {
  const path = (h: string) => `/api/verifier/images/${h}`;

  it("serves the bytes with no-store headers and the verified hash", async () => {
    const { store } = await seed();
    const res = await run(await signedRequest(path(PNG_HASH)), store).res;
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG));
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-image-sha256")).toBe(PNG_HASH);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain(`${PNG_HASH}.png`);
  });

  it("re-hashes before serving: a corrupted blob is a 500, never served", async () => {
    const { store } = await seed();
    const bad = new Uint8Array(PNG);
    bad[9] = 0xff;
    store.map.get(`${ELECTION}/${PNG_HASH}`)!.data = bad;
    const res = await run(await signedRequest(path(PNG_HASH)), store).res;
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("410 once deleteAfter has passed, even though the blob still exists", async () => {
    const { store, old } = await seed();
    const res = await run(await signedRequest(path(sha256Hex(old))), store).res;
    expect(res.status).toBe(410);
    // another image is available one second before its deleteAfter and gone at it (fresh signatures for those times)
    const t = new Date("2026-11-15T11:59:59.000Z");
    expect(await status(await signedRequest(path(PNG_HASH), { ts: Math.floor(t.getTime() / 1000) }), store, { now: t })).toBe(200);
    const t2 = new Date("2026-11-15T12:00:00.000Z");
    expect(await status(await signedRequest(path(PNG_HASH), { ts: Math.floor(t2.getTime() / 1000) }), store, { now: t2 })).toBe(410);
  });

  it("404 for an unknown hash and for another election's image; 400 for a malformed hash", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest(path(sha256Hex("nope"))), store)).toBe(404);
    expect(await status(await signedRequest(path(PNG_HASH), { election: "BEINGS-2026-BBBBBB" }), store)).toBe(404);
    for (const bad of ["abc", PNG_HASH + "0", PNG_HASH.slice(0, 63) + "g", PNG_HASH + "/x", "%2e%2e%2f" + PNG_HASH.slice(6)]) {
      expect(await status(await signedRequest(path(bad)), store)).toBe(400);
    }
    // a literal ../ is normalized away by the URL parser and lands outside the route
    expect(await status(await signedRequest(path("../" + PNG_HASH)), store)).toBe(404);
  });

  it("accepts an upper-case hash in the path", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest(path(PNG_HASH.toUpperCase())), store)).toBe(200);
  });

  it("needs auth: no image bytes for a stranger, an expired signature or no signature", async () => {
    const { store } = await seed();
    expect(await status(await signedRequest(path(PNG_HASH), { wallet: stranger }), store)).toBe(403);
    expect(await status(await signedRequest(path(PNG_HASH), { ts: nowSec - 3600 }), store)).toBe(401);
    expect(await status(new Request(`https://beingsvote.test${path(PNG_HASH)}?election=${ELECTION}`), store)).toBe(401);
  });
});

describe("rate limiting", () => {
  it("429 with Retry-After once a client exceeds its limit, before any signature work", async () => {
    const { store } = await seed();
    const limiter = new FixedWindowLimiter(2);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push(await status(await signedRequest("/api/verifier/images"), store, { limiter }));
    expect(codes).toEqual([200, 200, 429, 429]);
    const res = await run(await signedRequest("/api/verifier/images"), store, { limiter }).res;
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("the window resets, and clients are counted separately", () => {
    const l = new FixedWindowLimiter(1, 1000);
    expect(l.allow("a", 0)).toBe(true);
    expect(l.allow("a", 10)).toBe(false);
    expect(l.allow("b", 10)).toBe(true);
    expect(l.allow("a", 1000)).toBe(true);
  });
});
