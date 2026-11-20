import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { RECORDS_SELECTOR, decodeRecordsResult, encodeRecordsCall } from "../src/chain.js";
import { BALLOT, ELECTION, PNG_HASH, encodeRecord } from "./helpers.js";

describe("chain record decoding", () => {
  it("decodes a recorded ballot", () => {
    expect(decodeRecordsResult(encodeRecord({ imageSha256: PNG_HASH, acceptedAt: 1_780_000_000, reviewed: true }))).toEqual({ recorded: true, imageSha256: PNG_HASH, acceptedAt: 1_780_000_000 });
  });
  it("an all-zero record means not recorded", () => {
    expect(decodeRecordsResult(encodeRecord({ results: "", imageSha256: "00".repeat(32), acceptedAt: 0 })).recorded).toBe(false);
  });
  it("rejects malformed or short data", () => {
    expect(() => decodeRecordsResult("0x")).toThrow();
    expect(() => decodeRecordsResult("zz")).toThrow();
    expect(() => decodeRecordsResult("0x" + "00".repeat(64))).toThrow();
  });
});

// Cross-check against ethers and the core source when this checkout is the monorepo.
// A site-only tree has no packages/core, so the block is skipped. It does not load the schema validator.
const coreCodes = fileURLToPath(new URL("../../../packages/core/src/codes.ts", import.meta.url));
const coreHash = fileURLToPath(new URL("../../../packages/core/src/hash.ts", import.meta.url));

describe.skipIf(!existsSync(coreCodes))("agreement with ethers and @beings/core (monorepo only)", () => {
  const sig = "function records(bytes32,bytes32) view returns (string results, bytes32 imageSha256, bytes32 recordSha256, uint64 acceptedAt, bool reviewed)";
  it("selector and calldata equal what ethers builds from core's keys", async () => {
    const core = await import(/* @vite-ignore */ coreCodes);
    const iface = new Interface([sig]);
    const expected = iface.encodeFunctionData("records", [core.electionKey(ELECTION), core.ballotKey(BALLOT)]);
    expect(encodeRecordsCall(ELECTION, BALLOT)).toBe(expected);
    expect(RECORDS_SELECTOR).toBe(iface.getFunction("records")!.selector.slice(2));
  });
  it("decoding equals ethers' decoding of a real ABI-encoded return", () => {
    const iface = new Interface([sig]);
    const data = iface.encodeFunctionResult("records", ["V:c1|V:c2", "0x" + PNG_HASH, "0x" + "22".repeat(32), 1_780_000_000n, false]);
    expect(decodeRecordsResult(data)).toEqual({ recorded: true, imageSha256: PNG_HASH, acceptedAt: 1_780_000_000 });
  });
  it("blob key hashes agree with core", async () => {
    const core = await import(/* @vite-ignore */ coreHash);
    expect(core.sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
