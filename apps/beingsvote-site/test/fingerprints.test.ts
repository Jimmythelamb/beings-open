// Automatic fingerprints (create form), the approved scanner builds list, "Register Scanner/Printer", the
// "What was recorded, and why it matters" section and its in-browser checks, the "Local Scanner/Printer" label and the
// spare-ballot setting moved into the ballot design step. Synthetic data only: no network, no wallet, no ballot codes
// from any real election (the codes below are made-up 12-character strings).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FP from "../public/js/fingerprints.js";
import { SCANNER_BUILDS, SCANNER_BUILDS_SCHEMA } from "../public/js/scanner-builds.js";
import { canonicalize, sha256Hex } from "../public/js/format.js";
import * as Logic from "../public/js/logic.js";
import { merkleRoot, utf8, isAddress, DEFAULT_SPARE_PERCENT, draftElectionFile, validateElectionFile } from "../public/js/logic.js";
import { CONFIG } from "../public/js/config.js";
import { HELP_TEXT } from "../public/js/help.js";

const F: any = FP;
const printedBallots: (r: unknown, s?: unknown) => number = (Logic as any).printedBallots;
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const admin = src("../public/js/admin.js");
const QB_APP = "06694fe1cdf4766e89d713efca9c78dcf82f413b8de2907fff946aa895695527";
const omrPath = fileURLToPath(new URL("../../../packages/scanner/prototype/omr.py", import.meta.url));
const LAYOUT = "ab".repeat(32);
const deps = { sha256Hex, canonicalize, utf8 };

describe("approved scanner builds list", () => {
  it("is well formed: one default, 64-hex values, every entry says what it covers and how it was derived", () => {
    expect(SCANNER_BUILDS_SCHEMA).toBe("beings-scanner-builds/1");
    expect(SCANNER_BUILDS.filter((b) => b.default)).toHaveLength(1);
    for (const b of SCANNER_BUILDS) {
      expect(b.sha256, b.id).toMatch(/^[0-9a-f]{64}$/);
      expect(b.label.length, b.id).toBeGreaterThan(5);
      expect(b.covers.length, b.id).toBeGreaterThan(40);
      expect(b.derivation.length, b.id).toBeGreaterThan(40);
      expect(b.date, b.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["agreed-label", "file-sha256"]).toContain(b.kind);
    }
    expect(new Set(SCANNER_BUILDS.map((b) => b.sha256)).size).toBe(SCANNER_BUILDS.length);
  });
  it("the default is QB1TTH's scanner value, honestly marked as an agreed label (not a software hash)", () => {
    const d: any = F.defaultBuilds()[0];
    expect(d.sha256).toBe(QB_APP);
    expect(d.kind).toBe("agreed-label");
    expect(d.derivation).toMatch(/not the SHA-256 of any file/);
    const pub = JSON.parse(src("../public/data/elections/BEINGS-2026-QB1TTH.json"));
    expect(pub.file.approvedAppHashes).toEqual([QB_APP]);
  });
  it("every file-sha256 entry really is the SHA-256 of the file it names (recomputed now)", () => {
    for (const b of SCANNER_BUILDS.filter((x) => x.kind === "file-sha256")) {
      const path = fileURLToPath(new URL(`../../../${b.file}`, import.meta.url));
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), b.id).toBe(b.sha256);
    }
  });
  it("findBuild accepts 0x and upper case", () => {
    expect(F.findBuild(`0x${QB_APP.toUpperCase()}`)?.id).toBe("classroom-station-label-2026-11");
    expect(F.findBuild("cd".repeat(32))).toBeNull();
  });
});

