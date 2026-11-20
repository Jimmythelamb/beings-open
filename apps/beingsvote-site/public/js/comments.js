// Public comments on Home and How it works. Text is set with text nodes. The list is approved comments only.
import { h } from "./ui.js";
import { CONFIG, resolveCommentsUrl, turnstileSiteKey } from "./config.js";

export const COMMENT_MAX = 250;
export const COMMENT_NAME_MAX = 40;
export const COMMENT_RECEIVED = "Your comment was received and will appear here after a review.";
export const COMMENTS_UNAVAILABLE = "Approved comments aren't available right now. The rest of this page still works.";
export const COMMENTS_TURNSTILE_OFF = "Sending a comment is turned off until spam protection is set up.";

/** Home and How it works only. */
export function pageShowsComments(path) {
  return path === "/" || path === "/how";
}

export function publicCommentsFromPayload(data) {
  const rows = Array.isArray(data?.comments) ? data.comments : [];
  const comments = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.body !== "string") continue;
    const createdAt = Number(row.createdAt);
    comments.push({
      id: row.id.slice(0, 80),
      body: row.body.slice(0, COMMENT_MAX),
      displayName: typeof row.displayName === "string" ? row.displayName.slice(0, COMMENT_NAME_MAX) : "",
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    });
  }
  const nextCursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor.slice(0, 80) : "";
  return { comments, nextCursor };
}

function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

