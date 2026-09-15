# Archive Runtime Integration Verification

Status: LOCAL CHECKPOINT ONLY; remaining runtime gates are open.

## Commit Effects Checkpoint

- Code `77fa2e3d85a0fba5b734d86a9b6fa56666645667`; tree `6360456c6bc41512b4770ad2a51efd68224ad05a`.
- Combined prior eight unit files plus `multitable-recovery-archive-application.test.ts`: 9 files / 168 tests PASS.
- Five new async-facade cases cover committed, rollback, already-committed, no-pending and effect-failure outcomes; verify exact identity/mutations, ordering after commit, no replay notification and values-free warning. These use the mocked runner, not a real commit/crash test.
- Mutation removing the committed-only discriminator: already-committed case RED (1 failure / 14 passes); restored combined gate 168/168.
- Application snapshot test pins callback identity; source/core typecheck, explicit modified-unit typecheck, touched-module ESLint and diff-check PASS. Existing inert-mode table test now declares its unused second argument to satisfy explicit test TypeScript checking; behavior unchanged.
- This does not prove durable outbox wiring, realDB post-commit ordering, standard startup or runtime notification delivery. Earlier PostgreSQL evidence remains bound to its recorded code/test head below.

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

### Shared Mutation Event Checkpoint

- Code SHA `9062f3144355e99798c0d505e939f6f54152bdba`; tree `f68b51dd5e8ef2bf042700fb8d32e2812b989dd3`.
- Ten focused/neighbor unit files: 174/174 PASS. Event suite uses a mocked durable producer; it is not real outbox transaction evidence.
- Removing identity equality from the worker event binding: exactly mixed-identity test RED (1 failed/5 passed); restored suite 6/6 PASS.
- Core typecheck PASS; explicit unit-file typecheck PASS after correcting the test cleanup callback return; new source ESLint PASS; diff-check PASS.
- No PostgreSQL run for this event extraction yet. Prior 32-test DB evidence above belongs to its earlier SHA and cannot establish this changed HTTP producer path.
- No push/PR/Ready/merge/flag/dispatch/deploy; application composition, formula/realtime effects and real outbox rollback tests remain outstanding.

### Remaining Combined Validation

### Mutation Event Real-DB Evidence

- Exact code/test SHA `745b5685626490426d8cd71164df3d0be02e23b9`; tree `6379f5daf4f130ae92613b3e7a82dfea1674f3d8`. Remote main rechecked at `062614f4407b3d9bffc82dae266071b8a6e5e5bd` before this run.
- Dedicated PG15 fresh migration count 402; second replay exit 0. Whole `multitable-exact-anchor-route-wiring-realdb.test.ts` with `METASHEET_REAL_DB_TEST_STEP=1`: 35/35 PASS, zero skips.
- Three new `RECOVERY-EVENT` tests use the actual producer, not a mock: source version and event/consumer rows commit together; a deliberate rollback removes both; another connection cannot see uncommitted events; an autocommit query is rejected by the transaction probe. This verifies the extracted event hook, not a complete background job execution.
- Mutation omitting `enqueueRecordEventIfDurable`: all three new cases RED. Restore was byte-identical to `9062f3144`; final whole-file 35/35 GREEN.
- Pre-drop outbox/record/sheet/user fixture counts and other backends: all 0. Dedicated database dropped; prefix databases/backends 0; task-owned PG stopped. No flags outside this synthetic test process changed, no dispatcher ran.
- Standard worker composition, post-commit derived/realtime effects, restart integration and provider startup remain incomplete. No publication, Ready, merge, deployment or production claim.

### Remaining Runtime Gates

### Explicit Computed Authority Evidence

- Code/test SHA `7e37fadb2c50e041178f60c10bb7be82a131ca14`, tree `9c7ef5473e68541f855de44dc62c0e0bbe737520`.
- Six focused/neighbor unit files: 119/119 PASS; core typecheck PASS; diff-check PASS. No new whole-router lint claim.
- Dedicated PG15 fresh migrated database; whole exact-anchor route suite 37/37 PASS, zero skips. Requestless worker helpers hydrate the actual foreign lookup, recompute its formula and discover related records. Hiding the foreign field yields an empty lookup and no formula overwrite; restoring visibility restores the positive result. Both indexed-dependency and missing-index cases run.
- Before the taint fix, missing dependency rows produced formula value 1 instead of preserving 100; indexed case passed. After fix, both pass. Mutation suppressing expression-edge union again failed exactly the missing-index case (1 failed/1 passed); restored whole-file 37/37 PASS.
- Pre-drop outbox/records/sheets/users/fields and other-backend census all 0; database dropped, prefix databases/backends 0, PG stopped. No runtime flag or external dispatcher enabled.
- These are actual helper/HTTP regression checks, not evidence of standard background application composition. Provider wiring, full worker effects and restart acceptance remain required.

