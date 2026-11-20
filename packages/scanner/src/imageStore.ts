// Helpers for the ballot-image store (the Cloudflare R2 Worker).
//  * uploadScan:  hash a scan, POST it to /api/images (what the scanner does after reading a ballot)
//  * verify side lives in verify.ts (browser-safe). That read stays on beingsvote.live so a
//    picture already stored in Netlify Blobs can still be fetched until its deleteAfter.
import { ballotKey, sha256Hex, assertBallotCode, assertElectionCode } from "@beings/core";

export const DEFAULT_STORE_URL = "https://beings-ballot-images.beingsvote-test.workers.dev";

const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const LOCAL_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/;

/**
 * Where an upload goes. An explicit URL wins, then IMAGE_STORE_URL, otherwise the R2 Worker.
 * Only an https origin, or http://localhost for a local site, is accepted.
 */
export function resolveStoreBaseUrl(explicit?: string, envValue?: string): string {
  const raw = (explicit ?? envValue ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_STORE_URL;
  if (HTTPS_ORIGIN.test(raw) || LOCAL_HTTP.test(raw)) return raw;
  throw new UploadError("image store URL must be an https origin, or http://localhost for a local site");
}
export type ImageContentType = "image/png" | "image/jpeg" | "application/pdf";

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** Detect png, jpeg or pdf from the first bytes. Returns null for anything else (the store would refuse it too). */
export function sniffContentType(bytes: Uint8Array): ImageContentType | null {
  const is = (sig: number[]) => bytes.length >= sig.length && sig.every((v, i) => bytes[i] === v);
  if (is([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (is([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (is([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

export interface UploadScanOptions {
  /** Image store origin, no trailing slash needed. Default is the R2 Worker. */
  baseUrl?: string;
  /** The upload secret (SCANNER_UPLOAD_TOKEN on the site). Never log it. */
  token: string;
  electionCode: string;
  /** Strict 12-character ballot code. Only its keccak256 (the on-chain ballotKey) is sent. */
  ballotCode: string;
  /** The scan bytes: the same bytes whose SHA-256 goes on-chain as imageSha256. */
  bytes: Uint8Array;
  /** Whole days to keep the image (the election's imageRetention.days). */
  retentionDays: number;
  /** If the caller already has an imageHash (for example from omr_finish.mjs), it is checked against the bytes. */
  expectedImageSha256?: string;
  /**
   * Merkle proof that the ballot key is in one approved root. Hashes only: the code is not sent.
   * Omit it for an election that was created before pool checks.
   */
  poolProof?: { proof: string[]; rootIndex: number };
  contentType?: ImageContentType;
  fetchImpl?: FetchLike;
}

export interface UploadScanResult {
  /** The imageHash to put in the ballot record (64 lower-case hex). */
  imageSha256: string;
  status: "created" | "exists";
  key: string;
  deleteAfter: string;
}

export class UploadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function uploadScan(o: UploadScanOptions): Promise<UploadScanResult> {
  assertElectionCode(o.electionCode);
  assertBallotCode(o.ballotCode);
  if (!o.token) throw new UploadError("no upload token (set SCANNER_UPLOAD_TOKEN)");
  const imageSha256 = sha256Hex(o.bytes);
  if (o.expectedImageSha256 && o.expectedImageSha256.toLowerCase() !== imageSha256) {
    throw new UploadError(`image hash ${imageSha256} does not match the expected imageSha256 ${o.expectedImageSha256}`);
  }
  const contentType = o.contentType ?? sniffContentType(o.bytes);
  if (!contentType) throw new UploadError("the file is not a png, jpeg or pdf");
  const base = (o.baseUrl ?? DEFAULT_STORE_URL).replace(/\/+$/, "");
  const doFetch: FetchLike = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const headers: Record<string, string> = {
    authorization: `Bearer ${o.token}`,
    "content-type": contentType,
    "x-election-code": o.electionCode,
    "x-image-sha256": imageSha256,
    "x-ballot-key": ballotKey(o.ballotCode),
    "x-retention-days": String(o.retentionDays),
  };
  if (o.poolProof) {
    if (!Array.isArray(o.poolProof.proof) || !Number.isInteger(o.poolProof.rootIndex) || o.poolProof.rootIndex < 0) {
      throw new UploadError("the ballot-pool proof is not a list of hashes and a root index");
    }
    headers["x-ballot-proof"] = o.poolProof.proof.join(",");
    headers["x-ballot-root-index"] = String(o.poolProof.rootIndex);
  }
  const res = await doFetch(`${base}/api/images`, {
    method: "POST",
    headers,
    body: o.bytes,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(`upload refused (${res.status}): ${body?.error ?? "unknown error"}`, res.status);
  return { imageSha256, status: body.status, key: body.key, deleteAfter: body.deleteAfter };
}
