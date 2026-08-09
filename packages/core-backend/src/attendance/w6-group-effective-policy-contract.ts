/**
 * W6 (#4556) — group effective-policy aggregate read model: CONTRACT DRAFT.
 *
 * Status update (W6-1, #4814): this file's TYPES and closed enum
 * constants ARE imported and used at runtime by W6-1's aggregate service
 * and response-contract validator — the "nothing at runtime imports this
 * module" statement was accurate for W6-0 (#4771, when this file was
 * prep-only and PROPOSED) and is superseded now that W6-1 wires the
 * aggregate up. This does NOT authorize any new runtime BEHAVIOR beyond
 * what W6-1's own red lines (W6-R1..R9) already govern — W6-R9 itself
 * remains N/A to this file's PROPOSED contents (the OpenAPI-facing
 * pieces, still unused).
 *
 * `ATTENDANCE_GROUP_EFFECTIVE_POLICY_REASON_CODES_V1` (added in #4814
 * P2-2) is a module-scope `require()` of FSER's `.cjs` lib via
 * `requirePluginAttendanceLib` — a real filesystem-touching call at
 * import time, placed here alongside the other closed enum constants the
 * validator already imports at runtime, not new "prep drift."
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   sections 4.1-4.4; decision points OD-W6-1..9 are OPEN. The machine-shape
 *   twin of this module is
 *   packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml.
 *
 * Interlocks (declared, not re-derived here):
 *  - fixed-schedule effectiveness state/reason codes are the FSER contract
 *    (attendance-group-fixed-schedule-effectiveness-service.cjs is the single
 *    source; red line W6-R4);
 *  - editor references reuse the #4711 closed route family plus the existing
 *    group-editor stage union (red line W6-R8);
 *  - flex mode is the W5 union from w5-flex-policy.ts, read-only;
 *  - calculation posture is the W4 rollout state union, read-only.
 */
import { requirePluginAttendanceLib } from '../util/resolve-plugin-attendance-lib'

/** Parent lock §5.1 five display states — machine spelling per OD-W6-3(a). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1 = Object.freeze([
  'effective',
  'org_inherited',
  'preview_only',
  'needs_configuration',
  'conflict_action_required',
] as const)
export type AttendanceGroupEffectivePolicySourceLabelV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1)[number]

/** Closed policy-domain union per OD-W6-4(a). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1 = Object.freeze([
  'basics',
  'membership',
  'schedule',
  'segments',
  'flex',
  'rules',
  'punch_method',
  'request_posture',
] as const)
export type AttendanceGroupEffectivePolicyDomainV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1)[number]

/** Closed v1 conflict inventory per OD-W6-4(a). Additions are amendments. */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1 = Object.freeze([
  'CALCULATION_GROUP_MEMBERSHIP_OVERLAP',
  'FIXED_SCHEDULE_CONFIGURATION_CHANGED',
  'FIXED_SCHEDULE_PENDING_APPLY',
  'FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW',
  'SCHEDULE_STRATEGY_INCOMPLETE',
  'RULE_SOURCE_MISSING',
  'TIMEZONE_MISSING',
] as const)
export type AttendanceGroupEffectivePolicyConflictCodeV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1)[number]

/**
 * Reason-code closure, POSITION-SPECIFIC — because §4.2 is position-specific.
 *
 * §4.2: *"Reason codes inside the embedded fixed-schedule object are the FSER
 * lock's closed list, unchanged and in FSER order. W6 adds no FSER reason
 * code."* A single FLAT union over both positions cannot express that: with a
 * flat set, a W6-authored code passes at the `fixedSchedule` position (which
 * §4.2 says is FSER's list unchanged) and an FSER-only code passes at a
 * domain position. That flat union is what shipped, under a test named
 * "must be FSER's own closed list" that could only reject a wholly
 * nonexistent code. The two sets below make the position distinction real:
 *
 *  - {@link ATTENDANCE_GROUP_EFFECTIVE_POLICY_FSER_REASON_CODES_V1} — FSER's
 *    `REASON_ORDER` verbatim, the ONLY vocabulary legal inside
 *    `fixedSchedule.reasonCodes`;
 *  - {@link ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_REASON_CODES_V1} — what
 *    a `domains.*.reasonCodes` entry may be: FSER's codes with `EFFECTIVE`
 *    filtered out (the aggregate filters it, and §4.3's own example shows an
 *    effective group with `[]` at domain level), plus the four W6-authored
 *    domain codes that are not part of FSER's vocabulary.
 *
 * FSER's `REASON_ORDER` is IMPORTED, not hand-copied — a second hand-typed
 * copy is exactly the drift risk §7.3 forbids for W6-2's OpenAPI mint.
 */
const fserEffectivenessServiceLib = requirePluginAttendanceLib<{ REASON_ORDER: readonly string[] }>(
  __dirname,
  'attendance-group-fixed-schedule-effectiveness-service.cjs',
)

