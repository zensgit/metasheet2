'use strict'

// Actual planner/store/token/protocol composition. Only the execution snapshot,
// database boundary and fetch are synthetic. This proves NO runtime authority.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { ReadableStream } = require('node:stream/web')
const { createYidaTokenClient } = require('../lib/yida-token-client.cjs')
const { createDingTalkAppTokenExchange } = require('../lib/yida-token-exchange.cjs')
const { stableCanonicalStringify } = require('../lib/gip-canonical-json.cjs')

const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const copy = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const context = () => ({ tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', actorId: 'synthetic-owner' })
const request = () => ({ operationId: 'synthetic-operation', rowKey: 'synthetic-row' })
const deferred = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }

// A bounded single-process transactional stand-in, not a PG concurrency proof.
// The companion realdb file uses actual db.cjs, migration 088 and real rollback.
function memoryDb() {
  let state = { [LEDGER]: [], [AUDIT]: [] }
  const h = { events: [], beforeCommit: async () => {}, afterCommit: async () => {}, rejectAudit: () => false }
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = {
    async selectOne(table, where) {
      h.events.push('get')
      return copy(state[table].find((row) => matches(row, where)) || null)
    },
    async transaction(callback) {
      const staged = copy(state)
      let event
      h.events.push('begin')
      const trx = {
        async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed') },
        async selectOneForUpdate(table, where) { return copy(staged[table].find((row) => matches(row, where)) || null) },
        async insertOne(table, values) {
          if (table === AUDIT) {
            event = values.event
            if (h.rejectAudit(event)) throw new Error('synthetic-private-audit-failure')
          }
          const row = { claim_token: null, claim_actor_id: null, ack_status_code: null, ack_instance_id: null,
            ...copy(values), created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z' }
          staged[table].push(row)
          return [copy(row)]
        },
        async updateRow(table, values, where) {
          const changed = staged[table].filter((row) => matches(row, where))
          for (const row of changed) Object.assign(row, copy(values))
          return copy(changed)
        },
      }
      try {
        const result = await callback(trx)
        await h.beforeCommit(event)
        state = staged
        h.events.push(`commit:${event}`)
        await h.afterCommit(event)
        return result
      } catch (error) { h.events.push(`error:${event}`); throw error }
    },
  }
  return Object.assign(h, { db, rows: (table = LEDGER) => copy(state[table]) })
}

async function harness(t, options = {}, transportOptions = {}) {
  const { createYidaDeliveryRunner } = await import('../lib/yida-delivery-runner.mjs')
  const { createYidaProtocolExample, buildYidaStaticPlan } = await import('../lib/yida-static-plan.mjs')
  const { createYidaFormTransport } = require('../lib/yida-form-transport.cjs')
  const example = createYidaProtocolExample()
  const h = { db: memoryDb(), now: 1000, snapshots: [], tokenFetches: [], businessFetches: [], enablement: 'true' }
  h.snapshot = { ...context(), ...request(), grantRef: 'synthetic-grant', expiresAt: 100000,
    targetRef: 'synthetic-target', targetRevision: 'synthetic-target-revision', planRevision: 'synthetic-plan-revision',
    credentialRef: 'synthetic-credential', credentialGeneration: 1, config: example.config, row: example.rows[0],
    systemToken: ' synthetic-private-system-token ', userId: ' synthetic-private-user ' }
  h.resolver = async () => copy(h.snapshot)
  h.tokenFetch = async () => new Response(JSON.stringify({ accessToken: 'synthetic-private-access-token', expireIn: 60 }))
  h.businessFetch = async () => new Response(JSON.stringify({ result: 'synthetic-private-instance' }), { status: 201 })
  const binding = () => Object.fromEntries(['tenantId', 'workspaceId', 'ownerId', 'credentialRef', 'credentialGeneration'].map((key) => [key, h.snapshot[key]]))
  h.client = createYidaTokenClient({
    loadCredential: async (scope) => ({ ...scope, appKey: 'synthetic-private-key', appSecret: 'synthetic-private-secret' }),
    exchangeToken: createDingTalkAppTokenExchange({ fetch: async (...args) => { h.tokenFetches.push(args); return h.tokenFetch(...args) } }),
    monotonicNow: () => 0, safetySkewMs: 0,
  })
  h.client.activate(binding())
  t.after(() => h.client.dispose())
  h.transport = createYidaFormTransport({ fetch: async (...args) => {
    assert.equal(h.db.rows()[0].status, 'dispatching', 'business fetch must follow committed claim')
    assert.ok(h.db.events.includes('commit:claim'))
    h.businessFetches.push(args)
    return h.businessFetch(...args)
  }, readEnablement: () => h.enablement, ...transportOptions })
  h.options = {
    db: h.db.db, context: context(),
    resolveExecutionSnapshot: async (input, signalOptions) => {
      assert.deepEqual(input, { ...context(), ...request() })
      assert.ok(signalOptions.signal instanceof AbortSignal)
      h.snapshots.push(input)
      return h.resolver(input, signalOptions)
    },
    tokenClient: h.client, formTransport: h.transport, readEnablement: () => h.enablement,
    wallClock: () => h.now, timeoutMs: 1000, ...options,
  }
  h.runner = createYidaDeliveryRunner(h.options)
  h.createRunner = (patch = {}) => createYidaDeliveryRunner({ ...h.options, ...patch })
  h.plan = () => buildYidaStaticPlan({ config: h.snapshot.config, rows: [h.snapshot.row] })
  return h
}

function safeResult(result, status, attempted, durable = true) {
  assert.deepEqual(Object.keys(result).sort(), ['businessVerified', 'durable', 'externalWriteAttempted', 'record', 'status'])
  assert.equal(result.status, status)
  assert.equal(result.externalWriteAttempted, attempted)
  assert.equal(result.businessVerified, false)
  assert.equal(result.durable, durable)
  if (result.record) assert.deepEqual(Object.keys(result.record).sort(), [
    'createdAt', 'id', 'intent', 'operationId', 'ownerId', 'rowKey', 'status', 'tenantId', 'updatedAt', 'workspaceId',
  ])
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|claimToken|claim_token|grantRef|payload|succeeded|delivered/)
}

async function rejects(promise, code) {
  const fullCode = { INPUT: 'INVALID_INPUT', SNAPSHOT: 'SNAPSHOT_INVALID', CHANGED: 'SNAPSHOT_CHANGED',
    EXPIRED: 'SNAPSHOT_EXPIRED', CLOCK: 'CLOCK_INVALID', TOKEN: 'TOKEN_FAILED' }[code] || code
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, `YIDA_RUN_${fullCode}`)
    assert.equal(error.message, error.code)
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private/)
    return true
  })
}

