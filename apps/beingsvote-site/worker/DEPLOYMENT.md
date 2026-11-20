# Ballot image Worker

This directory is the Cloudflare Worker in front of the private R2 bucket `beings-ballot-images`. It is deployed at `https://beings-ballot-images.beingsvote-test.workers.dev`. beingsvote.live reads and writes images here. Netlify Blobs are a read-only fallback for objects already stored, until each object's own `deleteAfter`. The Netlify cleanup still deletes Blobs. This Worker's cron deletes R2 objects.

## What it does

Same HTTP API as the Netlify functions, implemented by the same handlers in `apps/beingsvote-site/src`:

| Route | Behavior |
| --- | --- |
| `POST /api/images` | Scanner upload. Bearer token, content-type magic bytes, recomputed SHA-256, election-scoped key, conditional create. |
| `GET /api/images?election=` | Voter fetch. Ballot code plus one read-only `eth_call` to BallotLedger. Serves only that record's `imageSha256`. |
| `GET /api/verifier/images` | Signed verifier manifest. No ballot-code hash in the JSON. |
| `GET /api/verifier/images/<sha256>` | One image, re-hashed before it is sent. |
| Cron `30 3 * * *` UTC | Deletes an object only when its own `deleteAfter` has passed. |

Object key: `<electionCode>/<sha256 hex>`. Metadata matches the Netlify blob: `electionCode`, `ballotCodeHash` (keccak of the ballot code, never the code), `contentType`, `size`, `uploadedAt`, `deleteAfter`.

Creates use R2 `onlyIf: { etagDoesNotMatch: "*" }` (If-None-Match). A failed condition returns null and writes nothing. Bytes that do not hash to the key are refused before `put`. A later upload may extend `deleteAfter` and must not shorten it. The bucket binding is `remote: false`, so local dev and tests use the simulator, not the real bucket.

There is no public R2 URL and no presigned S3 URL. A presigned URL would skip the ledger fingerprint check, the ballot binding, the retention check, and the re-hash. Downloads stay on the Worker, size-capped, `private, no-store`.

No R2 object-lifecycle expiration is configured. A bucket TTL would delete images before an election's own `deleteAfter`. Do not add one.

`workers_dev` is true so the workers.dev hostname stays on the next deploy. `preview_urls` stays false. There is no route on `beingsvote.live`. Do not add one: the pages call this hostname, and the ledger check stays in the Worker.

`ALLOWED_ORIGINS` in `wrangler.jsonc` is `https://beingsvote.live`. The copy that was already deployed did not send `access-control-allow-origin` for that origin (probed 2026-11-13). Set the variable on the existing Worker, or redeploy this directory, before a browser can read an image response directly. Until then the pages try this origin and, if the browser blocks the response, ask beingsvote.live, which forwards here.

## Defaults after cutover

| Switch | Unset behavior |
| --- | --- |
| Netlify `R2_IMAGE_SERVICE_URL` | Functions forward to `https://beings-ballot-images.beingsvote-test.workers.dev`. No Netlify UI setting is required. Set only to an `https` origin with no path, query, or credentials. A bad value returns 503 and does not write to Blobs. |
| `public/js/config.js` `imageServiceBase` | That same Worker origin. Pages call it. An unsafe value is ignored and the call stays on this site. `connect-src` in `netlify.toml` includes the origin. |
| Scanner `IMAGE_STORE_URL` or `--url` | The Worker origin. An explicit `https` origin is accepted. `http` is accepted only for `localhost` / `127.0.0.1`. |

The Netlify proxy forwards only the image API headers. It does not forward `Cookie` or `X-Forwarded-For`, and it does not follow redirects. Cleanup is not proxied. While requests go through Netlify, Cloudflare sees Netlify's egress address, so the Worker's per-address limit collapses to that address. Direct calls to the Worker use `CF-Connecting-IP`.

The browser calls this origin directly, so `connect-src` in `netlify.toml` includes it.

## Secret and config names

Values stay out of git. Placeholders only.

