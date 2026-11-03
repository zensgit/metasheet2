import type { ExactAnchorAppliedMutation, ExactAnchorLinkInvalidation } from './exact-anchor-recovery-execute'
import type { QueryFn } from './permission-service'
import { assertInTransaction } from './pg-transaction-guard'
import type { RecoveryArchiveWorkerIdentity } from './recovery-archive-async-restore'
import type { RecoveryArchiveRestoreJobTransaction } from './recovery-archive-restore-jobs'

const INVALID = 'RECOVERY_ARCHIVE_DERIVED_EFFECT_INVALID'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw new Error(INVALID)
}

function canonicalIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error(INVALID)
  values.forEach(requireId)
  return [...new Set(values)].sort()
}

async function requireTransaction(query: QueryFn): Promise<void> {
  try {
    await assertInTransaction({ query: async (text, values) => {
      const result = await query(text, values)
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? null }
    } }, 'recovery_archive_derived_effect')
  } catch {
    throw new Error('RECOVERY_ARCHIVE_DERIVED_EFFECT_TRANSACTION_REQUIRED')
  }
}

/** Internal mutation hook. Authorization and lease fences remain owned by the restore transaction. */
export async function enqueueRecoveryArchiveDerivedEffect(
  query: QueryFn,
  identity: RecoveryArchiveWorkerIdentity,
  mutation: ExactAnchorAppliedMutation,
): Promise<void> {
  for (const id of [identity.jobId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId,
    mutation.revisionId, mutation.recordId]) requireId(id)
  if (!UUID.test(identity.jobId) || !UUID.test(mutation.revisionId) ||
      !['revert', 'delete'].includes(mutation.kind) || !Array.isArray(mutation.linkInvalidations)) {
    throw new Error(INVALID)
  }
  const fields = canonicalIds(mutation.kind === 'revert' ? mutation.changedFieldIds : [])
  const links = mutation.linkInvalidations.map((entry) => {
    requireId(entry.sheetId)
    return { sheetId: entry.sheetId, recordIds: canonicalIds(entry.recordIds), fieldIds: canonicalIds(entry.fieldIds) }
  }).sort((a, b) => a.sheetId < b.sheetId ? -1 : a.sheetId > b.sheetId ? 1 : 0)
  await requireTransaction(query)
  const binding = await query(`SELECT id FROM public.meta_recovery_archive_jobs
    WHERE id=$1::uuid AND workspace_id=$2 AND base_id=$3 AND sheet_id=$4 AND actor_id=$5
      AND state='applying'`,
  [identity.jobId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId])
  if (binding.rows.length !== 1) throw new Error('RECOVERY_ARCHIVE_DERIVED_EFFECT_JOB_MISMATCH')

  // Project IDs explicitly: the mutation patch and other user values must never enter this ledger.
  await query(`INSERT INTO public.meta_recovery_archive_derived_effects
    (revision_id, job_id, record_id, field_ids, link_invalidations)
    VALUES ($1::uuid,$2::uuid,$3,$4::text[],$5::jsonb) ON CONFLICT (revision_id) DO NOTHING`,
  [mutation.revisionId, identity.jobId, mutation.recordId, fields, JSON.stringify(links)])
  const same = await query(`SELECT revision_id FROM public.meta_recovery_archive_derived_effects
    WHERE revision_id=$1::uuid AND job_id=$2::uuid AND record_id=$3
      AND field_ids=$4::text[] AND link_invalidations=$5::jsonb`,
  [mutation.revisionId, identity.jobId, mutation.recordId, fields, JSON.stringify(links)])
  if (same.rows.length !== 1) throw new Error('RECOVERY_ARCHIVE_DERIVED_EFFECT_CONFLICT')
}

export type RecoveryArchiveDerivedWork = {
  identity: RecoveryArchiveWorkerIdentity
  revisionId: string
  recordId: string
  fieldIds: string[]
  linkInvalidations: ExactAnchorLinkInvalidation[]
}

function readWork(row: Record<string, unknown>): RecoveryArchiveDerivedWork {
  const identity = {
    jobId: row.job_id, workspaceId: row.workspace_id, baseId: row.base_id,
    sheetId: row.sheet_id, actorId: row.actor_id,
  }
  Object.values(identity).forEach(requireId)
  requireId(row.revision_id)
  requireId(row.record_id)
  if (!Array.isArray(row.field_ids) || !Array.isArray(row.link_invalidations)) throw new Error(INVALID)
  const links = row.link_invalidations.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(INVALID)
    const link = entry as Record<string, unknown>
    if (Object.keys(link).sort().join(',') !== 'fieldIds,recordIds,sheetId' ||
      !Array.isArray(link.fieldIds) || !Array.isArray(link.recordIds)) throw new Error(INVALID)
    requireId(link.sheetId)
    return { sheetId: link.sheetId, recordIds: canonicalIds(link.recordIds), fieldIds: canonicalIds(link.fieldIds) }
  })
  return {
    identity: identity as RecoveryArchiveWorkerIdentity,
    revisionId: row.revision_id, recordId: row.record_id,
    fieldIds: canonicalIds(row.field_ids), linkInvalidations: links,
  }
}

/** One bounded attempt. The processor must freshly authorize and use canonical derived-write fences. */
export async function consumeRecoveryArchiveDerivedEffect(
  transaction: RecoveryArchiveRestoreJobTransaction,
  process: (work: RecoveryArchiveDerivedWork) => Promise<boolean>,
): Promise<'idle' | 'completed' | 'retry'> {
  return transaction(async (query) => {
    await requireTransaction(query)
    const selected = await query(`SELECT effect.revision_id, effect.job_id, effect.record_id,
        effect.field_ids, effect.link_invalidations,
        job.workspace_id, job.base_id, job.sheet_id, job.actor_id
      FROM public.meta_recovery_archive_derived_effects effect
      JOIN public.meta_recovery_archive_jobs job ON job.id=effect.job_id
      JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
      WHERE effect.completed_at IS NULL AND job.state IN ('done','abandoned_partial')
        AND sheet.deleted_at IS NULL AND sheet.recovery_writer_state IS NULL
      ORDER BY effect.last_attempt_at NULLS FIRST, effect.created_at, effect.revision_id
      LIMIT 1 FOR UPDATE OF effect SKIP LOCKED`)
    if (!selected.rows.length) return 'idle'
    const row = selected.rows[0] as Record<string, unknown>
    let completed = false
    try {
      // The queue-row lock serializes consumers without holding a sheet fence across nested writes.
      completed = await process(readWork(row)) === true
    } catch {
      // Never persist/log adapter errors or turn failed/best-effort computation into completion.
    }
    await query(`UPDATE public.meta_recovery_archive_derived_effects
      SET last_attempt_at=clock_timestamp(),
          completed_at=CASE WHEN $2::boolean THEN clock_timestamp() ELSE NULL END
      WHERE revision_id=$1::uuid AND completed_at IS NULL`, [row.revision_id, completed])
    return completed ? 'completed' : 'retry'
  })
}
