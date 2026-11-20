import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { electionKey, keccakHex, sha256Hex } from "@beings/core";
import {
  BLIND_SCRIPT,
  ExternalCommandReader,
  blindExitCode,
  blindReread,
  checkLayout,
  compareBlind,
  formatBlindSummary,
  type BlindReader,
  type BlindReaderInput,
  type LayoutLike,
} from "../src/blind.js";
import { listImageFiles, readChainRecordsFile } from "../src/blindCommon.js";
import { readLedgerImages, type LedgerResultEntry, type LogSource } from "../src/imageVerify.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, "../../ballot-gen/sample/output");
const LAYOUT_PATH = join(SAMPLE, "ballot-layout.json");
const election = JSON.parse(readFileSync(join(SAMPLE, "election-file.json"), "utf8"));
const layout = JSON.parse(readFileSync(LAYOUT_PATH, "utf8")) as LayoutLike;
const ORDER = ["q1", "q2", "q3"];
const entry = (results: string): LedgerResultEntry => ({ results, resultsHash: keccakHex(results) });

const hasCv2 = spawnSync("python3", ["-c", "import cv2, numpy"]).status === 0;
const tmp = () => mkdtempSync(join(tmpdir(), "blind-test-"));

describe("compareBlind (blind reading vs the on-chain resultsHash)", () => {
  it("match when keccak256 of the blind string equals the on-chain resultsHash", () => {
    expect(compareBlind("V:c1|O|V:c2+c4", [entry("V:c1|O|V:c2+c4")], ORDER).status).toBe("match");
  });
  it("mismatch lists the differing question with both readings (a deliberately tampered record)", () => {
    const c = compareBlind("V:c1|V:c3|V:c3+c4", [entry("V:c1|V:c2|V:c3+c4")], ORDER);
    expect(c.status).toBe("mismatch");
    expect(c.differences).toEqual([{ questionIndex: 1, questionId: "q2", blind: "V:c3", chain: "V:c2" }]);
  });
  it("a tampered multi-mark answer is a mismatch even when only the ascending order of ids differs by one choice", () => {
    expect(compareBlind("V:c1|V:c2|V:c3+c4", [entry("V:c1|V:c2|V:c3+c5")], ORDER).status).toBe("mismatch");
  });
  it("unclear when the blind reading has U and every decided question agrees; mismatch when a decided one differs", () => {
    expect(compareBlind("V:c1|U|V:c3+c4", [entry("V:c1|V:c2|V:c3+c4")], ORDER).status).toBe("unclear");
    expect(compareBlind("V:c2|U|V:c3+c4", [entry("V:c1|V:c2|V:c3+c4")], ORDER)).toMatchObject({ status: "mismatch", differences: [{ questionId: "q1" }] });
  });
  it("a different number of answers is a mismatch; an image on two records must match both", () => {
    expect(compareBlind("V:c1|B", [entry("V:c1|B|B")], ORDER).status).toBe("mismatch");
    expect(compareBlind("B|B|B", [entry("B|B|B"), entry("V:c1|B|B")], ORDER).status).toBe("mismatch");
    expect(compareBlind("B|B|B", [entry("B|B|B"), entry("B|B|B")], ORDER).status).toBe("match");
  });
});

describe("layout and election file", () => {
  it("accepts the layout the election file commits to (layoutHash)", () => {
    expect(checkLayout(layout, election)).toEqual([]);
  });
  it("rejects a layout whose hash differs, or whose ovals do not fit the election", () => {
    expect(() => checkLayout({ ...layout, tearLineY: 228 }, election)).toThrow(/layoutHash/);
    const noHash = { ...election, layoutHash: undefined };
    const fewer = { ...layout, questions: layout.questions.map((q, i) => (i === 2 ? { ...q, ovals: q.ovals.slice(0, 4) } : q)) };
    expect(() => checkLayout(fewer, noHash)).toThrow(/ovals/);
    const wrongMax = { ...layout, questions: layout.questions.map((q, i) => (i === 0 ? { ...q, maxMarks: 2 } : q)) };
    expect(() => checkLayout(wrongMax, noHash)).toThrow(/maxMarks/);
  });
});

