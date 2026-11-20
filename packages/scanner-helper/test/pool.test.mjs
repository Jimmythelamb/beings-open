import { keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { proofForCode } from "../src/pool.mjs";

const keccak = (bytes) => keccak256(bytes);

describe("ballot pool proofs", () => {
  it("builds a proof from the secret file and does not return the code", () => {
    const file = {
      ballotCodes: ["AAAAAAAAAAAA", "BBBBBBBBBBBB"],
      addedBallotPools: [{ codes: ["CCCCCCCCCCCC"] }],
    };
    const created = proofForCode(file, "AAAAAAAAAAAA", keccak);
    const added = proofForCode(file, "CCCCCCCCCCCC", keccak);
    expect(created.rootIndex).toBe(0);
    expect(added.rootIndex).toBe(1);
    expect(added.proof).toEqual([]);
    expect(proofForCode(file, "DDDDDDDDDDDD", keccak)).toBeNull();
    expect(JSON.stringify({ created, added })).not.toMatch(/AAAAAAAAAAAA|CCCCCCCCCCCC/);
  });
});
