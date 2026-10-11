import type { ConsumerAdapter, AdapterOutcome } from '../multitable/automation-durable-dispatch-loop'
import type { ClaimedConsumer } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction, type TransactionalQueryable } from '../multitable/pg-transaction-guard'
import { AutomationActorAuthorityError } from './automation-live-authority'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type AutomationReadLedgerDependencies, type ReadRequestStatus } from './automation-read-contracts'

type Row = Record<string, unknown>
type Admission = 'execute' | 'terminal' | 'retry' | 'reject'
type Reconciliation = 'before' | 'returned' | 'denied' | 'uncertain'
export type AutomationReadDeliveryOptions = {
  transaction: AutomationReadLedgerDependencies['transaction']
  execute(requestId: string, signal: AbortSignal): Promise<{ requestId: string; status: ReadRequestStatus }>
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const terminal = new Set(['succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])
const retry = (): AdapterOutcome => ({ outcome: 'retryable_failure', reason: 'adapter_error' })
const reject = (): AdapterOutcome => ({ outcome: 'permanent_failure', reason: 'permanent_rejection' })
// Transport ACK means this exact delivery reached an already durable terminal
// sink. It does NOT mean preview success: outcome_unknown remains unknown.
const handled = (): AdapterOutcome => ({ outcome: 'success' })

function data(value: unknown, keys: readonly string[]): Row | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return
  const result: Row = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return
    result[key] = descriptor.value
  }
  return result
}
function capture(value: ClaimedConsumer): (ClaimedConsumer & { requestId: string }) | undefined {
  try {
    const row = data(value, ['outboxId', 'consumerKey', 'fence', 'attempts', 'eventType', 'eventId',
      'payload', 'automationDepth', 'manifestVersion'])
    if (!row) return
    const payload = data(row.payload, ['requestId'])
    if (!payload || typeof payload.requestId !== 'string' || !uuid.test(payload.requestId)
      || row.consumerKey !== AUTOMATION_READ_CONSUMER || row.eventType !== AUTOMATION_READ_EVENT
      || row.eventId !== `integration-read:${payload.requestId}`
      || typeof row.outboxId !== 'string' || !row.outboxId.startsWith('obx_') || !uuid.test(row.outboxId.slice(4))
      || typeof row.fence !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.fence)
      || BigInt(row.fence) > 9223372036854775807n
      || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 1
      || row.automationDepth !== 0 || !Number.isSafeInteger(row.manifestVersion) || Number(row.manifestVersion) < 1) return
    return { ...row, payload: { requestId: payload.requestId }, requestId: payload.requestId } as ClaimedConsumer & { requestId: string }
  } catch { return undefined }
}
function isAdmissionDenied(error: unknown): boolean {
  if (error instanceof AutomationReadLedgerError) {
    return ['AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED'].includes(error.code)
  }
  if (error instanceof AutomationActorAuthorityError) return error.code === 'AUTOMATION_ACTOR_AUTHORITY_DENIED'
  // The host's private inactive-runtime error has no execution capability. Do
  // not invoke a getter or copy arbitrary error details into delivery/history.
  return error instanceof Error
    && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'AUTOMATION_READ_RUNTIME_INACTIVE'
}

/** Host-private transport admission/safe sink only: no authority bypass, source
 * reader, result observer, public API or automatic re-claim. An executable
 * queued request still passes the executor's real live authority and fence.
 */
