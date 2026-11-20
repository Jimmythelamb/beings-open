// Read-only lookup of a ballot's on-chain record: BallotLedger.records(bytes32 electionKey, bytes32 ballotKey).
// Public mapping getter, so the return value is the struct's fields flattened:
//   (string results, bytes32 imageSha256, bytes32 recordSha256, uint64 acceptedAt, bool reviewed)
// ABI head = 5 words: [offset of results][imageSha256][recordSha256][acceptedAt][reviewed]; the string body follows.
// No wallet, no keys, no transactions: a single eth_call over JSON-RPC.
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { KECCAK_HEX_RE, ballotKey, electionKey } from "./codes.js";

export const RECORDS_SIGNATURE = "records(bytes32,bytes32)";
export const RECORDS_SELECTOR = bytesToHex(keccak_256(new TextEncoder().encode(RECORDS_SIGNATURE))).slice(0, 8);

export interface LedgerRecord {
  /** false when nothing has been accepted on-chain for this election and ballot (acceptedAt == 0). */
  recorded: boolean;
  /** 64 lower-case hex characters, no 0x; empty string when not recorded. */
  imageSha256: string;
  acceptedAt: number;
}

export class ChainError extends Error {}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function encodeRecordsCall(electionCode: string, ballotCode: string): string {
  return encodeRecordsCallByKey(electionCode, ballotKey(ballotCode));
}

/** Same as encodeRecordsCall, but the caller already has the on-chain ballotKey (0x + 64 hex). */
export function encodeRecordsCallByKey(electionCode: string, ballotKeyHex: string): string {
  const key = ballotKeyHex.toLowerCase();
  if (!KECCAK_HEX_RE.test(key)) throw new ChainError("bad ballot key");
  return "0x" + RECORDS_SELECTOR + electionKey(electionCode).slice(2) + key.slice(2);
}

/** Decode the return data of records(...). Throws ChainError on anything that is not a well-formed record. */
export function decodeRecordsResult(hex: string): LedgerRecord {
  if (!/^0x([0-9a-f]{2})*$/i.test(hex)) throw new ChainError("RPC returned malformed data");
  const body = hex.slice(2);
  if (body.length < 5 * 64) throw new ChainError("RPC returned too little data (wrong contract address?)");
  const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
  const imageSha256 = word(1).toLowerCase();
  const acceptedAtBig = BigInt("0x" + word(3));
  if (acceptedAtBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainError("RPC returned an impossible timestamp");
  const acceptedAt = Number(acceptedAtBig);
  if (acceptedAt === 0) return { recorded: false, imageSha256: "", acceptedAt: 0 };
  return { recorded: true, imageSha256, acceptedAt };
}

export interface ChainOptions {
  rpcUrl: string;
  ledgerAddress: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Ask the ledger for the record of (electionCode, ballotCode). `ballotCode` must be in strict 12-character form. */
export async function readLedgerRecord(electionCode: string, ballotCode: string, opts: ChainOptions): Promise<LedgerRecord> {
  return readLedgerRecordByKey(electionCode, ballotKey(ballotCode), opts);
}

export interface FallbackChainOptions extends ChainOptions {
  /** Tried, in order, only when the current ledger has no record for this ballot (or the call fails). */
  legacyLedgerAddresses?: readonly string[];
}

function ledgerReadOrder(opts: FallbackChainOptions): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const v = (raw ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return;
    if (out.some((a) => a.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };
  push(opts.ledgerAddress);
  for (const a of opts.legacyLedgerAddresses ?? []) push(a);
  return out;
}

/**
 * Read `records` on the current ledger, then on each legacy ledger.
 * A recorded ballot is returned as soon as one ledger has it.
 * Every ledger that answers "not recorded", and none that errors, returns that miss.
 * An error is thrown when no ledger recorded the ballot and at least one call failed,
 * so a legacy outage is not reported as "no image".
 */
export async function readLedgerRecordWithFallback(electionCode: string, ballotCode: string, opts: FallbackChainOptions): Promise<LedgerRecord> {
  return readLedgerRecordByKeyWithFallback(electionCode, ballotKey(ballotCode), opts);
}

export async function readLedgerRecordByKeyWithFallback(electionCode: string, ballotKeyHex: string, opts: FallbackChainOptions): Promise<LedgerRecord> {
  const addresses = ledgerReadOrder(opts);
  if (addresses.length === 0) throw new ChainError("no ledger address configured");
  let lastMiss: LedgerRecord | null = null;
  let misses = 0;
  let lastError: unknown = null;
  for (const ledgerAddress of addresses) {
    try {
      const rec = await readLedgerRecordByKey(electionCode, ballotKeyHex, { ...opts, ledgerAddress });
      if (rec.recorded) return rec;
      lastMiss = rec;
      misses++;
    } catch (e) {
      lastError = e;
    }
  }
  if (misses === addresses.length && lastMiss) return lastMiss;
  if (lastError instanceof ChainError) throw lastError;
  if (lastError) throw new ChainError(`RPC request failed: ${lastError instanceof Error ? lastError.message : "unknown"}`);
  return lastMiss ?? { recorded: false, imageSha256: "", acceptedAt: 0 };
}

/** Ask the ledger for the record of (electionCode, ballotKey). Used when only the stored keccak is known. */
export async function readLedgerRecordByKey(electionCode: string, ballotKeyHex: string, opts: ChainOptions): Promise<LedgerRecord> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await doFetch(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: opts.ledgerAddress, data: encodeRecordsCallByKey(electionCode, ballotKeyHex) }, "latest"],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ChainError(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new ChainError(`RPC error: ${json.error.message ?? "unknown"}`);
    if (typeof json.result !== "string") throw new ChainError("RPC returned no result");
    return decodeRecordsResult(json.result);
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw new ChainError(`RPC request failed: ${e instanceof Error ? e.message : "unknown"}`);
  } finally {
    clearTimeout(timer);
  }
}
