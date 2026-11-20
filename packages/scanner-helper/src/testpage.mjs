// Synthetic test print-and-scan page for the optional pre-election check.
// This module never loads a real or private election file, never uploads, never signs,
// and never talks to the ledger. The only ballot code it knows is the fixed fake test code below.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./fsbatch.mjs";
import { makeOmrPageReader } from "./reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(here, "../fixtures/test-print-scan");

/** Fixed synthetic election. Crockford alphabet, clearly labelled, never taken from a real file. */
export const SYNTHETIC_ELECTION_CODE = "BEINGS-2026-TEST00";
export const SYNTHETIC_BALLOT_CODE = "TESTPRNTSC01";
export const SYNTHETIC_ELECTION_NAME = "SYNTHETIC TEST PAGE — NOT A REAL BALLOT";
/** keccak256(utf8(TESTPRNTSC01)) — the on-chain ballot fingerprint. Independent tests recompute this. */
export const SYNTHETIC_BALLOT_KEY = "0xbb39023f85d1ff8cb6e6cd1fa77bcf8e4f0d611c563f51032655096dd9dc1e51";
export const SYNTHETIC_QUESTION_ID = "q1";
/** The printed test page is unmarked, so a correct reading is Blank. */
export const SYNTHETIC_EXPECTED_RESULTS = Object.freeze({ q1: "B" });

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BALLOT_KEY_RE = /^0x[0-9a-f]{64}$/;

export function fixturePaths(dir = FIXTURE_DIR) {
  return {
    dir,
    electionFile: join(dir, "election-file.json"),
    layout: join(dir, "ballot-layout.json"),
    pdf: join(dir, "SYNTHETIC-TEST-PAGE-NOT-A-REAL-BALLOT.pdf"),
    png: join(dir, "test-page.png"),
    meta: join(dir, "meta.json"),
  };
}

/** True only for the bundled synthetic test election. Refuses anything else. */
export function isSyntheticTestFile(file) {
  if (!file || typeof file !== "object") return false;
  if (file.publicCopy) return false;
  if (file.electionCode !== SYNTHETIC_ELECTION_CODE) return false;
  if (file.name !== SYNTHETIC_ELECTION_NAME) return false;
  const codes = file.ballotCodes;
  return Array.isArray(codes) && codes.length === 1 && codes[0] === SYNTHETIC_BALLOT_CODE;
}

/** Load the bundled synthetic election file only. Never accepts a caller-supplied path to a real election. */
export function loadSyntheticElection(dir = FIXTURE_DIR) {
  const paths = fixturePaths(dir);
  if (!existsSync(paths.electionFile) || !existsSync(paths.layout)) {
    throw new Error("The synthetic test page fixture is missing. It should ship in packages/scanner-helper/fixtures/test-print-scan/.");
  }
  const file = JSON.parse(readFileSync(paths.electionFile, "utf8"));
  if (!isSyntheticTestFile(file)) throw new Error("The fixture is not the synthetic test election. Refusing to load it.");
  return { file, paths, layout: JSON.parse(readFileSync(paths.layout, "utf8")) };
}

export function syntheticExpectations() {
  return {
    electionCode: SYNTHETIC_ELECTION_CODE,
    electionName: SYNTHETIC_ELECTION_NAME,
    ballotCode: SYNTHETIC_BALLOT_CODE,
    ballotKey: SYNTHETIC_BALLOT_KEY,
    results: { ...SYNTHETIC_EXPECTED_RESULTS },
  };
}

/**
 * Compare a reading (from the existing mark reader, or a test double) with the synthetic expectations.
 * Pure. Never logs or returns anything from a real election file.
 */
