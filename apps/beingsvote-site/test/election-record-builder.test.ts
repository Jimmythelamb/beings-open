// tools/election-record/build-record.mjs end to end, offline (--onchain file instead of --check-chain). Synthetic signer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, keccak256, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import * as RecordModule from "../public/js/record.js";

const R: any = RecordModule;

const tool = fileURLToPath(new URL("../tools/election-record/build-record.mjs", import.meta.url));
const run = (args: string[]) => execFileSync(process.execPath, [tool, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const fails = (args: string[]) => {
  try {
    run(args);
  } catch (e: any) {
    return String(e.stderr);
  }
  throw new Error("expected the tool to fail");
};

describe("build-record.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "beings-record-"));
  const w = Wallet.createRandom();
  const results = { electionCode: "BEINGS-2026-QB1TTH", merkleRoot: "0x6e7c7f54b6eff97879a3a52f50a03f923e317bb0353eb6b913ac185fbea8fc7f", perQuestion: [{ valid: 7, blank: 0, overvote: 0, unclear: 0 }, { valid: 7, blank: 0, overvote: 0, unclear: 0 }], counts: { registered: 7, printed: 7, issued: 7, cast: 7, spoiled: 0, unusedReturned: 0, unissued: 0 }, failedChecks: 32, postedFrom: "web-admin" };
  const onchain = { organizer: w.address, onChain: { resultsSha256: "0x554e8a21ff93f2c382963eebe8b6c21105eca12a15ef1ee840eaeda2229622e1", failedChecks: 32, finality: "Provisional" } };
  writeFileSync(join(dir, "results.json"), JSON.stringify(results));
  writeFileSync(join(dir, "onchain.json"), JSON.stringify(onchain));
  writeFileSync(join(dir, "text.txt"), "Synthetic test note. Nothing private here.\n");

  it("draft-note writes the unsigned note and the exact EIP-712 payload", () => {
    const out = JSON.parse(run(["draft-note", "--election", "BEINGS-2026-QB1TTH", "--author", w.address, "--role", "organizer", "--tally-version", "1", "--checks", "R6", "--text-file", join(dir, "text.txt"), "--created-at", "2026-11-11T00:00:00.000Z", "--out", join(dir, "notes/organizer-note-1.json")]));
    expect(out.signed).toBe(false);
    const note = JSON.parse(readFileSync(join(dir, "notes/organizer-note-1.json"), "utf8"));
    const td = JSON.parse(readFileSync(join(dir, "notes/organizer-note-1.eip712.json"), "utf8"));
    expect(R.validateNote(note)).toEqual([]);
    expect(td.message).toEqual(R.noteTypedData(note, keccak256).message);
    expect(td.message.bodyHash).toBe(out.bodyHash);
  });

  it("build + verify with a signed note; the record fingerprint is stable", async () => {
    const note = JSON.parse(readFileSync(join(dir, "notes/organizer-note-1.json"), "utf8"));
    const td = R.noteTypedData(note, keccak256);
    const signed = R.attachSignature(note, await w.signTypedData(td.domain, td.types, td.message), { keccak256, verifyTypedData });
    writeFileSync(join(dir, "notes/organizer-note-1.json"), JSON.stringify(signed, null, 2));
    const args = ["build", "--election", "BEINGS-2026-QB1TTH", "--results", join(dir, "results.json"), "--note", join(dir, "notes/organizer-note-1.json"), "--onchain", join(dir, "onchain.json"), "--created-at", "2026-11-11T00:00:00.000Z"];
    const a = JSON.parse(run([...args, "--out", join(dir, "rec-a")]));
    const b = JSON.parse(run([...args, "--out", join(dir, "rec-b")]));
    expect(a.manifestSha256).toBe(b.manifestSha256);
    expect(a.draft).toBe(false);
    expect(existsSync(join(dir, "rec-a/election.public.json"))).toBe(true);
    const v = JSON.parse(run(["verify", "--dir", join(dir, "rec-a")]));
    expect(v.manifestSha256).toBe(a.manifestSha256);
    expect(v.files.every((f: any) => f.state === "match")).toBe(true);
    expect(v.notes[0].signature.valid).toBe(true);
    // the whole folder holds nothing shaped like a ballot code
    for (const f of ["manifest.json", "election.public.json", "results.json", "notes/organizer-note-1.json"]) expect(R.assertPublicJson(JSON.parse(readFileSync(join(dir, "rec-a", f), "utf8")), f)).toBe(true);
  });

  it("verify flags a changed file (exit code 2)", () => {
    const p = join(dir, "rec-b/results.json");
    writeFileSync(p, JSON.stringify({ ...results, failedChecks: 2 }));
    let code = 0;
    try {
      run(["verify", "--dir", join(dir, "rec-b")]);
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(2);
  });

  it("refuses a results file that doesn't match the on-chain fingerprint, and a non-public election file", () => {
    writeFileSync(join(dir, "bad-results.json"), JSON.stringify({ ...results, counts: { ...results.counts, registered: 6 }, failedChecks: 2 }));
    expect(fails(["build", "--election", "BEINGS-2026-QB1TTH", "--results", join(dir, "bad-results.json"), "--onchain", join(dir, "onchain.json"), "--out", join(dir, "rec-c")])).toMatch(/doesn't match the on-chain resultsSha256/);
    writeFileSync(join(dir, "full.json"), JSON.stringify({ file: { name: "x" } }));
    expect(fails(["build", "--election", "BEINGS-2026-QB1TTH", "--public-copy", join(dir, "full.json"), "--onchain", join(dir, "onchain.json"), "--out", join(dir, "rec-d")])).toMatch(/public copy/);
  });
});
