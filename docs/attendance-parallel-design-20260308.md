# Attendance Parallel Design (2026-03-08)

## 1. Background
Current production gates are largely green, but the parallel hardening branch exposed a key gap:
- `Attendance Import Perf Long Run` failed in scenario `rows100k-commit` with `async commit job failed: No rows to import`.
- Root cause: async job payload sanitization removed large `rows` payloads even when no `csvText/csvFileId` fallback existed.

This design defines a parallel implementation path to finish attendance hardening without blocking other lanes.

## 2. Scope
In scope:
- Import perf contract hardening (`payload_source`, `csv_rows_limit_hint`, upload intent/effective traceability).
- Async import reliability fix for rows-only large payloads.
- Regression guardrails in integration test + E2E assertion expansion.
- Evidence-first delivery docs for reproducible verification.

Out of scope:
- Payroll.
- Non-attendance domains.

## 3. Parallel Lanes

### A. Gate & Workflow Contracts
- Baseline/Longrun workflows accept and propagate:
  - `payload_source=auto|csv|rows`
  - `csv_rows_limit_hint`
- Longrun scenario gating is made payload-aware:
  - `PAYLOAD_SOURCE=csv`: keep CSV row cap behavior.
  - `PAYLOAD_SOURCE=auto|rows`: do not incorrectly skip large-row scenarios.
- Post-merge contract gate validates perf metadata fields:
  - `uploadCsvRequested`
  - `payloadSource`

### B. Backend Import Consistency
- Fix async payload sanitizer rule:
  - Keep `rows`/`entries` when they are the only source.
  - Only drop them when `csvText` exists (or `csvFileId` is already present and canonical).
- Add integration regression case:
  - `rows > 5000` + `commit-async` + idempotent retry without `commitToken`.
  - Poll job completion and rollback.

### C. Frontend/Verification UX
- Extend full-flow script assertions:
  - Add `ASSERT_ADMIN_RULE_SAVE` (default true).
  - Verify Default Rule save cycle transitions (`Save rule` -> optional `Saving...` -> recover enabled).

## 4. Key Design Decisions
1. **Payload source is explicit, not inferred downstream**
   - Avoids false assumptions in longrun orchestration.
2. **Do not delete the sole source of import rows**
   - Queue payload compaction must never break semantic correctness.
3. **Contracts must be machine-checkable**
   - Post-merge verification checks perf summary fields, not just job success.
4. **Evidence should be first-class artifacts**
   - Run IDs + local artifact paths are documented for replay/audit.

## 5. DoD for This Parallel Stage
1. Integration test file passes with new regression case.
2. Perf workflow contract changes merged and executable.
3. Regression root cause fixed in plugin runtime payload sanitizer.
4. Design/development MDs present with commands, run IDs, artifact paths.

## 6. Risk & Mitigation
- Risk: longrun run on branch still hits old production backend.
  - Mitigation: verify by integration test pre-merge; rerun longrun post-merge/deploy.
- Risk: payload compaction logic drift in future edits.
  - Mitigation: keep rows>5000 async integration test as permanent guard.

## 7. Verification Evidence (Current)
- Baseline PASS: `attendance-import-perf-baseline.yml` run `22803281301`
- Longrun pre-fix FAIL evidence: run `22803281293`
  - failure log: `output/playwright/ga/22803281293/.../rows100k-commit/perf.log`
