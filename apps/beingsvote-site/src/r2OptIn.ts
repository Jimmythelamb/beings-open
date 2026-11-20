// Same-origin front for the Cloudflare image Worker.
// Unset R2_IMAGE_SERVICE_URL uses the deployed Worker. A set value is used only when it is a
// credential-free https origin; anything else fails closed and does not write to Netlify Blobs.
// GET may still read Blobs that were stored before the cutover. POST never writes to Blobs.
import { loadConfig } from "./config.js";
import { json } from "./http.js";

/** Live Worker. Public origin, not a secret. */
export const DEFAULT_R2_IMAGE_SERVICE_URL = "https://beings-ballot-images.beingsvote-test.workers.dev";

const REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "x-election-code",
  "x-image-sha256",
  "x-ballot-key",
  "x-retention-days",
  "x-public-images",
  "x-ballot-code",
  "x-verifier-timestamp",
  "x-verifier-signature",
  "origin",
] as const;

const RESPONSE_HEADERS = [
  "allow",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-security-policy",
  "content-type",
  "pragma",
  "referrer-policy",
  "retry-after",
  "www-authenticate",
  "x-content-type-options",
  "x-image-sha256",
  "x-robots-tag",
] as const;

export type ServiceOrigin = { ok: true; origin: null } | { ok: true; origin: string } | { ok: false };

/** `null` origin means the raw value was empty. `ok: false` means it was set but not a safe target. */
export function parseServiceOrigin(raw: string | undefined): ServiceOrigin {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true, origin: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:") return { ok: false };
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false };
  if (!url.hostname || url.hostname === "." || url.hostname.includes("..")) return { ok: false };
  return { ok: true, origin: url.origin };
}

/** Unset uses the Worker. A bad explicit value fails closed. */
export function serviceOriginFromEnv(env: Record<string, string | undefined>): ServiceOrigin {
  const trimmed = (env.R2_IMAGE_SERVICE_URL ?? "").trim();
  return parseServiceOrigin(trimmed || DEFAULT_R2_IMAGE_SERVICE_URL);
}

export function isProxyPath(pathname: string, prefix: "/api/images" | "/api/verifier/images"): boolean {
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.includes("//")) return false;
  if (pathname.split("/").some((part) => part === "." || part === "..")) return false;
  if (prefix === "/api/images") return pathname === "/api/images";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export interface ProxyOptions {
  allowPath: (pathname: string) => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Returns null only when the origin parser has no target. With the code default that does not happen.
 * Forwards only the image API headers and the caller's path/query. Does not follow redirects.
 */
export async function proxyImageRequest(req: Request, env: Record<string, string | undefined>, opts: ProxyOptions): Promise<Response | null> {
  const parsed = serviceOriginFromEnv(env);
  if (!parsed.ok) return json(503, { error: "image service is misconfigured" });
  if (parsed.origin === null) return null;

  const incoming = new URL(req.url);
  if (incoming.host === new URL(parsed.origin).host) return json(503, { error: "image service is misconfigured" });
  if (!opts.allowPath(incoming.pathname)) return json(404, { error: "not found" });

  const maxBytes = loadConfig(env).maxImageBytes;
  let body: Uint8Array | undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) return json(413, { error: `image is larger than ${maxBytes} bytes` });
    const read = await readCapped(req, maxBytes);
    if (read === null) return json(413, { error: `image is larger than ${maxBytes} bytes` });
    body = read;
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const target = new URL(incoming.pathname + incoming.search, parsed.origin);
  const doFetch = opts.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method: req.method,
      headers,
      body: body ? copyBytes(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return json(502, { error: "image service could not be reached" });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { error: "image service returned a redirect" });
  }
  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

type ManifestImage = { imageHash?: unknown; contentType?: unknown; size?: unknown; uploadedAt?: unknown };
type ManifestBody = { election?: unknown; generatedAt?: unknown; count?: unknown; expiredOmitted?: unknown; images?: unknown };

function manifestPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/api/verifier/images";
}

/**
 * After a proxied GET: a Worker 404 is read from Blobs (410 and 200 pass through; another 404 keeps the Worker answer).
 * A Worker verifier manifest is combined with any still-unexpired Blob images. POST is returned unchanged, so this never writes.
 * A Blob read that throws leaves the Worker response in place.
 */
export async function finishProxiedRead(req: Request, proxied: Response, readBlobs: () => Promise<Response>): Promise<Response> {
  if (req.method !== "GET") return proxied;
  const path = new URL(req.url).pathname;
  if (manifestPath(path) && proxied.status === 200) {
    let blobRes: Response;
    try {
      blobRes = await readBlobs();
    } catch {
      return proxied;
    }
    if (blobRes.status !== 200) {
      await cancelBody(blobRes);
      return proxied;
    }
    const merged = await mergeManifestResponses(proxied, blobRes);
    return merged ?? proxied;
  }
  if (proxied.status !== 404) return proxied;
  let blobRes: Response;
  try {
    blobRes = await readBlobs();
  } catch {
    return proxied;
  }
  if (blobRes.status === 404) {
    await cancelBody(blobRes);
    return proxied;
  }
  await cancelBody(proxied);
  return blobRes;
}

async function mergeManifestResponses(workerRes: Response, blobRes: Response): Promise<Response | null> {
  const workerCopy = workerRes.clone();
  const blobCopy = blobRes.clone();
  let workerBody: ManifestBody;
  let blobBody: ManifestBody;
  try {
    workerBody = (await workerCopy.json()) as ManifestBody;
    blobBody = (await blobCopy.json()) as ManifestBody;
  } catch {
    await cancelBody(blobRes);
    return null;
  }
  await cancelBody(workerRes);
  await cancelBody(blobRes);
  return json(200, mergeManifestBodies(workerBody, blobBody), { "cache-control": "private, no-store, max-age=0", pragma: "no-cache" });
}

export function mergeManifestBodies(primary: ManifestBody, extra: ManifestBody): { election: string; generatedAt: string; count: number; expiredOmitted: number; images: ManifestImage[] } {
  const images = manifestImages(primary);
  const seen = new Set(images.map((image) => String(image.imageHash)));
  for (const image of manifestImages(extra)) {
    const hash = String(image.imageHash);
    if (seen.has(hash)) continue;
    seen.add(hash);
    images.push(image);
  }
  images.sort((a, b) => (String(a.imageHash) < String(b.imageHash) ? -1 : String(a.imageHash) > String(b.imageHash) ? 1 : 0));
  return {
    election: typeof primary.election === "string" ? primary.election : typeof extra.election === "string" ? extra.election : "",
    generatedAt: typeof primary.generatedAt === "string" ? primary.generatedAt : typeof extra.generatedAt === "string" ? extra.generatedAt : "",
    count: images.length,
    expiredOmitted: countOf(primary.expiredOmitted) + countOf(extra.expiredOmitted),
    images,
  };
}

function manifestImages(body: ManifestBody): ManifestImage[] {
  if (!Array.isArray(body.images)) return [];
  return body.images.filter((image): image is ManifestImage => {
    if (!image || typeof image !== "object") return false;
    const hash = (image as ManifestImage).imageHash;
    return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  });
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
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
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
