import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { parseCanonicalAttendanceRolloutOrgKeyV1 } from './w4c0-identity'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import { attendanceW4ConnectionDiscardV1, runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { readAttendancePunchDetailEnvelopeV1 } from './w4c3a-punch-detail-command'
import type { AttendancePunchDetailPreparationReadClientV1 } from './w4c3a-punch-detail-preparation-host'
import { authorizeCurrentAttendancePunchDetailPreviewV1, type AttendancePunchDetailPreviewAuthorizerV1 } from './w4c3a-punch-detail-preview-host'
import { verifyAttendancePunchDetailPreviewRecordV1, type AttendancePunchDetailPreviewBindingV1 } from './w4c3a-punch-detail-preview-record'
import { admitCurrentAttendancePunchDetailV1 } from './w4c3a-punch-detail-replay-host'
import type { AttendanceSyncImportHostDepsV1 } from './w4c3a-sync-import-host'

type Scope = AttendancePunchDetailPreviewBindingV1['scope']
const JOB_COLUMNS = `j.id,j.org_id,j.created_by,j.batch_id,j.idempotency_key,j.status,j.progress,j.total,
  j.error,j.started_at,j.finished_at,j.created_at,j.updated_at,j.w4_contract_version,
  j.punch_preview_version,j.punch_preview_request_fingerprint,j.punch_preview_snapshot_digest,
  j.punch_preview_actor_posture,j.punch_preview_token_subject_user_id`
const IDENTITY_COLUMNS = ['id', 'org_id', 'created_by', 'batch_id', 'idempotency_key', 'w4_contract_version',
  'punch_preview_version', 'punch_preview_request_fingerprint', 'punch_preview_snapshot_digest',
  'punch_preview_actor_posture', 'punch_preview_token_subject_user_id'] as const

function binding(row: Record<string, unknown>): AttendancePunchDetailPreviewBindingV1 {
  if (row.punch_preview_version !== 1 || row.w4_contract_version !== null) {
    throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
  }
  return { jobId: row.id as string, batchId: row.batch_id as string,
    scope: { orgId: row.org_id as string, actorId: row.created_by as string,
      actorPosture: row.punch_preview_actor_posture as Scope['actorPosture'],
      tokenSubjectUserId: row.punch_preview_token_subject_user_id as string | null },
    requestFingerprint: row.punch_preview_request_fingerprint as string,
    snapshotDigest: row.punch_preview_snapshot_digest as string }
}

/** Job-ID-only recovery; no mutable payload, policy resolver, calculator override or effect writer. */
export function createAttendancePunchDetailPreviewJobHostV1(deps: AttendanceSyncImportHostDepsV1) {
  async function execute(jobId: string, authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1, reader?: Scope) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(jobId)) {
      throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_INVALID')
    }
    const readerScope = reader ? Object.freeze({ ...reader }) : undefined
    if (readerScope) parseCanonicalAttendanceRolloutOrgKeyV1(readerScope.orgId)
    const acquired = await deps.acquireConnection()
    let discard: Error | undefined
    try {
      return await runAttendanceResultOperationTransactionV1(acquired.client, async (trx) => {
        // Only job identity and the target command needed for current authorization.
        // No row lock before the timezone/rollout prefix; no calculated result yet.
        const seeds = await trx.query(`SELECT ${JOB_COLUMNS},r.snapshot->'envelope' AS envelope
          FROM attendance_import_jobs j LEFT JOIN attendance_import_punch_preview_records r ON r.job_id=j.id
          WHERE j.id=$1${readerScope ? ' AND j.org_id=$2' : ''}`, readerScope ? [jobId, readerScope.orgId] : [jobId])
        if (!seeds.rows.length) return null
        if (seeds.rows.length !== 1) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
        const seed = seeds.rows[0] as Record<string, unknown>
        const expected = binding(seed)
        if (expected.jobId !== jobId || (readerScope && expected.scope.orgId !== readerScope.orgId)) {
          throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
        }
        const envelope = readAttendancePunchDetailEnvelopeV1(seed.envelope)
        if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_INVALID')
        const scope = readerScope ?? expected.scope
        await admitCurrentAttendancePunchDetailV1(trx, scope, envelope)
        let active = true
        const client: AttendancePunchDetailPreparationReadClientV1 = Object.freeze({
          __w4CanonicalTrx: true,
          async query(sql: string, params?: unknown[]) {
            if (!active) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_CLOSED')
            return (await trx.query(sql, params)).rows as Record<string, unknown>[]
          },
        })
        try {
          if (await authorizeCurrentAttendancePunchDetailPreviewV1(client, Object.freeze({ scope, envelope }), authorizeTarget) !== true) {
            throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
          }
          const rows = await client.query(`SELECT ${JOB_COLUMNS},r.snapshot
            FROM attendance_import_jobs j LEFT JOIN attendance_import_punch_preview_records r ON r.job_id=j.id
            WHERE j.id=$1 AND j.org_id=$2 FOR UPDATE OF j`, [jobId, expected.scope.orgId])
          const row = rows[0]
          if (rows.length !== 1 || IDENTITY_COLUMNS.some(key => row[key] !== seed[key])) {
            throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
          }
          const record = verifyAttendancePunchDetailPreviewRecordV1(row.snapshot, binding(row))
          if (canonicalAttendanceJsonV1(record.envelope) !== canonicalAttendanceJsonV1(envelope)) {
            throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_IDENTITY_MISMATCH')
          }
          if (!['queued', 'running', 'completed', 'failed'].includes(row.status as string)) {
            throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_INVALID')
          }
          const { snapshot: _snapshot, ...job } = row
          if (readerScope || row.status === 'completed' || row.status === 'failed') {
            return { job, record, changed: false }
          }
          const completed = await client.query(`UPDATE attendance_import_jobs AS j
            SET status='completed',progress=$3,total=$3,started_at=COALESCE(started_at,now()),
              finished_at=now(),updated_at=now(),error=NULL
            WHERE j.id=$1 AND j.org_id=$2 AND j.status IN ('queued','running') RETURNING ${JOB_COLUMNS}`,
          [jobId, expected.scope.orgId, record.preview.eventCount])
          if (completed.length !== 1) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_COMPLETION_FAILED')
          return { job: completed[0], record, changed: true }
        } finally { active = false }
      })
    } catch (error) {
      discard = attendanceW4ConnectionDiscardV1(error)
      throw error
    } finally { acquired.release(discard) }
  }
  return Object.freeze({
    readPunchDetailPreviewJob(input: { jobId: string; scope: Scope }, authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1) {
      return execute(input.jobId, authorizeTarget, input.scope)
    },
    async processPunchDetailPreviewJob(input: { jobId: string }, authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1) {
      const result = await execute(input.jobId, authorizeTarget)
      return result ? { kind: result.job.status as 'completed' | 'failed', idempotent: !result.changed } : { kind: 'not_found' as const }
    },
  })
}
