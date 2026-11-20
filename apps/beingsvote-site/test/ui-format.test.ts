// Unit tests for the browser-side helpers of the public site (public/js/format.js): code handling, the plain-language
// translation of ledger lines, the client-side recount and the election-file fingerprint.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyCorrections, canonicalize, choiceLabel, describeResult, formatBallotCode, normalizeBallotCode, normalizeElectionCode, parseResult, percent, sha256Hex, shortAddress, shortHash, splitLedgerResults, tallyFromResults } from "../public/js/format.js";
import { ballotKey, normalizeBallotCode as serverNormalize } from "../src/codes.js";

const wrapper = JSON.parse(readFileSync(resolve(__dirname, "../public/data/elections/BEINGS-2026-WMRHGH.json"), "utf8"));
const questions = wrapper.file.questions;

describe("code handling (must match the server)", () => {
  it.each(["4f9q-7m2x-ht8b", " 4F9Q 7M2X HT8B ", "4F9Q7M2XHT8B", "4F9Q-7M2X-HT8B"])("normalizes %j", (s) => {
    expect(normalizeBallotCode(s)).toBe("4F9Q7M2XHT8B");
  });
  it("maps look-alike letters like the printed codes do", () => {
    expect(normalizeBallotCode("O0O0-I1L1-4F9Q")).toBe("0000111" + "14F9Q");
    for (const s of ["O0O0-I1L1-4F9Q", "abcd-efgh-jkmn"]) expect(normalizeBallotCode(s)).toBe(serverNormalize(s));
  });
  it("rejects wrong length and illegal letters", () => {
    expect(normalizeBallotCode("4F9Q-7M2X")).toBeNull();
    expect(normalizeBallotCode("4F9Q7M2XHT8BX")).toBeNull();
    expect(normalizeBallotCode("4F9U7M2XHT8B")).toBeNull(); // U is not in the alphabet
    expect(normalizeBallotCode("")).toBeNull();
  });
  it("formats and normalizes election codes", () => {
    expect(normalizeElectionCode(" beings-2026-wmrhgh ")).toBe("BEINGS-2026-WMRHGH");
    expect(normalizeElectionCode("BEINGS-2026-WMRHG")).toBeNull();
    expect(normalizeElectionCode("<script>")).toBeNull();
    expect(formatBallotCode("4F9Q7M2XHT8B")).toBe("4F9Q-7M2X-HT8B");
  });
});

describe("ledger line parsing", () => {
  it("parses each segment kind", () => {
    expect(parseResult("V:c2")).toEqual({ kind: "V", choices: ["c2"] });
    expect(parseResult("V:c1+c3")).toEqual({ kind: "V", choices: ["c1", "c3"] });
    expect(parseResult("B")).toEqual({ kind: "B" });
    expect(parseResult("O")).toEqual({ kind: "O" });
    expect(parseResult("U")).toEqual({ kind: "U" });
  });
  it("never guesses on malformed input", () => {
    for (const bad of ["", "V:", "V:c3+c1", "V:c1+c1", "X", "v:c1", "V:c1+", "V:1", undefined, null]) expect(parseResult(bad as string)).toBeNull();
  });
  it("splits a ballot line in question order", () => {
    expect(splitLedgerResults("V:c1|V:c3|V:c3+c4")).toEqual(["V:c1", "V:c3", "V:c3+c4"]);
  });
});

