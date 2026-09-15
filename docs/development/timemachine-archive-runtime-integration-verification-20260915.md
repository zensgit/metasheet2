# Archive Runtime Integration Verification

Status: DRAFT/HOLD; exact-head remote CI and remaining runtime acceptance are open.

## Shutdown Neighbor CI Repair

Test-only commit `0e59e8518646faf56509d4ee842fd1f4c2616895` follows published
`e82a12310b8571b7b296dde8c00d246bb0dc4640`. The Node20 job 104494115055
in run 35002512661 reported three failures in two neighboring unit files.
Local whole-file reproduction matched exactly: 3 failed / 158 passed.
The app-registration census now pins `startOnce`, where startup registrations
actually reside, and the automation test awaits asynchronous shutdown before
asserting all nine subscriptions were removed. Neither census completeness nor
subscription count was weakened; production files are unchanged.
The two files plus completion-shutdown and automation-lifecycle neighbors pass
172/172. Core typecheck and diff-check pass. Local logs are
`/private/tmp/tm-neighbor-{red,green,tsc}-20260916.log`.
The pre-fix RED is reproduction evidence, not a separate production mutation.
New published-head CI remains required; no new browser or DB run is claimed.

## Optional Router Injection Main Replay

Merge `f82e71be32d5b3c3bb7bf4ed3befaad7e1b98294`, tree
`2cca78b9691d87f97db630b91aa3c67c0389cc27`, preserves ordered parents
`df1b4f477059506ff2126b4a6698d7c8f169e2e4` and main
`7c2af702003f60f7c5425f3c752fa5801f39fbad`. Incoming delta is only the approval
panel, submit dialog and record inspector optional-router injection (12+/12-),
with no conflicts, backend, migration or workflow change. Three affected Web
files pass 100/100; app-only vue-tsc and diff-check pass. Logs
`/private/tmp/tm-7c2af-{focused,app-tsc}-20260916.log`. Broader tests and browser
evidence below remain bound to 4bd71; this narrow replay does not claim a fresh
browser/DB run. Published-head CI remains required.

## Completion Shutdown Integration Acceptance

All following local evidence binds clean code `4bd71a62834bbee6d3764dd8ff9b16223a102ed0`,
tree `f96027d15689b52756e812dbf800951c6eb02890`, not a future published head:

- Lifecycle/EventBus focused: 7 files / 94 tests PASS. Server, archive application/wiring and Automation V1 neighbors: 4 files / 334 tests PASS. Core and app-only Web typechecks PASS.
- Required-web exits 0; final group 461 files / 6,939 tests PASS. TM wiring 42/42 PASS. Logs `/private/tmp/tm-shutdown-{focused,neighbors,required-web,core-tsc,app-tsc,wiring}-20260916.log` (focused log is `tm-shutdown-union-focused-20260916.log`). Existing fixture warnings remain.
- Preceding main replay focused Web: 4 files / 208 tests PASS. Two selector files preserve both parents: workflow token counts 445/441 to 447; required script 221/223 to 225, each missing=0. Shutdown merge has no manual resolution.
- Workbench run `c675c10b-1cc6-4cc7-b4e8-d77d20c6b06b`: 6/6 PASS with real login, retained whole-table recovery, selected row recovery and typed column/captured-value recovery. Fresh 405 migrations + replay; all 12 fixture residue categories zero; cleanupErrors empty.
- Archive run `d6439065-44df-4681-8f84-2d49a945c6db`: 6/6 PASS, fresh 405 migrations + replay. Real login and 401/403/503 negatives, viewer-timezone catalog, non-mutating preview, confirmation, persisted job rediscovery, exactly 5,001 restored rows and derived `{n:5001,pending:0}`. Desktop/mobile completion screenshots inspected: complete count and restored values visible.
- Both browser processes exit 0 with `Database pool closed` followed by `Shutdown complete`, without the preceding checkpoint's delayed `Shutdown timeout` warning. This is synthetic real-workbench acceptance, not arbitrary production WebSocket/signal/failure acceptance.
- Both dedicated databases are removed, independent exact/prefix database and backend census zero, task-owned PG stopped. Browser logs `/private/tmp/tm-4bd71-{workbench,archive}-20260916.log`; artifacts under `artifacts/timemachine-workbench` and `artifacts/recovery-archive-server`.
- Source shutdown mutation evidence remains bound to #5768's implementation commits; this automatic integration did not rerun those mutations. Published combined-head CI remains required. Production provider/KMS durability, capture coverage and nightly missing-sample attribution remain open.

## Fresh Workbench Acceptance After Record Approval Replay

Clean head `4151ce27dbcd5aaf5a304294e160fddb90b31eb5`, tree
`ef8a7b30d68a2ff4b0d83a42fbc9cd417eaa03da`, passes the real LoginView /
persisted session / app router / MetaSheetServer workbench acceptance 6/6.
Artifact run `22b8fa90-928d-4aa3-9e94-c15dc4f733b2` binds script SHA-256
`a7286d110194bda8d87f0fe4d77aa2aec8dc1868199dafde727d3ac6f558495d`.
Cases cover retained rows, history, retained whole-table delete/restore, named
actor and selected-row restoration, viewer-local time and typed column/captured
value restoration. Fresh 405 migrations and no-op replay pass; artifact fixture
residue is zero across all 12 categories, cleanupErrors is empty, independent
database/backend residue is zero after drop, and the dedicated PG is stopped.

Log `/private/tmp/tm-4151-workbench-20260916.log` records `Shutdown complete`
before `Shutdown timeout, forcing exit` ten seconds later. Current index.ts does
not cancel the timeout losing its Promise.race; successful workbench cases do
not prove shutdown lifecycle correctness. The owning approval shutdown task has
this exact evidence and the timer-cleanup distinction. No fresh 5,001-record
archive run, production provider/custody acceptance, or deployment is claimed.

## Record Approval Main Replay

Tested merge `5a8054d48a52b417cef7c99372541300fd776a2c`, tree
`c77f762ad226c3d65c408458776aee372009e20e`, ordered parents
`5c7f96a7b028414948e1cb673a4b75f6f2ec1576` +
`784c22dc182b2050bf204f4d013226d5bbb15131`:

- Backend focused unit: 2 files / 74 tests PASS; Web focused neighbors: 6 files / 316 tests PASS.
- Required-web exits 0; final group 460 files / 6,929 tests PASS. Log `/private/tmp/tm-784c-required-web-20260916.log`.
- Core typecheck and app-only `vue-tsc --noEmit -p tsconfig.app.json` PASS; diff-check PASS. No new mutation or independent review is claimed for this automatic merge.
- Dedicated PG15 synthetic database: fresh 405 migrations, second no-op replay, record-approval realDB 15/15 PASS. Log `/private/tmp/tm-784c-realdb-20260916.log`. This Express fixture uses synthetic identity middleware, not real browser authentication.
- Independent post-suite census: fixture users/sheets/bases and other database sessions each zero. Dedicated database dropped; exact database/backend residue zero; task-owned PostgreSQL stopped.
- Main recheck remained `784c22dc`. Published predecessor `5c7f96a7` had 28 SUCCESS, 1 expected SKIP, and Node20 pending at the last live query. No remote CI result for this merge is claimed. Earlier browser evidence stays bound to its original SHA.

