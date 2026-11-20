// Per-election image access policy, taken from the public election file (included in the file fingerprint).
// The image service never trusts a client-supplied "this election is public" header on a GET.
import { isElectionCode } from "./codes.js";
import type { SiteConfig } from "./config.js";

export const DEFAULT_IMAGE_RETENTION_DAYS = 30;
export const PUBLIC_IMAGE_RETENTION_MIN_DAYS = 30;
export const PUBLIC_IMAGE_RETENTION_MAX_DAYS = 60;

export interface ElectionImagePolicy {
  publicBallotImages: boolean;
  retentionDays: number | null;
}

export type PolicyLookup = (electionCode: string) => Promise<ElectionImagePolicy | null>;

export type PolicyFetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** True only for an explicit boolean true; missing or any other value is off. */
export function isPublicBallotImages(file: unknown): boolean {
  return !!file && typeof file === "object" && (file as { publicBallotImages?: unknown }).publicBallotImages === true;
}

export function policyFromElectionFile(file: unknown): ElectionImagePolicy {
  const days = file && typeof file === "object" ? (file as { imageRetention?: { days?: unknown } }).imageRetention?.days : null;
  return {
    publicBallotImages: isPublicBallotImages(file),
    retentionDays: typeof days === "number" && Number.isSafeInteger(days) && days > 0 ? days : null,
  };
}

export function retentionRange(publicOn: boolean, maxSiteDays = 365): { min: number; max: number } {
  return publicOn
    ? { min: PUBLIC_IMAGE_RETENTION_MIN_DAYS, max: Math.min(PUBLIC_IMAGE_RETENTION_MAX_DAYS, maxSiteDays) }
    : { min: 1, max: maxSiteDays };
}

/** X-Public-Images header on scanner upload (true / 1 / yes). */
export function isPublicImagesHeader(v: string | null): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Stored blob metadata may stringify booleans. */
export function isPublicImagesMetadata(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Load the public election file from `base/<electionCode>.json` and read the policy.
 * Fail closed (null) on any error. The path is only an already-checked election code.
 */
export async function loadElectionImagePolicy(
  electionCode: string,
  opts: { base?: string; fetchImpl?: PolicyFetch; timeoutMs?: number } = {},
): Promise<ElectionImagePolicy | null> {
  const base = (opts.base ?? "").trim().replace(/\/$/, "");
  if (!base || !isElectionCode(electionCode)) return null;
  const url = `${base}/${encodeURIComponent(electionCode)}.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const doFetch: PolicyFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init) as ReturnType<PolicyFetch>);
    const res = await doFetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const file = json && typeof json === "object" && "file" in (json as object) && (json as { file?: unknown }).file
      ? (json as { file: unknown }).file
      : json;
    return policyFromElectionFile(file);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Public-copy URL prefix: ELECTION_FILES_BASE, or same-origin `/data/elections`. */
export function electionFilesBaseFor(req: Request, config: SiteConfig): string | undefined {
  const fromEnv = config.electionFilesBase?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  try {
    return `${new URL(req.url).origin}/data/elections`;
  } catch {
    return undefined;
  }
}

export function policyLookup(req: Request, config: SiteConfig, fetchImpl?: PolicyFetch): PolicyLookup {
  const base = electionFilesBaseFor(req, config);
  return (code) => loadElectionImagePolicy(code, { base, ...(fetchImpl ? { fetchImpl } : {}) });
}
