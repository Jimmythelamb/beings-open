# @beings/ledger (M4): contracts

Solidity contracts for the consensus layer, built with **Hardhat 2**, targeting the **Flare Coston2** test network
(chain ID 114, RPC `https://coston2-api.flare.network/ext/C/rpc`). Solc 0.8.24, optimizer 200 runs, EVM `london`.

**Status: implemented, tested locally, and deployed to Coston2 (test network) on 2026-11-01 with `evmVersion: london`. Not audited.**

| Contract | Coston2 address |
|---|---|
| BallotLedger | [`0xF579913c90b86f102Fff8D07c6c16f465495013C`](https://coston2-explorer.flare.network/address/0xF579913c90b86f102Fff8D07c6c16f465495013C) |
| ElectionRegistry | [`0x651A078e51B69Eff17e22950573EbE0252f43E63`](https://coston2-explorer.flare.network/address/0x651A078e51B69Eff17e22950573EbE0252f43E63) |
| Tally | [`0x9844040a1B4BEC18a384d68F29cE2bd5D24cB4f4`](https://coston2-explorer.flare.network/address/0x9844040a1B4BEC18a384d68F29cE2bd5D24cB4f4) |
| VerifierRegistry | [`0xdb6A83242139E3b7D47c31588d8d06c64CE94316`](https://coston2-explorer.flare.network/address/0xdb6A83242139E3b7D47c31588d8d06c64CE94316) |

Addresses, deployment tx hashes and fees are in `deployments/coston2.json`; the smoke test (create, register device, open, submit, close, tally) is in `deployments/coston2-smoke.json`. Real gas and C2FLR cost per step: [GAS.md](GAS.md). These are test contracts, deployed by a throw-away test key: do not treat them as an election authority.
The spec itself calls its contract code "a sketch for discussion, not compiled, optimised or audited".

| Contract | Spec | Purpose |
|---|---|---|
| `ElectionRegistry` | 10.1 | election entry (code format checked), versions, device and reviewer roles, status machine Setup, Open, Closed, Tallied |
| `BallotLedger` | 10.2 | one record per ballot with quorum of EIP-712 `Reading` signatures (or one `Review` signature), batches, corrections, spoil marks |
| `Tally` | 10.3 | Merkle root, per-question counts, on-chain reconciliation R1 to R6 as a bit mask, Final or Provisional, review clearance, amended tallies, inclusion proofs |
| `VerifierRegistry` | 10.4 | optional verifier node hook: direct reports, and signed reports (`VerificationNotice`, **[PROPOSED]**) |

Libraries: `libraries/ReconcileLib.sol` (R1 to R6), `libraries/ResultString.sol` (results-string segments).
`test-helpers/ReconcileHarness.sol` is for tests only and is never deployed. OpenZeppelin is pinned to **5.4.0**
(5.5.0 and later use `mcopy`, which the `london` target does not have).

## Use

```bash
npm install                                    # from the repo root
npm run build -w @beings/ledger                # compile
npm test -w @beings/ledger                     # builds @beings/core first (pretest), then runs all Hardhat tests
npm run gas -w @beings/ledger                  # gas per function on the local network -> GAS.md, gas-report.json
npm run deploy:local -w @beings/ledger         # dry run on the in-process network (writes deployments/hardhat.json)
npm run smoke:local -w @beings/ledger          # end-to-end smoke test on the in-process network
```

### Deploying to Coston2

```bash
cp packages/ledger/.env.example packages/ledger/.env   # set DEPLOYER_PRIVATE_KEY (a funded Coston2 TEST key only)
npm run deploy:coston2 -w @beings/ledger
```

* The key is read **only** from the environment (`.env` is git-ignored; `.env.example` has no key). It is never printed or written.
* The script refuses to send anything when there is no key, the chain ID is not 114, or the account has no balance.
* Deployment order is fixed (BallotLedger, ElectionRegistry, Tally, VerifierRegistry, then `setLedger`, `setTally`).
  With a fresh account it gives the `verifyingContract` addresses used in the core EIP-712 test vectors, so the committed
  vector signatures verify on-chain. With another deployer or nonce the addresses differ, and signatures must be made for the real addresses.
* Writes `deployments/<network>.json` (addresses and block only; the Coston2 file was then extended by hand with the deploy tx hashes and fees). Re-running the deploy overwrites that file, so keep a copy.
* `npm run smoke:coston2 -w @beings/ledger` **sends real test-network transactions** against the addresses in `deployments/coston2.json` (about 0.5 C2FLR) and writes `deployments/coston2-smoke.json`. Each run uses a fresh random election code.

## Tests

* `ElectionRegistry`, `BallotLedger`, `Tally`, `VerifierRegistry`: every function and every custom error.
* `vectors.test.js`: **Merkle** proofs and roots, the 8 **reconciliation** cases (`failedChecks` mask), and results-string splitting from `packages/core/test-vectors/`, through Solidity.
* `BallotLedger.test.js`: the committed **EIP-712** `Reading` and `Review` signatures and digests verify on-chain, and on-chain domain separator and type hashes equal core.
* `Tally.test.js`: replays the full core `tally` vector on-chain (5 ballots, 2 corrections, 1 spoiled) and checks the effective-results Merkle leaves, the root, the counts, mask 0 and Final, and every inclusion proof.
* `VerifierRegistry.test.js`: includes the committed `VerificationNotice` signature.
* `deploy.test.js`: the deploy script on the in-process network, and its guards (never touches Coston2).

Gas numbers: [GAS.md](GAS.md).

## Must agree with `@beings/core`

* EIP-712 domain `{name: "B.E.I.N.G.S.", version: "1", chainId: 114, verifyingContract}` **[PROPOSED]**
* `Reading(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash,bytes32 imageSha256,bytes32 scoresHash)` (spec), `Review(bytes32 electionKey,bytes32 ballotKey,bytes32 resultsHash)` **[PROPOSED]**, `VerificationNotice(...)` **[PROPOSED]** (`VerifierReport` in core signs a report-file hash and is not used on-chain)
* `electionKey = keccak256(bytes(electionCode))`, `ballotKey = keccak256(bytes(ballotCode))`, `resultsHash = keccak256(bytes(results))`
* Merkle: keccak256, sorted pairs (OpenZeppelin `MerkleProof`), empty root `0x00..00`. The leaves are core's `entryLeaf` over the effective (corrected) results.
* Reconciliation bits: R1=1, R2=2, R3=4, R4=8, R5=16, R6=32.
* Corrections are 1-based in `head`/`corrections` (`prevIndex` 0 = the original record). Reasons: None, FaintMark, Erasure, StrayMark, GlareOrAlignment, PhoneMisread, Other.

## Decisions on spec gaps (all **[PROPOSED]**, to confirm with the contract author)

* `postCorrection` takes `electionKey` (the spec's struct has none) and stamps `at` with `block.timestamp`. `by` must equal `msg.sender`. Corrections are allowed from Open to Tallied; `questionIndex` is the 0-based position in the results string.
* A submission reverts unless **every** reading is valid and either quorum is met or a reviewer signature is present. Batches are all-or-nothing.
* The Merkle root and per-question counts are supplied by the organizer and are **not** verified on-chain (the chain stores them and runs R1 to R6 on the counts). Anyone can recompute them from the public ledger.
* `Tally.postTally` reads cast, spoiled and printed from the ledger and registry; the organizer supplies registered, issued and unused-returned.
* Final if all checks pass, otherwise Provisional with `ReviewRequired`; a reviewer clears the **latest** version with a clearance CID. An amended tally does not require corrections.
* The organizer may close an Open election at any time; anyone may close it once `closesAt` + `CLOSE_GRACE` (1 day) has passed.
* `markSpoiled` is organizer or reviewer, while Open or Closed, for unrecorded ballots only.
* A device or reviewer address can hold only one role per election. Election codes are checked for the `BEINGS-YYYY-XXXXXX` format (Crockford base-32 suffix).
* The VerifierRegistry keeps only the latest report per node; signed reports need a per-node sequential nonce (replay protection), because a `VerifierReport` signature over a file hash cannot bind the on-chain arguments.

## TODO

* **evmVersion: settled for now.** `london` deployed and ran the whole smoke test on Coston2, so it stays. `cancun` was not tried; only switch (and upgrade OpenZeppelin past 5.4.0) after a separate test deployment.
* Contracts are not verified on the Coston2 explorer yet (source verification needs the explorer's verifier, not done).
* Exercise the remaining paths on Coston2 (corrections, Provisional tally and `clearReview`, amended tally, VerifierRegistry). Done on Coston2 with `npm run election200:coston2` (200 ballots, 3 questions, single and batch submits, 3 spoiled, Final tally, independent re-read; results in `deployments/coston2-election200.json`). Corrections, a Provisional tally with `clearReview`, an amended tally and the VerifierRegistry are still not exercised on Coston2.
* Security audit. Fuzz and invariant tests. Gas optimisation (see GAS.md).
* Ballot-list proof on submit (spec open item); today `ballotListed` is a view only.
* Confirm the **[PROPOSED]** items above (Review, VerificationNotice, correction conventions, CLOSE_GRACE, strict revert when readings disagree).

## Staff roster (deployed on Coston2)

`contracts/StaffRegistry.sol` records each election's staff roster beside the live ElectionRegistry. It does not replace that registry, and it does not change BallotLedger, Tally, or VerifierRegistry. The live BallotLedger stores the registry address forever, and that registry has already used its one-time `setLedger`, so a new registry would no longer be the one the ballot pool checks. New elections stay on the current registry. This contract reads the organizer and the status from it.

The administrator chooses the election type once, when their wallet is recorded. It cannot be changed:

* **Standard** can later be certified. Every primary position needs its own wallet, no line may be covered by the administrator, and at least two Election officers (the paper-ballot handlers) must be recorded, each a different wallet. Each approval carries the legal-adult sentence. At close-out the System admin must sign that the roles and wallets were set up correctly and that each position's duties were verified complete. Without that signature the roster is not certification-ready.
* **Test** is always a test. The administrator may record other adults, or cover positions after signing "This election was used and identified as a test election." It is never certification-ready. One officer is enough. The System admin sign-off is optional. If it is recorded, it is disclosed.
* **Classroom** is one administrator covering the other primary positions. The label is "Classroom election (single administrator), not certified." It is never certification-ready. There is no separate System admin wallet, so the sign-off stays unsigned and that fact is disclosed.

Names stay off the chain. The stored name hash is `keccak256(abi.encode(salt, normalizedName))`. The salt is 32 random bytes generated in the browser for that staff entry. It stays in the confidential Executive staff record and on the administrator's computer (the local roster or the confidential download). It is not a contract argument, it is not in the EIP-712 typed data (so a transaction does not reveal it), and it is not in the public download. The chain stores that salted hash, the wallets, the positions, and the keccak256 of the public roster file. Staff sign EIP-712 claims for free. The administrator signs the approvals and the lock attestation, and pays the gas. After the lock, a change is an amendment that emits the old wallet, the new wallet, and the time.

`recordSystemSignOff` is the close-out step. The System admin signs EIP-712 `SystemSignOff(bytes32 electionId,bytes32 rosterHash,bytes32 dutiesHash,bytes32 positionSetHash,string statement)`. `dutiesHash` is `keccak256(abi.encode(positionIds, sheetHashes))` and `positionSetHash` is `keccak256(abi.encode(positionIds))`. The sheet hash is the keccak256 of that position's duty and close-out sheet. The organizer or the System admin wallet pays the gas. Voting must already be closed. A later roster change makes the sign-off stale until it is signed again.

`recordCustody` is the hook for paper handling. An Election officer co-signs each print run (`action` 1) and each scan batch (`action` 2) together with the Scanner operator, and signs alone when the paper is stored (`action` 3). The screens that ask for those signatures during printing and scanning are not in this change.

Ballot recording still goes through the existing BallotLedger. When at least one Scanner operator wallet is on the roster, the site refuses a ballot from any other wallet. The ledger itself is unchanged, so pool proofs and old elections keep working. Elections that never call `recordElectionAdmin` are left alone.

Deploy (do not run until the owner approves the fee): `scripts/deploy-staff.js`. It reads `deployments/coston2-pool.json` and refuses to continue unless that file's ElectionRegistry is `0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A`. It refuses a Coston2 send without `STAFF_DEPLOY_MAX_FEE_WEI`. `STAFF_DEPLOY_DRY_RUN=1` estimates gas and does not broadcast. A dry run on 17 Nov 2026, using the live ElectionRegistry in `deployments/coston2-pool.json` and not broadcasting, estimated 4,751,654 gas. The accepted deploy is recorded in `deployments/coston2-staff.json`, and `staffRegistry` in `apps/beingsvote-site/public/js/config.js` is that address. The four live contract addresses are unchanged. Coston2 gas price moves, so the owner should estimate again on that day and add 30% before setting the cap. Recording the administrator, a batch of staff, the lock, a custody note, and the System admin sign-off are extra transactions on top of deployment, each paid by the administrator's wallet (the System admin may also pay for their own sign-off).

## ElectionNotes (proposed, not deployed)

`contracts/ElectionNotes.sol` is an append-only, admin-free contract for officials' notes and long-term record
fingerprints about a **Tallied** election. The organizer, or a Device / Reviewer registered in `ElectionRegistry`,
can call `postNote(electionKey, tallyVersion, noteSha256, cid)` or `postNoteWithName(…, displayName)` (≤ 64 bytes,
public and permanent). The role is read from the registry at posting time and stored with the note. The same hash
can't be posted twice for an election. It never touches the other four contracts. Tests: `test/ElectionNotes.test.js`;
gas: `scripts/notes-gas.js`; deploy (needs a separately approved fee cap on Coston2): `scripts/deploy-notes.js`.
The off-chain note format (`beings-election-note/1`, EIP-712) and record manifest (`beings-election-record/1`) are in
`apps/beingsvote-site/public/js/record.js`.