/** FSER's own closed list, unchanged and in FSER order (§4.2). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_FSER_REASON_CODES_V1: readonly string[] = Object.freeze([
  ...fserEffectivenessServiceLib.REASON_ORDER,
])

/** The four domain-level reason codes this aggregate mints itself — never
 * part of FSER's vocabulary, so not present in `REASON_ORDER`. */
const ATTENDANCE_GROUP_EFFECTIVE_POLICY_OWN_REASON_CODES_V1 = [
  'SEGMENT_CALCULATION_NOT_AUTHORITATIVE',
  'SCHEDULE_STRATEGY_INCOMPLETE',
  'CALCULATION_GROUP_MEMBERSHIP_OVERLAP',
  'RULE_SOURCE_MISSING',
] as const

/** Legal at `domains.*.reasonCodes`: FSER's codes minus `EFFECTIVE`, plus
 * W6's own. Derived from the imported list, never re-typed. */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_REASON_CODES_V1: readonly string[] = Object.freeze([
  ...fserEffectivenessServiceLib.REASON_ORDER.filter((code) => code !== 'EFFECTIVE'),
  ...ATTENDANCE_GROUP_EFFECTIVE_POLICY_OWN_REASON_CODES_V1,
])

/** Union of both positions. Kept for callers that need "is this a W6 reason
 * code at all"; it is deliberately NOT what the validator uses at either
 * position, because a union cannot enforce a position rule. */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_REASON_CODES_V1: readonly string[] = Object.freeze([
  ...ATTENDANCE_GROUP_EFFECTIVE_POLICY_FSER_REASON_CODES_V1,
  ...ATTENDANCE_GROUP_EFFECTIVE_POLICY_OWN_REASON_CODES_V1,
])

/** Existing CHECK-constrained group type union (read-only mirror). */
export type AttendanceGroupEffectivePolicyGroupTypeV1 =
  | 'fixed_shift'
  | 'scheduled_shift'
  | 'free_time'

/** Read-only mirror of the W4 org rollout state union (lock §9). */
export type AttendanceGroupEffectivePolicyCalculationPostureV1 =
  | 'legacy'
  | 'shadow'
  | 'eligible'
  | 'authoritative'
  | 'suspended'

/**
 * Closed editor reference union per OD-W6-9(a).
 * `basics|people` stay ordinary group-editor stages (outside the #4711 route
 * family by that lock's §3.1); `schedule|calendar|rules` reuse #4711's closed
 * step/surface tables.
 */
export type AttendanceGroupEffectivePolicyEditorRefV1 =
  | {
      readonly kind: 'group_stage'
      readonly stage: 'basics' | 'people' | 'schedule' | 'policies'
    }
  | {
      readonly kind: 'group_context_route'
      readonly step: 'schedule'
      readonly surface?: 'shifts' | 'assignments' | 'advanced-scheduling'
    }
  | {
      readonly kind: 'group_context_route'
      readonly step: 'calendar'
    }
  | {
      readonly kind: 'group_context_route'
      readonly step: 'rules'
      readonly surface?: 'rule-sets'
    }

/**
 * THE sourceRef `kind` set — ONE authority, consulted by both the compiler and
 * the runtime validator.
 *
 * §4.2 defines no sourceRef-kind union, so this is W6's own closed set, which
 * means it must not carry a member no producer can emit. `schedule_group` was
 * declared and never produced (the same "declared enum with no producer" class
 * as the orphaned conflict code) and is gone from all three faces: this set,
 * the OpenAPI draft, and — via the derivation below — the exported TS type.
 *
 * The type is DERIVED from this array rather than written beside it. A prior
 * revision kept the two by hand and they DRIFTED: the runtime set had dropped
 * `schedule_group` while the exported type still declared it, so a value the
 * validator rejects at runtime still typechecked. Deriving makes that
 * particular disagreement unrepresentable — adding or removing a kind is one
 * edit here, and the compiler follows.
 *
 * The inner `as const` is load-bearing: without it the element type widens to
 * `string`, the derived union collapses to `string`, and the compile-time half
 * of this guarantee silently disappears while everything still builds.
 */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_REF_KINDS_V1 = Object.freeze([
  'shift',
  'rule_set',
  'fixed_schedule_config',
] as const)

/** The `kind` union, derived from the closed set above — never hand-written. */
export type AttendanceGroupEffectivePolicySourceRefKindV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_REF_KINDS_V1)[number]

/** Configuration-source references: config IDs only, never user IDs (W6-R2). */
export type AttendanceGroupEffectivePolicySourceRefV1 = {
  readonly kind: AttendanceGroupEffectivePolicySourceRefKindV1
  readonly id: string
}

/**
 * Embedded FSER effectiveness object — the FSER contract verbatim.
 * W6 declares the shape for typing; the values may only come from the
 * existing FSER service (red line W6-R4). Reason codes are typed as string
 * here on purpose: their closed list is owned by the FSER lock, and W6-2's
 * mechanical enum-equality test compares against the service's exported
 * list rather than a second hand-copied union.
 */
