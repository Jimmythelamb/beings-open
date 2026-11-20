import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ballotListRoot, sha256Json, validate } from "@beings/core";
import { OUTPUT_FILES, isValidLayout } from "../src/index.js";
import { tmpDir } from "./helpers.js";

const root = new URL("..", import.meta.url).pathname;
const tsx = join(root, "node_modules/.bin/tsx");
const rootTsx = join(root, "../../node_modules/.bin/tsx");
const bin = existsSync(tsx) ? tsx : rootTsx;
const run = (...args: string[]) => spawnSync(bin, [join(root, "src/cli.ts"), ...args], { encoding: "utf8", cwd: root });
const sample = join(root, "sample/classroom-election.json");

describe("beings-ballots CLI", () => {
  it("writes the five files and they agree with each other and with core", () => {
    const out = join(tmpDir(), "o");
    const r = run("--election", sample, "--count", "30", "--out", out);
    expect(r.status, r.stderr).toBe(0);
    for (const f of Object.values(OUTPUT_FILES)) expect(existsSync(join(out, f)), f).toBe(true);
    const read = (f: string): any => JSON.parse(readFileSync(join(out, f), "utf8"));
    const election = read(OUTPUT_FILES.electionFile);
    validate("electionFile", election);
    expect(election.ballotCodes).toHaveLength(30);
    const list = read(OUTPUT_FILES.ballotList);
    expect(list.ballotListRoot).toBe(ballotListRoot(election.ballotCodes));
    expect(list.count).toBe(30);
    const layout = read(OUTPUT_FILES.layout);
    expect(isValidLayout(layout)).toBe(true);
    const manifest = read(OUTPUT_FILES.manifest);
    expect(manifest.electionFileSha256).toBe(sha256Json(election));
    expect(manifest.layoutSha256).toBe(sha256Json(layout));
    expect(manifest.layoutHash).toBe(sha256Json(layout));
    expect(election.layoutHash).toBe(sha256Json(layout)); // the layout hash is INSIDE election-file.json, so the on-chain file hash covers it
    expect(layout.receiptQr.url).toBe(`https://beingsvote.live/check.html#e=${election.electionCode}`);
    expect(layout.receiptQr.purpose).toBe("voter-check-link");
    expect(layout.qr.payloadFormat.startsWith("BEINGS1|")).toBe(true);
    for (const code of election.ballotCodes) expect(layout.receiptQr.url.includes(code)).toBe(false);
    expect(manifest.ballotListRoot).toBe(list.ballotListRoot);
    expect(readFileSync(join(out, OUTPUT_FILES.pdf)).subarray(0, 5).toString()).toBe("%PDF-");
    expect(r.stdout).toContain(list.ballotListRoot);
  });

  it("refuses to overwrite without --force, and says why", () => {
    const out = join(tmpDir(), "o");
    expect(run("--election", sample, "--count", "3", "--out", out).status).toBe(0);
    const before = readFileSync(join(out, OUTPUT_FILES.ballotList), "utf8");
    const r = run("--election", sample, "--count", "3", "--out", out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already has .*--force/);
    expect(readFileSync(join(out, OUTPUT_FILES.ballotList), "utf8")).toBe(before);
    expect(run("--election", sample, "--count", "3", "--out", out, "--force").status).toBe(0);
    expect(readFileSync(join(out, OUTPUT_FILES.ballotList), "utf8")).not.toBe(before);
  });

  it("fails clearly on bad arguments", () => {
    expect(run("--election", sample, "--out", tmpDir()).stderr).toMatch(/count must be/);
    expect(run("--election", sample, "--count", "abc", "--out", tmpDir()).stderr).toMatch(/whole number/);
    expect(run("--election", "/nonexistent.json", "--count", "3", "--out", tmpDir()).stderr).toMatch(/cannot read/);
    expect(run().status).toBe(2);
    expect(run("--help").stdout).toMatch(/Usage/);
  });
});