describe("ledger entries and offline chain records", () => {
  const iface = new Interface(["event BallotAccepted(bytes32 indexed electionKey, bytes32 indexed ballotKey, string results, bytes32 imageSha256, bytes32 recordSha256, bool reviewed)"]);
  const ev = iface.getEvent("BallotAccepted")!;
  it("readLedgerImages keeps the results string and its keccak256 per image hash", async () => {
    const h = "ab".repeat(32);
    const enc = iface.encodeEventLog(ev, [electionKey("BEINGS-2026-4CRWX2"), "0x" + "bb".repeat(32), "V:c1|O|V:c2+c4", "0x" + h, "0x" + "cc".repeat(32), false]);
    const source: LogSource = { getBlockNumber: async () => 5, getLogs: async () => [{ topics: enc.topics, data: enc.data }] };
    const r = await readLedgerImages(source, "BEINGS-2026-4CRWX2", { fromBlock: 1, toBlock: 5, chunk: 100, concurrency: 1 });
    expect(r.entries!.get(h)).toEqual([{ results: "V:c1|O|V:c2+c4", resultsHash: keccakHex("V:c1|O|V:c2+c4") }]);
  });
  it("reads a records file and rejects malformed ones", () => {
    const d = tmp();
    writeFileSync(join(d, "ok.json"), JSON.stringify([{ imageSha256: "0x" + "AB".repeat(32), results: "B|B|B" }]));
    expect(readChainRecordsFile(join(d, "ok.json")).get("ab".repeat(32))).toEqual([entry("B|B|B")]);
    writeFileSync(join(d, "bad.json"), JSON.stringify([{ imageSha256: "xyz", results: "B" }]));
    expect(() => readChainRecordsFile(join(d, "bad.json"))).toThrow(/bad imageSha256/);
  });
});

// ------------------------------------------------------------------------------------ end to end on synthetic scans
type Spec = { fill: Record<string, number>; results: string; angle?: number };
const SPECS: Spec[] = [
  { fill: { "q1/c1": 1, "q2/c3": 1, "q3/c3": 1, "q3/c4": 1 }, results: "V:c1|V:c3|V:c3+c4" },
  { fill: { "q1/c1": 1, "q2/c2": 1, "q2/c3": 1, "q3/c2": 1, "q3/c4": 1 }, results: "V:c1|O|V:c2+c4", angle: -1.5 },
  { fill: { "q1/c2": 1, "q3/c1": 1, "q3/c5": 1 }, results: "V:c2|B|V:c1+c5", angle: 0.4 },
];

function synth(dir: string, name: string, fill: Record<string, number>, angle = 1.2, blank = false): string {
  const p = join(dir, name);
  execFileSync("python3", [join(here, "fixtures/synth_ballot.py"), "--layout", LAYOUT_PATH, "--out", p, "--fill", JSON.stringify(fill), "--angle", String(angle), ...(blank ? ["--blank"] : [])]);
  return p;
}

