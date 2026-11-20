// Public comments. Off-chain only: a D1 table on the image Worker. Nothing here calls a chain,
// and contact-form messages are not stored by these routes.
import { checkBearer } from "./auth.js";
import { MIN_TOKEN_LENGTH } from "./config.js";
import { json } from "./http.js";

export const COMMENT_MAX_CHARS = 250;
export const COMMENT_NAME_MAX = 40;
export const COMMENT_POST_LIMIT = 5;
export const COMMENT_POST_WINDOW_MS = 10 * 60 * 1000;
export const COMMENT_PAGE_SIZE = 20;
export const COMMENT_ACTION = "comment";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One line: D1 exec treats a newline as the end of a statement.
const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL, ip_hash TEXT NOT NULL)";
const CREATE_INDEX_STATUS = "CREATE INDEX IF NOT EXISTS comments_status_created ON comments (status, created_at, id)";
const CREATE_INDEX_IP = "CREATE INDEX IF NOT EXISTS comments_ip_created ON comments (ip_hash, created_at)";

export type CommentStatus = "pending" | "approved" | "rejected";

export interface StoredComment {
  id: string;
  body: string;
  displayName: string;
  status: CommentStatus;
  createdAt: number;
  ipHash: string;
}

export interface CommentCursor {
  createdAt: number;
  id: string;
}

export interface CommentStore {
  ready(): Promise<void>;
  insert(row: StoredComment): Promise<void>;
  listApproved(limit: number, before: CommentCursor | null): Promise<StoredComment[]>;
  countSince(ipHash: string, since: number): Promise<number>;
  listByStatus(status: CommentStatus, limit: number): Promise<StoredComment[]>;
  updateStatus(id: string, status: "approved" | "rejected"): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

interface CommentsStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

/** The slice of D1 this store uses. Structural so the site typecheck does not need Worker globals. */
export interface CommentsDatabase {
  prepare(query: string): { bind(...values: unknown[]): CommentsStatement };
  exec(query: string): Promise<unknown>;
}

interface SqlComment {
  id: string;
  body: string;
  display_name: string;
  status: string;
  created_at: number;
  ip_hash: string;
}

function asStatus(value: string): CommentStatus {
  return value === "approved" || value === "rejected" || value === "pending" ? value : "pending";
}

function fromSql(row: SqlComment): StoredComment {
  return {
    id: String(row.id),
    body: String(row.body),
    displayName: String(row.display_name ?? ""),
    status: asStatus(String(row.status)),
    createdAt: Number(row.created_at),
    ipHash: String(row.ip_hash),
  };
}

const ROW_SQL = "id, body, display_name, status, created_at, ip_hash";

export class D1CommentStore implements CommentStore {
  constructor(private readonly db: CommentsDatabase) {}

  async ready(): Promise<void> {
    await this.db.exec(CREATE_TABLE);
    await this.db.exec(CREATE_INDEX_STATUS);
    await this.db.exec(CREATE_INDEX_IP);
  }

