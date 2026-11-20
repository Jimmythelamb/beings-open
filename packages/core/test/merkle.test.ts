import { describe, expect, it } from "vitest";
import { BeingsError, ZERO_ROOT, ballotKey, ballotListRoot, ballotPoolProof, keccakHex, merkleProof, merkleRoot, verifyProof } from "../src/index.js";
import { concatBytes, hexToBytes } from "../src/index.js";

const leaf = (i: number) => keccakHex(`leaf-${i}`);
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));
/** Independent reference: OpenZeppelin StandardMerkleTree-style sorted-pair hash. */
const pair = (a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return keccakHex(concatBytes(hexToBytes(x), hexToBytes(y)));
};

describe("merkle", () => {
  it("empty list gives the zero root", () => {
    expect(merkleRoot([])).toBe(ZERO_ROOT);
    expect(ZERO_ROOT).toBe("0x" + "00".repeat(32));
  });

  it("single leaf: root is the leaf, proof is empty", () => {
    expect(merkleRoot([leaf(0)])).toBe(leaf(0));
    expect(merkleProof([leaf(0)], leaf(0))).toEqual([]);
    expect(verifyProof(leaf(0), leaf(0), [])).toBe(true);
  });

  it("two leaves: sorted-pair hash", () => {
    expect(merkleRoot([leaf(0), leaf(1)])).toBe(pair(leaf(0), leaf(1)));
    expect(merkleRoot([leaf(1), leaf(0)])).toBe(pair(leaf(0), leaf(1)));
  });

  it("three leaves: odd node is promoted unchanged", () => {
    const s = [...leaves(3)].sort();
    expect(merkleRoot(leaves(3))).toBe(pair(pair(s[0] as string, s[1] as string), s[2] as string));
  });

  it("four leaves match a hand-built tree", () => {
    const s = [...leaves(4)].sort() as string[];
    expect(merkleRoot(leaves(4))).toBe(pair(pair(s[0]!, s[1]!), pair(s[2]!, s[3]!)));
  });

  it("is independent of input order", () => {
    const a = leaves(7);
    expect(merkleRoot([...a].reverse())).toBe(merkleRoot(a));
  });

  it("every leaf of trees of size 1..40 has a verifying proof, and no other leaf verifies with it", () => {
    for (let n = 1; n <= 40; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (const l of ls) {
        const p = merkleProof(ls, l);
        expect(verifyProof(root, l, p), `n=${n}`).toBe(true);
      }
      const p0 = merkleProof(ls, ls[0] as string);
      expect(verifyProof(root, leaf(1000), p0)).toBe(false);
    }
  });

  it("rejects tampered proofs and wrong roots", () => {
    const ls = leaves(9);
    const root = merkleRoot(ls);
    const p = merkleProof(ls, ls[3] as string);
    expect(verifyProof(root, ls[3] as string, p)).toBe(true);
    expect(verifyProof(root, ls[3] as string, p.slice(1))).toBe(false);
    expect(verifyProof(root, ls[3] as string, [...p.slice(0, -1), leaf(77)])).toBe(false);
    expect(verifyProof(merkleRoot(leaves(8)), ls[3] as string, p)).toBe(false);
    expect(verifyProof("nonsense", ls[3] as string, p)).toBe(false);
    expect(verifyProof(root, ls[3] as string, ["0x12"])).toBe(false);
  });

  it("accepts upper-case hex and normalizes", () => {
    const upper = leaf(0).replace(/[a-f]/g, (c) => c.toUpperCase()).replace("0X", "0x");
    expect(merkleRoot([upper, leaf(1)])).toBe(merkleRoot([leaf(0), leaf(1)]));
  });

  it("rejects duplicates, unknown leaves and non-bytes32 input", () => {
    expect(() => merkleRoot([leaf(0), leaf(0)])).toThrowError(expect.objectContaining({ code: "MERKLE" }));
    expect(() => merkleProof(leaves(3), leaf(9))).toThrowError(expect.objectContaining({ code: "MERKLE" }));
    expect(() => merkleRoot(["0x1234"])).toThrow(BeingsError);
  });

  it("ballotListRoot is the Merkle root of the ballot keys", () => {
    const codes = ["4F9Q7M2XHT8B", "B3N6D0YK5E1W", "0123456789AB"];
    expect(ballotListRoot(codes)).toBe(merkleRoot(codes.map(ballotKey)));
  });

  it("ballotPoolProof names the list a synthetic code belongs to and omits the code", () => {
    const created = ["AAAAAAAAAAAA", "BBBBBBBBBBBB"];
    const added = ["CCCCCCCCCCCC"];
    const inCreated = ballotPoolProof([created, added], "BBBBBBBBBBBB");
    const inAdded = ballotPoolProof([created, added], "CCCCCCCCCCCC");
    expect(inCreated).toEqual({ ballotKey: ballotKey("BBBBBBBBBBBB"), proof: merkleProof(created.map(ballotKey), ballotKey("BBBBBBBBBBBB")), rootIndex: 0 });
    expect(inAdded?.rootIndex).toBe(1);
    expect(verifyProof(ballotListRoot(added), inAdded!.ballotKey, inAdded!.proof)).toBe(true);
    expect(ballotPoolProof([created, added], "DDDDDDDDDDDD")).toBeNull();
    expect(JSON.stringify(inCreated)).not.toContain("BBBBBBBBBBBB");
  });
});