describe("create form: fingerprints filled in automatically", () => {
  it("uses the designer's layout fingerprint and the site's default build, with no typing", () => {
    const r = F.resolveCreateFingerprints({ designedLayoutHash: `0x${LAYOUT.toUpperCase()}` });
    expect(r).toMatchObject({ layoutHash: LAYOUT, layoutSource: "designed", approvedAppHashes: [QB_APP], appsSource: "default", problems: [] });
  });
  it("Advanced layout override wins when valid, and is refused with a plain message when not", () => {
    expect(F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, layoutOverride: ` 0x${"cd".repeat(32)} ` })).toMatchObject({ layoutHash: "cd".repeat(32), layoutSource: "advanced", problems: [] });
    const bad = F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, layoutOverride: "abc" });
    expect(bad.problems).toEqual([{ field: "layoutHash", message: expect.stringMatching(/isn't 64 hex characters/) }]);
  });
  it("blocks when the ballot hasn't been designed and nothing was typed", () => {
    const r = F.resolveCreateFingerprints({});
    expect(r.layoutHash).toBeNull();
    expect(r.problems[0]).toMatchObject({ field: "layoutHash", message: expect.stringMatching(/hasn't been designed yet/) });
  });
  it("Advanced scanner build: ticked builds plus pasted ones, de-duplicated; bad or empty input blocks", () => {
    const omr = SCANNER_BUILDS.find((b) => b.kind === "file-sha256")!.sha256;
    const r = F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, useAppsOverride: true, appsSelected: [omr], appsPasted: `0x${omr}\n${"ef".repeat(32)}` });
    expect(r).toMatchObject({ appsSource: "advanced", approvedAppHashes: [omr, "ef".repeat(32)], problems: [] });
    expect(F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, useAppsOverride: true, appsPasted: "nothex" }).problems[0].message).toMatch(/isn't 64 hex characters: nothex/);
    expect(F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, useAppsOverride: true }).problems[0].message).toMatch(/Tick at least one scanner build/);
  });
  it("blocks with a plain message if the site has no default build", () => {
    const r = F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT, builds: [] });
    expect(r.problems).toEqual([{ field: "approvedAppHashes", message: expect.stringMatching(/no approved scanner build/) }]);
    expect(F.FIELD_LABEL.approvedAppHashes).toBe("Approved scanner build");
  });
  it("the resolved values pass the election-file validation that guards creation", () => {
    const r = F.resolveCreateFingerprints({ designedLayoutHash: LAYOUT });
    const f = draftElectionFile({ name: "Room 12", electionCode: "BEINGS-2026-TSTAAA", organizer: "0x2222222222222222222222222222222222222222", opensAt: "2026-11-16T16:00:00.000Z", closesAt: "2026-11-16T22:00:00.000Z", registeredVoters: 2, quorum: 1, retentionDays: 3, approvedAppHashes: r.approvedAppHashes, layoutHash: r.layoutHash, ballotCodes: ["AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC"], questions: [{ text: "Pizza?", choices: ["Yes", "No"], maxMarks: 1 }] });
    expect(validateElectionFile(f)).toEqual([]);
    expect(validateElectionFile({ ...f, approvedAppHashes: [] }).map((p) => p.field)).toContain("approvedAppHashes");
    expect(validateElectionFile({ ...f, layoutHash: null }).map((p) => p.field)).toContain("layoutHash");
  });
  it("admin.js no longer asks the organizer to type hashes: both fields sit under Advanced folds", () => {
    expect(admin).toContain("Advanced: use a layout fingerprint made elsewhere");
    expect(admin).toContain("Advanced: use a different scanner build");
    expect(admin).toContain("resolveCreateFingerprints(");
    expect(admin).not.toContain("Approved scanner app fingerprints");
    expect(admin).toMatch(/if \(fp\.problems\.length\) return fill\(out, callout\("warn", "A few things need fixing"/);
  });
});

describe("spare ballots: set in the ballot design step", () => {
  it("printed = ceil(registered × (1 + spare/100)), at least 1; default 0% (also for an empty box) when the designer is skipped", () => {
    expect(DEFAULT_SPARE_PERCENT).toBe(0);
    expect(printedBallots(30, 10)).toBe(33);
    expect(printedBallots(6, 0)).toBe(6);
    expect(printedBallots(6)).toBe(6);
    expect(printedBallots(6, "")).toBe(6);
    expect(printedBallots(6, "  ")).toBe(6);
    expect(printedBallots(6, "abc")).toBe(6);
    expect(printedBallots(6, 25)).toBe(8);
    expect(printedBallots(0, 25)).toBe(1);
    expect(printedBallots(100, 25)).toBe(125);
    for (const [r, s] of [[7, 25], [13, 33], [1, 200]] as [number, number][]) expect(printedBallots(r, s)).toBe(Math.max(Math.ceil(r * (1 + s / 100)), 1));
  });
  it("the Extra ballots field is gone from the main form and shown with the designed ballot", () => {
    expect(admin).toMatch(/h\("div", \{ class: "grid" \}, nameIn, codeIn, opens, closes, reg, quorum\)/);
    expect(admin).toContain("publicRow");
    expect(admin).toMatch(/publicRow,\s*days,/);
    expect(admin).toMatch(/h\("div", \{ class: "spare-step" \}, spare, printedLine\)/);
    expect(admin).toMatch(/value: String\(DEFAULT_SPARE_PERCENT\)/);
    expect(admin).toMatch(/const printed = printedBallots\(registered, val\(spare\)\)/);
    expect(HELP_TEXT["create.spare"]).toMatch(/design the ballot/);
    expect(HELP_TEXT["create.spare"]).toMatch(/starts at 0%.*empty box also means 0/);
    expect(HELP_TEXT["create.spare"]).not.toMatch(/25%/);
  });
});

