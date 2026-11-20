# @beings/verifier: independent verification tools

## `beings-verify-images`: check the whole ballot-image set of an election

Downloads every ballot image of an election from the image store (`apps/beingsvote-site`, verifier-only bulk route),
and checks each one **against both the store's manifest and the Flare ledger**, so the store cannot vouch for itself.

```bash
npm install                      # at the monorepo root; npm run build -w @beings/core -w @beings/verifier
export VERIFIER_PRIVATE_KEY=0x...   # the verifier's wallet key. Environment only; never a flag, never printed or sent
npx beings-verify-images --election BEINGS-2026-XXXXXX --out ./verified-images
```

What it does:

0. With `--blind-reread` (and `--election-file`, `--layout`) the verified images are also masked and re-read afterwards, see below; the exit code is the larger of the two checks.
1. Signs the challenge `BEINGS-VERIFIER|<election>|<unix seconds>` (EIP-191 `personal_sign`, a **fresh signature for
   every request**) and sends it as `X-Verifier-Timestamp` / `X-Verifier-Signature`. The address derived from the key
   must be registered in the VerifierRegistry (the store's default `VERIFIER_AUTH_MODE=registry`; see below).
2. Reads the ledger's `BallotAccepted` events for the election (read-only RPC) and collects every `imageSha256`.
3. Fetches the manifest, then downloads every image (4 in parallel, retries on 429/5xx honouring `Retry-After`).
4. For each image checks: SHA-256 of the bytes = the manifest hash; size and content type = the manifest; the hash is
   on the ledger. Only images that pass every check are written to `--out` as `<sha256>.<png|jpg|pdf>`.
5. Writes `manifest.json` and `report.json` to `--out` and prints a summary.

Problems reported: `hash-mismatch`, `size-mismatch`, `content-type-mismatch`, `not-on-chain` (image in the store that
the ledger has no record of), `missing` (on the ledger but not in the manifest; the message says how many were omitted as
past retention, which is expected after `deleteAfter`), `download-failed` (404/410/other), `duplicate-in-manifest`,
`bad-manifest-entry`.

Exit code: `0` everything verified, `2` discrepancies found (see `report.json`), `1` could not run (bad key, store or RPC error).

| flag | default |
| --- | --- |
| `--election <code>` | required |
| `--out <dir>` | required |
| `--url` | `https://beingsvote.live` (forwards to the R2 Worker, and can still read an unexpired Netlify Blob) |
| `--rpc` | `https://coston2-api.flare.network/ext/C/rpc` |
| `--ledger` | BallotLedger on Coston2 `0xF579913c90b86f102Fff8D07c6c16f465495013C` |
| `--from-block` / `--to-block` | ledger deploy block `37317112` / latest |
| `--chunk` | `30` (the public Coston2 RPC allows at most 30 blocks per `eth_getLogs`; the scan shrinks automatically if a node allows fewer) |
| `--concurrency` | `4` |

Tip: pass `--from-block` close to the election's creation block to make the log scan quick (it is ~30 blocks per request on the public RPC).

## Two layers of verification

| layer | what it protects | who does it |
| --- | --- | --- |
| **1. Chain consensus** | the integrity of the **data array**: the results strings, hashes and tallies recorded on the Flare ledger cannot be altered after the fact, and every node agrees on them | the blockchain (and `beings-verify-images` for the image hashes) |
| **2. Blind re-read** | that the data **matches the paper**: an independent reader looks at the ballot image again and its answer must hash to the on-chain `resultsHash` | `beings-blind-reread` / `beings-verify-images --blind-reread` |

Consensus on the chain says nothing about whether the numbers written there are what voters marked on the paper; it only
says the numbers have not changed since. The blind re-read closes that gap without trusting the scanner: a verifier
masks each ballot image, reads the ovals again with a second, independent reader, and compares the result with the
on-chain record. The chain does not need to hold or judge the scanned image itself.

## `beings-blind-reread`: blind second reading of every ballot

```bash
npx beings-blind-reread --election BEINGS-2026-XXXXXX --images ./verified-images \
    --election-file election-file.json --layout ballot-layout.json --out ./blind-reread
# or, as part of the image check:
npx beings-verify-images --election BEINGS-2026-XXXXXX --out ./verified-images --blind-reread \
    --election-file election-file.json --layout ballot-layout.json      # writes <out>/blind/
```

1. **Mask.** The image is deskewed with the four corner marks (layout v3, the top-left one larger) into the same frame the
   scanner uses (10 px/mm). Then everything except the oval regions is painted black, using `ballot-layout.json`: the QR code,
   the ballot code text, headings, the examples panel, the registration marks, the receipt/tear-off and everything below
   `tearLineY`. Only the ovals are kept (and, with `--keep-ids`, the faint choice ids). The masker refuses to run if a kept
   region overlaps a forbidden one. The QR code is never decoded. The masked images and the manifest are keyed **only by
   `imageSha256`** (hash of the file bytes), so the reader cannot tell whose ballot it is.
   `layoutHash` of the layout must equal the one in the election file, otherwise it stops.
2. **Blind read.** A reader gets only the masked PNG plus public geometry and the election's rules, and returns oval fill
   scores. The verifier turns them into a results string with the core rules (`empty < 15 %`, `marked > 50 %`, in between
   is *unclear* and becomes `U`; an overvote is `O`, a blank `B`; `V:cX` or `V:cA+cB`, joined by `|` in election-file
   question order, ids ascending). The default reader is the OpenCV one (`python/blind_reread.py`, same scoring as the
   scanner's `omr.py`, run as a separate process).
3. **Compare.** The image is matched to its on-chain record by `imageSha256` (the `BallotAccepted` event, read-only RPC, or
   `--chain-records file.json` offline), and `keccak256(blind string)` is compared with the record's `resultsHash`.

| status | meaning | exit |
| --- | --- | --- |
| `match` | keccak256 of the blind reading equals the on-chain `resultsHash` | 0 |
| `mismatch` | the blind reading differs; both readings and the differing questions are listed | **2** |
| `unclear` | an oval is in the 15-50 % band (`U`) and every question that could be decided agrees with the chain: a human must look | 0 (2 with `--strict`) |
| `no-image` | the chain has a record whose image you did not supply | 0 (2 with `--strict`) |
| `not-on-chain` | an image whose hash no record carries | 0 (2 with `--strict`) |
| `unreadable` | the image could not be deskewed / read | 0 (2 with `--strict`) |

Exit `1` means it could not run. Output in `--out` (default `./blind-reread`): `masked/<sha256>.png`, `masked-manifest.json`,
`report.json` and `summary.txt` (also printed). The chain comparison is read-only: no key, no transaction.

| flag | |
| --- | --- |
| `--election <code>`, `--images <dir>` | required (`--images` only for `beings-blind-reread`) |
| `--election-file`, `--layout` | required: question order, result rules, geometry |
| `--reader opencv` (default) / `--reader-cmd "<command> [args]"` | the mark reader |
| `--keep-ids` | keep the faint choice ids visible in the masked image |
| `--strict` | exit 2 on any non-match, not only on a mismatch |
| `--python` / `BEINGS_PYTHON` | the Python used for masking and the OpenCV reader (default `python3`, needs `opencv-python` and `numpy`) |
| `--chain-records <file>` | offline `[{"imageSha256","results"}]` instead of the RPC |
| `--rpc`, `--ledger`, `--from-block`, `--to-block`, `--chunk` | as for `beings-verify-images` |

### Plugging in another reader (for example an AI vision model)

Implement `BlindReader` (`{ name, read(input) }`, exported from this package) or pass `--reader-cmd`. The command is run
without a shell, gets one JSON document on stdin (`maskedPngPath`, `frame`, `ovals`, `questions`, `resultRules`; never the
original image, its path or its hash) and prints one JSON line on stdout, either `{"fillScores": {"q1": {"c1": 100, "c2": 0}, ...}}`
or, for a reader that judges whole questions, `{"results": {"q1": "V:c1", "q2": "B", ...}}` (and optional `"notes"`). No API
key is needed by the verifier itself; any key a vision-model reader needs stays inside that command.

### Limits

* The default reader shares its scoring idea with the scanner's `omr.py`, so it is independent in process and in data (it
  sees only the masked image) but not in algorithm; use `--reader-cmd` with a different kind of reader for a truly different
  second opinion.
* Needs the four corner marks to be visible and layout v3; photos of folded or heavily cropped ballots are `unreadable`.
* A masked image can still be matched by someone who also has the original; the point is that the *reader* has no identifying data.

## Three-threshold consensus

`beings-consensus` re-reads fill scores that were **already computed**. It does not scan again, does not use a key, and does not send a transaction. The same scores are turned into a results string three times (tight 10/55, the election's own rules, loose 20/45, or the optional `consensusThresholds` on the election file). Each pass becomes a Merkle root. The leaves are `keccak256(key || keccak256(results string))`, sorted ascending before the usual sorted-pair tree. See spec section 7.2.1.

```bash
beings-consensus --scores scores.json --out ./consensus
beings-consensus --readings readings.json --election-file election-file.json --out ./consensus
```

`--scores` is one JSON document with `questions`, `resultRules`, optional `consensusThresholds`, and `ballots` (`fillScores` plus either `imageSha256` or `ballotCode`). A readings file from the scanner helper is the other input; the election file supplies the questions and the rules. A ballot code, if present, is hashed into the leaf key and **is not written**. When codes must stay private, pass only `imageSha256`. That tree is a different tree from one keyed by ballot hashes.

Exit `0` means the three roots match. Exit `2` means they do not: `report.json` lists the ballots, questions and ovals that moved, with the fill score and the three states, and each of those is flagged for a person to look at. Exit `1` means it could not run. The directory gets `report.json` and `summary.txt`.

`beings-blind-reread` runs the same check on the fill scores its reader just produced (no second read) and writes `consensus-report.json` and `consensus-summary.txt` next to the blind report. Those leaves are keyed by `imageSha256`, because the masked read never sees a ballot code. The blind exit code is unchanged.

The three roots are not recorded on-chain. Spec 7.2.1 describes how `ElectionNotes` could pin them later. No contract is changed here.

## Registering as a verifier

Verification is open to anyone. Register the address of `VERIFIER_PRIVATE_KEY` once in the VerifierRegistry on Coston2
(`0xdb6A83242139E3b7D47c31588d8d06c64CE94316`) by calling `register(string name, string infoCid)` from that address
(it costs a little C2FLR gas; calling it again only updates the name and info CID). For example with Foundry's `cast`:

```bash
cast send 0xdb6A83242139E3b7D47c31588d8d06c64CE94316 "register(string,string)" "my-verifier" "" \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --private-key "$VERIFIER_PRIVATE_KEY"
```

The store checks `nodes(address).registeredAt != 0` (cached 60 s), so the download works shortly after the transaction.

## Tests

`npm test -w @beings/verifier` (35 tests: signing, retries, hash/ledger checks, log scanning with chunking, plus the blind re-read: comparison rules, masking leak audit, a tampered record, unclear, a pluggable reader; the synthetic-scan tests are skipped when `python3` with OpenCV is not installed). The site's
test suite also runs this client against the real server handler end to end.

## Still to come

The signed-report verifier node and the voter lookup page described in `docs/beings-architecture.md` (M6) are not built yet.
It depends on `@beings/core` for hashing and keys.
