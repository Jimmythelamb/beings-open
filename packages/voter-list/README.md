# @beings/voter-list (M1: Voter list)

**Status: placeholder.** No code yet. This folder reserves the module's place in the monorepo.

## Purpose

Registered-voter count and check-in counts (issued, unused returned) for the election, with no identities on the public record. Produces the counts that tabulation uses for reconciliation (`checkin-counts`).

## Depends on

`@beings/core` (M7) for hashing, canonical JSON, schemas, signing, Merkle and reconciliation. Do not re-implement those here.

## Suggested stack

See architecture doc section 3.

## Where to read more

* Architecture: `docs/beings-architecture.md`, Section 3 (M1)
* Design spec: `docs/beings-design-spec.md`
* Interface contracts: see section 12 (IC list) in the architecture doc
