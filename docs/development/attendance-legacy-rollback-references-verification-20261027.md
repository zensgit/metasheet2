# Legacy rollback reference repair — verification (2026-10-27)

Refs #4556 DB-10/DB-11. Draft/HOLD, local technical evidence only until current-head required CI completes. No formal parent or owner acceptance.

## Problem and change

The original shadow-to-legacy canonical transition committed with an active published multi-segment assignment. Native reproduction observed one matching admission failure, event count 0 to 1, with two independent unused-multi/single-segment controls passing. Source envelope, segment and assignment rows remained unchanged; the defect was admission, not destructive rollback.

The canonical transition and its read-only plan now share a SELECT-only count of distinct same-org referenced multi-segment shifts. Count failure is fail-closed. Active assignments/rules, pending swap snapshots and pending/published dispatch snapshots are covered. Explicit inactive/rejected/cancelled sources do not block. Rotation references use current UUID-first resolution before legacy-name fallback; a same-org single-shift ID cannot accidentally bind an unused multi-shift name.

Desired-only fixed-schedule configuration is not an effective assignment. Native legacy/OFF HTTP save succeeds with zero assignments and no rollout row; the first candidate wrongly blocked its later rollback. That hypothesis was removed after reading the FSER contract and proving the counterexample. Actual apply/rebuild assignments remain covered. Save/delete/conversion semantics are unchanged.

Both the exclusive class-00 lock-before-BEGIN ordering and the existing authoritative/source/pointer predicates remain intact. A real shared-lock writer commits a reference while the transition waits; pg_blocking_pids proves blocking, and transition then refuses using the committed source. No clock-based deactivation heuristic, direct rollout writer or new feature flag.

## Actual local execution

The existing writer-matrix file had 45 original cases. Eighteen new named identities have positive execution evidence across these phases; this is not a fresh whole63 or same-source18 run:

| Phase | Actual result | Scope |
|---|---|---|
| Initial boundary/source controls | 3 passed,45 excluded | Active multi refuses; unused multi and active single succeed; exact source preservation |
| First arm/race run | 7 passed,7 fixture failures,48 excluded | Assignment draft/inactive; rotation ID/name/inactive; foreign name; actual writer/transition lock race |
| UUID/name counterexample and repair | 1 matching red,62 excluded; then4 passed,59 excluded | New ID-first collision plus3 affected rotation controls |
| Desired-config counterexample | 1 matching red,62 excluded | Existing OFF metadata save200/zero assignments; candidate overblocking |
| Corrected source fixtures | 5 passed,2 fixture failures,56 excluded | Desired metadata allow; swap counterparty; dispatch pending/published/cancelled |
| Affected legacy-swap correction | 2 passed,61 excluded | Constraint-checked historical requester snapshot; rejected swap control |

The first fixture failures were HTTP group creation expecting201 instead of actual200 and missing mandatory operation IDs. The subsequent two failures were real existing public requester-multi create refusals. They were not hidden by changing producer guards: the test asserts422, the existing typed disabled code and zero created request/detail rows, then installs an explicit native constraint-checked legacy pending snapshot. This proves durable reference protection, **not public requester-multi admission**. The rejected control uses an admitted counterparty source and explicit historical rejected status. The public requester admission boundary remains a separate unresolved capability/contract item.

Eight fault groups produced ten matching failed assertions: boundary decision, active assignment arm, active rotation arm, requester/counterparty swap arms, pending/published dispatch arm, explicit inactive filtering and rotation org scope. Main audited actual failure messages and receipts: wrongly admitted transitions, or wrongly blocked inactive/foreign controls. Setup/network/hook errors are excluded. Runtime bytes restored exactly. No unchanged positive suite replay for mutation receipts.

Schema-down preservation: the strengthened existing case passed1/8 excluded. A temporary native ALTER TABLE before the original abort produced1 matching DDL assertion failure/8 excluded despite unchanged data and the same abort error. Exact migration source restoration; no production migration change. Full envelope/segment rows remain equal, observed COUNT proves the recorder is nonvacuous, and DDL count is exactly zero on refusal.

