// Staff area: the hub, plus the pieces the role screens share (election picker, small widgets).
// Everything here can be read without a wallet. A wallet is only needed to sign or to change something.
// The header Connect wallet button stays on every page. Election admin puts the connect control inside its
// first step. Other roles ask to sign in only inside their own panel, and only when that role needs a wallet.
import { labelWithHelp } from "./help.js";
import { fill, h, icon, badge, callout, spinner, skeleton, setTitle, fmtDate } from "./ui.js";
import { ROLE_INFO, STAFF_HUB_ORDER, state, subscribe, onCoston2 } from "./roles.js";
import { WALLET_CONNECT_LEAD } from "./walletui.js";
import { faucetButton } from "./faucet.js";
import { revealStartHere } from "./start-here.js";
import { discoverElections, getElection, loadElectionFile } from "./chain.js";
import { splitLedgerResults, parseResult } from "./format.js";
import { CONFIG } from "./config.js";
import { staffWalletsSection } from "./staff-wallets.js";
import { REGISTER_ADMIN_LABEL, resolveElectionId, startAdminRegistration } from "./admin-register.js";
import { readAdminRegistration } from "./roster.js";

// ------------------------------------------------------------------ small widgets
export const statGrid = (items) =>
  h("dl", { class: "chips" }, items.map(([label, value, hint, tone]) => h("div", { class: `chip${tone ? ` chip-${tone}` : ""}` }, h("dt", null, label), h("dd", null, value), hint ? h("span", { class: "chip-hint" }, hint) : null)));

export const kvList = (rows) => h("dl", { class: "kvs" }, rows.filter(Boolean).map(([k, v]) => h("div", { class: "kv" }, h("dt", null, k), h("dd", null, v))));

