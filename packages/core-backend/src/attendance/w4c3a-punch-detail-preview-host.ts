import { inspectPermissionCodesByNamespaceAdmission } from '../rbac/namespace-admission'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import { sha256HexOfCanonicalJsonV1 } from './w4c3a-legacy-execution-plan'
import { readAttendancePunchDetailEnvelopeV1 } from './w4c3a-punch-detail-command'
import type {
  AttendancePunchDetailFrozenTargetResolverV1,
  AttendancePunchDetailPreparationHostInputV1,
  AttendancePunchDetailPreparationReadClientV1,
} from './w4c3a-punch-detail-preparation-host'
import {
  buildAttendancePunchDetailPreviewRecordV1,
  fingerprintAttendancePunchDetailPreviewRequestV1,
  verifyAttendancePunchDetailPreviewRecordV1,
  type AttendancePunchDetailPreviewRecordV1,
} from './w4c3a-punch-detail-preview-record'
import { withCurrentAttendancePunchDetailReplayV1 } from './w4c3a-punch-detail-replay-host'
import type { AttendanceSyncImportHostDepsV1 } from './w4c3a-sync-import-host'

type PreviewInput = Pick<AttendancePunchDetailPreparationHostInputV1, 'scope' | 'envelope'> & { previewLimit: number }
export type AttendancePunchDetailPreviewAuthorizerV1 = (
  client: AttendancePunchDetailPreparationReadClientV1,
  input: Readonly<Pick<PreviewInput, 'scope' | 'envelope'>>,
) => Promise<boolean>

/** Namespace admission is separate from the full-import or scoped-target decision. */
export async function authorizeCurrentAttendancePunchDetailPreviewV1(
  client: AttendancePunchDetailPreparationReadClientV1,
  input: Readonly<Pick<PreviewInput, 'scope' | 'envelope'>>,
  authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1,
): Promise<boolean> {
  const admission = await inspectPermissionCodesByNamespaceAdmission(input.scope.actorId, ['attendance:import'],
    async (sql, params) => ({ rows: await client.query(sql, params) }))
  return !admission.unavailable && admission.codes.includes('attendance:import')
    && await authorizeTarget(client, input) === true
}

const JOB_COLUMNS = `j.id,j.org_id,j.created_by,j.batch_id,j.idempotency_key,j.status,j.progress,j.total,
  j.error,j.started_at,j.finished_at,j.created_at,j.updated_at,j.w4_contract_version,
  j.punch_preview_version,j.punch_preview_request_fingerprint,j.punch_preview_snapshot_digest,
  j.punch_preview_actor_posture,j.punch_preview_token_subject_user_id`

function conflict(): never { throw new Error('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT') }

