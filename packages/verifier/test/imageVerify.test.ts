import { Interface, Wallet, verifyMessage } from "ethers";
import { describe, expect, it } from "vitest";
import { electionKey, sha256Hex } from "@beings/core";
import {
  StoreClient,
  StoreError,
  challengeMessage,
  imageFileName,
  readLedgerImages,
  signChallenge,
  verifyImages,
  type HttpFetch,
  type LedgerImages,
  type LogSource,
  type Manifest,
} from "../src/imageVerify.js";

const ELECTION = "BEINGS-2026-4CRWX2";
const wallet = new Wallet("0x" + "11".repeat(32));
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const IMAGES = [1, 2, 3].map((n) => ({ bytes: png(n), hash: sha256Hex(png(n)) }));

const ledgerOf = (hashes: string[], extra: Partial<LedgerImages> = {}): LedgerImages => ({
  records: hashes.length,
  hashes: new Map(hashes.map((h) => [h, 1])),
  fromBlock: 1,
  toBlock: 100,
  ...extra,
});

/** A fake store implementing the same contract as the site. `bytesFor` lets a test serve something else. */
function fakeStore(opts: { listed?: typeof IMAGES; bytesFor?: (h: string) => Uint8Array | number; expiredOmitted?: number; contentType?: string } = {}) {
  const listed = opts.listed ?? IMAGES;
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    requests.push({ url, headers: init.headers });
    const u = new URL(url);
    if (u.pathname === "/api/verifier/images") {
      const m: Manifest = {
        election: ELECTION,
        generatedAt: "2026-11-01T12:00:00.000Z",
        count: listed.length,
        expiredOmitted: opts.expiredOmitted ?? 0,
        images: listed.map((i) => ({ imageHash: i.hash, contentType: opts.contentType ?? "image/png", size: i.bytes.byteLength, uploadedAt: "2026-10-30T00:00:00.000Z" })),
      };
      return new Response(JSON.stringify(m), { status: 200, headers: { "content-type": "application/json" } }) as never;
    }
    const hash = u.pathname.split("/").pop()!;
    const found = listed.find((i) => i.hash === hash);
    const served = opts.bytesFor ? opts.bytesFor(hash) : found?.bytes;
    if (served === undefined) return new Response("{}", { status: 404 }) as never;
    if (typeof served === "number") return new Response("{}", { status: served }) as never;
    return new Response(served as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "image/png" } }) as never;
  };
  return { fetchImpl, requests };
}

const client = (fetchImpl: HttpFetch, extra = {}) => new StoreClient({ storeUrl: "https://beingsvote.test/", election: ELECTION, signer: wallet, fetchImpl, now: () => 1_780_000_000_000, sleep: async () => {}, ...extra });
const run = (store: StoreClient, ledger: LedgerImages, extra = {}) => verifyImages({ election: ELECTION, signerAddress: wallet.address, store, ledger, now: () => new Date("2026-11-01T12:00:00.000Z"), ...extra });

describe("signing the challenge", () => {
  it("signs exactly BEINGS-VERIFIER|<election>|<timestamp> with EIP-191 personal_sign", async () => {
    const h = await signChallenge(wallet, ELECTION, 1_780_000_000.9);
    expect(h["x-verifier-timestamp"]).toBe("1780000000");
    expect(verifyMessage(`BEINGS-VERIFIER|${ELECTION}|1780000000`, h["x-verifier-signature"]!)).toBe(wallet.address);
    expect(challengeMessage(ELECTION, 5)).toBe(`BEINGS-VERIFIER|${ELECTION}|5`);
  });

  it("every request carries a fresh signature for the election in the URL", async () => {
    const s = fakeStore();
    let t = 1_780_000_000_000;
    const c = client(s.fetchImpl, { now: () => (t += 60_000) });
    await c.manifest();
    await c.image(IMAGES[0]!.hash);
    expect(s.requests.map((r) => r.headers["x-verifier-timestamp"])).toEqual(["1780000060", "1780000120"]);
    for (const r of s.requests) {
      expect(new URL(r.url).searchParams.get("election")).toBe(ELECTION);
      expect(verifyMessage(challengeMessage(ELECTION, r.headers["x-verifier-timestamp"]!), r.headers["x-verifier-signature"]!)).toBe(wallet.address);
    }
    expect(JSON.stringify(s.requests)).not.toContain("1".repeat(64)); // the private key is never sent
  });

  it("retries 429/5xx with backoff and gives up with the status", async () => {
    let n = 0;
    const flaky: HttpFetch = async () => (++n < 3 ? (new Response("{}", { status: 429, headers: { "retry-after": "1" } }) as never) : (new Response(JSON.stringify({ election: ELECTION, images: [], count: 0, expiredOmitted: 0, generatedAt: "" }), { status: 200 }) as never));
    expect((await client(flaky).manifest()).count).toBe(0);
    expect(n).toBe(3);
    const down: HttpFetch = async () => new Response("no", { status: 403 }) as never;
    await expect(client(down).manifest()).rejects.toThrow(/403/);
  });

  it("refuses a manifest that names a different election", async () => {
    const wrong: HttpFetch = async () => new Response(JSON.stringify({ election: "BEINGS-2026-AAAAAA", images: [], count: 0, expiredOmitted: 0, generatedAt: "" }), { status: 200 }) as never;
    await expect(client(wrong).manifest()).rejects.toThrow(/not for this election/);
  });

  it("never requests a path built from a malformed manifest hash", async () => {
    await expect(client(fakeStore().fetchImpl).image("../../etc/passwd")).rejects.toBeInstanceOf(StoreError);
  });
});

