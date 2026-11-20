// Synthetic test page: fixtures, evaluateTestRead, refusal to load anything but the bundled test election.
// Never reads a real or private election file. The live mark-reader case is skipIf tools are missing.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_BALLOT_CODE,
  SYNTHETIC_BALLOT_KEY,
  SYNTHETIC_ELECTION_CODE,
  SYNTHETIC_ELECTION_NAME,
  evaluateTestRead,
  fixturePaths,
  isSyntheticTestFile,
  loadSyntheticElection,
  mockTestAllowed,
  parseTestPrintRequest,
  parseTestScanRequest,
  readSyntheticTestImage,
  testPageInfo,
} from "../src/testpage.mjs";

const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const readerReady = has("python3", ["-c", "import cv2, numpy"]);

describe("synthetic fixture", () => {
  it("is clearly labelled, uses a fixed fake code, and is the only file loadSyntheticElection will accept", () => {
    const { file, paths } = loadSyntheticElection();
    expect(file.electionCode).toBe(SYNTHETIC_ELECTION_CODE);
    expect(file.name).toBe(SYNTHETIC_ELECTION_NAME);
    expect(file.ballotCodes).toEqual([SYNTHETIC_BALLOT_CODE]);
    expect(isSyntheticTestFile(file)).toBe(true);
    expect(isSyntheticTestFile({ ...file, electionCode: "BEINGS-2026-ABC123" })).toBe(false);
    expect(isSyntheticTestFile({ ...file, publicCopy: true })).toBe(false);
    expect(isSyntheticTestFile({ publicCopy: false, electionCode: SYNTHETIC_ELECTION_CODE, name: SYNTHETIC_ELECTION_NAME, ballotCodes: ["AAAAAAAAAAAA"] })).toBe(false);
    expect(readFileSync(paths.electionFile, "utf8")).toMatch(/NOT A REAL BALLOT/);
    expect(testPageInfo().ok).toBe(true);
    expect(testPageInfo().ballotKey).toBe(SYNTHETIC_BALLOT_KEY);
    expect(SYNTHETIC_BALLOT_CODE).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(SYNTHETIC_BALLOT_CODE).not.toMatch(/DESK|SGN00/);
  });
});

describe("evaluateTestRead", () => {
  const good = {
    reading: { ballotCode: SYNTHETIC_BALLOT_CODE, ballotKey: SYNTHETIC_BALLOT_KEY, results: { q1: "B" }, imageSha256: "a".repeat(64) },
    imageSha256: "a".repeat(64),
  };
  it("passes when the recovered code, fingerprint and unmarked marks match", () => {
    const r = evaluateTestRead(good);
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.ballotKey).toBe(SYNTHETIC_BALLOT_KEY);
    expect(JSON.stringify(r)).not.toMatch(/DESK8Q|SGN001/);
  });
  it("fails when the recovered code does not match, and does not echo the unexpected code", () => {
    const r = evaluateTestRead({ reading: { ballotCode: "ABCDEFGHJKMN", results: { q1: "B" }, imageSha256: "a".repeat(64) } });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.id === "code")?.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "fingerprint")?.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/ABCDEFGHJKMN/);
  });
  it("fails when marks are not blank, or when the reader errors", () => {
    expect(evaluateTestRead({ reading: { ballotCode: SYNTHETIC_BALLOT_CODE, ballotKey: SYNTHETIC_BALLOT_KEY, results: { q1: "V:c1" }, imageSha256: "a".repeat(64) } }).pass).toBe(false);
    const err = evaluateTestRead({ error: "mark reader failed: boom ABCDEFGHJKMN" });
    expect(err.pass).toBe(false);
    expect(JSON.stringify(err)).not.toMatch(/ABCDEFGHJKMN/);
    expect(JSON.stringify(err)).toMatch(/<code>/);
  });
});

describe("request parsing and mock policy", () => {
  it("requires a safe printer name and never takes a PDF path from the client", () => {
    expect(parseTestPrintRequest({}).errors).toBeTruthy();
    expect(parseTestPrintRequest({ printerName: "Brother DCP-L2640DW series" })).toEqual({ printerName: "Brother DCP-L2640DW series" });
    expect(parseTestPrintRequest({ printerName: "bad\nname" }).errors).toBeTruthy();
  });
  it("refuses a client-supplied election file or picture, and honours the mock flag", () => {
    expect(parseTestScanRequest({}, { allowMock: true })).toEqual({ deviceId: null, mock: false });
    expect(parseTestScanRequest({ mock: true }, { allowMock: false }).errors.join(" ")).toMatch(/mock test is not enabled/);
    expect(parseTestScanRequest({ mock: true }, { allowMock: true })).toEqual({ deviceId: null, mock: true });
    expect(parseTestScanRequest({ electionPath: "/tmp/secret.json" }, { allowMock: true }).errors.join(" ")).toMatch(/does not accept an election file/);
    expect(parseTestScanRequest({ imageBase64: "aaaa" }, { allowMock: true }).errors.join(" ")).toMatch(/does not accept a picture/);
  });
  it("allows a mock test by default off Windows, and only with a flag on Windows", () => {
    expect(mockTestAllowed({ platform: "linux" })).toBe(true);
    expect(mockTestAllowed({ platform: "win32", env: {} })).toBe(false);
    expect(mockTestAllowed({ platform: "win32", env: { BEINGS_ALLOW_MOCK_TEST: "1" } })).toBe(true);
    expect(mockTestAllowed({ allowMockTest: true, platform: "win32", env: {} })).toBe(true);
    expect(mockTestAllowed({ allowMockTest: false, platform: "linux" })).toBe(false);
  });
});

describe("injected reader", () => {
  it("uses the bundled fixture election, not a path from the caller, and evaluates the result", async () => {
    const seen = {};
    const r = await readSyntheticTestImage(fixturePaths().png, {
      readPage: async (args) => {
        Object.assign(seen, args);
        return { ballotCode: SYNTHETIC_BALLOT_CODE, results: { q1: "B" }, resultsString: "B", imageSha256: "b".repeat(64) };
      },
    });
    expect(seen.electionPath).toMatch(/fixtures\/test-print-scan\/election-file\.json$/);
    expect(seen.layoutPath).toMatch(/fixtures\/test-print-scan\/ballot-layout\.json$/);
    expect(readFileSync(seen.electionPath, "utf8")).toMatch(/BEINGS-2026-TEST00/);
    expect(r.pass).toBe(true);
    expect(r.ballotKey).toBe(SYNTHETIC_BALLOT_KEY);
  });
});

describe.skipIf(!readerReady)("real mark reader on the bundled stand-in PNG", () => {
  it("recovers the synthetic code, fingerprint and blank marks", async () => {
    const r = await readSyntheticTestImage(fixturePaths().png);
    expect(r.pass).toBe(true);
    expect(r.checks.find((c) => c.id === "code")?.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "fingerprint")?.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "marks")?.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/DESK8Q|SGN001|SGN005/);
  });
});

describe("refusal of a substituted election file", () => {
  it("refuses to treat a different file in a temp folder as the synthetic test", () => {
    const dir = mkdtempSync(join(tmpdir(), "beings-not-synthetic-"));
    const fake = { electionCode: "BEINGS-2026-ABC123", name: "Room 12", ballotCodes: ["ABCDEFGHJKMN"], publicCopy: false };
    writeFileSync(join(dir, "election-file.json"), JSON.stringify(fake));
    writeFileSync(join(dir, "ballot-layout.json"), "{}");
    expect(() => loadSyntheticElection(dir)).toThrow(/not the synthetic test election/);
  });
});
