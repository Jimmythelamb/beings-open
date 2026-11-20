// A second WalletConnect session used only to link a staff wallet.
// It does not use the page's connected-wallet provider, and it does not read or write the saved wallet kind,
// so the Election Administrator's own connection stays up.
// The Reown project and the Bifrost link are the same ones the site already uses.
// beingsvote.live is the origin allowlisted for that project. metadata.url is the page origin,
// which is https://beingsvote.live on the live site.
import { CONFIG } from "./config.js";
import { buildClaimMessage } from "./roster.js";
import { explainWalletConnectError, isAddress, qrSvgPath, sameAddress, walletConnectOptions, walletDeepLinks } from "./logic.js";
import { fill, h, icon, callout, spinner } from "./ui.js";

export const STAFF_LINK_PREFIX = "beings-staff-link";
export const STAFF_LINK_BUTTON = "Link staff wallet (scan QR)";
const NS = "http://www.w3.org/2000/svg";

/** Options for the staff provider. A different storage prefix from the administrator's session. Signing only: no send. */
export function staffSessionOptions(config, origin) {
  return {
    ...walletConnectOptions(config, origin),
    customStoragePrefix: STAFF_LINK_PREFIX,
    optionalMethods: ["personal_sign", "eth_signTypedData_v4", "eth_requestAccounts", "eth_accounts"],
    optionalEvents: ["accountsChanged", "chainChanged", "disconnect"],
  };
}

