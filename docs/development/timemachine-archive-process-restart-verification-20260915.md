# Time Machine Archive Process Restart Verification

## Exact Scope

- Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.
- Initial code: `1f2057881f3e36c708d246d38f8dec2dcce6c402`.
- Final code: `9a2bf1f5d4c9bd37c0f8314568b6513f71cd86a8`.
- Final code tree: `99ea785d712590d1160ae1e1ae2f00ce9be701df`.
- Branch: `codex/timemachine-archive-process-restart-20260915`.
- Code scope: one existing real-DB test, two test fixture helpers, and the design MD.
- This verification MD is a subsequent docs-only commit, not a different code candidate.
- No production source, migration, workflow, runtime flag, or restore semantics changed.

## Local Gates

Local runtime was Node 24.14.1 and PostgreSQL 15.17. Node 18/20 remote results are separate.

| Gate | Result |
| --- | --- |
| Fresh isolated migration using the existing Plugin System Tests exclusions | 396 applied |
| Second migration invocation | PASS, no-op; ledger remains 396 |
| Complete restore-job real-DB file | 22/22 PASS, zero skipped, 98.00 seconds total |
| Real SIGKILL cases within that file | 2/2 PASS; each restores 5,001 records exactly once |
| Archive CI wiring and armed no-DB fail-not-skip contracts | 7/7 PASS |
| Core backend typecheck | PASS |
| Explicit fixture-helper TypeScript program | PASS |
| Three changed test files, ESLint with explicit test project | PASS, zero errors/warnings |
| Diff whitespace check and restored source equivalence | PASS |

The 22-test total includes the existing real-DB harness sentinel. Earlier filtered runs
had 20/21 unselected tests and are not counted as full-suite evidence.

Commands, with a disposable connection supplied in the test environment:

```sh
pnpm --filter @metasheet/core-backend db:migrate
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts --reporter=dot
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs \
  scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
pnpm --filter @metasheet/core-backend run type-check
git diff --check
```

The core TSConfig excludes test files. A temporary no-emit config kept the production
src/core/types includes and exclusions, then explicitly included both changed fixture
helpers. ESLint used a temporary extension adding the integration file as an explicit
file and `--no-ignore --parser-options` for that project. The normal lint command ignores
the integration file and excludes helpers from its TSConfig; those diagnostics are not
counted as a lint pass. No shared TSConfig or lint configuration was edited.

## Discriminating Evidence

1. Commit inside the before-COMMIT barrier before killing the child: one selected test
   failed because archived data/version 3 appeared instead of original live data/version 2.
2. Let the replacement worker execute with the serialized old claim instead of its own
   canonical new claim: one selected test failed with `RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT`.
3. Add one second to the child-reported lease: one selected test failed on the exact
   database lease comparison. The restored test reads the durable lease, owner and fence,
   proves the lease is live and the job is not prematurely selectable, and waits on the DB deadline.

All mutations were restored before the final 22/22 run. A preliminary direct lease-shortening
fixture mutation was rejected by the existing database CAS guard (`55000`); it is not counted
as the new lease-observation oracle. Production source was never mutated in this slice.

Before-COMMIT crash leaves zero committed progress, receipts and restore revisions.
After-COMMIT/missing-ack crash leaves exactly one committed first-chunk effect.
Each replacement is a new PID with its own PG connection and canonical fresh claim;
the block fence is preserved and the worker fence increases. Final evidence contains
two committed chunks, completed count 5,001, exactly one restore revision for every
record, and a released writer block. The existing in-process branded stale-claim
`LEASE_LOST` negative remains; serialized snapshots cannot bypass process-local branding.

## Review and Cleanup

Terra high reviewed the initial immutable candidate and found one P2 in lease-evidence
independence. The follow-up code commit closed it. Fresh exact-code closure review:
P1=0, P2=0, P3=0. Both review sessions were read-only and closed. Review evidence is
session-local, not a remote GitHub approval or a full runtime security certification.

After the full suite: synthetic sheets=0, bases=0, keys=0, jobs=0, DB backends=0.
The disposable DB was dropped; exact/prefix DB count and backends were both zero.
The dedicated PG server was stopped. Child exit/connection drainage is asserted in
each process run; object directories are removed by the existing fixture finally blocks.
Only this task's isolated database and processes were used. No customer data or service
was contacted, and no staging or production operation occurred.

## CI and Remaining Boundaries

The existing D5 whole-file test is already in the post-migration backend CI roster and
excluded from the no-DB lane. The new cases therefore require no selector/workflow edit;
the 7/7 wiring gates independently pin this ownership. Remote exact-head CI is PENDING
at publication and must be read back from the Draft PR; local results do not replace it.

The object service survives in the parent as a read-only IPC fixture using the existing
encrypted local provider. Keys and allow-all authorization are synthetic fixtures. This
does not prove object-store service restart, durable provider metadata, real KMS, real
authorization, startup composition, staging or tenant UAT. Those remain separate work.
PR #5727 also adds tests in the same existing real-DB file: future integration must preserve
both test sets, not replace one with an entire older file. Neither PR is merged by this slice.
Whole-sheet hard-delete resurrection, feature enablement, dispatch and deployment remain excluded.
