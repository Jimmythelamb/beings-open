// Shared by `beings-blind-reread` and `beings-verify-images --blind-reread`.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isElectionCode, keccakHex } from "@beings/core";
import { ExternalCommandReader, OpenCvReader, type BlindElection, type BlindImage, type BlindReader } from "./blind.js";
import type { LedgerResultEntry } from "./imageVerify.js";

export const BLIND_FLAGS = "--election-file <election-file.json> --layout <ballot-layout.json> [--reader opencv|--reader-cmd \"<command> [args]\"] [--python python3] [--keep-ids] [--strict]";

export interface BlindInputs {
  election: BlindElection;
  layoutPath: string;
  reader: BlindReader;
  python: string;
  keepIds: boolean;
  strict: boolean;
}

export function loadBlindInputs(a: Record<string, string | true>, electionCode: string): BlindInputs {
  if (typeof a["election-file"] !== "string") throw new Error(`--election-file <election-file.json> is required for the blind re-read (it holds the question order and result rules)`);
  if (typeof a.layout !== "string") throw new Error(`--layout <ballot-layout.json> is required for the blind re-read`);
  const election = JSON.parse(readFileSync(resolve(a["election-file"]), "utf8")) as BlindElection;
  if (!Array.isArray(election.questions) || !election.resultRules) throw new Error("the election file has no questions/resultRules");
  if (election.electionCode !== undefined && election.electionCode !== electionCode) throw new Error(`the election file is for ${election.electionCode}, not ${electionCode}`);
  const python = typeof a.python === "string" ? a.python : process.env.BEINGS_PYTHON ?? "python3";
  const reader = typeof a["reader-cmd"] === "string" ? new ExternalCommandReader(a["reader-cmd"].trim().split(/\s+/)) : (() => {
    if (a.reader !== undefined && a.reader !== "opencv") throw new Error(`unknown --reader ${String(a.reader)} (use "opencv", or --reader-cmd for an external reader)`);
    return new OpenCvReader(python);
  })();
  return { election, layoutPath: resolve(a.layout), reader, python, keepIds: a["keep-ids"] === true, strict: a.strict === true };
}

export function requireElection(a: Record<string, string | true>, usage: string): string {
  const e = a.election;
  if (typeof e !== "string" || !isElectionCode(e)) throw new Error(`--election <BEINGS-YYYY-XXXXXX> is required\n${usage}`);
  return e;
}

const IMAGE_RE = /\.(png|jpe?g)$/i;
/** PNG/JPEG files directly inside `dir` (manifest.json, report.json and masked/ are ignored). */
export function listImageFiles(dir: string): BlindImage[] {
  return readdirSync(resolve(dir), { withFileTypes: true })
    .filter((d) => d.isFile() && IMAGE_RE.test(d.name))
    .map((d) => ({ path: join(resolve(dir), d.name) }))
    .sort((x, y) => (x.path < y.path ? -1 : 1));
}

/** Offline chain records: a JSON array of `{ "imageSha256": "<64 hex>", "results": "V:c1|B" }` (a 0x prefix is accepted). */
export function readChainRecordsFile(path: string): Map<string, LedgerResultEntry[]> {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("--chain-records must be a JSON array of {imageSha256, results}");
  const out = new Map<string, LedgerResultEntry[]>();
  for (const r of raw as { imageSha256?: unknown; results?: unknown }[]) {
    if (typeof r?.imageSha256 !== "string" || typeof r.results !== "string") throw new Error("each chain record needs imageSha256 and results strings");
    const h = r.imageSha256.replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`bad imageSha256 ${r.imageSha256}`);
    out.set(h, [...(out.get(h) ?? []), { results: r.results, resultsHash: keccakHex(r.results) }]);
  }
  return out;
}
