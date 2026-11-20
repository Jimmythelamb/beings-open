// Printed-ballot import and one-reading submission. No network, no wallet prompt, no ballot from a real election.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, Wallet, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import * as L from "../public/js/logic.js";
import { canonicalize, sha256Hex } from "../public/js/format.js";

const keccak = (b: Uint8Array) => keccak256(b);
const utf8 = (s: string) => new TextEncoder().encode(s);
const CODE = "BEINGS-2026-TEST12";
const A = "AAAAAAAAAAAA";
const B = "BBBBBBBBBBBB";
const LEDGER = "0xF579913c90b86f102Fff8D07c6c16f465495013C";
const wallet = new Wallet("0x" + "11".repeat(32));

function election(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: "0.1",
    version: 1,
    name: "Mock",
    organizerPublicKey: "0x2222222222222222222222222222222222222222",
    electionCode: CODE,
    questions: [
      { id: "q1", text: "One?", maxMarks: 1, choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }] },
      { id: "q2", text: "Two?", maxMarks: 2, choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }, { id: "c3", text: "C" }] },
    ],
    resultRules: { emptyBelow: 15, markedAbove: 50, results: ["V", "B", "O", "U"], abstainButton: false },
    imageRetention: { basis: "organizer-policy", days: 14, afterRetention: "delete" },
    registeredVoters: 1,
    ballotCodes: [A, B],
    layoutHash: "ab".repeat(32),
    approvedAppHashes: ["cd".repeat(32)],
    quorum: 1,
    opensAt: "2026-11-16T16:00:00Z",
    closesAt: "2026-11-16T22:00:00Z",
    ...over,
  };
}

function reading(scores: Record<string, Record<string, number>>, over: Record<string, unknown> = {}) {
  return { ballotCode: A, fillScores: scores, imageSha256: "ab".repeat(32), electionCode: CODE, ...over };
}

const blank = reading({ q1: { c1: 0, c2: 0 }, q2: { c1: 0, c2: 0, c3: 0 } });
const unclear = reading({ q1: { c1: 40, c2: 0 }, q2: { c1: 0, c2: 0, c3: 0 } });
const over = reading({ q1: { c1: 0, c2: 0 }, q2: { c1: 90, c2: 90, c3: 80 } });
const valid = reading({ q1: { c1: 80, c2: 0 }, q2: { c1: 90, c2: 70, c3: 0 } });

async function shaOf(file: object) {
  return "0x" + (await sha256Hex(utf8(canonicalize(file))));
}

