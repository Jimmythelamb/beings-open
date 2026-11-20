// Blind re-read: an independent second reading of every ballot image from a MASKED copy of the image.
//
// Layer 1 (consensus on the chain) protects the integrity of the data array. Layer 2 (this module) checks that the
// data matches the paper: the image is deskewed with the four registration marks, everything that is not an oval is
// painted black (QR, ballot code, headings, receipt, everything below tearLineY), a reader that sees ONLY the masked
// image produces a results string, and keccak256 of that string is compared with the on-chain resultsHash of the
// record whose imageSha256 is the hash of the image. Nothing identifying (QR, ballot code) is ever read or reported:
// the manifest and the report are keyed by imageSha256 only.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bubbleState, deriveResults, encodeResults, keccakHex, layoutHash, sha256Hex, type FillScores, type Results } from "@beings/core";
import type { LedgerResultEntry } from "./imageVerify.js";

export const BLIND_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "python", "blind_reread.py");

// ------------------------------------------------------------------------------------------------ types

export interface BlindElection {
  electionCode?: string;
  layoutHash?: string;
  resultRules: { emptyBelow: number; markedAbove: number };
  questions: { id: string; maxMarks: number; choices: { id: string }[] }[];
  /** Optional three-threshold pairs. Omitted pairs use the spec defaults. */
  consensusThresholds?: {
    tight?: { emptyBelow: number; markedAbove: number };
    standard?: { emptyBelow: number; markedAbove: number };
    loose?: { emptyBelow: number; markedAbove: number };
  };
}

export interface MaskFrame {
  pxPerMm: number;
  padMm: number;
  widthPx: number;
  heightPx: number;
}

/** Oval geometry in layout mm (origin = centre of the top-left mark), the only layout facts a reader needs. */
export interface OvalGeometry {
  questionId: string;
  choiceId: string;
  maxMarks: number;
  center: { x: number; y: number };
  widthMm: number;
  heightMm: number;
}

/** Everything a reader is given. There is deliberately no path to, or hash of anything but, the masked image. */
export interface BlindReaderInput {
  /** The masked image (PNG file on disk) and its bytes. */
  maskedPngPath: string;
  maskedPng: Uint8Array;
  frame: MaskFrame;
  ovals: OvalGeometry[];
  /** The layout file, for readers that want all the geometry (public data, identical for every ballot). */
  layoutPath: string;
  resultRules: { emptyBelow: number; markedAbove: number };
  /** Per question: id, max marks, choice ids (in election-file order). */
  questions: { id: string; maxMarks: number; choiceIds: string[] }[];
}

/** A reader returns oval fill scores (0-100; the verifier derives the results with the core rules) or, for readers
 *  that judge a whole question at once (e.g. a vision model), the per-question results themselves. */
export type BlindReadOutput = { fillScores: FillScores; notes?: string[] } | { results: Results; notes?: string[] };

export interface BlindReader {
  readonly name: string;
  read(input: BlindReaderInput): Promise<BlindReadOutput>;
}

export type BlindStatus = "match" | "mismatch" | "unclear" | "no-image" | "unreadable" | "not-on-chain";

export interface BlindDifference {
  questionIndex: number;
  questionId: string;
  blind: string;
  chain: string;
}

export interface BlindEntry {
  imageSha256: string;
  status: BlindStatus;
  detail?: string;
  maskedFile?: string;
  blind?: { results: string; resultsHash: string };
  chain?: { results: string; resultsHash: string }[];
  differences?: BlindDifference[];
  /** ovals in the unclear band (15-50 %), as `q/c=score` */
  unclearOvals?: string[];
  /** ovals within 10 points of a threshold: informational */
  lowConfidenceOvals?: string[];
  fillScores?: FillScores;
}

export interface BlindReport {
  election: string;
  reader: string;
  generatedAt: string;
  layoutHash: string;
  counts: Record<BlindStatus, number>;
  entries: BlindEntry[];
  /** true when there is no mismatch (the CLI exit code is 2 otherwise) */
  ok: boolean;
  notes: string[];
}

