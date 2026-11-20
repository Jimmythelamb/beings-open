// "Get free test coins" button and modal (faucet.js). Fake DOM, no network, no wallet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const ADDR = "0x7E5700000000000000000000000000000000BEEF";
let active: any = null;
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  hidden = false;
  disabled = false;
  open = false;
  value = "";
  parent: any = null;
  style: any = {};
  dataset: any = {};
  textContent = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this.attrs.class = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "disabled") this.disabled = true;
    if (k === "hidden") this.hidden = true;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    for (const x of c) {
      if (x instanceof FakeEl) x.parent = this;
      this.children.push(x);
    }
  }
  appendChild(c: any) {
    this.append(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this);
  }
  addEventListener(t: string, fn: (e: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  fire(t: string, e: any = {}) {
    for (const fn of this.listeners[t] ?? []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...e });
  }
  focus() {
    active = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire("close");
  }
  closest() {
    return null;
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (c instanceof FakeEl ? c.text : String(c))).join("");
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = pred(this) ? [this] : [];
    for (const c of this.children) if (c instanceof FakeEl) out.push(...c.find(pred));
    return out;
  }
  querySelectorAll(): FakeEl[] {
    return this.find((e: any) => (e.tagName === "A" && !!e.attrs.href) || (e.tagName === "BUTTON" && !e.disabled) || (e.tagName === "INPUT" && !e.disabled));
  }
  querySelector(sel: string): any {
    if (sel === ".dialog-head button") return this.find((e: any) => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Close")[0] ?? null;
    return null;
  }
}
const body = new FakeEl("body");
let F: any;
let copied: string[] = [];
beforeAll(async () => {
  (globalThis as any).Node = FakeEl;
  (globalThis as any).document = {
    body,
    get activeElement() {
      return active;
    },
    getElementById: () => null,
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_: string, t: string) => new FakeEl(t),
    createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }),
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true, writable: true });
  F = await import("../public/js/faucet.js");
});
afterAll(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).Node;
});
const links = (el: FakeEl) => el.find((e: any) => e.tagName === "A");

describe("the steps", () => {
  it("five steps in order: wallet (Bifrost first), faucet + C2FLR not CFLR, paste + Request C2FLR, amounts + 1-2 C2FLR, connect", () => {
    const s = F.faucetSteps(null);
    expect(s.map((x: any) => x.id)).toEqual(["wallet", "faucet", "paste", "receive", "back"]);
    expect(s[0].text).toMatch(/^We recommend Bifrost Wallet.*MetaMask also works\.$/);
    expect(s[0].link.url).toBe("https://bifrostwallet.com");
    expect(s[1].warn).toBe("In the network drop-down, choose C2FLR (not CFLR).");
    expect(s[1].after).toMatch(/older Coston network/);
    expect(s[1].link.url).toBe("https://faucet.flare.network");
    expect(s[2].text).toContain("press Request C2FLR");
    expect(s[3].text).toBe("The faucet gives 100 C2FLR, 10 USDT0 and 10 FXRP per address every 24 hours. A classroom election needs about 1 to 2 C2FLR (an example from our test elections; fees vary), so one request is plenty.");
    expect(s[4].text).toBe("Come back to this page and press Connect wallet at the top right.");
    const c = F.faucetSteps(ADDR);
    expect(c[2].address).toBe(ADDR);
    expect(c[4].text).toMatch(/already connected/);
  });
});

