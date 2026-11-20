// Verifier-side check of the ballot image store.
//
// 1. Sign a short challenge (EIP-191 personal_sign over `BEINGS-VERIFIER|<election>|<unix seconds>`) and send it in
//    X-Verifier-Timestamp / X-Verifier-Signature. A fresh challenge is signed for every request, so a long download
//    never outlives the server's 5-minute window.
// 2. GET the manifest, then every image it lists.
// 3. Hash every image locally and compare with (a) the manifest and (b) the imageSha256 values the BallotLedger holds
//    on-chain for the election (read straight from the chain, never from the store, so a dishonest store cannot vouch
//    for its own images).
// 4. Report mismatches, images the ledger has but the store does not serve, and images the store has but the ledger
//    does not.
//
// The ledger's records() mapping is keyed by ballot key, which the manifest deliberately does not reveal, so the on-chain
// side is collected from the BallotAccepted event log (indexed by electionKey) and compared as a set of image hashes.
import { Interface, type Signer } from "ethers";
import { electionKey, keccakHex, sha256Hex } from "@beings/core";

export const CHALLENGE_PREFIX = "BEINGS-VERIFIER";
export const COSTON2_RPC_URL = "https://coston2-api.flare.network/ext/C/rpc";
export const COSTON2_BALLOT_LEDGER = "0xF579913c90b86f102Fff8D07c6c16f465495013C";
/** Block the Coston2 test deployment of the ledger was deployed in (packages/ledger/deployments/coston2.json). */
export const COSTON2_LEDGER_DEPLOY_BLOCK = 37_317_112;
// beingsvote.live proxies to the R2 Worker and can still read an unexpired Netlify Blob. --url can point at the Worker directly.
export const DEFAULT_STORE_URL = "https://beingsvote.live";
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

export function challengeMessage(electionCode: string, timestamp: number | string): string {
  return `${CHALLENGE_PREFIX}|${electionCode}|${timestamp}`;
}

/** The two headers the verifier routes need, signed for `nowSeconds`. */
export async function signChallenge(signer: Pick<Signer, "signMessage">, electionCode: string, nowSeconds: number): Promise<Record<string, string>> {
  const ts = Math.floor(nowSeconds);
  return { "x-verifier-timestamp": String(ts), "x-verifier-signature": await signer.signMessage(challengeMessage(electionCode, ts)) };
}

// ------------------------------------------------------------------------------------------------ store access

export interface ManifestEntry {
  imageHash: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}
export interface Manifest {
  election: string;
  generatedAt: string;
  count: number;
  expiredOmitted: number;
  images: ManifestEntry[];
}

/** The part of fetch() this module uses (a real Response satisfies it). */
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; cache?: RequestCache }) => Promise<Pick<Response, "ok" | "status" | "headers" | "arrayBuffer" | "json" | "text">>;

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface StoreClientOptions {
  storeUrl: string;
  election: string;
  signer: Pick<Signer, "signMessage">;
  fetchImpl?: HttpFetch;
  now?: () => number; // ms
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts after a 429 / 5xx / network error. Default 3. */
  retries?: number;
}

