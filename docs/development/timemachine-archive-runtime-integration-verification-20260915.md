# Archive Runtime Integration Verification

Status: LOCAL CHECKPOINT ONLY; remaining runtime gates are open.

## Exact Migration Census CI Repair

- Published `95c65d772a6cd33bd561bdaf48f93ca6c37c9846` failed Node18/20 at the W0 exact-anchor static wiring step: the verifier correctly included 27 migrations, but its independent roster still required 26.
- Test-only fix `26b4f88d4219f10d799245dcc797fa753a238fca` adds derived effects as the final roster entry and an explicit removal mutation. Existing ordered equality and all prior negative checks remain intact. Direct wiring contract: 36/36 PASS; no skips.
- Current-main replay `31b9214559badfc59f148f9e34c966c0b8fe8550`, tree `e8b9141cc3a3d6c5a0f209e8205583c68eb03fb2`, has ordered parents `26b4f88d4219f10d799245dcc797fa753a238fca` and `58f704be92fe7711332b84d87a7c545776a38b8f`. Merge was conflict-free; incoming changes are three automation-editor files and two operational reports, with no recovery-source overlap.
- On the replay: wiring 36/36, automation editor neighbor 127/127, official package provenance frozen/live differenceCount=0. The first web attempt lacked the worktree-local dependency link; after linking the already-installed web dependencies, the full target ran successfully. No dependency installation or lock change.
- This round changes no recovery production code or migration. Earlier real-DB replay evidence remains bound to its recorded head; remote CI for the successor must run afresh. No Ready, merge, flags, dispatch, deployment or production operations.

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

### Durable Runtime Wiring Checkpoint

Code `a4436047b0f98c8e0bcc081850ec67c97fc90a5a`, tree `bc53d3527c7292158786baf981903d078d3de376`: nine code/test files; mandatory async transaction enqueue, worker consumption, canonical callback binding and enabled-composition validation.

- Fresh isolated PG15 migration: 403 ledger entries. Combined restore-jobs and exact-anchor route suites: 2 files / 83 tests PASS, zero skips. After adding an explicit Vitest import, the two changed encrypted-facade cases were rerun and passed; the other 32 were intentionally unselected in that targeted run.
- Real encrypted revert/reset facade proves post-enqueue failure rolls back source version and queue row, successful commit persists an actual revision-bound queue row, and applying jobs are ineligible. The revert terminal path proves consumption after finalization. Its processor is a spy: canonical computed behavior is separately covered by the route suite, not claimed as full end-to-end server acceptance here.
- Initial full run exposed cross-case pending queue pollution; each facade case now removes only its own job's effects in finally. Final effects/sheet/job fixtures zero; disposable database dropped, prefix databases/backends zero, PG stopped.
- Unit/boot neighbors: 4 files / 59 tests PASS. Covers enqueue failure, ordering before event hook, snapshot stability, missing processor fail-closed before database resolution, derived idle/success/retry scheduling, failure containment and stop boundaries. Core tsc and three modified small runtime modules' ESLint PASS; no megafile-wide lint claim. Diff-check PASS.
- Mutation omitting mandatory enqueue: both real encrypted facade cases RED. Mutation omitting worker consumption: five worker assertions RED. Restored unit matrix 59/59 and combined real-DB matrix 83/83 PASS.
- Logs are session-local `/private/tmp/tm-derived-runtime-{migrate,unit-restored,combined-final,target-restored,enqueue-mutation,worker-mutation,tsc-final,lint-final}.log`, not remote CI evidence.
- Live remote main was `3af8f12f73feedd517bfe97a92697cb1bb15536d` during this checkpoint. The integration branch has not yet replayed that main. Remaining read/write races, throughput, provider/standard startup and real process-restart gates remain open. No push, PR, Ready, merge, flags, dispatch or deployment occurred.

### Commit-Held Derived Inputs And Authority

Code `909afa204a72bd989c77a8203c5b823db37ccac9`, tree `bc7e22e5405710de7c927e23da210369d8d39c44`: four files, archive-only shared read/write transaction and post-commit invalidation.

