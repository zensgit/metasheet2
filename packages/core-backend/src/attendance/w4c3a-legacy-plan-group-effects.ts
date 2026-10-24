/**
 * W4C-3a fixed group/member effect adapter for verified durable plans.
 *
 * Preconditions are locked/rechecked elsewhere. This module only applies the
 * frozen groupEffects on a VerifiedAttendanceLegacyPlanV1 using fixed SQL:
 * ensure_group uses INSERT ... ON CONFLICT DO UPDATE RETURNING (counts as
 * groupCreated including conflict-update rows); ensure_member uses
 * INSERT ... ON CONFLICT DO NOTHING RETURNING (counts only actual inserts).
 *
 * Never rereads rules/settings/profile/source or recomputes existence branches.
 * ensure_member still rechecks user_orgs ∩ users.is_active in this same
 * transaction immediately before INSERT. A frozen plan is not a license to
 * write a member who was deactivated after enqueue. The trusted timezone
 * verifier checks source invariants after effects; its proof is prepared by
 * the host.
 */
import { requireAttendanceManagementGroupAdmission } from './attendance-group-membership-policy'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { requireAttendanceImportTimezoneSourceV1 } from './attendance-business-trip-locks'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

export class AttendanceLegacyGroupEffectError extends Error {
  readonly code: string
  readonly status: number | null
  readonly details: readonly Record<string, unknown>[] | null

