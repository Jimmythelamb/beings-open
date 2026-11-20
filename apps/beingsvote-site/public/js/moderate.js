// Comment review. The token is checked by the Worker (COMMENT_ADMIN_TOKEN). This page does not decide.
// The token stays in this page's memory. It is not written to localStorage and it is not put in the address.
import { h, setTitle, callout } from "./ui.js";
import { resolveCommentsUrl } from "./config.js";

const STATUSES = [
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
];

function when(ms) {
  if (!ms) return "";
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function reviewRows(data) {
  const rows = Array.isArray(data?.comments) ? data.comments : [];
  return rows.filter((row) => row && typeof row.id === "string" && typeof row.body === "string");
}

export function renderModerate(ctx, { fetchImpl = globalThis.fetch.bind(globalThis), reviewUrl = resolveCommentsUrl("/api/comments/review") } = {}) {
  setTitle("Review comments");
  const tokenInput = h("input", { id: "review-token", type: "password", autocomplete: "off", maxlength: "200", spellcheck: "false" });
  const status = h("select", { id: "review-status" }, ...STATUSES.map(([value, label]) => h("option", { value }, label)));
  const note = h("div", { id: "review-note", role: "status" });
  const list = h("div", { id: "review-list" });
  let token = "";

  const explain = (res) => {
    if (res.status === 401) return "That token was refused. Nothing was changed.";
    if (res.status === 503) return "Comment review isn't configured on the service yet.";
    if (res.status === 404) return "That comment is no longer there.";
    return "The comment service didn't answer. Nothing on the election record was changed.";
  };

  async function load() {
    token = tokenInput.value.trim();
    list.replaceChildren();
    if (!reviewUrl) {
      note.replaceChildren(callout("info", "Not connected", "Comment review isn't connected yet. The comment service address is empty or not a safe https origin."));
      return;
    }
    if (token.length < 24) {
      note.replaceChildren(callout("info", "Token needed", "Enter the moderation token. It is checked by the comment service, not by this page."));
      return;
    }
    note.replaceChildren(h("p", { class: "hint" }, "Loading…"));
    try {
      const url = new URL(reviewUrl);
      url.searchParams.set("status", status.value);
      const res = await fetchImpl(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
      if (!res.ok) {
        note.replaceChildren(callout("warn", "Couldn't load comments", explain(res)));
        return;
      }
      const rows = reviewRows(await res.json());
      note.replaceChildren();
      if (!rows.length) {
        list.replaceChildren(h("p", { class: "hint" }, "No comments in this list."));
        return;
      }
      list.replaceChildren(
        h(
          "ul",
          { class: "comment-list" },
          ...rows.map((row) => {
            const who = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : "Anonymous";
            const stamp = when(row.createdAt);
            const act = (action, label) =>
              h("button", { class: "btn", type: "button", onClick: () => moderate(row.id, action) }, label);
            return h(
              "li",
              { class: "comment" },
              h("p", { class: "comment-meta" }, who, stamp ? ` · ${stamp}` : "", row.status ? ` · ${row.status}` : ""),
              h("p", null, row.body),
              h("div", { class: "actions" }, act("approve", "Approve"), act("reject", "Reject"), act("delete", "Delete")),
            );
          }),
        ),
      );
    } catch {
      note.replaceChildren(callout("warn", "Couldn't load comments", "The comment service didn't answer. Nothing on the election record was changed."));
    }
  }

  async function moderate(id, action) {
    if (!reviewUrl || !token) return;
    note.replaceChildren(h("p", { class: "hint" }, "Saving…"));
    try {
      const res = await fetchImpl(reviewUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        note.replaceChildren(callout("warn", "That didn't save", explain(res)));
        return;
      }
      await load();
    } catch {
      note.replaceChildren(callout("warn", "That didn't save", "The comment service didn't answer. Nothing on the election record was changed."));
    }
  }

  const form = h(
    "form",
    { class: "form", novalidate: true, onSubmit: (event) => (event.preventDefault(), load()) },
    h("div", { class: "field" }, h("label", { for: "review-token" }, "Moderation token"), tokenInput, h("p", { class: "hint" }, "Checked by the comment service. It is not saved in this browser.")),
    h("div", { class: "field" }, h("label", { for: "review-status" }, "Show"), status),
    h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "submit" }, "Load comments")),
  );
  ctx.root.replaceChildren(
    h("a", { class: "back", href: "#/system" }, "← System admin"),
    h("header", { class: "page-head" }, h("h1", null, "Review public comments"), h("p", { class: "lead" }, "New comments stay hidden until you approve them. Rejected and deleted comments are not shown on the site. None of this is written on the blockchain.")),
    h("section", { class: "card" }, form, note),
    h("section", { class: "card" }, list),
  );
}
