# Attachment Restore Verification

Status: MERGED ON MAIN; bounded synthetic acceptance and merge-triggered CI verified.
No production enablement or real-tenant UAT.

Base: `868c8d2b26424fcaa8405661a6999abb17ec6d93` (#5849 merge).
Contract: `e4625f322` (full parent available in Git).
First code checkpoint: `0158b581001d630a470d39b2476c2cfb0c48b16e`.
Source/authorization checkpoint: `19d8e6e49996ff6a1083697dcaa22b118f463a2e`.
File preparation checkpoint: `a4bce2504849293703d3a6aebbc534d16a79cc94`.
Durable ledger checkpoint: `e4b447034a70918866428d355a9285db79d41d14`.
Merged PR branch (historical): `codex/timemachine-attachment-restore-20260919`.

## V1 Isolated Acceptance Refresh (2026-09-25, Asia/Taipei)

This refresh ran against then-current `origin/main`
`f31a88663d5dcb7a290b6237abff53d8c43d55fe` (tree
`5768eb1b01dd4fbbe6726bcd5c4683aafa56ea3d`) in a clean isolated
worktree. The only source change is test-harness commit
`4494f9410` (tree `e46a3aba35ce9a1992685a33010035d3e26862ce`), in
`packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts`.
No recovery product, permission, migration, storage, workflow or flag file changed.

| Gate | Current-main evidence |
| --- | --- |
| Real Workbench | `run-recovery-manual-checkpoint.mjs --workbench` exited 0: login/session/router Workbench 8/8; its owned database had zero connections before drop and its PostgreSQL cluster was stopped and removed. |
| Full browser and database | On the unmodified main, `--browser` passed its 47/59/127 real-DB neighbors and 32 migration replay checks, then failed because the harness queried the download pool after `MetaSheetServer.stop()` had closed it. The same command after the one-file fix exited 0, passed those same gates, all 1440/390 scalar/attachment/Workbench/application loops, authenticated original-byte downloads and gallery PNG decode, and ended with zero owned database/stage connections, no retained application timers, and removed owned browser/Vite/cluster resources. This is a discriminating RED-to-GREEN harness regression, not a product behavior fix. |
| Real-process restart | `verify-recovery-local-startup.mts` exited 0 in a new disposable PostgreSQL 15 cluster. Evidence at `artifacts/recovery-local-startup/evidence.json` binds source head `f31a8866` and records wrong-secret refusal before listen, no pre-unlock listener, authenticated restoration of 5,001 exact rows, locked restart until fresh FD3 delivery, two migration passes and zero database/backend/path/process residue. The owned cluster was then stopped and removed. |
| Local backup-set faults | `verify-recovery-local-backup.mts` exited 0 in a separate disposable PostgreSQL 15 cluster: two distinct databases, source unavailable before target worker, 5,001 recovered rows and drained effects, ten nonce sections, retained receipt/store identity and released writer block. The driver also exercised wrong secret/key, missing or tampered package/object, and receipt SHA/size refusals. Its owned databases and work root were removed; the cluster was stopped and removed. |
| Quality | Acceptance-script TypeScript project and `git diff --check` pass. Default ESLint project excludes this script; the dedicated project reports three existing `no-inner-declarations` findings at untouched lines 251/296/319. With only that existing rule disabled, scoped lint passes. |

These are synthetic local tests, not a customer environment or release decision.
The earlier intermittent browser `API_REQUEST_FAILED` is still unattributed;
this passing run does not establish its cause. Existing authority remains in
force: removing an attachment from a cell does not revoke its old ID, while
explicit deletion makes it unavailable. New tenant isolation, detach-time
revocation, hostile NAS durability, asynchronous attachment recovery, whole-
table resurrection after hard delete, flags, staging/deployment and real-tenant
UAT are outside this acceptance. The one-file harness fix requires its own
published exact-head CI and merge disposition before it is a mainline result.

## Merged-main Delivery Gate (2026-09-23)

| Gate | Exact evidence and disposition |
| --- | --- |
| Main and PR | PR #5882 MERGED at `2026-09-23T14:39:49Z`; merge/main `261835ad2dea6331e7880893e781b7f7c3439588`, tree `94cd151e67dea64aeda8cbe57d34a866c1b91250`, ordered parents `cd42eaf7455f03dd99021a02c47c42f1f3db6484` + owner-authorized head `bea1bdcef048932ce2bcdfe1f79c6ae349b77352`. |
| Merge-triggered push CI | 17/17 workflows SUCCESS; 26 jobs = 22 SUCCESS + 4 conditional SKIPPED, 0 pending/failure. Node18, Node20, Web Tests, migration replay, Time Machine D2 archive real-DB fail-not-skip and isolated manual checkpoint acceptance succeeded. Coverage is PR-only and skipped on push; separately scheduled health probes and issue-triggered runs are not counted. |
| Publication/deployment | `Deploy to Production` run `35875847298`: test SUCCESS; build-and-push and deploy SKIPPED. `Build and Push Docker Images` run `35875846996`: local CI build SUCCESS; registry login, approved image publication and deploy SKIPPED. No task-triggered dispatch, publish or deployment. |
| Owned DB and browser | Product checkpoint `3d01f8209897d07eebe0880c846be9d061fbb9db`: real LoginView/session/router Workbench 8/8, full 1440/390 browser archive loops, authenticated original binary and decoded PNG, fresh/replay 32 migration gates, historical 47/59/127 neighbors, zero owned DB/backend residue. Later commits through the merged head `bea1bdcef048932ce2bcdfe1f79c6ae349b77352` change only reports. |
| Permission and lifecycle | Owner-confirmed existing administrator/sheet/row/field authority. Removing an attachment from a cell does not itself revoke its old ID; explicit deletion makes it unavailable. No new tenant or detach-revocation contract is claimed. |
| Review and residual risk | Bounded Sol and Grok 4.7 read-only reviews found no P1/P2 in their inspected restore paths, not whole-PR approval. A prior browser `API_REQUEST_FAILED` remains unattributed despite later full passes; no root-cause fix is claimed. |
| Release boundary | Owner separately authorized Ready/merge for exact `bea1bdcef048932ce2bcdfe1f79c6ae349b77352`; that action is complete. No Time Machine flag enablement, task-triggered dispatch, staging/deploy, feature-specific production operation, customer storage/data access or real-tenant UAT was performed under this task. Async attachment restore, hostile-NAS guarantees and hard-deleted whole-table resurrection are outside this slice. |

The merged PR head differs from product checkpoint `3d01f8209897d07eebe0880c846be9d061fbb9db`
only in this report and its paired design lock. The older gate and OPEN sections
below record their original checkpoint state; this table supersedes them only
for the bounded evidence named here. It does not turn excluded capabilities
into passing acceptance.

## Owner Disposition and Evidence Boundary (2026-09-23)

Owner confirmed existing permissions and detached-ID lifecycle for this slice.
The authoritative decision is in the paired design lock's 2026-09-23 section.
This supersedes prior owner-pending statements; it does not retroactively create
test evidence or authorize implementation of new tenant isolation/revocation.

| Item | Disposition |
| --- | --- |
| Existing administrator/sheet/row/field checks | Retained; previously recorded authorization negatives remain SHA-bound evidence. |
| New tenant isolation | Separate future contract. Not implemented or verified by the other-actor/scope-relocation tests. No longer an owner-decision blocker for this bounded slice. |
| Attachment removed from cell | Does not itself revoke the old ID; existing authorization still applies. The earlier owned HTTP diagnostic is consistent with the confirmed contract, not an authentication bypass. |
| Explicit attachment deletion | Earlier diagnostic observed authorized DELETE then GET 404; anonymous/inactive access refused and sealed archive bytes remained intact. No new behavior or test run is claimed today. |
| Detach-immediately-revokes access | Separate future contract, including draft/archive lifecycle exceptions; not silently implemented. |
| Historical browser API_REQUEST_FAILED | Still unattributed and not declared fixed; later complete passes do not establish its cause. |

Publication baseline: clean/synchronized PR #5882 head
`402c412711f67f12c3c101c975c1ed44fe27a4aa`, main
`cd42eaf7455f03dd99021a02c47c42f1f3db6484`. Its terminal checks were
34 SUCCESS + 1 expected Strict E2E SKIPPED, zero pending/failure, recorded in
[the exact-head terminal receipt](https://github.com/zensgit/metasheet2/pull/5882#issuecomment-5765259644).
This follow-up changes only the two reports; successor exact-head checks are
separate. No DB/browser rerun, runtime changes, Ready/merge, flags, dispatch,
deployment or customer data/storage access accompanies the documentation change.

## Clean-head Acceptance and Source Review (2026-09-22)

Exact clean candidate `3d01f8209897d07eebe0880c846be9d061fbb9db`, tree
`8182836bb997149efbf4f43a87d51e01ba8c95cb`. Main remained
`cd42eaf7455f03dd99021a02c47c42f1f3db6484` at the subsequent readback.

- `--workbench`: 8/8 PASS; evidence run
  `8b6ff040-7957-4dbb-a897-724333dd81ab`. Real login/session/router,
  retained whole-table restore, deleted-row information and restore, sidebar
  history, actor name/viewer-local time, deleted-column typed restore and values.
  Inspected screenshots include sidebar history and the restored column.
- `--browser`: all 1440/390 scalar, attachment, Workbench and full application
  loops PASS, including cell-editor deletion, original restored bytes, authenticated
  download and decoded gallery PNG. Strict failed-request assertions unchanged.
- Same archive run: 32 migration replay gates, historical 47/59/127 tests,
  HTTP authorization/drift/fault/retry checks and final stage arbitration/drain.
- Owned fixture counters and connections zero, owned storage released, both
  clusters stopped/removed. No real tenant or customer storage used.

Commands are `TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node
scripts/ops/run-recovery-manual-checkpoint.mjs --workbench` and the same command
with `--browser`. Logs: `/private/tmp/tm-3d01-workbench.log` and
`/private/tmp/tm-3d01-archive-browser.log`.

Sol high read-only review inspected the source path from manual durable capture
and signed manifest through preview/execute revalidation, atomic stage adoption,
record CAS/history/token/receipt, expired-stage/purge arbitration, local storage,
runtime shutdown and authenticated attachment reads. Result: no source-evidenced
P1/P2 in that inspected integration path. No tests were run by the reviewer;
unrelated PR files, all UI state behavior, CI wiring and the denied-comment test
were not comprehensively reviewed. Session closed; no whole-PR approval inferred.

Public SHA-bound evidence: [acceptance and review update](https://github.com/zensgit/metasheet2/pull/5882#issuecomment-5764110501).
The earlier API_REQUEST_FAILED remains unattributed; a passing repeat does not
establish its cause. Owner-open tenant and detached-ID decisions are unchanged.
The `3d01f8209897d07eebe0880c846be9d061fbb9db` remote matrix subsequently
reached terminal 34 SUCCESS + 1 expected Strict E2E SKIPPED, zero pending/failure.
Node18, Node20, Web Tests and coverage succeeded. Node20 job `106421045699`
passed the previously failing multitable real-DB lane and its later integration
steps. This closes that exact-head CI gate, not the unattributed browser event or
owner decisions. A documentation successor does not inherit exact-SHA checks.

## Bounded Denied-audit CI Correction (2026-09-22)

Code checkpoint: `363cb715117169cfd1af98b3eb584d79d726a22a`, tree
`28eb8eadc5daff541650020ee0093defe95c13e8`. Parent is
`a0e4d70749275042dcec3688babdc54730176906`. Only
`packages/core-backend/tests/integration/multitable-oapi2a-comments-write-realdb.test.ts`
changes: replace a fixed 100ms sleep with the neighboring scope-guard test's
bounded `vi.waitFor` pattern (5000ms deadline, 50ms interval). The same denied/403
audit-row assertion, HTTP 403, error-code and no-comment checks remain mandatory.
No production, permission, workflow, migration or recovery behavior changed.

Parent Plugin run `35619976280` had Node18 SUCCESS and Node20 FAILURE at job
`106400289557`. Both isolated manual-checkpoint acceptance steps passed. The
multitable DB lane had 261 passing files and one failed file: the denied comment
audit assertion at line 126; 2879 tests passed, one failed and two were skipped.
The test and production audit boundary are byte-identical to main `cd42eaf745`.
The boundary writes after response finish, so receiving HTTP 403 does not prove
the audit INSERT has completed. Coverage skipped after this failure is not a
healthy intentional skip.

Owned fresh PostgreSQL 15 clusters; standalone driver Node 25.9.0, pnpm child
runtime Node 24.14.1 (verified with `pnpm --filter @metasheet/core-backend exec
node --version`). Neither is a local Node20 reproduction:

- A fixture-only BEFORE INSERT trigger delayed this suite's denied audit by
  `pg_sleep(0.4)`: original test failed exactly its audit assertion (1 RED, 3 PASS).
- Identical delay with the correction: 4/4 PASS.
- Mutation in the owned database returned NULL instead of inserting the denied
  audit: corrected test still failed after the bounded wait (1 RED, 3 PASS).
- Without fault injection, comment-write plus scope-guard neighbor: 19/19 PASS.
- Core type-check and diff-check PASS. Each cluster completed fresh migration;
  each run removed its trigger/function, dropped its database with connections=0,
  and stopped/removed the owned cluster. No production source was mutated.

Logs: `/private/tmp/tm-oapi-audit-{old-delay,fixed-delay,omitted,neighbor}.log`,
`/private/tmp/tm-oapi-audit-typecheck.log`. Local reproduction establishes a
timing-sensitive test, not the precise remote scheduler delay or an independent
Node20 reproduction. New exact-head CI must run after publication. The earlier
browser API_REQUEST_FAILED remains unattributed; this audit fix does not close it.

## Current-main Replay Investigation (2026-09-21)

Local merge `45458ad0c21a5d0d7bd743855c240d175927a420` has ordered parents
`afa50aee84fdc92f8b4de8ab625b4be1469accd7` and
`cd42eaf7455f03dd99021a02c47c42f1f3db6484`. Only
`scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs` needed manual resolution:
retain spawnSync plus main's readFileSyncRaw/CRLF-normalizing wrapper. Other
paths auto-merged. Wiring 41/41, archive Web 161/161 and core type-check passed.
Diff-check against the second parent passed; first-parent diff includes inherited
main whitespace warnings, not modified to hide them.

The first full browser run failed after a 1440 gallery check on a generic
API_REQUEST_FAILED event. Earlier archive capture/restore and attachment download
assertions passed. The log did not identify the request; this failure remains
unattributed and is not classified as a harmless cancellation or product defect.
Log: `/private/tmp/tm-cd42-replay-browser.log`. Owned DB/connections and cluster
were cleaned despite failure.

Diagnostic-only child `e1cc7eb052f935dc0f4d67808b31912a9de1a3aa` retains
the same strict zero-failed-request assertion and records synthetic request method,
pathname (no query/host) and ABORTED versus TRANSPORT enum. No exception allowlist
or product behavior change. Two complete browser runs passed with these bytes:
`/private/tmp/tm-cd42-browser-diagnostic.log` (before commit) and
`/private/tmp/tm-e1cc-browser-repeat.log` (clean exact e1cc head). Both cover
32 migration replay gates, historical 47/59/127, desktop/mobile component and
application attachment restoration/gallery, and stage arbitration/drain; owned
DB/connections/storage/cluster cleanup succeeded. These passes do not establish
the first failure's cause. Do not claim its root-cause closure or remote CI for
this local-only replay. Prior afa50 remote terminal green is historical only.

## CI Backend Drain Fix (2026-09-20)

Follow-up code: `494009d93dee52c64e581110fa4cade1b14440a4`, tree
`678a9385c84a181516001c479e0619390b12fc57`. Luna's bounded static review
of the prior correction found one valid P2: a drain rejection skipped admin
client/storage cleanup. Nested finally blocks now release both even if database
cleanup fails; a leaked database is not force-dropped. Injecting a drain timeout
at the final cleanup call produced exit 1 with the original timeout, confirmed
admin-client/storage cleanup, and outer owned-cluster removal. Restoring the call
returned stage acceptance to exit 0 with database/connections zero. This is
fault-injection evidence for the fix, not a fresh independent APPROVE verdict.

Logs: `/private/tmp/tm-stage-finally-fault-20260920.log` and
`/private/tmp/tm-stage-finally-restored-20260920.log`. Exact-anchor wiring again
passes 40/40; diff-check passes. Full-run evidence below binds the earlier script;
only the stage fixture's finally block changed afterward, with stage-only rerun.
On clean predecessor `d45247e0b79964e8758ea86905bd6f1fb281ac7d`, the two
archive Web suites also passed 161/161; no Web code changed in this follow-up.
New-head remote CI remains pending publication and does not inherit prior checks.

Code checkpoint: `6664885d5ae18e315bf4798a1bc9f576011629e7`, tree
`777d001742f0c4ef9b6ad7d9b4fa3f79797f8e57`. Tests ran on the identical
script bytes before commit; a design-report edit was present, so these runs are
not claimed to have started from a clean committed tree.

At predecessor `a05a2a420b49d3986d3169be5667cb1c8aff971d`, Node18 job
`105981553863` in run `35474600187` failed only at the immediate stage teardown
backend census (one connection, expected zero), after the stage assertions.
Node20 passed that same checkpoint step; its overall job was still pending at
inspection. Prior `28742c41` green checks below do not override this failure.
Installed pg-pool removes clients from its client list before client.end's
callback, while pool.end resolves on that empty list. Therefore pool shutdown
alone is insufficient evidence for an immediate server-side zero census.

The verifier polls the exact owned database with a bounded attempt count;
persistent connections still fail and are never terminated by this check.
The held-client negative uses a real PostgreSQL connection. Replacing the timeout
throw with return made the gate fail with `Missing expected rejection`; restoring
the throw restored success. Both mutation and final runs removed the owned
cluster. Existing zero-backend and zero-database assertions remain unchanged.

| Local gate | Result |
| --- | --- |
| Owned stage-only runner | PASS, held-client refusal and database/connections zero |
| Full owned manual-checkpoint runner | PASS, 32 migration replay gates, historical 47/47 + 59/59 + 127/127, HTTP restoration and stage races; databases/connections zero, cluster removed |
| Backend type-check | PASS; the script itself is outside the main TSConfig |
| Exact-anchor CI wiring | 40/40 PASS |
| Script ESLint | NOT VALIDATED: existing parserOptions.project excludes this .mts file; no shared configuration changed |
| Diff check | PASS |
| New remote exact-head CI | PENDING publication/checks; no inherited green claim |

Logs: `/private/tmp/tm-stage-drain-final-20260920.log`,
`/private/tmp/tm-stage-drain-mutation-20260920.log`,
`/private/tmp/tm-drain-full-restored-20260920.log`,
`/private/tmp/tm-drain-tsc-20260920.log`,
`/private/tmp/tm-drain-wiring-20260920.log`, and
`/private/tmp/tm-drain-lint-20260920.log`.
No production code, permissions, real environment access, flags, dispatch or
deployment changed. The detached-ID and second-tenant dispositions remain open.

## Current Gate Reconciliation (2026-09-20)

Evidence candidate: `28742c41dab1290550037fef1d6b19e0a761c26e`, tree
`8001a7fba9d5b7637c36eabbd9ef8ffd49249c79`; clean before and after both runs.
Authoritative remote main remained the base above. This section supersedes only
the corresponding old OPEN/pending statements, not their historical evidence.
A subsequent documentation commit does not inherit an exact-SHA CI result.

| Requirement | Inspected evidence and disposition |
| --- | --- |
| Original attachment recovery | Same-head `--browser` passes public capture, preview and explicit execution; both original binaries are restored to their existing original cell and downloaded through authenticated routes. Scalar peers, one version increment and token replay refusal remain checked. LOCAL VERIFIED. |
| Current authorization | Same run covers hidden/read-only fields, another actor's record lock, inactive actor, logged-in actor substitution, scope relocation and database-demoted administrator with an existing session. Zero-effect assertions cover the relevant data/metadata/history/token/receipt state. LOCAL VERIFIED for these axes only. |
| Second tenant | Ordinary sheet policy preserves existing global-admin authority; workspace relocation and another admin are not tenant proof. OPEN: needs an authoritative tenant fixture/contract; no new permission semantics introduced. |
| Evidence and identity | Whole-selection source/original-binding and digest guards retain their focused negatives/mutations below; current HTTP tests reject metadata drift and changed selected fields before staging. Sol's narrow static review at this head found 0 P1/P2 in source-to-restore binding, not whole-PR approval. |
| Atomicity and retries | Same-head owned PG run includes second-upload failure, second metadata-update fault, final receipt fault, unchanged live before-images and exact retry. Stage cleanup includes both apply-first blocking and cleanup-first canonical adoption refusal. LOCAL VERIFIED; arbitrary SQL reference fabrication is not claimed impossible. |
| Cleanup and lifecycle | Same run passes owned expired-stage retirement, terminal late-marker reconciliation, current-reference refusal, shutdown refusal and zero residue. Existing ownership/durability mutations remain SHA-bound below. Applied/displaced/unproven-object deletion and automatic scheduling remain excluded. |
| History/config/trash | Same-head full Workbench 8/8 passes real login/session/router, retained whole-table restore, deleted-row details/restore, right-side row restore, actor name/local time and deleted-column typed restore with captured values. LOCAL VERIFIED with synthetic data, not customer UAT. |
| Browser and async | Archive browser includes 1440/390 scalar and attachment loops, actual cell-editor deletion and restored gallery image. Local-launcher 5001-row scalar restart/unlock evidence keeps its earlier SHA. Over-threshold attachments remain refused; no async attachment claim. |
| Required CI | Exact head has 34 SUCCESS + 1 expected Strict E2E SKIPPED, 0 pending/failure. Plugin run 35470608400 has successful isolated manual-checkpoint acceptance on Node18 and Node20. Local wiring contract rerun: 40/40. TERMINAL for this SHA only. |
| Independent integration review | Sol's full-scope attempt ended with service-capacity error and no verdict. Terra subsequently inspected production integration, migration/runtime, changed Web flows and CI shape; REQUEST_CHANGES for detached-ID access. Diagnostic and contract disposition below; not recorded as APPROVE. |
| Real environment/nightly | Read-only investigation plan in the design lock only. No real-environment reads, generated operational activity, flag changes, dispatch, deployment or customer data/storage. |

Exact commands, both exit 0:

```sh
TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --workbench
TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --browser
```

Logs: `/private/tmp/tm-final-exact-workbench-20260920.log` and
`/private/tmp/tm-final-exact-archive-browser-20260920.log`. Workbench evidence run
`9a599df2-bdd2-4c93-84ca-911061039f4e` records its exact head/tree, eight cases,
zero fixture counters and no cleanup errors. Restored-column screenshot inspected.
Archive run passes 32-migration replay, historical 47/59/127 neighbors, HTTP and
desktop/mobile browser loops and final stage arbitration. Both runs finish with
owned database connections zero and their synthetic clusters removed.

Remote evidence is also attached without changing the tested head:
[terminal CI](https://github.com/zensgit/metasheet2/pull/5882#issuecomment-5745730421),
[exact Workbench](https://github.com/zensgit/metasheet2/pull/5882#issuecomment-5745752817),
[bounded source review](https://github.com/zensgit/metasheet2/pull/5882#issuecomment-5745754301).
No Ready/merge or full-goal completion is inferred from these results.

### Detached-ID Review Triage

Terra reported one P1 candidate: a current-only attachment removed by archive
restore remains publicly addressable by its previous ID. Independently inspected
read/delete service lookups and route authority are unchanged from the base;
existing draft-delete tests explicitly allow owner-authorized deletion without a
record binding. The proposed blanket live-cell-membership condition therefore
needs an access/lifecycle contract, not an inferred permission expansion/revocation.

A temporary diagnostic block in the owned manual-checkpoint runner performed real
HTTP upload and restore: add a new synthetic attachment to the current cell, restore
the older two-attachment selection, and verify the extra ID is no longer in the
cell. Its authorized download remained 200 with exact bytes; anonymous and inactive
actor downloads returned 401. Explicit authorized DELETE returned 200, then GET
returned 404. Fresh authenticated archive reconstruction still returned both
original archived binaries exactly. No archive damage or unauthenticated/revoked
access was reproduced; the observed authorized behavior alone does not establish
the claimed P1 under the existing permission contract. Owner disposition remains
open, not silently accepted as a new rule or declared independently cleared.

Log `/private/tmp/tm-displaced-id-diagnostic-fixed-20260920.log`, exit 0, includes
47/59/127 neighbors and final stage verification; owned/stage connections zero,
synthetic cluster removed. The first diagnostic attempt read the upload response
at `data.id` instead of its real `data.attachment.id` and failed its fixture assertion;
it also cleaned its database/cluster. It is not evidence of a production failure.
The successful diagnostic used a temporary uncommitted test block, not an
unchanged exact-head run or a production-guard mutation. That block was removed;
the script was restored byte-for-byte to HEAD, SHA-256
`5ce69550208e3b749e039da92fa38600488bcbfe04fafba16de2af7537f802b6`.
Only the two reports remain changed. No API/storage/permission behavior was edited.

## Accepted Archive Result Regression (2026-09-20)

### Consolidated acceptance refresh after rediscovery fix

Executed on clean exact `fd85fbdd71d4156ab4b3eece802696f3e86c2aa4`, tree
`2899c5ffa02b878a8cf1645bc0d0ab717395b51f`. Command:
`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --browser`.
Log `/private/tmp/tm-rediscovery-browser-20260920.log`, exit 0.
This supersedes the later chronological note that no fresh DB/browser run was
performed for the rediscovery delta. It does not inject the mounted response race
into Playwright or constitute customer UAT.

| Requirement | Current evidence / remaining boundary |
| --- | --- |
| Migrations and authority neighbors | 32 migration replay gates; 47/47, 59/59, 127/127 suites pass in this run. |
| Original attachment restore | HTTP restores both original binary files; second-upload, metadata and receipt failure/retry oracles pass without partial live effects. |
| Current field and actor authority | Real HTTP hidden/read-only field, record lock, inactive actor, independently logged-in actor substitution and workspace/base relocation negatives pass with no effects. The substitute is another administrator, NOT a second-tenant isolation proof. That named gate remains open. |
| Browser integration | 1440/390 scalar and attachment component/client/HTTP loops pass; Workbench cell editor deletes two attachments and restores both; authenticated gallery PNG decoded. Full synthetic application loop also passes. |
| Cleanup arbitration | Expired-stage commit-before-storage, retry, reference refusal, late writer and apply-wins race pass. Applied/displaced or unproven-ownership deletion is not authorized by these tests. |
| Residue | Owned browser/listeners/cache closed; owned and stage DB connections zero; synthetic cluster stopped and removed. |
| Async boundary | Actual local-launcher 5001-row scalar proof retains its earlier SHA. This run does not prove async attachment restore; over-threshold attachment operations remain refused. |
| Whole-product review | Narrow independent findings have been fixed; no complete independent exact-head approval is claimed. |
| Remote CI | At the read-only snapshot during this run: 29 success, 1 skipped, 4 running. This is not terminal success. |
| Real environment | Nightly investigation plan only; no environment or customer storage/data access. |

Next required evidence is the separately named second-tenant authorization
negative and consolidated independent review, followed by terminal exact-head CI.
Historical OPEN entries below are superseded only where a row or subsequent
SHA-bound section explicitly supplies the corresponding evidence. No blanket
Time Machine completion or merge authorization is inferred.

Code `758e10b68f33c16bfcd2f01bf9690a398fb5c200`, tree
`2293a137b97979a4136ac8b034d5a33e762f626e`; two files, three production
lines changed. Three new mounted cases first failed: reopen before completion,
reopen after hidden completion, and catalog selection during pending execution.
After repair, modal 60/60 plus client 100/100 PASS. Existing sheet-switch,
unmount and durable async job neighbors remain in that suite.

Independent mutations: remove the handler execution guard while keeping the
button disabled -> forced click changes the selected point, exact test RED;
restore unconditional discovery on reopen -> both result retention cases RED.
Both restored before the final 160/160 run. Web app vue-tsc PASS; scoped ESLint
0 errors with two existing fixture warnings; exact-anchor wiring 39/39;
diff-check PASS.

`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --browser`
passed with the same source/test bytes before commit. Log:
`/private/tmp/tm-archive-result-retention-browser-20260920.log`. Includes 32
migration replay gates, HTTP authority/failure/retry tests, scalar and attachment
production browser loops at 1440/390, restored authenticated binary downloads,
and stage cleanup arbitration. Owned and stage databases/connections=0, cluster
stopped and removed. The new timing regressions are mounted tests, not browser
response-delay injections; the browser run is integration regression evidence.

Terra's narrow review timed out before inspection and returned no verdict; it was
closed and is not counted as approval. Successor remote exact-head CI and final
independent integration review remain separate gates.

## Clean Candidate Full-Process Acceptance (2026-09-20)

Exact clean head `0e7dc5c69617a11b3e9a55a7934a944bd3a005ca`, tree
`fb5a98940b63753732f1f56312c4e4952118f86a`. No code was modified during
either execution. These results supersede the historical lack of full launcher
and Workbench evidence only for the cases below.

### Actual Local Launcher

`scripts/verify-recovery-local-startup.mts` passed five cases against a newly
created exclusive PG15 cluster and synthetic local custody/archive. It invoked
the actual `node --import tsx scripts/start-recovery-local.mts` child process:

1. Wrong secret exits before any listener is available.
2. Before FD3 unlock no listener is available.
3. Real login and canonical HTTP async restore complete all 5001 scalar rows;
   each restored value and version is checked against PostgreSQL.
4. A restarted process remains locked without another FD3 delivery.
5. Fresh FD3 delivery unlocks the restart and preserves terminal job state.

Fresh migration and replay both passed. Evidence:
`artifacts/recovery-local-startup/evidence.json` records source hashes,
empty-diff SHA256, five cases, restoredCount=5001, and database/backend/path/
process residue all zero with no cleanup errors. The outer owned cluster was
stopped and removed. This proves real local startup, not async attachments or
internal cleanup invocation through a public API.

### Full Workbench

`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --workbench`
passed 8/8 at the same exact head. The actual LoginView, persisted session,
production App/router/Workbench and MetaSheetServer verify:

- opening history and retaining rows/fields/views on table deletion;
- explicit recovery of that retained table through the table recycle bin;
- named actor and all visible deleted values, then single-row recovery;
- right-side history with deleted details and viewer-local time;
- grid edit followed by preview/confirmation row restore, one version increment
  and unchanged peer;
- field deletion followed by typed configuration restore with captured values.

Evidence: `artifacts/timemachine-workbench/evidence.json`, run
`4139fc54-bc7e-443e-b33d-adb7dbad98c3`, clean worktree; all twelve fixture
residue counters zero, no cleanup errors. Log:
`/private/tmp/tm-current-workbench-20260920.log`; owned DB dropped, connections=0,
cluster removed. The restored-column screenshot was visually inspected.
No real customer data, flags, dispatch, deployment or hard-deleted-table revival.

Luna medium's bounded diagnostics UI audit was stopped without a complete verdict;
it reported no substantiated P1/P2 but explicitly did not approve the scope. Its
partial review is not completion evidence. At the last remote observation of
`0e7dc5c696`, 30 checks succeeded and web-tests/Node18/Node20 remained pending,
with zero failures. This is not a terminal-green claim.

## Local Launcher Cleanup Evidence (2026-09-20)

Code `4ef3222d146d271d73e00008b91b7c4b134c435b`, tree
`bce3bf5a2d97f1d1d5649a9384dcbe8a596bc335`; five code/test files.
Audit found that the preceding internal API checkpoint had no cleanup capability
in the real local launcher. This checkpoint adds that bounded composition.

- New startup test first failed because the cleanup resolver was never called.
  Startup/application/reader neighbors then passed 3 files / 107 tests.
- A lookalike method on a non-local provider does not grant cleanup. OFF startup
  never calls the resolver. Throw/cancel while resolving refuses and scrubs the
  supplied secret. Service instances have no retireRecoveryAttachment method.
- Removing attachmentCleanupStorage from returned composition makes the positive
  startup test RED; restored full startup suite 20/20 GREEN.
- The real stage verifier now obtains its storage port through the same static
  local-service resolver, then invokes application cleanup against real PG and
  filesystem. `/private/tmp/tm-local-cleanup-composition-realdb-20260920.log`
  passes expiry/reference/commit-before-IO/retry/race gates; database/connections=0
  and owned cluster removed. It does not invoke cleanup through an enabled child
  launcher, and is not claimed as such.
- Core plus acceptance-script typecheck PASS; changed source ESLint 0 errors and
  warnings; diff-check PASS. Existing selected spec/runner paths unchanged.
- Terra medium narrow read-only review of committed `f9d461ea94` cleanup lifecycle
  returned no P1/P2 and was closed. It did not review this later launcher patch
  or the complete PR. No broad independent APPROVE is claimed.

Remote CI must bind the new pushed head; earlier green checks do not prove it.
No real environment/storage, flags, dispatch, deployment or merge was performed.

## Internal Cleanup Runtime Evidence (2026-09-20)

Code `f9d461ea944bad70912b4553502bba0efa0153af`, tree
`72031b8692498dd9a0ef069c7ae9ceceb8b6c1f4`; five code/test files only.

- Application and server wiring: 2 files / 58 tests PASS. Explicit storage is
  bound once; disabled/missing-port calls refuse; stop waits for accepted cleanup,
  refuses new cleanup and releases custody only after drain; provider errors are
  values-free. Server-level OFF entry does not resolve the pool or factory.
- Drain mutation: removing the active-cleanup wait initially survived a test that
  inspected only one microtask. The test now waits a full event-loop turn. The
  same mutation fails with stopped=true while cleanup is unresolved; restoring
  the wait returns the complete 58-test suite to GREEN.
- Real PG/local-storage application composition PASS:
  `/private/tmp/tm-cleanup-application-realdb-20260920.log`. Expiry/reference
  refusal, durable abandonment before IO, failed-retirement retry and terminal
  reconciliation are exercised through the application method. After stop it
  refuses. The separate apply-versus-cleanup race still tests the ledger helper.
  Stage database/connections=0; owned cluster stopped and removed.
- Core plus acceptance-script typecheck PASS; source ESLint 0 errors with 22
  existing index warnings. Default ESLint cannot parse the acceptance script
  because it is outside its configured project; the dedicated acceptance tsc
  covers it. No lint configuration was widened.
- Existing exact-anchor CI wiring 39/39 PASS; diff-check PASS.

Sol's bounded broader read-only audit ended without a terminal verdict and was
closed; no fresh external APPROVE is claimed. This is local evidence, not the
new remote exact-head CI result. Internal entry binding is closed in this scope;
applied/displaced-object cleanup, partial-proof deletion, public scheduling and
real environment operations are not claimed. Prior SHA-scoped Workbench and HTTP
evidence remains distinct and is not rebranded as new customer acceptance.

## Inspector Restore Execution (2026-09-20)

### Scope Relocation And Accepted Batch Result

Code `74bfcae9e821813da91519b0c487ce45cd6e998f`, tree
`7a316ec7d77c4f4b8d645c0cd28a99414f851c5e`; HTTP test parent
`3031025e0d2ee2bebfb744893328be1b0356fd33`.

The owned full default runner passes with the exact HTTP test bytes before
commit (`/private/tmp/tm-scope-relocation-realdb-20260920.log`). After an executable
attachment preview, independent workspace/base relocations each return 404 with
`RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND`. Records, attachment storage metadata,
stages, history operations/revisions, token burns and receipts remain unchanged.
Fixture scope is restored in finally and the original positive execution succeeds.
This is scope relocation, not a second-tenant user isolation claim. The full run
also passes migration replay, existing history/authority neighbors and the stage
cleanup verifier; owned database/connections=0 and cluster removed.

Sol medium read-only review (session `01a0bb45-039d-7f91-b478-083dc087c5f0`,
closed) found one P2 in the preceding UI delta: cancelling an accepted batch
execute hid its eventual result. A new mounted regression first fails on that
code. The fix separates context invalidation from cancel, disables executing
dialog controls, and retains result/refresh in the original context. Removing
the handler guard reproduces the same exact failure; restoring it passes.
Four focused files pass 69/69, core/app typecheck pass, scoped ESLint has zero
errors/eight fixture warnings, wiring 39/39 and diff-check pass. No fresh
independent APPROVE or remote exact-head CI completion is claimed.

Clean exact-code owned Workbench browser run at `74bfcae9e8` passes 8/8
(`/private/tmp/tm-batch-cancel-exact-browser-20260920.log`), with database/
connections=0 and cluster removed. These preserve actual application recovery
flows; the cancellation race itself is the discriminating mounted test above.


### Batch Isolation Checkpoint

Code `fb881f3c869e86b2b093998f734fc0cf230dadc7`, tree
`57f7e7851479055db3ac1b5b61d3275e33c315b7`. Five new cases fail against
the previous implementation: cancel/base/sheet invalidation, pending advanced
preview confirmation, and duplicate execution. Final existing wiring suite
32/32 plus history panel 16/16 pass. Removing the cancellation sequence increment
causes precisely two selected negatives to fail (cancel and sheet roundtrip);
restoring it returns the full 48/48 to green. Unmount is separately covered but
is not claimed as a discriminating case for that specific mutation.

Application vue-tsc passes; ESLint zero errors/eight fixture warnings; wiring
contract 39/39 and diff-check pass. Owned synthetic Workbench acceptance 8/8
passes with final product bytes before commit, connections=0 and owned DB/cluster
removed. Browser cases preserve existing flows; the async interleavings above
are mounted-component evidence, not a claim of browser race injection. No remote
CI success or full-product completion is inferred from this local checkpoint.


### Async Preview Isolation Follow-up

Local patch based on `c6541af54464c05d066e39975d5ab728c555d13b`:
five new regression cases first failed against the previous implementation
(out-of-order identity, cancel, sheet/base navigation, obsolete rejection).
The final existing wiring suite passes 24/24; history panel neighbor 16/16.
Additional cases cover pending success after cancel/unmount/sheet roundtrip and
accepted execution settling after navigation without refreshing the new sheet.
Application vue-tsc passes; scoped ESLint has zero errors and eight fixture
multi-component warnings; diff-check passes. Owned synthetic Workbench browser
acceptance passes 8/8 with this uncommitted patch, connections=0 and database/
cluster removed. This is not remote CI or real-environment UAT evidence.


Code `8420aea01b61b960c0fffaa4d3804ccfa004d6df`, tree
`61cd16fa1db5e2c97acabf99a50990c194730d51`. One existing acceptance script
only; production Workbench was restored byte-identically after mutation.
Clean owned `--workbench` run `9ec19e86-34df-40f6-ba1b-fa706e57c845` passes
8/8, artifact worktreeClean=true, all fixture counts zero, cleanupErrors empty.
Log `/private/tmp/tm-inspector-restore-exact-20260920.log`; database/connections
zero and cluster stopped/removed.

The new case edits Quantity from 7 to 42 through the real numeric grid editor and
requires a successful production patch request. It opens inspector History and
previews v1, verifies persisted data/version are still unchanged before confirm,
then confirms and requires the real restore-execute request to succeed. Data equals
the retained earlier row; version increments exactly once; the peer row remains
identical. Refreshed history displays the restored-from badge. Screenshot
`artifacts/timemachine-workbench/record-inspector-restored.png` was inspected and
shows Quantity 42 -> 7 with Restored from v1.

Mutation changes the Workbench execute targetVersion to targetVersion+1 while
keeping its preview identity. The real endpoint responds 409 and the new browser
case fails at the 200 oracle (`tm-inspector-restore-mutation-20260920.log`).
Restoring the production line produces the clean eight-case pass. Wiring 39/39
and diff-check pass. This is a synthetic desktop positive, not all field types,
mobile inspector execution or customer UAT; exact-head CI is separate.

## Terminal Cleanup Reconciliation (2026-09-20)

Code `df302d9b03b923e9ef106b64369fca9f710c7a45`, tree
`8cd5fae0fb111ae8d832d4f17e6a7ecd77309c9d`. Two files only: the existing
stage-ledger service and its owned real-DB acceptance script.

`/private/tmp/tm-terminal-cleanup-red-20260920.log` proves the original early
return leaves the exact-proof late directory present. Reinstating that return
after the fix produces the same failing ENOENT oracle in
`tm-terminal-cleanup-mutation-20260920.log`; mutation restored.
The clean committed `--attachment-stage` run exits 0 in
`tm-terminal-cleanup-exact-20260920.log` and proves:

- A retry after cleaned reconciles a newly present exact-proof private directory.
- Incomplete proof remains untouched; the complete terminal row is byte-equivalent
  before/after replay, including timestamps.
- A current metadata reference introduced before retry refuses with zero storage
  calls. This is not a claim that arbitrary direct SQL is a supported writer.
- Existing expiry, abandonment-before-IO, storage failure/retry, late open-file
  writer, terminal-state and apply-vs-cleanup row-lock race cases still pass.
- Database/connections zero, synthetic cluster stopped and removed.

Reader/storage neighbor 42/42, core type-check, scoped ESLint, wiring 39/39 and
diff-check pass. These local tests do not prove all possible process-death or
power-loss interleavings, displaced-object cleanup, NAS behavior or production
readiness. No schedules or customer environment were touched.

Sol high bounded read-only review was closed while still running without a
terminal verdict. It is not counted as approval. Local code review found no new
permission/state transition; independent whole-PR review remains open.

## Post-Preview Identity Refusal (2026-09-20)

Test-only code `e24c7bc7fd55c1d05c9dd84e5be717db19e88666`, tree
`6a5bdcc0a6754e60aa282dc9300e07b34d93edaa`, adds two real HTTP cases to the
existing owned checkpoint runner. The run began before commit with exactly the
committed script content; no production code changed.

`/private/tmp/tm-restore-identity-realdb-20260920.log` records exit 0 for the full
default runner, including fresh/replay, historical neighbors, checkpoint/restore
and stage gates. After a valid attachment preview:

- Deactivating the original actor makes execute refuse 401, then the fixture
  restores the actor in finally.
- A second synthetic admin logs in through the production login route and gets
  a distinct authenticated user ID; using the original preview refuses 409.
- Both refusals preserve record data/version, attachment storage metadata, stage
  count, revision/operation counts, token burns and receipts.
- The same original preview then succeeds for its original active actor, returns
  original binaries and refuses replay, providing the matching positive control.

Core type-check, wiring 39/39 and diff-check pass. Owned and stage databases and
connections are zero, and the cluster is stopped/removed. This proves post-preview
actor revocation/substitution, not a second-tenant test or a new mutation verdict.
The broader authorization gate remains open for its other explicitly listed axes.

## Inspector Deleted-Value Regression (2026-09-20)

Code `ec3cf65f6f88ea3157c8bfb912b8c7e45aa77d6f`, tree
`96a9f04c5d65282a1b7af780f56b469a3d3776e3`. Clean exact-head owned
`--workbench` run `c3c1a0ff-ab31-411a-bbc8-02df947487a8` passes 7/7;
log `/private/tmp/tm-inspector-clean-exact-20260920.log`. Its artifact records
worktreeClean=true, all 12 fixture counts zero and cleanupErrors empty. The
parent confirms zero connections, drops the database and removes the PG cluster.

The added case opens the grid's real record inspector, selects History, requires
the exact row-history GET to return 200/ok with nonempty items, matches rendered
row count, and checks actor name, viewer-local timestamp and both deleted values.
No API response is mocked. Screenshot `record-inspector-history.png` under
`artifacts/timemachine-workbench` was visually inspected; deleted fields are now
visible. Earlier screenshot showed the actual missing-value defect.

- Focused component/drawer/restore/inspector: 4 files/65 tests pass, including
  existing non-delete snapshot leak-lock and restore payload contracts.
- New deleted-value case failed before implementation and fails again when the
  delete-only display branch is removed (1 failure/15 pass); restoration passes.
- Temporarily removing the real Workbench inspector apiClient binding makes the
  browser gate fail waiting for its required history GET. Production binding
  restored byte-identically; the clean final seven-case run passes.
- Web application vue-tsc, scoped ESLint, wiring 39/39 and diff-check pass.
  ESLint initially lacked the local parser link; it passed using the installed
  canonical pnpm-store NODE_PATH, without installing or changing dependencies.
- Existing two CI lanes already select multitable-record-history-panel by its
  filename token; no selector change or new test file required.

Logs use `/private/tmp/tm-{deleted-inspector,inspector}-*20260920.log` names.
The first browser attempt used the wrong envelope level in the new assertion;
it was corrected to the existing ok/data contract and is not a product failure.
This synthetic acceptance does not certify real tenants, mobile inspector layout,
sidebar historical-version execution, hard-delete revival or full TM completion.

Sol medium independent read-only review of `def7e70a92..ec3cf65f6f` returned
PASS with no P1/P2, confirming the delete snapshot is already filtered by the
existing route authority and restore semantics are unchanged. Session closed;
the reviewer did not rerun tests and this is not whole-PR approval.

## Owned Workbench Regression (2026-09-20)

Code `e219198d806a4383606bf0837e9e209db10b6a2b`, tree
`356a8508ea0ccd40cfe894bedcc79d8153f289db`. The existing owned PostgreSQL
driver now accepts mutually exclusive `--workbench`, `--browser` and
`--attachment-stage` modes. No production or permission semantics changed.

`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --workbench`
passed 6/6 on the clean exact code head. Evidence run
`c0bfb031-1f76-444e-b062-349d3e6b914d` records `worktreeClean=true` in
`artifacts/timemachine-workbench/evidence.json`. Log:
`/private/tmp/tm-owned-workbench-clean-exact-20260920.log`.

The real LoginView, App/router and MetaSheetServer verify retained whole-table
deletion/restoration, deleted-row names and values followed by selected-row
restoration, and deleted-column configuration restoration with captured values
and viewer-local time. This is retained soft-delete recovery, not hard-deleted
table resurrection. The history entry exercised here is the toolbar dialog,
not an independent right-side record inspector acceptance.

All 12 fixture residue counts are zero, cleanupErrors is empty, and the driver
independently checks zero database connections, drops its generated database and
stops/removes its cluster. Default-mode regression also exits 0 with historical,
manual capture/restore and stage gates green; log
`/private/tmp/tm-owned-runner-default-final-20260920.log`. The attachment-stage
neighbor passes in `tm-owned-runner-stage-neighbor-20260920.log`.
Wiring is 39/39; history/config/trash frontend neighbors are 9 files/176 tests.
Initial new runner contract tests were red before implementation. These are local
synthetic results, not remote CI, real-tenant UAT or full TM completion.

## Full Application Acceptance Passed (2026-09-20)

Code `2e86dd86af1e5105e7987fd8d43f59cbe61ca7dd`, tree
`d709609381a3679d11bfd366ee3de231dfcc965f`, parent
`b4f5dea11654dfb82cab98b73a9763af5cfba435`. Two acceptance scripts only;
production code, permissions, schema and feature defaults are unchanged.

The full command
`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --browser`
exited naturally with code 0. Log:
`/private/tmp/tm-full-app-clean-exit-20260920.log`.

- Real LoginView obtains a production login response for the synthetic account;
  browser storage initially contains no token. The real main entry, App shell,
  protected router and MetaSheetServer serve the subsequent requests.
- Both 1440/390 application legs pass archive capture/reload, actual cell-editor
  deletion of two attachments, preview/explicit confirmation, one restore request,
  record version/history readback, authenticated image/gallery decode and saved
  original download-byte equality. No failed/non-2xx API or page error is tolerated.
- Application startup uses an allowlisted synthetic environment, loopback listener,
  owned database/storage and disabled external/plugin integrations. No fake plugin
  discovery response or manually injected browser token is used on this leg.
- Owned shutdown explicitly destroys the admin SafetyGuard and in-memory
  idempotency singletons via their existing APIs after server stop. The resource
  guard reports zero remaining referenced timers. The earlier no-cleanup run
  failed on exactly those two timers; no forced successful exit or timer unref
  workaround is used. This proves acceptance cleanup, not general server.stop
  singleton ownership.
- Full historical neighbors, migration replay, manual checkpoint and the subsequent
  attachment-stage ledger sequence pass. Both databases/connections are zero;
  browser, Vite cache/listener and the owned PostgreSQL cluster are closed/removed.
- Core type-check, JavaScript syntax check, wiring 37/37 and diff-check pass.
  Logs: `/private/tmp/tm-full-app-clean-exit-{tsc,wiring}-20260920.log`.

Inspected screenshots under the system temporary directory:
`tm-manual-http-browser-application-{1440,390}.png` and
`tm-restored-gallery-390.png`. The controls remain within the viewport. This is
synthetic full-application acceptance, not organization-switching or real-tenant
UAT. Broader Time Machine completion is still open. This checkpoint's remote
exact-head CI is separate and pending publication; #5882 remains Draft/HOLD.

## Earlier Full Application Diagnostic (2026-09-20)

Uncommitted acceptance-only work on parent
`b4f5dea11654dfb82cab98b73a9763af5cfba435`; not published evidence.
The real LoginView, main application entry/router/shell and MetaSheetServer
ran against the owned synthetic database and local attachment store. No token
was injected into browser storage on this application leg. Startup uses an
allowlisted environment, disables external/plugin integrations and binds loopback.

Log `/private/tmp/tm-full-application-browser-final-20260920.log` records both
1440/390 application legs passing capture, actual cell-editor attachment deletion,
confirmed restore, database/history readback, decoded gallery image and original
download-byte checks. Failed/non-2xx API responses remain fatal. The standalone
Workbench overflow mutation remains in its own leg; the full App outlet contains
overflow differently and is subject to the positive viewport check instead.

**Overall result: NOT PASS.** After application stop and zero database/connection
readback, the checkpoint process did not exit naturally. The owned child was
terminated; the outer runner failed and stopped/removed its cluster. The subsequent
stage-ledger leg was not run. A duplicate pool-close diagnostic also occurred;
its acceptance cleanup adjustment was then unverified. Do not force a successful
process exit, count this as full UAT, or infer production lifecycle correctness.
The passing checkpoint above supersedes this incomplete run after identifying
the two admin singleton timers and rerunning the complete driver. No real organization-selection or customer
environment evidence is claimed. The nightly investigation remains plan-only.

## Latest Real Grid-Editor Deletion Evidence (2026-09-20)

Code `0aac78fcee2393f57f8e107287706b62ba8de136`, tree
`115d353c180056ef1b951d47b814d1c299d12325`, parent
`532109af3b15f956d94386dc56ba7835920a4e81`. Two acceptance scripts only;
no production/runtime/schema edits.

Command:
`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --browser`
completed exit 0. Log `/private/tmp/tm-real-cell-delete-browser-20260920.log`.
The owned fresh PostgreSQL/manual checkpoint/stage-ledger sequence passes and
all owned databases, connections, cluster, browser, Vite listener and cache are
cleaned at completion.

At both 1440 and 390 pixels, the actual Workbench now:
1. Captures and reloads a recoverable archive; unchanged preview performs zero writes.
2. Opens the original attachment cell through double-click and invokes Clear All.
3. Receives two successful production attachment DELETE responses. Database
   readback requires the empty attachment field, two version increments, two
   `source=attachment` revisions with the exact changed field, and final empty patch.
4. Previews one changed row and executes only after explicit confirmation.
5. Restores the complete prior row data, exactly one additional record version and
   one restore revision. The grid changes from zero to two attachment references.
6. Reads both restored original binaries, decodes the image/lightbox/gallery cover,
   and verifies the browser's saved download bytes against the archived source.

No failed/non-2xx API request or page error is accepted. Screenshots were inspected
at both widths: `tm-manual-http-browser-workbench-{1440,390}.png` under the owned
temporary screenshot directory. No horizontal overflow was found. Existing
toolbar/cover counterexamples and SQL seal-guard mutation in the full runner remain
discriminating; no new production guard was introduced in this test-only change.
Core type-check, JavaScript syntax check, 37/37 existing CI wiring checks and
diff-check PASS. Logs: `/private/tmp/tm-real-cell-delete-{tsc,wiring}-20260920.log`.

This supersedes the earlier SQL-only Workbench edit limitation, not the complete
application UAT limitation: the account logs in through production HTTP, but the
real LoginView/organization selection/app shell are not yet exercised. Standalone
scalar/modal legs remain explicitly synthetic SQL edits. Exact-head remote CI
for this checkpoint is pending; #5882 remains Draft/HOLD.

## Latest Archive Modal Lifetime Evidence (2026-09-20)

Code `27aa9351fc8b093576941017e7875431c0ae59e5`, tree
`105d3eaaf54e43da863b19b8cc10329f0711d4c3`, parent
`02e521c0e6f7d8cedd3ae2e4dace1304ccd402d4`.

Three deferred-response negatives reproduce the old behavior: an in-flight job
read succeeding or failing after unmount restarts polling, and late async job
acceptance also starts a read after unmount. All three RED before implementation.
The fix guards disposed snapshots/timers and invalidates execute/job identities.
Removing the unmount assignment/invalidation makes exactly these three cases
RED again. Restore, then final archive modal/client/workbench restore-wiring:
3 files / 172 tests PASS, including original-sheet acceptance and reopen cases.
Every new case also asserts no cancelJob invocation: UI disposal must not cancel
server work.

The unchanged main multitable-web-guard Vitest command passes 295 files / 4093
tests (includes the previous history-time cases). This large command does not
replace the separately executed archive-specific 172-test gate above. App
vue-tsc, scoped ESLint and diff-check PASS. No DB migration or real environment
operation was needed for this two-file UI lifetime change.

Logs: `/private/tmp/tm-archive-unmount-{red,green,mutation,final,domain,tsc,lint}-20260920.log`.
Luna medium bounded read-only review did not return a terminal verdict before
closure; session `01a0bad9-dae6-7390-a234-4ad282dd0600` is closed and no external
approval is claimed. Code remains in #5882 Draft/HOLD, remote exact-head CI is
not yet a completion claim. Full application UAT and storage residual boundaries
remain open as documented below.

## Latest Record History Presentation Evidence (2026-09-20)

Code: `10a665746c94baa21864267386efbe82f34532a3`.
Tree: `67c3fc3e9b427bfe9bc7975966bcb7445a28f69b`.
Parent: `60908afd4536fc8ae93dfb52b4a120485bb0c247`.
Two product/test files only: MetaRecordHistoryPanel.vue and the existing
multitable-record-inspector.spec.ts. No DB/backend/workflow changes.

- Old implementation: both new English/Chinese history-tab cases RED because
  the original timestamp/semantic time element was absent.
- Final six-suite regression: 127/127 PASS (record inspector, history panel,
  drawer history diff, drawer restore, configuration history and sheet trash).
- Final restoration under `TZ=UTC`: the same 127/127 PASS. Explicit
  `TZ=Asia/Taipei`: both new cases PASS. Each expects the device-local time,
  visible zone, UI language, original datetime/title, invalid legacy fallback,
  actor display name and missing-name ID fallback.
- Mutation replacing the shared formatter with plain toLocaleString: both new
  cases RED on the rendered text; restored before final runs and commit.
- App vue-tsc PASS. Scoped ESLint: zero errors, seven existing multi-component
  harness warnings. Diff-check PASS.
- Existing `multitable-record-inspector` token covers this spec in both
  multitable-web-guard and run-required-web-tests.sh; no new spec or selector.
- Logs: `/private/tmp/tm-history-time-{red,green,mutation,final-utc,final-taipei,tsc,lint}-20260920.log`.

These are mounted component tests, not full application login/org-selection UAT.
Remote CI for this new code is not yet claimed. PR #5882 stays Draft/HOLD.

## Exact Parent Stage-Ledger Reverification

At clean `60908afd4536fc8ae93dfb52b4a120485bb0c247`, the owned runner
`TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs --attachment-stage`
completed with exit 0. Fresh isolated PostgreSQL stage-ledger replay, drift,
concurrency, metadata authorization/rollback, abandonment-before-storage,
reference refusal, late-writer barrier, retirement retry and cleanup-versus-apply
passed. Database/connections=0; owned cluster stopped and removed. Log:
`/private/tmp/tm-stage-exact-60908afd-20260920.log`.

This extends the prior marker-cleanup local evidence, not a whole-product
completion claim. The terminal cleaned-state replay intentionally performs no
additional storage IO; its pinned contract was not changed. Unprovable residual
objects, general late-process-death reconciliation, displaced objects and full
application acceptance remain separate residuals. No real environment accessed.

## Completed Local Evidence

- Internal descriptive cell planner preserves original reference ordering and
  selected scope without changing input maps or scalar values.
- Explicit empty scope, malformed/duplicate references, missing or duplicate
  attachment index evidence, archived-deleted references, wrong original record/
  field, missing live record and missing selected field fail closed.
- Scalar-only selection and identical attachments remain no-op; restoring an
  empty reference list plans detachment, not file deletion.
- Two files / 24 unit tests PASS: attachment-plan and existing archive-preview.
- Core `type-check` PASS (including archive acceptance script project).
- Source ESLint and diff-check PASS.
- Mutation removes original record/field ownership checks: precisely the two
  ownership cases fail (10 pass / 2 fail). Restore and both suites PASS 24/24.
- Existing installed dependencies were linked into this new worktree; no install
  or dependency/lockfile change.

The helper is not called by runtime yet and is not an authorization proof. Its
new unit file is not yet explicitly enrolled in the required archive CI lane;
local success is not published-head CI evidence. No successor PR is published.

## Source And Authorization Checkpoint

- Attachment-only and mixed scalar/attachment plans project into the canonical
  write-intent shape, preserving live versions, exact changed-field IDs, scalar
  peers and input immutability. Drift, duplicate cells and conflicting ownership
  reject the complete projection.
- The existing canonical plan authorizer accepts a writable attachment field,
  refuses hidden/read-only fields, and rechecks current management authority.
  Omitting attachment changed-field IDs yields exactly two false-allow failures;
  restoring the projection returns the suite to green.
- The real encrypted reader now privately retains authenticated attachment
  generation/workspace/base/sheet/record/field, deleted state, size and media
  type. Restore-source access checks all original identities, refuses archived-
  deleted/missing entries and forged state, and returns defensive binary copies.
  This was exercised through both the internal reader and public complete-state
  reconstruction. It does not invent the absent archived display filename.
- Removing the original record/field checks produced the targeted real-reader
  failure. Restored final run: four files / 58 tests PASS (reader, attachment plan,
  canonical plan authorization and archive preview).
- Core type-check (both projects), source ESLint and diff-check PASS.

These are real reader and authorization-component checks, not end-to-end file
restoration. No storage preparation, metadata update or live restore is enabled
by this checkpoint. The public preview still refuses attachment differences.

## File Preparation Checkpoint

- New internal staging function reads only a reader-authenticated source matching
  its original scope, checks current authorization before reservation, waits for
  the reservation port, and exclusively creates the fixed object path outside
  database transactions. It independently checks readback bytes, digest, length
  and immutable version before calling the verified-receipt port.
- Tests use real encrypted archives and the real local filesystem provider,
  including a freshly constructed read provider. Nine cases cover normal write,
  crash-before-receipt retry, verified retry, conflicting existing bytes, denied
  authorization, transaction-depth refusal, receipt failure, false readback and
  provider mutation. Collision/error never deletes an existing object.
- The reservation/receipt port is a test double here, NOT PostgreSQL durability
  evidence. There is no production ledger adapter, cleanup worker or runtime
  caller yet. Crash/retry in these tests means the owned identity is supplied
  again; it does not prove process-restart recovery from a persistent ledger.
- Removing independent readback hashing makes the false-readback test RED;
  restoration returns the full matrix to GREEN.
- Sol high independently reviewed committed `19d8e6e4` (not this new staging
  module): no P1, one P2 for shallow nested aliases in projected intents. Both
  scalar+attachment and attachment-only negatives reproduced RED. Deep copying
  closes both and preserves input/output detachment. No fresh external approval
  of the later staging module is claimed; the review session is closed.
- Final local matrix: five files / 95 tests PASS, core type-check (both projects),
  source ESLint and diff-check PASS. Log:
  `/private/tmp/tm-attachment-stage-verified-20260919.log`.
- Latest merge-main check snapshot: 27 checks, only Node20 pending, no failed
  check. Not yet claimed terminal combined-main green.

## Durable Ledger Checkpoint

- The PostgreSQL staging identity is keyed by actor/token hash/attachment and
  binds the complete archive/original scope, source version, digest, size and a
  unique object UUID. Scope/content cannot be rewritten; the only implemented
  state transition is reserved to verified. This does not yet implement applying
  or retiring prepared objects.
- Each adapter call owns and completes a transaction before file I/O. Source
  archive is locked before the stage row in both methods. Current authorization,
  source state and expiry are checked again, including verified retries.
- Isolated PG15 proves concurrent same-request identity, changed-content refusal,
  new-pool replay, exact verified receipt, authority denial, expiry rejection,
  immutability, empty down/down/up and populated-down refusal. Dropped NOT NULL,
  disabled row/truncate triggers, absent unique, deferred primary key, CHECK(true)
  and replaced function all make migration replay RED; transaction rollback and
  canonical replay restore GREEN. Removing the adapter's exact identity compare
  makes changed-content replay falsely succeed and the gate RED.
- The focused ledger fixture uses a minimal owning archive table and does not
  claim the whole production archive admission protocol. Separately, the complete
  owned-cluster driver passed fresh full migration and replay, 32-migration census
  (989 catalog objects; fingerprint
  `e89ec920a16e18b651df5a062a4ab31183010fa43d8c93472a3584c8e68d9d3c`),
  historical neighbors 59/59 and 127/127, manual attachment capture and HTTP scalar
  restore. The driver then runs the new ledger gate unconditionally.
- Initial full-neighbor failure was new-child FK cleanup omission in the older
  migration suites. The existing empty-layer suspension helper now unwinds and
  restores this layer; production FK and nonempty-down guards remain intact.
- Default-driver removal mutation and new migration removal mutation are pinned
  in the wiring contract: 37/37 PASS. Core type-check, source ESLint and diff-check
  PASS. All owned databases/connections and cluster directories were cleaned.
- Log: `/private/tmp/tm-attachment-stage-full-neighbors-20260919.log`.
- Merged #5849 base `868c8d2b...` now has 29 terminal checks, zero pending/bad.
  This is base evidence, not CI for this unpublished successor.

## Late Purge Completion Protection

- Guarded direct/orphan/sweep completion stamps require the claimed storage path,
  a deleted row, an outstanding purge claim and no previous completion. An old
  storage callback cannot mark a restored or replacement attachment as purged.
  Flag-disabled legacy stamp SQL is unchanged.
- Attachment service/cleanup unit tests: 49/49 PASS, including stale completion
  counted as skipped rather than deleted. Core two-project type-check PASS.
- Owned PostgreSQL stage gate: active row refused; old path after replacement
  refused; matching deleted object stamped once; repeat refused. Ledger gates
  remain green. Database/connections zero and owned cluster removed.
- Mutation removed the storage-path predicate: real PostgreSQL assertion at
  `verify-recovery-attachment-stage.mts:43` failed (true versus false). Restored
  implementation passed. Logs: `/private/tmp/tm-attachment-purge-path-mutation-20260919.log`
  and `/private/tmp/tm-attachment-purge-path-restored-20260919.log`.
- This is a restore prerequisite, not metadata writeback or browser acceptance.

## Metadata Transaction Participant

Exact code checkpoint: `b50271ab2ef1c54ddb1d7751d2af0b546dd61b1d`, parent
`2ba545173` (late purge completion protection). Local only; no remote CI or
successor publication is claimed.

- New internal participant locks the verified source/stage and existing original
  attachment metadata, checks actor/token/object/source identity, original row and
  field existence/type, retained metadata fingerprint and current authorization.
  It preserves filename/media metadata, changes storage identity and clears purge/
  deletion markers inside the caller transaction. No public entry point added.
- Owned PostgreSQL positives/negatives cover authority denial, zero transaction
  depth, actor/token/object/field substitution, unverified reserved stage, stale
  fingerprint, missing original record, changed field type, metadata/provider
  drift, successful metadata update and stale retry rejection.
- A forced later failure rolls the entire metadata row back byte-equivalently.
  This uses a synthetic enclosing transaction, NOT actual record/history apply.
- Removing the metadata hash check causes an expected-rejection failure at
  verifier line 135; removing the verified-state check causes one at line 144.
  Both were restored and the complete stage gate passed afterwards.
- Full owned driver: fresh migrations/replay (32 migration census, 989 catalog
  objects), historical neighbors 59/59 and 127/127, existing encrypted capture/
  reader and HTTP scalar restore, plus stage/metadata gates PASS. Fingerprint
  remains `e89ec920a16e18b651df5a062a4ab31183010fa43d8c93472a3584c8e68d9d3c`.
- Focused unit neighbors: six files / 118 tests PASS. Wiring contract: 37/37 PASS.
  Core two-project type-check, new source ESLint and diff-check PASS. All owned
  databases/connections and cluster directories removed.
- Logs: `/private/tmp/tm-attachment-metadata-{full,restored,unit,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-metadata-hash-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-metadata-verified-mutation-20260919.log`.
- Sol high bounded read-only review was closed while running after its time
  limit, without a terminal verdict. No independent approval is claimed.

## Preview Authority And Plan Identity

Exact code: `359935892af0c13e73b3c432b7b71f9b1ec6e597`; main rechecked
`868c8d2b26424fcaa8405661a6999abb17ec6d93`. Local only.

- Production preview now includes real attachment field/reference deltas in
  authorization and the blocked summary. Denial returns the existing values-free
  authority error. Authorized attachment changes still have no executable token.
- Internal sync-plan v2 binds a canonical closed metadata roster, with unique
  attachment IDs, original record/field scope validation and detached frozen
  entries. Omitting the roster retains the exact existing v1 hash; an explicit
  empty roster is a distinct v2 identity, not an accidental downgrade.
- Tests change every identity axis, reject malformed/extra/duplicate/out-of-scope
  entries, and prove source mutation cannot change the compiled plan.
- Mutation omitting roster hash content: 1 failure / 8 passes. Mutation omitting
  attachment write projection: 3 failures / 10 passes, including permission denial.
  Both restored; focused five-file suite 79/79 PASS.
- Full owned DB driver PASS, including fresh/replay 32/989 catalog census,
  59/59 + 127/127 historical neighbors, encrypted capture, existing scalar HTTP
  restore and the new stage/metadata participant gates. All DB/connection/cluster
  residue zero. Core type-check, source ESLint, wiring 37/37, diff-check PASS.
- Logs: `/private/tmp/tm-attachment-preview-binding-{full,restored,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-plan-hash-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-preview-auth-mutation-20260919.log`.
- No new external review this checkpoint. The production preview does NOT yet
  collect database metadata fingerprints, mint v2 identities or invoke attachment
  apply. No attachment restore browser/UAT evidence is claimed.

## Canonical Sync Transaction Integration

Exact code: `19f90ced8b09ebefc1b3cb6b1283c7fcde93b465`; remote main
rechecked `868c8d2b26424fcaa8405661a6999abb17ec6d93`.

- The internal materialized sync executor now validates the preparation roster
  against the token's v2 plan hash, rebuilds attachment field changes after the
  existing fence/row/schema checks, and submits those fields to locked plan
  authorization. Scalar/link projection remains unchanged without a batch.
- The batch requires exactly all before/target metadata identities, exactly the
  target set of verified stages, exact original scope and current metadata hashes.
  Metadata and record reference CAS now share canonical history/seal, token burn
  and receipt transaction. No public HTTP attachment restore is enabled.
- Four real-DB cases prove success, later-write rollback, authorization denial and
  metadata drift. Success verifies metadata path identity, restored record data,
  version increment, attachment-bearing history patch, one receipt and refusal of
  the second token execution. Failure cases pin zero history/burn and unchanged
  record/metadata. These are direct internal-kernel calls with synthetic verified
  stage rows and authority callbacks, NOT file IO or end-user permission UAT.
- Bypassing the batch apply call yields two exact failures: unchanged tombstoned
  storage metadata on success, and drift incorrectly accepted. Restored GREEN.
- Full D5 suite 44/44 PASS (including the four new cases); historical migration
  neighbors 59/59 and 127/127 PASS; full fresh/replay/manual capture/scalar HTTP
  and stage/metadata gates PASS. Owned DB/connections/cluster residue zero.
- Five focused unit files 59/59 PASS; core two-project type-check, source ESLint,
  diff-check and wiring contract 37/37 PASS. No new external review this checkpoint.
- Logs: `/private/tmp/tm-attachment-canonical-{apply,mutation,full,unit,wiring}-20260919.log`.
  The initial fixture used the legacy string actor ID and correctly failed the
  UUID stage boundary; the new fixture now uses a synthetic UUID, without relaxing
  production validation. The successful full log has no skipped D5 tests.

## Durable Adoption Checkpoint

Exact code: `0ddbab86007424ebb72c740ee76f3e87872c865e` (local only).
Six code/test files; no public restore entry point enabled.

- Verified stages transition once to applied, carrying the canonical operation
  and displaced storage identity. The BEFORE guard locks and checks the old
  attachment binding before replacement; the deferred AFTER guard checks the new
  object, original record reference, receipt and token burn at transaction commit.
  Applied rows remain immutable. This does not yet implement physical cleanup.
- Full D5 real-DB suite 47/47 PASS, including success, rollback, denial, drift,
  missing receipt, wrong adoption operation and wrong displaced storage path.
  All refusal cases preserve metadata/record state and leave no applied journal,
  canonical history or token burn. These are internal-kernel synthetic fixtures,
  not public HTTP attachment restore or browser UAT.
- Missing receipt first triggers the existing token-burn receipt guard; the
  initial new-error expectation was corrected, not the production guard weakened.
- Neutralizing the deferred adoption guard makes only wrong-adoption falsely
  succeed; neutralizing the original-binding guard makes only wrong-displaced
  falsely succeed. Each mutation was restored before final unfiltered testing.
- Full fresh/replay: 32 Time Machine migrations, 995 catalog objects, repeated
  fingerprint `ce2c18ede8fb173e59f9171aee86c4f50a1ace81f5092f81119625ed40162110`.
  Historical neighbors 59/59 and 127/127 PASS; existing manual capture, reader,
  scalar HTTP and stage/metadata gates PASS. Owned DB/connections/cluster residue 0.
- Unit neighbors 3 files/40 tests; two-project typecheck, source ESLint, wiring
  37/37 and diff-check PASS. The temporary D5 mutation filter was removed; the
  committed driver still runs the whole D5 file without a title filter.
- Sol high identified the original displaced-binding P2, now fixed and killed
  by the dedicated mutation. Narrow follow-up: no P1/P2 in that fix; session
  closed. It does not approve public facade, cleanup or the complete product.
- Logs: `/private/tmp/tm-attachment-adoption-final-20260919.log`,
  `/private/tmp/tm-attachment-adoption-mutation-20260919.log`,
  `/private/tmp/tm-attachment-displaced-mutation-20260919.log`, and
  `/private/tmp/tm-attachment-adoption-{unit,tsc,lint,wiring}-20260919.log`.

## Authenticated File Facade Checkpoint

Code commit: `e750e620fcaee89ff8a15aba30205a2f30d022a7`.

- Actual authenticated binary reader -> durable staging -> canonical attachment
  metadata/reference/history/receipt -> original byte readback PASS. This uses
  synthetic authorization and a test-issued v2 token, not public preview or UAT.
- Full-read denial, retiring key and active hold refuse before upload. Injected
  upload failure leaves record/version unchanged and one reserved object; retry
  adopts the same object identity. Consumed-token replay refuses without upload.
- Removing the prepared batch from the facade produces the exact identity-invalid
  RED; source restored before the final full run.
- Final unfiltered owned PostgreSQL runner PASS: D5 47/47, historical neighbors
  59/59 and 127/127; 32 migrations / 995 catalog objects with repeated fingerprint
  `ce2c18ede8fb173e59f9171aee86c4f50a1ace81f5092f81119625ed40162110`.
  Owned DB, connections, cluster and temporary storage residue zero.
- Seven unit files 92/92, two-project typecheck, source ESLint, wiring 37/37 and
  full sealed-export S5 PASS. S5 initially lacked local mssql resolution; rerun
  used the already-installed package through temporary NODE_PATH, without install.
- Sol identified missing pre-IO source authority and escaping structured refusal;
  both were fixed and tested. Narrow terminal review found no remaining P1/P2 in
  orchestration, not an approval of cleanup, public restore or the complete product.
- Initial fixture failures exposed absent live reference/sealed history/original
  scope and an inactive test fence. Fixtures were corrected without weakening
  production validation. Temporary test filters were removed before the full run.
- Logs: `/private/tmp/tm-attachment-facade-{final,mutation,unit,tsc,lint,wiring,s5}-20260919.log`.
- Successor remote exact-head CI has not yet been collected.

## Two-File Failure And Retry Checkpoint

Test commit: `0c287ef7aab36b98e97d5b7baa838dcea8bdb159`.
Published carrier: Draft/HOLD PR #5882. No public runtime enablement.

- The real manual capture fixture now seals two original attachments in the same
  original cell. The first upload succeeds and the second fails. Record data and
  version and both complete attachment metadata hashes stay unchanged. Durable
  stage states are exactly one verified and one reserved, not applied.
- Retry preserves both object IDs, performs only one additional upload, commits
  both stages applied, restores both original byte sequences and rejects consumed
  token replay without another upload. This is resumable preparation, not proof
  of abandoned-object cleanup or a final SQL-failure rollback across two files.
- Full owned runner PASS: 47/47 D5, 59/59 and 127/127 historical neighbors, fresh
  and repeated migration catalog 32/995 with the preceding exact fingerprint;
  existing capture/HTTP/stage participants PASS; owned database, connections and
  cluster removed. The final commit only clarified the successful console label
  after this run; its test assertions and production bytes were unchanged.
- Mutation: uploading a verified object again makes the focused verified-retry
  test RED on the unexpected upload event. Restored production file byte-equal;
  full reader 27/27 PASS; two-project typecheck and diff-check PASS.
- Logs: `/private/tmp/tm-attachment-two-file-{final,mutation,unit,tsc}-20260919.log`.
  This mutation is a focused reader test, not a second full database mutation run.
- Remote checks for the new follow-up head are pending publication/rerun; earlier
  head checks are not evidence for this commit.

## Transaction Failure Checkpoint

Test commit: `a60a3d683280e6faeb7253c574bea6c94e0c62bd`.

- After both original files are prepared, the production facade is interrupted
  after its second live attachment metadata UPDATE, then independently before
  its final sync receipt INSERT. The latter point follows record/history writes,
  token burn and operation sealing inside the same real PostgreSQL transaction.
- Both injected faults are reached with exactly two metadata updates. After each
  rollback, the live record data/version and both full attachment metadata hashes
  match their before-images. Revision/operation row counts are unchanged; token
  burns and receipts remain zero. Both stages are verified, with applied operation,
  time and both displaced storage fields NULL. No partial adoption remains.
- The original signed token subsequently succeeds and adopts both existing files
  without another upload. This establishes rollback/retry for these two precise
  failure points, not arbitrary crashes or abandoned/displaced-object reclamation.
- Terra read-only review found no P1 and requested an explicit displaced file-ID
  assertion. Added it and reran the full owned runner: 47/47, 59/59, 127/127;
  migration replay 32/995 with unchanged fingerprint; real two-file flow PASS;
  DB/connections/cluster/storage cleanup completed. No broad product approval.
- Typecheck, wiring 37/37 and diff-check PASS. This is fault injection, not a new
  production-guard mutation; earlier guard mutation evidence remains separate.
- Logs: `/private/tmp/tm-attachment-transaction-failure-reviewed-20260919.log`,
  `/private/tmp/tm-attachment-transaction-failure-{tsc,wiring}-20260919.log`.

## Ownership And Durability Checkpoint

Code: `a6cad9ecb06a70dbdfce6bb8627b1242c4aa53a5` followed by
`b1227f32ac86be4243e58d11d4fb6444a2b87344`.

- Real local filesystem tests reject unowned matching bytes, wrong ownership and
  symlinks. Before-open, already-open and completed-upload retirement cases prove
  late writes cannot recreate the payload after the internal barrier succeeds.
- Marker write and marker sync faults leave no stable partial reservation; a new
  provider retries successfully. Payload sync failure is reached and refuses
  before the verified ledger transition. Restored reader 36/36; reader plus three
  storage neighbors 4 files / 83 tests PASS.
- Mutations: bypass reservation accepts unowned bytes (RED); remove tombstone
  permits late writes (three RED); remove payload sync accepts durability failure
  (one RED); create stable directory before marker leaves poisoned reservations
  (two RED). Every mutation was restored before final verification.
- Full owned PostgreSQL runner on the durability code PASS: D5 47/47, historical
  neighbors 59/59 and 127/127; fresh/replay catalog 32 migrations / 995 objects,
  unchanged fingerprint. Authenticated two-file facade, upload/metadata/receipt
  fault rollback and same-token reuse PASS. Owned database/connections, stage DB
  and temporary cluster cleanup completed.
- Core typecheck, scoped source ESLint, exact-anchor wiring 37/37, archive wiring
  6/6 and diff-check PASS. Prior ownership checkpoint S5 PASS; no provenance-bound
  workflow or plugin files changed in the subsequent durability fix.
- Sol read-only review found two P2 durability issues in the initial checkpoint.
  Both were fixed and independently re-reviewed with no P1/P2 in those two fixes.
  The trusted-exclusive-root P3 remains explicit; this is not broad product
  approval. Review session closed; it did not run tests or modify files.
- Logs: `/private/tmp/tm-attachment-ownership-durable-{restored,realdb,tsc,lint,exact-wiring,wiring}-20260919.log`,
  `/private/tmp/tm-attachment-ownership-{sync,marker}-mutation-20260919.log`.
- These are internal storage and facade results, not public attachment execution,
  abandonment cleanup, shared-NAS certification or real Workbench browser UAT.

## Historical Acceptance Process Budget

Runner commit: `fb335f2177945906c0c123f3514cc154208d061b`.

- Remote `79734540f8fb189da00b67a74f0a121bdf346cb4` Node18/20 both
  failed in isolated manual acceptance, before any successful historical suite
  summary. The final cleanup assertion observed three database connections and
  masked the child failure; the owned outer cluster was stopped and removed.
- Local full D5 takes about 223 seconds against the old 240-second child limit.
  Process timeout is the working diagnosis, not a reproduced Node18 root cause.
  Neighbor budget is now bounded at 600 seconds and outer script at 1200 seconds;
  errors explicitly distinguish ETIMEDOUT from other process failures. No test,
  assertion or zero-connection cleanup requirement was removed.
- Full local rerun PASS again (47/59/127, unchanged 32/995 migration catalog,
  complete two-file facade and stage acceptance, owned DB/cluster cleanup).
  Typecheck and wiring 37/37 PASS. The final type narrowing changes only the
  error diagnostic, not the exercised successful runner path.
- Evidence: `/private/tmp/tm-5882-797345-failed.log` and
  `/private/tmp/tm-attachment-ownership-ci-budget-{realdb,tsc,wiring}-20260919.log`.
  Fresh remote exact-head CI is required before declaring the CI failure closed.

## Expired Stage Cleanup Checkpoint

Code: `87f05247d1cdb9854bcf1f216ecd4a78424e229e` (seven files).

- The server carries the verified signed token's exact expiry into immutable stage
  identity. Retry must match that expiry; active prepare/apply checks database time.
  No retention duration, schedule or public cleanup capability was introduced.
- Real PG + local filesystem prove expired-only abandonment is committed before
  storage retirement. Any attachment metadata reference by file ID or path refuses
  cleanup. A post-retirement failure leaves abandoned/cleaned_at=NULL; retry stamps
  completion, and subsequent replay makes no storage call. Never-started uploads
  are retired safely; late open-descriptor writes cannot recreate the payload key.
- A separate apply transaction acquires the stage before expiry and holds it across
  expiry. `pg_blocking_pids` proves cleanup waits for that exact writer. Apply commits
  its metadata, record reference, token burn and receipt; cleanup then refuses with
  zero storage calls and stage remains applied. This is real lock arbitration, not
  an elapsed-time-only concurrency assertion.
- Mutations: removing the DB expiry guard admits premature direct abandonment;
  skipping file retirement falsely completes; doing file retirement before claim
  commit leaves verified instead of abandoned on failure. Each is RED, restored.
- First full run found seven old attachment transaction fixtures missing the new
  expiry argument (40/47 passed). Fixed that caller to use real token verification,
  not a default timestamp. Restored full runner: 47/47, 59/59, 127/127, two-file
  facade, stage cleanup/race gates PASS; owned DB/connections/cluster removed.
- Fresh/replay: 32 migrations / 999 catalog objects; fingerprint
  `651036c3ffcc978293e9e1bcfeb4de2d33458adfd80b88166ef1b50bf9d90063`.
  Catalog growth is the three expiry/cleanup columns plus their CHECK constraint.
- Unit neighbors: four files / 70 tests, execution/async neighbors three files /
  26 tests PASS. Typecheck, source ESLint, wiring 37/37, S5 and diff-check PASS.
- Sol bounded read-only review: no P1/P2 in expiry/abandonment/storage-order logic;
  no tests or edits by reviewer; session closed. This does not approve the entire
  attachment product or displaced-object cleanup.
- Logs: `/private/tmp/tm-attachment-abandon-full-restored-realdb-20260919.log`,
  `/private/tmp/tm-attachment-abandon-{expiry,storage,commit-order}-mutation-20260919.log`,
  `/private/tmp/tm-attachment-abandon-{neighbors,execution-neighbors,final-tsc,lint,wiring,s5}-20260919.log`.
- Public runtime, automatic scheduling, old displaced-object cleanup and browser
  UAT remain unimplemented. No customer storage or real environment was accessed.

## Public Synchronous Attachment Checkpoint

Code: `c97550f243d82060e1af88c1a90864cde78e4c93`.
Tree: `b93f8883072586cad761331f71c4470e03dce878` (eight-file code/test delta).

- Public preview fingerprints the database metadata of both removed and restored
  attachment references under original sheet/record/field ownership. The v2 plan
  is rederived and matched before file staging; final canonical apply still
  rechecks metadata, current permission, record/schema locks and token authority.
- The optional server-owned application port snapshots and binds all three
  methods. Incomplete ports refuse before resolving DB; absent ports preserve the
  attachment refusal. Over-threshold attachments remain blocked as a whole.
- Real HTTP preview covers whole sheet, selected records and selected fields;
  scalar-only no-op remains unchanged. Public execution restores two original
  binary files to their existing original record/field, increments version once,
  and refuses consumed-token replay. Anonymous calls are 401. Metadata drift and
  altered selected fields are 409 with no new stage or live record change.
- First full run correctly refused an old fixture that inserted an unbound
  attachment into the cell (503). The positive now removes one actual original
  reference instead; no production ownership guard was weakened.
- Full restored owned PG runner PASS: fresh/replay 32 migrations / 999 catalog
  objects, fingerprint unchanged; historical 47/47 + 59/59 + 127/127; prior
  two-file upload/metadata/receipt fault rollback; public HTTP; expired-stage and
  concurrent apply/cleanup arbitration. Database/connections/cluster removed.
- Focused public suites 3 files / 62 tests and sync/async/attachment neighbors
  5 files / 54 tests PASS. Core typecheck, source ESLint, wiring 37/37, full S5 and
  diff-check PASS. No workflow or provenance pin changed.
- Mutation replacing metadata hashes with a constant makes the public-preview
  fingerprint test RED; restored full 62/62 GREEN. No mutation was committed.
- Sol high read-only narrow review found no evidenced P1/P2 in public binding,
  pre-IO validation or capability snapshot. Session closed; it ran no tests and
  does not certify browser, cleanup or asynchronous restoration.
- Logs: `/private/tmp/tm-attachment-public-http-realdb-20260919.log` (initial
  fixture failure), `tm-attachment-public-http-restored-realdb-20260919.log`,
  `tm-attachment-public-{unit,neighbors,metadata-mutation,final-tsc,lint,wiring,s5}-20260919.log`
  under `/private/tmp`. HTTP authentication is synthetic, not Workbench login/UAT.
- Remote exact-head CI for this new checkpoint is pending publication/rerun.

## Synthetic Browser Attachment Checkpoint

Code: `dc589e3e830d1cedaf29b4161839857612590816`.
Tree: `9be618e686b89c8d8820763b3936ccca45a1a245` (five-file delta).

- Chromium 1440/390 passed for both scalar and attachment capture, reload,
  catalog, preview, explicit confirmation and synchronous restore through the
  production modal/client/router. Failed or non-2xx API requests fail the gate.
  Each loop requires exactly one execute request and one executed notification.
- Attachment readback checks the entire record data, exactly one restore version
  increment after the synthetic edit, one restore history entry and both original
  binary payloads through local storage. This is not a browser download test or
  proof that the Workbench grid consumed the notification.
- Initial attachment browser run exposed a shared-client transaction fixture
  problem during concurrent status/catalog reads. The fixture now uses an owned
  pool with per-transaction checkout and async-local depth. Production main pool
  already uses its transaction API; no production database behavior was changed.
- Restored full runner exited 0: historical 47/47, 59/59 and 127/127;
  32 migrations / 999 catalog objects; public HTTP, stage cleanup/concurrency,
  all four browser loops. Owned DB connections, clusters, browser and Vite/cache
  were closed/removed. Log:
  `/private/tmp/tm-attachment-public-browser-restored-20260919.log`.
- Modal/client 2 files / 154 tests, core/web typechecks, scoped ESLint, wiring
  37/37 and diff-check passed. Unsupported-copy assertions were RED before the
  bilingual correction and GREEN after it. Full required-web was not rerun
  locally for this checkpoint; these existing specs retain their two-point wiring.
- Screenshots `tm-manual-http-browser-attachment-{1440,390}.png` in the runner's
  OS temporary directory were visually inspected; no dialog overflow or control
  overlap observed. Authentication is synthetic and edits are synthetic SQL.
- Luna narrow read-only review returned no evidenced P1/P2 before session close.
  It made no edits and ran no tests; this verdict covers this five-file patch,
  not full Workbench UAT or the complete attachment product.
- New exact-head remote CI remains pending publication. No real environment,
  flags, dispatch, deployment or customer storage was accessed.

## Local Startup Binding

Local startup binding checkpoint: code
`6cb20af35dbd02a5f835027cd5190c917d1dd610`, tree
`3447686772f4a15b0501252fd6713e5e8d92b84e` (four files).
The actual local launcher supplies the existing upload/download storage singleton
to custody startup, which forwards it only after unlock. OFF, wrong-secret,
cancellation and root/receipt refusal preserve zero storage resolution; resolver
throw/cancellation reject publication and scrub the supplied secret.

Startup/application focused suites PASS 58/58, core typecheck PASS, startup source
ESLint PASS, D2 archive wiring PASS 6/6, diff-check PASS. The initial new positive
failed because the resolver was never called. Removing composition forwarding
independently failed on missing attachmentStorage; restored suites PASS 58/58.
Logs: `/private/tmp/tm-attachment-startup-{restored-tests,tsc,source-lint,wiring,port-mutation}-20260919.log`.
Launcher ESLint was attempted but excluded by the repository TSConfig (not a
source lint pass); actual launcher OFF/wrong-secret/cancel subprocess tests pass.
No new DB/browser run or independent review is claimed for this binding-only
checkpoint; the previous synthetic router/browser proof is not full launcher UAT.

## Production Download Route Acceptance

Code: `d1ca403ddb8cd85fc28dbf7575d23a9956df808b`.
Tree: `aac0a46df72a9ebf65eeb9b52b91cd3e1a795260` (one verifier file).
The production attachment download route uses the process main pool rather than
the recovery router injection port. The verifier asserts that the initial pool
has zero connections, closes it and binds a pool to the separately verified owned
database. Database name and role are checked before the download route runs.

- Both restored files download byte-identically through the real GET route;
  anonymous calls return 401. These checks also run after each desktop/mobile
  browser restore, in addition to the prior direct storage readback.
- Full `--browser` runner PASS: scalar and attachment 1440/390; historical
  47/47 + 59/59 + 127/127, migration replay, fault rollback and cleanup races.
  Main/download/stage DB connections are zero and databases/cluster removed.
- Core typecheck and diff-check PASS. Log:
  `/private/tmp/tm-attachment-download-browser-20260919.log`;
  typecheck: `/private/tmp/tm-attachment-download-tsc-20260919.log`.
- Download requests are Node HTTP requests using synthetic authentication,
  not browser link clicks or real Workbench login. No new production code,
  permission or flag changed. No new independent-review verdict is claimed.

## Production Login And JWT Checkpoint

Code `4b5a6a52e5593cba730dec97a3e9628a8af7b631`, tree
`4a0e4bbed602bffe73c2786038c532b584f29aa1` (two verifier files).
An isolated synthetic user logs in through the production auth route; attachment
requests and desktop/mobile modal calls use the returned token and production
JWT middleware. Capture/restore/download pass; anonymous and subsequently
deactivated actor downloads return 401. Scalar fixtures retain their earlier
synthetic middleware and are not claimed as production-login coverage.

The first run completed behavioral assertions and DB cleanup but remained alive
because importing auth routes started message-bus resources. It was explicitly
terminated and is not a full PASS. The corrected verifier shuts down that owned
singleton in finally. The complete restored runner exits 0, including four browser
loops, historical 47/59/127, stage cleanup arbitration and zero remaining DB
connections/removed cluster. Core typecheck, JS syntax and diff-check PASS.
Logs: `/private/tmp/tm-attachment-login-browser-restored-20260919.log` and
`/private/tmp/tm-attachment-login-final-tsc-20260919.log`.

Sol high reviewed the permission/original-binding chain read-only at f215ba1f1a:
no P1; P2 was OPEN for generic preparation errors becoming HTTP 500 after permission
or original-binding drift. It ran no tests and did not assess these verifier edits.
Session closed. This checkpoint is local-only pending that bounded fix; remote
CI on f215ba1f1a does not certify it. No Workbench login-page/grid/download-click
acceptance, real environment, flag, dispatch or deployment is claimed.

## Preparation Refusal Fix

Code `6bff7a8d6645644ad07b77b606df265dc2842aa0`, tree
`5e322c08b76f9f513b240b78f727ba0fdbe8aa04` (seven files), closes the
bounded Sol finding above. Named permission errors survive preparation/staging;
original metadata and plan errors use preview-drift. Unknown infrastructure
failures are not relabeled as permission or drift errors.

- Initial unit negatives failed for generic permission/binding errors. Final
  sync-restore/attachment-plan/preview neighbors PASS: three files, 42/42.
- Mutation restoring generic preparation permission failure makes the matching
  unit RED; restored implementation is used for the complete final DB run.
- Production HTTP: field permission revoked after preview returns 403; original
  attachment field binding removed after preview returns 409. Both preserve
  record data/version and stage count. Restored fixture then completes the
  positive two-file restore with exact original-byte downloads.
- Full owned PostgreSQL/browser runner exits 0: 32 migration replay census;
  historical suites 47/47, 59/59 and 127/127; scalar and attachment modal loops
  at 1440/390; production login/JWT/download; fault rollback and cleanup races.
  Owned browser/listeners close, database connections reach zero, databases and
  temporary cluster are removed.
- Core typecheck, five source-file ESLint, D2 wiring 6/6 and diff-check PASS.
- Terra bounded read-only review: no evidenced P1/P2 in the five source files.
  Its initial concern about generic infrastructure errors was withdrawn after
  tracing facade rethrow/HTTP 500; sanitization remains intentional. No tests
  were run by that reviewer; session is closed.

Logs under `/private/tmp/`:
`tm-attachment-refusal-route-final-realdb-20260919.log`,
`tm-attachment-refusal-final-unit-20260919.log`,
`tm-attachment-refusal-final-tsc-20260919.log`,
`tm-attachment-refusal-lint-20260919.log`,
`tm-attachment-refusal-wiring-20260919.log`, and
`tm-attachment-refusal-mutation-20260919.log`.
These are local evidence, not a successor remote CI verdict. No full Workbench
login-page/grid/download-link UAT, runtime cleanup registration, real environment
or customer data acceptance is inferred. #5882 remains Draft/HOLD.

## Field And Record Lock Acceptance

Additional authorization code checkpoint:
`84e975b2b131c1ed0ebadde93f8f5974ca01abfa`, tree
`d6253c6cbeae7d09b7ef14dee5afc49bde9f5946` (one verifier file; no production
change). After preview, both hidden and read-only field rows independently cause
HTTP 403 with unchanged stage count and record. An unrelated locker with no owner
bypass causes HTTP 409 RECORD_LOCKED; live attachment metadata, record data/version,
revision/history counts, preview-token burns and sync receipts remain unchanged.
The fixture lock/owner fields are restored in finally; subsequent positive apply
succeeds exactly once and downloads the original two binaries. This does not
assert zero private staging for the canonical record-lock refusal.

Full owned runner exits 0, including historical 47/59/127, four desktop/mobile
modal loops, production login/JWT/download, cleanup/apply races and zero database
connections/removed cluster. Core typecheck PASS; exact-anchor CI wiring 37/37
PASS; diff-check PASS. Logs:
`/private/tmp/tm-attachment-lock-http-realdb-20260919.log`,
`/private/tmp/tm-attachment-lock-http-tsc-20260919.log`, and
`/private/tmp/tm-attachment-lock-http-wiring-20260919.log`.
No new independent reviewer or record-lock guard mutation is claimed for this
verifier-only extension. Existing production guard behavior was exercised through
the actual HTTP route; remote CI for the new commit is not yet certified.

## Workbench And Reader CI Checkpoint

Code checkpoint: `580577ecda412f0a28e7e017dad58d3f481b19bf`, tree
`691a1d37198e6068db7b3c1058c48737af8b2f7c` (three verifier/test files,
no production change).
Owned runner `TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node
scripts/ops/run-recovery-manual-checkpoint.mjs --browser` exits 0. In addition to
the existing modal loops, production Workbench loops at 1440 and 390 prove real
capture/catalog/preview/confirmation, exactly one execute request, empty-to-two
attachment grid refresh and database/history/binary readback. All API non-2xx
responses remain fatal. Production comment routes, not successful mocks, satisfy
the Workbench dependency reads. Owned database connections are zero and the
synthetic cluster is removed. Log:
`/private/tmp/tm-workbench-archive-final-realdb-20260919.log`.

Earlier runs failed on missing fixture comment routes and a locator matching both
the hidden recycle-bin dialog and archive dialog. These are not counted as passes.
The final run mounts real comment services and selects the named archive dialog.
Both screenshots were inspected. At 390px the full-page image exposes horizontal
Workbench overflow despite a passing dialog-width check; mobile layout remains
OPEN. This is a functional small-viewport result, not responsive-layout signoff.
Full app login/org selection, real cell edits and browser-click download remain
OPEN; HTTP download with an explicit JWT is a different evidence class.

Remote Node18/20 at `2ef3cdcb18a8da647e9e422555629e7748943ac3` failed the same
reader denied-mode stale error expectation. Local reproduction was 1 failed/35
passed. Only denied mode now requires the typed authorization error and exact
`ARCHIVE_ATTACHMENT_STAGE_FORBIDDEN` message; its zero-storage-events assertion
and all other refusal cases remain. Restored reader is 36/36; reader/sync-restore/
attachment-plan/preview neighbors are 4 files/78 tests PASS. Logs:
`/private/tmp/tm-reader-refusal-red-20260920.log` and
`/private/tmp/tm-reader-refusal-neighbors-20260920.log`.
Core typecheck, wiring 37/37 and diff-check PASS. Earlier bounded Luna read-only
review found no evidenced P1/P2 in the initial Workbench oracle; it did not review
the later fixture dependency/locator adjustments. No new full independent verdict
or successor remote CI success is claimed. PR remains Draft/HOLD.

## Original Download Repair

Code `0784b4c1cdb1cc3d16eb4ee24214538b57d619bc`, tree
`d18add79b7230626ba79d85b5fadbe1a8bc4c1be`. Actual Workbench click before the
repair failed 401 versus required 200, independently of the passing authenticated
HTTP readback. Log `/private/tmp/tm-workbench-download-red-20260920.log`.
After repair, the full owned PostgreSQL/browser runner exits 0 at 1440 and 390;
the click obtains HTTP 200 and a completed browser download. No browser-wide extra
headers or query-token bypass is used. This currently tests the first original
download action, not thumbnail/lightbox rendering or full application login UI.
Log `/private/tmp/tm-workbench-download-green-20260920.log`; database connections
zero, synthetic cluster stopped/removed. Original binary fidelity continues to
be checked by the HTTP/database fixture; downloaded-file byte comparison is not
claimed for this browser-click assertion.

Four component/neighbor files pass 27/27. Unit negatives prove denied response
creates no blob/download, unmount aborts and suppresses a late download, and a
hostile stored URL is not used as the authenticated request destination. Removing
the HTTP-success guard makes exactly denied mode RED (1 failed/6 passed); restored
neighbors return 27/27. Logs `/private/tmp/tm-attachment-download-mutation-20260920.log`
and `/private/tmp/tm-attachment-download-restored-20260920.log`.
Application `vue-tsc --noEmit -p tsconfig.app.json` passes. Full web type-check
is NOT green: unchanged `vite.config.ts:28` reports incompatible Vite 5/7 plugin
types in the available dependency tree. No dependencies/config were changed.
Scoped ESLint passes with zero errors/five component-fixture warnings using only
the already installed pnpm-store NODE_PATH (initial parser-resolution attempt
failed). Diff-check passes. The existing attachment-list spec remains covered by
both domain guard and required-web filters; no selectors changed.

Luna's bounded read-only review remained running without a terminal verdict and
was closed; no external approval is claimed. Successor remote CI remains pending
verification. Workbench whole-page mobile overflow and authenticated image preview
remain OPEN. No Ready/merge, flag, dispatch, deployment or real environment access.

## Remaining Acceptance

Image-preview checkpoint `8528aa176d385f0a6134d580c14bbf31d981c327`, tree
`7bbb591fd8b98cfc37b76dd941904d96582f1079`, supersedes the original-download
checkpoint's open image-authentication item. Three initial image cases were RED
because the component never made an authenticated image request. Final component
and seven neighbor files pass 96/96. Removing the post-abort publication guard
makes removed-image mode RED (1 failed/2 passed in the focused image cases);
restoration returns the expanded suite to 96/96. Existing field-panel/drawer
assertions now check blob image sources instead of raw URL strings.

The full isolated runner exits 0 with a real synthetic PNG as the second archived
attachment. All existing binary/hash/history assertions use the same expected
fixture bytes, not substituted text. Both 1440/390 Workbench loops wait for a
decoded thumbnail (naturalWidth > 0), open the lightbox and prove naturalWidth=1
for the one-pixel PNG, then complete authenticated original download. Every API
failure remains fatal. Owned DB connections=0 and the cluster is removed.
Application and backend typechecks pass; scoped ESLint has zero errors;
diff-check passes. The full web project-reference Vite dependency conflict from
the prior checkpoint is not claimed resolved.

Logs: `/private/tmp/tm-image-auth-red-20260920.log`,
`/private/tmp/tm-image-auth-final-20260920.log`,
`/private/tmp/tm-image-auth-mutation-20260920.log`,
`/private/tmp/tm-image-auth-browser-20260920.log`,
`/private/tmp/tm-image-auth-app-tsc-20260920.log`,
`/private/tmp/tm-image-auth-core-tsc-20260920.log`, and
`/private/tmp/tm-image-auth-final-lint-20260920.log`.
Terra medium completed a bounded read-only review of the image component/test
delta: 0 P1/P2. It ran no tests and did not certify the full PR; its session closed.
Whole-page mobile overflow, full app-login/organization-selection UAT, cleanup
composition, broader remaining acceptance and successor exact-head CI stay OPEN.

## Remaining Full-Scope Acceptance

Mobile containment checkpoint `081a2644eb0f38fe3382a834f42b72d961f23a5e`, tree
`b4a15a5456a0f0ab9c5a3a97007959caa3877c0c`, supersedes the earlier observed
whole-page overflow item for the tested Workbench fixture. Baseline assertion
reports viewport=390/document=1365, toolbar-right edge=1364.5625 and banner-right
edge=406. Final owned browser/PG runner exits 0 at 1440 and 390; whole-page width
fits, and in-browser nowrap mutation reproduces overflow before restoration.
Screenshots were inspected at both widths. Existing capture/restore, image decode,
authenticated download, database/history/byte readback and cleanup gates remain
green. Owned database connections=0 and cluster removed. Logs:
`/private/tmp/tm-workbench-mobile-red-20260920.log` and
`/private/tmp/tm-workbench-mobile-green-20260920.log`.

Exact remote `1c0ab0e11da8d33f830ec1594715d6be856cf5e7` domain CI failed one
stale raw-thumbnail-URL assertion in multitable-grid-link-renderer.spec.ts; local
reproduction was 1 failed/5 passed. Test-only commit `4658ac1f07` changes it to
authenticated request plus blob source assertions. Focused image neighbors pass
79/79. The full, unmodified workflow targeted command passes 295 files/4088 tests
in `/private/tmp/tm-mobile-full-domain-guard-20260920.log`. Layout/toolbar/Workbench
neighbors pass 196/196; scoped ESLint has zero errors with existing prop-default
warnings. Syntax/diff checks pass. No new independent layout reviewer is claimed.

Gallery cover images have a separate raw-URL rendering path (not changed here);
their authenticated browser behavior remains an explicit audit item, not covered
by the grid/lightbox pass. Full application login/organization selection, remaining
runtime/cleanup requirements and successor remote CI are still not certified.

## Saved Browser Download Bytes Checkpoint

Code `c6813cf79503794c625fb1bfe4fa07e856470b3c`, tree
`70a75c47761d292b621f064b104c86ba054ed25b`, adds an exact saved-file
oracle to the existing production Workbench synthetic browser loop. At both
1440 and 390, the authenticated original download must identify the expected
attachment, complete without a download error, persist a file, and contain
exactly the original synthetic archive bytes. HTTP 200 alone is insufficient.

The owned full runner passes in
`/private/tmp/tm-browser-download-saved-bytes-20260920.log`; database connections
are zero and the synthetic cluster is removed. Syntax and diff checks pass.
The preceding run in `/private/tmp/tm-browser-download-bytes-20260920.log`
failed because Playwright response.body() returned an empty buffer. That
transport-observation assertion was replaced with the stronger user-delivered
download.path() file read, not relaxed to status-only acceptance. The saved
file contains the exact expected 32 bytes. No claim about the cause of the
empty response observation is made. Existing direct HTTP/storage byte checks
remain unchanged. This is test-only; no new product permission or restore semantic.

Gallery cover rendering and full application login/organization selection
remain separate open acceptance items. No flags, deployment or real environment.

## Authenticated Gallery Cover Checkpoint

Code `f92a6cfcf214b3770fae56384f5e50bc4b889b7d`, tree
`88c4c04e958a30b2a818c8ed8235e26da3f3e8a6`, changes only the existing gallery
component and its already-wired spec. Cover requests use encoded attachment ID
through apiFetch, never the stored URL. Aborted requests cannot publish a blob;
current covers are revoked on metadata/row changes and unmount. Unavailable
covers keep the existing filename fallback.

- Baseline: 4 failed/2 passed, `tm-gallery-auth-red-20260920.log`.
- Focused gallery/attachment neighbors: 16/16, `tm-gallery-auth-green-20260920.log`.
- Remove the abort publication check: removed-row case RED, 1 failed/5 passed;
  restored before final gates, `tm-gallery-auth-mutation-20260920.log`.
- Full unchanged multitable workflow targeted command: 295 files/4091 tests PASS,
  `tm-gallery-full-domain-20260920.log`.
- App-source vue-tsc, scoped ESLint and diff-check PASS;
  `tm-gallery-auth-tsc-20260920.log`, `tm-gallery-auth-lint-20260920.log`.

All logs are under `/private/tmp/`. Bounded Luna read-only review was closed
without a terminal verdict, so no independent approval is claimed. Actual gallery
browser decoding through the owned HTTP fixture remains open; grid/lightbox
browser evidence is not substituted for it. No DB, flags or deployment in this
checkpoint. Successor exact-head CI remains separate.

## Restored Gallery Real Browser Checkpoint

Code `f18bbbc435fa43897135e440884498cdb416c013`, tree
`45897d89579090a4a0fbb347075528f5dce3fd1b`: fixture attachment ordering is
image-first, preserving both original binaries; an owned gallery view uses that
same attachment field. After archive restore, real production Workbench loads
the gallery via its initial view ID. At 1440 and 390, its cover must complete,
have naturalWidth=1 and an authenticated blob source. API failures remain fatal.
Original file download saved bytes and database/history readback still pass.

Full owned PG/browser runner exits 0:
`/private/tmp/tm-gallery-browser-20260920.log`. Owned database/stage connections
are zero, cluster removed, browser/Vite/cache closed. Syntax/diff checks pass.
Screenshots `tm-restored-gallery-1440.png` and `tm-restored-gallery-390.png` under
the OS temporary directory were inspected. The white 1x1 fixture really decodes;
it is not a missing image. However one-column desktop cover height grows with
image aspect ratio, leaving an oversized card: visual sizing is not certified.

This closes the prior gallery authenticated-decoding gap, not full app login,
organization selection, real cell editing or remaining runtime/cleanup gates.
No new permissions, flags, deployment or real data access.

## Gallery Cover Sizing Closure

Code `7912fb96b1c27e4efa71d167a37041bebe67e440`, tree
`16134a74c71078eab7665ebd71d58ecb8ae15083`: existing size values are now fixed
heights, preserving object-fit cover and card layout. At 1440 and 390 the owned
production browser changes small/large/medium using the actual select, requires
PATCH success and exact 108/176/132px cover heights. A temporary height:auto
override must exceed 176px; removal must restore 132px. Both screenshots were
inspected and no longer show the oversized square-image card.

`/private/tmp/tm-gallery-sizing-browser-final-20260920.log` exits 0 for the full
owned migration, recovery, browser and cleanup runner. Connections=0, cluster
removed. Gallery/attachment neighbors 16/16, scoped ESLint, syntax and diff-check
pass (`tm-gallery-sizing-unit-20260920.log`, `tm-gallery-sizing-lint-20260920.log`).
The first sizing attempt timed out on an exact label locator; it is not a pass.
The final locator targets the labeled field's select and awaits selection and
response together, preserving the height assertions and cleanup path.

Sol's separate bounded runtime audit was closed without a terminal report; no
independent verdict or runtime-gap closure is inferred. No new permissions,
flags, dispatch, deployment or real environment access.

## Outstanding Full-Scope Acceptance

Latest interruption refinement: code
`29e123f7a870d568b48b13c5e3d00abc2b1164e6`, tree
`f18871361dbecd852a5bb1b73aa1ab4b2c34504d`. Injected rmdir failure immediately
after marker removal reproduces an old unprovable leftover; new provider instance
retry now removes the imported empty directory while preserving the permanent
payload tombstone. Restoring the old unlink-before-transfer order makes that
exact test RED. Wrong imported proof/extra data/symlink negatives preserve their
sentinels and refuse. Final reader/application neighbors pass 84/84; core tsc,
source ESLint and diff-check pass. Logs:
`/private/tmp/tm-orphan-retry-{red,mutation,final,tsc,lint}-20260920.log`.

No SQL or public API changed. Full PG/browser was not rerun for this filesystem
refinement; the preceding real-DB checkpoint remains previous-code evidence.
No new independent review is claimed. Tests model deterministic interruption,
not an OS power cut. Missing original proof, late-writer crash after terminal
cleanup, displaced objects and full product acceptance remain open.

Latest bounded cleanup evidence: code
`2aef32ff8edb01981a923bfe7e312164ba626253`, tree
`bd1666275020951b8c0f4c49f749924a39a9768c`. Two new local filesystem cases
first failed (36 existing passed), then reader/application neighbors passed
80/80. Removing exact ownership verification caused the foreign-marker assertion
to fail; restored before final tests. Core typecheck, source ESLint and diff-check
pass. Logs under `/private/tmp/`: `tm-orphan-owned-{red,green,mutation,final,tsc,lint}-20260920.log`.

`tm-orphan-owned-realdb-20260920.log` is a successful full owned runner without
browser: fresh/replay, restore and stage abandonment/apply race gates passed;
owned/stage connections zero, cluster removed. This new filesystem behavior is
directly tested with synthetic local directories, not claimed as a real-DB fault
injection of process death. Terra medium narrow read-only review returned no
P1/P2 and was closed; it is not a full-PR approval. Markerless/partial-proof and
unlink/rmdir-crash leftovers plus displaced objects remain open as described in
the lock. No real storage, public cleanup API or background registration.

Production local startup composition is wired (see the paired runtime audit at
`f0af8722c1`); full launcher/application acceptance is not yet certified.
Public/background cleanup scheduling remains contract-excluded, not implicitly
authorized. Internal expired-stage retirement is locally verified. Open items:
prepared/displaced file
reference-safe crash cleanup; end-user attachment field authorization acceptance;
remaining purge/drift/retry concurrency; async contract;
whole-operation negatives; full Workbench login, field authorization, grid refresh
and browser attachment download acceptance beyond the synthetic modal loop;
required exact-head CI and independent exact-head review.

Next order: prove crash reconciliation ownership without a new retention policy;
complete real application login/org/cell-edit acceptance; audit history/config/
trash/diagnostics against their own locks. Do not substitute repeated image-helper
verification for these remaining gates. Gallery/mobile improvements are now
locally verified, not proof of full Time Machine completion.
`unsupported_attachments` remains for absent/partial ports and over-threshold
attachment selections. Explicit test composition is not production readiness.

Sol high's bounded read-only integration review was closed while running without
a terminal verdict. No external approval is claimed. #5849 post-merge CI later
reached the terminal base result recorded above; it is not successor CI evidence.
No flags, dispatch, deployment, real environment or customer storage/data access.
The read-only nightly plan is in the paired design lock; it has not been executed
against any real environment.

## Retained-result job rediscovery verification (2026-09-20)

Exact code: `9a1751bd1aeeed9f2b7b6eec39d38bc413cc572f`.
Kimi 0.40.1 completed a bounded, read-only review of the preceding UI delta
and identified one P2: retained results prevented later same-sheet job discovery.
Its verdict was narrow, not approval of this PR or this subsequent fix.

The added mounted case reproduced RED before implementation (one discovery
call instead of two). After fixing discovery independently of catalog reset,
the new paused job is visible without accept/resume writes. Modal 61/61 and
client 100/100 pass after restoration. Removing the preserve-result condition
produced a separate precise RED in the after-completion reopen case; restored
combined run is 161/161. Web app vue-tsc passes; scoped ESLint passes with two
existing fixture warnings (initial parser resolution failed, rerun using the
existing pnpm NODE_PATH passed without installation). CI wiring 39/39 and
diff-check pass. These are mounted regressions, not browser race injection.
No fresh DB/browser run is claimed for this UI-only delta. Earlier runtime
evidence retains its own SHA. Remote exact-head CI remains a separate gate.

## Database-fresh administrator revocation (2026-09-20)

Test code `ac1aae767a5e4a491fd703b0d6913c814d052826`, one acceptance script,
no production changes. The existing alternate admin login/409 actor-substitution
positive is followed by database role demotion. Both archive catalog and execute
using that already-issued session return 403; the shared zero-effect oracle checks
record data/version, attachment metadata, stage/history/token/receipt state.
Role restoration is in finally. No second-tenant isolation claim is made.

Default owned runner exits 0 with these exact script bytes:
`/private/tmp/tm-revoked-admin-realdb-20260920.log`; fresh/replay, existing restore
and stage arbitration gates pass, owned/stage connections zero, cluster removed.
Core and acceptance-script typechecks pass; three authority/route neighbors pass
64/64; diff-check passes. This test-only addition has no new production mutation
result; prior guard mutations retain their own checkpoints.

Terra medium completed a separate static review of UI commit `9a1751bd` with
0 P1/P2/P3 in that narrow delta; no test execution or whole-PR verdict claimed.
Agent closed. The general tenant policy limitation is recorded in the design lock;
it remains an explicit unproven acceptance requirement, not a silently closed gate.

## Web selector and bounded storage review (2026-09-20)

CI code `41ae2e0f8390dbc0459bb7a8ea0e216293cb81e1` adds the previously
missing record-history-panel invocation to multitable-web-guard and both event
path lists. Required-web already selected this spec. The initial executable
contract failed for the missing step; final wiring passes 40/40 with in-memory
deletions of either lane selector and source/spec trigger each rejected. YAML
parsed before/after comparison proves every old path and run command preserved.
Nine history/inspector/drawer specs pass 203/203. No product or permission changes.
Initial line-only census omitted YAML run prefixes and shell environment prefixes;
only the corrected YAML/continued-command census supports the missing-selector
finding. All ten changed Web specs are now selected by both lanes; grid-link uses
the existing multitable-grid substring selector.

Sol high reviewed the backend ownership/cleanup subset at `7b0c9c4b1c` and
returned INCOMPLETE, not APPROVE. Its suggested claim-to-retire reference race
requires independent reachability/reproduction before disposition: canonical
attachment adoption locks the stage and rejects abandoned state, while ordinary
upload uses provider-issued random objects. Arbitrary SQL mutation is not yet a
demonstrated public write path. Keep this review question open.

The review's lack-of-real-cleanup-coverage assertion is contradicted by
`verify-recovery-attachment-stage.mts`: current-reference refusal, expired
abandonment/retry and two-connection apply-wins arbitration are implemented and
passed in the recorded full owned runs. That does not prove the newly suggested
reverse race. Review session closed; no whole-PR independent clearance claimed.

## Cleanup-first canonical adoption counterexample (2026-09-20)

Exact test code `c23aefafc2ae7b031fe154a42857be5b1ad7e26a`. At the real
cleanup storage callback, after SQL abandonment commits and before physical
retirement, a separate transaction attempts the canonical metadata-adoption
participant with the original actor/token/object/metadata hash. It must reject
with `ARCHIVE_ATTACHMENT_RESTORE_APPLY_REFUSED`, preserve the entire metadata
row, and allow cleanup to finish as cleaned. The fixture uses a genuinely expired
confirmation token, as required by cleanup, not an arbitrary time bypass.

`run-recovery-manual-checkpoint.mjs --attachment-stage` exits 0; log
`/private/tmp/tm-cleanup-first-race-final-20260920.log`. Existing apply-first
two-connection arbitration also passes. Stage DB/connections zero; owned cluster
stopped and removed. Core plus acceptance typechecks and diff-check pass. First
attempt proved the new behavior but failed only the old final fixture census
(7 versus 6); final census is exactly 7. No product code or new guard mutation.

This refutes the proposed race through the canonical adoption participant under
its current expiry/state contract. It does not prove arbitrary SQL or a future
writer cannot manufacture a new storage reference: raw metadata UPDATE can do
so and is deliberately used by existing reference-refusal fixtures. Ordinary
upload obtains new random provider objects; no public caller-specified adoption
path was found in the current source census. Do not broaden this result into
universal database tamper resistance or whole-PR independent approval.
