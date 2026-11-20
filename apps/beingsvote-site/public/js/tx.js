// Every action that changes something goes through here, and only here:
//   1. a plain-language confirmation card that says what will happen, on which contract, and that it costs a small
//      network fee in free test coin;
//   2. a dry run against the live chain (so a step that would fail says why, before the wallet is bothered);
//   3. the wallet's own prompt, then the wait for the network, then a link to the transaction.
// Nothing is sent unless the person presses the confirm button on the card and then confirms in the wallet.
import { fill, h, callout, extLink, spinner } from "./ui.js";
import { contractAddress } from "./config.js";
import { ABI } from "./abi.js";
import { getEthers } from "./chain.js";
import { state, getSigner, ensureCoston2, onCoston2, recheck } from "./roles.js";
import { explainError, isUserRejected } from "./logic.js";
import { explorerTx } from "./ui.js";

const dlg = () => document.getElementById("tx-dialog");
const body = () => document.getElementById("tx-body");
const titleEl = () => document.getElementById("tx-title");

let open;
function openDialog(title) {
  titleEl().textContent = title;
  const d = dlg();
  if (!d.open) d.showModal();
  return d;
}

/** A card that asks for a yes or a no. Resolves true / false. `lines` are plain sentences; `facts` is [[label, value]]. */
export function confirmCard({ title, lines = [], facts = [], confirmText = "Confirm", tone = "info", cancelText = "Cancel" }) {
  return new Promise((resolve) => {
    const d = openDialog(title);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.removeEventListener("close", onClose);
      if (d.open) d.close();
      resolve(v);
    };
    const onClose = () => finish(false);
    d.addEventListener("close", onClose);
    document.getElementById("tx-close").onclick = () => finish(false);
    fill(body(), 
      ...lines.map((l) => h("p", null, l)),
      facts.length ? h("dl", { class: "kvs" }, facts.map(([k, v]) => h("div", { class: "kv" }, h("dt", null, k), h("dd", null, v)))) : null,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => finish(false) }, cancelText), h("button", { class: `btn btn-primary`, type: "button", "data-tone": tone, onClick: () => finish(true), id: "tx-confirm" }, confirmText)),
    );
    document.getElementById("tx-confirm").focus();
  });
}

const progress = (text, link) => fill(body(), spinner(text), link ?? null);

/**
 * Send one transaction through the connected wallet.
 *   contract: "registry" | "ledger" | "tally" | "verifiers" | "notes"; method + args as in abi.js.
 *   title / lines / facts: what the confirmation card shows.
 * Resolves { status: "sent", hash, receipt } | { status: "cancelled" } | { status: "failed", message }.
 * Never throws; every failure comes back as a sentence in `message`.
 */
export async function sendTx({ contract, method, args, title, lines, facts, confirmText = "Confirm and send" }) {
  if (open) return { status: "failed", message: "Another step is already waiting for you. Finish or cancel it first." };
  open = true;
  try {
    if (!state.address) return { status: "failed", message: "Connect your crypto-wallet first (top right)." };
    const address = contractAddress(contract);
    if (!address) return { status: "failed", message: "That contract isn't set up on this site yet, so nothing was sent." };
    if (!onCoston2()) {
      const ok = await confirmCard({
        title: "Switch to the test network",
        lines: ["Your crypto-wallet is on a different network. B.E.I.N.G.S. runs on the Flare Coston2 test network. Your crypto-wallet will ask before it switches."],
        confirmText: "Switch network",
      });
      if (!ok) return { status: "cancelled" };
      try {
        await ensureCoston2();
      } catch (e) {
        return { status: "failed", message: explainError(e) };
      }
      if (!onCoston2()) return { status: "failed", message: "Your crypto-wallet is still on another network." };
    }
    const go = await confirmCard({
      title,
      lines: [...lines, "This changes the public ledger and can't be undone. It costs a small network fee, paid in free test coin (C2FLR). Your crypto-wallet will ask you to confirm once more."],
      facts: [...(facts ?? []), ["Contract", `${contract} (${address})`], ["Your address", state.address]],
      confirmText,
    });
    if (!go) return { status: "cancelled" };

    openDialog(title);
    document.getElementById("tx-close").onclick = () => dlg().close();
    progress("Checking this step against the live ledger first…");
    const ethers = await getEthers();
    const signer = await getSigner();
    const c = new ethers.Contract(address, ABI[contract], signer);
    try {
      await c[method].staticCall(...args); // dry run: a revert here is decoded into words, and nothing is sent
    } catch (e) {
      if (!isUserRejected(e)) return showFailure(explainError(e));
    }
    progress("Waiting for you to confirm in your crypto-wallet…");
    let tx;
    try {
      tx = await c[method](...args);
    } catch (e) {
      return showFailure(explainError(e), isUserRejected(e) ? "cancelled" : "failed");
    }
    const link = h("p", null, extLink(explorerTx(tx.hash), "View the transaction"));
    progress("Sent. Waiting for the network to confirm it…", link);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) return showFailure("The network included the transaction but it didn't succeed. Check the transaction link.");
    fill(body(), callout("ok", "Done", "The ledger now shows this change.", "check"), link, h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", onClick: () => dlg().close() }, "Close")));
    recheck().catch(() => {});
    return { status: "sent", hash: tx.hash, receipt };
  } catch (e) {
    return showFailure(explainError(e));
  } finally {
    open = false;
  }
}

function showFailure(message, status = "failed") {
  if (status === "cancelled") {
    if (dlg().open) dlg().close();
    return { status: "cancelled", message };
  }
  fill(body(), callout("warn", "That didn't go through", message, "alert"), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg().close() }, "Close")));
  return { status: "failed", message };
}

/** Ask the wallet to sign, with a short card first. `sign` is async (signer) => signature. Resolves { status, signature?, message? }. */
export async function signWithCard({ title, lines, facts, confirmText = "Sign", sign }) {
  if (!state.address) return { status: "failed", message: "Connect your crypto-wallet first (top right)." };
  const ok = await confirmCard({ title, lines: [...lines, "Signing costs nothing and doesn't change the ledger. Your crypto-wallet will show you what you are signing."], facts, confirmText });
  if (!ok) return { status: "cancelled" };
  try {
    const signer = await getSigner();
    return { status: "signed", signature: await sign(signer) };
  } catch (e) {
    return { status: isUserRejected(e) ? "cancelled" : "failed", message: explainError(e) };
  }
}