describe("importing a printed election", () => {
  it("refuses a public copy and a readings file in the election slot", () => {
    expect(L.unwrapElectionImport({ publicCopy: true, file: election() }).error).toMatch(/public copy/i);
    expect(L.unwrapElectionImport({ readings: [blank] }).error).toMatch(/readings/i);
    expect(L.unwrapElectionImport({ file: { name: "x" } }).error).toMatch(/ballot codes/i);
  });

  it("keeps the codes when the schedule changes, and the fingerprint moves with the file", async () => {
    const file = election();
    const root = L.ballotListRootOf(file.ballotCodes, keccak);
    const before = await shaOf(file);
    const next = L.withSchedule(file, "2026-11-07T12:00:00Z", "2026-11-07T18:00:00Z");
    expect(next.ballotCodes).toEqual(file.ballotCodes);
    expect(next.questions).toEqual(file.questions);
    expect(next.layoutHash).toBe(file.layoutHash);
    expect(file.opensAt).toBe("2026-11-16T16:00:00Z");
    expect(L.ballotListRootOf(next.ballotCodes, keccak)).toBe(root);
    const after = await shaOf(next);
    expect(after).not.toBe(before);
    const args = L.createElectionArgs(next, { cid: "local-unpublished:" + CODE, fileSha256: after, ballotListRoot: root });
    expect(args[2]).toBe(after);
    expect(args[6]).toBe(L.unixFromIso(next.opensAt));
    expect(args[7]).toBe(L.unixFromIso(next.closesAt));
    expect(args[8]).toBe(root);
    const back = L.withSchedule(file, file.opensAt, file.closesAt);
    expect(await shaOf(back)).toBe(before);
  });

  it("rejects a manifest whose root or fingerprint does not match, and accepts a schedule edit against the old fingerprint", async () => {
    const file = election();
    const root = L.ballotListRootOf(file.ballotCodes, keccak);
    const sha = await shaOf(file);
    const manifest = { createElection: { electionCode: CODE, fileSha256: sha, ballotListRoot: root, ballotCount: 2 } };
    expect(L.importProblems({ file, manifest, fileSha256: sha, ballotListRoot: root, datesChanged: false })).toEqual([]);
    expect(L.importProblems({ file, manifest, fileSha256: "0x" + "11".repeat(32), ballotListRoot: root, datesChanged: false }).some((p) => p.field === "fileSha256")).toBe(true);
    expect(L.importProblems({ file, manifest, fileSha256: "0x" + "11".repeat(32), ballotListRoot: root, datesChanged: true, baselineSha256: "0x" + "11".repeat(32) }).some((p) => p.field === "fileSha256")).toBe(true);
    expect(L.importProblems({ file, manifest, fileSha256: "0x" + "11".repeat(32), ballotListRoot: root, datesChanged: true, baselineSha256: sha }).some((p) => p.field === "fileSha256")).toBe(false);
    expect(L.importProblems({ file, manifest, fileSha256: sha, ballotListRoot: "0x" + "22".repeat(32), datesChanged: false }).some((p) => p.field === "ballotListRoot")).toBe(true);
    expect(L.importProblems({ file, manifest: { createElection: { ...manifest.createElection, electionCode: "BEINGS-2026-OTHER1" } }, fileSha256: sha, ballotListRoot: root, datesChanged: false }).some((p) => p.field === "manifest")).toBe(true);
    const badCodes = election({ ballotCodes: ["CCCCCCCCCCCC", B] });
    expect(L.validateElectionFile(badCodes)).toEqual([]);
    expect(L.ballotListRootOf(badCodes.ballotCodes, keccak)).not.toBe(root);
  });

  it("tells a matching chain election from a conflicting one", async () => {
    const file = election();
    const root = L.ballotListRootOf(file.ballotCodes, keccak);
    const sha = await shaOf(file);
    expect(L.chainAgrees(file, null, { fileSha256: sha, ballotListRoot: root }).state).toBe("absent");
    expect(L.chainAgrees(file, { code: CODE, ballotListRoot: root, fileSha256: sha, ballotCount: 2 }, { fileSha256: sha, ballotListRoot: root }).state).toBe("match");
    expect(L.chainAgrees(file, { code: CODE, ballotListRoot: "0x" + "33".repeat(32), fileSha256: sha, ballotCount: 2 }, { fileSha256: sha, ballotListRoot: root }).state).toBe("conflict");
  });
});