describe("Local Scanner/Printer wording", () => {
  it("the quorum field is labelled Local Scanner/Printer, with the classroom explanation", () => {
    expect(admin).toMatch(/id: "c-quorum", help: "create\.quorum", label: "Local Scanner\/Printer"/);
    expect(admin).not.toMatch(/Scanning phones that must agree|Register phone|Register a scanning phone/);
    expect(HELP_TEXT["create.quorum"]).toMatch(/one scanner\/printer station run through a signing crypto-wallet/);
    expect(HELP_TEXT["admin.device"]).toMatch(/Local Scanner\/Printer/);
  });
  it("the admin page registers stations with a Register Scanner/Printer button", () => {
    expect(admin).toContain('"Register Scanner/Printer")');
    expect(admin).toMatch(/method: "registerDevice"/);
    expect(admin).toContain("Only during Setup, before voting opens.");
    expect(admin).toMatch(/"Scanner\/Printer registered"/);
    expect(admin).toMatch(/"Registration failed"/);
  });
  it("the site offers a known station wallet (public address only)", () => {
    const list = (CONFIG as any).scannerStations;
    expect(Array.isArray(list)).toBe(true);
    for (const s of list) {
      expect(isAddress(s.address)).toBe(true);
      expect(Object.keys(s).sort()).toEqual(["address", "label"]);
    }
  });
});

