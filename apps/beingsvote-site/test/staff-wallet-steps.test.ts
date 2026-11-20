// @vitest-environment happy-dom
// Where the staff wallet control sits: off the Staff Porthole hub, inside Election admin step 1,
// and as a short sign-in line on other roles only while they still need a wallet.
// Synthetic address only. No network and no wallet session.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { state } from "../public/js/roles.js";
import { REGISTER_ADMIN_LABEL } from "../public/js/roster.js";
import {
  ELECTION_START,
  ROLE_SIGNIN_PROMPT,
  electionStartNodes,
  openElectionForms,
  electionConnectControl,
  openHeaderWallet,
  administratorGuide,
  pageHead,
  renderStaffHub,
  roleAccess,
  roleSignInNodes,
} from "../public/js/staff.js";
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const SYNTH = "0x1111111111111111111111111111111111111111";
const savedAddress = state.address;

function fnBody(file: string, name: string) {
  const text = src(file);
  const start = text.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport ", start + 10);
  return text.slice(start, next === -1 ? undefined : next);
}

afterAll(() => {
  state.address = savedAddress;
});

describe("staff hub", () => {
  it("no longer puts a wallet box above the role cards", () => {
    const hub = fnBody("../public/js/staff.js", "renderStaffHub");
    expect(hub).not.toContain("walletPicker");
    expect(hub).not.toContain("electionConnectControl");
    expect(hub).not.toContain("wallet-panel");
    expect(hub).not.toContain("roleSignIn");
    expect(hub).toContain('class: "staff-grid"');
    state.address = null;
    const root = document.createElement("div");
    renderStaffHub({ root, current: () => true, query: new URLSearchParams() });
    expect(root.querySelector(".wallet-panel")).toBeNull();
    expect(root.querySelector(".election-connect")).toBeNull();
    expect(root.querySelector(".wallet-connect-layout")).toBeNull();
    expect(root.textContent).not.toContain("Connect a wallet");
    expect(root.textContent).not.toContain("Open Bifrost Wallet");
    expect(root.textContent).toContain("Election Administrator");
    expect(root.textContent).toContain("Election officer");
    expect(root.textContent).toContain("Verifier");
    expect(root.textContent).toContain("Scanner operator");
    expect(root.textContent).toContain("System admin");
    expect(root.textContent).toContain("Staff Porthole");
    expect(root.textContent).not.toContain("Staff tools");
    expect(document.title).toBe("Staff Porthole · B.E.I.N.G.S.");
    expect(root.textContent).toContain("Open to read");
    const labels = [...root.querySelectorAll(".role-card h2")].map((n) => n.textContent);
    expect(labels).toEqual(["Election Administrator", "Election officer", "Verifier", "Scanner operator", "System admin"]);
  });
});

describe("role page heading", () => {
  it("keeps the icon, title and description, and drops the tag row", () => {
    const head = pageHead("admin", { lead: "Set up an election." });
    expect(head.querySelector("h1")?.textContent).toBe("Election Administrator");
    expect(head.textContent).toContain("Set up an election.");
    expect(head.querySelector("img, .role-icon")).toBeTruthy();
    expect(head.querySelector(".badges")).toBeNull();
    for (const gone of ["Open to read, wallet needed to act", "Changes the ledger · wallet needed", "Test network", "Unlocked for your wallet"]) {
      expect(head.textContent).not.toContain(gone);
    }
    for (const id of ["officer", "verifier", "scanner", "system"]) expect(pageHead(id, { lead: "Still here." }).querySelector(".badges")).toBeNull();
    expect(src("../public/js/admin.js")).not.toContain("Changes the ledger · wallet needed");
    expect(src("../public/js/staff.js")).toContain('h("h1", null, "Staff Porthole")');
    expect(src("../public/js/staff.js")).toContain('setTitle("Staff Porthole")');
    expect(src("../public/js/admin.js")).toContain('setTitle(ROLE_INFO.admin.label)');
    expect(src("../public/js/admin.js")).toContain("pageHead(\"admin\", { body: administratorGuide() })");
    expect(src("../public/js/roles.js")).toContain('route: "#/admin"');
    const guide = administratorGuide();
    expect(guide.querySelector(".lead")?.textContent).toContain("official signature");
    expect(guide.querySelector("details summary")?.textContent).toBe("What's a crypto-wallet, and why does an election need one?");
    expect(guide.querySelector("#admin-duties-h")?.textContent).toContain("what their crypto-wallet does at each step");
    expect(guide.querySelectorAll(".duty-list li")).toHaveLength(8);
    expect(guide.textContent).toContain("What their crypto-wallet can't do:");
    expect(guide.querySelector(".badges")).toBeNull();
  });
});

