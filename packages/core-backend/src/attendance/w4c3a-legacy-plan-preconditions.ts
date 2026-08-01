import {
  AttendanceLegacyExecutionPlanError,
  computeLegacyImportGroupStateFingerprintV1,
  computeLegacyImportRecordPreconditionFingerprintV1,
  legacyImportRecordWriteExpectsExistingRecordV1,
  type LegacyImportRecordPreconditionV1,
  type LegacyImportRecordWritePlanV1,
} from './w4c3a-legacy-execution-plan'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'

type QueryRow = Record<string, unknown>

class AttendanceLegacyRecordPreconditionRowError extends Error {}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function canonicalDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }
  throw new AttendanceLegacyRecordPreconditionRowError()
}

function canonicalInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return parsed.toISOString()
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return Number(value)
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null
  if (typeof value !== 'boolean') {
    throw new AttendanceLegacyRecordPreconditionRowError()
  }
  return value
}

function recordPrecondition(row: QueryRow): LegacyImportRecordPreconditionV1 {
  return {
    exists: true,
    id: requiredString(row.id),
    orgId: requiredString(row.org_id),
    userId: requiredString(row.user_id),
    workDate: canonicalDate(row.work_date),
    firstInAt: canonicalInstant(row.first_in_at),
    lastOutAt: canonicalInstant(row.last_out_at),
    workMinutes: nullableNonNegativeInteger(row.work_minutes),
    lateMinutes: nullableNonNegativeInteger(row.late_minutes),
    earlyLeaveMinutes: nullableNonNegativeInteger(row.early_leave_minutes),
    status: nullableString(row.status),
    isWorkday: nullableBoolean(row.is_workday),
    meta: row.meta ?? null,
    sourceBatchId: nullableString(row.source_batch_id),
  }
}

function revisionMatches(
  rows: readonly QueryRow[],
  expectedRevision: number,
): boolean {
  if (rows.length !== 1) return false
  const revision = Number(rows[0]?.revision)
  return (
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    revision === expectedRevision
  )
}

const LOCK_RECORD_SQL = `
  SELECT id::text AS id, org_id, user_id, work_date::text AS work_date,
         first_in_at, last_out_at, work_minutes, late_minutes,
         early_leave_minutes, status, is_workday, meta,
         source_batch_id::text AS source_batch_id
  FROM attendance_records
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  FOR UPDATE
`

const LOCK_REVISION_SQL = `
  SELECT revision::text AS revision
  FROM attendance_record_target_revisions
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  FOR UPDATE
`

const READ_RECORD_EXISTENCE_SQL = `
  SELECT 1 AS present
  FROM attendance_records
  WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date
  LIMIT 1
`

async function recheckExistingRecord(
  trx: AttendanceW4TransactionClientV1,
  write: LegacyImportRecordWritePlanV1,
): Promise<boolean> {
  const values = [write.orgId, write.userId, write.workDate]
  const recordRows = (await trx.query(LOCK_RECORD_SQL, values))
    .rows as QueryRow[]
  if (recordRows.length !== 1 || recordRows[0]?.id !== write.recordId) {
    return false
  }
  const revisionRows = (await trx.query(LOCK_REVISION_SQL, values))
    .rows as QueryRow[]
  if (!revisionMatches(revisionRows, write.targetRevision)) return false

  try {
    const precondition = recordPrecondition(recordRows[0])
    if (precondition.sourceBatchId !== write.expectedSourceOwnership) {
      return false
    }
    return (
      computeLegacyImportRecordPreconditionFingerprintV1(precondition) ===
      write.existingRecordPreconditionFingerprint
    )
  } catch (error) {
    if (
      error instanceof AttendanceLegacyRecordPreconditionRowError ||
      error instanceof AttendanceLegacyExecutionPlanError
    ) {
      return false
    }
    throw error
  }
}

async function recheckMissingRecord(
  trx: AttendanceW4TransactionClientV1,
  write: LegacyImportRecordWritePlanV1,
): Promise<boolean> {
  if (write.expectedSourceOwnership !== null) return false
  const values = [write.orgId, write.userId, write.workDate]
  const revisionRows = (await trx.query(LOCK_REVISION_SQL, values))
    .rows as QueryRow[]
  if (!revisionMatches(revisionRows, write.targetRevision)) return false
  const recordRows = (await trx.query(READ_RECORD_EXISTENCE_SQL, values)).rows
  return recordRows.length === 0
}

