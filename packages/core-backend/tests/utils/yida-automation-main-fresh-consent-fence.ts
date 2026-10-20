import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { createYidaMainSyntheticVendor } from './yida-automation-main-synthetic-send'

type Row = Record<string, unknown>
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>
type LedgerIdentity = { tenantId: string; ownerId: string; operationId: string; rowKey: string }
/** The original dispatcher retains in_progress on retry, but each completed
 * reschedule bumps the claim fence again. A running claim has an odd fence;
 * heartbeat never bumps it. These are fresh default-zero consumer rows. */
export function isResolvedUnknownRetry(value: Row): boolean {
  return Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 1 && Number(value.attempts) <= 64
    && value.status === 'in_progress' && value.last_error === 'unknown'
    && typeof value.fence === 'string' && /^[1-9][0-9]*$/u.test(value.fence)
    && BigInt(value.fence) === 2n * BigInt(Number(value.attempts))
}
function data(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_FRESH_FENCE_OBJECT_REQUIRED')
  return value as Row
}

/** Observe the actual native SELECT used by db.cjs -> the original permanent
 * delivery store. Forward original SQL/results/errors; never simulate a row. */
export function observeUnknownLedger(client: { prototype: object }, identity?: LedgerIdentity) {
  const descriptor = Object.getOwnPropertyDescriptor(client.prototype, 'query')
  assert(descriptor?.configurable && typeof descriptor.value === 'function', 'APP_YIDA_FRESH_FENCE_NATIVE_QUERY_REQUIRED')
  const original = descriptor.value, scope = new AsyncLocalStorage<'control'>()
  const sql = 'SELECT * FROM "integration_yida_delivery_ledger" WHERE "tenant_id" = $1 AND "workspace_id" IS NULL'
    + ' AND "operation_id" = $2 AND "row_key" = $3 LIMIT 1 FOR UPDATE'
  const counts = { attempts: 0, completions: 0, unknownRows: 0, errors: 0 }
  const control = { attempts: 0, completions: 0, unknownRows: 0, errors: 0 }
  let restored = false
  const wrapper = function (this: unknown, ...supplied: unknown[]) {
    if (restored || !identity) return Reflect.apply(original, this, supplied)
    const selected = identity
    const expected = [selected.tenantId, selected.operationId, selected.rowKey]
    const config = supplied[0] && typeof supplied[0] === 'object' ? supplied[0] as Row : null
    const statement = typeof supplied[0] === 'string' ? supplied[0] : config?.text
    const values = typeof supplied[0] === 'string' ? supplied[1] : config?.values
    if (statement !== sql || !Array.isArray(values) || values.length !== expected.length
      || expected.some((value, index) => values[index] !== value)) return Reflect.apply(original, this, supplied)
    const counter = scope.getStore() === 'control' ? control : counts
    counter.attempts++
    const complete = (value: unknown) => {
      counter.completions++
      if (value && typeof value === 'object' && Array.isArray((value as Row).rows)) {
        const rows = (value as { rows: Row[] }).rows
        if (rows.length === 1 && rows[0] && rows[0].tenant_id === selected.tenantId && rows[0].owner_id === selected.ownerId
          && rows[0].workspace_id === null && rows[0].operation_id === selected.operationId
          && rows[0].row_key === selected.rowKey && rows[0].status === 'outcome_unknown') counter.unknownRows++
      }
    }
    // Pool.query supplies a callback; transaction clients usually return the
    // original Promise. Observe both forms without changing their result.
    const args = [...supplied], last = args.length - 1
    if (typeof args[last] === 'function') {
      const callback = args[last] as (...values: unknown[]) => unknown
      args[last] = function (this: unknown, ...callbackArgs: unknown[]) {
        const [error, value] = callbackArgs
        if (error) counter.errors++; else complete(value)
        return Reflect.apply(callback, this, callbackArgs)
      }
      return Reflect.apply(original, this, args)
    }
    const pending = Reflect.apply(original, this, args)
    const observed = pending as PromiseLike<unknown> | undefined
    if (observed && typeof observed.then === 'function') {
      void observed.then(complete, () => { counter.errors++ })
    }
    return pending
  }
  Object.defineProperty(client.prototype, 'query', { ...descriptor, value: wrapper })
  return {
    counts,
    arm(selected: LedgerIdentity) {
      assert(!restored && !identity, 'APP_YIDA_FRESH_FENCE_ALREADY_ARMED')
      identity = Object.freeze({ ...selected })
    },
    async positiveControl(query: Query) {
      assert(identity && !restored, 'APP_YIDA_FRESH_FENCE_NOT_ARMED')
      const expected = [identity.tenantId, identity.operationId, identity.rowKey]
      await scope.run('control', () => query(sql, expected))
      assert.deepEqual(control, { attempts: 1, completions: 1, unknownRows: 1, errors: 0 },
        'APP_YIDA_FRESH_FENCE_QUERY_CONTROL_REQUIRED')
      assert.deepEqual(counts, { attempts: 0, completions: 0, unknownRows: 0, errors: 0 })
    },
    restore() {
      if (restored) return
      assert.equal(Object.getOwnPropertyDescriptor(client.prototype, 'query')?.value, wrapper,
        'APP_YIDA_FRESH_FENCE_OBSERVER_CHANGED')
      Object.defineProperty(client.prototype, 'query', descriptor); restored = true
    },
  }
}