describe("election admin steps", () => {
  it("puts Connect and the C2FLR help button inside step 1 only", () => {
    const connect = electionConnectControl();
    const view = electionStartNodes({ address: null, connect });
    expect(view.querySelector("#election-start-h")?.textContent).toContain(ELECTION_START.title);
    const steps = [...view.querySelectorAll("[data-step]")];
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(["1", "2", "3"]);
    expect(steps.map((s) => s.textContent)).toEqual([
      expect.stringContaining(ELECTION_START.steps[0]),
      expect.stringContaining(ELECTION_START.steps[1]),
      expect.stringContaining(ELECTION_START.steps[2]),
    ]);
    const step1 = steps[0] as HTMLElement;
    expect(step1.className).toContain("is-current");
    expect(step1.textContent).toContain("Connect wallet");
    expect(step1.textContent).toContain("Bifrost");
    expect(step1.textContent).toContain("Load your Wallet with C2FLR");
    expect(steps[1].textContent).not.toContain("Connect wallet");
    expect(steps[1].textContent).not.toContain("Load your Wallet with C2FLR");
    expect(steps[2].querySelector(".election-connect")).toBeNull();
    expect(view.querySelector(".wallet-panel")).toBeNull();
    expect(step1.textContent).toContain(REGISTER_ADMIN_LABEL);
    expect(steps[1].textContent).not.toContain(REGISTER_ADMIN_LABEL);
    expect(steps[2].textContent).not.toContain(REGISTER_ADMIN_LABEL);
    let registers = 0;
    const again = electionStartNodes({ address: null, connect, onRegister: () => registers++ });
    (again.querySelector('[data-step="1"] button.register-admin-btn') as HTMLButtonElement).click();
    expect(registers).toBe(1);
    const control = fnBody("../public/js/staff.js", "electionConnectControl");
    expect(control).toContain("openHeaderWallet()");
    expect(control).toContain("faucetButton()");
    expect(control).not.toContain("walletPicker");
    expect(fnBody("../public/js/staff.js", "electionStartGuide")).toContain("state.address ? null : electionConnectControl()");
    expect(fnBody("../public/js/admin.js", "renderAdmin")).toContain("electionStartGuide(ctx)");
    expect(src("../public/js/admin.js")).not.toContain("walletPanel");
  });

  it("marks step 1 done with the connected address and points at the forms", () => {
    let forms = 0;
    const stray = document.createElement("div");
    stray.textContent = "Browser wallet Open Bifrost Wallet Load your Wallet with C2FLR";
    const waiting = electionStartNodes({ address: SYNTH, connect: stray, onRegister: () => forms++ });
    const waitingStep = waiting.querySelector('[data-step="1"]') as HTMLElement;
    expect(waitingStep.className).not.toContain("is-done");
    expect(waitingStep.textContent).toContain("Connected as");
    expect(waitingStep.textContent).toContain(REGISTER_ADMIN_LABEL);
    expect(waitingStep.textContent).not.toContain("Browser wallet");
    (waitingStep.querySelector("button.register-admin-btn") as HTMLButtonElement).click();
    expect(forms).toBe(1);
    const view = electionStartNodes({
      address: SYNTH,
      connect: stray,
      onForms: () => forms++,
      registered: { firstName: "Ada", lastName: "Lovelace", address: SYNTH },
      wrongNetwork: true,
      organizes: ["BEINGS-2026-DEMO"],
    });
    const step1 = view.querySelector('[data-step="1"]') as HTMLElement;
    expect(step1.className).toContain("is-done");
    expect(step1.textContent).toContain("Registered as");
    expect(step1.textContent).toContain("Ada Lovelace");
    expect(step1.textContent).toContain(SYNTH);
    expect(step1.textContent).not.toContain(REGISTER_ADMIN_LABEL);
    expect(step1.querySelector("code")?.getAttribute("title")).toBe(SYNTH);
    expect(step1.textContent).not.toContain("Browser wallet");
    expect(step1.textContent).not.toContain("Open Bifrost Wallet");
    expect(view.textContent).toContain("Next: fill out the election forms (details, questions, staff, schedule).");
    expect(view.querySelector('[data-step="2"]')?.className).toContain("is-next");
    expect(view.textContent).toContain("Your crypto-wallet is on a different network.");
    expect(view.textContent).toContain("This crypto-wallet organizes 1 election: BEINGS-2026-DEMO.");
    (step1.querySelector("button") as HTMLButtonElement).click();
    expect(forms).toBe(2);
    const details = document.createElement("details");
    details.id = "start-here";
    document.body.append(details);
    openElectionForms();
    expect(details.open).toBe(true);
    details.remove();
  });
});