describe("verifyImages", () => {
  it("all good: every image matches the manifest and the ledger", async () => {
    const saved: string[] = [];
    const { report } = await run(client(fakeStore().fetchImpl), ledgerOf(IMAGES.map((i) => i.hash)), { onVerified: (e: { imageHash: string }) => void saved.push(e.imageHash) });
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.verified).toEqual(IMAGES.map((i) => i.hash).sort());
    expect(saved.sort()).toEqual(report.verified);
    expect(report.onChain).toEqual({ records: 3, distinctImageHashes: 3, fromBlock: 1, toBlock: 100 });
  });

  it("detects a store that serves different bytes than the manifest hash (and does not save them)", async () => {
    const victim = IMAGES[1]!.hash;
    const store = fakeStore({ bytesFor: (h) => (h === victim ? png(99) : IMAGES.find((i) => i.hash === h)!.bytes) });
    const saved: string[] = [];
    const { report } = await run(client(store.fetchImpl), ledgerOf(IMAGES.map((i) => i.hash)), { onVerified: (e: { imageHash: string }) => void saved.push(e.imageHash) });
    expect(report.ok).toBe(false);
    expect(report.problems.find((p) => p.kind === "hash-mismatch")).toMatchObject({ imageHash: victim });
    expect(report.verified).not.toContain(victim);
    expect(saved).not.toContain(victim);
  });

  it("detects an image the ledger has no record of", async () => {
    const { report } = await run(client(fakeStore().fetchImpl), ledgerOf([IMAGES[0]!.hash, IMAGES[1]!.hash]));
    expect(report.problems).toEqual([expect.objectContaining({ kind: "not-on-chain", imageHash: IMAGES[2]!.hash })]);
    expect(report.verified).toHaveLength(2);
  });

  it("detects images the ledger has but the store does not list (missing), mentioning expired ones", async () => {
    const lost = sha256Hex("lost");
    const { report } = await run(client(fakeStore({ expiredOmitted: 1 }).fetchImpl), ledgerOf([...IMAGES.map((i) => i.hash), lost]));
    expect(report.ok).toBe(false);
    const p = report.problems.find((x) => x.kind === "missing")!;
    expect(p.imageHash).toBe(lost);
    expect(p.detail).toMatch(/past retention/);
  });

  it("reports listed images that cannot be downloaded (404 and 410)", async () => {
    const [a, b] = [IMAGES[0]!.hash, IMAGES[1]!.hash];
    const store = fakeStore({ bytesFor: (h) => (h === a ? 410 : h === b ? 404 : IMAGES.find((i) => i.hash === h)!.bytes) });
    const { report } = await run(client(store.fetchImpl), ledgerOf(IMAGES.map((i) => i.hash)));
    expect(report.problems.map((p) => [p.kind, p.imageHash]).sort()).toEqual([["download-failed", a], ["download-failed", b]].sort());
    expect(report.problems.find((p) => p.imageHash === a)!.detail).toMatch(/410/);
    expect(report.verified).toEqual([IMAGES[2]!.hash]);
  });

  it("flags a wrong content type or size against the manifest", async () => {
    const { report } = await run(client(fakeStore({ contentType: "application/pdf" }).fetchImpl), ledgerOf(IMAGES.map((i) => i.hash)));
    expect(report.problems.filter((p) => p.kind === "content-type-mismatch")).toHaveLength(3);
    const lying: HttpFetch = async (url, init) => {
      const r = await fakeStore().fetchImpl(url, init);
      if (new URL(url).pathname === "/api/verifier/images") {
        const m = (await r.json()) as Manifest;
        m.images[0]!.size += 1;
        return new Response(JSON.stringify(m), { status: 200 }) as never;
      }
      return r;
    };
    const { report: r2 } = await run(client(lying), ledgerOf(IMAGES.map((i) => i.hash)));
    expect(r2.problems.map((p) => p.kind)).toEqual(["size-mismatch"]);
  });

  it("flags duplicate and malformed manifest entries without fetching them", async () => {
    const odd: HttpFetch = async (url) => {
      if (new URL(url).pathname === "/api/verifier/images") {
        const e = { contentType: "image/png", size: 9, uploadedAt: "" };
        const m = { election: ELECTION, generatedAt: "", count: 3, expiredOmitted: 0, images: [{ imageHash: IMAGES[0]!.hash, ...e }, { imageHash: IMAGES[0]!.hash, ...e }, { imageHash: "../x", ...e }] };
        return new Response(JSON.stringify(m), { status: 200 }) as never;
      }
      return new Response(IMAGES[0]!.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "image/png" } }) as never;
    };
    const { report } = await run(client(odd), ledgerOf([IMAGES[0]!.hash]));
    expect(report.problems.map((p) => p.kind).sort()).toEqual(["bad-manifest-entry", "duplicate-in-manifest"]);
    expect(report.verified).toEqual([IMAGES[0]!.hash]);
  });

  it("file names are always <hash>.<ext>", () => {
    expect(imageFileName({ imageHash: IMAGES[0]!.hash, contentType: "image/jpeg" })).toBe(`${IMAGES[0]!.hash}.jpg`);
    expect(imageFileName({ imageHash: IMAGES[0]!.hash, contentType: "text/html" })).toBe(`${IMAGES[0]!.hash}.bin`);
    expect(() => imageFileName({ imageHash: "../../x", contentType: "image/png" })).toThrow();
  });
});

