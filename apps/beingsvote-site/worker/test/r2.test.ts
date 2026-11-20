import { env, SELF } from "cloudflare:test";
import { Wallet } from "ethers";
import { beforeEach, describe, expect, it } from "vitest";
import { BALLOT_ROOT_AT_SELECTOR, POOL_ENFORCED_SELECTOR, verifySortedProof } from "../../src/ballotPool.js";
import { ballotKey, sha256Hex } from "../../src/codes.js";
import { challengeMessage } from "../../src/verifierAuth.js";
import worker, { workerStringEnv } from "../src/index.js";

const TOKEN = "t".repeat(40);
const ELECTION = "BEINGS-2026-4CRWX2";
const OTHER = "BEINGS-2026-AAAAAA";
const BALLOT = "4F9Q7M2XHT8B";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_HASH = sha256Hex(PNG);
const KEY = `${ELECTION}/${PNG_HASH}`;
const verifier = new Wallet("0x" + "11".repeat(32));

function word(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function encodeRecord(imageSha256: string, acceptedAt: number): string {
  const results = new TextEncoder().encode("V:c1");
  const hex = [...results].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
  return (
    "0x" +
    word((5 * 32).toString(16)) +
    word(imageSha256) +
    word("11".repeat(32)) +
    word(acceptedAt.toString(16)) +
    word("0") +
    word(results.length.toString(16)) +
    hex
  );
}

const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://coston2-api.flare.network/")) {
      let data = "";
      try {
        data = (JSON.parse(String(init?.body ?? "{}")) as { params?: [{ data?: string }] }).params?.[0]?.data ?? "";
      } catch {
        data = "";
      }
      // Old registries revert poolEnforced. Other calls keep their real answers.
      if (data.startsWith(`0x${POOL_ENFORCED_SELECTOR}`) || data.startsWith(`0x${BALLOT_ROOT_AT_SELECTOR}`)) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
  let cursor: string | undefined;
  do {
    const page = await env.BALLOT_IMAGES.list({ cursor, limit: 1000 });
    await Promise.all(page.objects.map((object) => env.BALLOT_IMAGES.delete(object.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

function upload(over: { election?: string; hash?: string; ballot?: string; days?: string; body?: Uint8Array; token?: string | null; type?: string; ip?: string } = {}): Request {
  const body = over.body ?? PNG;
  const headers = new Headers({
    authorization: over.token === null ? "" : `Bearer ${over.token ?? TOKEN}`,
    "content-type": over.type ?? "image/png",
    "x-election-code": over.election ?? ELECTION,
    "x-image-sha256": over.hash ?? sha256Hex(body),
    "x-ballot-key": ballotKey(over.ballot ?? BALLOT),
    "x-retention-days": over.days ?? "14",
    "cf-connecting-ip": over.ip ?? "203.0.113.10",
  });
  if (over.token === null) headers.delete("authorization");
  return new Request("https://images.example/api/images", { method: "POST", headers, body });
}

async function sign(election: string, ts: number): Promise<Request> {
  return new Request(`https://images.example/api/verifier/images?election=${election}`, {
    headers: {
      "x-verifier-timestamp": String(ts),
      "x-verifier-signature": await verifier.signMessage(challengeMessage(election, ts)),
      "cf-connecting-ip": "203.0.113.20",
    },
  });
}

function stubRpc(result: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://coston2-api.flare.network/")) return new Response("blocked", { status: 599 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("worker defaults", () => {
  it("allows the live site when ALLOWED_ORIGINS is unset and keeps an explicit list", () => {
    expect(workerStringEnv({} as never).ALLOWED_ORIGINS).toBe("https://beingsvote.live");
    expect(workerStringEnv({ ALLOWED_ORIGINS: "https://preview.example" } as never).ALLOWED_ORIGINS).toBe("https://preview.example");
  });
});

describe("authorized and unauthorized uploads", () => {
  it("rejects a missing or wrong bearer and stores nothing", async () => {
    expect((await SELF.fetch(upload({ token: null }))).status).toBe(401);
    expect((await SELF.fetch(upload({ token: "x".repeat(40) }))).status).toBe(401);
    expect((await env.BALLOT_IMAGES.list()).objects).toEqual([]);
  });

  it("stores a valid upload once and reports the key", async () => {
    const res = await SELF.fetch(upload());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; key: string };
    expect(body).toMatchObject({ status: "created", key: KEY });
    const stored = await env.BALLOT_IMAGES.get(KEY);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG);
    expect(JSON.stringify(stored!.customMetadata)).not.toContain(BALLOT);
  });
});

describe("malformed input and hash mismatch", () => {
  it("rejects a bad election, a traversal code, a bad hash and the wrong type", async () => {
    expect((await SELF.fetch(upload({ election: "../x" }))).status).toBe(400);
    expect((await SELF.fetch(upload({ election: "BEINGS-2026-4CRWXU" }))).status).toBe(400);
    expect((await SELF.fetch(upload({ hash: "ab".repeat(32) }))).status).toBe(422);
    expect((await SELF.fetch(upload({ type: "text/html" }))).status).toBe(415);
    expect((await SELF.fetch(upload({ days: "0" }))).status).toBe(400);
    expect((await env.BALLOT_IMAGES.head(KEY))).toBeNull();
  });

  it("rejects an oversized declared body before writing", async () => {
    const req = upload();
    req.headers.set("content-length", "6000000");
    expect((await SELF.fetch(req)).status).toBe(413);
  });
});

describe("election isolation and conditional writes", () => {
  it("keeps one object when the same upload is repeated, and can extend retention but not shorten it", async () => {
    const first = await SELF.fetch(upload({ days: "30" }));
    expect(first.status).toBe(201);
    const again = await SELF.fetch(upload({ days: "7" }));
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { extended: boolean; deleteAfter: string };
    expect(againBody.extended).toBe(false);
    expect(againBody.deleteAfter).toBe(((await first.json()) as { deleteAfter: string }).deleteAfter);
    const extended = await SELF.fetch(upload({ days: "300" }));
    expect(extended.status).toBe(200);
    const extendedBody = (await extended.json()) as { extended: boolean; deleteAfter: string };
    expect(extendedBody.extended).toBe(true);
    expect(Date.parse(extendedBody.deleteAfter)).toBeGreaterThan(Date.parse(againBody.deleteAfter));
    expect((await env.BALLOT_IMAGES.list({ prefix: `${ELECTION}/` })).objects).toHaveLength(1);
  });

  it("two concurrent creates leave one object, and a second ballot cannot overwrite it", async () => {
    const [a, b] = await Promise.all([SELF.fetch(upload({ ip: "203.0.113.30" })), SELF.fetch(upload({ ip: "203.0.113.31" }))]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await env.BALLOT_IMAGES.list({ prefix: `${ELECTION}/` })).objects).toHaveLength(1);
    const other = await SELF.fetch(upload({ ballot: "AAAAAAAAAAAA", ip: "203.0.113.32" }));
    expect(other.status).toBe(409);
    const head = await env.BALLOT_IMAGES.head(KEY);
    const meta = head?.customMetadata ?? {};
    const bound = meta.ballotCodeHash ?? meta.ballotcodehash;
    expect(bound).toBe(ballotKey(BALLOT));
  });

  it("the same bytes in another election are a different key and are not listed or fetched with the first", async () => {
    expect((await SELF.fetch(upload())).status).toBe(201);
    expect((await SELF.fetch(upload({ election: OTHER, ballot: "AAAAAAAAAAAA", ip: "203.0.113.40" }))).status).toBe(201);
    const ts = Math.floor(Date.now() / 1000);
    const manifest = await SELF.fetch(await sign(ELECTION, ts));
    expect(manifest.status).toBe(200);
    const body = (await manifest.json()) as { count: number; images: { imageHash: string }[] };
    expect(body.count).toBe(1);
    expect(body.images.map((image) => image.imageHash)).toEqual([PNG_HASH]);
    const foreign = await SELF.fetch(new Request(`https://images.example/api/verifier/images/${PNG_HASH}?election=${OTHER}`, {
      headers: {
        "x-verifier-timestamp": String(ts),
        "x-verifier-signature": await verifier.signMessage(challengeMessage(OTHER, ts)),
        "cf-connecting-ip": "203.0.113.41",
      },
    }));
    expect(foreign.status).toBe(200);
    const missing = await SELF.fetch(new Request(`https://images.example/api/verifier/images/${"ab".repeat(32)}?election=${ELECTION}`, {
      headers: {
        "x-verifier-timestamp": String(ts),
        "x-verifier-signature": await verifier.signMessage(challengeMessage(ELECTION, ts)),
        "cf-connecting-ip": "203.0.113.42",
      },
    }));
    expect(missing.status).toBe(404);
  });
});

describe("verifier signatures, replay and voter fingerprint", () => {
  it("refuses a stranger, an expired challenge and a challenge signed for another election", async () => {
    expect((await SELF.fetch(new Request(`https://images.example/api/verifier/images?election=${ELECTION}`))).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    expect((await SELF.fetch(await sign(ELECTION, now - 301))).status).toBe(401);
    const crossed = new Request(`https://images.example/api/verifier/images?election=${ELECTION}`, {
      headers: {
        "x-verifier-timestamp": String(now),
        "x-verifier-signature": await verifier.signMessage(challengeMessage(OTHER, now)),
        "cf-connecting-ip": "203.0.113.50",
      },
    });
    expect((await SELF.fetch(crossed)).status).toBe(403);
  });

  it("accepts one fresh signature twice inside the five-minute read window", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      "x-verifier-timestamp": String(ts),
      "x-verifier-signature": await verifier.signMessage(challengeMessage(ELECTION, ts)),
      "cf-connecting-ip": "203.0.113.51",
    };
    const first = await SELF.fetch(new Request(`https://images.example/api/verifier/images?election=${ELECTION}`, { headers }));
    const second = await SELF.fetch(new Request(`https://images.example/api/verifier/images?election=${ELECTION}`, { headers }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("serves the voter only the ledger fingerprint, and 500s when the stored bytes do not match it", async () => {
    expect((await SELF.fetch(upload())).status).toBe(201);
    stubRpc(encodeRecord(PNG_HASH, 1_780_000_000));
    const ok = await SELF.fetch(new Request(`https://images.example/api/images?election=${ELECTION}`, {
      headers: { "x-ballot-code": BALLOT, "cf-connecting-ip": "203.0.113.60" },
    }));
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
    expect(ok.headers.get("x-image-sha256")).toBe(PNG_HASH);

    const tampered = new Uint8Array(PNG);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    await env.BALLOT_IMAGES.put(KEY, tampered, { customMetadata: { electionCode: ELECTION, ballotCodeHash: ballotKey(BALLOT), contentType: "image/png", size: String(tampered.byteLength), uploadedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 86_400_000).toISOString() } });
    stubRpc(encodeRecord(PNG_HASH, 1_780_000_000));
    const bad = await SELF.fetch(new Request(`https://images.example/api/images?election=${ELECTION}`, {
      headers: { "x-ballot-code": BALLOT, "cf-connecting-ip": "203.0.113.61" },
    }));
    expect(bad.status).toBe(500);
  });

  it("answers 410 after deleteAfter and does not take a hash from the query string", async () => {
    await env.BALLOT_IMAGES.put(KEY, PNG, {
      customMetadata: {
        electionCode: ELECTION,
        ballotCodeHash: ballotKey(BALLOT),
        contentType: "image/png",
        size: String(PNG.byteLength),
        uploadedAt: "2026-01-01T00:00:00.000Z",
        deleteAfter: "2026-01-02T00:00:00.000Z",
      },
    });
    stubRpc(encodeRecord(PNG_HASH, 1_780_000_000));
    const gone = await SELF.fetch(new Request(`https://images.example/api/images?election=${ELECTION}&imageHash=${PNG_HASH}`, {
      headers: { "x-ballot-code": BALLOT, "cf-connecting-ip": "203.0.113.62" },
    }));
    expect(gone.status).toBe(410);
  });
});

describe("scheduled cleanup", () => {
  it("deletes only expired image keys and leaves stray objects and future elections", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const meta = (election: string, deleteAfter: string) => ({
      electionCode: election,
      ballotCodeHash: ballotKey(BALLOT),
      contentType: "image/png",
      size: String(PNG.byteLength),
      uploadedAt: new Date().toISOString(),
      deleteAfter,
    });
    await env.BALLOT_IMAGES.put(`${ELECTION}/${PNG_HASH}`, PNG, { customMetadata: meta(ELECTION, past) });
    const otherHash = sha256Hex(new Uint8Array([...PNG, 9]));
    await env.BALLOT_IMAGES.put(`${OTHER}/${otherHash}`, new Uint8Array([...PNG, 9]), { customMetadata: meta(OTHER, future) });
    await env.BALLOT_IMAGES.put(`${ELECTION}/${"cd".repeat(32)}`, PNG, {
      customMetadata: { electionCode: ELECTION, ballotCodeHash: ballotKey(BALLOT), contentType: "image/png", size: String(PNG.byteLength), uploadedAt: "2026-01-01T00:00:00.000Z" },
    });
    await env.BALLOT_IMAGES.put("notes/not-an-image", new Uint8Array([1]));
    await worker.scheduled({ cron: "30 3 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, {} as ExecutionContext);
    expect(await env.BALLOT_IMAGES.head(`${ELECTION}/${PNG_HASH}`)).toBeNull();
    expect(await env.BALLOT_IMAGES.head(`${OTHER}/${otherHash}`)).not.toBeNull();
    expect(await env.BALLOT_IMAGES.head(`${ELECTION}/${"cd".repeat(32)}`)).not.toBeNull();
    expect(await env.BALLOT_IMAGES.head("notes/not-an-image")).not.toBeNull();
  });
});

describe("ballot pool", () => {
  function pooledRpc(root: string): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: [{ data?: string }] };
      const data = body.params?.[0]?.data ?? "";
      const result = data.startsWith(`0x${POOL_ENFORCED_SELECTOR}`) ? `0x${"0".repeat(63)}1` : root;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  it("refuses a pooled election with no proof or a bad proof, and accepts an empty proof for a one-leaf root", async () => {
    const key = ballotKey(BALLOT);
    pooledRpc(key);
    expect(verifySortedProof(key, key, [])).toBe(true);
    expect((await SELF.fetch(upload())).status).toBe(422);
    const bad = upload();
    bad.headers.set("x-ballot-proof", "0x" + "11".repeat(32));
    bad.headers.set("x-ballot-root-index", "0");
    expect((await SELF.fetch(bad)).status).toBe(422);
    const ok = upload();
    ok.headers.set("x-ballot-proof", "");
    ok.headers.set("x-ballot-root-index", "0");
    expect((await SELF.fetch(ok)).status).toBe(201);
    expect(JSON.stringify(ok.headers)).not.toContain(BALLOT);
  });
});

describe("routing", () => {
  it("does not expose cleanup or a nested images path", async () => {
    expect((await SELF.fetch(new Request("https://images.example/"))).status).toBe(404);
    expect((await SELF.fetch(new Request("https://images.example/api/images/extra"))).status).toBe(404);
    expect((await SELF.fetch(new Request("https://images.example/api/images", { method: "PUT" }))).status).toBe(405);
  });

  it("limits a single address", async () => {
    const ip = "198.51.100.77";
    let last = 0;
    for (let i = 0; i < 301; i++) {
      last = (await SELF.fetch(new Request("https://images.example/api/images", { headers: { "cf-connecting-ip": ip } }))).status;
    }
    expect(last).toBe(429);
  });
});
