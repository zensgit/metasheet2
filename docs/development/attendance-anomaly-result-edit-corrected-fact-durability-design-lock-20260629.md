# Attendance AE-1b corrected-fact durability — design lock (PROPOSED)

> Date: 2026-06-29
> Baseline: `origin/main@46dbf4fe4` (`#3303` merged; attendance test hygiene closed)
> Status: 🔶 **PROPOSED / awaiting owner ratification**. This document chooses the durability contract for AE-1b only. It does not authorize runtime code, UI, notifications, staging, or broader payroll-cycle freeze work.

## 1. Why this slice exists

AE-1 is live on main: `POST /api/attendance/anomaly-result-edits` lets an attendance admin correct one confirmed anomaly result, writes an immutable `attendance_record_result_edits` audit row, and updates `attendance_records` through `upsertAttendanceRecord` / `computeAttendanceRecordUpsertValues` rather than a naked status update.

The remaining correctness gap is durability of the corrected fact:

1. AE-1 can correct a record such as `late -> normal`.
2. The original punches remain on the record.
3. A later derived writer can call the shared upsert path without an explicit manual edit intent.
4. `computeMetrics` re-derives the old result from the preserved punches and silently overwrites the manual correction.

That is a real accounting/customer-trust issue: the audit row says an admin corrected the fact, but the current record can later drift back to the pre-correction result.

Issue `#3317` tracks this as the only open AE correctness item after AE-1. `#3368` made it the next recommended attendance slice after `#3303`.

## 2. Grounded current code

Observed on `origin/main@46dbf4fe4`:

- `applyAttendanceResultEdit` locks the target row, validates source/edit-window/closed-cycle guards, then calls `upsertAttendanceRecord` with `statusOverride: targetStatus` and optional normalized metrics.
- `upsertAttendanceRecord` loads the existing row and delegates to `computeAttendanceRecordUpsertValues`.
- `computeAttendanceRecordUpsertValues` merges `meta`, computes metrics, applies `overrideMetrics`, recomputes late-tier meta, and finally chooses `statusOverride ?? finalMetrics.status`.
- There is no current `meta.manual_result_edit` or equivalent sticky marker.
- Import commit paths can call the same value builder in bulk. They pass `statusOverride` only when the imported row explicitly supplies a status; otherwise the derived status wins.
- Auto-absence inserts missing absent rows only when no attendance record exists; it does not update an existing corrected record today, but it is part of the future recompute surface.
- Approved-request recompute paths call `upsertAttendanceRecord` with explicit `statusOverride` values (`adjusted` / `off`) for current leave/overtime and missed-punch approvals.

The dangerous class is therefore **derived recompute without an explicit override intent**, not every write to `attendance_records`.

## 3. AE-1b decision

### 3.1 Recommended model: sticky corrected-fact marker

AE-1b should add a small durable marker to `attendance_records.meta` when AE-1 applies a correction:

```json
{
  "manual_result_edit": {
    "version": 1,
    "auditId": "attendance_record_result_edits.id",
    "idempotencyKey": "client key",
    "targetStatus": "normal",
    "editedAt": "2026-06-29T00:00:00.000Z",
    "actorUserId": "admin-user-id"
  }
}
```

This marker is not the audit log. The immutable audit table remains canonical for reason, evidence, before/after snapshots, notification fields, and idempotency history. The marker is only a compact routing fact: "this row's current result was intentionally corrected by an admin."

### 3.2 Recompute contract

If an existing `attendance_records` row has `meta.manual_result_edit`:

- A derived writer with **no explicit `statusOverride`** MUST NOT silently replace the corrected status/metrics.
- The default behavior is **preserve the corrected fact**:
  - keep existing `status`;
  - keep existing corrected `work_minutes`, `late_minutes`, `early_leave_minutes`;
  - keep `meta.manual_result_edit`;
  - allow unrelated safe metadata additions only when they do not rewrite the corrected metrics/status.
- An intentional writer with an explicit `statusOverride` is not treated as a silent recompute. It may replace the result when it is already an authorized write path, but it must be explicit and test-covered.
- A future broad "closed-cycle freeze" or "manual result lock across all writers" can be designed later. AE-1b does not make every write immutable forever.

This keeps the fix narrow: protect a corrected fact from accidental recomputation, without redesigning import semantics or approval recomputation.

