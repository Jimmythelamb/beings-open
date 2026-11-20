# @beings/scanner-helper (polling PC: print, scan, seal, read, upload)

Classroom version: paper + scanning only. Windows PC with a WIA scanner (USB, or network/Wi-Fi such as the Brother
DCP-L2640DW) and any installed printer. Nothing here signs, records on the ledger or holds a wallet key.

| Step | Tool | Output |
|---|---|---|
| Design | Dapp admin page → Create → "Design the ballot" (fills the layout fingerprint and sets the spare ballots), then Prepare → "Download printable ballots" + "Download the ballot layout" | `<code>-ballots.pdf` (secret), `<code>-ballot-layout.json` |
| Print | `windows\Print-BeingsBallots.ps1` | paper; `print-log.json` (PDF SHA-256, pages, printer) |
| Scan | `windows\Scan-BeingsBatch.ps1` | `BEINGS-Scans\<SHORT>\batch-YYYYMMDD-HHMMSS\` with `page-NN.png`, live `manifest.json`, `batch.log` |
| Seal | `node src\cli.mjs seal <batch>` (auto-run by the scan script with `-NodePath`) | `DONE.txt` (one DONE line) or `QUARANTINED.txt` |
| Interrupted? | `node src\cli.mjs supersede <batch> --reason "…"` | `SUPERSEDED.txt` |
| Read marks | `node src\cli.mjs read <batch> --election-file <secret> --layout <layout> --out readings.json` | unsigned readings for review (private) |
| Upload pictures | `windows\Upload-BeingsBatch.ps1` (or `node src\cli.mjs upload … --approve <batchId>`) | `POST /api/images` on the R2 Worker per page; `upload-receipt-*.json` |
| Status | `node src\cli.mjs status BEINGS-Scans\<SHORT>` | which batch is recordable |

The operator steps, in order, are in [docs/OPERATOR-CHECKLIST.md](docs/OPERATOR-CHECKLIST.md).

## INCIDENT-001 protocol, as built

* Expected sheet count is required before the feeder starts, and the operator types a hand count that must match.
* Every run writes a new `batch-<local time>` folder; it refuses to start while an earlier batch of the same election is
  neither sealed nor superseded.
* `manifest.json` is rewritten after each page (index, file, bytes, SHA-256, width, height, time). Ctrl+C, a jam, the
  scanner going offline or a short/long feed end as `INTERRUPTED` / `INCOMPLETE` with a red "do not record" banner.
  The scan script never writes `DONE`.
* `seal` writes exactly one `DONE beings-scan-batch/1 election=… batch=… pages=n manifestSha256=… decoded=yes|no sealedAt=…`
  line only when: saved = expected; every file exists, is non-empty and matches its SHA-256; sizes agree (declared page
  size mismatch is a warning); no stray page files; no duplicate image within the batch or in another live batch of the
  election. With `--election-file` + `--layout` it also requires every ballot code to decode, be distinct and be on the list.
* Recording gate (`read`, `upload`, bridge): refuses anything that is not `SEALED`; a manifest edited after sealing or a
  picture whose bytes changed makes the batch `QUARANTINED`; `SUPERSEDED` always wins. Messages name pages, never codes.
* `supersede` needs a reason, keeps the files, logs it, and needs `--force` for an already-sealed batch.

## Upload

`upload` is a dry run unless `--approve <exact batch id>` is given. It re-checks the seal, that the readings file was
made from this exact manifest, that each picture's bytes match the manifest and the reading, and that retention days
match the election file. Pages flagged for review are skipped unless `--include-flagged`. It then runs
`packages/scanner/src/cli.ts` (the existing `npm run upload -w @beings/scanner` code) once per page, so the request is
the agreed one: `Authorization: Bearer $SCANNER_UPLOAD_TOKEN`, `X-Election-Code`, `X-Image-Sha256`, `X-Ballot-Key`
(keccak of the code; the code itself is never sent), `X-Retention-Days`. The token is only read from the environment;
`Upload-BeingsBatch.ps1` asks for it at a hidden prompt and removes it afterwards. With no `--url` and no `IMAGE_STORE_URL`, the upload goes to `https://beings-ballot-images.beingsvote-test.workers.dev`. Either of those overrides the default. Tested against a mock server only.

## Local bridge (optional)

