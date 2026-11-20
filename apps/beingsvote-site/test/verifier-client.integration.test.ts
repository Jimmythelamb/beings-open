// End to end: the verifier package's client (packages/verifier) against this site's handler, with the mock blob store.
// Skipped on a standalone checkout of the site (the verifier package is not there).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { ballotKey, sha256Hex } from "../src/codes.js";
import { FixedWindowLimiter } from "../src/rateLimit.js";
import { handleVerifierImages } from "../src/verifierImages.js";
import { BALLOT, ELECTION, MockStore, NOW, PNG, testConfig } from "./helpers.js";

const clientPath = fileURLToPath(new URL("../../../packages/verifier/src/imageVerify.ts", import.meta.url));
const present = existsSync(clientPath);
const wallet = new Wallet("0x" + "33".repeat(32));

describe.skipIf(!present)("verifier client against the site handler (monorepo only)", () => {
  async function setup(tamper = false, signer: Wallet = wallet) {
    const lib = (await import(/* @vite-ignore */ clientPath)) as any; // untyped on purpose: this file must typecheck on a standalone checkout of the site
    const store = new MockStore();
    const imgs = [1, 2, 3].map((n) => new Uint8Array([...PNG, n]));
    for (const b of imgs) {
      await store.set(`${ELECTION}/${sha256Hex(b)}`, b, {
        metadata: { electionCode: ELECTION, ballotCodeHash: ballotKey(BALLOT), contentType: "image/png", size: b.byteLength, uploadedAt: NOW.toISOString(), deleteAfter: "2026-12-01T00:00:00.000Z" },
      });
    }
    if (tamper) store.map.get(`${ELECTION}/${sha256Hex(imgs[0]!)}`)!.data = new Uint8Array([...PNG, 9, 9]);
    const config = testConfig({ verifierAuthMode: "allowlist", verifierAddresses: [wallet.address.toLowerCase()] });
    const limiter = new FixedWindowLimiter(1000);
    const fetchImpl = (url: string, init: { method: string; headers: Record<string, string> }) =>
      handleVerifierImages(new Request(url, { method: init.method, headers: init.headers }), { store, config, now: () => NOW, limiter }) as never;
    const ledger = { records: 3, hashes: new Map(imgs.map((b) => [sha256Hex(b), 1] as const)), fromBlock: 1, toBlock: 2 };
    const client = new lib.StoreClient({ storeUrl: "https://beingsvote.test", election: ELECTION, signer, fetchImpl, now: () => NOW.getTime(), sleep: async () => {}, retries: 0 });
    return { lib, client, ledger, imgs };
  }

  it("signs, downloads, verifies all images and agrees with the ledger", async () => {
    const { lib, client, ledger } = await setup();
    const { report } = await lib.verifyImages({ election: ELECTION, signerAddress: wallet.address, store: client, ledger });
    expect(report.problems).toEqual([]);
    expect(report.verified).toHaveLength(3);
  });

  it("a corrupted blob is refused by the server (500) and shows up as a failed download, never as verified", async () => {
    const { lib, client, ledger } = await setup(true);
    const { report } = await lib.verifyImages({ election: ELECTION, signerAddress: wallet.address, store: client, ledger });
    expect(report.ok).toBe(false);
    expect(report.problems.map((p: { kind: string }) => p.kind)).toEqual(["download-failed"]);
    expect(report.verified).toHaveLength(2);
  });

  it("an unauthorized key is refused", async () => {
    const { lib, client, ledger } = await setup(false, new Wallet("0x" + "44".repeat(32)));
    await expect(lib.verifyImages({ election: ELECTION, signerAddress: "x", store: client, ledger })).rejects.toThrow(/403/);
  });
});