export interface MaskManifest {
  note: string;
  layoutVersion: number;
  frame: MaskFrame;
  keepIds: boolean;
  /** keyed ONLY by the SHA-256 of the original image file */
  images: Record<string, { masked: string; maskedSha256: string; keptRegions: number }>;
}

// ------------------------------------------------------------------------------------------------ processes

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", rej);
    p.on("close", (code) => res({ code, stdout, stderr }));
    p.stdin.on("error", () => undefined);
    p.stdin.end(stdin ?? "");
  });
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`unexpected helper output: ${stdout.slice(0, 200)}`);
  }
}

async function python(py: string, args: string[]): Promise<Record<string, unknown>> {
  const r = await run(py, [BLIND_SCRIPT, ...args]);
  let out: Record<string, unknown> | undefined;
  try {
    out = lastJson(r.stdout);
  } catch {
    /* handled below */
  }
  if (r.code !== 0 || !out || out.error) throw new Error(typeof out?.error === "string" ? out.error : `python helper failed (exit ${r.code}): ${r.stderr.trim().slice(-300)}`);
  return out;
}

/** Throws a helpful error unless `<py> -c "import cv2, numpy"` works. */
export async function checkPython(py: string): Promise<void> {
  try {
    const r = await run(py, ["-c", "import cv2, numpy"]);
    if (r.code === 0) return;
  } catch {
    /* fall through */
  }
  throw new Error(`the default OpenCV reader needs Python 3 with opencv-python and numpy (tried "${py}"); install them (pip install opencv-python-headless numpy), pass --python <bin>, or use --reader-cmd`);
}

// ------------------------------------------------------------------------------------------------ layout / election

export interface LayoutLike {
  layoutVersion: number;
  electionCode?: string;
  tearLineY: number;
  questions: { id: string; maxMarks: number; ovals: { choiceId: string; center: { x: number; y: number }; widthMm: number; heightMm: number }[] }[];
  [k: string]: unknown;
}

/** The layout must be the one the election file commits to, and must describe the election's questions. Returns notes. */
export function checkLayout(layout: LayoutLike, election: BlindElection): string[] {
  const notes: string[] = [];
  if (layout.layoutVersion !== 3) throw new Error(`unsupported layout version ${layout.layoutVersion} (this reader needs layout v3)`);
  if (election.layoutHash !== undefined && layoutHash(layout) !== election.layoutHash) {
    throw new Error(`ballot-layout.json does not match the election file: its layoutHash is ${layoutHash(layout)}, the election file says ${election.layoutHash}`);
  }
  if (election.layoutHash === undefined) notes.push("the election file has no layoutHash, so the layout could not be tied to it");
  if (layout.questions.length !== election.questions.length) throw new Error("the layout and the election file have a different number of questions");
  for (const q of election.questions) {
    const lq = layout.questions.find((x) => x.id === q.id);
    if (!lq) throw new Error(`the layout has no question ${q.id}`);
    if (lq.maxMarks !== q.maxMarks) throw new Error(`question ${q.id}: layout maxMarks ${lq.maxMarks} != election file ${q.maxMarks}`);
    const a = lq.ovals.map((o) => o.choiceId).sort().join(",");
    const b = q.choices.map((c) => c.id).sort().join(",");
    if (a !== b) throw new Error(`question ${q.id}: the layout's ovals (${a}) do not match the election's choices (${b})`);
  }
  return notes;
}

export function ovalGeometry(layout: LayoutLike): OvalGeometry[] {
  return layout.questions.flatMap((q) => q.ovals.map((o) => ({ questionId: q.id, choiceId: o.choiceId, maxMarks: q.maxMarks, center: o.center, widthMm: o.widthMm, heightMm: o.heightMm })));
}

// ------------------------------------------------------------------------------------------------ readers

/** The default reader: OpenCV (Python), same thresholds and scoring as scanner/prototype/omr.py, from the masked image only. */
export class OpenCvReader implements BlindReader {
  readonly name = "opencv";
  constructor(private readonly py = process.env.BEINGS_PYTHON ?? "python3") {}
  async read(input: BlindReaderInput): Promise<BlindReadOutput> {
    const out = await python(this.py, ["read", "--masked", input.maskedPngPath, "--layout", input.layoutPath]);
    return { fillScores: out.fillScores as FillScores, notes: [`paper level ${String(out.paperLevel)}`] };
  }
}

