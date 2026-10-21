# Approval Handler Insert Menu Verification Report - 2026-09-05

**Status:** DRAFT / HOLD evidence. This is not a release, UAT, deployment, production, or product-FINAL declaration.

## Exact evidence boundary

- PR: #5473
- exact tested code head: `3bc9c4ae218bfbdbccfaf4ffa70a3d36dd6e633b`
- base/main parent: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`
- tree: `881c0abb11e4d4e9af96b6a591aa84760de5bdf1`
- relative-main files: `ApprovalFlowCanvas.vue` and `approval-flow-canvas-a11y.test.ts` only
- candidate blobs: unchanged from the prior green head (`af5d4c4c...` and `d2e6f8de...` respectively)
- report-only child: not represented as tested by this code-head matrix

## Exact-head local gates

| Gate | Result | Evidence boundary |
|---|---:|---|
| Focused Canvas plus neighbor Vitest | 57/57 pass | 53 tests in `approval-flow-canvas-a11y.test.ts`; 4 in `approval-flow-canvas-summary-tooltip.spec.ts` |
| Approval Chromium collection | 36 tests in 5 files | Dynamic `--list` against `playwright.approval-verification.config.ts` |
| Full approval Chromium | 36/36 pass | Real Chromium; no browser test skipped |
| Approval browser wiring contract | 3/3 pass | Workflow context, disjoint/exhaustive spec ownership, and verification tsconfig census |
| Verification approval typecheck | pass | `type-check:verification-approval` |
| Targeted ESLint | pass | Both candidate-owned files |
| Required-web aggregate | 501 files / 6796 tests pass | Sum across all script invocations after retaining the main-side stock-preparation spec |
| Required-web final broad invocation | 422 files / 5461 tests pass | This is one invocation inside the aggregate above, not a competing total |
| Patch hygiene | pass | `git diff --check`; worktree clean after ordinary push |

The required-web aggregate increased by exactly one file and four tests from the prior `500 / 6792` evidence because main added `StockPreparationUnconfirmableHold.spec.ts`; the final broad invocation correspondingly moved from `421 / 5457` to `422 / 5461`.

## Structural and mutation evidence

The structural test requires all of the following together: the handler test id, the business-language handler label, the existing `Tickets` icon, the handler background token, and source order `CC < Handler < Condition`.

A discriminating mutation removed only the handler background rule. The exact target test failed while the remaining 52 tests in that file stayed green; restoring the rule returned the file to 53/53. That mutation ran on the original content commit. The two later mechanical main replays did not rerun the mutation, but blob equality proves the production and test files at `3bc9c4ae...` are byte-identical to the mutated-and-restored content.

## Current-main preservation evidence

- the replay had zero conflicts and no manual product resolution;
- relative to the second parent, exactly the two approval files change;
- both approval blobs and the stable candidate patch are unchanged from the earlier green candidate;
- the four main-side stock-preparation product/test/required-web files remain present as an automatic union;
- the new required-web selector token was exercised by the `501 / 6796` run.

## Exact-head remote CI

GitHub reported the following terminal matrix for exact code head `3bc9c4ae218bfbdbccfaf4ffa70a3d36dd6e633b`: 21 SUCCESS, one intentional SKIPPED context, zero failure, and zero pending.

| Workflow | Context | Outcome | Job |
|---|---|---:|---|
| Approval Browser Verify | Approval browser verify (chromium) | SUCCESS | `101241907235` |
| Plugin System Tests | DingTalk P4 ops regression gate | SUCCESS | `101241907601` |
| Plugin System Tests | K3 WISE offline PoC | SUCCESS | `101241907644` |
| Plugin System Tests | after-sales integration | SUCCESS | `101241907600` |
| Approval Web Guard | approval-web-guard | SUCCESS | `101241907203` |
| Attendance Web Guard | attendance-web-guard | SUCCESS | `101241907075` |
| Attendance Gate Contract Matrix | contracts (dashboard) | SUCCESS | `101241907387` |
| Attendance Gate Contract Matrix | contracts (openapi) | SUCCESS | `101241907394` |
| Attendance Gate Contract Matrix | contracts (strict) | SUCCESS | `101241907402` |
| Plugin System Tests | coverage | SUCCESS | `101245839021` |
| Observability E2E | e2e | SUCCESS | `101241907074` |
| Integration Guard | integration-guard | SUCCESS | `101241907167` |
| Multitable O2 Observation Kit | observation-kit contract (read-only SQL census + runbook gating) | SUCCESS | `101241906986` |
| Phase 5 PR Validation (External Metrics Gate) | pr-validate | SUCCESS | `101241907299` |
| Multitable recovery-schema drift (A-vs-B) | recovery-schema-drift | SUCCESS | `101241907094` |
| Approval S1 Evidence Replay Gate | s1-evidence replay gate contract (static census - no DB, no secrets) | SUCCESS | `101241907113` |
| SSH Host-Key Pin Contract | ssh host-key pin contract (fail-closed known_hosts) | SUCCESS | `101241907053` |
| Plugin System Tests | stock-prep PowerShell 5.1 acceptance | SUCCESS | `101241907509` |
| Plugin System Tests | test (18.x) | SUCCESS | `101241907633` |
| Plugin System Tests | test (20.x) | SUCCESS | `101241907679` |
| Web Tests | web-tests | SUCCESS | `101241907154` |
| Observability Strict | Strict E2E with Enhanced Gates | SKIPPED (intentional) | `101241907440` |

All job identifiers above belong to Actions runs triggered for the exact code head. The report-only child created after this matrix must not inherit this terminal claim; its checks require a separate exact-head read.

## Release boundary

No staging UAT, real-tenant UAT, flag activation, dispatch, deployment, production action, or database action is claimed. Even terminal green CI only makes the PR eligible to request separate owner Ready/merge authorization after the report-only child independently re-greens.