describe("registerStationPlan", () => {
  const base = { address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", appHash: QB_APP, approved: [QB_APP], status: 1, isOrganizer: true, electionCode: "BEINGS-2026-TSTAAA" };
  it("ready to send: 0x build, plain lines that say Setup only, facts with the build label", () => {
    const p = F.registerStationPlan(base);
    expect(p.ok).toBe(true);
    expect(p.appHash).toBe(`0x${QB_APP}`);
    expect(p.title).toBe("Register Scanner/Printer");
    expect(p.lines.join(" ")).toMatch(/only be done during Setup/);
    expect(p.facts).toContainEqual(["Scanner build", SCANNER_BUILDS[0]!.label]);
  });
  it("refuses outside Setup, for non-organizers, bad addresses and unapproved builds", () => {
    expect(F.registerStationPlan({ ...base, status: 2 }).problems[0] as string).toMatch(/only be registered while the election is in Setup/);
    expect(F.registerStationPlan({ ...base, isOrganizer: false }).problems.join()).toMatch(/organizer/);
    expect(F.registerStationPlan({ ...base, address: "0x123" }).problems.join()).toMatch(/doesn't look right/);
    expect(F.registerStationPlan({ ...base, appHash: "cd".repeat(32) }).problems.join()).toMatch(/isn't one this election approved/);
    expect(F.registerStationPlan({ ...base, appHash: "zz" }).problems.join()).toMatch(/64 hex/);
  });
  it("stationStatus flags unapproved builds and the quorum", () => {
    const s = F.stationStatus([{ address: base.address, appHash: `0x${QB_APP}` }, { address: "0x2222222222222222222222222222222222222222", appHash: "0x" + "cd".repeat(32) }], [QB_APP], 1);
    expect(s).toMatchObject({ count: 2, quorumMet: true, allApproved: false });
    expect(s.rows.map((r: any) => r.approved)).toEqual([true, false]);
  });
});

describe("What was recorded, and why it matters: items", () => {
  const created = {
    stage: "created",
    fileSha256: "0x" + "11".repeat(32),
    ballotListRoot: "0x" + "22".repeat(32),
    layoutHash: LAYOUT,
    approvedAppHashes: [QB_APP],
    devices: [{ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", appHash: "0x" + QB_APP }],
    quorum: 1,
    merkleRoot: "0x" + "33".repeat(32),
    resultsSha256: "0x" + "44".repeat(32),
    recordSha256: "0x" + "55".repeat(32),
  };
  it("lists every recorded value with a name, a value and a why paragraph", () => {
    const items = F.recordedItems(created);
    expect(items.map((i: any) => i.id)).toEqual(["electionFile", "ballotList", "layout", "scannerBuilds", "stations", "merkleRoot", "results", "record"]);
    for (const i of items) {
      expect(i.name.length, i.id).toBeGreaterThan(8);
      expect(i.why.length, i.id).toBeGreaterThan(120);
      expect(i.value || i.values?.length, i.id).toBeTruthy();
    }
    expect(items.find((i: any) => i.id === "scannerBuilds").values[0]).toMatchObject({ tone: "info", note: expect.stringMatching(/agreed label/) });
    expect(items.find((i: any) => i.id === "layout").check.kind).toBe("layout");
    expect(items.find((i: any) => i.id === "stations").check.status.quorumMet).toBe(true);
  });
  it("before the tally: no Merkle root, results or record values, with a plain 'when' line", () => {
    const items = F.recordedItems({ ...created, merkleRoot: "0x" + "0".repeat(64), resultsSha256: undefined, recordSha256: undefined });
    const m = items.find((i: any) => i.id === "merkleRoot");
    expect(m.value).toBeNull();
    expect(m.pending).toMatch(/when the official tally is posted/);
    expect(items.some((i: any) => i.id === "record")).toBe(false);
  });
  it("preview (before Create): computed values, stations explained as the next step, nothing about the tally", () => {
    const items = F.recordedItems({ ...created, stage: "preview", devices: [] });
    expect(items.map((i: any) => i.id)).toEqual(["electionFile", "ballotList", "layout", "scannerBuilds", "stations"]);
    expect(items[0].check.kind).toBe("computed");
    expect(items.find((i: any) => i.id === "stations").pending).toMatch(/after creating the election, during Setup/);
  });
});

describe("Check it yourself (in the browser)", () => {
  const codes = ["AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC"];
  const file = { electionCode: "BEINGS-2026-TSTAAA", name: "Mock", questions: [{ id: "q1", text: "Q", maxMarks: 1, choices: [] }], ballotCodes: codes };
  it("election file: match, mismatch, public copy and bad JSON", async () => {
    const sha = "0x" + (await sha256Hex(utf8(canonicalize(file))));
    expect((await F.checkElectionFileText(JSON.stringify(file), sha, deps)).ok).toBe(true);
    expect((await F.checkElectionFileText(JSON.stringify({ ...file, name: "Edited" }), sha, deps)).ok).toBe(false);
    expect((await F.checkElectionFileText(JSON.stringify({ publicCopy: true, file }), sha, deps)).ok).toBeNull();
    expect((await F.checkElectionFileText("{", sha, deps)).ok).toBe(false);
  });
  it("ballot list: rebuilds the Merkle root from the codes", () => {
    const keccak = (b: Uint8Array) => keccak256(b);
    const root = merkleRoot(codes.map((c) => keccak(utf8(c))), keccak);
    const d = { keccak, merkleRoot, utf8 };
    expect(F.checkBallotListText(JSON.stringify(file), root, d).ok).toBe(true);
    expect(F.checkBallotListText(JSON.stringify({ ...file, ballotCodes: codes.slice(1) }), root, d).ok).toBe(false);
    expect(F.checkBallotListText(JSON.stringify({ ...file, ballotCodes: undefined }), root, d).ok).toBeNull();
  });
  it("layout: re-designs and compares", async () => {
    expect((await F.checkLayout(file, `0x${LAYOUT}`, async () => ({ layoutHash: LAYOUT }))).ok).toBe(true);
    expect((await F.checkLayout(file, `0x${LAYOUT}`, async () => ({ layoutHash: "cd".repeat(32) }))).ok).toBe(false);
    expect((await F.checkLayout({}, LAYOUT, async () => ({ layoutHash: LAYOUT }))).ok).toBeNull();
  });
  it("results file and scanner build file", async () => {
    const doc = { electionCode: "BEINGS-2026-TSTAAA", perQuestion: [] };
    const sha = "0x" + (await sha256Hex(utf8(canonicalize(doc))));
    expect((await F.checkResultsText(JSON.stringify(doc), sha, deps)).ok).toBe(true);
    expect((await F.checkResultsText(JSON.stringify({ ...doc, x: 1 }), sha, deps)).ok).toBe(false);
    const omr = new Uint8Array(readFileSync(omrPath));
    const omrBuild = SCANNER_BUILDS.find((b) => b.kind === "file-sha256")!.sha256;
    expect((await F.checkBuildBytes(omr, [omrBuild], deps)).ok).toBe(true);
    const r = await F.checkBuildBytes(omr, [QB_APP], deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/agreed test label, not a hash of a file/);
  });
});

// ------------------------------------------------------------------ the section rendered into a tiny fake DOM
class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: any[] = [];
  className = "";
  hidden = false;
  style: any = {};
  dataset: any = {};
  textContent = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: any[]) {
    this.children.push(...c);
  }
  appendChild(c: any) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: any[]) {
    this.children = c;
  }
  addEventListener() {}
  querySelector(): any {
    return new FakeEl("button");
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (c instanceof FakeEl ? c.text : String(c))).join("");
  }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = pred(this) ? [this] : [];
    for (const c of this.children) if (c instanceof FakeEl) out.push(...c.find(pred));
    return out;
  }
}
describe("What was recorded, and why it matters: rendering", () => {
  let ui: any;
  beforeAll(async () => {
    (globalThis as any).Node = FakeEl;
    (globalThis as any).document = { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (s: string) => Object.assign(new FakeEl("#text"), { textContent: s }) };
    ui = await import("../public/js/recorded-ui.js");
  });
  afterAll(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).Node;
  });
  const items = () => F.recordedItems({ stage: "created", fileSha256: "0x" + "11".repeat(32), ballotListRoot: "0x" + "22".repeat(32), layoutHash: LAYOUT, approvedAppHashes: [QB_APP], devices: [{ address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", appHash: "0x" + QB_APP }], quorum: 1, merkleRoot: "0x" + "33".repeat(32), resultsSha256: "0x" + "44".repeat(32) });
  it("renders a heading with help, every item, why paragraphs, copy buttons and checks", () => {
    const sec: any = ui.recordedSection(items(), { stage: "created", file: { questions: [{ id: "q1" }] }, deps: {} });
    const t = sec.text;
    expect(t).toContain("What was recorded, and why it matters");
    for (const n of ["Election file fingerprint", "Ballot code list fingerprint", "Ballot layout fingerprint", "Approved scanner build", "Local Scanner/Printer stations", "Merkle root", "Official results file fingerprint"]) expect(t).toContain(n);
    expect(sec.find((e: FakeEl) => e.tagName === "SUMMARY" && e.text === "Why it matters")).toHaveLength(7);
    expect(sec.find((e: FakeEl) => e.getAttribute("aria-label")?.startsWith("Copy "))).not.toHaveLength(0);
    expect(t).toContain("Check it yourself");
    expect(t).toContain("Re-design the ballot and compare");
    expect(t).toContain("Choose the election file to compare");
    expect(t).toContain("Recount it on the Verifier screen");
    expect(t).toContain("1 of 1 needed registered; every one runs an approved build");
    expect(t).toContain("0x11111111…11111111");
    expect(sec.find((e: FakeEl) => e.className === "help-btn")).toHaveLength(1);
  });
  it("preview: says nothing is on the ledger yet and that you don't type any of it", () => {
    const sec: any = ui.recordedSection(F.recordedItems({ stage: "preview", fileSha256: "0x" + "11".repeat(32), ballotListRoot: "0x" + "22".repeat(32), layoutHash: LAYOUT, approvedAppHashes: [QB_APP], devices: [], quorum: 1 }), { stage: "preview", file: null, deps: {} });
    expect(sec.text).toContain("Nothing is on the ledger yet");
    expect(sec.text).toContain("You don't need to type or copy any of them");
    expect(sec.text).toContain("Computed on this page just now");
    expect(sec.text).toContain("You register the Scanner/Printer after creating the election");
  });
  it("valueWithCopy shortens hashes and addresses but keeps the full value for screen readers", () => {
    const v: any = ui.valueWithCopy("0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", { address: true, label: "station" });
    expect(v.text).toContain("(full value 0xfB2A3F83F2362566341b8edfB008a0C42A52d73D)");
    expect(ui.valueWithCopy(null as any).text).toBe("—");
  });
});
