// Upload step against a MOCK image store on 127.0.0.1 only. The live API is never contacted.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealBatch } from "../src/fsbatch.mjs";
import { DEFAULT_IMAGE_STORE_URL, planUpload, resolveUploadUrl, runUpload } from "../src/upload.mjs";
import { makePng, tmpRoot, writeBatch, CODE } from "./helpers.mjs";

const TOKEN = "test-token-not-real-0123456789";
const codes = ["AAAAAAAAAAAA", "BBBBBBBBBBBB"];

async function sealedWithReadings({ flagPage } = {}) {
  const root = tmpRoot();
  const { dir, manifest } = writeBatch(root, "batch-20261109-202954", { pages: 2 });
  await sealBatch(dir, { electionDir: root });
  const { loadBatch } = await import("../src/fsbatch.mjs");
  const b = loadBatch(dir);
  mkdirSync(join(dir, "reader"));
  const readings = manifest.pages.map((p, i) => {
    const r = { scan: p.index, ballotCode: codes[i], electionCode: CODE, fillScores: { q1: { c1: 80 } }, results: { q1: "V:c1" }, resultsString: "V:c1", imageSha256: p.sha256 };
    writeFileSync(join(dir, "reader", `page-0${p.index}.result.json`), JSON.stringify({ ballotCode: codes[i], imageSha256: p.sha256 }));
    return r;
  });
  return { dir, readings: { kind: "beings-readings/unsigned-1", electionCode: CODE, retentionDays: 3, batch: { batchId: b.batchId, manifestSha256: b.manifestSha256, pages: 2 }, problems: [], review: flagPage ? [{ page: flagPage, why: ["unclear"] }] : [], readings } };
}

describe("upload plan (gate)", () => {
  it("plans every reviewed page of a sealed batch", async () => {
    const { dir, readings } = await sealedWithReadings();
    const p = planUpload(dir, readings, {});
    expect(p.problems).toEqual([]);
    expect(p.retentionDays).toBe(3);
    expect(p.items.map((i) => i.page)).toEqual([1, 2]);
  });
  it("skips flagged pages unless told to include them", async () => {
    const { dir, readings } = await sealedWithReadings({ flagPage: 2 });
    expect(planUpload(dir, readings).items.map((i) => i.page)).toEqual([1]);
    expect(planUpload(dir, readings, { includeFlagged: true }).items.map((i) => i.page)).toEqual([1, 2]);
  });
  it("refuses readings from another manifest, a retention mismatch, and changed pictures", async () => {
    const { dir, readings } = await sealedWithReadings();
    expect(planUpload(dir, { ...readings, batch: { ...readings.batch, manifestSha256: "0".repeat(64) } }).problems.join()).toMatch(/different manifest/);
    expect(planUpload(dir, readings, { retentionDays: 30 }).problems.join()).toMatch(/differs/);
    writeFileSync(join(dir, "page-01.png"), makePng(85, 140, 9999));
    expect(() => planUpload(dir, readings)).toThrow(/QUARANTINED/);
  });
  it("refuses an unsealed batch", async () => {
    const root = tmpRoot();
    const { dir } = writeBatch(root, "batch-20261109-210000", { pages: 1 });
    expect(() => planUpload(dir, { kind: "beings-readings/unsigned-1" })).toThrow(/CAPTURED and must not be read/);
  });
});

describe("upload run", () => {
  it("needs the exact batch id and a token in the environment", async () => {
    const { dir, readings } = await sealedWithReadings();
    const plan = planUpload(dir, readings);
    const send = async () => ({ code: 0, out: "{}" });
    await expect(runUpload(plan, { approve: "yes", env: { SCANNER_UPLOAD_TOKEN: TOKEN }, send })).rejects.toThrow(/--approve must be exactly batch-20261109-202954/);
    await expect(runUpload(plan, { approve: plan.batchId, env: {}, send })).rejects.toThrow(/SCANNER_UPLOAD_TOKEN/);
  });
  it("sends to the Worker unless --url or IMAGE_STORE_URL is set", async () => {
    const { dir, readings } = await sealedWithReadings();
    const plan = planUpload(dir, readings);
    const calls = [];
    const send = async (args) => (calls.push(args), { code: 0, out: JSON.stringify({ status: "created", deleteAfter: "2026-12-01T00:00:00.000Z" }) });
    await runUpload(plan, { approve: plan.batchId, env: { SCANNER_UPLOAD_TOKEN: TOKEN }, send });
    expect(calls[0]).toContain(DEFAULT_IMAGE_STORE_URL);
    expect(DEFAULT_IMAGE_STORE_URL).toBe("https://beings-ballot-images.beingsvote-test.workers.dev");
    calls.length = 0;
    await runUpload(plan, { approve: plan.batchId, url: "http://127.0.0.1:9", env: { SCANNER_UPLOAD_TOKEN: TOKEN, IMAGE_STORE_URL: "https://other.example" }, send });
    expect(calls[0]).toContain("http://127.0.0.1:9");
    expect(resolveUploadUrl(undefined, { IMAGE_STORE_URL: "https://other.example" })).toBe("https://other.example");
    expect(resolveUploadUrl(undefined, { IMAGE_STORE_URL: "  " })).toBe(DEFAULT_IMAGE_STORE_URL);
  });
  it("stops at the first refusal and never repeats the token or a code", async () => {
    const { dir, readings } = await sealedWithReadings();
    const plan = planUpload(dir, readings);
    let calls = 0;
    const send = async () => (++calls, { code: 1, out: "", err: `error: upload refused (401) token ${TOKEN} code AAAAAAAAAAAA` });
    const r = await runUpload(plan, { approve: plan.batchId, env: { SCANNER_UPLOAD_TOKEN: TOKEN }, send });
    expect(calls).toBe(1);
    expect(r.sent).toBe(0);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("AAAAAAAAAAAA");
  });
});

describe("upload through @beings/scanner's CLI to a mock store", () => {
  let server;
  let url;
  const seen = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, path: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "created", key: "k", deleteAfter: "2026-11-13T15:00:00Z" }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("sends each picture with the agreed headers; only the ballot key, never the code", async () => {
    const { dir, readings } = await sealedWithReadings();
    const plan = planUpload(dir, readings);
    const r = await runUpload(plan, { approve: plan.batchId, url, env: { ...process.env, SCANNER_UPLOAD_TOKEN: TOKEN, IMAGE_STORE_URL: "" } });
    expect(r.results.map((x) => x.error)).toEqual([null, null]);
    expect(r.sent).toBe(2);
    expect(seen).toHaveLength(2);
    seen.forEach((s, i) => {
      expect(s.method).toBe("POST");
      expect(s.path).toBe("/api/images");
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.headers["x-election-code"]).toBe(CODE);
      expect(s.headers["x-image-sha256"]).toBe(plan.items[i].imageSha256);
      expect(s.headers["x-ballot-key"]).toBe(keccak256(toUtf8Bytes(codes[i])));
      expect(s.headers["x-retention-days"]).toBe("3");
      expect(s.headers["content-type"]).toBe("image/png");
      expect(JSON.stringify(s.headers)).not.toContain(codes[i]);
    });
  }, 60000);
});
