# Archive Runtime Integration Verification

Status: LOCAL CHECKPOINT ONLY; remaining runtime gates are open.

Code: `22d9fbcd6eefcfc752e953a79b9cf96341dd2836`.
Tree: `756d1e7152ad4a2b732ae68525f5b8dda582cf7f`.
Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.

## Executed

From `packages/core-backend`:

```sh
pnpm exec vitest run --config vitest.config.ts \
  tests/unit/recovery-actor-authority.test.ts \
  tests/unit/recovery-explicit-read-authority.test.ts \
  tests/unit/multitable-permission-service.test.ts \
  tests/unit/multitable-stored-data-taint-chokepoint.guard.test.ts \
  tests/unit/multitable-exact-anchor-recovery-route.test.ts \
  tests/unit/multitable-recovery-archive-async-restore.test.ts
```

Result: 6 files / 132 tests PASS. This covers combined unit policy/wiring, not live worker recovery. `pnpm run type-check` passed. `git diff --check BASE..HEAD` passed.

Three true merges preserve the recorded source heads as ancestors. The exact-anchor test insertion conflict was resolved by concatenating both complete parent test blocks: two account-invalidity cases and one foreign-base revocation case. A mechanical comparison confirmed both blocks are byte-identical to their respective parents. No production conflict required manual resolution.

## Not Yet Proven Here

### Shared Policy Checkpoint

Code `5fb07a51126aa228bf635b9d2d49d62720af4c00`, tree `e429ed6710cd948da1c0bd45826a069e4b1c0930`:

- Added `tests/unit/recovery-plan-authorization.test.ts` to the above command: 7 files / 141 tests PASS.
- New direct tests: 9/9; fresh authority on every invocation, actor/manage/full-read refusal before record queries, writable scalar versus formula/lookup/rollup, foreign authority refusal before target locking.
- Mutation neutralizing the full-read guard: 2 failures / 7 passes. It broke exact full-read invocation and allowed record lookup after denied full-read. Restored combined run: 141/141.
- Core `pnpm run type-check`: PASS. Core plus explicitly included new test via temporary TypeScript project: PASS. The initial temporary project incorrectly excluded ambient Express declarations; it was corrected to inherit the core includes, without editing application declarations.
- Shared module ESLint: PASS. `git diff --check`: PASS.
- No new DB, browser, remote CI or external model review was run for this checkpoint. Existing constituent DB results are not asserted as a combined pass.

### Open Gates

### Worker Adapter Checkpoint

Code `6185c4b39e49214643ced708ce60abfc605e926d`, tree `420890aec4d0775297ca2b681cc5cf740a29f119`:

- Added `tests/unit/recovery-archive-worker-authorization.test.ts` to the combined command: 8 files / 152 tests PASS.
- New suite: 11/11, invokes the actual exported canonical worker authorization factory with a synthetic query implementation (NOT a real DB). Covers persisted actor, fresh revocation, base/workspace/deleted scope, five malformed identity fields, final lock scope, and plan/stabilizer identity mismatch.
- Base-binding mutation: remove `row.base_id === identity.baseId`; exact base-drift test RED, 1 failure / 10 passes. Restored combined run: 152/152.
- Core plus both new test files TypeScript project: PASS. New shared modules ESLint: PASS. Diff-check: PASS.
- Existing explicit-read structural guard now accepts absence of HTTP Request only with explicit authority; absent request AND authority throws a values-free refusal. No fake Request was introduced.
- Real-DB worker transaction, startup composition and mutation/post-commit behavior are still open gates. No external reviewer, DB or runtime activation was performed in this checkpoint.

### Remaining Acceptance

### PostgreSQL Authority Checkpoint

Code/test head `dcb10e1c1b98d37181942870752d4d7c451306cd`, tree `d9eb3f4b1a0840222ee7a07d0d6687af73b510a7`:

- Dedicated PostgreSQL 15 database, full `pnpm run migrate` then second replay: both exit 0; migration ledger count 402. This is this run's actual count, not the historical constituent count.
- `METASHEET_REAL_DB_TEST_STEP=1 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts`: 32/32 PASS, no skipped tests in the final whole-file run.
- New `WORKER-AUTHORITY` calls the actual worker factory against PostgreSQL without any HTTP request. It proves active authority, account revoke/re-enable, field-hidden full-read refusal, field-read-only true-delta refusal, restored writable positive, workspace drift and permission revocation. It asserts record data/version unchanged.
- Mutation replacing worker full-read with `Promise.resolve(true)` failed precisely at the hidden-field refusal. Restored production file is byte-identical to `6185c4b39`; final whole-file suite passed.
- Pre-drop fixture census: users/bases/sheets/records/fields 0; other database backends 0. Dedicated database dropped; exact/prefix database and backend census 0. Task-owned PG server stopped; DB window released.
- This is worker authorization and HTTP route regression evidence, not a background chunk execution or startup/provider acceptance. The callback factory is not yet composed into the application worker, and durable mutation/post-commit effects remain open.

### Outstanding End-to-End Gates

- Combined real-DB route and worker execution, mutation, and process-restart gates.
- Shared full-read/plan authorization invoked by a real background worker.
- Provider/KMS/object-store integration or ordinary application startup readiness.
- Remote CI, PR publication, merge, staging, UAT or production readiness.

Constituent PR reports remain SHA-scoped; their prior DB/mutation evidence does not replace these combined gates. No extra reviewer was invoked for this integration checkpoint.
