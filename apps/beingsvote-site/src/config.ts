// Runtime configuration, read from environment variables (Netlify: Site configuration > Environment variables).
// Defaults point at the B.E.I.N.G.S. test deployment on Flare Coston2.

export const STORE_NAME = "ballot-images";

export const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const DEFAULT_RPC_URL = "https://coston2-api.flare.network/ext/C/rpc";
// Current ballot-pool contracts (Coston2, deploy block 37873904). New elections are created here.
export const DEFAULT_LEDGER_ADDRESS = "0x5d00bE9A32DcF1FcDe9475C8Be874aE8af0fCf0b";
export const DEFAULT_REGISTRY_ADDRESS = "0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A";
export const DEFAULT_VERIFIER_REGISTRY_ADDRESS = "0x360e9d558DEc99a2E2F81Cf925424ba399492bDc";
// Earlier Coston2 set (deploy block 37317124). Still holds the elections in public/data/elections.json.
// Reads try the current address, then these. Writes and new elections do not.
export const DEFAULT_LEGACY_LEDGER_ADDRESSES = ["0xF579913c90b86f102Fff8D07c6c16f465495013C"] as const;
export const DEFAULT_LEGACY_REGISTRY_ADDRESSES = ["0x651A078e51B69Eff17e22950573EbE0252f43E63"] as const;
export const DEFAULT_LEGACY_VERIFIER_REGISTRY_ADDRESSES = ["0xdb6A83242139E3b7D47c31588d8d06c64CE94316"] as const;
/** Netlify synchronous functions accept request bodies up to 6 MB, so the default stays under that. */
export const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;
export const DEFAULT_MAX_RETENTION_DAYS = 365;
export const MIN_TOKEN_LENGTH = 24;

/**
 * Who may call the verifier-only bulk routes:
 *   registry   only addresses registered in the on-chain VerifierRegistry (default: verification is open)
 *   allowlist  only addresses in VERIFIER_ADDRESSES (fail-closed when the list is empty)
 *   either     allowlist OR registry
 * VerifierRegistry.register() is permissionless (any address can register by paying gas). That is intended:
 * anyone may verify. Requests must still be signed by a registered key; the rate limit and the registration gas
 * cost deter abuse. VERIFIER_ADDRESSES is optional (used by "allowlist" and "either").
 */
export const VERIFIER_AUTH_MODES = ["allowlist", "registry", "either"] as const;
export type VerifierAuthMode = (typeof VERIFIER_AUTH_MODES)[number];

export interface SiteConfig {
  /** Upload secret. Empty string means "not configured": every upload is refused (503). */
  uploadToken: string;
  rpcUrl: string;
  ledgerAddress: string;
  /** ElectionRegistry, used to recognise an election's organizer for bulk image access. */
  registryAddress: string;
  maxImageBytes: number;
  maxRetentionDays: number;
  allowedOrigins: string[];
  verifierRegistryAddress: string;
  /** Earlier BallotLedger addresses. Image reads try `ledgerAddress` first, then these, and stop at the first recorded ballot. */
  legacyLedgerAddresses: string[];
  /** Earlier ElectionRegistry addresses. Organizer checks try `registryAddress` first, then these. */
  legacyRegistryAddresses: string[];
  /** Earlier VerifierRegistry addresses. A verifier registered on any of them (or the current one) may read. */
  legacyVerifierRegistryAddresses: string[];
  /** Lower-case 0x addresses from VERIFIER_ADDRESSES (valid entries only). */
  verifierAddresses: string[];
  verifierAuthMode: VerifierAuthMode;
  /** Per-client request cap for the verifier routes, per minute, per function instance (best effort; the platform rate limit is the hard one). */
  verifierRatePerMinute: number;
  /** Origin+path of public election JSON files, e.g. https://beingsvote.live/data/elections. Empty means derive from the request origin. */
  electionFilesBase: string;
  /** Per-client cap for unauthenticated hash-only image fetches, per minute, per instance. */
  publicImageRatePerMinute: number;
}

type Env = Record<string, string | undefined>;

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Comma/space/newline separated 0x addresses. Malformed entries are dropped (never matched), the rest lower-cased. */
export function parseAddressList(v: string | undefined): string[] {
  return [...new Set((v ?? "").split(/[\s,;]+/).filter((a) => ADDRESS_RE.test(a)).map((a) => a.toLowerCase()))];
}

/** Unset keeps the built-in list. A set value, including an empty one, replaces it (invalid entries are dropped). */
function addressListOrDefault(v: string | undefined, fallback: readonly string[]): string[] {
  if (v === undefined) return [...fallback];
  return parseAddressList(v);
}

/** Current address first, then legacy addresses, with duplicates removed. Invalid entries are skipped. */
export function addressesForRead(current: string | undefined, legacy: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const v = (raw ?? "").trim();
    if (!ADDRESS_RE.test(v)) return;
    if (out.some((a) => a.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };
  push(current);
  for (const a of legacy ?? []) push(a);
  return out;
}

function authMode(v: string | undefined): VerifierAuthMode {
  const m = (v ?? "").trim().toLowerCase();
  return (VERIFIER_AUTH_MODES as readonly string[]).includes(m) ? (m as VerifierAuthMode) : "registry"; // unset or unknown value: the default (open verification)
}

export function loadConfig(env: Env): SiteConfig {
  return {
    uploadToken: env.SCANNER_UPLOAD_TOKEN ?? "",
    rpcUrl: env.RPC_URL?.trim() || DEFAULT_RPC_URL,
    ledgerAddress: env.LEDGER_ADDRESS?.trim() || DEFAULT_LEDGER_ADDRESS,
    registryAddress: env.REGISTRY_ADDRESS?.trim() || DEFAULT_REGISTRY_ADDRESS,
    maxImageBytes: positiveInt(env.MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
    maxRetentionDays: positiveInt(env.MAX_RETENTION_DAYS, DEFAULT_MAX_RETENTION_DAYS),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    verifierRegistryAddress: env.VERIFIER_REGISTRY_ADDRESS?.trim() || DEFAULT_VERIFIER_REGISTRY_ADDRESS,
    legacyLedgerAddresses: addressListOrDefault(env.LEGACY_LEDGER_ADDRESSES, DEFAULT_LEGACY_LEDGER_ADDRESSES),
    legacyRegistryAddresses: addressListOrDefault(env.LEGACY_REGISTRY_ADDRESSES, DEFAULT_LEGACY_REGISTRY_ADDRESSES),
    legacyVerifierRegistryAddresses: addressListOrDefault(env.LEGACY_VERIFIER_REGISTRY_ADDRESSES, DEFAULT_LEGACY_VERIFIER_REGISTRY_ADDRESSES),
    verifierAddresses: parseAddressList(env.VERIFIER_ADDRESSES),
    verifierAuthMode: authMode(env.VERIFIER_AUTH_MODE),
    verifierRatePerMinute: positiveInt(env.VERIFIER_RATE_PER_MINUTE, 240),
    electionFilesBase: (env.ELECTION_FILES_BASE ?? "").trim().replace(/\/$/, ""),
    publicImageRatePerMinute: positiveInt(env.PUBLIC_IMAGE_RATE_PER_MINUTE, 60),
  };
}
