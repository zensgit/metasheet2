# Time Machine Recovery Actor Authority Verification

## Immutable Target

- Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.
- Code/design commit: `a56f3d6432ce11e452132ce980328cd5702d9b39`.
- Code/design tree: `5d61b02ef4f6c1139557e2142d7b4cdc7f9029d3`.
- Branch: `codex/timemachine-recovery-actor-authority-20260915`.
- Bounded scope: one production resolver, one new unit suite, two new cases in an
  existing real-DB route suite, and the design/verification reports.
- This report is a documentation-only child of the code target; it does not claim
  remote exact-head CI, merged-main verification, browser login, UAT or deployment.

## Defect and Fix

Before the fix, the database-fresh loader returned an inactive/disabled account's
identity with empty global permissions. A surviving explicit sheet-admin grant
could then restore its capabilities. Two production-route/real-PG cases proved
that execute returned 200 after either `is_active=false` or `role='disabled'`.

The loader now removes the invalid access identity. The canonical database-side
sheet resolver refuses before grant composition; the HTTP wrapper retains the
request identity only for the existing denied-response shape, with every capability
false. Active-account sheet grants and request/database capability intersection
remain intact. The request-independent resolver is consumed by the HTTP wrapper,
not a dormant alternate authorization implementation.

Both new cases prove an active preview, surviving sheet-admin grant, 403 after
deactivation, unchanged record data/version, zero token burns, and successful
same-token execution after reactivation. No permissions or recovery semantics are
added. The helper alone is not full-read, row/field/link/person or worker authority.

## Local Gates

| Gate | Result |
| --- | --- |
| New resolver unit suite | 22/22 |
| Exact-anchor unit neighbor | 44/44 |
| Archive database wiring unit neighbor | 1/1 |
| Attendance cleaning unit neighbor | 10/10 |
| Exact-anchor production-route real DB | 30/30 |
| Recovery authority stability real DB | 13/13, including one non-DB sentinel |
| Attendance cleaning authority real DB | 30/30 in its own disposable database |
| Fresh migration and second replay | 396 entries; second run no-op |
| Core typecheck | PASS |
| New unit explicit-project typecheck | PASS |
| Production source and new unit explicit ESLint | PASS, zero errors/warnings |
| `git diff --check` | PASS |

Database gates ran serially on a dedicated PostgreSQL 15.17 instance. The recovery
route uses a synthetic Express test principal, real production authorization and
real recovery transactions; it is not authentication/login/browser acceptance.
The attendance neighbor owns a minimal fixture schema, not a second full migration
proof. No shared database, real tenant or external service was used.

Commands from the candidate root:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/recovery-actor-authority.test.ts tests/unit/multitable-exact-anchor-recovery-route.test.ts tests/unit/univer-meta-recovery-archive-database-wiring.test.ts tests/unit/attendance-report-cleaning-proposal.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-recovery-authority-stability-realdb.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-report-cleaning-proposal.db.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend run type-check
```

The recovery runs used the dedicated `DATABASE_URL` and
`METASHEET_REAL_DB_TEST_STEP=1`; the attendance neighbor used only its dedicated
`ATTENDANCE_TEST_DATABASE_URL`. Fresh/replay used the existing workflow migration
exclusions, not a new exclusion. Dependencies were reused through local symlinks;
the attendance CJS unit required temporary `NODE_PATH` to the already-installed
core dependency directory. There was no installation or dependency-file change.

Initial local harness corrections are not product failures: Vitest 1.6 does not
support `toHaveBeenCalledExactlyOnceWith`, replaced by count plus argument assertions;
the first temporary typecheck project accidentally included unrelated historical
tests, corrected to preserve core exclusions and explicitly include the new test.
All final gates above ran after these corrections. The existing integration test
is excluded by the repository's normal ESLint configuration; no ignored-file lint
result is counted as a lint pass.

## Discriminating Mutations

1. Restore the invalid account's nonempty identity: both new real-DB cases fail
   precisely with actual 200 versus expected 403. This also reproduces the original
   pre-fix RED. Restore: both cases and the full 30-test route suite pass.
2. Replace HTTP request/database capability intersection with database capabilities:
   all 11 per-capability request-ceiling cases fail. Restore: the unit matrix passes.

Both mutations were uncommitted. Restored production SHA-256:
`20ce135b5847913a6045797d1a30d18d25e58d6a660f9d63198ed99083e93d02`.

## CI and Runtime Boundaries

The new unit is discovered by the existing default backend Vitest run in
`plugin-tests.yml`. Both recovery real-DB suites already have exact no-DB exclusions
and whole-file post-migrate arguments in that workflow. No workflow, selector,
provenance pin, migration, shared permission service or feature flag was edited.
Remote collection/results must be verified on the published exact head separately.

Cleanup census: recovery fixture users/sheets/records/grants = 0; authority-neighbor
users = 0; attendance scratch databases = 0; database backends = 0. The outer database
was dropped, and the isolated PostgreSQL process was stopped with no port response.

Independent Sol high read-only review completed on the exact base-to-code range:
P1=0 / P2=0 / P3=0. It inspected invalid-actor exclusion, the request ceiling, HTTP
denial shape, real-DB test oracles and the attendance cleaning caller. No reviewer
tests, DB or edits were performed; the verdict is session-local, not a remote CI
artifact. The review session was closed after its terminal report.

This is one authorization repair, not Time Machine
completion or full production archive-worker composition. Whole-sheet hard-delete
resurrection, provider rollout, flags, dispatch, staging, deployment and production
remain outside this slice. Ready/merge requires separate authorization.
