// "Get free test coins": a button (header, wallet box, Create page) that opens an accessible step-by-step modal on
// getting C2FLR from the official Flare Faucet. Text only; a neutral droplet icon, no Flare logo, no endorsement.
// It never sends anything and never asks the faucet for coins itself: the person does that on the faucet's own page.
import { h, icon, extLink, copyText } from "./ui.js";
import { WALLET_GUIDE } from "./wallet-guide.js";
import { isAddress } from "./logic.js";
import { shortAddress } from "./format.js";

export const FAUCET_TITLE = "Get free test coins";

/** Visible label on every coral faucet button. The C2FLR mark sits between the words. */
export const FAUCET_BUTTON_LABEL = "Load your Wallet with C2FLR Here.";

export function c2flrIcon() {
  return h("img", {
    class: "faucet-c2flr",
    src: "/brand/c2flr/c2flr-64.webp",
    srcset: "/brand/c2flr/c2flr-32.webp 32w, /brand/c2flr/c2flr-64.webp 64w",
    sizes: "1.15em",
    width: "32",
    height: "32",
    alt: "C2FLR",
  });
}

/** How to copy a Coston2 address in Bifrost. The pictures are examples: balances, the QR, and the address are covered. */
export const BIFROST_ADDRESS_STEPS = [
  { src: "/help/bifrost/01-home.webp", alt: "Bifrost home screen. A round blue button with an upward chevron is at the bottom centre.", text: "Open Bifrost and tap the round button at the bottom." },
  { src: "/help/bifrost/02-menu.webp", alt: "Bifrost menu after the round button is tapped, showing Receive, Send, and Connect.", text: "Tap Receive." },
  { src: "/help/bifrost/03-search.webp", alt: "Bifrost Receive search with coston typed. Coston 2 Flare (C2FLR) is the first result, above Coston Flare (CFLR).", text: "Search “coston” and choose Coston 2 Flare (C2FLR), not Coston Flare (CFLR)." },
  { src: "/help/bifrost/04-address.webp", alt: "Bifrost Receive screen for Coston 2 Flare. The QR code and address are examples. The address is shown as 0x… and the caption says tap to copy.", text: "Tap the address to copy it, then paste it on the faucet." },
];

export const BIFROST_METAMASK_NOTE = "MetaMask users copy the address from the top of the account screen.";

export const BIFROST_DEV_CALLOUT = "Please change your Bifrost Wallet to Developer mode.";

export const BIFROST_DEV_TITLE = "Change Bifrost Wallet to Developer Mode";

export const BIFROST_DEV_NOTE = "Turning on Developer Mode means Bifrost uses test networks only (Flare shows Coston 2), so nobody risks real coins while testing B.E.I.N.G.S. Do this before you request test coins or connect.";

/** Settings, Advanced (Developer Mode and Coston 2), then the home screen of test coins. Balances on the home shot are covered. */
export const BIFROST_DEV_STEPS = [
  { src: "/help/bifrost/05-settings.webp", alt: "Bifrost Settings. The gear icon is selected at the bottom right. Under Preferences, Advanced is in the list.", lines: ["Tap the gear (Settings) at the bottom right and scroll to Preferences."] },
  { src: "/help/bifrost/06-advanced.webp", alt: "Bifrost Advanced screen. Developer Mode is switched on. Under Active Networks, Flare Network says Coston 2.", lines: ["Tap Advanced and switch on Developer Mode.", "Check that Flare Network says Coston 2."] },
  { src: "/help/bifrost/07-dev-home.webp", alt: "Bifrost home screen after Developer Mode is on. Test coins such as Coston 2 are listed. The balance amounts are covered.", lines: ["Go back to the wallet and you'll see test coins such as C2FLR. Turn Developer Mode off later to see real assets again."] },
];

/** The five steps as plain data (tested); `address` is the connected wallet, if any. */
export function faucetSteps(address = null) {
  const g = WALLET_GUIDE;
  return [
    { id: "wallet", title: "Have a wallet", text: `We recommend ${g.recommended.name}, a Flare-friendly app for iPhone and Android. ${g.alsoWorks} also works.`, link: g.recommended },
    { id: "faucet", title: "Open the faucet and choose C2FLR", text: `Open the ${g.faucet.name} in a new tab.`, warn: "In the network drop-down, choose C2FLR (not CFLR).", after: "CFLR is the older Coston network and its coins don't work with B.E.I.N.G.S.", link: { name: g.faucet.host, url: g.faucet.url } },
    { id: "paste", title: "Paste your wallet address", text: address ? `Copy your connected wallet's address below, paste it on the faucet and press ${g.faucet.button}.` : `Paste your wallet address on the faucet and press ${g.faucet.button}. Your wallet app shows your address (a long code that starts with 0x) and lets you copy it.`, address },
    { id: "receive", title: "Receive your coins", text: `The faucet gives ${g.faucet.perRequest} ${g.faucet.per}. A classroom election needs ${g.typicalNeed} (an example from our test elections; fees vary), so one request is plenty.` },
    { id: "back", title: "Come back and connect", text: address ? "You're already connected. Your new C2FLR shows in your wallet after a few seconds." : "Come back to this page and press Connect wallet at the top right." },
  ];
}

