'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const ts = require('typescript')
const {
  createYidaDeliveryStore,
  YidaDeliveryStoreError,
} = require('../lib/yida-delivery-store.cjs')

const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const UNIQUE_SCOPE_ROW = 'uniq_integration_yida_delivery_scope_row'
const UNIQUE_CREATE_BUSINESS = 'uniq_integration_yida_delivery_create_business'

test('both ledger suites are registered in their real execution lanes without filtered DB cases', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const specs = ['tests/integration/stock-preparation-yida-write-ledger-realdb.test.ts',
    'tests/integration/stock-preparation-yida-create-fence-realdb.test.ts']
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8'))
  const step = workflow.jobs.test.steps.find((entry) => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  assert.equal(step.env.EXPECT_DB, '1')
  assert.equal(step.if, "matrix.node-version == '20.x'")
  assert.ok(step.env.DATABASE_URL)
  const command = step.run.replace(/\\\r?\n/g, ' ')
  assert.match(command, /vitest --config vitest\.integration\.config\.ts run /)
  for (const spec of specs) assert.equal(command.split(/\s+/).filter((token) => token === spec).length, 1)
  assert.doesNotMatch(command, /(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
  const config = ts.createSourceFile('vitest.config.ts', fs.readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const excluded = new Set()
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const entry of node.initializer.elements) if (ts.isStringLiteral(entry)) excluded.add(entry.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  for (const spec of specs) assert.equal(excluded.has(spec), true)
  const commands = fs.readFileSync(path.join(root, 'plugins/plugin-integration-core/test-chain.txt'), 'utf8').split(/\r?\n/)
  assert.equal(commands.filter((line) => line === 'node __tests__/yida-delivery-store.test.cjs').length, 1)
  for (const spec of specs) assert.equal(commands.some((line) => line.includes(spec)), false)
})

const copy = (value) => structuredClone(value)
const identity = (patch = {}) => ({
  tenantId: 'tenant-a', workspaceId: null, operationId: 'operation-a',
  rowKey: 'row-a', ownerId: 'owner-a', ...patch,
})
const preparation = (patch = {}) => ({
  ...identity(), targetRef: 'target-a', targetRevision: 'target-rev-a',
  planRevision: 'plan-rev-a', payloadDigest: 'a'.repeat(64),
  businessKeyDigest: 'b'.repeat(64), credentialRef: 'credential-a',
  credentialGeneration: 1, intent: 'create', ...patch,
})
const actor = (patch = {}) => ({ ...identity(), actorId: 'actor-a', ...patch })
const ack = (claimToken, patch = {}) => ({
  ...actor(), claimToken, ack: { statusCode: 200, instanceId: 'instance-a' }, ...patch,
})
const unknown = (claimToken, patch = {}) => ({
  ...actor(), claimToken, reason: 'transport_unknown', ...patch,
})

// A transactional unit fake, NOT PostgreSQL lock/rollback evidence. The separate
// realDB suite uses production db.cjs, PostgreSQL and independent connections.
function memoryDb({ wrappedRows = false } = {}) {
  let state = { [LEDGER]: [], [AUDIT]: [] }
  let sequence = 0
  const faults = { audit: false, commit: false, committedResponse: false, insert: null, competitor: null }
  const events = []
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const result = (rows) => wrappedRows ? { rows: copy(rows) } : copy(rows)
  const db = {
    faults,
    events,
    rows: (table = LEDGER) => copy(state[table]),
    async selectOne(table, where) {
      events.push({ type: 'get', table, where: copy(where) })
      return copy(state[table].find((row) => matches(row, where)) || null)
    },
    async transaction(callback) {
      const tx = ++sequence
      const staged = copy(state)
      let pinned = false
      const record = (type, details = {}) => {
        assert.ok(pinned, 'isolation must be pinned before any transaction query')
        events.push({ tx, type, ...details })
      }
      events.push({ tx, type: 'begin' })
      const trx = {
        async setTransactionIsolationLevel(level) {
          assert.equal(level, 'read committed')
          assert.equal(pinned, false)
          pinned = true
          events.push({ tx, type: 'isolation' })
        },
        async selectOneForUpdate(table, where) {
          record('lock', { table, where: copy(where) })
          return copy(staged[table].find((row) => matches(row, where)) || null)
        },
        async insertOne(table, values) {
          record('insert', { table })
          if (table === AUDIT && faults.audit) throw new Error('synthetic-private-audit-failure')
          if (table === LEDGER && faults.insert) {
            const error = faults.insert
            faults.insert = null
            if (faults.competitor) state[LEDGER].push({ ...copy(values), ...faults.competitor })
            throw error
          }
          const row = {
            ...(table === LEDGER ? { claim_token: null, claim_actor_id: null, ack_status_code: null, ack_instance_id: null } : {}),
            ...copy(values), created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z',
          }
          staged[table].push(row)
          return result([row])
        },
        async updateRow(table, values, where) {
          record('update', { table, where: copy(where) })
          const changed = []
          for (const row of staged[table]) {
            if (!matches(row, where)) continue
            Object.assign(row, copy(values))
            changed.push(row)
          }
          return result(changed)
        },
      }
      let value
      try {
        value = await callback(trx)
        if (faults.commit) throw new Error('synthetic-private-commit-failure')
      } catch (error) {
        events.push({ tx, type: 'rollback' })
        throw error
      }
      state = staged
      events.push({ tx, type: 'commit' })
      if (faults.committedResponse) throw new Error('synthetic-private-commit-response-lost')
      return value
    },
  }
  return db
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof YidaDeliveryStoreError)
    assert.equal(error.code, `YIDA_DELIVERY_${code}`)
    assert.equal(error.message, error.code)
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    return true
  })
}

