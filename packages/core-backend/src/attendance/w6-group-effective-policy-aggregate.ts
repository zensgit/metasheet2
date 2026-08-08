/**
 * W6-1 (#4556) — group effective-policy aggregate: read-only service.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   §4 (aggregate read-model contract), §3 (red lines W6-R1..R9), all OD-W6-*
 *   resolved to option (a).
 *
 * This module owns EVERY read the aggregate performs. It is deliberately
 * kept out of `attendance-admin.ts` (route wiring only) and out of
 * `plugins/plugin-attendance/index.cjs` (no new separable logic added
 * there) per this line's module-boundary convention.
 *
 * Authorization is NOT this module's job (W6-R3): the caller (the route)
 * must resolve and verify the org/permission/membership BEFORE calling
 * `getAggregate`. This module receives an already-authorized `orgId` and
 * every query it issues carries an `org_id` predicate. (That sentence used
 * to be false: `loadShiftSegmentProfile`'s two reads were keyed on
 * `shift_id` alone. Both tables carry `org_id`, so the code was changed to
 * match the claim rather than the claim narrowed to match the code.)
 *
 * GET-only (W6-R1): every query in this file is a SELECT. The mechanical
 * proof is `tests/unit/attendance-w6-group-effective-policy-dml-sweep.test.ts`.
 * Read what that test actually proves before relying on this sentence: its
 * static leg sweeps a DERIVED call-path closure and REFUSES any `query(...)`
 * whose SQL argument is not a single literal (a concatenated verb defeated
 * the previous literal-text-only detector inside this very file), and its
 * behavioural leg brackets the route round-trip with a per-table row-count +
 * `MAX(xmin)` snapshot over a DERIVED table set. The behavioural leg's known
 * blind spot is disclosed in that file's header, not papered over here.
 *
 * Fixed-schedule effectiveness (W6-R4, OD-W6-2(a)): this module calls the
 * EXISTING FSER service (`attendance-group-fixed-schedule-effectiveness-service.cjs`,
 * injected as `deps.fser`) and embeds its result verbatim (minus the
 * redundant `groupId` key, already present at the aggregate's own top
 * level) for `fixed_shift` groups. It introduces no second effectiveness
 * predicate and no persisted second status. The FSER instance the route
 * builds is injected with the CANONICAL producer key from
 * `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs`
 * — the same function `index.cjs` delegates to — so this module holds no
 * producer-key implementation of its own.
 */
import {
  SCHEDULE_ROUTE_SURFACES,
  validateAttendanceGroupEffectivePolicyResponseV1,
} from './w6-group-effective-policy-response-contract'
import type {
  AttendanceGroupEffectivePolicyAggregateV1,
  AttendanceGroupEffectivePolicyCalculationPostureV1,
  AttendanceGroupEffectivePolicyConflictCodeV1,
  AttendanceGroupEffectivePolicyEditorRefV1,
  AttendanceGroupEffectivePolicyGroupTypeV1,
  AttendanceGroupFixedScheduleEffectivenessV1,
} from './w6-group-effective-policy-contract'

export type AttendanceGroupEffectivePolicyQueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/** Structural type for the injected FSER service — matches
 * `createAttendanceGroupFixedScheduleEffectivenessService(...)`'s
 * `getEffectiveness` export exactly (see
 * `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs`). */
export interface AttendanceGroupEffectivePolicyFserServiceLike {
  getEffectiveness(
    db: { query: AttendanceGroupEffectivePolicyQueryFn },
    input: { orgId: string; groupId: string },
  ): Promise<{
    groupId: string
    state: 'not_configured' | 'pending_apply' | 'effective' | 'configuration_changed'
    reasonCodes: readonly string[]
    // `endDate: string | null` — the producer emits null for an open-ended
    // managed row by construction. Narrowing it here made the compiler assert
    // the lie at the injection seam, which is why the P1 class had FOUR copies
    // rather than one.
    desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
    coverage: {
      targetMembers: number
      matchingMembers: number
      missingMembers: number
      nonMemberTargets: number
      differentKeyRows: number
    }
    drift: {
      unconfiguredManagedRows: number
      unpublishedManagedRows: number
      managedSets: ReadonlyArray<{
        shiftId: string
        startDate: string
        endDate: string | null
        producerKey: string
        rowCount: number
      }>
    }
    evaluatedAt: string
  }>
}

