// Unit tests for public/js/logic.js: the pure rules behind the verifier, officer, admin and system screens.
// Where a rule also lives in the contracts / @beings/core / this site's server, the tests check the copies agree
// (those cross-checks are skipped on a standalone checkout of the site, the rest always run).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { keccak256, Wallet, verifyTypedData, verifyMessage } from "ethers";
import { describe, expect, it } from "vitest";
import * as L from "../public/js/logic.js";
import { canonicalize } from "../public/js/format.js";
import { challengeMessage as serverChallenge } from "../src/verifierAuth.js";

const keccak = (b: Uint8Array) => keccak256(b);
const wrapper = JSON.parse(readFileSync(resolve(__dirname, "../public/data/elections/BEINGS-2026-WMRHGH.json"), "utf8"));
const questions = wrapper.file.questions;

describe("small validators", () => {
  it("recognises addresses and bytes32 values", () => {
    expect(L.isAddress("0xfB2A3F83F2362566341b8edfB008a0C42A52d73D")).toBe(true);
    expect(L.isAddress("0xfB2A3F83F2362566341b8edfB008a0C42A52d73")).toBe(false);
    expect(L.isAddress(null)).toBe(false);
    expect(L.isBytes32("0x" + "ab".repeat(32))).toBe(true);
    expect(L.isBytes32("ab".repeat(32))).toBe(false);
    expect(L.sameAddress("0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", "0xfb2a3f83f2362566341b8edfb008a0c42a52d73d")).toBe(true);
  });
  it("normalizes hashes however they are spelled", () => {
    const h = "AB".repeat(32);
    expect(L.normHash("0x" + h)).toBe("ab".repeat(32));
    expect(L.normHash(h)).toBe("ab".repeat(32));
    expect(L.normHash("0x1234")).toBeNull();
    expect(L.normHash(undefined)).toBeNull();
  });
  it("parses counts strictly", () => {
    expect(L.parseCount(" 12 ")).toBe(12);
    expect(L.parseCount("0")).toBe(0);
    for (const bad of ["", "-1", "1.5", "abc", "1e3", "12345678901", null]) expect(L.parseCount(bad as never)).toBeNull();
  });
  it("splits a pasted address list and reports the bad ones", () => {
    const a = "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D";
    const b = "0x7f5F788D89e99Aff09663A60d1f7E4aa4Bd34656";
    expect(L.parseAddressList(`${a}, ${b}\n${a} nope`)).toEqual({ valid: [a, b], invalid: ["nope"] });
  });
});

describe("network and wallet helpers", () => {
  it("reads chain ids in any form", () => {
    expect(L.chainIdNumber("0x72")).toBe(114);
    expect(L.chainIdNumber(114)).toBe(114);
    expect(L.chainIdNumber("114")).toBe(114);
    expect(L.chainIdNumber(null)).toBeNull();
    expect(L.chainIdNumber("zzz")).toBeNull();
  });
  it("classifies the network", () => {
    expect(L.networkState("0x72")).toBe("ok");
    expect(L.networkState("0x1")).toBe("wrong");
    expect(L.networkState(undefined)).toBe("unknown");
  });
  it("describes Coston2 for wallet_addEthereumChain", () => {
    const p = L.walletChainParams({ chainId: 114, rpcUrl: "https://coston2-api.flare.network/ext/C/rpc", explorer: "https://coston2-explorer.flare.network" });
    expect(p.chainId).toBe("0x72");
    expect(p.nativeCurrency).toEqual({ name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 });
    expect(p.rpcUrls).toEqual(["https://coston2-api.flare.network/ext/C/rpc"]);
  });
});

describe("error messages", () => {
  it("treats a declined wallet prompt as calm, not an error", () => {
    expect(L.isUserRejected({ code: "ACTION_REJECTED" })).toBe(true);
    expect(L.isUserRejected({ code: 4001 })).toBe(true);
    expect(L.explainError({ code: 4001 })).toMatch(/nothing was sent/);
  });
  it("turns custom errors into plain sentences", () => {
    expect(L.explainError({ revert: { name: "NotEnoughDevices", args: [0, 1] } })).toMatch(/quorum/i);
    expect(L.explainError({ shortMessage: "execution reverted (unknown custom error)", revert: { name: "TooEarly", args: [5n] } })).toMatch(/opening time/);
    expect(L.explainError({ revert: { name: "WrongStatus", args: [3n] } })).toMatch(/currently closed/);
    expect(L.explainError({ shortMessage: "execution reverted: reverted with custom error 'NotOrganizer()'" })).toMatch(/organizer/);
  });
  it("explains funds and unknown errors without throwing", () => {
    expect(L.explainError({ code: "INSUFFICIENT_FUNDS" })).toMatch(/C2FLR/);
    expect(L.explainError(new Error("boom"))).toBe("boom");
    expect(L.explainError("plain")).toBe("plain");
    expect(L.explainError({ message: "x".repeat(500) }).length).toBeLessThanOrEqual(220);
  });
});

