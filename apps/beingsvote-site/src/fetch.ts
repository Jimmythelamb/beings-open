// GET /api/images: fetch one ballot image.
//
//   Voter path (always, setting does not matter):
//     X-Ballot-Code: <ballot code>        (preferred: headers stay out of URLs and most logs)
//     ?election=BEINGS-YYYY-XXXXXX        (and optionally ?ballotCode=... if a header is not possible)
//     Authorization = knowing the ballot code AND the ballot being recorded on-chain.
//
//   Public path (only when the election's Public ballot images setting is on):
//     ?election=BEINGS-YYYY-XXXXXX
//     X-Image-Sha256: <64 hex>            (or ?image= / ?imageHash=)
//     No listing, no ballot-code hash index. The store is read by electionCode/hash, then the
//     on-chain record for the blob's ballotCodeHash must name this same hash. Rate limited.
//     When the setting is off, this path is refused (existing voter behaviour is unchanged).
//
// There is no directory listing.
import type { SiteConfig } from "./config.js";
import { ChainError, readLedgerRecordByKeyWithFallback, readLedgerRecordWithFallback, type FetchLike } from "./chain.js";
import { KECCAK_HEX_RE, ballotKey, blobKey, isElectionCode, normalizeBallotCode, normalizeImageSha256, sha256Hex } from "./codes.js";
import { isExpired } from "./expiry.js";
import { json } from "./http.js";
import { isPublicImagesMetadata, type PolicyLookup } from "./imagePolicy.js";
import { FixedWindowLimiter, clientKey } from "./rateLimit.js";
import type { BlobStore } from "./store.js";

export interface FetchDeps {
  store: BlobStore;
  config: SiteConfig;
  now: () => Date;
  fetchImpl?: FetchLike;
  /** Source of truth for "Public ballot images". Fail closed when the lookup returns off or, if null, when metadata is not marked public. */
  policyFor?: PolicyLookup;
  /** Optional in-memory limiter for the unauthenticated hash path (tests inject a tight one). */
  publicLimiter?: FixedWindowLimiter;
}

export const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": "inline",
};

const defaultPublicLimiter = new FixedWindowLimiter(60);

export async function handleFetch(req: Request, deps: FetchDeps): Promise<Response> {
  const { store, config, now } = deps;
  const url = new URL(req.url);

  const electionCode = (url.searchParams.get("election") ?? url.searchParams.get("electionCode") ?? "").trim();
  if (!isElectionCode(electionCode)) return json(400, { error: "election must look like BEINGS-YYYY-XXXXXX" });
  const rawCode = req.headers.get("x-ballot-code") ?? url.searchParams.get("ballotCode") ?? "";
  const imageHash = normalizeImageSha256(req.headers.get("x-image-sha256") ?? url.searchParams.get("image") ?? url.searchParams.get("imageHash") ?? "");

  // A ballot code always uses the existing voter path (a hash in the query is ignored).
  if (rawCode) return voterFetch(req, deps, electionCode, rawCode);
  if (imageHash) return publicFetch(req, deps, electionCode, imageHash);
  return json(400, { error: "a ballot code is required (X-Ballot-Code header)" });
}

async function voterFetch(req: Request, deps: FetchDeps, electionCode: string, rawCode: string): Promise<Response> {
  const { store, config, now } = deps;
  const ballotCode = normalizeBallotCode(rawCode);
  if (!ballotCode) return json(400, { error: "that is not a valid ballot code" });

  let record;
  try {
    record = await readLedgerRecordWithFallback(electionCode, ballotCode, {
      rpcUrl: config.rpcUrl,
      ledgerAddress: config.ledgerAddress,
      legacyLedgerAddresses: config.legacyLedgerAddresses,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (e) {
    if (e instanceof ChainError) return json(502, { error: "could not read the ledger right now; try again later" });
    throw e;
  }
  if (!record.recorded) return json(404, { error: "no image found for that election and ballot code" });

  const key = blobKey(electionCode, record.imageSha256);
  const blob = await store.get(key);
  if (!blob) return json(404, { error: "no image found for that election and ballot code" });

  if (blob.metadata.ballotCodeHash !== ballotKey(ballotCode)) return json(404, { error: "no image found for that election and ballot code" });
  if (isExpired(blob.metadata.deleteAfter, now())) {
    return json(410, { error: "the image for this ballot has passed its retention period and is no longer available; the hash stays on-chain", imageSha256: record.imageSha256 });
  }
  if (sha256Hex(blob.data) !== record.imageSha256) return json(500, { error: "stored image failed its integrity check" });

  const contentType = typeof blob.metadata.contentType === "string" ? blob.metadata.contentType : "application/octet-stream";
  return new Response(blob.data as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { ...PRIVATE_HEADERS, "content-type": contentType, "content-length": String(blob.data.byteLength), "x-image-sha256": record.imageSha256 },
  });
}

async function publicFetch(req: Request, deps: FetchDeps, electionCode: string, imageHash: string): Promise<Response> {
  const { store, config, now } = deps;
  const limiter = deps.publicLimiter ?? defaultPublicLimiter;
  if (!limiter.allow(`public-image:${clientKey(req)}`, now().getTime())) {
    return json(429, { error: "too many requests; slow down" }, { "retry-after": "60" });
  }

  let policy = null;
  if (deps.policyFor) {
    try {
      policy = await deps.policyFor(electionCode);
    } catch {
      policy = null;
    }
  }
  if (policy && policy.publicBallotImages !== true) {
    return json(403, { error: "pictures for this election are not public" });
  }

  const key = blobKey(electionCode, imageHash);
  const blob = await store.get(key);
  if (!blob) return json(404, { error: "no image found for that election and fingerprint" });

  // When the public copy could not be loaded, only serve blobs the scanner marked public.
  if (!policy && !isPublicImagesMetadata(blob.metadata.publicImages)) {
    return json(404, { error: "no image found for that election and fingerprint" });
  }

  if (isExpired(blob.metadata.deleteAfter, now())) {
    return json(410, { error: "Image expired", imageSha256: imageHash });
  }
  if (sha256Hex(blob.data) !== imageHash) return json(500, { error: "stored image failed its integrity check" });

  const ballotCodeHash = typeof blob.metadata.ballotCodeHash === "string" ? blob.metadata.ballotCodeHash.toLowerCase() : "";
  if (!KECCAK_HEX_RE.test(ballotCodeHash)) return json(404, { error: "no image found for that election and fingerprint" });

  let record;
  try {
    record = await readLedgerRecordByKeyWithFallback(electionCode, ballotCodeHash, {
      rpcUrl: config.rpcUrl,
      ledgerAddress: config.ledgerAddress,
      legacyLedgerAddresses: config.legacyLedgerAddresses,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (e) {
    if (e instanceof ChainError) return json(502, { error: "could not read the ledger right now; try again later" });
    throw e;
  }
  if (!record.recorded || record.imageSha256 !== imageHash) {
    return json(404, { error: "no image found for that election and fingerprint" });
  }

  const contentType = typeof blob.metadata.contentType === "string" ? blob.metadata.contentType : "application/octet-stream";
  return new Response(blob.data as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { ...PRIVATE_HEADERS, "content-type": contentType, "content-length": String(blob.data.byteLength), "x-image-sha256": imageHash },
  });
}
