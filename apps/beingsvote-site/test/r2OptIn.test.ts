import { describe, expect, it } from "vitest";
import { DEFAULT_R2_IMAGE_SERVICE_URL, finishProxiedRead, isProxyPath, mergeManifestBodies, parseServiceOrigin, proxyImageRequest, serviceOriginFromEnv } from "../src/r2OptIn.js";
import { fetchImageApi, resolveImagePath, CONFIG } from "../public/js/config.js";

const WORKER = "https://beings-ballot-images.beingsvote-test.workers.dev";

describe("image service origin", () => {
  it("treats an empty raw value as not opted in, and the env default as the Worker", () => {
    expect(parseServiceOrigin(undefined)).toEqual({ ok: true, origin: null });
    expect(parseServiceOrigin("  ")).toEqual({ ok: true, origin: null });
    expect(serviceOriginFromEnv({})).toEqual({ ok: true, origin: WORKER });
    expect(serviceOriginFromEnv({ R2_IMAGE_SERVICE_URL: "  " })).toEqual({ ok: true, origin: WORKER });
    expect(DEFAULT_R2_IMAGE_SERVICE_URL).toBe(WORKER);
  });

  it("accepts only a credential-free https origin", () => {
    expect(parseServiceOrigin("https://images.example")).toEqual({ ok: true, origin: "https://images.example" });
    expect(parseServiceOrigin("https://images.example/")).toEqual({ ok: true, origin: "https://images.example" });
    for (const bad of ["http://images.example", "https://user:pw@images.example", "https://images.example/api", "https://images.example?x=1", "not a url", "file:///tmp"]) {
      expect(parseServiceOrigin(bad).ok).toBe(false);
    }
  });

  it("the public path helper uses the Worker and ignores an unsafe base", () => {
    expect(CONFIG.imageServiceBase).toBe(WORKER);
    expect(resolveImagePath("/api/images")).toBe(`${WORKER}/api/images`);
    const saved = CONFIG.imageServiceBase;
    CONFIG.imageServiceBase = "javascript:alert(1)";
    expect(resolveImagePath("/api/verifier/images")).toBe("/api/verifier/images");
    CONFIG.imageServiceBase = "https://images.example";
    expect(resolveImagePath("/api/images")).toBe("https://images.example/api/images");
    CONFIG.imageServiceBase = saved;
  });
});

