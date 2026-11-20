import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBatches, loadBatch, sealBatch, supersedeBatch } from "../src/fsbatch.mjs";
import { pngSize } from "../src/png.mjs";
import { main } from "../src/cli.mjs";
import { makePng, tmpRoot, writeBatch } from "./helpers.mjs";

describe("png", () => {
  it("reads width and height, refuses non-PNG", () => {
    expect(pngSize(makePng(85, 140))).toEqual({ width: 85, height: 140 });
    expect(pngSize(Buffer.from("not a png at all, sorry"))).toBeNull();
  });
});

describe("seal", () => {
  it("seals a complete batch with one DONE line and logs it", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-202954", { pages: 7 });
    const r = await sealBatch(dir, { electionDir: root });
    expect(r.sealed).toBe(true);
    const done = readFileSync(join(dir, "DONE.txt"), "utf8");
    expect(done.trim().split("\n")).toHaveLength(1);
    expect(done).toMatch(/^DONE beings-scan-batch\/1 election=BEINGS-2026-TSTAAA batch=batch-20261109-202954 pages=7 /);
    expect(readFileSync(join(dir, "batch.log"), "utf8")).toMatch(/DONE/);
    expect(loadBatch(dir).status).toMatchObject({ state: "SEALED", recordable: true });
    expect((await sealBatch(dir, { electionDir: root })).already).toBe(true);
  });

  it("INCIDENT-001 replay: interrupted 6-of-7 batch is quarantined, re-fed batch seals after supersede", async () => {
    const root = tmpRoot();
    const first = writeBatch(root, "batch-20261109-202714", { pages: 6, expected: 7, state: "INTERRUPTED" });
    const r1 = await sealBatch(first.dir, { electionDir: root });
    expect(r1.sealed).toBe(false);
    expect(existsSync(join(first.dir, "DONE.txt"))).toBe(false);
    expect(readFileSync(join(first.dir, "QUARANTINED.txt"), "utf8")).toMatch(/6 of 7 pages saved: INCOMPLETE/);
    expect(loadBatch(first.dir).status.recordable).toBe(false);
    supersedeBatch(first.dir, { reason: "cancelled mid-feed on page 7; full stack re-fed", replacedBy: "batch-20261109-202954" });
    // the re-feed scans the same paper again, so the first six images may even be byte-identical: allowed because the old batch is superseded
    const second = writeBatch(root, "batch-20261109-202954", { pages: 7, imageSource: (i) => (i <= 6 ? readFileSync(join(first.dir, `page-0${i}.png`)) : makePng(85, 140, 999)) });
    const r2 = await sealBatch(second.dir, { electionDir: root });
    expect(r2.problems).toEqual([]);
    expect(r2.sealed).toBe(true);
    const states = Object.fromEntries(listBatches(root).map((b) => [b.batchId, b.status.state]));
    expect(states).toEqual({ "batch-20261109-202714": "SUPERSEDED", "batch-20261109-202954": "SEALED" });
  });

  it("refuses the same image bytes in two live batches", async () => {
    const root = tmpRoot();
    const a = writeBatch(root, "batch-20261109-100000", { pages: 2, seeds: [1, 2] });
    await sealBatch(a.dir, { electionDir: root });
    const b = writeBatch(root, "batch-20261109-110000", { pages: 2, seeds: [3, 2] });
    const r = await sealBatch(b.dir, { electionDir: root });
    expect(r.sealed).toBe(false);
    expect(r.problems.join()).toMatch(/page 2: the same image bytes are already in batch-20261109-100000/);
  });

  it("a picture changed after sealing makes the batch unreadable for recording", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-120000", { pages: 2 });
    await sealBatch(dir, { electionDir: root });
    writeFileSync(join(dir, "page-02.png"), makePng(85, 140, 4242));
    expect(loadBatch(dir).status).toMatchObject({ state: "QUARANTINED", recordable: false, reasons: ["picture(s) changed or missing since sealing: page 2"] });
    expect(await main(["verify", dir])).toBe(2);
  });

  it("editing the manifest after sealing un-seals it", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-130000", { pages: 2 });
    await sealBatch(dir, { electionDir: root });
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.expectedPages = 2;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m)); // same content, different bytes
    expect(loadBatch(dir).status).toMatchObject({ state: "QUARANTINED", recordable: false });
  });

  it("a quarantined batch that is fixed can be sealed; the earlier finding is kept", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-140000", { pages: 2 });
    const extra = join(dir, "page-03.png");
    writeFileSync(extra, makePng(85, 140, 77));
    expect((await sealBatch(dir, { electionDir: root })).sealed).toBe(false);
    (await import("node:fs")).rmSync(extra);
    expect((await sealBatch(dir, { electionDir: root })).sealed).toBe(true);
    expect(readdirSync(dir).some((n) => n.startsWith("QUARANTINED-resolved-"))).toBe(true);
  });

  it("seal with decode requires readable, distinct, listed codes", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-150000", { pages: 3 });
    const decode = async () => [{ page: 1, ballotCode: "AAAAAAAAAAAA" }, { page: 2, ballotCode: "AAAAAAAAAAAA" }, { page: 3, ballotCode: null }];
    const r = await sealBatch(dir, { electionDir: root, decode, ballotCodes: ["AAAAAAAAAAAA"] });
    expect(r.sealed).toBe(false);
    expect(r.problems).toEqual(["page 2: same ballot code as page 1", "page 3: the ballot code could not be read (manual review)"]);
    expect(readFileSync(join(dir, "QUARANTINED.txt"), "utf8")).not.toMatch(/AAAA/);
  });
});

describe("supersede", () => {
  it("needs a reason, and --force for a sealed batch", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-160000", { pages: 1 });
    expect(() => supersedeBatch(dir, { reason: "" })).toThrow(/reason/);
    await sealBatch(dir, { electionDir: root });
    expect(() => supersedeBatch(dir, { reason: "x" })).toThrow(/SEALED/);
    expect(supersedeBatch(dir, { reason: "x", force: true }).ok).toBe(true);
    expect(loadBatch(dir).status.state).toBe("SUPERSEDED");
    expect(readFileSync(join(dir, "batch.log"), "utf8")).toMatch(/SUPERSEDED/);
  });
});

describe("cli", () => {
  it("status, seal and supersede exit codes", async () => {
    const root = tmpRoot();
    const bad = writeBatch(root, "batch-20261109-170000", { pages: 1, expected: 2, state: "INCOMPLETE" });
    expect(await main(["seal", bad.dir])).toBe(2);
    expect(await main(["supersede", bad.dir, "--reason", "short feed"])).toBe(0);
    const good = writeBatch(root, "batch-20261109-171000", { pages: 2 });
    expect(await main(["seal", good.dir])).toBe(0);
    expect(await main(["status", root])).toBe(0);
  });
});
