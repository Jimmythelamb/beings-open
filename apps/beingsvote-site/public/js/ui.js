// Tiny DOM helpers. Text is always set with textContent / text nodes, never innerHTML, so nothing read from the
// chain, an election file or a server can inject markup.
import { CONFIG } from "./config.js";

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, so it works under a strict Content-Security-Policy
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children, skipping null/false entries (the native replaceChildren would print them as "null"). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const NS = "http://www.w3.org/2000/svg";
const ICONS = {
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  unlock: "M7 11V8a5 5 0 0 1 9.5-2M5 11h14v10H5z",
  shield: "M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z M9 12l2 2 4-4",
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  ticket: "M3 9V6h18v3a2 2 0 0 0 0 6v3H3v-3a2 2 0 0 0 0-6zM13 6v12",
  users: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8",
  clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  wallet: "M3 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V5a2 2 0 0 1 2-2h12v4M17 14h2",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  flag: "M4 22V4M4 4h13l-2 4 2 4H4",
  image: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  arrow: "M5 12h14M13 6l6 6-6 6",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  qr: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v.01M14 20h3M20 17v4",
  browser: "M3 4h18v16H3zM3 9h18M7 6.5h.01",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5V21h16",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  pause: "M8 5v14M16 5v14",
  play: "M7 4v16l13-8z",
  droplet: "M12 2.7 6.3 9.6a7 7 0 1 0 11.4 0z",
};
export function icon(name, { size = 20, label } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.info);
  svg.appendChild(p);
  return svg;
}

export const badge = (text, tone = "neutral", ic) => h("span", { class: `badge badge-${tone}` }, ic ? icon(ic, { size: 14 }) : null, text);

export function callout(tone, title, body, ic) {
  return h(
    "div",
    { class: `callout callout-${tone}`, role: tone === "warn" || tone === "bad" ? "alert" : "note" },
    icon(ic ?? (tone === "ok" ? "check" : tone === "info" ? "info" : "alert"), { size: 22 }),
    h("div", null, title ? h("strong", null, title) : null, body ? h("div", null, body) : null),
  );
}

export const spinner = (text = "Loading…") => h("div", { class: "loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, text));

export function skeleton(lines = 3) {
  return h("div", { class: "skeleton-wrap", "aria-hidden": "true" }, Array.from({ length: lines }, (_, i) => h("div", { class: "skeleton", style: `width:${90 - i * 12}%` })));
}

export const extLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text, " ", icon("external", { size: 14 }), h("span", { class: "sr-only" }, " (opens in a new tab)"));

export const explorerAddress = (a) => `${CONFIG.explorer}/address/${a}`;
export const explorerTx = (t) => `${CONFIG.explorer}/tx/${t}`;

let toastTimer;
export function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

export async function copyText(text, okMessage = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    toast("Couldn't copy automatically. Select the text and copy it.");
  }
}

export function fmtDate(unixSeconds, opts = {}) {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...opts });
}

/** A glossary term: dotted underline with an explanation that works on focus, hover and tap (no hover-only). */
export function term(word, meaning) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  const btn = h("button", { type: "button", class: "term-btn", "aria-describedby": id }, word);
  const wrap = h("span", { class: "term" }, btn, h("span", { class: "term-tip", role: "tooltip", id }, meaning));
  btn.addEventListener("click", () => wrap.classList.toggle("open")); // tap support (iOS doesn't focus buttons on tap)
  btn.addEventListener("blur", () => wrap.classList.remove("open"));
  btn.addEventListener("keydown", (e) => e.key === "Escape" && wrap.classList.remove("open"));
  return wrap;
}

export function setTitle(t) {
  document.title = t ? `${t} · B.E.I.N.G.S.` : "B.E.I.N.G.S. Public Election Ledger";
}