## Embed Echo Main Replay

Tested merge `0753062239e16cce410714f7083a19bb19e15fac`, tree `4dfffc3a6fd62970e3d02e5064c689242ec753de`, ordered parents `b05fb6a8a61f6fb2f86e6a5254b23d7e42793538` + main `1bbf3c1c311ffd7dd58e841dd5e9a1c642db7e2c`:

- Four focused files (workbench view, embed host, external context, automation manager roundtrip): 186/186 PASS. Existing router-link resolution warnings remain; not warning-free.
- Full required-web exits 0; all groups PASS, final group 460 files / 6,919 tests. Log `/private/tmp/tm-1bbf-required-web-20260916.log`.
- `vue-tsc --noEmit -p tsconfig.app.json` PASS; 42/42 archive/exact-anchor wiring cases PASS. Logs `/private/tmp/tm-1bbf-app-tsc-20260916.log` and `/private/tmp/tm-1bbf-wiring-20260916.log`.
- Manual resolution only in `.github/workflows/multitable-web-guard.yml` and `apps/web/scripts/run-required-web-tests.sh`. Mechanical relevant-token census against both parents: workflow 202/201 to 203, script 215/215 to 217; missing=0 for each parent. Both new whole-file tokens are retained.
- Backend/plugin/OpenAPI first-parent delta empty; no fresh DB/browser/archive run claimed. Earlier synthetic evidence remains bound to its actual SHA. Diff-check and unmerged-index checks PASS. Fresh published-head CI and independent lifecycle/provider gates remain required.

## Nightly Diagnostic Contract Recheck

On clean `928bbe4ec367970a9a967616b38b7d66886fa90f`, the following local command passes 25/25 with zero skips:

```sh
node --test scripts/ops/phase5-required-samples-contract.test.mjs scripts/ops/phase5-metrics-auth-fallback-workflow-contract.test.mjs scripts/ops/phase5-cache-hit-rate-contract.test.mjs scripts/ops/phase5-nginx-metrics-route-contract.test.mjs
```

Log: `/private/tmp/tm-nightly-contract-recheck-20260915.log`. The required-samples tests execute the real validator against a disposable loopback synthetic metrics server: missing latency samples produce exit 1, five passes and six N/A; complete synthetic samples produce exit 0 and eleven passes. These positives and negatives establish the local gate behavior, not deployed sample availability. The latest read-only `phase5-nightly.yml` query still returns failed run `34920290620` on `c6f2d437a8810a822fb4210976aaf6af9ed3af74`. No threshold, workflow, production endpoint, provider, or sampling action was changed; nightly attribution remains open.

## Workbench Main Integration Checkpoint

- Published `c54422cbb6b9f177803bdb6e26004f28fbd6b586` reached terminal **30 SUCCESS + 1 expected SKIPPED**, zero pending/failure (Plugin System Tests run `34984450573`, including Node18/20 and coverage). Main remained `79dbc6588329b47e237315ea0bb1986625c5b64c` during final verification. This result binds c544 only; report-only successors require their own remote checks and do not authorize Ready/merge.
- Fresh real-workbench acceptance on published `c54422cbb6b9f177803bdb6e26004f28fbd6b586`, tree `c91af5a3a4dc61cd7a8695eabae21f4eddbfb824`, passes **6/6**; run `87948eea-e8d4-4dfc-aca4-26681b3017bd`, clean source, unchanged script SHA-256 `a7286d110194bda8d87f0fe4d77aa2aec8dc1868199dafde727d3ac6f558495d`. Real LoginView/persisted session/router/MetaSheetServer covers retained table delete/restore, named actor and deleted row values, selected-row restore, viewer-local configuration history and typed-column/captured-value restore. Dedicated PG15 fresh migrate plus second replay pass; independent migration count=405. Script reports all 12 fixture categories zero and cleanupErrors empty. Disposable database removed, independent exact database/backend census `0|0`, dedicated PG stopped. Logs `/private/tmp/tm-c544-{migrate,replay,workbench}-20260915.log`; artifact `artifacts/timemachine-workbench/evidence.json`. This supersedes the earlier workbench browser checkpoint only; no fresh 5,001-row archive/provider validation is claimed.
- Code `19c6b60ccd4437003f4982308b58e00698dcdf9a`, tree `83f5faaf3b5223329531dd5daa32ff4e4557b4a9`; true merge `e9553b380c0b70c3f5e369d114db6a9d23280c59` incorporates main `79dbc6588329b47e237315ea0bb1986625c5b64c` without conflicts. Incoming 11 files cover external-context convergence and automation-editor serialization.
- Initial five-file run: 362 PASS / 2 FAIL. Both incoming race tests assumed pre-fields context application and successful superseded requests, contrary to the TM atomic generation contract. Test-only child `bacea432` preserves atomic application and false cancellation; restored focused pair 42/42 PASS. Removing the post-fields generation check produces exactly those two RED cases, then restoration returns GREEN; production file restored byte-for-byte.
- Added the external-context spec to both existing Web gates and both workflow path lists; parent token omissions=0. In-memory deletion probes independently fail each selector contract; these are mechanical probes, not executed workflow mutations.
- Full required-web on the wired code exits 0, all groups pass; final group **459 files / 6,895 tests**, including external-context **11/11**. Log `/private/tmp/tm-19c6-required-web-20260915.log`. Earlier unwired full run passed 458/6,884 and does not substitute for this run.
- Application-only TypeScript passes; 42 TM wiring tests pass; official provenance differenceCount=0 before the Web-only selector addition (no pinned workflow changed). Logs `/private/tmp/tm-79dbc-app-tsc-20260915.log` and `/private/tmp/tm-79dbc-wiring-20260915.log`. No new DB/browser execution on this checkpoint; earlier runs remain SHA-bound evidence.
- Sol High narrow review was stopped while still running after its bounded window; no terminal verdict is claimed. Main-task code trace confirms cancelled requests return before memoization. The separately confirmed record-approval shutdown P2 remains unwaived and outside this test-only fix; independent ownership work is separate.
- Not yet remote exact-head CI evidence. No Ready/merge, flag, dispatch, provider selection or deployment.

## Record-Approval Backend Main Checkpoint

