// Unit tests for the pure phone-wallet (WalletConnect) rules in public/js/logic.js, plus a check that the vendored bundle
// draws a real QR code and that the page's security policy lets WalletConnect talk to its relay (and nothing broader).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WALLET_CONNECT_LEAD } from "../public/js/walletui.js";
import * as L from "../public/js/logic.js";
import { CONFIG } from "../public/js/config.js";

const ID = "0123456789abcdef0123456789ABCDEF";
const URI = "wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303";
const site = (p: string) => resolve(fileURLToPath(new URL("..", import.meta.url)), p);

describe("project ID", () => {
  it("accepts 32 hex characters, with stray spaces", () => {
    expect(L.isWalletConnectProjectId(ID)).toBe(true);
    expect(L.isWalletConnectProjectId(`  ${ID}\n`)).toBe(true);
  });
  it("rejects empty, short, long, non-hex and non-string values", () => {
    for (const v of ["", "   ", "abc", ID + "0", "g".repeat(32), null, undefined, 42, {}]) expect(L.isWalletConnectProjectId(v)).toBe(false);
  });
  it("ships the public WalletConnect project id, and treats an empty one as off", () => {
    expect(CONFIG.walletConnectProjectId).toBe("8a7a9fdb10da4f8b27e2dac859b49529");
    expect(L.isWalletConnectProjectId(CONFIG.walletConnectProjectId)).toBe(true);
    expect(L.walletConnectConfigured(CONFIG)).toBe(true);
    expect(L.walletConnectConfigured({ walletConnectProjectId: "" })).toBe(false);
    expect(L.walletConnectConfigured({ walletConnectProjectId: ID })).toBe(true);
    expect(L.walletConnectConfigured(undefined)).toBe(false);
  });
});

