# beingsvote-site: the temporary ballot-image store for B.E.I.N.G.S.

A small, **standalone Netlify site** that holds the redacted ballot images for the retention period only, and shows
each voter *their own* image. It will be served at **beingsvote.live**. It has its own `netlify.toml`, its own
`package.json`, its own Netlify site and its own environment variables. It shares nothing with any other site, and
no other site is referred to anywhere in this folder.

Images are linked to the permanent record **by hash only**. The Flare ledger (Coston2 for now) keeps the results and
the SHA-256 of each image forever; this site keeps the image itself only until `deleteAfter`.

```
apps/beingsvote-site/
  netlify.toml                      build/functions settings and security headers (site-local)
  netlify/functions/images.mts      /api/images   POST = scanner upload, GET = voter fetch
  netlify/functions/verifier-images.mts  /api/verifier/images[/<sha256>]   signed, verifier-only bulk read
  netlify/functions/cleanup-images.mts   daily scheduled cleanup
  src/                              all logic, with the store and the chain injected so it is unit tested
  public/index.html                 the web app shell (header, role bar, wallet dialog)
  public/css/app.css                design system: light/dark, cards, bars, forms, accessible focus states
  public/js/app.js                  hash router, nav, theme toggle, wallet dialog, role-gated routes
  public/js/home.js results.js voter.js   the public pages (home, public results, voter lookup)
  public/js/staff.js verifier.js officer.js admin.js system.js   the staff role screens (shared pieces, then one file per role)
  public/js/logic.js                pure, unit-tested helpers for the staff screens (reconciliation, flags, report format, ZIP, election-file drafting)
  public/js/tx.js                   confirmation card + dry run + explorer link for every wallet transaction or signature
  public/js/chain.js roles.js format.js explain.js abi.js config.js ui.js   chain access, role detection, ledger-line translation, plain-language copy, DOM helpers
  public/vendor/ethers.umd.min.js   ethers v6.17.0 fallback if the CDN copy fails its SRI check
  public/vendor/appkit.js           Reown AppKit 2 (the connect modal). Loaded only when someone connects a wallet
  public/vendor/walletconnect.js    WalletConnect ethereum-provider for the separate staff-link session, plus a QR encoder
  public/js/appkit-connect.js       chain lock, featured wallets, error text and the ethers provider wrapper (no network)
  public/js/appkit-client.js        opens the AppKit modal or the Bifrost link and keeps the EIP-1193 provider
  tools/appkit-vendor/              how public/vendor/appkit.js is built (esbuild, pinned versions). Not part of the Netlify build
  tools/walletconnect-vendor/       how public/vendor/walletconnect.js is built. Not part of the Netlify build
  public/data/                      bundled public election files (ballot codes stripped) for elections whose file is not published
  dev/server.ts                     local server (npm run serve) for the site + the real /api/images and /api/verifier/images handlers
  test/                             vitest unit tests (mocked blob store, fake RPC)
  .env.example                      the environment variables
```

The scanner-side upload helper/CLI and the in-browser verify helper live in `packages/scanner` (see the end).

## The web app (`public/`)

A static, friendly single-page app. **No build step**: plain ES modules, hash routes, deployed as-is by Netlify
(`publish = "public"`). Written for people who have heard of blockchain but don't know how it works: plain words,
short explanations, a light and a dark theme, large touch targets, a skip link, keyboard-friendly controls, live
regions for loading states, and text/icon cues as well as colour (WCAG AA contrast, checked for both themes).

