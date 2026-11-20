import { PDFDocument } from "pdf-lib";
import {
  BALLOT_CODE_RE,
  BeingsError,
  ballotKey,
  ballotListRoot,
  csprng,
  electionFileProblems,
  layoutHash as layoutHashOf,
  electionKey,
  newBallotCodes,
  newElectionCode,
  sha256Json,
  validate,
  type ElectionFile,
  type RandomBytes,
} from "@beings/core";
import { buildPlan, makeFonts, type BallotLayout } from "./plan.js";
import { renderPdf } from "./render.js";
import { validateLayout } from "./layout-schema.js";

export interface GenerateOptions {
  /** Number of ballots to print, including spares. Required unless the election file already lists `ballotCodes`. */
  count?: number;
  /** Random source. Defaults to the platform CSPRNG; override ONLY in tests. */
  rng?: RandomBytes;
  /** Public https origin encoded in the receipt QR. Defaults to https://beingsvote.live. */
  siteOrigin?: string;
}

export interface BallotListEntry {
  ballotCode: string;
  ballotKey: string;
}

export interface GeneratedElection {
  /** The election file with `ballotCodes` filled in (sorted, so the order says nothing about the print order). */
  electionFile: ElectionFile;
  /** SHA-256 hex of the canonical JSON (RFC 8785) of the election file, as recorded on-chain by createElection. */
  electionFileSha256: string;
  layout: BallotLayout;
  /** SHA-256 hex of the canonical JSON of the layout: the same value as `electionFile.layoutHash`. */
  layoutHash: string;
  /** Alias of `layoutHash` (the name `manifest.json` has used since the first version). */
  layoutSha256: string;
  ballotList: {
    schemaVersion: "0.1";
    electionCode: string;
    electionKey: string;
    count: number;
    ballotListRoot: string;
    ballots: BallotListEntry[];
  };
  /** Arguments for `ElectionRegistry.createElection` that this generator can fill in. */
  createElection: { electionCode: string; electionKey: string; fileSha256: string; ballotCount: number; registeredVoters: number; quorum: number; ballotListRoot: string };
  /** Batch PDF, one ballot per page, in a random (shuffled) print order. The print order is never written anywhere else. */
  pdf: Uint8Array;
  warnings: string[];
}

