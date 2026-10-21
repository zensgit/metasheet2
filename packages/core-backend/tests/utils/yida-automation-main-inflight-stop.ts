import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises'
import type { createYidaMainSyntheticVendor } from './yida-automation-main-synthetic-send'

type Row = Record<string, unknown>
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>
function row(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_CONFIGURED_YIDA_INFLIGHT_OBJECT_REQUIRED')
  return value as Row
}
const prefix = '/api/integration/yida-automation-authorizations'
const naturalIntervalMs = 2000

/** Independent fixed-tuple witness of persisted occurrences. This computes no
 * authority or producer input, and never invokes a scheduler/dispatcher. */
export function verifyYidaNaturalOccurrences(input: {
  grantId: string; activationId: string; ruleId: string; ruleRevision: string; actionId: string
  anchorMs: number; approvedAtMs: number; observedAtMs: number; intervalMs: number
  requests: readonly { ordinal: number; occurrenceKey: string }[]
}) {
  const { anchorMs, approvedAtMs, observedAtMs, intervalMs } = input
  assert([anchorMs, approvedAtMs, observedAtMs].every(value => Number.isSafeInteger(value) && value > 0)
    && approvedAtMs >= anchorMs && observedAtMs >= approvedAtMs && intervalMs === naturalIntervalMs,
  'APP_CONFIGURED_YIDA_NATURAL_PHASE_REQUIRED')
  const first = Math.max(1, Math.floor((approvedAtMs - anchorMs) / intervalMs) + 1)
  const last = Math.floor((observedAtMs - anchorMs) / intervalMs)
  assert(last >= first && last - first < 32 && input.requests.length === 2, 'APP_CONFIGURED_YIDA_NATURAL_RANGE_REQUIRED')
  const definition = createHash('sha256').update(JSON.stringify(['yida-interval-definition/v1',
    input.ruleId, input.ruleRevision, input.actionId, anchorMs, intervalMs])).digest('hex')
  const candidates = new Map<string, number>()
  for (let index = first; index <= last; index++) {
    const key = createHash('sha256').update(JSON.stringify(['yida-automation-occurrence/v1',
      input.grantId, input.activationId, input.ruleId, input.ruleRevision, input.actionId,
      'schedule.interval', anchorMs + index * intervalMs, anchorMs, intervalMs, definition])).digest('hex')
    candidates.set(key, index)
  }
  let previous = 0
  for (const [ordinal, request] of input.requests.entries()) {
    const matched = candidates.get(request.occurrenceKey)
    assert(request.ordinal === ordinal && matched !== undefined && matched > previous,
      'APP_CONFIGURED_YIDA_NATURAL_OCCURRENCE_REQUIRED')
    previous = matched
  }
  return Object.freeze({ phaseAnchorVerified: true, occurrenceKeysVerified: 2, manualOccurrencesExcluded: true })
}

/** Test-only actual-main probe. Only the native sender's remote boundary is
 * synthetic. This never calls a runtime factory or aborts its own controller. */
