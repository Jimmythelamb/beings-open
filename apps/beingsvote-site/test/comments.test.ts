// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMENT_MAX_CHARS,
  COMMENT_NAME_MAX,
  type CommentCursor,
  type CommentStatus,
  type CommentStore,
  type StoredComment,
  handleComments,
  hashIp,
  loadCommentsConfig,
  verifyTurnstileToken,
} from "../src/comments.js";
import { COMMENT_MAX, COMMENT_RECEIVED, COMMENTS_TURNSTILE_OFF, COMMENTS_UNAVAILABLE, pageShowsComments, publicCommentsFromPayload, renderPublicComments } from "../public/js/comments.js";

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const ADMIN = "a".repeat(40);
const SECRET = "s".repeat(40);
const HOST = "https://images.example";

class MemoryComments implements CommentStore {
  rows: StoredComment[] = [];
  async ready(): Promise<void> {}
  async insert(row: StoredComment): Promise<void> {
    this.rows.push({ ...row, status: "pending" });
  }
  async listApproved(limit: number, before: CommentCursor | null): Promise<StoredComment[]> {
    return this.rows
      .filter((row) => row.status === "approved")
      .filter((row) => !before || row.createdAt < before.createdAt || (row.createdAt === before.createdAt && row.id < before.id))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
  async countSince(ipHash: string, since: number): Promise<number> {
    return this.rows.filter((row) => row.ipHash === ipHash && row.createdAt > since).length;
  }
  async listByStatus(status: CommentStatus, limit: number): Promise<StoredComment[]> {
    return this.rows
      .filter((row) => row.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  async updateStatus(id: string, status: "approved" | "rejected"): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return false;
    row.status = status;
    return true;
  }
  async remove(id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length !== before;
  }
}

function siteverify(result: Record<string, unknown> | Error, status = 200): typeof fetch {
  return (async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    expect(params.get("secret")).toBe(SECRET);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function deps(store: MemoryComments, over: { postAllowed?: boolean; ip?: string; now?: number; secret?: string; fetchImpl?: typeof fetch } = {}) {
  return {
    store,
    config: loadCommentsConfig({
      COMMENT_ADMIN_TOKEN: ADMIN,
      TURNSTILE_SECRET: over.secret ?? SECRET,
      TURNSTILE_HOSTNAMES: "beingsvote.live",
    }),
    now: () => over.now ?? 1_700_000_000_000,
    ip: over.ip ?? "203.0.113.10",
    postAllowed: over.postAllowed ?? true,
    fetchImpl: over.fetchImpl ?? siteverify({ success: true, action: "comment", hostname: "beingsvote.live" }),
  };
}

function submit(store: MemoryComments, body: unknown, over: Parameters<typeof deps>[1] = {}) {
  return handleComments(
    new Request(`${HOST}/api/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    deps(store, over),
  );
}

describe("comment service", () => {
  it("holds a new comment as pending and does not list it until it is approved", async () => {
    const store = new MemoryComments();
    const created = await submit(store, { body: "Count the paper twice.", displayName: "AL", turnstileToken: "good" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: "received" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.status).toBe("pending");
    expect(store.rows[0]?.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.rows[0]?.ipHash).not.toContain("203.0.113.10");

    const hidden = await handleComments(new Request(`${HOST}/api/comments`), deps(store));
    expect(await hidden.json()).toEqual({ comments: [], nextCursor: null });

    const id = store.rows[0]?.id ?? "";
    const refused = await handleComments(new Request(`${HOST}/api/comments/review`), deps(store));
    expect(refused.status).toBe(401);
    const listed = await handleComments(
      new Request(`${HOST}/api/comments/review?status=pending`, { headers: { authorization: `Bearer ${ADMIN}` } }),
      deps(store),
    );
    expect(listed.status).toBe(200);
    const queue = (await listed.json()) as { comments: Array<Record<string, string>> };
    expect(queue.comments[0]).toMatchObject({ id, body: "Count the paper twice.", displayName: "AL", status: "pending" });
    expect(queue.comments[0]?.ipHash).toBeUndefined();

    const approved = await handleComments(
      new Request(`${HOST}/api/comments/review`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "approve" }),
      }),
      deps(store),
    );
    expect(approved.status).toBe(200);
    const pub = (await (await handleComments(new Request(`${HOST}/api/comments`), deps(store))).json()) as { comments: Array<Record<string, string>> };
    expect(pub.comments.map((row) => row.body)).toEqual(["Count the paper twice."]);
    expect(Object.keys(pub.comments[0] ?? {}).sort()).toEqual(["body", "createdAt", "displayName", "id"]);
  });

  it("lists approved comments newest first and pages with a cursor", async () => {
    const store = new MemoryComments();
    let now = 1_000;
    await submit(store, { body: "Older", displayName: "", turnstileToken: "good" }, { now });
    now = 2_000;
    await submit(store, { body: "Newer", displayName: "N", turnstileToken: "good" }, { now });
    for (const row of store.rows) row.status = "approved";
    const page = await handleComments(new Request(`${HOST}/api/comments?limit=1`), deps(store));
    const first = (await page.json()) as { comments: Array<{ body: string }>; nextCursor: string };
    expect(first.comments.map((row) => row.body)).toEqual(["Newer"]);
    expect(first.nextCursor).toMatch(/^2000_/);
    const rest = await handleComments(new Request(`${HOST}/api/comments?limit=1&cursor=${first.nextCursor}`), deps(store));
    const second = (await rest.json()) as { comments: Array<{ body: string }>; nextCursor: string | null };
    expect(second.comments.map((row) => row.body)).toEqual(["Older"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects unconfigured, failed, and hostile Turnstile checks before storing anything", async () => {
    const store = new MemoryComments();
    expect((await submit(store, { body: "Hi", turnstileToken: "good" }, { secret: "" })).status).toBe(503);
    expect((await submit(store, { body: "Hi", turnstileToken: "good" }, { fetchImpl: siteverify({ success: false }) })).status).toBe(403);
    expect((await submit(store, { body: "Hi", turnstileToken: "good" }, { fetchImpl: siteverify({ success: true, action: "contact", hostname: "beingsvote.live" }) })).status).toBe(403);
    expect((await submit(store, { body: "Hi", turnstileToken: "good" }, { fetchImpl: siteverify({ success: true, action: "comment", hostname: "evil.example" }) })).status).toBe(403);
    expect((await submit(store, { body: "Hi", turnstileToken: "good" }, { fetchImpl: siteverify(new Error("down")) })).status).toBe(403);
    expect(store.rows).toEqual([]);
    const verdict = await verifyTurnstileToken(
      { secret: SECRET, token: "x", remoteIp: "203.0.113.10", hostnames: ["beingsvote.live"] },
      siteverify({ success: true, action: "comment", hostname: "localhost" }),
    );
    expect(verdict).toBe("forbidden");
  });

  it("rate-limits an address, refuses a long comment, and does not echo HTML as markup", async () => {
    const store = new MemoryComments();
    const ip = "203.0.113.44";
    for (let i = 0; i < 5; i++) expect((await submit(store, { body: `Note ${i}`, turnstileToken: "good" }, { ip })).status).toBe(201);
    expect((await submit(store, { body: "One more", turnstileToken: "good" }, { ip })).status).toBe(429);
    expect(store.rows).toHaveLength(5);
    expect((await submit(store, { body: "x".repeat(COMMENT_MAX_CHARS + 1), turnstileToken: "good" }, { ip: "203.0.113.45" })).status).toBe(400);
    expect((await submit(store, { body: "   ", turnstileToken: "good" }, { ip: "203.0.113.45" })).status).toBe(400);
    expect((await submit(store, { body: "Ok", displayName: "y".repeat(COMMENT_NAME_MAX + 1), turnstileToken: "good" }, { ip: "203.0.113.45" })).status).toBe(400);
    const attack = await submit(store, { body: "<script>alert(1)</script>", displayName: "<b>x</b>", turnstileToken: "good" }, { ip: "203.0.113.45" });
    expect(attack.status).toBe(201);
    const row = store.rows.find((item) => item.body.includes("<script>"));
    expect(row?.body).toBe("<script>alert(1)</script>");
    if (row) row.status = "approved";
    const listed = await handleComments(new Request(`${HOST}/api/comments`), deps(store));
    expect(listed.headers.get("content-type")).toContain("application/json");
    const payload = (await listed.json()) as { comments: Array<{ body: string }> };
    expect(payload.comments.some((item) => item.body === "<script>alert(1)</script>")).toBe(true);
    expect((await submit(store, { body: "nope", turnstileToken: "good" }, { postAllowed: false, ip: "203.0.113.46" })).status).toBe(429);
  });

  it("refuses review without the server token, and delete removes the row", async () => {
    const store = new MemoryComments();
    await submit(store, { body: "Hide me", turnstileToken: "good" });
    const id = store.rows[0]?.id ?? "";
    expect((await handleComments(new Request(`${HOST}/api/comments/review`, { headers: { authorization: "Bearer short" } }), deps(store, { secret: SECRET }))).status).toBe(401);
    const bare = loadCommentsConfig({});
    expect(bare.adminToken).toBe("");
    expect(bare.turnstileHostnames).toEqual(["beingsvote.live"]);
    const closed = await handleComments(new Request(`${HOST}/api/comments/review`, { headers: { authorization: `Bearer ${ADMIN}` } }), {
      ...deps(store),
      config: bare,
    });
    expect(closed.status).toBe(503);
    const wrong = await handleComments(
      new Request(`${HOST}/api/comments/review`, {
        method: "POST",
        headers: { authorization: `Bearer ${"z".repeat(40)}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "approve" }),
      }),
      deps(store),
    );
    expect(wrong.status).toBe(401);
    expect(store.rows[0]?.status).toBe("pending");
    const removed = await handleComments(
      new Request(`${HOST}/api/comments/review`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ id, action: "delete" }),
      }),
      deps(store),
    );
    expect(removed.status).toBe(200);
    expect(store.rows).toEqual([]);
    const same = await hashIp("203.0.113.10", "pepper");
    expect(await hashIp("203.0.113.10", "pepper")).toBe(same);
    expect(await hashIp("203.0.113.10", "other")).not.toBe(same);
  });
});

