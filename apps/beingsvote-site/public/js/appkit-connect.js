// Pure rules for the Reown AppKit connection. No network and no modal, so the tests can run them.
// Wallet ids are the public WalletGuide explorer ids (not the site's project id).
import { explainWalletConnectError, walletDeepLinks, WALLET_FIREWALL_NOTE } from "./logic.js";
export { explainWalletConnectError as explainConnectError, WALLET_FIREWALL_NOTE };

export const BIFROST_WALLET_ID = "37a686ab6223cd42e2886ed6e5477fce100a4fb565dcd57ed4f81f7c12e93053";
export const METAMASK_WALLET_ID = "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96";
/** Beside the QR, in this order. All wallets and search stay available because includeWalletIds is not set. */
export const FEATURED_WALLET_IDS = [BIFROST_WALLET_ID, METAMASK_WALLET_ID];

/** AppKit view whose desktop screen is the WalletConnect QR. The build places featured wallets beside that QR. */
export const DESKTOP_CONNECT_VIEW = "ConnectingWalletConnectBasic";

/** Hosts the modal calls. Kept in sync with netlify.toml. No wildcards. */
export const APPKIT_CONNECT_HOSTS = [
  "https://rpc.walletconnect.com",
  "https://rpc.walletconnect.org",
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://pulse.walletconnect.com",
  "https://pulse.walletconnect.org",
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
  "https://echo.walletconnect.com",
  "https://echo.walletconnect.org",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
];
export const APPKIT_IMG_HOSTS = [
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
  "https://walletconnect.com",
  "https://walletconnect.org",
];
export const APPKIT_FRAME_HOSTS = [
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://secure.walletconnect.com",
  "https://secure.walletconnect.org",
];

/** Flare Coston2 only. A wallet on another network is asked to switch. */
export function coston2Chain(config) {
  return {
    id: config.chainId,
    caipNetworkId: `eip155:${config.chainId}`,
    chainNamespace: "eip155",
    name: "Flare Testnet Coston2",
    nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: "Coston2 Explorer", url: config.explorer } },
    testnet: true,
  };
}

export function appKitCreateOptions(config, origin) {
  const chain = coston2Chain(config);
  const root = String(origin || "https://beingsvote.live").replace(/\/+$/, "");
  return {
    projectId: String(config.walletConnectProjectId || "").trim(),
    networks: [chain],
    defaultNetwork: chain,
    featuredWalletIds: FEATURED_WALLET_IDS,
    allWallets: "SHOW",
    enableWallets: true,
    enableCoinbase: false,
    enableBaseAccount: false,
    enableNetworkSwitch: true,
    allowUnsupportedChain: false,
    enableReconnect: true,
    enableWalletGuide: false,
    experimental_preferUniversalLinks: false,
    defaultAccountTypes: { eip155: "eoa" },
    customRpcUrls: { [`eip155:${config.chainId}`]: [{ url: config.rpcUrl }] },
    metadata: {
      name: "B.E.I.N.G.S.",
      description: "Blockchain-audited paper ballots (Coston2 test network)",
      url: root,
      icons: [`${root}/favicon.svg`],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
      history: false,
      send: false,
      receive: false,
      connectMethodsOrder: ["wallet"],
      connectorTypeOrder: ["featured", "injected", "walletConnect"],
    },
  };
}

/**
 * What the Connect button does.
 * Desktop shows the QR immediately. A phone or iPad with no injected wallet opens Bifrost.
 * An injected wallet (MetaMask extension or its in-app browser) connects directly.
 */
export function connectAction({ mobile, hasInjected }) {
  if (mobile && hasInjected) return "injected";
  if (mobile) return "bifrost";
  return "qr";
}

/** Wallet record AppKit's mobile deep link expects. The scheme is the one Bifrost documents. */
export function bifrostWalletItem() {
  return {
    id: BIFROST_WALLET_ID,
    name: "Bifrost Wallet",
    connectors: [],
    isInjected: false,
    walletInfo: {
      deepLink: "bifrostwallet://",
      description: "Bifrost Wallet",
      linkMode: null,
      supportedChains: ["eip155:114"],
    },
  };
}

export function bifrostHref(uri) {
  return walletDeepLinks(uri).find((l) => l.id === "bifrost")?.href ?? "";
}

/** Wei (bigint, hex or decimal) as a short C2FLR amount for the header chip. */
export function formatC2flr(wei) {
  let n;
  try {
    n = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "";
  }
  if (n < 0n) return "";
  const whole = n / 10n ** 18n;
  const frac = n % 10n ** 18n;
  if (frac === 0n) return `${whole} C2FLR`;
  const digits = frac.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  if (!digits) return whole === 0n ? "<0.0001 C2FLR" : `${whole} C2FLR`;
  return `${whole}.${digits} C2FLR`;
}

/** A small identicon from the address. Same address, same picture. No image host. */
export function addressAvatar(address) {
  const hex = String(address || "").toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const cells = [];
  for (let y = 0; y < 4; y++) {
    const row = [];
    for (let x = 0; x < 3; x++) row.push(parseInt(hex[(y * 3 + x) % hex.length], 16) % 2 === 0);
    cells.push([...row, row[1], row[0]]);
  }
  return { hue: parseInt(hex.slice(0, 2), 16) % 360, cells };
}

/** ethers v6 signer around an EIP-1193 provider (injected wallet or AppKit's WalletConnect provider). */
export function eip1193Signer(provider, address, ethers) {
  if (!provider || typeof provider.request !== "function" || !address) throw new Error("NO_WALLET");
  return new ethers.BrowserProvider(provider).getSigner(address);
}
