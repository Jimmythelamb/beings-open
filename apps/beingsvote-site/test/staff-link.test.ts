// Staff wallet linking. Synthetic wallets only. The QR session is a fake provider, not the network.
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Wallet, verifyMessage, toUtf8String } from "ethers";
import { CONFIG } from "../public/js/config.js";
import { linkStaffWallet, staffQrElement, staffSessionOptions, utf8ToHex } from "../public/js/staff-link.js";

const CODE = "BEINGS-2026-RST4XY";
const WHEN = "2026-11-16T01:00:00.000Z";
const NONCE = "abc12345abc12345abc12345abc12345";
const SYNTHETIC_URI = "wc:synthetic-demo@2?relay-protocol=irn&symKey=00";

function square() {
  return [
    [true, false, true],
    [false, true, false],
    [true, false, true],
  ];
}

describe("staff WalletConnect session", () => {
  it("uses its own storage prefix, the page origin, and personal_sign without a ledger send", () => {
    const opts = staffSessionOptions(CONFIG, "https://beingsvote.live");
    expect(opts.customStoragePrefix).toBe("beings-staff-link");
    expect(opts.metadata.url).toBe("https://beingsvote.live");
    expect(opts.showQrModal).toBe(false);
    expect(opts.optionalMethods).toContain("personal_sign");
    expect(opts.optionalMethods).not.toContain("eth_sendTransaction");
    expect(opts.methods).toBeUndefined();
    expect(JSON.stringify(opts)).not.toMatch(/eth_sendTransaction/);
  });

  it("signs with the scanned wallet, checks the recovery, disconnects, and leaves the administrator session alone", async () => {
    const staff = Wallet.createRandom();
    localStorage.setItem("beings.wallet", "browser");
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let disconnected = 0;
    let seenOptions: any = null;
    const provider = {
      accounts: [] as string[],
      session: null as null | { topic: string },
      listeners: {} as Record<string, ((u: string) => void)[]>,
      on(ev: string, fn: (u: string) => void) {
        (this.listeners[ev] ??= []).push(fn);
      },
      async connect() {
        this.listeners.display_uri?.forEach((fn) => fn(SYNTHETIC_URI));
        await gate;
        this.accounts = [staff.address];
        this.session = { topic: "staff-only" };
      },
      async request({ method, params }: { method: string; params: string[] }) {
        expect(method).toBe("personal_sign");
        expect(params[1]).toBe(staff.address);
        const text = toUtf8String(params[0]);
        expect(text).toContain("I, Ada Lovelace, hold this wallet and accept the position System admin");
        expect(utf8ToHex(text)).toBe(params[0]);
        return staff.signMessage(text);
      },
      async disconnect() {
        disconnected += 1;
        this.session = null;
        this.accounts = [];
      },
    };
    const pending = linkStaffWallet({
      firstName: "Ada",
      lastName: "Lovelace",
      position: "System admin",
      electionCode: CODE,
      nonce: NONCE,
      now: () => WHEN,
      origin: "https://beingsvote.live",
      verifyMessage,
      matrixFor: square,
      uriTimeoutMs: 3000,
      loadProvider: async (options) => {
        seenOptions = options;
        return provider;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const dlg = document.querySelector(".staff-link-dialog") as HTMLDialogElement;
    expect(dlg).toBeTruthy();
    expect(dlg.textContent).toContain("Link staff wallet");
    expect(dlg.textContent).toContain("separate connection");
    expect(dlg.querySelector(".wallet-qr")).toBeTruthy();
    const bifrost = [...dlg.querySelectorAll("a")].find((a) => a.textContent?.includes("Open Bifrost Wallet")) as HTMLAnchorElement;
    expect(bifrost.hidden).toBe(false);
    expect(bifrost.getAttribute("href")).toMatch(/^bifrostwallet:\/\/wc\?uri=/);
    expect(bifrost.getAttribute("href")).toContain(encodeURIComponent(SYNTHETIC_URI));
    release();
    const result = await pending;
    expect(result.status).toBe("signed");
    if (result.status !== "signed") return;
    expect(result.address).toBe(staff.address);
    expect(verifyMessage(result.message, result.signature)).toBe(staff.address);
    expect(result.message).toContain(WHEN);
    expect(disconnected).toBe(1);
    expect(seenOptions.customStoragePrefix).toBe("beings-staff-link");
    expect(seenOptions.metadata.url).toBe("https://beingsvote.live");
    expect(localStorage.getItem("beings.wallet")).toBe("browser");
    expect(document.querySelector(".staff-link-dialog")).toBeNull();
  });

  it("disconnects the staff session when the dialog is closed before a scan", async () => {
    let disconnected = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = linkStaffWallet({
      firstName: "Ada",
      lastName: "Lovelace",
      position: "Verifier",
      electionCode: CODE,
      origin: "https://beingsvote.live",
      matrixFor: square,
      uriTimeoutMs: 3000,
      loadProvider: async () => ({
        accounts: [] as string[],
        session: null,
        listeners: {} as Record<string, ((u: string) => void)[]>,
        on(ev: string, fn: (u: string) => void) {
          (this.listeners[ev] ??= []).push(fn);
        },
        async connect() {
          this.listeners.display_uri?.forEach((fn) => fn(SYNTHETIC_URI));
          await gate;
          this.accounts = [Wallet.createRandom().address];
        },
        async request() {
          throw new Error("should not sign");
        },
        async disconnect() {
          disconnected += 1;
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    (document.querySelector(".staff-link-dialog button[aria-label='Close']") as HTMLButtonElement).click();
    release();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(disconnected).toBe(1);
  });

  it("draws a QR from a synthetic code without a live pairing", () => {
    const el = staffQrElement(SYNTHETIC_URI, square);
    const svg = el.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
    expect(el.textContent).not.toContain("0x");
  });
});
