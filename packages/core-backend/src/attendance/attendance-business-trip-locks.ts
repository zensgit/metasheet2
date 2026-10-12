import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { acquireAttendanceTimezoneRuntimeLocksV1, buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from './attendance-timezone-runtime-locks'

type SourceVerifier = () => Promise<void>
type RequestSourceGuard = (trx: AttendanceW4TransactionClientV1, input: {orgId:string;userIds:null}) => Promise<SourceVerifier>
let requestSourceGuard: RequestSourceGuard | null = null
const preparedSourceGuards = new WeakMap<object,{transactionId:string;orgId:string;verify:SourceVerifier}>()
const preparedRelatedPrefixes = new WeakMap<object,{transactionId:string;orgId:string;userId:string}>()
export function registerAttendanceRequestTimezoneSourceGuardV1(guard: RequestSourceGuard | null): void {
  requestSourceGuard = guard
}

// Called before original/round/request row locks. External redemption only
// verifies the prefix already taken by dispatchAction; it never takes it late.
export async function acquireBusinessTripRequestPrefixV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgId: string; userId?: string; actorId?: string; requestId?: string; creatingTrip?: boolean; external?: boolean },
): Promise<SourceVerifier | void> {
  let userId = input.userId
  let scheduleSource = false
  let relatedSource = false
  if (!input.creatingTrip) {
    if (!input.requestId) return
    const rows = await trx.query(
      "SELECT user_id,request_type FROM attendance_requests WHERE id=$1::uuid AND org_id=$2 AND request_type IN ('business_trip','shift_swap','schedule_dispatch','leave','overtime','missed_check_in','missed_check_out','time_correction')",
      [input.requestId,input.orgId],
    )
    if (rows.rows.length === 0) return
    if (rows.rows.length !== 1) throw new Error('ATTENDANCE_TRIP_REQUEST_BINDING')
    scheduleSource = rows.rows[0].request_type === 'shift_swap' || rows.rows[0].request_type === 'schedule_dispatch'
    relatedSource = ['leave','overtime','missed_check_in','missed_check_out','time_correction'].includes(String(rows.rows[0].request_type))
    userId = typeof rows.rows[0].user_id === 'string' ? rows.rows[0].user_id : undefined
  }
  if (!userId) throw new Error('ATTENDANCE_TRIP_INVALID_SUBJECT')
  if (input.external) {
    const lock = await trx.query(`SELECT 1 FROM pg_locks
      WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode=ANY($2::text[]) AND granted
      AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
      AND objid=(hashtextextended($1,0) & 4294967295)::oid AND objsubid=1 LIMIT 1`,
    [buildAttendanceTimezoneRuntimeOrgLockKeyV1(input.orgId),relatedSource ? ['ShareLock','ExclusiveLock'] : ['ExclusiveLock']])
    if (lock.rows.length !== 1) throw new Error('ATTENDANCE_TRIP_EXTERNAL_PREFIX_REQUIRED')
    if (relatedSource) {
      const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
      const prepared = preparedRelatedPrefixes.get(trx)
      if (!prepared || prepared.orgId !== input.orgId || prepared.userId !== userId
        || prepared.transactionId !== transaction.rows[0]?.transaction_id) {
        throw new Error('ATTENDANCE_TIMEZONE_EXTERNAL_PREFIX_REQUIRED')
      }
      return
    }
    if (scheduleSource) {
      const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
      const prepared = preparedSourceGuards.get(trx)
      if (!prepared || prepared.orgId !== input.orgId || prepared.transactionId !== transaction.rows[0]?.transaction_id) {
        throw new Error('ATTENDANCE_TIMEZONE_EXTERNAL_SOURCE_GUARD_REQUIRED')
      }
      return prepared.verify
    }
    return
  }
  await acquireAttendanceTimezoneRuntimeLocksV1(trx, { orgId:input.orgId, userId, mode:relatedSource ? 'shared' : 'exclusive' })
  if (relatedSource) {
    const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
    const transactionId = transaction.rows[0]?.transaction_id
    if (typeof transactionId !== 'string') throw new Error('ATTENDANCE_TIMEZONE_TRANSACTION_REQUIRED')
    preparedRelatedPrefixes.set(trx,{transactionId,orgId:input.orgId,userId})
    // Actor authorization remains in the original request/approval protocol.
    // This prefix carries lock preparation, never a permission grant.
    return
  }
  let verify: SourceVerifier | undefined
  if (scheduleSource) {
    const schema = await trx.query("SELECT to_regclass('public.attendance_timezone_context_companions') IS NOT NULL AS present")
    if (schema.rows.length !== 1 || schema.rows[0].present !== true) {
      throw Object.assign(new Error('ATTENDANCE_TIMEZONE_SCHEMA_UNAVAILABLE'), {
        name: 'AttendanceBusinessTripError',
        code: 'ATTENDANCE_TIMEZONE_SCHEMA_UNAVAILABLE',
        httpStatus: 503,
      })
    }
    if (schema.rows[0].present) {
      if (!requestSourceGuard) throw new Error('ATTENDANCE_TIMEZONE_WRITE_GUARD_UNAVAILABLE')
      verify = await requestSourceGuard(trx,{orgId:input.orgId,userIds:null})
      const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
      const transactionId = transaction.rows[0]?.transaction_id
      if (typeof transactionId !== 'string') throw new Error('ATTENDANCE_TIMEZONE_TRANSACTION_REQUIRED')
      preparedSourceGuards.set(trx,{transactionId,orgId:input.orgId,verify})
    }
  }
  const subjects = [...new Set([userId,input.actorId ?? userId])].sort()
  for (const subject of subjects) {
    const members = await trx.query('SELECT u.id FROM users u JOIN user_orgs uo ON uo.user_id=u.id '
      + 'WHERE u.id=$1 AND uo.org_id=$2 AND u.is_active=true AND uo.is_active=true FOR SHARE OF u,uo', [subject,input.orgId])
    if (members.rows.length !== 1) {
      const error = new Error('ATTENDANCE_TRIP_MEMBER_REQUIRED') as Error & { code:string;httpStatus:number }
      error.name='AttendanceBusinessTripError';error.code='ATTENDANCE_TRIP_MEMBER_REQUIRED';error.httpStatus=403
      throw error
    }
  }
  return verify
}


