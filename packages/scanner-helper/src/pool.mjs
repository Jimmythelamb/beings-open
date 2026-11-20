// Merkle proofs for the ballot pool. Codes stay in the secret election file. A proof is only hashes.
// Same sorted-pair tree as @beings/core and ElectionRegistry. `keccak` is (Uint8Array) -> 0x + 64 hex.

function hexBytes(hex) {
  const s = String(hex).replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function merkleProof(leaves, leaf, keccak) {
  const sorted = [...leaves.map((item) => item.toLowerCase())].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error("duplicate leaf");
  let idx = sorted.indexOf(String(leaf).toLowerCase());
  if (idx < 0) throw new Error("leaf is not in the tree");
  const levels = [sorted];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = cur[i + 1];
      if (b === undefined) next.push(a);
      else {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        next.push(keccak(hexBytes(lo.slice(2) + hi.slice(2))).toLowerCase());
      }
    }
    levels.push(next);
  }
  const proof = [];
  for (let level = 0; level < levels.length - 1; level++) {
    const sib = levels[level][idx ^ 1];
    if (sib !== undefined) proof.push(sib);
    idx >>= 1;
  }
  return proof;
}

/** Code lists. Index 0 is the creation list. Later indexes are ballots added before opening. */
export function poolsOf(electionFile) {
  const pools = [Array.isArray(electionFile?.ballotCodes) ? electionFile.ballotCodes : []];
  if (Array.isArray(electionFile?.addedBallotPools)) {
    for (const pool of electionFile.addedBallotPools) {
      if (Array.isArray(pool?.codes)) pools.push(pool.codes);
    }
  }
  return pools;
}

/** { ballotKey, proof, rootIndex } or null. The code is not in the result. */
export function proofForCode(electionFile, code, keccak) {
  const key = keccak(new TextEncoder().encode(code)).toLowerCase();
  const pools = poolsOf(electionFile);
  for (let rootIndex = 0; rootIndex < pools.length; rootIndex++) {
    const leaves = pools[rootIndex].map((item) => keccak(new TextEncoder().encode(item)).toLowerCase());
    if (!leaves.includes(key)) continue;
    return { ballotKey: key, proof: merkleProof(leaves, key, keccak), rootIndex };
  }
  return null;
}
