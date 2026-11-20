// Register the Election Administrator: connect the existing wallet dialog, ask for a name, sign an
// EIP-191 message, check the signature, and store it on the roster. No transaction is sent.
import { toast, h } from "./ui.js";
import { state, subscribe } from "./roles.js";
import { getEthers } from "./chain.js";
import { signWithCard } from "./tx.js";
import { isAddress, sameAddress } from "./logic.js";
import { ELECTION_CODE_RE } from "./format.js";
import { revealStartHere } from "./start-here.js";
import {
  NEW_ELECTION_ID,
  REGISTER_ADMIN_LABEL,
  adminRegistrationMessage,
  cleanName,
  emptyRoster,
  loadRoster,
  parseAdminRegistration,
  readAdminRegistration,
  recordAdminRegistration,
  saveAdminRegistration,
} from "./roster.js";

export { REGISTER_ADMIN_LABEL };

let running = false;

/** The election id to sign: an explicit code, the draft code on the form, the open election, or "new election". */
export function resolveElectionId({ electionCode, doc = globalThis.document } = {}) {
  const given = String(electionCode ?? "").trim();
  if (given.toLowerCase() === NEW_ELECTION_ID) return NEW_ELECTION_ID;
  if (ELECTION_CODE_RE.test(given.toUpperCase())) return given.toUpperCase();
  const draft = String(doc?.getElementById?.("c-code")?.value ?? "").trim().toUpperCase();
  if (ELECTION_CODE_RE.test(draft)) return draft;
  const hash = String(globalThis.location?.hash ?? "");
  const query = new URLSearchParams(hash.split("?")[1] || "").get("e") || "";
  if (ELECTION_CODE_RE.test(query.trim().toUpperCase())) return query.trim().toUpperCase();
  return NEW_ELECTION_ID;
}

/** First and last name. Skips the dialog when both are already filled in. */
export function askAdminNames({ first = "", last = "" } = {}) {
  const readyFirst = cleanName(first);
  const readyLast = cleanName(last);
  if (readyFirst && readyLast) return Promise.resolve({ firstName: readyFirst, lastName: readyLast });
  return new Promise((resolve) => {
    const firstIn = h("input", { id: "admin-reg-first", autocomplete: "given-name", value: readyFirst, "aria-label": "First name" });
    const lastIn = h("input", { id: "admin-reg-last", autocomplete: "family-name", value: readyLast, "aria-label": "Last name" });
    const hint = h("p", { class: "hint", role: "status" });
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    const onClose = () => close(null);
    const dlg = h(
      "dialog",
      { class: "admin-name-dialog", "aria-labelledby": "admin-reg-title" },
      h(
        "div",
        { class: "dialog-card" },
        h("h2", { id: "admin-reg-title" }, "Your name"),
        h("p", null, "Enter the first and last name that will sign as Election Administrator. It is stored with your wallet on this computer."),
        h("label", { class: "roster-field" }, "First name", firstIn),
        h("label", { class: "roster-field" }, "Last name", lastIn),
        hint,
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn", type: "button", onClick: () => close(null) }, "Cancel"),
          h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onClick: () => {
                const firstName = cleanName(firstIn.value);
                const lastName = cleanName(lastIn.value);
                if (!firstName || !lastName) {
                  hint.textContent = "Enter both a first name and a last name.";
                  return;
                }
                close({ firstName, lastName });
              },
            },
            "Continue",
          ),
        ),
      ),
    );
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    firstIn.focus?.();
  });
}

function defaultEnsureWallet() {
  if (state.address) return Promise.resolve(state.address);
  const dialog = document.getElementById("wallet-dialog");
  return new Promise((resolve) => {
    let done = false;
    const finish = (addr) => {
      if (done) return;
      done = true;
      off();
      dialog?.removeEventListener("close", onClose);
      document.removeEventListener("beings:wallet-dismissed", onDismiss);
      resolve(addr || null);
    };
    const off = subscribe(() => {
      if (state.address) finish(state.address);
    });
    const onClose = () => finish(state.address || null);
    const onDismiss = () => finish(state.address || null);
    dialog?.addEventListener("close", onClose);
    document.addEventListener("beings:wallet-dismissed", onDismiss);
    document.dispatchEvent(new CustomEvent("beings:open-wallet"));
    if (!dialog && !state.address) finish(null);
  });
}

