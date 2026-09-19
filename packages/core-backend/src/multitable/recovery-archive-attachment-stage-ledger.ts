import { createHash, randomUUID } from 'node:crypto'
import type { QueryFn } from './permission-service'
import type { ArchiveAttachmentStageIdentity, ArchiveAttachmentStageLedger } from './recovery-archive-attachment-stage'

const columns = ['attachment_id', 'generation_id', 'workspace_id', 'base_id', 'sheet_id',
  'record_id', 'field_id', 'source_version', 'plaintext_sha256', 'size_bytes'] as const
const keys = ['attachmentId', 'generationId', 'workspaceId', 'baseId', 'sheetId',
  'recordId', 'fieldId', 'sourceVersion', 'plaintextSha256', 'sizeBytes'] as const

/** Each port call finishes its own transaction before the staging layer performs file I/O. */
export function createArchiveAttachmentStageLedger(input: {
  actorId: string
  tokenHash: string
  transaction: <T>(work: (query: QueryFn) => Promise<T>) => Promise<T>
  authorize: (query: QueryFn) => Promise<boolean>
}): ArchiveAttachmentStageLedger {
  const { actorId, tokenHash, transaction, authorize } = input
  if (!/^[0-9a-f-]{36}$/.test(actorId) || !/^[0-9a-f]{64}$/.test(tokenHash)) refused()
  async function run<T>(work: (query: QueryFn) => Promise<T>): Promise<T> {
    try {
      return await transaction(async query => {
        if (!(await authorize(query))) refused()
        return work(query)
      })
    } catch { refused() }
  }
  return {
    reserve: async source => {
      const identity = snapshot(source)
      return run(async query => {
        await lockSource(query, identity)
        await query(`INSERT INTO public.meta_recovery_archive_attachment_stages
          (actor_id,token_hash,${columns.join(',')},object_id)
          VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::bigint,$13::uuid)
          ON CONFLICT (actor_id,token_hash,attachment_id) DO NOTHING`,
        [actorId, tokenHash, ...keys.map(key => identity[key]), randomUUID()])
        const result = await query(`SELECT ${columns.join(',')},object_id::text,state
          FROM public.meta_recovery_archive_attachment_stages
          WHERE actor_id=$1::uuid AND token_hash=$2 AND attachment_id=$3 FOR UPDATE`,
        [actorId, tokenHash, identity.attachmentId])
        const row = exactRow(result.rows, identity)
        const objectId = String(row.object_id)
        const ownershipKey = createHash('sha256').update(JSON.stringify([
          'archive-attachment-stage-owner-v1', actorId, tokenHash, objectId, ...keys.map(key => identity[key]),
        ])).digest('hex')
        return { objectId, ownershipKey, state: row.state as 'reserved' | 'verified' }
      })
    },
    verified: async (objectId, source) => {
      const identity = snapshot(source)
      return run(async query => {
        await lockSource(query, identity)
        const result = await query(`SELECT ${columns.join(',')},object_id::text,state
          FROM public.meta_recovery_archive_attachment_stages
          WHERE actor_id=$1::uuid AND token_hash=$2 AND attachment_id=$3 FOR UPDATE`,
        [actorId, tokenHash, identity.attachmentId])
        const row = exactRow(result.rows, identity)
        if (row.object_id !== objectId) refused()
        if (row.state === 'verified') return
        const updated = await query(`UPDATE public.meta_recovery_archive_attachment_stages
          SET state='verified',verified_at=clock_timestamp()
          WHERE actor_id=$1::uuid AND token_hash=$2 AND attachment_id=$3
            AND object_id=$4::uuid AND state='reserved' RETURNING object_id`,
        [actorId, tokenHash, identity.attachmentId, objectId])
        if (updated.rows.length !== 1) refused()
      })
    },
  }
}

async function lockSource(query: QueryFn, identity: ArchiveAttachmentStageIdentity): Promise<void> {
  const source = await query(`SELECT generation_id FROM public.meta_recovery_archives
    WHERE generation_id=$1::uuid AND workspace_id=$2 AND base_id=$3 AND sheet_id=$4
      AND state='verified' AND build_status='finalized' AND coverage_status='complete'
      AND expires_at>clock_timestamp() FOR SHARE`,
  [identity.generationId, identity.workspaceId, identity.baseId, identity.sheetId])
  if (source.rows.length !== 1) refused()
}

/** Called inside canonical apply's existing transaction, never an independent autocommit. */
export async function lockVerifiedArchiveAttachmentStage(query: QueryFn, input: {
  actorId: string; tokenHash: string; objectId: string; identity: ArchiveAttachmentStageIdentity
}): Promise<void> {
  const { actorId, tokenHash, objectId } = input
  const identity = snapshot(input.identity)
  await lockSource(query, identity)
  const result = await query(`SELECT ${columns.join(',')},object_id::text,state
    FROM public.meta_recovery_archive_attachment_stages
    WHERE actor_id=$1::uuid AND token_hash=$2 AND attachment_id=$3 FOR UPDATE`,
  [actorId, tokenHash, identity.attachmentId])
  const row = exactRow(result.rows, identity)
  if (row.state !== 'verified' || row.object_id !== objectId) refused()
}

function snapshot(source: Readonly<ArchiveAttachmentStageIdentity>): ArchiveAttachmentStageIdentity {
  const result = Object.fromEntries(keys.map(key => [key, source[key]])) as unknown as ArchiveAttachmentStageIdentity
  if (keys.some(key => typeof result[key] !== 'string' || !result[key] || result[key].trim() !== result[key])
    || !/^[0-9a-f]{64}$/.test(result.plaintextSha256) || !/^(0|[1-9][0-9]*)$/.test(result.sizeBytes)) refused()
  return result
}

function exactRow(rows: unknown[], identity: ArchiveAttachmentStageIdentity): Record<string, unknown> {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') refused()
  const row = rows[0] as Record<string, unknown>
  if (columns.some((column, index) => (column === 'size_bytes' ? String(row[column]) : row[column]) !== identity[keys[index]!])
    || typeof row.object_id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.object_id)
    || (row.state !== 'reserved' && row.state !== 'verified')) refused()
  return row
}

function refused(): never {
  throw new Error('ARCHIVE_ATTACHMENT_RESTORE_STAGE_REFUSED')
}
