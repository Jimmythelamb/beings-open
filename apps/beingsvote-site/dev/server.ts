// Local preview server (no Netlify account needed): serves public/ and answers /api/images with the REAL handler
// (src/fetch.ts) over an in-memory image store. For the test election it is preloaded with the scanned ballot pictures
// listed in packages/ledger/deployments/coston2-scanned-5.json, so the voter page can be tried end to end.
// The chain lookup is real: it reads BallotLedger on Coston2.
//
//   npm run serve            # http://localhost:8888
//   PORT=9000 npm run serve
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { handleFetch } from "../src/fetch.js";
import { policyLookup } from "../src/imagePolicy.js";
import { handleVerifierImages } from "../src/verifierImages.js";
import { ballotKey, blobKey, sha256Hex } from "../src/codes.js";
import type { BlobStore, ImageMetadata } from "../src/store.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(root, "public");
const port = Number(process.env.PORT ?? 8888);

class MemoryStore implements BlobStore {
  map = new Map<string, { data: Uint8Array; metadata: Record<string, unknown> }>();
  async set(key: string, data: Uint8Array, o: { metadata: ImageMetadata; onlyIfNew?: boolean }) {
    if (o.onlyIfNew && this.map.has(key)) return { modified: false };
    this.map.set(key, { data, metadata: { ...o.metadata } });
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
    for (const k of this.map.keys()) if (!prefix || k.startsWith(prefix)) yield k;
  }
}

// Use the same Content-Security-Policy as production (read from netlify.toml) so CSP problems show up locally.
const csp = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "netlify.toml"), "utf8"))?.[1];

const store = new MemoryStore();
// No upload token: uploads are not served here, only fetches. VERIFIER_ADDRESSES (and VERIFIER_AUTH_MODE) can be set to try the
// verifier download locally with an allow-list instead of the on-chain registry, e.g. VERIFIER_ADDRESSES=0xabc… npm run serve
const config = loadConfig(process.env);

function preload() {
  const file = resolve(root, "../../packages/ledger/deployments/coston2-scanned-5.json");
  if (!existsSync(file)) return console.log("(no scanned-5 deployment file; the image API will answer 404 for everything)");
  const d = JSON.parse(readFileSync(file, "utf8")) as { electionCode: string; ballots: { ballotCode: string; imageFile: string; imageSha256: string }[] };
  let n = 0;
  for (const b of d.ballots) {
    if (!existsSync(b.imageFile)) continue;
    const data = new Uint8Array(readFileSync(b.imageFile));
    const hex = sha256Hex(data);
    if (`0x${hex}` !== b.imageSha256.toLowerCase()) {
      console.log(`  ! ${b.imageFile} does not match its recorded fingerprint, skipped`);
      continue;
    }
    const metadata: ImageMetadata = { electionCode: d.electionCode, ballotCodeHash: ballotKey(b.ballotCode), contentType: "image/jpeg", size: data.byteLength, uploadedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 14 * 86_400_000).toISOString() };
    store.map.set(blobKey(d.electionCode, hex), { data, metadata });
    n++;
  }
  console.log(`preloaded ${n} ballot image(s) for ${d.electionCode}`);
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".pdf": "application/pdf", ".mp4": "video/mp4" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/api/images") {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" }).end();
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(url, { method: "GET", headers });
      const r = await handleFetch(request, { store, config, now: () => new Date(), policyFor: policyLookup(request, config) });
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === "/api/verifier/images" || url.pathname.startsWith("/api/verifier/images/")) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await handleVerifierImages(new Request(url, { method: req.method ?? "GET", headers }), { store, config, now: () => new Date() });
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname));
    if (p.endsWith(sep) || p === "/") p = join(p, "index.html");
    const full = join(publicDir, p);
    if (!full.startsWith(publicDir) || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const ext = extname(full);
    const headers: Record<string, string> = { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // The whitepaper is a file, not a page. Match the /whitepaper/*.pdf headers in netlify.toml.
    if (ext === ".pdf") {
      headers["content-disposition"] = "inline";
      headers["content-security-policy"] = "default-src 'none'; object-src 'self'; frame-ancestors 'none'; base-uri 'none'";
    } else if (csp) headers["content-security-policy"] = csp;
    res.writeHead(200, headers);
    res.end(readFileSync(full));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    res.writeHead(500).end("error");
  }
}).listen(port, () => {
  preload();
  console.log(`B.E.I.N.G.S. site on http://localhost:${port}`);
});
