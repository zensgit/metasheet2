# Administrator issues: CI registration followup — 2026-10-14

Scope: existing authorized Draft PRs #6407–#6410. No new capability, production source, migration, real CI variable, protection or deployment change.

## Reproduction and correction

#6407 Plugin System Tests run38584050458 failed the Attendance W4C-2 wiring contract. The new `attendance-self-service-revocation-atomicity.db.test.ts` was already a whole-file argument in the approval real-DB job, but two static registrations were missing: the no-DB `test.exclude` and the exact `EXPECTED_ATTENDANCE_SUITES` pin. The discovered corpus had126 members while the pin had125. The later timezone cleanup failure followed the early job failure and is not the primary diagnosis.

Grok implemented exactly three insertions in commit `1383c28fe0916b4199cb2c37ec759f15a8ce04f0`: one explanatory comment and the exact suite string in `packages/core-backend/vitest.config.ts`, plus the exact string in `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`. Every old125 member and all equality/once-only/whole-file guards remain intact. No runtime behavior changes.

## Validation

- Actual existing emit mechanism `EMIT_ATTENDANCE_CORPUS=1 node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs` verifies126 exact members. Grok local guard run294 passed.
- Exact frozen source mirrored to the dedicated Mac mini workspace with full tree/hash and clean-index verification. `node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs scripts/ops/attendance-acceptance-wiring.test.mjs`: **304 passed,0 failed,0 skipped**.
- Remove only the new quoted no-DB exclusion: matching once-only wiring assertion fails. Restore original bytes. Remove only the new pinned member: exact-family assertion fails. Restore original bytes; final source clean. Two mutations pass as negative controls, not baseline skip-shaped evidence.
- Sol independent bounded review: **PASS** at1383. Initial API429 attempt produced no verdict; the low-effort retry succeeded. No broad product review or additional implementation was delegated.
- Native first attempt failed closed because the Mac environment had no usable PyYAML. Existing installed PyYAML6.0.1 pure Python files were copied only into this task's runtime, with transfer hash and interpreter/YAML positive control. No repository parser bypass, shared install or network package download occurred. The successful304-test rerun supersedes that failed environment attempt.
- `validate:all`: **PASS** on exact frozen source1383.

Prior product/API/browser/PostgreSQL qualification remains attributed to its original sources; neither changed file alters runtime source. The dedicated database/backend/web are stopped, with445-table count/content restoration previously confirmed after publication screenshot capture. No repeat database migration or real-tenant operation is required for these static CI registrations.

## Publication and gate boundaries

The three-line correction and this verification note are propagated to the existing four owner-approved branches. Dependent heads preserve their own product changes and include the corrected parent through explicit ancestry. Each exact new head starts complete main-targeted PR CI, then its stacked review base is restored to #6407. That scheduling does not change workflow rules or branch protection. Remote CI remains pending until new-head results arrive; no merge or deployment is authorized.
