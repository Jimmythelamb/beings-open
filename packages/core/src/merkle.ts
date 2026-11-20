import { BeingsError } from "./errors.js";
import { type Hex, concatBytes, hexToBytes, toBytes32 } from "./hex.js";
import { keccakHex } from "./hash.js";
import { ballotKey } from "./codes.js";

/**
 * Merkle trees (spec 9.7, 10.3): keccak256, OpenZeppelin-style SORTED-PAIR hashing,
 * i.e. parent = keccak256(min(a,b) || max(a,b)), so proofs carry no left/right flags and verify with
 * OpenZeppelin `MerkleProof.verify` in `Tally.verifyInclusion`.
 *
 * Choices the spec leaves open (resolved here, [PROPOSED] for the contract author to confirm):
 *  1. Leaves are SORTED ascending (byte order) before building, so the root does not depend on input order
 *     (the spec says the ledger must not leak scan order).
 *  2. Duplicate leaves are rejected (a ballot appears once).
 *  3. A level with an odd number of nodes PROMOTES the last node unchanged (no duplication, which avoids
 *     the CVE-2012-2459 style ambiguity). With sorted-pair hashing a promoted node simply has no sibling
 *     at that level, so its proof is shorter.
 *  4. The root of an empty list is the all-zero bytes32 (ZERO_ROOT).
 *  5. No extra leaf/node domain separation is added: a leaf is the keccak256 of a JCS JSON document
 *     (never 64 raw bytes), so it cannot be confused with an inner node unless a JSON preimage collides.
 */
export const ZERO_ROOT: Hex = `0x${"00".repeat(32)}`;

function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a < b ? [a, b] : [b, a]; // equal-length lower-case hex: string order == byte order
  return keccakHex(concatBytes(hexToBytes(lo), hexToBytes(hi)));
}

function prepare(leaves: readonly string[]): Hex[] {
  const norm = leaves.map(toBytes32);
  const sorted = [...norm].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new BeingsError("MERKLE", "duplicate leaf");
  }
  return sorted;
}

function buildLevels(sortedLeaves: Hex[]): Hex[][] {
  const levels: Hex[][] = [sortedLeaves];
  while ((levels[levels.length - 1] as Hex[]).length > 1) {
    const cur = levels[levels.length - 1] as Hex[];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i] as Hex;
      const b = cur[i + 1];
      next.push(b === undefined ? a : hashPair(a, b));
    }
    levels.push(next);
  }
  return levels;
}

/** Merkle root over bytes32 leaves (order-independent). */
export function merkleRoot(leaves: readonly string[]): Hex {
  const sorted = prepare(leaves);
  if (sorted.length === 0) return ZERO_ROOT;
  const levels = buildLevels(sorted);
  const top = levels[levels.length - 1] as Hex[];
  return top[0] as Hex;
}

/** Inclusion proof (sibling hashes, bottom to top) for `leaf`, which must be one of `leaves`. */
export function merkleProof(leaves: readonly string[], leaf: string): Hex[] {
  const sorted = prepare(leaves);
  const target = toBytes32(leaf);
  let idx = sorted.indexOf(target);
  if (idx < 0) throw new BeingsError("MERKLE", "leaf is not in the tree");
  const levels = buildLevels(sorted);
  const proof: Hex[] = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l] as Hex[];
    const sib = level[idx ^ 1];
    if (sib !== undefined) proof.push(sib);
    idx = idx >> 1;
  }
  return proof;
}

/** Verify an inclusion proof; same algorithm as OpenZeppelin `MerkleProof.verify`. Never throws on a bad proof. */
export function verifyProof(root: string, leaf: string, proof: readonly string[]): boolean {
  try {
    let h = toBytes32(leaf);
    for (const p of proof) h = hashPair(h, toBytes32(p));
    return h === toBytes32(root);
  } catch {
    return false;
  }
}

/** `ElectionRegistry.ballotListRoot`: Merkle root of the ballot keys keccak256(ballotCode) of the election file's codes. */
export function ballotListRoot(ballotCodes: readonly string[]): Hex {
  return merkleRoot(ballotCodes.map(ballotKey));
}

export interface BallotPoolProof {
  ballotKey: Hex;
  proof: Hex[];
  /** 0 is the creation list. Later indexes are lists added with `addBallots`. */
  rootIndex: number;
}

/**
 * Merkle proof that `code` is in one pool. `pools[0]` is the creation list; later pools are `addBallots` lists.
 * Returns null when the code is in none of them. The code itself is not part of the result.
 */
export function ballotPoolProof(pools: readonly (readonly string[])[], code: string): BallotPoolProof | null {
  const key = ballotKey(code);
  for (let rootIndex = 0; rootIndex < pools.length; rootIndex++) {
    const keys = (pools[rootIndex] ?? []).map(ballotKey);
    if (!keys.includes(key)) continue;
    return { ballotKey: key, proof: merkleProof(keys, key), rootIndex };
  }
  return null;
}
