// Settings for the B.E.I.N.G.S. site. Everything here is public information (addresses on a public test network).
export const CONFIG = {
  chainId: 114,
  chainName: "Flare Coston2 (test network)",
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
  // Block the current contracts were deployed in. Log searches for this set start here.
  // Ballot-pool contracts (PR #15, source f49caea), deployed on Coston2 2026-11-14.
  // New elections are created on `contracts` only. Reads also try `legacySets` (see contractSetsForRead).
  deployBlock: 37873904,
  contracts: {
    registry: "0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A",
    ledger: "0x5d00bE9A32DcF1FcDe9475C8Be874aE8af0fCf0b",
    tally: "0xeDaBF1D8597FC4CA0aB71fcF0E91a0be966E7892",
    verifiers: "0x360e9d558DEc99a2E2F81Cf925424ba399492bDc",
  },
  // Earlier Coston2 deployments that still hold elections. Each set has the block it was deployed in, so log
  // searches do not start at genesis. Writes never use this list.
  legacySets: [
    {
      id: "pre-pool",
      deployBlock: 37317124,
      contracts: {
        registry: "0x651A078e51B69Eff17e22950573EbE0252f43E63",
        ledger: "0xF579913c90b86f102Fff8D07c6c16f465495013C",
        tally: "0x9844040a1B4BEC18a384d68F29cE2bd5D24cB4f4",
        verifiers: "0xdb6A83242139E3b7D47c31588d8d06c64CE94316",
      },
    },
  ],
  // ElectionNotes (officials' notes and record fingerprints). Empty until it is deployed on Coston2: while it is empty,
  // the Results page shows election records in "signed file only" mode and the admin page can sign but not post notes.
  notesContract: "",
  // StaffRegistry on Coston2. Deploy tx 0xf628baa51be82c51fa360ac7da10b0c902dd5de4ede45a14ad12ec53a03bb067, block 37963247.
  // It reads the live ElectionRegistry above. The four contracts above stay as they are.
  staffRegistry: "0x7e519d972e61929f54d9f316eA79F6BB51dAf635",
  // Local Scanner/Printer station wallets the admin page offers in "Register Scanner/Printer" (public addresses only, never
  // keys). The organizer can always paste a different address instead. Empty list = the page asks for a pasted address.
  scannerStations: [
    { label: "B.E.I.N.G.S. classroom signing wallet (Coston2 test)", address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D" },
  ],
  // Staff and official wallets shown on the Staff page (public addresses that already act on chain). Add a row per
  // person or station. `name` is an optional display label kept on this website only; it is never written on chain.
  // `role` is the plain label; `areas` says what the wallet looks after. The ledger, not this list, decides permissions.
  staffWallets: [
    { role: "Organizer", name: ":James-Hugh: Lamb.", areas: "B.E.I.N.G.S. classroom test elections on Coston2, such as BEINGS-2026-QB1TTH", address: "0xFdAC058d47dc99A70f076523c95a5c97b3805bBB" },
    { role: "Scanner/Printer station", name: "", areas: "Classroom signing wallet that records ballot readings for registered elections", address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D" },
  ],
  // Ballot images. The path is the API; imageServiceBase sends it to the Cloudflare R2 Worker.
  imagesApi: "/api/images",
  // Credential-free https origin. Pages call this first. An unsafe value is ignored and the call stays on this site.
  imageServiceBase: "https://beings-ballot-images.beingsvote-test.workers.dev",
  // Public copy of the election-file fallback list (see data/elections.json).
  knownElectionsUrl: "data/elections.json",
  // ethers v6 from a CDN (with an integrity hash), falling back to the copy in /vendor.
  ethers: {
    cdn: "https://cdn.jsdelivr.net/npm/ethers@6.17.0/dist/ethers.umd.min.js",
    integrity: "sha384-lApM4ELRuFNT7NgNqnXB2zFWgSDdhVvmnOHov2DPJz/2zuNpZImXBeklFr18ilvi",
    local: "vendor/ethers.umd.min.js",
  },
  // Where "report a problem" messages and the contact form should go. Empty = the contact page can only copy the message.
  reportEmail: "report@beingsvote.live",
  // Public comments (off-chain, on the image Worker). An unsafe commentsServiceBase is ignored and the section stays quiet.
  // Until that Worker is redeployed with the comments routes, Home and How it works show a note instead of throwing.
  commentsApi: "/api/comments",
  commentsServiceBase: "https://beings-ballot-images.beingsvote-test.workers.dev",
  // Cloudflare Turnstile site key (public). Empty turns comment submission off, with a note. The secret is a Worker secret.
  turnstileSiteKey: "",
  // Printed on ballot receipts (the check-page QR). Always this public origin.
  // A preview or the page's own hostname must not be baked into a ballot.
  siteOrigin: "https://beingsvote.live",
  // Reown / WalletConnect project id (public, not a secret). Create one at https://dashboard.reown.com and allow
  // beingsvote.live plus any Netlify preview host. While it is empty, Connect cannot open a phone wallet.
  walletConnectProjectId: "8a7a9fdb10da4f8b27e2dac859b49529",
  // Reown AppKit, built from tools/appkit-vendor. Loaded only when someone connects a wallet.
  appKitLib: "vendor/appkit.js",
  // Separate WalletConnect session for linking a staff wallet (tools/walletconnect-vendor). The administrator's AppKit session stays up.
  walletConnectLib: "vendor/walletconnect.js",
  // IPFS gateway used when an election file is published under an ipfs:// CID.
  ipfsGateway: "https://ipfs.io/ipfs/",
};

/** Address of a contract by its abi.js name ("registry", "ledger", "tally", "verifiers", "notes"); "" if not configured.
 *  Always the current set. Transactions and new elections use this, never a legacy set. */
export function contractAddress(name) {
  if (name === "notes") return String(CONFIG.notesContract || "");
  if (name === "staff") return String(CONFIG.staffRegistry || "");
  return CONFIG.contracts[name] ?? "";
}

function completeSet(set, fallbackId) {
  const c = set?.contracts;
  if (!c?.registry || !c?.ledger || !c?.tally || !c?.verifiers) return null;
  const deployBlock = Number(set.deployBlock);
  if (!Number.isSafeInteger(deployBlock) || deployBlock < 0) return null;
  return { id: String(set.id || fallbackId), deployBlock, contracts: c };
}

/** Current set first, then each earlier deployment. Incomplete rows are dropped. */
export function contractSets(config = CONFIG) {
  const current = completeSet({ id: "current", deployBlock: config.deployBlock, contracts: config.contracts }, "current");
  const legacy = (Array.isArray(config.legacySets) ? config.legacySets : []).map((set, i) => completeSet(set, `legacy-${i}`)).filter(Boolean);
  return current ? [current, ...legacy] : legacy;
}

/**
 * Order for a read. When the caller already knows which deployment an election lives on (`hint.set` or
 * `hint.contractSet.id`, a set id or that set's registry address), that set is tried first. The current set
 * and any other legacy sets follow, so a stale hint still finds the election.
 */
export function contractSetsForRead(hint, config = CONFIG) {
  const sets = contractSets(config);
  const want = hint?.set ?? hint?.contractSet?.id ?? "";
  if (!want) return sets;
  const wantStr = String(want).toLowerCase();
  const picked = sets.find((s) => s.id.toLowerCase() === wantStr || s.contracts.registry.toLowerCase() === wantStr);
  if (!picked || picked === sets[0]) return sets;
  return [picked, ...sets.filter((s) => s !== picked)];
}

/** Credential-free https origin, or "" when the value is empty or unsafe. */
export function safeServiceOrigin(value) {
  const base = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(base)) return "";
  return base;
}

/** Absolute comments URL, or "" when commentsServiceBase is empty or unsafe. A relative path is not used. */
export function resolveCommentsUrl(path = "/api/comments", config = CONFIG) {
  const base = safeServiceOrigin(config.commentsServiceBase);
  if (!base) return "";
  return base + (String(path).startsWith("/") ? String(path) : `/${path}`);
}

/** Public Turnstile site key, or "" when it is missing or not a site-key shape. */
export function turnstileSiteKey(config = CONFIG) {
  const key = String(config.turnstileSiteKey || "").trim();
  return /^[0-9A-Za-z_-]{8,200}$/.test(key) ? key : "";
}

/** Same-origin path unless imageServiceBase is a credential-free https origin. Unsafe values are ignored. */
export function resolveImagePath(path) {
  const base = String(CONFIG.imageServiceBase || "").trim().replace(/\/+$/, "");
  if (!base) return path;
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(base)) return path;
  return base + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * GET an image URL. The Worker is tried first. A 404, or a browser block such as CORS, is tried once
 * on this site, which can still read unexpired Netlify Blobs and does not write. A verifier manifest
 * that the Worker accepts is also read from this site, because that response already includes those Blobs.
 * POST is not retried.
 */
export async function fetchImageApi(url, init, fetchImpl = fetch) {
  const method = String(init?.method || "GET").toUpperCase();
  const fallback = method === "GET" ? sameOriginImageUrl(url) : null;
  let res = null;
  let thrown = null;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    thrown = err;
  }
  if (!fallback) {
    if (thrown) throw thrown;
    return res;
  }
  const manifest = imagePathname(url) === "/api/verifier/images";
  const needFallback = thrown || res.status === 404 || (manifest && res.ok);
  if (!needFallback) return res;
  let again;
  try {
    again = await fetchImpl(fallback, init);
  } catch (err) {
    if (thrown) throw thrown;
    return res;
  }
  if (thrown) return again;
  if (res.status === 404) return again.status === 404 ? res : again;
  if (manifest && res.ok && again.ok) return again;
  return res;
}

function imagePathname(url) {
  try {
    return new URL(url, "https://beingsvote.live").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

/** Path on this site for a Worker image URL, or null when the URL is already local or not an image route. */
function sameOriginImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url, "https://beingsvote.live");
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/api/images" && !path.startsWith("/api/verifier/images")) return null;
  const base = String(CONFIG.imageServiceBase || "").trim().replace(/\/+$/, "");
  if (!base || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(base) || parsed.origin !== base) return null;
  return parsed.pathname + parsed.search;
}
