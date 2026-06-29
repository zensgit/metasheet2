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

### 3.1 Recommended fork: sticky marker + survive-but-flag

Recommended fork: **(a) sticky marker at the shared upsert chokepoint + (iii) survive-but-flag on material fact divergence**.

AE-1b should add a small durable marker to `attendance_records.meta` when AE-1 applies a correction:

```json
{
  "manual_result_edit": {
    "version": 1,
    "auditId": "attendance_record_result_edits.id",
    "idempotencyKey": "client key",
    "targetStatus": "normal",
    "correctedMetrics": {
      "workMinutes": 480,
      "lateMinutes": 0,
      "earlyLeaveMinutes": 0
    },
    "correctedAgainst": {
      "workDate": "2026-06-29",
      "firstInAt": "2026-06-29T01:35:00.000Z",
      "lastOutAt": "2026-06-29T10:00:00.000Z",
      "isWorkday": true
    },
    "editedAt": "2026-06-29T00:00:00.000Z",
    "actorUserId": "admin-user-id",
    "reviewConflict": null
  }
}
```

This marker is not the audit log. The immutable audit table remains canonical for reason, evidence, before/after snapshots, notification fields, and idempotency history. The marker is only a compact routing fact: "this row's current result was intentionally corrected by an admin."

`correctedAgainst` is the material fact fingerprint the correction was made against. v1 should include the fields that can re-derive attendance status through the shared upsert path: `workDate`, `firstInAt`, `lastOutAt`, and `isWorkday`. If runtime later proves leave/overtime minutes can also silently change the corrected result through a no-override recompute, those minutes must join the fingerprint in the same PR.

### 3.2 Recompute contract

If an existing `attendance_records` row has `meta.manual_result_edit`:

- A derived writer with **no explicit `statusOverride`** MUST NOT silently replace the corrected status/metrics.
- The default behavior is **preserve the corrected result**:
  - keep existing `status`;
  - keep existing corrected `work_minutes`, `late_minutes`, `early_leave_minutes`;
  - keep `meta.manual_result_edit`;
  - allow raw punch fields and unrelated safe metadata additions to update only when they do not rewrite the corrected metrics/status.
- If the incoming raw facts materially diverge from `correctedAgainst`, the write still **survives** and preserves the corrected result, but it must set `meta.manual_result_edit.reviewConflict` so the correction can be re-reviewed.
- An intentional writer with an explicit `statusOverride` is not treated as a silent recompute. It may replace the result when it is already an authorized write path, but it must be explicit and test-covered.
- A future broad "closed-cycle freeze" or "manual result lock across all writers" can be designed later. AE-1b does not make every write immutable forever.

This keeps the fix narrow: protect a corrected fact from accidental recomputation, without redesigning import semantics or approval recomputation.

### 3.3 Conflict semantics

AE-1b chooses **survive-but-flag**, not fail-closed:

1. A no-override recompute may update raw facts such as `first_in_at` / `last_out_at` when that writer is otherwise authorized.
2. It must preserve the corrected result fields (`status`, `work_minutes`, `late_minutes`, `early_leave_minutes`).
3. If the incoming material fact fingerprint differs from `manual_result_edit.correctedAgainst`, it must set:

```json
{
  "manual_result_edit": {
    "reviewConflict": {
      "state": "needs_review",
      "detectedAt": "2026-06-29T12:00:00.000Z",
      "source": "derived_recompute",
      "attemptedDerivedStatus": "late",
      "latestFacts": {
        "firstInAt": "2026-06-29T01:50:00.000Z",
        "lastOutAt": "2026-06-29T10:00:00.000Z",
        "isWorkday": true
      }
    }
  }
}
```

`reviewConflict` is a durable review signal, not a hard stop. Existing hard stops still compose normally: the AE route's edit window and closed/archived-cycle guards continue to block new manual edits; this conflict flag does not bypass them. A future UI slice can surface the flag, but AE-1b runtime must already write it.

### 3.4 Explicit override semantics

AE-1b should distinguish three cases:

| Incoming write | Existing marker | v1 behavior |
|---|---:|---|
| Derived compute, no `statusOverride` | yes | preserve corrected result; if material facts changed, set `reviewConflict` |
| AE route replay / new AE edit | yes/no | AE helper remains authoritative; writes a new/updated marker for the new audit row |
| Existing admin/import/approval path with explicit `statusOverride` | yes | allowed only if that path already has authority; either replace marker with a new explicit source marker or clear it deliberately |

The last row is intentionally not a back door for ordinary recompute: the code must make the intent visible in tests.

## 4. Implementation shape for AE-1b runtime

AE-1b runtime should be a later PR with this rough shape:

1. Add helper functions:
   - `buildManualResultEditMarker(editRow, targetStatus)`
   - `hasManualResultEditMarker(meta)`
   - `buildManualResultEditFactFingerprint(rowOrValues)`
   - `detectManualResultEditConflict(existingMarker, incomingValues)`
   - `shouldPreserveManualResultEdit(existingRow, incomingOptions)`
2. Extend `applyAttendanceResultEdit` so the `upsertAttendanceRecord` call passes `meta.manual_result_edit` tied to the inserted audit row, or performs a second same-transaction metadata update after the audit row id exists.
3. Extend `computeAttendanceRecordUpsertValues` or the `upsertAttendanceRecord` wrapper to preserve corrected facts when:
   - `existingRow.meta.manual_result_edit` exists; and
   - the incoming write does not carry an explicit result override intent.
4. When preserving a corrected fact, compare the incoming material fact fingerprint with the marker's `correctedAgainst`; if it differs, set `reviewConflict.state='needs_review'`.
5. Keep late-tier meta consistent with the preserved corrected metrics. A preserve path must not recompute tiers from stale derived lateness.
6. Preserve the existing AE-1 closed/archived-cycle guard unchanged.

Open implementation detail for the runtime PR: whether the marker is written in the first upsert (without audit id, then patched after insert) or after the audit insert in the same transaction. Either is acceptable if the final row and audit row commit atomically.

## 5. Verification matrix

AE-1b runtime must add real-DB tests. Minimum matrix:

| Case | Setup | Action | Expected |
|---|---|---|---|
| Core durability, same facts | Seed `late`, AE edit `late -> normal` | Drive a no-`statusOverride` recompute through the shared upsert path with the same material facts | record stays `normal`; corrected metrics preserved; marker persists; no conflict flag |
| Core durability, changed facts | Seed `late`, AE edit `late -> normal` | Drive a no-`statusOverride` recompute with materially changed punches | record stays `normal`; raw facts may update; corrected metrics preserved; `reviewConflict.state='needs_review'` |
| Import derived row | Seed edited record | Import/update a row with punches but no explicit status | import does not silently restore `late`; conflict flag reflects whether facts changed |
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
2. **Conflict semantic**: choose survive-but-flag. A no-`statusOverride` recompute preserves the corrected result; if material facts changed, it sets `reviewConflict` instead of silently clobbering or hard-blocking.
3. **Explicit override behavior**: existing explicit-status write paths may intentionally supersede the marker, but must do so visibly and with tests.
4. **Scope boundary**: no UI/notification/staging or broad closed-cycle freeze in AE-1b.

Recommended answer: ratify all four as written, then build AE-1b runtime as one backend PR with the real-DB matrix above.