describe("other roles", () => {
  it("shows a short sign-in prompt only while a wallet is still needed", () => {
    expect(roleSignInNodes({ address: SYNTH, onConnect() {} })).toBeNull();
    let clicks = 0;
    const line = roleSignInNodes({ address: null, onConnect: () => clicks++, detail: "Reading this page stays open." });
    expect(line?.textContent).toContain(ROLE_SIGNIN_PROMPT);
    expect(line?.textContent).toContain("Reading this page stays open.");
    expect(line?.querySelector(".wallet-connect-layout")).toBeNull();
    (line?.querySelector("button") as HTMLButtonElement).click();
    expect(clicks).toBe(1);

    state.address = null;
    let opened = 0;
    const onOpen = () => opened++;
    document.addEventListener("beings:open-wallet", onOpen);
    const officer = roleAccess({ current: () => true }, { roleId: "officer", detail: "Reading this page stays open. A wallet is needed to mark a ballot spoiled or sign off a review." });
    expect(officer.getAttribute("data-role")).toBe("officer");
    expect(officer.hidden).toBe(false);
    expect(officer.textContent).toContain(ROLE_SIGNIN_PROMPT);
    expect(officer.querySelector(".wallet-panel")).toBeNull();
    (officer.querySelector("button") as HTMLButtonElement).click();
    expect(opened).toBe(1);
    openHeaderWallet();
    expect(opened).toBe(2);
    document.removeEventListener("beings:open-wallet", onOpen);

    state.address = SYNTH;
    const signedIn = roleAccess({ current: () => true }, { roleId: "officer", detail: "not shown" });
    expect(signedIn.hidden).toBe(true);
    expect(signedIn.textContent).not.toContain(ROLE_SIGNIN_PROMPT);
    const verifier = roleAccess({ current: () => true }, {
      roleId: "verifier",
      whenConnected: () => {
        const p = document.createElement("p");
        p.textContent = "Registered as a verifier node";
        return p;
      },
    });
    expect(verifier.textContent).toContain("Registered as a verifier node");
    expect(verifier.textContent).not.toContain(ROLE_SIGNIN_PROMPT);
    state.address = null;
  });

  it("wires the prompt into officer and verifier, and leaves scanner and system without a wallet box", () => {
    const officer = src("../public/js/officer.js");
    const verifier = src("../public/js/verifier.js");
    expect(officer).toContain('roleAccess(ctx, { roleId: "officer"');
    expect(officer).not.toContain("walletPanel");
    expect(verifier).toContain('roleAccess(ctx, { roleId: "verifier"');
    expect(verifier).toContain("whenConnected: () => registrationBox(ctx)");
    expect(verifier).not.toContain("walletPanel");
    for (const file of ["../public/js/system.js", "../public/js/scanner.js"]) {
      const text = src(file);
      expect(text, file).not.toContain("walletPanel");
      expect(text, file).not.toContain("walletPicker");
      expect(text, file).not.toContain("roleAccess");
    }
  });
});

describe("header connect button", () => {
  it("stays the header control and still opens the same dialog", () => {
    const html = src("../public/index.html");
    expect(html).toContain('<button id="wallet-btn" class="btn btn-sm wallet-btn" type="button" aria-haspopup="dialog">Connect wallet</button>');
    const app = src("../public/js/app.js");
    expect(app).toContain('walletBtn.addEventListener("click", openWallet)');
    expect(app).toContain("beginConnect()");
    expect(app).toContain("openConnect()");
    expect(app).toContain("WALLET_CONNECT_LEAD");
    expect(app).not.toContain("walletPicker");
  });
});