const KEYS_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside the dialog (a native modal dialog already makes the page behind it inert). */
export function trapTab(e, container) {
  if (e.key !== "Tab") return;
  const f = [...container.querySelectorAll(KEYS_FOCUSABLE)].filter((x) => !x.closest?.("[hidden]"));
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  const active = container.ownerDocument?.activeElement ?? globalThis.document?.activeElement;
  if (e.shiftKey && active === first) (e.preventDefault(), last.focus());
  else if (!e.shiftKey && active === last) (e.preventDefault(), first.focus());
}

function enlargeShot(step) {
  const close = () => dlg.close();
  const dlg = h(
    "dialog",
    { class: "bifrost-lightbox", "aria-label": step.alt },
    h(
      "div",
      { class: "dialog-card bifrost-lightbox-card" },
      h("button", { class: "icon-btn lg", type: "button", "aria-label": "Close", onClick: close }, icon("x")),
      h("img", { class: "bifrost-lightbox-img", src: step.src, alt: step.alt }),
    ),
  );
  dlg.addEventListener("click", (e) => e.target === dlg && close());
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector("button")?.focus();
}

function shotGrid(steps, className) {
  let n = 0;
  return h(
    "ol",
    { class: className },
    steps.map((step) => {
      const lines = (step.lines ?? [step.text]).map((line) => `${++n}. ${line}`);
      return h(
        "li",
        null,
        h(
          "button",
          { class: "bifrost-shot", type: "button", onClick: () => enlargeShot(step) },
          h("img", { src: step.src, alt: step.alt, width: "360", height: "780" }),
          ...lines.map((line) => h("span", null, line)),
        ),
      );
    }),
  );
}

function bifrostWalkthrough() {
  return h(
    "details",
    { class: "bifrost-help" },
    h("summary", null, "Show me how in Bifrost"),
    shotGrid(BIFROST_ADDRESS_STEPS, "bifrost-grid"),
    h("p", { class: "small bifrost-metamask" }, BIFROST_METAMASK_NOTE),
  );
}

/** The official faucet with Coston2 already selected (checked 14 Nov 2026: the page offers Request C2FLR). */
export const FAUCET_COSTON2_URL = "https://faucet.flare.network/coston2";

function brandIcon(file, alt) {
  return h("img", {
    class: "bifrost-get-icon",
    src: `/brand/${file}-64.webp`,
    srcset: `/brand/${file}-32.webp 32w, /brand/${file}-64.webp 64w`,
    sizes: "28px",
    width: "32",
    height: "32",
    alt,
  });
}

function bifrostGetButton() {
  const g = WALLET_GUIDE.recommended;
  return h(
    "a",
    { class: "bifrost-get", href: g.url, target: "_blank", rel: "noopener noreferrer" },
    brandIcon("bifrost/bifrost", "Bifrost Wallet"),
    "Click Here to get your Bifrost Wallet",
    h("span", { class: "sr-only" }, " (opens in a new tab)"),
  );
}

function c2flrLoadButton() {
  return h(
    "a",
    { class: "bifrost-get", href: FAUCET_COSTON2_URL, target: "_blank", rel: "noopener noreferrer" },
    brandIcon("flare/flare", "Flare network"),
    brandIcon("c2flr/c2flr", "C2FLR"),
    "Click here to load your wallet with C2FLR now",
    h("span", { class: "sr-only" }, " (opens in a new tab)"),
  );
}

function bifrostDevMode() {
  return h(
    "details",
    { class: "bifrost-help bifrost-dev", id: "bifrost-dev-mode" },
    h("summary", null, BIFROST_DEV_TITLE),
    h("p", { class: "small bifrost-safety" }, BIFROST_DEV_NOTE),
    shotGrid(BIFROST_DEV_STEPS, "bifrost-grid bifrost-grid-3"),
  );
}

function showDevMode() {
  const box = document.getElementById("bifrost-dev-mode");
  const note = document.getElementById("dev-mode-callout");
  if (box instanceof HTMLDetailsElement) box.open = true;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  (note || box)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
}

function addressBox(address) {
  if (address)
    return h("div", { class: "faucet-addr" }, h("code", { class: "code", title: address }, address), h("button", { class: "btn btn-sm", type: "button", onClick: () => copyText(address, "Wallet address copied") }, icon("copy", { size: 16 }), "Copy"));
  const msg = h("p", { class: "small muted", "aria-live": "polite", id: "faucet-addr-msg" }, "Optional: paste it here first to check it looks right.");
  const input = h("input", { id: "faucet-addr", type: "text", inputmode: "text", autocomplete: "off", spellcheck: "false", placeholder: "0x…", "aria-describedby": "faucet-addr-msg" });
  const copy = h("button", { class: "btn btn-sm", type: "button", disabled: true, onClick: () => copyText(input.value.trim(), "Wallet address copied") }, icon("copy", { size: 16 }), "Copy");
  input.addEventListener("input", () => {
    const v = input.value.trim();
    const ok = isAddress(v);
    copy.disabled = !ok;
    msg.textContent = !v ? "Optional: paste it here first to check it looks right." : ok ? `Looks like a wallet address (${shortAddress(v)}).` : "That doesn't look like a wallet address yet: it should start with 0x and have 42 characters.";
  });
  return h("div", { class: "faucet-addr" }, h("label", { for: "faucet-addr", class: "small" }, "Your wallet address"), h("div", { class: "faucet-addr-row" }, input, copy), msg);
}