| Route | What it is |
| --- | --- |
| `#/` | Home: what this is and three clear actions. Public comments sit above the footer |
| `#/results`, `#/results/<code>` | **Public results**, read live from Coston2: status, per-question bar charts, overvote / blank / unclear counts, balance check, six live checks and a "How this is verified" explainer |
| `#/check?election=<code>` | **Voter lookup**: enter the receipt ballot code. Shows the ledger entry in plain words (`V:c1`, `V:c1+c3`, `B` blank, `O` overvote, `U` unclear), the ballot scan (with a browser-side SHA-256 check against the hash on the ledger), corrections, and a "Report a problem" form |
| `#/how` | How it works, no jargon. The same public comments block as Home |
| `#/staff` | Role hub: shows which staff roles the connected wallet has and links to the four screens |
| `#/verifier` | **Verifier**: registration status (and a "Register as a verifier" button), sign-in and bulk download of ballot images with a SHA-256 check of each against the ledger, a browsable ledger table, an independent recount compared with the on-chain Tally, the Merkle-root check (needs the full election file), flags, and a signed report |
| `#/officer` | **Election officer**: polling-station reconciliation (registered, printed, handed out, cast, spoiled, unused), review of the published tally, spoiled-ballot register, scanner status and guidance, read-only ledger feed |
| `#/admin` | **Election Administrator**: create an election (builds the file and ballot codes in the browser), register scanning phones and reviewers, open and close voting, publish or amend the tally, announce image retirement |
| `#/contact` | **Contact**: name, email and a message (1,000 characters). Posted to the private Netlify form `contact` for `CONFIG.reportEmail`. Not published, and not stored with public comments. If the host refuses the form, the page offers a mailto link |
| `#/moderate` | **Comment review**: approve, reject or delete public comments. The moderation token is sent to the Worker and checked there (`COMMENT_ADMIN_TOKEN`). It is not a wallet action and it is not stored in the browser |
| `#/system` | **System admin**: contract addresses and wiring checks, network health (RPC, block age), image-service health, the verifier registry list, site settings. Links to comment review. Read-only, plus the close-out sign-off |

**Roles.** Everybody gets Public + Voter with no sign-in, and every staff screen can be *read* without a wallet. Staff
can connect a browser wallet (EIP-1193). Connecting only shares the address. A signature or a transaction is requested
only when someone presses a specific action button, and each one first shows a plain-language confirmation card
(what changes, which contract, which address); transactions are dry-run against the live ledger first so a refusal is
explained in words. Wrong network: the app offers to switch to Coston2. Roles come from the on-chain registries: system
admin = `ElectionRegistry.deployer()`; Election Administrator = organizer of a known election; election officer = Reviewer role
in a known election; verifier = registered in `VerifierRegistry`.

| Screen | Wallet actions (live) | Read-only |
| --- | --- | --- |
| Verifier | `VerifierRegistry.register`; signs the image-download note (EIP-191, free); signs the report (EIP-712, free) | recount, comparisons, flags, image check |
| Officer | `Tally.clearReview` (Reviewer), `BallotLedger.markSpoiled` (organizer or Reviewer) | station reconciliation (handed-out and unused figures are typed in and kept in this browser only), ledger feed |
| Admin | `ElectionRegistry` `createElection`, `registerDevice`, `registerReviewer`, `openElection`, `closeElection`, `noticeImagesRetired`; `Tally` `postTally` / `postAmendedTally` | the election overview |
| System admin | close-out EIP-712 sign-off that the roster's roles and wallets were set up and each position's duties were verified (`StaffRegistry.recordSystemSignOff`) | network, contracts, services, elections |

**Signed verifier report.** `VerifierReport(bytes32 electionKey, uint32 tallyVersion, bytes32 reportHash)` under the
EIP-712 domain `{ name: "B.E.I.N.G.S.", version: "1", chainId: 114 }`; `reportHash` is the SHA-256 of the RFC 8785
canonical JSON of the report body. Anything not checked is written as `not checked`, never as a pass. Flags only describe
what was found; nothing here can change a record.

**Where the numbers come from.** Contract addresses and the RPC are in `public/js/config.js` (Coston2, chain 114). `staffRegistry` is the StaffRegistry deployed on Coston2 (`packages/ledger/deployments/coston2-staff.json`). The four live contract addresses are not switched for this roster work.
The Tally contract only stores totals, so per-choice counts are *recounted in the browser* from the `BallotAccepted` and
`CorrectionPosted` events and compared with the official totals (a mismatch is shown, never hidden). The Coston2 RPC
limits `eth_getLogs` to 30 blocks, so event history is read from the Flare Coston2 Blockscout API
(`CONFIG.explorerApi`). The election file is fingerprinted (SHA-256 of the RFC 8785 canonical JSON) and compared with the
on-chain hash. If the election's file isn't published (the test election uses `local-unpublished:`), the page uses the
bundled public copy in `public/data/elections/` and marks the check "unverifiable".

**Wallets (Reown AppKit).** Connect opens Reown AppKit, WalletConnect's prebuilt modal. On a computer the WalletConnect
QR code is showing as soon as the modal opens; Bifrost and MetaMask sit beside it, and All wallets (with search) is the
button under that list. On a phone or iPad the same button opens Bifrost directly (`bifrostwallet://wc?uri=`). An
injected wallet, including MetaMask's browser, connects without the QR. The network is Flare Coston2 (chain 114, C2FLR).
A wallet on another network is asked to switch. The header chip shows an avatar, the short address, the C2FLR balance,
copy and disconnect. A failed connection shows the wallet's own reason and a note about `relay.walletconnect.org` and
`relay.walletconnect.com`. There is no fixed timeout.