- Code `ba803089f7990958b23f261229907fd7f3bf58e1`, tree `6738f5f47f52b8b1b9477c6b01841c01010cf7bb`; ordered parents `c6475dfd84cefe8db7f7fff6b09f048b40b51a05` and main `59d1eac2c943e3ede8990f9521dc0d96207b7bcd`. The incoming 34-file record-approval backend merged without conflicts or manual changes.
- Six backend startup/record-approval/durable-routing files: 114/114 PASS. Four recovery actor/worker/read/plan authority files: 61/61 PASS. Core typecheck PASS. TM D2/exact-anchor wiring 42/42 PASS; official provenance differenceCount=0. No pin or selector edits in this merge.
- Fresh dedicated PG15 full migration: **405 entries**, followed by successful no-op replay. The two new record-approval migrations are included; the preceding 403-migration count is not reused for this tree.
- Real LoginView/router/Workbench/MetaSheetServer acceptance run `396aeb0f-dc3b-4d23-9557-ee9c55679a87`: **6/6 PASS**, sourceHead/tree exact and clean. Whole-table recycle-bin restore, named deleted-row values/row-only restore, viewer-local configuration history and typed column/captured-value restore all pass. Script reports all 12 fixture categories zero and cleanupErrors=[].
- On the same disposable migrated database, incoming `multitable-record-approval-realdb.test.ts`: **12/12 PASS**, including persisted submission, conflict, authority, durable completion and idempotent notification. This suite uses its documented test auth middleware and is not the browser-auth proof above.
- An additional manual fixture-count query used the nonexistent `multitable_sheets` name and failed; it is NOT counted as successful residue evidence. Subsequent normal database drop succeeded, independent exact database/backend counts were both zero, and the owned PG cluster stopped. No shared or production database used.
- Logs: `/private/tmp/tm-59d1-{backend,authority,core-tsc}-20260915.log`, `/private/tmp/tm-ba803-{migrate,replay,workbench,record-approval-db,wiring}-20260915.log`. Earlier full required-web evidence remains bound to `1937ec0e`; no Web production delta was introduced by this second backend-only main merge. The archive 5,001-row browser run remains on its earlier SHA, not rerun here.
- Sol High narrow read-only terminal review: integration-specific P1/P2/P3=0/0/0; session closed, no model tests. It also found a **main-existing P2**: record-approval completion event subscriptions are not detached/drained, and their promises are untracked before pool shutdown. With durable delivery off, an approval completion racing shutdown may leave its submission/notification pending without retry. The implicated startup/service files are byte-identical to incoming main; this is not caused by the TM merge and is not fixed or waived by these tests. Separate ownership follow-up is required; no whole-candidate zero-P2 claim is made.
- New published-head CI remains required; these local results do not imply Ready/merge or provider/custody/capture approval.

## Current-Main Replay Checkpoint

- Code `1937ec0e96984f310db034cfab8eac0d26693991`, tree `e0c6a366e8b54853e0186de7237556a431295a33`; ordered parents `50caab8495fa70e33985ec6ace190ae64eaafbc2` and `02808c068d8d5cf60ae9f73a1051b3cdffc6d65b`.
- The prior published head reached **30 SUCCESS + 1 intentional SKIPPED**, zero pending/failure, including Node18/20 and coverage (run `34970354055`). This proves that head, not the new merge. Final-main drift was recorded in PR comment `5681405388` before replay.
- Incoming main: 14 files, six path intersections. `git show --remerge-diff` names exactly `.github/workflows/multitable-web-guard.yml` and `apps/web/scripts/run-required-web-tests.sh`. Product merge is automatic; neither parent test set is removed. Domain token census: 437/439; required-web token census: 258/263; missing=0 for both parents in both files.
- Focused record-approval/inspector/drawer/workbench/trash/config-history: **9 files / 238 tests PASS**. Existing router-injection warnings are not failures and were not suppressed. Web application `vue-tsc --noEmit -p tsconfig.app.json` PASS. TM D2/exact-anchor wiring **42/42 PASS**. Official frozen/live package provenance differenceCount=0, pin unchanged.
- Full required-web exits 0, all groups pass; final group **458 files / 6,847 tests PASS**. Log: `/private/tmp/tm-02808-required-web-20260915.log`. Wiring log: `/private/tmp/tm-02808-wiring-20260915.log`. Diff-check and final clean-status checks PASS.
- Backend/plugin/OpenAPI trees are byte-identical to the preceding published head. Earlier DB/process/browser evidence below remains explicitly bound to its tested SHA; no fresh browser/DB execution is claimed for this Web/main merge. No database or provider was started, no deployment performed. Full local Vite config typecheck limitation remains as recorded below.
- This report-only child and merge will ordinary-FF update existing Draft #5744. Its new exact-head CI remains required. No Ready/merge, provider/custody decision, flag, dispatch or production action is authorized by these results.

## Final Navigation Checkpoint

- Final clean code `5131269ffd5afcc8aa561800910bdb299f4e68df`, tree `5c72f2df21d143a112d6dbbe52d1a1953eea0bda`, parent `c2c7d2ec47c2f2eded4121794f89d112abdeaf9b`. The production delta is exactly two foreground `loading=true` assignments in sheet-only/view-only external navigation; the existing background guard and generation-aware cleanup apply to these routes too. Two deferred-response regressions are RED on old code and under omission mutation, then restored GREEN. Three accompanying MD files record the preceding combined checkpoint, not additional runtime changes.
- Five workbench files / 213 tests PASS; restored composable/manager pair 46/46. Web application TypeScript and the two touched-file lint checks PASS. Fresh Sol High read-only review of the two-line delta and its ownership interaction: P1/P2/P3=0/0/0; session closed, no model-run tests. The full local Vite config type mismatch recorded below remains a limitation, not a passing gate.
- Full required-web on this exact code exits 0; all groups PASS, final group **456 files / 6,790 tests**. Backend, workflow, script, OpenAPI and plugin trees are byte-identical to `c2c7d2ec`; its core/script typecheck, 43/43 wiring and full S5 evidence are reused with that explicit boundary.
- Fresh real-workbench run `59628c05-fb5d-479d-8eea-cf3013d0c7ff`: **6/6 PASS**, sourceHead/tree exact and worktreeClean=true. Repeats all table/row/column/authentication scenarios below; fresh 403 migrations plus replay; all 12 fixture census counts and cleanupErrors zero, database dropped.
- Fresh real-archive run `750b3581-8a59-492f-8d57-16f704d05b1c`: **6/6 PASS**, same exact clean source. Fresh 403 migrations plus replay; repeats canonical authentication/flag negatives, confirmed non-mutating preview, persisted-job rediscovery, desktop/mobile progress and exact 5,001-row restoration. Derived `{n:5001,pending:0}`, databaseResidue=0, cleanupErrors=[]. Both processes exit 0; the pre-existing shutdown warning remains recorded.
- Independent final archive/workbench database-prefix and backend counts are zero; owned PG is stopped. One initial cluster restart omitted the dedicated port and failed before any connection or test; it was corrected to the previously audited loopback port. No shared database was used, and the failed initialization commands are not passing evidence.
- Final browser artifacts retain the same local paths below and now bind `5131269ff`. Logs: `/private/tmp/tm-final-5131269-{workbench-browser,archive-browser,required-web,migrate,replay}-20260915.log`; focused/mutation/type/lint logs use `/private/tmp/tm-final-external-busy-*-20260915.log`. Screenshots were inspected; no new screenshot is claimed as an uploaded remote artifact.
- Read-only nightly artifact retrieval now succeeds: run `34919685921`, artifact `10377791613`, ZIP SHA-256 `0604d894c0c5fd9af2c859dd152d737f7898b04707ec014ed038a729c050f426`. Its `phase5.json` confirms 11 checks, 5 passes, 0 measured failures, 6 N/A and overall fail. The archive contains only JSON/Markdown summaries, not raw scrape samples; it does not settle deployed target/label attribution or authorize production sampling. All three scheduled alerts remain open.

