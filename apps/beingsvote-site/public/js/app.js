// App shell: hash router, navigation, light/dark theme, optional wallet connection and role gating.
import { h, icon, badge, callout, setTitle, toast, extLink, explorerAddress, copyText } from "./ui.js";
import { CONFIG } from "./config.js";
import { WALLET_CONNECT_LEAD } from "./walletui.js";
import { state as walletState, subscribe, disconnect, restore, ROLE_INFO, activeRoleIds, ensureCoston2 } from "./roles.js";
import { shortAddress } from "./format.js";
import { walletChipModel, walletChipAvatar, walletChipExtras, walletRoleLine } from "./wallet-chip.js";
import { openConnect, prepareMobileConnect } from "./appkit-client.js";
import { explainConnectError } from "./appkit-connect.js";
import { isUserRejected, isMobileDevice } from "./logic.js";
import { noWalletYet } from "./wallet-info.js";
import { startTicker } from "./ticker.js";
import { faucetButton } from "./faucet.js";
import { renderHome, createBanner, WHITEPAPER_HREF, WHITEPAPER_LABEL } from "./home.js";
import { renderResultsList, renderElection } from "./results.js";
import { renderVoter } from "./voter.js";
import { isCheckDocumentPath, routeFromLocation } from "./check-link.js";
import { renderStaffHub } from "./staff.js";
import { renderVerifier } from "./verifier.js";
import { renderOfficer } from "./officer.js";
import { renderAdmin } from "./admin.js";
import { renderSystem } from "./system.js";
import { renderScanner } from "./scanner.js";
import { clearStartHereView, createLinkAlreadyHere, revealStartHere } from "./start-here.js";
import { renderExplainer } from "./explain.js";
import { renderContact } from "./contact.js";
import { pageShowsComments, renderPublicComments } from "./comments.js";
import { renderModerate } from "./moderate.js";

const root = document.getElementById("app");
let navToken = 0;

const NAV = [
  ["#/", "Home", "home"],
  ["#/results", "Results", "results"],
  ["#/check", "Check my ballot", "check"],
  ["#/how", "How it works", "how"],
  ["#/staff", "Staff", "staff"],
  ["#/contact", "Contact", "contact"],
];

// Staff screens. They open for everyone (reading is public). Election admin keeps connect-wallet inside
// its start steps. Other roles ask for a wallet inside their own panel only when an action needs one.
// The header Connect wallet button is unchanged.
const STAFF = { "/verifier": renderVerifier, "/officer": renderOfficer, "/admin": renderAdmin, "/scanner": renderScanner, "/system": renderSystem };

function parseHash() {
  return routeFromLocation({ pathname: location.pathname, hash: location.hash });
}

function sectionOf(path) {
  if (path === "/") return "home";
  if (path.startsWith("/results")) return "results";
  if (path.startsWith("/check")) return "check";
  if (path.startsWith("/how")) return "how";
  if (path === "/contact") return "contact";
  return "staff";
}

// Public comments sit in the slot above the footer, and only on Home and How it works.
function syncPageComments(path) {
  const slot = document.getElementById("page-comments");
  if (!slot) return;
  if (!pageShowsComments(path)) {
    slot.replaceChildren();
    slot.hidden = true;
    delete slot.dataset.page;
    return;
  }
  if (slot.dataset.page === path && slot.childElementCount > 0) return;
  slot.hidden = false;
  slot.dataset.page = path;
  try {
    slot.replaceChildren(renderPublicComments());
  } catch (err) {
    console.error(err);
    slot.replaceChildren();
    slot.hidden = true;
  }
}