export function evaluateTestRead({ reading, error, problems = [], imageSha256 } = {}, expected = syntheticExpectations()) {
  const checks = [];
  const fail = (id, label, help) => checks.push({ id, ok: false, label, help });
  const pass = (id, label, help) => checks.push({ id, ok: true, label, help });

  if (error) {
    fail("read", "The mark reader could not read the page", plainReaderHelp(error));
  } else if (!reading || typeof reading !== "object") {
    fail("read", "No reading was produced", "The helper ran, but it did not return a reading for the test page. Try the scan again, or check that the page went through the scanner face up and straight.");
  } else {
    pass("read", "The mark reader returned a reading", "The test page was read with the same mark reader used for real ballots.");
  }

  const gotCode = reading?.ballotCode ?? null;
  if (gotCode === expected.ballotCode) {
    pass("code", "The reading recovered the synthetic test code", "This is the fixed fake code printed on the test page, not a code from any real election.");
  } else if (gotCode == null) {
    fail("code", "The reading did not recover a ballot code", "The QR or printed code on the test page was not read. Check the page is the synthetic test page, printed at actual size, and that the scan is not cropped or too dark.");
  } else {
    fail("code", "The recovered code does not match the synthetic test page", "The reader saw a code, but it was not the fixed fake test code. Make sure the sheet in the scanner is the synthetic test page, not a real ballot.");
  }

  const gotKey = normalizeKey(reading?.ballotKey) ?? (gotCode === expected.ballotCode ? expected.ballotKey : null);
  if (gotKey && gotKey === expected.ballotKey) {
    pass("fingerprint", "The ballot fingerprint matches", "The fingerprint is the keccak hash of the recovered code. It matches the expected fingerprint of the synthetic test page.");
  } else if (!gotKey) {
    fail("fingerprint", "The ballot fingerprint could not be checked", "The fingerprint is computed from the recovered ballot code. Without a matching code, it cannot be confirmed.");
  } else {
    fail("fingerprint", "The ballot fingerprint does not match", "The computed fingerprint of the recovered code is not the expected fingerprint of the synthetic test page.");
  }

  const sha = normalizeSha(imageSha256 ?? reading?.imageSha256);
  if (sha) {
    pass("image", "A picture fingerprint was computed", "SHA-256 of the scanned (or stand-in) picture bytes. A live scan will not match the generated file's hash, and that is expected.");
  } else {
    fail("image", "No picture fingerprint was computed", "The helper should hash the scanned picture. Without that hash, the check is incomplete.");
  }

  const expectedResults = expected.results ?? SYNTHETIC_EXPECTED_RESULTS;
  const gotResults = reading?.results;
  if (gotResults && resultsMatch(gotResults, expectedResults)) {
    pass("marks", "The marks match the unmarked test page", "The synthetic test page is printed with no ovals filled, so each question should read as Blank (B).");
  } else if (!gotResults && !error) {
    fail("marks", "No mark results were returned", "The reader did not report marks for the test page.");
  } else if (!error) {
    fail("marks", "The marks do not match the unmarked test page", "The test page is printed with no ovals filled, so the reading should be Blank (B). A stray mark, a dark scan, or a cropped page can cause this.");
  }

  if (Array.isArray(problems) && problems.length) {
    fail("problems", "The reader reported a problem", problems.map((p) => String(p).replace(/[A-Z0-9]{12}/g, "<code>")).join(" "));
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  return {
    pass: ok,
    checks,
    help: ok
      ? "The test print and scan passed. The reading and the ballot fingerprint match the synthetic test page. Nothing was recorded on the ledger or uploaded."
      : checks
          .filter((c) => !c.ok)
          .map((c) => c.help)
          .filter(Boolean)
          .join(" ") || "The test print and scan did not pass. You can try again, or skip this optional check. Creating or registering is never blocked, because ballots are accounted for by hash.",
    electionCode: expected.electionCode,
    ballotKey: expected.ballotKey,
    imageSha256: sha,
  };
}

function normalizeSha(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/^0x/, "");
  return SHA256_HEX.test(s) ? s : null;
}

function normalizeKey(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const with0x = s.startsWith("0x") ? s : `0x${s}`;
  return BALLOT_KEY_RE.test(with0x) ? with0x : null;
}

function resultsMatch(got, expected) {
  const keys = Object.keys(expected);
  if (!keys.length) return false;
  return keys.every((k) => String(got?.[k] ?? "") === String(expected[k]));
}

function plainReaderHelp(error) {
  const t = String(error ?? "").replace(/[A-Z0-9]{12}/g, "<code>").slice(0, 200);
  return `The mark reader stopped (${t || "unknown error"}). Check the test page is printed at actual size, single-sided, and went through the scanner straight.`;
}

/**
 * Read one picture of the synthetic test page with the existing mark reader.
 * `imagePath` must be a local file (the just-scanned page, or the bundled stand-in PNG).
 * The election file and layout always come from the bundled fixture — never from the caller.
 */