function when(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function commentItem(row) {
  const who = row.displayName.trim() || "Anonymous";
  const stamp = when(row.createdAt);
  return h("li", { class: "comment" }, h("p", { class: "comment-meta" }, who, stamp ? ` · ${stamp}` : ""), h("p", null, row.body));
}

function loadTurnstileWidget(container, siteKey, onToken) {
  const draw = () => {
    const api = window.turnstile;
    if (!api || typeof api.render !== "function") throw new Error("turnstile missing");
    const id = api.render(container, {
      sitekey: siteKey,
      action: "comment",
      callback: (token) => onToken(String(token || "")),
      "expired-callback": () => onToken(""),
      "error-callback": () => onToken(""),
    });
    return { reset: () => api.reset(id) };
  };
  if (window.turnstile?.render) return Promise.resolve(draw());
  return new Promise((resolve, reject) => {
    let script = document.querySelector("script[data-beings-turnstile]");
    if (!script) {
      script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.beingsTurnstile = "1";
      document.head.append(script);
    }
    script.addEventListener("load", () => {
      try {
        resolve(draw());
      } catch (err) {
        reject(err);
      }
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("turnstile failed to load")), { once: true });
  });
}

/**
 * The comments block. `listUrl` empty, or a failed fetch, leaves a calm note and does not throw.
 * Submission stays disabled until a Turnstile site key is configured.
 */
export function renderPublicComments({
  listUrl = resolveCommentsUrl(CONFIG.commentsApi || "/api/comments"),
  fetchImpl = globalThis.fetch.bind(globalThis),
  siteKey = turnstileSiteKey(),
  loadTurnstile = loadTurnstileWidget,
} = {}) {
  const list = h("div", { id: "comment-list-wrap" });
  const name = h("input", { id: "comment-name", type: "text", maxlength: String(COMMENT_NAME_MAX), autocomplete: "nickname" });
  const box = h("textarea", { id: "comment-body", rows: "4", maxlength: String(COMMENT_MAX) });
  const count = h("p", { class: "char-count", id: "comment-count", "aria-live": "polite" });
  const widget = h("div", { id: "comment-turnstile" });
  const note = h("div", { id: "comment-note", role: "status" });
  const send = h("button", { class: "btn btn-primary", id: "comment-send", type: "submit" }, "Send comment");
  let token = "";
  let widgetHandle = null;
  const paintCount = () => {
    count.textContent = `${box.value.length} / ${COMMENT_MAX}`;
    count.classList.toggle("at-limit", box.value.length >= COMMENT_MAX);
  };
  paintCount();
  box.addEventListener("input", paintCount);
  const setToken = (value) => {
    token = value;
    send.disabled = !siteKey || !token || box.value.trim().length === 0;
  };
  if (!siteKey) {
    send.disabled = true;
    note.replaceChildren(h("p", null, COMMENTS_TURNSTILE_OFF));
  } else {
    send.disabled = true;
    loadTurnstile(widget, siteKey, setToken).then(
      (handle) => {
        widgetHandle = handle;
      },
      () => {
        send.disabled = true;
        note.replaceChildren(h("p", null, "Spam protection didn't load, so sending a comment is turned off."));
      },
    );
  }
  box.addEventListener("input", () => {
    if (siteKey) send.disabled = !token || box.value.trim().length === 0;
  });

  const paintList = (payload, append) => {
    const parsed = publicCommentsFromPayload(payload);
    const items = parsed.comments.map(commentItem);
    const older = parsed.nextCursor
      ? h("button", { class: "btn", type: "button", onClick: () => load(parsed.nextCursor, true) }, "Older comments")
      : null;
    if (!append) {
      const kids = items.length ? [h("ol", { class: "comment-list" }, ...items)] : [h("p", { class: "hint" }, "No approved comments yet.")];
      if (older) kids.push(older);
      list.replaceChildren(...kids);
      return;
    }
    const ol = list.querySelector(".comment-list") ?? h("ol", { class: "comment-list" });
    if (!ol.parentNode) list.replaceChildren(ol);
    ol.append(...items);
    list.querySelector("button")?.remove();
    if (older) list.append(older);
  };

  async function load(cursor, append) {
    if (!listUrl) {
      list.replaceChildren(h("p", { class: "hint" }, COMMENTS_UNAVAILABLE));
      return;
    }
    if (!append) list.replaceChildren(h("p", { class: "hint", role: "status" }, "Loading comments…"));
    const url = new URL(listUrl);
    url.searchParams.set("limit", "20");
    if (cursor) url.searchParams.set("cursor", cursor);
    try {
      const res = await fetchImpl(url.toString(), { headers: { accept: "application/json" }, signal: timeoutSignal(8000) });
      if (!res.ok) throw new Error("unavailable");
      paintList(await res.json(), append);
    } catch {
      if (!append) list.replaceChildren(h("p", { class: "hint" }, COMMENTS_UNAVAILABLE));
    }
  }

  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "comment-name" }, "Name or initials (optional)"), name),
    h("div", { class: "field" }, h("label", { for: "comment-body" }, "Comment"), box, count),
    widget,
    note,
    h("div", { class: "actions" }, send),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!siteKey || !listUrl) return;
    const body = box.value.trim();
    const displayName = name.value.trim();
    if (!body || body.length > COMMENT_MAX || displayName.length > COMMENT_NAME_MAX || !token) return;
    send.disabled = true;
    try {
      const res = await fetchImpl(listUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ body, displayName, turnstileToken: token }),
        signal: timeoutSignal(8000),
      });
      if (res.status === 201) {
        box.value = "";
        name.value = "";
        paintCount();
        token = "";
        widgetHandle?.reset();
        note.replaceChildren(h("p", null, COMMENT_RECEIVED));
        return;
      }
      const quiet = res.status === 503 ? COMMENTS_TURNSTILE_OFF : res.status === 429 ? "You've sent several comments. Please wait a few minutes and try again." : "The comment service isn't available right now. Nothing was published.";
      note.replaceChildren(h("p", null, quiet));
    } catch {
      note.replaceChildren(h("p", null, "The comment service isn't available right now. Nothing was published."));
    } finally {
      if (siteKey) send.disabled = !token || box.value.trim().length === 0;
    }
  });

  const section = h(
    "section",
    { class: "card public-comments", "aria-labelledby": "public-comments-title" },
    h("h2", { id: "public-comments-title" }, "Public comments"),
    h("p", null, "Comments are reviewed before they appear. They are kept off the election record and are not written on the blockchain."),
    list,
    form,
  );
  load();
  return section;
}
