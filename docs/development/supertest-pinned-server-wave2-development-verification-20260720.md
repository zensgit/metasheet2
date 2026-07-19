# Supertest pinned-server wave 2: development and verification

Date: 2026-07-20

## 1. Objective

This slice continues the drain-only migration established by #4454 and #4462. It removes `request(app)` from 12 additional core-backend unit suites so each file uses one pinned HTTP listener and swaps only the Express request listener under test.

The change is test infrastructure only. It does not change production routes, permissions, payload contracts, retry policy, CI configuration, or the shared pinned-server helper.

## 2. Selection and design audit

Kimi K3 audited all 35 files in the pre-slice baseline and classified them before implementation:

- 23 direct migrations;
- 12 bounded local-adapter migrations;
- 0 deferrals requiring a production or helper change.

Wave 2 selects the highest-yield 12 files, covering 220 of the 356 remaining app-mode call sites:

| File | Drained sites |
| --- | ---: |
| `approval-metrics-router.test.ts` | 13 |
| `approvals-bridge-routes.test.ts` | 32 |
| `approvals-routes.test.ts` | 12 |
| `automation-runs-api.test.ts` | 30 |
| `data-source-readonly.test.ts` | 20 |
| `data-source-result-boundary.test.ts` | 13 |
| `data-source-scope.test.ts` | 16 |
| `federation.contract.test.ts` | 20 |
| `multitable-formula-reference-guard.test.ts` | 12 |
| `multitable-hierarchy-parent-link-guard.test.ts` | 19 |
| `multitable-template-dryrun-routes.test.ts` | 14 |
| `plm-embed-discussion-read-routes.test.ts` | 19 |

No selected file contains concurrent tests, independently managed listeners, WebSocket assertions, or simultaneously live different apps. Files that build multiple apps preserve their original construction points and call `pinned.setApp(app)` immediately before the corresponding request group.

## 3. Implementation

Each migrated file calls `usePinnedServer()` once. Existing `request(app)` calls become `request(pinned.url())`; suites with per-test apps install the matching app in `beforeEach`, in the local app builder, or immediately before the request. The original request order, request bodies, assertions, mocks, and app-construction semantics remain unchanged.

The drain-only baseline changes from 35 files / 356 sites to 23 files / 136 sites. `retry: 2` remains in place until the baseline reaches zero and the full lane has sustained retry-free evidence.

## 4. Model roles

- Kimi K3: read-only cross-module classification, concurrency and lifecycle risk audit, and slice selection.
- Grok Build: mechanical implementation and first-pass targeted/full-lane test execution in an isolated worktree.
- Codex: exact-diff review, app-selection and lifecycle audit, independent test execution, fail-first mutation, documentation, and PR ownership.

Agent output is supporting evidence only. The acceptance results below are from the final worktree and were independently rerun by Codex.

## 5. Verification

### 5.1 Static and baseline checks

- `git diff --check`: pass.
- Changed runtime/helper/CI files: none.
- Final baseline: 23 files / 136 sites.
- App-mode tripwire: 2/2 pass.

### 5.2 Targeted behavior

The 12 migrated specs pass together: 12/12 files, 199/199 tests. Per-suite tests and business assertions were not removed or weakened.

### 5.3 Full unit lane

`CI=1 pnpm --filter @metasheet/core-backend test:unit -- --retry=0`

Result: 419/419 files and 5795/5795 tests pass.

### 5.4 Load-bearing negative control

One migrated request in `approvals-routes.test.ts` was temporarily reverted from `request(pinned.url())` to `request(app)`. The drain-only tripwire failed with the exact new app-mode-site finding for that file. Restoring the URL-mode request returned the tripwire to 2/2 green.

This proves the reduced baseline does not merely hide migrated sites: a regression in a drained file is rejected.

## 6. Honest boundary and next slice

This slice proves transport migration and retry-free unit behavior on the current host. It does not by itself prove that the historical full-lane flake rate is zero across repeated CI runs. The remaining 23 files / 136 sites stay frozen by the drain-only baseline and should be completed in one or more similarly reviewed waves. Only after the baseline reaches zero should removal of `retry: 2` be proposed with repeated CI evidence.
