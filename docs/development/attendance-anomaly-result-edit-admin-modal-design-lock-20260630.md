# Attendance AE-3 — admin anomaly-correction modal — design lock (PROPOSED)

> Date: 2026-06-30
> Baseline: `origin/main@a07e6be07` (`#3416` merged). AE-1 route, AE-1b durability, and AE-2 employee notification are on main; AE-2.1 notification-toggle honoring is open as `#3419` and must land, or be replaced by an equivalent fix, before the AE-3 runtime merges.
> Status: **PROPOSED**. This document locks the UI contract for AE-3 only. It does not authorize runtime code, staging, new backend mutation semantics, manager fan-out, or a new admin-rail section. Runtime remains a separate owner-reviewed PR after this lock is ratified.

## 1. Why this slice exists

The backend correction loop is now mature:

- AE-1: `POST /api/attendance/anomaly-result-edits` corrects one anomaly, writes `attendance_record_result_edits`, and keeps the write idempotent.
- AE-1b: `meta.manual_result_edit` makes the corrected fact durable across no-override recompute and flags material fact divergence.
- AE-2: the corrected employee receives one notification through the existing attendance delivery pipeline.

The operator surface is still incomplete. Current UI can show anomaly rows and prefill a request form, but an admin cannot apply the audited correction from the app. AE-3 closes that gap with a narrow modal on existing anomaly rows.

AE-3 is not a new write model. It is a safe UI around the already-reviewed route.

## 2. Grounded current code

Observed on `origin/main@a07e6be07`:

| Anchor | Location | Current behavior |
|---|---|---|
| Inline anomalies table | `apps/web/src/views/AttendanceView.vue` around the overview anomalies table | row action only calls `prefillRequestFromAnomaly(item)` / "Create request" |
| Extracted request center | `apps/web/src/views/attendance/AttendanceRequestCenterSection.vue` | has a second anomalies table with the same create-request action |
| Mounted location | the inline anomalies table is under `showOverview`, not the admin rail | an admin write action cannot be gated only by `showAdmin`; it needs a capability probe that also works in overview mode |
| Request prefill helper | `prefillRequestFromAnomaly(item)` in `AttendanceView.vue` | blocks pending rows and scrolls to the request form |
| Load path | `loadAnomalies()` in `AttendanceView.vue` | `GET /api/attendance/anomalies` with date/org/user filters |
| Backend route | `POST /api/attendance/anomaly-result-edits` in `plugins/plugin-attendance/index.cjs` | admin-only, idempotent, audited, closed-cycle/edit-window guarded |
| Admin settings | `attendanceResultEditPolicy` in attendance settings | `enabled`, `editWindowDays`, `requireReason`, `notifyAffectedEmployee` |
| Existing modal pattern | missed-punch reminder and annual-leave operations in `AttendanceView.vue` | in-DOM `role="dialog"` overlay; no `window.confirm` |
| Admin rail | `apps/web/src/views/attendance/useAttendanceAdminRail.ts` | no anomaly-correction section today |

The two anomaly surfaces are the important duplication. AE-3 must either wire both to the same modal callback, or explicitly declare one canonical surface and hide the other action. Leaving one surface with "Edit result" and the other without it is drift.

## 3. AE-3 decisions

### 3.1 Placement — row action, not a new admin section

AE-3 adds an `Edit result / 修改结果` action beside the existing `Create request` action on anomaly rows. It does **not** add a new admin-rail section.

Implications:

- No `ATTENDANCE_ADMIN_SECTION_IDS` entry.
- No admin anchor-nav count bump.
- No new dashboard/landing page.
- The action lives where the record-level context already exists: the anomaly row.

The action is admin-only, but the anomaly table is currently mounted in the **overview** surface. Runtime must therefore introduce an explicit capability predicate usable from overview mode, for example `canEditAttendanceAnomalyResult`, derived from the same admin/settings authority check that protects the route. It must **not** use `showAdmin` alone as the gate, because `showAdmin` describes the admin tab/rail visibility, not whether an overview-row action can call an admin route.

In the extracted `AttendanceRequestCenterSection.vue`, the parent passes this explicit capability/callback; the component must not infer admin permission on its own.