/**
 * Locks and rechecks every frozen record target in verified plan order.
 * SQL errors intentionally escape to the governing whole-transaction retry.
 */
export async function lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<boolean> {
  for (const write of plan.recordWrites) {
    const matches = legacyImportRecordWriteExpectsExistingRecordV1(write)
      ? await recheckExistingRecord(trx, write)
      : await recheckMissingRecord(trx, write)
    if (!matches) return false
  }
  return true
}

const LOCK_EXISTING_GROUP_SQL = `
  SELECT id::text AS id, org_id
  FROM attendance_groups
  WHERE id = $1::uuid
  FOR UPDATE
`

const LOCK_EXISTING_MEMBER_SQL = `
  SELECT group_id::text AS group_id, user_id, org_id
  FROM attendance_group_members
  WHERE org_id = $1 AND group_id = $2::uuid AND user_id = $3
  FOR UPDATE
`

const LOCK_GROUP_REVISION_SQL = `
  SELECT revision::text AS revision
  FROM attendance_group_effect_revisions
  WHERE org_id = $1
  FOR UPDATE
`

const READ_GROUP_BY_ID_SQL = `
  SELECT id::text AS id, org_id, name, code, timezone,
         rule_set_id::text AS rule_set_id
  FROM attendance_groups
  WHERE id = $1::uuid
`

const READ_GROUP_BY_NAME_SQL = `
  SELECT 1 AS present
  FROM attendance_groups
  WHERE org_id = $1 AND lower(btrim(name)) = $2
  LIMIT 1
`

const READ_MEMBER_SQL = `
  SELECT 1 AS present
  FROM attendance_group_members
  WHERE org_id = $1 AND group_id = $2::uuid AND user_id = $3
  LIMIT 1
`

/**
 * OD-W4C-58=(a) worker lock and recheck order for group/member effects.
 * Uses only verified plan existence branches — never current-state guesses.
 * SQLSTATE 40001/40P01 propagate to the governing whole-transaction retry.
 */