AppKit's EIP-1193 provider is wrapped in an ethers v6 `BrowserProvider` (`getSigner` in `roles.js`), so organizer
transactions, scanner batches, roster EIP-712 signatures, the verifier and the tally keep using the same signer.
Linking a *different* staff wallet still uses a second WalletConnect session (`staff-link.js`, `/vendor/walletconnect.js`)
so the administrator's session stays connected. Reads never go through the phone: they use the Coston2 RPC.
The modal is loaded on demand from `/vendor/appkit.js` (no CDN). The choice is remembered in `localStorage["beings.wallet"]`
(`browser` or `walletconnect`), and a phone session is restored on the next visit if it is still alive. Disconnect ends
the session on the phone too.

*Project ID.* `walletConnectProjectId` in `public/js/config.js` is the public Reown project id already used by this site
(`8a7a9fdb10da4f8b27e2dac859b49529`). It is not a secret. In <https://dashboard.reown.com> open that project (or create
a free AppKit project and paste its id into `config.js`) and, under **Domain** / allowlist, add `beingsvote.live` with
no `https://` and no path. Add `localhost` to try it on a computer. Each Netlify deploy preview has its own host
(`deploy-preview-<number>--<site>.netlify.app`); add that host too or the preview's QR is rejected. AppKit's
`metadata.url` is the page's own origin, which is what the allowlist is checked against. Reown Verify only treats the
domain in that metadata as the verified domain, so a preview can connect once allowlisted and still show as unverified
in the wallet. To rebuild the modal (only when upgrading): `cd tools/appkit-vendor && npm ci && npm run build`, then
commit `public/vendor/appkit.js`. The staff-link bundle is separate: `cd tools/walletconnect-vendor && npm ci && npm run build`.

