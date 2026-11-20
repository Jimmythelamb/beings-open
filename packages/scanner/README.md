# @beings/scanner (M3: Scanning)

**Status: prototype plus image-store helpers.** `prototype/` holds a desktop OMR that reads one scanned ballot (layout v3). The phone app
(PWA, opencv.js) is not written yet. `src/` holds TypeScript helpers for the temporary image store (upload a scan, verify a fetched image against the ledger).

## Purpose

Phone app that scans each ballot, reads the marks (OMR), signs a reading with the device key (EIP-712 `Reading`) and submits records to the ledger. Hashes and signatures come from `@beings/core`.

## Prototype (`prototype/`)

* `omr.py` (Python 3 + OpenCV + numpy): finds the four registration marks (TL is the largest), warps the page onto the
  layout frame (`ballot-layout.json`, 10 px per mm), decodes the machine-read QR (`BEINGS1|<election>|<ballotCode>|L<layout>`), checks
  the code is in `ballot-list.json`, measures every oval's fill and writes a debug image (green = marked, grey = empty,
  orange = unclear). The receipt QR is a different symbol (an https check-page link, election code only, below the tear
  line). `qr_select.py` ignores it. The layout crop of `qr.bbox` is tried first, so a receipt link on an untorn page
  cannot be read as the ballot.
* Fill score = percent of ink pixels inside the oval's sample ellipse (0.8 x the oval) minus the ink found in the baseline
  ring around it (1.25 to 1.6 x), integer 0-100. Ink = darker than half the paper level. Thresholds come from the election
  file's `resultRules` (empty < 15, marked > 50, otherwise unclear).
* `omr_finish.mjs`: derives the per-question results with `@beings/core` (`deriveResults`, spec 7.2), builds the results
  string (`encodeResults`), validates it (`entryProblems`, strict parse round-trip) and hashes the scanned image.
* On-chain submission of the result lives in `packages/ledger/scripts/scanned-ballot.js`.

```bash
python3 prototype/omr.py --image scan.png --layout ballot-layout.json --ballot-list ballot-list.json \
    --election election-file.json --out page.json --debug debug.png
node prototype/omr_finish.mjs page.json election-file.json scan-original.jpg result.json
```

Known limits: assumes the whole Letter page is in the picture with the marks at the corners, one ballot per image, no
rotation handling beyond failing when TL is not the largest mark, no glare or shadow correction (a black and white
100 dpi scan reads cleanly, a phone photo will need local thresholding), and the QR must decode with OpenCV's detector.

## Image store helpers (`src/`)

Uploads go to the Cloudflare R2 Worker at `https://beings-ballot-images.beingsvote-test.workers.dev` unless `--url` or `IMAGE_STORE_URL` is set. Image reads in `verify.ts` stay on `https://beingsvote.live`, which forwards to that Worker and can still read an unexpired Netlify Blob.

* `uploadScan(...)` / CLI `beings-scan-upload` (`npm run upload -w @beings/scanner -- --file scan.png --election <code> --ballot-code <code> --retention-days 14`):
  computes the SHA-256 (`@beings/core`), sends only the keccak of the ballot code, POSTs to `/api/images` with the bearer token
  from `SCANNER_UPLOAD_TOKEN` (environment only), and prints the `imageSha256` to put in the ballot record. `--hash-only` just hashes.
* `fetchAndVerifyImage(...)`, `fetchOnChainImageHash(...)`, `verifyImageBytes(...)`, `sha256HexWeb(...)` (browser-safe, WebCrypto):
  recompute the SHA-256 of a fetched image and compare it with the `imageSha256` read directly from BallotLedger on Coston2.

Tests: `npm test -w @beings/scanner` (includes an end-to-end test against the site's handlers).

## Depends on

`@beings/core` (M7) for hashing, canonical JSON, schemas, signing, Merkle and reconciliation. Do not re-implement those here (the Python prototype re-implements the 7.2 thresholds only for its debug banner; the string that goes on-chain is built by core).

## Suggested stack

See architecture doc section 5 (browser app, opencv.js).

## Where to read more

* Architecture: `docs/beings-architecture.md`, Section 5 (M3)
* Design spec: `docs/beings-design-spec.md`
* Interface contracts: section 12 (IC list)