- Before implementation, all three new two-connection cases failed: source fence, foreign fence and actor lifecycle revoke could proceed while the processor paused after reading input.
- Final cases hold a real calculation-read barrier. Competing source/foreign canonical lock acquisition times out; actor deactivation fails with the existing authority-busy code. After processor commit, the same writer succeeds. A subsequent calculation reads the new value (21), and a subsequently deactivated actor is denied. Cleanup always releases the barrier and awaits the processor.
- Transaction negative proves an autocommit query is rejected, a scoped query cannot materialize another sheet, and a simulated commit failure rolls formula value 11 back to 100 without publishing. Restored normal transaction commits 11 and publishes.
- Mutations: removing actor lease gives exactly 1 RED/2 GREEN race cases; removing canonical fence entry gives exactly 2 RED/1 GREEN; removing scope membership guard makes the transaction negative RED. All restored.
- Fresh isolated PG15 stream PASS. Final route + restore-jobs real-DB suites: 2 files / 87 tests PASS, zero skips. Formula/lookup/parser/reference and worker/application unit neighbors: 8 files / 135 tests PASS. Core tsc, both modified small module ESLint and diff-check PASS; no megafile-wide lint claim.
- Effects/sheet/job fixtures zero; disposable database dropped, prefix databases/backends zero, PG stopped. Logs: `/private/tmp/tm-derived-race-{migrate,before,target-final,authority-mutation,fence-mutation,scope-mutation,full,unit,tsc-final,lint}.log` (local only).
- No new remote-state claim, push/PR, flag, Ready, merge or deployment. Throughput/capacity, actual process restart, standard startup/provider and current-main replay remain open; overall goal is not complete.

### Provider And Process-Restart Merge Verification

Exact code `378190bc0f014b05f2364c06cc88fe34d26aa4a9`, tree `f4b958532d834eb83df12a8a2ae5912ba75f7cd2`.

- Ordered true merges: `d52b332b3659b47d50d039a44737a89b1a0a0176` incorporates main `3af8f12f73feedd517bfe97a92697cb1bb15536d`; `36337e86a44b6c33d0d349dd08aa8d7a6fb922f4` incorporates #5726 `598b5bec3d2f5a5eee644de54c75d9a2e1cd6a64`; final code incorporates #5728 `eabd47aaf20a248b5148d195dd80ff33f47fdde9`. Sole manual conflict resolution: restore-jobs real-DB spec, preserving both branches' assertions and cleanup.
- Fresh isolated PG15 full migration succeeds, ledger count 403. Restore-jobs suite 36/36 includes real child SIGKILL before/after COMMIT, durable revision-bound enqueue, rollback and terminal consumption. Exact-anchor route suite 53/53 covers canonical authority and commit-held processor races. Combined 89/89, no skips; these are separate suites, not a single canonical server/process acceptance claim.
- Async facade/application/worker/server unit neighbors: 4 files, 80/80 PASS. Core `pnpm exec tsc --noEmit` rerun exits 0; diff-check PASS. Existing incoming tests were reused, not duplicated. No new mutation claim for the merge-only checkpoint.
- Effects, fixture sheets and jobs all zero before dropping the dedicated DB. Afterwards database-prefix and backend counts both zero; owned PG stopped. Logs are local `/private/tmp/tm-runtime-merge-{migrate,process,route,unit,tsc}.log`; the final tsc rerun was directly observed exit 0 rather than inferred from an empty log.
- No push, PR metadata, Ready, merge-to-main, flags, dispatch or deployment. Production provider/custody, standard startup, queue capacity and combined canonical restart remain open; overall goal remains active.

### Bounded Derived Drain Verification

Exact code `5522d0467e17c43eeafb910854d63bde2973b2c6`, tree `079470ea9da2126d968b8cee71dacf2e3a5534f6`; two source/test files, 26 additions/2 deletions.

- New expectations against the old one-attempt implementation: 4 RED/22 PASS. Cases cover multiple completions followed by idle/retry and a continuously replenished queue, with ordinary restore finalization still reached after the bound. Existing stop-after-in-flight and infrastructure-failure tests remain green.
- Restored implementation: four worker/application/facade/server unit files 83/83 PASS. Mutation breaking only on idle instead of every non-completed outcome: 2 RED/24 PASS. Restored direct worker suite 26/26 PASS. Core tsc, worker source ESLint and diff-check exit 0.
- Logs: `/private/tmp/tm-derived-batch-{before,final,mutation,restored}.log`. No new DB claim: persistence/locking SQL is unchanged; preceding 89-test real-DB evidence binds its recorded code SHA. This scheduling test is not a production performance benchmark.
- Local-only commit, no push/PR/flags/deployment. Capacity/indexing, canonical restart composition and provider decisions remain open.