  async insert(row: StoredComment): Promise<void> {
    await this.db
      .prepare("INSERT INTO comments (id, body, display_name, status, created_at, ip_hash) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind(row.id, row.body, row.displayName, row.createdAt, row.ipHash)
      .run();
  }

  async listApproved(limit: number, before: CommentCursor | null): Promise<StoredComment[]> {
    const stmt = before
      ? this.db
          .prepare(
            `SELECT ${ROW_SQL} FROM comments
             WHERE status = 'approved' AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .bind(before.createdAt, before.createdAt, before.id, limit)
      : this.db.prepare(`SELECT ${ROW_SQL} FROM comments WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit);
    const listed = await stmt.all<SqlComment>();
    return (listed.results ?? []).map(fromSql);
  }

  async countSince(ipHash: string, since: number): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async listByStatus(status: CommentStatus, limit: number): Promise<StoredComment[]> {
    const listed = await this.db
      .prepare(`SELECT ${ROW_SQL} FROM comments WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(status, limit)
      .all<SqlComment>();
    return (listed.results ?? []).map(fromSql);
  }

  async updateStatus(id: string, status: "approved" | "rejected"): Promise<boolean> {
    const result = await this.db.prepare("UPDATE comments SET status = ? WHERE id = ?").bind(status, id).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}

export interface CommentsConfig {
  adminToken: string;
  turnstileSecret: string;
  turnstileHostnames: string[];
  ipPepper: string;
  postLimit: number;
  postWindowMs: number;
  pageSize: number;
}

type Env = Record<string, string | undefined>;

/** Hostnames allowed to submit. Unset means the live site only. Localhost is not in that default. */
export function loadCommentsConfig(env: Env): CommentsConfig {
  const hosts = (env.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return {
    adminToken: env.COMMENT_ADMIN_TOKEN ?? "",
    turnstileSecret: env.TURNSTILE_SECRET ?? "",
    turnstileHostnames: hosts.length ? hosts : ["beingsvote.live"],
    ipPepper: env.COMMENT_IP_PEPPER ?? "",
    postLimit: COMMENT_POST_LIMIT,
    postWindowMs: COMMENT_POST_WINDOW_MS,
    pageSize: COMMENT_PAGE_SIZE,
  };
}

/** SHA-256 of the address plus a pepper. The raw address is not stored. */
export async function hashIp(ip: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`beings-comments-v1\n${pepper}\n${ip}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Strip control characters. Newlines stay in a comment body; names are one line. */
export function cleanCommentText(value: unknown, max: number, newlines: boolean): string | null {
  if (typeof value !== "string") return null;
  const without = newlines ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") : value.replace(/[\u0000-\u001F\u007F]/g, "");
  const text = without.trim();
  if (text.length > max) return null;
  return text;
}

export function parseCursor(raw: string | null): CommentCursor | null {
  if (!raw) return null;
  const match = /^(\d{1,16})_([0-9a-f-]{36})$/i.exec(raw);
  const created = match?.[1];
  const id = match?.[2];
  if (!created || !id) return null;
  const createdAt = Number(created);
  if (!Number.isSafeInteger(createdAt)) return null;
  return { createdAt, id };
}

function cursorOf(row: StoredComment): string {
  return `${row.createdAt}_${row.id}`;
}

function publicView(row: StoredComment) {
  return { id: row.id, body: row.body, displayName: row.displayName, createdAt: row.createdAt };
}

function reviewView(row: StoredComment) {
  return { id: row.id, body: row.body, displayName: row.displayName, status: row.status, createdAt: row.createdAt };
}

export type TurnstileVerdict = "ok" | "forbidden" | "not-configured";

export async function verifyTurnstileToken(
  input: { secret: string; token: unknown; remoteIp: string; hostnames: readonly string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  if (input.secret.length < MIN_TOKEN_LENGTH) return "not-configured";
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 2048) return "forbidden";
  const expected = new Set(input.hostnames.map((host) => host.trim()).filter(Boolean));
  if (expected.size === 0) return "forbidden";
  let result: { success?: unknown; action?: unknown; hostname?: unknown };
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret: input.secret, response: input.token, remoteip: input.remoteIp }),
    });
    if (!response.ok) return "forbidden";
    result = (await response.json()) as { success?: unknown; action?: unknown; hostname?: unknown };
  } catch {
    return "forbidden";
  }
  if (result.success !== true || result.action !== COMMENT_ACTION || typeof result.hostname !== "string" || !expected.has(result.hostname)) return "forbidden";
  return "ok";
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const advertised = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(advertised) && advertised > 4096) return { ok: false, status: 413, error: "comment is too large" };
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.includes("application/json")) return { ok: false, status: 415, error: "send JSON" };
  let text = "";
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: "the comment was not valid JSON" };
  }
  if (text.length > 4096) return { ok: false, status: 413, error: "comment is too large" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "the comment was not valid JSON" };
  }
}

function pageLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 50);
}

function reviewStatus(raw: string | null): CommentStatus {
  return raw === "approved" || raw === "rejected" ? raw : "pending";
}

export interface CommentDeps {
  store: CommentStore;
  config: CommentsConfig;
  now: () => number;
  ip: string;
  /** False when the in-memory per-IP limiter already refused this public POST. */
  postAllowed: boolean;
  fetchImpl?: typeof fetch;
}