Backend authorization remains final: a direct call without `attendance:admin` still returns the route's existing 403.

### 3.2 Eligibility and disabled copy

The UI should mirror the backend's coarse guardrails without pretending to be authoritative.

Editable source statuses:

- `late`
- `early_leave`
- `late_early`
- `partial`
- `absent`

Non-editable sources:

- `normal`
- `off`
- `adjusted`
- any unknown status

Target statuses in the modal:

- `normal`
- `late`
- `early_leave`
- `late_early`
- `partial`
- `absent`
- `adjusted`

The button should be disabled, with visible inline copy, when:

- the row has `state === 'pending'`;
- the source status is not editable;
- the known `attendanceResultEditPolicy.enabled` is false;
- admin capability is missing.

The UI may also show an edit-window hint from `editWindowDays`, but it must not use client-side date math as the final authority. The backend's `ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED` remains decisive.

### 3.3 Modal contents

The modal is an in-DOM dialog, not `window.confirm`.

It shows:

- employee/user id as available from the anomaly row;
- work date;
- current status;
- warnings;
- linked request status if present;
- target status select;
- reason textarea;
- evidence-reference inputs.

Evidence v1 remains metadata-only. The modal can support one or more evidence rows with:

- `type`;
- `label`;
- `url` or `attachmentId` if the backend accepts it.

The UI must not implement file upload in AE-3.

Reason behavior:

- If `attendanceResultEditPolicy.requireReason !== false`, the submit button is disabled until `reason.trim()` is non-empty.
- If settings are unavailable, the UI should default to requiring reason; backend validation remains final.
- Submitted reason is trimmed.

### 3.4 Snapshot and idempotency

Opening the modal freezes a snapshot:

```ts
{
  recordId,
  workDate,
  sourceStatus,
  warnings,
  request,
  idempotencyKey
}
```

The submit handler must consume this modal snapshot, not re-read a live reactive anomaly row at submit time. This prevents a TOCTOU class where the row changes after review but the UI submits a never-reviewed record/status.

`idempotencyKey` is generated when the modal opens and reused for retries from the same modal instance. It is reset when the modal closes or a new anomaly row is opened.

### 3.5 Submit contract

AE-3 calls:

```http
POST /api/attendance/anomaly-result-edits
```

with:

```json
{
  "orgId": "default",
  "recordId": "uuid-from-snapshot",
  "targetStatus": "normal",
  "reason": "trimmed reason",
  "evidence": [],
  "idempotencyKey": "modal-open-generated-key"
}
```

The modal must not send raw metric overrides in v1 unless a later owner-ratified UI slice explicitly exposes them. AE-3 v1 is result correction, not payroll-minute editing.

### 3.6 Success and refresh behavior

On success:

- render the returned `edit.id`, `beforeStatus`, `afterStatus`, and notification outcome (`notificationDeliveryId` or `notificationSkippedReason`) if present;
- clear modal error state;
- close or move the modal into a success state only after the response is received;
- refresh `loadAnomalies()`, `loadRecords()`, and `loadSummary()`;
- refresh request report only if the runtime confirms it reads affected status totals;
- refresh notification deliveries if that admin section is currently active, or mark it stale for the next load.

The anomalies table must clear stale modal/result state when the date/org/user filter changes or `loadAnomalies()` starts. This is a runtime acceptance gate, not only a UX nicety: an open modal or success/error state for range A must disappear synchronously when range B starts loading.

### 3.7 Error behavior

Error mapping should be explicit:

| Backend code | UI behavior |
|---|---|
| `VALIDATION_ERROR` | keep modal open; show field-level/general error |
| `ATTENDANCE_RESULT_EDIT_DISABLED` | keep modal open; show policy-disabled copy and disable submit |
| `ATTENDANCE_RECORD_NOT_FOUND` | close stale row context after user acknowledgement or reload anomalies |
| `ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE` | keep modal open with non-editable source copy; reload anomalies |
| `ATTENDANCE_RESULT_EDIT_NORMAL_TO_ABNORMAL_UNSUPPORTED` | keep modal open; target/source guard copy |
| `ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED` | keep modal open; edit-window copy; reload anomalies optional |
| `ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED` | keep modal open; closed-cycle copy |
| `ATTENDANCE_RESULT_EDIT_IDEMPOTENCY_CONFLICT` | disable retry for that modal key; generate a new key only after closing/reopening |
| `DB_NOT_READY` | fail closed; no optimistic success state |

