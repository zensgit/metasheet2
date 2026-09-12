# Approval K6 and Lock-4 Candidate Verification Report

**Status:** Candidate evidence only. “Pass” below never means merged-main, flag-enabled, staged, or deployed.

## Evidence Matrix

| Candidate | Gate | Result | Scope |
| --- | --- | --- |
| K6 | Focused unit suite | PASS, 246 tests | Sequential helper, graph executor, and product-service neighbors. |
| K6 | Fresh PostgreSQL 15 | PASS, 10 tests | `approval-sequential-mode.db.test.ts`; scratch database removed after a zero-residue census. |
| K6 | Type check | PASS | `pnpm --filter @metasheet/core-backend type-check`. |
| K6 | Lint and diff check | PASS with three pre-existing unused-import warnings in `ApprovalProductService.ts`; no lint errors | K6 production/test paths. |
| K6 | Mutation | PASS | Allowing mixed queue/non-queue metadata made the matching unit negative fail; the guard was restored. |
| K6 | Independent refute-first review | CLEAR | Grok review of exact `f1f8b49c...` reported no P1/P2/P3 finding. |
| K6 | Exact-head GitHub CI | PASS, 56 success, 0 pending, 0 failed, 1 intentional skip | PR #5392 head `f1f8b49c...`; includes Node 18/20, PG15/16 sequential, approval browser, and required web gates. |
| F4-E | Focused unit suite | PASS, 33 tests | Departure dispatch and directory-org contexts. |
| F4-E | Fresh PostgreSQL 15 | PASS, 31 tests | Directory orchestration fault injection plus departure writer suite; scratch database removed after zero residue. |
| F4-E | Type check, lint, diff check | PASS | No type or lint errors; same pre-existing unused-import warnings noted above. |
| F4-E | Mutation | PASS | Re-throwing a post-commit invitation-ledger fault made exactly the hostile-invite orchestration test fail; restoring isolation returned the suite green. |
| F4-E | Refute-first review | PASS, 0 P1/P2 | Verified committed boundary, dispatch ordering, values-free warning data, and completed-run preservation. Current main carries the same tested behavior through #5368, not the standalone candidate commit. |

## Discriminating F4-E Oracle

The PostgreSQL fault-injection case creates a trigger that rejects one auto-admission invite after the directory transaction commits. Its green oracle requires all of the following:

1. The sync call returns a completed run with no error message.
2. F4-E invokes exactly one departure transfer for the departed user and resolved manager.
3. The durable `user_changed` effect and reassignment record exist.
4. The invite row is absent, while the admitted user remains active.
5. The warning meta is the fixed `invite_ledger_failed` reason and contains none of the injected hostile values.

The mutation that rethrows the invite exception makes the exact oracle fail at the sync call. This proves the test is not merely observing the final database state.

## Current Integration State

| Fact | Evidence |
| --- | --- |
| K6 is a clean Draft PR | #5392 head `f1f8b49c...`, auto-merge unset. |
| K6 is not current-main merge evidence | Its PR base is `25635e67...`; current documented main is `08d24517...`. |
| F4-E behavior is on current main | #5368 `21932d08...` contains the committed boundary, invitation isolation, and hostile-invite real-DB oracle. The standalone `da359...` evidence commit is not a main ancestor and needs no separate replay. |
| Flags and operational actions | No new flag; no dispatch, staging, deployment, production, or UAT action occurred. |

## Replay Acceptance

Before K6 can move beyond Draft/HOLD, its replay head must prove:

1. Ordered parents and range-diff preserve the original candidate delta.
2. Its changed-file census remains within the documented candidate scope plus any mechanically required current-main union.
3. The relevant focused unit, fresh PostgreSQL, mutation, type/lint/diff, and exact-head CI gates are rerun successfully.
4. Main did not drift between replay preflight and any authorized publication.
5. Ready, merge, feature enablement, dispatch, deployment, and production remain distinct owner actions.
