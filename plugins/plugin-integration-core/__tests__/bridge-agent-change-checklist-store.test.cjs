'use strict'

// BA-APPLY-2a — content-keyed checklist persistence + values-free audit + approval gate. Mock db
// only — no network, no adapter, no route, no Agent. Design-lock
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 B + §4 hard locks.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  BridgeAgentChecklistValidationError,
  BridgeAgentChecklistNotFoundError,
  BridgeAgentChecklistConflictError,
  BridgeAgentChecklistNotApprovedError,
  createBridgeAgentChecklistStore,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'bridge-agent-change-checklist-store.cjs'))

const CHECKLIST_TABLE = 'integration_bridge_agent_checklists'
const AUDIT_TABLE = 'integration_bridge_agent_checklist_audit'

function createMockDb() {
  const tables = { [CHECKLIST_TABLE]: [], [AUDIT_TABLE]: [] }
  const calls = []

  function matchesWhere(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    tables,
    calls,
    async selectOne(table, where) {
      calls.push(['selectOne', table, { ...where }])
      return tables[table].find((row) => matchesWhere(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push(['insertOne', table, JSON.parse(JSON.stringify(row))])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-07-08T00:00:00.000Z',
        updated_at: row.updated_at || '2026-07-08T00:00:00.000Z',
      }
      tables[table].push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = tables[table].find((candidate) => matchesWhere(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-07-08T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = tables[table].filter((row) => matchesWhere(row, options.where || {}))
      return filtered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
    async transaction(callback) {
      calls.push(['transaction'])
      return callback(this)
    },
  }
}

// Distinctive strings so leak scans are meaningful: the audit trail must never contain any of them.
const DISTINCTIVE = {
  objectName: 'DistinctiveMaterial',
  fieldKey: 'FDistinctiveNumber',
}

function validChecklist(overrides = {}) {
  return {
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: DISTINCTIVE.objectName, fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: [DISTINCTIVE.fieldKey] },
    ],
    ...overrides,
  }
}

function newStore() {
  const db = createMockDb()
  let seq = 0
  const store = createBridgeAgentChecklistStore({ db, idGenerator: () => `id_${++seq}` })
  return { db, store }
}

const SCOPE = { tenantId: 'tenant_1', workspaceId: 'workspace_1' }

async function testInvalidChecklistRejectedValuesFree() {
  const { db, store } = newStore()
  // A write/delete op must be rejected before it can be persisted.
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, checklist: validChecklist({ operations: [{ op: 'delete_object', objectName: 'material', fieldKeys: [] }] }), actor: 'op_1' }),
    (error) => {
      assert.ok(error instanceof BridgeAgentChecklistValidationError)
      assert.ok(Array.isArray(error.details.errors) && error.details.errors.length > 0)
      return true
    },
  )
  // A host/secret pasted as an object name is rejected and never persisted or echoed.
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, checklist: validChecklist({ operations: [{ op: 'add_readonly_object', objectName: 'server=1.2.3.4;pwd=Secret123', fieldKeys: [] }] }), actor: 'op_1' }),
    (error) => {
      assert.ok(error instanceof BridgeAgentChecklistValidationError)
      assert.ok(!JSON.stringify(error.details).includes('Secret123'))
      return true
    },
  )
  assert.equal(db.tables[CHECKLIST_TABLE].length, 0, 'invalid checklist never reaches the table')
  assert.equal(db.tables[AUDIT_TABLE].length, 0, 'invalid checklist never reaches the audit table')
}

async function testSaveStoresNormalizedAndMintsDraft() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })
  assert.equal(saved.reused, false)
  assert.equal(saved.version, 1)
  assert.equal(saved.status, 'draft')
  assert.match(saved.contentKey, /^[0-9a-f]{64}$/)
  assert.equal(saved.createdBy, 'op_1')
  const row = db.tables[CHECKLIST_TABLE][0]
  assert.deepEqual(JSON.parse(JSON.stringify(row.checklist)), {
    schemaVersion: 1,
    operations: [
      { op: 'add_readonly_object', objectName: DISTINCTIVE.objectName, fieldKeys: [] },
      { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: [DISTINCTIVE.fieldKey] },
    ],
  })
}

async function testContentKeyIdempotency() {
  const { db, store } = newStore()
  const first = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })
  const second = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_2' })
  assert.equal(second.reused, true)
  assert.equal(second.id, first.id)
  assert.equal(db.tables[CHECKLIST_TABLE].length, 1, 'idempotent save is a no-op on the checklist table')
  assert.deepEqual(db.tables[AUDIT_TABLE].map((row) => row.action), ['save_version', 'reuse_version'])

  // Changed content → next version in the family.
  const third = await store.saveVersion({
    ...SCOPE,
    checklist: validChecklist({ operations: [{ op: 'add_readonly_object', objectName: 'material', fieldKeys: [] }] }),
    actor: 'op_1',
  })
  assert.equal(third.reused, false)
  assert.equal(third.version, 2)
  assert.equal(db.tables[CHECKLIST_TABLE].length, 2)
}