export type AttendanceGroupFixedScheduleEffectivenessV1 = {
  readonly state:
    | 'not_configured'
    | 'pending_apply'
    | 'effective'
    | 'configuration_changed'
  readonly reasonCodes: readonly string[]
  /**
   * `endDate` is `string | null` because the PRODUCER emits `null` BY
   * CONSTRUCTION: FSER's `formatDateOnly` returns `null` for a null column,
   * `attendance_shift_assignments.end_date` is a NULLABLE `date` with no NOT
   * NULL and no CHECK, and the canonical managed-row writer has an explicit
   * `end_date: input.endDate ?? null` branch. Declaring it `string` made this
   * type — and the validator that follows it — STRICTER THAN ITS OWN
   * PRODUCER, which §4.2 forbids: the embedded fixed-schedule object is the
   * FSER contract verbatim. `startDate` stays non-null (the column is NOT
   * NULL).
   */
  readonly desired: {
    readonly shiftId: string
    readonly startDate: string
    readonly endDate: string | null
    readonly revision: number
  } | null
  readonly coverage: {
    readonly targetMembers: number
    readonly matchingMembers: number
    readonly missingMembers: number
    readonly nonMemberTargets: number
    readonly differentKeyRows: number
  }
  readonly drift: {
    readonly unconfiguredManagedRows: number
    readonly unpublishedManagedRows: number
    /** Same nullability reasoning as `desired.endDate` above: FSER derives
     * every managed set's `endDate` through the same `formatDateOnly`, over
     * the same nullable column. `producerKey` stays non-null — it is
     * guaranteed non-null whenever `producer_type` is non-null by
     * `chk_attendance_shift_assignments_producer_metadata`. */
    readonly managedSets: ReadonlyArray<{
      readonly shiftId: string
      readonly startDate: string
      readonly endDate: string | null
      readonly producerKey: string
      readonly rowCount: number
    }>
  }
  readonly evaluatedAt: string
}

export type AttendanceGroupEffectivePolicyDomainSummaryV1 = {
  readonly label: AttendanceGroupEffectivePolicySourceLabelV1
  readonly reasonCodes: readonly string[]
  readonly sourceRefs?: readonly AttendanceGroupEffectivePolicySourceRefV1[]
  readonly editorRef: AttendanceGroupEffectivePolicyEditorRefV1
}

export type AttendanceGroupEffectivePolicyConflictV1 = {
  readonly code: AttendanceGroupEffectivePolicyConflictCodeV1
  readonly domain: AttendanceGroupEffectivePolicyDomainV1
  readonly label: 'conflict_action_required'
  /** Count only; never user IDs (red line W6-R2). */
  readonly affectedUserCount?: number
  readonly editorRef: AttendanceGroupEffectivePolicyEditorRefV1
}

/** Aggregate response `data` — design lock §4.3, exact-key. */
export type AttendanceGroupEffectivePolicyAggregateV1 = {
  readonly groupId: string
  readonly groupType: AttendanceGroupEffectivePolicyGroupTypeV1
  readonly timezone: string | null
  readonly activeMemberCount: number
  readonly managerPosture: {
    readonly ownerCount: number
    readonly subOwnerCount: number
  }
  readonly calculationPosture: AttendanceGroupEffectivePolicyCalculationPostureV1
  readonly domains: {
    readonly membership: AttendanceGroupEffectivePolicyDomainSummaryV1
    readonly schedule: AttendanceGroupEffectivePolicyDomainSummaryV1 & {
      readonly strategy: AttendanceGroupEffectivePolicyGroupTypeV1
      readonly fixedSchedule: AttendanceGroupFixedScheduleEffectivenessV1 | null
    }
    readonly segments: AttendanceGroupEffectivePolicyDomainSummaryV1
    readonly flex: AttendanceGroupEffectivePolicyDomainSummaryV1 & {
      readonly mode?: 'strict' | 'flex_required_duration'
    }
    readonly rules: AttendanceGroupEffectivePolicyDomainSummaryV1 & {
      readonly source: 'org_default' | 'group_rule_set'
    }
    readonly punchMethod: AttendanceGroupEffectivePolicyDomainSummaryV1 & {
      readonly source: 'org_inherited'
    }
    readonly requestPosture: AttendanceGroupEffectivePolicyDomainSummaryV1 & {
      readonly overtime: 'org_inherited'
      readonly makeupPunch: 'org_inherited'
      readonly outdoor: 'org_inherited'
    }
  }
  readonly conflicts: readonly AttendanceGroupEffectivePolicyConflictV1[]
  readonly evaluatedAt: string
}

export type AttendanceGroupEffectivePolicyResponseV1 = {
  readonly ok: true
  readonly data: AttendanceGroupEffectivePolicyAggregateV1
}