const org = (o: Partial<{ registered: number; issued: number; unusedReturned: number }> = {}) => ({ registered: 100, issued: 90, unusedReturned: 5, ...o });
const led = (l: Partial<Record<string, unknown>> = {}) => ({ registeredInElectionFile: 100, printed: 120, cast: 80, spoiled: 5, perQuestion: [{ valid: 70, blank: 5, overvote: 3, unclear: 2 }], ...l }) as never;

describe("reconcile (R1 to R6)", () => {
  it("passes a clean station", () => {
    const r = L.reconcile(org(), led());
    expect(r.failedChecks).toBe(0);
    expect(r.counts).toEqual({ registered: 100, printed: 120, issued: 90, cast: 80, spoiled: 5, unusedReturned: 5, unissued: 30 });
  });
  it.each([
    ["R1", org({ issued: 70, unusedReturned: -15 + 15 }), led({ cast: 80, spoiled: 0 }), 1],
    ["R3", org({ issued: 130, unusedReturned: 45 }), led(), 4],
    ["R4", org({ unusedReturned: 9 }), led(), 8],
    ["R5", org(), led({ perQuestion: [{ valid: 70, blank: 5, overvote: 3, unclear: 3 }] }), 16],
    ["R6", org({ registered: 99 }), led(), 32],
  ])("sets the %s bit", (_n, o, l, bit) => {
    expect(L.reconcile(o as never, l).failedChecks & (bit as number)).toBe(bit);
  });
  it("skips R2 when no register is used and fails it when over-issued", () => {
    const none = L.reconcile(org({ registered: 0 }), led({ registeredInElectionFile: 0 }));
    expect(none.details.find((d) => d.rule === "R2")).toMatchObject({ passed: true, skipped: true });
    expect(L.reconcile(org({ registered: 80, issued: 90 }), led({ registeredInElectionFile: 80, spoiled: 5 })).failedChecks & 2).toBe(2);
  });
  it("rejects malformed counts instead of passing", () => {
    expect(() => L.reconcile(org({ issued: -1 }), led())).toThrow();
    expect(() => L.reconcile(org(), led({ cast: 1.5 }))).toThrow();
  });
  it("maps a bit mask back to rules", () => {
    expect(L.rulesFromMask(9).filter((r) => !r.passed).map((r) => r.id)).toEqual(["R1", "R4"]);
    expect(L.rulesFromMask(0).every((r) => r.passed)).toBe(true);
  });
  const corePath = fileURLToPath(new URL("../../../packages/core/src/reconcile.ts", import.meta.url));
  it.skipIf(!existsSync(corePath))("agrees with @beings/core on random inputs (monorepo only)", async () => {
    const core = (await import(/* @vite-ignore */ corePath)) as any;
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 300; i++) {
      const cast = rnd(30);
      const spoiled = rnd(5);
      const o = { registered: rnd(3) === 0 ? 0 : rnd(40), issued: cast + spoiled + rnd(8) - (rnd(4) === 0 ? 3 : 0), unusedReturned: rnd(8) };
      if (o.issued < 0) o.issued = 0;
      const t = { valid: rnd(cast + 1), blank: rnd(3), overvote: rnd(3), unclear: rnd(3) };
      const l = { registeredInElectionFile: rnd(3) === 0 ? o.registered : rnd(40), printed: rnd(60), cast, spoiled, perQuestion: [t] };
      const mine = L.reconcile(o, l as never);
      const theirs = core.reconcile(o, { ...l, perQuestion: { q1: t } });
      expect(mine.failedChecks).toBe(theirs.failedChecks);
      expect(mine.counts).toEqual(theirs.counts);
    }
  });
});

