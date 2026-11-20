// Delegated batch signing. Ephemeral keys and mocks only. No network and no real ballots.
import { Wallet, keccak256, verifyTypedData } from "ethers";
import { describe, expect, it } from "vitest";
import { COSTON2_ALLOWLIST, batchApprovalTypedData, createBatchSession, explainBatch, splitPrepaid, validateManifest } from "../public/js/delegated.js";
import { readingTypedData } from "../public/js/logic.js";

const SCANNER = new Wallet("0x" + "ab".repeat(32));
const ORGANIZER = new Wallet("0x" + "cd".repeat(32));
const CLIENT = "school-a";
const OTHER = "school-b";
const NOW = 1_800_000_000;
const KEY_A = "0x" + "11".repeat(32);
const KEY_B = "0x" + "22".repeat(32);
const HASH = "0x" + "33".repeat(32);
const SCORE = "0x" + "44".repeat(32);
const RECORD = "0x" + "55".repeat(32);

function item(id: string, ballotKey: string, resultsString: string) {
  return { itemId: id, ballotKey, resultsString, imageSha256: HASH, scoresHash: SCORE, recordSha256: RECORD };
}

function manifest(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    batchId: "batch-0001",
    clientId: CLIENT,
    electionCode: "BEINGS-2026-TEST01",
    chainId: 114,
    contracts: { registry: COSTON2_ALLOWLIST.registry, ledger: COSTON2_ALLOWLIST.ledger },
    scanner: SCANNER.address,
    expiresAt: NOW + 3600,
    gasCapWei: "1000000000000000000",
    contingencyBps: 2000,
    fiatMinorPerItem: 10,
    items: [item("one", KEY_A, "B"), item("two", KEY_B, "U")],
    ...over,
  };
}

function chain(over: Record<string, unknown> = {}) {
  return {
    chainId: 114,
    missing: false,
    status: 2,
    organizer: ORGANIZER.address,
    scannerRole: 1,
    recordedBallotKeys: [] as string[],
    fee: { gasPriceWei: "510000000000", maxFeePerGasWei: "1020000000000" },
    submitRecordGas: "212311",
    nextNonce: 7,
    ...over,
  };
}

function prepaid(amountMinor = 10_000, clientId = CLIENT) {
  return { accounts: { [clientId]: { currency: "USD", amountMinor } } };
}

const quote = { fiatMinorPerItem: 10 };
const keccak = (bytes: Uint8Array) => keccak256(bytes);

function opened(over: Record<string, unknown> = {}) {
  const result = createBatchSession({ manifest: manifest(over), now: () => NOW });
  if (!result.ok || !result.session) throw new Error(result.problems.join(" "));
  return result.session;
}

async function approve(session: { arm: (input: unknown) => Promise<{ ok: boolean }> }, man = manifest(), ch = chain()) {
  const typed = batchApprovalTypedData(man);
  const signature = await ORGANIZER.signTypedData(typed.domain, typed.types, typed.message);
  return session.arm({ signature, chain: ch, recover: verifyTypedData });
}