Publication uses a docs-only child of this code in existing Draft #5744. Fresh
published-head CI and separate Ready/merge authority remain required. No flags,
dispatch, deployment, production provider/capture or real tenant activation.

## Combined Current-Main Verification

All evidence below is local unless explicitly identified as a GitHub readback.
Historical sections retain their own exact SHA and do not supersede this section.

- Clean tested code: `c2c7d2ec47c2f2eded4121794f89d112abdeaf9b`; tree `4ba0f8216849f1486d2eb0ebf02b0531223149dc`. Relative main `f67984b34cc170e7256292e671d619502feea0e9`: 109 files, including inherited reports/screenshots, not 109 new production files. This report is a docs-only child of the tested code.
- True merge sequence: `21592612` joins #5744 `dbc4e2d4` with main `268aded9`; `195dbcc2` adds #5709 `c970c880`; `0ddc79e6` adds #5725 `0a23e4ed`. All three are conflict-free. Their path union has 106 entries. `703b7456` removes one duplicate permission-helper import left by the automatic merge; no authority logic changes. `86f40dcb` and `d775f50e` close context ownership and poll priority defects, adding three existing-main paths to that union. Final true merge `c2c7d2ec` has ordered parents `d775f50e5829f49b5b9a3db1c40537b9de8a3930` and `f67984b34cc170e7256292e671d619502feea0e9`; eight incoming automation files, zero TM overlap, zero manual resolution.
- Context regressions: 5 workbench files / 211 tests PASS. Old same-sheet response, stale context/error rollback, direct view switch, loading ownership and restore-notification cases are pinned. Independently neutralizing generation, identity, stale-rollback, and poll-loading guards makes the corresponding tests RED; all restored before commit. Initial pre-fix context cases were 7 RED, stale toast 1 RED, and poll priority 1 RED. Final Sol High read-only narrow integration review: P1/P2/P3=0/0/0, session closed; no model test execution or fresh whole-PR external review is claimed.
- Incoming-main neighbors on final code: 4 Web files / 210 tests PASS, including automation editor 139/139 and manager refresh 15/15; backend outcome/wiring 2 files / 33 tests plus archive application 1 file / 33 tests PASS. The earlier integrated 16-file Web run was 534/534 and 10-file backend run 185/185 on `703b7456`; these are earlier checkpoints, not extra final-head executions.
- Final required-web exits 0; all command groups pass, with the final group 456 files / 6,788 tests. The three edited workbench suites are in multitable-web-guard and the required script's actual invocation; the latter intentionally uses suffix-free filters for manager-flow and sheet-delete. A literal full-filename-only probe initially returned false for those two filters, but runtime token inspection and the executed test log prove coverage; no selector edit was needed.
- Core typecheck, Web application-only `vue-tsc --noEmit -p tsconfig.app.json`, and the explicit archive script TypeScript project PASS. Full local `vue-tsc -b` does NOT pass: unchanged `vite.config.ts` sees incompatible Vite 5/7 plugin types in the reused installed dependency tree. Config, manifest and lockfile are byte-identical to main; this is recorded, not masked or counted as an all-project typecheck pass. Touched view lint has zero errors; the mounted manager test retains eight existing multi-component warnings. Local Node is 24.14.1, not remote Node18/20.
- Exact-anchor/D2/OpenAPI wiring: 43/43 PASS. Official `computePackageProvenancePinSet` frozen/live differenceCount=0; no pin refresh. Full 11-file sealed-export S5 chain PASS, including positive package provenance. Existing installed mssql was exposed through temporary NODE_PATH only; no install, lockfile or shared dependency edit.

### Real Recovery Acceptance

Both scripts ran on clean `c2c7d2ec` and tree above through the real LoginView,
app router, MultitableWorkbench, MetaSheetServer and dedicated PostgreSQL 15.
No successful API response was mocked and no browser authentication was injected.

- Workbench run `e0102434-f6e6-4726-b874-371dc52ea9ed`: 6/6 PASS, exit 0. Covers real login, history entry, whole-table soft delete retaining all data/schema/views, explicit table restore, named actor plus all deleted values followed by selected-row-only restore, and deleted-column/local-time presentation followed by typed restore of the column and captured values. Full fresh 403 migrations and second no-op replay. All 12 fixture census counts are zero; cleanupErrors=[]; independent remaining connections/users/sheets/records zero before database drop.
- Archive run `4387cda5-d539-402a-b754-d4205d03f1e6`: 6/6 PASS, exit 0. Fresh 403 migrations/replay; 401 anonymous, 403 reader, 503 test-process flag OFF. Viewer-local catalog, non-mutating 5,001-row preview and required confirmation; one browser-accepted job rediscovered after full-page reload. Exactly 5,001 restored records at version 3, 5,001 revisions and derived `{n:5001,pending:0}`. Desktop 1440x1000 and mobile 390x844 screenshots were inspected; completed progress/count and restored values are visible. databaseResidue=0, cleanupErrors=[]. The pre-existing server shutdown timeout warning is not represented as a clean absence of warnings; the process exits 0 after cleanup.
- Combined real-DB regression at `703b7456923b28cc1f18ce73d29c1e46808bdc45`: four whole files / 90 tests PASS, zero skips (archive restore-jobs, config-history API, history-before hydration, dangling-link repair). Actual SIGKILL boundaries and application-timer resume/drain remain included. These suites and their recovery/history production sources are byte-identical to the final code; this is reuse of scoped evidence, not a second 90-test execution after the Web fixes or incoming automation changes.
- Both browser databases were dropped. Independent archive/workbench prefix database and backend counts are zero; owned PostgreSQL stopped. No persistent flag, customer data, external dispatch, staging or production operation.

Local artifacts: `artifacts/timemachine-workbench/evidence.json` and
`artifacts/recovery-archive-server/evidence.json`, with their screenshots. They
bind code/tree, clean state, script hashes, fixture type and cleanup. Logs are
`/private/tmp/tm-final-c2c7-{workbench-browser,archive-browser,required-web,wiring,s5,script-tsc}-20260915.log`
and `/private/tmp/tm-final-main-{backend,application,web,web-app-tsc,web-tsc,core-tsc}-20260915.log`.
These artifacts are session-local, not uploaded CI evidence.

