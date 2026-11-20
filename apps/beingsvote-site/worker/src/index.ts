// Image API for the beingsvote.live cutover. Same routes and handlers as the Netlify functions, with R2 instead of Blobs.
// The public hostname is the workers.dev URL. No route is attached to beingsvote.live.
// Cleanup is scheduled only; it is not an HTTP endpoint.
import { loadConfig } from "../../src/config.js";
import { runCleanup } from "../../src/cleanup.js";
import { handleFetch } from "../../src/fetch.js";
import { policyLookup } from "../../src/imagePolicy.js";
import { corsHeaders, json, withHeaders } from "../../src/http.js";
import { FixedWindowLimiter, clientKey } from "../../src/rateLimit.js";
import { checkBallotPool } from "../../src/ballotPool.js";
import { handleUpload } from "../../src/upload.js";
import { handleVerifierImages } from "../../src/verifierImages.js";
import { D1CommentStore, handleComments, loadCommentsConfig } from "../../src/comments.js";
import { openR2Store } from "./r2Store.js";

const STRING_BINDINGS = [
  "SCANNER_UPLOAD_TOKEN",
  "RPC_URL",
  "LEDGER_ADDRESS",
  "REGISTRY_ADDRESS",
  "LEGACY_LEDGER_ADDRESSES",
  "LEGACY_REGISTRY_ADDRESSES",
  "LEGACY_VERIFIER_REGISTRY_ADDRESSES",
  "MAX_IMAGE_BYTES",
  "MAX_RETENTION_DAYS",
  "ALLOWED_ORIGINS",
  "VERIFIER_REGISTRY_ADDRESS",
  "VERIFIER_ADDRESSES",
  "VERIFIER_AUTH_MODE",
  "VERIFIER_RATE_PER_MINUTE",
  "ELECTION_FILES_BASE",
  "PUBLIC_IMAGE_RATE_PER_MINUTE",
] as const;

// Best-effort, per isolate, matching the Netlify function cap. Not a global limit.
const requests = new FixedWindowLimiter(300);
// Public comment posts, per address, per isolate. D1 applies the same cap across isolates.
const commentPosts = new FixedWindowLimiter(5, 10 * 60_000);
const commentReview = new FixedWindowLimiter(30);

/** Browser pages on the live site. A dashboard value replaces this. */
export const DEFAULT_ALLOWED_ORIGINS = "https://beingsvote.live";

export function workerStringEnv(env: Env): Record<string, string | undefined> {
  const source = env as Env & Partial<Record<(typeof STRING_BINDINGS)[number], string>>;
  const out: Record<string, string | undefined> = {};
  for (const name of STRING_BINDINGS) {
    const value = source[name];
    if (typeof value === "string") out[name] = value;
  }
  if (!out.ALLOWED_ORIGINS?.trim()) out.ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
  return out;
}

function routeOf(url: URL): "images" | "verifier" | "comments" | null {
  const path = url.pathname;
  if (path.includes("\\") || path.includes("\0")) return null;
  if (path === "/api/images") return "images";
  if (path === "/api/verifier/images" || path.startsWith("/api/verifier/images/")) return "verifier";
  if (path === "/api/comments" || path === "/api/comments/review") return "comments";
  return null;
}

function commentsRuntimeEnv(env: Env): Record<string, string | undefined> {
  return {
    COMMENT_ADMIN_TOKEN: env.COMMENT_ADMIN_TOKEN,
    TURNSTILE_SECRET: env.TURNSTILE_SECRET,
    TURNSTILE_HOSTNAMES: env.TURNSTILE_HOSTNAMES,
    COMMENT_IP_PEPPER: env.COMMENT_IP_PEPPER,
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    void ctx;
    const config = loadConfig(workerStringEnv(env));
    const cors = corsHeaders(request, config);
    const url = new URL(request.url);
    const route = routeOf(url);
    let res: Response;
    try {
      if (!route) {
        res = json(404, { error: "not found" });
      } else if (request.method !== "OPTIONS" && !requests.allow(clientKey(request), Date.now())) {
        res = json(429, { error: "too many requests; slow down" }, { "retry-after": "60" });
      } else if (route === "images") {
        const policyFor = policyLookup(request, config);
        const poolCheck = (input: Parameters<typeof checkBallotPool>[0]) =>
          checkBallotPool(input, { rpcUrl: config.rpcUrl, registryAddress: config.registryAddress });
        const deps = { store: openR2Store(env.BALLOT_IMAGES, config.maxImageBytes), config, now: () => new Date(), policyFor, poolCheck };
        if (request.method === "OPTIONS") res = new Response(null, { status: 204 });
        else if (request.method === "POST") res = await handleUpload(request, deps);
        else if (request.method === "GET") res = await handleFetch(request, deps);
        else res = json(405, { error: "method not allowed" }, { allow: "GET, POST, OPTIONS" });
      } else if (route === "comments") {
        if (request.method === "OPTIONS") res = new Response(null, { status: 204 });
        else if (request.method === "POST" && url.pathname === "/api/comments" && !commentPosts.allow(clientKey(request), Date.now())) {
          res = json(429, { error: "too many comments; try again later" }, { "retry-after": "600" });
        } else if (url.pathname === "/api/comments/review" && !commentReview.allow(clientKey(request), Date.now())) {
          res = json(429, { error: "too many requests; slow down" }, { "retry-after": "60" });
        } else if (!env.COMMENTS) res = json(503, { error: "comments are not configured" });
        else {
          res = await handleComments(request, {
            store: new D1CommentStore(env.COMMENTS),
            config: loadCommentsConfig(commentsRuntimeEnv(env)),
            now: () => Date.now(),
            ip: clientKey(request),
            postAllowed: true,
          });
        }
      } else if (request.method === "OPTIONS") {
        res = new Response(null, { status: 204 });
      } else if (request.method === "GET") {
        res = await handleVerifierImages(request, { store: openR2Store(env.BALLOT_IMAGES, config.maxImageBytes), config, now: () => new Date() });
      } else {
        res = json(405, { error: "method not allowed" }, { allow: "GET, OPTIONS" });
      }
    } catch (e) {
      console.error(JSON.stringify({ message: "image request failed", error: e instanceof Error ? e.message : "unknown" }));
      res = json(500, { error: "internal error" });
    }
    console.log(JSON.stringify({ message: "image request", method: request.method, path: url.pathname, status: res.status }));
    return Object.keys(cors).length ? withHeaders(res, cors) : res;
  },

  async scheduled(controller, env, ctx): Promise<void> {
    void ctx;
    const config = loadConfig(workerStringEnv(env));
    const result = await runCleanup(openR2Store(env.BALLOT_IMAGES, config.maxImageBytes), new Date(controller.scheduledTime));
    console.log(JSON.stringify({
      message: "cleanup",
      cron: controller.cron,
      scanned: result.scanned,
      deleted: result.deleted,
      kept: result.kept,
      needsAttention: result.needsAttention.length,
    }));
    if (result.needsAttention.length) {
      console.warn(JSON.stringify({ message: "cleanup needs attention", count: result.needsAttention.length }));
    }
  },
} satisfies ExportedHandler<Env>;
