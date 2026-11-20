// Live stats in the shared header, beside the logo (not a strip above it). Starts as a skeleton of fixed height (in
// index.html), fills in from stats.js without blocking the page, and never shows a made-up number.
// A slow marquee that pauses on hover, on keyboard focus, and with its pause button.
// prefers-reduced-motion: a static, wrapping block (CSS).
import { h, icon } from "./ui.js";
import { loadStats, tickerItems, STATS_EXPLAIN } from "./stats.js";

export const TICKER_ERROR = "Live stats unavailable right now. Everything else on this page still works.";
const KIND_TEXT = { measured: "measured", estimated: "estimated", live: "live" };

const itemNode = (it) =>
  h(
    "li",
    { class: `tick tick-${it.id}`, "data-kind": it.kind },
    h("span", { class: "tick-label" }, it.label),
    h("strong", { class: "tick-value" }, it.value),
    it.note ? h("span", { class: "tick-note" }, it.note) : null,
    it.badge ? h("span", { class: "tick-badge" }, it.badge) : null,
    it.kind !== "live" ? h("span", { class: `tick-kind tick-kind-${it.kind}` }, KIND_TEXT[it.kind]) : null,
  );

/** The explanation panel ("What is this?"). */
export function explainPanel(id = "ticker-explain") {
  return h(
    "div",
    { class: "ticker-explain", id, hidden: true },
    h("p", { class: "small" }, h("strong", null, "What is this? "), "Live numbers about B.E.I.N.G.S., read straight from the public Coston2 test network a moment ago. Nothing here is typed in by us. ", h("em", null, "Measured"), " means taken from real transaction receipts; ", h("em", null, "estimated"), " means worked out from them."),
    h("dl", { class: "ticker-dl" }, STATS_EXPLAIN.flatMap(([t, d]) => [h("dt", null, t), h("dd", null, d)])),
  );
}

/** Fill the ticker element. state: {status: "loading"|"ready"|"error", stats?} */
export function paintTicker(root, state, now = Date.now()) {
  const explain = explainPanel();
  const whatBtn = h("button", { class: "ticker-btn", type: "button", "aria-expanded": "false", "aria-controls": "ticker-explain", onClick: (e) => {
    const open = explain.hidden;
    explain.hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", String(open));
  } }, icon("info", { size: 14 }), h("span", null, "What is this?"));
  const title = h("span", { class: "ticker-title" }, icon("activity", { size: 14 }), "Live");
  // On a ready ticker the pause control and "What is this?" sit with the Live label. The moving line is last so CSS
  // can wrap it underneath them without reordering the tab sequence.
  let before = [];
  let after = [];
  if (state.status === "ready") {
    const items = tickerItems(state.stats, now);
    const list = (hidden) => h("ul", { class: "ticker-list", "aria-hidden": hidden ? "true" : null }, items.map(itemNode));
    const pauseBtn = h("button", { class: "ticker-btn ticker-pause", type: "button", "aria-pressed": "false", "aria-label": "Pause the moving stats", onClick: (e) => {
      const paused = root.classList.toggle("paused");
      e.currentTarget.setAttribute("aria-pressed", String(paused));
      e.currentTarget.setAttribute("aria-label", paused ? "Play the moving stats" : "Pause the moving stats");
      e.currentTarget.replaceChildren(icon(paused ? "play" : "pause", { size: 14 }));
    } }, icon("pause", { size: 14 }));
    before = [pauseBtn];
    after = [h("div", { class: "ticker-viewport", tabindex: "0", "aria-label": "Live stats (moves slowly; hover, focus or press pause to stop it)" }, h("div", { class: "ticker-track" }, list(false), list(true)))];
  } else if (state.status === "error") {
    before = [h("p", { class: "ticker-msg", role: "status" }, h("span", { class: "tick-badge" }, "Coston2 test network · play money"), " ", TICKER_ERROR)];
  } else {
    before = [h("p", { class: "ticker-msg ticker-skeleton", "aria-busy": "true" }, h("span", { class: "sk" }), h("span", { class: "sk" }), h("span", { class: "sk" }), h("span", { class: "sr-only" }, "Loading live stats…"))];
  }
  root.classList.toggle("is-ready", state.status === "ready");
  root.classList.toggle("is-error", state.status === "error");
  root.replaceChildren(h("div", { class: "ticker-bar" }, title, ...before, whatBtn, ...after), explain);
  // marquee speed: about 50 px per second, whatever the content width
  const track = root.querySelector?.(".ticker-track");
  if (track && typeof requestAnimationFrame === "function") requestAnimationFrame(() => track.style.setProperty("--ticker-duration", `${Math.max(30, Math.round(track.scrollWidth / 2 / 50))}s`));
}

/** Start the ticker without blocking anything; refreshes every 60 s while the tab is visible. */
export function startTicker(root = document.getElementById("stats-ticker"), { load = loadStats, every = 60_000 } = {}) {
  if (!root) return;
  const run = async () => {
    try {
      const stats = await load();
      paintTicker(root, { status: "ready", stats });
    } catch {
      if (!root.classList.contains("is-ready")) paintTicker(root, { status: "error" });
    }
  };
  paintTicker(root, { status: "loading" });
  run();
  if (every) setInterval(() => document.visibilityState !== "hidden" && run(), every);
}