describe("polling-station view", () => {
  const base = { registered: 100, printed: 120, cast: 80, spoiled: 5 };
  it("is ok when everything balances", () => {
    const s = L.stationReconciliation({ ...base, issued: 90, unusedReturned: 5 });
    expect(s.status).toBe("ok");
    expect(s.issues).toEqual([]);
    expect(s.unaccounted).toBe(0);
    expect(s.turnout).toBe(80);
  });
  it("asks for the station's own counts rather than guessing", () => {
    const s = L.stationReconciliation(base);
    expect(s.status).toBe("incomplete");
    expect(s.issues.map((i) => i.id)).toEqual(["incomplete"]);
    expect(s.rows.find((r) => r.id === "issued")).toMatchObject({ known: false, value: null });
  });
  it("flags cast above registered even before the station counts", () => {
    const s = L.stationReconciliation({ ...base, cast: 101 });
    expect(s.status).toBe("review");
    expect(s.issues[0]).toMatchObject({ id: "cast>registered", level: "bad" });
  });
  it("does not apply the registered rule when there is no register", () => {
    expect(L.stationReconciliation({ ...base, registered: 0, cast: 110, spoiled: 0, issued: 115, unusedReturned: 5 }).status).toBe("ok");
  });
  it("flags cast above issued, issued above printed and unbalanced counts", () => {
    expect(L.stationReconciliation({ ...base, issued: 70, unusedReturned: 0 }).issues.map((i) => i.id)).toContain("cast>issued");
    expect(L.stationReconciliation({ ...base, issued: 130, unusedReturned: 45 }).issues.map((i) => i.id)).toContain("issued>printed");
    const s = L.stationReconciliation({ ...base, issued: 90, unusedReturned: 3 });
    expect(s.status).toBe("review");
    expect(s.unaccounted).toBe(2);
    expect(s.issues.find((i) => i.id === "unaccounted")?.title).toMatch(/2 ballots can't be accounted for/);
  });
  it("flags more ballots used than printed", () => {
    expect(L.stationReconciliation({ registered: 0, printed: 10, cast: 8, spoiled: 3 }).issues[0].id).toBe("over-printed");
  });
  it("agrees with the R-rules for the same numbers", () => {
    for (const [issued, unused, cast] of [[90, 5, 80], [90, 3, 80], [70, 0, 80], [130, 45, 80]]) {
      const st = L.stationReconciliation({ registered: 100, printed: 120, cast, spoiled: 5, issued, unusedReturned: unused });
      const r = L.reconcile({ registered: 100, issued, unusedReturned: unused }, { registeredInElectionFile: 100, printed: 120, cast, spoiled: 5, perQuestion: [{ valid: cast, blank: 0, overvote: 0, unclear: 0 }] } as never);
      expect(st.status === "ok").toBe(r.failedChecks === 0);
    }
  });
});

describe("what the organizer may do next", () => {
  const base = { status: 1, now: 1000, opensAt: 500, closesAt: 5000, deviceCount: 1, quorum: 1, isOrganizer: true };
  it("opens when staffed, on time and by the organizer", () => {
    expect(L.electionActions(base).canOpen).toBe(true);
  });
  it("explains each blocker", () => {
    expect(L.electionActions({ ...base, deviceCount: 0 }).openBlockers[0]).toMatch(/Register 1 more Scanner\/Printer station\b/);
    expect(L.electionActions({ ...base, quorum: 3, deviceCount: 1 }).openBlockers[0]).toMatch(/2 more Scanner\/Printer stations/);
    expect(L.electionActions({ ...base, now: 100 }).openBlockers[0]).toMatch(/opening time/);
    expect(L.electionActions({ ...base, isOrganizer: false }).openBlockers[0]).toMatch(/organizer/);
    expect(L.electionActions({ ...base, status: 2 }).canOpen).toBe(false);
  });
  it("closes only while open; others only a day after the scheduled close", () => {
    const o = { ...base, status: 2 };
    expect(L.electionActions(o).canClose).toBe(true);
    expect(L.electionActions({ ...o, isOrganizer: false, now: 5000 + 86400 }).canClose).toBe(false);
    expect(L.electionActions({ ...o, isOrganizer: false, now: 5000 + 86401 }).canClose).toBe(true);
    expect(L.electionActions({ ...base, status: 3 }).canClose).toBe(false);
  });
  it("posts a tally only after close, and amends only after a tally", () => {
    expect(L.electionActions({ ...base, status: 3 }).canPostTally).toBe(true);
    expect(L.electionActions({ ...base, status: 2 }).canPostTally).toBe(false);
    expect(L.electionActions({ ...base, status: 4 }).canPostTally).toBe(false);
    expect(L.electionActions({ ...base, status: 4 }).canAmend).toBe(true);
    expect(L.electionActions({ ...base, status: 4, isOrganizer: false }).canAmend).toBe(false);
  });
  it("only registers phones and reviewers during setup", () => {
    expect(L.canRegisterRoles({ status: 1, isOrganizer: true })).toBe(true);
    expect(L.canRegisterRoles({ status: 2, isOrganizer: true })).toBe(false);
    expect(L.canRegisterRoles({ status: 1, isOrganizer: false })).toBe(false);
  });
});

describe("tally comparison", () => {
  const off = [{ valid: 3, blank: 1, overvote: 0, unclear: 0 }, { valid: 2, blank: 1, overvote: 1, unclear: 0 }];
  it("matches identical totals", () => {
    const c = L.compareTally(off, off.map((x) => ({ ...x })));
    expect(c).toMatchObject({ checked: true, matches: true, differences: [] });
  });
  it("lists exactly what differs", () => {
    const c = L.compareTally(off, [off[0], { ...off[1], valid: 3 }]);
    expect(c.matches).toBe(false);
    expect(c.differences).toEqual([{ question: 2, field: "valid", official: 2, recount: 3 }]);
  });
  it("fails when the question counts differ and is 'not checked' without a tally", () => {
    expect(L.compareTally(off, [off[0]]).matches).toBe(false);
    expect(L.compareTally([], []).checked).toBe(false);
    expect(L.compareTally(undefined as never, []).matches).toBeNull();
  });
  it("audits that entries are readable and inside the election's rules", () => {
    const qs = [{ id: "q1", maxMarks: 1, choices: [{ id: "c1" }, { id: "c2" }] }, { id: "q2", maxMarks: 2, choices: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] }];
    expect(L.auditEntries(["V:c1|V:c2+c3", "B|O"], qs)).toMatchObject({ checked: 4, agreed: 4, problems: [] });
    const bad = L.auditEntries(["V:c9|V:c1+c2+c3", "V:c1+c2|U", "x|B", "V:c1"], qs);
    expect(bad.agreed).toBe(3);
    expect(bad.problems.map((p) => p.problem)).toEqual(expect.arrayContaining([expect.stringMatching(/unknown choice c9/), expect.stringMatching(/at most 2/), expect.stringMatching(/at most 1/), expect.stringMatching(/unreadable/), expect.stringMatching(/has 1 answers/)]));
  });
  it("summarizes special entries", () => {
    expect(L.summarizeEntries(["V:c1|B", "O|U", "B|B"], [{ id: "q1", choices: [{ id: "c1" }, { id: "c2" }] }, { id: "q2", choices: [{ id: "c1" }, { id: "c2" }] }])).toEqual({ unclear: 1, overvote: 1, blank: 3, unreadable: 0 });
  });
});