export class StoreClient {
  private readonly base: string;
  private readonly doFetch: HttpFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: StoreClientOptions) {
    this.base = o.storeUrl.replace(/\/+$/, "");
    this.doFetch = o.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<HttpFetch>);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get(path: string): Promise<Awaited<ReturnType<HttpFetch>>> {
    const url = `${this.base}${path}?election=${encodeURIComponent(this.o.election)}`;
    const attempts = (this.o.retries ?? 3) + 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const headers = await signChallenge(this.o.signer, this.o.election, this.now() / 1000);
        const res = await this.doFetch(url, { method: "GET", headers, cache: "no-store" });
        if (res.status !== 429 && res.status < 500) return res;
        last = new StoreError(`store answered ${res.status}`, res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        if (i < attempts - 1) await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 500 * 2 ** i);
      } catch (e) {
        last = e;
        if (i < attempts - 1) await this.sleep(500 * 2 ** i);
      }
    }
    throw last instanceof Error ? last : new StoreError("request failed");
  }

  async manifest(): Promise<Manifest> {
    const res = await this.get("/api/verifier/images");
    if (!res.ok) throw new StoreError(`manifest request failed: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    const m = (await res.json()) as Manifest;
    if (!m || !Array.isArray(m.images) || m.election !== this.o.election) throw new StoreError("the store returned a manifest that is not for this election");
    return m;
  }

  /** The raw bytes the store serves, plus its content type. Throws StoreError with the status on non-200. */
  async image(imageHash: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (!SHA256_RE.test(imageHash)) throw new StoreError("bad image hash in manifest");
    const res = await this.get(`/api/verifier/images/${imageHash}`);
    if (!res.ok) throw new StoreError(`image request failed: ${res.status}`, res.status);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
  }
}

// ------------------------------------------------------------------------------------------------ the ledger

const ledgerIface = new Interface([
  "event BallotAccepted(bytes32 indexed electionKey, bytes32 indexed ballotKey, string results, bytes32 imageSha256, bytes32 recordSha256, bool reviewed)",
]);
const BALLOT_ACCEPTED_TOPIC = ledgerIface.getEvent("BallotAccepted")!.topicHash;

/** What an ethers Provider offers that we need (so tests can pass a fake). */
export interface LogSource {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address: string; topics: string[]; fromBlock: number; toBlock: number }): Promise<{ topics: readonly string[]; data: string }[]>;
}

/** What a BallotAccepted event says about one ballot, keyed (in LedgerImages.entries) by its image hash only. */
export interface LedgerResultEntry {
  /** The on-chain results string, e.g. `V:c1|O|V:c2+c4`. */
  results: string;
  /** keccak256(bytes(results)): the resultsHash the readings were signed over. */
  resultsHash: string;
}

export interface LedgerImages {
  /** Number of BallotAccepted records for the election. */
  records: number;
  /** imageSha256 (64 hex, no 0x) -> how many records carry it. */
  hashes: Map<string, number>;
  /** imageSha256 -> the results recorded with it (used by the blind re-read). Absent in older callers. */
  entries?: Map<string, LedgerResultEntry[]>;
  fromBlock: number;
  toBlock: number;
}

export interface LedgerReadOptions {
  ledgerAddress?: string;
  fromBlock?: number;
  toBlock?: number;
  /** Blocks per eth_getLogs request. The Coston2 public RPC allows 30; if the node says otherwise ("maximum is set to N") this adapts. Default 30. */
  chunk?: number;
  concurrency?: number;
  onProgress?: (doneBlocks: number, totalBlocks: number) => void;
}

function maxRangeFromError(e: unknown): number | null {
  const text = [String((e as Error)?.message ?? ""), String((e as { error?: { message?: string } })?.error?.message ?? "")].join(" ");
  const m = /maximum is set to (\d+)/i.exec(text) ?? /(?:range|limit)[^0-9]{0,40}(\d{1,6}) blocks?/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Every imageSha256 the BallotLedger accepted for this election, from the BallotAccepted event log. */
export async function readLedgerImages(source: LogSource, electionCode: string, o: LedgerReadOptions = {}): Promise<LedgerImages> {
  const address = o.ledgerAddress ?? COSTON2_BALLOT_LEDGER;
  const fromBlock = o.fromBlock ?? COSTON2_LEDGER_DEPLOY_BLOCK;
  const toBlock = o.toBlock ?? (await source.getBlockNumber());
  if (toBlock < fromBlock) throw new Error(`--to-block ${toBlock} is before --from-block ${fromBlock}`);
  const topics = [BALLOT_ACCEPTED_TOPIC, electionKey(electionCode)];
  const out: LedgerImages = { records: 0, hashes: new Map(), entries: new Map(), fromBlock, toBlock };
  let chunk = Math.max(1, o.chunk ?? 30);
  const total = toBlock - fromBlock + 1;
  let done = 0;
  // Work queue of [from,to] ranges; a node that rejects the range size makes us shrink the chunk and re-split.
  let next = fromBlock;
  const take = (): [number, number] | null => {
    if (next > toBlock) return null;
    const r: [number, number] = [next, Math.min(toBlock, next + chunk - 1)];
    next = r[1] + 1;
    return r;
  };
  const retry: [number, number][] = [];
  const worker = async () => {
    for (;;) {
      const r = retry.shift() ?? take();
      if (!r) return;
      try {
        const logs = await source.getLogs({ address, topics, fromBlock: r[0], toBlock: r[1] });
        for (const l of logs) {
          const parsed = ledgerIface.parseLog({ topics: [...l.topics], data: l.data });
          if (!parsed) continue;
          const h = String(parsed.args.imageSha256).slice(2).toLowerCase();
          out.records++;
          out.hashes.set(h, (out.hashes.get(h) ?? 0) + 1);
          const results = String(parsed.args.results);
          const list = out.entries!.get(h) ?? [];
          list.push({ results, resultsHash: keccakHex(results) });
          out.entries!.set(h, list);
        }
        done += r[1] - r[0] + 1;
        o.onProgress?.(done, total);
      } catch (e) {
        const max = maxRangeFromError(e);
        if (max !== null && r[1] - r[0] + 1 > max) {
          chunk = Math.min(chunk, max);
          for (let s = r[0]; s <= r[1]; s += max) retry.push([s, Math.min(r[1], s + max - 1)]);
        } else throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return out;
}

// ------------------------------------------------------------------------------------------------ verification

export type ProblemKind =
  | "hash-mismatch" // the bytes served hash to something other than the manifest's imageHash
  | "size-mismatch" // byte length differs from the manifest
  | "content-type-mismatch" // served type differs from the manifest
  | "not-on-chain" // the store has an image the ledger has no record of
  | "missing" // the ledger records a hash the store does not list
  | "download-failed" // listed, but the store would not serve it (e.g. 404, or 410 after retention)
  | "duplicate-in-manifest"
  | "bad-manifest-entry";

export interface Problem {
  kind: ProblemKind;
  imageHash: string;
  detail: string;
}

export interface Report {
  election: string;
  signer: string;
  generatedAt: string;
  manifestCount: number;
  expiredOmitted: number;
  onChain: { records: number; distinctImageHashes: number; fromBlock: number; toBlock: number };
  /** Images whose bytes match the manifest AND are recorded on-chain. */
  verified: string[];
  problems: Problem[];
  ok: boolean;
}

export interface VerifyImagesOptions {
  election: string;
  signerAddress: string;
  store: Pick<StoreClient, "manifest" | "image">;
  ledger: LedgerImages;
  /** Called for each image that passed every check, before the report is built (e.g. to write it to disk). */
  onVerified?: (entry: ManifestEntry, bytes: Uint8Array) => Promise<void> | void;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  now?: () => Date;
}

export async function verifyImages(o: VerifyImagesOptions): Promise<{ report: Report; manifest: Manifest }> {
  const manifest = await o.store.manifest();
  const problems: Problem[] = [];
  const verified: string[] = [];
  const seen = new Set<string>();
  const todo: ManifestEntry[] = [];
  for (const e of manifest.images) {
    if (!e || typeof e.imageHash !== "string" || !SHA256_RE.test(e.imageHash)) {
      problems.push({ kind: "bad-manifest-entry", imageHash: String((e as { imageHash?: unknown })?.imageHash ?? ""), detail: "imageHash is not 64 lower-case hex characters" });
      continue;
    }
    if (seen.has(e.imageHash)) {
      problems.push({ kind: "duplicate-in-manifest", imageHash: e.imageHash, detail: "listed more than once" });
      continue;
    }
    seen.add(e.imageHash);
    todo.push(e);
  }

  let done = 0;
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const e = todo[idx++];
      if (!e) return;
      const found: Problem[] = [];
      try {
        const { bytes, contentType } = await o.store.image(e.imageHash);
        const actual = sha256Hex(bytes);
        if (actual !== e.imageHash) found.push({ kind: "hash-mismatch", imageHash: e.imageHash, detail: `the store served bytes whose SHA-256 is ${actual}` });
        if (e.size >= 0 && bytes.byteLength !== e.size) found.push({ kind: "size-mismatch", imageHash: e.imageHash, detail: `manifest says ${e.size} bytes, received ${bytes.byteLength}` });
        if (contentType !== e.contentType) found.push({ kind: "content-type-mismatch", imageHash: e.imageHash, detail: `manifest says ${e.contentType}, received ${contentType || "none"}` });
        if (!o.ledger.hashes.has(e.imageHash)) found.push({ kind: "not-on-chain", imageHash: e.imageHash, detail: "no BallotAccepted record on the ledger carries this image hash" });
        if (found.length === 0) {
          await o.onVerified?.(e, bytes);
          verified.push(e.imageHash);
        }
      } catch (err) {
        const status = err instanceof StoreError && err.status ? ` (HTTP ${err.status})` : "";
        found.push({ kind: "download-failed", imageHash: e.imageHash, detail: `${err instanceof Error ? err.message : String(err)}${status}` });
      }
      problems.push(...found);
      o.onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));

  for (const h of o.ledger.hashes.keys()) {
    if (!seen.has(h)) {
      problems.push({
        kind: "missing",
        imageHash: h,
        detail: manifest.expiredOmitted > 0 ? `recorded on-chain but not in the manifest (the store reports ${manifest.expiredOmitted} image(s) past retention)` : "recorded on-chain but not in the manifest",
      });
    }
  }
  verified.sort();
  problems.sort((a, b) => (a.kind + a.imageHash < b.kind + b.imageHash ? -1 : 1));
  const report: Report = {
    election: o.election,
    signer: o.signerAddress,
    generatedAt: (o.now?.() ?? new Date()).toISOString(),
    manifestCount: manifest.images.length,
    expiredOmitted: manifest.expiredOmitted ?? 0,
    onChain: { records: o.ledger.records, distinctImageHashes: o.ledger.hashes.size, fromBlock: o.ledger.fromBlock, toBlock: o.ledger.toBlock },
    verified,
    problems,
    ok: problems.length === 0,
  };
  return { report, manifest };
}

/** File name for a verified image: always `<64 hex>.<png|jpg|pdf>`, so nothing from the network can pick a path. */
export function imageFileName(entry: Pick<ManifestEntry, "imageHash" | "contentType">): string {
  if (!SHA256_RE.test(entry.imageHash)) throw new Error("bad image hash");
  return `${entry.imageHash}.${EXT[entry.contentType] ?? "bin"}`;
}
