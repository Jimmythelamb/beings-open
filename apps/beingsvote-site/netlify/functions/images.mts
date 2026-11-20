// /api/images: forward to the R2 Worker. GET may still read a Netlify Blob stored before the cutover. POST never writes one.
import type { Config } from "@netlify/functions";
import { loadConfig } from "../../src/config.js";
import { corsHeaders, json, withHeaders } from "../../src/http.js";
import { openBlobStore } from "../../src/netlifyStore.js";
import { finishProxiedRead, isProxyPath, proxyImageRequest } from "../../src/r2OptIn.js";
import { handleFetch } from "../../src/fetch.js";
import { policyLookup } from "../../src/imagePolicy.js";

export default async (req: Request): Promise<Response> => {
  const config = loadConfig(process.env);
  const cors = corsHeaders(req, config);
  const policyFor = policyLookup(req, config);
  let res: Response;
  try {
    const proxied = await proxyImageRequest(req, process.env, { allowPath: (path) => isProxyPath(path, "/api/images") });
    if (proxied) {
      res = await finishProxiedRead(req, proxied, () => handleFetch(req, { store: openBlobStore(), config, now: () => new Date(), policyFor }));
    } else if (req.method === "OPTIONS") {
      res = new Response(null, { status: 204 });
    } else {
      res = json(503, { error: "image service is misconfigured" });
    }
  } catch (e) {
    // Never echo internals (they could contain a ballot code from the URL). Log the message only.
    console.error("images function error:", e instanceof Error ? e.message : "unknown");
    res = json(500, { error: "internal error" });
  }
  return Object.keys(cors).length ? withHeaders(res, cors) : res;
};

export const config: Config = {
  path: "/api/images",
  method: ["GET", "POST", "OPTIONS"],
  rateLimit: { windowSize: 60, windowLimit: 300, aggregateBy: ["ip", "domain"] },
};
