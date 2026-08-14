/**
 * W7-1a (#4556) STEP 2 — in-transaction group-effective FACTS resolver
 * (OD-W7-1(a)).
 *
 * Authority: design-lock §4.1 (resolution input), §2 red lines W7-R1/W7-R2/
 * W7-R10; ratified per #4556 comments 5293034619 (ruling) + 5293478713 (owner first-person confirmation)
 * — rulings 5 (`fixed_shift` only),
 * 6 (W1-vs-FSER mismatch fail-closes), 8 (composite lock order), 9
 * (`w7-resolver/` layout), 11 (`flex_required_duration` fail-closes).
 *
 * RETURNS FACTS, NEVER A CONTEXT (W7-R1). Minting the
 * `FrozenAttendanceContextV2` is the exclusive job of core operation (i) in
 * `./w7-group-effective-context-issuance.ts`. A resolver that returned the V2
 * object directly would put a second issuance origin in the production-root
 * inventory, which is precisely what W7-R1 forbids.
 *
 * READS PERSISTED FACTS UNDER LOCKS — NEVER THE W6 HTTP AGGREGATE (W7-R10).
 * This module imports no W6 module of any kind (not the aggregate service,
 * not its route, and not its types-only contract module — whether a compile-
 * erased `import type` of the W6 contract counts as a live dependency is an
 * OPEN question the ratification comment did NOT rule on, so this file keeps
 * it moot by importing nothing from W6 at all), and issues no HTTP call.
 *
 * STRUCTURALLY INERT (W7-1a): zero production import sites, zero call sites.
 *
 * ON THE FSER COMPOSITION. `loadEffectivenessFacts` is a private closure
 * inside the FSER factory and is NOT exported
 * (`plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:291-296`),
 * and the exported `getEffectiveness`/`getSelfEffectiveness` wrappers do
 * UNLOCKED pooled reads (`:218`, `:251`) — unusable for a resolver that must
 * read under its own locks. So this module reissues those three SELECTs
 * verbatim INSIDE the lock and feeds them to the EXPORTED PURE derivation
 * `deriveAttendanceGroupFixedScheduleEffectiveness` (`:71`), which is
 * INJECTED rather than imported — the same shape the landed W6-1 aggregate
 * module uses for its own `deps.fser`. (That module is named here only by
 * description, not by filename: the landed W6-R5 import-graph guard
 * `tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts`
 * is a TEXT-marker scan over calculation-path files, and this file is
 * correctly classified as one. Spelling the basename in a comment that exists
 * to say "we do NOT import it" would trip that guard, and the right response
 * to a tripwire firing on prose is to reword the prose, never to add an
 * exemption that weakens the guard for every future file.) Consequence
 * that must not be glossed: this introduces a second *fact loader*, but NOT a
 * second effectiveness *predicate* — the predicate stays singular, which is
 * what W6-R4 and `tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts`
 * actually guard. The three queries below are pinned byte-for-byte against
 * the FSER original by a test, so a one-sided edit reds.
 */
import {
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceUserIdV1,
  parseCanonicalAttendanceWorkDateV1,
  type AttendanceW4TransactionClientV1,
} from '../w4c0-identity'
import { acquireAttendanceW7CompositeFactsLocksV1 } from './w7-composite-lock-order'

/**
 * The runtime overlap code. Deliberately the SAME string the W1 membership
 * writer throws (`../../services/AttendanceCalculationGroupMembership.ts:5-6`,
 * thrown `:541-547`): the gist storage constraint is date-dependent, so
 * runtime must re-check, and a caller distinguishing "storage said overlap"
 * from "calculation said overlap" would be distinguishing two spellings of
 * one fact (W7-R2).
 */
export const ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP =
  'ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP'

export class AttendanceW7GroupResolverError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW7GroupResolverError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW7GroupResolverError(code)
}

/**
 * CLOSED reason set — exactly two members, both reachable.
 *
 * `membership-ambiguous` is deliberately ABSENT. Every ambiguity path THROWS
 * `ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP` per W7-R2, so a
 * `membership-ambiguous` reason would be an unreachable member of a closed
 * set — a shape that reads like coverage while proving nothing.
 */
export const ATTENDANCE_W7_GROUP_RESOLUTION_REASONS_V1 = Object.freeze([
  'membership-absent',
  'incomplete-policy',
] as const)

export type AttendanceW7GroupResolutionReasonV1 =
  (typeof ATTENDANCE_W7_GROUP_RESOLUTION_REASONS_V1)[number]

export interface AttendanceW7GroupEffectiveSegmentFactsV1 {
  index: 0 | 1 | 2
  startTime: string
  endTime: string
  startDayOffset: 0
  endDayOffset: 0 | 1
  lateGraceMinutes: number
  earlyLeaveGraceMinutes: number
}

