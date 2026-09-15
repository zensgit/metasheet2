import type { ExactAnchorAppliedMutation } from './exact-anchor-recovery-execute'
import type { QueryFn } from './permission-service'
import { assertInTransaction } from './pg-transaction-guard'
import type { RecoveryArchiveWorkerIdentity } from './recovery-archive-async-restore'

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
  try {
    await assertInTransaction({ query: async (text, values) => {
      const result = await query(text, values)
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? null }
    } }, 'recovery_archive_derived_effect')
  } catch {
    throw new Error('RECOVERY_ARCHIVE_DERIVED_EFFECT_TRANSACTION_REQUIRED')
  }
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