describe.skipIf(!hasCv2)("blind re-read on synthetic scans (needs python3 + opencv)", () => {
  const dir = tmp();
  const files = SPECS.map((s, i) => synth(dir, `s${i}.png`, s.fill, s.angle));
  const shaOf = (f: string) => sha256Hex(readFileSync(f));
  const chainFor = (resultsPerFile: string[]) => new Map(files.map((f, i) => [shaOf(f), [entry(resultsPerFile[i]!)]]));
  const run = (chain: Map<string, LedgerResultEntry[]>, extra: Partial<Parameters<typeof blindReread>[0]> = {}) =>
    blindReread({ electionCode: "BEINGS-2026-4CRWX2", election, layoutPath: LAYOUT_PATH, images: files.map((path) => ({ path })), chain, outDir: tmp(), ...extra });

  it("every ballot reads back and matches its on-chain record; exit code 0", async () => {
    const { report } = await run(chainFor(SPECS.map((s) => s.results)));
    expect(report.counts.match).toBe(3);
    expect(report.ok).toBe(true);
    expect(blindExitCode(report)).toBe(0);
    for (const e of report.entries) expect(e.blind!.results).toBe(SPECS[files.findIndex((f) => shaOf(f) === e.imageSha256)]!.results);
    expect(formatBlindSummary(report)).toContain("OK: every blind reading matches");
  });

  it("the masked image shows nothing but the ovals (QR, code, headings, receipt, marks are black)", async () => {
    const outDir = tmp();
    const { report, maskManifest } = await run(chainFor(SPECS.map((s) => s.results)), { outDir });
    for (const e of report.entries) {
      const audit = JSON.parse(execFileSync("python3", [BLIND_SCRIPT, "audit", "--masked", join(outDir, e.maskedFile!), "--layout", LAYOUT_PATH]).toString());
      expect(audit.nonBlackOutside).toBe(0);
      expect(audit.nonBlackInside).toBeGreaterThan(1000);
    }
    // the manifest is keyed only by the image hash; no QR/ballot-code information anywhere in it or the report
    expect(Object.keys(maskManifest.images).sort()).toEqual(files.map(shaOf).sort());
    expect(JSON.stringify(maskManifest) + JSON.stringify(report)).not.toMatch(/ABCD|BEINGS1|ballotCode|ballotKey/);
  });

  it("with --keep-ids the faint choice ids stay visible but still nothing else", async () => {
    const outDir = tmp();
    const { report } = await run(chainFor(SPECS.map((s) => s.results)), { outDir, keepIds: true });
    expect(report.counts.match).toBe(3);
    const e = report.entries[0]!;
    const audit = JSON.parse(execFileSync("python3", [BLIND_SCRIPT, "audit", "--keep-ids", "--masked", join(outDir, e.maskedFile!), "--layout", LAYOUT_PATH]).toString());
    expect(audit.nonBlackOutside).toBe(0);
  });

  it("a deliberately tampered on-chain record is a mismatch showing both readings, and the exit code is 2", async () => {
    const tampered = SPECS.map((s) => s.results);
    tampered[0] = "V:c1|V:c2|V:c3+c4"; // the paper says V:c3 for q2
    const { report } = await run(chainFor(tampered));
    expect(report.counts).toMatchObject({ match: 2, mismatch: 1 });
    const bad = report.entries.find((e) => e.status === "mismatch")!;
    expect(bad.blind!.results).toBe("V:c1|V:c3|V:c3+c4");
    expect(bad.chain![0]!.results).toBe("V:c1|V:c2|V:c3+c4");
    expect(bad.differences).toEqual([{ questionIndex: 1, questionId: "q2", blind: "V:c3", chain: "V:c2" }]);
    expect(report.ok).toBe(false);
    expect(blindExitCode(report)).toBe(2);
    expect(formatBlindSummary(report)).toContain("MISMATCH");
  });

  it("an oval in the 15-50 % band is flagged unclear (not a match, not a mismatch); --strict makes it fail", async () => {
    const d = tmp();
    const f = synth(d, "u.png", { "q1/c1": 1, "q2/c3": 0.35, "q3/c2": 1 });
    const chain = new Map([[sha256Hex(readFileSync(f)), [entry("V:c1|V:c3|V:c2")]]]);
    const { report } = await blindReread({ electionCode: "BEINGS-2026-4CRWX2", election, layoutPath: LAYOUT_PATH, images: [{ path: f }], chain, outDir: tmp() });
    const e = report.entries[0]!;
    expect(e.status).toBe("unclear");
    expect(e.blind!.results).toBe("V:c1|U|V:c2");
    expect(e.unclearOvals![0]).toMatch(/^q2\/c3=\d+$/);
    expect(blindExitCode(report)).toBe(0);
    expect(blindExitCode(report, true)).toBe(2);
    // the same unclear ballot against a record that differs in a DECIDED question is a mismatch
    const chain2 = new Map([[sha256Hex(readFileSync(f)), [entry("V:c2|V:c3|V:c2")]]]);
    const r2 = await blindReread({ electionCode: "BEINGS-2026-4CRWX2", election, layoutPath: LAYOUT_PATH, images: [{ path: f }], chain: chain2, outDir: tmp() });
    expect(r2.report.entries[0]!.status).toBe("mismatch");
  });

  it("reports no-image, not-on-chain and unreadable", async () => {
    const d = tmp();
    const blank = synth(d, "blank.png", {}, 0, true);
    const extra = synth(d, "extra.png", { "q1/c1": 1 });
    const ghost = "ee".repeat(32);
    const chain = new Map<string, LedgerResultEntry[]>([[ghost, [entry("B|B|B")]], [sha256Hex(readFileSync(blank)), [entry("B|B|B")]]]);
    const { report } = await blindReread({ electionCode: "BEINGS-2026-4CRWX2", election, layoutPath: LAYOUT_PATH, images: [{ path: blank }, { path: extra }], chain, outDir: tmp() });
    const by = Object.fromEntries(report.entries.map((e) => [e.imageSha256, e.status]));
    expect(by[ghost]).toBe("no-image");
    expect(by[sha256Hex(readFileSync(blank))]).toBe("unreadable");
    expect(by[sha256Hex(readFileSync(extra))]).toBe("not-on-chain");
    expect(blindExitCode(report)).toBe(0);
    expect(blindExitCode(report, true)).toBe(2);
  });

  it("a pluggable reader gets only the masked image: no path or hash of the original, no QR or ballot code", async () => {
    const seen: BlindReaderInput[] = [];
    const fake: BlindReader = {
      name: "fake",
      async read(input) {
        seen.push(input);
        return { fillScores: { q1: { c1: 100, c2: 0 }, q2: { c1: 0, c2: 0, c3: 0, c4: 0 }, q3: { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 } } };
      },
    };
    const { report } = await run(chainFor(SPECS.map((s) => s.results)), { reader: fake });
    expect(report.reader).toBe("fake");
    expect(report.counts.mismatch).toBe(3); // the fake reader reads every ballot as V:c1|B|B
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(Object.keys(s).sort()).toEqual(["frame", "layoutPath", "maskedPng", "maskedPngPath", "ovals", "questions", "resultRules"]);
      expect(s.maskedPngPath).toMatch(/masked[\\/][0-9a-f]{64}\.png$/);
      expect(s.maskedPng.length).toBeGreaterThan(100);
      expect(JSON.stringify({ ...s, maskedPng: undefined })).not.toContain(dir);
    }
  });

  it("an external command can be the reader (hook for a vision model): JSON in, JSON out", async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);if(i.maskedPng||!i.maskedPngPath)process.exit(9);" +
      "const r={};for(const q of i.questions)r[q.id]='B';r.q1='V:c1';console.log(JSON.stringify({results:r}))})";
    const reader = new ExternalCommandReader([process.execPath, "-e", script]);
    const chain = new Map([[shaOf(files[0]!), [entry("V:c1|B|B")]]]);
    const { report } = await run(chain, { reader, images: [{ path: files[0]! }] } as never);
    expect(report.reader).toMatch(/^external:/);
    expect(report.entries[0]).toMatchObject({ status: "match" });
    const failing = new ExternalCommandReader([process.execPath, "-e", "process.exit(4)"]);
    const r2 = await run(chain, { reader: failing, images: [{ path: files[0]! }] } as never);
    expect(r2.report.entries[0]!.status).toBe("unreadable");
  });

  it("lists only png/jpg files of an image directory", () => {
    const d = tmp();
    for (const n of ["a.png", "b.JPG", "manifest.json", "report.json", "c.pdf"]) writeFileSync(join(d, n), "x");
    expect(listImageFiles(d).map((i) => i.path.slice(d.length + 1))).toEqual(["a.png", "b.JPG"]);
  });

  it("refuses a layout that is not the one the election file commits to", async () => {
    const d = tmp();
    const other = join(d, "layout.json");
    writeFileSync(other, JSON.stringify({ ...layout, tearLineY: 230 }));
    await expect(blindReread({ electionCode: "x", election, layoutPath: other, images: [], chain: new Map(), outDir: d })).rejects.toThrow(/layoutHash/);
  });
});