export function createAutomationReadDelivery(options: AutomationReadDeliveryOptions): ConsumerAdapter {
  async function reconcile(event: ClaimedConsumer & { requestId: string }, mode: Reconciliation): Promise<Admission> {
    return options.transaction(async trx => {
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0].isolation !== 'read committed') throw new Error('Delivery transaction required')
      await assertInTransaction(trx, 'Automation read delivery')
      const hint = (await trx.query('SELECT grant_id FROM integration_automation_read_requests WHERE id = $1', [event.requestId])).rows[0]
      if (!hint) return 'reject'
      // Same grant -> request order as ledger claim/cancel/abandon. We only
      // terminalize the private sink; we never derive execution authority here.
      const grant = (await trx.query(`SELECT id, tenant_id, owner_id, workspace_id
        FROM integration_automation_read_grants WHERE id = $1 FOR UPDATE`, [hint.grant_id])).rows[0]
      const row = (await trx.query(`SELECT id, grant_id, tenant_id, owner_id, workspace_id, outbox_id,
        status, lease_expires_at FROM integration_automation_read_requests WHERE id = $1 FOR UPDATE`, [event.requestId])).rows[0]
      if (!grant || !row || row.grant_id !== grant.id || row.tenant_id !== grant.tenant_id
        || row.owner_id !== grant.owner_id || row.workspace_id !== null || grant.workspace_id !== null
        || row.outbox_id !== event.outboxId) return 'reject'
      const binding = (await trx.query(`SELECT o.event_type, o.event_id, o.payload, o.automation_depth, o.manifest_version,
        c.status, c.fence::text AS fence, c.attempts, c.lease_expires_at
        FROM meta_automation_outbox o JOIN meta_automation_outbox_consumer c ON c.outbox_id = o.id
        WHERE o.id = $1 AND c.consumer_key = $2 FOR SHARE OF o, c`, [event.outboxId, AUTOMATION_READ_CONSUMER])).rows[0]
      if (!binding || binding.event_type !== event.eventType || binding.event_id !== event.eventId
        || binding.automation_depth !== event.automationDepth || binding.manifest_version !== event.manifestVersion
        || data(binding.payload, ['requestId'])?.requestId !== event.requestId) return 'reject'
      // Clock after all locks: a long lock wait cannot resurrect an expired
      // delivery token. This fence is the OUTBOX fence, never the source fence.
      const at = Number((await trx.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms')).rows[0]?.now_ms)
      if (!Number.isFinite(at)) throw new Error('Delivery clock unavailable')
      if (binding.status !== 'in_progress' || binding.fence !== event.fence || binding.attempts !== event.attempts
        || !(new Date(binding.lease_expires_at as string).getTime() > at)) return 'retry'
      if (terminal.has(String(row.status))) return 'terminal'
      if (row.status === 'running') {
        // Active duplicate delivery never invokes execute. After a thrown
        // invocation its claim may have committed without a receipt; conservatively
        // close that sink rather than attempting source IO again.
        if (mode === 'denied' || mode === 'uncertain' || !(new Date(row.lease_expires_at as string).getTime() > at)) {
          await finish(trx, event.requestId, 'outcome_unknown')
          return 'terminal'
        }
        return 'retry'
      }
      if (row.status !== 'queued') return 'reject'
      if (mode === 'denied') {
        await finish(trx, event.requestId, 'blocked')
        return 'terminal'
      }
      return mode === 'before' ? 'execute' : 'retry'
    })
  }
  async function finish(trx: TransactionalQueryable, requestId: string, status: 'blocked' | 'outcome_unknown') {
    await trx.query(`UPDATE integration_automation_read_requests SET status = $2, result = NULL,
      finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`, [requestId, status])
  }
  return Object.freeze({
    key: AUTOMATION_READ_CONSUMER,
    async handle(input: ClaimedConsumer, ctx?: { signal: AbortSignal }): Promise<AdapterOutcome> {
      const event = capture(input)
      if (!event) return reject()
      if (!(ctx?.signal instanceof AbortSignal) || ctx.signal.aborted) return retry()
      try {
        const admission = await reconcile(event, 'before')
        if (admission === 'terminal') return handled()
        if (admission === 'reject') return reject()
        if (admission !== 'execute' || ctx.signal.aborted) return retry()
        let mode: Reconciliation = 'returned'
        try {
          // Never interpret a resolved/accepted/running return as success. The
          // durable sink, not runtime output, is the sole terminal evidence.
          await options.execute(event.requestId, ctx.signal)
        } catch (error) { mode = isAdmissionDenied(error) ? 'denied' : 'uncertain' }
        const settled = await reconcile(event, mode)
        return settled === 'terminal' ? handled() : settled === 'reject' ? reject() : retry()
      } catch {
        // Database outage/ambiguous commit: retry TRANSPORT only. A later
        // admission sees running/terminal and never reclaims a source attempt.
        return retry()
      }
    },
  })
}
