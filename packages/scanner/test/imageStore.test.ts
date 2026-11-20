import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { ballotKey, electionKey, sha256Hex } from "@beings/core";
import { DEFAULT_STORE_URL, UploadError, resolveStoreBaseUrl, sniffContentType, uploadScan } from "../src/imageStore.js";
import { fetchAndVerifyImage, fetchOnChainImageHash, sha256HexWeb, verifyImageBytes } from "../src/verify.js";

const ELECTION = "BEINGS-2026-4CRWX2";
const BALLOT = "4F9Q7M2XHT8B";
const TOKEN = "t".repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);
const PNG_HASH = sha256Hex(PNG);

describe("sniffContentType", () => {
  it("knows png, jpeg and pdf and nothing else", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffContentType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("store URL", () => {
  it("uses the R2 Worker unless an https origin or local http URL is set", () => {
    expect(DEFAULT_STORE_URL).toBe("https://beings-ballot-images.beingsvote-test.workers.dev");
    expect(resolveStoreBaseUrl(undefined, undefined)).toBe(DEFAULT_STORE_URL);
    expect(resolveStoreBaseUrl(undefined, "")).toBe(DEFAULT_STORE_URL);
    expect(resolveStoreBaseUrl(undefined, "https://beingsvote.live")).toBe("https://beingsvote.live");
    expect(resolveStoreBaseUrl("https://images.example/", "https://other.example")).toBe("https://images.example");
    expect(resolveStoreBaseUrl(undefined, "http://127.0.0.1:8888")).toBe("http://127.0.0.1:8888");
    expect(() => resolveStoreBaseUrl(undefined, "http://images.example")).toThrow(UploadError);
    expect(() => resolveStoreBaseUrl("https://user:pw@images.example", undefined)).toThrow(UploadError);
    expect(() => resolveStoreBaseUrl("https://images.example/api", undefined)).toThrow(UploadError);
  });
});

describe("uploadScan", () => {
  it("computes the hash, sends the ballot KEY (not the code) and the bearer token", async () => {
    let seen: { url: string; init: any } | undefined;
    const res = await uploadScan({
      baseUrl: "https://beingsvote.live/",
      token: TOKEN,
      electionCode: ELECTION,
      ballotCode: BALLOT,
      bytes: PNG,
      retentionDays: 14,
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 201, json: async () => ({ status: "created", key: `${ELECTION}/${PNG_HASH}`, deleteAfter: "2026-11-15T00:00:00.000Z" }), text: async () => "" };
      },
    });
    expect(res.imageSha256).toBe(PNG_HASH);
    expect(seen!.url).toBe("https://beingsvote.live/api/images");
    const h = seen!.init.headers;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h["x-image-sha256"]).toBe(PNG_HASH);
    expect(h["x-ballot-key"]).toBe(ballotKey(BALLOT));
    expect(h["x-retention-days"]).toBe("14");
    expect(JSON.stringify(seen!.init.headers)).not.toContain(BALLOT);
  });

  it("refuses before sending when the expected hash does not match the bytes, or the file is not an image", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    const base = { token: TOKEN, electionCode: ELECTION, ballotCode: BALLOT, retentionDays: 14, fetchImpl: never as never };
    await expect(uploadScan({ ...base, bytes: PNG, expectedImageSha256: "00".repeat(32) })).rejects.toThrow(UploadError);
    await expect(uploadScan({ ...base, bytes: new TextEncoder().encode("hello") })).rejects.toThrow(/png, jpeg or pdf/);
    await expect(uploadScan({ ...base, token: "", bytes: PNG })).rejects.toThrow(/token/);
  });

  it("surfaces the server's refusal", async () => {
    await expect(
      uploadScan({ token: TOKEN, electionCode: ELECTION, ballotCode: BALLOT, bytes: PNG, retentionDays: 14, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }), text: async () => "" }) }),
    ).rejects.toThrow(/401.*unauthorized/);
  });
});

const iface = new Interface(["function records(bytes32,bytes32) view returns (string results, bytes32 imageSha256, bytes32 recordSha256, uint64 acceptedAt, bool reviewed)"]);
const rpc = (hash: string, acceptedAt: bigint) => {
  const calls: any[] = [];
  return {
    calls,
    fetchImpl: async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ result: iface.encodeFunctionResult("records", ["V:c1", "0x" + hash, "0x" + "22".repeat(32), acceptedAt, false]) }) };
    },
  };
};

