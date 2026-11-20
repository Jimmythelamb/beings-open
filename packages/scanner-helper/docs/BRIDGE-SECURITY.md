# Local scanner bridge: security notes

`node src/cli.mjs bridge --output-root "%USERPROFILE%\Documents\BEINGS-Scans"` starts a small HTTP service so the Dapp, open
in a browser **on the same PC**, can find the connected scanner and printer (and an optional public station wallet address), start a scan batch, read batch manifests and ask for a seal.
It is optional. Everything it does can be done from the command line.

| Control | What it does |
|---|---|
| Binds `127.0.0.1` and `::1` only | Not reachable from the network or Wi-Fi. `localhost` can resolve to `::1`, so both are open and nothing else is. |
| Host header check | `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` for every route. Read-only status also accepts a private-network address (RFC1918 or link-local) or a `*.local` name, on that same port. A public host is still rejected. This stops DNS-rebinding pages. |
| Origin allowlist | Default `https://beingsvote.live`, `http://localhost:8888`, `http://127.0.0.1:8888`. Others get 403 and no CORS headers. Change with `--allow-origin` (repeatable). |
| POST needs `Origin` and `application/json` | Forces a CORS preflight, so a page can't fire a "simple" form POST at it. |
| Private Network Access | Preflight answers `Access-Control-Allow-Private-Network: true` only for allowed origins (Chrome asks before a public site talks to localhost). |
| No tokens, no secrets | It never sees `SCANNER_UPLOAD_TOKEN`, a wallet key or the election file. It cannot upload or sign. |
| Output is metadata only (ordinary endpoints) | Batch id, state, page count, SHA-256 and sizes. Never images, file paths outside the scans folder, or ballot codes. |
| Fixed command | Starts only `windows\Scan-BeingsBatch.ps1` (and, for printer listing or the optional test print, `windows\Print-BeingsBallots.ps1`) with validated arguments (`shell: false`, election code regex, 1–1000 pages, dpi from a list, page size from a list). The test print always uses the bundled synthetic PDF, never a path from the page. It starts PowerShell with -STA and prints by drawing the PDF itself (no PDF app). After Print(), it reads the Windows print queue and reports an error, a job still waiting, or a job that left the queue. If that queue reports an error, the helper tries the next real queue (up to three). GET /v1/test/last-page.png serves the picture from the latest test scan. GET /v1/log returns the tail of the helper log with secrets removed. One scan at a time. Listing is read-only. |
| Hand count | `operatorCountConfirmed: true` is required; the Dapp must ask the operator to count the paper first. |
| Body limit | 16 KB. |

Residual risks: any program already running on the PC as the same user can call it (it could do the same with the
scripts directly). A malicious page on an allowed origin could start a scan, which only creates a new batch folder
that cannot be recorded until sealed and reviewed. Stop the bridge (Ctrl+C) when not scanning.

Endpoints: `GET /v1/health`, `GET /v1/scanners`, `GET /v1/printers`, `GET /v1/station` (read-only: scanners, printers, optional public station wallet, never a key),
`POST /v1/scan`, `GET /v1/scan`, `GET /v1/elections/<code>/batches[/<batchId>]`, `POST /v1/elections/<code>/batches/<batchId>/seal`.
Optional test print and scan (local only, nothing is uploaded or recorded): `GET /v1/test`, `POST /v1/test/prepare`, `GET /v1/test/page.pdf`, `POST /v1/test/print`, `POST /v1/test/scan-and-read`.
`GET` or `POST /v1/diagnostics` returns a fixed checklist (helper, Node, pdf-lib, Windows built-in printing, printers, scanners, whether the printer address answers, the scan folder, a read of the R2 Worker image store at `https://beings-ballot-images.beingsvote-test.workers.dev` that does not upload, and leftover synthetic test batches). `IMAGE_STORE_URL` overrides that read the same way it overrides an upload. The page's own address is not the image store. `POST /v1/diagnostics/fix` accepts only `supersede-synthetic-test` or `signin-start`. It cannot name a folder, a program, or a URL. Remembering which scanner to use is stored in the browser, not on the helper.
These test endpoints may return the bundled synthetic test page (PDF) and its fixed fake ballot code, which is clearly labelled "SYNTHETIC TEST PAGE — NOT A REAL BALLOT" and is never taken from a real or private election file. A scan-and-read result does not echo an unexpected recovered code (so a real ballot scanned by mistake is not displayed). Temporary test-scan files are deleted afterwards. Off Windows, or when started with mock allowed, scan-and-read can use the bundled stand-in picture instead of a real scanner; the response says so.
The Dapp's Create and Register pages call the read-only find endpoints (`/v1/station`, falling back to `/v1/health` + `/v1/scanners` + `/v1/printers` on an older helper) and, if the teacher starts the optional test, the `/v1/test/*` endpoints. They do not start a live election scan from that UI. Find, confirm and the test are optional: creating or registering is never blocked.
The optional public station wallet is set with `--station-address 0x…` or `--station-file` (JSON with `address` and optional `label` only). A file that looks like it contains a private key or mnemonic is refused and not loaded.
A preview site (for example a Netlify deploy preview) is not in the default origin list. Start the helper with `--allow-origin https://THAT-PREVIEW` (this replaces the default list, so also pass `--allow-origin https://beingsvote.live` if you still want the live site).
The site's Content-Security-Policy `connect-src` allows `http://127.0.0.1:8765`, `http://[::1]:8765`, and `http://localhost:8765`.

### Read-only status from an iPad or iPhone

The admin page can ask a scanner station for status from an iPad. That call is only `GET /v1/station` (the same read-only payload as the find step: helper version, scanners, printers, optional public station wallet). It does not call `POST /v1/scan`, `/v1/test/scan-and-read`, or any upload.

The helper still listens on `127.0.0.1` and `::1` only, so an iPad cannot open a connection to it directly. Reaching the station from another device needs secure local access: a TLS proxy on the scanner computer that forwards to the loopback helper. The proxy should pass the browser's `Origin` and `OPTIONS` preflight through. `GET /v1/health`, `GET /v1/station`, and `GET /v1/diagnostics` (and their preflight) accept a private-network or `.local` `Host` header so the proxy can keep the name the iPad used. `POST`, scan, seal, test print, and test scan still require a loopback `Host`.

CORS for those responses already allows `https://beingsvote.live` (and the local dev origins). A different page address still needs `--allow-origin`. The response includes `Access-Control-Allow-Private-Network: true` on the preflight.

An HTTPS page will not call a station that is plain HTTP (mixed content). The page says that the station needs secure local access, instead of a generic failure. The site CSP is unchanged and still lists only the loopback helper, so a LAN address is blocked by the page until that access is an address the page is allowed to call.