function publicRecord(record) {
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'id', 'intent', 'operationId', 'ownerId', 'rowKey',
    'status', 'tenantId', 'updatedAt', 'workspaceId',
  ])
  assert.ok(!Object.hasOwn(record, 'claimToken'))
  assert.ok(!Object.hasOwn(record, 'instanceId'))
}

test('prepare reuses one scoped identity and rejects every changed snapshot field', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  const first = await store.prepare(preparation())
  assert.equal(first.reused, false)
  publicRecord(first.record)
  const repeated = await store.prepare(preparation())
  assert.equal(repeated.reused, true)
  assert.equal(repeated.record.id, first.record.id)
  const changes = {
    ownerId: 'owner-b', targetRef: 'target-b', targetRevision: 'target-rev-b',
    planRevision: 'plan-rev-b', payloadDigest: 'c'.repeat(64),
    businessKeyDigest: 'd'.repeat(64), credentialRef: 'credential-b', credentialGeneration: 2,
  }
  for (const [key, value] of Object.entries(changes)) {
    await rejectsCode(() => store.prepare(preparation({ [key]: value })), 'CONFLICT')
  }
  await rejectsCode(() => store.prepare(preparation({ intent: 'update', instanceId: 'instance-a' })), 'CONFLICT')
  await store.prepare(preparation({ rowKey: 'row-update', intent: 'update', instanceId: 'instance-a' }))
  await rejectsCode(() => store.prepare(preparation({ rowKey: 'row-update', intent: 'update', instanceId: 'instance-b' })), 'CONFLICT')
  assert.equal(db.rows().length, 2)
  assert.equal(db.rows(AUDIT).length, 2)
})

test('null workspace, named workspace, tenant and rows stay separate; owner cannot split identity', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  for (const patch of [{}, { workspaceId: 'workspace-a' }, { tenantId: 'tenant-b' }, { rowKey: 'row-b' }]) {
    await store.prepare(preparation(patch))
  }
  assert.equal(new Set(db.rows().map((row) => row.id)).size, 4)
  assert.equal(await store.get(identity({ ownerId: 'owner-b' })), null)
  assert.equal(await store.get(identity({ workspaceId: 'workspace-b' })), null)
  assert.equal(await store.get(identity({ tenantId: 'tenant-c' })), null)
  for (const patch of [{ ownerId: 'owner-b' }, { workspaceId: 'workspace-b' }, { tenantId: 'tenant-c' }]) {
    await rejectsCode(() => store.claim(actor(patch)), 'NOT_FOUND')
    await rejectsCode(() => store.cancelPrepared(actor(patch)), 'NOT_FOUND')
  }
  await rejectsCode(() => store.prepare(preparation({ ownerId: 'owner-b' })), 'CONFLICT')
  assert.equal((await store.get(identity())).status, 'prepared')
})