async function testStatusTransitionsFailClosed() {
  const { store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })

  // retire before approve → conflict (only approved → retired).
  await assert.rejects(
    () => store.retire({ ...SCOPE, id: saved.id, actor: 'op_1' }),
    (error) => error instanceof BridgeAgentChecklistConflictError,
  )
  // APPROVAL GATE: apply lookup of a DRAFT → fail-closed NotApproved.
  await assert.rejects(
    () => store.getForApply({ ...SCOPE, id: saved.id }),
    (error) => error instanceof BridgeAgentChecklistNotApprovedError && error.details.status === 'draft',
  )

  const approved = await store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  assert.equal(approved.status, 'approved')
  // double-approve → conflict.
  await assert.rejects(
    () => store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' }),
    (error) => error instanceof BridgeAgentChecklistConflictError,
  )
  // APPROVAL GATE: an approved checklist IS fetchable for apply.
  const forApply = await store.getForApply({ ...SCOPE, id: saved.id })
  assert.equal(forApply.status, 'approved')

  const retired = await store.retire({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  assert.equal(retired.status, 'retired')
  // APPROVAL GATE: a RETIRED checklist is no longer applyable (terminal, fail-closed).
  await assert.rejects(
    () => store.getForApply({ ...SCOPE, id: saved.id }),
    (error) => error instanceof BridgeAgentChecklistNotApprovedError && error.details.status === 'retired',
  )
  // retired is terminal: no re-approve.
  await assert.rejects(
    () => store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' }),
    (error) => error instanceof BridgeAgentChecklistConflictError,
  )
}

async function testAuditRowPerTransition() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })
  await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_2' }) // reuse
  await store.approve({ ...SCOPE, id: saved.id, actor: 'approver_1' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'approver_1' })

  const audit = await store.listAudit({ ...SCOPE, checklistId: saved.id })
  assert.equal(audit.length, 4)
  assert.deepEqual(
    audit.map((entry) => entry.action).sort(),
    ['reuse_version', 'save_version', 'status_change', 'status_change'],
  )
  // Audit is VALUES-FREE: no checklist content (object/field-key names) appears anywhere.
  const text = JSON.stringify(db.tables[AUDIT_TABLE])
  for (const leak of Object.values(DISTINCTIVE)) {
    assert.ok(!text.includes(leak), `audit trail must not contain checklist content: ${leak}`)
  }
  // Also: no op literal / operations key rides into audit detail.
  for (const leak of ['add_readonly_object', 'add_readonly_field', 'operations', 'fieldKeys']) {
    assert.ok(!text.includes(leak), `audit trail must not contain checklist structure: ${leak}`)
  }
  const statusChange = audit.find((entry) => entry.detail && entry.detail.to === 'approved')
  assert.deepEqual({ ...statusChange.detail }, { from: 'draft', to: 'approved' })
}

async function testRetiredContentReuseFailsClosed() {
  const { db, store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })
  await store.approve({ ...SCOPE, id: saved.id, actor: 'op_1' })
  await store.retire({ ...SCOPE, id: saved.id, actor: 'op_1' })
  const auditCountBefore = db.tables[AUDIT_TABLE].length
  await assert.rejects(
    () => store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' }),
    (error) => {
      assert.ok(error instanceof BridgeAgentChecklistConflictError)
      assert.equal(error.details.reason, 'content_retired')
      return true
    },
  )
  assert.equal(db.tables[AUDIT_TABLE].length, auditCountBefore, 'retired-content conflict appends no audit row')
  assert.equal(db.tables[CHECKLIST_TABLE].length, 1, 'no new row minted')
}

async function testScopingAndNotFound() {
  const { store } = newStore()
  const saved = await store.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op_1' })
  await assert.rejects(
    () => store.get({ tenantId: 'tenant_2', workspaceId: 'workspace_1', id: saved.id }),
    (error) => error instanceof BridgeAgentChecklistNotFoundError,
  )
  await assert.rejects(
    () => store.get({ ...SCOPE, id: 'missing' }),
    (error) => error instanceof BridgeAgentChecklistNotFoundError,
  )
  await assert.rejects(
    () => store.getForApply({ tenantId: 'tenant_2', workspaceId: 'workspace_1', id: saved.id }),
    (error) => error instanceof BridgeAgentChecklistNotFoundError,
  )
  const listed = await store.list({ ...SCOPE })
  assert.equal(listed.length, 1)
  const other = await store.list({ tenantId: 'tenant_2', workspaceId: 'workspace_1' })
  assert.equal(other.length, 0, 'list is tenant-scoped')
  // status filter is enum-strict.
  await assert.rejects(
    () => store.list({ ...SCOPE, status: 'everything' }),
    (error) => error instanceof BridgeAgentChecklistValidationError,
  )
}