### Outstanding Standard Runtime

### Worker Callback Composition Evidence

- Code/test SHA `467b80a239c81b58e1e44a1ec4336c5ef7ab3aef`; tree `452dd5beac6309a01a55de006a1a231fe368a7cf`.
- Six focused/neighbor unit files 90/90 PASS; core typecheck and diff-check PASS.
- Dedicated PG15 fresh migrations; whole exact-anchor route suite 39/39 PASS, zero skips. Two new worker-callback cases use real source/link updates and the actual callback assembly: no event/Yjs emission inside the transaction; authorized post-commit recompute produces 11; post-commit account revocation retains prior derived value 100 and emits only ID invalidations. Event bus/realtime/Yjs are observed with spies, not external delivery.
- Mutation replacing post-commit authority recheck with unconditional entry: exactly revoked case RED, normal case GREEN. Restored whole-file 39/39 PASS.
- Record/outbox/sheet/user fixtures and other backends 0; database dropped, database prefix 0, PG stopped. No deployment/production/flag action.
- This is callback composition evidence without a long-lived archive writer block. Job finalization releases that block after chunk callbacks, so terminal/restart-safe derived effects remain unproven and explicitly pending. Standard startup has not been enabled or claimed complete.

### Still Required

- Combined real-DB route and worker execution, mutation, and process-restart gates.
- Shared full-read/plan authorization invoked by a real background worker.
- Provider/KMS/object-store integration or ordinary application startup readiness.
- Remote CI, PR publication, merge, staging, UAT or production readiness.

Constituent PR reports remain SHA-scoped; their prior DB/mutation evidence does not replace these combined gates. No extra reviewer was invoked for this integration checkpoint.

### Derived Ledger Schema Checkpoint

Code `af9a2520d611cbee703191d621d98b008a7426c4`, tree `9f610e54907f508561bb72e43df11953a1a0c28d`, adds only the internal ledger migration, five cases in the existing restore-jobs real-DB suite, and its bounded design contract. Remote main was rechecked as `062614f4407b3d9bffc82dae266071b8a6e5e5bd`. No enqueue or consumer is wired yet.

- Dedicated PG15 fresh stream: 403 migrations; second migration run exits 0 with no new migration.
- Focused migration cases: 5/5. Empty down/down/up/up succeeds; dropped NOT NULL/default and deferred primary-key drift are rejected; populated down fails closed and retains pending work.
- Mutation changing populated-down rejection to a silent return: the exact refusal case RED (promise resolved); restored code passes the complete suite.
- Initial full-suite run exposed the new fixture's planned job contaminating subsequent candidate selection. The fixture now cancels its job through the existing API in finally. Final full restore-jobs real-DB suite: 25/25, no skip.
- Core `tsc --noEmit`, migration ESLint and `git diff --check`: PASS. The existing suite is already named in the plugin post-migrate lane and excluded from no-DB unit collection; no shared selector changed.
- Final ledger/sheet/job fixture counts: 0. Dedicated database dropped; database prefix and backends: 0; PG stopped.
- Logs: `/private/tmp/tm-derived-migrate.log`, `tm-derived-replay.log`, `tm-derived-target.log`, `tm-derived-mutation.log`, `tm-derived-full-final.log`, `tm-derived-tsc.log`, `tm-derived-lint.log` (session-local, not remote artifacts).

Remaining: transaction-bound enqueue, bounded terminal consumer with strict error handling, live authorization/fence checks, crash/restart completion and standard startup assembly. This checkpoint is not end-to-end derived recovery proof and has not been pushed or published.

### Transaction-Bound Derived Enqueue

Code `1b1621d41dbbc53cbe8c3f91c60315f9f9c48d56`, tree `f73c9ebc8982daff559d1c7d30a4022aae64b79d`, adds the internal enqueue primitive and six cases to the existing real-DB suite. The application does not call it yet; consumer and callback wiring remain open.

- Dedicated PG15 fresh full migration succeeds. Final full restore-jobs suite: 31/31 with no skips.
- Enqueue cases cover committed revert/delete ID projection, duplicate idempotency, invisibility to another connection before commit, rollback, conflicting revision payload rollback, all four wrong scope/actor fields, planned-job refusal and real autocommit refusal. Deletion retains link invalidations but no source field IDs.
- Mutation disabling the post-conflict equality check produces the exact conflict-case RED; restored implementation passes the whole suite.
- Core tsc, new module ESLint and diff-check pass. No shared workflow or no-DB selector change; this suite retains its existing post-migrate wiring.
- Ledger/sheet/job fixtures zero; dedicated database dropped, prefix/backends zero, PG stopped.
- Logs are session-local `/private/tmp/tm-derived-enqueue-{migrate,target,mutation,full-final,tsc,lint}.log`, not remote CI evidence.
- During verification remote main advanced to `f274316f6dfe2ba7f0de78dee7c43aa3624748c7`; fetched delta contains 13 stock-preparation plugin files and no path overlap with this checkpoint. Integration branch is still based on `062614f4407b3d9bffc82dae266071b8a6e5e5bd`; current-main replay remains necessary before publication. No push/PR/flag/deployment action occurred.

