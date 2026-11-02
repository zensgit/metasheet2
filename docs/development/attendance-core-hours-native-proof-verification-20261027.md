# Legal core-hours violation — verification (2026-10-27)

Refs #4556 CALC-10. Draft/HOLD; this is one bounded native HTTP proof of existing semantics, not a new core-hours reason or policy and not full parent acceptance.

## Source and actual results

Fresh isolated main b9bccade372e0bf339df2ea66211fb0e20d58861. The existing registered W4 request-operation fixture authors a legal single-segment 09:00–18:00 flex shift through actual HTTP201. Required480 minutes, permitted arrival08:00–10:00 and core10:00–15:00 satisfy both original coverage inequalities. Native synthetic published assignments and the legal rollout-state fixture ladder admit canonical authoritative live punch; no public assignment-write or operational rollout proof is claimed.

Two named scenarios actually passed with24 original cases filtered out:
- Violation: actual HTTP check-in10:30/check-out14:30; expected10:00–18:00, work240, late25, early205, status late_early and exactly early_check_out/late_check_in.
- Independent on-time control: HTTP10:00–18:00, work480, late0/early0, normal/within_window.

Both retain exact frozen core/flex policy and legacy selector. The current calculation ID/org/record join, authoritative completed/calculated/set_active projection, full selected child metrics/boundaries/reasons, parent metrics and exact two native events agree. The immutable segment_snapshot is the authored segment definition, equal to context_snapshot.segments; calculated output is in attendance_record_segments. The test clock helper sends actual HTTP and removes occurredAt from the online body.

## Retained oracle failure and mutation

The first new test incorrectly treated segment_snapshot as calculated output. Independent source review found one P2; main read writeCompletedRow, where segmentSnapshot is input.context.segments, and actual execution failed exactly those two new assertions/24 excluded. The minimum test-only correction compares the frozen definition snapshots; exact child/parent numeric assertions and budgets remain. No product storage semantics changed. This review was source-only and did not attest execution.

The corrected two scenarios passed/24 excluded/exit0. Temporarily forcing the calculator's late-minute expression to zero caused exactly the violation case to fail at the full canonical/parent metrics assertion: late25 became0 and late_early became early_leave, while work240/early205 remained. The on-time control actually passed;24 unrelated cases excluded. Main audited the raw diff, not only the failure count. Calculator SHA256 restored exactly to87c5c6c1afc40df3e9a24cde22cee6b1d32f4c378769c1d40674141980a218e3. No positive replay after restoration for a receipt.

Original24 test bodies/hooks/budgets are byte-identical after removing the added block. The existing full file is already registered in plugin-tests.yml; no workflow, test budget or gate changes. Current/base explicit lint both exit0 with the same3 pre-existing any warnings: introduced0 errors/0 warnings, not warning-free whole-file lint.

Production/config/package/blob inputs equal the existing b9 base validation. Actual prior pnpm validate:all exit0 is retained with an explicit source-applicability proof; backend integration tests are outside production TS includes and core has no lint script. Current test explicit lint was run. This is **not a fresh candidate validate:all run**; no unchanged suite was replayed.

Native ledger458/pending0 was reused without migration replay. Each owned PG start ended with the same postmaster stopped, port closed and data retained. No production source, dependency/lockfile/schema/OpenAPI/workflow/feature-flag changes remain.

## Evidence and commands

- native-core-hours-first-state.json:2 oracle failures/24 excluded; preserved history.
- core-hours-independent-source-review.json and core-hours-review-main-disposition.json: confirmed P2 and source-based correction.
- native-core-hours-v2-state.json:2 actual passed/24 excluded, two exact HTTP/native receipts.
- native-core-hours-mutation-state.json:1 matching red +1 actual control/24 excluded, exact restoration.
- core-hours-explicit-lint-state.json: current/base diagnostic equality.
- production-quality-source-applicability.json: actual prior quality0, same production inputs, no fresh quality claim.
- main-independent-local-final-audit.json: raw assertion/mutation/source/budget/cleanup audit.

Commands were selected:
- pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts -t PARENT_CALC10_CORE_HTTP
- pnpm --filter @metasheet/core-backend exec eslint --no-ignore --parser-options '{"project":null}' tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts

## Design-lock gates

| Gate | State |
|---|---|
| Authoring-valid core policy and actual violation | PASS: real shift/punch HTTP plus native canonical readbacks |
| Independent on-time control | PASS |
| Canonical child/parent/frozen-source agreement | PASS, exact numeric and definition assertions |
| Matching mutation and exact restoration | PASS:1 named red/1 actual control |
| Original tests, explicit lint, production-quality applicability | PASS with prior-source qualification and3 existing warnings |
| Exact-head required CI | PENDING; must execute whole registered26 and both new named receipts |
| W7 group flex/real-auth/UAT/whole parent/owner acceptance | Not proved or excluded |

The existing fixture uses RBAC_BYPASS and native synthetic source assignments. This is W4 legacy-selector flex, not W7 group-effective flex enablement or public assignment admission. No new core_hours_violation enum is invented. CALC11–15, DB/MUT/EP01/correction/OT target choice and bridge, private combined-source compatibility, owner/human/frozen/staging/live gates remain separate.

All PRs Draft/HOLD; no merge/deploy/R71/tag/release/business-config changes. Stream/lifecycle OFF; realUAT/50004 excluded; historical08PUT INCONCLUSIVE.