async function testUniqueViolationRouting() {
  const CONTENT_CONSTRAINT = 'uniq_integration_bridge_agent_checklists_content'
  const VERSION_CONSTRAINT = 'uniq_integration_bridge_agent_checklists_family_version'

  function raceDb({ constraint, failures = 1, winnerRowAfterFailure = null }) {
    const base = createMockDb()
    let remainingFailures = failures
    let insertsBlocked = failures
    const wrapped = {
      ...base,
      tables: base.tables,
      calls: base.calls,
      async selectOne(table, where) {
        if (winnerRowAfterFailure && table === CHECKLIST_TABLE && insertsBlocked > 0) return null
        if (winnerRowAfterFailure && table === CHECKLIST_TABLE && insertsBlocked === 0 && base.tables[CHECKLIST_TABLE].length === 0) {
          base.tables[CHECKLIST_TABLE].push(winnerRowAfterFailure)
        }
        return base.selectOne(table, where)
      },
      async insertOne(table, row) {
        if (table === CHECKLIST_TABLE && remainingFailures > 0) {
          remainingFailures -= 1
          insertsBlocked -= 1
          const error = new Error('duplicate key value violates unique constraint')
          error.code = '23505'
          error.constraint = constraint
          throw error
        }
        return base.insertOne(table, row)
      },
      async transaction(callback) {
        base.calls.push(['transaction'])
        return callback(wrapped)
      },
    }
    return wrapped
  }

  // (a) content-key violation → reuse the winner's row.
  const winnerRow = {
    id: 'bac_winner',
    tenant_id: 'tenant_1',
    workspace_id: 'workspace_1',
    checklist: { schemaVersion: 1, operations: [] },
    content_key: __internals.contentKeyFor({ schemaVersion: 1, operations: [{ op: 'add_readonly_object', objectName: DISTINCTIVE.objectName, fieldKeys: [] }, { op: 'add_readonly_field', objectName: 'bom_child', fieldKeys: [DISTINCTIVE.fieldKey] }] }),
    version: 1,
    status: 'draft',
    created_at: 'x',
    updated_at: 'x',
  }
  const contentDb = raceDb({ constraint: CONTENT_CONSTRAINT, failures: 1, winnerRowAfterFailure: winnerRow })
  const contentStore = createBridgeAgentChecklistStore({ db: contentDb, idGenerator: () => 'id_x' })
  const reused = await contentStore.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op' })
  assert.equal(reused.reused, true)
  assert.equal(reused.id, 'bac_winner')
  assert.equal(contentDb.tables[CHECKLIST_TABLE].length, 1)

  // (b) transient version violation → retry mints successfully.
  const transientDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 1 })
  const transientStore = createBridgeAgentChecklistStore({ db: transientDb, idGenerator: () => 'id_y' })
  const minted = await transientStore.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op' })
  assert.equal(minted.reused, false)
  assert.equal(minted.version, 1)

  // (c) persistent version violation → bounded retry then typed Conflict.
  const persistentDb = raceDb({ constraint: VERSION_CONSTRAINT, failures: 99 })
  const persistentStore = createBridgeAgentChecklistStore({ db: persistentDb, idGenerator: () => 'id_z' })
  await assert.rejects(
    () => persistentStore.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op' }),
    (error) => error instanceof BridgeAgentChecklistConflictError && error.details.reason === 'mint_conflict',
  )

  // (d) an unrelated 23505 is NOT swallowed.
  const foreignDb = raceDb({ constraint: 'some_other_constraint', failures: 1 })
  const foreignStore = createBridgeAgentChecklistStore({ db: foreignDb, idGenerator: () => 'id_w' })
  await assert.rejects(
    () => foreignStore.saveVersion({ ...SCOPE, checklist: validChecklist(), actor: 'op' }),
    (error) => error.code === '23505' && error.constraint === 'some_other_constraint',
  )
}

async function testContentKeyHelperIsStable() {
  const key1 = __internals.contentKeyFor({ b: 2, a: [1, { d: 4, c: 3 }] })
  const key2 = __internals.contentKeyFor({ a: [1, { c: 3, d: 4 }], b: 2 })
  assert.equal(key1, key2, 'content key is key-order independent')
  assert.notEqual(key1, __internals.contentKeyFor({ a: [1, { c: 3, d: 4 }], b: 3 }))
}

async function testStoreRequiresTransactionDb() {
  assert.throws(() => createBridgeAgentChecklistStore({ db: {} }), /scoped db helper/)
}

async function main() {
  await testInvalidChecklistRejectedValuesFree()
  await testSaveStoresNormalizedAndMintsDraft()
  await testContentKeyIdempotency()
  await testStatusTransitionsFailClosed()
  await testAuditRowPerTransition()
  await testRetiredContentReuseFailsClosed()
  await testScopingAndNotFound()
  await testUniqueViolationRouting()
  await testContentKeyHelperIsStable()
  await testStoreRequiresTransactionDb()
  console.log('bridge-agent-change-checklist-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