describe("image fingerprints", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  it("compares the ledger and the store as sets, in any spelling", () => {
    const r = L.compareImageSets(["0x" + a, "0x" + b], [a.toUpperCase(), c]);
    expect(r).toMatchObject({ onChain: 2, inStore: 2, matched: [a], missingFromStore: [b], notOnLedger: [c] });
  });
  it("classifies a downloaded image", () => {
    const set = new Set([a]);
    expect(L.classifyImage(a, a, set)).toBe("verified");
    expect(L.classifyImage(a, b, set)).toBe("tampered");
    expect(L.classifyImage(c, c, set)).toBe("not-on-ledger");
    expect(L.classifyImage(a, "short", set)).toBe("failed");
  });
  it("summarizes checks and includes manifest-only differences", () => {
    const items = [{ sha256: a, status: "verified" }, { sha256: b, status: "tampered" }, { sha256: c, status: "failed", reason: "HTTP 500" }];
    const s = L.summarizeImageChecks(items, L.compareImageSets([a, b, "d".repeat(64)], [a, b, c, "e".repeat(64)]));
    expect(s).toMatchObject({ manifest: 4, downloaded: 2, verified: 1, tampered: [b], failed: [{ sha256: c, reason: "HTTP 500" }], missingFromStore: ["d".repeat(64)] });
    expect(s.notOnLedger.sort()).toEqual([c, "e".repeat(64)]);
  });
});

describe("verifier flags", () => {
  const clean = { tallyPosted: true, tallyMatches: true, failedChecks: 0, reconciliationDrift: false, fileCheck: "verified", recordsRead: 5, recordCount: 5, unreadable: 0, auditProblems: 0, merkle: { checked: true, matches: true, unknownBallots: 0 }, images: { tampered: [], missingFromStore: [], notOnLedger: [], failed: [] }, unclear: 0, overvote: 0 };
  it("raises nothing when everything checks out", () => {
    expect(L.buildFlags(clean)).toEqual([]);
  });
  it("raises each problem with the right level and puts the worst first", () => {
    const f = L.buildFlags({ ...clean, tallyMatches: false, tallyDifferences: [{}], failedChecks: 9, fileCheck: "mismatch", recordsRead: 4, merkle: { checked: true, matches: false, unknownBallots: 1 }, images: { tampered: ["x"], missingFromStore: ["y"], notOnLedger: ["z"], failed: ["w"] }, unclear: 2, overvote: 1 });
    const ids = f.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["tally-mismatch", "reconciliation-failed", "file-mismatch", "record-count", "merkle-mismatch", "unknown-ballots", "image-tampered", "image-missing", "image-extra", "image-failed", "unclear", "overvote"]));
    const levels = f.map((x) => x.level);
    const rank = (l: string | undefined): number => ({ bad: 0, warn: 1, info: 2 } as Record<string, number>)[l ?? ""] ?? 9;
    expect(levels).toEqual([...levels].sort((p, q) => rank(p) - rank(q)));
    expect(f.find((x) => x.id === "reconciliation-failed")?.detail).toMatch(/R1, R4/);
  });
  it("says 'not checked' instead of passing", () => {
    expect(L.buildFlags({ tallyPosted: false, merkle: { checked: false }, images: null }).map((x) => x.id).sort()).toEqual(["images-unchecked", "merkle-unchecked", "no-tally"]);
    expect(L.buildFlags({}).length).toBe(0);
  });
});

