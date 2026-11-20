// /api/verifier/images and /api/verifier/images/<sha256>: forwarded to the R2 Worker.
// A missing object, and extra unexpired Blobs in the manifest, are read from Netlify Blobs. Nothing is written.
import type { Config } from "@netlify/functions";
import { loadConfig } from "../../src/config.js";
import { corsHeaders, json, withHeaders } from "../../src/http.js";
import { openBlobStore } from "../../src/netlifyStore.js";
import { finishProxiedRead, isProxyPath, proxyImageRequest } from "../../src/r2OptIn.js";
import { handleVerifierImages } from "../../src/verifierImages.js";

export default async (req: Request): Promise<Response> => {
  const config = loadConfig(process.env);
  const cors = corsHeaders(req, config);
  let res: Response;
  try {
    const proxied = await proxyImageRequest(req, process.env, { allowPath: (path) => isProxyPath(path, "/api/verifier/images") });
    if (proxied) {
      res = await finishProxiedRead(req, proxied, () => handleVerifierImages(req, { store: openBlobStore(), config, now: () => new Date() }));
    } else if (req.method === "OPTIONS") res = new Response(null, { status: 204 });
    else res = json(503, { error: "image service is misconfigured" });
  } catch (e) {
    console.error("verifier-images function error:", e instanceof Error ? e.message : "unknown");
    res = json(500, { error: "internal error" });
  }
  return Object.keys(cors).length ? withHeaders(res, cors) : res;
};

export const config: Config = {
  path: ["/api/verifier/images", "/api/verifier/images/*"],
  method: ["GET", "OPTIONS"],
  // A bulk download is one manifest request plus one request per image; keep the platform cap well above that for a
  // pilot-sized election but low enough to blunt scraping. Aggregated per client IP.
  rateLimit: { windowSize: 60, windowLimit: 300, aggregateBy: ["ip", "domain"] },
};
