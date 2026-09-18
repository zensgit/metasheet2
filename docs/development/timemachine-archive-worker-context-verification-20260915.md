# Time Machine Archive Worker Identity Verification

## Exact Scope

- Baseline: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.
- Verified code commit: `e55d549760dd34285c055c57254abf719e0c791b`.
- Code checkpoint tree: `a8764a38bcd9600bf79f6d92f40d3e639bf352ef`.
- Branch: `codex/timemachine-archive-worker-context-20260915`.
- Scope: one async-facade source, its unit test, the existing restore-job real-DB test,
  and the design/verification documents. No migration, workflow, provider, flag, or UI edit.
- This report is a docs-only descendant of the verified code commit. It does not claim that
  the final publication commit has already passed remote CI.

## Local Gates

| Gate | Result |
| --- | --- |
| Old facade with strengthened identity assertion | RED: authority callback lacked job/workspace/base |
| Async facade unit | 10/10 PASS |
| Async facade/plan, worker, application, server wiring | 5 files, 51/51 PASS |
| Core `type-check` | PASS |
| Source ESLint | PASS |
| Existing archive CI wiring and armed-no-DB refusal guards | 7/7 PASS |
| Fresh isolated PostgreSQL 15 migration | 396 applied; second replay no-op |
| Restore-job real-DB whole file | 20/20 PASS, zero skips; includes one harness sentinel |
| `git diff --check` | PASS |

The fresh migration uses the exact Plugin System Tests exclusions, not an unfiltered stream:
`008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql`.

Commands, with `DATABASE_URL` pointing only to the disposable local database:

```sh
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-async-restore.test.ts \
  tests/unit/multitable-recovery-archive-async-plan.test.ts \
  tests/unit/multitable-recovery-archive-restore-worker.test.ts \
  tests/unit/multitable-recovery-archive-application.test.ts \
  tests/unit/metasheet-recovery-archive-wiring.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend run type-check
pnpm --filter @metasheet/core-backend exec eslint src/multitable/recovery-archive-async-restore.ts
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs \
  scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
pnpm --filter @metasheet/core-backend db:migrate
METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts --reporter=dot
```

## Discriminating Mutations

Each mutation ran independently and was restored before the final 51-test and real-DB runs.

| Mutation | RED evidence |
| --- | --- |
| Omit preliminary-read identity | 2 failures: propagation and concurrent jobs |
| Omit stabilization identity | 1 callback-argument failure |
| Omit final locked-read identity | 1 callback-argument failure |
| Omit projected authorization identity | 1 callback-argument failure |
| Omit mutation-hook identity | 1 callback-argument failure |
| Omit archive-materialization authority identity | 1 first authority-call failure |
| Omit transactional authority identity | 1 second authority-call failure |
| Remove identity freezing | 2 frozen-object failures |
| Remove binding/claim identity check | 2 failures, including archive-plan read occurring before refusal |
| Remove runner identity comparison | 3 failures: wrong job/sheet/actor reached a second authority call |

Restored source SHA-256:
`1b63ea8e7b0f90698286d171f2a19192f3146f8b020fe507187d660f7e9cb3ef`.
Unit SHA-256: `84556845c23866035b81683cec3e386d80347eeba2272f56480388df68e2d8a8`.
Real-DB test SHA-256: `10e4a9dc6b677ba884f42ef9c59928ce87031275ec6d08b52edab7a48d6b2c8a`.

## Real-DB Evidence and Cleanup

The existing encrypted reset/revert facade cases now assert the exact immutable identity in
coarse authorization, preliminary read, stabilization, final locked read, projected write
authorization, and mutation notification. The existing 5,001-record disappearance/reclaimer
case checks durable progress, the stale claimant's refusal, and exactly-once restoration.
This is an in-process lease-expiry simulation, not a separately killed/restarted process.

Post-suite independent counts: fixture sheets=0, bases=0, archive keys=0, jobs=0,
other database backends=0. Disposable database dropped; matching database prefix=0 and
matching database backends=0. Isolated PostgreSQL stopped; `pg_ctl status` reports no server.
No existing service, customer database, or real tenant was used.

## CI Ownership and Review

The unit suite is collected by the existing default core test lane. The real-DB suite is
explicitly excluded from that lane and explicitly invoked whole-file in the post-migration
`multitable-real-db-integration` step with `METASHEET_REAL_DB_TEST_STEP=1`.
The two-point guard and fail-not-skip guard passed; no selector edits were necessary.

Terra supplied the read-only CI/bootstrap audit; it is not a code-approval verdict.
Sol high completed an independent read-only review of immutable code commit
`e55d549760dd34285c055c57254abf719e0c791b` against the stated baseline:
P1=0, P2=0, P3=0. It checked identity isolation, early/late authority, stale-claim
protection, callback arguments/returns/errors, and optional mutation-hook behavior.
The reviewer ran no tests and made no file/ref changes; its session is closed.
This is session-local review evidence, not a remote review artifact or a claim that
the real production authorization adapters are installed.
Remote exact-head CI, Ready, merge, and deployment remain separate gates.

## Remaining Goal Work

This closes callback identity propagation, not archive operational readiness. Real production
authorization adapters, standard startup composition, object/key providers, true process
restart acceptance, and controlled runtime enablement are not proved by this slice. Adapters
can still ignore arguments; the added context is not a substitute for policy implementation.
No permission expansion, hard-deleted whole-table resurrection, flag enablement, dispatch,
staging, deployment, or production action is authorized by these results.
