# Segment-window selection — Draft verification (2026-10-27)

Refs #4556 §7.2 CALC05/06. Base b9bccade372e0bf339df2ea66211fb0e20d58861; branch codex/attendance-segment-window-selection-20261027. Owned isolated synthetic fixture only.

## Problem and repair

Real HTTP/native PG reproduced false ambiguity for published split08–09+16–17 versus narrow13–15 at13:00 in both slot orders:409 ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS, no event/record/calculation/child changes. A separate16:00 reproduction exposed unconditional same-date candidate-count refusal; actual overlap was a passing refusal control.

The canonical live path now reads served W7 segment definitions only behind the existing exact organization reference posture. A query-free negative hint preserves the OFF path; it never grants admission. Same-transaction strict referenceSegments===true remains mandatory. Actual containing windows select a unique current-day candidate independently of row order; public W2 segmentIndex remains null, and full-shift V2 identity/segments are retained. Unused candidates do not themselves constitute a second issued context; an existing distinct issued context still rejects409.

Only a unique actual-containing winner bypasses the old date-count fence. No actual hits retain the original envelope/gap/tail/overtime attribution branches; no per-segment tail or new unresolved policy is invented. Enabled-timezone proof covers the selected FULL original window, including required policy partitions whose reconstructed window moves away. Default source-change/calendar/request proof callers retain the original whole-day proof.

## Actual local evidence and scope

| Gate | Actual evidence |
|---|---|
| Reproduction | Original two slot orders:2 matching red/24 excluded. Extra split16:00:1 matching red plus genuine-overlap1 control/26 excluded. Zero-match intermediate invocation is invalid and retained. |
| Initial units | 232 actual passed, zero skips: new pure helper91, W2 resolver43, timezone locks28, context loader70. |
| First native candidate | 4 actual passed/24 excluded: two narrow permutations, full split shift, actual overlap refusal. |
| Added protections | Later6 actual passed/28 excluded: enabled narrow/split; second issued context409 preserving current result and counts; OFF; strict source failure503; required policy cut409. These are separate source/test phases, not a fresh all34-case run. |
| OFF callback units | New11 actual passed, zero skips: exact false/nonliteral hints, strict posture values, same trx and private-error fixed503. Mock finite SQL/callback evidence, not native whole-query census. |
| CALC06 | Two existing W2 native cases strengthened:2 actual passed/9 excluded. Exact no-window result without guessed identity; exact3 ambiguity candidates; reversed actual assignment-query rows give identical union. Legacy-envelope outcome proof, not all canonical entrypoints. |
| W7/W6 | Complete W7 dual-ban13 and W6 DML sweep39 actual passed, zero skips. An initial harness predicted111 instead of actual52; suite exit0/raw assertions accepted independently, no replay. |
| Production quality | Actual pnpm validate:all exit0 (manifest/lint/type checks); existing manifest warnings retained. |
| Explicit lint | New helper/two unit files0 errors/0 warnings. Existing TS paths match same-path baseline, including W2 test11 existing errors, W3 test3 warnings and core index22 warnings. Supplemental CJS check uses CommonJS-applicable rules and matches baseline; inherited plugin5529 errors/36 warnings and timezone runtime3 errors remain. Forcing the TypeScript no-var-requires rule onto CJS initially added one expected require diagnostic; retained as a tooling-model failure, no repository/CI lint configuration changed. Do not call whole-file lint clean. |
| Review | Independent first implementation review plus six-protection/11-unit followup: no confirmed introduced P1/P2, source-only. Main raw assertion, mutation, source and baseline audits are separate. |
| Publication/CI | PENDING exact new commit and required CI. No old PR/head green is inherited. |

The four native CALC05 faults give6 matching failures and1 passing mutation control across separate invocations: envelope-only false ambiguity, first-row selection/wrong overlap admission, unconditional date-count refusal, and skipped moved-away required policy partition. Two CALC06 faults each give1 matching failure. Retaining the hint call but forcing its decision gives5 matching strict-resolver-call failures; truthy posture admission gives2 matching failures/3 controls. All runtime bytes restored exactly. The first hint mutation deleted the hint call and failed its spy assertion; that earlier result is not counted as the target guard proof.

Native OFF baseline/candidate receipts match exactly:409 ATTENDANCE_TIMEZONE_WORK_DATE_AMBIGUOUS, protected business counts unchanged, full response SHA256 ac6ecaa8bdf98f30d4eb06aba43e4e6398e10737f45f7fcaf1abdd2130dc2e69. This is response/count parity plus separate bounded callback/source proof, not a native full SQL census.

Fresh isolated UTF8 PG458 migrations/pending0 once; later phases reuse ledger. Owned cluster finally stopped/port closed/data retained. Source shifts use HTTP; published assignments/policies are explicit native synthetic source fixtures. Existing RBAC_BYPASS means not real-auth/public assignment authoring/UAT proof. Only event/record/calculation/segment counts are claimed for refusal deltas; no claim that all legitimate refusal/audit writes are absent.

## Evidence locations

Remote artifacts under attendance-segment-window-selection-20261027:
- calc05-reproduction-v1-state.json, calc05-reproduction-v3-state.json
- calc05-first-fix-v1-state.json, calc05-protections-v1-state.json
- calc05-mutations-main-independent-audit.json, calc05-mutations-v1-state.json
- calc06-positive-v1-state.json, calc06-mutation-v1-state.json
- selection-unit-guards-quality-v1-state.json, selection-off-mutations-quality-v1-state.json
- selection-final-explicit-lint-v1-state.json, selection-final-explicit-lint-v2-state.json
- calc05-first-fix-independent-source-review.json, calc05-protections-independent-followup-review.json
- main-independent-local-final-audit.json, candidate-final-source-manifest.json

No dependency/lock/schema/OpenAPI/workflow/feature-flag changes. New helper is in W7 CALCULATION_PATH, both bans; NOT list unchanged. New unit files use existing unit discovery. Integration cases remain in the two existing registered DB files; current-head CI must prove whole W3 file34 and W2 file11 plus helper91/runtime11 actual execution before final evidence.

Correction replacement/missing-boundary semantics and approval/OT bridge remain separate and awaiting the existing human target decision. Full parent DB/CALC/MUT reconciliation, formal4556/4844/6512 owner acceptance, private combined-source verification, human AT/native menu/screenreader, TRANSFER freeze, W8/PQA/staging/soak/performance/reconciliation/live/provider/2000-user/Redis/secrets are not closed here.

All PR Draft/HOLD; no merge/deploy/R71/tag/release/business-config changes. Stream/lifecycle OFF; real UAT/50004 excluded; historical08PUT INCONCLUSIVE. This is not whole product or production acceptance.