describe("delegated batch authorization", () => {
  it("requires a pool proof only when the election enforces the pool, and sends that proof", async () => {
    const proof = ["0x" + "66".repeat(32)];
    const pooled = manifest({ items: [item("one", KEY_A, "B")] });
    const session = createBatchSession({ manifest: pooled, now: () => NOW }).session!;
    await approve(session, pooled, chain({ poolEnforced: true }));
    expect(session.explain(chain({ poolEnforced: true }), prepaid(), quote).blockers.join(" ")).toMatch(/Merkle proof/);
    const withProof = manifest({ batchId: "batch-pool", items: [{ ...item("one", KEY_A, "B"), proof, rootIndex: 1 }] });
    const ready = createBatchSession({ manifest: withProof, now: () => NOW }).session!;
    await approve(ready, withProof, chain({ poolEnforced: true }));
    await ready.sign({ manifest: withProof, signer: SCANNER, chain: chain({ poolEnforced: true }), prepaid: prepaid(), quote, keccak });
    let sentProof: unknown = null;
    const result = await ready.sendNext({
      manifest: withProof,
      chain: chain({ poolEnforced: true }),
      prepaid: prepaid(),
      quote,
      sender: { send: async (tx: { args: unknown[] }) => { sentProof = tx.args[1]; return { status: "submitted", txHash: "0x" + "ab".repeat(32), method: "submitRecord" }; } },
    });
    expect(result.status).toBe("broadcast");
    expect(sentProof).toEqual(proof);
  });

  it("rejects ballot codes, secrets, the unapproved synthetic election, and the wrong chain", () => {
    const missingPrice = manifest();
    delete (missingPrice as { fiatMinorPerItem?: number }).fiatMinorPerItem;
    expect(validateManifest(missingPrice, NOW).problems.join(" ")).toMatch(/no customer price/i);
    expect(validateManifest({ ...manifest(), ballotCode: "222222222222" }, NOW).ok).toBe(false);
    expect(validateManifest(manifest({ electionCode: "BEINGS-2026-SGN001" }), NOW).problems.join(" ")).toMatch(/not approved/);
    expect(validateManifest(manifest({ chainId: 14 }), NOW).problems.join(" ")).toMatch(/Coston2/);
    expect(validateManifest(manifest({ contracts: { registry: COSTON2_ALLOWLIST.registry, ledger: "0x" + "12".repeat(20) } }), NOW).problems.join(" ")).toMatch(/ledger/);
    expect(validateManifest(manifest({ items: [item("one", KEY_A, "B"), item("two", KEY_A, "U")] }), NOW).problems.join(" ")).toMatch(/same ballot hash/);
    expect(splitPrepaid(10_000)).toEqual({ gas: 200, operations: 9800 });
  });

  it("states the DESK8Q scanner blocker and does not treat a faucet balance as prepaid", () => {
    const explained = explainBatch({
      manifest: manifest({ electionCode: "BEINGS-2026-DESK8Q" }),
      chain: chain({ scannerRole: 0 }),
      prepaid: null,
      quote: null,
      now: NOW,
    });
    expect(explained.paidAllowed).toBe(false);
    expect(explained.blockers.join(" ")).toMatch(/DESK8Q is already open/);
    expect(explained.cost.faucetIsNotPrepaid).toBe(true);
    expect(explained.summary.B).toBe(1);
    expect(explained.summary.U).toBe(1);
  });

  it("stays a dry run until explicitly armed, and a missing price or estimate stops the paid path", async () => {
    const session = opened();
    let calls = 0;
    const dry = await session.sign({ manifest: manifest(), signer: { address: SCANNER.address, signTypedData: async () => { calls += 1; return "0x"; } }, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(dry.status).toBe("dry-run");
    expect(calls).toBe(0);
    expect((await session.arm({ signature: "0x" + "11".repeat(65), chain: chain(), recover: () => { throw new Error("bad"); } })).message).toMatch(/not approval/);
    await approve(session);
    const unknown = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain({ submitRecordGas: null }), prepaid: prepaid(), quote, keccak });
    expect(unknown.message).toMatch(/cannot be estimated/i);
    const unpriced = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote: { fiatMinorPerItem: 99 }, keccak });
    expect(unpriced.ok).toBe(false);
    expect(unpriced.message).toMatch(/does not match the authorized batch/);
  });

  it("signs only with the authorized scanner and keeps the result string intact", async () => {
    const session = opened();
    await approve(session);
    const wrong = await session.sign({ manifest: manifest(), signer: ORGANIZER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(wrong.message).toMatch(/not the authorized scanner/);
    const signed = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(signed).toMatchObject({ ok: true, signed: 2 });
    const again = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(again.signed).toBe(0);
    const receipt = session.receipt();
    expect(JSON.stringify(receipt)).not.toMatch(/"ballotCode"|privateKey|mnemonic/i);
    expect(receipt.items.map((item) => item.resultsString)).toEqual(["B", "U"]);
  });

  it("stops when the batch payload changes and skips ballots already on the ledger", async () => {
    const session = opened();
    await approve(session);
    const changed = manifest();
    changed.items[0].resultsString = "V:c1";
    const stopped = await session.sign({ manifest: changed, signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(stopped.message).toMatch(/changed/);
    const secondManifest = manifest({ batchId: "batch-0002" });
    const second = opened({ batchId: "batch-0002" });
    await approve(second, secondManifest);
    let calls = 0;
    const result = await second.sign({
      manifest: manifest({ batchId: "batch-0002" }),
      signer: { address: SCANNER.address, signTypedData: async (...args: unknown[]) => { calls += 1; return SCANNER.signTypedData(args[0] as never, args[1] as never, args[2] as never); } },
      chain: chain({ recordedResults: { [KEY_A]: "B" } }),
      prepaid: prepaid(),
      quote,
      keccak,
    });
    expect(result.signed).toBe(1);
    expect(calls).toBe(1);
    expect(second.receipt().items.find((item) => item.itemId === "one")?.phase).toBe("skipped");
    const conflict = explainBatch({
      manifest: manifest({ batchId: "batch-conflict" }),
      chain: chain({ recordedResults: { [KEY_A]: "V:c1" } }),
      prepaid: prepaid(),
      quote,
      now: NOW,
    });
    expect(conflict.blockers.join(" ")).toMatch(/will not be replaced/);
    expect(conflict.paidAllowed).toBe(false);
  });

  it("reserves gas, reconciles an ambiguous send before retrying, and does not resend a recorded ballot", async () => {
    const one = manifest({ batchId: "batch-send", items: [item("one", KEY_A, "B")] });
    const session = createBatchSession({ manifest: one, now: () => NOW }).session!;
    await approve(session, one);
    await session.sign({ manifest: one, signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    const calls: { nonce: number; method: string; results: string }[] = [];
    const ambiguous = await session.sendNext({
      manifest: one,
      chain: chain(),
      prepaid: prepaid(),
      quote,
      sender: { send: async () => { throw new Error("socket hang up"); } },
    });
    expect(ambiguous.status).toBe("ambiguous");
    const blocked = await session.sendNext({ manifest: one, chain: chain(), prepaid: prepaid(), quote, sender: { send: async () => ({ status: "submitted", txHash: "0xabc" }) } });
    expect(blocked.status).toBe("ambiguous");
    expect(blocked.message).toMatch(/must be checked/);
    expect(session.reconcile("one", null).status).toBe("signed");
    const sent = await session.sendNext({
      manifest: one,
      chain: chain(),
      prepaid: prepaid(),
      quote,
      sender: { send: async (tx: { nonce: number; method: string; args: { results: string }[][] }) => {
        calls.push({ nonce: tx.nonce, method: tx.method, results: tx.args[0][2] as unknown as string });
        const typed = readingTypedData({
          electionKey: tx.args[0][0],
          ballotKey: tx.args[0][1],
          resultsHash: keccak(new TextEncoder().encode(String(tx.args[0][2]))),
          imageSha256: HASH,
          scoresHash: SCORE,
          verifyingContract: COSTON2_ALLOWLIST.ledger,
        });
        const recovered = verifyTypedData(typed.domain, typed.types, typed.message, tx.args[0][5][0][3]);
        expect(recovered).toBe(SCANNER.address);
        expect(tx.method).toBe("submitRecord");
        expect(tx.args[0][2]).toBe("B");
        return { status: "submitted", txHash: "0x" + "ab".repeat(32) };
      } },
    });
    expect(sent.status).toBe("broadcast");
    expect(calls[0].nonce).toBe(7);
    expect(session.reconcile("one", { mined: true, success: true, txHash: "0x" + "ab".repeat(32), actualWei: "1000" }).status).toBe("recorded");
    const receipt = session.receipt();
    expect(receipt.items.find((item) => item.itemId === "one")).toMatchObject({ phase: "recorded", actualWei: "1000" });
    expect(receipt.budget.spentWei).toBe("1000");
    expect(receipt.budget.reservedWei).toBe("0");
  });

  it("does not run two sends at once, stops cleanly, and bounds retries", async () => {
    const session = opened();
    await approve(session);
    await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    let release: (value: { status: string }) => void = () => {};
    const first = session.sendNext({
      manifest: manifest(),
      chain: chain(),
      prepaid: prepaid(),
      quote,
      sender: { send: () => new Promise((resolve) => { release = resolve; }) },
    });
    const second = await session.sendNext({ manifest: manifest(), chain: chain(), prepaid: prepaid(), quote, sender: { send: async () => ({ status: "submitted", txHash: "0x1" }) } });
    expect(second.status).toBe("busy");
    release({ status: "rejected" });
    await first;
    expect(session.pause().status).toBe("paused");
    const paused = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(paused.message).toMatch(/paused/);
    expect(session.resume().status).toBe("armed");
    expect(session.revoke().status).toBe("revoked");
    const after = await session.sign({ manifest: manifest(), signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    expect(after.message).toMatch(/broadcast cannot be undone/);
    const limitManifest = manifest({ batchId: "batch-limit", items: [item("one", KEY_A, "B")] });
    const limited = createBatchSession({ manifest: limitManifest, now: () => NOW }).session!;
    await approve(limited, limitManifest);
    await limited.sign({ manifest: limitManifest, signer: SCANNER, chain: chain(), prepaid: prepaid(), quote, keccak });
    for (let i = 0; i < 3; i += 1) {
      const rejected = await limited.sendNext({ manifest: limitManifest, chain: chain(), prepaid: prepaid(), quote, sender: { send: async () => ({ status: "rejected" }) } });
      expect(rejected.ok).toBe(false);
    }
    const fourth = await limited.sendNext({ manifest: limitManifest, chain: chain(), prepaid: prepaid(), quote, sender: { send: async () => ({ status: "submitted", txHash: "0xno" }) } });
    expect(fourth.message).toMatch(/retry limit/);
  });

  it("keeps the 2% gas reserve and 98% operations share per client", () => {
    const session = opened();
    expect(session.noteOperations(OTHER, "storage", 1).message).toMatch(/different client/);
    expect(session.noteOperations(CLIENT, "storage", 1).message).toMatch(/No prepaid/);
    session.bindPrepaid(prepaid());
    expect(session.noteOperations(CLIENT, "storage", 9800).ok).toBe(true);
    expect(session.noteOperations(CLIENT, "storage", 1).message).toMatch(/98%/);
    const tight = explainBatch({ manifest: manifest(), chain: chain(), prepaid: prepaid(100), quote: { fiatMinorPerItem: 50 }, now: NOW });
    expect(tight.blockers.join(" ")).toMatch(/2%/);
  });
});
