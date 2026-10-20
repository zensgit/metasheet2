import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { initializationMaterial } from './stock-preparation-yida-initialization-full-app'
import { verifyYidaMainFreshConsentFence, type observeUnknownLedger } from './yida-automation-main-fresh-consent-fence'

type Data = Record<string, unknown>
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Data[] }>
function data(value: unknown): Data {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_SYNTHETIC_OBJECT_REQUIRED')
  return value as Data
}

/** Test-only vendor boundary captured by the REAL host at construction. It
 * never replaces a route, JWT, installed source, authority, ledger or worker.
 * Non-vendor calls retain the original fetch Promise; the two fixed vendor
 * endpoints can NEVER fall through to the network, even outside the window. */
export function createYidaMainSyntheticVendor(original: typeof fetch) {
  const database = new URL(process.env.PLM_FULL_APP_DATABASE_URL ?? '')
  assert(process.platform === 'linux' && database.hostname === '127.0.0.1'
    && database.pathname === '/plm_full_app_synthetic' && process.env.NODE_ENV === 'production')
  const tokenEndpoint = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
  const formEndpoint = 'https://api.dingtalk.com/v1.0/yida/forms/instances'
  const material = initializationMaterial(), accessToken = 'synthetic-full-app-automatic-access'
  let active = false, closed = false, tokenCalls = 0, formCalls = 0, refusedCalls = 0
  let holdFinal = false, held = false, stopRequested = false, abortObserved = false, abortedBeforeStop = false, lateDelivered = false
  let unknownFirst = false
  let heldSignal: AbortSignal | undefined
  let releaseHeld: (() => void) | undefined, rejectHeld: (() => void) | undefined
  let resolveAbort!: () => void
  const aborted = new Promise<void>(resolve => { resolveAbort = resolve })
  const snapshot = () => Object.freeze({ active, closed, tokenCalls, formCalls, refusedCalls })
  const reject = (): never => { throw new Error('APP_YIDA_SYNTHETIC_VENDOR_REFUSED') }
  const intercepted: typeof fetch = (input, init) => {
    if (input !== tokenEndpoint && input !== formEndpoint) return Reflect.apply(original, globalThis, [input, init]) as ReturnType<typeof fetch>
    try {
      if (!active || closed || process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED !== 'true'
        || !init || init.method !== 'POST' || init.redirect !== 'error'
        || !(init.signal instanceof AbortSignal) || init.signal.aborted || typeof init.body !== 'string') reject()
      const body = data(JSON.parse(init!.body as string))
      if (input === tokenEndpoint) {
        tokenCalls++
        if (tokenCalls > 2) reject()
        assert.deepEqual(body, { appKey: material.appKey, appSecret: material.appSecret })
        return Promise.resolve(new Response(JSON.stringify({ accessToken, expireIn: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      formCalls++
      if (formCalls > 2 || formCalls > tokenCalls) reject()
      assert.deepEqual(Object.keys(body).sort(), ['appType', 'formDataJson', 'formUuid', 'systemToken', 'userId'])
      assert.equal(body.appType, 'synthetic_stock_app'); assert.equal(body.formUuid, 'synthetic_stock_form')
      assert.equal(body.systemToken, material.systemToken); assert.equal(body.userId, material.userId)
      assert.equal(new Headers(init!.headers).get('x-acs-dingtalk-access-token'), accessToken)
      assert.equal(typeof body.formDataJson, 'string')
      const common = { project: 'DEMO-P1', componentCode: 'DEMO-PART-A', componentName: '示例物料',
        specification: 'SPEC-1', material: 'MAT-1', version: 'V1' }
      assert.deepEqual(JSON.parse(body.formDataJson as string), formCalls === 1
        ? { ...common, qty: 0, priority: 'normal' }
        : { ...common, parentCode: 'PARENT-1', qty: 3, priority: 'rush' })
      if (holdFinal && formCalls === 2) {
        assert(!held); held = true; heldSignal = init!.signal!
        return new Promise<Response>((resolve, rejectResponse) => {
          const observedAbort = () => {
            abortObserved = true; abortedBeforeStop = !stopRequested; resolveAbort()
          }
          heldSignal!.addEventListener('abort', observedAbort, { once: true })
          releaseHeld = () => {
            assert(abortObserved && stopRequested && !lateDelivered && !closed)
            heldSignal!.removeEventListener('abort', observedAbort); lateDelivered = true
            resolve(new Response(JSON.stringify({ result: 'synthetic-late-automatic-instance' }),
              { status: 201, headers: { 'Content-Type': 'application/json' } }))
          }
          rejectHeld = () => {
            heldSignal!.removeEventListener('abort', observedAbort)
            rejectResponse(new Error('APP_YIDA_SYNTHETIC_VENDOR_CLOSED'))
          }
        })
      }
      // A malformed 2xx for the second row is deliberately UNKNOWN, not ACK.
      return Promise.resolve(new Response(JSON.stringify({ result: formCalls === 1 && !unknownFirst ? 'synthetic-automatic-instance' : null }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }))
    } catch {
      refusedCalls++
      return Promise.reject(new Error('APP_YIDA_SYNTHETIC_VENDOR_REFUSED'))
    }
  }
  return Object.freeze({ fetch: intercepted, snapshot,
    start(mode?: 'hold-final' | 'unknown-first') { assert(!active && !closed && tokenCalls === 0 && formCalls === 0 && refusedCalls === 0); active = true; holdFinal = mode === 'hold-final'; unknownFirst = mode === 'unknown-first' },
    inFlight() { return Object.freeze({ held, stopRequested, abortObserved, abortedBeforeStop, lateDelivered,
      signalAborted: heldSignal?.aborted === true }) },
    markHostStop() { assert(held && heldSignal && !heldSignal.aborted && !stopRequested && !abortObserved); stopRequested = true },
    waitForAbort() { assert(held && stopRequested); return aborted },
    deliverLateResponse() { assert(releaseHeld); releaseHeld() },
    close() { if (held && !lateDelivered) rejectHeld?.(); active = false; closed = true },
    assertUntouched() { assert.deepEqual(snapshot(), { active: false, closed: false, tokenCalls: 0, formCalls: 0, refusedCalls: 0 }) },
  })
}

/** Actual main/JWT + UI-created rule + real installation/shared-loop/native
 * sender, with ONLY the remote token/form boundary simulated. Not yet a
 * browser approval/request-button proof or an in-flight stop proof. */
export async function verifyYidaAutomationMainSyntheticExecution(input: {
  origin: string; ownerToken: string; ownerId: string; tenantId: string; operationId: string; rowKeys: readonly string[]
  rule: Readonly<{ id: string; revision: string; slot: string; sheetId: string }>
  query: Query; vendor: ReturnType<typeof createYidaMainSyntheticVendor>
  browserExecute?: () => Promise<{ grantId: string }>
  queryObservation: ReturnType<typeof observeUnknownLedger>
  reportFreshFence(evidence: Awaited<ReturnType<typeof verifyYidaMainFreshConsentFence>>): void
  report(phase: 'BEGIN' | 'GRANT' | 'FIRST_QUEUED' | 'ACK' | 'SECOND_QUEUED' | 'UNKNOWN' | 'REVOKED'): void
}) {
  const { query, vendor } = input
  assert.equal(new URL(input.origin).hostname, '127.0.0.1')
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED))
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED))
  assert.equal(input.rowKeys.length, 2)
  vendor.assertUntouched()
  const oldFlag = process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
  const oldOwnerFlag = process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
  const prefix = '/api/integration/yida-automation-authorizations'
  let phase: Parameters<typeof input.report>[0] = 'BEGIN'
  let lastHttpStatus = 0
  let lastRequests: Array<{ status: string; ledgerStatus: string }> = []
  const enter = (next: typeof phase) => { phase = next; input.report(next) }
  const http = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const response = await fetch(input.origin + prefix + route, { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + input.ownerToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    lastHttpStatus = response.status
    const payload = data(await response.json())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, payload }
  }
  const consent = { confirmationId: randomUUID(), ruleId: input.rule.id, expectedRuleRevision: input.rule.revision,
    actionId: input.rule.slot, projectNo: 'DEMO-P1', operationId: input.operationId, rowKeys: [...input.rowKeys],
    allowedTriggers: ['manual'], maxExecutions: 2, ttlMs: 900000 }
  let grantId = ''
  async function observe() {
    const result = await http('GET', '/' + grantId)
    assert.equal(result.status, 200); assert.equal(result.payload.ok, true)
    return data(result.payload.data)
  }
  async function waitFor(status: 'closed_observed' | 'admitted', ledgerStatus: 'acknowledged' | 'outcome_unknown', ordinal: number) {
    const deadline = performance.now() + 10000
    while (performance.now() < deadline) {
      const observed = await observe(), requests = observed.requests
      assert(Array.isArray(requests))
      lastRequests = (requests as unknown[]).slice(0, 2).map(value => {
        const row = data(value)
        return { status: typeof row.status === 'string' && ['queued','admitted','closed_observed','closed_unknown','closed_not_sent'].includes(row.status) ? row.status : 'OTHER',
          ledgerStatus: typeof row.ledgerStatus === 'string' && ['prepared','dispatching','acknowledged','outcome_unknown','not_sent'].includes(row.ledgerStatus) ? row.ledgerStatus : 'OTHER' }
      })
      if (requests.length === ordinal + 1 && data(requests[ordinal]).status === status
        && data(requests[ordinal]).ledgerStatus === ledgerStatus) return observed
      await delay(100)
    }
    throw new Error('APP_YIDA_SYNTHETIC_TERMINAL_MISSING')
  }
  try {
    enter('BEGIN'); vendor.start()
    process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = 'true'
    if (input.browserExecute) {
      // Required by the original owner preview gate, only in this guarded,
      // fake-vendor synthetic window. No default or production gate changes.
      process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = 'true'
      grantId = (await input.browserExecute()).grantId
      assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(grantId))
    } else {
    const created = await http('POST', '', consent)
    assert.equal(created.status, 201); assert.equal(created.payload.ok, true)
    const grant = data(created.payload.data)
    assert.equal(typeof grant.grantId, 'string'); grantId = grant.grantId as string
    assert.equal(grant.maxExecutions, 2); assert.equal(grant.usedExecutions, 0)
    assert.equal(grant.canSend, false); assert.equal(grant.externalWriteAttempted, false)
    assert.equal(vendor.snapshot().tokenCalls, 0); assert.equal(vendor.snapshot().formCalls, 0)
    enter('GRANT')
    const keys = [randomUUID(), randomUUID()]
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const accepted = await http('POST', '/' + grantId + '/requests', { requestKey: keys[ordinal] })
      assert.equal(accepted.status, 202); assert.equal(accepted.payload.ok, true)
      const saved = data(accepted.payload.data)
      assert.equal(saved.rowOrdinal, ordinal); assert.equal(saved.reused, false)
      assert.equal(saved.deliveryQueued, true); assert.equal(saved.canSend, false)
      assert.equal(typeof saved.requestId, 'string')
      enter(ordinal === 0 ? 'FIRST_QUEUED' : 'SECOND_QUEUED')
      // UNKNOWN deliberately does NOT retire the request or release its serial
      // slot. Observe both the actual admission and the durable unknown ledger.
      const observed = await waitFor(ordinal === 0 ? 'closed_observed' : 'admitted',
        ordinal === 0 ? 'acknowledged' : 'outcome_unknown', ordinal)
      const rows = observed.requests as unknown[]
      assert.equal(data(rows[ordinal]).requestId, saved.requestId)
      assert.equal(data(rows[ordinal]).ledgerStatus, ordinal === 0 ? 'acknowledged' : 'outcome_unknown')
      assert.equal(observed.usedExecutions, ordinal + 1)
      assert.equal(observed.serialBlocked, ordinal === 1)
      const replay = await http('POST', '/' + grantId + '/requests', { requestKey: keys[ordinal] })
      assert.equal(replay.status, 200); assert.equal(data(replay.payload.data).requestId, saved.requestId)
      assert.equal(data(replay.payload.data).reused, true)
      enter(ordinal === 0 ? 'ACK' : 'UNKNOWN')
    }
    assert.equal((await http('POST', '/' + grantId + '/requests', { requestKey: randomUUID() })).status, 403)
    }
    const terminal = (await query(`SELECT r.row_ordinal,r.status AS request_status,l.status AS ledger_status,
      g.used_executions,g.max_executions,g.active_request_id=r.id AS active
      FROM integration_yida_auto_grants g JOIN integration_yida_auto_requests r ON r.grant_id=g.id
      JOIN integration_yida_auto_admissions a ON a.grant_id=g.id AND a.request_id=r.id
      JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
      WHERE g.id=$1 AND g.owner_id=$2 AND g.tenant_id=$3 ORDER BY r.row_ordinal`, [grantId, input.ownerId, input.tenantId])).rows
    assert.deepEqual(terminal, [
      { row_ordinal: 0, request_status: 'closed_observed', ledger_status: 'acknowledged', used_executions: 2, max_executions: 2, active: false },
      { row_ordinal: 1, request_status: 'admitted', ledger_status: 'outcome_unknown', used_executions: 2, max_executions: 2, active: true },
    ])
    // Wait for the ORIGINAL dispatcher resolutions with the test flag still
    // ON. Restoring OFF must not hide an accidental generic consumer retry.
    const consumerDeadline = performance.now() + 10000
    let consumersClosed = false
    while (performance.now() < consumerDeadline) {
      const consumers = (await query(`SELECT r.row_ordinal,c.status,c.attempts
        FROM integration_yida_auto_requests r JOIN integration_yida_auto_outbox_links l
          ON l.grant_id=r.grant_id AND l.request_id=r.id
        JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
        WHERE r.grant_id=$1 ORDER BY r.row_ordinal`, [grantId])).rows
      if (consumers.length === 2 && consumers[0].status === 'done' && consumers[1].status === 'dead_letter') {
        assert.deepEqual(consumers, [{ row_ordinal: 0, status: 'done', attempts: 1 }, { row_ordinal: 1, status: 'dead_letter', attempts: 1 }])
        consumersClosed = true; break
      }
      await delay(100)
    }
    assert(consumersClosed, 'APP_YIDA_SYNTHETIC_CONSUMER_RESOLUTION_REQUIRED')
    if (!input.browserExecute) {
      const revoked = await http('POST', '/' + grantId + '/revoke', {})
      assert.equal(revoked.status, 200); assert.equal(data(revoked.payload.data).revoked, true)
    }
    assert.equal((await http('POST', '/' + grantId + '/requests', { requestKey: randomUUID() })).status, 403)
    const after = await observe()
    assert.equal(after.usedExecutions, 2); assert.equal(after.revoked, true); assert.equal(after.serialBlocked, true)
    assert.deepEqual(vendor.snapshot(), { active: true, closed: false, tokenCalls: 2, formCalls: 2, refusedCalls: 0 })
    enter('REVOKED')
    const freshFence = await verifyYidaMainFreshConsentFence({ origin: input.origin, token: input.ownerToken,
      ownerId: input.ownerId, tenantId: input.tenantId, operationId: input.operationId, rowKey: input.rowKeys[1],
      sourceGrantId: grantId, rule: input.rule, query, queryObservation: input.queryObservation, vendor })
    input.reportFreshFence(freshFence)
    return Object.freeze({ actualMain: true, actualJwt: true, actualBrowserCreatedRule: true, actualInstalledBinding: true,
      actualSharedWorker: true, actualNativeSenderAndLedger: true, syntheticTokenCalls: 2, syntheticFormCalls: 2,
      acknowledged: 1, outcomeUnknown: 1, executionsUsed: 2, executionLimit: 2, sameRequestReplayNoNewAttempt: !input.browserExecute,
      consumerRows: 2, consumerAttempts: 2, unknownConsumerDeadLettered: true, unknownRetainsAdmittedRequest: true,
      nextRequestDeniedAfterUnknownAtExhaustedBudget: !input.browserExecute, revocationDoesNotRefundOrClearUnknown: true, businessVerified: false,
      externalSend: false, browserApproved: !!input.browserExecute, browserRequested: !!input.browserExecute, inFlightStopProven: false })
  } catch {
    console.error('YIDA_AUTO_SYNTHETIC_FAILURE ' + JSON.stringify({ phase, ...vendor.snapshot(), lastHttpStatus, lastRequests }))
    throw new Error('APP_CONFIGURED_YIDA_AUTO_SYNTHETIC_FAILED')
  } finally {
    if (oldFlag === undefined) delete process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
    else process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = oldFlag
    if (oldOwnerFlag === undefined) delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
    else process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = oldOwnerFlag
    vendor.close()
  }
}