/**
 * Hook for an external reader (a vision model, another OMR, a human tool). The command is run with no shell, receives
 * ONE JSON object on stdin (maskedPngPath, frame, ovals, questions, resultRules; no original image, no ballot code)
 * and must print one JSON object on stdout: `{"fillScores": {q: {c: 0-100}}}` or `{"results": {q: "V:c1"}}`.
 * No API key is needed or handled by the verifier: the command owns its own credentials.
 */
export class ExternalCommandReader implements BlindReader {
  readonly name: string;
  constructor(private readonly command: string[]) {
    if (command.length === 0) throw new Error("empty reader command");
    this.name = `external:${command[0]}`;
  }
  async read(input: BlindReaderInput): Promise<BlindReadOutput> {
    const { maskedPng: _bytes, layoutPath: _l, ...payload } = input;
    const r = await run(this.command[0]!, this.command.slice(1), JSON.stringify(payload));
    if (r.code !== 0) throw new Error(`reader command exited ${r.code}: ${r.stderr.trim().slice(-200)}`);
    const out = lastJson(r.stdout) as Partial<{ fillScores: FillScores; results: Results; notes: string[] }>;
    if (out.fillScores) return { fillScores: out.fillScores, ...(out.notes ? { notes: out.notes } : {}) };
    if (out.results) return { results: out.results, ...(out.notes ? { notes: out.notes } : {}) };
    throw new Error("reader command printed neither fillScores nor results");
  }
}

// ------------------------------------------------------------------------------------------------ comparison

export interface Comparison {
  status: "match" | "mismatch" | "unclear";
  differences: BlindDifference[];
  detail?: string;
}

/**
 * Compare a blind results string with the on-chain record(s) of the same imageSha256. `match` = the keccak256 of the
 * blind string equals the on-chain resultsHash (of every record carrying the image). Otherwise, when the blind reading
 * contains `U` (an oval in the unclear band) and every question it did decide agrees with the chain, the result is
 * `unclear` (a human must look); any decided question that differs is a `mismatch`.
 */
export function compareBlind(blind: string, chain: LedgerResultEntry[], questionIds: string[]): Comparison {
  const blindHash = keccakHex(blind);
  const bad = chain.filter((c) => c.resultsHash.toLowerCase() !== blindHash);
  if (bad.length === 0) return { status: "match", differences: [] };
  const bp = blind.split("|");
  const differences: BlindDifference[] = [];
  let undecided = false;
  for (const c of bad) {
    const cp = c.results.split("|");
    if (cp.length !== bp.length) {
      differences.push({ questionIndex: -1, questionId: "*", blind, chain: c.results });
      continue;
    }
    bp.forEach((b, i) => {
      if (b === cp[i]) return;
      if (b === "U") undecided = true;
      else differences.push({ questionIndex: i, questionId: questionIds[i] ?? `#${i + 1}`, blind: b, chain: cp[i]! });
    });
  }
  if (differences.length === 0 && undecided) return { status: "unclear", differences: [], detail: "the blind reading has an unclear oval and every decided question agrees with the chain" };
  return { status: "mismatch", differences };
}