### Pending Index Verification

Code `027ff1ef7309306e88ce3d4797da3658b1298812`, tree `51cf0c7654bc4b94b248baf1006c1ae0c4ea54c4`; two files, 28 additions.

- Fresh isolated PG15 migration PASS; full restore-jobs real-DB suite 39/39 PASS, including real process restart. Three new index drift negatives pin default NULLS LAST, missing partial predicate and wrong key sequence. Core tsc, migration ESLint and diff-check PASS.
- Neutralizing the index audit yields 3 RED. The initial mutation left test index drift committed; cleanup was corrected by forcing rollback even when a weakened migration accepts the index. After restoring the owned test index, final rollback-safe mutation again yields 3 RED; restored migration tests 8/8 PASS (31 intentionally unselected). Full 39/39 preceded only this test-cleanup hardening; no production change followed that full run.
- Source logs: `/private/tmp/tm-derived-index-{migrate,full,mutation-final,restored-final}.log`. Effects/sheets/jobs zero, dedicated DB dropped, prefix DB/backends zero, PG stopped. Initial startup omitted the dedicated port and failed to bind; corrected explicit loopback port was used before any database creation, with no shared database operation.
- Remote main rechecked `3af8f12f73feedd517bfe97a92697cb1bb15536d`. Local only, no push/PR/flag/deployment. No query-latency benchmark or connection-capacity completion is claimed.

### Publication And Scope-Expansion Negative

Draft/HOLD #5744 published at `c6488a47f8dde6059a5ef1c6e7de8d1a418b827f`, tree `dcea801e727407289d72e8a180c1d27a5d6dbf4b`, base `3af8f12f73feedd517bfe97a92697cb1bb15536d`; 39 files. Ten unit files 185/185 and full S5 pass; frozen/live provenance differenceCount=0. S5 used temporary NODE_PATH to an existing installed mssql dependency after missing local symlink detection; no install. REST readback OPEN/Draft, auto-merge null. First exact-head check snapshot: 3 success, 1 expected skip, 24 pending; not terminal evidence.

Local test-only follow-up `f17077e146142f64b71e8314954fe5b8473f8c78`, tree `0caa975e70e373911efbf4dfd272376cf51f9536`: one spec, 47 additions. Real transaction pauses before first canonical fence acquisition; a second canonical transaction commits a new link field targeting a previously undiscovered sheet. Processor refuses scope expansion before materialization. Mutation disabling the discovery recheck returns true and the exact negative fails; restored route real-DB suite 54/54 PASS, core tsc and diff-check PASS. Production source restored unchanged. Barrier release and scoped fixture cleanup run in finally; sheets/fields, dropped DB prefix and backends all zero, PG stopped. Logs `/private/tmp/tm-derived-scope-{migrate,target,mutation,full}.log`. Follow-up not yet pushed; #5744 CI remains bound to its published SHA.

### Exact-Head Migration Replay Fix

Remote #5744 at `c6488a47f8dde6059a5ef1c6e7de8d1a418b827f` failed migration-replay run `34947698903`, job `104310915688`: `phase=cleanup code=recovery_incomplete category=migration count=1`. Local verifier reproduced the same failure. The new derived ledger FK was outside the old replay set, preventing correct dependency-ordered rollback; fresh migration alone did not prove this gate.

Fix `b068e9be8c705ab4d15374bab8730b5be0fb7d2b`, tree `9c193699d1cac294442289b79858af66b5ce9450`, adds the ledger to the ordered migration list and touched/owned catalog census. Its down now executes existence check, ACCESS EXCLUSIVE lock, nonempty refusal and drop in one DO statement, also valid for the verifier's direct autocommit invocation. No CASCADE or weakened down protection.

Fresh dedicated DB passes the full verifier: 27 migrations, 931 catalog objects, fingerprint `05fc3f2c0ea108f2b99a32af6e3ec5b48d1e8aab056753c2a2528fec5e5d385e`. Injected failure after derived-ledger down gives the expected injected-down RED; subsequent full replay returns the identical fingerprint. Owning migration subset 8/8, tsc/lint/diff-check PASS. The first broken verifier left partial catalog cleanup, so repaired verification used a newly recreated dedicated DB rather than assuming that catalog was intact. DB dropped, prefix/backends zero, PG stopped. Logs `/private/tmp/tm-replay-fix-{before,after-fresh,injection,final,migration-tests}.log`. No remote success claim until the new exact head runs.