| Name | Where | Notes |
| --- | --- | --- |
| `SCANNER_UPLOAD_TOKEN` | Worker secret (`wrangler secret put`) and the existing Netlify variable | Required. At least 24 characters. Missing or short: every upload is 503. |
| `CLOUDFLARE_API_TOKEN` | :James-Hugh: Lamb.'s shell only, or `wrangler login` | Deploy credential. Not a Worker binding. Never commit it. |
| `R2_IMAGE_SERVICE_URL` | Netlify env, optional | Not a secret. Unset already means the Worker origin above. Set only to replace that origin. |
| `IMAGE_STORE_URL` | Scanner environment, optional | Not a secret. |
| `RPC_URL` | Worker var, optional | Default `https://coston2-api.flare.network/ext/C/rpc`. Read-only `eth_call`. |
| `LEDGER_ADDRESS` | Worker var, optional | Current Coston2 BallotLedger `0x5d00bE9A32DcF1FcDe9475C8Be874aE8af0fCf0b`. A dashboard value overrides `wrangler.jsonc`. |
| `LEGACY_LEDGER_ADDRESSES` | Worker var, optional | Earlier BallotLedger `0xF579913c90b86f102Fff8D07c6c16f465495013C`. Image reads try the current ledger, then this list. |
| `VERIFIER_REGISTRY_ADDRESS` | Worker var, optional | Current Coston2 VerifierRegistry `0x360e9d558DEc99a2E2F81Cf925424ba399492bDc`. |
| `VERIFIER_AUTH_MODE` | Worker var, optional | `registry` (default), `allowlist`, or `either`. |
| `VERIFIER_ADDRESSES` | Worker var, optional | Used by allowlist / either. |
| `VERIFIER_RATE_PER_MINUTE` | Worker var, optional | Default 240 per isolate. |
| `MAX_IMAGE_BYTES` | Worker var, optional | Default 5000000. |
| `MAX_RETENTION_DAYS` | Worker var, optional | Default 365. Private pictures may use 1–365 days. Public ballot images are limited to 30–60. |
| `REGISTRY_ADDRESS` | Worker var, optional | Current Coston2 ElectionRegistry `0x9Ae01EEAf38FB03554970cbDC7F83FFBB8d4Ee8A` (organizer auth for bulk image access). |
| `LEGACY_REGISTRY_ADDRESSES` | Worker var, optional | Earlier ElectionRegistry `0x651A078e51B69Eff17e22950573EbE0252f43E63`. |
| `LEGACY_VERIFIER_REGISTRY_ADDRESSES` | Worker var, optional | Earlier VerifierRegistry `0xdb6A83242139E3b7D47c31588d8d06c64CE94316`. |
| `ELECTION_FILES_BASE` | Worker var, optional | Public election JSON prefix, e.g. `https://beingsvote.live/data/elections`. Unset: same-origin `/data/elections`. |
| `PUBLIC_IMAGE_RATE_PER_MINUTE` | Worker var, optional | Default 60 per isolate, for unauthenticated hash-only fetches. |
| `ALLOWED_ORIGINS` | Worker var | CORS. `wrangler.jsonc` sets `https://beingsvote.live`. Empty in code now means that same origin. The already-deployed Worker still needs this variable, or a redeploy, before browsers can read its responses. |

Account `23463786666b4b6a7da866b52a5a2d64`. Bucket `beings-ballot-images`, binding `BALLOT_IMAGES`, Standard / default jurisdiction. Do not create another bucket and do not enable r2.dev or a public custom domain.

Local secrets file: copy `worker/.dev.vars.example` to `worker/.dev.vars` (gitignored).

## How an image becomes answers

This is not an AI model, and the beingsvote.live pages do not read the marks.

The component that extracts marks is the local prototype `packages/scanner/prototype/omr.py` (Python, OpenCV, numpy). Its own header says it is not the production phone app. `packages/scanner/README.md` says the phone PWA (`opencv.js`) is not written yet. No file under `apps/beingsvote-site/public/js` runs OMR. The web verifier records `omrBuild: "none: this tool re-checks the ledger, hashes and counts, not the ballot marks"` in `public/js/logic.js`.

`omr.py` is deterministic pixel processing against the layout file:

