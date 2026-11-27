# Canonical split-day and overnight proof verification — Draft/HOLD

Refs #4556. Base: b9bccade372e0bf339df2ea66211fb0e20d58861.
This is a test-only delivery for existing parent §7.2 CALC01/02/04 clauses. It does not ratify or close the parent/W8/owner gates.

## Actual positive execution

The existing registered HTTP/PG file received two named cases. A scoped run executed **2 passed, 24 filtered**, exit0. Three receipt phases are assertion groups within those two cases, not three Vitest tests.

| Clause/phase | Actual observations |
|---|---|
| CALC02 | Explicit08–12/13–17; three real HTTP punches200; native current authoritative calculation, morning normal240, afternoon missing_check_out0, partial daily240. |
| CALC01 phase in same case | Fourth real checkout200; normal240+240/daily480; same daily parent and new current calculation; full prior calculation and all prior children unchanged. |
| CALC04 | Explicit21–06+1, assignment only on origin day; two real punches200, source events/context/attribution/canonical replay/native daily record retain origin day, one parent and zero next-day parents, one normal540 segment. |

The affected existing pure overnight test executed **1 passed, 75 filtered**, exit0, with two added originating workDate/timezone assertions. Other green tests were not rerun. All original24 integration cases/hooks/budgets and all prior pure test bytes reconstruct exactly after removing the additions.

HTTP response fields are checked against the actual persisted row. Canonical replay invokes the real calculator using committed HTTP-produced native attribution/context/evidence/fact snapshots, with exact current parent/pointer/child/event assertions in the same case. It is a fresh replay, **not capture of the original in-flight return**. Existing RBAC_BYPASS fixture posture remains; this is **not a real-auth/RBAC proof**.

## Matching negative controls

| Scoped mutation, restored exactly | Actual failure |
|---|---|
| Afternoon missing-out becomes missing-in |1 matching failed,25 filtered; exact afternoon status/reason tuple changes.|
| Replace segment-sum daily minutes with first-in/last-out span |1 matching failed,25 filtered; canonical replay540 versus expected480.|
| Overnight canonical projection uses next day |1 matching failed,25 filtered; canonical replay next day versus origin day.|
| Same date mutation, affected existing pure overnight |1 matching failed,75 filtered; next-day workDate versus expected origin workDate.|

No filtered item counts as passing. The date mutation failure proves the canonical replay discriminator; it does not claim a wrong-date parent was persisted. Production calculator bytes were restored to HEAD after each mutation and finally. No product change is included.

## Harness history and scope preservation

Initial future-dated fixtures failed at existing FUTURE_PUNCH_NOT_ALLOWED before calculation. Only the new scenarios use historical synthetic dates; the refusal guard is unchanged. Main inverse-byte audit caught four original date literals touched by a broad intermediate replacement and restored those excluded original fixtures exactly. Selected passing/new mutation bodies remain byte-identical; no green rerun was made for a receipt. Original failed attempts remain in evidence.

A fresh isolated UTF8 database applied458 migrations, pending0; later phases reused the same ledger without rerunning migrations. Each controller stopped only the cluster it started with unchanged PID, closed the owned port and retained data.

Evidence names: positive-v1/2/3-state.json; mutation-v1-state.json; main-independent-mutation-audit.json; main-original-bytes-and-source-scope-audit.json; quality-v1-state.json; independent-source-review.json; candidate-final-source-manifest.json.

## Gates

| Gate | State |
|---|---|
| P1 source/scope | PASS: fresh main, isolated copy, original bytes preserved, tests/docs only. |
| P2 positive | PASS: two new HTTP/PG plus one affected pure case, staged counts above. |
| P3 mutation | PASS: three scoped mutation groups;4 actual matching failures across4 selected invocations; exact restore. |
| P4 quality/review | PASS: explicit changed-test lint current/baseline each0errors and3existingwarnings (introduced0); actual pnpm validate:all exit0; source-only independent review found no confirmed P1/P2. Main audited actual named results and raw matching diffs. |
| P5 Draft/current-head CI | PENDING: new exact head must finish required CI and actually execute registered whole files before final evidence. |

Correction/OT canonical approval bridge and replacement/missing-boundary protocol are not implemented here. No schema/API/workflow/dependency/feature-flag/runtime changes, merge, deployment, R71/tag/release or business-config edits. Stream/lifecycle OFF; real UAT/50004 excluded; historical08PUT INCONCLUSIVE. Human/owner/manual/staging/performance/live acceptance remains separate.
