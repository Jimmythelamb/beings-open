// Verifier-only bulk access to the ballot image store.
//
//   GET /api/verifier/images?election=<code>              manifest: [{imageHash, contentType, size, uploadedAt}] (no ballot hash)
//   GET /api/verifier/images/<sha256>?election=<code>     one image, re-hashed before it is served
//
// Both need the signed challenge (see verifierAuth.ts): a registered verifier, an allowlisted address, or this election's organizer. The manifest deliberately omits the ballot code hash (the blob
// metadata's ballotCodeHash), so a verifier can check the images against the ledger but cannot tie an image to a ballot
// code, and a voter's per-ballot fetch (/api/images) stays the only way to go from a ballot code to its image.
// Expired images (deleteAfter passed) are left out of the manifest and answer 410 on the single route.
import type { FetchLike } from "./chain.js";
import { SHA256_HEX_RE, blobKey, isElectionCode, sha256Hex } from "./codes.js";
import type { SiteConfig } from "./config.js";
import { PRIVATE_HEADERS } from "./fetch.js";
import { json } from "./http.js";
import { isExpired } from "./expiry.js";
import { FixedWindowLimiter, clientKey } from "./rateLimit.js";
import type { BlobStore } from "./store.js";
import { authenticateVerifier } from "./verifierAuth.js";

export const VERIFIER_BASE_PATH = "/api/verifier/images";

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
  /** Images still in the store but past deleteAfter: not listed, not downloadable (their hash stays on-chain). */
  expiredOmitted: number;
  images: ManifestEntry[];
}

export interface VerifierDeps {
  store: BlobStore;
  config: SiteConfig;
  now: () => Date;
  fetchImpl?: FetchLike;
  limiter?: FixedWindowLimiter;
  registryCache?: Map<string, { registered: boolean; at: number }>;
  organizerCache?: Map<string, { organizer: string; at: number }>;
}

const shared = new Map<number, FixedWindowLimiter>();
function limiterFor(config: SiteConfig): FixedWindowLimiter {
  let l = shared.get(config.verifierRatePerMinute);
  if (!l) shared.set(config.verifierRatePerMinute, (l = new FixedWindowLimiter(config.verifierRatePerMinute)));
  return l;
}

const NO_STORE = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache" };

export async function handleVerifierImages(req: Request, deps: VerifierDeps): Promise<Response> {
  const { store, config, now } = deps;
  if (req.method !== "GET") return json(405, { error: "method not allowed" }, { allow: "GET" });
  const url = new URL(req.url);

  const electionCode = (url.searchParams.get("election") ?? "").trim();
  if (!isElectionCode(electionCode)) return json(400, { error: "election must look like BEINGS-YYYY-XXXXXX" });

  // Route: manifest or one image.
  const rest = url.pathname.startsWith(VERIFIER_BASE_PATH) ? url.pathname.slice(VERIFIER_BASE_PATH.length).replace(/^\/+|\/+$/g, "") : null;
  if (rest === null) return json(404, { error: "not found" });
  let imageHash: string | null = null;
  if (rest !== "") {
    imageHash = rest.toLowerCase();
    if (!SHA256_HEX_RE.test(imageHash)) return json(400, { error: "image hash must be 64 hex characters" });
  }

  // Rate limit first (also bounds the registry lookups strangers can trigger), then authentication.
  const limiter = deps.limiter ?? limiterFor(config);
  if (!limiter.allow(clientKey(req), now().getTime())) return json(429, { error: "too many requests; slow down" }, { "retry-after": "60" });

  const auth = await authenticateVerifier(req, electionCode, {
    config,
    now,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.registryCache ? { registryCache: deps.registryCache } : {}),
    ...(deps.organizerCache ? { organizerCache: deps.organizerCache } : {}),
  });
  if (!auth.ok) {
    const extra: Record<string, string> = { ...NO_STORE };
    if (auth.status === 401) extra["www-authenticate"] = 'Beings-Verifier realm="beings-verifier-images"';
    return json(auth.status, { error: auth.error }, extra);
  }

  return imageHash === null ? manifest(store, electionCode, now()) : singleImage(store, electionCode, imageHash, now());
}

const BATCH = 25;

async function manifest(store: BlobStore, electionCode: string, at: Date): Promise<Response> {
  const prefix = `${electionCode}/`;
  const keys: string[] = [];
  for await (const k of store.listKeys(prefix)) if (k.startsWith(prefix) && SHA256_HEX_RE.test(k.slice(prefix.length))) keys.push(k);
  const images: ManifestEntry[] = [];
  let expiredOmitted = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const metas = await Promise.all(keys.slice(i, i + BATCH).map((k) => store.getMetadata(k)));
    metas.forEach((m, j) => {
      if (!m) return; // deleted while listing
      if (isExpired(m.metadata.deleteAfter, at)) {
        expiredOmitted++;
        return;
      }
      const md = m.metadata;
      images.push({
        imageHash: keys[i + j]!.slice(prefix.length),
        contentType: typeof md.contentType === "string" ? md.contentType : "application/octet-stream",
        size: typeof md.size === "number" ? md.size : -1,
        uploadedAt: typeof md.uploadedAt === "string" ? md.uploadedAt : "",
      });
    });
  }
  images.sort((a, b) => (a.imageHash < b.imageHash ? -1 : a.imageHash > b.imageHash ? 1 : 0));
  const body: Manifest = { election: electionCode, generatedAt: at.toISOString(), count: images.length, expiredOmitted, images };
  return json(200, body, NO_STORE);
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

async function singleImage(store: BlobStore, electionCode: string, imageHash: string, at: Date): Promise<Response> {
  const blob = await store.get(blobKey(electionCode, imageHash));
  if (!blob) return json(404, { error: "no such image for that election" }, NO_STORE);
  if (isExpired(blob.metadata.deleteAfter, at)) {
    return json(410, { error: "this image has passed its retention period and is no longer available; its hash stays on-chain", imageHash }, NO_STORE);
  }
  // Re-hash before serving: what leaves the store is exactly what its key says it is.
  if (sha256Hex(blob.data) !== imageHash) return json(500, { error: "stored image failed its integrity check" }, NO_STORE);
  const contentType = typeof blob.metadata.contentType === "string" ? blob.metadata.contentType : "application/octet-stream";
  const ext = EXTENSIONS[contentType] ?? "bin";
  return new Response(blob.data as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "content-disposition": `attachment; filename="${imageHash}.${ext}"`,
      "content-type": contentType,
      "content-length": String(blob.data.byteLength),
      "x-image-sha256": imageHash,
    },
  });
}