1. Find four registration-mark squares (top-left must be the largest).
2. Warp the page to the layout frame at 10 px/mm.
3. Decode the QR with OpenCV's QR detector (`BEINGS1|<election>|<ballot code>|L<layout>`). That is a barcode decode, not OCR of handwriting and not a model.
4. Treat a pixel as ink when it is darker than half the measured paper level.
5. For each oval, score = round(100 × (ink fraction in the inner ellipse − ink fraction in the baseline ring)), integer 0–100.

`packages/scanner/prototype/omr_finish.mjs` then calls `@beings/core` `deriveResults`: score below `emptyBelow` (15 in the sample rules) is empty, above `markedAbove` (50) is marked, otherwise unclear. Too many marks → `O`, any unclear → `U`, none marked → `B`, else `V:c1` / `V:c1+c3`. It joins questions with `|`, and SHA-256s the image file bytes into `imageSha256`. `scoresHash` is keccak256 of the canonical fill-score JSON (`packages/core/src/eip712.ts`). `recordSha256` is SHA-256 of the canonical full record. `resultsHash` is keccak256 of the results string.

The image store receives the image bytes and the keccak of the ballot code. It does not receive fill scores and does not re-read ovals. The chain submission helper is `packages/ledger/scripts/scanned-ballot.js` (a Hardhat script; it can send testnet transactions, so it was not run here). The ledger stores one record per ballot: results string, `imageSha256`, `recordSha256`.

`packages/verifier/README.md` mentions an AI vision model only as an optional `--reader-cmd` plug-in. The default reader is `packages/verifier/python/blind_reread.py`, the same OpenCV scoring, in a separate process, on a masked copy of the stored image.

## Data flow: scan, chain, Merkle, re-read

Current implementation, not a second physical scan.

1. One physical capture. `docs/beings-architecture.md` and `docs/beings-design-spec.md` say each ballot is scanned once. No second-pass scanner, rescan queue, or "scan again for the Merkle tree" path exists in the repo.
2. The stored fingerprint is the SHA-256 of the image bytes that were uploaded, not a hash of the mark vector. A new photo of the same paper will not match that hash (compression, lighting, alignment, crop).
3. The phone/prototype reading becomes a results string and fill scores. Those are what get signed and posted. The image store never derives them.
4. `BallotLedger.submitRecord` writes that one ballot. `submitBatch` exists and still calls `_submit` once per ballot (all-or-nothing). It is not a Merkle-only posting. Design-spec open question 1 (per-ballot versus batched Merkle posting) is still an open lean: per-ballot for small elections, Merkle root at close.
5. The tally posts one `merkleRoot`. `merkleRootOfEntries` / `entryLeaf` in `packages/core/src/tally.ts` hash the canonical ledger entry `{electionCode, ballotCode, results, imageSha256, recordSha256, reviewed}` after corrections. Leaves are sorted before pairing (`packages/core/src/merkle.ts`), so physical scan order does not change the root. Ballot codes are per-ballot receipt secrets, not voter ids. The leaf does not contain a voter id.
6. Recomputing that root from the same posted records checks that the posted root matches those records. It does not check that the paper was read correctly.
7. The site verifier rebuilds that root when someone supplies the full election file (the public copy strips ballot codes, so it cannot). It also checks image-byte hashes against the ledger. It does not re-read marks.
8. `packages/verifier` blind re-read is a second software reading of the same stored image: mask everything except the ovals, score pixels, compare keccak256 of the new results string with the on-chain `resultsHash`. Reports are keyed by `imageSha256` only. It is not a second trip through the scanner, and the default algorithm is the same family as `omr.py` (independent process, not an independent method). The spec's paper risk-limiting audit (section 12.1 step 5) is a human sample of paper ballots. It is not implemented as an automated rescan.

The 2026-11-04 note about a 2.1 million ballot re-read is a timing estimate for images already captured (~30 ms each) plus a note that physical scanning is the bottleneck. It is not a BEINGS rescan feature.

## Security gaps already in the design