// Import hosts take this prefix before class-00; completed replay never
// prepares mutable source facts. Effects only consume a same-transaction proof.
export async function acquireAttendanceImportTimezonePrefixV1(
  trx: AttendanceW4TransactionClientV1, orgId: string,
): Promise<void> {
  await trx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)])
}

export async function prepareAttendanceImportTimezoneSourceV1(
  trx: AttendanceW4TransactionClientV1, orgId: string,
): Promise<void> {
  const held = await trx.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid() AND mode='ExclusiveLock' AND granted
    AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
    AND objid=(hashtextextended($1,0) & 4294967295)::oid AND objsubid=1 LIMIT 1`,
  [buildAttendanceTimezoneRuntimeOrgLockKeyV1(orgId)])
  if (held.rows.length !== 1) throw new Error('ATTENDANCE_TIMEZONE_IMPORT_PREFIX_REQUIRED')
  const schema = await trx.query("SELECT to_regclass('public.attendance_timezone_policies') IS NOT NULL AS present")
  if (schema.rows.length !== 1 || typeof schema.rows[0].present !== 'boolean') {
    throw new Error('ATTENDANCE_TIMEZONE_SCHEMA_UNAVAILABLE')
  }
  if (!schema.rows[0].present) throw new Error('ATTENDANCE_TIMEZONE_SCHEMA_UNAVAILABLE')
  if (!requestSourceGuard) throw new Error('ATTENDANCE_TIMEZONE_WRITE_GUARD_UNAVAILABLE')
  // OFF still has group-scoped calendar rules. Protect started contexts in both modes.
  const verify = await requestSourceGuard(trx,{orgId,userIds:null})
  const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
  const transactionId = transaction.rows[0]?.transaction_id
  if (typeof transactionId !== 'string') throw new Error('ATTENDANCE_TIMEZONE_TRANSACTION_REQUIRED')
  preparedSourceGuards.set(trx,{transactionId,orgId,verify})
}

export async function requireAttendanceImportTimezoneSourceV1(
  trx: AttendanceW4TransactionClientV1, orgId: string,
): Promise<SourceVerifier> {
  const transaction = await trx.query('SELECT txid_current()::text AS transaction_id')
  const prepared = preparedSourceGuards.get(trx)
  if (!prepared || prepared.orgId !== orgId || prepared.transactionId !== transaction.rows[0]?.transaction_id) {
    throw new Error('ATTENDANCE_TIMEZONE_IMPORT_SOURCE_REQUIRED')
  }
  return prepared.verify
}