/** Actual main/JWT/new consent/new request -> real shared worker -> original
 * native existing-unknown row lookup. All identifiers stay private to this run. */
export async function verifyYidaMainFreshConsentFence(input: {
  origin: string; token: string; tenantId: string; ownerId: string; operationId: string; rowKey: string; sourceGrantId: string
  rule: Readonly<{ id: string; revision: string; slot: string }>; query: Query
  queryObservation: ReturnType<typeof observeUnknownLedger>
  vendor: ReturnType<typeof createYidaMainSyntheticVendor>
}) {
  const { query, vendor } = input
  assert.equal(new URL(input.origin).hostname, '127.0.0.1')
  assert.equal(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED, 'true')
  const prefix = '/api/integration/yida-automation-authorizations'
  let phase: 'BEFORE' | 'GRANT' | 'CONTROL' | 'REQUEST' | 'WORKER' | 'REVOKE' | 'AFTER' = 'BEFORE'
  let freshGrantId = '', requestId = ''
  let observer: ReturnType<typeof observeUnknownLedger> | undefined
  let attempts = 0
  const http = async (method: 'GET' | 'POST', suffix: string, body?: unknown) => {
    const response = await fetch(input.origin + prefix + suffix, { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + input.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const envelope = data(await response.json())
    assert.equal(envelope.ok, true); assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, value: data(envelope.data) }
  }
  const durable = async () => (await query(`SELECT
    (SELECT count(*)::int FROM integration_yida_delivery_ledger WHERE tenant_id=$1 AND owner_id=$2) AS ledgers,
    (SELECT count(*)::int FROM integration_yida_auto_admissions a JOIN integration_yida_auto_grants g ON g.id=a.grant_id
      WHERE g.tenant_id=$1 AND g.owner_id=$2) AS admissions,
    (SELECT count(*)::int FROM integration_yida_auto_execution_snapshots s JOIN integration_yida_auto_grants g ON g.id=s.grant_id
      WHERE g.tenant_id=$1 AND g.owner_id=$2) AS snapshots,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id)::text,'[]'))
      FROM integration_yida_delivery_ledger l WHERE l.tenant_id=$1 AND l.owner_id=$2) AS private_ledger_fingerprint`,
  [input.tenantId, input.ownerId])).rows[0]
  try {
    const before = await durable()
    assert.equal(before.ledgers, 2); assert.equal(before.admissions, 2); assert.equal(before.snapshots, 2)
    const created = await http('POST', '', { confirmationId: randomUUID(), ruleId: input.rule.id,
      expectedRuleRevision: input.rule.revision, actionId: input.rule.slot, projectNo: 'DEMO-P1',
      operationId: input.operationId, rowKeys: [input.rowKey], allowedTriggers: ['manual'], maxExecutions: 1, ttlMs: 900000 })
    assert.equal(created.status, 201); assert.equal(created.value.usedExecutions, 0); assert.equal(created.value.maxExecutions, 1)
    assert.equal(created.value.revoked, false); assert.equal(typeof created.value.grantId, 'string')
    freshGrantId = created.value.grantId as string; assert.notEqual(freshGrantId, input.sourceGrantId)
    phase = 'GRANT'
    observer = input.queryObservation; observer.arm(input)
    phase = 'CONTROL'; await observer.positiveControl(query)
    const accepted = await http('POST', '/' + freshGrantId + '/requests', { requestKey: randomUUID() })
    assert.equal(accepted.status, 202); assert.equal(accepted.value.rowOrdinal, 0)
    assert.equal(accepted.value.deliveryQueued, true); assert.equal(accepted.value.reused, false)
    assert.equal(typeof accepted.value.requestId, 'string'); requestId = accepted.value.requestId as string
    phase = 'REQUEST'
    const deadline = performance.now() + 10000
    let observedWorker = false
    while (performance.now() < deadline) {
      const rows = (await query(`SELECT c.attempts,c.status,c.fence::text AS fence,c.last_error FROM integration_yida_auto_outbox_links l
        JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
        WHERE l.grant_id=$1 AND l.request_id=$2`, [freshGrantId, requestId])).rows
      if (rows.length === 1) attempts = Number(rows[0].attempts)
      if (rows.length === 1 && isResolvedUnknownRetry(rows[0])
        && observer.counts.completions >= 1) {
        attempts = Number(rows[0].attempts); observedWorker = true; break
      }
      await delay(50)
    }
    assert(observedWorker, 'APP_YIDA_FRESH_FENCE_REAL_WORKER_REQUIRED')
    phase = 'WORKER'
    assert(observer.counts.attempts >= 1 && observer.counts.completions === observer.counts.attempts
      && observer.counts.unknownRows === observer.counts.completions && observer.counts.errors === 0,
    'APP_YIDA_FRESH_FENCE_ACTUAL_UNKNOWN_ROW_REQUIRED')
    const inspection = await http('GET', '/' + freshGrantId)
    assert.equal(inspection.status, 200); assert.equal(inspection.value.usedExecutions, 0)
    assert.equal(inspection.value.serialBlocked, false)
    assert(Array.isArray(inspection.value.requests) && inspection.value.requests.length === 1)
    assert.deepEqual(data(inspection.value.requests[0]), { requestId, rowOrdinal: 0, status: 'queued',
      admissionId: null, ledgerStatus: null, durable: true, canSend: false })
    phase = 'REVOKE'
    const revoked = await http('POST', '/' + freshGrantId + '/revoke', {})
    assert.equal(revoked.status, 200); assert.equal(revoked.value.revoked, true); assert.equal(revoked.value.usedExecutions, 0)
    assert.deepEqual(await durable(), before, 'APP_YIDA_FRESH_FENCE_DURABLE_HISTORY_CHANGED')
    const original = await http('GET', '/' + input.sourceGrantId)
    assert.equal(original.value.usedExecutions, 2); assert.equal(original.value.revoked, true)
    assert.equal(original.value.serialBlocked, true)
    assert.deepEqual(vendor.snapshot(), { active: true, closed: false, tokenCalls: 2, formCalls: 2, refusedCalls: 0 })
    const finalConsumers = (await query(`SELECT c.attempts,c.status,c.fence::text AS fence,c.last_error FROM integration_yida_auto_outbox_links l
      JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
      WHERE l.grant_id=$1 AND l.request_id=$2`, [freshGrantId, requestId])).rows
    assert(finalConsumers.length === 1 && Number.isSafeInteger(finalConsumers[0].attempts)
      && Number(finalConsumers[0].attempts) >= attempts && isResolvedUnknownRetry(finalConsumers[0]))
    attempts = Number(finalConsumers[0].attempts)
    assert(observer.counts.completions <= attempts && observer.counts.completions === observer.counts.attempts
      && observer.counts.unknownRows === observer.counts.completions && observer.counts.errors === 0)
    phase = 'AFTER'
    return Object.freeze({ actualMain: true, realPasswordJwt: true, freshConsentCreated: true, freshRequestQueued: true,
      realWorkerClaimed: true, metadataAttempts: attempts, nativeUnknownLookupAttempts: observer.counts.attempts,
      nativeUnknownLookupCompletions: observer.counts.completions, nativeUnknownRowsRead: observer.counts.unknownRows,
      nativeUnknownLookupErrors: 0, nativeQueryPositiveControl: true, retryFenceResolved: true, retryConsumerState: 'in_progress', freshGrantExecutionsUsed: 0,
      newAdmissions: 0, newExecutionSnapshots: 0, existingLedgerRows: 2, existingUnknownHistoryUnchanged: true,
      originalGrantExecutionsUsed: 2, originalSerialBlocked: true, freshConsentRevoked: true,
      syntheticTokenCalls: 2, syntheticFormCalls: 2, refusedVendorCalls: 0, externalSend: false, businessVerified: false })
  } catch {
    console.error('YIDA_AUTO_FRESH_FENCE_FAILURE ' + JSON.stringify({ phase, workerAttempts: attempts,
      ...(observer ? observer.counts : {}), ...vendor.snapshot() }))
    throw new Error('APP_CONFIGURED_YIDA_FRESH_CONSENT_FENCE_FAILED')
  } finally { observer?.restore() }
}