test('claim returns one committed private token; reloaded store and repeated prepare cannot reclaim it', async () => {
  for (const wrappedRows of [false, true]) {
    const db = memoryDb({ wrappedRows })
    const store = createYidaDeliveryStore({ db })
    await store.prepare(preparation())
    const claimed = await store.claim(actor())
    assert.match(claimed.claimToken, /^[0-9a-f]{64}$/)
    assert.equal(claimed.record.status, 'dispatching')
    publicRecord(claimed.record)
    assert.equal(db.events.at(-1).type, 'commit')
    assert.deepEqual(db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim'])
    const reloaded = createYidaDeliveryStore({ db })
    await rejectsCode(() => reloaded.claim(actor()), 'STATE')
    await rejectsCode(() => reloaded.cancelPrepared(actor()), 'STATE')
    assert.equal((await reloaded.prepare(preparation())).reused, true)
    publicRecord(await reloaded.get(identity()))
    assert.equal(db.rows()[0].claim_token, claimed.claimToken)
  }
})

test('create ACK records protocol acknowledgement, never success, without projecting receipt values', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  const { claimToken } = await store.claim(actor())
  const record = await store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 201, instanceId: 'private-instance-a' } }))
  assert.equal(record.status, 'acknowledged')
  publicRecord(record)
  assert.equal(db.rows()[0].ack_instance_id, 'private-instance-a')
  assert.equal(db.rows()[0].ack_status_code, 201)
  assert.equal((await store.prepare(preparation())).record.status, 'acknowledged')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.recordAcknowledgement(ack(claimToken)), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown(claimToken)), 'STATE')
  for (const entry of db.rows(AUDIT)) {
    assert.deepEqual(Object.keys(entry).filter((key) => key !== 'updated_at').sort(), [
      'created_at', 'event', 'id', 'ledger_id', 'reason', 'status',
    ])
    assert.ok(!JSON.stringify(entry).includes('private-instance-a'))
    assert.ok(!JSON.stringify(entry).includes(claimToken))
  }
})

test('ACK validates strict shape, 2xx and explicit bounded instance; update binds its original instance', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation({ intent: 'update', instanceId: 'instance-a' }))
  const { claimToken } = await store.claim(actor())
  for (const code of [199, 300, 500, '200', 200.5, null]) {
    await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: code, instanceId: 'instance-a' } })), 'ACK')
  }
  for (const instanceId of ['', ' instance-a', 'a'.repeat(129), 123, null, 'instance-b']) {
    await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 200, instanceId } })), 'ACK')
  }
  for (const invalid of [
    { statusCode: 200 }, { instanceId: 'instance-a' },
    { statusCode: 200, instanceId: 'instance-a', verified: true },
    { statusCode: 200, instanceId: 'instance-a', body: { arbitrary: true } },
  ]) await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: invalid })), 'INPUT')
  assert.equal((await store.get(identity())).status, 'dispatching')
  assert.equal((await store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 204, instanceId: 'instance-a' } }))).status, 'acknowledged')
})

test('completion is bound to token, actor, full scope and row, while unknown remains terminal', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  await store.prepare(preparation({ rowKey: 'row-b' }))
  const first = await store.claim(actor())
  const second = await store.claim(actor({ rowKey: 'row-b' }))
  assert.notEqual(first.claimToken, second.claimToken)
  for (const method of [
    (patch) => store.recordAcknowledgement(ack(first.claimToken, patch)),
    (patch) => store.markUnknown(unknown(first.claimToken, patch)),
  ]) {
    for (const patch of [{ claimToken: '0'.repeat(64) }, { claimToken: '' }, { actorId: 'actor-b' }, { rowKey: 'row-b' }]) {
      await rejectsCode(() => method(patch), 'TOKEN')
    }
    for (const patch of [{ tenantId: 'tenant-b' }, { workspaceId: 'workspace-b' }, { ownerId: 'owner-b' }]) {
      await rejectsCode(() => method(patch), 'NOT_FOUND')
    }
  }
  await rejectsCode(() => store.markUnknown(unknown(first.claimToken, { reason: 'arbitrary-private-exception' })), 'INPUT')
  assert.equal((await store.markUnknown(unknown(first.claimToken))).status, 'outcome_unknown')
  await rejectsCode(() => store.recordAcknowledgement(ack(first.claimToken)), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown(first.claimToken)), 'STATE')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.cancelPrepared(actor()), 'STATE')
  assert.equal((await store.get(identity({ rowKey: 'row-b' }))).status, 'dispatching')
  assert.equal((await store.recordAcknowledgement(ack(second.claimToken, { rowKey: 'row-b' }))).status, 'acknowledged')
})

