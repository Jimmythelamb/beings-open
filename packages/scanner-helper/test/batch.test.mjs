import { describe, expect, it } from "vitest";
import * as B from "../src/batch.mjs";

const H = (c) => c.repeat(64);
const manifest = (over = {}) => ({
  schema: B.MANIFEST_SCHEMA, electionCode: "BEINGS-2026-TSTAAA", batchId: "batch-20261109-202954", expectedPages: 2, state: "CAPTURED", dpi: 300, pageSize: "Legal",
  pages: [{ index: 1, file: "page-01.png", bytes: 10, sha256: H("a"), width: 2550, height: 4200 }, { index: 2, file: "page-02.png", bytes: 10, sha256: H("b"), width: 2550, height: 4200 }],
  ...over,
});
const files = (over = {}) => ({ "page-01.png": { bytes: 10, sha256: H("a"), width: 2550, height: 4200 }, "page-02.png": { bytes: 10, sha256: H("b"), width: 2550, height: 4200 }, ...over });

describe("names", () => {
  it("makes batch ids from local time and page names", () => {
    expect(B.batchIdFor(new Date(2026, 10, 9, 20, 29, 54))).toBe("batch-20261109-202954");
    expect(B.pageFileName(7)).toBe("page-07.png");
  });
});

describe("DONE line", () => {
  const d = { electionCode: "BEINGS-2026-TSTAAA", batchId: "batch-20261109-202954", pages: 7, manifestSha256: H("c"), sealedAt: "2026-11-09T20:31:00Z" };
  it("round-trips", () => {
    const line = B.formatDoneLine(d);
    expect(line.startsWith("DONE beings-scan-batch/1 ")).toBe(true);
    expect(B.parseDoneLine(line)).toMatchObject({ ...d, decoded: "no" });
  });
  it("refuses missing, doubled and malformed lines", () => {
    expect(B.parseDoneLine("").error).toMatch(/no DONE/);
    const line = B.formatDoneLine(d);
    expect(B.parseDoneLine(`${line}\n${line}`).error).toMatch(/more than one/);
    expect(B.parseDoneLine(line.replace("pages=7", "pages=0")).error).toMatch(/page count/);
    expect(B.parseDoneLine(line.replace(H("c"), "xyz")).error).toMatch(/fingerprint/);
  });
});

describe("SUPERSEDED line", () => {
  it("round-trips and needs a reason", () => {
    const l = B.formatSupersededLine({ batchId: "batch-20261109-202714", reason: "cancelled on page 7\nre-fed", replacedBy: "batch-20261109-202954", at: "t" });
    expect(B.parseSupersededLine(l)).toEqual({ batchId: "batch-20261109-202714", replacedBy: "batch-20261109-202954", at: "t", reason: "cancelled on page 7 re-fed" });
    expect(() => B.formatSupersededLine({ batchId: "b", reason: " ", at: "t" })).toThrow(/reason/);
  });
});

describe("checkBatch", () => {
  it("passes a complete batch", () => {
    expect(B.checkBatch(manifest(), files())).toEqual({ problems: [], warnings: [] });
  });
  it("INCIDENT-001: 6 of 7 saved is not sealable", () => {
    const m = manifest({ expectedPages: 3, state: "INCOMPLETE" });
    const r = B.checkBatch(m, files());
    expect(r.problems.join(" ")).toMatch(/2 of 3 pages saved: INCOMPLETE/);
    expect(r.problems.join(" ")).toMatch(/ended INCOMPLETE/);
  });
  it("an interrupted or still-capturing scan is never sealable, even with the right count", () => {
    expect(B.checkBatch(manifest({ state: "INTERRUPTED", stateReason: "Ctrl+C" }), files()).problems[0]).toMatch(/INTERRUPTED \(Ctrl\+C\)/);
    expect(B.checkBatch(manifest({ state: "CAPTURING" }), files()).problems[0]).toMatch(/never finished/);
  });
  it("finds missing, empty, changed and extra files", () => {
    expect(B.checkBatch(manifest(), files({ "page-02.png": undefined })).problems.join()).toMatch(/missing/);
    expect(B.checkBatch(manifest(), files({ "page-02.png": { bytes: 0, sha256: H("b"), width: 2550, height: 4200 } })).problems.join()).toMatch(/empty/);
    expect(B.checkBatch(manifest(), files({ "page-02.png": { bytes: 10, sha256: H("d"), width: 2550, height: 4200 } })).problems.join()).toMatch(/no longer match/);
    expect(B.checkBatch(manifest(), files({ "page-03.png": { bytes: 10, sha256: H("e"), width: 2550, height: 4200 } })).problems.join()).toMatch(/not in the manifest/);
  });
  it("finds the same image twice in one batch", () => {
    const m = manifest();
    m.pages[1].sha256 = H("a");
    expect(B.checkBatch(m, files({ "page-02.png": { bytes: 10, sha256: H("a"), width: 2550, height: 4200 } })).problems.join()).toMatch(/duplicate image/);
  });
  it("flags mixed page sizes and warns about a declared size mismatch", () => {
    expect(B.checkBatch(manifest(), files({ "page-02.png": { bytes: 10, sha256: H("b"), width: 2550, height: 3300 } })).problems.join()).toMatch(/different sizes/);
    const r = B.checkBatch(manifest({ pageSize: "Letter" }), files());
    expect(r.problems).toEqual([]);
    expect(r.warnings[0]).toMatch(/Letter/);
  });
  it("refuses a manifest without an expected count or with a bad shape", () => {
    expect(B.checkBatch(manifest({ expectedPages: undefined }), files()).problems.join()).toMatch(/expected page count/);
    expect(B.manifestShapeProblems(null)).toEqual(["manifest.json is not an object"]);
    expect(B.manifestShapeProblems(manifest({ schema: "x" }))[0]).toMatch(/schema/);
  });
});

