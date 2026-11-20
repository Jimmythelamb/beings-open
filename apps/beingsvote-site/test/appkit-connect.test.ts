// Connect-module rules: Coston2 lock, featured wallets, error text, and the ethers provider wrapper.
// No network, no modal, no private key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../public/js/config.js";
import {
  APPKIT_CONNECT_HOSTS,
  APPKIT_FRAME_HOSTS,
  APPKIT_IMG_HOSTS,
  BIFROST_WALLET_ID,
  DESKTOP_CONNECT_VIEW,
  FEATURED_WALLET_IDS,
  METAMASK_WALLET_ID,
  addressAvatar,
  appKitCreateOptions,
  bifrostHref,
  bifrostWalletItem,
  connectAction,
  eip1193Signer,
  explainConnectError,
  formatC2flr,
} from "../public/js/appkit-connect.js";

const site = (p: string) => resolve(fileURLToPath(new URL("..", import.meta.url)), p);
const src = (p: string) => readFileSync(site(p), "utf8");
const URI = "wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303";

describe("chain lock", () => {
  const opts = appKitCreateOptions(CONFIG, "https://beingsvote.live");
  it("offers only Flare Coston2, with its RPC, explorer and C2FLR", () => {
    const chain = opts.networks[0];
    expect(opts.networks).toHaveLength(1);
    expect(chain).toBeTruthy();
    expect(opts.defaultNetwork).toBe(chain);
    expect(chain).toMatchObject({
      id: 114,
      caipNetworkId: "eip155:114",
      chainNamespace: "eip155",
      nativeCurrency: { symbol: "C2FLR", decimals: 18 },
    });
    expect(chain?.rpcUrls.default.http).toEqual([CONFIG.rpcUrl]);
    expect(chain?.blockExplorers.default.url).toBe(CONFIG.explorer);
    expect(opts.customRpcUrls["eip155:114"]?.[0]?.url).toBe(CONFIG.rpcUrl);
  });
  it("asks the wallet to switch when it is on another network", () => {
    expect(opts.allowUnsupportedChain).toBe(false);
    expect(opts.enableNetworkSwitch).toBe(true);
    expect(opts.defaultAccountTypes).toEqual({ eip155: "eoa" });
  });
});

describe("featured wallets", () => {
  it("features Bifrost then MetaMask and leaves All wallets searchable", () => {
    const opts = appKitCreateOptions(CONFIG, "https://beingsvote.live");
    expect(BIFROST_WALLET_ID).toBe("37a686ab6223cd42e2886ed6e5477fce100a4fb565dcd57ed4f81f7c12e93053");
    expect(METAMASK_WALLET_ID).toBe("c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96");
    expect(opts.featuredWalletIds).toEqual(FEATURED_WALLET_IDS);
    expect(opts.featuredWalletIds).toEqual([BIFROST_WALLET_ID, METAMASK_WALLET_ID]);
    expect(opts.allWallets).toBe("SHOW");
    expect(opts).not.toHaveProperty("includeWalletIds");
    expect(opts.projectId).toBe("8a7a9fdb10da4f8b27e2dac859b49529");
    expect(DESKTOP_CONNECT_VIEW).toBe("ConnectingWalletConnectBasic");
  });
  it("deep-links Bifrost with the documented bifrostwallet://wc?uri= form", () => {
    expect(bifrostWalletItem().walletInfo.deepLink).toBe("bifrostwallet://");
    expect(bifrostHref(URI)).toBe(`bifrostwallet://wc?uri=${encodeURIComponent(URI)}`);
    expect(bifrostHref("https://evil.example")).toBe("");
  });
});

describe("which connect action", () => {
  it("shows the QR on a computer, even when an extension is installed", () => {
    expect(connectAction({ mobile: false, hasInjected: true })).toBe("qr");
    expect(connectAction({ mobile: false, hasInjected: false })).toBe("qr");
  });
  it("opens Bifrost on a phone or iPad, and uses an injected wallet when one is there", () => {
    expect(connectAction({ mobile: true, hasInjected: false })).toBe("bifrost");
    expect(connectAction({ mobile: true, hasInjected: true })).toBe("injected");
  });
});