export async function readSyntheticTestImage(imagePath, { readPage, fixtureDir = FIXTURE_DIR, workDir } = {}) {
  if (!imagePath || !existsSync(imagePath)) throw new Error("No test-page picture to read.");
  const { file, paths } = loadSyntheticElection(fixtureDir);
  const bytes = readFileSync(imagePath);
  const imageSha256 = sha256(bytes);
  const tmp = workDir ?? mkdtempSync(join(tmpdir(), "beings-test-print-scan-"));
  const createdWork = !workDir;
  const blistDir = mkdtempSync(join(tmpdir(), "beings-test-blist-"));
  const ballotListPath = join(blistDir, "ballot-list.json");
  writeFileSync(ballotListPath, JSON.stringify({ electionCode: file.electionCode, ballots: [{ ballotCode: SYNTHETIC_BALLOT_CODE }] }));
  mkdirSync(tmp, { recursive: true });
  const reader = readPage ?? makeOmrPageReader();
  try {
    const raw = await reader({
      imagePath,
      page: 1,
      layoutPath: paths.layout,
      ballotListPath,
      electionPath: paths.electionFile,
      workDir: tmp,
    });
    if (raw?.error) return evaluateTestRead({ error: raw.error, imageSha256, reading: { imageSha256 } });
    const reading = {
      ballotCode: raw.ballotCode ?? null,
      ballotKey: SYNTHETIC_BALLOT_CODE && raw.ballotCode === SYNTHETIC_BALLOT_CODE ? SYNTHETIC_BALLOT_KEY : null,
      results: raw.results ?? null,
      resultsString: raw.resultsString ?? null,
      imageSha256: raw.imageSha256 ?? imageSha256,
    };
    const problems = raw.coreValidationProblems ?? [];
    return evaluateTestRead({ reading, problems, imageSha256: reading.imageSha256 });
  } finally {
    rmSync(blistDir, { recursive: true, force: true });
    if (createdWork) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Public description of the test page, safe to send to the browser. Includes the fake test code (it is not a real ballot). */
export function testPageInfo(dir = FIXTURE_DIR) {
  const paths = fixturePaths(dir);
  const ready = existsSync(paths.pdf) && existsSync(paths.electionFile) && existsSync(paths.layout);
  return {
    ok: ready,
    synthetic: true,
    electionCode: SYNTHETIC_ELECTION_CODE,
    electionName: SYNTHETIC_ELECTION_NAME,
    ballotCode: SYNTHETIC_BALLOT_CODE,
    ballotKey: SYNTHETIC_BALLOT_KEY,
    expectedResults: { ...SYNTHETIC_EXPECTED_RESULTS },
    hasPdf: existsSync(paths.pdf),
    hasPng: existsSync(paths.png),
    note: "This is a synthetic test page, not a real ballot. Nothing is recorded on the ledger or uploaded.",
  };
}

/** What the page should show after a real test scan. The picture is kept even when the mark reader fails. */
export function scanOutcome({ readResult = null, readError = null, hasImage = false } = {}) {
  if (!hasImage) {
    const message = readError || "The scanner ran, but no picture was saved. Nothing was uploaded.";
    return { ok: false, pass: false, mocked: false, message, imageUrl: null, checks: [] };
  }
  const read = readResult && typeof readResult === "object" ? readResult : {};
  const message = readError
    ? `The scanner saved a picture, but the check did not finish. ${readError} Nothing was uploaded.`
    : read.pass
      ? "The scanner's picture of the test page was read. Nothing was recorded or uploaded."
      : read.help || "The scanner's picture was saved. The check did not pass. Nothing was recorded or uploaded.";
  return {
    ok: true,
    pass: !!read.pass && !readError,
    mocked: false,
    checks: Array.isArray(read.checks) ? read.checks : [],
    help: read.help || message,
    message,
    imageUrl: "/v1/test/last-page.png",
    imageSha256: read.imageSha256 || null,
    ballotKey: read.ballotKey || null,
  };
}

export function readFixturePdf(dir = FIXTURE_DIR) {
  const paths = fixturePaths(dir);
  if (!existsSync(paths.pdf)) throw new Error("The synthetic test PDF is missing.");
  return readFileSync(paths.pdf);
}

export function readFixturePng(dir = FIXTURE_DIR) {
  const paths = fixturePaths(dir);
  if (!existsSync(paths.png)) throw new Error("The synthetic test PNG is missing.");
  return { path: paths.png, bytes: readFileSync(paths.png) };
}

/** Validate a print request. Pure. The PDF path is never taken from the client. */
export function parseTestPrintRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const printerName = String(b.printerName ?? "").trim();
  if (!printerName) return { errors: ["printerName is required"] };
  if (printerName.length > 200 || /[\r\n"`$]/.test(printerName)) return { errors: ["printerName is not valid"] };
  return { printerName };
}

/** Validate a scan-and-read request. Pure. Never accepts an election file or an image from the client. */
export function parseTestScanRequest(body, { allowMock = false } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const deviceId = b.deviceId == null || b.deviceId === "" ? null : String(b.deviceId);
  if (deviceId != null && (deviceId.length > 200 || /[\r\n"`$]/.test(deviceId))) errors.push("deviceId is not valid");
  const mock = b.mock === true;
  if (mock && !allowMock) errors.push("mock test is not enabled on this helper");
  if (b.electionFile != null || b.electionPath != null || b.layoutPath != null) errors.push("the test flow does not accept an election file from the page");
  if (b.image != null || b.imageBase64 != null || b.imagePath != null) errors.push("the test flow does not accept a picture from the page");
  if (errors.length) return { errors };
  return { deviceId, mock };
}

export function mockTestAllowed({ allowMockTest, platform = process.platform, env = process.env } = {}) {
  if (allowMockTest === true) return true;
  if (allowMockTest === false) return false;
  return platform !== "win32" || env?.BEINGS_ALLOW_MOCK_TEST === "1";
}
