import { assertInTransaction, type TransactionalQueryable } from '../multitable/pg-transaction-guard'
import {
  AutomationReadLedgerError, canonicalReadId, readInput,
  type AutomationReadLedgerDependencies, type ReadRecordDelivery,
} from './automation-read-contracts'

export type ReadRecordTriggerType = 'record.created' | 'record.updated'
export type ReadRecordEventType = 'multitable.record.created' | 'multitable.record.updated'
/** Closed mapping of saved rule types to durable event families, never payload fields. */
export function readRecordTriggerType(value: unknown): ReadRecordTriggerType | null {
  return value === 'record.created' || value === 'record.updated' ? value : null
}
export function readRecordEventType(trigger: ReadRecordTriggerType): ReadRecordEventType {
  return trigger === 'record.created' ? 'multitable.record.created' : 'multitable.record.updated'
}
export const AUTOMATION_READ_RECORD_CONSUMER = 'automation-record-trigger'
// Mirrors AutomationService's current record-trigger guard. This preview does
// not backwrite, so it uses the persisted event depth without incrementing it.
export const AUTOMATION_READ_RECORD_MAX_DEPTH = 3

type Row = Record<string, unknown>
export type LockedReadRecordDelivery = Readonly<ReadRecordDelivery & {
  sheetId: string; recordId: string; leaseExpiresAt: number
  eventType: ReadRecordEventType; triggerType: ReadRecordTriggerType
}>

/** Own data only: the producer cannot make event serializers an authority hook. */
export function captureReadRecordData(value: unknown, keys: readonly string[]): Row {
  readInput(!!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === keys.length)
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    readInput(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'))
    return [key, descriptor.value]
  }))
}

export function captureReadRecordDelivery(input: ReadRecordDelivery): Readonly<ReadRecordDelivery> {
  const row = captureReadRecordData(input, ['outboxId', 'eventId', 'fence', 'attempts'])
  readInput(canonicalReadId(row.outboxId) && canonicalReadId(row.eventId)
    && typeof row.fence === 'string' && /^[1-9][0-9]{0,18}$/.test(row.fence)
    && BigInt(row.fence) <= 9223372036854775807n
    && Number.isSafeInteger(row.attempts) && Number(row.attempts) >= 1 && Number(row.attempts) <= 2147483647)
  return Object.freeze({ outboxId: row.outboxId, eventId: row.eventId, fence: row.fence, attempts: Number(row.attempts) })
}

export function assertReadRecordSignal(signal: AbortSignal): void {
  readInput(signal instanceof AbortSignal)
  if (signal.aborted) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
}

/** Database clock after all delivery locks and again after admission writes. */
export async function assertReadRecordLease(trx: TransactionalQueryable, row: LockedReadRecordDelivery, signal: AbortSignal): Promise<void> {
  assertReadRecordSignal(signal)
  const clock = await trx.query('SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS now_ms')
  assertReadRecordSignal(signal)
  const at = Number(clock.rows[0]?.now_ms)
  if (!Number.isFinite(at) || row.leaseExpiresAt <= at) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
}