describe("the modal content", () => {
  it("links open in a new tab with rel noopener; the no-value note and the 'not run by us' line are there; no logo", () => {
    const el = F.faucetContent({ address: null, onConnect: () => {} });
    const ls = links(el);
    expect(ls.map((a) => a.getAttribute("href"))).toEqual(["https://bifrostwallet.com", "https://bifrostwallet.com", "https://faucet.flare.network", "https://faucet.flare.network/coston2"]);
    expect(el.text).toContain("Click here to load your wallet with C2FLR now");
    expect(el.text).toContain("In the network drop-down, choose C2FLR (not CFLR).");
    const loadBtn = el.find((e: any) => e.tagName === "A" && e.text.includes("Click here to load your wallet with C2FLR now"))[0];
    expect(loadBtn.getAttribute("class")).toContain("bifrost-get");
    expect(loadBtn.getAttribute("rel")).toContain("noopener");
    const loadIcons = loadBtn.find((e: any) => e.tagName === "IMG");
    expect(loadIcons.map((img: any) => img.getAttribute("alt"))).toEqual(["Flare network", "C2FLR"]);
    expect(el.text).toContain("Click Here to get your Bifrost Wallet");
    const getBtn = el.find((e: any) => e.tagName === "A" && e.text.includes("Click Here to get your Bifrost Wallet"))[0];
    expect(getBtn.getAttribute("class")).toContain("bifrost-get");
    expect(getBtn.getAttribute("href")).toBe("https://bifrostwallet.com");
    for (const a of ls) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    const t = el.text;
    expect(t).toContain("Flare Coston2 test network");
    expect(t).toContain("In the network drop-down, choose C2FLR (not CFLR).");
    expect(t).toContain("These are free test coins with no real-world value.");
    expect(t).toContain("The faucet is run by Flare, not by B.E.I.N.G.S. We only link to it.");
    const shots = el.find((e: any) => e.tagName === "IMG" && e.getAttribute("src")?.startsWith("/help/bifrost/"));
    expect(shots).toHaveLength(7);
    const bifrostIcon = el.find((e: any) => e.getAttribute("src") === "/brand/bifrost/bifrost-64.webp")[0];
    expect(bifrostIcon.getAttribute("alt")).toBe("Bifrost Wallet");
    const iconFile = readFileSync(fileURLToPath(new URL("../public/brand/bifrost/bifrost-64.webp", import.meta.url)));
    expect(iconFile.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(shots.map((img: any) => img.getAttribute("src"))).toEqual([
      "/help/bifrost/05-settings.webp",
      "/help/bifrost/06-advanced.webp",
      "/help/bifrost/07-dev-home.webp",
      "/help/bifrost/01-home.webp",
      "/help/bifrost/02-menu.webp",
      "/help/bifrost/03-search.webp",
      "/help/bifrost/04-address.webp",
    ]);
    for (const img of shots) expect(img.getAttribute("alt")?.length).toBeGreaterThan(20);
    expect(t).toContain("Show me how in Bifrost");
    expect(t).toContain("Open Bifrost and tap the round button at the bottom.");
    expect(t).toContain("Tap Receive.");
    expect(t).toContain("Search “coston” and choose Coston 2 Flare (C2FLR), not Coston Flare (CFLR).");
    expect(t).toContain("Tap the address to copy it, then paste it on the faucet.");
    expect(t).toContain("MetaMask users copy the address from the top of the account screen.");
    expect(t).toContain("Please change your Bifrost Wallet to Developer mode.");
    expect(t.indexOf("Please change your Bifrost Wallet to Developer mode.")).toBeLessThan(t.indexOf("Open the official Flare Faucet"));
    expect(t.indexOf("Change Bifrost Wallet to Developer Mode")).toBeLessThan(t.indexOf("Show me how in Bifrost"));
    expect(t).toContain("Developer Mode steps are in step 2.");
    const faucetStep = el.find((e: any) => (e.getAttribute("class") ?? "").includes("faucet-step-faucet"))[0];
    expect(faucetStep.find((e: any) => e.tagName === "DETAILS")).toHaveLength(1);
    const pasteStep = el.find((e: any) => (e.getAttribute("class") ?? "").includes("faucet-step-paste"))[0];
    expect(pasteStep.text).not.toContain("Tap the gear (Settings)");
    const callout = el.find((e: any) => e.getAttribute("id") === "dev-mode-callout")[0];
    expect(callout.getAttribute("class")).toContain("faucet-dev-callout");
    for (const d of el.find((e: any) => e.tagName === "DETAILS")) expect(d.text).not.toContain("Please change your Bifrost Wallet to Developer mode.");
    expect(t).toContain("Turning on Developer Mode means Bifrost uses test networks only (Flare shows Coston 2), so nobody risks real coins while testing B.E.I.N.G.S. Do this before you request test coins or connect.");
    expect(t).toContain("1. Tap the gear (Settings) at the bottom right and scroll to Preferences.");
    expect(t).toContain("2. Tap Advanced and switch on Developer Mode.");
    expect(t).toContain("3. Check that Flare Network says Coston 2.");
    expect(t).toContain("4. Go back to the wallet and you'll see test coins such as C2FLR. Turn Developer Mode off later to see real assets again.");
    const details = el.find((e: any) => e.tagName === "DETAILS");
    expect(details).toHaveLength(2);
    for (const d of details) expect(d.getAttribute("open")).toBeNull();
  });
  it("connected: shows the full address with a Copy button", async () => {
    copied = [];
    const el = F.faucetContent({ address: ADDR });
    expect(el.text).toContain(ADDR);
    const copy = el.find((e: any) => e.tagName === "BUTTON" && e.text.includes("Copy"))[0]!;
    copy.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toEqual([ADDR]);
    expect(el.find((e: any) => e.tagName === "INPUT")).toHaveLength(0);
    const shot = el.find((e: any) => e.tagName === "BUTTON" && e.text.includes("Open Bifrost and tap the round button"))[0]!;
    shot.fire("click");
    const light = body.children.find((c: any) => c.tagName === "DIALOG" && c.getAttribute("class") === "bifrost-lightbox");
    expect(light?.open).toBe(true);
    expect(light.find((e: any) => e.tagName === "IMG")[0]?.getAttribute("alt")).toMatch(/round blue button/);
    light.close();
    expect(body.children.includes(light)).toBe(false);
  });
  it("not connected: a paste field that checks the address, then lets you copy it; plus a Connect wallet button", () => {
    let connected = false;
    const el = F.faucetContent({ address: null, onConnect: () => (connected = true) });
    const input = el.find((e: any) => e.tagName === "INPUT")[0]!;
    const copy = el.find((e: any) => e.tagName === "BUTTON" && e.text.includes("Copy"))[0]!;
    const msg = el.find((e: any) => e.getAttribute("id") === "faucet-addr-msg")[0]!;
    expect(msg.getAttribute("aria-live")).toBe("polite");
    expect(copy.disabled).toBe(true);
    input.value = "0x12";
    input.fire("input");
    expect(copy.disabled).toBe(true);
    expect(msg.textContent).toMatch(/doesn't look like a wallet address yet/);
    input.value = ` ${ADDR} `;
    input.fire("input");
    expect(copy.disabled).toBe(false);
    expect(msg.textContent).toBe("Looks like a wallet address (0x7E57…BEEF).");
    el.find((e: any) => e.tagName === "BUTTON" && e.text.includes("Connect wallet"))[0]!.fire("click");
    expect(connected).toBe(true);
  });
});

describe("the dialog", () => {
  it("button opens a modal dialog; Tab is trapped; closing removes it and returns focus to the button", async () => {
    const btn = F.faucetButton({ getAddress: () => null });
    expect(btn.getAttribute("aria-label")).toBe("Load your Wallet with C2FLR Here.");
    expect(btn.text).toContain("Load your Wallet with C2FLR");
    expect(btn.text).toContain("Here.");
    const mark = btn.find((e: any) => e.tagName === "IMG")[0];
    expect(mark.getAttribute("alt")).toBe("C2FLR");
    expect(mark.getAttribute("src")).toBe("/brand/c2flr/c2flr-64.webp");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    btn.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    const dlg = body.children.find((c: any) => c.tagName === "DIALOG");
    expect(dlg.open).toBe(true);
    expect(dlg.getAttribute("aria-labelledby")).toBe("faucet-title");
    expect(dlg.text).toContain("Get free test coins");
    expect(active?.getAttribute("aria-label")).toBe("Close");
    const focusables = dlg.querySelectorAll();
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    dlg.fire("keydown", { key: "Tab", shiftKey: false });
    expect(active).toBe(first);
    first.focus();
    dlg.fire("keydown", { key: "Tab", shiftKey: true });
    expect(active).toBe(last);
    dlg.close(); // Esc on a native modal dialog fires the same close event
    expect(body.children.includes(dlg)).toBe(false);
    expect(active).toBe(btn);
  });
  it("compact header button has an accessible name with the network label", () => {
    const b = F.faucetButton({ compact: true, getAddress: () => null });
    expect(b.getAttribute("aria-label")).toBe("Load your Wallet with C2FLR Here.");
    expect(b.text).toContain("Load your Wallet with C2FLR");
    expect(b.find((e: any) => e.tagName === "IMG")[0].getAttribute("alt")).toBe("C2FLR");
  });
});

describe("placement and style", () => {
  it("in the shared header, in the wallet box (Create and admin), coral in light and dark", () => {
    expect(src("../public/index.html")).toMatch(/<div class="header-tools">\s*<span id="faucet-slot"><\/span>/);
    expect(src("../public/js/app.js")).toMatch(/getElementById\("faucet-slot"\)\?\.replaceChildren\(faucetButton\(\{ compact: true, getAddress: \(\) => walletState\.address \}\)\)/);
    expect(src("../public/js/wallet-info.js")).toMatch(/h\("p", \{ class: "faucet-row" \}, faucetButton\(\)\)/);
    const css = src("../public/css/app.css");
    expect(css).toMatch(/:root \{ --coral: #b8264f;/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{ --coral: #ff8fab;/);
    expect(css).toMatch(/\.faucet-btn \{[^}]*var\(--coral\)/);
    expect(src("../public/js/admin.js")).toMatch(/walletInfoBox\(\{ variant: "full" \}\)/);
    expect(src("../public/js/admin.js")).toMatch(/walletInfoBox\(\{ variant: "admin"/);
    const icon32 = readFileSync(fileURLToPath(new URL("../public/brand/c2flr/c2flr-32.webp", import.meta.url)));
    const icon64 = readFileSync(fileURLToPath(new URL("../public/brand/c2flr/c2flr-64.webp", import.meta.url)));
    expect(icon32.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(icon64.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(icon64.length).toBeLessThan(8_000);
  });
});