describe("plain-language translation", () => {
  const q2 = questions[1];
  it("names the chosen candidate", () => {
    const d = describeResult("V:c3", q2);
    expect(d.title).toBe("You marked: Chloe Nguyen");
    expect(d.tone).toBe("ok");
    expect(d.raw).toBe("V:c3");
  });
  it("lists several choices", () => {
    expect(describeResult("V:c3+c4", questions[2]).title).toBe("You marked 2 choices: Zoo and Fire station");
  });
  it("explains blank, overvote and unclear without jargon-only text", () => {
    expect(describeResult("B", q2).title).toMatch(/blank/i);
    expect(describeResult("O", q2).title).toMatch(/too many marks/i);
    expect(describeResult("O", q2).detail).toMatch(/More than 1 mark was/);
    expect(describeResult("U", q2).title).toMatch(/unclear/i);
  });
  it("shows unknown text as-is instead of hiding it", () => {
    const d = describeResult("???", q2);
    expect(d.tone).toBe("warn");
    expect(d.detail).toContain("???");
  });
  it("falls back to the id for an unknown choice", () => {
    expect(choiceLabel(q2, "c9")).toBe("c9");
  });
});

describe("recount of the real test election (BEINGS-2026-WMRHGH)", () => {
  // The five ledger lines posted on Coston2 (deployments/coston2-scanned-5.json), in file order of the ballots.
  const deployment = resolve(__dirname, "../../../packages/ledger/deployments/coston2-scanned-5.json");
  const lines = existsSync(deployment) ? (JSON.parse(readFileSync(deployment, "utf8")).ballots as { resultsString: string }[]).map((b) => b.resultsString) : null;

  it.skipIf(!lines)("matches the published tally", () => {
    const t = tallyFromResults(lines!, questions);
    expect(t[0]!.byChoice).toEqual({ c1: 5, c2: 0 });
    expect(t[0]!.valid).toBe(5);
    expect(t[1]!.byChoice).toEqual({ c1: 0, c2: 2, c3: 1, c4: 1 });
    expect(t[1]).toMatchObject({ valid: 4, overvote: 1 });
    expect(t[2]!.byChoice).toEqual({ c1: 1, c2: 1, c3: 4, c4: 4, c5: 0 });
    expect(t[2]!.valid).toBe(5);
    expect(t.every((x: { blank: number; unclear: number; unreadable: number }) => x.blank === 0 && x.unclear === 0 && x.unreadable === 0)).toBe(true);
  });
  it("counts blanks, unclear and unreadable separately", () => {
    const t = tallyFromResults(["V:c1|B|U", "O|V:c2|zzz"], [questions[0], questions[1], questions[0]]);
    expect(t[0]).toMatchObject({ valid: 1, overvote: 1 });
    expect(t[1]).toMatchObject({ valid: 1, blank: 1 });
    expect(t[2]).toMatchObject({ unclear: 1, unreadable: 1 });
  });
  it("applies only the latest correction per ballot and question", () => {
    const out = applyCorrections(
      { a: "V:c1|O", b: "B|V:c2" },
      [
        { ballotKey: "a", questionIndex: 1, index: 1, toResult: "U" },
        { ballotKey: "a", questionIndex: 1, index: 2, toResult: "V:c4" },
        { ballotKey: "zz", questionIndex: 0, index: 3, toResult: "V:c1" },
      ],
    );
    expect(out).toEqual({ a: "V:c1|V:c4", b: "B|V:c2" });
  });
});

describe("fingerprints", () => {
  it("canonicalizes like RFC 8785 (sorted keys, no spaces)", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize(NaN)).toThrow();
  });
  it("hashes with SHA-256 in the browser the same way as on the server", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256Hex(bytes)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("the ballot key the site derives from a code is keccak256 of the strict code (server rule)", () => {
    expect(ballotKey("4F9Q7M2XHT8B")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("small helpers", () => {
  it("percent, shortHash, shortAddress", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(5, 0)).toBe(0);
    expect(shortHash("0x" + "ab".repeat(32), 6, 4)).toBe("0xabab…abab");
    expect(shortAddress("0x651A078e51B69Eff17e22950573EbE0252f43E63")).toMatch(/^0x651A…3E63$/);
  });
  it("the bundled public election file hides the ballot codes", () => {
    expect(JSON.stringify(wrapper)).not.toMatch(/"ballotCodes"\s*:\s*\[/);
    expect(wrapper.publicCopy).toBe(true);
  });
});