test('only prepared rows can be cancelled and cancellation never supplies a retry', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  assert.equal((await store.cancelPrepared(actor())).status, 'not_sent')
  assert.equal((await store.prepare(preparation())).record.status, 'not_sent')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.cancelPrepared(actor()), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown('a'.repeat(64))), 'STATE')
  await rejectsCode(() => store.recordAcknowledgement(ack('a'.repeat(64))), 'STATE')
  assert.equal(db.rows()[0].claim_token, null)
})

test('audit failure atomically rolls back prepare, claim, ACK, unknown and cancellation', async () => {
  for (const operation of ['prepare', 'claim', 'ack', 'unknown', 'cancel']) {
    const db = memoryDb()
    const store = createYidaDeliveryStore({ db })
    let claimToken
    if (operation !== 'prepare') await store.prepare(preparation())
    if (['ack', 'unknown'].includes(operation)) ({ claimToken } = await store.claim(actor()))
    const before = [db.rows(), db.rows(AUDIT)]
    db.faults.audit = true
    const actions = {
      prepare: () => store.prepare(preparation()), claim: () => store.claim(actor()),
      ack: () => store.recordAcknowledgement(ack(claimToken)),
      unknown: () => store.markUnknown(unknown(claimToken)), cancel: () => store.cancelPrepared(actor()),
    }
    await rejectsCode(actions[operation], 'UNAVAILABLE')
    assert.deepEqual([db.rows(), db.rows(AUDIT)], before)
    assert.equal(db.events.at(-1).type, 'rollback')
    db.faults.audit = false
    await actions[operation]()
  }
})

test('failed commit does not return a claim; lost committed response cannot reopen dispatching', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  db.faults.commit = true
  await rejectsCode(() => store.claim(actor()), 'UNAVAILABLE')
  assert.equal(db.rows()[0].status, 'prepared')
  db.faults.commit = false
  db.faults.committedResponse = true
  await rejectsCode(() => store.claim(actor()), 'UNAVAILABLE')
  db.faults.committedResponse = false
  assert.equal(db.rows()[0].status, 'dispatching')
  await rejectsCode(() => createYidaDeliveryStore({ db }).claim(actor()), 'STATE')
})