describe("browser read fallback", () => {
  const workerUrl = `${WORKER}/api/images?election=BEINGS-2026-4CRWX2`;
  const init = { headers: { "X-Ballot-Code": "4F9Q7M2XHT8B" } };

  it("keeps a Worker answer other than 404 and does not call this site", async () => {
    const seen: string[] = [];
    const res = await fetchImageApi(workerUrl, init, async (url) => {
      seen.push(String(url));
      return new Response("nope", { status: 400 });
    });
    expect(res.status).toBe(400);
    expect(seen).toEqual([workerUrl]);
  });

  it("reads this site when the Worker has no object", async () => {
    const seen: string[] = [];
    const res = await fetchImageApi(workerUrl, init, async (url) => {
      seen.push(String(url));
      return new Response(String(url).startsWith(WORKER) ? "missing" : "blob", { status: String(url).startsWith(WORKER) ? 404 : 200 });
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob");
    expect(seen[1]).toBe("/api/images?election=BEINGS-2026-4CRWX2");
  });

  it("keeps the Worker 404 when this site also has no object", async () => {
    const res = await fetchImageApi(workerUrl, init, async () => new Response("missing", { status: 404 }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  it("uses this site when the browser cannot read the Worker response", async () => {
    const res = await fetchImageApi(workerUrl, init, async (url) => {
      if (String(url).startsWith(WORKER)) throw new TypeError("blocked");
      return new Response("via-site", { status: 400 });
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("via-site");
  });

  it("uses the site manifest, which already includes leftover Blobs", async () => {
    const manifest = `${WORKER}/api/verifier/images?election=BEINGS-2026-4CRWX2`;
    const res = await fetchImageApi(manifest, {}, async (url) => {
      const body = String(url).startsWith(WORKER) ? "worker" : "merged";
      return new Response(body, { status: 200 });
    });
    expect(await res.text()).toBe("merged");
  });
});

describe("opt-in proxy", () => {
  const env = { R2_IMAGE_SERVICE_URL: "https://images.example", MAX_IMAGE_BYTES: "1000" };
  const allow = (path: string) => isProxyPath(path, "/api/images");

  it("calls the Worker when R2_IMAGE_SERVICE_URL is unset", async () => {
    let seen = "";
    const res = await proxyImageRequest(new Request("https://beingsvote.live/api/images?election=BEINGS-2026-4CRWX2"), {}, {
      allowPath: allow,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response(JSON.stringify({ error: "election must look like BEINGS-YYYY-XXXXXX" }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    expect(seen).toBe(`${WORKER}/api/images?election=BEINGS-2026-4CRWX2`);
    expect(res?.status).toBe(400);
  });

  it("fails closed on a bad origin and does not call it", async () => {
    let called = false;
    const res = await proxyImageRequest(new Request("https://beingsvote.live/api/images"), { R2_IMAGE_SERVICE_URL: "http://127.0.0.1" }, {
      allowPath: allow,
      fetchImpl: async () => { called = true; return new Response("no"); },
    });
    expect(res?.status).toBe(503);
    expect(called).toBe(false);
  });

  it("forwards only the image headers and refuses a redirect", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const req = new Request("https://beingsvote.live/api/images?election=BEINGS-2026-4CRWX2", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "image/png",
        "x-ballot-code": "4F9Q7M2XHT8B",
        cookie: "session=nope",
        "x-forwarded-for": "1.2.3.4",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    const res = await proxyImageRequest(req, env, {
      allowPath: allow,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
      },
    });
    expect(res?.status).toBe(502);
    expect(seen?.url).toBe("https://images.example/api/images?election=BEINGS-2026-4CRWX2");
    const headers = seen?.init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("x-ballot-code")).toBe("4F9Q7M2XHT8B");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("refuses an oversized body without calling the Worker", async () => {
    let called = false;
    const res = await proxyImageRequest(new Request("https://beingsvote.live/api/images", { method: "POST", headers: { "content-length": "1001" }, body: new Uint8Array(10) }), env, {
      allowPath: allow,
      fetchImpl: async () => { called = true; return new Response("no"); },
    });
    expect(res?.status).toBe(413);
    expect(called).toBe(false);
  });
});

describe("read-only Blob fallback", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  it("does not read Blobs for a write, a Worker hit, or an expired Worker object", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return new Response("blob");
    };
    const post = new Request("https://beingsvote.live/api/images", { method: "POST" });
    expect(await finishProxiedRead(post, new Response("created", { status: 201 }), read)).toBeTruthy();
    expect(reads).toBe(0);
    const got = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("png", { status: 200 }), read);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("png");
    const gone = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("expired", { status: 410 }), read);
    expect(gone.status).toBe(410);
    expect(reads).toBe(0);
  });

  it("returns the Blob when the Worker has no object, and keeps the Worker 404 when Blobs do not either", async () => {
    const found = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("missing-r2", { status: 404 }), async () => new Response("png", { status: 200, headers: { "content-type": "image/png" } }));
    expect(found.status).toBe(200);
    expect(await found.text()).toBe("png");
    const missed = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("missing-r2", { status: 404 }), async () => new Response("missing-blob", { status: 404 }));
    expect(missed.status).toBe(404);
    expect(await missed.text()).toBe("missing-r2");
    const expired = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("missing-r2", { status: 404 }), async () => new Response("gone", { status: 410 }));
    expect(expired.status).toBe(410);
  });

  it("keeps the Worker response when the Blob read throws", async () => {
    const res = await finishProxiedRead(new Request("https://beingsvote.live/api/images"), new Response("missing-r2", { status: 404 }), async () => {
      throw new Error("store down");
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing-r2");
  });

  it("adds unexpired Blob images to a Worker manifest and does not duplicate a hash", async () => {
    const worker = new Response(JSON.stringify({ election: "BEINGS-2026-4CRWX2", generatedAt: "2026-11-13T00:00:00.000Z", count: 1, expiredOmitted: 1, images: [{ imageHash: hashB, contentType: "image/png", size: 3, uploadedAt: "2026-11-10T00:00:00.000Z" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const blobs = new Response(JSON.stringify({ election: "BEINGS-2026-4CRWX2", generatedAt: "2026-11-13T00:00:00.000Z", count: 2, expiredOmitted: 0, images: [{ imageHash: hashA, contentType: "image/jpeg", size: 4, uploadedAt: "2026-11-11T00:00:00.000Z" }, { imageHash: hashB, contentType: "image/png", size: 9, uploadedAt: "2026-11-01T00:00:00.000Z" }] }), { status: 200 });
    const res = await finishProxiedRead(new Request("https://beingsvote.live/api/verifier/images?election=BEINGS-2026-4CRWX2"), worker, async () => blobs);
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; expiredOmitted: number; images: { imageHash: string; size: number }[] };
    expect(body.count).toBe(2);
    expect(body.expiredOmitted).toBe(1);
    expect(body.images.map((image) => image.imageHash)).toEqual([hashA, hashB]);
    expect(body.images[1]?.size).toBe(3);
  });

  it("leaves the Worker manifest alone when Blobs refuse the signed read", async () => {
    const worker = new Response(JSON.stringify({ election: "BEINGS-2026-4CRWX2", count: 0, expiredOmitted: 0, images: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const res = await finishProxiedRead(new Request("https://beingsvote.live/api/verifier/images?election=BEINGS-2026-4CRWX2"), worker, async () => new Response("no", { status: 401 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 0, images: [] });
  });

  it("drops a manifest entry whose hash is not 64 hex characters", () => {
    const merged = mergeManifestBodies({ images: [{ imageHash: "not-a-hash" }, { imageHash: hashA }] }, { images: [{ imageHash: "../x" }] });
    expect(merged.images.map((image) => image.imageHash)).toEqual([hashA]);
  });
});
