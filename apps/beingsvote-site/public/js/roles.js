// Optional wallet connection and role detection from the on-chain registries. Both ways are EIP-1193 providers:
//   "browser"       an injected wallet (MetaMask extension or its in-app browser)
//   "walletconnect" Reown AppKit (desktop QR, or a Bifrost deep link on a phone or iPad)
// Connecting a wallet only shares the public address. Nothing is ever signed or sent at connect time: the staff
// screens ask the wallet to sign a message or send a transaction only when a person presses a button for that exact
// step, after a plain-language confirmation (tx.js), and the wallet shows its own prompt on top of that.
// Roles are READ from the contracts with our own RPC connection:
//   Election admin   = the organizer address of at least one election (ElectionRegistry.elections().organizer)
//   Election officer = a registered reviewer in at least one election (ElectionRegistry.roles() == Reviewer)
//   Verifier         = a registered verifier node (VerifierRegistry.nodes().registeredAt != 0)
//   System admin     = on an election roster, a named wallet for local machines and connections (no ballot or certification authority).
//                      The Staff page "Unlocked" mark is still the contract deployer (ElectionRegistry.deployer()), which has no election switches.
// Public and Voter screens never need a wallet.
import { discoverElections, electionKeyOf, readRoleFacts, getEthers } from "./chain.js";
import { CONFIG } from "./config.js";
import { eip1193Signer, formatC2flr } from "./appkit-connect.js";
import { chainIdNumber, networkState, savedWalletKind, walletChainParams, walletChoices, walletConnectConfigured } from "./logic.js";

const staffMark = (file, alt) => ({
  src: `/brand/staff/${file}-256.webp`,
  srcset: `/brand/staff/${file}-128.webp 128w, /brand/staff/${file}-256.webp 256w`,
  alt,
});

export const ROLE_INFO = {
  public: { id: "public", label: "Public", icon: "chart", blurb: "Anyone can read results and see how they were verified." },
  voter: { id: "voter", label: "Voter", icon: "ticket", blurb: "Look up your own ballot with the code on your receipt." },
  verifier: { id: "verifier", label: "Verifier", icon: "shield", mark: staffMark("verifier", "Verifier: a shield in a hexagon network"), blurb: "Independent checkers who download the ballot images, re-count the election and sign what they find.", route: "#/verifier" },
  officer: { id: "officer", label: "Election officer", icon: "clipboard", mark: staffMark("election-officer", "Election officer: a magnifying glass over a document with a green check"), blurb: "Polling-station counts that must balance, plus review of flagged results.", route: "#/officer" },
  admin: { id: "admin", label: "Election Administrator", icon: "users", mark: staffMark("election-admin", "Election Administrator: a key, a ballot box and a crypto-wallet"), blurb: "The organizer who sets up, opens, closes and publishes an election.", route: "#/admin" },
  scanner: { id: "scanner", label: "Scanner operator", icon: "search", readsOnly: true, mark: staffMark("scanner-operator", "Scanner operator: a scanner with a ballot and blockchain cubes"), blurb: "Runs the scanner helper, feeds ballot batches through the scanner and signs each batch for the ledger. Never changes a ballot.", route: "#/scanner" },
  system: { id: "system", label: "System admin", icon: "gear", readsOnly: true, blurb: "Sets up and monitors local resources and connections: scanner computers and helpers, printers, and the network and image-service connections. Has no authority over ballot choices or certification.", route: "#/system" },
};

/** Staff hub card order. Scanner operator is a workstation role, not a wallet unlock. */
export const STAFF_HUB_ORDER = ["admin", "officer", "verifier", "scanner", "system"];

export const state = {
  status: "idle", // idle | connecting | checking | ready | error
  address: null,
  chainId: null, // the wallet's current network (number), or null
  kind: null, // "browser" | "walletconnect" | null: which way the wallet is connected
  balanceText: "", // short C2FLR amount for the header chip; "" until the public RPC answers
  roles: { verifier: false, officer: false, admin: false, system: false },
  details: { verifier: null, officer: [], admin: [], system: null },
  error: null,
};

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn(state));

export function hasWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}
function injected() {
  const e = window.ethereum;
  if (!e) return null;
  return Array.isArray(e.providers) && e.providers.length ? e.providers[0] : e;
}

/** Which ways of connecting this page can offer right now (see logic.js walletChoices). */
export const walletOptions = () => walletChoices({ hasInjected: hasWallet(), projectId: CONFIG.walletConnectProjectId });

// The EIP-1193 provider AppKit (or a direct injected connect) last handed us. getSigner wraps this.
let kitProvider = null;
let kitOwned = false;
export function attachProvider(provider, fromKit = false) {
  kitProvider = provider && typeof provider.request === "function" ? provider : null;
  kitOwned = !!kitProvider && !!fromKit;
}

/** The provider the page is currently using. AppKit's provider when that is how we connected, else the browser wallet. */
function activeProvider() {
  return kitProvider || injected();
}

export const activeRoleIds = () => ["public", "voter", ...Object.keys(state.roles).filter((r) => state.roles[r])];

function reset() {
  state.status = "idle";
  state.address = null;
  state.chainId = null;
  state.kind = null;
  state.balanceText = "";
  state.roles = { verifier: false, officer: false, admin: false, system: false };
  state.details = { verifier: null, officer: [], admin: [], system: null };
  state.error = null;
}

async function readChain(eth) {
  try {
    state.chainId = chainIdNumber(await eth.request({ method: "eth_chainId" }));
  } catch {
    state.chainId = null;
  }
}