**Security.** All page text is set with `textContent`; there is no `innerHTML`. `netlify.toml` sets a strict CSP (no inline
script or style, `connect-src` limited to this site, the Coston2 RPC and explorer, IPFS, the WalletConnect relay
`relay.walletconnect.com` and `relay.walletconnect.org`, Reown's `api.web3modal.org` / `api.web3modal.com` and
`explorer-api.walletconnect.com`, and the optional local scanner helper at http://127.0.0.1:8765 and http://localhost:8765).
`frame-src` allows the verify pages and `secure.walletconnect.com` / `secure.walletconnect.org` (WalletConnect uses them
to show whether this site is the one it claims to be) and `https://challenges.cloudflare.com` for the comment spam check.
ethers is loaded from
jsDelivr with an SRI hash and falls back to `public/vendor/`. The ballot code is only sent in the `X-Ballot-Code`
header, never in a URL; the problem report uses the ballot's public key hash, not the code.

**Contact and comments.** The contact form is a Netlify Form named `contact`. Submissions stay in the Netlify dashboard
and, once an email notification is set, go to `CONFIG.reportEmail`. They are not listed on the site. Public comments
appear only on Home and How it works. They are stored in a Cloudflare D1 database on the image Worker, start as
pending, and are shown only after approval. `turnstileSiteKey` in `config.js` is the public site key; leave it empty
and the comment box stays on the page but sending is turned off. The Worker secret and the D1 database are not created
by deploying this site. See `worker/DEPLOYMENT.md`.

**Known limits.** "Report a problem" has no backend yet: it produces a text report to copy or download (set
`CONFIG.reportEmail` to also offer an email link). Role detection covers elections the site knows about (bundled list +
the registry's events via the explorer). Per-choice counts need the explorer API to be reachable. The small-election
privacy threshold (`minBreakdownSize`, 10) is noted on the page for the 5-ballot test election, but the data is shown.

## How it works

### Storage

New images are stored in the private Cloudflare R2 bucket `beings-ballot-images`, behind the Worker
`https://beings-ballot-images.beingsvote-test.workers.dev`. The pages and the scanner helper call that origin.
`/api/images` and `/api/verifier/images` on this site forward there, so a client that still posts to beingsvote.live
does not write a new object into Netlify Blobs. No Netlify environment variable is required for that forward:
an unset `R2_IMAGE_SERVICE_URL` uses the Worker origin. A bad value returns 503 and does not write to Blobs.

Pictures already stored in Netlify Blobs (`ballot-images`, site-wide, strongly consistent) stay readable until their
own `deleteAfter`. A Worker 404 on GET is tried against Blobs, and a verifier manifest from the Worker is combined
with any still-unexpired Blob. That path does not write. The daily Netlify cleanup still deletes expired Blobs.
The Worker cron (`30 3 * * *` UTC) deletes expired R2 objects.

The key and metadata are the same in both stores. Key = `<electionCode>/<sha256hex of the image bytes>`, the same
`imageSha256` that goes into the on-chain ballot record. Metadata on every object:

| field | meaning |
| --- | --- |
| `electionCode` | `BEINGS-YYYY-XXXXXX` |
| `ballotCodeHash` | `keccak256(ballotCode)`, i.e. the on-chain `ballotKey`. **The raw ballot code is never sent to or stored by this site on upload.** |
| `contentType` | `image/png`, `image/jpeg` or `application/pdf` |
| `size` | bytes |
| `uploadedAt` | ISO time of the first upload |
| `deleteAfter` | ISO time after which the image is deleted |
| `publicImages` | `1` when the election's Public ballot images setting is on (optional; used if the public election file cannot be loaded) |

### Upload: `POST /api/images` (scanner only)

Headers: `Authorization: Bearer <SCANNER_UPLOAD_TOKEN>`, `Content-Type`, `X-Election-Code`, `X-Image-Sha256`,
`X-Ballot-Key` (the keccak of the ballot code), `X-Retention-Days`, and optionally `X-Public-Images: true` when the
election file has `publicBallotImages: true`. Body: the raw image bytes.

* The bearer token is compared in constant time (both sides are hashed, then `timingSafeEqual`). If
  `SCANNER_UPLOAD_TOKEN` is missing or shorter than 24 characters, **every upload is refused (503)**: it fails closed.
  Authentication is checked before anything else is read.
* The server **recomputes the SHA-256 of the body** and rejects the upload (422) if it is not the claimed hash.
* Size limit (`MAX_IMAGE_BYTES`, default 5,000,000; Netlify functions accept at most 6 MB per request) checked from
  the header and again while reading. Content-type allowlist: png, jpeg, pdf, and the first bytes must really be that type.
* `deleteAfter` = now + `X-Retention-Days`. When Public ballot images is off, days are a whole number from 1 to
  `MAX_RETENTION_DAYS` (default 365). When it is on (the scanner header or the public election file), days must be
  **30 to 60** (the Create form defaults to 30). The days come from the election's `imageRetention.days`.
* **Idempotent:** the same image for the same ballot uploaded again returns 200 `exists` and never creates a second
  blob. A repeat can **extend** retention (for example while a review is open) but never shorten it. The same
  image hash claimed for a different ballot is refused (409).

### Voter fetch: `GET /api/images?election=<code>` with header `X-Ballot-Code: <ballot code>`

**Authorization is a chain lookup** (not the fallback):

1. The ballot code is normalized (Crockford rules, dashes and case ignored) and turned into the on-chain keys exactly
   as `@beings/core` does: `electionKey = keccak256(electionCode)`, `ballotKey = keccak256(ballotCode)`.
2. The function makes a read-only `eth_call` to **BallotLedger** `records(electionKey, ballotKey)` on Coston2
   (`https://coston2-api.flare.network/ext/C/rpc`). It tries the current ledger
   (`0x5d00bE9A32DcF1FcDe9475C8Be874aE8af0fCf0b`) and, when that ballot is not recorded there, the earlier ledger
   (`0xF579913c90b86f102Fff8D07c6c16f465495013C`). `RPC_URL` and `LEDGER_ADDRESS` override the current endpoint and
   ledger; `LEGACY_LEDGER_ADDRESSES` overrides the earlier list. No wallet, no key, no transaction.
3. If `acceptedAt` is 0 (ballot not recorded) the answer is 404. Otherwise the record's `imageSha256` is the only
   thing that decides which blob is served: `<electionCode>/<imageSha256>`.
4. The blob's `ballotCodeHash` must equal this ballot's key, it must not be past `deleteAfter` (410 if it is, even
   before the daily cleanup has run), and the bytes are re-hashed and must equal the on-chain hash (else 500).
5. The image is returned with `Cache-Control: private, no-store, max-age=0`, `X-Content-Type-Options: nosniff`,
   `Content-Security-Policy: default-src 'none'; sandbox`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`
   and `X-Image-Sha256`.

There is **no listing endpoint** and no search. A request with a ballot code still uses only the on-chain record for
that code (a hash in the query is ignored). If the RPC is down the answer is 502 and nothing is served.

### Public fetch (optional): `GET /api/images?election=<code>` with header `X-Image-Sha256: <64 hex>`

This path exists only when the election file sets `publicBallotImages: true` (default **off**). Anyone who already has
the **election code and that one picture's fingerprint** can fetch that single image, without signing in and without a
ballot code. The fingerprint is public on the ledger, but it is hard to guess. There is still **no list** of pictures.

The setting is stored in the election file (it is in the public copy and is part of the file fingerprint `fileSha256`
on the ledger). No contract change. The image service reads the public copy from `ELECTION_FILES_BASE` (or, if that is
unset, same-origin `/data/elections/<code>.json`). If that file cannot be loaded, a blob marked `publicImages` at
upload may still be served; if the file says the setting is off, the path is refused (403).

The server loads `<electionCode>/<sha256>`, checks expiry, re-hashes the bytes, and confirms
`BallotLedger.records(electionKey, ballotCodeHash)` names this same image hash. Past retention the answer is **410**
with `{ error: "Image expired" }`. The page shows **Image expired**. Fingerprints and readings stay on the chain.
Unauthenticated hash lookups are rate-limited (`PUBLIC_IMAGE_RATE_PER_MINUTE`, default 60 per client per instance,
plus the platform limit).

`?image=` or `?imageHash=` is accepted if a header cannot be set; prefer the header.

When the setting is off, behaviour is unchanged: this path is refused, and only a ballot code or a signed
organizer/verifier request can load a picture.

The ballot code goes in the **`X-Ballot-Code` header** so that it stays out of URLs and the usual request logs. A
`?ballotCode=` query parameter is accepted as a fallback for clients that cannot set headers, but then the code may
appear in access logs; prefer the header.

CORS: none by default (same-origin only). Set `ALLOWED_ORIGINS` (comma-separated) to allow other pages, such as a
verifier web page, to call the API from a browser.

### Cleanup: scheduled function, daily at 03:30 UTC

`cleanup-images` lists the store and deletes every blob whose `deleteAfter` has passed. A blob whose `deleteAfter`
is missing or unreadable is **not** deleted blindly; it is counted in the log ("needing attention") for a human.
The log shows counts only. Netlify runs scheduled functions only on the **published production deploy**.

### Verifier bulk access: `GET /api/verifier/images` (verifiers only)

Open data verification needs every image of an election, not one per receipt. Verifiers therefore get a second, signed
way in. **Voters still fetch only their own image with their ballot code; nothing about that route changed.**

| request | answer |
| --- | --- |
| `GET /api/verifier/images?election=<code>` | JSON manifest: `{ election, generatedAt, count, expiredOmitted, images: [{ imageHash, contentType, size, uploadedAt }] }`, sorted by hash. **No ballot code hash** and no deleteAfter is listed, so the manifest does not link an image to a ballot. Images past `deleteAfter` are left out and counted in `expiredOmitted`. |
| `GET /api/verifier/images/<sha256>?election=<code>` | the one image. Re-hashed before it is served (500 if the stored bytes do not match their hash), **410 Gone** from `deleteAfter` on, 404 if unknown. Sends `Cache-Control: private, no-store, max-age=0`, `X-Image-Sha256`, `Content-Disposition: attachment`, nosniff and a sandbox CSP. |

A streamed zip was left out on purpose: Netlify functions have a 6 MB response and a short time limit, so a
per-image download (the CLI runs 4 in parallel) is what actually works, and it lets the verifier check every file on its own.

**Authentication (EIP-191 `personal_sign`).** The verifier signs the text
`BEINGS-VERIFIER|<electionCode>|<unix seconds>` with its key and sends two headers:
`X-Verifier-Timestamp: <unix seconds>` and `X-Verifier-Signature: 0x<65-byte signature>`. The server recovers the signer
with `ethers.verifyMessage` and answers:

* 400 bad election code; 401 missing or malformed headers, or a timestamp more than **5 minutes** from server time;
* 403 the signer is not an authorised verifier (a signature for another election or timestamp recovers a different
  address, so it ends here too);
* 502 the registry could not be read (nothing is served); 503 verifier access is not configured (only in `allowlist` mode with an empty list); 429 rate limit.

The challenge names the election, so a signature cannot be replayed on another election. Inside the 5-minute window a
captured request could be replayed to read the **same** election, over TLS, for the same data the verifier could read
anyway; the CLI signs a fresh challenge for every request.

Who counts as authorised is set by `VERIFIER_AUTH_MODE`:

| mode | rule |
| --- | --- |
| `registry` (default) | the address is registered in the **VerifierRegistry** (`nodes(address).registeredAt != 0`, one `eth_call`, cached 60 s). `VERIFIER_ADDRESSES` is not needed. |
| `allowlist` | the address is in `VERIFIER_ADDRESSES` (comma, space or newline separated). Empty list = 503, fail closed. |
| `either` | allowlist first, then the registry. |

**Verification is open.** Anyone may verify: any address registered in the VerifierRegistry
(`0xdb6A83242139E3b7D47c31588d8d06c64CE94316`, Coston2) can bulk-download. `register()` is permissionless (see
`packages/verifier/README.md` for how to register). Every request must still be signed by the registered key; the rate
limit (per IP in the function config, plus `VERIFIER_RATE_PER_MINUTE`, default 240 per client per instance) and the gas
cost of registering deter abuse. `allowlist` and `either` remain available if a deployment wants to restrict or add
addresses via `VERIFIER_ADDRESSES`.

The client side is `beings-verify-images` in `packages/verifier` (see its README): it downloads everything, checks each
SHA-256 against the manifest **and against the `imageSha256` in the on-chain `BallotAccepted` events**, and reports
mismatches and missing images.

## Privacy model

* **Three access paths.** Voters: per-ballot fetch, authorised by their ballot code and an on-chain lookup (above).
  Verifiers and the election organizer: signed bulk access to the whole election (the All ballot scans gallery), with a
  manifest that carries no ballot codes or ballot-code hashes. Optionally, when **Public ballot images** is on, a
  narrow unauthenticated fetch of **one** picture by election code + image fingerprint (no listing).

* **What is held here:** only the redacted ballot images (the phone crops and blurs everything except the bubbles, the
  ballot code and the QR code before hashing and upload), keyed by hash, for the retention period. No names, no
  voter list, no record files. Nothing else about voters exists on this site.
* **What is permanent:** only on the ledger: results and the image hash. After deletion the hash lets anyone prove
  that a copy someone kept is authentic.
* **Who can read an image:** someone who holds the ballot code (the voter's receipt) for a ballot recorded on-chain;
  a registered verifier or the election organizer, with a signed request; or, only when Public ballot images is on,
  anyone who has the election code and that picture's fingerprint. The scanner can write but cannot read. The raw
  ballot code is not stored here, only its keccak hash, which is the same value the public ledger already uses as the
  ballot's key. A public picture can show a printed ballot code, so it could be used as proof of a vote or to pressure
  someone. Public pictures are kept for 30 to 60 days, then removed.
* **Honest limits:**
  * Whoever sees a voter's receipt can fetch that image; the receipt must be kept private (as the design spec already says).
  * The ballot code is also printed in the (redacted) image itself, and the ledger design makes per-ballot results
    public. If the project publishes ballot codes next to results (for example in a public tally file), then anyone who
    reads that file can fetch every image through this endpoint. See "Open questions".
  * Copies somebody already downloaded cannot be recalled.
  * Netlify (and Flare's RPC provider) see request metadata such as IP addresses. Use the header, not the query string.
  * A basic per-IP rate limit (300 requests per minute) is set in the function config; confirm that it is active for
    your Netlify plan.

## Retention rule

Each upload carries `X-Retention-Days`, the election's `imageRetention.days` (design spec 9.3). When pictures are not
public, that is 1 to 365 days. When Public ballot images is on, it must be **30 to 60 days** (Create form, validation,
and the upload API all enforce this; the default is 30). The store computes `deleteAfter = upload time + days` and
writes it into the blob's metadata. From `deleteAfter` on, fetch answers **410** and the page shows **Image expired**
(the ledger's hash, fingerprint and reading remain), and the daily cleanup deletes the blob (so physical deletion
happens within about a day after `deleteAfter`).
The spec says the clock starts when results are Final and is extended while a review or recount is open. This site
cannot see that, so the **uploader decides**: upload with a date far enough ahead, and while a review is open
re-run the upload with a larger `X-Retention-Days`, which extends (never shortens) the date. After retention, the
spec's `noticeImagesRetired` notice on the ledger is a separate organizer action.

## Deployment (what :James-Hugh: Lamb. does, step by step)

All of this is on netlify.com and at your domain registrar. Nothing here touches any other Netlify site.

1. **Make the upload secret.** On any computer run
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep the 64-character result somewhere
   private (a password manager). This is `SCANNER_UPLOAD_TOKEN`. Do not put it in the repo.
2. **Push the repo.** Make sure the private GitHub repo `beings` contains this folder (`apps/beingsvote-site`).
3. **Create a NEW Netlify site.** In Netlify choose **Add new project** > **Import an existing project** > **GitHub**.
   Allow the Netlify GitHub app access to the private repo `beings` (grant it only that repository). To keep this
   completely separate, create it in a **separate Netlify team** (Netlify: team switcher > *Create a new team*), or
   at least a brand-new site in your existing team. Never reuse or edit another site.
4. **Build settings** on the import screen:
   * Branch to deploy: `main` (or your production branch)
   * **Base directory: `apps/beingsvote-site`**
   * Build command: `npm run typecheck` (the file `netlify.toml` already says this)
   * Publish directory: `public`
   * Functions directory: `netlify/functions`
   Netlify reads `apps/beingsvote-site/netlify.toml`; paths there are relative to the base directory.
5. **Environment variables** (Site configuration > Environment variables). Required: `SCANNER_UPLOAD_TOKEN` = the
   secret from step 1 (mark it as a secret / "contains secret values"). Optional (defaults are fine for the Coston2 test):
   `RPC_URL`, `LEDGER_ADDRESS`, `REGISTRY_ADDRESS`, `MAX_IMAGE_BYTES`, `MAX_RETENTION_DAYS`, `ALLOWED_ORIGINS`.
   Optional for public pictures: `ELECTION_FILES_BASE` (origin + `/data/elections`; defaults to the same site),
   `PUBLIC_IMAGE_RATE_PER_MINUTE` (default 60). Verifier bulk access works out of the box (open to registered
   verifiers, and to the election organizer); optional: `VERIFIER_ADDRESSES`, `VERIFIER_AUTH_MODE`,
   `VERIFIER_REGISTRY_ADDRESS`, `VERIFIER_RATE_PER_MINUTE`. Set them for the
   **Production** deploy context, then click **Deploy**. No setup is needed for Netlify Blobs; it is on by default.
6. **Check the deploy:** open the `*.netlify.app` address Netlify gives you. The page should load. Then
   `curl -i https://<your-site>.netlify.app/api/images` should answer `400` (needs an election) and
   `curl -i -X POST https://<your-site>.netlify.app/api/images` should answer `401`. Under **Functions** you should see
   `images`, `verifier-images` and `cleanup-images` (the last marked as scheduled). `curl -i https://<your-site>.netlify.app/api/verifier/images?election=BEINGS-2026-XXXXXX`
   should answer `401` (no signature).
7. **Point the domain.** Site configuration > Domain management > **Add a domain** > `beingsvote.live`, and verify it.
   Then either (a) let Netlify DNS handle it: Netlify shows four name servers; set them at the registrar where you
   bought `beingsvote.live`, or (b) keep your registrar's DNS and add the records Netlify shows (usually an `A` record for
   the bare domain and a `CNAME` for `www` pointing at your `*.netlify.app` name). Wait for DNS, then in Domain
   management click **Verify DNS** and **Provision certificate** (HTTPS). Use `https://beingsvote.live` only.
8. **Give the scanner its secret.** On the scanning computer set the environment variable `SCANNER_UPLOAD_TOKEN` to the
   same value (see below). Never type it into a command line flag or paste it in chat.
9. **Try it end to end** with a test image (below) and then confirm the voter page shows it for the ballot code and that
   a wrong ballot code shows nothing.

## Local development and tests

```bash
cd apps/beingsvote-site
npm install
npm test            # site tests (hash checking, upload and voter auth, public hash fetch, election-file policy, expiry, key derivation, chain decode, fetch rules, verifier signature auth, all-ballot-scans gallery, rate limit)
npm run typecheck
npm run dev         # netlify dev (needs the Netlify CLI and a linked site; Blobs run in a local sandbox)
npm run serve       # no Netlify CLI needed: http://localhost:8888 (PORT=... to change), same CSP headers, in-memory images
# to try the verifier download locally: VERIFIER_ADDRESSES=0xYourWallet VERIFIER_AUTH_MODE=allowlist npm run serve
```

Tests use an in-memory blob store and a fake JSON-RPC endpoint, so they need no network. When run inside the monorepo
they also cross-check the key derivation and ABI decoding against `@beings/core` and `ethers`.

## Scanner upload and verify helpers (`packages/scanner`)

```bash
export SCANNER_UPLOAD_TOKEN=...        # the same secret; from the environment only
# upload one scan (hashes it, sends the keccak of the ballot code, prints the imageHash for the ballot record)
npm run upload -w @beings/scanner -- --file scan.png --election BEINGS-2026-XXXXXX \
    --ballot-code 4F9Q-7M2X-HT8B --retention-days 14
# just the hash:   ... --file scan.png --hash-only
# take ballot code and check the hash from omr_finish.mjs output:   --result page1-result.json
```

In code or a browser bundle: `import { uploadScan, fetchAndVerifyImage, verifyImageBytes } from "@beings/scanner"`.
`fetchAndVerifyImage` fetches the image from the store, **reads the on-chain imageHash itself from the RPC** (so the
store cannot vouch for its own image), recomputes the SHA-256 in the browser and returns `ok` only if they match.

## All ballot scans

On Admin and Verifier, **All ballot scans** shows every stored picture, with recorded reading, recorded hash, computed
hash, and a match/mismatch badge, plus Verify all (browser SHA-256) and Download all (a zip built in the browser, with
`manifest.json` and `manifest.csv`). Labels are **Ballot A1, A2, …**, sorted by hashed ballot key — not print or scan
order. The zip and manifest do not include a ballot code, a ledger sequence number, or a print position. The full
gallery stays organizer/verifier only. Check my ballot still does not fetch a picture until the voter asks.

When Public ballot images is on, Results and Check my ballot show a notice, and Results has a single-picture lookup
(election code + fingerprint). That lookup also waits for a click.

Local mock previews (no wallet, no network, synthetic `BEINGS-2026-TEST42` only):
`apps/beingsvote-site/dev/all-scans-preview.html` and `apps/beingsvote-site/dev/public-images-preview.html`.

## Connect printer & scanner and test print and scan

On Create and on the Setup Register card, **Connect printer & scanner (Windows PC)** asks the optional local helper
(`http://127.0.0.1:8765`, `http://[::1]:8765`, and `http://localhost:8765`) what Windows can see, and relinks a scanner the teacher already confirmed.
An optional **Test print and scan** step can then print a clearly labelled synthetic test page (not a real ballot;
fixed fake code `TESTPRNTSC01` for election `BEINGS-2026-TEST00`), scan it, and check that the reading and the ballot
fingerprint match. Nothing is recorded on the ledger or uploaded. Both steps are optional: creating an election and
registering a station are never blocked if a device is unconfirmed, not found, or the test is skipped or failed,
because ballots are accounted for by hash, so any printer and scanner can theoretically work. The page shows a
plain-language advisory instead.

The same button downloads `BEINGS-Scanner-Helper-Setup.exe` only when the helper is not installed, or when the
running helper is older than the version in `public/downloads/helper-download.js`. A recent download is remembered
(`beings.helperDownloadedAt`) so the page does not keep saving another copy. If the helper was seen before
(`beings.helperSeen.v1`) but is not running, the page shows **Start helper** (`beings-helper://start`) and the Start
menu steps, not another download. The setup program is not code-signed yet: if SmartScreen appears, choose More info,
then Run anyway. The zip next to the exe is the fallback. The zip is rebuilt by the Netlify build
(`node ../../packages/scanner-helper/tools/build-windows-bundle.mjs`). The exe is built with NSIS
(`node packages/scanner-helper/tools/build-windows-installer.mjs`) and committed with its SHA256. Code signing is not
available yet. On an iPad or phone the page says the helper has to be installed on the Windows PC.

**Run system check** sits with Find and Install. It asks the helper on this computer and does not upload. The image-store
line reads `https://beings-ballot-images.beingsvote-test.workers.dev` (or `IMAGE_STORE_URL` when that is set), not this
page's own address.

A local mock preview (no wallet, no network, no real hardware):
`apps/beingsvote-site/dev/scanner-confirm-preview.html?view=create|register&state=idle|found|notfound|confirmed|skipped|pass|fail|mocked`.
On this Linux build machine the helper's test uses the bundled stand-in picture, not a real WIA scanner or printer.

## Open choices


* Chain lookup is used, so no stored-metadata fallback was needed for the voter path. The public hash path may fall
  back to upload metadata only when the public election file cannot be loaded; if the file says the setting is off, it
  is refused.
* The ledger is read on **Coston2 only** (test). For the real network change `RPC_URL` and `LEDGER_ADDRESS`.
* `publicBallotImages` lives in the site's election file and is included in `fileSha256`. The published `@beings/core`
  JSON schema was not updated in this change (`additionalProperties: false` would reject the new field if someone
  validates against that schema).
* The on-chain record order is still the order the scanner recorded the ballots, unless a batch is shuffled before
  recording. The gallery does not follow that order. An optional "shuffle before recording" step in the scanner helper
  is an open point; it is not built here.