async function route() {
  const token = ++navToken;
  const { path, query } = parseHash();
  const ctx = { root, query, params: {}, current: () => token === navToken };
  document.querySelectorAll("#nav a").forEach((a) => (a.dataset.section === sectionOf(path) ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const startHere = path === "/admin" && query.get("new") === "1";
  if (!startHere) clearStartHereView();
  // Instant reset. The Start here landing does its own smooth scroll once the form is on the page.
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  try {
    if (path === "/") renderHome(ctx);
    else if (path === "/results") await renderResultsList(ctx);
    else if (path.startsWith("/results/")) {
      ctx.params.code = decodeURIComponent(path.slice("/results/".length));
      await renderElection(ctx);
    } else if (path === "/check") await renderVoter(ctx);
    else if (path === "/how") {
      setTitle("How it works");
      root.replaceChildren(h("header", { class: "page-head" }, h("h1", null, "How it works"), h("p", { class: "lead" }, "No technical knowledge needed.")), renderExplainer({}));
    } else if (path === "/contact") renderContact(ctx);
    else if (path === "/moderate") renderModerate(ctx);
    else if (path === "/staff") await renderStaffHub(ctx);
    else if (STAFF[path]) await STAFF[path](ctx);
    else {
      setTitle("Page not found");
      root.replaceChildren(h("div", { class: "card" }, h("h1", null, "We couldn't find that page"), h("p", null, "The link may be old or mistyped."), h("a", { class: "btn btn-primary", href: "#/" }, "Go to the home page")));
    }
  } catch (e) {
    console.error(e);
    root.replaceChildren(h("div", { class: "card" }, callout("warn", "Something went wrong", "Please reload the page. If it keeps happening, tell an election officer.")));
  }
  if (token === navToken) {
    syncPageComments(path);
    // move focus to the page heading so keyboard and screen-reader users start at the top of the new page
    const hd = root.querySelector("h1");
    if (hd) {
      hd.setAttribute("tabindex", "-1");
      hd.focus({ preventScroll: true });
    }
    document.getElementById("route-status").textContent = document.title;
  }
}

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function setupTheme() {
  try {
    applyTheme(localStorage.getItem("beings.theme"));
  } catch {
    /* ignore */
  }
  const btn = document.getElementById("theme-btn");
  const paint = () => {
    const dark = currentTheme() === "dark";
    btn.replaceChildren(icon(dark ? "sun" : "moon", { size: 20 }), h("span", { class: "sr-only" }, dark ? "Switch to light mode" : "Switch to dark mode"));
    btn.setAttribute("aria-pressed", String(dark));
  };
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("beings.theme", next);
    } catch {
      /* ignore */
    }
    paint();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  paint();
}

// ------------------------------------------------------------------ wallet
const dialog = document.getElementById("wallet-dialog");
const walletBtn = document.getElementById("wallet-btn");
const roleBar = document.getElementById("role-bar");

function paintWallet() {
  const s = walletState;
  // Header chip: the connected wallet (short address, network, copy, disconnect). Same header on every page.
  const chip = walletChipModel(s, CONFIG.chainId);
  const face = chip.connected ? walletChipAvatar(chip.address) : icon("wallet", { size: 18 });
  const chipBits = [face, h("span", null, chip.label)];
  if (chip.balanceText) chipBits.push(h("span", { class: "wallet-bal" }, chip.balanceText));
  walletBtn.replaceChildren(...chipBits);
  walletBtn.title = chip.balanceText ? `${chip.title} Balance ${chip.balanceText}.` : chip.title;
  walletBtn.classList.toggle("connected", chip.connected);
  document.getElementById("wallet-extra")?.replaceChildren(...walletChipExtras(chip, { onCopy: (a) => copyText(a, "Wallet address copied"), onDisconnect: () => (disconnect(), toast("Disconnected")), onSwitch: () => ensureCoston2().catch(() => toast("Your wallet didn't switch networks.")) }));
  // Public and Voter were always-on pills, not a view switch: every visitor can already read results
  // and open Check my ballot from the nav. Staff roles still show here after a wallet connects.
  const roles = activeRoleIds().filter((r) => r !== "public" && r !== "voter");
  const access = [
    ...roles.map((r) => badge(ROLE_INFO[r].label, "ok", "unlock")),
    s.status === "checking" ? h("span", { class: "muted small" }, " checking your wallet…") : null,
    walletRoleLine(chip),
  ].filter(Boolean);
  const roleRow = document.getElementById("role-row");
  if (access.length) {
    roleBar.replaceChildren(h("span", { class: "sr-only" }, "Your access: "), ...access);
    roleRow?.removeAttribute("hidden");
  } else {
    roleBar.replaceChildren();
    roleRow?.setAttribute("hidden", "");
  }
  // dialog body
  const body = document.getElementById("wallet-body");
  const parts = [];
  if (s.address) {
    parts.push(
      h("p", null, "Connected as ", h("code", { class: "code" }, s.address)),
      s.status === "checking" ? h("p", { role: "status" }, "Checking the public registries…") : null,
      s.error ? callout("warn", "Couldn't check roles", s.error) : null,
      s.status === "ready" ? roleSummary() : null,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => (disconnect(), toast("Disconnected")) }, "Disconnect"), h("button", { class: "btn btn-primary", type: "button", onClick: () => (dialog.close(), (location.hash = "#/staff")) }, "Go to Staff Porthole")),
    );
  } else {
    parts.push(h("p", { class: "wallet-lead" }, WALLET_CONNECT_LEAD), noWalletYet());
  }
  body.replaceChildren(...parts.filter(Boolean));
}

