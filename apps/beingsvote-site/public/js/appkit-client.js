// Loads the vendored Reown AppKit once, then drives the desktop QR modal and the phone deep link.
// Signing stays in roles.js: getSigner wraps whatever EIP-1193 provider AppKit (or the browser) handed us.
import { CONFIG } from "./config.js";
import { loadEthers } from "./chain.js";
import { chainIdNumber, isMobileDevice, walletConnectConfigured } from "./logic.js";
import { toast } from "./ui.js";
import {
  DESKTOP_CONNECT_VIEW,
  appKitCreateOptions,
  bifrostHref,
  connectAction,
  explainConnectError,
} from "./appkit-connect.js";
import { adoptWallet, attachProvider, connect, ensureCoston2, hasWallet, state } from "./roles.js";

let modal = null;
let modalPromise = null;
let pairing = null;
let lastError = null;
let askedSwitch = false;

function themeMode() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "dark" || set === "light") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function noteChain(chainId) {
  const id = chainIdNumber(chainId);
  if (!state.address || id == null) return;
  state.chainId = id;
  if (id !== CONFIG.chainId && !askedSwitch) {
    askedSwitch = true;
    ensureCoston2().catch(() => {
      askedSwitch = false;
    });
  }
}

function bind(next) {
  next.subscribeProviders((providers) => {
    const p = providers?.eip155;
    if (p) attachProvider(p, true);
  });
  next.subscribeAccount((acc) => {
    if (!acc?.isConnected || !acc.address) return;
    const p = next.getWalletProvider();
    if (p) attachProvider(p, true);
    const type = String(next.getWalletProviderType() || "");
    const kind = /walletconnect/i.test(type) ? "walletconnect" : "browser";
    if (state.address?.toLowerCase() !== acc.address.toLowerCase()) adoptWallet(acc.address, kind);
    noteChain(next.getChainId());
  });
  next.subscribeNetwork?.((net) => noteChain(net?.chainId));
  next.subscribeEvents?.((ev) => {
    const data = ev?.data ?? ev;
    const name = data?.event;
    const message = data?.properties?.message;
    if ((name === "CONNECT_ERROR" || name === "CONNECT_PROXY_ERROR") && message) {
      lastError = new Error(String(message));
      const text = explainConnectError(lastError);
      if (!/declined/i.test(text)) toast(text);
    }
  });
  let wasOpen = false;
  next.subscribeState?.((s) => {
    const open = !!s?.open;
    if (wasOpen && !open && !state.address) document.dispatchEvent(new CustomEvent("beings:wallet-dismissed"));
    wasOpen = open;
  });
}

function ensureModal() {
  if (!walletConnectConfigured(CONFIG)) throw new Error("Connecting a phone wallet isn't switched on for this site yet.");
  modalPromise ??= (async () => {
    await loadEthers();
    const lib = await import(new URL(CONFIG.appKitLib, document.baseURI).href);
    const created = lib.createAppKit({
      ...appKitCreateOptions(CONFIG, location.origin),
      adapters: [new lib.EthersAdapter()],
      themeMode: themeMode(),
    });
    await created.ready();
    bind(created);
    modal = created;
    return created;
  })().catch((e) => {
    modalPromise = null;
    throw e;
  });
  return modalPromise;
}

/** Start the WalletConnect pairing without a deadline. The URI arrives on its own; the approval ends the promise. */
function startPairing() {
  pairing ??= (async () => {
    const next = await ensureModal();
    let uri = next.getWalletConnectUri?.()?.wcUri || "";
    const uriReady = uri
      ? Promise.resolve(uri)
      : new Promise((resolve, reject) => {
          const stop = next.subscribeWalletConnectUri(() => {
            const snap = next.getWalletConnectUri();
            if (snap?.wcUri) {
              stop();
              resolve(snap.wcUri);
            } else if (snap?.wcError) {
              stop();
              reject(lastError || new Error("The WalletConnect relay did not return a connection code."));
            }
          });
        });
    const pending = next.prefetchWalletConnectUri().catch((e) => {
      lastError = e instanceof Error ? e : new Error(String(e?.message || e || "The wallet connection failed."));
      throw lastError;
    });
    pending.catch(() => {});
    return { modal: next, uriReady };
  })().catch((e) => {
    pairing = null;
    throw e;
  });
  return pairing;
}

/** On a phone or iPad, fetch the pairing link before the tap so the tap can open Bifrost immediately. */
export function prepareMobileConnect() {
  const mobile = isMobileDevice(navigator.userAgent, navigator.maxTouchPoints, navigator.platform);
  if (!mobile || hasWallet() || !walletConnectConfigured(CONFIG)) return;
  startPairing().catch((e) => {
    lastError = e instanceof Error ? e : new Error(String(e?.message || e));
  });
}

async function openQrModal() {
  const next = await ensureModal();
  next.setThemeMode?.(themeMode());
  await next.open({ view: DESKTOP_CONNECT_VIEW });
}

async function openBifrost() {
  if (modal) {
    const ready = modal.getWalletConnectUri?.()?.wcUri;
    const href = ready ? bifrostHref(ready) : "";
    if (href) {
      location.href = href;
      return;
    }
  }
  const { uriReady } = await startPairing();
  const uri = await uriReady;
  const href = bifrostHref(uri);
  if (!href) throw new Error("The connection code was not a WalletConnect link.");
  location.href = href;
}

/** Header Connect. Desktop: QR modal. Phone or iPad: Bifrost. Injected wallet: that wallet. */
export function openConnect() {
  const mobile = isMobileDevice(navigator.userAgent, navigator.maxTouchPoints, navigator.platform);
  const action = connectAction({ mobile, hasInjected: hasWallet() });
  if (action === "injected") return connect("browser");
  if (action === "bifrost") return openBifrost();
  return openQrModal();
}

export async function restoreModal() {
  const next = await ensureModal();
  const acc = next.getAccount?.("eip155");
  if (acc?.isConnected && acc.address) {
    const p = next.getWalletProvider();
    if (p) attachProvider(p, true);
    await adoptWallet(acc.address, "walletconnect");
    noteChain(next.getChainId());
    return true;
  }
  return false;
}

export async function disconnectModal() {
  if (!modal) return;
  try {
    await modal.disconnect();
  } catch {
    /* already gone */
  }
}

export async function closeModal() {
  try {
    await modal?.close();
  } catch {
    /* already closed */
  }
}
