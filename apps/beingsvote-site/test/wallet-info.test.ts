// Organizer wallet box (public/js/wallet-info.js): the facts it states are checked against the code
// and against the real Coston2 receipts in packages/ledger/GAS.md. No network, no wallet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as W from "../public/js/wallet-info.js";
import { ABI } from "../public/js/abi.js";
import { HELP_TEXT } from "../public/js/help.js";

const WI: any = W;
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const admin = src("../public/js/admin.js");
const tx = src("../public/js/tx.js");
const gasMd = src("../../../packages/ledger/GAS.md");

describe("the steps listed are the ones the code really sends", () => {
  it("every step is a real contract function the admin page sends with the organizer's wallet", () => {
    const abiText = JSON.stringify(ABI);
    for (const s of WI.ORGANIZER_STEPS) {
      expect(abiText, s.method).toContain(`function ${s.method}(`);
      if (s.method === "createElection") {
        expect(abiText).toContain("function createPooledElection(");
        expect(admin).toMatch(/createElectionCall/);
      } else {
        expect(admin, s.method).toMatch(new RegExp(`method: (?:el\\.status === 4 \\? "postAmendedTally" : )?"${s.method}"`));
      }
    }
  });
  it("the Create Your Election page sends exactly one transaction: createPooledElection on a new registry, createElection on an old one", () => {
    const create = admin.slice(admin.indexOf("export function createCard("));
    const logic = src("../public/js/logic.js");
    expect(create.match(/sendTx\(/g)).toHaveLength(1);
    expect(create).toMatch(/createElectionCall/);
    expect(logic).toMatch(/method: poolEnforced \? "createPooledElection" : "createElection"/);
    expect(WI.CREATE_PAGE_TX_COUNT).toBe(1);
    expect(WI.ORGANIZER_STEPS[0].method).toBe("createElection");
  });
  it("the claims about approval match tx.js: a card first, a dry run, then the wallet; network switch offered", () => {
    expect(tx).toMatch(/await confirmCard\(/);
    expect(tx).toMatch(/staticCall\(\.\.\.args\); \/\/ dry run/);
    expect(tx).toMatch(/Waiting for you to confirm in your crypto-wallet/);
    expect(tx).toMatch(/await ensureCoston2\(\)/);
    expect(tx).toMatch(/Signing costs nothing and doesn't change the ledger/);
  });
});

describe("example fees are real Coston2 receipts from GAS.md", () => {
  const row = (label: string) => {
    const line = gasMd.split("\n").find((l) => l.startsWith(`| ${label} |`) && /0x[0-9a-f]{8}\.\.\./.test(l));
    return line ? Number(line.split("|")[3]!.trim()) : NaN;
  };
  it("each example equals the smoke-test receipt; steps without one say so", () => {
    const map: Record<string, string> = { createElection: "ElectionRegistry.createElection", registerDevice: "ElectionRegistry.registerDevice", openElection: "ElectionRegistry.openElection", closeElection: "ElectionRegistry.closeElection", postTally: "Tally.postTally (1 question)" };
    for (const s of WI.ORGANIZER_STEPS) {
      if (map[s.method]) expect(s.example, s.method).toBe(row(map[s.method]!));
      else expect(s.example, s.method).toBeNull();
    }
    expect(gasMd).toContain("BEINGS-2026-2MJTDK");
    expect(gasMd).toMatch(/Gas price was 650 gwei/);
    expect(WI.FEE_SOURCE).toMatch(/BEINGS-2026-2MJTDK.*650 gwei.*GAS\.md/);
    expect(WI.exampleTotal()).toBe(0.373);
  });
  it("the reminder line counts the create page's transactions", () => {
    expect(WI.createReminderText()).toBe("Your crypto-wallet will ask you to approve 1 transaction and pay the network fee (test C2FLR). Check the fee your crypto-wallet shows before you approve.");
    expect(WI.createReminderText(2)).toMatch(/approve 2 transactions/);
  });
});

describe("placement and help", () => {
  it("shown at the top of the create form, again before the create button with the reminder, and on the admin page", () => {
    expect(admin).toMatch(/Creating a new election will create a new quantified list of unique ballot codes which will become verified, certified and permanent blockchain ledger entries\."\),\n\s+walletInfoBox\(\{ variant: "full" \}\)/);
    expect(admin).toMatch(/walletInfoBox\(\{ variant: "confirm", open: true \}\),[\s\S]{0,300}h\("div", \{ class: "actions" \}, createBtn\),\n\s+createReminder\(\)/);
    expect(admin).toMatch(/walletInfoBox\(\{ variant: "admin", open: false, administratorName: administratorName\(code, el\.organizer\) \}\)/);
    expect(admin).toContain("Your wallet is asked only at the final step");
  });
  it("help keys exist", () => {
    expect(HELP_TEXT["create.wallet"]).toMatch(/approve/);
    expect(HELP_TEXT["admin.wallet"]).toMatch(/organizer's crypto-wallet/);
  });
});

// ------------------------------------------------------------------ rendering in a tiny fake DOM
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
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
  addEventListener() {}
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
describe("the box", () => {
  let wi: any;
  beforeAll(async () => {
    (globalThis as any).Node = FakeEl;
    (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
    wi = await import("../public/js/wallet-info.js");
  });
  afterAll(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).Node;
  });
  it("full: title, own wallet, steps in order, fees as examples, faucet, test network, permanence, Setup, station wallet", () => {
    const box = wi.walletInfoBox({ variant: "full" });
    expect(box.getAttribute("open")).toBe("");
    const t = box.text;
    expect(t).toContain(wi.WALLET_BOX_HEADING);
    expect(wi.WALLET_BOX_HEADING).toBe("Election Positions and Transactions are through verified and authorized Crypto Wallet Permissions and Transaction Fees.");
    expect(t).toContain("You, the organizer, sign every change with your own crypto-wallet (for example Bifrost or MetaMask) and pay its small network fee.");
    expect(t).toContain("Your crypto-wallet gives permission and authorization from your Election Staffmember position. Sometimes it will ask you for gas fees that will be used to pay for ledger entries to the blockchain.");
    expect(t).not.toContain("This site never holds your coins");
    const order = ["Create the election", "Register Scanner/Printer", "Register a reviewer", "Open voting", "Close voting", "Publish the official tally", "Notice that images were retired"].map((s) => t.indexOf(s));
    expect(order.every((x: number, i: number) => x > 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
    expect(t).toContain("Example fee: about 0.11 C2FLR");
    expect(t).toContain("no test receipt yet");
    expect(t).toContain("rough examples from a test election, not a quote");
    expect(t).toContain("Get your crypto-wallet and test coins");
    expect(t).toContain("We recommend Bifrost Wallet");
    expect(t).toContain("MetaMask also works");
    expect(t.indexOf("We recommend Bifrost Wallet")).toBeLessThan(t.indexOf("MetaMask also works, as a browser crypto-wallet"));
    expect(t).toContain("official Flare Faucet (faucet.flare.network)");
    expect(t).toContain("On the faucet, choose C2FLR in the drop-down (not CFLR).");
    expect(t).toContain("CFLR is the older Coston test network (chain 16); CFLR coins do not work with B.E.I.N.G.S., which runs on Coston2 (chain 114)");
    expect(t.indexOf("choose C2FLR in the drop-down")).toBeLessThan(t.indexOf("paste your crypto-wallet address and press Request C2FLR"));
    expect(t).toContain("For Coston2 it gives 100 C2FLR, 10 USDT0 and 10 FXRP per address every 24 hours");
    expect(t).toContain("test coins with no real value");
    expect(t).toContain("about 1 to 2 C2FLR for a typical classroom election");
    expect(t).toContain("example from our test elections, not a promise, because fees vary; one faucet request is plenty");
    expect(t).toContain("C2FLR has no money value");
    expect(t).toContain("public and permanent");
    expect(t).toContain("only works during Setup");
    expect(t).toContain("The Scanner/Printer has its own crypto-wallet");
    expect(t).not.toMatch(/undefined|NaN/);
  });
  it("confirm: one transaction, createElection, collapsed list of every step", () => {
    const t = wi.walletInfoBox({ variant: "confirm", open: true }).text;
    expect(t).toContain('Pressing "Create it on the ledger" sends 1 transaction from your crypto-wallet');
    expect(t).toContain("Every step your crypto-wallet will be asked for, in order");
  });
  it("admin: collapsed by default; the reminder line renders", () => {
    const box = wi.walletInfoBox({ variant: "admin", open: false });
    expect(box.getAttribute("open")).toBeNull();
    expect(wi.createReminder().text).toContain("approve 1 transaction");
  });
});

describe("wallet and faucet guidance (:James-Hugh: Lamb., 10 Nov)", () => {
  beforeAll(() => {
    (globalThis as any).Node = FakeEl;
    (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
  });
  afterAll(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).Node;
  });
  it("links: Bifrost recommended first, official faucet URL; only the faucet facts from its page", async () => {
    const wi: any = await import("../public/js/wallet-info.js");
    expect(wi.WALLET_GUIDE.recommended).toEqual({ name: "Bifrost Wallet", url: "https://bifrostwallet.com" });
    expect(wi.WALLET_GUIDE.faucet.url).toBe("https://faucet.flare.network");
    expect(wi.WALLET_GUIDE.faucet.perRequest).toBe("100 C2FLR, 10 USDT0 and 10 FXRP");
    const g = wi.walletGetReady();
    const hrefs = g.find((e: any) => e.tagName === "A").map((a: any) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://bifrostwallet.com", "https://faucet.flare.network"]);
    // compact (admin): no wallet recommendation, still faucet + need
    const c = wi.walletGetReady({ compact: true }).text;
    expect(c).not.toContain("We recommend");
    expect(c).toContain("Request C2FLR");
    expect(c).toContain("On the faucet, choose C2FLR in the drop-down (not CFLR).");
    const admin = wi.walletInfoBox({ variant: "admin" }).text;
    expect(admin).toContain("faucet.flare.network");
    expect(admin).toContain(wi.WALLET_BOX_HEADING);
    const n = wi.noWalletYet();
    expect(n.text).toMatch(/^No wallet yet\? Get Bifrost.*MetaMask also works.*Flare Faucet.*: choose C2FLR in the drop-down \(not CFLR\)\.$/);
    expect(n.find((e: any) => e.tagName === "A").map((a: any) => a.getAttribute("href"))).toEqual(["https://bifrostwallet.com", "https://faucet.flare.network"]);
  });
  it("help keys and header text mention Bifrost first and the faucet; no 'unnamed faucet' wording remains", async () => {
    const { HELP_TEXT } = await import("../public/js/help.js");
    expect(HELP_TEXT["create.wallet"]).toMatch(/We recommend Bifrost \(MetaMask also works\)/);
    expect(HELP_TEXT["create.wallet"]).toMatch(/faucet\.flare\.network: choose C2FLR in the drop-down \(not CFLR\), paste your address and press Request C2FLR/);
    expect(HELP_TEXT["admin.wallet"]).toMatch(/choose C2FLR in the drop-down \(not CFLR/);
    expect(HELP_TEXT["create.wallet"]).toMatch(/About 1 to 2 C2FLR .*fees vary/);
    expect(HELP_TEXT["admin.wallet"]).toMatch(/100 C2FLR per address every 24 hours/);
    const chip: any = await import("../public/js/wallet-chip.js");
    expect(chip.walletChipModel({ address: null }, 114).title).toContain("No wallet yet? Get Bifrost (bifrostwallet.com), then free test coins at faucet.flare.network (choose C2FLR, not CFLR).");
    expect(src("../public/js/app.js")).toMatch(/WALLET_CONNECT_LEAD\), noWalletYet\(\)/);
    expect(src("../public/js/walletui.js")).toContain("Use WalletConnect here to register an election and to pay for image storage and gas fees for the blockchain ledger entries.");
    expect(src("../public/js/app.js")).toContain("WALLET_CONNECT_LEAD");
    for (const f of ["wallet-info.js", "help.js", "walletui.js"]) expect(src(`../public/js/${f}`), f).not.toMatch(/Flare Coston2 faucet|the Flare faucet/);
  });
});
