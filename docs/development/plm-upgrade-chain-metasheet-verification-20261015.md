# MetaSheet side of the Yuantus upgrade chain — verification (2026-10-15)

Companion to `plm-upgrade-chain-metasheet-design-20261015.md`. Draft PR [#6425](https://github.com/zensgit/metasheet2/pull/6425) on `cursor/plm-upgrade-chain-metasheet-316e`, base `codex/plm-visual-consumer-20261015`.

## Evidence classes (kept separate; counts are never summed across classes)

- **A. Remote CI by exact SHA.** GitHub check runs read through `repos/zensgit/metasheet2/commits/<sha>/check-runs`, with `head_sha` verified equal to the SHA.
- **B. Local unit/route.** vitest 1.6.1 on Node v22.14.0, after `pnpm install --frozen-lockfile` with pnpm 10.33.4. CI uses Node 20 and pnpm 10.16.1.
- **C. Local real PostgreSQL 16.15.** A private cluster under a temporary directory with an ownership marker; one fresh database per run; nothing pre-existing is targeted.
- **D. Local full backend suite.** `CI=true node node_modules/vitest/vitest.mjs run` with the default `vitest.config.ts` and no database. This is the core-backend step of `test (20.x)` without the CI job's other steps.
- **E. Static inventory.** Code reading with `path:line` citations, in the design document.

No paired Yuantus server, real DingTalk, browser, TLS edge or production system was exercised. All fixtures are synthetic.

## Source identity

| Item | SHA |
| --- | --- |
| Handoff head (remote = local, verified by `git fetch`) | `a5977db1c2afb0106d87e60fe066cd4a3427dc4c` |
| `main` merge base of the stack | `ad2246fecd7af5227f8f4a68ee5c8ba8512e212c` (`main` has moved 10 commits since; no rebase is done here) |
| Code commits on this branch | `aa1ed32` org check, `9daedd2` disabled binding, `7994071` tripwire, `0ac8b5f` bridge, `f46c317` flag, `18922e0` vitest exclusion |

The documentation commit that adds this file is checked separately in the PR and is not rewritten to cite its own SHA.

## Task 1: exact-head CI of the handoff stack (class A, read at 13:47–14:20 UTC)

| PR | Head (branch) | Base | Exact-head checks | Earlier commits | Not run on this head |
| --- | --- | --- | --- | --- | --- |
| [#6413](https://github.com/zensgit/metasheet2/pull/6413) | `2d520922bb7a` (`codex/plm-listener-review-20261015`) | `main` | 62: 61 success, 1 skipped (`Strict E2E with Enhanced Gates`, not executed) | `b8e3346`: 9 cancelled (superseded). `de8f03d`: `test (20.x)` failed, 14/22,976 tests in 9 files (GW7 raw `meta_records` writer boundary on `plm-bom-review-service.ts`, supertest tripwire on `plm-bom-review-routes.test.ts`, and others), [job](https://github.com/zensgit/metasheet2/actions/runs/38662339874/job/116186578264). Fixed by `5600570`; green since. | The 23 names present only on other heads (for example `visual-consumer`, `record-ingress-regression`, `postgres`) |
| [#6417](https://github.com/zensgit/metasheet2/pull/6417) | `2323b45369b0` (`codex/plm-bom-ui-20261015`) | #6413 branch | 17/17 success | `2be37cf`: no check runs. `c898b4e` and `95ed462`: `integration-guard` failed, 2/1,342 web tests in `StockPreparationWorkspace.spec.ts` (the `/plm` route allowlist pin), [job](https://github.com/zensgit/metasheet2/actions/runs/38706873780/job/116328343253). Fixed by `2323b45`. | 67, including `test (20.x)`, `web-tests`, `contracts (*)`, `coverage`, `migration-replay`, `e2e` |
| [#6418](https://github.com/zensgit/metasheet2/pull/6418) | `a5ed6d86376d` (`codex/plm-record-push-20261015`) | #6413 branch | 43/43 success (single commit) | none | 41, including `test (20.x)`, `web-tests`, `contracts (*)`, `coverage` |
| [#6423](https://github.com/zensgit/metasheet2/pull/6423) | `c11e3a2a2010` (`codex/plm-personal-approval-20261015`) | #6418 branch | 56/56 success | `80210bc`, `d7ee868`: 56/56 each | 28, including `test (20.x)`, `web-tests`, `contracts (*)`, `coverage`, `migration-replay` |
| [#6424](https://github.com/zensgit/metasheet2/pull/6424) | `a5977db1c2af` (`codex/plm-visual-consumer-20261015`) | #6423 branch | 46/46 success | `9d89380`: `plm-embed-web-guard` failed, 8/70 in `plm-embed-service.spec.ts` (exact shapes lacked the new default-false Visual flag), [job](https://github.com/zensgit/metasheet2/actions/runs/38731299585/job/116409470300). Fixed by `73024fc`. | 38, including `test (20.x)`, `web-tests`, `contracts (*)`, `coverage` |

"Not run" means check names in the 84-name union across the five heads that are absent on that head. Workflows such as `plugin-tests.yml` (`test (20.x)`, `coverage`) and `web-tests.yml` trigger only for `main` and `develop`, so they never ran on #6417, #6418, #6423 or #6424. The six contexts the stack docs list as required on `main` (`contracts (strict)`, `contracts (dashboard)`, `contracts (openapi)`, `test (20.x)`, `web-tests`, `stock-prep PowerShell 5.1 acceptance`) cannot be read with this token (branch protection API returns 403), so that list is unverified here. No job was rerun.

### What `test (20.x)` would report on the handoff head (class D)

These are the same default config and the same Node 22 environment, in clean worktrees whose plugin dependencies were not linked. That is why both sides show the same 53 suite-load failures (for example `Cannot find module 'zod'` from `plugins/plugin-attendance`).

| Source | Test files | Tests |
| --- | --- | --- |
| `main` merge base `ad2246f` | 54 failed (all load-level, environment) / 1,104 passed / 170 skipped (1,328) | **0 failed** / 20,300 passed / 1,739 skipped (22,039) |
| Handoff head `a5977db` | 65 failed / 1,113 passed / 170 skipped (1,348) | **20 failed** / 20,572 passed / 1,739 skipped (22,331) |

On the handoff head and not on the merge base:

| Failing check (test file) | Offending site | Introduced by | Status on this branch |
| --- | --- | --- | --- |
| `supertest-app-mode-tripwire` | `plm-personal-approval-routes.test.ts` (5 `request(app)` sites) | #6423 | **Fixed** (`7994071`) |
| Default config loads `plm-personal-approval-realdb.test.ts` | import throws `DATABASE_URL required` | #6423 | **Fixed** (`18922e0`) |
| `multitable-record-lock-guard` (rank-8) | `plm-record-ingress-service.ts:161` UPDATE without lock disposition | #6418 | Open (needs owner disposition) |
| `multitable-revision-disposition-guard` (OD-6) | `plm-record-ingress-service.ts:161,165` | #6418 | Open |
| `multitable-permissions-txn-liveness-recheck` (#5938) | `plm-record-ingress-binding.ts` `meta_sheets … FOR SHARE` not named | #6418 | Open |
| `api-path-policy.guard` | `oapi-read-allowlist.ts:106` compares against an `/api` literal | stack (file changed by #6418) | Open |
| `attendance-w6-…-authorization` (`index.ts` pre-gate census, 4 tests) | new `app.use('/api/multitable/plm-record-ingress', plmRecordIngressParser)` | #6418 | Open |
| `metasheet-recovery-archive-wiring` (2 tests) | `index.ts` wiring calls `get` an extra time | stack `index.ts` changes | Open |
| `encrypted-store-census.guard` (5 tests) | `PlmPersonalApprovalBindingService.ts` new `encryptStoredSecretValue` site not pinned | #6423 | Open |
| `outbound-sql-write-gate` (3 tests) | `DataSourceManager.ts:1399` receives a config without `type` from the test's fake database after #6424 made `persistDataSource` transactional and value-returning | #6424 (test double) | Open |
| `plm-personal-approval-transport` (1 test) | spawned loader on local Node 22: "does not provide an export named 'PLMAdapter'" | local environment | Not attributed (passed in the dedicated Node 20 workflow) |

A branch run in `/workspace`, where every package's dependencies are installed, gave 9 failed / 1,166 passed / 172 skipped test files (1,347), and 19 failed / 21,423 passed / 1,751 skipped tests (23,193). The 19 failed tests are exactly the handoff's 20 minus the tripwire, with **no new failure**. The environments differ, so only the test-level comparison is meaningful.

## Task 2: changes, red then green (classes B and C)

| Change | Red before fix (same test) | Green after fix |
| --- | --- | --- |
| Embed org check (`aa1ed32`) | `plm-embed-routes` + `plm-embed-visual-preview-routes`: 8 failed / 41 passed (49). The cross-org cases reached the provider call. | 49/49. Embed and Discussion relays: 4 files, 100/100. |
| Disabled binding (`9daedd2`) | New real-DB test, filtered run, 1 failed / 131 skipped (132): listener still `active`. With that assertion temporarily removed it failed again: `expected { created: 2 } to deeply equal { created: 0 }` (two escalations created after disable). | Full BOM review real-DB suite 132/0/0 (handoff baseline 131/0/0). Listener workflow unit list 10 files, 111/111. Six structural guard/tripwire files (W1-3 write path, fence recheck, rich text sink, OAPI allowlist, sheet liveness closure, supertest tripwire): 165 passed, 1 failed. The failure was the pre-existing tripwire, fixed in the next row. |
| Tripwire (`7994071`) | Handoff: 1 failed / 2 passed (3) | 3/3; route spec 9/9 |
| Bridge refusal (`0ac8b5f`) | With only `ApprovalBridgeService.ts` reverted: `expected 409 "Conflict", got 200 "OK"`, 1 failed / 30 passed (31) | 31/31; repeated 10× plus 3× combined with `federation.contract` and `plm-adapter-yuantus` (96/96). One earlier combined run during a concurrent full-suite load reported 1 failure that did not reproduce in those 13 reruns. |
| Flag registration (`f46c317`) | Negative control (manifest entry removed): 2 failed / 48 passed (50), namely completeness and the reader test | `global-history-flag-manifest` 50/50 (handoff 49/49); `multitable-global-history-flag-status` 21/21 |
| Vitest exclusion (`18922e0`) | Handoff default config: `Error: DATABASE_URL required` | Branch default config: "No test files found". The dedicated config still loads the file and enforces `DATABASE_URL`. |
| Write-back audit (this pass) | `plm-workbench-writeback-audit.test.ts` against the unaudited routes: 6 failed / 2 passed (8). The two passes were the pre-provider refusals, which correctly write nothing. | 8/8. Together with the existing BOM write, ECO intent, write-error redaction and data-source ownership route files: 4 files, 67/67. |

Other real-DB suites on the branch (class C, fresh database each, previous pass): personal approval 16/0/0, record ingress 25/0/0, Visual source authority 14/0/0. Backend `tsc --noEmit` passed on the previous head. This pass changes `plm-workbench.ts` and does not rerun those real-DB files; they do not import the workbench router. No web source changed. The 19 pre-existing full-suite reds were not edited and were not rerun.

## Second pass against the eight Yuantus documents

The documents were read from the uploads, not from the Yuantus git tree. Wrapper lines around the fetch are ignored. Reconciliation, the dropped-line question, and the reclassification of SSO, Discussion visibility, revocation, DP1, Stage A, RG source binding and the version roadmap are in the design document. Whole-BOM completion stays unbuilt because those documents do not say how a refresh that drops lines counts.

The write-back audit test does not catch an outcome row written with a different actor than the request, beyond the assertions on `actor_id`. It uses a mocked `pg` query, not PostgreSQL. A deployment whose `operation_audit_logs` table lacks `route` or `meta` fails closed (503, no provider call) rather than writing a partial row.

### Coverage of the requested scenarios

| Scenario | Where covered |
| --- | --- |
| Cross-tenant | Existing embed tenant tests (BOM 3 + real adapter), personal `checkScope`, record ingress source equality |
| Cross-org | New: 6 BOM relay tests (including a real `PLMAdapter` with hand-set `x-org-id`) and 3 Visual relay tests |
| Escalation | New disabled-binding test (SLA matured after disable creates nothing). Existing SLA scan test. |
| Revocation and source transfer | Existing listener and authority-version real-DB tests (unchanged, inside the 132) |
| Concurrent update and duplicate callbacks | Existing concurrent scan and deliver races, duplicate inbox and receipt tests (inside the 132, 16 and 25) |
| Idempotency | Existing frozen intent, `source_event_id` unique and completion Idempotency-Key tests |
| Outage | Existing completion lease/OUTCOME_UNKNOWN and listener restart tests |
| Migration | Existing downgrade-refusal tests. **No new migration** in this PR. |
| Disable / restore | New disabled-binding test (cancel `BINDING_DISABLED`, listener stopped with cursor kept, audit revision, re-enable refused, evidence retained). Flag-off workers are covered by existing worker unit tests. |

Gaps that tests here do not catch:
- A mutation that skips the disabled check only in `notificationContext` is masked by the explicit prepare/deliver checks. Removing those as well is caught.
- An adapter whose `getEffectiveOrgId` returns the token's org without actually sending it is not detectable at the relay.
- The bridge guard is tested through the route with a mocked database, not against PostgreSQL.

## Checklist

**Done.** Remote-head verification. Exact-SHA CI read for #6413–#6424 and for the previous head `a802744` (48/48). Inventory. The first-pass fixes, each with red-then-green. Write-back audit, red then green (8/8, 67/67 with the surrounding route files). The eight uploaded Yuantus documents read and reconciled. Local real-DB lanes for all four PLM suites on the previous head.

**Not done.**
- Whole-BOM completion. Open question, in the design document: how lines dropped by a refresh count. Not guessed.
- Which Yuantus account performs the write. The MetaSheet audit of who requested it is done.
- Generic pre-review wiring. The reuse review does not name a template, trigger or form mapping.
- The 19 pre-existing reds owned by #6418/#6423/#6424. Not edited.
- Personal-binding MetaSheet tenant column.
- Flag-off legacy bridge.

**Classified, not built here.** SSO and Discussion visibility: Yuantus contract absent. Revocation: done as observe-on-next-call. DP1 and baseline batch: Yuantus-only. Stage A and RG: not defined for MetaSheet in the eight documents. Version/upgrade rehearsal: needs a real environment.

**Pending real environment (owner-approved only).**
- Paired Yuantus server with real accounts in a read-only window.
- Real DingTalk delivery.
- Embed edge CSP and TLS.
- Upgrade-package install, backup, restore and failed-upgrade handling.
- Full migration chain and server lifecycle with these commits.
- Customer acceptance.
- Exact-head CI of the commit that adds the write-back audit. It is checked once after the single push and recorded in the PR description, not by another commit.

## Reproduction

From `packages/core-backend`, with `<db-url>` a disposable PostgreSQL database URL:

```sh
pnpm install --frozen-lockfile
node node_modules/vitest/vitest.mjs run tests/unit/plm-embed-routes.test.ts tests/unit/plm-embed-visual-preview-routes.test.ts tests/unit/approvals-bridge-routes.test.ts tests/unit/plm-personal-approval-routes.test.ts tests/unit/supertest-app-mode-tripwire.test.ts tests/unit/plm-workbench-writeback-audit.test.ts tests/unit/plm-workbench-bom-multitable-routes.test.ts tests/unit/plm-workbench-write-error-redaction.test.ts tests/unit/plm-workbench-datasource-ownership.test.ts
DATABASE_URL=<db-url> EXPECT_DB=1 node node_modules/vitest/vitest.mjs run --config vitest.plm-bom-review.config.ts
DATABASE_URL=<db-url> EXPECT_DB=1 node node_modules/vitest/vitest.mjs run --config vitest.plm-personal-approval.config.ts
DATABASE_URL=<db-url> EXPECT_DB=1 node node_modules/vitest/vitest.mjs run --config vitest.plm-record-ingress.config.ts
PLM_VISUAL_SOURCE_TEST_DATABASE_URL=<db-url> EXPECT_PLM_VISUAL_SOURCE_DB=1 node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/plm-visual-source-authority-realdb.test.ts
CI=true node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
```

From the repository root: `node --test scripts/ops/global-history-flag-manifest.test.mjs scripts/ops/multitable-global-history-flag-status.test.mjs`.

## Residual risks and limits

- Deployments must configure the served org (`x-org-id` through `PLM_ORG_ID`, `plm.orgId` or the source's `options.orgId`). Otherwise the embed relays now refuse with 403 by design.
- The workbench write-back is now audited in MetaSheet and may still be executed by the shared integration account. The audit records the MetaSheet actor, not the Yuantus subject.
- Whole-BOM completion can be configured and does not fire. The dropped-line rule is unanswered.
- The local runtime is Node 22, not CI's Node 20. Exact-head CI is the authority for CI claims.

## Independent approval-boundary verification — 2026-10-17

Input source: `70af11cadb2393f1fe6e477ea539a6924184d347`. Grok 4.7 (xhigh) implemented the scoped guard and tests; Codex independently read the diff and executed the tests with Node **20.20.2** and existing locked dependencies. This runtime statement applies to this increment, not the older Node 22 evidence above.

- With the new tests and the original two source files restored temporarily, both entry tests failed: expected 409, actual 200. Sources were restored to the candidate in a `finally` block. Two failures, 42 unrelated tests skipped by the focused name filter.
- The four complete candidate suites passed independently: approval bridge **31**, federation **13**, personal approval routes **9**, personal transport **9**; **62/62** in **1.62s**. Flag matrices cover unset/off/false/TRUE/1/true for approve and reject; assert no adapter decision, no local decision record/status/assignment mutation. Platform approve/reject, existing history, federation substitutes and personal-card positives remain covered.
- `git diff --check` passed. No production call, real notification, deployment or merge occurred. No new environment flag or migration.

Reproduce from `packages/core-backend` under Node 20: `node node_modules/vitest/vitest.mjs run tests/unit/approvals-bridge-routes.test.ts tests/unit/federation.contract.test.ts tests/unit/plm-personal-approval-routes.test.ts tests/unit/plm-personal-approval-transport.test.ts`. The package manager wrapper rejected symlinked task-state dependencies (`ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`); the existing locked Vitest binary was invoked directly, without dependency changes.

Exact pushed-head CI is tracked separately in the PR description. The purpose-specific personal BOM-line/ECO chain, split identity/RBAC/PLM topology and cross-process revocation remain pending; these guard tests are not their acceptance evidence.


## Personal BOM foundation review checkpoint — 2026-10-17

Native provider Draft PR349 now has source
`e75a9f4cb56ef772618035e93528487e78f3d2b0`; its exact-head CI is pending.
It includes independent-purpose grants, controlled line/ECO APIs and native
purpose-selection UI. The complete local native workflow passed328 tests without
skips on owned PostgreSQL15; canonical JWT/REST/RPC/UI/org controls passed87.
These overlapping counts are not MetaSheet integration proof. Native first-use
password login/PATCH compatibility was repaired and reviewed with Astra ultra.

Grok4.7(xhigh) is implementing the MetaSheet binding/wire foundation. Codex
independently reproduced and checked the following with Node20.20.2 and existing
locked dependencies; no real provider account, external notification or deployment
was used:

- A stale cached adapter origin received a synthetic personal bearer before the
  repair. With persistent target origin carried explicitly through the actual
  adapter, the real-PG positive control targets only the current native origin.
- A real PostgreSQL15 row-lock barrier and `pg_blocking_pids` reproduced40P01
  between public rebind and use on service hash06c40de9. Stable repaired hash
  `6c87903c3362a66b6f5bd38d8479855be374dad5c2f08313ef8825f1127a8035`
  passed both concurrent calls with an actual observed wait and no deadlock.
  The two repository PG lock-order cases then passed,0 skipped; owned cluster
  shutdown and cleanup succeeded. Their native responses are transport fixtures,
  so this is database/concurrency proof, not the paired native write chain.
- Actual native HTTP accepted Unicode connection/part/line identifiers and
  separately140-character part/line identifiers. Original consumer validation
  refused them; repaired wire hash
  `d350c15c088b68e69c362f684728c909516f00df9c4f571560f3aeb49b806d8f`
  independently accepts the captured successful native response and constructs
  the correctly percent-encoded PATCH path. A reserved-character hypothesis was
  refuted by native401; reserved delimiters remain rejected.

These are checkpoints of uncommitted foundation files, not completion of PR6425.
Durable retired-grant restart/revoke behavior, JWT-verified MetaSheet tenant
admission, persisted frozen intents, route/UI integration, CI execution without
skip substitution, and the actual two-process personal line/ECO chain remain
pending. Historical approval-guard green CI cannot stand in for those checks.


Durable-revoke review found two additional reproducible gaps on candidate service
hash9b8522ea, using actual PostgreSQL/migration/service/adapter and a synthetic
native transport: (1) A→B with uncertain A revoke, then A rebind, lets cleanup
revoke the now-current A; (2) a429 response clears the retired ciphertext as
terminal rejection, so a restart cannot retry the still-valid old credential.
Both original red controls preserve source hashes and owned-cluster cleanup.
The A→B→A control passes on stable service hash
`372f6134b28962457843f5296cb0f8dea3b0218416c0f54e6c1cdf93645ae64a`:
rebind is refused409, B stays bound and is not revoked, and A's durable cleanup
remains possible. Recoverable-response retry repair and final source validation
are still pending; these intermediate hashes are not the eventual committed head.


### Verified foundation follow-up

Final foundation source fingerprints and limits are recorded in
`plm-personal-bom-foundation-verification-20261017.json`. Grok finished and
released its write lock; Codex independently reviewed the new service/wire and
adapter diff, repaired the CI admission wiring and registered the independent
exact-literal flag. Backend `tsc --noEmit` and workflow actionlint both pass.
Two complete unit files: **42 passed in2.43s**. Flag registry: **50 passed in2.099s**.
The complete PostgreSQL lock/restart file: **6 passed,0 skipped in1.20s**,
wrapper1.68s, PostgreSQL15, stable source fingerprints, shutdown/cleanup confirmed.
Its later429→204 restart now retains the encrypted retired secret until successful
revoke, then clears the ciphertext. Independent actual-PG429 control also passes.

The dedicated workflow supplies only its disposable PostgreSQL service URL;
there is no implicit production/default database fallback. Missing explicit URL
or execution gate makes the actual CLI fail before collection. CI parses its
JUnit report and refuses zero tests, any failure/error or skipped test. The
non-default `.realdb.ts` suffix avoids a misleading skipped unit-lane pass.
Local testing used owned socket-only PostgreSQL, not a shared database.

Reproduce against a disposable loopback PostgreSQL database named
`plm_personal_disposable`, from `packages/core-backend`:

```sh
EXPECT_PLM_PERSONAL_BOM_WRITE_DB=1 PLM_PERSONAL_BOM_WRITE_TEST_PG_URL='<disposable-url>' node ../../node_modules/vitest/vitest.mjs run --config vitest.plm-personal-bom-write-lock.config.ts
node ../../node_modules/vitest/vitest.mjs run tests/unit/plm-personal-bom-write-binding.test.ts tests/unit/plm-personal-bom-write-transport.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit
```

The native provider remains authoritative. This foundation does not yet replace
the existing workbench line/ECO routes: trusted MetaSheet request tenant and
membership admission, durable frozen intents (including preconditions), actual
personal dispatch, binding/settings UI and paired native positive/retry/permission
proof remain required next work. Remote CI of this candidate is pending.

Foundation commit `037f161216ee7843a30c0e71a56ff00a566515a3` was checked live
on 2026-10-17 at05:53UTC: **49 checks successful**, PR #6425 remains Draft.
This applies to the foundation commit only. The following trusted actor/membership
admission edits are uncommitted and require independent local and exact-head CI
verification. The read-only Astra ultra dispatch design review performed no
executions and is not test evidence for a personal write chain.


### Independently verified actor admission increment

Grok 4.7 (xhigh) implemented the bounded service/type/test slice and then fixed
the independently identified missing/blank-context collapse. Codex reviewed the
diff and independently ran both complete unit files: **50 passed in2.59s**;
backend `tsc --noEmit` exited0. The complete owned PostgreSQL15 file ran
**7 passed,0 skipped in1.34s**, wrapper1.61s, stable source fingerprints and
confirmed shutdown/cleanup. This includes a real `pg_blocking_pids` barrier:
membership deactivation waits while native verification is held, then completes;
the next use is denied403 without another provider call, preserving ciphertext.
Both source/binding lock orders and all existing retired-grant restart controls
also pass. PostgreSQL uses a controlled native-wire fixture, not a paired live
Yuantus service. Exact fingerprints and limits are in
`plm-personal-bom-actor-verification-20261017.json`.

Unit negatives cover wrong Meta tenant, revoked/missing membership, source-scope
changes and five malformed context forms on every admitted entry, with no native
verification call. Explicit null-private and different Meta/native tenant
positives remain functional. No new flags, migrations or production defaults
changed. The service is verified; actual route/JWT carrier integration and the
full personal line/ECO dispatch/restart chain remain pending. New remote CI must
verify the actor commit; foundation037's49 green checks do not cover these edits.

Actor source `a410cfe929f22790fd328f0f26d6ec42f98b4cf1` completed **49 successful checks across 46 workflows**
on 2026-10-17 at06:25UTC. [Personal verification run](https://github.com/zensgit/metasheet2/actions/runs/39009409287)
checked out automatic merge `0fa8fe01f4d212e3013e880eb6ed0f7c4faa3f64` into base `a5977db1`.
That run passed backend173/12files, web54/5files, personal approval real-DB16,
and personal BOM real-PG7/0skip; backend and web typechecks succeeded.
The compact exact-SHA record is `plm-personal-bom-actor-ci-20261017.json`.
The next intent implementation is uncommitted and cannot inherit this green.

### Durable personal BOM dispatch intent (2026-10-17)

Grok 4.7 (xhigh) implemented the bounded slice. Astra ultra independently read
the two-phase design and found a concrete acknowledgement-validation defect:
a shape-valid reply could name another line or contradict an earlier stored
confirmation. The repaired path compares the frozen line and canonical prior
confirmation before accepting. A mismatch returns503, records unknown and
preserves any earlier confirmation; it does not claim the native write failed.
Codex independently reviewed the repair and executed:

- Three complete unit files: **81 passed in2.52s**.
- Both complete real PostgreSQL15 files: **22 passed,0 skipped in2.93s**,
  wrapper3.22s. All11 source fingerprints stayed stable. Owned cluster shutdown
  and removal succeeded. The provider is an actual adapter with a controlled
  fetch fixture; this is not a paired live native-service acceptance test.
- Backend `tsc --noEmit`, workflow `actionlint` and diff checks passed.
- The actual workflow JUnit checker accepted the22-test report and rejected
  missing-intent-suite, zero-intent-tests and skipped-test counterexamples.

Real PostgreSQL tests observe `pg_blocking_pids` while phase2 holds the provider
request: source transfer, user deactivation, membership revocation and actual
service unbind wait; after release, the accepted write completes first and the
next dispatch is denied without another write. Same-person rotation waits, then
replays the stored key with the replacement grant. Phase1 and phase2 wrappers
execute the real server COMMIT before throwing an acknowledgement-loss error:
phase1 leaves a durable intent with zero immediate writes; phase2 leaves the
accepted confirmation. New service instances retain the intent/key and call
native authorization again. ECO dispatch has no body/If-Match and retains its
key/confirmation after a committed-but-unacknowledged outcome.

The real additive migration drops an empty intent table, refuses populated
unconfirmed evidence, and refuses an active writer with PostgreSQL55P03 NOWAIT,
without losing rows. Earlier rollback-before-COMMIT testing is retained and is
reported separately from actual COMMIT acknowledgement loss. Ordinary empty,
long and `assembly_yuw_component` JSON text remains valid; header limits do not
apply to BOM text. Only allowed body fields are copied, raw client keys become
SHA256, and binding credentials remain encrypted. There is no SQL bearer-pattern
constraint or general secret detector; the unit fake's credential assertion is
not such a database guarantee.

Compact source fingerprints and evidence limits:
`plm-personal-bom-intent-verification-20261017.json`. Source parent is
`a410cfe929f22790fd328f0f26d6ec42f98b4cf1`; the pending source commit must obtain
its own CI. The actor source's49 green checks do not validate it. Actual
workbench routes/JWT carrier, management UI, durable browser retry keys and the
paired live line/ECO/revocation chain remain required next work. No shared-account
mutation route has been claimed repaired by this service-only increment.

Intent source `14b8b222c4ab75b41843779b9ae70c29700b3a09` was checked live at07:41UTC:
**49 checks successful across46 workflows**, Draft retained. The [personal
verification run](https://github.com/zensgit/metasheet2/actions/runs/39013933001)
checked out merge `26cce14b542734e2ea33f6de702ff5f5216dd701` into base
`a5977db1c2afb0106d87e60fe066cd4a3427dc4c`. Actual CI PostgreSQL16: backend
204/13files15.77s, web54/5files5.49s, approval real-DB16/0skip13.33s,
and both BOM real-PG files22/0skip5.73s. Backend/web types and both JUnit
execution guards passed. Counts overlap earlier local testing and are not
summed. Compact source/run/merge evidence is
`plm-personal-bom-intent-ci-20261017.json`. This CI record will accompany the next
source slice; later commits must obtain their own checks. It does not complete
route/UI or paired-service acceptance.

### 2026-10-17 personal BOM HTTP integration candidate

Candidate after base `14b8b222c4ab75b41843779b9ae70c29700b3a09`: both line PATCH and ECO intent use durable personal dispatch, caller keys, verified Meta tenant provenance and mandatory attempt audit. Legacy shared-account mutation methods refuse every mode. Owner binding management retains independent native person/tenant/org authority and permits cleanup after feature or membership disablement.

Independent main verification: **394 passed / 22 complete unit files / 0 skips, 6.71s**, executing the current expanded personal CI unit command. This includes the targeted 271-test/12-file set. **22 real PostgreSQL 15 tests / 0 skips, 3.75s**, 14 stable source fingerprints and owned-cluster shutdown/cleanup; both backend TypeScript projects pass. Counts overlap and are not additive.

The actual paired runtime exposed two integration gaps that fixtures had hidden. Canonical persisted source config omits type; reconstruction now uses the authoritative source column, with object/JSON red→green controls and a non-PLM-column denial. A revoked native grant returns 401, so the refused-attempt/may-have-applied/same-operation envelope now covers both native 401 and 403. Six added controls failed before that extension and passed afterward. Earlier broad HTTP review and unit totals are preserved as historical evidence, not substituted for this runtime check.

The packaged verifier at `scripts/verification/plm-personal-bom-paired/README.md` ran separate native TLS/HTTP and Meta HTTP processes with real PostgreSQL and native identity/RBAC/tenant stores. Three distinct Meta PIDs restart after lost line and ECO responses. Both native mutations committed before their responses were dropped; retries under revoked grants returned 401, then same-person replacement grants recovered the original frozen keys with 200. It verified wrong Meta tenant, non-owner admin, changed payload and post-unbind refusal; two accepted Meta intents; 18 attempt/outcome audit rows in the latest three-process run; quantity 8; one ECO, one personal ECO receipt and one native domain audit with Auth42/RBAC900. Every native mutation used `yuw_`; all three issued grants were revoked and binding secrets cleared. Unknown CA was rejected. All owned children, databases, proxy, CA/key and temporary root were stopped/removed. The personal provider adapter had a deliberately stale origin, wrong native tenant/org and an unusable shared header; only the explicit persisted source authority made the real requests succeed. Latest runtime: 2.82s excluding initial cluster/native setup. The native line audit also contains exactly one applied Auth42/default/fixture-org row, part/line provenance and quantity 1→8 despite retries. Its unique native scoped key is distinct from the raw provider header key by design.

Compact records: `plm-personal-bom-http-boundary-verification-20261017.json` and `plm-personal-bom-paired-http-verification-20261017.json`, including source and verifier fingerprints. The native source is local candidate `1f2e36ceaf29536a82f6d6a35f69b22b913be0e4`; the Meta source is an explicitly uncommitted candidate, not remote14b.

Limits: this uses actual signed trusted-claims JWTs plus live service membership checks, actual route assembly and the official native tenant metadata builder. It does not prove whole index lifecycle, default Alembic chain, forced kill before local outcome persistence, installation/upgrade or production/customer acceptance. Browser recovery has separate component-chain evidence below; complete product entry and installation are still unproven. All PRs remain Draft; no merge, deployment or production enablement.

Current HTTP-boundary WIP also passed the whole personal approval PostgreSQL suite: **16 passed, zero skipped, 7.75s**, on an owned socket-only PostgreSQL 15 cluster. The recorded backend fingerprints stayed stable; the cluster stopped and its owned directory was removed. This checks the existing approval path alongside the new BOM boundary; it is not new-head remote PostgreSQL 16 CI or complete product acceptance. Compact evidence: `plm-personal-bom-http-boundary-verification-20261017.json`.

Current Auth compatibility was also exercised through the existing real frontend `main.ts` entry rehearsal (`tests/e2e/plm-personal-approval-entry-browser.mts`): **18 assertions passed in 8.622s**, ordinary signed JWT with trusted-claims mode disabled, real owned PostgreSQL 15, actual Auth/approval routes, Vite and Chromium. Settings/open/refresh, real own binding metadata and source management link, revoked card, invalid HMAC, foreign recipient and anonymous login behavior all passed; no approval command or native grant write was sent. The main reviewer inspected the binding and revoked-card screenshots. Thirteen relevant source fingerprints remained stable; HTTP, browser, Vite, pools, owned PostgreSQL and both private temporary directories cleaned up. Compact proof: `plm-personal-approval-entry-current-verification-20261017.json`. This does not test native grant issuance, real DingTalk delivery, the new BOM UI, full backend `index.ts` lifecycle or the unified Yuantus upgrade installation.


The first independent complete web command passed **137 tests in all 10 current CI files, 2.64s**, and web application types passed. The full-identity pending-display and exact pinned-scope retry fix also passed the actual helper counterexample: scope A and explicit scope B remain stored, while pinned B resolves B rather than being blocked by A. The UI suite checks that foreign scope operation/line identifiers are not displayed. A further exact business-cell preservation counterexample was then found in the pending helper (empty/long/JSON-like text rejected, whitespace silently trimmed); its focused repair is still pending, so these results are a pre-repair snapshot and must not be presented as final source acceptance.

The actual Chromium/Vue BOM component chain passed in **4.50s** against stable executed web/backend/native fingerprints. It binds an explicitly registered native personal grant; commits line quantity 8 with a lost response; reloads without automatic resend; replays the original key/body/If-Match despite edited quantity 9; submits a separate quantity 10 edit with a refreshed ETag; and recovers ECO intent after a lost response and reload. With creation/write capability disabled, metadata remains available and the real UI unbind succeeds. Native SQL shows exactly two applied line audits (1→8, 8→10), one ECO, one ECO receipt and one domain audit, Auth42/RBAC900 and no tenant authority-table copies. Both response losses are real owned TLS-proxy disconnects; HTTP replies are not browser fixtures. One issued grant is revoked; pending storage contains neither grant nor login JWT; all owned browser/Vite/HTTP/native/PostgreSQL/private resources clean up. This is assembled actual BOM components and HTTP routes, not full backend index or the unified Yuantus managed upgrade entry. The browser lane will be rerun after the last helper repair.


Final local source verification after that last helper repair: **138 passed / all 10 CI web files / zero skipped, 2.54s**, and web application types exit 0. The independent actual-helper red→green control now preserves all five exact business-cell examples (empty, surrounding whitespace, 501 characters, ordinary `yuw_` text and JSON-like text); invalid NUL/unpaired-surrogate cells and non-finite quantities have focused regressions. Metadata and operation-key validation remain separate. The real Chromium/native chain was rerun against the repaired helper: **4.29s**, stable source fingerprints and complete owned cleanup, with the same real line/ECO response-loss, frozen replay, fresh ETag and disabled-feature unbind checks. Compact browser/source/harness evidence is `plm-personal-bom-browser-verification-20261017.json`. The candidate is ready for its own source CI; this record does not claim the old14b checks validate the new source.