export async function beginYidaMainInFlightStop(input: {
  origin: string; ownerToken: string; ownerId: string; tenantId: string; operationId: string; rowKeys: readonly string[]
  rule: Readonly<{ id: string; revision: string; slot: string; sheetId: string }>
  query: Query; vendor: ReturnType<typeof createYidaMainSyntheticVendor>
}) {
  const { query, vendor } = input
  assert(new URL(input.origin).hostname === '127.0.0.1' && input.rowKeys.length === 2)
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED))
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED))
  vendor.assertUntouched()
  const oldFlag = process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
  let closed = false, grantId = '', stopObserved = false
  let phase: 'RULE' | 'GRANT' | 'FIRST' | 'HELD' | 'NATURAL' | 'STOP' | 'AFTER_STOP' = 'RULE'
  const close = () => {
    if (closed) return
    closed = true; vendor.close()
    if (oldFlag === undefined) delete process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED
    else process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = oldFlag
  }
  const http = async (method: 'GET' | 'POST', suffix: string, body?: unknown) => {
    const response = await fetch(input.origin + prefix + suffix, { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + input.ownerToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const envelope = row(await response.json())
    assert.equal(envelope.ok, true); assert.equal(response.headers.get('cache-control'), 'no-store')
    return { status: response.status, value: row(envelope.data) }
  }
  const state = async (read: Query) => (await read(`SELECT r.row_ordinal,r.status AS request_status,l.status AS ledger_status,
    g.used_executions,g.max_executions,g.active_request_id=r.id AS active
    FROM integration_yida_auto_grants g JOIN integration_yida_auto_requests r ON r.grant_id=g.id
    JOIN integration_yida_auto_admissions a ON a.grant_id=g.id AND a.request_id=r.id
    JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
    WHERE g.id=$1 AND g.owner_id=$2 AND g.tenant_id=$3 ORDER BY r.row_ordinal`, [grantId, input.ownerId, input.tenantId])).rows
  try {
    vendor.start('hold-final'); process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = 'true'
    // Author through the existing real owner route. Do not patch the old UI
    // rule, backdate its anchor or call any scheduler/producer/dispatch method.
    const slot = randomUUID()
    const ruleResponse = await fetch(input.origin + '/api/multitable/sheets/' + encodeURIComponent(input.rule.sheetId) + '/automations', {
      method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + input.ownerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic natural finite YiDa', enabled: true, triggerType: 'schedule.interval',
        triggerConfig: { intervalMs: naturalIntervalMs }, actionType: 'integration_yida_send_authorized',
        actionConfig: { authorizationSlot: slot }, actions: null, conditions: null, executionMode: 'legacy' }),
      signal: AbortSignal.timeout(10000),
    })
    const ruleEnvelope = row(await ruleResponse.json())
    assert.equal(ruleResponse.status, 200); assert.equal(ruleEnvelope.ok, true)
    const savedRule = row(row(ruleEnvelope.data).rule)
    assert.equal(typeof savedRule.id, 'string'); assert.equal(typeof savedRule.integrationAuthorityRevision, 'string')
    assert.equal(savedRule.createdBy, input.ownerId); assert.equal(savedRule.enabled, true)
    assert.equal(savedRule.triggerType, 'schedule.interval'); assert.deepEqual(savedRule.triggerConfig, { intervalMs: naturalIntervalMs })
    assert.equal(savedRule.actionType, 'integration_yida_send_authorized'); assert.deepEqual(savedRule.actionConfig, { authorizationSlot: slot })
    const rule = { id: savedRule.id as string, revision: savedRule.integrationAuthorityRevision as string, slot }
    const liveRules = (await query(`SELECT created_by,trigger_type,trigger_config,integration_authority_revision::text AS revision,
      floor(extract(epoch FROM created_at)*1000)::text AS anchor_ms FROM automation_rules WHERE id=$1 AND sheet_id=$2`,
    [rule.id, input.rule.sheetId])).rows
    assert.equal(liveRules.length, 1)
    const anchorMs = Number(liveRules[0].anchor_ms)
    assert.deepEqual(liveRules[0], { created_by: input.ownerId, trigger_type: 'schedule.interval',
      trigger_config: { intervalMs: naturalIntervalMs }, revision: rule.revision, anchor_ms: String(anchorMs) })
    phase = 'GRANT'
    const created = await http('POST', '', { confirmationId: randomUUID(), ruleId: rule.id,
      expectedRuleRevision: rule.revision, actionId: rule.slot, projectNo: 'DEMO-P1',
      operationId: input.operationId, rowKeys: [...input.rowKeys], allowedTriggers: ['schedule.interval'], maxExecutions: 2, ttlMs: 900000 })
    assert.equal(created.status, 201); assert.equal(created.value.usedExecutions, 0)
    assert(typeof created.value.grantId === 'string'); grantId = created.value.grantId
    // A manual request is not an alternative route into this interval consent.
    const denied = await fetch(input.origin + prefix + '/' + grantId + '/requests', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + input.ownerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey: randomUUID() }), signal: AbortSignal.timeout(10000) })
    const refusal = row(await denied.json())
    assert.equal(denied.status, 403); assert.equal(refusal.ok, false); assert.equal(denied.headers.get('cache-control'), 'no-store')
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      // Only wait for the ORIGINAL boot scheduler's natural ticks. The old
      // per-row ten-second admission budget remains unchanged.
      const deadline = performance.now() + 10000
      let reached = false
      while (performance.now() < deadline) {
        const observed = await state(query)
        if (observed.length === ordinal + 1 && observed[ordinal].request_status === (ordinal === 0 ? 'closed_observed' : 'admitted')
          && observed[ordinal].ledger_status === (ordinal === 0 ? 'acknowledged' : 'dispatching')
          && (ordinal === 0 || vendor.inFlight().held)) { reached = true; break }
        await delay(50)
      }
      assert(reached, 'APP_CONFIGURED_YIDA_INFLIGHT_ADMISSION_REQUIRED')
      phase = ordinal === 0 ? 'FIRST' : 'HELD'
    }
    assert.deepEqual(await state(query), [
      { row_ordinal: 0, request_status: 'closed_observed', ledger_status: 'acknowledged', used_executions: 2, max_executions: 2, active: false },
      { row_ordinal: 1, request_status: 'admitted', ledger_status: 'dispatching', used_executions: 2, max_executions: 2, active: true },
    ])
    assert.deepEqual(vendor.inFlight(), { held: true, stopRequested: false, abortObserved: false,
      abortedBeforeStop: false, lateDelivered: false, signalAborted: false })
    phase = 'NATURAL'
    const requests = (await query(`SELECT r.id,r.row_ordinal,r.occurrence_key,g.activation_id,g.approved_at_ms::text AS approved_ms,
      floor(extract(epoch FROM clock_timestamp())*1000)::text AS observed_ms,
      o.event_type,o.manifest_version,o.automation_depth,o.payload,c.consumer_key,c.attempts,c.status AS consumer_status
      FROM integration_yida_auto_grants g JOIN integration_yida_auto_requests r ON r.grant_id=g.id
      JOIN integration_yida_auto_outbox_links l ON l.grant_id=g.id AND l.request_id=r.id
      JOIN meta_automation_outbox o ON o.id=l.outbox_id
      JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
      WHERE g.id=$1 AND g.owner_id=$2 AND g.tenant_id=$3 ORDER BY r.row_ordinal`, [grantId, input.ownerId, input.tenantId])).rows
    assert.equal(requests.length, 2)
    for (const [ordinal, request] of requests.entries()) {
      assert.equal(request.activation_id, requests[0].activation_id); assert.equal(request.approved_ms, requests[0].approved_ms)
      assert.equal(request.event_type, 'integration.yida.authorized.requested'); assert.equal(request.manifest_version, 5)
      assert.equal(request.automation_depth, 0); assert.equal(request.consumer_key, 'integration-yida-authorized-send')
      assert.deepEqual(request.payload, { requestId: request.id }); assert.equal(request.attempts, 1)
      assert.equal(request.consumer_status, ordinal === 0 ? 'done' : 'in_progress')
    }
    const phaseProof = verifyYidaNaturalOccurrences({ grantId, activationId: String(requests[0].activation_id),
      ruleId: rule.id, ruleRevision: rule.revision, actionId: rule.slot, anchorMs, intervalMs: naturalIntervalMs,
      approvedAtMs: Number(requests[0].approved_ms), observedAtMs: Number(requests[0].observed_ms),
      requests: requests.map(request => ({ ordinal: Number(request.row_ordinal), occurrenceKey: String(request.occurrence_key) })) })
    return Object.freeze({
      natural: Object.freeze({ actualMain: true, realPasswordJwt: true, realRuleHttpCreated: true, intervalMs: naturalIntervalMs,
        intervalOnlyConsent: true, naturalRequests: 2, manualRequestsRejected: 1, manualRequestsAccepted: 0,
        ...phaseProof, actualSharedOutboxRows: 2, consumerAttempts: 2, acknowledged: 1, heldDispatching: 1,
        executionLimit: 2, executionsUsed: 2, externalSend: false, businessVerified: false }),
      ready: Object.freeze({ actualMain: true, actualJwt: true, actualInstalledBinding: true, actualSharedWorker: true,
        acknowledgedBeforeStop: 1, dispatchingBeforeStop: 1, requests: 2, executionsUsed: 2,
        heldNativeForm: true, abortBeforeStop: false, externalSend: false }),
      markStopping() { assert(!closed && !stopObserved); phase = 'STOP'; vendor.markHostStop() },
      async duringStop(stopped: Promise<unknown>, mainPoolEnded: () => boolean) {
        let settled = false, timer: ReturnType<typeof setTimeout> | undefined
        void stopped.then(() => { settled = true }, () => { settled = true })
        try {
          await Promise.race([vendor.waitForAbort(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('APP_CONFIGURED_YIDA_INFLIGHT_ABORT_MISSING')), 5000)
          })])
          await nextTurn(); await delay(100)
          assert.equal(settled, false, 'APP_CONFIGURED_YIDA_INFLIGHT_STOP_EARLY')
          assert.equal(mainPoolEnded(), false, 'APP_CONFIGURED_YIDA_INFLIGHT_POOL_EARLY')
          assert.deepEqual(vendor.inFlight(), { held: true, stopRequested: true, abortObserved: true,
            abortedBeforeStop: false, lateDelivered: false, signalAborted: true })
          stopObserved = true; vendor.deliverLateResponse()
        } catch {
          console.error('YIDA_AUTO_INFLIGHT_FAILURE ' + JSON.stringify({ phase: 'STOP', stopSettled: settled,
            mainPoolEnded: mainPoolEnded(), ...vendor.snapshot(), ...vendor.inFlight() }))
          throw new Error('APP_CONFIGURED_YIDA_INFLIGHT_STOP_BARRIER_FAILED')
        } finally {
          if (timer) clearTimeout(timer)
          // A failed probe must never leave the real host awaiting our fake IO.
          if (!vendor.inFlight().lateDelivered) close()
        }
      },
      async verifyAfterStop(read: Query) {
        phase = 'AFTER_STOP'
        let observed: Row[] = []
        try {
          assert(stopObserved, 'APP_CONFIGURED_YIDA_INFLIGHT_STOP_NOT_OBSERVED')
          observed = await state(read)
          // Parent lifetime is revoked. The approved contract forbids a new
          // terminal-write bypass merely to make a stopped ledger look final.
          // Dispatching is unresolved, NOT a committed outcome_unknown or ACK.
          assert.deepEqual(observed, [
            { row_ordinal: 0, request_status: 'closed_observed', ledger_status: 'acknowledged', used_executions: 2, max_executions: 2, active: false },
            { row_ordinal: 1, request_status: 'admitted', ledger_status: 'dispatching', used_executions: 2, max_executions: 2, active: true },
          ])
          assert.deepEqual(vendor.snapshot(), { active: true, closed: false, tokenCalls: 2, formCalls: 2, refusedCalls: 0 })
          assert.deepEqual(vendor.inFlight(), { held: true, stopRequested: true, abortObserved: true,
            abortedBeforeStop: false, lateDelivered: true, signalAborted: true })
          return Object.freeze({ actualHostStop: true, sameStopPromise: true, signalAbortedAfterStopRequested: true,
            stopPendingBeforeLateResponse: true, mainPoolOpenBeforeLateResponse: true, lateValid2xxNotAcknowledged: true,
            acknowledged: 1, unresolvedDispatching: 1, outcomeUnknownCommitted: 0, unresolvedRequestAdmitted: true, serialBlocked: true,
            executionsUsed: 2, executionsRefunded: 0, syntheticTokenCalls: 2, syntheticFormCalls: 2,
            businessVerified: false, externalSend: false })
        } catch {
          console.error('YIDA_AUTO_INFLIGHT_FAILURE ' + JSON.stringify({ phase, ...vendor.snapshot(), ...vendor.inFlight(),
            rows: observed.slice(0, 2).map(value => ({ ordinal: value.row_ordinal === 0 ? 0 : value.row_ordinal === 1 ? 1 : -1,
              requestStatus: ['queued','admitted','closed_observed','closed_unknown','closed_not_sent'].includes(String(value.request_status)) ? value.request_status : 'OTHER',
              ledgerStatus: ['prepared','dispatching','acknowledged','outcome_unknown','not_sent'].includes(String(value.ledger_status)) ? value.ledger_status : 'OTHER',
              active: value.active === true })) }))
          throw new Error('APP_CONFIGURED_YIDA_INFLIGHT_POST_STOP_FAILED')
        } finally { close() }
      },
      close,
    })
  } catch {
    console.error('YIDA_AUTO_INFLIGHT_FAILURE ' + JSON.stringify({ phase, ...vendor.snapshot(), ...vendor.inFlight() }))
    close(); throw new Error('APP_CONFIGURED_YIDA_INFLIGHT_FAILED')
  }
}
