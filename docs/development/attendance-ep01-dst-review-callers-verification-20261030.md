# EP01 DST review callers verification — Draft/HOLD

Source base: `fc914ccb6fe5ec628f184ea0ea71d55c79be1a4e`. Branch: `codex/attendance-ep01-dst-review-callers-20261030`.

This test supplement follows the [DST lock](attendance-ep01-dst-ready-callers-design-lock-20261028.md) and retains the original five-caller EP01 denominator. Four paths change relative to the source base: one new helper, two registration/export edits, and this note. Compared with main, the PR also retains the unmerged #6630 source composition.

## Behavior and scope

Exactly two new cases exercise four public live punches, bounded overtime creation/final approval, and ordinary frozen-prior recompute refusal:

| Actual expanded ID | Live and OT calculation reason | Local native result |
|---|---|---|
| `EP01_DST_REVIEW_CALLERS_'gap'` | `dst_gap_local_time` | passed |
| `EP01_DST_REVIEW_CALLERS_'shared_fold'` | `dst_fold_shared_boundary_ambiguous` | passed |

Each case checks four cumulative live review calculations and a fifth OT review calculation, literal frozen identity/context/evidence, independent terminal approval binding, and immutable prior history. The four original physical punch rows survive; one separate route-owned adjustment audit event is asserted independently. Parent equality includes metadata and timestamps.

The calculation remains `review_required`, with a null current pointer, null calculation projection and no children. Its operation can complete while the parent stays a retired review placeholder. Ordinary recompute returns 409 `ATTENDANCE_RECORD_RETIRED`; complete rows in 12 named organization-scoped business tables remain unchanged. This is a bounded table snapshot.

The original 52 cases, helpers and budgets are byte-preserved. Existing integration-file wiring registers the two new cases, giving an expected whole-file denominator of 54. Local selection executed only the new two; the other 52 were filtered and receive no pass credit.

## Source invariants

- `plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs`, `prepareLivePunch` (~L300): outer boundaries are unique; only an internal segment boundary is gap/shared-fold.
- `packages/core-backend/src/attendance/w4c1-segment-calculator.ts`, `resolveAnchors` (~L786/~L801): distinct typed review reasons, empty segments and null daily projection. Persisted literal assertions are independent of the additional calculator replay.
- `w4c2-authoritative-calculation-core.ts`, `writeReviewRow` (~L782): authoritative review stores an empty segment snapshot while its context retains both definitions. Shadow/completed-row shapes are different.
- `w4c3b-approved-overtime-shadow.ts`, `readNonCurrentApprovedOvertimeInputsV1` (~L142): hidden review history is read without fabricating a current pointer or completed prior.
- `plugins/plugin-attendance/index.cjs`, final adjustment audit block (~L40126/~L40161): the separate adjustment event is not a physical punch.

The reused online fixture controls its module-local historical ingress instant and restores it in `finally`; it does not replace global Date. Resolution timestamps are bounded by the real request clock. Existing fixture cleanup removes the synthetic actor's authority while retaining referenced history; the new cases restore their environment entries.

## Executed validation

```bash
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts \
  -t EP01_DST_REVIEW_CALLERS_ --retry=0
```

Actual assertion results: **2 passed, 52 filtered**. Two values-free receipts were emitted after business assertions, fixture cleanup and environment restoration.

Each temporary one-branch source fault replaced the respective calculator reason with the existing valid `context_mismatch` reason. Each exact quoted ID above produced **1 matching failed, 53 filtered**, at `EP01_DST_REVIEW_LIVE_TYPED_REASON`. Both original source bytes were restored. These shared-calculator faults prove the live typed-reason oracle; they are not separate OT per-caller mutation proofs. No restored-green run or original 52-case run was added.

Focused lint introduced no diagnostic. Both existing files retain their configured project-inclusion diagnostic; AST lint retains the original integration-file warnings, and the new helper has zero errors/warnings. Focused test-root project-options type diagnostics are **8/8**, transitive **331/331**, baseline/candidate; introduced **0**. This is not a fresh workspace-wide validation claim.

The owned fixture database ledger was observed at 453; no migration was applied. Both owned PG starts ended with stop exit 0, closed port and retained data. The post-green observer was handed off before any fault to correct unquoted selectors. An initial fault continuation stopped before PG/tests on an existing-log collision. Those harness histories remain saved; completed green cases were reused.

Authoritative artifact: `actual-native-dst-review-callers-and-reason-fault-audit.json`, SHA-256 `14023148110041f19b7ea6cecb1999a8ce7c47e95b218a16b301fd827829039a`. It binds physical raw lines including LF, actual leaf statuses, source hashes, cleanup and harness histories. Code/runtime bytes match the tested candidate; this note was finalized afterward.

## Remaining gates

| Gate | State |
|---|---|
| Two finite live/OT native review cases | Passed; original 52 filtered |
| Two shared-calculator reason faults | Matching live-oracle failures; exact restoration |
| Main independent source/raw audit and focused quality | Qualified; no introduced diagnostic |
| Current-head required CI and whole-file 54 | Pending |
| Fifth correction caller, CALC14 and full five-caller EP01 | Open |
| Real JWT/RBAC, Redis/provider/live and owner/manual/business acceptance | Separate, unproven |

Draft/HOLD remains in force. This delta changes test sources and verification only. Runtime, migrations, workflows, configuration, dependencies and default flags retain source-base bytes. It does not authorize merge, target installation, deployment, R71 changes or external sends.
