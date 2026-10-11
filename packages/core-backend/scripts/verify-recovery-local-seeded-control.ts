/** Seeded control only; never qualifies either genuine captured-archive scenario. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { RecoveryArchiveRestoreJobQuery } from '../src/multitable/recovery-archive-restore-jobs'
import type { ArchiveProcessWorkerInput, ArchiveProcessWorkerMessage } from '../tests/utils/recovery-archive-process-worker'

export async function finishSeededRecoveryLocalControl(input: {
  readonly query: RecoveryArchiveRestoreJobQuery
  readonly jobId: string
  readonly keyId: string
  readonly sheetId: string
  readonly local: NonNullable<ArchiveProcessWorkerInput['local']>
  readonly expectedRestoredRows: readonly { id: string; data: Readonly<Record<string, unknown>>; version: number }[]
  readonly runWorker: (input: Omit<ArchiveProcessWorkerInput, 'applicationName'>) => Promise<ArchiveProcessWorkerMessage>
}): Promise<void> {
  const workerInput = { keyId: input.keyId, jobId: input.jobId, local: input.local }
  const completed = await input.runWorker({ ...workerInput, phase: 'finish',
    keyMaterial: { dek: randomBytes(32), wrappedDek: randomBytes(48) } })
  assert.equal(completed.kind, 'done')
  if (completed.kind !== 'done') throw new Error('RECOVERY_LOCAL_BACKUP_WORKER_RESULT_INVALID')
  console.log(JSON.stringify({ phase: 'worker', outcome: completed.outcome, state: completed.terminal.state }))
  assert.deepEqual(completed.outcome, { kind: 'completed', swept: 0, chunks: 2 })
  assert.deepEqual(completed.terminal, { state: 'done', completedCount: '5001' })
  assert.deepEqual(completed.lifecycle, ['started', 'drained'])

  const drained = await input.runWorker({ ...workerInput, phase: 'drain', drainTicks: 158,
    keyMaterial: { dek: randomBytes(32), wrappedDek: randomBytes(48) } })
  assert.equal(drained.kind, 'drained')
  if (drained.kind !== 'drained') throw new Error('RECOVERY_LOCAL_BACKUP_DRAIN_RESULT_INVALID')
  assert.equal(drained.attempts, 5001)
  assert.equal(drained.completed, 5001)
  assert.deepEqual(drained.lifecycle, ['started', 'drained'])

  const restoredRows = await input.query(
    'SELECT id, data, version FROM public.meta_records WHERE sheet_id=$1 ORDER BY id', [input.sheetId])
  assert.deepEqual(restoredRows.rows, input.expectedRestoredRows)
  const terminal = await input.query(
    `SELECT job.state, job.completed_count::text AS completed_count,
            sheet.recovery_writer_state,
            (SELECT count(*)::int FROM public.meta_record_revisions revision
              WHERE revision.sheet_id=job.sheet_id AND revision.source='restore') AS restore_events,
            (SELECT count(*)::int FROM public.meta_recovery_archive_derived_effects effect
              WHERE effect.job_id=job.id) AS effects,
            (SELECT count(*)::int FROM public.meta_recovery_archive_derived_effects effect
              WHERE effect.job_id=job.id AND effect.completed_at IS NOT NULL) AS completed_effects
       FROM public.meta_recovery_archive_jobs job
       JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
      WHERE job.id=$1::uuid`, [input.jobId])
  assert.deepEqual(terminal.rows, [{ state: 'done', completed_count: '5001', recovery_writer_state: null,
    restore_events: 5001, effects: 5001, completed_effects: 5001 }])
  const exactOnce = await input.query(
    `SELECT count(*)::int AS count FROM (
       SELECT record_id FROM public.meta_record_revisions
        WHERE sheet_id=$1 AND source='restore' GROUP BY record_id HAVING count(*)=1
     ) exact_once`, [input.sheetId])
  assert.equal((exactOnce.rows[0] as { count: number }).count, 5001)
}
