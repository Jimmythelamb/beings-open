// POST /api/images: the scanner uploads one image.
//
//   Authorization: Bearer <SCANNER_UPLOAD_TOKEN>
//   Content-Type:  image/png | image/jpeg | application/pdf
//   X-Election-Code:   BEINGS-YYYY-XXXXXX
//   X-Image-Sha256:    64 hex, the imageHash that goes on-chain (the server recomputes it and rejects a mismatch)
//   X-Ballot-Key:      0x + 64 hex = keccak256(ballotCode), the on-chain ballotKey (the raw ballot code is not sent)
//   X-Retention-Days:  whole days to keep the image, from the election's imageRetention.days (capped by MAX_RETENTION_DAYS)
//   X-Public-Images:   optional true/1/yes, copied from the election file's publicBallotImages
//   body: the raw image bytes
// When Public ballot images is on (header or the public election file), retention must be 30 to 60 days.
import { ALLOWED_CONTENT_TYPES, type AllowedContentType, type SiteConfig } from "./config.js";
import { checkBearer } from "./auth.js";
import { type PoolCheckInput, type PoolVerdict } from "./ballotPool.js";
import { KECCAK_HEX_RE, SHA256_HEX_RE, blobKey, isElectionCode, sha256Hex } from "./codes.js";
import { computeDeleteAfter, parseDeleteAfter } from "./expiry.js";
import { json } from "./http.js";
import { PUBLIC_IMAGE_RETENTION_MAX_DAYS, PUBLIC_IMAGE_RETENTION_MIN_DAYS, isPublicImagesHeader, type PolicyLookup } from "./imagePolicy.js";
import type { BlobStore, ImageMetadata } from "./store.js";

export type PoolCheck = (input: PoolCheckInput) => Promise<PoolVerdict>;

export interface UploadDeps {
  store: BlobStore;
  config: SiteConfig;
  now: () => Date;
  policyFor?: PolicyLookup;
  /** When set, a pooled election's upload must prove the ballot key is in an approved root. */
  poolCheck?: PoolCheck;
}

/** Does the content start with the signature of the type it claims to be? */
export function matchesMagic(type: AllowedContentType, b: Uint8Array): boolean {
  const startsWith = (sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
  switch (type) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "application/pdf":
      return startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  }
}

export function parseContentType(header: string | null): AllowedContentType | null {
  const base = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(base) ? (base as AllowedContentType) : null;
}

