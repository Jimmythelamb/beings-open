// Header wallet chip (wallet-chip.js), Staff and official wallets (staff-wallets.js), and "every new election uses the
// client's own connected wallet" (nothing hardcoded). Throwaway/public addresses only; no network, no wallet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG } from "../public/js/config.js";
import { HELP_TEXT } from "../public/js/help.js";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const ORGANIZER = "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB";
const STATION = "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D";
const C: any = CONFIG;

class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  className = "";
  hidden = false;
  style: any = {};
  dataset: any = {};
  textContent = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  addEventListener(t: string, fn: (e: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  fire(t: string) {
    for (const fn of this.listeners[t] ?? []) fn({ stopPropagation() {} });
  }
  querySelector(): any {
    return new FakeEl("button");
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (c instanceof FakeEl ? c.text : String(c))).join("");
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = pred(this) ? [this] : [];
    for (const c of this.children) if (c instanceof FakeEl) out.push(...c.find(pred));
    return out;
  }
}
let chip: any;
let staff: any;
beforeAll(async () => {
  (globalThis as any).Node = FakeEl;
  (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
  chip = await import("../public/js/wallet-chip.js");
  staff = await import("../public/js/staff-wallets.js");
});
afterAll(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).Node;
});
const textOf = (nodes: any[]) => nodes.filter(Boolean).map((n: any) => n.text).join(" ");