export async function lockAndRecheckAttendanceLegacyGroupPreconditionsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<boolean> {
  if (plan.groupEffects.length === 0) {
    return plan.manifest.groupRevision === null &&
      plan.manifest.groupStateFingerprint === null
  }
  if (
    plan.manifest.groupRevision === null ||
    plan.manifest.groupStateFingerprint === null
  ) {
    return false
  }

  const orgId = plan.manifest.orgId
  const existingGroups = plan.groupEffects
    .filter(
      (
        effect,
      ): effect is Extract<
        (typeof plan.groupEffects)[number],
        { kind: 'ensure_group' }
      > => effect.kind === 'ensure_group' && effect.groupExistedAtPrepare,
    )
    .slice()
    .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
  const existingMembers = plan.groupEffects
    .filter(
      (
        effect,
      ): effect is Extract<
        (typeof plan.groupEffects)[number],
        { kind: 'ensure_member' }
      > =>
        effect.kind === 'ensure_member' && effect.membershipExistedAtPrepare,
    )
    .slice()
    .sort((a, b) => {
      return compareUtf8(a.groupRef, b.groupRef) || compareUtf8(a.userId, b.userId)
    })

  // 1-3: lock frozen-existing groups FOR UPDATE by UTF-8 groupId.
  for (const effect of existingGroups) {
    const rows = (await trx.query(LOCK_EXISTING_GROUP_SQL, [effect.groupId]))
      .rows as QueryRow[]
    if (
      rows.length !== 1 ||
      String(rows[0]?.id) !== effect.groupId ||
      String(rows[0]?.org_id) !== orgId
    ) {
      return false
    }
  }

  // 4-5: lock frozen-existing members FOR UPDATE by UTF-8 (groupRef, userId).
  for (const effect of existingMembers) {
    const rows = (
      await trx.query(LOCK_EXISTING_MEMBER_SQL, [
        orgId,
        effect.groupRef,
        effect.userId,
      ])
    ).rows as QueryRow[]
    if (
      rows.length !== 1 ||
      String(rows[0]?.group_id) !== effect.groupRef ||
      String(rows[0]?.user_id) !== effect.userId ||
      String(rows[0]?.org_id) !== orgId
    ) {
      return false
    }
  }

  // 6-7: lock org revision and require exact equality.
  const revisionRows = (await trx.query(LOCK_GROUP_REVISION_SQL, [orgId]))
    .rows as QueryRow[]
  if (!revisionMatches(revisionRows, plan.manifest.groupRevision)) return false

  // 8-10: re-read effective group IDs and member keys; reconstruct fingerprint.
  const fingerprintGroups: Array<{
    id: string
    orgId: string
    name: string
    code: string | null
    timezone: string
    ruleSetId: string | null
  }> = []
  const seenGroupIds = new Set<string>()
  for (const effect of plan.groupEffects) {
    if (effect.kind === 'ensure_group') {
      if (effect.groupExistedAtPrepare) {
        if (seenGroupIds.has(effect.groupId)) return false
        seenGroupIds.add(effect.groupId)
        const rows = (await trx.query(READ_GROUP_BY_ID_SQL, [effect.groupId]))
          .rows as QueryRow[]
        if (
          rows.length !== 1 ||
          String(rows[0]?.org_id) !== orgId
        ) {
          return false
        }
        fingerprintGroups.push({
          id: String(rows[0].id),
          orgId: String(rows[0].org_id),
          name: String(rows[0].name),
          code: rows[0].code === null ? null : String(rows[0].code),
          timezone: String(rows[0].timezone),
          ruleSetId:
            rows[0].rule_set_id === null ? null : String(rows[0].rule_set_id),
        })
      } else {
        const absent = (
          await trx.query(READ_GROUP_BY_NAME_SQL, [
            orgId,
            effect.normalizedName,
          ])
        ).rows
        if (absent.length !== 0) return false
        const byId = (await trx.query(READ_GROUP_BY_ID_SQL, [effect.groupId]))
          .rows
        if (byId.length !== 0) return false
      }
      continue
    }
    // ensure_member
    if (effect.membershipExistedAtPrepare) {
      const rows = (
        await trx.query(READ_MEMBER_SQL, [
          orgId,
          effect.groupRef,
          effect.userId,
        ])
      ).rows
      if (rows.length !== 1) return false
    } else {
      const rows = (
        await trx.query(READ_MEMBER_SQL, [
          orgId,
          effect.groupRef,
          effect.userId,
        ])
      ).rows
      if (rows.length !== 0) return false
    }
    // Effective existing group referenced only by membership (no ensure_group).
    if (
      !seenGroupIds.has(effect.groupRef) &&
      !plan.groupEffects.some(
        (candidate) =>
          candidate.kind === 'ensure_group' &&
          candidate.groupId === effect.groupRef,
      )
    ) {
      const rows = (await trx.query(READ_GROUP_BY_ID_SQL, [effect.groupRef]))
        .rows as QueryRow[]
      if (rows.length !== 1 || String(rows[0]?.org_id) !== orgId) return false
      seenGroupIds.add(effect.groupRef)
      fingerprintGroups.push({
        id: String(rows[0].id),
        orgId: String(rows[0].org_id),
        name: String(rows[0].name),
        code: rows[0].code === null ? null : String(rows[0].code),
        timezone: String(rows[0].timezone),
        ruleSetId:
          rows[0].rule_set_id === null ? null : String(rows[0].rule_set_id),
      })
    } else if (
      !seenGroupIds.has(effect.groupRef) &&
      plan.groupEffects.some(
        (candidate) =>
          candidate.kind === 'ensure_group' &&
          candidate.groupId === effect.groupRef &&
          candidate.groupExistedAtPrepare,
      )
    ) {
      // Already captured via ensure_group existing branch above.
    }
  }

  const memberships = plan.groupEffects
    .filter(
      (
        effect,
      ): effect is Extract<
        (typeof plan.groupEffects)[number],
        { kind: 'ensure_member' }
      > => effect.kind === 'ensure_member',
    )
    .map((effect) => ({
      orgId,
      groupId: effect.groupRef,
      userId: effect.userId,
      exists: effect.membershipExistedAtPrepare,
    }))

  try {
    return (
      computeLegacyImportGroupStateFingerprintV1({
        groups: fingerprintGroups,
        memberships,
      }) === plan.manifest.groupStateFingerprint
    )
  } catch {
    return false
  }
}

/**
 * Combined record then group precondition recheck for the canonical processor.
 * Record targets first (amendment §5); group effects follow OD-W4C-58 order.
 */
export async function lockAndRecheckAttendanceLegacyPlanPreconditionsV1(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
): Promise<boolean> {
  if (!(await lockAndRecheckAttendanceLegacyRecordPreconditionsV1(trx, plan))) {
    return false
  }
  return lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx, plan)
}