function nearThreshold(scores: FillScores, rules: { emptyBelow: number; markedAbove: number }): string[] {
  const out: string[] = [];
  for (const [q, cs] of Object.entries(scores)) for (const [c, s] of Object.entries(cs)) if (Math.abs(s - rules.emptyBelow) <= 10 || Math.abs(s - rules.markedAbove) <= 10) out.push(`${q}/${c}=${s}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ the pipeline

export interface BlindImage {
  /** An image file on disk (PNG or JPEG). Its SHA-256 is computed from the bytes; the file name is never trusted. */
  path: string;
}

export interface BlindRereadOptions {
  electionCode: string;
  election: BlindElection;
  layoutPath: string;
  images: BlindImage[];
  /** imageSha256 -> on-chain results (LedgerImages.entries) */
  chain: Map<string, LedgerResultEntry[]>;
  /** where `masked/<sha>.png`, `masked-manifest.json` go */
  outDir: string;
  reader?: BlindReader;
  python?: string;
  keepIds?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  now?: () => Date;
}

export async function blindReread(o: BlindRereadOptions): Promise<{ report: BlindReport; maskManifest: MaskManifest }> {
  const py = o.python ?? process.env.BEINGS_PYTHON ?? "python3";
  const layoutRaw = readFileSync(o.layoutPath, "utf8");
  const layout = JSON.parse(layoutRaw) as LayoutLike;
  const notes = checkLayout(layout, o.election);
  if (layout.electionCode && o.electionCode && layout.electionCode !== o.electionCode) {
    notes.push(`the layout file is labelled ${layout.electionCode}, not ${o.electionCode}; its geometry is what the election file's layoutHash commits to, so it was used`);
  }
  const reader = o.reader ?? new OpenCvReader(py);
  await checkPython(py); // masking always uses OpenCV, whatever reader follows

  const order = o.election.questions.map((q) => q.id);
  const ovals = ovalGeometry(layout);
  const questions = o.election.questions.map((q) => ({ id: q.id, maxMarks: q.maxMarks, choiceIds: q.choices.map((c) => c.id) }));
  const maskedDir = join(o.outDir, "masked");
  mkdirSync(maskedDir, { recursive: true });

  // hash the files; two files with identical bytes are one image
  const byHash = new Map<string, string>();
  for (const im of o.images) {
    const sha = sha256Hex(readFileSync(im.path));
    if (!byHash.has(sha)) byHash.set(sha, im.path);
  }

  const entries: BlindEntry[] = [];
  const maskManifest: MaskManifest = {
    note: "Keyed only by the SHA-256 of the original image. Masked images show the oval regions only; nothing else of the ballot is present.",
    layoutVersion: layout.layoutVersion,
    frame: { pxPerMm: 10, padMm: 12, widthPx: 0, heightPx: 0 },
    keepIds: !!o.keepIds,
    images: {},
  };
  const todo = [...byHash.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  let idx = 0;
  let done = 0;

  const one = async (sha: string, path: string): Promise<BlindEntry> => {
    const chain = o.chain.get(sha);
    const base: BlindEntry = { imageSha256: sha, status: "unreadable", ...(chain ? { chain: chain.map((c) => ({ results: c.results, resultsHash: c.resultsHash })) } : {}) };
    const maskedPath = join(maskedDir, `${sha}.png`);
    let meta: Record<string, unknown>;
    try {
      meta = await python(py, ["mask", "--image", path, "--layout", o.layoutPath, "--out", maskedPath, ...(o.keepIds ? ["--keep-ids"] : [])]);
    } catch (e) {
      return { ...base, detail: `masking failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const maskedPng = readFileSync(maskedPath);
    maskManifest.frame = { pxPerMm: meta.pxPerMm as number, padMm: meta.padMm as number, widthPx: meta.widthPx as number, heightPx: meta.heightPx as number };
    maskManifest.images[sha] = { masked: `masked/${sha}.png`, maskedSha256: sha256Hex(maskedPng), keptRegions: meta.keptRegions as number };
    base.maskedFile = `masked/${sha}.png`;
    let results: Results;
    let fill: FillScores | undefined;
    try {
      const out = await reader.read({ maskedPngPath: maskedPath, maskedPng, frame: maskManifest.frame, ovals, layoutPath: o.layoutPath, resultRules: o.election.resultRules, questions });
      if ("fillScores" in out) {
        fill = Object.fromEntries(Object.entries(out.fillScores).map(([q, cs]) => [q, Object.fromEntries(Object.entries(cs).map(([c, s]) => [c, Math.max(0, Math.min(100, Math.round(s)))]))]));
        results = deriveResults(o.election as never, fill);
      } else {
        results = out.results;
      }
    } catch (e) {
      return { ...base, detail: `the reader failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    let blind: string;
    try {
      blind = encodeResults(results, order);
    } catch (e) {
      return { ...base, detail: `the reader produced an invalid results set: ${e instanceof Error ? e.message : String(e)}` };
    }
    const unclearOvals = fill ? Object.entries(fill).flatMap(([q, cs]) => Object.entries(cs).filter(([, s]) => bubbleState(s, o.election.resultRules) === "unclear").map(([c, s]) => `${q}/${c}=${s}`)) : [];
    const detail: Partial<BlindEntry> = {
      maskedFile: base.maskedFile!,
      blind: { results: blind, resultsHash: keccakHex(blind) },
      ...(fill ? { fillScores: fill, unclearOvals, lowConfidenceOvals: nearThreshold(fill, o.election.resultRules) } : {}),
    };
    if (!chain) return { ...base, ...detail, status: "not-on-chain", detail: "no BallotAccepted record carries this image hash" };
    const cmp = compareBlind(blind, chain, order);
    return { ...base, ...detail, status: cmp.status, ...(cmp.differences.length ? { differences: cmp.differences } : {}), ...(cmp.detail ? { detail: cmp.detail } : {}) };
  };

  const worker = async () => {
    for (;;) {
      const t = todo[idx++];
      if (!t) return;
      entries.push(await one(t[0], t[1]));
      o.onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, worker));

  for (const [sha, chain] of o.chain) {
    if (!byHash.has(sha)) entries.push({ imageSha256: sha, status: "no-image", chain: chain.map((c) => ({ results: c.results, resultsHash: c.resultsHash })), detail: "recorded on-chain but no image with this hash was supplied" });
  }
  entries.sort((a, b) => (a.imageSha256 < b.imageSha256 ? -1 : 1));
  const counts: Record<BlindStatus, number> = { match: 0, mismatch: 0, unclear: 0, "no-image": 0, unreadable: 0, "not-on-chain": 0 };
  for (const e of entries) counts[e.status]++;
  const report: BlindReport = {
    election: o.electionCode,
    reader: reader.name,
    generatedAt: (o.now?.() ?? new Date()).toISOString(),
    layoutHash: layoutHash(layout),
    counts,
    entries,
    ok: counts.mismatch === 0,
    notes,
  };
  return { report, maskManifest };
}

/** Exit code of the blind re-read: 2 on any mismatch (and, with `strict`, on anything that is not a match), else 0. */
export function blindExitCode(report: BlindReport, strict = false): number {
  if (report.counts.mismatch > 0) return 2;
  if (strict && report.entries.some((e) => e.status !== "match")) return 2;
  return 0;
}

export function formatBlindSummary(report: BlindReport): string {
  const c = report.counts;
  const lines = [
    `Blind re-read of ${report.election} (reader: ${report.reader}): ${report.entries.length} image/record(s)`,
    `  match ${c.match}   mismatch ${c.mismatch}   unclear ${c.unclear}   no-image ${c["no-image"]}   unreadable ${c.unreadable}   not-on-chain ${c["not-on-chain"]}`,
  ];
  for (const e of report.entries) {
    const id = e.imageSha256.slice(0, 12);
    if (e.status === "match") lines.push(`  MATCH     ${id}  ${e.blind!.results}`);
    else if (e.status === "mismatch") lines.push(`  MISMATCH  ${id}  blind ${e.blind?.results ?? "?"}  vs chain ${(e.chain ?? []).map((x) => x.results).join(" / ")}`);
    else if (e.status === "unclear") lines.push(`  UNCLEAR   ${id}  blind ${e.blind?.results}  vs chain ${(e.chain ?? []).map((x) => x.results).join(" / ")}  ovals ${(e.unclearOvals ?? []).join(", ")}`);
    else lines.push(`  ${e.status.toUpperCase().padEnd(9)} ${id}  ${e.detail ?? ""}`);
  }
  for (const n of report.notes) lines.push(`  note: ${n}`);
  lines.push(c.mismatch > 0 ? "MISMATCH FOUND: the on-chain data disagrees with what the paper shows (see report.json)." : c.match === report.entries.length ? "OK: every blind reading matches the on-chain record." : "No mismatch, but some images were not matched (see above).");
  return lines.join("\n");
}

export function writeBlindFiles(outDir: string, report: BlindReport, maskManifest: MaskManifest): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "masked-manifest.json"), JSON.stringify(maskManifest, null, 2) + "\n");
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, "summary.txt"), formatBlindSummary(report) + "\n");
}