### Remaining Gates

- Ordinary publication reuses #5744; new exact-head CI is required. Previous runtime head `dbc4e2d4` still had Node20 running at the last read. Main `f67984b3` had 15 SUCCESS, 3 SKIPPED and 2 running checks at the successful REST snapshot, after one API timeout; no combined-main all-green claim.
- Fresh read-only nightly queries still return failed runs `34919685921`, `34919841957`, `34920290620` on `c6f2d437`. Existing missing-sample attribution remains open; no alert/threshold change or production reload/restore was performed.
- Synthetic seeded archives do not prove production capture/coverage, durable object-store/key custody, real tenant UAT or deployment. Whole hard-deleted-table resurrection is excluded. #5709/#5725 metadata and separate Ready/merge authority remain unchanged.

## Real Archive Browser Checkpoint

- Clean tested code: `1907d2b413abbeb65b00e07c917406154f001501`; tree `72ec5b49e7890421f7e27c9810568e1e6cbae277`; parent `a1d2fe1968c9464de9b7306ac72f07065f380925`. Exactly two script/config files, +137/-5. Main was independently rechecked as `2b67a04625a0d6b089dac173e47a0de5d111e225`; no incoming replay was needed for this checkpoint. Production UI/backend, migrations and workflows have no final delta.
- Final manual run `913bcb95-87d7-4d2e-9b6d-8832f324c63e`: **6/6 scenario groups PASS**, process exit 0, worktreeClean=true. Complete fresh 403 migrations plus replay. Actual MetaSheetServer, Vite app entry/router, LoginView and MultitableWorkbench; real password auth and three persisted sessions including the browser. No fulfilled/stubbed responses or injected browser auth.
- HTTP authority negatives remain 401 anonymous / 403 reader / 503 test-process flag OFF. Browser catalog time matches America/New_York and differs from UTC. Real UI preview is async, shows 5,001 changes, leaves all live values/version unchanged and disables execution until confirmed. Browser acceptance returns 202 and creates exactly one persisted job. Full-page reload rediscovers the same job from the server; UI shows Completed, 5001 / 5001 and 100 percent. Closing the modal reveals archived-0 instead of live-0 in the workbench.
- Independent postconditions: all 5,001 records exactly match the seeded encrypted archive and have version 3; 5,001 restore revisions; derived effects `{n:5001,pending:0}`. Desktop 1440x1000 and mobile 390x844 preview/completion screenshots were inspected. Mobile progress/count/outcome must be fully in the viewport and un-clipped. The broader app navigation's responsive layout is not reworked by this acceptance-only change.
- Mutation 1: omit `applyJobSnapshot` during server job discovery. Browser acceptance still happens and the server returns the persisted job, but the reloaded modal has no job panel; the exact post-reload `toBeVisible` fails. Mutation evidence run `baa52e94-7fec-4e67-bc5d-b8e9a48851c2` is FAIL with cleanupErrors=[] and databaseResidue=0.
- Mutation 2: mobile CSS translates the count outside the viewport. The count still exists and reads 5001 / 5001, but `toBeInViewport` fails with viewport ratio 0. This closes the Terra Medium review's real P2 false-positive concern; the reviewer did not run tests or provide a second post-fix verdict. Both mutations were restored with apply_patch before the clean positive run. Modal SHA-256 is restored exactly to `ec133098d0e3203cb73e24645b9a8c878aac826745035b8ea807420ae032ff15`.
- Script SHA-256 `42973525ce6a9c3ff2b780033cdf0d5ea5310b5154974d33ed0f999fd6cb02bd`; committed script config SHA-256 `2dd24a7fd87076eeeb2c11fc62e489395d46cc3317f4f5643466c00db39ebaaa`. The fixture and existing 39-case real-DB suite are byte-identical to the preceding verified checkpoint; that whole suite was not rerun in this script-only window. New run evidence also binds the modal/workbench source hashes and the empty tracked-diff hash.
- Archive client/modal neighbors: **2 files / 95 tests PASS**. Committed script/source TypeScript project PASS. ESLint PASS with that explicit parser project; the default lint command initially rejected the script because the default core tsconfig excludes it, so that initial command is not counted as lint success. `git diff --check` PASS.
- Cleanup: browser/Vite/server closed, owned database and object directory removed; final independent database-prefix/backend census `0|0`; dedicated PG stopped. No customer data, persistent flag, dispatch or deployment was involved. Initial harness attempt failed on an incorrect job-table name after browser completion; it was corrected and is not counted as a product failure or a passing gate.
- Evidence is session-local: `artifacts/recovery-archive-server/{evidence,browser-discovery-mutation,browser-mobile-mutation}.json`, four `archive-{preview,completed}-{desktop,mobile}.png`, and `/private/tmp/tm-archive-browser-*.log`. The seeded catalog uses the existing fixture coverage metadata (coverageRowCount=0); actual manifest records and independently verified restore count are 5,001. This does **not** prove production capture/coverage generation, provider/KMS durability or deployed UAT. The manual script is not a required-CI test. Published-head checks must run afresh after ordinary push.

Reproduction on the already-admitted owned synthetic cluster:

```sh
NODE_ENV=test TM_ARCHIVE_TEST_ADMIN_URL="$OWNED_TEST_CLUSTER_ADMIN_URL" \
  TM_ARCHIVE_TEST_PGDATA="$OWNED_TEST_CLUSTER_DATA_DIRECTORY" \
  pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-archive-server.mts
pnpm --filter @metasheet/core-backend exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json
pnpm --filter @metasheet/core-backend exec eslint scripts/verify-recovery-archive-server.mts \
  --parser-options '{"project":"./scripts/tsconfig.recovery-archive-acceptance.json"}'
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/multitable-recovery-archive-client.spec.ts tests/multitable-recovery-archive-modal.spec.ts
```

## Standard Server HTTP Checkpoint