describe("readings", () => {
  const file = election();

  it("keeps blank, unclear, overvote and a normal mark as the scores produce them", () => {
    const cases = [
      [blank, "B|B"],
      [unclear, "U|B"],
      [over, "B|O"],
      [valid, "V:c1|V:c1+c2"],
    ] as const;
    for (const [raw, expectString] of cases) {
      const got = L.assessReading(raw, file, keccak);
      expect(got.problems, expectString).toEqual([]);
      expect(got.reading?.resultsString).toBe(expectString);
    }
    const tally = L.readingTally([
      L.assessReading(blank, file, keccak).reading!,
      L.assessReading(unclear, file, keccak).reading!,
      L.assessReading(over, file, keccak).reading!,
      L.assessReading(valid, file, keccak).reading!,
    ]);
    expect(tally).toMatchObject({ ballots: 4, B: 4, U: 1, O: 1, V: 2 });
  });

  it("rejects a result that was edited away from the scores, a bad hash, a foreign code and a duplicate", () => {
    const edited = L.assessReading({ ...unclear, results: { q1: "V:c1", q2: "B" } }, file, keccak);
    expect(edited.problems.join(" ")).toMatch(/not changed/);
    const hashed = L.assessReading(valid, file, keccak).reading!;
    const tampered = L.assessReading({ ...valid, scoresHash: "0x" + "44".repeat(32) }, file, keccak);
    expect(tampered.problems.join(" ")).toMatch(/scores fingerprint/);
    const badJoin = L.assessReading({ ...valid, resultsString: "B|B" }, file, keccak);
    expect(badJoin.problems.join(" ")).toMatch(/joined result/);
    expect(L.assessReading({ ...valid, resultsHash: hashed.resultsHash }, file, keccak).problems).toEqual([]);
    expect(L.assessReading({ ...valid, resultsHash: "0x" + "55".repeat(32) }, file, keccak).problems.join(" ")).toMatch(/results fingerprint/);
    expect(L.assessReading({ ...valid, ballotCode: "CCCCCCCCCCCC" }, file, keccak).problems.join(" ")).toMatch(/not in the election/);
    expect(L.assessReading({ ...valid, electionCode: "BEINGS-2026-OTHER1" }, file, keccak).problems.join(" ")).toMatch(/different election/);
    expect(L.assessReading({ ...valid, imageSha256: "abcd" }, file, keccak).problems.join(" ")).toMatch(/picture fingerprint/);
    const dup = L.assessReadings([valid, { ...valid, scan: 2 }], file, keccak);
    expect(dup.problems.join(" ")).toMatch(/more than once/);
    expect(L.assessReadings({ readings: [] }, file, keccak).problems.join(" ")).toMatch(/empty/);
    expect(L.assessReadings({ hello: true }, file, keccak).problems.join(" ")).toMatch(/isn't a readings/);
  });
});

describe("recording one ballot", () => {
  const open = { chainId: 114, verifyingContract: LEDGER, ledger: LEDGER, role: 1, status: 2, found: false, spoiled: false, quorum: 1, signer: wallet.address, device: wallet.address };

  it("refuses the wrong chain, the wrong ledger, a missing role, a closed election, a duplicate and a second device", () => {
    expect(L.submissionGate(open).ok).toBe(true);
    expect(L.submissionGate({ ...open, chainId: 16 }).ok).toBe(false);
    expect(L.submissionGate({ ...open, chainId: null }).ok).toBe(false);
    expect(L.submissionGate({ ...open, ledger: "0x0000000000000000000000000000000000000001" }).reason).toMatch(/ledger/);
    expect(L.submissionGate({ ...open, role: 0 }).reason).toMatch(/not a registered scanning/);
    expect(L.submissionGate({ ...open, role: 2 }).reason).toMatch(/not a registered scanning/);
    expect(L.submissionGate({ ...open, status: 1 }).reason).toMatch(/not open/);
    expect(L.submissionGate({ ...open, found: true }).reason).toMatch(/already/);
    expect(L.submissionGate({ ...open, spoiled: true }).reason).toMatch(/spoiled/);
    expect(L.submissionGate({ ...open, quorum: 2 }).reason).toMatch(/more than one/);
    expect(L.submissionGate({ ...open, signer: "0x0000000000000000000000000000000000000002" }).reason).toMatch(/not from the connected/);
  });

  it("treats a cancelled or failed wallet step as no signature and no transaction", () => {
    expect(L.walletProduced({ status: "cancelled", signature: "0x" + "ab".repeat(65) }, "signature")).toBeNull();
    expect(L.walletProduced({ status: "failed", hash: "0xabc" }, "hash")).toBeNull();
    expect(L.walletProduced({ status: "signed", signature: "0x" + "ab".repeat(65) }, "signature")).toMatch(/^0x/);
    expect(L.walletProduced(null, "signature")).toBeNull();
  });

  it("signs the Reading type for this ledger, and a different wallet does not verify", async () => {
    const file = election();
    const one = L.assessReading(valid, file, keccak).reading!;
    const typed = L.readingTypedData({
      electionKey: one.electionKey,
      ballotKey: one.ballotKey,
      resultsHash: one.resultsHash,
      imageSha256: "0x" + one.imageSha256,
      scoresHash: one.scoresHash,
      verifyingContract: LEDGER,
    });
    expect(typed.domain).toMatchObject({ name: "B.E.I.N.G.S.", version: "1", chainId: 114, verifyingContract: LEDGER });
    expect(typed.types.Reading.map((f) => f.name)).toEqual(["electionKey", "ballotKey", "resultsHash", "imageSha256", "scoresHash"]);
    const sig = await wallet.signTypedData(typed.domain, typed.types, typed.message);
    expect(verifyTypedData(typed.domain, typed.types, typed.message, sig)).toBe(wallet.address);
    const other = new Wallet("0x" + "22".repeat(32));
    expect(verifyTypedData(typed.domain, typed.types, typed.message, await other.signTypedData(typed.domain, typed.types, typed.message))).not.toBe(wallet.address);
    const record = L.ballotRecord({ electionCode: CODE, ballotCode: A, results: one.results, fillScores: one.fillScores, imageSha256: one.imageSha256, device: wallet.address, signature: sig });
    const recordSha = "0x" + (await sha256Hex(utf8(canonicalize(record))));
    const args = L.submitRecordArgs({ electionKey: one.electionKey, ballotKey: one.ballotKey, resultsString: one.resultsString, imageSha256: "0x" + one.imageSha256, recordSha256: recordSha, scoresHash: one.scoresHash, device: wallet.address, signature: sig });
    expect(args[0][2]).toBe("V:c1|V:c1+c2");
    expect(args[0][5]).toEqual([[wallet.address, "0x" + one.imageSha256, one.scoresHash, sig]]);
    expect(args[0][7]).toBe("0x");
  });

  const coreResults = fileURLToPath(new URL("../../../packages/core/src/results.ts", import.meta.url));
  const coreHash = fileURLToPath(new URL("../../../packages/core/src/hash.ts", import.meta.url));
  const coreMerkle = fileURLToPath(new URL("../../../packages/core/src/merkle.ts", import.meta.url));
  const coreEip = fileURLToPath(new URL("../../../packages/core/src/eip712.ts", import.meta.url));
  it.skipIf(!existsSync(coreResults))("matches @beings/core on the result, the hashes and the signature domain", async () => {
    const results = (await import(/* @vite-ignore */ coreResults)) as any;
    const hash = (await import(/* @vite-ignore */ coreHash)) as any;
    const merkle = (await import(/* @vite-ignore */ coreMerkle)) as any;
    const eip = (await import(/* @vite-ignore */ coreEip)) as any;
    const file = election();
    expect(merkle.ballotListRoot(file.ballotCodes)).toBe(L.ballotListRootOf(file.ballotCodes, keccak));
    expect("0x" + hash.sha256Json(file)).toBe(await shaOf(file));
    for (const raw of [blank, unclear, over, valid]) {
      const mine = L.assessReading(raw, file, keccak).reading!;
      const derived = results.deriveResults(file, raw.fillScores);
      expect(results.encodeResults(derived, ["q1", "q2"])).toBe(mine.resultsString);
      expect(hash.keccakJson(raw.fillScores)).toBe(mine.scoresHash);
      expect(results.resultsHash(derived, ["q1", "q2"])).toBe(mine.resultsHash);
      const typed = eip.readingTypedData({ electionCode: CODE, ballotCode: A, results: derived, imageSha256: raw.imageSha256, fillScores: raw.fillScores, questionOrder: ["q1", "q2"] }, eip.eip712Domain({ chainId: 114, verifyingContract: LEDGER }));
      const ours = L.readingTypedData({ electionKey: mine.electionKey, ballotKey: mine.ballotKey, resultsHash: mine.resultsHash, imageSha256: "0x" + mine.imageSha256, scoresHash: mine.scoresHash, verifyingContract: LEDGER });
      expect(ours.message).toEqual(typed.message);
      expect(ours.domain).toEqual(typed.domain);
    }
  });
});