### 3.3 Explicit override semantics

AE-1b should distinguish three cases:

| Incoming write | Existing marker | v1 behavior |
|---|---:|---|
| Derived compute, no `statusOverride` | yes | preserve corrected fact; do not clobber |
| AE route replay / new AE edit | yes/no | AE helper remains authoritative; writes a new/updated marker for the new audit row |
| Existing admin/import/approval path with explicit `statusOverride` | yes | allowed only if that path already has authority; either replace marker with a new explicit source marker or clear it deliberately |

The last row is intentionally not a back door for ordinary recompute: the code must make the intent visible in tests.

## 4. Implementation shape for AE-1b runtime

AE-1b runtime should be a later PR with this rough shape:

1. Add helper functions:
   - `buildManualResultEditMarker(editRow, targetStatus)`
   - `hasManualResultEditMarker(meta)`
   - `shouldPreserveManualResultEdit(existingRow, incomingOptions)`
2. Extend `applyAttendanceResultEdit` so the `upsertAttendanceRecord` call passes `meta.manual_result_edit` tied to the inserted audit row, or performs a second same-transaction metadata update after the audit row id exists.
3. Extend `computeAttendanceRecordUpsertValues` or the `upsertAttendanceRecord` wrapper to preserve corrected facts when:
   - `existingRow.meta.manual_result_edit` exists; and
   - the incoming write does not carry an explicit result override intent.
4. Keep late-tier meta consistent with the preserved corrected metrics. A preserve path must not recompute tiers from stale derived lateness.
5. Preserve the existing AE-1 closed/archived-cycle guard unchanged.

Open implementation detail for the runtime PR: whether the marker is written in the first upsert (without audit id, then patched after insert) or after the audit insert in the same transaction. Either is acceptable if the final row and audit row commit atomically.

## 5. Verification matrix

AE-1b runtime must add real-DB tests. Minimum matrix:

| Case | Setup | Action | Expected |
|---|---|---|---|
| Core durability | Seed `late`, AE edit `late -> normal` | Drive a no-`statusOverride` recompute through the shared upsert path | record stays `normal`; corrected metrics preserved; marker persists |
| Import derived row | Seed edited record | Import/update a row with punches but no explicit status | import does not silently restore `late` |
| Explicit import override | Seed edited record | Import a row with explicit status | behavior matches the ratified explicit-override policy; no silent clobber |
| Approved-request recompute | Seed edited record, then drive an approval recompute that has explicit `adjusted/off` semantics | result changes only if the existing approval route is intentionally authoritative; marker handling is explicit |
| No marker regression | Seed ordinary record with no marker | Run existing recompute | byte-identical to current behavior |
| AE replay | Same idempotency key | replay returns `alreadyApplied`; marker/audit are not duplicated |
| Closed cycle | Closed/archived payroll cycle | AE edit | existing `409 ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED` still wins |

If a route-level setup is too heavy for a first PR, the helper-level test is acceptable only if it also proves the real route still stamps the marker. A pure unit-only proof is insufficient for this durability bug.

## 6. Out of scope

AE-1b does not include:

- AE-2 employee notification.
- AE-3 admin UI / modal.
- AE-4 staging smoke.
- Changing the ratified `absent -> normal` rule that preserves `work_minutes=0` unless the admin supplies `overrideMetrics.workMinutes`.
- Multi-tenant / org-scoped RBAC changes. The repo is currently documented as single-tenant/global-admin posture for attendance admin routes.
- A platform-wide closed-cycle freeze for punch/import/auto-absence. That is a broader consistency slice.
- Rewriting attendance import UX or requiring every import to understand manual corrections.

## 7. Owner ratification questions

Please ratify or adjust these before runtime:

1. **Sticky marker model**: use `attendance_records.meta.manual_result_edit` as the v1 durability mechanism, with the audit table remaining canonical.
2. **Default derived recompute behavior**: a no-`statusOverride` recompute preserves the corrected fact instead of silently clobbering it.
3. **Explicit override behavior**: existing explicit-status write paths may intentionally supersede the marker, but must do so visibly and with tests.
4. **Scope boundary**: no UI/notification/staging or broad closed-cycle freeze in AE-1b.

Recommended answer: ratify all four as written, then build AE-1b runtime as one backend PR with the real-DB matrix above.
