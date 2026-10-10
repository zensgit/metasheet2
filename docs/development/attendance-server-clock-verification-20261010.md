# Attendance server clock — local verification snapshot

**Date:** 2026-10-10
**State:** Local verification snapshot, including follow-up work after the first CI failure. This records completed local evidence and remaining gates; it is not a merge, deployment, or customer-acceptance claim.

## Source identity and scope

The implementation worktree is based on merged prerequisite #6300: base commit `9bbbdb29e352527b93164490d17f759d321ddb68`, tree `fe89dc3a13b01d82ade8c6ebe093991cac058e93`. The merge receipt is `artifacts/attendance-server-clock-20261010/pr6300-actual-merge-receipt.json`. These identify the predecessor base, not the final tested implementation.

The final implementation sources are identified by SHA-256 in `artifacts/attendance-server-clock-20261010/backend/source-final-hashes.json`; that manifest also records the base and harness hash and confirms all deliberate backend mutations were restored. It covers the attendance plugin entry point, server clock module, online request module, operation registry, live scheduled boundary, and backend index. Frontend source identity is in `artifacts/attendance-server-clock-20261010/frontend-completion-receipt.json`. The qualified successor PR head and final remote CI result are recorded separately; neither is inferred from this local snapshot.

All checks below used synthetic/isolated test data. No customer data or production environment was used. No deployment, production history repair, external write, or business acceptance occurred.

## Backend verification

The final backend receipt qualifies 25 distinct whole files / 564 cases, all passing with zero skips; post-mutation repeats are not counted twice. Both owned databases and the isolated PostgreSQL cluster were removed, listener/process/TCP censuses were empty, and the tracked `.env` was restored byte-exactly with its private backup removed. See `backend/backend-final-receipt.json`.