describe("signed report", () => {
  const input = () => ({
    electionCode: "BEINGS-2026-WMRHGH", tallyVersion: 1, address: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", block: 100, recordCount: 5, recordsRead: 5, correctionsRead: 0,
    audit: { checked: 15, agreed: 15 }, tally: { checked: true, matches: true, differences: [] }, recon: { checked: true, matches: true, failedChecks: 0 },
    merkle: { checked: true, matches: true, root: "0x" + "11".repeat(32), onChainRoot: "0x" + "11".repeat(32) },
    images: { downloaded: 5, verified: 5, tampered: [], missingFromStore: [], notOnLedger: [], failed: [] }, fileCheck: "verified", flags: [], createdAt: "2026-11-01T00:00:00.000Z",
  });
  it("records what was and wasn't checked", () => {
    const r = L.buildVerifierReport({ ...input(), merkle: { checked: false }, images: null });
    expect(r.merkle).toEqual({ checked: false, matches: null, recomputedRoot: null, onChainRoot: null });
    expect(r.images).toBeNull();
    expect(r.kind).toBe("web-verifier-report");
  });
  it("hashes the same however the keys are ordered and ignores a signature field", () => {
    const r = L.buildVerifierReport(input());
    const shuffled = Object.fromEntries(Object.entries(r).reverse());
    expect(L.reportCanonical(shuffled)).toBe(L.reportCanonical(r));
    expect(L.reportCanonical({ ...r, signature: { x: 1 } })).toBe(L.reportCanonical(r));
    expect(L.reportCanonical(r)).toBe(canonicalize(r));
  });
  it("is signed with the same EIP-712 type @beings/core uses, and the signer is recoverable", async () => {
    const w = new Wallet("0x" + "44".repeat(32));
    const r = L.buildVerifierReport({ ...input(), address: w.address });
    const reportHash = keccak256(new TextEncoder().encode(L.reportCanonical(r)));
    const t = L.reportTypedData({ electionKey: "0x" + "22".repeat(32), tallyVersion: 1, reportHash });
    expect(t.domain).toEqual({ name: "B.E.I.N.G.S.", version: "1", chainId: 114 });
    const sig = await w.signTypedData(t.domain, t.types, t.value);
    expect(verifyTypedData(t.domain, t.types, t.value, sig)).toBe(w.address);
  });
  const corePath = fileURLToPath(new URL("../../../packages/core/src/eip712.ts", import.meta.url));
  it.skipIf(!existsSync(corePath))("hashes and signs exactly like @beings/core's report functions (monorepo only)", async () => {
    const core = (await import(/* @vite-ignore */ corePath)) as any;
    const w = new Wallet("0x" + "44".repeat(32));
    const r = L.buildVerifierReport({ ...input(), address: w.address });
    const reportHash = keccak256(new TextEncoder().encode(L.reportCanonical(r)));
    const theirs = core.reportTypedData(r);
    expect(theirs.message.reportHash).toBe(reportHash);
    expect(theirs.message.tallyVersion).toBe(1);
    const t = L.reportTypedData({ electionKey: theirs.message.electionKey, tallyVersion: 1, reportHash });
    expect(t.types).toEqual(theirs.types);
    expect(t.domain).toEqual(theirs.domain);
    const sig = await w.signTypedData(t.domain, t.types, t.value);
    expect(core.verifyReport({ ...r, signature: sig })).toBe(true);
  });
  it("only offers the on-chain report when every check really ran", () => {
    const ok = L.onChainReportArgs(L.buildVerifierReport(input()), { electionKey: "0x" + "22".repeat(32), reportCid: "local-unpublished:abcd", reportSha256: "0x" + "33".repeat(32) });
    expect(ok.ok).toBe(true);
    expect(ok.args).toEqual(["0x" + "22".repeat(32), 1, "local-unpublished:abcd", "0x" + "33".repeat(32), 15, 15, true, true, true]);
    const no = L.onChainReportArgs(L.buildVerifierReport({ ...input(), merkle: { checked: false }, tallyVersion: 0 }), { electionKey: "0x", reportCid: "x", reportSha256: "0x" });
    expect(no.ok).toBe(false);
    expect(no.missing).toEqual(expect.arrayContaining([expect.stringMatching(/tally has to be published/), expect.stringMatching(/Merkle/)]));
  });
});

describe("verifier download request", () => {
  it("builds the challenge exactly like the server", () => {
    expect(L.challengeMessage("BEINGS-2026-WMRHGH", 1767225600)).toBe(serverChallenge("BEINGS-2026-WMRHGH", 1767225600));
  });
  it("is verifiable the way the server verifies it (EIP-191)", async () => {
    const w = new Wallet("0x" + "55".repeat(32));
    const sig = await w.signMessage(L.challengeMessage("BEINGS-2026-WMRHGH", 100));
    expect(verifyMessage(serverChallenge("BEINGS-2026-WMRHGH", 100), sig)).toBe(w.address);
  });
  it("reuses a signature briefly, inside the server's window", () => {
    expect(L.signatureStillFresh(1000, 1100)).toBe(true);
    expect(L.signatureStillFresh(1000, 1000 + L.SIGNATURE_REUSE_SECONDS)).toBe(false);
    expect(L.signatureStillFresh(1000, 900)).toBe(false);
    expect(L.SIGNATURE_REUSE_SECONDS).toBeLessThan(L.VERIFIER_WINDOW_SECONDS);
  });
  it("explains every answer the image API can give", () => {
    for (const s of [401, 403, 404, 410, 429, 500, 418]) expect(L.verifierApiMessage(s).length).toBeGreaterThan(10);
    expect(L.verifierApiMessage(403)).toMatch(/organizer or a registered verifier/);
  });
});