- Clean tested code: `54ac563ce3d0d69b1970a986370a6ef6bce5238b`; tree `bf2184778e308488dc87adcdae05bfa302b458e7`; parent `75adc9c14fcaad03354221727bf79e5fb9204f35`. Three test/script files, +520/-188. The preceding conflict-free true merge has ordered parents `85592c35d6c5c52933bbe2e9f1aad55af22d4b3a` and then-current main `2b67a04625a0d6b089dac173e47a0de5d111e225`; incoming main delta is three notification client/test files, no archive overlap.
- Manual standard-server acceptance: 3/3 scenario groups PASS. Real password login creates two persisted sessions; unauthenticated catalog returns 401 and read-only actor returns 403. Test-process flag OFF returns 503. Authorized catalog and preview work; preview selects async without changing 5,001 live rows. HTTP accept returns 202; server-owned worker reaches `done`, every record matches the encrypted archive with version 3, restore revisions count 5,001, and derived effects are exactly 5,001 completed / 0 pending. No test loop calls `runOnce` and no authorization callback is replaced.
- Full fresh PostgreSQL stream: 403 migrations; second replay succeeds. Every manual run creates its own random database after checking the dedicated cluster identity, then drops it in cleanup. Final clean-run evidence: run ID `366559bf-4906-4224-b9d6-60ddcb4cb2eb`, worktreeClean=true, databaseResidue=0, cleanupErrors=[]. Independent final manual-prefix/regression-database and backend census returned `0|0`; owned PostgreSQL stopped. Local Node is 24.14.1; this is not remote Node18/20 evidence.
- Script SHA-256: `c9b7a0bf1b509fa1edd691970cf513556b97353b369029d13854018d8d7b1c72`; extracted fixture: `0819d691e3aa62fcb598803e471cfabbcda1abefcfc2151ef4a4ff03d990eeee`; existing suite: `d0b80e45983ba9f31fe5fb8e6a8bccc2609d17e253888fae473ada92c3b1eb2b`. Final tracked dirty-diff hash is the empty SHA-256. The script also rechecks these bindings before declaring success.
- Mutation: temporarily omit `MetaSheetServer.start()`'s archive-worker startup. Login/catalog/preview/accept remain reachable, but the job stays `planned`; the script exits 1 with `WORKER_COMPLETION_REQUIRED` instead of reporting success. Its database is also dropped. Production `src/index.ts` was restored byte-for-byte (SHA-256 `edd0fc4e3f3fac0e76cd16436952cd5756406c98c43a6a55728004b7eba1255f`) before the clean positive run.
- Extracted-fixture whole-file regression: 39/39 PASS, no skips, 149.51 seconds, including both real SIGKILL/COMMIT boundaries and their application timers. This ran on the byte-identical final helper/suite before the code commit; it is not claimed as a second execution after commit. Its dedicated database had zero jobs, derived effects, test users/sheets and other connections, then was dropped.
- Core typecheck and explicit script+source TypeScript check PASS; diff-check PASS. Terra Medium performed the scoped extraction. Sol High read-only review found no P1 but two harness/evidence P2: incomplete dirty-source binding and a shared restore/derived deadline. Both were corrected before the clean positive run. No second external verdict is claimed. The production implementation and shared CI selectors are unchanged; the existing real-DB suite remains in the post-migrate workflow and excluded from no-DB runs. The new manual HTTP script is not a required-CI test.
- Local artifacts: `artifacts/recovery-archive-server/evidence.json` and `worker-start-mutation.json`; logs `/private/tmp/tm-archive-server-{exact,no-worker-mutation,tsc,core-tsc}-20260915.log` and `/private/tmp/tm-archive-fixture-regression-20260915.log`. They are session-local evidence, not uploaded remote artifacts. Initial harness attempts rejected a missing worker replay horizon and an incorrect expected job-state spelling; those failures are not counted as product defects or passes.
- Boundary: seeded verified archive, synthetic key custody, test-only process-local object metadata. This does not prove a production capture builder, independently durable provider/KMS restart, archive browser UAT or deployment. The standard server's pre-existing shutdown timeout warning is not counted as a worker failure: the observed process exited 0 after draining and cleanup. No production/source change was made for that separate warning. Published-head CI must run afresh; no Ready/merge/flag/dispatch/deploy is authorized by these tests.

Reproduction uses the already-audited disposable local cluster only; neither variable may name a shared or business service:

```sh
NODE_ENV=test TM_ARCHIVE_TEST_ADMIN_URL="$OWNED_TEST_CLUSTER_ADMIN_URL" \
  TM_ARCHIVE_TEST_PGDATA="$OWNED_TEST_CLUSTER_DATA_DIRECTORY" \
  pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-archive-server.mts
```

## Real Application Timer Lifecycle

- Code `34681dc7c326926311dbe5446b22355e8e81100f`, tree `c98b5d4a6b5075a03915f53a38ddab59f818fc0a`, parent `9763493bd481d9e4b6476b2830390603c401b04d`. Exactly two existing test/helper files, +68/-33; production source, providers, migrations, workflows and flags unchanged. This report/design/goal update is a docs-only child.
- Fresh child processes now compose `createRecoveryArchiveApplication`, use its actual interval and `startWorker`/`stopWorker`, and observe real run/lifecycle callbacks. The resume and derived-drain paths no longer call `runOnce` from a test loop. Canonical authorization, real PostgreSQL transactions and both actual SIGKILL boundaries remain.
- Clean code-head full restore-jobs suite: 39/39 PASS, no skips, 141.73 seconds. After before-COMMIT and after-COMMIT crashes, application startup resumes respectively two/one chunks, finalizes exactly 5,001 rows, and releases the writer block. Inactive actor leaves all 5,001 derived effects pending; reactivation lets timer ticks complete them in 156 batches of 32, then 9, then an idle tick. Existing independent database exact-once/formula/version assertions remain.
- Every normal child reports lifecycle `started,drained`, observes no further result during five interval lengths after stop, exits normally, and leaves no application-name database backend. Mutation omitting production `cancel(timer)` makes the before-COMMIT case RED at `archive_process_exit_timeout`; its owned child is killed by existing finally cleanup. Restored worker is byte-identical to parent before final green.
- Application/worker/server-wiring unit neighbors: 3 files / 67 tests PASS. Core typecheck, explicit helper/dependency typecheck and diff-check PASS. Terra Medium independently reviewed only the two-file test delta with zero findings; no model test execution is claimed and the session is closed.
- Dedicated PostgreSQL 15: fresh 403 migrations, subsequent replay no-op. Jobs, effects, synthetic users/sheets/bases and other connections zero before disposal. Database dropped; exact/prefix database and backend census zero; owned PG stopped. Test environment/authority triggers use the existing finally restoration; no live environment setting changed.
- Logs: `/private/tmp/tm-runtime-timer-{target,stop-mutation,exact-full,unit,tsc,helper-tsc,migrate,replay}.log`. These are local evidence, not remote CI artifacts. The selected mutation run's 38 filtered tests are not counted as a full pass.
- This closes the application interval/start/stop composition gate only. It is not a `MetaSheetServer.start()` HTTP lifecycle test, independent production object-store/KMS acceptance, archive browser UAT or deployment. Object bytes still cross fixture IPC and custody remains synthetic. Provider/custody selection and full standard startup remain open; fresh published-head CI is required.

## Full-Schema Fixture Cleanup CI Repair