describe("batchStatus / recording gate", () => {
  const msha = H("f");
  const done = B.formatDoneLine({ electionCode: "BEINGS-2026-TSTAAA", batchId: "batch-20261109-202954", pages: 2, manifestSha256: msha, sealedAt: "t" });
  it("only a valid DONE with a matching manifest is recordable", () => {
    const s = B.batchStatus({ manifest: manifest(), manifestSha256: msha, doneText: done });
    expect(s).toMatchObject({ state: "SEALED", recordable: true });
    expect(() => B.assertRecordable(s)).not.toThrow();
  });
  it("no DONE line: not recordable", () => {
    const s = B.batchStatus({ manifest: manifest(), manifestSha256: msha });
    expect(s).toMatchObject({ state: "CAPTURED", recordable: false });
    expect(() => B.assertRecordable(s, "batch-x")).toThrow(/batch-x is CAPTURED/);
    expect(B.batchStatus({ manifest: manifest({ state: "INCOMPLETE" }), manifestSha256: msha }).reasons[0]).toMatch(/do not record/);
  });
  it("manifest edited after sealing: quarantined", () => {
    expect(B.batchStatus({ manifest: manifest(), manifestSha256: H("0"), doneText: done })).toMatchObject({ state: "QUARANTINED", recordable: false });
  });
  it("superseded always wins, even over DONE", () => {
    const sup = B.formatSupersededLine({ batchId: "batch-20261109-202954", reason: "r", at: "t" });
    expect(B.batchStatus({ manifest: manifest(), manifestSha256: msha, doneText: done, supersededText: sup })).toMatchObject({ state: "SUPERSEDED", recordable: false });
  });
  it("no manifest: incomplete", () => {
    expect(B.batchStatus({})).toMatchObject({ state: "INCOMPLETE", recordable: false });
  });
});

describe("cross-batch rules", () => {
  const b = (batchId, state, shas) => ({ batchId, state, pages: shas.map((s, i) => ({ index: i + 1, sha256: s })) });
  it("same image in two live batches is a duplicate", () => {
    const d = B.crossBatchDuplicateImages([b("batch-1", "SEALED", [H("a"), H("b")]), b("batch-2", "CAPTURED", [H("c"), H("a")])]);
    expect(d).toEqual([{ sha256: H("a"), places: [{ batchId: "batch-1", index: 1 }, { batchId: "batch-2", index: 2 }] }]);
  });
  it("a superseded batch is ignored", () => {
    expect(B.crossBatchDuplicateImages([b("batch-1", "SUPERSEDED", [H("a")]), b("batch-2", "CAPTURED", [H("a")])])).toEqual([]);
  });
  it("unresolved batches block a new scan", () => {
    const list = [b("batch-1", "SUPERSEDED", []), b("batch-2", "SEALED", []), b("batch-3", "INTERRUPTED", []), b("batch-4", "CAPTURED", [])];
    expect(B.unresolvedBatches(list).map((x) => x.batchId)).toEqual(["batch-3", "batch-4"]);
  });
  it("code checks name pages, never codes", () => {
    const codes = ["AAAAAAAAAAAA", "BBBBBBBBBBBB"];
    const p = B.codeChecks([{ page: 1, ballotCode: "AAAAAAAAAAAA" }, { page: 2, ballotCode: "AAAAAAAAAAAA" }, { page: 3, ballotCode: "ZZZZZZZZZZZZ" }, { page: 4, ballotCode: null }, { page: 5, ballotCode: "BBBBBBBBBBBB" }], codes, [{ batchId: "batch-old", codes: new Set(["BBBBBBBBBBBB"]) }]);
    expect(p).toEqual(["page 2: same ballot code as page 1", "page 3: the ballot code is not on this election's list", "page 4: the ballot code could not be read (manual review)", "page 5: this ballot code is also in batch-old"]);
    expect(p.join(" ")).not.toMatch(/AAAA|BBBB|ZZZZ/);
  });
});