async function defaultSign(message, { firstName, lastName, address, electionId }) {
  const r = await signWithCard({
    title: "Register as Election Administrator",
    lines: ["You are signing an EIP-191 message that you will administer this election. The signature is stored with the roster on this computer. It does not create the election and it does not send a transaction."],
    facts: [["Name", `${firstName} ${lastName}`], ["Wallet", address], ["Election", electionId]],
    confirmText: "Sign the registration",
    sign: async (signer) => signer.signMessage(message),
  });
  if (r.status !== "signed") return r;
  return { status: "signed", signature: r.signature };
}

async function defaultVerify() {
  const ethers = await getEthers();
  return (message, signature) => ethers.verifyMessage(message, signature);
}

function finish(electionId, onDone) {
  document.dispatchEvent(new CustomEvent("beings:admin-registered", { detail: { electionId } }));
  const form = document.getElementById("start-here");
  if (form) form.open = true;
  revealStartHere();
  onDone?.();
}

/**
 * Connect if needed, ask for a name, sign, verify, and store the registration.
 * Inject `ensureWallet`, `askNames`, `sign`, and `verify` in tests. No network and no transaction.
 */
export async function startAdminRegistration({
  electionCode,
  organizerAddress = "",
  storage = globalThis.localStorage,
  getAddress = () => state.address,
  ensureWallet = defaultEnsureWallet,
  askNames = askAdminNames,
  readNames,
  sign = defaultSign,
  verify,
  now = () => new Date().toISOString(),
  onDone,
} = {}) {
  if (running) return { status: "failed", message: "Registration is already waiting for you." };
  running = true;
  try {
    let address = getAddress() || "";
    if (!isAddress(address)) {
      address = (await ensureWallet()) || "";
      if (!isAddress(address)) return { status: "cancelled" };
    }
    if (isAddress(organizerAddress) && !sameAddress(organizerAddress, address)) {
      const message = "Connect the wallet that administers this election. It is the one shown at the top right.";
      toast(message);
      return { status: "failed", message };
    }
    const electionId = resolveElectionId({ electionCode });
    const existing = readAdminRegistration(storage, electionId);
    if (existing && sameAddress(existing.address, address)) {
      if (ELECTION_CODE_RE.test(electionId) && existing.electionId === NEW_ELECTION_ID) {
        const parsed = parseAdminRegistration(existing.message);
        const verifyFn = verify || (await defaultVerify());
        const adopted = recordAdminRegistration(loadRoster(storage, electionId, { organizerAddress: parsed.address }), {
          firstName: existing.firstName,
          lastName: existing.lastName,
          address: parsed.address,
          signature: existing.signature,
          at: parsed.at,
          electionId: NEW_ELECTION_ID,
          verify: verifyFn,
        });
        saveAdminRegistration(storage, adopted);
      }
      finish(electionId, onDone);
      return { status: "saved", already: true };
    }
    const typed = readNames?.() ?? {};
    const names = await askNames({ first: typed.first || existing?.firstName || "", last: typed.last || existing?.lastName || "" });
    if (!names) return { status: "cancelled" };
    const at = now();
    const message = adminRegistrationMessage({ firstName: names.firstName, lastName: names.lastName, address, electionId, at });
    const signed = await sign(message, { ...names, address, electionId });
    if (!signed || signed.status === "cancelled") return { status: "cancelled" };
    if (signed.status !== "signed" || !signed.signature) {
      const failed = signed.message || "The wallet didn't sign. Nothing was saved.";
      toast(failed);
      return { status: "failed", message: failed };
    }
    const verifyFn = verify || (await defaultVerify());
    const roster = electionId === NEW_ELECTION_ID
      ? { ...emptyRoster("BEINGS-2026-AAAAAA"), electionCode: NEW_ELECTION_ID }
      : loadRoster(storage, electionId, { organizerAddress: address });
    const saved = recordAdminRegistration(roster, { ...names, address, signature: signed.signature, at, electionId, verify: verifyFn });
    saveAdminRegistration(storage, saved);
    finish(electionId, onDone);
    return { status: "saved", roster: saved };
  } catch (e) {
    const message = String(e?.message ?? e);
    toast(message);
    return { status: "failed", message };
  } finally {
    running = false;
  }
}
