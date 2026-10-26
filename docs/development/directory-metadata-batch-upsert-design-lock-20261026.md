# Directory metadata batch upsert — Draft design lock

Status: Draft/HOLD. Base `bcd879f1b5efc23bcf5346c42224bc59801ad724`. Refs DT-PERF-01 in the DingTalk integrated roadmap §7.7.

The existing sync already batches account-department relations, but still issues one metadata upsert per department and account. This slice batches only those two metadata phases. It does not claim the 2000-user staging runtime target or switch the remote user-list/detail contract.

## Locked behavior

- Keep original column lists, VALUES expressions, conflict targets/assignments, provider/corp/integration scope, openId CASE and JSON normalization identical. Represent each statement as trusted static prefix/row/tail parts; render the same scalar statement for the existing openId SQL proof and each actual one-row batch. No general SQL parser or caller-supplied SQL.
- Fixed maximum 500 rows per metadata statement: at most 8000 bind parameters for the 16-column account values, safely below the PostgreSQL parameter limit. Shift only numbered bind markers within the trusted row template. No configurable limit or new dependency.
- Canonical input maps are already deduplicated by the existing pull logic. Keep their order; do not add speculative duplicate-policy behavior. Empty input issues no SQL. Actual created rows are those whose returned `created` is exactly true; remaining input rows count updated, retaining the old defensive false/empty-result behavior.
- Existing transaction owns all chunks. No BEGIN/COMMIT/ROLLBACK, savepoint, retry, lock, permission, identity/link/rehire/deprovision, membership/group projection, state-machine, provider request, flag or env behavior is added/changed. Failure in any chunk propagates to the existing whole-apply rollback.
- Source stays in a sibling module; do not grow the sync mega-file. Retain the existing test SQL accessor by deriving its scalar SQL from the same trusted parts used by actual batching; it must not become a dead legacy SQL probe.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| G1 production-call baseline | Real sync with fully mocked provider and native PostgreSQL observation: multiple departments/accounts are currently multiple metadata INSERTs; matching expected batch-count assertions must fail before runtime wiring. |
| G2 SQL/bind semantics | Actual native-PG cold/update/empty/multi-chunk cases; correct parameter shifting, IDs/metadata/raw/last-seen, same-person openId retention and changed/null union/corp clearing, explicit new openId precedence. Whole exact result/row shapes. |
| G3 scope/atomicity | Second-integration isolation; a later chunk failure followed by caller rollback leaves no prior chunk writes; helper never owns transaction completion. |
| G4 production integration | Original orchestration passes batch-count and created/updated/repeat/stale behavior assertions; affected existing openId, primary-department, preview/apply, lease and freeze neighbors remain applicable and execute when affected. |
| G5 matching mutation | Neuter one actual semantic guard or batching behavior, require matching named red, restore exact bytes; no assertion/budget relaxation. |
| G6 quality/CI | Explicit changed-file lint and validate:all, real-DB two-point registration/strict corpus where a new DB file is added; current-head required CI success with actual named targets; exact source/HEAD/clean and final PR body readback. |

All PRs remain Draft. No merge, deploy, R71/tag/release, real provider/customer access or business configuration changes. Stream/lifecycle OFF; real UAT and business50004 excluded. Historical08PUT remains INCONCLUSIVE. This Draft has no owner/parent/W8/staging acceptance effect.
