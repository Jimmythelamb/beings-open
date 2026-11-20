import { loadConfig, type SiteConfig } from "../src/config.js";
import { sha256Hex, ballotKey } from "../src/codes.js";
import type { BlobStore, ImageMetadata } from "../src/store.js";
import type { FetchLike } from "../src/chain.js";

export const TOKEN = "t".repeat(40);
export const ELECTION = "BEINGS-2026-4CRWX2";
export const BALLOT = "4F9Q7M2XHT8B";
export const NOW = new Date("2026-11-01T12:00:00.000Z");

export function testConfig(over: Partial<SiteConfig> = {}): SiteConfig {
  return { ...loadConfig({ SCANNER_UPLOAD_TOKEN: TOKEN }), ...over };
}

/** In-memory BlobStore with the same semantics the site relies on (onlyIfNew, metadata, listing). */
export class MockStore implements BlobStore {
  map = new Map<string, { data: Uint8Array; metadata: Record<string, unknown> }>();
  async set(key: string, data: Uint8Array, options: { metadata: ImageMetadata; onlyIfNew?: boolean }) {
    if (options.onlyIfNew && this.map.has(key)) return { modified: false };
    this.map.set(key, { data: new Uint8Array(data), metadata: { ...options.metadata } });
    return { modified: true };
  }
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async getMetadata(key: string) {
    const e = this.map.get(key);
    return e ? { metadata: e.metadata } : null;
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async *listKeys(prefix?: string) {
    for (const k of [...this.map.keys()]) if (!prefix || k.startsWith(prefix)) yield k;
  }
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
export const PNG_HASH = sha256Hex(PNG);

export function uploadRequest(opts: { body?: Uint8Array; headers?: Record<string, string | null> } = {}): Request {
  const body = opts.body ?? PNG;
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "image/png",
    "x-election-code": ELECTION,
    "x-image-sha256": sha256Hex(body),
    "x-ballot-key": ballotKey(BALLOT),
    "x-retention-days": "14",
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Request("https://beingsvote.test/api/images", { method: "POST", headers, body: body as Uint8Array<ArrayBuffer> });
}

const hexWord = (hex: string) => hex.padStart(64, "0");

/** ABI-encode the return value of records(...): (string, bytes32, bytes32, uint64, bool). */
export function encodeRecord(o: { results?: string; imageSha256: string; acceptedAt: number; reviewed?: boolean }): string {
  const results = Buffer.from(o.results ?? "V:c1", "utf8");
  const padded = results.toString("hex").padEnd(Math.ceil(results.length / 32) * 64, "0");
  return (
    "0x" +
    hexWord((5 * 32).toString(16)) +
    hexWord(o.imageSha256) +
    hexWord("11".repeat(32)) +
    hexWord(o.acceptedAt.toString(16)) +
    hexWord(o.reviewed ? "1" : "0") +
    hexWord(results.length.toString(16)) +
    padded
  );
}

/** A fake JSON-RPC endpoint that answers eth_call with `result` and records the calls. */
export function fakeRpc(result: string | { error: string } | { httpStatus: number }): { fetchImpl: FetchLike; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (typeof result === "object" && "httpStatus" in result) return { ok: false, status: result.httpStatus, json: async () => ({}) };
    if (typeof result === "object") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: result.error } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { fetchImpl, calls };
}