describe("Merkle recomputation", () => {
  const leaf = (n: number) => keccak(new Uint8Array([n]));
  it("is order independent, promotes odd nodes and uses the zero root for nothing", () => {
    expect(L.merkleRoot([], keccak)).toBe("0x" + "00".repeat(32));
    expect(L.merkleRoot([leaf(1)], keccak)).toBe(leaf(1));
    const ls = [leaf(1), leaf(2), leaf(3)];
    expect(L.merkleRoot(ls, keccak)).toBe(L.merkleRoot([...ls].reverse(), keccak));
    expect(() => L.merkleRoot([leaf(1), leaf(1)], keccak)).toThrow(/duplicate/);
  });
  const corePath = fileURLToPath(new URL("../../../packages/core/src/merkle.ts", import.meta.url));
  it.skipIf(!existsSync(corePath))("equals @beings/core's merkleRoot for many sizes (monorepo only)", async () => {
    const core = (await import(/* @vite-ignore */ corePath)) as any;
    for (let n = 0; n <= 20; n++) {
      const ls = Array.from({ length: n }, (_, i) => leaf(i + 1));
      expect(L.merkleRoot(ls, keccak)).toBe(core.merkleRoot(ls));
    }
  });
  const fixture = fileURLToPath(new URL("../../../packages/ledger/deployments/coston2-scanned-5.json", import.meta.url));
  it.skipIf(!existsSync(fixture))("recomputes the posted tally root of the scanned test election from its ledger entries (monorepo only)", () => {
    const d = JSON.parse(readFileSync(fixture, "utf8"));
    const qs = d.electionFile.questions;
    const records = d.ballots.map((b: any) => ({ ballotKey: b.ballotKey, results: b.resultsString, imageSha256: b.imageSha256, recordSha256: b.recordSha256, reviewed: false }));
    const r = L.ledgerMerkle({ electionCode: d.electionFile.electionCode, records, codes: d.electionFile.ballotCodes, questions: qs, keccak });
    expect(r.unknown).toBe(0);
    expect(r.leaves).toBe(5);
    expect(r.root).toBe(d.tally.merkleRoot);
  });
  it("counts ledger entries whose ballot isn't in the file", () => {
    const r = L.ledgerMerkle({ electionCode: "BEINGS-2026-AAAAAA", records: [{ ballotKey: "0x" + "99".repeat(32), results: "V:c1", imageSha256: "a".repeat(64), recordSha256: "b".repeat(64), reviewed: false }], codes: ["4F9Q7M2XHT8B"], questions: [{ id: "q1" }], keccak });
    expect(r).toMatchObject({ unknown: 1, leaves: 0 });
  });
  it("turns a ledger string into question results", () => {
    expect(L.resultsObject("V:c1|B", [{ id: "q1" }, { id: "q2" }])).toEqual({ q1: "V:c1", q2: "B" });
    expect(() => L.resultsObject("V:c1", [{ id: "q1" }, { id: "q2" }])).toThrow();
  });
});

