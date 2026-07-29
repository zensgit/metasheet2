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

/**
 * W4C-2 remediation P2-1 (#4612 gate2 finding, exact-head `ad5541027`): the
 * `resolved` counterpart of the pin above. The gate's M10 mutation
 * (`calendarWorkDate` shifted a whole day at `index.cjs`
 * `deriveLegacyLivePunchAttributionV1`) proved the ORIGINAL pin above never
 * exercises `deriveLegacyLivePunchAttributionV1`'s `resolution.kind ===
 * 'resolved'` branch at all — both existing fixtures leave the punching user
 * unscheduled, so `workDateResolution` is always `{ kind: 'unresolved',
 * reasonCode: 'UNSCHEDULED_NO_SHIFT', ... }`. This is the resolved shape: a
 * published shift actually wins, `resolution.workDate`/`.shiftId` are
 * non-null, AND — because a first `resolved` write freezes evidence into
 * `record.meta.workDateAttributionV1` (see `buildFrozenWorkDateAttribution`
 * in `attendance-work-date-resolver.cjs`, called from
 * `applyLivePunchProjectionLegacyV1` in index.cjs) — the persisted DB
 * projection carries a SECOND, independent copy of the same resolution
 * fields. Both copies are recursive-key-path-pinned AND value-asserted here.
 *
 * Independence of the two copies' assertions is mutation-verified, not just
 * asserted: a targeted mutation that corrupts ONLY the frozen copy's
 * `reasonCode` (`buildFrozenWorkDateAttribution` fed a doctored
 * `{ ...punchWorkDateResolution, reasonCode: 'MUTANT_FROZEN_ONLY' }` while
 * the response's own `punchWorkDateResolution` is left untouched) turns both
 * new legs red exactly at `frozen.reasonCode` below (`expected
 * 'MUTANT_FROZEN_ONLY' to be '<real reasonCode>'`) — AFTER the response-side
 * `workDateResolution.*`/`responseEvidence.*` assertions above have already
 * passed, proving they do not mask a frozen-side break. Note the reverse
 * direction (a P1-style bug that only corrupts the RESPONSE side) is proven
 * by the P1 regression fix itself, which failed at the response-side
 * `workDateResolution.reasonCode` check before ever reaching the frozen
 * assertions — see the PR body's "P1 修复实数" section for those numbers.
 * Both directions restored via `git checkout HEAD --`, porcelain re-verified
 * empty. Caveat: only `reasonCode` (both copies) has a dedicated
 * single-field mutation; `shiftId`/`workDate`/`evidenceSnapshot.
 * calendarWorkDate`/`.matchingCount` are asserted and structurally exercised
 * by every leg above but not each individually mutation-proven this round.
 */
export const LEGACY_LIVE_PUNCH_GOLDEN_KEY_PATHS_RESOLVED_V1: readonly string[] = [
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
  'record.meta.workDateAttributionV1',
  'record.meta.workDateAttributionV1.evidenceSnapshot',
  'record.meta.workDateAttributionV1.evidenceSnapshot.attributionTailMinutes',
  'record.meta.workDateAttributionV1.evidenceSnapshot.calendarWorkDate',
  'record.meta.workDateAttributionV1.evidenceSnapshot.matchingCount',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.absoluteWindow',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.absoluteWindow.endAt',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.absoluteWindow.startAt',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.assignmentId',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.isOvernight',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.segmentIndex',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.shiftId',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.source',
  'record.meta.workDateAttributionV1.evidenceSnapshot.winner.workDate',
  'record.meta.workDateAttributionV1.orgId',
  'record.meta.workDateAttributionV1.reasonCode',
  'record.meta.workDateAttributionV1.segmentIndex',
  'record.meta.workDateAttributionV1.shiftId',
  'record.meta.workDateAttributionV1.userId',
  'record.meta.workDateAttributionV1.version',
  'record.meta.workDateAttributionV1.workDate',
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
  'workDateResolution.evidenceSnapshot.attributionTailMinutes',
  'workDateResolution.evidenceSnapshot.calendarWorkDate',
  'workDateResolution.evidenceSnapshot.matchingCount',
  'workDateResolution.evidenceSnapshot.winner',
  'workDateResolution.evidenceSnapshot.winner.absoluteWindow',
  'workDateResolution.evidenceSnapshot.winner.absoluteWindow.endAt',
  'workDateResolution.evidenceSnapshot.winner.absoluteWindow.startAt',
  'workDateResolution.evidenceSnapshot.winner.assignmentId',
  'workDateResolution.evidenceSnapshot.winner.isOvernight',
  'workDateResolution.evidenceSnapshot.winner.segmentIndex',
  'workDateResolution.evidenceSnapshot.winner.shiftId',
  'workDateResolution.evidenceSnapshot.winner.source',
  'workDateResolution.evidenceSnapshot.winner.workDate',
  'workDateResolution.kind',
  'workDateResolution.reasonCode',
  'workDateResolution.segmentIndex',
  'workDateResolution.shiftId',
  'workDateResolution.workDate',
].slice().sort()