/** A scrollable table. columns: [{ key, label, num? }]; rows: array of objects whose values are text or DOM nodes. */
export function dataTable(columns, rows, { caption, empty = "Nothing to show yet." } = {}) {
  if (!rows.length) return h("p", { class: "muted" }, empty);
  return h(
    "div",
    { class: "table-wrap", tabindex: "0", role: "region", "aria-label": caption ?? "Table" },
    h(
      "table",
      { class: "data-table" },
      caption ? h("caption", { class: "sr-only" }, caption) : null,
      h("thead", null, h("tr", null, columns.map((c) => h("th", { scope: "col", class: c.num ? "num" : null }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", { class: r._class ?? null }, columns.map((c) => h("td", { class: c.num ? "num" : null }, r[c.key] ?? "—"))))),
    ),
  );
}

export const hashText = (v, lead = 10, tail = 8) => h("code", { class: "code", title: v }, !v ? "—" : v.length > lead + tail + 3 ? `${v.slice(0, lead)}…${v.slice(-tail)}` : v);

const levelTone = { bad: "bad", warn: "warn", info: "info", ok: "ok" };
const levelIcon = { bad: "alert", warn: "flag", info: "info", ok: "check" };
export function flagList(flags, emptyText = "No problems found in what was checked.") {
  if (!flags.length) return callout("ok", "All clear", emptyText, "check");
  return h("div", { class: "flag-list" }, flags.map((f) => h("div", { class: `callout callout-${levelTone[f.level] ?? "info"}` }, icon(levelIcon[f.level] ?? "info", { size: 22 }), h("div", null, h("strong", null, f.title), h("p", null, f.detail)))));
}

export function downloadBlob(name, data, mime = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const field = ({ id, label, hint, type = "text", value, placeholder, mono, rows, min, max, step, required, help }) =>
  h(
    "div",
    { class: "field" },
    help ? labelWithHelp(id, label, help) : h("label", { for: id }, label),
    rows
      ? h("textarea", { id, name: id, rows, spellcheck: "false", placeholder, "aria-describedby": `${id}-hint` }, value ?? "")
      : h("input", { id, name: id, type, value: value ?? null, placeholder, min, max, step, autocomplete: "off", spellcheck: "false", class: mono ? "plain-mono" : null, required: required ? true : null, "aria-describedby": `${id}-hint` }),
    hint ? h("p", { id: `${id}-hint`, class: "hint" }, hint) : null,
  );

/** Put a button into a "working" state while an async function runs. */
export async function busy(btn, label, fn) {
  const old = [...btn.childNodes];
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (label) btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    fill(btn, ...old);
  }
}

/** Questions from an election file; when only a public copy without questions exists, placeholders so counting still works. */
export function questionsOf(file, records) {
  if (file?.questions?.length) return file.questions;
  const n = Math.max(0, ...Object.values(records ?? {}).map((s) => splitLedgerResults(s).length));
  const max = Array.from({ length: n }, () => 1);
  for (const s of Object.values(records ?? {})) splitLedgerResults(s).forEach((seg, i) => {
    const p = parseResult(seg);
    if (p?.kind === "V") for (const id of p.choices) max[i] = Math.max(max[i], Number(id.slice(1)));
  });
  return max.map((m, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}`, maxMarks: 1, choices: Array.from({ length: m }, (_, j) => ({ id: `c${j + 1}`, text: `Choice ${j + 1}` })), synthetic: true }));
}

// ------------------------------------------------------------------ page frame
/** App tile for a staff role, or the small outline icon when the role has no tile (System admin). */
export function roleMark(info, { px = 52 } = {}) {
  if (!info?.mark) return h("span", { class: px >= 60 ? "role-icon" : "role-icon sm" }, icon(info.icon, { size: px >= 60 ? 30 : 22 }));
  return h("img", { class: "role-mark", src: info.mark.src, srcset: info.mark.srcset, sizes: `${px}px`, width: String(px), height: String(px), alt: info.mark.alt });
}

export function pageHead(roleId, { lead, body } = {}) {
  const info = ROLE_INFO[roleId];
  return h(
    "header",
    { class: "card role-head" },
    roleMark(info, { px: 60 }),
    h("div", { class: "role-copy" }, h("h1", null, info.label), body ?? h("p", { class: "lead" }, lead)),
  );
}

/** Plain-language guide under the Election Administrator title. */
export function administratorGuide() {
  const point = (title, rest) => h("li", null, h("strong", null, title), " ", rest);
  const step = (name, what, wallet) =>
    h(
      "li",
      null,
      h("strong", null, `${name}.`),
      what ? [" ", what] : null,
      h("span", { class: "duty-wallet" }, h("strong", null, "Crypto-wallet: "), wallet),
    );
  return h(
    "div",
    { class: "role-guide" },
    h(
      "p",
      { class: "lead" },
      "The one person responsible for running this election from start to finish. Their crypto-wallet is the election's official signature: every step below is a transaction they approve in their crypto-wallet, written to the public ledger with the time and their crypto-wallet address, so anyone can see who did what and when.",
    ),
    h(
      "details",
      { class: "details role-explain", open: true },
      h("summary", null, "What's a crypto-wallet, and why does an election need one?"),
      h("p", null, "A crypto-wallet is an app on your phone or computer (like Bifrost or MetaMask). It doesn't hold cash here. In an election it works like your official signature and ID badge."),
      h(
        "ul",
        { class: "plain-list" },
        point("Your crypto-wallet address is your staff ID.", "Every staff member has one, a long code starting with 0x. Once it's registered, the election knows which address belongs to the Election Administrator, the officers, the scanner operators and the verifiers."),
        point("Approving in your crypto-wallet is signing the official record.", "On paper, an election official initials the poll book or signs the count sheet. Here you press Approve in your crypto-wallet instead. Your signature is attached to that step forever, and anyone can check it."),
        point("The private key is your pen.", "It lives only in your crypto-wallet app and is never shared, not with us, not with anyone. Whoever holds it can sign as you, so guard it the way you'd guard the ballot box key."),
        point("Connecting is showing your badge at the door.", "It only tells the site which staff member you are. It can't sign or spend anything."),
        point("Network fees are the postage for the public record.", "Each official step written to the ledger costs a tiny fee. In test elections it's paid with free C2FLR test coins, which have no money value."),
        point("The ledger is the public poll book.", "A shared record nobody can secretly edit, not even us. Every signed step lands there with the time and the address that signed it."),
      ),
      h("p", null, "In short: the crypto-wallet lets anyone confirm who did each step of the election, and when, without having to trust us."),
    ),
    h(
      "section",
      { class: "role-explain", "aria-labelledby": "admin-duties-h" },
      h("h2", { id: "admin-duties-h" }, "What the Election Administrator does, and what their crypto-wallet does at each step"),
      h(
        "ol",
        { class: "duty-list" },
        step("Registers", "Links their name to their crypto-wallet.", "signs a transaction to the Staff Registry. It stores their crypto-wallet address next to a salted fingerprint of their name, proving who they are without putting the name itself on the ledger."),
        step("Sets up the election", "Writes the questions and choices, sets the schedule, and names the staff.", "signs the staff roster as typed data (a readable signature), recording which crypto-wallet address holds each role (officer, scanner operator, verifier). From then on, only those addresses can act in those roles."),
        step("Registers the election on the ledger", "", "signs a transaction to the Election Registry, writing the election's code and a fingerprint of its questions and rules. Once recorded, any change would no longer match the fingerprint, so the rules are locked in public view."),
        step("Prints the ballots", "Each paper ballot carries its own code so a voter can check it later.", "nothing to sign; printing happens offline from the registered election."),
        step("Opens and closes voting", "", "signs a transaction for each, changing the election's status on the ledger, so everyone can see exactly when voting started and stopped, and who did it."),
        step("Oversees the count", "Scanner operators scan the ballots, and each ballot's fingerprint is recorded on the Ballot Ledger.", "the scanner operators' crypto-wallets sign those batches, not the Administrator's, so no single crypto-wallet controls both setup and counting. Flagged ballots go to an officer for review."),
        step("Publishes the official result", "", "signs a transaction to the Tally contract, posting the final count and a single fingerprint (a Merkle root) built from every recorded ballot. Independent verifiers rebuild that fingerprint from the ballot images; if it matches, the count is confirmed."),
        step("Pays the costs", "", "covers the network fee (gas) for each transaction, plus image storage. Test elections use free C2FLR test coins with no money value."),
      ),
      h("p", null, h("strong", null, "What their crypto-wallet can't do: "), "change a ballot once it's recorded, sign as another staff member, hide a result, or verify their own count. The ledger only accepts each action from the crypto-wallet registered for that role."),
    ),
  );
}

/** Re-run `paint` whenever the wallet changes, until the person leaves this page. */
export function liveWallet(ctx, paint) {
  const off = subscribe(() => {
    if (!ctx.current()) return off();
    paint();
  });
  paint();
}

/** The sentence other roles show, inside their own panel, only while they still need a wallet. */
export const ROLE_SIGNIN_PROMPT = "Connect your crypto-wallet to sign in to this position.";

/** Directions at the top of Election admin. The connect control lives inside step 1. */
export const ELECTION_START = {
  title: "To start an election",
  steps: [
    "Connect your crypto-wallet (the crypto-wallet shown top right becomes the Election Administrator's crypto-wallet)",
    "Fill out the election forms (details, questions, staff, schedule)",
    "Register the election",
  ],
};

/** Open the header's existing Connect wallet dialog. Does not add a second connect button to the header. */
export function openHeaderWallet() {
  document.dispatchEvent(new CustomEvent("beings:open-wallet"));
}

/**
 * The same Connect action as the header: AppKit's QR on a computer, Bifrost on a phone or iPad.
 * Drawn inside Election admin step 1, not above the staff hub.
 */
export function electionConnectControl() {
  return h(
    "div",
    { class: "election-connect" },
    h("p", { class: "wallet-lead" }, WALLET_CONNECT_LEAD),
    h("button", { class: "btn btn-primary", type: "button", onClick: () => openHeaderWallet() }, "Connect wallet"),
    h("p", { class: "muted small" }, "On a computer this opens the WalletConnect code, with Bifrost and MetaMask beside it. On a phone or iPad it opens Bifrost."),
    h("p", { class: "muted small" }, "Free test coins pay the network fee. They have no money value."),
    h("div", { class: "faucet-row" }, faucetButton()),
  );
}

const registerAdminButton = (onRegister) =>
  h("button", { class: "btn btn-primary register-admin-btn", type: "button", onClick: () => onRegister?.() }, REGISTER_ADMIN_LABEL);

/** Ordered directions. The connect control and the register button live inside step 1. */
export function electionStartNodes({ address, connect, onRegister, onForms, registered = null, wrongNetwork = false, organizes = [] } = {}) {
  const connected = !!address;
  const done = !!(registered && connected && String(registered.address).toLowerCase() === String(address).toLowerCase());
  const step = (n, extra, cls) =>
    h(
      "li",
      { class: `election-step${cls ? ` ${cls}` : ""}`, "data-step": String(n), "aria-current": cls === "is-current" || cls === "is-next" ? "step" : null },
      h("p", { class: "step-kicker" }, `${n}) ${ELECTION_START.steps[n - 1]}`),
      extra,
    );
  const stepBody = done
    ? h(
        "div",
        { class: "step-done" },
        h("p", { class: "step-status" }, icon("check", { size: 18, label: "Done" }), h("span", null, "Registered as ", h("strong", null, `${registered.firstName} ${registered.lastName}`), ". Crypto-wallet ", h("code", { class: "code", title: address }, address), ".")),
        h("p", null, "This is the crypto-wallet shown at the top right. It is the Election Administrator's crypto-wallet. The name and crypto-wallet are stored with the roster."),
        wrongNetwork ? h("p", { class: "muted small" }, "Your crypto-wallet is on a different network. Use the network button at the top right to switch to Coston2.") : null,
        organizes.length ? h("p", { class: "muted small" }, `This crypto-wallet organizes ${organizes.length} election${organizes.length === 1 ? "" : "s"}: ${organizes.join(", ")}.`) : null,
        h("p", { class: "step-next-line" }, "Next: fill out the election forms (details, questions, staff, schedule)."),
        h("button", { class: "btn btn-primary", type: "button", onClick: () => onForms?.() }, "Go to the election forms"),
      )
    : h(
        "div",
        { class: "step-register" },
        connected ? h("p", { class: "step-status" }, "Connected as ", h("code", { class: "code", title: address }, address), ". Register your name with this crypto-wallet to finish this step.") : connect ?? null,
        wrongNetwork ? h("p", { class: "muted small" }, "Your crypto-wallet is on a different network. Use the network button at the top right to switch to Coston2.") : null,
        registerAdminButton(onRegister),
      );
  return h(
    "section",
    { class: "card election-start", id: "election-start", "aria-labelledby": "election-start-h" },
    h("h2", { id: "election-start-h" }, icon("flag", { size: 22 }), ELECTION_START.title),
    h(
      "ol",
      { class: "election-steps" },
      step(1, stepBody, done ? "is-done" : "is-current"),
      step(2, done ? h("p", { class: "muted small" }, "The forms are below: election details, questions, staff, and the schedule.") : null, done ? "is-next" : ""),
      step(3, done ? h("p", { class: "muted small" }, "When the forms are ready, register the election from this page. Your crypto-wallet confirms that step.") : null, ""),
    ),
  );
}

/** Open the create-election forms and bring them to the top of the screen. */
export function openElectionForms() {
  const el = document.getElementById("start-here");
  if (el) el.open = true;
  revealStartHere();
}

/** Election admin directions. Step 1 redraws when the wallet connects or the administrator registers. */
export function electionStartGuide(ctx) {
  const box = h("div", { class: "election-start-slot" });
  const paint = () => {
    const stored = readAdminRegistration(globalThis.localStorage, resolveElectionId());
    const registered = stored && state.address && stored.address.toLowerCase() === state.address.toLowerCase() ? stored : null;
    fill(
      box,
      electionStartNodes({
        address: state.address,
        connect: state.address ? null : electionConnectControl(),
        onRegister: () => startAdminRegistration({ storage: globalThis.localStorage }),
        onForms: openElectionForms,
        registered,
        wrongNetwork: !!state.address && !onCoston2(),
        organizes: state.roles?.admin ? state.details?.admin ?? [] : [],
      }),
    );
  };
  const onChange = () => {
    if (!ctx.current?.()) {
      document.removeEventListener("beings:admin-registered", onChange);
      document.removeEventListener("beings:election-draft", onChange);
      return;
    }
    paint();
  };
  liveWallet(ctx, paint);
  document.addEventListener("beings:admin-registered", onChange);
  document.addEventListener("beings:election-draft", onChange);
  return box;
}

/** Short sign-in line. Returns null once a wallet is connected, so it never sits on the page as an empty box. */
export function roleSignInNodes({ address, onConnect, detail } = {}) {
  if (address) return null;
  return h(
    "div",
    { class: "role-signin" },
    h("p", null, h("strong", null, ROLE_SIGNIN_PROMPT), detail ? h("span", { class: "muted" }, ` ${detail}`) : null),
    h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: () => onConnect?.() }, icon("wallet", { size: 16 }), "Connect wallet"),
  );
}

/**
 * A role's own sign-in prompt, inside that role's panel. Hidden once connected.
 * `whenConnected` can add role-only follow-up (the verifier registration form). It is not a wallet box.
 */
export function roleAccess(ctx, { roleId, detail, whenConnected } = {}) {
  const box = h("div", { class: "role-access", "data-role": roleId });
  liveWallet(ctx, () => {
    const prompt = roleSignInNodes({ address: state.address, onConnect: openHeaderWallet, detail });
    const extra = state.address && whenConnected ? whenConnected() : null;
    box.hidden = !prompt && !extra;
    fill(box, prompt, extra);
  });
  return box;
}

// ------------------------------------------------------------------ election picker
let listPromise;
export const forgetElections = () => (listPromise = null);

async function listElections() {
  if (!listPromise) {
    listPromise = (async () => {
      const { elections } = await discoverElections().catch(() => ({ elections: [] }));
      const rows = await Promise.all(
        elections.map(async (hint) => {
          try {
            const el = await getElection(hint.code, hint);
            if (!el) return null;
            const f = await loadElectionFile(el).catch(() => null);
            return { code: hint.code, name: f?.file?.name ?? "Election", at: el.version.postedAt, status: el.status };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter(Boolean).sort((a, b) => b.at - a.at);
    })();
  }
  return listPromise;
}

/** Everything one election needs on a role screen: ledger summary, file (with its check), questions. */
export async function loadElectionContext(code) {
  const { elections } = await discoverElections().catch(() => ({ elections: [] }));
  const hint = elections.find((e) => e.code === code) ?? {};
  const election = await getElection(code, hint);
  if (!election) return null;
  const fileInfo = await loadElectionFile(election).catch(() => null);
  return { election, fileInfo, file: fileInfo?.file ?? null, name: fileInfo?.file?.name ?? "Election" };
}

/**
 * Draw the picker into `slot` and resolve with the chosen election code (from ?e= or, failing that, the newest one).
 * Choosing another election navigates to `#${path}?e=CODE`, which draws the screen again.
 */
export async function electionPicker(ctx, slot, path, { allowNone = false } = {}) {
  fill(slot, h("section", { class: "card" }, spinner("Finding elections on the ledger…")));
  const list = await listElections();
  if (!ctx.current()) return null;
  const wanted = ctx.query.get("e");
  const code = wanted || (allowNone ? null : list[0]?.code ?? null);
  const select = h("select", { id: `pick-${path.slice(1)}`, "aria-describedby": "pick-hint" }, [...(code && !list.some((l) => l.code === code) ? [{ code, name: "Not listed" }] : []), ...list].map((l) => h("option", { value: l.code, selected: l.code === code }, `${l.name} (${l.code})`)));
  if (allowNone) select.prepend(h("option", { value: "", selected: !code }, "Choose an election…"));
  select.addEventListener("change", () => (location.hash = select.value ? `#${path}?e=${select.value}` : `#${path}`));
  const typed = h("input", { id: "pick-code", placeholder: "BEINGS-2026-ABC123", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": "Or type an election code" });
  const go = () => typed.value.trim() && (location.hash = `#${path}?e=${encodeURIComponent(typed.value.trim().toUpperCase())}`);
  typed.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), go()));
  fill(slot, 
    h(
      "section",
      { class: "card picker" },
      h("label", { for: select.id }, "Election"),
      h("div", { class: "row" }, select, h("button", { class: "btn", type: "button", onClick: () => (forgetElections(), window.dispatchEvent(new HashChangeEvent("hashchange"))) }, icon("arrow", { size: 16 }), "Refresh")),
      h("details", { class: "details" }, h("summary", null, "Use an election that isn't listed"), h("div", { class: "row" }, typed, h("button", { class: "btn", type: "button", onClick: go }, "Open"))),
      h("p", { id: "pick-hint", class: "hint" }, "Elections are read live from the public ledger."),
    ),
  );
  return code;
}

export const notFoundCard = (code) => h("section", { class: "card" }, callout("warn", "That election isn't on the ledger", `We couldn't find ${code}. Check the code, or pick another election.`));
export const errorCard = (message, retry) => h("section", { class: "card" }, callout("warn", "We couldn't read the ledger", message ?? "This is usually temporary: the public test network can be busy."), retry ? h("button", { class: "btn", type: "button", onClick: retry }, "Try again") : null);

export { skeleton, spinner, fmtDate };

// ------------------------------------------------------------------ the hub
export function renderStaffHub(ctx) {
  const { root } = ctx;
  setTitle("Staff Porthole");
  const cards = STAFF_HUB_ORDER.map((id) => {
    const info = ROLE_INFO[id];
    const unlocked = !!state.roles[id];
    return h(
      "a",
      { class: `card card-link role-card ${unlocked ? "" : "locked"}`, href: info.route, title: info.blurb },
      h("div", { class: "card-top" }, roleMark(info), unlocked ? badge("Unlocked", "ok", "unlock") : badge("Open to read", "neutral")),
      h("h2", null, info.label),
      h("p", { class: "muted" }, info.blurb),
      h("span", { class: "link-cta" }, "Open", icon("arrow", { size: 16 })),
    );
  });
  fill(root, 
    h("header", { class: "page-head" }, h("h1", null, "Staff Porthole"), h("p", { class: "lead" }, "Running or checking an election takes more than voting. Everything here can be read by anyone, because it is all public. A crypto-wallet is only needed to sign a report or change something, and the ledger itself decides which crypto-wallets are allowed to. Open a role to connect, if that role asks you to.")),
    h("div", { class: "staff-grid" }, cards),
    staffWalletsSection(CONFIG.staffWallets, { connected: state.address }),
    h("section", { class: "card soft" }, h("h2", null, "How your crypto-wallet is used"), h("ul", { class: "plain-list" }, h("li", null, h("strong", null, "Connecting "), "only shares your public address."), h("li", null, h("strong", null, "Signing "), "proves who you are (to download ballot images) or signs a report. It costs nothing and changes nothing."), h("li", null, h("strong", null, "Sending "), "changes the public ledger. Each time, a plain-language card tells you exactly what will happen first, and the ledger itself refuses anyone who isn't allowed.")), h("p", null, h("strong", null, "Voters and the public never need a crypto-wallet."))),
  );
}

export { CONFIG };

/** Draw the current page again (after a change went through, so it shows what the ledger now says). */
export function reloadPage() {
  forgetElections();
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
