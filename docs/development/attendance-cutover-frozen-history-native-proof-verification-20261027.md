# Attendance effective-date cutover and frozen target — verification

Draft / HOLD. Refs #4556. Base `5193da4c5667418a8bd9fa40a9a80021cdcac077`. Test/docs only.

## Actual positives

The registered route suite retains original24 cases exactly and adds two. Only canonical-day/frozen-calculation helper definitions were reused; no prior CALC/core/DST cases were copied or replayed.

| Target | Actual phase | Per-assertion result |
|---|---|---|
| CALC12 effective-date group switch | native-two-corrected-v3 | CALC12 passed; C13 failed;24 excluded |
| CALC13 actual edit/frozen_prior | native-c13-domain-v6 | C13 passed;25 excluded |

Two unique positive cases across separate phases, not a fresh joint run. C12 body stayed unchanged through C13 fixes. Filtered/skipped and Vitest1.6 aggregate passed counters are not actual passes.

CALC12 receipt:2 parents/2 groups/4 events,480 and360 minutes, owners w4_group, exact date-scoped V2 attribution/current-pointer joins/authored definitions/evidence/native children. A starts June1/ends July1 inclusive, B starts July2; legal source/producer facts precede HTTP, both dates reread after four punches.

CALC13 receipt:source PUT200 and recompute200, frozen_prior/prior_calculation_frozen; changed live window/grace/rounding, original C0/children/parent/events/counts exact before recompute, same six frozen inputs/source-definition fingerprint,480→480, version+1, owner w4,2 events. Full OCC response/new provenance and exact count deltas checked. C0 immutable and edited live source unchanged after recompute. Full nine-key append/merge semantic domains independently verified, not falsely equal.

## Three matching fault groups

| Temporary runtime mutation | Actual matching red | Opposite control |
|---|---|---|
| effective_from <= becomes < | CALC12 HTTP503 vs200 | CALC13 passed |
| effective_to >= becomes > | CALC12 HTTP503 vs200 | CALC13 passed |
| frozen_prior rounding1 becomes5 | CALC13 context1 vs5 | CALC12 passed |

Each group executed1 named red/1 named control/24 excluded. Main read raw failures and individual JSON statuses, verified exact restoration. No receipt-only positive replay.
Restored resolver SHA `4c3586b72768e6f5c4dd2b096975c17d10562d43ace383e66ec2984a252adc82`; recompute `953c8600c9ac2a901921ed24dec1a4d71cd91c9a76137d94d395a6e4b28f58c3`.
Own controller/postmaster exited, port closed, data retained. All original24 inverse bytes/budgets exact.

## Failed attempts and refuted hypotheses

- First run0pass/2fail/24excluded: same-org group-name23505 and C13 recompute403. Distinct synthetic names fixed setup only.
- Missing DB admin was an incorrect hypothesis: original seedOrg already grants it. Redundant grant removed.
- V2 launched after an edit command failed before writes. Only owned child terminated; own cluster stopped. No assertion report, invalid run.
- V3 passed CALC12. C13-only V4 exposed FORBIDDEN/ORG_MEMBERSHIP_REQUIRED. Legacy getOrgId ignores dev-token tenantId; existing X-Org-Id selector header fixed request fixture, no guard change.
- V5 reached200/six frozen inputs/equal source fingerprint/old480, then wrong semantic-equality oracle failed. W4 section4.3 includes mergePolicy: live append versus legacy merge differ. V6 verifies both exact domains; no runtime or W7-R6 relaxation.
- New shared clone fetch hit alternate depth; only its alternate references flattened, existing stores/tags/source untouched.
- Explicit lint finished before path inventory failed on Git quoted filenames. Retained lint output parsed and inventory corrected to NUL-separated paths, no lint replay. All attempts retained.

## Lint, quality, source and review

Same absolute test filename/config explicit ESLint: `--no-ignore --parser-options '{"project":null}' --stdin --format json`. Baseline/current0 errors/same3 existing no-explicit-any warnings; introduced0, not warning-free.

Actual same-base DST validate:all exited0. All14118 other tracked files/production/config/package inputs are byte-equal to that actual quality source; only integration test differs and production TS excludes tests. This is applicability, not fresh candidate validate:all. Offline install once, qualified ledger458 reused without migration replay.

Independent refute-first review found no confirmed introduced P1/P2. Main verified hashes/original24 inverse/pivotal assertions and actual raw execution. Reviewer ran no tests/mutations and did not certify publication/business acceptance. Source plan requested Astra/ultra, runtime model unexposed; no model attestation claim.

Private evidence includes reports/logs, `native-finite-mutations-main-independent-audit.json`, `explicit-test-lint-and-quality-applicability-state.json`, manifests/contract diagnosis/review. Public evidence excludes runtime IDs/hosts/secrets.

## Reproduction / CI

In the isolated synthetic native PG fixture:
```sh
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts -t 'CALC12_HTTP_PG|CALC13_HTTP_PG'
```
Saved positives are V3/C13-only V6 above; this command is not an extra joint run claim. Current published-head whole file26 and both receipt markers remain PENDING CI.

## Open boundaries

No real-auth/public assignment write, operational cutover, full policy history/current_policy/group recompute/correction/OT/archive proof. Full W7-R6 equal-fingerprint/no-live-read/three-fact-family matrix OPEN. CALC14 effective-date/prehistory and correction-target choices await human answer; no dependent implementation. New inputs not claimed composed into existing private fixture.

Formal #4556/#4844/#6512 owner gates, human keyboard/screenreader/native-menu tests, TRANSFER frozen items, W8/PQA/manual/soak/performance/reconciliation/live/provider/2000-user/Redis/secrets remain separate. Draft/HOLD, Stream/lifecycle OFF, realUAT/50004 excluded,08PUT INCONCLUSIVE. No merge/deploy/R71/tag/release/business-config/persistent-flag change.
