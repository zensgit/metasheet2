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
 */
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

export class AttendanceLegacyGroupEffectError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyGroupEffectError'
    this.code = code
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

  let groupCreated = 0
  let groupMembersAdded = 0
  const ensureGroupCount = plan.groupEffects.filter(
    (effect) => effect.kind === 'ensure_group',
  ).length
  const ensureMemberCount = plan.groupEffects.filter(
    (effect) => effect.kind === 'ensure_member',
  ).length

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

  if (groupCreated > ensureGroupCount || groupMembersAdded > ensureMemberCount) {
    fail('W4C3A_GROUP_EFFECT_COUNT_INVALID')
  }
  return Object.freeze({ groupCreated, groupMembersAdded })
}
