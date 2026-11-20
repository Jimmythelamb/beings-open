# @beings/tabulation (M5: Tabulation and live results)

**Status: placeholder.** No code yet. This folder reserves the module's place in the monorepo.

## Purpose

Produce the tally: per-question V/B/O/U counts with corrections applied, the Merkle root and the reconciliation R1 to R6. Core already provides `tallyQuestions`, `reconcile`, `buildTallyFile` and `merkleRootOfEntries`; this package adds the CLI (`beings tally`, `beings post-tally`), chain reads, and the optional live view.

## Depends on

`@beings/core` (M7) for hashing, canonical JSON, schemas, signing, Merkle and reconciliation. Do not re-implement those here.

## Suggested stack

TypeScript on `@beings/core`; static page for the live view; optional Python cross-check of `reconcile` using the core test vectors.

## Where to read more

* Architecture: `docs/beings-architecture.md`, Section 7 (M5)
* Design spec: `docs/beings-design-spec.md`
* Interface contracts: section 12 (IC list)