/** Normalized facts. Operation (i) turns exactly this into a V2 context; it
 *  performs no further reads of its own (W7-R1). */
export interface AttendanceW7GroupEffectiveFactsV1 {
  orgId: string
  userId: string
  workDate: string
  timezone: string
  calculationGroupId: string
  shiftId: string
  isWorkday: boolean
  holidayKind: string | null
  roundingMinutes: number
  severeLateThresholdMinutes: number
  absenceLateThresholdMinutes: number
  segments: AttendanceW7GroupEffectiveSegmentFactsV1[]
}

export type AttendanceW7GroupResolutionV1 =
  | { ok: true; facts: AttendanceW7GroupEffectiveFactsV1 }
  | { ok: false; reason: AttendanceW7GroupResolutionReasonV1 }

/** Structural type of the INJECTED pure FSER derivation
 *  (`deriveAttendanceGroupFixedScheduleEffectiveness`). Only the fields this
 *  resolver reads are declared. */
export interface AttendanceW7FixedScheduleDeriveLikeV1 {
  (input: {
    desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
    producerKey: string | null
    targetMemberIds: readonly string[]
    managedRows: readonly Record<string, unknown>[]
    evaluatedAt: string
  }): {
    state: 'not_configured' | 'pending_apply' | 'effective' | 'configuration_changed'
    reasonCodes: readonly string[]
    desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
  }
}

/** Structural type of the INJECTED canonical producer-key builder
 *  (`plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs`).
 *  Injected, not re-implemented: the producer key is the FSER join key, and a
 *  second implementation of it would silently mismatch every managed row. */
export interface AttendanceW7ProducerKeyBuilderLikeV1 {
  (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }): string
}

/** Org-level calculation rule scalars. Injected because they are NOT group
 *  policy: the legacy builder reads them from the org default rule
 *  (`plugins/plugin-attendance/index.cjs:22775-22782`), and W7 must not fork a
 *  second definition of them while the group arm is the only thing changing. */
export interface AttendanceW7OrgRuleFactsLoaderV1 {
  (
    trx: AttendanceW4TransactionClientV1,
    orgKey: string,
  ): Promise<{ severeLateThresholdMinutes: number; absenceLateThresholdMinutes: number }>
}

export interface AttendanceW7GroupEffectiveResolverDepsV1 {
  deriveFixedScheduleEffectiveness: AttendanceW7FixedScheduleDeriveLikeV1
  buildFixedScheduleProducerKey: AttendanceW7ProducerKeyBuilderLikeV1
  loadOrgRuleFacts: AttendanceW7OrgRuleFactsLoaderV1
  now?: () => string
}

export interface AttendanceW7GroupEffectiveResolverInputV1 {
  orgId: string
  userId: string
  workDate: string
  timezone: string
  isWorkday: boolean
  holidayKind: string | null
}

function formatDateOnly(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
      .join('-')
  }
  const normalized = String(value)
  const match = normalized.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : normalized
}

/** `HH:MM` / `HH:MM:SS` -> `HH:MM`; anything else -> null (fail-closed). */
function normalizeTimeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)/)
  return match ? `${match[1]}:${match[2]}` : null
}