/** C2FLR from the public Coston2 RPC. A failure leaves the chip without a figure; it never blocks signing. */
async function loadBalance(address) {
  try {
    const res = await fetch(CONFIG.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    });
    const json = await res.json();
    if (state.address?.toLowerCase() !== String(address).toLowerCase()) return;
    state.balanceText = json?.result ? formatC2flr(json.result) : "";
  } catch {
    if (state.address?.toLowerCase() === String(address).toLowerCase()) state.balanceText = "";
  }
  emit();
}

async function detect(address) {
  state.status = "checking";
  state.address = address;
  state.error = null;
  emit();
  try {
    const eth = activeProvider();
    if (eth) await readChain(eth);
    const { elections } = await discoverElections();
    const withKeys = await Promise.all(elections.map(async (e) => ({ code: e.code, key: await electionKeyOf(e.code) })));
    const facts = await readRoleFacts(address, withKeys);
    const lc = address.toLowerCase();
    state.roles.system = facts.deployer.toLowerCase() === lc;
    state.details.system = state.roles.system ? { deployer: facts.deployer } : null;
    state.details.admin = facts.perElection.filter((e) => e.organizer.toLowerCase() === lc).map((e) => e.code);
    state.roles.admin = state.details.admin.length > 0;
    state.details.officer = facts.perElection.filter((e) => e.role === 2).map((e) => e.code);
    state.roles.officer = state.details.officer.length > 0;
    state.roles.verifier = facts.node.registeredAt > 0;
    state.details.verifier = state.roles.verifier ? { name: facts.node.name } : null;
    state.status = "ready";
    void loadBalance(address);
  } catch (e) {
    state.status = "error";
    state.error = "We couldn't check your wallet against the public registries just now. You can still use the public and voter pages.";
  }
  emit();
}

/** Remember a wallet AppKit has already approved, and read its roles. */
export async function adoptWallet(address, kind) {
  state.kind = kind === "walletconnect" ? "walletconnect" : "browser";
  try {
    localStorage.setItem("beings.wallet", state.kind);
  } catch {
    /* private mode */
  }
  await detect(address);
}

/**
 * Connect an injected wallet (MetaMask extension or its in-app browser). Phone wallets go through AppKit
 * (`openConnect` in appkit-client.js): a QR code on a computer, a Bifrost link on a phone or iPad.
 */
export async function connect(kind = "browser") {
  if (kind === "walletconnect") {
    const { openConnect } = await import("./appkit-client.js");
    return openConnect();
  }
  const eth = injected();
  if (!eth) throw new Error("NO_WALLET");
  state.status = "connecting";
  emit();
  try {
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    if (!accounts?.length) throw new Error("No account was shared.");
    attachProvider(eth, false);
    state.kind = "browser";
    localStorage.setItem("beings.wallet", "browser");
    await detect(accounts[0]);
  } catch (e) {
    reset();
    emit();
    throw e;
  }
}

/** Drop a connection attempt that has not produced an address. Does not invent a timeout. */
export function cancelConnect() {
  if (state.status === "connecting" && !state.address) {
    reset();
    emit();
  }
}

export function disconnect(closeSession = true) {
  const owned = kitOwned;
  try {
    localStorage.removeItem("beings.wallet");
  } catch {
    /* private mode */
  }
  attachProvider(null);
  reset();
  emit();
  if (closeSession && owned) import("./appkit-client.js").then((m) => m.disconnectModal()).catch(() => {});
}

/** On page load: if the person connected before and the wallet still allows it, re-check silently (no pop-up). */
export async function restore() {
  const eth = injected();
  if (eth?.on) {
    eth.on("chainChanged", (id) => {
      if (!state.address || state.kind !== "browser") return;
      state.chainId = chainIdNumber(id);
      emit();
    });
    eth.on("accountsChanged", (accounts) => {
      if (state.kind !== "browser" && savedWalletKind(localStorage.getItem("beings.wallet")) !== "browser") return;
      if (!accounts?.length) disconnect();
      else detect(accounts[0]);
    });
  }
  const saved = savedWalletKind(localStorage.getItem("beings.wallet"));
  if (!saved) return;
  try {
    if (saved === "walletconnect") {
      if (!walletConnectConfigured(CONFIG)) return disconnect(false);
      const { restoreModal } = await import("./appkit-client.js");
      if (!(await restoreModal())) disconnect(false);
      return;
    }
    if (!eth) return;
    const accounts = await eth.request({ method: "eth_accounts" });
    if (accounts?.length) {
      attachProvider(eth, false);
      state.kind = "browser";
      await detect(accounts[0]);
    } else disconnect();
  } catch {
    /* stay signed out */
  }
}

// ------------------------------------------------------------------ writing through the wallet
export const onCoston2 = () => networkState(state.chainId, CONFIG.chainId) === "ok";

/** Read the roles again (after a transaction that may have changed them). */
export async function recheck() {
  if (state.address) await detect(state.address);
}

/** Ask the wallet to switch to Coston2, adding the network first if the wallet doesn't know it. The wallet asks the person. */
export async function ensureCoston2() {
  const eth = activeProvider();
  if (!eth) throw new Error("NO_WALLET");
  const params = walletChainParams(CONFIG);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] });
  } catch (e) {
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized chain|not been added/i.test(e?.message ?? "")) {
      await eth.request({ method: "wallet_addEthereumChain", params: [params] });
    } else throw e;
  }
  await readChain(eth);
  emit();
}

/** An ethers signer for the connected account. A fresh provider every time, because ethers fixes the network when it is made. */
export async function getSigner() {
  const eth = activeProvider();
  if (!eth || !state.address) throw new Error("NO_WALLET");
  const ethers = await getEthers();
  return eip1193Signer(eth, state.address, ethers);
}
