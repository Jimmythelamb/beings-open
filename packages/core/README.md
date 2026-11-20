# @beings/core (M7): shared core library

One tested implementation of the rules every B.E.I.N.G.S. module must agree on (architecture doc section 9, IC12).
Pure functions only: no network, no storage, no logging, no UI. Fail closed: bad input **throws**, never "repairs".

```ts
import {
  canonicalize, sha256Hex, keccakHex,          // RFC 8785 JCS; SHA-256 (hex, no 0x); keccak-256 (0x-hex)
  newBallotCode, ballotKey, electionKey,       // Crockford base-32 codes, keys = keccak256(code)
  merkleRoot, merkleProof, verifyProof,        // keccak, sorted-pair (OpenZeppelin-compatible)
  validate, isValid,                           // JSON Schema 2020-12 for all six spec schemas
  parseResult, deriveResults,                  // V:c1+c2 / B / O / U
  signReading, verifyReading, signReport,      // EIP-712 (ethers v6)
  tallyQuestions, reconcile, buildTallyFile,   // tally, R1..R6 bit mask, tally file
} from "@beings/core";
```

## Modules

| File | What |
|---|---|
| `canonical.ts` | `canonicalize` (RFC 8785): rejects NaN, Infinity, undefined, functions, lone surrogates |
| `hash.ts`, `hex.ts` | `sha256Hex`, `keccakHex`, `sha256Json`, `keccakJson`, bytes32 helpers |
| `codes.ts` | `newBallotCode(s)` (CSPRNG, 12 chars, no I L O U), `normalizeBallotCode`, `newElectionCode`, `ballotKey`, `electionKey` |
| `merkle.ts` | `merkleRoot`, `merkleProof`, `verifyProof`, `ballotListRoot` |
| `validate.ts` | `validate(name, json)` (throws `SchemaValidationError`), `isValid`, `schemaIssues`, `parseAndValidate`, `electionFileProblems`, `correctionProblems` |
| `results.ts` | `parseResult`, `formatResult`, `bubbleState`, `deriveResults`, `encodeResults`, `resultsHash` |
| `tally.ts` | `applyCorrections`, `tallyQuestions`, `entryLeaf`, `merkleRootOfEntries` |
| `reconcile.ts` | `reconcile` (R1 to R6 bit mask 1,2,4,8,16,32), `buildTallyFile`, `failedRules`, `checksFromMask` |
| `eip712.ts` | `Reading`, `Review`, `VerifierReport` typed data; sign, recover, verify; `checkRecordSignatures` |
| `record.ts` | `recordSha256`, `ledgerEntryFromRecord` |

## Schemas

`schemas/*.schema.json` are copied from design spec section 11 (election-file, ballot-record,
ledger-entry, correction, tally, verifier-report). The one addition to the spec's election-file schema is the optional
`layoutHash` (64 lower-case hex = SHA-256 of the canonical ballot layout JSON, see `layoutHash(layout)` in `hash.ts`):
optional so older election files still validate, always written by the ballot generator, and covered by the election
file hash that goes on-chain. `electionFileProblems(file, { requireLayoutHash: true })` demands it. The spec (11.1) was updated to match. `src/schemas.generated.ts` is generated from them by
`npm run gen:schemas`; do not edit it by hand. `schemaVersion` mismatch is a hard error.

ajv runs in strict mode except `strictRequired: false`: the spec's tally schema lists `required` keys inside a
sub-object without redeclaring them at that level, which strict mode rejects. The schemas themselves are unchanged apart from `layoutHash` above.

## Test vectors

`test-vectors/*.json` are generated deterministically by `npm run gen:vectors` (script: `scripts/vectors.ts`) and
checked by `test/vectors.test.ts`. A Python port, the contracts and every other implementation must reproduce them.
They are signed with **test-only private keys (0x00..01 to 0x00..04). Never use these keys for anything real.**
`test-vectors/spec-examples/` holds the spec's own example documents.

## [PROPOSED] items implemented here

Marked in code comments too. These fill gaps the spec leaves open; the contract author must confirm them:

* EIP-712 domain `{name: "B.E.I.N.G.S.", version: "1", chainId: 114, verifyingContract?}`
* `Review(electionKey, ballotKey, resultsHash)` and `VerifierReport(electionKey, tallyVersion, reportHash)` typed data
* `resultsHash = keccak256(results string)`, results joined with `|`, in election-file question order
* `scoresHash = keccak256(JCS(fillScores))`; reading `imageSha256` = `0x` + SHA-256 hex
* Merkle leaf = `keccak256(JCS(ledger entry with corrections applied))`; sorted leaves; odd node promoted; empty root `0x00..00`; duplicate leaves rejected
* `ballotListRoot` = Merkle root of ballot **keys** (not raw codes, so publishing the root reveals nothing)
* Correction chain index: 1-based posting order, `prevIndex` 0 = original
* Election-file semantic checks beyond the schema (`electionFileProblems`)
* Strict result strings: choice ids strictly ascending, no duplicates

## Commands

```bash
npm run build       # tsc -> dist/
npm run typecheck
npm test            # vitest
npm run gen:vectors # regenerate test-vectors/
npm run gen:schemas # regenerate src/schemas.generated.ts
```