function toNonNegativeInt(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Resolve `(org, user, workDate)` to normalized group-effective facts.
 *
 * Order is load-bearing and matches ruling 8: the composite locks are taken
 * FIRST, through the one shared helper, before any fact is read. Reading a
 * fact before its lock is the classic TOCTOU: a concurrent writer could
 * commit between the read and the lock and the frozen context would carry a
 * version that never existed as a coherent whole.
 */
export async function resolveW7GroupEffectiveFactsInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  deps: AttendanceW7GroupEffectiveResolverDepsV1,
  input: AttendanceW7GroupEffectiveResolverInputV1,
): Promise<AttendanceW7GroupResolutionV1> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  const userId = parseCanonicalAttendanceUserIdV1(input.userId)
  const workDate = parseCanonicalAttendanceWorkDateV1(input.workDate)

  // ---- Locks first, in the ruled order, through the ONE shared helper. ----
  await acquireAttendanceW7CompositeFactsLocksV1(trx, { orgKey, userId })

  // ---- (a) W1 effective membership, LOCKED `FOR SHARE`. ----
  // Reader strength: the W1 writer path takes `FOR UPDATE`
  // (`AttendanceCalculationGroupMembership.ts:393-400`); `FOR SHARE` conflicts
  // with it, so a concurrent transition serializes against this read without
  // two concurrent W7 readers blocking each other.
  //
  // The effective-on predicate is the closed interval
  // `[effective_from, effective_to]` with an open right end when
  // `effective_to IS NULL` — the SQL form of the JS predicate at
  // `AttendanceCalculationGroupMembership.ts:428-432`.
  const membershipResult = await trx.query(
    `SELECT id, group_id
       FROM attendance_calculation_group_memberships
      WHERE org_id = $1
        AND user_id = $2
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY effective_from ASC, id ASC
      FOR SHARE`,
    [orgKey, userId, workDate],
  )

  if (membershipResult.rows.length === 0) return { ok: false, reason: 'membership-absent' }
  // W7-R2 RUNTIME re-check. The `attendance_calc_group_memberships_no_overlap`
  // gist constraint is date-dependent, so storage-level validity does not
  // imply "exactly one row is effective on THIS date". Never latest-updated,
  // never first-row, never array-order: a silent winner here is the whole
  // failure mode W7-R2 names.
  if (membershipResult.rows.length > 1) fail(ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP)

  const calculationGroupId = String(membershipResult.rows[0].group_id ?? '')
  if (!calculationGroupId) return { ok: false, reason: 'incomplete-policy' }

  // ---- (b) the group row. ----
  const groupResult = await trx.query(
    'SELECT id, attendance_type, timezone FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
    [calculationGroupId, orgKey],
  )
  if (groupResult.rows.length !== 1) return { ok: false, reason: 'incomplete-policy' }
  const groupRow = groupResult.rows[0]

  // Ruling 5: W7-1 covers `fixed_shift` ONLY. `scheduled_shift` composition is
  // deferred to its own later slice and design ruling; `free_time` has no
  // shift at all and so can never satisfy the v2 non-empty `shiftId` plus
  // >=1 segment shape. Both fail-close on the same reason — the distinction
  // between "deferred" and "impossible" is a roadmap fact, not a runtime one.
  if (groupRow.attendance_type !== 'fixed_shift') return { ok: false, reason: 'incomplete-policy' }

  // ---- (c) FSER schedule facts, read UNDER THIS RESOLVER'S OWN LOCK. ----
  const configResult = await trx.query(
    `SELECT shift_id, start_date, end_date, revision
       FROM attendance_group_fixed_schedule_configs
      WHERE org_id = $1 AND group_id = $2
      LIMIT 1`,
    [orgKey, calculationGroupId],
  )
  const memberResult = await trx.query(
    `SELECT DISTINCT user_id
       FROM attendance_group_members
      WHERE org_id = $1 AND group_id = $2
      ORDER BY user_id ASC`,
    [orgKey, calculationGroupId],
  )
  const managedResult = await trx.query(
    `SELECT user_id, shift_id, start_date, end_date, publish_status, producer_key
       FROM attendance_shift_assignments
      WHERE org_id = $1
        AND producer_type = 'attendance_group_fixed_schedule'
        AND producer_ref_id = $2
        AND COALESCE(is_active, true) = true
      ORDER BY producer_key ASC, user_id ASC, start_date ASC, created_at ASC, id ASC`,
    [orgKey, calculationGroupId],
  )

  const configRow = configResult.rows[0]
  const desired = configRow
    ? {
        shiftId: String(configRow.shift_id),
        startDate: formatDateOnly(configRow.start_date) as string,
        endDate: formatDateOnly(configRow.end_date),
        revision: Number(configRow.revision),
      }
    : null
  const producerKey = desired
    ? deps.buildFixedScheduleProducerKey({
        groupId: calculationGroupId,
        shiftId: desired.shiftId,
        startDate: desired.startDate,
        endDate: desired.endDate,
      })
    : null
  const targetMemberIds = memberResult.rows.map((row) => String(row.user_id))

  const effectiveness = deps.deriveFixedScheduleEffectiveness({
    desired,
    producerKey,
    targetMemberIds,
    managedRows: managedResult.rows,
    evaluatedAt: (deps.now ?? (() => new Date().toISOString()))(),
  })

  // Fail-close unless the group's fixed schedule is fully effective. A
  // `pending_apply` / `configuration_changed` / `not_configured` group has a
  // policy that is not yet (or no longer) the one its assignments express;
  // freezing a calculation context off it would freeze a policy nobody
  // authorized.
  if (effectiveness.state !== 'effective' || effectiveness.desired === null) {
    return { ok: false, reason: 'incomplete-policy' }
  }

  // Ruling 6: W1-membership vs FSER member-set reconciliation. The user is
  // W1-effective in this group, but FSER's member set comes from a DIFFERENT,
  // non-effective-dated table (`attendance_group_members`). If the two
  // disagree about this user, FAIL-CLOSE — no soft degrade, no shadow
  // substitute. `state === 'effective'` already implies FSER has full coverage
  // of ITS OWN member set, but it says nothing about a user W1 considers a
  // member and FSER has never heard of; that user is exactly the gap.
  if (!targetMemberIds.includes(userId)) return { ok: false, reason: 'incomplete-policy' }

  // ---- (d) the effective shift row + its segments. ----
  const shiftId = effectiveness.desired.shiftId
  const shiftResult = await trx.query(
    `SELECT id, timezone, rounding_minutes, late_grace_minutes, early_grace_minutes,
            work_start_time, work_end_time, is_overnight, flex_mode
       FROM attendance_shifts
      WHERE id = $1 AND org_id = $2
      LIMIT 1`,
    [shiftId, orgKey],
  )
  if (shiftResult.rows.length !== 1) return { ok: false, reason: 'incomplete-policy' }
  const shiftRow = shiftResult.rows[0]

  // Ruling 11: `flex_required_duration` fail-closes unconditionally in W7-1.
  // Its v2 expression awaits a NEW amendment/OD — it is not a supplement to
  // the OD-W7-2 this ratification fixed. Note the check is "not strict", not
  // "equals flex_required_duration": an unrecognised third mode must also
  // fail-close rather than fall through as if it were strict.
  if (shiftRow.flex_mode !== 'strict') return { ok: false, reason: 'incomplete-policy' }

  const lateGraceMinutes = toNonNegativeInt(shiftRow.late_grace_minutes)
  const earlyLeaveGraceMinutes = toNonNegativeInt(shiftRow.early_grace_minutes)

  const segmentResult = await trx.query(
    `SELECT segment_index, start_time, end_time, start_day_offset, end_day_offset
       FROM attendance_shift_segments
      WHERE org_id = $1 AND shift_id = $2
      ORDER BY segment_index ASC`,
    [orgKey, shiftId],
  )

  const segments: AttendanceW7GroupEffectiveSegmentFactsV1[] = []
  if (segmentResult.rows.length > 0) {
    if (segmentResult.rows.length > 3) return { ok: false, reason: 'incomplete-policy' }
    for (let i = 0; i < segmentResult.rows.length; i += 1) {
      const row = segmentResult.rows[i]
      const index = Number(row.segment_index)
      const startDayOffset = Number(row.start_day_offset ?? 0)
      const endDayOffset = Number(row.end_day_offset ?? 0)
      const startTime = normalizeTimeString(row.start_time)
      const endTime = normalizeTimeString(row.end_time)
      if (
        index !== i ||
        startDayOffset !== 0 ||
        (endDayOffset !== 0 && endDayOffset !== 1) ||
        !startTime ||
        !endTime
      ) {
        return { ok: false, reason: 'incomplete-policy' }
      }
      segments.push({
        index: index as 0 | 1 | 2,
        startTime,
        endTime,
        startDayOffset: 0,
        endDayOffset: endDayOffset as 0 | 1,
        lateGraceMinutes,
        earlyLeaveGraceMinutes,
      })
    }
  } else {
    const startTime = normalizeTimeString(shiftRow.work_start_time)
    const endTime = normalizeTimeString(shiftRow.work_end_time)
    if (!startTime || !endTime) return { ok: false, reason: 'incomplete-policy' }
    segments.push({
      index: 0,
      startTime,
      endTime,
      startDayOffset: 0,
      endDayOffset: shiftRow.is_overnight === true ? 1 : 0,
      lateGraceMinutes,
      earlyLeaveGraceMinutes,
    })
  }

  const ruleFacts = await deps.loadOrgRuleFacts(trx, orgKey)

  const shiftTimezone =
    typeof shiftRow.timezone === 'string' && shiftRow.timezone ? shiftRow.timezone : null
  const groupTimezone =
    typeof groupRow.timezone === 'string' && groupRow.timezone ? groupRow.timezone : null

  return {
    ok: true,
    facts: {
      orgId: orgKey,
      userId,
      workDate,
      // Same precedence the legacy builder uses (`index.cjs:22841`): the
      // shift's own timezone wins, then the caller's. The group row's
      // timezone is the fallback between them — it is group POLICY, which the
      // legacy per-user path never had.
      timezone: shiftTimezone ?? groupTimezone ?? input.timezone,
      calculationGroupId,
      shiftId,
      isWorkday: input.isWorkday !== false,
      holidayKind: input.holidayKind ?? null,
      roundingMinutes: toNonNegativeInt(shiftRow.rounding_minutes),
      severeLateThresholdMinutes: ruleFacts.severeLateThresholdMinutes,
      absenceLateThresholdMinutes: ruleFacts.absenceLateThresholdMinutes,
      segments,
    },
  }
}
