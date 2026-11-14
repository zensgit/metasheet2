# Attendance correction fact pair design lock — 2026-10-27

Refs #4556. Bounded correction of the existing W4 pure calculator closed fact contract. Draft/HOLD; no merge/deploy, R71, Stream/lifecycle, real UAT or business 50004 changes.

## Existing contract and problem

The W4 approved correction fact has one direction and an exact superseded evidence ref. The existing request payload accepts requestedInAt and requestedOutAt in one time_correction request. Two already-resolved directional correction facts from the same immutable request/approval are currently rejected solely by kind+requestId deduplication.

This slice consumes already-resolved closed correction facts. It does not create a new request target protocol, select replacement events, insert missing punches, bridge final approvals to canonical writes, or establish target/cell semantics. That separate human question remains pending.

## Required behavior

- A correction request may contribute at most one check_in fact and one check_out fact.
- Both facts must have identical requestSnapshotVersion, requestSnapshotFingerprint, approvalVersion and approvalRecordId.
- Duplicate same-direction facts and any mixed binding remain input_schema_invalid, with the exact existing review shape.
- Other fact kinds retain the existing kind+requestId cardinality; all exact-key/type validation stays intact.
- Existing exact superseded evidence and adjustment matching rules remain intact. No new field, enum, flag, schema or public API.
- Fact ordering and fingerprint behavior must be audited; add a minimal regression only if the existing implementation already claims order invariance. Do not silently expand scope.

## Gates

| Gate | Required actual evidence |
|---|---|
| G1 | Same-request two-direction valid fact reproduction fails on original runtime, with a real existing one-direction control passing. |
| G2 | Corrected full calculator file and one relevant fingerprint/neighbor file pass, actual assertion statuses; filtered/todo/skip excluded. |
| G3 | Each of the four binding fields has a mismatched-pair negative; duplicate same-direction remains rejected; other fact kind cardinality stays rejected. |
| G4 | Remove directional allowance or binding guard, corresponding named tests turn red; exact source restoration. |
| G5 | Focused lint and production validation, independent source review, source/head/clean manifest. |
| G6 | Draft PR exact-head required CI terminal success and actual named calculator execution; precise PR body/readback. |

Unchanged successful suites are not replayed merely to repair receipts. Local staged evidence and current-head CI are reported separately.

## Shared-boundary sorting constraint

A real adjacent-segment case (09–12 and12–18) admits a correction out and in at the same12:00 instant with one immutable approval. Candidate calculator accepts and calculates the two segments, while the previous comparator leaves those two facts tied and reversal changes the semantic fingerprint (actual matching red). Extend only the final complete tie for correction facts with the existing direction discriminator. All earlier tuple keys, other kinds, field validation, domains and golden fingerprints for prior valid inputs remain unchanged. No target/ref is invented. A matching comparator-reversion mutation and existing fingerprint tests must pass.

## Exact-identity compatibility boundary

Review found that localeCompare can tie canonically equivalent but byte-distinct request IDs; those separate requests were accepted by the original calculator. Actual new regression fails on the initial candidate and passes with both original runtime modules. Therefore the direction fallback additionally requires exact requestId, requestSnapshotFingerprint and approvalRecordId equality; numeric snapshot/approval versions already compare by exact numeric value. Canonical Unicode equivalence is not shared request identity. Preserve the original ordering for distinct request IDs, including non-UUID strings accepted by the pure function; no production UUID reachability claim.
