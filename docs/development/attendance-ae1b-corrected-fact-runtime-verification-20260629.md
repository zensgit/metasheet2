# Attendance AE-1b corrected-fact durability — runtime verification

> Date: 2026-06-29
> Baseline: `origin/main@2621b50d7` (`#3371` RATIFIED)
> Slice: AE-1b runtime only — sticky corrected-fact marker + survive-but-flag. No UI, no notification, no staging, no broad closed-cycle/freeze.

## 1. Writer inventory gate

The ratified design requires every current `attendance_records.status` writer / status-choosing site to be classified before runtime can claim durability. This inventory was taken from `plugins/plugin-attendance/index.cjs` in the AE-1b runtime branch.

| Site | Classification | AE-1b handling |
|---|---|---|
| `computeAttendanceRecordUpsertValues` (`statusOverride ?? finalMetrics.status`) | canonical status-choosing helper | marker-aware in this PR: no-`statusOverride` recompute preserves corrected result; changed facts set `manual_result_edit.reviewConflict` |
| `upsertAttendanceRecord` single-row SQL (`status = EXCLUDED.status`) | SQL sink fed by the canonical helper | covered because values are computed by the marker-aware helper |
| `batchUpsertAttendanceRecordsValues` / `Unnest` / `Staging` (`status = EXCLUDED.status`) | SQL sinks for bulk import, fed by rows built from the canonical helper | covered because import prefetches existing rows, calls `computeAttendanceRecordUpsertValues`, then batch-upserts the resulting rows |
| Import commit bulk path around the existing-row prefetch and `computeAttendanceRecordUpsertValues` calls | clobber-capable no-override writer | covered by helper and by the new real-DB import recompute regression |
| Import commit direct `upsertAttendanceRecord` paths | clobber-capable no-override writer | covered by helper; same marker-aware behavior applies through `upsertAttendanceRecord` |
| Punch route `upsertAttendanceRecord` | clobber-capable no-override writer | covered by helper; a later punch may update raw facts but cannot silently overwrite a corrected result |
| Approved request recompute (`statusOverride: 'adjusted'` / `'off'`) | explicit intentional override | not treated as silent recompute; explicit override clears stale manual marker unless a caller supplies a fresh one |
| AE-1 route (`statusOverride: targetStatus`) | explicit manual correction writer | writes a fresh marker after the immutable audit row is inserted, in the same transaction |
| `generateAbsenceRecords` | insert-only for missing rows (`NOT EXISTS`) | not a clobber risk for an existing corrected row |
| Import preview status calculations (`status: statusOverride ?? computed.status`, `status: finalMetrics.status`) | preview-only response, does not write `attendance_records` | not a clobber risk |
| Auto-shift run/run-item status updates and request/outbox status updates | different tables | not a clobber risk |

Result: no unclassified `attendance_records.status` writer remains for this slice.

## 2. Runtime behavior

When AE-1 applies an edit, it now stores a compact marker on `attendance_records.meta.manual_result_edit` after the immutable audit row is inserted:

- audit id and idempotency key;
- target status;
- corrected metrics;
- `correctedAgainst` material fact fingerprint (`workDate`, `firstInAt`, `lastOutAt`, `isWorkday`);
- actor/timestamp;
- `reviewConflict: null`.

When a later writer reaches the shared upsert helper with no explicit `statusOverride`, the helper:

1. allows raw facts such as `first_in_at` / `last_out_at` to update;
2. preserves the corrected status and corrected metrics;
3. recomputes late-tier meta from the preserved corrected lateness;
4. compares the latest fact fingerprint to `correctedAgainst`;
5. sets `reviewConflict.state='needs_review'` when the facts diverged.

Explicit `statusOverride` remains an intentional override and clears a stale marker unless the caller supplies a fresh marker. AE-1 itself writes a new marker after audit insert.

## 3. Verification

Added tests:

- Unit: `attendance-result-edit-durability.test.ts`
  - same facts: corrected result preserved, no conflict flag;
  - changed facts: corrected result preserved, `reviewConflict` written;
  - explicit status override: intentional override clears stale marker.
- Real DB / route: `attendance-result-edit.test.ts`
  - AE-1 successful edit stamps `manual_result_edit` on the record;
  - same-facts import recompute preserves the corrected result without `reviewConflict`;
  - changed-facts import recompute preserves the corrected result and writes `reviewConflict`;
  - the preserved path keeps late-tier meta consistent with corrected lateness, not the newly-derived stale lateness;
  - explicit import `status` override intentionally supersedes and clears a stale marker;
  - approved request recompute (`statusOverride: adjusted`) intentionally supersedes and clears a stale marker;
  - unmarked records keep route-derived behavior and never gain a marker;
  - AE idempotency replay returns `alreadyApplied` without changing the marker/audit id;
  - closed/archived cycle tests continue to prove the hard stop remains outside and above the soft conflict flag.

Expected CI gate: `test (20.x)` runs the real-Postgres attendance integration suite; the import recompute regression must execute there, not skip.
