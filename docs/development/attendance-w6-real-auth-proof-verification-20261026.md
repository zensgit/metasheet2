# W6 real-authentication proof verification — 2026-10-26

Status: local evidence supplement; Draft/HOLD. Published-head required CI is pending and is not replaced by these results. Base: `40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b`. No runtime, permission, schema, public contract or feature-flag change.

## Named proof and result

The new `attendance-w6-real-auth.db.test.ts` runs the canonical MetaSheetServer with actual JWT/session hydration and database-backed roles, namespace admission and organization membership. It does not inject a principal or mock RBAC. Fixture setup uses synthetic data and the existing development-token fixture endpoint, then verifies persisted profile/session state and observes real users/session SQL on each measured request.

| Case | Actual aggregate GET result | Scoped aggregate evidence |
|---|---|---|
| A1 delegated admin, active A, scheduled group incomplete | 200, full existing fixture shape and needs_configuration | A-scoped group/schedule reads; READ ONLY transaction observed |
| A2 B membership exists before first B session | 404, existing exact error shape | Only B-scoped missing-group lookup; no A payload |
| A3 A actor selects B through header | 403, existing selector refusal | No aggregate SQL |
| A4 active group owner without attendance:admin | 403, real RBAC refusal | No aggregate SQL |
| A5 old A token after fixture membership revocation | 403, unscoped identity refusal after real AuthService hydration | No aggregate SQL |

Five actual passed assertions, zero skipped/pending, command exit 0. Exactly five measured aggregate requests; setup/profile requests are separate. SQL observation preserves the original driver receiver, arguments and return behavior. Each measured request compares all 465 ordinary business-table fingerprints, including row xmin; business DML is zero. Session/revocation tables are recorded separately: no observed session writes or changed fingerprints in this run. Setup and revocation do modify synthetic fixtures outside measured actions; this is not a claim of a globally unchanged database.

The owned UTF8 database applied 458 migrations with pending 0 and ledger 458. It was stopped normally and retained. No provider or customer data was used.

## Refutation and registration

Temporarily removing only the W6 route RBAC guard makes A4 return 200 instead of 403: one matching failure and four passing controls, zero excluded. The route was restored byte-for-byte (SHA256 `921046f43c4798184022e1f739cdb7ff5aa97aa94266d6f5b238d79507a812e4`). No guard mutation is committed.

The new suite is registered exactly once in the existing required real-DB step, excluded from no-DB discovery, and included in the strict frozen corpus. Separate unconditional preparation steps create and migrate its own database before integration. The guarded invocation contains only the supported flat commands. Cleanup runs even after migration/test failure, only when this job successfully created that database; a failed creation does not authorize dropping an existing database. Existing suites, parser, assertions and budgets are preserved. The isolated fixture database keeps partial scheduled-group rows out of the timezone lane's global-policy evidence.

Initial variable/trap registration and a subsequent createdb command inside the guarded step were both rejected by the unchanged wiring guard. They were corrected by moving preparation outside the guarded test step; they are historical failed harness attempts, not product failures.

## Reproduction

Use a disposable UTF8 PostgreSQL database with matching `DATABASE_URL` and `ATTENDANCE_TEST_DATABASE_URL`, original strict-RBAC settings and an empty environment directory.

```sh
pnpm --filter @metasheet/core-backend migrate
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w6-real-auth.db.test.ts --reporter=json --outputFile=artifacts/w6-real-auth.vitest.json
node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
pnpm validate:all
```

Do not execute against an existing business database. The suite retains fixture history for fingerprints and requires an isolated schema.

## Evidence gates

| Gate | Local evidence |
|---|---|
| Actual JWT/session/DB-RBAC five-case execution | 5/5, exit 0, no skip |
| Matching RBAC-removal mutation | 1 matching red + 4 controls; exact source restored |
| Focused test lint | exit 0 |
| Strict registration corpus | 324/324, exit 0, no skip/cancel |
| Workflow YAML | parsed and unique required-step invocation checked |
| Required quality | pnpm validate:all exit 0 |
| Independent review | Astra/high test-source review; separate workflow review recorded |
| Published-head required CI | Pending; current SHA and terminal checks must be verified separately |

Local receipts are under `artifacts/attendance-w6-real-auth-proof-20261026/`: `real-auth-first-state.json`, `first-five-http.vitest.json`, `rbac-mutation-state.json`, `rbac-removal-http.vitest.json`, `quality-v3-state.json`, `independent-source-review.json` and `workflow-independent-review.json`. Artifacts are local execution evidence, not a claim that CI already ran this commit.

## Remaining boundary

This closes only the named actual-auth layer. It does not replace the existing injected-principal route tests, establish a new permission, employee projection or per-group punch enforcement, or qualify all role-by-policy combinations. Three additional synthetic actual-entry observations are tracked separately. Human assistive-technology/native-menu work, parent owner acceptance, #6512 approval, frozen TRANSFER and W8/PQA/manual/24h/TXN/live acceptance remain separate. No merge, deployment, R71/tag/release or business configuration change; Stream/lifecycle OFF. Real UAT and business50004 excluded; historical08PUT remains INCONCLUSIVE.
