// Browser-safe verification: recompute the SHA-256 of the image you were given and compare it with the imageHash
// recorded on-chain (BallotLedger on Coston2). The chain read is independent of the image store: the caller talks to
// the RPC directly, so a dishonest store cannot vouch for its own images.
import { Interface } from "ethers";
import { ballotKey, electionKey, normalizeBallotCode } from "@beings/core";

export const COSTON2_RPC_URL = "https://coston2-api.flare.network/ext/C/rpc";
export const COSTON2_BALLOT_LEDGER = "0xF579913c90b86f102Fff8D07c6c16f465495013C";
// Reads stay on beingsvote.live. That function proxies to the Worker and can still read an unexpired Netlify Blob.
export const DEFAULT_STORE_BASE_URL = "https://beingsvote.live";

const ledgerIface = new Interface([
  "function records(bytes32 electionKey, bytes32 ballotKey) view returns (string results, bytes32 imageSha256, bytes32 recordSha256, uint64 acceptedAt, bool reviewed)",
]);

/** SHA-256 with WebCrypto (browsers, Node 20+): 64 lower-case hex characters. */
export async function sha256HexWeb(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes); // plain ArrayBuffer-backed copy
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface HashCheck {
  ok: boolean;
  actual: string;
  expected: string;
}

/** Compare the image bytes with an expected imageHash (with or without 0x, any case). */
export async function verifyImageBytes(bytes: Uint8Array, expectedImageHash: string): Promise<HashCheck> {
  const expected = expectedImageHash.toLowerCase().replace(/^0x/, "");
  const actual = await sha256HexWeb(bytes);
  return { ok: actual === expected, actual, expected };
}

export type RpcFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface ChainReadOptions {
  rpcUrl?: string;
  ledgerAddress?: string;
  fetchImpl?: RpcFetch;
}

/** The imageHash the ledger holds for this ballot (64 hex, no 0x), or null if the ballot is not recorded. */
export async function fetchOnChainImageHash(electionCode: string, ballotCode: string, o: ChainReadOptions = {}): Promise<string | null> {
  const code = normalizeBallotCode(ballotCode);
  const data = ledgerIface.encodeFunctionData("records", [electionKey(electionCode), ballotKey(code)]);
  const doFetch: RpcFetch = o.fetchImpl ?? (fetch as unknown as RpcFetch);
  const res = await doFetch(o.rpcUrl ?? COSTON2_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: o.ledgerAddress ?? COSTON2_BALLOT_LEDGER, data }, "latest"] }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${j.error.message ?? "unknown"}`);
  const decoded = ledgerIface.decodeFunctionResult("records", j.result);
  if (decoded.acceptedAt === 0n) return null;
  return String(decoded.imageSha256).slice(2).toLowerCase();
}

export type FetchResponseLike = { ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };

export interface FetchAndVerifyOptions extends ChainReadOptions {
  /** Image store base URL. Default https://beingsvote.live */
  storeUrl?: string;
  electionCode: string;
  ballotCode: string;
  storeFetch?: (url: string, init: { headers: Record<string, string>; cache?: string }) => Promise<FetchResponseLike>;
}

export interface FetchAndVerifyResult extends HashCheck {
  /** The image, only returned when it matches the on-chain hash. */
  bytes: Uint8Array | null;
  contentType: string | null;
}

/**
 * Fetch the voter's image from the store, read the on-chain imageHash from the ledger itself, hash the bytes in this
 * process and compare. `ok` is true only when the hash of what the store sent equals the ledger's imageHash.
 */
export async function fetchAndVerifyImage(o: FetchAndVerifyOptions): Promise<FetchAndVerifyResult> {
  const code = normalizeBallotCode(o.ballotCode);
  const expected = await fetchOnChainImageHash(o.electionCode, code, o);
  if (!expected) throw new Error("this ballot is not recorded on-chain");
  const base = (o.storeUrl ?? DEFAULT_STORE_BASE_URL).replace(/\/+$/, "");
  const doFetch = o.storeFetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<FetchResponseLike>);
  const res = await doFetch(`${base}/api/images?election=${encodeURIComponent(o.electionCode)}`, { headers: { "X-Ballot-Code": code }, cache: "no-store" });
  if (!res.ok) throw new Error(`image store answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const check = await verifyImageBytes(bytes, expected);
  return { ...check, bytes: check.ok ? bytes : null, contentType: res.headers.get("content-type") };
}