export async function handleComments(req: Request, deps: CommentDeps): Promise<Response> {
  const url = new URL(req.url);
  const review = url.pathname === "/api/comments/review";
  try {
    await deps.store.ready();
    if (review) return await handleReview(req, url, deps);
    if (url.pathname !== "/api/comments") return json(404, { error: "not found" });
    if (req.method === "GET") return await listPublic(url, deps);
    if (req.method === "POST") return await submitPublic(req, deps);
    return json(405, { error: "method not allowed" }, { allow: "GET, POST, OPTIONS" });
  } catch (err) {
    console.error(JSON.stringify({ message: "comment request failed", error: err instanceof Error ? err.message : "unknown" }));
    return json(500, { error: "internal error" });
  }
}

async function listPublic(url: URL, deps: CommentDeps): Promise<Response> {
  const limit = pageLimit(url, deps.config.pageSize);
  const before = parseCursor(url.searchParams.get("cursor"));
  const rows = await deps.store.listApproved(limit + 1, before);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(200, {
    comments: page.map(publicView),
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  });
}

async function submitPublic(req: Request, deps: CommentDeps): Promise<Response> {
  if (!deps.postAllowed) return json(429, { error: "too many comments; try again later" }, { "retry-after": "600" });
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const record = parsed.value;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return json(400, { error: "check the comment and try again" });
  const fields = record as { body?: unknown; displayName?: unknown; turnstileToken?: unknown };
  const body = cleanCommentText(fields.body, COMMENT_MAX_CHARS, true);
  if (body === null) return json(400, { error: "comment is too long" });
  if (!body) return json(400, { error: "enter a comment" });
  const named = fields.displayName == null || fields.displayName === "" ? "" : cleanCommentText(fields.displayName, COMMENT_NAME_MAX, false);
  if (named === null) return json(400, { error: "display name is too long" });
  const verdict = await verifyTurnstileToken(
    { secret: deps.config.turnstileSecret, token: fields.turnstileToken, remoteIp: deps.ip, hostnames: deps.config.turnstileHostnames },
    deps.fetchImpl,
  );
  if (verdict === "not-configured") return json(503, { error: "comment submission is not configured" });
  if (verdict !== "ok") return json(403, { error: "spam check failed" });
  const ipHash = await hashIp(deps.ip, deps.config.ipPepper);
  const since = deps.now() - deps.config.postWindowMs;
  if ((await deps.store.countSince(ipHash, since)) >= deps.config.postLimit) {
    return json(429, { error: "too many comments; try again later" }, { "retry-after": "600" });
  }
  await deps.store.insert({
    id: crypto.randomUUID(),
    body,
    displayName: named,
    status: "pending",
    createdAt: deps.now(),
    ipHash,
  });
  return json(201, { status: "received" });
}

async function handleReview(req: Request, url: URL, deps: CommentDeps): Promise<Response> {
  const auth = checkBearer(req.headers.get("authorization"), deps.config.adminToken);
  if (auth === "not-configured") return json(503, { error: "comment review is not configured" });
  if (auth !== "ok") return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="beings-comments"' });
  if (req.method === "GET") {
    const status = reviewStatus(url.searchParams.get("status"));
    const rows = await deps.store.listByStatus(status, pageLimit(url, 50));
    return json(200, { comments: rows.map(reviewView) });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "GET, POST, OPTIONS" });
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const record = parsed.value;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return json(400, { error: "check the comment and try again" });
  const fields = record as { id?: unknown; action?: unknown };
  if (typeof fields.id !== "string" || !UUID_RE.test(fields.id)) return json(400, { error: "unknown comment" });
  if (fields.action === "delete") {
    const removed = await deps.store.remove(fields.id);
    return removed ? json(200, { status: "deleted" }) : json(404, { error: "unknown comment" });
  }
  if (fields.action !== "approve" && fields.action !== "reject") return json(400, { error: "unknown action" });
  const status = fields.action === "approve" ? "approved" : "rejected";
  const updated = await deps.store.updateStatus(fields.id, status);
  return updated ? json(200, { status }) : json(404, { error: "unknown comment" });
}