/** Caller owns the transaction: do not verify then submit in another transaction. */
export async function lockReadRecordDelivery(
  trx: TransactionalQueryable, delivery: Readonly<ReadRecordDelivery>, signal: AbortSignal,
): Promise<LockedReadRecordDelivery | null> {
  assertReadRecordSignal(signal)
  const result = await trx.query(`SELECT o.event_type,o.event_id,o.automation_depth,
      pg_catalog.jsonb_typeof(o.payload)='object'
        AND pg_catalog.jsonb_typeof(o.payload->'sheetId')='string'
        AND pg_catalog.jsonb_typeof(o.payload->'recordId')='string' AS payload_valid,
      o.payload->>'sheetId' AS sheet_id,o.payload->>'recordId' AS record_id,
      c.status,c.fence::text AS fence,c.attempts,c.lease_expires_at
    FROM meta_automation_outbox o JOIN meta_automation_outbox_consumer c ON c.outbox_id=o.id
    WHERE o.id=$1 AND c.consumer_key=$2 FOR SHARE OF o,c NOWAIT`,
  [delivery.outboxId, AUTOMATION_READ_RECORD_CONSUMER])
  assertReadRecordSignal(signal)
  const row = result.rows[0]
  if (result.rows.length !== 1 || row?.event_id !== delivery.eventId || row?.status !== 'in_progress'
    || row?.fence !== delivery.fence || Number(row?.attempts) !== delivery.attempts) {
    throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
  }
  const leaseExpiresAt = row.lease_expires_at === null ? NaN : new Date(row.lease_expires_at as string).getTime()
  if (!Number.isFinite(leaseExpiresAt)) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
  const triggerType = row.event_type === 'multitable.record.created' ? 'record.created'
    : row.event_type === 'multitable.record.updated' ? 'record.updated' : null
  if (triggerType === null || row.payload_valid !== true
    || !canonicalReadId(row.sheet_id) || !canonicalReadId(row.record_id)
    || !Number.isSafeInteger(row.automation_depth) || Number(row.automation_depth) < 0
    || Number(row.automation_depth) >= AUTOMATION_READ_RECORD_MAX_DEPTH) return null
  const locked = Object.freeze({ ...delivery, sheetId: row.sheet_id, recordId: row.record_id, leaseExpiresAt,
    triggerType, eventType: readRecordEventType(triggerType) })
  await assertReadRecordLease(trx, locked, signal)
  return locked
}

/** Metadata candidates ONLY. May run while the execution runtime is inactive;
 * no actor/source authority or source IO is inferred by this bounded scan. */
export async function findAutomationReadRecordCandidates(
  transaction: AutomationReadLedgerDependencies['transaction'], input: ReadRecordDelivery, signal: AbortSignal,
): Promise<readonly string[]> {
  const delivery = captureReadRecordDelivery(input)
  assertReadRecordSignal(signal)
  try {
    return await transaction(async trx => {
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
        throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED')
      }
      await assertInTransaction(trx, 'Automation read record candidates')
      const event = await lockReadRecordDelivery(trx, delivery, signal)
      if (!event) return Object.freeze([])
      const candidates = (await trx.query(`SELECT a.id FROM integration_automation_read_record_activations a
        JOIN integration_automation_read_grants g ON g.id=a.grant_id AND g.tenant_id=a.tenant_id AND g.owner_id=a.owner_id
        JOIN automation_rules r ON r.id=a.rule_id
        JOIN meta_automation_outbox o ON o.id=$1
        WHERE a.sheet_id=$2 AND g.purpose='automatic' AND g.status='active' AND g.workspace_id IS NULL
          AND g.expires_at>pg_catalog.clock_timestamp() AND o.created_at>a.activated_at
          AND NOT EXISTS (SELECT 1 FROM meta_automation_outbox history
            WHERE history.event_type=o.event_type AND history.event_id=o.event_id
              AND history.created_at<=a.activated_at)
          AND r.sheet_id=a.sheet_id AND r.created_by=a.owner_id AND r.enabled=true
          AND r.integration_authority_revision=a.rule_revision AND r.trigger_type=$3
          AND ((r.conditions IS NULL OR r.conditions='null'::jsonb) AND a.condition_confirmation->>'mode'='unconditional'
            OR pg_catalog.jsonb_typeof(r.conditions)='object' AND a.condition_confirmation->>'mode'='saved_conditions')
          AND (r.trigger_config IS NULL OR r.trigger_config IN ('null'::jsonb,'{}'::jsonb))
        ORDER BY a.id LIMIT 101`, [delivery.outboxId, event.sheetId, event.triggerType])).rows
      // Cutover also excludes a duplicate of pre-activation history retained and
      // visible to this statement. It does not prove a logical first occurrence
      // across retention or against an earlier, still-uncommitted transaction.
      assertReadRecordSignal(signal)
      if (candidates.length > 100) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
      const ids = candidates.map(row => {
        if (typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
        }
        return row.id
      })
      await assertReadRecordLease(trx, event, signal)
      return Object.freeze(ids)
    })
  } catch (error) {
    if (error instanceof AutomationReadLedgerError) throw error
    throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
  }
}