test('known scope-row unique race rolls back before a new transaction reuses or conflicts', async () => {
  for (const competitor of [{}, { owner_id: 'owner-b' }, { credential_generation: 2 }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-unique-values'), { code: '23505', constraint: UNIQUE_SCOPE_ROW })
    db.faults.competitor = competitor
    const store = createYidaDeliveryStore({ db })
    if (Object.keys(competitor).length) await rejectsCode(() => store.prepare(preparation()), 'CONFLICT')
    else assert.equal((await store.prepare(preparation())).reused, true)
    const rolledBack = db.events.findIndex((event) => event.type === 'rollback')
    const secondBegin = db.events.findIndex((event) => event.type === 'begin' && event.tx === 2)
    assert.ok(rolledBack > -1 && secondBegin > rolledBack)
    assert.equal(db.events.filter((event) => event.tx === 1 && event.type === 'lock').length, 1)
    assert.equal(db.rows().length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('business unique race preserves identical-operation replay after rollback in a new transaction', async () => {
  const db = memoryDb()
  db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
  db.faults.competitor = {}
  let result
  await assert.doesNotReject(async () => { result = await createYidaDeliveryStore({ db }).prepare(preparation()) })
  assert.equal(result.reused, true)
  publicRecord(result.record)
  const rollback = db.events.findIndex(event => event.type === 'rollback')
  assert.ok(rollback >= 0)
  assert.equal(db.events[rollback + 1].type, 'begin')
  assert.equal(db.events.filter(event => event.type === 'insert').length, 1)
  assert.equal(db.rows(AUDIT).length, 0)
})

test('business collision never returns a changed snapshot under the same operation identity', async () => {
  for (const competitor of [{ owner_id: 'owner-b' }, { credential_generation: 2 }, { payload_digest: 'c'.repeat(64) }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
    db.faults.competitor = competitor
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'CONFLICT')
    assert.equal(db.rows().length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('business collision of another operation returns only a fixed conflict and never the other owner record', async () => {
  for (const competitor of [{ operation_id: 'operation-b' }, { row_key: 'row-b' },
    { operation_id: 'operation-b', owner_id: 'owner-b' }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
    db.faults.competitor = competitor
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'BUSINESS_CONFLICT')
    const retryLocks = db.events.filter(event => event.tx === 2 && event.type === 'lock')
    assert.equal(retryLocks.length, 1)
    assert.deepEqual(retryLocks[0].where, { tenant_id: 'tenant-a', workspace_id: null, operation_id: 'operation-a', row_key: 'row-a' })
    assert.equal(db.events.filter(event => event.type === 'insert').length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('unrelated unique errors and arbitrary driver exceptions are sanitized without retry', async () => {
  for (const error of [
    Object.assign(new Error('synthetic-private-database-values'), { code: '23505', constraint: 'other_unique' }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '40001', constraint: UNIQUE_SCOPE_ROW }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '40001', constraint: UNIQUE_CREATE_BUSINESS }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS + '_other' }),
  ]) {
    const db = memoryDb()
    db.faults.insert = error
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'UNAVAILABLE')
    assert.equal(db.events.filter((event) => event.type === 'begin').length, 1)
    assert.equal(db.rows().length, 0)
  }
})

test('strict input rejects missing scope, unbounded IDs, payloads, credentials and accessors before storage', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  const absentWorkspace = preparation()
  delete absentWorkspace.workspaceId
  const inputs = [
    absentWorkspace, preparation({ workspaceId: '' }), preparation({ ownerId: ' ' }),
    preparation({ rowKey: 'a\n' }), preparation({ operationId: 'a'.repeat(129) }),
    preparation({ payloadDigest: 'a'.repeat(63) }), preparation({ businessKeyDigest: 'A'.repeat(64) }),
    preparation({ credentialGeneration: 0 }), preparation({ credentialGeneration: 2147483648 }),
    preparation({ credentialGeneration: '1' }), preparation({ instanceId: 'instance-a' }),
    preparation({ intent: 'update' }), preparation({ intent: 'success' }),
    preparation({ targetRevision: 1 }), preparation({ payload: {} }),
    preparation({ token: 'synthetic-secret' }), preparation({ systemToken: 'synthetic-secret' }),
    preparation({ userId: 'caller' }), preparation({ url: 'https://invalid.example' }),
    [], null, Object.assign(Object.create({ inherited: true }), preparation()),
  ]
  let accessed = false
  const accessor = preparation()
  Object.defineProperty(accessor, 'ownerId', { get() { accessed = true; return 'owner-a' }, enumerable: true })
  inputs.push(accessor)
  for (const input of inputs) await rejectsCode(() => store.prepare(input), 'INPUT')
  assert.equal(accessed, false)
  assert.equal(db.events.length, 0)
})

test('missing transactional capabilities fail closed before any mutation', async () => {
  assert.throws(() => createYidaDeliveryStore(), { code: 'YIDA_DELIVERY_UNAVAILABLE' })
  const store = createYidaDeliveryStore({
    db: { selectOne() {}, async transaction(callback) { return callback({}) } },
  })
  await rejectsCode(() => store.prepare(preparation()), 'UNAVAILABLE')
  const read = createYidaDeliveryStore({
    db: { transaction() {}, async selectOne() { throw new Error('synthetic-private-read-error') } },
  })
  await rejectsCode(() => read.get(identity()), 'UNAVAILABLE')
})
