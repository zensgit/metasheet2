import { performance } from 'node:perf_hooks'
import { assertInTransaction, type TransactionalQueryable } from './pg-transaction-guard'

type RetentionOptions = {
  transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T>
}
const consumer = 'automation-record-trigger'
const batchSize = 200
const intervalMs = 15 * 60 * 1000
const unavailable = 'AUTOMATION_RECORD_AFTER_IMAGE_RETENTION_UNAVAILABLE'

export class AutomationRecordAfterImageRetentionError extends Error {
  readonly code = unavailable
  constructor() { super(unavailable); this.name = 'AutomationRecordAfterImageRetentionError' }
}

/** Private raw-image cleanup only. Keep the source event/consumer and its cutover evidence.
 * A completed source consumer has finished both the read-admission and ordinary legs. Pending,
 * in-progress, dead-lettered or missing consumers retain their images for delivery/repair.
 * Fixed seven-day age uses the DB clock; an admitted read worker no longer needs the image.
 */
export async function pruneAutomationRecordAfterImages(options: RetentionOptions): Promise<number> {
  try {
    return await options.transaction(async trx => {
      await trx.query("SET LOCAL statement_timeout = '5000ms'")
      await trx.query("SET LOCAL lock_timeout = '200ms'")
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0].isolation !== 'read committed') throw new AutomationRecordAfterImageRetentionError()
      await assertInTransaction(trx, 'Automation record after-image retention')
      // Lock BOTH rows before deciding. A writer-first done->pending change is skipped or
      // rechecked by READ COMMITTED; a cleaner-first decision excludes that writer until commit.
      const candidates = await trx.query(`SELECT i.outbox_id
        FROM meta_automation_record_after_images i
        JOIN meta_automation_outbox_consumer c ON c.outbox_id=i.outbox_id
        WHERE c.consumer_key=$1 AND c.status='done'
          AND i.created_at<pg_catalog.clock_timestamp()-INTERVAL '7 days'
        ORDER BY i.created_at,i.outbox_id LIMIT 200 FOR UPDATE OF c,i SKIP LOCKED`, [consumer])
      if (candidates.rows.length > batchSize) throw new AutomationRecordAfterImageRetentionError()
      const ids = candidates.rows.map(row => {
        if (typeof row.outbox_id !== 'string' || row.outbox_id.length === 0) throw new AutomationRecordAfterImageRetentionError()
        return row.outbox_id
      })
      if (new Set(ids).size !== ids.length) throw new AutomationRecordAfterImageRetentionError()
      if (!ids.length) return 0
      // Recheck on the same handle while the decision locks are still held. No parent DELETE,
      // consumer UPDATE, source value selection, or fallback when the image table is missing.
      const deleted = await trx.query(`DELETE FROM meta_automation_record_after_images i
        WHERE i.outbox_id=ANY($1::text[])
          AND i.created_at<pg_catalog.clock_timestamp()-INTERVAL '7 days'
          AND EXISTS (SELECT 1 FROM meta_automation_outbox_consumer c
            WHERE c.outbox_id=i.outbox_id AND c.consumer_key=$2 AND c.status='done')`, [ids, consumer])
      if (!Number.isSafeInteger(deleted.rowCount) || Number(deleted.rowCount) < 0
        || Number(deleted.rowCount) > ids.length) throw new AutomationRecordAfterImageRetentionError()
      return Number(deleted.rowCount)
    })
  } catch { throw new AutomationRecordAfterImageRetentionError() }
}

/** Existing dispatcher ticks are the only driver: no timer, flag or detached work.
 * One attempt per fifteen minutes per process, INCLUDING failed attempts (no outage hot loop).
 * This is best-effort retention, not an absolute expiry or capacity promise while OFF/stopped.
 * tick failures remain observable; stop only drains their already-observed completion.
 */
export function createAutomationRecordAfterImageRetention(options: RetentionOptions): Readonly<{
  tick(): Promise<number>; stop(): Promise<void>
}> {
  let stopped = false
  let lastAttempt: number | undefined
  let inFlight: Promise<number> | undefined
  return Object.freeze({
    tick(): Promise<number> {
      if (stopped) return Promise.resolve(0)
      if (inFlight) return inFlight
      const at = performance.now()
      if (!Number.isFinite(at)) return Promise.reject(new AutomationRecordAfterImageRetentionError())
      if (lastAttempt !== undefined && at - lastAttempt < intervalMs) return Promise.resolve(0)
      lastAttempt = at
      inFlight = Promise.resolve().then(() => stopped ? 0 : pruneAutomationRecordAfterImages(options))
        .finally(() => { inFlight = undefined })
      return inFlight
    },
    stop(): Promise<void> {
      stopped = true
      return inFlight?.then(() => undefined, () => undefined) ?? Promise.resolve()
    },
  })
}