/** Server-only reservation. The supplied authorizer must use current scoped preview policy. */
export function createAttendancePunchDetailPreviewHostV1(deps: AttendanceSyncImportHostDepsV1) {
  async function execute(
    input: PreviewInput,
    authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1,
    create?: {
      jobId: string; batchId: string
      beforeCreate(client: AttendancePunchDetailPreparationReadClientV1): Promise<void>
      resolveFrozenTarget: AttendancePunchDetailFrozenTargetResolverV1
    },
  ) {
    const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
    if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    const scope = Object.freeze({ ...input.scope })
    const previewLimit = input.previewLimit
    const fingerprint = fingerprintAttendancePunchDetailPreviewRequestV1(scope, envelope, previewLimit)
    const key = envelope.idempotencyKey === null ? null : 'punch-preview:' + sha256HexOfCanonicalJsonV1({
      domain: 'metasheet2:attendance:punch-detail-preview-key:v1', key: envelope.idempotencyKey,
    })
    if (!create && key === null) return null
    return withCurrentAttendancePunchDetailReplayV1(deps, { scope, envelope }, async (trx) => {
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
        if (key !== null) {
          const rows = await client.query(`SELECT ${JOB_COLUMNS},r.snapshot
            FROM attendance_import_jobs j LEFT JOIN attendance_import_punch_preview_records r ON r.job_id=j.id
            WHERE j.org_id=$1 AND j.idempotency_key=$2 FOR UPDATE OF j`, [scope.orgId, key])
          if (rows.length > 1) conflict()
          if (rows.length === 1) {
            const row = rows[0]
            if (row.punch_preview_version !== 1 || row.w4_contract_version !== null
              || row.punch_preview_request_fingerprint !== fingerprint || row.created_by !== scope.actorId
              || row.org_id !== scope.orgId || row.punch_preview_actor_posture !== scope.actorPosture
              || row.punch_preview_token_subject_user_id !== scope.tokenSubjectUserId) conflict()
            const record = verifyAttendancePunchDetailPreviewRecordV1(row.snapshot, {
              jobId: row.id as string, batchId: row.batch_id as string,
              scope: { orgId: row.org_id as string, actorId: row.created_by as string,
                actorPosture: row.punch_preview_actor_posture as PreviewInput['scope']['actorPosture'],
                tokenSubjectUserId: row.punch_preview_token_subject_user_id as string | null },
              requestFingerprint: row.punch_preview_request_fingerprint as string,
              snapshotDigest: row.punch_preview_snapshot_digest as string,
            })
            const { snapshot: _snapshot, ...job } = row
            return { created: false, job, record }
          }
        }
        if (!create) return null
        await create.beforeCreate(client)
        const frozen = await create.resolveFrozenTarget(client, Object.freeze({ referenceSegments: true }))
        const { record, snapshotDigest } = buildAttendancePunchDetailPreviewRecordV1({
          jobId: create.jobId, previewLimit,
          preparation: { ...frozen, scope, envelope, batchId: create.batchId, chunkConfig: null },
        })
        const rows = await client.query(`INSERT INTO attendance_import_jobs AS j
          (id,org_id,created_by,batch_id,idempotency_key,status,progress,total,payload,
            punch_preview_version,punch_preview_request_fingerprint,punch_preview_snapshot_digest,
            punch_preview_actor_posture,punch_preview_token_subject_user_id)
          VALUES ($1,$2,$3,$4,$5,'queued',0,$6,'{"__jobType":"preview"}'::jsonb,1,$7,$8,$9,$10)
          RETURNING ${JOB_COLUMNS}`, [record.jobId, scope.orgId, scope.actorId, record.batchId, key,
          record.preview.eventCount, record.requestFingerprint, snapshotDigest, scope.actorPosture, scope.tokenSubjectUserId])
        if (rows.length !== 1) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREVIEW_INSERT_FAILED')
        await client.query(`INSERT INTO attendance_import_punch_preview_records
          (job_id,org_id,created_by,batch_id,request_fingerprint,snapshot_digest,snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [record.jobId, scope.orgId, scope.actorId,
          record.batchId, record.requestFingerprint, snapshotDigest, JSON.stringify(record)])
        return { created: true, job: rows[0], record }
      } finally { active = false }
    }, key)
  }

  return Object.freeze({
    readPunchDetailPreviewReplay(input: PreviewInput, authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1) {
      return execute(input, authorizeTarget)
    },
    async reservePunchDetailPreview(input: PreviewInput & { jobId: string; batchId: string }, callbacks: {
      authorizeTarget: AttendancePunchDetailPreviewAuthorizerV1
      beforeCreate(client: AttendancePunchDetailPreparationReadClientV1): Promise<void>
      resolveFrozenTarget: AttendancePunchDetailFrozenTargetResolverV1
    }): Promise<{ created: boolean; job: Record<string, unknown>; record: AttendancePunchDetailPreviewRecordV1 }> {
      return (await execute(input, callbacks.authorizeTarget, {
        jobId: input.jobId, batchId: input.batchId, beforeCreate: callbacks.beforeCreate,
        resolveFrozenTarget: callbacks.resolveFrozenTarget,
      }))!
    },
  })
}
