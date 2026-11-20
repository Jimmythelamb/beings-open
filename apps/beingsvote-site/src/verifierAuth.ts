// Verifier authentication for the bulk routes.
//
// The verifier signs a short challenge with its Ethereum key (EIP-191 personal_sign):
//
//     BEINGS-VERIFIER|<election code>|<unix seconds>
//
// and sends it in two headers:
//
//     X-Verifier-Timestamp: <unix seconds, the same number that was signed>
//     X-Verifier-Signature: 0x<65-byte signature, r||s||v>
//
// The server rebuilds the message from the election in the URL and the timestamp header, recovers the signer's address
// and decides whether that address may read. A signature made for another election, or for another timestamp, recovers
// to a different (random) address and is refused like any stranger. Nothing secret crosses the wire, and the signature
// is only good for ~5 minutes. It is not bound to a path or method (every verifier route is a read), so within the
// window a captured header could be replayed for a read: keep TLS on, which Netlify does.
//
// Authorization = the recovered address is (a) in VERIFIER_ADDRESSES, and/or (b) registered in the on-chain
// VerifierRegistry (nodes(address).registeredAt != 0), depending on VERIFIER_AUTH_MODE, or (c) the organizer of
// THIS election (ElectionRegistry.elections(electionKey).organizer). Organizer access does not make pictures
// public: the request is still signed, still for one election, and the manifest still omits ballot code hashes.
// VerifierRegistry.register() is permissionless, so "registered" is the strongest on-chain fact there is for verifiers.
import { Interface, verifyMessage } from "ethers";
import { addressesForRead, type SiteConfig } from "./config.js";
import { electionKey, isElectionCode } from "./codes.js";
import type { FetchLike } from "./chain.js";

export const CHALLENGE_PREFIX = "BEINGS-VERIFIER";
export const MAX_SKEW_SECONDS = 300;

export function challengeMessage(electionCode: string, timestamp: string | number): string {
  return `${CHALLENGE_PREFIX}|${electionCode}|${timestamp}`;
}

const registryIface = new Interface(["function nodes(address node) view returns (string name, string infoCid, uint64 registeredAt)"]);
const electionsIface = new Interface([
  "function elections(bytes32 key) view returns (address organizer, uint8 status, uint32 ballotCount, uint32 registeredVoters, uint8 quorum, uint64 opensAt, uint64 closesAt, bytes32 ballotListRoot)",
]);

export type VerifierAuthResult =
  | { ok: true; address: string; via: "allowlist" | "registry" | "organizer" }
  | { ok: false; status: 400 | 401 | 403 | 502 | 503; error: string };

const fail = (status: 400 | 401 | 403 | 502 | 503, error: string): VerifierAuthResult => ({ ok: false, status, error });

export interface VerifierAuthDeps {
  config: SiteConfig;
  now: () => Date;
  fetchImpl?: FetchLike;
  /** Test hook / cache: address -> registered, valid for registryCacheMs. */
  registryCache?: Map<string, { registered: boolean; at: number }>;
  /** Test hook / cache: election code -> organizer address. */
  organizerCache?: Map<string, { organizer: string; at: number }>;
}

const REGISTRY_CACHE_MS = 60_000;
const defaultRegistryCache = new Map<string, { registered: boolean; at: number }>();

/** Recover the signer of a challenge. Returns null for anything that is not a valid, fresh challenge signature. */
export function recoverVerifier(electionCode: string, timestampHeader: string | null, signatureHeader: string | null, now: Date): { address: string } | { error: string } {
  const ts = (timestampHeader ?? "").trim();
  if (!/^[1-9][0-9]{0,11}$/.test(ts)) return { error: "X-Verifier-Timestamp must be unix seconds" };
  const sig = (signatureHeader ?? "").trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { error: "X-Verifier-Signature must be a 65-byte 0x hex signature" };
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(ts));
  if (skew > MAX_SKEW_SECONDS) return { error: `challenge expired: the timestamp must be within ${MAX_SKEW_SECONDS / 60} minutes of server time` };
  try {
    return { address: verifyMessage(challengeMessage(electionCode, ts), sig).toLowerCase() };
  } catch {
    return { error: "signature could not be recovered" };
  }
}