describe("wallet choices", () => {
  it("offers both when there is a browser wallet and a project ID", () => {
    const c = L.walletChoices({ hasInjected: true, projectId: ID });
    expect(c.browser).toEqual({ available: true, reason: "" });
    expect(c.phone).toEqual({ available: true, reason: "" });
  });
  it("hides the phone option with a plain note when there is no project ID", () => {
    const c = L.walletChoices({ hasInjected: true, projectId: "" });
    expect(c.phone.available).toBe(false);
    expect(c.phone.reason).toMatch(/isn't switched on/);
    expect(c.browser.available).toBe(true);
  });
  it("explains a missing browser wallet but still offers the phone", () => {
    const c = L.walletChoices({ hasInjected: false, projectId: ID });
    expect(c.browser.available).toBe(false);
    expect(c.browser.reason).toMatch(/No browser wallet/);
    expect(c.phone.available).toBe(true);
  });
});

describe("mobile detection", () => {
  it("recognises phones and tablets", () => {
    expect(L.isMobileDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Mobile/15E148", 5, "iPhone")).toBe(true);
    expect(L.isMobileDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36", 5, "Linux armv8l")).toBe(true);
  });
  it("recognises an iPad that reports itself as a Mac", () => {
    expect(L.isMobileDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5, "MacIntel")).toBe(true);
  });
  it("treats desktops as desktops", () => {
    expect(L.isMobileDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 0, "MacIntel")).toBe(false);
    expect(L.isMobileDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", 10, "Win32")).toBe(false);
    expect(L.isMobileDevice(undefined)).toBe(false);
  });
});

describe("deep links", () => {
  it("puts Bifrost first, with the documented bifrostwallet://wc?uri= link, then the raw wc: link and the other wallets", () => {
    const links = L.walletDeepLinks(URI);
    expect(links.map((l: { id: string }) => l.id)).toEqual(["bifrost", "any", "metamask", "trust", "rainbow"]);
    expect(links[0]).toMatchObject({ id: "bifrost", name: "Bifrost Wallet" });
    expect(links[0].href.startsWith("bifrostwallet://wc?uri=")).toBe(true);
    expect(decodeURIComponent(links[0].href.slice("bifrostwallet://wc?uri=".length))).toBe(URI);
    expect(links[1]).toMatchObject({ id: "any", href: URI });
    for (const l of links.slice(2)) {
      const u = new URL(l.href);
      expect(u.protocol).toBe("https:");
      expect(u.searchParams.get("uri")).toBe(URI);
    }
  });
  it("refuses anything that is not a wc: link (no javascript:, no https:, no spaces)", () => {
    for (const bad of ["", "javascript:alert(1)", "https://evil.example/wc:x", "wc:abc def", "wc:", undefined, 5]) expect(L.walletDeepLinks(bad)).toEqual([]);
  });
});

describe("QR path", () => {
  it("draws one rectangle per run of dark modules with a 4-module quiet border", () => {
    const m = [
      [true, true, false],
      [false, true, false],
      [true, false, true],
    ];
    const { size, d } = L.qrSvgPath(m);
    expect(size).toBe(11);
    expect(d).toBe("M4 4h2v1h-2zM5 5h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1z");
  });
  it("rejects a matrix that is not square", () => {
    expect(() => L.qrSvgPath([[true, false], [true]])).toThrow(/square/);
    expect(() => L.qrSvgPath([])).toThrow(/square/);
  });
  it("turns the vendored library's matrix for a real pairing link into a path (finder patterns in 3 corners)", async () => {
    const lib = await import("../public/vendor/walletconnect.js");
    const m: boolean[][] = lib.qrMatrix(URI);
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect(n % 4).toBe(1);
    expect(m.every((r) => r.length === n)).toBe(true);
    const corner = (r: number, c: number) => [0, 1, 2, 3, 4, 5, 6].every((i) => m[r]?.[c + i] && m[r + 6]?.[c + i] && m[r + i]?.[c] && m[r + i]?.[c + 6]);
    expect(corner(0, 0) && corner(0, n - 7) && corner(n - 7, 0)).toBe(true);
    expect(m[n - 7]?.[n - 7]).toBeDefined();
    const { size, d } = L.qrSvgPath(m);
    expect(size).toBe(n + 8);
    expect(d.length).toBeGreaterThan(200);
  });
});

describe("provider options", () => {
  const opts = L.walletConnectOptions({ ...CONFIG, walletConnectProjectId: ` ${ID} ` }, "https://beingsvote.live");
  it("uses our own QR dialog, Coston2 and its public RPC", () => {
    expect(opts.projectId).toBe(ID);
    expect(opts.showQrModal).toBe(false);
    expect(opts.optionalChains).toEqual([114]);
    expect(opts.rpcMap).toEqual({ 114: CONFIG.rpcUrl });
  });
  it("describes the site to the wallet", () => {
    expect(opts.metadata.name).toBe("B.E.I.N.G.S.");
    expect(opts.metadata.url).toBe("https://beingsvote.live");
    expect(opts.metadata.icons).toEqual(["https://beingsvote.live/favicon.svg"]);
  });
});

describe("remembered connection", () => {
  it("reads the old '1' marker and the new names, and ignores junk", () => {
    expect(L.savedWalletKind("1")).toBe("browser");
    expect(L.savedWalletKind("browser")).toBe("browser");
    expect(L.savedWalletKind("walletconnect")).toBe("walletconnect");
    for (const v of [null, "", "0", "metamask", undefined]) expect(L.savedWalletKind(v)).toBeNull();
  });
});

describe("a phone wallet declining", () => {
  it("counts as the person saying no, like a browser wallet's 4001", () => {
    expect(L.isUserRejected({ code: 5000, message: "x" })).toBe(true);
    expect(L.isUserRejected({ info: { error: { code: 5000 } } })).toBe(true);
    expect(L.isUserRejected(new Error("User rejected."))).toBe(true);
    expect(L.isUserRejected({ code: 5001 })).toBe(false);
  });
});

describe("error wording", () => {
  const say = (m: unknown) => L.explainWalletConnectError(typeof m === "string" ? new Error(m) : m);
  it("shows the real reason and a firewall note, and keeps a decline calm", () => {
    expect(say({ code: 4001, message: "x" })).toMatch(/declined/);
    expect(say({ code: 4001, message: "x" })).not.toMatch(/relay\.walletconnect/);
    expect(say("User rejected methods.")).toMatch(/declined/);
    expect(say("Project not found for this origin")).toMatch(/Project not found for this origin/);
    expect(say("WebSocket connection failed")).toMatch(/WebSocket connection failed/);
    expect(say("WebSocket connection failed")).toMatch(/relay\.walletconnect\.org/);
    expect(say("WebSocket connection failed")).toMatch(/relay\.walletconnect\.com/);
    expect(say(undefined)).toMatch(/wallet connection failed/);
  });
  it("keeps the real error text instead of replacing it", () => {
    expect(say("0xdeadbeef internal stack")).toMatch(/deadbeef/);
    expect(say("0xdeadbeef internal stack")).toMatch(/firewall/i);
  });
});

describe("connect lead", () => {
  it("still says what the wallet is for", () => {
    expect(WALLET_CONNECT_LEAD).toMatch(/register an election/);
    expect(WALLET_CONNECT_LEAD).toMatch(/gas fees/);
  });
});

describe("security policy", () => {
  const toml = readFileSync(site("netlify.toml"), "utf8");
  const csp = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
  const dir = (name: string) => (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " ")) ?? "").split(/\s+/).slice(1);
  it("lets the page reach the WalletConnect relay, its project RPC, and the verify service", () => {
    const c = dir("connect-src");
    for (const o of ["wss://relay.walletconnect.com", "wss://relay.walletconnect.org", "https://relay.walletconnect.com", "https://relay.walletconnect.org", "https://rpc.walletconnect.com", "https://rpc.walletconnect.org", "https://echo.walletconnect.com", "https://echo.walletconnect.org", "https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://api.web3modal.org", "https://api.web3modal.com", "https://explorer-api.walletconnect.com", "https://pulse.walletconnect.com", "https://pulse.walletconnect.org"]) expect(c).toContain(o);
  });
  it("allows the WalletConnect verify pages and the Turnstile frame", () => {
    expect(dir("frame-src")).toEqual(["blob:", "https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://secure.walletconnect.com", "https://secure.walletconnect.org", "https://challenges.cloudflare.com"]);
  });
  it("keeps scripts on this site, the pinned ethers CDN, and the Turnstile host", () => {
    expect(dir("script-src")).toEqual(["'self'", "https://cdn.jsdelivr.net", "https://challenges.cloudflare.com"]);
    expect(CONFIG.walletConnectLib).toBe("vendor/walletconnect.js");
    expect(CONFIG.appKitLib).toBe("vendor/appkit.js");
    expect(CONFIG.walletConnectLib).not.toMatch(/^[a-z]+:|^\/\//i);
    expect(CONFIG.appKitLib).not.toMatch(/^[a-z]+:|^\/\//i);
  });
  it("stays strict: no wildcards, no unsafe-*, default-src none", () => {
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).not.toMatch(/\*|unsafe-/);
    for (const o of dir("connect-src").filter((x) => x.startsWith("ws"))) expect(o).toMatch(/^wss:\/\/relay\.walletconnect\.(com|org)$/);
  });
});