| Command / scope | Actual result | Receipt |
|---|---|---|
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-online-punch-clock.test.ts tests/unit/attendance-online-punch-request.test.ts` | 31 passed, 0 failed, 0 pending. | `backend/unit-final.json`, `backend/unit-final.log` |
| `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c0-operation-registry.db.test.ts tests/integration/attendance-w4c2-d2-live-punch-authoritative.db.test.ts` | 35 passed, 0 failed, 0 pending. | `backend/db-internal-legacy-final-receipt.json`, `backend/db-internal-legacy-final.json` |
| Fresh owned PostgreSQL database: migrate, compare migration ledger, run the two new integration files, census, run 18 adjacent whole files, strict fixture check, real-PostgreSQL teardown, session census and drop/absence check | Migration: 438 applied, replay 0, pending 0, ledger unchanged. New files: 38/38 passed (20 server-time + 18 replay). Adjacent files: 441/441 passed across 18 files. Rules census matched empty baseline. Strict fixture check passed. Teardown: 19/19 passed including the opt-in real-PG case; 0 skipped. Sessions before drop: 0; database dropped and absence verified. | `backend/fresh-regression-receipt.json`; stage logs under `backend/fresh-*.log` |

The 18 adjacent whole-file runs were `attendance-live-punch-order.db.test.ts` (7), `attendance-outdoor-punch.test.ts` (29), `attendance-plugin.test.ts` (166), `attendance-shift-segments-writer-matrix.db.test.ts` (41), `attendance-soak-diff-families.db.test.ts` (5), `attendance-w4c2-gate-matrix-e5.db.test.ts` (31), `attendance-w4c2-live-scheduled-boundary.db.test.ts` (8), `attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts` (16), `attendance-w4c2-p2-remediation.db.test.ts` (5), `attendance-w4c2-posture-matrix.db.test.ts` (5), `attendance-w4c3b-request-operation-routes.db.test.ts` (24), `attendance-w4c3c-record-operation-routes.db.test.ts` (35), `attendance-w7-4-read-side-labeling.db.test.ts` (18), `attendance-files-acl.test.ts` (13), `attendance-w7-1b-issuance-seam.db.test.ts` (11), `attendance-punch-org-resolution.db.test.ts` (9), `attendance-w7-1b-cutover-e2e.db.test.ts` (6), and `attendance-org-resolution-shadow.db.test.ts` (12). Each collected test passed; no skips or pending tests.

Five backend guard mutations each caused assertion failures and each was restored to its recorded source hash: timestamp presence (17 failures / 20 tests), production clock seam (1/10), common claim marker (4/18), uncertain rollback (1/21), and replay liveness (2/18). The exact failed assertions, commands, pre/post hashes, and restoration flags are in `backend/mutation-receipt.json`; mutation run outputs are the corresponding `backend/mutation-*.json` and `.log` files. These results demonstrate that the focused guards detect those mutations; they do not substitute for the passing whole-file runs.

Backend TypeScript final check exited 0 (`backend/unit-type-final-receipt.json`). The strict fixture verifier exited 0 and reported its pass marker without RBAC bypass (`backend/fresh-strict-fixture.log`). Core backend `.env` restoration was exact and its temporary backup was absent afterward; this report does not include environment contents (`backend/core-env-restoration.json`).

## Repository and source-gate checks

`pnpm validate:all` exited 0 on Node 20.20.2 / pnpm 10.33.0; plugin manifests reported 13 valid and 0 invalid. `node --test scripts/ops/global-history-flag-manifest.test.mjs` exited 0 with 46/46 checks. Receipts: `root-quality-final.json`; logs: `validate-all.log`, `global-flag-manifest.log`.

The exact-source CI wiring whole-file attempt used Node 20.20.2 and exited 0: 268 passed, 0 failed, 0 skipped, with source-byte identity preserved. Its receipt is `root-ci-wiring-attempt3.receipt.json`; command and output are `root-ci-wiring-attempt3.command.json` and `.log`. Two earlier timeout-related failures are retained in the earlier attempt logs; this report does not infer their root cause from the later passing whole-file run.

OpenAPI build and guard exited 0. Post-recovery OpenAPI, retired-tool and required-CI source guards total 75/75 passing; three source-gate mutations went red and were restored byte-exactly. Evidence: `openapi-build.log`, `openapi-guard-postrecovery.log`, `root-postrecovery-unit.json`, `root-mutations.json`, and `root-source-gates.json`.

## Frontend evidence

The exact frontend source hashes are in `frontend-completion-receipt.json`. The 12-file whole-file lane passed 323/323 with no failures, skips, or todo; `vue-tsc --noEmit -p tsconfig.app.json` exited 0. Synthetic Chromium completed 10/10 expected tests with no skip, unexpected, or flaky result. Four synthetic captures covered available/unavailable clock × desktop/mobile and were independently reviewed in `root-visual-review.json`. The earlier mounted-view baseline had 17 assertion failures; five focused frontend mutations went red and were restored. Detailed receipts are `frontend-final-wholefiles.json`, `frontend-chromium-final.json`, `frontend-negative-restoration.json`, and `frontend-mutation-*-red.json`.

## First-CI source census follow-up

Draft PR #6321 first ran at head `b3dd4ec1de0ac8290891f3a0ed3539fbc04ffe2c`. The core step failed with seven assertions in two files: the W7 preservation classification omitted the two new modules, and the multitable fence-holder ledger omitted the two new shared-transaction callers. Downstream database, drain and checkpoint steps were skipped and are NOT_RUN for that head. The failure is preserved in `ci/sol61-core-failure.json` and its raw/API logs; the independently reviewed cause is `ci/independent-core-failure-review-astra.json`.

The follow-up adds both modules to `CALCULATION_PATH` (keeping the carve-out list empty), and records `executeOnlinePunch` and `probeOnlinePunchReplay` as row-32 attendance-only `NONWRITER` holders, each with count 1. This registers the actual source without changing production code, scan roots, guard functions or assertions. The two guard whole files and the adjacent W6 enum-parity whole file passed 124/124 after restoration: W7 13, fence census 49, enum parity 62; zero failures/skips/todo. Deleting each of the four new entries caused its matching guard to fail, and each file was restored to its exact hash before the final whole-file run. The name-filtered mutation exclusions are not counted as passing whole-file qualification. All 1409 tracked production/runtime file hashes remained unchanged.

Receipts: `ci-guard-fix/final-receipt.json`, `ci-guard-fix/final-green.json`, and the independent `ci-guard-fix/independent-guard-fix-review-astra.json`. Final qualification still requires a fresh CI run on the follow-up head; the original failed head is not retroactively marked green.

## Product boundary and remaining gates

Calendar `today` and punch `workDate` remain distinct: the former follows calibrated server time and the aligned attendance timezone; backend shift and overnight rules determine the latter. Existing resolution remains rotation shift, assignment shift, then default rule. No device-time fallback is claimed.

The future multitimezone requirement remains pending separate design: OFF means the configured system/organization default timezone even during approved travel; ON means an administrator-approved effective attendance arrangement, with a travel destination only during its approved period and the underlying arrangement afterward. This slice does not implement either mode or travel linkage. See `artifacts/attendance-server-clock-20261010/requirements-followup.md`.

The owner stated that old attendance data can be discarded for future enablement. This does not mean existing rows have been physically cleared: any such asynchronous clearing remains pending and outside this verification snapshot.

| Gate | Status |
|---|---|
| Local frontend, backend unit/integration, fresh-database migration/replay/regression, strict fixture and real-PG teardown | Complete for the source hashes and receipts listed above |
| Local `validate:all`, feature-flag manifest, OpenAPI, retired-tool and source CI-wiring checks | Complete; no remote CI implication |
| First-CI static registration repair, whole-file guard/neighbor checks and deletion controls | Local PASS: 3 files / 124; four deletion controls detected and exactly restored; independent review PASS |
| Final independent Astra review | PASS for frontend/root and backend local source/evidence; remote CI remains separate |
| Linked Draft PR head and remote exact-head CI | Pending; will be recorded separately |
| Original 20-item QA and business acceptance | NOT_RUN |
| Physical clearing of existing attendance data | Pending; not performed by these checks |
| Deployment, history repair, production scope, external writes | Not authorized or performed |

The successor remains Draft + CI approved as directed. That label does not mean Ready, merge-approved, deployed, or customer-accepted. The release gate to stop old ingress, drain old writers, run only the new binary, and reopen traffic after release checks remains pending and unauthorized.

## Evidence index

- Approved behavior contract: `docs/development/attendance-server-clock-design-lock-20261010.md`
- Final backend source identities and mutation restoration: `artifacts/attendance-server-clock-20261010/backend/source-final-hashes.json`, `backend/mutation-receipt.json`
- Fresh migration, new and adjacent whole-file runs, teardown: `artifacts/attendance-server-clock-20261010/backend/fresh-regression-receipt.json`
- Backend unit/type checks: `artifacts/attendance-server-clock-20261010/backend/unit-final.json`, `backend/unit-type-final-receipt.json`
- Independent final local review: `artifacts/attendance-server-clock-20261010/independent-backend-final-review-astra.json`, `independentfrontend-root-review.json`
- Quality and CI wiring: `artifacts/attendance-server-clock-20261010/root-quality-final.json`, `root-ci-wiring-attempt3.receipt.json`
- Frontend and visual evidence: `artifacts/attendance-server-clock-20261010/frontend-completion-receipt.json`, `root-visual-review.json`
- Future timezone requirement: `artifacts/attendance-server-clock-20261010/requirements-followup.md`
