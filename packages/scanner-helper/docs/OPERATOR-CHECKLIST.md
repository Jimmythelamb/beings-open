# Polling-PC operator checklist (classroom: paper + scanning)

One page. Follow it in order. It implements INCIDENT-001 (interrupted scan, QB1TTH, 9 Nov 2026).
Nothing in these steps signs, records on the ledger or needs a crypto wallet. Recording is a separate, approved step.

## Before printing
1. Have the **secret full election file** (`…-SECRET-full-file.json`) and the ballot PDF in a private folder on this PC.
2. Note the number of ballots to print (the election's "Ballots printed", for example 7).

## Print
3. `windows\Print-BeingsBallots.ps1 -ListPrinters` and pick the printer (USB or network/Wi-Fi).
4. `windows\Print-BeingsBallots.ps1 -PdfPath <ballots.pdf> -PrinterName "<name>" -ExpectedPages <n> -NodePath "C:\Program Files\nodejs\node.exe"`
   * It refuses if the PDF's pages differ from `<n>`. Use **actual size**, single-sided.
5. Count the sheets that came out. They must equal `<n>`. Keep spoiled sheets; don't throw them away.

## Scan (after voting)
6. Count the marked ballots **by hand**. Write the number down.
7. `windows\Scan-BeingsBatch.ps1 -ListDevices` and note the scanner name.
8. `windows\Scan-BeingsBatch.ps1 -ElectionCode <code> -ExpectedPages <hand count> -DeviceName "<name>" -NodePath "C:\Program Files\nodejs\node.exe"`
   * Type the hand count when asked. If it differs, the script stops.
   * It refuses to start while an earlier batch for this election is neither sealed nor superseded.
   * Each run makes a **new** folder `BEINGS-Scans\<SHORT>\batch-YYYYMMDD-HHMMSS`. Never copy files into it by hand.
9. Watch the result:
   * **Green "Captured n of n"** then **"SEALED. DONE …"**: good. Go to step 11.
   * **Red "INCOMPLETE – DO NOT RECORD THIS BATCH"** (jam, Ctrl+C, feeder ran out early, extra sheets): go to step 10.

## If a scan is interrupted or wrong
10. Do not record anything from it. Do not delete it. Mark it superseded, then re-feed the **whole** stack:
    `node src\cli.mjs supersede "<batch folder>" --reason "jam on sheet 7, re-fed full stack" --replaced-by <new batch id>`
    then repeat step 8. (Appending one page to a broken batch is not allowed.)

## Seal (if the scan step did not do it)
11. `node src\cli.mjs seal "<batch folder>"` writes the single `DONE` line **only if**: pages saved = pages expected,
    every file exists, is non-empty and matches its SHA-256, page sizes agree, and no image is also in another live batch.
    Stronger (recommended): add `--election-file <secret file> --layout <ballot-layout.json>` so every ballot code is also
    decoded, distinct and on the list before `DONE`.
12. `node src\cli.mjs status "BEINGS-Scans\<SHORT>"` – exactly one batch should be `SEALED  RECORDABLE`; others `SUPERSEDED`.

## Read the marks (for review, unsigned)
13. `node src\cli.mjs read "<batch folder>" --election-file <secret file> --layout <ballot-layout.json> --out <private>\readings.json`
    * Refuses any batch that is not SEALED, or whose pictures changed since sealing.
    * Lists pages that need a human look (unclear marks, close to a threshold, unreadable code). Blank (B), overvote (O)
      and unclear (U) are kept exactly as read.
    * The readings file holds ballot codes: keep it private. Nothing is signed.

## Upload the pictures (explicit step, after review)
14. Dry run: `node src\cli.mjs upload "<batch folder>" --readings <readings.json>` – shows exactly which pages and hashes.
15. Send: `windows\Upload-BeingsBatch.ps1 -BatchDir "<batch folder>" -Readings <readings.json> -NodePath "C:\Program Files\nodejs\node.exe"`
    shows the plan, asks you to type the batch id to approve, then asks for `SCANNER_UPLOAD_TOKEN` at a hidden prompt (paste
    it from the password app; never in chat, never as a flag). Pictures go to the Cloudflare image Worker unless you pass `-Url` or set `IMAGE_STORE_URL`. Flagged pages are skipped unless `-IncludeFlagged`.
16. The script removes the token from its environment when it finishes. The receipt (`upload-receipt-*.json`) is in the batch folder.

## Recording on the ledger
17. Only from the SEALED batch's readings, only the exact batch the organizer approved. Never from a SUPERSEDED folder.
