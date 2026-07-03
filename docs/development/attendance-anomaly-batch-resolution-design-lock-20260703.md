# Attendance batch anomaly resolution — design lock (PROPOSED)

> Date: 2026-07-03
> Baseline: `origin/main@43e7e704c` (post MP-6 staging-smoke prep #3527 and AE-3 runtime line).
> Status: **PROPOSED**. This document is a design lock only. It does not authorize runtime, backend schema, staging closeout, or production enablement. Runtime remains a separate owner-reviewed PR after ratification.

## 1. Why this slice exists

The post-H2 attendance tracker has the core engines closed. The remaining benchmark-surpass work is last-mile operator ergonomics. `docs/research/attendance-humanization-opportunities-20260622.md` row #4 identifies a high-value gap: desktop admins can select multiple anomaly rows and apply the same resolution in one flow.

MetaSheet now has a mature single-row correction path:

- AE-1: `POST /api/attendance/anomaly-result-edits` writes one immutable audit row and updates one `attendance_records` row.
- AE-1b: `meta.manual_result_edit` preserves the correction across recompute and flags material fact divergence.
- AE-2 / AE-2.1: the affected employee notification is employee-only and honors `notifyAffectedEmployee`.
- AE-3: the admin modal exposes the single-row correction safely from anomaly rows.

The batch slice should improve the desktop workflow without inventing a second correction model.

## 2. Grounded current code

Observed on `origin/main@43e7e704c`:

| Anchor | Location | Current behavior |
|---|---|---|
| Anomaly list API | `GET /api/attendance/anomalies` in `plugins/plugin-attendance/index.cjs` | returns one page of anomaly rows for one target user/range; returned rows do not carry `userId`; no batch mutation route exists |
| Single correction route | `POST /api/attendance/anomaly-result-edits` in `plugins/plugin-attendance/index.cjs` | `attendance:admin`, one `recordId`, one audit row, one idempotency key, reason/evidence validation, edit-window and closed-cycle guards |
| Correction implementation | `applyAttendanceResultEdit()` in `plugins/plugin-attendance/index.cjs` | writes `attendance_record_result_edits`, updates the record through the shared builder, stamps `manual_result_edit`, and optionally enqueues one affected-employee notification |
| AE-3 UI | `apps/web/src/views/AttendanceView.vue` | row-level modal calls the single correction route; it does not send metric overrides |
| Request-center parity | `apps/web/src/views/attendance/AttendanceRequestCenterSection.vue` + `apps/web/tests/AttendanceRequestCenterSection.result-edit.spec.ts` | component-level contract accepts parent-provided result-edit callbacks and forwards them; current production mounting is not asserted by this design |
| Guard workflow | `.github/workflows/attendance-web-guard.yml` | runs targeted attendance UI specs, including AE-3 modal and request-center parity |
| Benchmark input | `docs/research/attendance-humanization-opportunities-20260622.md` row #4 | desktop batch anomaly processing is still a gap; mobile batch edit is explicitly out of scope |

## 3. Product scope

### 3.1 V1 behavior

Add a desktop-only batch affordance on the currently loaded anomaly rows:

1. Admin selects multiple eligible anomaly rows with checkboxes.
2. Admin opens one batch-resolution modal.
3. Admin chooses one `targetStatus`, one `reason`, and optional evidence references.
4. Runtime submits one correction per selected row through the existing single-row route.
5. UI shows per-row success/failure results and refreshes the anomaly/record/summary surfaces after the batch finishes.

This is a UI workflow improvement, not a new accounting primitive.

Because today's anomaly read surface is target-user scoped, this v1 closes the
"batch multiple rows/dates" workflow first. It must not claim true cross-employee
batch processing until a later read-surface slice expands
`GET /api/attendance/anomalies` to return multiple users with explicit `userId`
and scheduler-scope/access semantics. The UI copy should say "selected anomaly
rows" rather than "selected employees" unless that read-surface slice has landed.

### 3.2 Out of scope

V1 does not add:

- a backend `bulk` anomaly-result-edit endpoint;
- a new table or migration;
- all-or-nothing multi-record transaction semantics;
- metric override editing;
- manager/sub-admin notification fan-out;
- mobile batch handling;
- cross-employee anomaly-list expansion;
- cross-user permission expansion;
- staging PASS claims.

Any backend batch endpoint is a later design because it would need its own idempotency grain, audit outcome table, partial-failure contract, transaction boundaries, and possibly rate limiting.

## 4. Runtime contract

### 4.1 Reuse the single-row route

Every selected row must call:

```http
POST /api/attendance/anomaly-result-edits
```

with the same shape AE-3 uses:

```json
{
  "orgId": "default",
  "recordId": "row-record-id",
  "targetStatus": "normal",
  "reason": "trimmed shared reason",
  "evidence": [],
  "idempotencyKey": "batch-open-generated-key-for-this-row"
}
```

The batch UI must not call an unreviewed backend endpoint and must not send `overrideMetrics` in v1.

### 4.2 Idempotency

The batch modal freezes a snapshot when opened:

```ts
{
  batchClientId,
  rows: [
    {
      recordId,
      workDate,
      targetUserId,
      sourceStatus,
      request,
      warnings,
      idempotencyKey
    }
  ]
}
```

`idempotencyKey` is generated per selected row at modal open. Retrying a failed network submit from the same open modal reuses that row's key. Closing and reopening the modal generates new keys.

The key must include no employee PII beyond the existing random/idempotency material. The server remains final authority for duplicate detection. `targetUserId` is the committed query target for the loaded anomaly list; it is not a row-level identity from the current API.

### 4.3 Execution model

V1 executes sequentially with a small UI cap:

- maximum selected rows: **50**;
- rows are submitted one at a time;
- already-succeeded rows are not retried by the same modal;
- a row failure does not hide other row results;
- the final batch state is `completed_with_errors` when any row fails.

Sequential execution is deliberate: it keeps backend load bounded, preserves readable audit order, and avoids a new concurrency contract. A later backend batch endpoint may choose a different model.

### 4.4 Eligibility

The selectable set reuses AE-3 eligibility:

- source status must be one of `late`, `early_leave`, `late_early`, `partial`, `absent`;
- row must not be `state === 'pending'`;
- `attendanceResultEditPolicy.enabled` must not be false;
- explicit admin correction capability must be allowed;
- row must have a `recordId`.

Rows that are visible but not eligible remain visible and unselected, with disabled copy. Selection is cleared synchronously when `loadAnomalies()` starts or when date/org/user filters change.

### 4.5 Result semantics

The batch result is a UI aggregate over single-row results:

| Row outcome | UI handling |
|---|---|
| `ok` / `alreadyApplied` | mark row success and show returned edit id + notification outcome |
| `VALIDATION_ERROR` | row failure; keep reason/evidence form open for retry if no row succeeded with stale keys |
| `ATTENDANCE_RECORD_NOT_FOUND` | row failure; mark stale and require anomaly reload |
| `ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE` | row failure; mark stale/non-editable and require reload |
| `ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED` | row failure; show edit-window copy |
| `ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED` | row failure; show closed-cycle copy |
| `ATTENDANCE_RESULT_EDIT_IDEMPOTENCY_CONFLICT` | row failure; do not auto-generate a new key inside the same modal |
| `DB_NOT_READY` / 5xx | row failure; no optimistic success |

The UI must not present the whole batch as successful unless every row succeeded or returned `alreadyApplied`.

## 5. Audit, notification, and durability invariants

Batch processing must preserve the invariants that AE-1 through AE-3 already proved:

- one selected row leads to at most one `attendance_record_result_edits` audit row per idempotency key;
- notifications remain employee-only and still honor `notifyAffectedEmployee`;
- `manual_result_edit` marker stamping is unchanged;
- `reviewConflict.state='needs_review'` behavior on later recompute is unchanged;
- closed-cycle/edit-window/source-status guards remain backend-authoritative;
- each row's audit reason/evidence is the shared batch reason/evidence, not hidden or synthetic.

The batch UI is not allowed to coalesce multiple records into one audit event in v1.

## 6. UI design contract

### 6.1 Placement

Batch controls live on the anomaly table surface, not in a new admin section:

- add row checkboxes to the desktop anomaly list;
- add a toolbar action `Batch resolve / 批量处理`;
- keep AE-3's single-row `Edit result / 修改结果` action.

If both the inline overview anomaly table and `AttendanceRequestCenterSection` are mounted/expose anomaly rows in the runtime PR, runtime must either:

1. wire both to the same batch controller; or
2. explicitly choose one canonical desktop surface and not show the batch affordance on the other.

Silent surface drift is not allowed.

### 6.2 Modal contents

The modal shows:

- selected count;
- a compact preview list of selected rows: target user (from the committed filter), dates, and current statuses;
- target status select;
- shared reason textarea;
- shared evidence label/URL inputs;
- a warning that rows are processed individually and failures are reported per row.

Reason/evidence follows AE-3 validation rules. If policy requires reason and settings are unavailable, the UI defaults to reason-required.

### 6.3 Stale-state clearing

Runtime must clear selection, modal, and per-row batch result state synchronously when:

- `loadAnomalies()` starts;
- date/org/user filters change;
- target user changes;
- mode changes away from the anomaly surface.

This is a hard gate, not a cosmetic nicety. The MP-5 stale-error lesson applies: final UI state tests must prove a row selected in range A cannot be submitted after switching to range B.

## 7. Verification plan

Runtime PR acceptance gates:

1. **No backend route/schema diff**: `plugins/plugin-attendance/index.cjs` must not add an anomaly batch endpoint in this slice.
2. **Single-row route reuse**: tests assert N selected rows produce N calls to `/api/attendance/anomaly-result-edits`, each with a distinct per-row `idempotencyKey`.
3. **Eligibility gate**: pending, non-editable, policy-disabled, missing capability, and missing-record-id rows cannot be selected.
4. **Cap gate**: selecting more than 50 rows disables submit with clear copy.
5. **Partial failure**: one row success + one row backend error renders mixed results and does not claim full success.
6. **No optimistic success**: failed rows do not disappear or mutate locally before reload.
7. **Stale-state gate**: changing date/user/range clears selection and modal state synchronously.
8. **Request-center parity**: if the extracted request-center anomaly surface exposes batch controls, it must use the same callback/controller; otherwise the runtime PR must document why the batch affordance is intentionally only on the canonical surface.
9. **Attendance web guard**: any new/changed frontend specs that protect this behavior must be added to `.github/workflows/attendance-web-guard.yml`; no skip-shaped green.
10. **Copy safety**: no competitor brand names in runtime UI; benchmark references stay in docs/research or this design-lock.
11. **No multi-user overclaim**: unless the runtime PR also adds and verifies a multi-user anomaly read surface, labels/tests must prove the batch is over selected anomaly rows in the current target-user view, not "selected employees".

Suggested focused tests:

- `attendance-admin-regressions.spec.ts`: selection, cap, sequential submits, partial failure, stale clearing.
- `AttendanceRequestCenterSection.result-edit.spec.ts` or a new paired spec: callback parity / explicit non-exposure.
- A pure helper test if the batch-controller state is extracted from `AttendanceView.vue`.

## 8. Rollout / staging

This is an admin UI workflow over a route already covered by AE-4 staging. Runtime can merge after frontend guard + required CI, but #3317 remains open and this slice does not produce a staging PASS.

If the operator wants end-to-end browser proof, add it as an optional AE-4 addendum after the existing AE-4/RD-4-5/OT-bank/v1-8/MP-6 window plan; do not block the current prepared staging window on this new polish.

## 9. Owner decisions before runtime

Recommended defaults for ratification:

1. **Backend shape:** UI-orchestrated per-row calls in v1; no backend batch endpoint.
2. **Max rows:** 50 selected rows per modal.
3. **Failure semantics:** partial success allowed and displayed per row; no all-or-nothing claim.
4. **Surface:** expose on the desktop anomaly table; request-center parity required if that surface shows the control.
5. **Metrics:** no metric overrides in v1.
6. **Staging:** no new staging gate before merge; optional AE-4 addendum only after the current window is closed.
7. **Read-surface scope:** v1 is current-loaded-row batching; true cross-employee batch processing is a separate read-surface + authorization design.

Owner ratification flips this document to RATIFIED and unlocks a separate frontend runtime PR.
