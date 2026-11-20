import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildVectors } from "../scripts/vectors.js";
import { canonicalize, isValid, type BallotRecord } from "../src/index.js";
import { spec, vector } from "./helpers.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vectors");

describe("shared test vectors", () => {
  it("committed vector files are exactly what the code produces (run `npm run gen:vectors -w @beings/core` after intentional changes)", async () => {
    const built = await buildVectors();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(Object.keys(built).map((k) => `${k}.json`).sort());
    for (const [name, value] of Object.entries(built)) {
      // compare through JSON so that undefined fields and -0 behave as they do in the written file
      expect(JSON.parse(JSON.stringify(value)), name).toEqual(vector(name));
    }
  });

  it("generation is deterministic", async () => {
    expect(JSON.stringify(await buildVectors())).toBe(JSON.stringify(await buildVectors()));
  });

  it("pins externally known values", () => {
    const hashes = vector<{ utf8: string; sha256: string; keccak256: string }[]>("hashes");
    expect(hashes[1]).toMatchObject({ utf8: "abc", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", keccak256: "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45" });
    const eip = vector<{ wallets: { device1: { address: string }; reviewer: { address: string } } }>("eip712");
    // private key 1 and 3 are the well-known secp256k1 test keys
    expect(eip.wallets.device1.address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(eip.wallets.reviewer.address).toBe("0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69");
  });

  it("the layoutHash vector is the SHA-256 of the canonical layout (pinned independently with Python hashlib)", () => {
    const v = vector<{ canonical: string; layoutHash: string; sha256OfCanonical: string }>("layoutHash");
    expect(v.layoutHash).toBe(v.sha256OfCanonical);
    expect(v.layoutHash).toBe("a3b01e760685221aee7e21c6415d99e92cb76a5c12642c1f9f8d4b66405cd99e");
    const e = spec<{ layoutHash: string }>("election-example-with-layout");
    expect(e.layoutHash).toBe(v.layoutHash);
  });

  it("the vector record in records.json is schema-valid and its canonical form hashes as recorded", () => {
    const r = vector<{ record: BallotRecord; recordSha256: string }>("records");
    expect(isValid("ballotRecord", r.record)).toBe(true);
    expect(canonicalize(r.record)).toBe(canonicalize(JSON.parse(JSON.stringify(r.record))));
  });

  it("canonical vectors are self-consistent", () => {
    for (const c of vector<{ input: unknown; canonical: string }[]>("canonical")) expect(canonicalize(c.input)).toBe(c.canonical);
  });
});