export interface LegacyPunchGoldenExpectedValuesResolvedV1 {
  readonly userId: string
  readonly status: string
  readonly workMinutes: number
  readonly lateMinutes: number
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  /** The route's PRE-resolution `calendarWorkDate` — see P1's `requestTimezone`. */
  readonly calendarWorkDate: string
  readonly reasonCode: string
  readonly shiftId: string
  /** The winning shift instance's own `workDate` (NOT `calendarWorkDate`). */
  readonly resolvedWorkDate: string
  readonly matchingCount: number
}

/**
 * Recursive key-path pin PLUS explicit value assertions, asserted
 * INDEPENDENTLY on both the response's own `workDateResolution` AND the
 * persisted `record.meta.workDateAttributionV1` frozen copy — see this
 * module's constant doc comment above for why both copies matter.
 */
export function assertLegacyPunchResponseGoldenShapeResolvedV1(
  data: PlainRecord,
  expected: LegacyPunchGoldenExpectedValuesResolvedV1,
): void {
  expect(recursiveKeyPaths(data)).toEqual([...LEGACY_LIVE_PUNCH_GOLDEN_KEY_PATHS_RESOLVED_V1])

  const record = data.record as PlainRecord
  const event = data.event as PlainRecord
  const workDateResolution = data.workDateResolution as PlainRecord
  const recordMeta = record.meta as PlainRecord
  const frozen = recordMeta.workDateAttributionV1 as PlainRecord

  expect(event.user_id).toBe(expected.userId)
  expect(record.user_id).toBe(expected.userId)
  expect(record.status).toBe(expected.status)
  expect(record.work_minutes).toBe(expected.workMinutes)
  expect(record.late_minutes).toBe(expected.lateMinutes)
  expect(record.first_in_at).toBe(expected.firstInAt)
  expect(record.last_out_at).toBe(expected.lastOutAt)

  expect(workDateResolution.kind).toBe('resolved')
  expect(workDateResolution.reasonCode).toBe(expected.reasonCode)
  expect(workDateResolution.shiftId).toBe(expected.shiftId)
  expect(workDateResolution.workDate).toBe(expected.resolvedWorkDate)
  const responseEvidence = workDateResolution.evidenceSnapshot as PlainRecord
  expect(responseEvidence.calendarWorkDate).toBe(expected.calendarWorkDate)
  expect(responseEvidence.matchingCount).toBe(expected.matchingCount)

  expect(frozen.reasonCode).toBe(expected.reasonCode)
  expect(frozen.shiftId).toBe(expected.shiftId)
  expect(frozen.workDate).toBe(expected.resolvedWorkDate)
  const frozenEvidence = frozen.evidenceSnapshot as PlainRecord
  expect(frozenEvidence.calendarWorkDate).toBe(expected.calendarWorkDate)
  expect(frozenEvidence.matchingCount).toBe(expected.matchingCount)
}
