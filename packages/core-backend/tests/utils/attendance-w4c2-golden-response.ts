/**
 * W4C-2 remediation P1-1 (#4612 gate finding, `attendance-issue-4556-w4c2-remediation-plan-20260726.md`
 * §2.2) — a shared byte-red-line assertion helper for the `legacy_projection_only`
 * live-punch response.
 *
 * The pre-remediation guard was `Object.keys(res.body.data).sort()).toEqual([...])`:
 * a TOP-LEVEL-ONLY key-set check. The gate's MK-2 mutation proved this has zero
 * reach into nested structure or field VALUES: deleting `record.status`, adding an
 * unrelated nested key on `record`, and nulling the entire `workDateResolution`
 * field all left the full 789-test suite green.
 *
 * This module gives both flagged call sites
 * (`attendance-w4c2-posture-matrix.db.test.ts:265`,
 * `attendance-w4c2-live-scheduled-boundary.db.test.ts:244`) a single shared
 * instrument instead of duplicating ad hoc assertions:
 *
 *  - `recursiveKeyPaths` walks plain objects (not arrays — arrays are treated as
 *    leaves; the only array in this response shape,
 *    `workDateResolution.evidenceSnapshot.workDates`, is asserted by length/value
 *    directly at the call site) and returns every `a.b.c`-style key path in the
 *    value, sorted. A leaf key still appears in the path list (e.g. `event.id`),
 *    so both "delete a key" and "add a nested key anywhere in the tree" changes
 *    the returned array — this is what makes the assertion recursive rather than
 *    top-level-only.
 *  - `assertLegacyPunchResponseGoldenShapeV1` combines that recursive key-path
 *    pin with the deterministic-VALUE assertions the gate named explicitly
 *    (`record.status`, `record.work_minutes`, `record.late_minutes`,
 *    `record.first_in_at`, `record.last_out_at`, and the actually-observed
 *    `workDateResolution.kind`/`.reasonCode` — see the module note below on why
 *    `.workDate`/`.shiftId` are not asserted for this fixture shape) — deleting a
 *    key changes the key-path list; adding a key changes the key-path list;
 *    nulling `workDateResolution` collapses its key-path subtree to nothing
 *    AND fails the value assertions; changing one nested value trips a value
 *    assertion without changing the key-path list at all.
 *
 * Both suites' fixtures produce the SAME `workDateResolution` shape today
 * (`{ kind: 'unresolved', reasonCode: 'UNSCHEDULED_NO_SHIFT', evidenceSnapshot:
 * {...} }` — neither fixture assigns the punching user a published shift), so
 * the gate's illustrative `.workDate`/`.shiftId` field names do not exist on
 * EITHER fixture's actual resolution object; this helper asserts the fields
 * that are actually present instead of fabricating ones that are not.
 */
import { expect } from 'vitest'

export type PlainRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  if (value instanceof Date) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Every `a.b.c`-style key path reachable in `value`, sorted. Arrays are leaves
 * (their own path is recorded; their elements are not descended into) so a
 * mutation that swaps an array for an object (or vice versa) still changes the
 * returned path set via the parent key's presence/absence pattern at deeper
 * levels.
 */
export function recursiveKeyPaths(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) return []
  const paths: string[] = []
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    paths.push(path)
    paths.push(...recursiveKeyPaths(value[key], path))
  }
  return paths.sort()
}

/** The exact recursive key-path set for today's legacy live-punch response. */
export const LEGACY_LIVE_PUNCH_GOLDEN_KEY_PATHS_V1: readonly string[] = [
  'event',
  'event.created_at',
  'event.event_type',
  'event.id',
  'event.location',
  'event.meta',
  'event.occurred_at',
  'event.org_id',
  'event.source',
  'event.timezone',
  'event.user_id',
  'event.work_date',
  'record',
  'record.created_at',
  'record.current_calculation_id',
  'record.early_leave_minutes',
  'record.first_in_at',
  'record.id',
  'record.is_workday',
  'record.last_out_at',
  'record.late_minutes',
  'record.meta',
  'record.meta.absence_late_count',
  'record.meta.severe_late_count',
  'record.meta.severe_late_minutes',
  'record.org_id',
  'record.projection_owner',
  'record.source_batch_id',
  'record.status',
  'record.timezone',
  'record.updated_at',
  'record.user_id',
  'record.visibility_reason',
  'record.visibility_state',
  'record.work_date',
  'record.work_minutes',
  'workDateResolution',
  'workDateResolution.evidenceSnapshot',
  'workDateResolution.evidenceSnapshot.calendarWorkDate',
  'workDateResolution.evidenceSnapshot.channel',
  'workDateResolution.evidenceSnapshot.contractConflict',
  'workDateResolution.evidenceSnapshot.workDates',
  'workDateResolution.kind',
  'workDateResolution.reasonCode',
].slice().sort()

export interface LegacyPunchGoldenExpectedValuesV1 {
  readonly userId: string
  readonly status: string
  readonly workMinutes: number
  readonly lateMinutes: number
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workDateResolutionKind: string
  readonly workDateResolutionReasonCode: string
}

/**
 * Recursive key-path pin (catches: delete a key anywhere in the tree, add a
 * key anywhere in the tree, swap an object subtree for `null`) PLUS explicit
 * value assertions on the deterministic fields the gate named (catches:
 * change one nested value without touching the key set).
 */
export function assertLegacyPunchResponseGoldenShapeV1(
  data: PlainRecord,
  expected: LegacyPunchGoldenExpectedValuesV1,
): void {
  expect(recursiveKeyPaths(data)).toEqual([...LEGACY_LIVE_PUNCH_GOLDEN_KEY_PATHS_V1])

  const record = data.record as PlainRecord
  const event = data.event as PlainRecord
  const workDateResolution = data.workDateResolution as PlainRecord

  expect(event.user_id).toBe(expected.userId)
  expect(record.user_id).toBe(expected.userId)
  expect(record.status).toBe(expected.status)
  expect(record.work_minutes).toBe(expected.workMinutes)
  expect(record.late_minutes).toBe(expected.lateMinutes)
  expect(record.first_in_at).toBe(expected.firstInAt)
  expect(record.last_out_at).toBe(expected.lastOutAt)
  expect(workDateResolution.kind).toBe(expected.workDateResolutionKind)
  expect(workDateResolution.reasonCode).toBe(expected.workDateResolutionReasonCode)
}
