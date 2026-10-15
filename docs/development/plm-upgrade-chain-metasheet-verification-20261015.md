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
| Disabled binding (`9daedd2`) | New real-DB test, filtered run, 1 failed / 131 skipped (132): listener still `active`. With that assertion temporarily removed it failed again: `expected { created: 2 } to deeply equal { created: 0 }` (two escalations created after disable). | Full BOM review real-DB suite 132/0/0 (handoff baseline 131/0/0). Listener workflow unit list 10 files, 111/111. Structural guards (W1-3, fence recheck, rich text sink, OAPI tripwire, sheet liveness): 165 passed. |
| Tripwire (`7994071`) | Handoff: 1 failed / 2 passed (3) | 3/3; route spec 9/9 |
| Bridge refusal (`0ac8b5f`) | With only `ApprovalBridgeService.ts` reverted: `expected 409 "Conflict", got 200 "OK"`, 1 failed / 30 passed (31) | 31/31; repeated 10× plus 3× combined with `federation.contract` and `plm-adapter-yuantus` (96/96). One earlier combined run during a concurrent full-suite load reported 1 failure that did not reproduce in those 13 reruns. |
| Flag registration (`f46c317`) | Negative control (manifest entry removed): 2 failed / 48 passed (50), namely completeness and the reader test | `global-history-flag-manifest` 50/50 (handoff 49/49); `multitable-global-history-flag-status` 21/21 |
| Vitest exclusion (`18922e0`) | Handoff default config: `Error: DATABASE_URL required` | Branch default config: "No test files found". The dedicated config still loads the file and enforces `DATABASE_URL`. |

Other real-DB suites on the branch (class C, fresh database each): personal approval 16/0/0, record ingress 25/0/0, Visual source authority 14/0/0. Backend `tsc --noEmit` passes. No web source changed.

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

**Done.** Remote-head verification. Exact-SHA CI read for all five PRs, including earlier failures and not-run checks. Inventory with evidence. Five code fixes and one test-config fix, each with red-then-green. Local real-DB lanes for all four PLM suites. Full-suite comparison at merge base, handoff and branch. Design and verification documents.

**Not done.**
- Whole-BOM completion producer.
- Write-back identity and audit, and a multitable write-back path.
- Census and guard dispositions for #6418, #6423 and #6424.
- The `outbound-sql-write-gate` test double.
- MetaSheet-tenant scoping of personal bindings.
- SSO, Discussion visibility, revocation propagation, DP1, Stage A, RG source binding, version roadmap.
- Reading the Yuantus scope documents (not accessible from here).

**Pending real environment (owner-approved only).**
- Paired Yuantus server with real accounts in a read-only window.
- Real DingTalk delivery.
- Embed edge CSP and TLS.
- Full migration chain and server lifecycle with these commits.
- Customer acceptance.

## Reproduction

From `packages/core-backend`, with `<db-url>` a disposable PostgreSQL database URL:

```sh
pnpm install --frozen-lockfile
node node_modules/vitest/vitest.mjs run tests/unit/plm-embed-routes.test.ts tests/unit/plm-embed-visual-preview-routes.test.ts tests/unit/approvals-bridge-routes.test.ts tests/unit/plm-personal-approval-routes.test.ts tests/unit/supertest-app-mode-tripwire.test.ts
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
- Until gap 2 in the design is closed, the workbench write-back may write as a shared integration account.
- Whole-BOM completion can be configured but never fires.
- The local runtime is Node 22, not CI's Node 20. Exact-head CI for #6425 is the authority for CI claims and is tracked in the PR body.