async function ethCall(deps: VerifierAuthDeps, to: string, data: string): Promise<string> {
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await doFetch(deps.config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`RPC error: ${j.error.message ?? "unknown"}`);
    if (typeof j.result !== "string") throw new Error("RPC returned no result");
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

/** nodes(address).registeredAt != 0 on the current VerifierRegistry, or on a legacy one. Throws when every registry call fails. */
export async function isRegisteredOnChain(address: string, deps: VerifierAuthDeps): Promise<boolean> {
  const cache = deps.registryCache ?? defaultRegistryCache;
  const t = deps.now().getTime();
  const hit = cache.get(address);
  if (hit && t - hit.at < REGISTRY_CACHE_MS) return hit.registered;

  const registries = addressesForRead(deps.config.verifierRegistryAddress, deps.config.legacyVerifierRegistryAddresses);
  const data = registryIface.encodeFunctionData("nodes", [address]);
  let lastError: unknown = null;
  for (const to of registries) {
    try {
      const result = await ethCall(deps, to, data);
      const decoded = registryIface.decodeFunctionResult("nodes", result);
      if (BigInt(decoded[2] as bigint) !== 0n) {
        cache.set(address, { registered: true, at: t });
        return true;
      }
    } catch (e) {
      lastError = e;
    }
  }
  // A failed registry is not "not registered": the address may be on the set we could not read.
  if (lastError) throw lastError instanceof Error ? lastError : new Error("RPC request failed");
  cache.set(address, { registered: false, at: t });
  return false;
}

const ORGANIZER_CACHE_MS = 60_000;
const defaultOrganizerCache = new Map<string, { organizer: string; at: number }>();

/** ElectionRegistry.elections(electionKey).organizer, lower-cased. "" if none on the current or a legacy registry. Throws when every registry call fails. */
export async function organizerOfElection(electionCode: string, deps: VerifierAuthDeps): Promise<string> {
  const cache = deps.organizerCache ?? defaultOrganizerCache;
  const t = deps.now().getTime();
  const hit = cache.get(electionCode);
  if (hit && t - hit.at < ORGANIZER_CACHE_MS) return hit.organizer;

  const registries = addressesForRead(deps.config.registryAddress, deps.config.legacyRegistryAddresses);
  const data = electionsIface.encodeFunctionData("elections", [electionKey(electionCode)]);
  let lastError: unknown = null;
  for (const to of registries) {
    try {
      const result = await ethCall(deps, to, data);
      const decoded = electionsIface.decodeFunctionResult("elections", result);
      const organizer = String(decoded[0] ?? "").toLowerCase();
      const value = organizer === "0x0000000000000000000000000000000000000000" ? "" : organizer;
      if (value) {
        cache.set(electionCode, { organizer: value, at: t });
        return value;
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error("RPC request failed");
  cache.set(electionCode, { organizer: "", at: t });
  return "";
}

/** Full check: fresh signature for THIS election, then allowlist and/or registry per VERIFIER_AUTH_MODE, then organizer. */
export async function authenticateVerifier(req: Request, electionCode: string, deps: VerifierAuthDeps): Promise<VerifierAuthResult> {
  const { config } = deps;
  if (!isElectionCode(electionCode)) return fail(400, "election must look like BEINGS-YYYY-XXXXXX");
  const useAllowlist = config.verifierAuthMode !== "registry";
  const useRegistry = config.verifierAuthMode !== "allowlist";
  const allowlistEmpty = useAllowlist && !useRegistry && config.verifierAddresses.length === 0;

  const rec = recoverVerifier(electionCode, req.headers.get("x-verifier-timestamp"), req.headers.get("x-verifier-signature"), deps.now());
  if ("error" in rec) return fail(401, rec.error);
  const address = rec.address;

  if (useAllowlist && config.verifierAddresses.includes(address)) return { ok: true, address, via: "allowlist" };
  let registryError = false;
  if (useRegistry) {
    try {
      if (await isRegisteredOnChain(address, deps)) return { ok: true, address, via: "registry" };
    } catch {
      registryError = true;
    }
  }
  try {
    const organizer = await organizerOfElection(electionCode, deps);
    if (organizer && organizer === address) return { ok: true, address, via: "organizer" };
  } catch {
    if (registryError) return fail(502, "could not read the verifier registry right now; try again later");
    return fail(502, "could not read the election registry right now; try again later");
  }
  if (registryError) return fail(502, "could not read the verifier registry right now; try again later");
  if (allowlistEmpty) return fail(503, "verifier access is not configured on this site");
  return fail(403, "this address is not an authorized verifier or the organizer of this election");
}