/** Unbiased Fisher-Yates shuffle driven by `rng` (rejection sampling, no modulo bias). */
export function shuffled<T>(items: readonly T[], rng: RandomBytes): T[] {
  const a = [...items];
  const below = (n: number): number => {
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const b = rng(4);
      const v = ((b[0] as number) * 16777216 + (b[1] as number) * 65536 + (b[2] as number) * 256 + (b[3] as number)) >>> 0;
      if (v < limit) return v % n;
    }
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * M2 entry point (architecture doc section 4): `generateElection(electionFile, {count}) -> everything to print and publish`.
 *
 * The input is an election file in the core schema. `ballotCodes` may be missing or empty (then `count` fresh CSPRNG
 * codes are generated) or already listed (then those exact codes are printed, e.g. a reprint of the same batch;
 * `count`, if given, must equal their number). A missing `electionCode` is generated. The result is validated with
 * core (schema and election-file rules) before anything is drawn.
 */
export async function generateElection(input: unknown, options: GenerateOptions = {}): Promise<GeneratedElection> {
  const rng = options.rng ?? csprng;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BeingsError("BAD_INPUT", "the election file must be a JSON object");
  const raw = input as Record<string, unknown>;
  const given = raw.ballotCodes;
  if (given !== undefined && !Array.isArray(given)) throw new BeingsError("BAD_INPUT", "ballotCodes must be an array");

  let codes: string[];
  if (given && given.length > 0) {
    if (options.count !== undefined && options.count !== given.length) throw new BeingsError("BAD_INPUT", `count ${options.count} does not match the ${given.length} ballotCodes already in the election file`);
    codes = given.map(String);
  } else {
    const n = options.count;
    if (n === undefined || !Number.isSafeInteger(n) || n < 1 || n > 100000) throw new BeingsError("BAD_INPUT", "count must be an integer from 1 to 100000");
    codes = newBallotCodes(n, rng);
  }
  for (const c of codes) if (!BALLOT_CODE_RE.test(c)) throw new BeingsError("BAD_CODE", `invalid ballot code ${JSON.stringify(c)}`);
  if (new Set(codes).size !== codes.length) throw new BeingsError("BAD_CODE", "duplicate ballot codes");

  let electionCode = raw.electionCode;
  if (electionCode === undefined) {
    const year = Number.isFinite(Date.parse(String(raw.opensAt))) ? new Date(String(raw.opensAt)).getUTCFullYear() : new Date().getUTCFullYear();
    electionCode = newElectionCode(year, rng);
  }
  const sorted = [...codes].sort();
  // 1. Validate what we were given (a `layoutHash` already in the file is allowed: a reprint).
  const candidate = { ...raw, electionCode, ballotCodes: sorted };
  validate("electionFile", candidate);
  const problems = electionFileProblems(candidate as ElectionFile);
  if (problems.length > 0) throw new BeingsError("BAD_INPUT", `election file problems: ${problems.join("; ")}`);

  const warnings: string[] = [];
  if (codes.length < (candidate as ElectionFile).registeredVoters) warnings.push(`only ${codes.length} ballots for ${(candidate as ElectionFile).registeredVoters} registered voters (print spares for spoiled ballots too)`);
  else if (codes.length === (candidate as ElectionFile).registeredVoters) warnings.push("no spare ballots: a spoiled ballot would need a replacement from the spares");

  // 2. The layout depends only on the election code, name and questions, never on the ballot codes or on any hash of the
  //    election file, so its hash can go INTO the election file (no circularity) before the file is hashed for the chain.
  const doc = await PDFDocument.create();
  const fonts = await makeFonts(doc);
  const plan = await buildPlan(candidate as ElectionFile, fonts, { siteOrigin: options.siteOrigin });
  const layout = plan.layout;
  validateLayout(layout);
  const layoutHash = layoutHashOf(layout);
  const givenHash = (candidate as ElectionFile).layoutHash;
  if (givenHash !== undefined && givenHash !== layoutHash) {
    throw new BeingsError("BAD_INPUT", `the election file's layoutHash ${givenHash} does not match the layout this generator draws for its questions (${layoutHash}); remove layoutHash to have it recomputed, or use the generator version that made the file`);
  }
  // 3. The election file, now carrying layoutHash, is what is validated (layoutHash required) and hashed.
  const electionFile = { ...candidate, layoutHash } as ElectionFile;
  validate("electionFile", electionFile);
  const finalProblems = electionFileProblems(electionFile, { requireLayoutHash: true });
  if (finalProblems.length > 0) throw new BeingsError("BAD_INPUT", `election file problems: ${finalProblems.join("; ")}`);

  const printOrder = shuffled(codes, rng);
  const pdf = await renderPdf({ plan, electionCode: electionFile.electionCode, ballotCodes: printOrder }, async () => ({ doc, fonts }));

  const root = ballotListRoot(sorted);
  const fileSha256 = sha256Json(electionFile);
  const eKey = electionKey(electionFile.electionCode);
  return {
    electionFile,
    electionFileSha256: fileSha256,
    layout,
    layoutHash,
    layoutSha256: layoutHash,
    ballotList: {
      schemaVersion: "0.1",
      electionCode: electionFile.electionCode,
      electionKey: eKey,
      count: sorted.length,
      ballotListRoot: root,
      ballots: sorted.map((c) => ({ ballotCode: c, ballotKey: ballotKey(c) })),
    },
    createElection: { electionCode: electionFile.electionCode, electionKey: eKey, fileSha256: "0x" + fileSha256, ballotCount: sorted.length, registeredVoters: electionFile.registeredVoters, quorum: electionFile.quorum, ballotListRoot: root },
    pdf,
    warnings,
  };
}
