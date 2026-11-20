# B.E.I.N.G.S. — public mirror (v0.13)

This is the public mirror of the **B.E.I.N.G.S.** open standard for transparent, publicly verifiable
paper-ballot elections, demonstrated on Flare Coston2 (test network, chain ID 114).

* Live site: <https://beingsvote.live>
* Dated publication (Zenodo, v0.13): DOI [10.5281/zenodo.24377935](https://doi.org/10.5281/zenodo.24377935)
* Source: a sanitized snapshot of `main` at commit `bd70bd78` (19 November 2026). See [`SNAPSHOT.txt`](SNAPSHOT.txt)
  for what was removed or redacted. This mirror starts with fresh history.
* Worked example: the synthetic Test election **Example Classroom 411** (`BEINGS-2026-EX411X`) is in
  [`examples/example-classroom-411/`](examples/example-classroom-411/).

Coston2 only. Not a legally certified election system, not a mainnet deployment, and not independently audited.

**Licences.** Code is licensed under the [Apache License 2.0](LICENSE). Documentation and example data are licensed
under [CC BY 4.0](LICENSE-DOCS-CC-BY-4.0.txt). See [`LICENSE-NOTICE.txt`](LICENSE-NOTICE.txt) for the file-by-folder map.

**Trademark and artwork.** B.E.I.N.G.S. is a trademark of :James-Hugh: Lamb. The B.E.I.N.G.S. logo and coin designs
are artwork of :James-Hugh: Lamb. and are not licensed under Apache License 2.0 or CC BY 4.0. The logo, coin artwork,
and spin videos are omitted from this repository.

© 2026 :James-Hugh: Lamb.

---

# B.E.I.N.G.S. monorepo

Starter monorepo for **B.E.I.N.G.S.** (Blockchain Election Integrity Network System): hash-anchored, publicly
verifiable paper-ballot elections. The two source documents are in [`docs/`](docs/):

* [`docs/beings-architecture.md`](docs/beings-architecture.md): modules M1 to M7, interface contracts (IC), build order
* [`docs/beings-design-spec.md`](docs/beings-design-spec.md): schemas, contracts, reconciliation rules

## Structure

```
packages/
  core/         M7  @beings/core: shared library. IMPLEMENTED, tested. Build this first; everything else depends on it.
  ledger/       M4  Hardhat project, ElectionRegistry, BallotLedger, Tally, VerifierRegistry. IMPLEMENTED and tested locally (Coston2, chain ID 114). Deployed to Coston2 (test).
  voter-list/   M1  placeholder (README only)
  ballot-gen/   M2  @beings/ballot-gen: ballot PDF, ballot layout JSON, ballot list + Merkle root, `beings-ballots` CLI. IMPLEMENTED, tested. The election file it writes carries `layoutHash` (SHA-256 of the layout), and the printed ballot shows question and choice ids (`Q1`, `c2`) that match the ledger result strings.
  scanner/      M3  @beings/scanner: OMR prototype (Python) + TypeScript helpers to upload a scan to the image store and verify a fetched image against the ledger. Tested.
  tabulation/   M5  placeholder (README only)
  verifier/     M6  placeholder (README only)
apps/
  beingsvote-site/  standalone Netlify site (beingsvote.live): the public web app (static, no build step: public results, voter lookup, role-gated staff screens) plus the ballot-image API. New images go to the Cloudflare R2 Worker; the Netlify functions forward to it and can still read an unexpired Blob. Not an npm workspace; own package.json, own netlify.toml. `npm run serve` runs it locally. See its README.
docs/           the architecture and design spec
```

## Setup

Requires **Node 20 or newer** and npm 10 or newer (npm workspaces).

```bash
npm install
npm run build        # builds @beings/core first, then the other packages (ballot-gen, ledger contracts)
npm run typecheck
npm test             # core (vitest) + ballot-gen (vitest) + ledger (hardhat)
```

Run only the core tests:

```bash
npm run test:core
# or, from packages/core:  npx vitest run
```

The first `hardhat compile` downloads the solc 0.8.24 compiler, so it needs network access. To skip the ledger package,
use `npm run test:core`.

Gas per function on the local Hardhat network (writes `packages/ledger/GAS.md`):

```bash
npm run gas -w @beings/ledger
```

### Coston2 deployment

Deployed on 2026-11-01 (`evmVersion: london`); addresses and real gas costs are in [`packages/ledger/README.md`](packages/ledger/README.md) and `packages/ledger/GAS.md`. To redeploy with a funded **test** key:

```bash
cp packages/ledger/.env.example packages/ledger/.env   # set DEPLOYER_PRIVATE_KEY (a funded Coston2 test key only)
npm run deploy:coston2 -w @beings/ledger               # writes packages/ledger/deployments/coston2.json (overwrites the recorded deployment)
npm run smoke:coston2 -w @beings/ledger                # optional: real test-network smoke run, about 0.5 C2FLR
```

The key is read only from `.env` (git-ignored) and never printed. The script stops without sending anything if there
is no key, the chain ID is not 114, or the balance is zero. `npm run deploy:local -w @beings/ledger` is a dry run on
the in-process network. See [`packages/ledger/README.md`](packages/ledger/README.md).

`.env` is git-ignored. Coston2: chain ID 114, RPC `https://coston2-api.flare.network/ext/C/rpc`. Test gas (C2FLR) comes
from the Flare faucet. Chain ID and RPC come from the election setup in the real system.

## What is implemented

`@beings/core` implements IC12 in full, see [`packages/core/README.md`](packages/core/README.md): canonical JSON,
SHA-256 and keccak, ballot codes, Merkle root and proof, EIP-712 signing and verification, JSON Schema validation,
tally with corrections, and reconciliation R1 to R6 as a failed-check bit mask. Test vectors are written to
`packages/core/test-vectors/` for cross-language checks.

`packages/ledger` implements the four contracts of design spec section 10, with Hardhat tests that check the
`@beings/core` test vectors (EIP-712 signatures, Merkle roots and proofs, reconciliation bit mask) through Solidity.

Items the documents leave open are implemented as **[PROPOSED]** defaults and listed in the core README. They need
confirmation before contracts or other modules rely on them.

## Notes and known issues

* **Spec example documents contain placeholder addresses and signatures** (not real signatures; one address is not EIP-55). The spec's record hash and tally examples **are** reproduced exactly by the code.
* Spec schema patterns allow choice ids `c0` and `c01`; the prose says `c1`, `c2`, ... The schemas are used unchanged; `electionFileProblems` adds the stricter check.
* The correction schema leaves `electionCode`, `from` and `to` as free strings; `correctionProblems` adds checks.
* `evmVersion` for the contracts is `london` (Flare's docs disagree: FAQ `london`, developer hub `cancun`). `london` works on Coston2: deployment and a smoke test succeeded. `cancun` is untested.
* The Python port of `@beings/core` (architecture doc section 9) is not started; it should be driven by `test-vectors/`.

## Conventions

* SHA-256 values: lowercase hex, no `0x`. keccak-256 values: `0x` plus lowercase hex.
* All JSON that is hashed or signed is canonicalised with RFC 8785 first.
* No PII anywhere in schemas or logs.

No license file is included; add one before publishing.