/** Read the body, refusing to buffer more than `max` bytes. Returns null if over the limit. */
async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function handleUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const { store, config, now } = deps;

  // 1. Authentication first, before reading anything else.
  const auth = checkBearer(req.headers.get("authorization"), config.uploadToken);
  if (auth === "not-configured") return json(503, { error: "uploads are not configured on this site" });
  if (auth !== "ok") return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="beings-image-upload"' });

  // 2. Headers.
  const electionCode = req.headers.get("x-election-code")?.trim() ?? "";
  if (!isElectionCode(electionCode)) return json(400, { error: "X-Election-Code must look like BEINGS-YYYY-XXXXXX" });
  const claimedHash = (req.headers.get("x-image-sha256") ?? "").trim().toLowerCase();
  if (!SHA256_HEX_RE.test(claimedHash)) return json(400, { error: "X-Image-Sha256 must be 64 lower-case hex characters" });
  const ballotCodeHash = (req.headers.get("x-ballot-key") ?? "").trim().toLowerCase();
  if (!KECCAK_HEX_RE.test(ballotCodeHash)) return json(400, { error: "X-Ballot-Key must be 0x plus 64 hex characters (keccak256 of the ballot code)" });
  if (deps.poolCheck) {
    const rawProof = req.headers.get("x-ballot-proof");
    const rawIndex = req.headers.get("x-ballot-root-index");
    if (rawIndex !== null && rawIndex.trim() !== "" && !/^[0-9]+$/.test(rawIndex.trim())) {
      return json(400, { error: "X-Ballot-Root-Index must be a whole number" });
    }
    const proof = rawProof === null ? null : rawProof.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (proof && proof.some((part) => !KECCAK_HEX_RE.test(part))) {
      return json(400, { error: "X-Ballot-Proof must be a comma-separated list of 0x hashes" });
    }
    const verdict = await deps.poolCheck({
      electionCode,
      ballotKey: ballotCodeHash,
      proof,
      rootIndex: rawIndex === null || rawIndex.trim() === "" ? 0 : Number(rawIndex.trim()),
    });
    if (!verdict.ok) return json(422, { error: verdict.error ?? "this ballot is not in the election's ballot pool" });
  }
  const contentType = parseContentType(req.headers.get("content-type"));
  if (!contentType) return json(415, { error: `content type must be one of ${ALLOWED_CONTENT_TYPES.join(", ")}` });
  let publicOn = isPublicImagesHeader(req.headers.get("x-public-images"));
  if (deps.policyFor) {
    try {
      const policy = await deps.policyFor(electionCode);
      if (policy?.publicBallotImages === true) publicOn = true;
      if (policy && policy.publicBallotImages !== true && isPublicImagesHeader(req.headers.get("x-public-images"))) {
        return json(400, { error: "pictures for this election are not public; omit X-Public-Images" });
      }
    } catch {
      /* policy lookup failed: honour only the scanner header */
    }
  }
  const maxDays = publicOn ? Math.min(PUBLIC_IMAGE_RETENTION_MAX_DAYS, config.maxRetentionDays) : config.maxRetentionDays;
  const minDays = publicOn ? PUBLIC_IMAGE_RETENTION_MIN_DAYS : 1;
  const deleteAfter = computeDeleteAfter(now(), req.headers.get("x-retention-days"), maxDays, minDays);
  if (!deleteAfter) {
    const range = publicOn
      ? `When ballot pictures are public, X-Retention-Days must be a whole number from ${PUBLIC_IMAGE_RETENTION_MIN_DAYS} to ${PUBLIC_IMAGE_RETENTION_MAX_DAYS}`
      : `X-Retention-Days must be a whole number from 1 to ${config.maxRetentionDays}`;
    return json(400, { error: range });
  }

  // 3. Size, before and while reading.
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > config.maxImageBytes) return json(413, { error: `image is larger than ${config.maxImageBytes} bytes` });
  const body = await readLimited(req, config.maxImageBytes);
  if (body === null) return json(413, { error: `image is larger than ${config.maxImageBytes} bytes` });
  if (body.byteLength === 0) return json(400, { error: "empty body" });

  // 4. Content really is the claimed type, and its hash is the claimed hash (recomputed here, never trusted).
  if (!matchesMagic(contentType, body)) return json(415, { error: "file content does not match its content type" });
  const actualHash = sha256Hex(body);
  if (actualHash !== claimedHash) return json(422, { error: "hash mismatch: the SHA-256 of the body is not the claimed X-Image-Sha256", actualSha256: actualHash });

  // 5. Store. Idempotent: the same image for the same ballot again is a success that never duplicates it.
  const key = blobKey(electionCode, actualHash);
  const metadata: ImageMetadata = {
    electionCode,
    ballotCodeHash,
    contentType,
    size: body.byteLength,
    uploadedAt: now().toISOString(),
    deleteAfter,
    ...(publicOn ? { publicImages: 1 } : {}),
  };
  const created = await store.set(key, body, { metadata, onlyIfNew: true });
  if (created.modified) return json(201, { status: "created", key, deleteAfter });

  const existing = await store.getMetadata(key);
  if (existing && existing.metadata.ballotCodeHash !== ballotCodeHash) {
    return json(409, { error: "an image with this hash already exists for a different ballot" });
  }
  // Same image, same ballot. A re-upload may EXTEND retention (for example while a review is open), never shorten it.
  const oldDelete = parseDeleteAfter(existing?.metadata.deleteAfter);
  if (oldDelete !== null && Date.parse(deleteAfter) > oldDelete) {
    const keep: ImageMetadata = { ...metadata, uploadedAt: typeof existing?.metadata.uploadedAt === "string" ? existing.metadata.uploadedAt : metadata.uploadedAt };
    await store.set(key, body, { metadata: keep });
    return json(200, { status: "exists", key, deleteAfter, extended: true });
  }
  return json(200, { status: "exists", key, deleteAfter: existing?.metadata.deleteAfter ?? deleteAfter, extended: false });
}