  constructor(
    code: string,
    extras?: {
      status?: number
      details?: readonly Record<string, unknown>[]
    },
  ) {
    super(code)
    this.name = 'AttendanceLegacyGroupEffectError'
    this.code = code
    this.status = extras?.status ?? null
    this.details = extras?.details ?? null
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyGroupEffectError(code)
}

export type AttendanceLegacyGroupEffectResultV1 = Readonly<{
  readonly groupCreated: number
  readonly groupMembersAdded: number
}>

const ENSURE_GROUP_SQL = `
  INSERT INTO attendance_groups (
    id, org_id, name, code, timezone, rule_set_id, description, created_at, updated_at
  ) VALUES (
    $1::uuid, $2, $3, $4, $5, $6::uuid, NULL, now(), now()
  )
  ON CONFLICT (org_id, name) DO UPDATE SET
    timezone = COALESCE(attendance_groups.timezone, EXCLUDED.timezone),
    rule_set_id = COALESCE(attendance_groups.rule_set_id, EXCLUDED.rule_set_id),
    updated_at = now()
  RETURNING id::text AS id
`

const ENSURE_MEMBER_SQL = `
  INSERT INTO attendance_group_members (
    id, org_id, group_id, user_id, created_at, updated_at
  ) VALUES (
    $1::uuid, $2, $3::uuid, $4, now(), now()
  )
  ON CONFLICT (org_id, group_id, user_id) DO NOTHING
  RETURNING id::text AS id
`

const ACTIVE_ORG_MEMBER_USER_IDS_SQL = `
  SELECT uo.user_id
    FROM user_orgs uo
    JOIN users u ON u.id = uo.user_id
   WHERE uo.org_id = $1
     AND uo.user_id = ANY($2::text[])
     AND uo.is_active = true
     AND u.is_active = true
   FOR SHARE OF uo, u
`

export function throwAttendanceRosterOrgMembershipError(
  plan: VerifiedAttendanceLegacyPlanV1,
  rejectedUserIds: readonly string[],
): never {
  const indexes = rosterWriteIndexes(plan, rejectedUserIds)
  throw new AttendanceLegacyGroupEffectError('W4C3A_MEMBER_NOT_ACTIVE_IN_ORG', {
    status: 404,
    // Older V1 plans do not freeze member source rows. Keep the visible
    // membership failure, but require re-prepare instead of guessing indexes.
    details: indexes === null ? [] : [{
      code: 'USER_NOT_IN_ORG',
      rejectedCount: indexes.length,
      indexes,
    }],
  })
}

function rosterWriteIndexes(
  plan: VerifiedAttendanceLegacyPlanV1,
  rejected: readonly string[],
): number[] | null {
  const rejectedSet = new Set(rejected)
  const indexes = new Set<number>()
  for (const effect of plan.groupEffects) {
    if (effect.kind !== 'ensure_member' || !rejectedSet.has(effect.userId)) continue
    if (effect.sourceOrdinals === undefined) return null
    for (const ordinal of effect.sourceOrdinals) indexes.add(ordinal)
  }
  return [...indexes].sort((left, right) => left - right)
}

/**
 * Applies frozen group/member effects from a verified plan only.
 * Empty plan.groupEffects performs zero SQL and returns zero counts.
 */
export async function applyAttendanceLegacyGroupEffectsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<AttendanceLegacyGroupEffectResultV1> {
  if (plan.groupEffects.length === 0) {
    return Object.freeze({ groupCreated: 0, groupMembersAdded: 0 })
  }

  const verifyTimezoneSource = await requireAttendanceImportTimezoneSourceV1(trx, plan.manifest.orgId)

  let groupCreated = 0
  let groupMembersAdded = 0
  const ensureGroupCount = plan.groupEffects.filter(
    (effect) => effect.kind === 'ensure_group',
  ).length
  const ensureMemberCount = plan.groupEffects.filter(
    (effect) => effect.kind === 'ensure_member',
  ).length

  const memberUserIds: string[] = []
  const seenMemberUserIds = new Set<string>()
  for (const effect of plan.groupEffects) {
    if (effect.kind !== 'ensure_member') continue
    const userId = String(effect.userId ?? '').trim()
    if (!userId || seenMemberUserIds.has(userId)) continue
    seenMemberUserIds.add(userId)
    memberUserIds.push(userId)
  }
  // Before any group or member INSERT. A later throw does not abort PostgreSQL
  // by itself, so a caller that records the failure and commits must not have
  // already written a group or an earlier member.
  if (memberUserIds.length > 0) {
    const membership = await trx.query(ACTIVE_ORG_MEMBER_USER_IDS_SQL, [
      plan.manifest.orgId,
      memberUserIds,
    ])
    const active = new Set(
      membership.rows.map((row) => String((row as Record<string, unknown>).user_id ?? '')),
    )
    const rejected = memberUserIds.filter((userId) => !active.has(userId))
    if (rejected.length > 0) {
      throwAttendanceRosterOrgMembershipError(plan, rejected)
    }
  }

  await requireAttendanceManagementGroupAdmission(trx, plan.manifest.orgId, plan.groupEffects
    .flatMap(effect => effect.kind === 'ensure_member'
      ? [{ groupId: effect.groupRef, userId: effect.userId }] : []))

  // Fixed order: groups first, members second (OD-W4C-58 §5 / effect adapter).
  for (const effect of plan.groupEffects) {
    if (effect.kind !== 'ensure_group') continue
    const result = await trx.query(ENSURE_GROUP_SQL, [
      effect.groupId,
      plan.manifest.orgId,
      effect.displayName,
      effect.code,
      effect.timezone,
      effect.ruleSetId,
    ])
    if (result.rows.length !== 1) fail('W4C3A_GROUP_EFFECT_ROW_MISMATCH')
    const returnedId = String(
      (result.rows[0] as Record<string, unknown>).id ?? '',
    )
    if (returnedId !== effect.groupId) {
      fail('W4C3A_GROUP_EFFECT_ROW_MISMATCH')
    }
    groupCreated += 1
  }

  for (const effect of plan.groupEffects) {
    if (effect.kind !== 'ensure_member') continue
    const result = await trx.query(ENSURE_MEMBER_SQL, [
      effect.memberId,
      plan.manifest.orgId,
      effect.groupRef,
      effect.userId,
    ])
    // Conflict-ignore returns zero rows when the membership already exists.
    groupMembersAdded += result.rows.length
  }

  await verifyTimezoneSource()

  if (groupCreated > ensureGroupCount || groupMembersAdded > ensureMemberCount) {
    fail('W4C3A_GROUP_EFFECT_COUNT_INVALID')
  }
  return Object.freeze({ groupCreated, groupMembersAdded })
}