Affected native neighbors: core rollout control68/68 and CLI transition tool31/31, zero skipped. Inventory16, W6 DML sweep39, W7 preservation13 all passed, zero skipped. Actual pnpm validate:all exited0 after final production helper/core changes. Later changes are test scaffolding/docs only; no fresh quality rerun is claimed.

Explicit same-path/same-config lint comparison found zero introduced diagnostics; new helper has zero errors/warnings. Existing test/core diagnostics remain and both broad current/baseline lint commands exit1. Whole-file lint clean is not claimed. No lint configuration changed.

Original writer45 and core68 bodies/hooks/budgets are byte-identical after inverse additions. Migration assertions/budgets are preserved and strengthened. Six empty real relation shapes were added only to the isolated core-boundary fixture; full-schema/FK/source proof comes from the writer-matrix file. Native ledger458/pending0 reused without migration replay. Owned cluster stopped, port closed, data retained.

## Review and receipts

The independent source review found the UUID/name collision; the main agent independently reproduced and repaired it. A later source followup and actual OFF save refuted the first desired-config hypothesis. This was not a no-findings review. The reviewer did not run tests.

Artifacts retain raw reporter assertions and failed attempts:
- parent-rollback-reproduction-main-independent-audit.json
- parent-id-first-reproduction-v1-state.json and parent-id-first-positive-v1-state.json
- desired-reference-contract-main-disposition.json
- parent-reference-protections-v1-state.json
- parent-reference-fixture-corrections-v2-state.json
- parent-reference-swap-legacy-v3-state.json
- schema-down-preservation-v1-state.json
- rollback-neighbors-quality-v1-state.json
- rollback-mutations-and-original-tests-main-independent-audit.json
- final-explicit-lint-baseline-state.json
- legacy-reference-core-independent-source-review.json
- main-independent-local-final-audit.json

Commands used with isolated synthetic database configuration:
- pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-shift-segments-writer-matrix.db.test.ts -t PARENT_DB10
- pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-w4c3a-rollout-control.db.test.ts tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts
- pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-shift-segments-migration.db.test.ts
- pnpm validate:all

These commands describe the actual selected phases above; they do not assert unfiltered execution where a filter was used.

## Gates and limits

| Gate | State |
|---|---|
| Original DB-10 defect and controls | PASS: native matching red before repair; two actual controls |
| Canonical admission/plan and sources | PASS across explicit phases; public requester create remains422 |
| Org/status/guard mutations | PASS:8 groups/10 matching failed assertions, exact restoration |
| Lock race and runtime source preservation | PASS at original budgets |
| Schema-down no-DDL/data preservation | PASS selected original case plus matching native DDL mutation |
| Neighbors, quality and original-test preservation | PASS with lint/source-phase qualifications above |
| Current-head required CI | PENDING; no parent/local green substitution |
| Parent/owner/business/live acceptance | OPEN or excluded; not implied by this repair |

Current CI must actually execute the whole registered writer-matrix63, core68, CLI31, migration9, inventory16, W6 39 and W7 13 before final evidence. Filtered/skipped/todo entries are never counted as passed.

No dependency, lockfile, schema, OpenAPI, workflow, external IO or feature-flag changes. Existing HTTP fixtures use synthetic authentication bypass and native synthetic source rows; this is not real-auth/UAT or a production rollback drill. New public inputs are not claimed composed into the private combined fixture. Correction/OT target choice and bridge, CALC/DB/MUT residuals, formal4556/4844/6512 owner gates, human AT/native menus/screenreader, frozen TRANSFER, W8/PQA/staging/manual/soak/performance/reconciliation/live/provider/2000-user/Redis/secrets remain separate.

All PRs Draft/HOLD; no merge/deploy/R71/tag/release/business-config changes. Stream/lifecycle OFF, realUAT/50004 excluded, historical08PUT INCONCLUSIVE.
