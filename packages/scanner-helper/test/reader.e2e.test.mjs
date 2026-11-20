// End to end on the SYNTHETIC sample election from @beings/ballot-gen (never a real election):
// render 3 ballots at 300 dpi, mark some ovals, seal the batch, run the real mark reader, then check the unsigned
// readings file is accepted by the website's own reading checks. Skipped when python3+OpenCV or pdftoppm is missing.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { sealBatch } from "../src/fsbatch.mjs";
import { readBatch } from "../src/reader.mjs";
import { planUpload } from "../src/upload.mjs";
import { tmpRoot, writeBatch } from "./helpers.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const sample = resolve(here, "../../ballot-gen/sample/output");
const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const ready = has("python3", ["-c", "import cv2, numpy"]) && has("pdftoppm", ["-v"]);

describe.skipIf(!ready)("read a sealed batch with the real mark reader (synthetic sample election)", () => {
  it("produces unsigned readings the site accepts, with B/O/V preserved", async () => {
    const work = tmpRoot();
    const pngDir = join(work, "render");
    mkdirSync(pngDir);
    execFileSync("pdftoppm", ["-png", "-r", "300", "-f", "1", "-l", "3", join(sample, "ballots.pdf"), join(pngDir, "p")]);
    const rendered = readdirSync(pngDir).filter((f) => f.endsWith(".png")).sort().map((f) => join(pngDir, f));
    expect(rendered).toHaveLength(3);
    const layout = join(sample, "ballot-layout.json");
    execFileSync("python3", [join(here, "mark.py"), rendered[0], layout, "q1/c1"]);
    execFileSync("python3", [join(here, "mark.py"), rendered[2], layout, "q1/c1", "q1/c2"]);
    const election = JSON.parse(readFileSync(join(sample, "election-file.json"), "utf8"));
    const root = join(work, "scans");
    const { dir } = writeBatch(root, "batch-20261109-202954", { pages: 3, electionCode: election.electionCode, size: [2551, 3300], dpi: 300, pageSize: "Letter", imageSource: (i) => readFileSync(rendered[i - 1]) });
    // refuses before sealing
    await expect(readBatch(dir, { electionPath: join(sample, "election-file.json"), layoutPath: layout })).rejects.toThrow(/CAPTURED and must not be read/);
    const sealed = await sealBatch(dir, { electionDir: root });
    expect(sealed.problems).toEqual([]);
    const out = join(work, "readings.json");
    const r = await readBatch(dir, { electionPath: join(sample, "election-file.json"), layoutPath: layout, outPath: out });
    expect(r.problems).toEqual([]);
    expect(r.summary.read).toBe(3);
    expect(r.readings.map((x) => x.results.q1)).toEqual(["V:c1", "B", "O"]);
    for (const x of r.readings) expect(election.ballotCodes).toContain(x.ballotCode);

    // the site's own checks (apps/beingsvote-site/public/js/logic.js) accept every reading unchanged
    const L = await import("../../../apps/beingsvote-site/public/js/logic.js");
    const keccak = (b) => keccak256(b);
    const fileForSite = { ...election, resultRules: election.resultRules };
    for (const raw of r.readings) {
      const a = L.assessReading(raw, fileForSite, keccak);
      expect(a.problems).toEqual([]);
      expect(a.reading.resultsString).toBe(raw.resultsString);
    }

    // upload plan needs retention days (the sample file has none) and matches the sealed bytes
    const plan = planUpload(dir, r, { retentionDays: 3 });
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((i) => i.page)).toEqual([1, 2, 3]);
  });
});