AE-3 must never optimistically mutate a row before the backend response.

## 4. Runtime dependency gates

AE-3 runtime must not merge until:

1. AE-1b is on main. Already true via `#3377`.
2. AE-2 employee notification runtime is on main. Already true via `#3413`.
3. AE-2.1 notification-toggle honoring is on main, or an equivalent fix exists. As of this lock's baseline, `#3419` is open/clean but not merged.
4. This AE-3 design-lock is ratified.

If the owner decides to proceed before #3, the runtime PR must explicitly re-state that `notifyAffectedEmployee` may be ignored. The recommended path is to wait for #3419.

## 5. Implementation shape for AE-3 runtime

Expected frontend-only shape:

1. Extend the anomaly row action model with `openResultEditModal(item)`.
2. Add modal state in `AttendanceView.vue`:
   - `open`;
   - frozen row snapshot;
   - target status;
   - reason;
   - evidence references;
   - idempotency key;
   - submitting/error/result.
3. Pass the same capability/action into `AttendanceRequestCenterSection.vue` so both anomaly tables use the same modal.
4. Add an in-DOM modal block using existing `.attendance__modal` patterns.
5. Submit through `apiFetch('/api/attendance/anomaly-result-edits', { method: 'POST', ... })`.
6. On success refresh the affected read surfaces (§3.6).

No new backend route, migration, worker, or delivery code belongs in AE-3.

## 6. Verification matrix

AE-3 runtime must include frontend tests. Minimum:

| Case | Assertion |
|---|---|
| Admin-only action | admin-capable render shows `Edit result`; non-admin/self-service render does not expose a write action |
| Overview-capability gate | the existing overview-mounted anomaly table uses an explicit admin capability probe, not `showAdmin` alone; an admin-capable overview can open the modal, while a non-admin overview cannot POST |
| Eligibility disabled copy | pending row / non-editable status / policy disabled disables the button and performs no POST |
| Modal snapshot | open modal for row A, mutate the backing `anomalies` data to row B, submit; POST still uses row A's frozen `recordId` and modal idempotency key |
| Load-start stale clearing | with a modal/result/error open for range A, changing date/org/user or starting `loadAnomalies()` for range B clears the modal/result/error synchronously before the new rows resolve |
| Required reason | when `requireReason` is true or settings are unknown, blank reason blocks submit before network |
| Success path | POST body contains `orgId`, frozen `recordId`, `targetStatus`, trimmed `reason`, `evidence`, and generated `idempotencyKey`; UI refreshes anomalies/records/summary and shows audit/notification outcome |
| Backend error path | 409/422/403 errors keep modal open, show error copy, and do not show stale success |
| Request-center parity | `AttendanceRequestCenterSection.vue` anomaly row can open the same modal/callback; no duplicated business logic |
| No anchor-nav drift | since AE-3 adds no admin section, `attendance-admin-anchor-nav.spec.ts` counts remain unchanged |

If a runtime implementation adds a new admin section anyway, the owner must re-ratify placement and the anchor-nav/web-guard counts must be updated in that same PR.

## 7. Out of scope

- Batch anomaly correction.
- Editing raw punches or payroll minutes.
- Uploading evidence files.
- Notifying managers, owners, or admins.
- Staging smoke (AE-4).
- A new anomaly audit viewer; existing audit/delivery surfaces remain the source of truth.

## 8. Owner decisions to ratify

Recommended defaults:

1. Placement: anomaly-row action in both existing anomaly surfaces; no new admin-rail section.
2. Capability: admin-only UI affordance; backend remains final authority.
3. Submit: no metric overrides in AE-3 v1.
4. Snapshot: modal-open snapshot is authoritative for submit.
5. Dependency: wait for #3419/equivalent before runtime merge.

On owner ratification, flip this document to **RATIFIED** and open the AE-3 runtime PR as a separate slice.