describe("public comments on the page", () => {
  it("is only on Home and How it works", () => {
    expect(pageShowsComments("/")).toBe(true);
    expect(pageShowsComments("/how")).toBe(true);
    for (const path of ["/results", "/check", "/staff", "/admin", "/contact", "/moderate", "/system", "/results/BEINGS-2026-QB1TTH"]) {
      expect(pageShowsComments(path)).toBe(false);
    }
    const app = src("../public/js/app.js");
    expect(app.match(/renderPublicComments\(/g)).toHaveLength(1);
    expect(app).toContain("pageShowsComments(path)");
    expect(src("../public/js/home.js")).not.toContain("Public comments");
    expect(src("../public/js/moderate.js")).toContain("authorization: `Bearer ${token}`");
    expect(src("../public/js/moderate.js")).not.toMatch(/localStorage\s*[.\[]|sessionStorage/);
    expect(src("../public/js/comments.js")).not.toMatch(/eth_sendTransaction|from "\.\/chain/);
    expect(src("../src/comments.ts")).not.toMatch(/chain\.js|BallotLedger|eth_call/);
    expect(COMMENT_MAX).toBe(COMMENT_MAX_CHARS);
  });

  it("renders escaped text, a live counter, and a calm note when the service is down", async () => {
    const root = renderPublicComments({
      listUrl: "https://beings-ballot-images.beingsvote-test.workers.dev/api/comments",
      siteKey: "",
      fetchImpl: async () => {
        throw new Error("worker not redeployed");
      },
    });
    document.body.replaceChildren(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector("h2")?.textContent).toBe("Public comments");
    expect(root.querySelector("#comment-body")).toBeTruthy();
    expect((root.querySelector("#comment-send") as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain(COMMENTS_TURNSTILE_OFF);
    expect(root.textContent).toContain(COMMENTS_UNAVAILABLE);
    expect(root.textContent).toMatch(/not written on the blockchain/);
    const box = root.querySelector("#comment-body") as HTMLTextAreaElement;
    box.value = "x".repeat(10);
    box.dispatchEvent(new Event("input"));
    expect(root.querySelector("#comment-count")?.textContent).toBe(`10 / ${COMMENT_MAX}`);
  });

  it("shows approved text as text, and says the comment will appear after review", async () => {
    let posted: { body?: string; turnstileToken?: string } = {};
    const root = renderPublicComments({
      listUrl: "https://comments.example/api/comments",
      siteKey: "0x4AAAAAAAAAAAAAAA",
      loadTurnstile: async (_el, _key, onToken) => {
        onToken("widget-token");
        return { reset() { onToken(""); } };
      },
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") {
          posted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ status: "received" }), { status: 201, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify({
            comments: [{ id: "1", body: "<img src=x onerror=alert(1)>", displayName: "<b>Eve</b>", createdAt: 1_700_000_000_000, ipHash: "nope", status: "approved" }],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    document.body.replaceChildren(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("<b>Eve</b>");
    expect(publicCommentsFromPayload({ comments: [{ id: "1", body: "Hi", displayName: "A", ipHash: "secret" }] }).comments[0]).not.toHaveProperty("ipHash");
    const box = root.querySelector("#comment-body") as HTMLTextAreaElement;
    box.value = "A considered remark";
    box.dispatchEvent(new Event("input"));
    const send = root.querySelector("#comment-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted.body).toBe("A considered remark");
    expect(posted.turnstileToken).toBe("widget-token");
    expect(root.querySelector("#comment-note")?.textContent).toBe(COMMENT_RECEIVED);
    expect(root.textContent).not.toContain("A considered remark");
  });
});