describe("errors and the signer", () => {
  it("surfaces the real failure and names the relay hosts", () => {
    const text = explainConnectError(new Error("WebSocket connection to relay.walletconnect.org failed: 403 origin"));
    expect(text).toMatch(/403 origin/);
    expect(text).toMatch(/relay\.walletconnect\.org/);
    expect(text).toMatch(/relay\.walletconnect\.com/);
    expect(explainConnectError({ code: 4001, message: "User rejected" })).toMatch(/declined/);
  });
  it("does not cut the attempt off with the old timeout", () => {
    expect(src("public/js/roles.js")).not.toMatch(/12000|WC_URI_WAIT|WC_INIT_WAIT/);
    expect(src("public/js/walletui.js")).not.toMatch(/12000/);
    expect(src("public/js/appkit-client.js")).not.toMatch(/setTimeout\(/);
  });
  it("wraps the EIP-1193 provider in an ethers BrowserProvider", async () => {
    const provider = { request: async () => "0x1" };
    const seen: unknown[] = [];
    const ethers = {
      BrowserProvider: class {
        constructor(p: unknown) {
          seen.push(p);
        }
        getSigner(address: string) {
          return { address, provider: seen[0] };
        }
      },
    };
    const signer = await eip1193Signer(provider, "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB", ethers);
    expect(seen[0]).toBe(provider);
    expect(signer).toMatchObject({ address: "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB" });
    expect(src("public/js/roles.js")).toContain("return eip1193Signer(eth, state.address, ethers)");
    expect(() => eip1193Signer({}, "0x1", ethers)).toThrow(/NO_WALLET/);
  });
});

describe("header amount and avatar", () => {
  it("formats C2FLR from wei", () => {
    expect(formatC2flr(0n)).toBe("0 C2FLR");
    expect(formatC2flr("0xde0b6b3a7640000")).toBe("1 C2FLR");
    expect(formatC2flr(1500000000000000000n)).toBe("1.5 C2FLR");
    expect(formatC2flr(1n)).toBe("<0.0001 C2FLR");
    expect(formatC2flr("nope")).toBe("");
  });
  it("draws a stable identicon from the address", () => {
    const a = addressAvatar("0xFdAC058d47dc99A70f076523c95a5c97b3805bBB");
    expect(a.cells).toHaveLength(4);
    expect(a.cells[0]).toHaveLength(5);
    expect(addressAvatar("0xFdAC058d47dc99A70f076523c95a5c97b3805bBB")).toEqual(a);
    expect(addressAvatar("0x0000000000000000000000000000000000000001").hue).not.toBe(a.hue);
  });
});

describe("content security policy covers AppKit", () => {
  const toml = readFileSync(site("netlify.toml"), "utf8");
  const csp = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
  const dir = (name: string) => (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " ")) ?? "").split(/\s+/).slice(1);
  it("allows the relay, the wallet list and the wallet icons, with no wildcard", () => {
    for (const host of APPKIT_CONNECT_HOSTS) expect(dir("connect-src"), host).toContain(host);
    for (const host of APPKIT_IMG_HOSTS) expect(dir("img-src"), host).toContain(host);
    for (const host of APPKIT_FRAME_HOSTS) expect(dir("frame-src"), host).toContain(host);
    expect(csp).not.toMatch(/\*|unsafe-/);
  });
  it("places the featured wallets beside the QR in the vendored modal", () => {
    const vendor = src("public/vendor/appkit.js");
    expect(vendor.length).toBeGreaterThan(200_000);
    expect(vendor.length).toBeLessThan(3_000_000);
    expect(vendor).toContain("beings-wc");
    expect(vendor).toContain("min(960px, calc(100vw - 2rem))");
    expect(vendor).toContain("max-width: 900px");
    expect(vendor).toContain("min(300px, 45vh)");
    expect(vendor).toContain("w3m-connector-list");
    expect(src("tools/appkit-vendor/build.mjs")).toContain("w3m-connector-list");
  });
});