export class AttendanceGroupEffectivePolicyServiceError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface AttendanceGroupEffectivePolicyServiceDeps {
  query: AttendanceGroupEffectivePolicyQueryFn
  fser: AttendanceGroupEffectivePolicyFserServiceLike
  now?: () => string
  /** Mirrors `SEGMENT_CALCULATION_IMPLEMENTED` from `attendance-shift-service.cjs`
   * (currently `false` in production). Injected, not re-derived (W6-R4 spirit). */
  segmentCalculationImplemented?: boolean
}

const GROUP_TYPES = new Set<AttendanceGroupEffectivePolicyGroupTypeV1>(['fixed_shift', 'scheduled_shift', 'free_time'])
const MANAGER_ROLES = new Set(['owner', 'sub_owner'])
const ROLLOUT_STATES = new Set<AttendanceGroupEffectivePolicyCalculationPostureV1>([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
])
// Mirrors `chk_attendance_shifts_flex_mode` — the only two values the
// column's own CHECK constraint permits.
const FLEX_MODES = new Set(['strict', 'flex_required_duration'])

function stageRef(stage: 'basics' | 'people' | 'schedule' | 'policies'): AttendanceGroupEffectivePolicyEditorRefV1 {
  return { kind: 'group_stage', stage }
}

/**
 * Builds a `group_context_route` editorRef against the #4711 closed step/
 * surface table.
 *
 * The `surface` argument is now HONOURED for every step rather than accepted
 * and discarded for `rules` (where it used to be silently replaced by the
 * literal `'rule-sets'` — behaviour that happened to be right only because
 * `'rule-sets'` is the sole legal rules surface, so the signature lied). An
 * out-of-table pair throws rather than being coerced, which keeps this
 * builder fail-closed in the same way the response-contract parser is.
 */
function scheduleRouteRef(
  step: 'schedule' | 'calendar' | 'rules',
  surface?: string,
): AttendanceGroupEffectivePolicyEditorRefV1 {
  const allowed = SCHEDULE_ROUTE_SURFACES[step]
  if (surface === undefined) {
    return { kind: 'group_context_route', step } as AttendanceGroupEffectivePolicyEditorRefV1
  }
  if (allowed === null || !allowed.includes(surface)) {
    throw new AttendanceGroupEffectivePolicyServiceError(
      500,
      'EDITOR_REF_SURFACE_UNRECOGNIZED',
      'Editor reference surface is not in the closed step/surface table',
    )
  }
  return { kind: 'group_context_route', step, surface } as AttendanceGroupEffectivePolicyEditorRefV1
}

/**
 * W6-R5 / OD-W6-8(a): bounded per-group, current-date-only membership overlap
 * detection. Counts users who (a) hold an effective-today
 * `attendance_calculation_group_memberships` row for THIS group, and (b) hold
 * MORE THAN ONE effective-today row org-wide (any group) — the exact
 * "two or more effective groups" conflict parent lock §3.4 names. The output
 * is a bare COUNT; no member list is ever read out of this query.
 *
 * EXPORTED AS A NAMED CONSTANT deliberately. W6-R5's own required negative
 * proof is that a CHOOSE-FIRST / CHOOSE-LATEST rewrite fails. The fake-DB
 * suite's router matches SQL by SUBSTRING, so appending `ORDER BY m.user_id
 * LIMIT 1` to the inner subquery still matched every route and left the whole
 * unit suite green — the mutation the red line names was invisible. Pinning
 * the SQL text as a constant gives that mutation a DB-free gate: any
 * `ORDER BY`/`LIMIT`/`DISTINCT ON` rewrite changes this string and reds the
 * pin. The real-DB suite carries the behavioural counterpart (a fixture whose
 * per-user-dedup count differs from a choose-first count).
 */
export const ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1 = `SELECT COUNT(*)::int AS cnt
         FROM (
           SELECT m.user_id
             FROM attendance_calculation_group_memberships m
            WHERE m.org_id = $1
              AND m.group_id = $2
              AND m.effective_from <= CURRENT_DATE
              AND (m.effective_to IS NULL OR m.effective_to >= CURRENT_DATE)
            GROUP BY m.user_id
         ) this_group
        WHERE (
          SELECT COUNT(*)
            FROM attendance_calculation_group_memberships other
           WHERE other.org_id = $1
             AND other.user_id = this_group.user_id
             AND other.effective_from <= CURRENT_DATE
             AND (other.effective_to IS NULL OR other.effective_to >= CURRENT_DATE)
        ) > 1`