- Code `3409c5f92b7622cb4b683ffe5e74c4e7186176ba`, tree `0ff867aa5ea8771454a45e96ad37aab2cee1ee64`, parent `cf69839968748f34a28df79206bce1b61d11ece5`. Six integration-test files only, 53 insertions and 5 deletions. No production, migration, workflow, package, flag or provenance change.
- Parent #5744 Node20 job `104332733237`, run `34954318359`, failed in the multitable real-DB step. Seven archive files failed: six old cleanup paths omitted the derived-effect child table and raised PostgreSQL `0A000`; leftover state also caused downstream catalog/hold assertions to fail. Node18 success did not override this exact-head failure. A full-schema local catalog run reproduced the FK failure before the repair.
- Cleanup now includes the archive-owned child only when present. Catalog rollback drops the empty child before jobs and reapplies it after jobs; the existing empty down/up positive explicitly checks child restoration before its transaction rolls back. No `CASCADE`, constraint weakening or test exclusion was introduced.
- Local Node `24.14.1`, isolated PostgreSQL 15: fresh full stream 403 migrations; subsequent migrate replay exit 0 and ledger count 403. Local Node is not a substitute for the new Node18/20 remote matrix.
- Final whole-file run: catalog 41/41, claim-anchor 19/19, coverage-binding 13/13, object-receipt-authority 17/17, source-pin-authority 18/18, stale-pin-cleanup 19/19, legal-hold-authority 19/19, restore-jobs 39/39. Total 8 files / 185 tests PASS, no skips. The unchanged restore-jobs neighbor includes the real process-death and 5,001-record resume/drain cases.
- Mutations: omit child from TRUNCATE -> exact FK refusal; omit child down -> dependent-object refusal instead of the expected nonempty-authority error; omit child reapply -> explicit child-presence assertion fails. All restored; catalog SHA-256 `a4a4d32b22590fb07d0e781e24e01f4794271a87120b7d94fae675cadb0df840`. One initial down mutation was contaminated by earlier intentionally failed cleanup and is not counted; its clean positive followed by a fresh distinguishing RED is the evidence.
- Core typecheck PASS; exact-anchor plus D2 archive wiring 42/42 PASS; diff-check PASS. Terra Medium independently reviewed the six-file cleanup delta with no P1/P2, without running DB/tests; the subsequently added child-restoration assertion was directly mutation-checked by the main task. No additional model review is claimed.
- Before final database disposal: archive/job/derived-effect counts and other connections were zero; one synthetic key from the deliberately broken cleanup run remained. The entire dedicated database was dropped. Independent exact/prefix database and backend census then returned zero; dedicated PostgreSQL stopped. No shared service or real customer data was used.
- Test logs are session-local under `/private/tmp/tm-runtime-ci-cleanup-*`; no remote artifact is claimed. This closes the bounded fixture dependency failure locally, not all runtime/product gates. New remote exact-head CI remains required. Standard provider/custody startup and full deployed acceptance remain open.

Commands from the repository worktree:

```sh
pnpm --filter @metasheet/core-backend migrate
NODE_ENV=test METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-recovery-archive-{catalog,claim-anchor,coverage-binding,object-receipt-authority,source-pin-authority,stale-pin-cleanup,legal-hold-authority,restore-jobs}-realdb.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend run type-check
node --test scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-ci-wiring.test.mjs
```

`DATABASE_URL` must point only at the dedicated synthetic database; the report intentionally omits connection credentials. Shell brace expansion above denotes the exact eight-file run, not an unbounded glob.

## Canonical Process Authorization Checkpoint

- Current-main replay `44fdd13ec2fdcbae37a084520a9e1f1d13188f5a`, tree `ac65250eced7f76900969a13d82813f71cd32d6b`: ordered parents `1038e6a4a8cbfe1ff5aae3dd5c3cc1e8e6275892` and `4e216662e8d2fd2dbab2f77b529df91a934a986e`. Conflict-free; incoming delta is one business verification document only. All backend/plugin/script/workflow/web paths are byte-identical to the tested parent. Wiring contract 36/36 PASS after merge; historical 39/39 DB and mutation evidence below remains exact-code-equivalent, not a newly executed DB run.

- Code `8f3a14a5580319321b3b64c9da3282061cee2233`, tree `2c5b3fa4cb1332adbf35103f2c892ee5341e21ea`; two test/helper files only, production unchanged.
- Real SIGKILL child now uses `createRecoveryArchiveWorkerAuthorization()` rather than allow-all callbacks. Synthetic users have explicit database permissions. Each process scenario snapshots, enables and finally restores the canonical authority triggers in the isolated database; missing trigger substrate fails closed.
- Both before-COMMIT and after-COMMIT/before-acknowledgment process-death cases PASS with fresh-process takeover, 5,001 records and existing exact-once/receipt assertions. Removing the fixture user's permissions makes the before-COMMIT scenario RED with `RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED`; restoration is included in full 39/39 PASS. Core typecheck and diff-check PASS.
- The initial canonical attempt correctly failed because fresh migrations leave authority triggers disabled. No production flag or trigger state was changed. Temporary reason-only diagnosis was removed; the production facade is byte-identical to parent.
- Fresh isolated migration succeeded. User/job/backend residue zero; all tested authority triggers restored disabled; database dropped, prefix databases/backends zero and dedicated PG stopped.
- This supersedes the earlier allow-all-child limitation only. The parent still supplies a local synthetic object store over IPC and fixture custody; full worker-loop derived draining, explicit revocation between process restarts, standard startup and independently durable provider acceptance are not established here.
- Pre-push remote main advanced from `58f704be92fe7711332b84d87a7c545776a38b8f` to `4e216662e8d2fd2dbab2f77b529df91a934a986e`; this checkpoint is local-only pending bounded replay. Existing remote #5744 remains `a37e93f422e121e8f023579b084e67b6f845a266`.

## Exact Migration Census CI Repair

### Connection Exhaustion Evidence

- Test checkpoint `ba0e74abd58f739129d7bcb506765965a67f7cbe`, tree `f993e845ca6e986ae17e7541dda4ccba51a9803f`: one real-DB test file, 27 added lines; production source unchanged.
- Uses the production ConnectionPool wrapper with max=1 and a one-second connection timeout. The queue transaction owns the only connection; attempted nested processor transaction never enters. Consumption returns retry, leaves completed_at NULL with attempted=true, has zero waiters and returns the connection to idle. Existing healthy-pool retry/serialization flow then completes the same effect.
- Mutation marking a caught processing error completed is RED at the new capacity assertion (and the existing abandoned-partial exception assertion); restored focused three terminal-state cases PASS. Full restore-jobs PostgreSQL suite 39/39 PASS, including existing process-death boundaries; core typecheck and diff-check PASS.
- Fresh isolated migration succeeded. Final ledger/job counts and other database backends were zero; database dropped, prefix database/backend census zero, dedicated PG stopped.
- This proves bounded retry without false completion under finite connection timeout, not single-connection processing liveness or a throughput SLA. Queue and canonical processor still require two concurrently available connections for progress. Provider selection, standard startup and canonical whole-process acceptance remain separate open gates.

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

### Process Restart And Canonical Derived Completion

Exact test commit `0f5e1176a4adc74afa26a6ac769af1982eb66892`, tree `16ba1647f7c401b4892cf7c76e72236e49de18cb`:

