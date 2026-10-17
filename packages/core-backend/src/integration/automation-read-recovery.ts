import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT,
  type AutomationReadLedgerDependencies } from './automation-read-contracts'

type Row = Record<string, unknown>
type RecoveryOptions = Pick<AutomationReadLedgerDependencies, 'transaction'>
type RecoveryCursor = Readonly<{ grantId: string; requestId: string }>
const unavailable = 'AUTOMATION_READ_RECOVERY_UNAVAILABLE' as const
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

export class AutomationReadRecoveryError extends Error {
  readonly code = unavailable
  constructor() { super(unavailable); this.name = 'AutomationReadRecoveryError' }
}

// Same closed event envelope as delivery, checked again against the locked DB
// row. This is transport exhaustion evidence, NEVER execution authority.
function exactDeadLetter(row: Row | undefined, requestId: unknown, outboxId: unknown): boolean {
  if (!row || typeof requestId !== 'string' || !uuid.test(requestId)
    || typeof outboxId !== 'string' || !outboxId.startsWith('obx_') || !uuid.test(outboxId.slice(4))
    || row.consumer_key !== AUTOMATION_READ_CONSUMER || row.status !== 'dead_letter'
    || row.lease_expires_at !== null || row.event_type !== AUTOMATION_READ_EVENT
    || row.event_id !== `integration-read:${requestId}` || row.automation_depth !== 0
    || !Number.isSafeInteger(row.manifest_version) || Number(row.manifest_version) < 1
    || typeof row.fence !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.fence)
    || BigInt(row.fence) > 9223372036854775807n
    || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 1) return false
  const payload = row.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null)
    || Reflect.ownKeys(payload).length !== 1) return false
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'requestId')
  return !!descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && descriptor.value === requestId
}

/** A restart-safe private sink sweep, not a retry/reclaim executor. A poisoned
 * outbox row can precede every delivery callback (or outlive a lost callback).
 * No result column is selected and no grant usage, fence or outbox is changed.
 */
export async function recoverDeadLetters(options: RecoveryOptions, after?: RecoveryCursor): Promise<RecoveryCursor | undefined> {
  try {
    return await options.transaction(async trx => {
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0].isolation !== 'read committed') throw new AutomationReadRecoveryError()
      await assertInTransaction(trx, 'Automation read recovery')
      // Private short transaction only; no session-wide settings or source IO.
      await trx.query("SET LOCAL lock_timeout = '250ms'")
      await trx.query("SET LOCAL statement_timeout = '2000ms'")
      // Filter malformed and terminal rows BEFORE LIMIT: they must not starve
      // an eligible orphan behind them on every dispatcher tick. These are
      // hints only; all linkage and dead-letter evidence is rechecked below.
      const candidates = (await trx.query(`SELECT r.id, r.grant_id, r.outbox_id
        FROM integration_automation_read_requests r
        JOIN integration_automation_read_grants g ON g.id = r.grant_id
          AND g.tenant_id = r.tenant_id AND g.owner_id = r.owner_id
        JOIN meta_automation_outbox o ON o.id = r.outbox_id
        JOIN meta_automation_outbox_consumer c ON c.outbox_id = o.id
        WHERE r.status IN ('queued', 'running') AND r.workspace_id IS NULL AND g.workspace_id IS NULL
          AND c.consumer_key = $1 AND c.status = 'dead_letter' AND c.lease_expires_at IS NULL
          AND c.fence > 0 AND c.attempts > 0 AND o.event_type = $2 AND o.automation_depth = 0
          AND o.manifest_version > 0 AND o.event_id = 'integration-read:' || r.id::text
          AND o.payload = jsonb_build_object('requestId', r.id::text)
          AND o.id ~ '^obx_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
          AND ($3::uuid IS NULL OR (r.grant_id, r.id) > ($3::uuid, $4::uuid))
        ORDER BY r.grant_id, r.id LIMIT 16`,
      [AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, after?.grantId ?? null, after?.requestId ?? null])).rows
      for (const hint of candidates) {
        // Delivery and ledger use grant -> request -> outbox/consumer order.
        // Skip held rows instead of queuing recovery behind active execution.
        const grant = (await trx.query(`SELECT id, tenant_id, owner_id, workspace_id
          FROM integration_automation_read_grants WHERE id = $1 FOR UPDATE SKIP LOCKED`, [hint.grant_id])).rows[0]
        if (!grant) continue
        const request = (await trx.query(`SELECT id, grant_id, tenant_id, owner_id, workspace_id, outbox_id, status
          FROM integration_automation_read_requests WHERE id = $1 FOR UPDATE SKIP LOCKED`, [hint.id])).rows[0]
        if (!request || request.grant_id !== grant.id || request.tenant_id !== grant.tenant_id
          || request.owner_id !== grant.owner_id || request.workspace_id !== null || grant.workspace_id !== null
          || request.outbox_id !== hint.outbox_id || !['queued', 'running'].includes(String(request.status))) continue
        const binding = (await trx.query(`SELECT o.event_type, o.event_id, o.payload, o.automation_depth, o.manifest_version,
          c.consumer_key, c.status, c.fence::text AS fence, c.attempts, c.lease_expires_at
          FROM meta_automation_outbox o JOIN meta_automation_outbox_consumer c ON c.outbox_id = o.id
          WHERE o.id = $1 AND c.consumer_key = $2 FOR SHARE OF o, c SKIP LOCKED`,
        [request.outbox_id, AUTOMATION_READ_CONSUMER])).rows[0]
        if (!exactDeadLetter(binding, request.id, request.outbox_id)) continue
        await trx.query(`UPDATE integration_automation_read_requests SET status = $2, result = NULL,
          finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
        [request.id, request.status === 'queued' ? 'blocked' : 'outcome_unknown'])
      }
      // Advance past EVERY hint, including busy rows. Otherwise 16 perpetually
      // held locks starve all later requests despite SKIP LOCKED. This private
      // keyset wraps at the end; it is not a result or a public progress count.
      const last = candidates.at(-1)
      return candidates.length === 16 && last
        ? Object.freeze({ grantId: String(last.grant_id), requestId: String(last.id) }) : undefined
    })
  } catch { throw new AutomationReadRecoveryError() }
}

/** Drive only from the existing dispatcher observer. No new timer or public
 * capability. Non-overlap is process-local; locked rechecks provide DB safety.
 */
export function createAutomationReadRecovery(options: RecoveryOptions & {
  onError?: (code: typeof unavailable) => void
}): Readonly<{ tick(): Promise<void>; stop(): Promise<void> }> {
  let closed = false
  let inFlight: Promise<void> | undefined
  let cursor: RecoveryCursor | undefined
  return Object.freeze({
    tick(): Promise<void> {
      if (closed) return Promise.resolve()
      if (inFlight) return inFlight
      inFlight = Promise.resolve().then(async () => {
        if (!closed) cursor = await recoverDeadLetters(options, cursor)
      }).catch(() => {
        try { options.onError?.(unavailable) } catch { /* Observers cannot reopen admission. */ }
      }).finally(() => { inFlight = undefined })
      return inFlight
    },
    stop(): Promise<void> {
      closed = true
      return inFlight ?? Promise.resolve()
    },
  })
}