- Verifier signatures are `BEINGS-VERIFIER|<election>|<unix seconds>`. They are scoped to the election and expire after 5 minutes. They are not scoped to the path. Inside that window the same read can be replayed. Tests assert that, rather than hiding it. Adding a nonce would change every current verifier client.
- `VerifierRegistry.register` is permissionless. In the default `registry` mode any address that pays gas and signs can bulk-download that election's images. That is the published "verification is open" rule.
- `?ballotCode=` is still accepted on voter fetch, so the code can land in access logs. The header is the path the pages use.
- Upload does not check the chain. The scan is stored before the ballot record exists, so there is no fingerprint to compare yet. The voter fetch is where the ledger fingerprint is enforced. A stolen upload token can write images; it cannot read them.
- The server does not read the election file's `imageRetention.days`. It trusts `X-Retention-Days`, capped at `MAX_RETENTION_DAYS`.
- The in-memory rate limit is per isolate (300/minute on the Worker, plus the verifier's own 240). It is not global. Netlify's platform limit remains on the Netlify path.
- Someone with a direct R2 write credential can bypass the Worker. Do not create a browser S3 token. Do not enable public access.
- Two concurrent retention extensions can still race on which longer date lands. The conditional update will not write a shorter date over a longer one. The bytes cannot change, because the key is the content hash.
- Keys that are not `<electionCode>/<sha256>` are not listed and are not deleted by cleanup. A missing `deleteAfter` is kept and counted as needing attention.

## Tests already run (local only)

Worker, workerd via `@cloudflare/vitest-plugin` 1.6.0, Wrangler 4.158.0, Vitest 4.1.12. `npm test` in `apps/beingsvote-site/worker`: **14 passed**. Startup warns `Missing required secrets: SCANNER_UPLOAD_TOKEN` because that secret is a Miniflare binding in the test config, not `process.env`. The synthetic token is still present at runtime (unauthorized uploads return 401, a good token returns 201).

Covered: missing/wrong bearer and no object; valid create; bad election and traversal; hash mismatch 422 and no object; bad content type; oversized `Content-Length` 413; repeat upload 200; retention not shortened and then extended; two concurrent creates leave one object; a second ballot is 409 and does not replace `ballotCodeHash`; the same bytes under another election are a different key and do not appear in the first election's manifest; verifier without a signature 401; expired challenge 401; signature for the other election 403; the same fresh signature accepted twice inside five minutes; voter fetch checks the stubbed ledger fingerprint; tampered bytes under that key return 500; `deleteAfter` in the past returns 410 even if the query names the hash; cleanup deletes only the expired image key and leaves a future election, a key with no `deleteAfter`, and `notes/not-an-image`; `PUT` and unknown paths do not hit the API; the 301st request from one address is 429.

`wrangler deploy --dry-run` packaged the Worker (272.45 KiB, gzip 66.56 KiB) and exited without deploying. The binding shown was `BALLOT_IMAGES` → `beings-ballot-images`.

Site Vitest 3.2.7, focused image tests: **69 passed** (`r2OptIn`, `rateLimit`, `upload`, `fetch`, `auth`, `verifier`). Full site run: **216 passed, 7 failed, 3 skipped**. The failures are from this checkout, not from the image handlers:

- `wallet-connect.test.ts` expects `walletConnectProjectId` to be `""`. The committed `config.js` already contains `8a7a9fdb10da4f8b27e2dac859b49529`.
- Three `staff-logic` checks and three `verifier-client` checks need the monorepo install (`ajv`, `@beings/core`). Root `node_modules` is not present. `tsc` for the site also reports the existing `test/chain.test.ts` import of `@beings/core`. Worker `tsc` completed with no errors.

No live Coston2 calls, no contract writes, no real ballots, no wallet keys.

## Public comments (not deployed by the contact/comments change)

Comments are off-chain rows in D1 binding `COMMENTS` (database name `beings-comments`). They are not ballot images and they are not chain transactions. The site already calls `https://beings-ballot-images.beingsvote-test.workers.dev/api/comments`. Until this Worker is redeployed, that path 404s and Home / How it works show a note instead of throwing. Contact messages do not use this database: they are a Netlify Form named `contact`.

Do not run these steps as part of reviewing the pull request. They change the live Worker.

1. From `apps/beingsvote-site/worker`, confirm the account is `23463786666b4b6a7da866b52a5a2d64`. Create the database (once): `npx wrangler d1 create beings-comments`. Copy the printed `database_id` into `wrangler.jsonc` in place of `00000000-0000-0000-0000-000000000001`. Do not create another R2 bucket.
2. Apply the schema: `npx wrangler d1 migrations apply beings-comments --remote`. The file is `migrations/0001_comments.sql`. The Worker also runs `CREATE TABLE IF NOT EXISTS` on first use.
3. Secrets, each with `npx wrangler secret put` and the value on stdin. At least 24 characters. Do not pass the value as a flag, do not commit it, do not put it in Netlify env.
   - `COMMENT_ADMIN_TOKEN` — required before approve / reject / delete will succeed. Missing or short: those routes return 503.
   - `TURNSTILE_SECRET` — the Turnstile widget secret. Missing or short: public comment POST returns 503 and nothing is stored.
   - `COMMENT_IP_PEPPER` — optional. Mixed into the SHA-256 stored for rate limiting. The raw IP is not stored either way.
4. Turnstile widget (Cloudflare dashboard, managed). Add the hostname `beingsvote.live`. Do not add `localhost` to the production hostname list. `TURNSTILE_HOSTNAMES` in `wrangler.jsonc` is `beingsvote.live`. Put the public site key in `public/js/config.js` as `turnstileSiteKey` and deploy the site again. Leave the key empty until then: the comment box renders and sending stays off.
5. Redeploy this directory with `npx wrangler deploy`. `workers_dev` stays true. Do not add a route on `beingsvote.live`.
6. Netlify: after the site deploy, open Forms → `contact` → Form notifications → Email notification → `report@beingsvote.live`. Do not turn on a public submissions feed. Submissions stay in the Netlify dashboard and that mailbox. They are not written to D1 or the chain. If the form POST fails, the contact page offers a mailto link to the same address.

Generate a token outside the repo, for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, and paste it only into `wrangler secret put`.

## Deploy, cutover, rollback (separate from this change)

1. From `apps/beingsvote-site/worker`, `npx wrangler login` or export `CLOUDFLARE_API_TOKEN` in the shell. Confirm the account is `23463786666b4b6a7da866b52a5a2d64` and the bucket `beings-ballot-images` already exists. Do not create a bucket.
2. `npx wrangler secret put SCANNER_UPLOAD_TOKEN` and paste the same value Netlify already uses, or a new one if scanners will be pointed only at the Worker. Do not pass it as a flag.
3. Optional vars (`RPC_URL`, `LEDGER_ADDRESS`, verifier settings, size and retention caps) only if they should differ from the defaults above. `ALLOWED_ORIGINS` is already `https://beingsvote.live` in `wrangler.jsonc`. The Worker that is already deployed was published before that line, so set `ALLOWED_ORIGINS` on it (or redeploy) or browsers cannot read its responses. Leave `remote` false. Do not add a route for `beingsvote.live`.
4. `npx wrangler deploy` keeps the workers.dev hostname (`workers_dev` is true) and does not attach `beingsvote.live`.
5. Smoke, against the workers.dev URL, with synthetic values: `POST` without a token is 401; `GET /api/images` without an election is 400; a verifier GET without a signature is 401. Those three already passed on the deployed Worker.
6. Cutover is one store for new writes. Pages, the scanner helper, and the Netlify functions all send new images to this Worker. Do not write half the ballots to Blobs and half to R2. A GET the Worker answers with 404 may still read a Blob already stored, until that object's `deleteAfter`. The Worker cron deletes R2 objects. The Netlify cleanup only deletes Blobs. Clearing `R2_IMAGE_SERVICE_URL` does not turn the forward off.
7. Rollback of new writes is a code change: set `imageServiceBase` back to `""`, point the scanner default back at `https://beingsvote.live`, and stop the Netlify functions from forwarding. `wrangler rollback` restores the previous Worker code and does not restore or delete R2 objects. Leave the bucket in place. Do not enable a lifecycle rule to "clean up" the experiment.