/** The modal's content (no dialog element), so it can be tested and reused. */
export function faucetContent({ address = null, onConnect } = {}) {
  const steps = faucetSteps(address);
  return h(
    "div",
    { class: "faucet-content" },
    h("p", { class: "faucet-net" }, h("span", { class: "faucet-chip" }, icon("droplet", { size: 14 }), WALLET_GUIDE.networkLabel)),
    h(
      "ol",
      { class: "faucet-steps" },
      steps.map((s) =>
        h(
          "li",
          { class: `faucet-step faucet-step-${s.id}` },
          h("strong", null, s.title),
          s.id === "faucet" ? h("p", { id: "dev-mode-callout", class: "faucet-dev-callout", role: "note" }, BIFROST_DEV_CALLOUT) : null,
          s.id === "faucet" ? bifrostDevMode() : null,
          h("p", null, s.text),
          s.warn ? h("p", { class: "faucet-choose" }, icon("alert", { size: 16 }), h("strong", null, s.warn)) : null,
          s.after ? h("p", { class: "small" }, s.after) : null,
          s.link
            ? h(
                "div",
                { class: s.id === "wallet" || s.id === "faucet" ? "faucet-wallet-links" : null },
                h("p", null, extLink(s.link.url, s.id === "faucet" ? `Open ${s.link.name}` : s.link.name)),
                s.id === "wallet" ? bifrostGetButton() : s.id === "faucet" ? c2flrLoadButton() : null,
              )
            : null,
          s.id === "paste" ? addressBox(address) : null,
          s.id === "paste" ? bifrostWalkthrough() : null,
          s.id === "paste" ? h("p", { class: "small" }, h("button", { type: "button", class: "faucet-backlink", onClick: showDevMode }, "Developer Mode steps are in step 2.")) : null,
          s.id === "back" && !address && onConnect ? h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: onConnect }, icon("wallet", { size: 16 }), "Connect wallet") : null,
        ),
      ),
    ),
    h("p", { class: "faucet-note small" }, icon("info", { size: 16 }), WALLET_GUIDE.noValue),
    h("p", { class: "muted small" }, "The faucet is run by Flare, not by B.E.I.N.G.S. We only link to it."),
  );
}

/** Open the modal. Esc closes it (native dialog), Tab stays inside it, focus returns to the button that opened it. */
export function openFaucet({ address = null, opener = null, onConnect } = {}) {
  const close = () => dlg.close();
  const dlg = h(
    "dialog",
    { class: "faucet-dialog", "aria-labelledby": "faucet-title" },
    h(
      "div",
      { class: "dialog-card" },
      h("div", { class: "dialog-head" }, h("h2", { id: "faucet-title" }, FAUCET_TITLE), h("button", { class: "icon-btn lg", type: "button", "aria-label": "Close", onClick: close }, icon("x"))),
      faucetContent({ address, onConnect: onConnect && (() => (close(), onConnect())) }),
    ),
  );
  dlg.addEventListener("keydown", (e) => trapTab(e, dlg));
  dlg.addEventListener("click", (e) => e.target === dlg && close());
  dlg.addEventListener("close", () => {
    dlg.remove();
    opener?.focus?.();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector(".dialog-head button")?.focus();
  return dlg;
}

/**
 * The coral "Get free test coins" button. getAddress: () => address or null (default: read the shared wallet state
 * lazily, only when clicked). compact: icon + short label for the header.
 */
export function faucetButton({ compact = false, getAddress, onConnect } = {}) {
  const btn = h(
    "button",
    { class: `faucet-btn${compact ? " compact" : ""}`, type: "button", "aria-haspopup": "dialog", "aria-label": FAUCET_BUTTON_LABEL, title: `${FAUCET_TITLE} (${WALLET_GUIDE.networkLabel})` },
    h("span", { class: "faucet-btn-main" }, "Load your Wallet with C2FLR", c2flrIcon(), "Here."),
  );
  btn.addEventListener("click", async () => {
    let address = null;
    try {
      address = getAddress ? await getAddress() : (await import("./roles.js")).state.address;
    } catch {
      /* no wallet state: show the paste field */
    }
    const connect = onConnect ?? (() => document.getElementById("wallet-btn")?.click());
    openFaucet({ address, opener: btn, onConnect: connect });
  });
  return btn;
}