/** UTF-8 message as the 0x hex string personal_sign expects. */
export function utf8ToHex(text) {
  const bytes = new TextEncoder().encode(String(text));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Same black-on-white QR as the main wallet dialog, drawn from logic.js qrSvgPath. */
export function staffQrElement(uri, matrixFor) {
  let shape;
  try {
    shape = qrSvgPath(matrixFor(uri));
  } catch {
    return h("p", { class: "muted" }, "The QR code couldn't be drawn. Use Open Bifrost Wallet instead.");
  }
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${shape.size} ${shape.size}`);
  svg.setAttribute("width", String(shape.size));
  svg.setAttribute("height", String(shape.size));
  svg.setAttribute("class", "wallet-qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for linking a staff wallet");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", shape.size);
  bg.setAttribute("height", shape.size);
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", shape.d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return h("div", { class: "wallet-qr-wrap" }, svg);
}

function showDialog(dlg) {
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

/**
 * The QR dialog. `showUri` draws the code. Closing the dialog calls `onCancel`.
 * Tests and screenshots can open this with a synthetic wc: string and never touch the network.
 */
export function createStaffLinkDialog({ firstName, lastName, position, onCancel, matrixFor } = {}) {
  const qrSlot = h("div", { class: "wallet-qr-slot" });
  const status = h("div", { class: "wallet-qr-status", role: "status" });
  const bifrost = h(
    "a",
    { class: "btn wallet-choice wallet-choice-short", href: "bifrostwallet://", hidden: true },
    icon("phone", { size: 16 }),
    h("span", null, "Open Bifrost Wallet"),
  );
  let uri = "";
  const closeBtn = h("button", { class: "icon-btn lg", type: "button", "aria-label": "Close" }, icon("x", { size: 20 }));
  const dlg = h(
    "dialog",
    { class: "staff-link-dialog", "aria-labelledby": "staff-link-title" },
    h(
      "div",
      { class: "dialog-card" },
      h("div", { class: "dialog-head" }, h("h2", { id: "staff-link-title" }, "Link staff wallet"), closeBtn),
      h("p", null, `${firstName} ${lastName} scans this code with Bifrost and signs that they hold the wallet and accept ${position}.`),
      h("p", { class: "muted small" }, "This is a separate connection. The wallet already connected on this computer stays connected. Nothing is written to the blockchain."),
      h("div", { class: "wallet-connect-qr" }, qrSlot, status),
      h("div", { class: "actions" }, bifrost),
    ),
  );
  const showLoading = (text = "Getting a connection code…") => fill(status, spinner(text));
  const showError = (message) => {
    fill(qrSlot);
    fill(status, callout("warn", "That didn't connect", message));
  };
  const showUri = (next, draw = matrixFor) => {
    uri = next;
    const link = walletDeepLinks(next).find((l) => l.id === "bifrost");
    if (link) {
      bifrost.href = link.href;
      bifrost.hidden = false;
    }
    fill(status, h("p", { class: "muted small" }, "Scan with Bifrost on their phone. They will be asked to sign. The signature only proves they hold the wallet."));
    fill(qrSlot, staffQrElement(next, draw));
  };
  const close = () => {
    if (dlg.open && typeof dlg.close === "function") dlg.close();
    dlg.remove();
  };
  const requestClose = () => {
    onCancel?.();
    close();
  };
  closeBtn.addEventListener("click", requestClose);
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    requestClose();
  });
  document.body.append(dlg);
  showLoading();
  showDialog(dlg);
  closeBtn.focus();
  return { dlg, bifrost, showLoading, showError, showUri, close, get uri() { return uri; } };
}

async function defaultLoadProvider(options) {
  if (options?.customStoragePrefix !== STAFF_LINK_PREFIX) throw new Error("Staff linking must use its own WalletConnect session.");
  const lib = await import(new URL(CONFIG.walletConnectLib, document.baseURI).href);
  return lib.EthereumProvider.init(options);
}

async function defaultMatrixFor(text) {
  const lib = await import(new URL(CONFIG.walletConnectLib, document.baseURI).href);
  return lib.qrMatrix(text);
}

async function defaultVerifyMessage(message, signature) {
  const { loadEthers } = await import("./chain.js");
  const ethers = await loadEthers();
  return ethers.verifyMessage(message, signature);
}

/**
 * Open the QR, wait for a staff wallet, ask it for personal_sign, check the signer, then disconnect that session.
 * Resolves { status: "signed", address, message, signature, nonce, signedAt } or cancelled / failed.
 * Never reads a private key. The returned address is the one recovered from the signature.
 */
export async function linkStaffWallet({
  firstName,
  lastName,
  position,
  electionCode,
  loadProvider = defaultLoadProvider,
  matrixFor = defaultMatrixFor,
  verifyMessage = defaultVerifyMessage,
  now = () => new Date().toISOString(),
  nonce = randomNonce(),
  chainOnly = false,
  chainTypedDataFor,
  origin = globalThis.location?.origin,
  config = CONFIG,
  uriTimeoutMs = 0,
  openDialog = createStaffLinkDialog,
} = {}) {
  let provider = null;
  let dialog = null;
  let settled = false;
  let timer;
  let cancelConnect = () => {};
  const cancelled = new Promise((_, reject) => {
    cancelConnect = () => reject(new Error("CANCELLED"));
  });
  cancelled.catch(() => {});
  const finishCancel = () => {
    if (settled) return;
    cancelConnect();
  };
  try {
    dialog = openDialog({ firstName, lastName, position, onCancel: finishCancel, matrixFor });
    const options = staffSessionOptions(config, origin || "https://beingsvote.live");
    provider = await Promise.race([Promise.resolve().then(() => loadProvider(options)), cancelled]);
    if (provider?.session && typeof provider.disconnect === "function") {
      await provider.disconnect().catch(() => {});
    }
    let sawUri = false;
    const onUri = (uri) => {
      const link = typeof uri === "string" ? uri : uri?.uri;
      if (typeof link !== "string" || !link.startsWith("wc:")) return;
      sawUri = true;
      clearTimeout(timer);
      dialog.showUri(link, matrixFor);
    };
    provider.on?.("display_uri", onUri);
    const noUri = uriTimeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (!sawUri) reject(new Error("NO_URI"));
          }, uriTimeoutMs);
        })
      : null;
    noUri?.catch(() => {});
    const connected = Promise.resolve().then(() => provider.connect());
    connected.catch(() => {});
    await Promise.race([connected, noUri, cancelled].filter(Boolean));
    clearTimeout(timer);
    const address = provider.accounts?.[0];
    if (!isAddress(address || "")) throw new Error("No account was shared.");
    const signedAt = now();
    let message = "";
    let signature = "";
    let recovered = address;
    if (!chainOnly) {
      message = buildClaimMessage({ firstName, lastName, position, electionCode, nonce, signedAt });
      signature = await Promise.race([
        provider.request({ method: "personal_sign", params: [utf8ToHex(message), address] }),
        cancelled,
      ]);
      recovered = await verifyMessage(message, signature);
      if (!sameAddress(recovered, address)) throw new Error("The signature did not come from the wallet that scanned the code.");
    }
    let chainSignature = null;
    let chainNonce = null;
    let chainNameHash = null;
    if (typeof chainTypedDataFor === "function") {
      const built = await chainTypedDataFor(address);
      chainNonce = built.nonce;
      chainNameHash = built.nameHash;
      const payload = JSON.stringify({ domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.message });
      chainSignature = await Promise.race([
        provider.request({ method: "eth_signTypedData_v4", params: [address, payload] }),
        cancelled,
      ]);
    }
    settled = true;
    dialog.close();
    return { status: "signed", address: recovered, message, signature, nonce, signedAt, chainSignature, chainNonce, chainNameHash };
  } catch (e) {
    const wentAway = settled || e?.message === "CANCELLED";
    if (wentAway) {
      dialog?.close();
      return { status: "cancelled" };
    }
    const message = explainWalletConnectError(e);
    dialog?.showError(message);
    return { status: "failed", message };
  } finally {
    settled = true;
    clearTimeout(timer);
    try {
      await provider?.disconnect?.();
    } catch {
      /* the staff session is already gone */
    }
  }
}