- Actual SIGKILL before commit and after commit/before acknowledgement retain the existing restore/receipt uniqueness assertions. Both now drain 5,001 effects through the real canonical derived processor rather than a terminal stub.
- Inactive synthetic actor gives retry, zero computed change and 5,001 pending effects. Reactivation completes exactly 5,001 effects; the next consume is idle. First and last formula values match restored inputs; the last record remains version 3. Formula fixture IDs use the engine's existing `fld_` grammar, without changing production parsing.
- Prefix-scoped afterEach cleanup prevents long process tests leaving an expired prior fixture for a subsequent sweep assertion. The strict expected sweep count remains unchanged. Final full suite: 39/39 PASS, zero skips, 147.51 seconds. Log `/private/tmp/tm-process-derived-isolated-full.log`; dedicated fresh migration log `/private/tmp/tm-process-derived-migrate.log`. Synthetic users/jobs/effects/backends zero, database dropped, prefix residue zero, dedicated PG stopped.
- This is canonical parent-process queue consumption after child restart, not complete standard-startup/provider or child worker-loop acceptance. No new mutation result is claimed for this test-only commit.

### Scoped Derived CI Disposition

Exact code `04b63fd732ecb33c90cc07e2767cebc4630a8647`, tree `9584554625d1c48ba5c546176dff23cb288572e9`: one source file, two comment lines, no runtime/SQL change.

- Remote run `34951043638` at `c9a5debf2d4b97f0ea0ab917d764635378742b43` reported missing lock/revision disposition at the new scoped derived UPDATE. Existing sibling derived writers already declare this computed-only exemption. Canonical actor authorization and scoped sheet fences remain required by the caller.
- Direct lock guard, revision guard and richtext/longtext write-sink neighbor: 3 files / 19 tests PASS. Removing the two new annotations produces exactly the two corresponding guard failures, both naming this SQL site; restoring returns 19/19 PASS. Logs `/private/tmp/tm-derived-disposition-{guards,mutation,restored}.log`; diff-check PASS.
- No DB rerun for comment-only source change. Prior 39/39 real-DB evidence remains bound to its exact test commit. Remote head must run its own CI; local results are not a remote pass.

### Current-Main Attendance Replay

True merge `bf98898de36e71a913ac526752eeb8870d212168`, tree `f673c33c3273507cdfddd692495d504b2494b0dd`, ordered parents `7510edbb59c5e954e90b39cd09fac859d84a4306` and then-current main `3af707dddca48b196e168da0fab45560f88acd11`. Seven incoming attendance Web paths, no conflicts or manual resolutions. First-parent backend/plugin/script/workflow/OpenAPI delta is empty, including provenance. Incoming attendance dashboard/reveal tests pass 98/98; the three disposition/sink guards pass 19/19 again; diff-check and worktree clean. Logs `/private/tmp/tm-main-attendance-neighbor.log` and `/private/tmp/tm-derived-disposition-merged.log`. No repeated real-DB claim or production operation; publication still requires fresh exact-head remote checks.

### Fresh-Process Worker Drain

Exact code `7e451b46b14859eadd4e5dd3a015799cb22efc07`, tree `b505c7da96644c8846d26f3b9be0c9df5872f608`: two test/harness files only, 62 additions / 13 deletions.

- Both real SIGKILL cases now invoke a fresh child using the production worker factory and `runOnce`, canonical derived processor and real PG transactions. Parent PID differs; normal child exit is 0 and its application-name backend census returns zero. The original restore restart/lease/receipt assertions remain intact.
- Inactive actor: one attempted callback, zero completions, one idle tick, no stale formula change and 5,001 pending effects. Reactivated actor: exactly 5,001 callback completions; batch sizes exactly 156 times 32, then 9, then 0. Each tick has zero restore chunks/sweeps. Formula and ledger completion assertions remain exact. No parent callback completes these effects.
- Mutation changing the production worker derived loop bound from 32 to 0 makes the before-COMMIT case RED: expected one denied callback, received zero. Production worker restored byte-identical, Git blob `15f950ed13e795f28a7d9540d494914cd046800e`.
- Fresh isolated migration PASS; final complete restore-jobs suite 39/39 PASS, zero skips, 141.75 seconds. Core tsc and diff-check PASS. Logs `/private/tmp/tm-child-drain-{migrate,target,mutation,full,final-tsc}.log` are session-local evidence, not remote artifacts.
- Synthetic users, jobs, effects and other database backends zero. Dedicated DB dropped, exact/prefix database and backend census zero, PG stopped. No shared DB, provider or deployment change.
- Two simultaneous connections suffice for this serial fixture, not a production capacity SLA. Child object store/key custody remain fixture-bound; standard startup/provider, timer-driven server acceptance and real browser UAT are not claimed. Remote CI must be evaluated at the published successor SHA.

### Production Worker Resume

Exact code `7d6d230c68720b5dc0bc679fb6a8d86fe6b09206`, tree `23c9484142ddb9b4292c6997f242d7bb6cd222b9`: two test/harness files only, 37 additions / 29 deletions.

- Fresh-process resume uses `createRecoveryArchiveRestoreWorker().runOnce()` with canonical authorization and processor. Before-COMMIT case reports completed/2 chunks; after-COMMIT-before-ack case reports completed/1 chunk, both with zero sweeps. Database evidence independently proves done/5,001, incremented worker fence, unchanged block fence, exact chunk/restore revision uniqueness, terminal aggregate and writer-block release. The subsequent independent worker drain still proves all 5,001 effects and exact bounded batches.
- Mutation replaces only production factory finalization with a no-op. Worker returns completed, but the before-COMMIT case fails because the independently queried job state is applying rather than done. Restored production file matches Git blob `15f950ed13e795f28a7d9540d494914cd046800e`.
- Fresh isolated migration PASS; restored full suite 39/39 PASS, zero skips, 147.42 seconds; core tsc and diff-check PASS. Logs `/private/tmp/tm-worker-resume-{migrate,mutation,full,tsc}.log` are session-local, not remote CI evidence.
- Users/jobs/effects/other backends zero, dedicated DB dropped, prefix databases/backends zero, PG stopped. No dependency installation or shared DB operation. Standard startup/provider configuration, real timer/server lifecycle and browser UAT remain outside this evidence.

### Template Client Current-Main Replay

True merge `f78d286562a142f98c061d8842e88ff69f27cf37`, tree `ac69e2892e7c257fb018d9dcbaefdec2b4a17f53`, ordered parents `10499baa04de502e9bb9cba032f5e8b0bd473577` and main `28d11496bb4281738c3dd13096fe317ff42e8780`. The incoming #5747 delta is the approval-template list client and its dedicated test (two Web files), conflict-free with zero manual resolution. Backend/plugin/script/workflow/OpenAPI and provenance bytes are unchanged from the first parent. Incoming focused Web test 4/4 PASS (`/private/tmp/tm-template-client-replay.log`), diff-check PASS. The preceding 39/39 real-DB evidence is reused only for the byte-identical backend/harness; it is not new combined-main remote CI or browser acceptance.