describe("zip builder", () => {
  it("computes the standard crc32", () => {
    expect(L.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(L.crc32(new Uint8Array())).toBe(0);
  });
  it("makes an archive that unzip and zipfile readers accept", async () => {
    const files = [{ name: "a.png", bytes: new Uint8Array([1, 2, 3, 4]) }, { name: "dir/b.txt", bytes: new TextEncoder().encode("hello") }];
    const zip = L.buildZip(files, new Date("2026-11-01T10:00:00Z"));
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(2);
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(resolve(tmpdir(), "zip-"));
    const zipPath = resolve(dir, "t.zip");
    writeFileSync(zipPath, zip);
    const script = "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()),z.read('dir/b.txt'))";
    // Windows Store stubs answer `python3` with exit 9009 when Python is not installed. A real interpreter that rejects the archive exits 1.
    const tries: [string, string[]][] = [
      ["python3", ["-c", script, zipPath]],
      ["python", ["-c", script, zipPath]],
      ["py", ["-3", "-c", script, zipPath]],
    ];
    let ran: { status: number | null; stdout: string } | null = null;
    for (const [cmd, args] of tries) {
      const t = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
      if (t.error || t.status === 9009) continue;
      ran = t;
      break;
    }
    if (!ran) return; // no Python: the structural checks above still ran
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("b'hello'");
  });
});

describe("election file", () => {
  const good = () =>
    L.draftElectionFile({
      name: "Room 12", organizer: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", registeredVoters: 5, quorum: 1, opensAt: "2026-11-09T16:00:00Z", closesAt: "2026-11-09T22:00:00Z",
      electionCode: "BEINGS-2026-WMRHGH", ballotCodes: ["REDACTED-BALLOT-CODE", "REDACTED-BALLOT-CODE", "AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC", "DDDDDDDDDDDD"], layoutHash: "6e".repeat(32), retentionDays: 30, approvedAppHashes: ["9f".repeat(32)],
      questions: [{ text: "Pizza?", maxMarks: 1, choices: ["Yes", "No"] }, { text: "Pick two", maxMarks: 2, choices: ["A", "B", "C"] }],
    });
  const problems = (mut: (f: any) => void) => { const f = good(); mut(f); return L.validateElectionFile(f).map((p) => p.field); };
  it("accepts a well-formed file and numbers questions and choices", () => {
    const f = good();
    expect(L.validateElectionFile(f)).toEqual([]);
    expect(f.questions[1]).toMatchObject({ id: "q2", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }, { id: "c3", text: "C" }] });
    expect(f.ballotCodes[0] <= f.ballotCodes[1]).toBe(true);
    expect(f.imageRetention).toEqual({ basis: "organizer-policy", days: 30, afterRetention: "delete" });
  });
  it("matches the shape of the existing test election", () => {
    const sample = wrapper.file;
    const mine = good();
    for (const k of Object.keys(sample).filter((k) => k !== "ballotCodes")) expect(Object.keys(mine)).toContain(k);
    expect(mine.resultRules).toEqual(sample.resultRules);
    expect(mine.privacy).toEqual(sample.privacy);
  });
  it.each([
    ["election code", (f: any) => { f.electionCode = "bad"; }, "electionCode"],
    ["name", (f: any) => { f.name = " "; }, "name"],
    ["no questions", (f: any) => { f.questions = []; }, "questions"],
    ["one choice", (f: any) => { f.questions[0].choices = [f.questions[0].choices[0]]; }, "question 1"],
    ["too many marks", (f: any) => { f.questions[0].maxMarks = 3; }, "question 1"],
    ["quorum 5", (f: any) => { f.quorum = 5; }, "quorum"],
    ["quorum 0", (f: any) => { f.quorum = 0; }, "quorum"],
    ["close before open", (f: any) => { f.closesAt = f.opensAt; }, "closesAt"],
    ["bad date", (f: any) => { f.opensAt = "tomorrow"; }, "opensAt"],
    ["duplicate ballot codes", (f: any) => { f.ballotCodes[1] = f.ballotCodes[0]; }, "ballotCodes"],
    ["bad ballot code", (f: any) => { f.ballotCodes[0] = "4F9U7M2XHT8B"; }, "ballotCodes"],
    ["fewer ballots than voters", (f: any) => { f.registeredVoters = 50; }, "ballotCodes"],
    ["no layout hash", (f: any) => { delete f.layoutHash; }, "layoutHash"],
    ["bad layout hash", (f: any) => { f.layoutHash = "xyz"; }, "layoutHash"],
    ["no retention", (f: any) => { delete f.imageRetention; }, "imageRetention"],
    ["retention too long", (f: any) => { f.imageRetention.days = 4000; }, "imageRetention"],
    ["no app hash", (f: any) => { f.approvedAppHashes = []; }, "approvedAppHashes"],
    ["bad organizer", (f: any) => { f.organizerPublicKey = "0x12"; }, "organizerPublicKey"],
  ])("rejects: %s", (_n, mut, field) => {
    expect(problems(mut as never)).toContain(field);
  });
  it("accepts 0 registered voters (no register)", () => {
    expect(problems((f) => { f.registeredVoters = 0; })).toEqual([]);
  });
  it("builds the createElection arguments", () => {
    const f = good();
    const args = L.createElectionArgs(f, { cid: "local-unpublished:x", fileSha256: "0x" + "ab".repeat(32), ballotListRoot: "0x" + "cd".repeat(32) });
    expect(args).toEqual(["BEINGS-2026-WMRHGH", "local-unpublished:x", "0x" + "ab".repeat(32), 6, 5, 1, 1794240000, 1794261600, "0x" + "cd".repeat(32)]);
    expect(L.createElectionCall(f, { cid: "local-unpublished:x", fileSha256: "0x" + "ab".repeat(32), ballotListRoot: "0x" + "cd".repeat(32) }, true).method).toBe("createPooledElection");
    expect(L.createElectionCall(f, { cid: "local-unpublished:x", fileSha256: "0x" + "ab".repeat(32), ballotListRoot: "0x" + "cd".repeat(32) }, false).method).toBe("createElection");
    expect(L.unixFromIso("not a date")).toBeNull();
    expect(L.unixFromIso("2026-11-09T16:00:00Z")).toBe(1794240000);
  });
  it("defaults Public ballot images to off and keeps the flag in the public copy", () => {
    const f = good();
    expect(f.publicBallotImages).toBe(false);
    expect(L.validateElectionFile(f)).toEqual([]);
    const pub = L.publicElectionCopy(f) as any;
    expect(pub.publicBallotImages).toBe(false);
    expect(L.summarizeElectionFile(f).publicBallotImages).toBe(false);
  });
  it("accepts public pictures only when retention is 30 to 60 days", () => {
    expect(problems((f) => { f.publicBallotImages = true; })).toEqual([]);
    expect(problems((f) => { f.publicBallotImages = true; f.imageRetention.days = 60; })).toEqual([]);
    expect(problems((f) => { f.publicBallotImages = true; f.imageRetention.days = 29; })).toContain("imageRetention");
    expect(problems((f) => { f.publicBallotImages = true; f.imageRetention.days = 61; })).toContain("imageRetention");
    expect(problems((f) => { f.publicBallotImages = true; f.imageRetention.days = 90; })).toContain("imageRetention");
    expect(problems((f) => { f.publicBallotImages = false; f.imageRetention.days = 365; })).toEqual([]);
    expect(problems((f) => { f.publicBallotImages = "yes"; })).toContain("publicBallotImages");
  });
  it("drafts publicBallotImages from the create form", () => {
    const on = L.draftElectionFile({
      name: "Room 12", organizer: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", registeredVoters: 5, quorum: 1, opensAt: "2026-11-09T16:00:00Z", closesAt: "2026-11-09T22:00:00Z",
      electionCode: "BEINGS-2026-WMRHGH", ballotCodes: ["REDACTED-BALLOT-CODE", "REDACTED-BALLOT-CODE", "AAAAAAAAAAAA", "BBBBBBBBBBBB", "CCCCCCCCCCCC", "DDDDDDDDDDDD"], layoutHash: "6e".repeat(32), retentionDays: 30, publicBallotImages: true, approvedAppHashes: ["9f".repeat(32)],
      questions: [{ text: "Pizza?", maxMarks: 1, choices: ["Yes", "No"] }],
    });
    expect(on.publicBallotImages).toBe(true);
    expect(L.validateElectionFile(on)).toEqual([]);
    expect(L.publicElectionCopy(on).publicBallotImages).toBe(true);
  });
  it("drops the secret ballot codes from the public copy", () => {
    const pub = L.publicElectionCopy(good()) as any;
    expect(pub.ballotCodes).toBeUndefined();
    expect(pub.ballotCount).toBe(6);
    expect(JSON.stringify(pub)).not.toMatch(/REDACTED-BALLOT-CODE/);
    const withAdded = L.publicElectionCopy({ ...good(), addedBallotPools: [{ count: 1, root: "0x" + "ab".repeat(32), codes: ["AAAAAAAAAAAA"] }] }) as any;
    expect(withAdded.addedBallotPools).toBeUndefined();
    expect(withAdded.ballotCodes).toBeUndefined();
    expect(withAdded.addedBallotCount).toBe(1);
    expect(JSON.stringify(withAdded)).not.toContain("AAAAAAAAAAAA");
    expect(L.electoralBodyPool({ registeredVoters: 5, verifiedExtras: 1, unissuedExtras: 2 })).toEqual({ quorumPool: 6, verifiedExtras: 1, unissuedExtras: 2, unusedAtClose: 2 });
    const found = L.ballotPoolProof([["AAAAAAAAAAAA", "BBBBBBBBBBBB"], ["CCCCCCCCCCCC"]], "CCCCCCCCCCCC", keccak);
    expect(found?.rootIndex).toBe(1);
    expect(JSON.stringify(found)).not.toContain("CCCCCCCCCCCC");
    const note = L.reprintNote({ electionCode: "BEINGS-2026-WMRHGH", ballotKey: found?.ballotKey, reason: "torn before it was cast", author: "0xfB2A3F83F2362566341b8edfB008a0C42A52d73D", at: "2026-11-14T00:00:00Z" });
    expect(note.ballotKey).toBe(found?.ballotKey);
    expect(JSON.stringify(note)).not.toContain("CCCCCCCCCCCC");
  });
  it("summarizes the file and computes the retention deadline", () => {
    const s = L.summarizeElectionFile(good());
    expect(s).toMatchObject({ questionCount: 2, choiceCount: 5, ballotCount: 6, retentionDays: 30, hasBallotCodes: true });
    expect(L.summarizeElectionFile(wrapper.file).retentionDays).toBeNull();
    expect(L.retentionDeadline(1000, 30)).toBe(1000 + 30 * 86400);
    expect(L.retentionDeadline(1000, null as never)).toBeNull();
  });
  it("generates codes the contracts and the printed ballots accept", () => {
    const rb = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    expect(L.newElectionCode(2026, rb)).toMatch(/^BEINGS-2026-[0-9A-HJKMNP-TV-Z]{6}$/);
    const codes = L.newBallotCodes(500, rb);
    expect(new Set(codes).size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });
  it("validates the election file fingerprint the way the site loads it", () => {
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe("network health", () => {
  it("classifies block age", () => {
    expect(L.blockFreshness(3)).toBe("fresh");
    expect(L.blockFreshness(60)).toBe("slow");
    expect(L.blockFreshness(1000)).toBe("stale");
    expect(L.blockFreshness(-1)).toBe("unknown");
    expect(L.blockFreshness(NaN)).toBe("unknown");
  });
  it("words ages", () => {
    expect(L.ageText(2)).toBe("2 seconds");
    expect(L.ageText(600)).toBe("10 minutes");
    expect(L.ageText(7200)).toBe("2 hours");
    expect(L.ageText(86400 * 5)).toBe("5 days");
  });
  it("checks that the contracts point at each other", () => {
    const c = { registry: "0xAa", ledger: "0xBb", tally: "0xCc" };
    const ok = L.wiringChecks(c, { registryLedger: "0xbb", registryTally: "0xCC", ledgerRegistry: "0xaa", tallyRegistry: "0xAA", tallyLedger: "0xBB" });
    expect(ok.every((x) => x.pass)).toBe(true);
    const bad = L.wiringChecks(c, { registryLedger: "0xdd", registryTally: "0xCC", ledgerRegistry: undefined, tallyRegistry: "0xAA", tallyLedger: "0xBB" });
    expect(bad.filter((x) => !x.pass).map((x) => x.id)).toEqual(["registry.ledger", "ledger.registry"]);
  });
  it("shortens long lists", () => {
    expect(L.shortList(["a", "b"])).toBe("a, b");
    expect(L.shortList(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});