function roleSummary() {
  const rows = [["Public", "Always"], ["Voter", "Always"]];
  for (const r of ["verifier", "officer", "admin", "system"]) rows.push([ROLE_INFO[r].label, walletState.roles[r] ? "Unlocked" : "Not registered"]);
  return h("table", { class: "role-table" }, h("caption", { class: "sr-only" }, "Your roles"), h("tbody", null, rows.map(([a, b]) => h("tr", null, h("th", { scope: "row" }, a), h("td", null, b)))));
}

function showConnectError(message) {
  const body = document.getElementById("wallet-body");
  body.replaceChildren(
    h("p", { class: "wallet-lead" }, WALLET_CONNECT_LEAD),
    callout("warn", "That didn't connect", message),
    h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", onClick: () => beginConnect() }, "Try again")),
    noWalletYet(),
  );
  if (!dialog.open) dialog.showModal();
}

async function beginConnect() {
  walletBtn.setAttribute("aria-busy", "true");
  try {
    await openConnect();
  } catch (e) {
    if (isUserRejected(e)) toast("No problem. Nothing was shared.");
    else showConnectError(explainConnectError(e));
    document.dispatchEvent(new CustomEvent("beings:wallet-dismissed"));
  } finally {
    walletBtn.removeAttribute("aria-busy");
  }
}

function openWallet() {
  if (walletState.address) {
    paintWallet();
    if (!dialog.open) dialog.showModal();
    return;
  }
  beginConnect();
}

function setupWallet() {
  walletBtn.addEventListener("click", openWallet);
  walletBtn.addEventListener("pointerdown", () => prepareMobileConnect());
  document.addEventListener("beings:open-wallet", openWallet);
  document.addEventListener("beings:wallet-error", (e) => {
    const message = e.detail;
    if (message && !/declined/i.test(String(message))) toast(String(message));
  });
  document.getElementById("wallet-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  if (isMobileDevice(navigator.userAgent, navigator.maxTouchPoints, navigator.platform)) prepareMobileConnect();
  let seen = "";
  subscribe(() => {
    paintWallet();
    // The staff hub draws its role cards once, so draw it again when the wallet or its roles change.
    // The other staff screens follow the wallet themselves, and keep what you typed.
    const sig = `${walletState.address}|${walletState.status}|${Object.values(walletState.roles).join()}`;
    if (sig !== seen) {
      seen = sig;
      if (parseHash().path === "/staff") route();
    }
  });
  paintWallet();
  restore();
}

// The header logo is a short looping video. Reduced-motion users get the still image (CSS);
// pause the file here so it does not keep playing off-screen.
function setupBrandLogo() {
  const video = document.querySelector("video.brand-logo");
  if (!(video instanceof HTMLVideoElement)) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => {
    if (motion.matches) {
      video.removeAttribute("autoplay");
      video.pause();
    } else {
      video.setAttribute("autoplay", "");
      video.play().catch(() => {});
    }
  };
  apply();
  motion.addEventListener("change", apply);
}

// ------------------------------------------------------------------ boot
function boot() {
  const navRoot = isCheckDocumentPath(location.pathname) ? "/" : "";
  document.getElementById("nav-list").replaceChildren(...NAV.map(([href, label, sec]) => h("li", null, h("a", { href: navRoot + href, "data-section": sec }, label))));
  document.getElementById("footer-net").textContent = `${CONFIG.chainName}, chain ${CONFIG.chainId}`;
  const contactHref = `${navRoot}#/contact`;
  document.getElementById("footer-links").replaceChildren(extLink(explorerAddress(CONFIG.contracts.registry), "Elections contract"), " · ", extLink(explorerAddress(CONFIG.contracts.ledger), "Ballot ledger contract"), " · ", extLink(explorerAddress(CONFIG.contracts.tally), "Totals contract"), " · ", extLink(explorerAddress(CONFIG.contracts.verifiers), "Verifier contract"), " · ", extLink(WHITEPAPER_HREF, WHITEPAPER_LABEL), " · ", h("a", { href: contactHref }, "Contact us"));
  document.getElementById("skip").addEventListener("click", (e) => {
    e.preventDefault(); // a bare #main would be read as a route
    document.getElementById("main").focus();
  });
  setupTheme();
  setupBrandLogo();
  document.getElementById("header-promo")?.replaceChildren(createBanner());
  document.body.addEventListener("click", (e) => {
    if (!createLinkAlreadyHere(e)) return;
    e.preventDefault();
    revealStartHere();
  });
  setupWallet();
  window.addEventListener("hashchange", route);
  route();
  // Live stats ticker: fills in after the page is drawn and never blocks it.
  setTimeout(() => startTicker(), 0);
  // "Get free test coins" (Flare Coston2 faucet guide) in the header, on every page.
  document.getElementById("faucet-slot")?.replaceChildren(faucetButton({ compact: true, getAddress: () => walletState.address }));
}
boot();
