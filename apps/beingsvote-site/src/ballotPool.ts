// Ballot-pool check for image uploads. The worker sees the ballot key and a Merkle proof, never the code.
// Proofs use the same sorted-pair keccak256 tree as ElectionRegistry.ballotListedIn.
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { electionKey, KECCAK_HEX_RE } from "./codes.js";

const encoder = new TextEncoder();
const selectorOf = (signature: string) => bytesToHex(keccak_256(encoder.encode(signature))).slice(0, 8);

export const POOL_ENFORCED_SELECTOR = selectorOf("poolEnforced(bytes32)");
export const BALLOT_ROOT_AT_SELECTOR = selectorOf("ballotRootAt(bytes32,uint256)");

export interface PoolCheckInput {
  electionCode: string;
  ballotKey: string;
  /** null when the scanner did not send X-Ballot-Proof. An empty array is a real proof (a one-ballot list). */
  proof: string[] | null;
  rootIndex: number;
}

export interface PoolVerdict {
  ok: boolean;
  error?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hashPair(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const bytes = new Uint8Array(64);
  bytes.set(hexToBytes(lo), 0);
  bytes.set(hexToBytes(hi), 32);
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** OpenZeppelin sorted-pair Merkle proof. Never throws. */
export function verifySortedProof(root: string, leaf: string, proof: readonly string[]): boolean {
  try {
    let hash = leaf.toLowerCase();
    const want = root.toLowerCase();
    if (!KECCAK_HEX_RE.test(hash) || !KECCAK_HEX_RE.test(want)) return false;
    for (const part of proof) {
      const sib = part.toLowerCase();
      if (!KECCAK_HEX_RE.test(sib)) return false;
      hash = hashPair(hash, sib);
    }
    return hash === want;
  } catch {
    return false;
  }
}

async function ethCall(opts: { rpcUrl: string; registryAddress: string; fetchImpl?: FetchLike; timeoutMs?: number }, data: string): Promise<string> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await doFetch(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: opts.registryAddress, data: `0x${data}` }, "latest"] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("http");
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error || typeof json.result !== "string" || !/^0x[0-9a-fA-F]{64,}$/.test(json.result)) throw new Error("revert");
    return `0x${json.result.slice(2, 66).toLowerCase()}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the registry whether this election checks its ballot pool, and if it does, whether the proof holds.
 * A registry from before this change reverts `poolEnforced`, and that is treated as "not checked".
 *
 * TODO: if the Coston2 RPC cannot be reached, this also allows the upload, because a failed call looks the
 * same as an old registry. Fail closed once every live election is on a registry that has `poolEnforced`.
 */
export async function checkBallotPool(
  input: PoolCheckInput,
  opts: { rpcUrl: string; registryAddress: string; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<PoolVerdict> {
  const key = electionKey(input.electionCode).slice(2);
  let enforced = false;
  try {
    const word = await ethCall(opts, POOL_ENFORCED_SELECTOR + key);
    enforced = BigInt(word) === 1n;
  } catch {
    return { ok: true };
  }
  if (!enforced) return { ok: true };
  if (input.proof === null || !Number.isInteger(input.rootIndex) || input.rootIndex < 0) {
    return { ok: false, error: "this election only accepts images for ballots in its pool; send the Merkle proof in X-Ballot-Proof and the list number in X-Ballot-Root-Index" };
  }
  let root: string;
  try {
    const index = input.rootIndex.toString(16).padStart(64, "0");
    root = await ethCall(opts, BALLOT_ROOT_AT_SELECTOR + key + index);
  } catch {
    return { ok: false, error: "that ballot list is not one of this election's approved lists" };
  }
  if (!verifySortedProof(root, input.ballotKey, input.proof)) {
    return { ok: false, error: "this ballot is not in the election's ballot pool" };
  }
  return { ok: true };
}
