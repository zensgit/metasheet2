# ERP/PLM Integration Closeout Plan - 2026-05-07

## Current State

This plan covers the PLM -> MetaSheet cleanse/staging -> K3 WISE ERP path.

Latest merged base:

- `e2e87b020` `fix(integration): include runtime metadata in ping (#1411)`
- `02cee5686` `fix(integration): refresh runtime status metadata (#1408)`
- `8d3e5df1f` `feat(integration): expose dead-letter communication api (#1407)`

Immediate closeout already executed:

- #1408 merged and branch/worktree cleaned.
- #1411 rebased onto latest `origin/main`, revalidated, force-pushed, CI rerun,
  and merged.

Open integration/K3 queue after #1411:

- 57 integration/K3/ERP/PLM PRs remain open.
- Current failed checks: 0.
- Current pending checks: 0.
- Most PRs show `REVIEW_REQUIRED`; some show blank `reviewDecision`.
- Many PRs show `UNKNOWN` mergeability because GitHub recalculates lazily after
  main moved. Treat them as "refresh before merge", not as conflict evidence.

## Closeout Principle

Stop opening new feature slices until the existing ERP/PLM/K3 PR queue is
closed or explicitly deferred. The queue is already large enough; adding more
implementation before merge consolidation increases conflict and audit cost.

## Done Definition

The ERP/PLM integration closeout is done when all four gates pass:

1. Merge queue closed or explicitly deferred.
2. Main deploy contains the K3 WISE control plane and authenticated postdeploy
   smoke passes.
3. Customer GATE packet can be preflighted without code changes.
4. Test-account live PoC produces PASS evidence or a documented customer-side
   blocker.

Production use is not part of this closeout. Production needs a separate
hardening decision after test-account live PoC.

## Phase 0 - Queue Discipline

Rules:

- No new ERP/PLM/K3 feature PRs unless they fix a failing merge gate.
- One merge batch at a time.
- After every batch, refresh `origin/main` and run the listed verification.
- Do not admin-merge large UI/feature PRs unless explicitly approved for that
  PR. Admin override is acceptable only for small guard/test/docs PRs with fresh
  green CI.
- Do not merge stale-base PRs without `gh pr update-branch` or rebase plus
  fresh CI.

Implementation already done:

- #1411 was updated to the latest main and merged after fresh green CI.

## Phase 1 - Merge Batch A: Evidence And Report Safety

Goal: close the customer-facing evidence/report safety layer first. These PRs
reduce risk when operators paste customer data into reports.

PRs:

- #1405 `fix(integration): expose staging validation details`
- #1404 `fix(integration): parse bracketed K3 mock SQL tables`
- #1403 `fix(integration): redact K3 mock request logs`
- #1402 `fix(integration): escape K3 live PoC markdown reports`
- #1401 `fix(integration): escape K3 smoke markdown evidence`
- #1400 `fix(integration): escape K3 summary markdown values`

Execution:

1. Refresh each branch against current main.
2. Wait for CI green.
3. Merge in descending PR order only if still small and green.
4. After the batch, run:

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Exit criteria:

- No evidence/report PR remains open from #1400-#1405.
- Offline PoC and report tests pass on main.

## Phase 2 - Merge Batch B: Runtime Safety Guards

Goal: close the guardrail layer that protects live runs, replay, config updates,
payload persistence, and connector edges.

PRs:

- #1399 `fix(integration): preserve project scope on connection tests`
- #1398 `fix(integration): include all idempotency key fields`
- #1397 `fix(integration): guard missing pipeline runner context`
- #1392 `fix(integration): persist disabled K3 SQL channel`
- #1391 `fix(plm): block import route when disabled`
- #1390 `fix(integration): guard dead-letter replay marks`
- #1389 `fix(integration): reject malformed db read filters`
- #1388 `fix(integration): preserve external system update defaults`
- #1387 `fix(integration): tighten PLM input normalization`
- #1386 `fix(integration): guard HTTP adapter relative paths`
- #1385 `fix(integration): preserve HTTP adapter pagination guards`
- #1383 `fix(integration): guard runner target write counters`
- #1381 `fix(integration): redact test connection results`
- #1382 `fix(integration): reject secret-bearing K3 PoC text`
- #1380 `fix(integration): split K3 SQL table allowlists`
- #1378 `fix(integration): validate adapter upsert counters`
- #1377 `fix(integration): redact session payload keys`
- #1376 `fix(integration): validate watermark values before persistence`
- #1374 `fix(integration): coerce ERP feedback boolean options`
- #1373 `fix(integration): reject unsafe K3 WebAPI relative paths`
- #1367 `fix(integration): redact external system public config`
- #1364 `fix(integration): validate K3 GATE middle-table writes`
- #1363 `fix(integration): redact run error summaries`
- #1361 `fix(integration): redact REST error details`

Execution:

1. Split by file overlap before merging. Do not merge two PRs that touch the same
   high-risk file without inspecting the second diff after the first lands.
2. Prefer these sub-batches:
   - adapter/config safety
   - runner/dead-letter/idempotency safety
   - redaction/error-surface safety
3. After each sub-batch, run:

```bash
pnpm -F plugin-integration-core test
pnpm validate:plugins
git diff --check
```

Exit criteria:

- Runtime guard PRs are merged or explicitly deferred with reason.
- `plugin-integration-core` full test suite passes on main.

## Phase 3 - Merge Batch C: Deploy And Postdeploy Gates

Goal: make deploy/test-account readiness explicit before touching a customer
system.

PRs:

- #1396 `test(integration): cover PLM K3 route control chain`
- #1395 `test(integration): add K3 postdeploy smoke input gate`
- #1394 `feat(integration): show K3 deploy readiness checklist`
- #1393 `test(integration): add ERP PLM deploy readiness gate`
- #1372 `fix(integration): guard K3 smoke token env exports`
- #1370 `fix(integration): reject secret-bearing K3 smoke base URLs`
- #1369 `fix(integration): cap K3 live PoC sample limits`
- #1360 `fix(ops): accept K3 tenant auto-discovery in runtime readiness`
- #1355 `feat(integration): add K3 WISE delivery readiness gate`
- #1331 `fix(integration): gate K3 smoke signoff on operator permissions`
- #1330 `fix(integration): write K3 smoke evidence for token file failures`
- #1327 `fix(integration): use temp key for K3 smoke token resolver`
- #1324 `test(integration): add K3 WISE signoff evidence gate`

Execution:

1. Merge test/ops gates before frontend readiness UI.
2. Treat #1394 as feature UI: require explicit review or owner approval before
   admin merge.
3. After the batch, run:

```bash
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Exit criteria:

- Authenticated postdeploy smoke is available and documented.
- Deploy-readiness UI either lands or is deferred until after backend gates.

## Phase 4 - Merge Batch D: Live PoC Contract Hardening

Goal: close the remaining preflight/evidence/K3 contract hardening before
customer GATE comes back.

PRs:

- #1358 `fix(integration): harden K3 WISE BOM PoC contract`
- #1352 `fix(integration): require K3 WebAPI auth transport`
- #1348 `fix(integration): block stale K3 setup connection tests`
- #1345 `fix(integration): guard K3 summary auth signoff`
- #1344 `fix(integration): hydrate saved K3 setup booleans`
- #1342 `fix(integration): preserve K3 postdeploy token failure evidence`
- #1338 `fix(integration): require K3 ERP feedback evidence`
- #1337 `fix(integration): reject secret-bearing K3 preflight URLs`
- #1335 `test(integration): align K3 SQL mock with channel contract`
- #1332 `fix(integration): harden K3 live evidence decisions`
- #1326 `fix(integration): block inconsistent K3 signoff summaries`
- #1320 `test(integration): guard K3 live PoC evidence fixtures`
- #1316 `fix(integration): clarify disabled SQL preflight mode`

Execution:

1. Merge fixture/test guard PRs first.
2. Merge auth/signoff/evidence guards next.
3. Merge BOM/K3 auth transport guards last because they are closer to business
   behavior.
4. After the batch, run:

```bash
pnpm run verify:integration-k3wise:poc
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
```

Exit criteria:

- Offline PoC gate passes on main.
- Live PoC contract has no known unmerged safety PR.

## Phase 5 - UI And Customer GATE Workbench

Goal: decide whether the operator can enter GATE data in the frontend before
live testing.

PR:

- #1305 `feat(integration): add K3 WISE GATE readiness UI`

Decision:

- If the live customer reply is imminent, do not block on UI. Use the existing
  JSON preflight path first.
- If the customer reply is still days away, review #1305 after backend and ops
  gates land.
- UI must not store secrets in plain text. Credentials still go through external
  system credential storage.

Exit criteria:

- Either #1305 lands after review, or the closeout explicitly records "CLI/JSON
  first, UI after PoC".

## Deployment Test Gate

You can deploy to an internal/entity-machine test environment after Phases 1-3
land, even before customer GATE returns, as long as this is only control-plane
testing:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke

node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

Pass criteria:

- `ok=true`
- `authenticated=true`
- `signoff.internalTrial=pass`
- `summary.fail=0`
- control-plane list probes pass:
  - external systems
  - pipelines
  - runs
  - dead letters

This verifies the deployed MetaSheet runtime. It does not contact customer PLM,
K3 WISE, or SQL Server.

## Customer GATE Gate

Live customer testing cannot start until the GATE answer packet is complete:

- K3 WISE version and patch number.
- K3 WebAPI/K3API URL and network path.
- test account set / test tenant opened.
- material and BOM field-code list.
- Save-only vs Submit/Audit decision.
- SQL Server permission scope.
- middle database / middle table availability.
- PLM source access and BOM product scope.

When the packet arrives:

1. Run preflight.
2. Run mock PoC demo.
3. Create PLM/K3/optional SQL external systems.
4. Run connection tests.
5. Run material dry-run.
6. Run material Save-only live test.
7. Run BOM Save-only live test.
8. Compile evidence.

Do not enable production writes in this phase.

## Merge Commands

Use this pattern per PR:

```bash
gh pr view <number> --repo zensgit/metasheet2 --json mergeable,reviewDecision,statusCheckRollup
gh pr update-branch <number> --repo zensgit/metasheet2
# wait for fresh CI
gh pr merge <number> --repo zensgit/metasheet2 --squash --delete-branch
```

If branch protection blocks a small green guard/test/docs PR and owner approval
is unavailable, admin squash may be used only after explicitly confirming:

- no failed checks
- no pending checks
- `mergeable=MERGEABLE`
- diff is small or safety-only
- no known file overlap with a just-merged PR

## Stop Conditions

Stop and ask before continuing if any of these happen:

- any required CI check fails
- a PR becomes `CONFLICTING`
- a feature/UI PR requires product review
- a PR touches credentials, auth, or K3 write behavior in a way not covered by
  tests
- customer GATE contradicts the current K3 WISE assumptions

## Expected Remaining Work

With current evidence, this is mostly queue closeout and environment validation,
not new platform development:

- Merge consolidation: 1-2 engineering days if done carefully in batches.
- Internal/entity-machine deployment smoke: 0.5 day after the deploy environment
  is ready.
- Customer test-account live PoC: 1-3 days after GATE packet and network access.
- Production hardening: separate decision; likely 1-2 weeks depending on K3
  approval flow, BOM complexity, SQL Server policy, and rollback SOP.