describe("in-browser verify helper", () => {
  it("sha256HexWeb equals core's sha256Hex", async () => {
    expect(await sha256HexWeb(PNG)).toBe(PNG_HASH);
    expect(await sha256HexWeb(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("verifyImageBytes accepts the right hash (0x or not, any case) and rejects a changed image", async () => {
    expect((await verifyImageBytes(PNG, PNG_HASH)).ok).toBe(true);
    expect((await verifyImageBytes(PNG, "0x" + PNG_HASH.toUpperCase())).ok).toBe(true);
    const tampered = new Uint8Array(PNG);
    tampered[9] = 0;
    const r = await verifyImageBytes(tampered, PNG_HASH);
    expect(r.ok).toBe(false);
    expect(r.actual).not.toBe(r.expected);
  });

  it("reads the imageHash from the ledger with the keys core derives", async () => {
    const r = rpc(PNG_HASH, 5n);
    expect(await fetchOnChainImageHash(ELECTION, "4f9q-7m2x-ht8b", r)).toBe(PNG_HASH);
    expect(r.calls[0].params[0].data).toBe(iface.encodeFunctionData("records", [electionKey(ELECTION), ballotKey(BALLOT)]));
    expect(await fetchOnChainImageHash(ELECTION, BALLOT, rpc("00".repeat(32), 0n))).toBeNull();
  });

  const storeOk = (bytes: Uint8Array) => async () => ({ ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

  it("fetchAndVerifyImage: ok when the store's image matches the ledger", async () => {
    const r = await fetchAndVerifyImage({ electionCode: ELECTION, ballotCode: BALLOT, ...rpc(PNG_HASH, 5n), storeFetch: storeOk(PNG) });
    expect(r.ok).toBe(true);
    expect(r.bytes).not.toBeNull();
  });

  it("fetchAndVerifyImage: not ok, and no bytes returned, when the store sends a different image", async () => {
    const other = new Uint8Array([...PNG, 1]);
    const r = await fetchAndVerifyImage({ electionCode: ELECTION, ballotCode: BALLOT, ...rpc(PNG_HASH, 5n), storeFetch: storeOk(other) });
    expect(r.ok).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.actual).toBe(sha256Hex(other));
    expect(r.expected).toBe(PNG_HASH);
  });

  it("fetchAndVerifyImage: throws when the ballot is not on-chain", async () => {
    await expect(fetchAndVerifyImage({ electionCode: ELECTION, ballotCode: BALLOT, ...rpc("00".repeat(32), 0n), storeFetch: storeOk(PNG) })).rejects.toThrow(/not recorded/);
  });
});

// End to end with the real site handlers (same monorepo), an in-memory store and a fake chain: the scanner's upload
// is accepted by POST /api/images and the voter fetch then serves it and the verify helper accepts it.
const siteSrc = fileURLToPath(new URL("../../../apps/beingsvote-site/src/", import.meta.url));
describe.skipIf(!existsSync(siteSrc + "upload.ts"))("scanner <-> image-store site", () => {
  it("upload, voter fetch by ballot code, verify", async () => {
    const { handleUpload } = await import(pathToFileURL(siteSrc + "upload.ts").href);
    const { handleFetch } = await import(pathToFileURL(siteSrc + "fetch.ts").href);
    const { loadConfig } = await import(pathToFileURL(siteSrc + "config.ts").href);
    const map = new Map<string, { data: Uint8Array; metadata: Record<string, unknown> }>();
    const store = {
      async set(k: string, d: Uint8Array, o: any) {
        if (o.onlyIfNew && map.has(k)) return { modified: false };
        map.set(k, { data: new Uint8Array(d), metadata: { ...o.metadata } });
        return { modified: true };
      },
      async get(k: string) {
        return map.get(k) ?? null;
      },
      async getMetadata(k: string) {
        const e = map.get(k);
        return e ? { metadata: e.metadata } : null;
      },
      async delete(k: string) {
        map.delete(k);
      },
      async *listKeys() {
        yield* map.keys();
      },
    };
    const config = loadConfig({ SCANNER_UPLOAD_TOKEN: TOKEN });
    const now = () => new Date("2026-11-01T12:00:00.000Z");
    const site = (url: string, init: any) => handleUpload(new Request(url, init), { store, config, now });
    const up = await uploadScan({ baseUrl: "https://beingsvote.test", token: TOKEN, electionCode: ELECTION, ballotCode: BALLOT, bytes: PNG, retentionDays: 14, fetchImpl: async (u, i) => {
      const r: Response = await site(u, i);
      return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() };
    } });
    expect(up.status).toBe("created");
    const again = await uploadScan({ baseUrl: "https://beingsvote.test", token: TOKEN, electionCode: ELECTION, ballotCode: BALLOT, bytes: PNG, retentionDays: 14, fetchImpl: async (u, i) => {
      const r: Response = await site(u, i);
      return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() };
    } });
    expect(again.status).toBe("exists");

    const chain = rpc(PNG_HASH, 5n);
    const result = await fetchAndVerifyImage({
      electionCode: ELECTION,
      ballotCode: BALLOT,
      ...chain,
      storeUrl: "https://beingsvote.test",
      storeFetch: async (url, init) => {
        const r: Response = await handleFetch(new Request(url, { headers: init.headers }), { store, config, now, fetchImpl: chain.fetchImpl });
        return { ok: r.ok, status: r.status, headers: r.headers, arrayBuffer: () => r.arrayBuffer() };
      },
    });
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.bytes!)).toEqual(Buffer.from(PNG));
  });
});
