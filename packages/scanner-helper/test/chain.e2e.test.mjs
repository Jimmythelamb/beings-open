// Whole classroom chain on a SYNTHETIC election: design on the website (ballotpdf.js) -> print PDF -> "scan"
// (pdftoppm at 300 dpi, ovals filled in) -> seal with decode -> read -> site accepts readings -> upload to a MOCK store.
// No real election, no network beyond 127.0.0.1, nothing signed.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { loadBatch, sealBatch } from "../src/fsbatch.mjs";
import { readBatch, readPages, loadFullElectionFile } from "../src/reader.mjs";
import { planUpload, runUpload } from "../src/upload.mjs";
import { tmpRoot, writeBatch } from "./helpers.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const site = resolve(here, "../../../apps/beingsvote-site/public/js");
const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const ready = has("python3", ["-c", "import cv2, numpy"]) && has("pdftoppm", ["-v"]);

describe.skipIf(!ready)("design -> print -> scan -> seal -> read -> upload (synthetic)", () => {
  it("works end to end and keeps B/O/V exactly", async () => {
    const L = await import(join(site, "logic.js"));
    const P = await import(join(site, "ballotpdf.js"));
    const rb = (n) => crypto.getRandomValues(new Uint8Array(n));
    const base = { name: "Synthetic class vote", electionCode: L.newElectionCode(2026, rb), organizer: "0x2222222222222222222222222222222222222222", opensAt: "2026-11-16T16:00:00.000Z", closesAt: "2026-11-16T22:00:00.000Z", registeredVoters: 3, quorum: 1, retentionDays: 3, approvedAppHashes: ["cd".repeat(32)], questions: [{ text: "Class rep?", choices: ["Alex", "Sam"], maxMarks: 1 }, { text: "Pick up to two", choices: ["Art", "Music", "Drama"], maxMarks: 2 }] };
    const designed = await P.designLayout(L.draftElectionFile({ ...base, ballotCodes: [] }));
    const file = L.draftElectionFile({ ...base, layoutHash: designed.layoutHash, ballotCodes: L.newBallotCodes(3, rb) });
    expect(L.validateElectionFile(file)).toEqual([]);
    const { pdf, layout } = await P.ballotPdf(file);

    const work = tmpRoot();
    const electionPath = join(work, "secret-full-file.json");
    const layoutPath = join(work, "ballot-layout.json");
    writeFileSync(electionPath, JSON.stringify(file));
    writeFileSync(layoutPath, JSON.stringify(layout));
    writeFileSync(join(work, "ballots.pdf"), pdf);
    const pngDir = join(work, "scan");
    mkdirSync(pngDir);
    execFileSync("pdftoppm", ["-png", "-r", "300", join(work, "ballots.pdf"), join(pngDir, "p")]);
    const pngs = readdirSync(pngDir).sort().map((f) => join(pngDir, f));
    expect(pngs).toHaveLength(3);
    execFileSync("python3", [join(here, "mark.py"), pngs[0], layoutPath, "q1/c2", "q2/c1", "q2/c3"]);
    execFileSync("python3", [join(here, "mark.py"), pngs[2], layoutPath, "q1/c1", "q1/c2"]);

    const root = join(work, "BEINGS-Scans", "X");
    const { dir } = writeBatch(root, "batch-20261110-081500", { pages: 3, electionCode: file.electionCode, size: [2551, 3300], dpi: 300, pageSize: "Letter", imageSource: (i) => readFileSync(pngs[i - 1]) });
    const electionFile = loadFullElectionFile(electionPath);
    const decode = async (b) => (await readPages(b, { electionFile, electionPath, layoutPath, workDir: join(dir, "reader") })).map((p) => ({ page: p.page, ballotCode: p.error ? null : p.ballotCode }));
    const sealed = await sealBatch(dir, { electionDir: root, decode, ballotCodes: file.ballotCodes });
    expect(sealed.problems).toEqual([]);
    expect(readFileSync(join(dir, "DONE.txt"), "utf8")).toMatch(/decoded=yes/);

    const r = await readBatch(dir, { electionPath, layoutPath });
    expect(r.problems).toEqual([]);
    const byResults = r.readings.map((x) => x.resultsString).sort();
    expect(byResults).toEqual(["B|B", "O|B", "V:c2|V:c1+c3"].sort());
    for (const raw of r.readings) expect(L.assessReading(raw, file, (b) => keccak256(b)).problems).toEqual([]);

    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.headers["x-image-sha256"]);
      req.resume();
      req.on("end", () => (res.writeHead(201, { "content-type": "application/json" }), res.end('{"status":"created","key":"k","deleteAfter":"x"}')));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const plan = planUpload(dir, r, { includeFlagged: true });
      expect(plan.problems).toEqual([]);
      const receipt = await runUpload(plan, { approve: "batch-20261110-081500", url: `http://127.0.0.1:${server.address().port}`, env: { ...process.env, SCANNER_UPLOAD_TOKEN: "mock-token", IMAGE_STORE_URL: "" } });
      expect(receipt.sent).toBe(3);
      expect(seen.sort()).toEqual(loadBatch(dir).manifest.pages.map((p) => p.sha256).sort());
    } finally {
      server.close();
    }
  }, 120000);
});
