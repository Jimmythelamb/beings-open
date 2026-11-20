import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const ADMIN = "a".repeat(40);
const SECRET = "s".repeat(40);
let octet = 1;

function ip(): string {
  octet += 1;
  return `203.0.113.${octet}`;
}

beforeEach(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const ok = params.get("response") === "good-token" && params.get("secret") === SECRET;
      return new Response(JSON.stringify(ok ? { success: true, action: "comment", hostname: "beingsvote.live" } : { success: false, "error-codes": ["invalid-input-response"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("blocked", { status: 599 });
  }) as typeof fetch;
  await env.COMMENTS.exec(
    "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL, ip_hash TEXT NOT NULL)",
  );
  await env.COMMENTS.prepare("DELETE FROM comments").run();
});

function post(body: string, address: string, token = "good-token"): Request {
  return new Request("https://images.example/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address, origin: "https://beingsvote.live" },
    body: JSON.stringify({ body, displayName: "AL", turnstileToken: token }),
  });
}

describe("off-chain comments", () => {
  it("stores a pending comment in D1 and hides it until an admin approves it", async () => {
    const address = ip();
    const created = await SELF.fetch(post("Count the paper.", address));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: "received" });
    const stored = await env.COMMENTS.prepare("SELECT body, status, ip_hash FROM comments").all<{ body: string; status: string; ip_hash: string }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]).toMatchObject({ body: "Count the paper.", status: "pending" });
    expect(stored.results[0]?.ip_hash).not.toContain(address);

    const hidden = await SELF.fetch(new Request("https://images.example/api/comments", { headers: { origin: "https://beingsvote.live" } }));
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("access-control-allow-origin")).toBe("https://beingsvote.live");
    expect(await hidden.json()).toEqual({ comments: [], nextCursor: null });

    const noToken = await SELF.fetch(new Request("https://images.example/api/comments/review"));
    expect(noToken.status).toBe(401);
    const queue = await SELF.fetch(new Request("https://images.example/api/comments/review", { headers: { authorization: `Bearer ${ADMIN}` } }));
    const pending = (await queue.json()) as { comments: Array<{ id: string; body: string; status: string; ipHash?: string }> };
    expect(pending.comments[0]).toMatchObject({ body: "Count the paper.", status: "pending" });
    expect(pending.comments[0]?.ipHash).toBeUndefined();
    const id = pending.comments[0]?.id ?? "";

    const approved = await SELF.fetch(
      new Request("https://images.example/api/comments/review", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "approve" }),
      }),
    );
    expect(approved.status).toBe(200);
    const visible = (await (await SELF.fetch(new Request("https://images.example/api/comments"))).json()) as { comments: Array<{ body: string }> };
    expect(visible.comments.map((row) => row.body)).toEqual(["Count the paper."]);
  });

  it("rate-limits one address and refuses a bad spam token without storing it", async () => {
    const address = ip();
    for (let n = 0; n < 5; n++) expect((await SELF.fetch(post(`Note ${n}`, address))).status).toBe(201);
    expect((await SELF.fetch(post("Note 6", address))).status).toBe(429);
    const rows = await env.COMMENTS.prepare("SELECT body FROM comments WHERE body LIKE 'Note %'").all<{ body: string }>();
    expect(rows.results).toHaveLength(5);
    const other = ip();
    expect((await SELF.fetch(post("<script>alert(1)</script>", other, "bad-token"))).status).toBe(403);
    const attack = await env.COMMENTS.prepare("SELECT id FROM comments WHERE body LIKE '%script%'").all();
    expect(attack.results).toEqual([]);
    expect((await SELF.fetch(new Request("https://images.example/api/contact", { method: "POST" }))).status).toBe(404);
  });

  it("rejects and deletes without putting the comment on the public list", async () => {
    const address = ip();
    expect((await SELF.fetch(post("Not this one", address))).status).toBe(201);
    const queue = (await (await SELF.fetch(new Request("https://images.example/api/comments/review", { headers: { authorization: `Bearer ${ADMIN}` } }))).json()) as {
      comments: Array<{ id: string }>;
    };
    const id = queue.comments[0]?.id ?? "";
    const rejected = await SELF.fetch(
      new Request("https://images.example/api/comments/review", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "reject" }),
      }),
    );
    expect(rejected.status).toBe(200);
    expect(await (await SELF.fetch(new Request("https://images.example/api/comments"))).json()).toEqual({ comments: [], nextCursor: null });
    const removed = await SELF.fetch(
      new Request("https://images.example/api/comments/review", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "delete" }),
      }),
    );
    expect(removed.status).toBe(200);
    expect((await env.COMMENTS.prepare("SELECT id FROM comments WHERE id = ?").bind(id).all()).results).toEqual([]);
  });
});