describe("reading the ledger's image hashes", () => {
  const iface = new Interface(["event BallotAccepted(bytes32 indexed electionKey, bytes32 indexed ballotKey, string results, bytes32 imageSha256, bytes32 recordSha256, bool reviewed)"]);
  const ev = iface.getEvent("BallotAccepted")!;
  const logFor = (hash: string, ballot = "0x" + "bb".repeat(32)) => {
    const enc = iface.encodeEventLog(ev, [electionKey(ELECTION), ballot, "V:a", "0x" + hash, "0x" + "cc".repeat(32), false]);
    return { topics: enc.topics, data: enc.data };
  };

  function fakeChain(logsByBlock: Record<number, ReturnType<typeof logFor>[]>, maxRange: number, head = 100) {
    const calls: { from: number; to: number; topics: string[] }[] = [];
    const source: LogSource = {
      getBlockNumber: async () => head,
      getLogs: async (f) => {
        calls.push({ from: f.fromBlock, to: f.toBlock, topics: f.topics });
        if (f.toBlock - f.fromBlock + 1 > maxRange) throw new Error(`requested too many blocks from ${f.fromBlock} to ${f.toBlock}, maximum is set to ${maxRange}`);
        const out: ReturnType<typeof logFor>[] = [];
        for (let b = f.fromBlock; b <= f.toBlock; b++) out.push(...(logsByBlock[b] ?? []));
        return out;
      },
    };
    return { source, calls };
  }

  it("collects imageSha256 from BallotAccepted logs for the election key, across chunks, counting repeats", async () => {
    const [a, b] = [IMAGES[0]!.hash, IMAGES[1]!.hash];
    const { source, calls } = fakeChain({ 3: [logFor(a)], 55: [logFor(b)], 56: [logFor(b, "0x" + "dd".repeat(32))] }, 30);
    const r = await readLedgerImages(source, ELECTION, { fromBlock: 1, chunk: 30 });
    expect(r.records).toBe(3);
    expect(r.hashes.get(a)).toBe(1);
    expect(r.hashes.get(b)).toBe(2);
    expect(r.toBlock).toBe(100);
    expect(calls.length).toBe(4); // 1-30, 31-60, 61-90, 91-100
    expect(calls[0]!.topics[1]).toBe(electionKey(ELECTION));
    expect(calls[0]!.topics[0]).toBe(ev.topicHash);
  });

  it("adapts when the RPC allows fewer blocks per request than asked for", async () => {
    const { source, calls } = fakeChain({ 40: [logFor(IMAGES[0]!.hash)] }, 10);
    const r = await readLedgerImages(source, ELECTION, { fromBlock: 1, chunk: 100, concurrency: 1 });
    expect(r.records).toBe(1);
    expect(Math.max(...calls.filter((c) => c.to - c.from + 1 <= 10).map((c) => c.to - c.from + 1))).toBe(10);
  });

  it("passes other errors through, and rejects an inverted range", async () => {
    const broken: LogSource = { getBlockNumber: async () => 10, getLogs: async () => { throw new Error("boom"); } };
    await expect(readLedgerImages(broken, ELECTION, { fromBlock: 1 })).rejects.toThrow("boom");
    await expect(readLedgerImages(broken, ELECTION, { fromBlock: 20, toBlock: 10 })).rejects.toThrow(/before/);
  });
});
