import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { createYidaMainSyntheticVendor } from './yida-automation-main-synthetic-send'
import { isResolvedUnknownRetry } from './yida-automation-main-fresh-consent-fence'

type Row = Record<string, unknown>
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>
const prefix = '/api/integration/yida-automation-authorizations'
function row(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_REMAINING_OBJECT_REQUIRED')
  return value as Row
}

/** Dedicated fresh full-main case only. Never invoke after the normal two-row
 * sender case: it requires original approved members with NO existing ledger.
 * Remote transport is synthetic; JWT, HTTP, host, worker and PG are not. */
export async function verifyYidaMainRemainingUnknown(input: {
  origin: string; ownerToken: string; ownerId: string; tenantId: string; operationId: string; rowKeys: readonly string[]
  rule: Readonly<{ id: string; revision: string; slot: string }>; query: Query
  vendor: ReturnType<typeof createYidaMainSyntheticVendor>
}) {
  assert.equal(new URL(input.origin).hostname, '127.0.0.1'); assert.equal(input.rowKeys.length, 2)
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED))
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED))
  input.vendor.assertUntouched()
  const old = process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
  const { query } = input
  let phase: 'BEFORE' | 'GRANT' | 'UNKNOWN' | 'REMAINING' | 'REVOKED' = 'BEFORE'
  const http = async (method: 'GET' | 'POST', suffix: string, body?: unknown) => {
    const response = await fetch(input.origin + prefix + suffix, { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + input.ownerToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const envelope = row(await response.json())
    assert.equal(envelope.ok, true); assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, value: row(envelope.data) }
  }
  const census = async () => (await query(`SELECT
    (SELECT count(*)::int FROM integration_yida_delivery_ledger) AS ledgers,
    (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
    (SELECT count(*)::int FROM integration_yida_auto_execution_snapshots) AS snapshots`)).rows[0]
  const ledger = async () => (await query('SELECT * FROM integration_yida_delivery_ledger ORDER BY id')).rows
  try {
    assert.deepEqual(await census(), { ledgers: 0, admissions: 0, snapshots: 0 })
    input.vendor.start('unknown-first'); process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = 'true'
    const created = await http('POST', '', { confirmationId: randomUUID(), ruleId: input.rule.id,
      expectedRuleRevision: input.rule.revision, actionId: input.rule.slot, projectNo: 'DEMO-P1',
      operationId: input.operationId, rowKeys: [...input.rowKeys], allowedTriggers: ['manual'], maxExecutions: 2, ttlMs: 900000 })
    assert.equal(created.status, 201); assert.equal(created.value.usedExecutions, 0)
    assert.equal(created.value.maxExecutions, 2); assert.equal(typeof created.value.grantId, 'string')
    const grantId = created.value.grantId as string
    phase = 'GRANT'
    const first = await http('POST', '/' + grantId + '/requests', { requestKey: randomUUID() })
    assert.equal(first.status, 202); assert.equal(first.value.rowOrdinal, 0); assert.equal(first.value.deliveryQueued, true)
    const consumer = async (requestId: unknown) => {
      assert.equal(typeof requestId, 'string')
      const found = (await query(`SELECT c.status,c.attempts,c.fence::text AS fence,c.last_error
        FROM integration_yida_auto_outbox_links l JOIN meta_automation_outbox_consumer c
          ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
        WHERE l.grant_id=$1 AND l.request_id=$2`, [grantId, requestId])).rows
      assert.equal(found.length, 1); return found[0]
    }
    const firstDeadline = performance.now() + 10000
    let firstClosed = false
    while (performance.now() < firstDeadline) {
      const state = await consumer(first.value.requestId)
      if (state.status === 'dead_letter' && state.attempts === 1) { firstClosed = true; break }
      await delay(50)
    }
    assert(firstClosed, 'APP_YIDA_REMAINING_FIRST_CONSUMER_REQUIRED')
    const history = await ledger()
    assert.equal(history.length, 1); assert.equal(history[0].row_key, input.rowKeys[0])
    assert.equal(history[0].status, 'outcome_unknown')
    phase = 'UNKNOWN'
    assert.deepEqual(await census(), { ledgers: 1, admissions: 1, snapshots: 1 })
    const live = (await http('GET', '/' + grantId)).value
    assert.equal(live.usedExecutions, 1); assert.equal(live.maxExecutions, 2)
    assert.equal(live.revoked, false); assert.equal(live.serialBlocked, true)
    const second = await http('POST', '/' + grantId + '/requests', { requestKey: randomUUID() })
    assert.equal(second.status, 202); assert.equal(second.value.rowOrdinal, 1)
    assert.equal(second.value.deliveryQueued, true); assert.equal(second.value.reused, false)
    const secondDeadline = performance.now() + 10000
    let completed = false, attempts = 0
    while (performance.now() < secondDeadline) {
      const state = await consumer(second.value.requestId)
      if (isResolvedUnknownRetry(state)) { attempts = Number(state.attempts); completed = true; break }
      await delay(50)
    }
    assert(completed, 'APP_YIDA_REMAINING_REAL_ADAPTER_RETRY_REQUIRED')
    phase = 'REMAINING'
    const after = (await http('GET', '/' + grantId)).value
    assert.equal(after.usedExecutions, 1); assert.equal(after.maxExecutions, 2)
    assert.equal(after.revoked, false); assert.equal(after.serialBlocked, true)
    const admissions = (await query('SELECT id,ledger_id FROM integration_yida_auto_admissions WHERE grant_id=$1', [grantId])).rows
    assert.equal(admissions.length, 1); assert.equal(admissions[0].ledger_id, history[0].id)
    assert.deepEqual(after.requests, [
      { requestId: first.value.requestId, rowOrdinal: 0, status: 'admitted', admissionId: admissions[0].id,
        ledgerStatus: 'outcome_unknown', durable: true, canSend: false },
      { requestId: second.value.requestId, rowOrdinal: 1, status: 'queued', admissionId: null,
        ledgerStatus: null, durable: true, canSend: false },
    ])
    assert.deepEqual(await census(), { ledgers: 1, admissions: 1, snapshots: 1 })
    assert.deepEqual(await ledger(), history)
    assert.deepEqual(input.vendor.snapshot(), { active: true, closed: false, tokenCalls: 1, formCalls: 1, refusedCalls: 0 })
    const revoked = await http('POST', '/' + grantId + '/revoke', {})
    assert.equal(revoked.status, 200); assert.equal(revoked.value.revoked, true); assert.equal(revoked.value.usedExecutions, 1)
    phase = 'REVOKED'
    return Object.freeze({ actualMain: true, realPasswordJwt: true, approvedRows: 2, maximumExecutions: 2,
      executionsUsed: 1, remainingExecutions: 1, unusedRowRequested: true, originalWorkerRetryResolved: true,
      workerAttempts: attempts, serialBlocked: true, originalUnknownHistoryUnchanged: true,
      ledgers: 1, admissions: 1, snapshots: 1, tokenCalls: 1, formCalls: 1, refusedCalls: 0,
      revokedWithoutRefund: true, externalSend: false, businessVerified: false })
  } catch {
    console.error('YIDA_AUTO_REMAINING_FAILURE ' + JSON.stringify({ phase, ...input.vendor.snapshot() }))
    throw new Error('APP_CONFIGURED_YIDA_REMAINING_UNKNOWN_FAILED')
  } finally {
    input.vendor.close()
    if (old === undefined) delete process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
    else process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = old
  }
}