describe("header wallet chip", () => {
  it("disconnected: a Connect wallet button, nothing else", () => {
    const m = chip.walletChipModel({ address: null }, 114);
    expect(m).toMatchObject({ connected: false, label: "Connect wallet" });
    expect(chip.walletChipExtras(m)).toEqual([]);
    expect(chip.walletRoleLine(m)).toBeNull();
  });
  it("connected on Coston2: short address, full address + role line in the tooltip, Coston2 badge, copy and disconnect", () => {
    let copied = "";
    let gone = false;
    const m = chip.walletChipModel({ address: STATION, chainId: 114 }, 114);
    expect(m).toMatchObject({ connected: true, label: "0xfB2A…d73D", network: "ok", networkText: "Coston2", networkTone: "ok" });
    expect(m.title).toBe(`${STATION}. This is the wallet that signs and pays for your election.`);
    const parts = chip.walletChipExtras(m, { onCopy: (a: string) => (copied = a), onDisconnect: () => (gone = true) });
    expect(textOf(parts)).toContain("Coston2");
    const copy = parts.find((p: any) => p.getAttribute("aria-label") === "Copy your wallet address");
    const disc = parts.find((p: any) => p.getAttribute("aria-label") === "Disconnect your wallet");
    copy.fire("click");
    disc.fire("click");
    expect(copied).toBe(STATION);
    expect(gone).toBe(true);
    expect(chip.walletRoleLine(m).text).toBe("This is the wallet that signs and pays for your election.");
  });
  it("wrong network: a red badge that offers to switch; unknown network is neutral", () => {
    let switched = false;
    const m = chip.walletChipModel({ address: STATION, chainId: 1 }, 114);
    expect(m).toMatchObject({ network: "wrong", networkText: "Wrong network", networkTone: "bad" });
    const b = chip.walletChipExtras(m, { onSwitch: () => (switched = true) })[0];
    expect(b.tagName).toBe("BUTTON");
    b.fire("click");
    expect(switched).toBe(true);
    expect(chip.walletChipModel({ address: STATION, chainId: null }, 114).networkTone).toBe("neutral");
  });
  it("lives in the shared header, so every page shows it; it reuses the existing wallet state", () => {
    const html = src("../public/index.html");
    expect(html).toMatch(/<div class="header-tools">[\s\S]*id="wallet-btn"[\s\S]*<span id="wallet-extra" class="wallet-extra"><\/span>[\s\S]*<\/header>/);
    const app = src("../public/js/app.js");
    expect(app).toMatch(/const chip = walletChipModel\(s, CONFIG\.chainId\)/);
    expect(app).toMatch(/walletChipExtras\(chip, \{ onCopy/);
    expect(app).toMatch(/walletRoleLine\(chip\)/);
    expect(src("../public/js/wallet-chip.js")).not.toMatch(/privateKey|sendTransaction|signTypedData/);
  });
});

describe("Staff and official wallets", () => {
  it("the configured list is valid and includes the organizer wallet and the station", () => {
    expect(staff.staffWalletProblems(C.staffWallets)).toEqual([]);
    expect(C.staffWallets).toContainEqual(expect.objectContaining({ role: "Organizer", address: ORGANIZER }));
    expect(C.staffWallets).toContainEqual(expect.objectContaining({ role: "Scanner/Printer station", address: STATION }));
  });
  it("refuses bad rows with plain reasons", () => {
    expect(staff.staffWalletProblems([{ role: "Organizer", address: "0x12" }])[0]).toMatch(/isn't a wallet address/);
    expect(staff.staffWalletProblems([{ role: "A", address: ORGANIZER }, { role: "B", address: ORGANIZER.toLowerCase() }])[0]).toMatch(/listed twice/);
    expect(staff.staffWalletProblems([{ role: "", address: ORGANIZER }])[0]).toMatch(/role label/);
    expect(staff.staffWalletProblems([{ role: "A", address: ORGANIZER, name: "x".repeat(65) }])[0]).toMatch(/longer than 64/);
    expect(staff.staffWalletProblems([{ role: "A", address: ORGANIZER, email: "a@b" }])[0]).toMatch(/unknown field email/);
    expect(staff.staffWalletProblems("nope")).toEqual(["staffWallets must be a list."]);
  });
  it("renders role, display name, areas, full address with copy, and marks the connected wallet", () => {
    const sec = staff.staffWalletsSection(C.staffWallets, { connected: ORGANIZER.toLowerCase() });
    const t = sec.text;
    expect(t).toContain("Staff and official wallets");
    expect(t).toContain("Organizer");
    expect(t).toContain(":James-Hugh: Lamb.");
    expect(t).toContain(ORGANIZER);
    expect(t).toContain(STATION);
    expect(t).toContain("never written to the ledger");
    expect(t).toContain("doesn't give a wallet any power");
    expect(sec.find((e: FakeEl) => e.tagName === "LI" && (e.getAttribute("class") ?? e.className).includes("me"))).toHaveLength(1);
    expect(sec.find((e: FakeEl) => (e.getAttribute("aria-label") ?? "").startsWith("Copy the "))).toHaveLength(2);
    expect(staff.staffWalletsSection([]).text).toContain("No staff wallets are listed");
  });
  it("is shown on the Staff page and has its help note", () => {
    expect(src("../public/js/staff.js")).toMatch(/staffWalletsSection\(CONFIG\.staffWallets, \{ connected: state\.address \}\)/);
    expect(HELP_TEXT["staff.wallets"]).toMatch(/only a label on this website/);
  });
});

describe("every new election uses the client's own connected wallet", () => {
  const admin = src("../public/js/admin.js");
  it("the organizer is the connected wallet; Prepare asks to connect first", () => {
    expect(admin).toMatch(/draftElectionFile\(\{ \.\.\.v, organizer: state\.address,/);
    expect(admin).toMatch(/if \(!state\.address\) return fill\(out, callout\("warn", "Connect your wallet first"/);
  });
  it("no wallet address is hardcoded in the page code; stations come from the site setting or a pasted address", () => {
    for (const f of ["admin.js", "fingerprints.js", "recorded-ui.js", "wallet-info.js", "staff-wallets.js", "wallet-chip.js", "scanner-builds.js", "staff.js", "app.js"]) expect(src(`../public/js/${f}`), f).not.toMatch(/0x[0-9a-fA-F]{40}\b/);
    expect(admin).toMatch(/const known = \(CONFIG\.scannerStations \?\? \[\]\)/);
    expect(admin).toContain("Paste a different wallet address…");
    expect(Array.isArray(C.scannerStations)).toBe(true);
  });
  it("the wallet box points at the wallet in the header", async () => {
    const wi = await import("../public/js/wallet-info.js");
    const t = (wi.walletInfoBox({ variant: "full" }) as any).text;
    expect(t).toContain("The address at the top right is the one that creates this election, followed by the Election Administrator's name.");
    expect(t).toContain("paid by the crypto-wallet that sends it, not by yours");
    expect((wi.walletInfoBox({ variant: "confirm" }) as any).text).toContain("connected at the top right of the page, which becomes this election's organizer");
  });
});