### Terminal Consumer Primitive

Code `e2a78f8a1e86b560687a7843ff21d37bf41f8f95`, tree `404cc8a3c85ed79b803978ad2338e3dea9ee62d7`, adds the one-row terminal consumer and three real-DB lifecycle cases. It is not yet a production computed callback or worker integration.

- Fresh dedicated PG15 migration succeeds; full restore-jobs suite 34/34, no skips. Core tsc, module ESLint and diff-check pass.
- Actual job APIs create/claim and finalize/abandon/cancel fixture jobs. Applying jobs are not consumed; done and abandoned-partial jobs are consumed; cancelled-zero-write remains unconsumed.
- False and thrown processor results preserve pending work and persist attempt time. A two-connection barrier proves a second consumer skips the locked row. Exact true completes it, and later attempts do not call the processor again. These synthetic processor tests prove queue behavior, not live formula recomputation or OS process restart.
- Mutation treating false as completed: abandoned-partial case RED. Mutation admitting cancelled-zero-write jobs: cancellation case RED. Restored full suite 34/34.
- Final queue/sheet/job fixtures 0; database dropped, prefix/backends 0, PG stopped. Logs: `/private/tmp/tm-derived-consume-{migrate,target,result-mutation,state-mutation,full,tsc,lint}.log` (session-local).
- Open gates: strict computed success/failure propagation, fresh actor/scope processor binding, canonical-fence race tests, durable runtime hook wiring, process death/restart and startup/provider verification. No runtime enablement, push or PR publication claimed.

### Strict Computed Helper Checkpoint

Code `9c9c093b2acb6206c9150cb807370a75aed81f0b`, tree `2527c6cf11928eb3c303c3b4a9c846835451d150`, adds opt-in strict completion propagation to the shared formula/related helpers; ordinary HTTP defaults remain best-effort.

- Fresh dedicated PG15 migration succeeds. Full exact-anchor route real-DB suite: 43/43. Formula engine/lookup/parser/reference neighbors: 4 files, 76/76. Core tsc and diff-check pass; no new global lint claim for the existing megafile.
- Six targeted assertions cover denied foreign formula input with/without indexed dependencies, blocked pure source formula, blocked pure related formula, blocked source relation aggregate and blocked related relation aggregate. Each blocked case proves strict refusal, legacy benign return, unchanged stored value, then correct materialization after block removal.
- Mutation forcing the factory's strict argument false: all six targeted cases RED. Restored full suite 43/43.
- Synthetic record/sheet fixtures zero; dedicated database dropped, prefix/backends zero, PG stopped. Session-local logs: `/private/tmp/tm-derived-strict-{migrate,target-final,mutation,full,unit,tsc}.log`.
- This proves strict helper behavior against a pre-existing durable block, not a new-block race or complete queue/runtime integration. Fresh processor binding, delete-link invalidation recompute, worker startup and real restart remain open. No push/PR/flags/deployment action.

### Canonical Processor Checkpoint

Code `089dec4c2d94ff5de28374d7b27451b5dbb30558`, tree `d0a5c9212b58fef7340a04d09ae43e2cc9551342`, adds the requestless canonical processor factory and dedicated implementation module. Neither queue nor application invokes this factory yet.

- Fresh isolated PG15 stream succeeds; full exact-anchor route suite 49/49, no skips. Core tsc, new module ESLint and diff-check pass.
- Six processor scenarios: revert computes both source formulas; delete recomputes the surviving related formula after actual source/edge deletion without resurrecting the source; revoked actor retries then succeeds after reactivation; active writer block rejects then succeeds after removal; denied related field scope and denied cross-base access refuse before source materialization. Every case rejects a mismatched workspace identity.
- Initial four-case failure identified an incorrectly unconditional base-read gate. Same-base behavior now follows the existing sheet capability path; only cross-base targets require base readability. Final positive fixtures have no broad base-read grant.
- No business event emission; realtime payloads contain no record patches; Yjs receives source/affected related IDs. Mutation dropping saved link invalidations: delete, related-scope denial and cross-base denial are exactly RED (3 fail/3 pass); restored full suite 49/49.
- Fixture record/sheet/extra-base counts zero; dedicated DB dropped, prefix/backends zero, PG stopped. Session-local logs: `/private/tmp/tm-derived-processor-{migrate,target-final,mutation,full,tsc-final,lint}.log`.
- This is actual processor/DB evidence, not queue-to-worker or process-restart proof. Concurrent permission/input changes, bounded lifecycle, provider/startup and current-main replay remain open. No push/PR/enablement/deployment action.
