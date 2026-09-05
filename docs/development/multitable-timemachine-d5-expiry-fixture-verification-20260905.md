# Time Machine D5 expiry fixture verification

Status: local gates PASS; publication and remote CI pending at this checkpoint.
The report-only commits do not change the tested code or extend runtime authority.

## Exact binding

- Base/sole code parent: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
- Code commit: `e98e171abe700ec460566bddf35f86fb866489a2`.
- Code tree: `b83cfa9e14369b50fe1c92580fffe927a3841a6d`.
- Test SHA-256: `0c2c10066e9d3d3d15a22b675a51d481f76b3e7a190666a916e4958916464fc6`.
- Code census: one integration test, 27 insertions and 11 deletions.
- Worktree: `/private/tmp/codex-tm-d5-expiry-fixture-hardening-20260905`.
- Evidence directory: `/private/tmp/tm_d5_fixture_evidence_20260905`.
- Original CI log: `/private/tmp/main70-node20-101240622471-20260905.log`.

The failed multitable CI step reported 260 files / 2716 tests passing, one failed
test, and two skips. No new remote result is claimed for the repaired code.

## Environment and migration

Used installed Node `20.20.2`, PostgreSQL `15.17`, and existing PNPM dependencies
through two links created only in the owned worktree. No install occurred.
The new database `tm_d5_fixture_20260905` used role `tm_d5_fixture_owner`, an
unused loopback port checked before startup, and newly initialized PGDATA at
`/private/tmp/tm_d5_fixture_pgdata_20260905`. Existing test rows retained their
random `tm_d5_` namespace inside that exclusively owned synthetic database.

Applied the complete configured CI migration stream: 389 ledger entries. The
same six legacy exclusions as `plugin-tests.yml` were passed to the migrator:
`008_plugin_infrastructure.sql`, `048_create_event_bus_tables.sql`,
`049_create_bpmn_workflow_tables.sql`, `042a_core_model_views.sql`,
`20250924140000_create_gantt_tables.ts`, `20250925_create_view_tables.sql`.
A second migration invocation returned successfully with no pending execution.
This is not proof of the unexcluded production migration stream.

## Results

| Gate | Result | Artifact in evidence directory |
|---|---|---|
| Original failed test, unmodified local baseline | 1 PASS; 19 unselected by name filter | `old-focused-baseline.log` |
| Original fixture, phase-aligned mint plus 1.1-second DB delay | RED; 388 ms before delay, exact binding true and token live false, service line 592 | `old-constrained-boundary-red.log` |
| Final fixture, same constrained condition | 1 PASS; 4391 ms before first delay and 3274 ms before second delay; both token-live checks true | `final-constrained-boundary-green.log` |
| Final fixture, expiry wait removed | RED: sweep returned 0 while the expired-plan assertion expected 1 | `final-expiry-wait-counterpart-red.log` |
| Restored expiry and prune focused tests | 2 PASS; 18 unselected by name filter | `final-focused-expiry-and-prune.log` |
| Complete owning integration suite | 20 PASS, zero skips; 31.40 s test time | `final-whole-suite.log` |
| Restore-plan and restore-jobs-list units, no DB environment | 2 files / 12 PASS | `neighbor-units.log` |
| Core `tsc --noEmit` | PASS; core configuration excludes integration test files | `core-typecheck.log` |
| Explicit owning-test ESLint | 0 errors / 0 warnings, matching base | `final-scoped-eslint.log`, `baseline-eslint.log` |
| Diff and production-byte checks | PASS; no production/config change | final handoff census |
| Residue audit | Zero fixture rows across 385 public tables; all 15 recovery tables empty; no other DB sessions | `residue-audit.json` |

The mutation changed only the test's wait. No production expiry guard was
modified. The test was restored byte-exact to the SHA-256 above before the final
whole-file run. No assertions were deleted, and no skips or retry mechanism were
added. `boundary-probe.patch` preserves the temporary diagnostic probe; it is
absent from the code commit.

Two intermediate repair failures are retained: assigning the microsecond DB
archive deadline directly to a millisecond plan bound violated the existing plan
constraint (`fixed-initial-deadline-precision-red.log`); the former ten-second
poll watchdog could stop before observing the new ten-second deadlines
(`fixed-initial-whole-poll-timeout-red.log`). Both were fixed within the test:
use the plan's exact resume bound and a separate fifteen-second watchdog.

## Commands

Run from the owned checkout with Node20 first on PATH and `DATABASE_URL` bound
only to a freshly created, exclusively owned synthetic database:

```sh
pnpm --filter @metasheet/core-backend db:migrate
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts --reporter=dot
```

The migration command used the six-item `MIGRATION_EXCLUDE` listed above and was
run twice. The focused commands additionally used `-t 'refuses archive expiry
with live jobs'`, `-t 'requires one exact prepared plan'`, or
`-t 'refuses archive expiry with live jobs|keeps legacy and held burns'`.

With DB variables unset:

```sh
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-restore-plan.test.ts \
  tests/unit/multitable-recovery-archive-restore-jobs-list.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend type-check
git diff --check
```

From `packages/core-backend`, lint explicitly includes the normally excluded
test without a typed project: `pnpm exec eslint --no-ignore --parser-options
'{"project":null}' tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts`.
Baseline lint used `git show <base>:<test>` through ESLint stdin with the same
filename and options. No ESLint or TypeScript configuration was edited.

## Independent review

Fresh Terra high read-only review covered exact range
`70dc72d7671cad9cea1925ed93f90d3d9c746aeb..97577a66e355ff733f9771829d8d1e8b6e24fecb`:
P1=0, P2=0, P3=0. It checked preservation of expiry, live-job, zero/partial-sweep,
retention, legal-hold, and legacy-burn oracles, the polling/test timeout budget,
and the documented remote-timing limitations. It ran no tests, made no writes,
and was closed after its terminal verdict. This is session-local review evidence,
not a GitHub approval or remote CI result.

The coordinator separately checked the original and fixed probe logs, original
test inventory equality, three-file scope, unchanged production bytes and existing
whole-file CI wiring. This report-only follow-up changes no tested code.

## Cleanup and limits

After the audit passed, PG15 was stopped normally, its listener was confirmed
absent, and only the owned PGDATA was removed. Both dependency links were removed.
The DB slot is released; logs and the audit/probe artifacts remain in the private
evidence directory. Remote CI of this D5 repair is NOT RUN at this checkpoint.
Existing/production/customer databases, external providers, KMS, staging,
real tenants, deployment, flags, dispatch, Ready, and PR merge were not exercised.
The published D8 checkout remains untouched; whole-sheet recovery is PARKED.