`node src\cli.mjs bridge --output-root "%USERPROFILE%\Documents\BEINGS-Scans"` – see [docs/BRIDGE-SECURITY.md](docs/BRIDGE-SECURITY.md).
The Create and Register pages can ask this helper (read-only) to find the connected scanner and printer.
Optional: `--station-address 0x…` (public address only) or `--station-file path.json` so the page can show the station wallet. The helper still never holds a key.
Find, confirm and the optional test print and scan never block creating an election or registering a station: ballots are accounted for by hash, so any printer and scanner can theoretically work. The test prints a clearly labelled synthetic page (fixed fake code, bundled under `fixtures/test-print-scan/`, never a real election file), may send it to the chosen printer or let the teacher print the PDF from the browser, scans it, and checks the reading and ballot fingerprint with the existing mark reader. Nothing is recorded or uploaded. Off Windows the helper uses the bundled stand-in picture and says so in the response; a real print and WIA scan were not run on the Linux build machine.
The site's Content-Security-Policy `connect-src` allows `http://127.0.0.1:8765` and `http://localhost:8765`. For a preview site, add `--allow-origin` for that page's address.
An iPad can read `GET /v1/station` only (version, sheet-fed scanner, printer). It does not scan or upload. The helper still binds to loopback; a private-network `Host` is accepted on that read-only status so a secure local proxy can forward it. See [docs/BRIDGE-SECURITY.md](docs/BRIDGE-SECURITY.md).

## Requirements on the polling PC

* Windows PowerShell 5.1 (built in). Scanner visible in Windows "Printers & scanners" (WIA driver).
* Node 20 or newer. Teachers do not need git, npm, or Node already on PATH. On Create and on Register, **Install printer/scanner helper** downloads `BEINGS-Scanner-Helper-Windows.zip` (this package, `windows/`, `fixtures/`, `docs/`, and production `node_modules/pdf-lib`). Unzip it and double-click `Install-BEINGS-Helper.cmd`. That copies the helper to `%LOCALAPPDATA%\BEINGS\scanner-helper`, uses a Node 20+ already on PATH or under `%LOCALAPPDATA%\Programs\node-*`, or downloads the official Node.js LTS Windows x64 zip from nodejs.org and checks its SHA256 against that version's `SHASUMS256.txt`. The usual install is **BEINGS-Scanner-Helper-Setup.exe** (NSIS, per user, no administrator password). It bundles a portable Node.js, installs over any older copy, starts the helper in the background with no console window, and starts it again at sign-in. The zip remains a fallback: unzip it and double-click `Install-BEINGS-Helper.cmd`. The bridge listens only on `127.0.0.1` and `::1`. The setup file is not code-signed yet. If SmartScreen appears, choose More info, then Run anyway. The zip does not contain `SCANNER_UPLOAD_TOKEN` or a private election file. Rebuild it with `npm run bundle:windows -w @beings/scanner-helper` (also the Netlify build). The published SHA256 is `apps/beingsvote-site/public/downloads/BEINGS-Scanner-Helper-Windows.sha256`.
* An existing checkout can still use Node 20+ (a Node install outside PATH works: pass `-NodePath`) and `npm ci` in the repo once.
* For reading marks: Python 3 with `opencv-python` and `numpy` (`py -m pip install opencv-python numpy`), or run `read`
  on another machine with the sealed batch folder.
* Printing uses Windows built-in printing (Windows.Data.Pdf and System.Drawing). SumatraPDF is not installed by this helper. If it is already on the PC and the built-in print fails, the helper may use it. The PrintTo verb is not used. Preview only opens a PDF and does not print.

## Tests

`npm test -w @beings/scanner-helper` (or `npx vitest run` in this folder): manifest/seal/supersede rules, the INCIDENT-001
replay, duplicate images across batches, PDF page counts, bridge request checks and a live loopback bridge with a fake
PowerShell, upload gating plus a real run of the scanner CLI against a mock store, and two end-to-end tests on synthetic
elections (render → mark → seal with decode → read → the site's own reading checks → mock upload). The end-to-end tests
skip when `python3`+OpenCV or `pdftoppm` is missing. The PowerShell scripts are syntax-checked and their pre-scan
refusals were run under PowerShell 7 on Linux; WIA scanning and printing were **not** run (no Windows/scanner here).
`test/windows-bundle.test.mjs` rebuilds the Windows zip and checks that it contains `src/cli.mjs` and `pdf-lib`, and that it
has no token or private key. `Install-BEINGS-Helper.ps1` is parsed with PowerShell on Linux. The installer was **not**
executed on Windows: no shortcut was created, and Node.js was not downloaded from nodejs.org, in this environment.