export function createAttendanceGroupEffectivePolicyAggregateService(deps: AttendanceGroupEffectivePolicyServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString())
  const segmentCalculationImplemented = deps.segmentCalculationImplemented ?? false
  const db = { query: deps.query }

  async function loadGroup(orgId: string, groupId: string) {
    const rows = await deps.query(
      `SELECT id, attendance_type, timezone, rule_set_id
         FROM attendance_groups
        WHERE id = $1 AND org_id = $2
        LIMIT 1`,
      [groupId, orgId],
    )
    if (!rows.length) throw new AttendanceGroupEffectivePolicyServiceError(404, 'NOT_FOUND', 'Group not found')
    const row = rows[0]
    const groupType = row.attendance_type
    if (typeof groupType !== 'string' || !GROUP_TYPES.has(groupType as AttendanceGroupEffectivePolicyGroupTypeV1)) {
      throw new AttendanceGroupEffectivePolicyServiceError(500, 'GROUP_TYPE_UNRECOGNIZED', 'Group type is not a recognized value')
    }
    return {
      groupType: groupType as AttendanceGroupEffectivePolicyGroupTypeV1,
      timezone: typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone : null,
      ruleSetId: typeof row.rule_set_id === 'string' && row.rule_set_id.trim() ? row.rule_set_id : null,
    }
  }

  async function loadActiveMemberCount(orgId: string, groupId: string): Promise<number> {
    const rows = await deps.query(
      `SELECT COUNT(*)::int AS cnt FROM attendance_group_members WHERE org_id = $1 AND group_id = $2`,
      [orgId, groupId],
    )
    return Number(rows[0]?.cnt ?? 0)
  }

  async function loadManagerPosture(orgId: string, groupId: string) {
    const rows = await deps.query(
      `SELECT role, COUNT(*)::int AS cnt FROM attendance_group_managers WHERE org_id = $1 AND group_id = $2 GROUP BY role`,
      [orgId, groupId],
    )
    let ownerCount = 0
    let subOwnerCount = 0
    for (const row of rows) {
      const role = row.role
      if (typeof role !== 'string' || !MANAGER_ROLES.has(role)) {
        throw new AttendanceGroupEffectivePolicyServiceError(500, 'MANAGER_ROLE_UNRECOGNIZED', 'Manager role is not a recognized value')
      }
      if (role === 'owner') ownerCount = Number(row.cnt ?? 0)
      else subOwnerCount = Number(row.cnt ?? 0)
    }
    return { ownerCount, subOwnerCount }
  }

  async function loadCalculationPosture(orgId: string): Promise<AttendanceGroupEffectivePolicyCalculationPostureV1> {
    const rows = await deps.query(`SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1 LIMIT 1`, [orgId])
    if (!rows.length) return 'legacy'
    const state = rows[0].state
    if (typeof state !== 'string' || !ROLLOUT_STATES.has(state as AttendanceGroupEffectivePolicyCalculationPostureV1)) {
      throw new AttendanceGroupEffectivePolicyServiceError(500, 'ROLLOUT_STATE_UNRECOGNIZED', 'Rollout state is not a recognized value')
    }
    return state as AttendanceGroupEffectivePolicyCalculationPostureV1
  }

  async function loadOrgHasDefaultRuleSet(orgId: string): Promise<boolean> {
    const rows = await deps.query(
      `SELECT 1 FROM attendance_rule_sets WHERE org_id = $1 AND is_default = true LIMIT 1`,
      [orgId],
    )
    return rows.length > 0
  }

  async function loadHasAdvancedSchedulingConfig(orgId: string, groupId: string): Promise<boolean> {
    const rows = await deps.query(
      `SELECT 1 FROM attendance_schedule_groups WHERE org_id = $1 AND attendance_group_id = $2 AND is_active = true LIMIT 1`,
      [orgId, groupId],
    )
    return rows.length > 0
  }

  /**
   * W6-R3: BOTH reads are org-scoped. They were not — they keyed on
   * `shift_id`/`id` alone while every other read in this module carried
   * `org_id`, which made the module header's absolute claim false. There was
   * no live cross-tenant read (the `shiftId` reaches here only from
   * `fser.desired.shiftId`, and `attendance_group_fixed_schedule_configs`
   * carries a composite `(shift_id, org_id)` FK to `attendance_shifts`), but
   * the fix is to make the code match the claim, not to soften the claim.
   * The segments predicate also now matches the existing
   * `idx_attendance_shift_segments_org_shift` index.
   */
  async function loadShiftSegmentProfile(
    orgId: string,
    shiftId: string,
  ): Promise<{ segmentCount: number; flexMode: 'strict' | 'flex_required_duration' }> {
    const [segmentRows, shiftRows] = await Promise.all([
      deps.query(`SELECT COUNT(*)::int AS cnt FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2`, [
        orgId,
        shiftId,
      ]),
      deps.query(`SELECT flex_mode FROM attendance_shifts WHERE id = $1 AND org_id = $2 LIMIT 1`, [shiftId, orgId]),
    ])
    const segmentCount = Number(segmentRows[0]?.cnt ?? 0)
    const flexModeRaw = shiftRows[0]?.flex_mode
    if (typeof flexModeRaw !== 'string' || !FLEX_MODES.has(flexModeRaw)) {
      throw new AttendanceGroupEffectivePolicyServiceError(500, 'FLEX_MODE_UNRECOGNIZED', 'Shift flex mode is not a recognized value')
    }
    const flexMode = flexModeRaw as 'strict' | 'flex_required_duration'
    return { segmentCount, flexMode }
  }

  /** The fixed-schedule config row's OWN id (distinct from the shift it
   * targets) — FSER's own `loadEffectivenessFacts` never selects `id`
   * (it only needs shift_id/dates/revision), so the aggregate reads it
   * separately, purely for the `fixed_schedule_config` sourceRef. This is
   * metadata about which config row is desired, not a second effectiveness
   * derivation (W6-R4 governs the STATE derivation, not this id lookup). */
  async function loadFixedScheduleConfigId(orgId: string, groupId: string): Promise<string | null> {
    const rows = await deps.query(
      `SELECT id FROM attendance_group_fixed_schedule_configs WHERE org_id = $1 AND group_id = $2 LIMIT 1`,
      [orgId, groupId],
    )
    const id = rows[0]?.id
    return typeof id === 'string' && id.trim() ? id : null
  }

  /** See {@link ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1} for the semantics
   * and for why the SQL is a module-level named constant. */
  async function countMembershipOverlap(orgId: string, groupId: string): Promise<number> {
    const rows = await deps.query(ATTENDANCE_GROUP_MEMBERSHIP_OVERLAP_SQL_V1, [orgId, groupId])
    return Number(rows[0]?.cnt ?? 0)
  }

  function fserStateToScheduleLabel(state: string): {
    label: AttendanceGroupEffectivePolicyAggregateV1['domains']['schedule']['label']
    conflictCode: AttendanceGroupEffectivePolicyConflictCodeV1 | null
  } {
    switch (state) {
      case 'effective':
        return { label: 'effective', conflictCode: null }
      case 'not_configured':
        return { label: 'needs_configuration', conflictCode: null }
      case 'pending_apply':
        return { label: 'conflict_action_required', conflictCode: 'FIXED_SCHEDULE_PENDING_APPLY' }
      case 'configuration_changed':
        return { label: 'conflict_action_required', conflictCode: 'FIXED_SCHEDULE_CONFIGURATION_CHANGED' }
      default:
        throw new AttendanceGroupEffectivePolicyServiceError(500, 'FSER_STATE_UNRECOGNIZED', 'Fixed-schedule state is not a recognized value')
    }
  }

  async function getAggregate(input: { orgId: string; groupId: string }): Promise<AttendanceGroupEffectivePolicyAggregateV1> {
    const { orgId, groupId } = input
    const group = await loadGroup(orgId, groupId)
    const evaluatedAt = now()

    const [activeMemberCount, managerPosture, calculationPosture] = await Promise.all([
      loadActiveMemberCount(orgId, groupId),
      loadManagerPosture(orgId, groupId),
      loadCalculationPosture(orgId),
    ])

    const conflicts: AttendanceGroupEffectivePolicyAggregateV1['conflicts'][number][] = []

    // ---- schedule + segments + flex --------------------------------------
    let scheduleLabel: AttendanceGroupEffectivePolicyAggregateV1['domains']['schedule']['label'] = 'effective'
    let scheduleReasonCodes: string[] = []
    let scheduleSourceRefs: Array<{ kind: 'shift' | 'fixed_schedule_config'; id: string }> = []
    let fixedSchedule: AttendanceGroupFixedScheduleEffectivenessV1 | null = null
    let scheduleEditorRef = scheduleRouteRef('schedule', 'assignments')

    let segmentLabel: AttendanceGroupEffectivePolicyAggregateV1['domains']['segments']['label'] = 'effective'
    let segmentReasonCodes: string[] = []
    let segmentSourceRefs: Array<{ kind: 'shift'; id: string }> = []

    let flexLabel: AttendanceGroupEffectivePolicyAggregateV1['domains']['flex']['label'] = 'effective'
    let flexReasonCodes: string[] = []
    let flexMode: 'strict' | 'flex_required_duration' | undefined

    if (group.groupType === 'fixed_shift') {
      scheduleEditorRef = scheduleRouteRef('schedule', 'assignments')
      const fser = await deps.fser.getEffectiveness(db, { orgId, groupId })
      const { groupId: _fserGroupId, ...fserEmbed } = fser
      fixedSchedule = fserEmbed as AttendanceGroupFixedScheduleEffectivenessV1

      const mapped = fserStateToScheduleLabel(fser.state)
      scheduleLabel = mapped.label
      // Domain-summary reasonCodes carry ONE representative reason, not
      // FSER's full diagnostic list (that stays inside the embedded
      // `fixedSchedule` object verbatim). Fixture-pinned: EFFECTIVE fixed_shift
      // groups show `[]` here even though FSER's own reasonCodes is
      // `['EFFECTIVE']`, and the configuration_changed fixture shows only
      // `['DIFFERENT_MANAGED_KEY_ACTIVE']` even though FSER's full list is
      // `['DIFFERENT_MANAGED_KEY_ACTIVE','TARGET_MEMBER_MISSING']` — FSER
      // already orders reasonCodes by its own REASON_ORDER, so "first
      // non-EFFECTIVE entry" is FSER's own primary-cause ordering, not a
      // second derivation.
      scheduleReasonCodes = fser.reasonCodes.filter((code) => code !== 'EFFECTIVE').slice(0, 1)
      if (mapped.conflictCode) {
        conflicts.push({
          code: mapped.conflictCode,
          domain: 'schedule',
          label: 'conflict_action_required',
          editorRef: scheduleEditorRef,
        })
      }

      /**
       * §4.2 CLOSED-SET COMPLETENESS: `FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW`
       * is one of the seven RATIFIED conflict codes (OD-W6-4(a)) and had NO
       * emission path anywhere — never pushed into `conflicts[]`, never a
       * domain reason code, unreachable by any input. FSER explicitly detects
       * and reports the condition (`drift.unpublishedManagedRows`, reason code
       * `UNPUBLISHED_MANAGED_ROW`) and its `effective` predicate deliberately
       * does NOT include unpublished rows, so a group with unpublished managed
       * rows and everything else clean genuinely returns state `effective` —
       * the aggregate received the fact and dropped it. §2.1 item 3 promises a
       * CLOSED conflict inventory; an item with no producer is not an entry.
       *
       * This escalates the fact the aggregate already holds. Consequence,
       * stated because it is new: `conflicts[]` can now carry TWO
       * schedule-domain items for one group (a state conflict plus this one).
       * The seventh fixture pins that shape.
       */
      if (fser.drift.unpublishedManagedRows > 0) {
        conflicts.push({
          code: 'FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW',
          domain: 'schedule',
          label: 'conflict_action_required',
          editorRef: scheduleEditorRef,
        })
        if (scheduleLabel === 'effective') scheduleLabel = 'conflict_action_required'
        if (scheduleReasonCodes.length === 0 && fser.reasonCodes.includes('UNPUBLISHED_MANAGED_ROW')) {
          scheduleReasonCodes = ['UNPUBLISHED_MANAGED_ROW']
        }
      }

      if (fser.desired) {
        const [configId, profile] = await Promise.all([
          loadFixedScheduleConfigId(orgId, groupId),
          loadShiftSegmentProfile(orgId, fser.desired.shiftId),
        ])
        scheduleSourceRefs = [{ kind: 'shift', id: fser.desired.shiftId }]
        if (configId) scheduleSourceRefs.push({ kind: 'fixed_schedule_config', id: configId })
        segmentSourceRefs = [{ kind: 'shift', id: fser.desired.shiftId }]
        flexMode = profile.flexMode
        const isSingleSegmentStrict = profile.segmentCount <= 1 && profile.flexMode === 'strict'
        const authoritativeAndImplemented = calculationPosture === 'authoritative' && segmentCalculationImplemented
        if (isSingleSegmentStrict || authoritativeAndImplemented) {
          segmentLabel = 'effective'
          flexLabel = 'effective'
        } else {
          segmentLabel = 'preview_only'
          flexLabel = 'preview_only'
          segmentReasonCodes = ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE']
          flexReasonCodes = ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE']
        }
      } else {
        // `fser.desired === null` is paired UNCONDITIONALLY by FSER with
        // `state: 'not_configured'` (its `not_configured` branch is the only
        // one that returns a null `desired`), which
        // `fserStateToScheduleLabel` maps to `needs_configuration`. The
        // former `: 'effective'` arm of a ternary here was therefore dead
        // code. Collapsed to the constant, with the FSER invariant that makes
        // it total named above — and asserted rather than assumed, so a future
        // FSER change that breaks the pairing fails loudly instead of silently
        // labelling an unconfigured group `effective`.
        if (scheduleLabel !== 'needs_configuration' && scheduleLabel !== 'conflict_action_required') {
          throw new AttendanceGroupEffectivePolicyServiceError(
            500,
            'FSER_DESIRED_NULL_STATE_UNEXPECTED',
            'Fixed-schedule desired is null but the derived schedule label is neither needs_configuration nor a conflict',
          )
        }
        segmentLabel = 'needs_configuration'
        flexLabel = 'needs_configuration'
      }
    } else if (group.groupType === 'free_time') {
      scheduleEditorRef = scheduleRouteRef('schedule')
      scheduleLabel = 'effective'
      scheduleReasonCodes = []
      scheduleSourceRefs = []
      fixedSchedule = null
      segmentLabel = 'effective'
      flexLabel = 'effective'
    } else {
      // scheduled_shift
      scheduleEditorRef = scheduleRouteRef('schedule', 'advanced-scheduling')
      const hasAdvancedScheduling = await loadHasAdvancedSchedulingConfig(orgId, groupId)
      if (!hasAdvancedScheduling) {
        scheduleLabel = 'needs_configuration'
        scheduleReasonCodes = ['SCHEDULE_STRATEGY_INCOMPLETE']
        conflicts.push({
          code: 'SCHEDULE_STRATEGY_INCOMPLETE',
          domain: 'schedule',
          label: 'conflict_action_required',
          editorRef: scheduleEditorRef,
        })
        segmentLabel = 'needs_configuration'
        segmentReasonCodes = ['SCHEDULE_STRATEGY_INCOMPLETE']
        flexLabel = 'needs_configuration'
        flexReasonCodes = ['SCHEDULE_STRATEGY_INCOMPLETE']
      } else {
        /**
         * OD-W6-6(a), applied HERE too. This branch used to hard-code
         * `effective` for segments and flex with empty reasonCodes, reading
         * neither the posture nor `SEGMENT_CALCULATION_IMPLEMENTED` — so a
         * `scheduled_shift` org on `legacy` posture with the flag false was
         * told its segment/flex policy was `effective` while the calculation
         * chain was not consuming it. That is fail-open in exactly the
         * direction §9's OD-W6-6(a) closes, and it contradicted a §9
         * resolution verbatim rather than merely under-covering it.
         *
         * The single-segment-strict exemption CANNOT apply here: v1 resolves
         * no single shift for a `scheduled_shift` group, so there is no
         * envelope to call authoritative. Only the posture disjunct is
         * available, and when it is false the honest label is `preview_only`.
         */
        scheduleLabel = 'effective'
        const authoritativeAndImplemented = calculationPosture === 'authoritative' && segmentCalculationImplemented
        if (authoritativeAndImplemented) {
          segmentLabel = 'effective'
          flexLabel = 'effective'
        } else {
          segmentLabel = 'preview_only'
          flexLabel = 'preview_only'
          segmentReasonCodes = ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE']
          flexReasonCodes = ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE']
        }
      }
    }

    // ---- membership --------------------------------------------------------
    const overlapCount = await countMembershipOverlap(orgId, groupId)
    const membershipLabel: AttendanceGroupEffectivePolicyAggregateV1['domains']['membership']['label'] =
      overlapCount > 0 ? 'conflict_action_required' : 'effective'
    const membershipReasonCodes = overlapCount > 0 ? ['CALCULATION_GROUP_MEMBERSHIP_OVERLAP'] : []
    if (overlapCount > 0) {
      conflicts.push({
        code: 'CALCULATION_GROUP_MEMBERSHIP_OVERLAP',
        domain: 'membership',
        label: 'conflict_action_required',
        affectedUserCount: overlapCount,
        editorRef: stageRef('people'),
      })
    }

    // ---- rules ---------------------------------------------------------
    let rulesLabel: AttendanceGroupEffectivePolicyAggregateV1['domains']['rules']['label']
    let rulesReasonCodes: string[] = []
    let rulesSourceRefs: Array<{ kind: 'rule_set'; id: string }> = []
    const rulesSource: 'org_default' | 'group_rule_set' = group.ruleSetId ? 'group_rule_set' : 'org_default'
    if (group.ruleSetId) {
      rulesLabel = 'effective'
      rulesSourceRefs = [{ kind: 'rule_set', id: group.ruleSetId }]
    } else {
      const hasDefault = await loadOrgHasDefaultRuleSet(orgId)
      if (hasDefault) {
        rulesLabel = 'org_inherited'
      } else {
        rulesLabel = 'needs_configuration'
        rulesReasonCodes = ['RULE_SOURCE_MISSING']
        // No conflicts[] entry: RULE_SOURCE_MISSING is a domain reasonCode
        // only, per the fixture-pinned asymmetry in
        // aggregate-needs-configuration.json (SCHEDULE_STRATEGY_INCOMPLETE
        // is in both the domain AND conflicts[]; RULE_SOURCE_MISSING is
        // domain-only). Reproduced byte-exactly, not normalized away.
      }
    }

    // ---- timezone conflict -----------------------------------------------
    if (group.timezone === null) {
      conflicts.push({
        code: 'TIMEZONE_MISSING',
        domain: 'basics',
        label: 'conflict_action_required',
        editorRef: stageRef('basics'),
      })
    }

    const aggregate: AttendanceGroupEffectivePolicyAggregateV1 = {
      groupId,
      groupType: group.groupType,
      timezone: group.timezone,
      activeMemberCount,
      managerPosture,
      calculationPosture,
      domains: {
        membership: {
          label: membershipLabel,
          reasonCodes: membershipReasonCodes,
          editorRef: stageRef('people'),
        },
        schedule: {
          label: scheduleLabel,
          strategy: group.groupType,
          reasonCodes: scheduleReasonCodes,
          // sourceRefs is ALWAYS present on schedule/segments/rules (even
          // `[]`) — fixture-pinned across all 6 aggregate-*.json fixtures.
          sourceRefs: scheduleSourceRefs,
          fixedSchedule,
          editorRef: scheduleEditorRef,
        },
        segments: {
          label: segmentLabel,
          reasonCodes: segmentReasonCodes,
          sourceRefs: segmentSourceRefs,
          editorRef: scheduleRouteRef('schedule', 'shifts'),
        },
        flex: {
          label: flexLabel,
          ...(flexMode ? { mode: flexMode } : {}),
          reasonCodes: flexReasonCodes,
          editorRef: scheduleRouteRef('schedule', 'shifts'),
        },
        rules: {
          label: rulesLabel,
          source: rulesSource,
          sourceRefs: rulesSourceRefs,
          reasonCodes: rulesReasonCodes,
          editorRef: scheduleRouteRef('rules', 'rule-sets'),
        },
        punchMethod: {
          label: 'org_inherited',
          source: 'org_inherited',
          reasonCodes: [],
          editorRef: stageRef('policies'),
        },
        requestPosture: {
          label: 'org_inherited',
          overtime: 'org_inherited',
          makeupPunch: 'org_inherited',
          outdoor: 'org_inherited',
          reasonCodes: [],
          editorRef: stageRef('policies'),
        },
      },
      conflicts,
      evaluatedAt,
    }

    // Belt-and-suspenders (R7 spirit): never hand the route a response this
    // module's own contract validator would reject.
    const validation = validateAttendanceGroupEffectivePolicyResponseV1({ ok: true, data: aggregate })
    if (validation.ok === false) {
      throw new AttendanceGroupEffectivePolicyServiceError(
        500,
        'AGGREGATE_CONTRACT_VIOLATION',
        `Aggregate failed its own response contract: ${validation.reason}`,
      )
    }
    return aggregate
  }

  return { getAggregate, countMembershipOverlap }
}