test('actual create composition binds the ledger digest to exactly the submitted data bytes', async (t) => {
  const h = await harness(t)
  const result = await h.runner.run(request())
  safeResult(result, 'acknowledged', true)
  assert.equal(h.tokenFetches.length, 1)
  assert.equal(h.businessFetches.length, 1)
  assert.equal(h.snapshots.length, 3)
  const [url, options] = h.businessFetches[0]
  assert.equal(url, 'https://api.dingtalk.com/v1.0/yida/forms/instances')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  const body = JSON.parse(options.body)
  const data = { appType: body.appType, formUuid: body.formUuid, formDataJson: body.formDataJson }
  const planned = h.plan()
  assert.equal(planned.canApply, false)
  assert.equal(body.formDataJson, stableCanonicalStringify(planned.rows[0].payload))
  assert.equal(body.systemToken, h.snapshot.systemToken)
  assert.equal(body.userId, h.snapshot.userId)
  // Execution digest version 2 (design baseline v2.3 §7.2): an unbound snapshot carries both binding digests as null.
  assert.equal(h.db.rows()[0].payload_digest, hash(stableCanonicalStringify({ version: 2,
    grantRef: h.snapshot.grantRef, expiresAt: h.snapshot.expiresAt, actorId: h.snapshot.actorId,
    targetRef: h.snapshot.targetRef, targetRevision: h.snapshot.targetRevision, planRevision: h.snapshot.planRevision,
    intent: 'create', data, formUuid: h.snapshot.config.target.formUuid,
    sourceRecordDigest: null, creationIdentityDigest: null })))
  assert.deepEqual([h.db.rows()[0].source_record_digest, h.db.rows()[0].creation_identity_digest], [null, null])
  assert.equal(h.db.rows()[0].business_key_digest, hash(planned.rows[0].localBusinessKey))
  assert.deepEqual(h.db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim', 'acknowledgement'])
})

test('actual update composes a PUT and reports HTTP acknowledgement, never business verification', async (t) => {
  const h = await harness(t)
  h.snapshot.config.intent = 'update'
  h.snapshot.config.instanceIdField = 'instance'
  h.snapshot.row.instance = 'synthetic-instance'
  h.snapshot.instanceId = 'synthetic-instance'
  h.businessFetch = async () => new Response('{"errorCode":"synthetic-business-error"}')
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  const body = JSON.parse(h.businessFetches[0][1].body)
  assert.equal(h.businessFetches[0][1].method, 'PUT')
  assert.equal(body.formInstanceId, 'synthetic-instance')
  assert.equal(body.formUuid, undefined)
  assert.equal(h.db.rows()[0].ack_instance_id, 'synthetic-instance')
})

for (const enablement of [undefined, false, true, 'TRUE', ' true', 'false']) {
  test(`enablement ${String(enablement)} is OFF with zero downstream IO`, async (t) => {
    const h = await harness(t, { readEnablement: enablement === undefined ? undefined : () => enablement })
    await rejects(h.runner.run(request()), 'DISABLED')
    assert.equal(h.snapshots.length + h.db.events.length + h.tokenFetches.length + h.businessFetches.length, 0)
  })
}

test('an accidentally async rejecting enablement is disabled without an unhandled secret-bearing rejection', async (t) => {
  const h = await harness(t, { readEnablement: () => Promise.reject(new Error('synthetic-private-enablement')) })
  await rejects(h.runner.run(request()), 'DISABLED')
  await flush() // node:test fails if the dependency rejection escapes unhandled.
  assert.equal(h.snapshots.length + h.db.events.length + h.tokenFetches.length + h.businessFetches.length, 0)
})

for (const gate of ['readEnablement', 'wallClock']) {
  for (const shape of ['own-constructor-getter', 'own-species-getter', 'subclass']) {
    test(`nonordinary Promise ${shape} in ${gate} is rejected without reading dependency constructors`, async (t) => {
      let touched = 0
      const value = shape === 'subclass' ? new (class extends Promise {})(resolve => resolve('true')) : Promise.resolve('true')
      if (shape === 'own-constructor-getter') Object.defineProperty(value, 'constructor', {
        get() { touched++; throw new Error('synthetic-private-constructor') },
      })
      if (shape === 'own-species-getter') Object.defineProperty(value, 'constructor', { value: {
        get [Symbol.species]() { touched++; throw new Error('synthetic-private-species') },
      } })
      const h = await harness(t, { [gate]: () => value })
      await rejects(h.runner.run(request()), gate === 'readEnablement' ? 'DISABLED' : 'CLOCK')
      assert.equal(touched, 0)
      assert.equal(h.db.events.length + h.tokenFetches.length + h.businessFetches.length, 0)
      await flush()
    })
  }
}

test('synchronous enablement reentry cannot acquire a second attempt before the BUSY slot is reserved', async (t) => {
  const h = await harness(t)
  let entered = false
  let nested
  let runner
  runner = h.createRunner({ readEnablement: () => {
    if (!entered) {
      entered = true
      nested = runner.run(request()).then((value) => ({ value }), (error) => ({ error }))
    }
    return 'true'
  } })
  safeResult(await runner.run(request()), 'acknowledged', true)
  const rejectedNested = await nested
  assert.ok(rejectedNested.error, 'reentrant request must be denied, not start another attempt')
  assert.equal(rejectedNested.error.code, 'YIDA_RUN_BUSY')
  assert.equal(h.businessFetches.length, 1)
})

test('constructor denies actor impersonation and missing explicit workspace', async (t) => {
  const h = await harness(t)
  assert.throws(() => h.createRunner({ context: { ...context(), actorId: 'synthetic-admin' } }), { code: 'YIDA_RUN_INVALID_INPUT' })
  const absent = context(); delete absent.workspaceId
  assert.throws(() => h.createRunner({ context: absent }), { code: 'YIDA_RUN_INVALID_INPUT' })
  assert.equal(h.snapshots.length + h.db.events.length, 0)
})

test('run accepts only operation and row identity; invalid and aborted requests cause zero IO', async (t) => {
  const h = await harness(t)
  for (const invalid of [null, {}, { ...request(), ownerId: context().ownerId }, { ...request(), verified: true }]) {
    await rejects(h.runner.run(invalid), 'INPUT')
  }
  const aborted = new AbortController(); aborted.abort('synthetic-private-abort')
  await rejects(h.runner.run(request(), { signal: aborted.signal }), 'CANCELLED')
  for (const signal of [{}, new Proxy(new AbortController().signal, {}), Object.create(new AbortController().signal)]) {
    await rejects(h.runner.run(request(), { signal }), 'INPUT')
  }
  assert.equal(h.snapshots.length + h.db.events.length, 0)
})

for (const [field, value] of [['tenantId', 'other'], ['workspaceId', 'other'], ['ownerId', 'other'], ['actorId', 'other'], ['operationId', 'other'], ['rowKey', 'other']]) {
  test(`initial snapshot ${field} mismatch cannot touch storage or tokens`, async (t) => {
    const h = await harness(t); h.snapshot[field] = value
    await rejects(h.runner.run(request()), 'SNAPSHOT')
    assert.equal(h.db.events.length + h.tokenFetches.length + h.businessFetches.length, 0)
  })
}

test('expired grants and clock rollback fail closed', async (t) => {
  const h = await harness(t)
  h.snapshot.expiresAt = h.now
  await rejects(h.runner.run(request()), 'EXPIRED')
  assert.equal(h.db.events.length, 0)
  h.snapshot.expiresAt = 100000
  h.resolver = async () => { h.now -= 1; return copy(h.snapshot) }
  await rejects(h.runner.run(request()), 'CLOCK')
  assert.equal(h.businessFetches.length, 0)
})

test('an accidentally async rejecting clock fails without leaking an unhandled private rejection', async (t) => {
  const h = await harness(t, { wallClock: () => Promise.reject(new Error('synthetic-private-clock')) })
  await rejects(h.runner.run(request()), 'CLOCK')
  await flush()
  assert.equal(h.db.events.length + h.tokenFetches.length + h.businessFetches.length, 0)
})

test('hostile snapshot structures cannot run getters or canonicalize negative zero into accepted input', async (t) => {
  const h = await harness(t)
  const baseline = copy(h.snapshot)
  let accessed = false
  const accessor = copy(baseline)
  Object.defineProperty(accessor, 'systemToken', { enumerable: true, get() { accessed = true; throw new Error('synthetic-private-getter') } })
  const sparse = copy(baseline); sparse.config.fieldMap = Array(1)
  const deep = copy(baseline); let node = deep.row; for (let i = 0; i < 15; i++) { node.nested = {}; node = node.nested }
  const cases = [accessor, new Proxy(baseline, {}), sparse, deep,
    { ...baseline, verified: true }, { ...baseline, row: { ...baseline.row, quantity: -0 } },
    { ...baseline, row: { ...baseline.row, quantity: Infinity } },
    { ...baseline, row: { ...baseline.row, componentName: 'x'.repeat(270000) } }]
  for (const snapshot of cases) {
    h.resolver = async () => snapshot
    await rejects(h.runner.run(request()), 'SNAPSHOT')
  }
  assert.equal(accessed, false)
  assert.equal(h.db.events.length + h.businessFetches.length, 0)
})

test('planner and authorized update-instance matching are enforced before prepare', async (t) => {
  const h = await harness(t)
  h.snapshot.row.quantity = 'wrong-type'
  await rejects(h.runner.run(request()), 'SNAPSHOT')
  h.snapshot.row.quantity = 0
  h.snapshot.config.intent = 'update'; h.snapshot.config.instanceIdField = 'instance'
  h.snapshot.row.instance = 'synthetic-instance'; h.snapshot.instanceId = 'synthetic-other-instance'
  await rejects(h.runner.run(request()), 'SNAPSHOT')
  assert.equal(h.db.events.length, 0)
})

const changes = {
  grant: (s) => { s.grantRef = 'changed-grant' }, expiry: (s) => { s.expiresAt += 1 },
  target: (s) => { s.targetRef = 'changed-target' }, targetRevision: (s) => { s.targetRevision = 'changed-target-revision' },
  plan: (s) => { s.planRevision = 'changed-plan' }, credential: (s) => { s.credentialRef = 'changed-credential' },
  generation: (s) => { s.credentialGeneration += 1 }, systemToken: (s) => { s.systemToken += 'changed' },
  userId: (s) => { s.userId += 'changed' }, config: (s) => { s.config.target.formUuid = 'changed_form' },
  row: (s) => { s.row.quantity += 1 },
}
for (const [label, change] of Object.entries(changes)) {
  test(`post-token ${label} change preserves prepared and sends nothing`, async (t) => {
    const h = await harness(t)
    h.resolver = async () => { const next = copy(h.snapshot); if (h.snapshots.length === 2) change(next); return next }
    await rejects(h.runner.run(request()), 'CHANGED')
    assert.equal(h.db.rows()[0].status, 'prepared')
    assert.equal(h.tokenFetches.length, 1)
    assert.equal(h.businessFetches.length, 0)
  })
}

test('post-claim snapshot change is durably unknown with no business request', async (t) => {
  const h = await harness(t)
  h.resolver = async () => { const next = copy(h.snapshot); if (h.snapshots.length === 3) next.systemToken += 'changed'; return next }
  safeResult(await h.runner.run(request()), 'outcome_unknown', false)
  assert.equal(h.businessFetches.length, 0)
  assert.equal(h.db.rows(AUDIT).at(-1).reason, 'manual_recovery')
})

test('token failure leaves prepared; dependency text and cause cannot escape', async (t) => {
  const h = await harness(t)
  h.tokenFetch = async () => { throw new Error('synthetic-private-token-error') }
  await rejects(h.runner.run(request()), 'TOKEN')
  assert.equal(h.db.rows()[0].status, 'prepared')
  assert.equal(h.businessFetches.length, 0)
})

test('claim commit response loss never sends or reclaims and restart sees dispatching', async (t) => {
  const h = await harness(t)
  h.db.afterCommit = async (event) => { if (event === 'claim') throw new Error('synthetic-private-lost-response') }
  await rejects(h.runner.run(request()), 'CLAIM_UNCONFIRMED')
  assert.equal(h.db.rows()[0].status, 'dispatching')
  h.db.afterCommit = async () => {}
  safeResult(await h.createRunner().run(request()), 'dispatching', false)
  assert.equal(h.businessFetches.length, 0)
  assert.equal(h.tokenFetches.length, 1)
})

test('late ignored-cancellation claim retains BUSY until token arrives, then quarantines once', async (t) => {
  const h = await harness(t)
  const reached = deferred(); const release = deferred(); const controller = new AbortController()
  h.db.beforeCommit = async (event) => { if (event === 'claim') { reached.resolve(); await release.promise } }
  let settled = false
  const pending = h.runner.run(request(), { signal: controller.signal }).finally(() => { settled = true })
  await reached.promise
  controller.abort('synthetic-private-abort')
  await flush()
  assert.equal(settled, false)
  await rejects(h.runner.run(request()), 'BUSY')
  release.resolve()
  safeResult(await pending, 'outcome_unknown', false)
  assert.equal(h.businessFetches.length, 0)
  assert.deepEqual(h.db.rows(AUDIT).map((r) => r.event), ['prepare', 'claim', 'unknown'])
})

test('ignored-abort business fetch keeps BUSY until settlement; the late 2xx is acknowledged, never retried (gate 6)', async (t) => {
  const h = await harness(t)
  const reached = deferred(); const release = deferred(); const controller = new AbortController()
  h.businessFetch = async () => { reached.resolve(); await release.promise; return new Response('{"result":"synthetic-private-late"}') }
  const pending = h.runner.run(request(), { signal: controller.signal })
  await reached.promise; controller.abort()
  await rejects(h.runner.run(request()), 'BUSY')
  release.resolve()
  // The abort reached the request before any status line, but the fetch ignored it and still
  // produced a 2xx: that receipt is evidence the remote accepted the row, so it is acknowledged.
  safeResult(await pending, 'acknowledged', true)
  assert.equal(h.businessFetches.length, 1)
  assert.deepEqual(h.db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim', 'acknowledgement'])
  safeResult(await h.createRunner().run(request()), 'acknowledged', false)
  assert.equal(h.businessFetches.length, 1)
})

test('business timeout retains the slot for an ignored fetch and keeps BUSY; the late 2xx is acknowledged (gate 6)', async (t) => {
  const h = await harness(t, { timeoutMs: 20 })
  const reached = deferred(); const release = deferred(); let signal
  h.businessFetch = async (_url, options) => { signal = options.signal; reached.resolve(); await release.promise; return new Response('{"result":"synthetic-private-late"}') }
  const pending = h.runner.run(request())
  await reached.promise
  // Before the status line the timer still tears the request down (the fetch signal aborts)...
  await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
  await rejects(h.runner.run(request()), 'BUSY')
  release.resolve()
  // ...but a 2xx the fetch nevertheless delivered is not discarded by a post-send check.
  safeResult(await pending, 'acknowledged', true)
  assert.equal(h.businessFetches.length, 1)
})

test('a run timeout that fires after the status line, while the body is still arriving, cannot discard the receipt', async (t) => {
  const h = await harness(t, { timeoutMs: 20 })
  let fetchSignal
  h.businessFetch = async (_url, options) => {
    fetchSignal = options.signal
    // The status line is immediate; the body arrives only after the runner's 20 ms budget expired.
    const body = new ReadableStream({ pull(stream) {
      return new Promise((resolve) => setTimeout(() => { stream.enqueue(Buffer.from('{"result":"synthetic-private-late"}')); stream.close(); resolve() }, 60))
    } }, { highWaterMark: 0 })
    return new Response(body, { status: 201 })
  }
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  assert.equal(fetchSignal.aborted, false, 'after the status line the run signal is no longer forwarded to the request')
  assert.deepEqual(h.db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim', 'acknowledgement'])
  assert.equal(h.db.rows()[0].ack_status_code, 201)
})

test('a stalled 2xx body keeps BUSY and ends as receipt_unparsed at the transport body deadline; never resent', async (t) => {
  const h = await harness(t, {}, { bodyReadTimeoutMs: 50 })
  const entered = deferred()
  h.businessFetch = async () => new Response(new ReadableStream({ pull() { entered.resolve(); return new Promise(() => {}) } }, { highWaterMark: 0 }), { status: 200 })
  const pending = h.runner.run(request())
  await entered.promise
  await rejects(h.runner.run(request()), 'BUSY')
  safeResult(await pending, 'outcome_unknown', true)
  assert.equal(h.db.rows(AUDIT).at(-1).reason, 'receipt_unparsed')
  safeResult(await h.createRunner().run(request()), 'outcome_unknown', false)
  assert.equal(h.businessFetches.length, 1)
  assert.equal(h.tokenFetches.length, 1)
})

for (const [label, responseFactory, reason] of [
  ['network', () => { throw new Error('synthetic-private-wire-error') }, 'transport_unknown'],
  ['refused 4xx', () => new Response('{"result":"synthetic-private-instance"}', { status: 403 }), 'receipt_invalid'],
  ['refused 5xx', () => new Response('{not json', { status: 500 }), 'receipt_invalid'],
  // a2: a 2xx WAS received but its body is unusable; the ledger keeps that distinction.
  ['malformed', () => new Response('{not json'), 'receipt_unparsed'],
  ['missing result', () => new Response('{}'), 'receipt_unparsed'],
  ['oversized', () => new Response(JSON.stringify({ result: 'x'.repeat(17000) })), 'receipt_unparsed'],
]) {
  test(`${label} business outcome is terminal unknown (${reason}) without token refresh or resend`, async (t) => {
    const h = await harness(t); h.businessFetch = responseFactory
    safeResult(await h.runner.run(request()), 'outcome_unknown', true)
    assert.equal(h.db.rows(AUDIT).at(-1).reason, reason)
    assert.equal(h.db.rows()[0].ack_status_code, null)
    safeResult(await h.createRunner().run(request()), 'outcome_unknown', false)
    assert.equal(h.businessFetches.length, 1)
    assert.equal(h.tokenFetches.length, 1)
  })
}

test('ACK commit response loss is observed once and reported as durable acknowledgement', async (t) => {
  const h = await harness(t)
  h.db.afterCommit = async (event) => { if (event === 'acknowledgement') throw new Error('synthetic-private-ack-response-lost') }
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  assert.equal(h.db.events.filter((event) => event === 'get').length, 1)
  assert.deepEqual(h.db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim', 'acknowledgement'])
  assert.equal(h.businessFetches.length, 1)
})

test('cancellation after receiving ACK cannot erase a successful ACK transaction', async (t) => {
  const h = await harness(t)
  const controller = new AbortController()
  h.db.beforeCommit = async (event) => { if (event === 'acknowledgement') controller.abort('synthetic-private-late-cancel') }
  safeResult(await h.runner.run(request(), { signal: controller.signal }), 'acknowledged', true)
  assert.equal(h.businessFetches.length, 1)
  assert.deepEqual(h.db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim', 'acknowledgement'])
})

test('ACK audit rollback becomes unknown; failed unknown audit cannot be claimed durable', async (t) => {
  for (const rejectUnknown of [false, true]) {
    const h = await harness(t)
    h.db.rejectAudit = (event) => event === 'acknowledgement' || (rejectUnknown && event === 'unknown')
    const result = await h.runner.run(request())
    safeResult(result, rejectUnknown ? 'state_unconfirmed' : 'outcome_unknown', true, !rejectUnknown)
    assert.equal(h.db.rows()[0].status, rejectUnknown ? 'dispatching' : 'outcome_unknown')
    assert.equal(h.businessFetches.length, 1)
    assert.equal(h.db.events.filter((event) => event === 'error:acknowledgement').length, 1)
  }
})

test('same completed identity survives a new runner without token fetch or resend', async (t) => {
  const h = await harness(t)
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  let recovered
  await assert.doesNotReject(async () => { recovered = await h.createRunner().run(request()) })
  safeResult(recovered, 'acknowledged', false)
  assert.equal(h.db.rows().length, 1)
  assert.equal(h.businessFetches.length, 1)
  assert.equal(h.tokenFetches.length, 1)
})

// R-71 ⑦.3: a v3 snapshot (copy / constant / concat) is accepted and sends exactly its own planned
// payload; any other mapping version is SNAPSHOT_INVALID before any ledger, token or form I/O.
async function v3Harness(t) {
  const h = await harness(t)
  const { createYidaTransformExample } = await import('../lib/yida-static-plan.mjs')
  const example = createYidaTransformExample()
  h.snapshot.config = example.config
  h.snapshot.row = example.rows[0]
  return h
}

test('R-71 ⑦.3: a v3 snapshot sends exactly its planned payload, derived targets included', async (t) => {
  const h = await v3Harness(t)
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  assert.equal(h.businessFetches.length, 1)
  const body = JSON.parse(h.businessFetches[0][1].body)
  const planned = h.plan().rows[0]
  assert.equal(body.formDataJson, stableCanonicalStringify(planned.payload))
  const sent = JSON.parse(body.formDataJson)
  assert.equal(sent.blankSize, '1200*600*20')
  assert.equal(sent.processRule, 'SYN-RULE-A')
  assert.equal(sent.partCategory, undefined)
  assert.equal(h.db.rows()[0].business_key_digest, hash(planned.localBusinessKey))
})

test('R-71 ⑦.3: mapping versions other than exactly 2 or 3 are SNAPSHOT_INVALID with zero I/O', async (t) => {
  const { createYidaStaticExample } = await import('../lib/yida-static-plan.mjs')
  for (const version of [1, 4, '3', 3.5, null]) {
    const h = await v3Harness(t)
    if (version === 1) {
      const example = createYidaStaticExample()
      h.snapshot.config = example.config; h.snapshot.row = example.rows[0]
    } else h.snapshot.config.version = version
    await rejects(h.runner.run(request()), 'SNAPSHOT')
    assert.equal(h.db.events.length, 0)
    assert.equal(h.tokenFetches.length + h.businessFetches.length, 0)
  }
})

test('R-71 ⑦.3: a v3 snapshot that loses its concat-only columns after the token sends nothing', async (t) => {
  const h = await v3Harness(t)
  h.resolver = async () => {
    const next = copy(h.snapshot)
    // All three concat-only columns gone: the row still plans, but without blankSize.
    if (h.snapshots.length === 2) for (const column of ['ext_blankLength', 'ext_blankWidth', 'ext_blankThickness']) delete next.row[column]
    return next
  }
  await rejects(h.runner.run(request()), 'CHANGED')
  assert.equal(h.db.rows()[0].status, 'prepared')
  assert.equal(h.businessFetches.length, 0)
})

// R-71 ⑦.4 (Y6): the shipped v3 example carries the generated material code (one preset part). The runner never
// stores or receives a code: it re-plans the snapshot row, so the form body carries the code recomputed from the
// snapshot, byte-equal to an independent oracle (node:crypto SHA-1, RFC 4122 UUIDv5 layout, frozen name layout).
function oracleMaterialCode(keyValue, projectNo) {
  const digest = createHash('sha1').update(Buffer.from('6d37f698e75c4b5e8eefb702478a1cfb', 'hex'))
    .update(Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]), 'utf8')).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex')
  return `WLBH-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}

test('R-71 ⑦.4: a v3 snapshot with a generated entry sends the code recomputed from the snapshot row', async (t) => {
  const h = await v3Harness(t)
  assert.equal(h.snapshot.config.fieldMap.some((entry) => entry.transform === 'generated'), true)
  safeResult(await h.runner.run(request()), 'acknowledged', true)
  assert.equal(h.businessFetches.length, 1)
  const sent = JSON.parse(JSON.parse(h.businessFetches[0][1].body).formDataJson)
  assert.equal(sent.materialCodeText, oracleMaterialCode(h.snapshot.row.idempotencyKey, h.snapshot.row.projectNo))
  assert.equal(sent.materialCodeText, h.plan().rows[0].payload.materialCodeText)
  assert.deepEqual(sent, h.plan().rows[0].payload)
})

test('R-71 ⑦.4: a v3 snapshot whose code input changes after the token sends nothing', async (t) => {
  const h = await v3Harness(t)
  h.resolver = async () => {
    const next = copy(h.snapshot)
    // The project of the code changes between the two reads: another code, so the verified payload no longer matches.
    if (h.snapshots.length === 2) next.row.projectNo = 'DEMO-P9'
    return next
  }
  await rejects(h.runner.run(request()), 'CHANGED')
  assert.equal(h.db.rows()[0].status, 'prepared')
  assert.equal(h.businessFetches.length, 0)
})

// ---- Source binding (design baseline v2.3 §7.2): the two row digests travel from the snapshot into the ledger ----
test('a bound snapshot carries both digests into the ledger row and the version-2 execution digest; a half binding is SNAPSHOT_INVALID', async (t) => {
  const h = await harness(t)
  h.snapshot.sourceRecordDigest = 'c'.repeat(64)
  h.snapshot.creationIdentityDigest = 'd'.repeat(64)
  const result = await h.runner.run(request())
  safeResult(result, 'acknowledged', true)
  const row = h.db.rows()[0]
  assert.equal(row.source_record_digest, 'c'.repeat(64))
  assert.equal(row.creation_identity_digest, 'd'.repeat(64))
  const [, options] = h.businessFetches[0]
  const body = JSON.parse(options.body)
  const data = { appType: body.appType, formUuid: body.formUuid, formDataJson: body.formDataJson }
  assert.equal(row.payload_digest, hash(stableCanonicalStringify({ version: 2,
    grantRef: h.snapshot.grantRef, expiresAt: h.snapshot.expiresAt, actorId: h.snapshot.actorId,
    targetRef: h.snapshot.targetRef, targetRevision: h.snapshot.targetRevision, planRevision: h.snapshot.planRevision,
    intent: 'create', data, formUuid: h.snapshot.config.target.formUuid,
    sourceRecordDigest: 'c'.repeat(64), creationIdentityDigest: 'd'.repeat(64) })))
  for (const patch of [{ creationIdentityDigest: null }, { sourceRecordDigest: 'C'.repeat(64) }, { creationIdentityDigest: 'd'.repeat(63) }]) {
    const broken = await harness(t)
    broken.snapshot.sourceRecordDigest = 'c'.repeat(64)
    broken.snapshot.creationIdentityDigest = 'd'.repeat(64)
    Object.assign(broken.snapshot, patch)
    await rejects(broken.runner.run(request()), 'SNAPSHOT')
    assert.equal(broken.db.rows().length, 0)
    assert.equal(broken.tokenFetches.length + broken.businessFetches.length, 0)
  }
})
