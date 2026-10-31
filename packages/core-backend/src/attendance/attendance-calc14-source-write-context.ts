import {
  AttendanceW4IdentityError,
  acquireAttendanceCalculationRolloutLock,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import { resolveAttendanceW7ContextSourcePostureV1 } from './w7-resolver/w7-context-source-posture-resolver'

export class AttendanceCalc14SourceWriteError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code)
    this.name = 'AttendanceCalc14SourceWriteError'
  }
}

export function isAttendanceCalc14BusinessDateV1(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number(value.slice(0, 4)) === 0) return false
  const at = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value
}

/** Public validator for core and the attendance host's existing CJS transport. */
export function assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(
  value: unknown,
  today: string,
): string {
  if (value === undefined) {
    throw new AttendanceCalc14SourceWriteError(422, 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED')
  }
  if (!isAttendanceCalc14BusinessDateV1(value) || !isAttendanceCalc14BusinessDateV1(today)) {
    throw new AttendanceCalc14SourceWriteError(422, 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID')
  }
  if (value < today) {
    throw new AttendanceCalc14SourceWriteError(403, 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED')
  }
  return value
}

export function attendanceCalc14SourceWriteErrorV1(error: unknown): AttendanceCalc14SourceWriteError | null {
  if (error instanceof AttendanceCalc14SourceWriteError) return error
  const dbError = error as { code?: string; message?: string } | null
  if (dbError?.code !== '23514') return null
  const statuses: Record<string, number> = {
    ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED: 422,
    ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT: 409,
    ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID: 403,
    ATTENDANCE_CALC14_SOURCE_IMMUTABLE: 409,
  }
  const status = statuses[dbError.message ?? '']
  return typeof status === 'number'
    ? new AttendanceCalc14SourceWriteError(status, dbError.message as string)
    : null
}

// These are the deferred capture triggers reached by the two core writers.
const CORE_CAPTURE_TRIGGERS = [
  'calc14_capture_attendance_group_members',
  'calc14_capture_attendance_shift_assignments',
  'calc14_capture_attendance_calculation_group_memberships',
].join(', ')

/**
 * The caller authorizes org/actor and holds its existing org source lock.
 * Only the supplied transaction is used; no pooled queries or plugin imports.
 * Missing dates are left to semantic capture, so no-op DML needs no date.
 */
export async function prepareAttendanceCalc14SourceWriteContextV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgId: string; actorId: string; businessEffectiveDate?: unknown },
): Promise<() => Promise<void>> {
  let orgKey: ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1>
  try {
    orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
  } catch (error) {
    // Existing host convention: non-rollout orgs cannot have W7 posture rows.
    if (error instanceof AttendanceW4IdentityError && error.code === 'W4C0_ROLLOUT_ORG_KEY_INVALID') {
      return async () => {}
    }
    throw error
  }
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveAttendanceW7ContextSourcePostureV1(trx, input.orgId)
  if (posture.effectiveState === 'off') return async () => {}
  if (typeof input.actorId !== 'string' || !input.actorId.trim()) {
    throw new AttendanceCalc14SourceWriteError(403, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID')
  }

  let effectiveDate: string | undefined
  if (input.businessEffectiveDate !== undefined) {
    const rules = await trx.query(
      'SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true FOR SHARE',
      [input.orgId],
    )
    const timezone = rules.rows.length === 1 ? rules.rows[0].timezone : null
    let today: string
    try {
      if (typeof timezone !== 'string' || !timezone) throw new Error()
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date())
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value
      today = `${part('year')}-${part('month')}-${part('day')}`
    } catch {
      throw new AttendanceCalc14SourceWriteError(422, 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    }
    effectiveDate = assertAttendanceCalc14OrdinaryBusinessEffectiveDateV1(input.businessEffectiveDate, today)
  }

  const context = await trx.query(
    `SELECT nullif(current_setting('metasheet.calc14_org',true),'') AS org_id,
      nullif(current_setting('metasheet.calc14_business_effective_date',true),'') AS effective_date,
      nullif(current_setting('metasheet.calc14_actor',true),'') AS actor_id`,
  )
  const prior = context.rows[0]
  if ((prior?.org_id && prior.org_id !== input.orgId)
    || (prior?.actor_id && prior.actor_id !== input.actorId)) {
    throw new AttendanceCalc14SourceWriteError(403, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID')
  }
  if (prior?.effective_date && prior.effective_date !== effectiveDate) {
    throw new AttendanceCalc14SourceWriteError(409, 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT')
  }
  await trx.query(
    `SELECT set_config('metasheet.calc14_org',$1,true),
      set_config('metasheet.calc14_date_required','true',true),
      set_config('metasheet.calc14_business_effective_date',$2,true),
      set_config('metasheet.calc14_actor',$3,true)`,
    [input.orgId, effectiveDate ?? '', input.actorId],
  )
  return async () => {
    try {
      await trx.query(`SET CONSTRAINTS ${CORE_CAPTURE_TRIGGERS} IMMEDIATE`)
      await trx.query(`SET CONSTRAINTS ${CORE_CAPTURE_TRIGGERS} DEFERRED`)
    } catch (error) {
      throw attendanceCalc14SourceWriteErrorV1(error) ?? error
    }
  }
}
