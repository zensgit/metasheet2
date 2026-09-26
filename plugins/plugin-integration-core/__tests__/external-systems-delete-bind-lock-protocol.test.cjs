'use strict'

// External-system delete × pointer write — the LOCK PROTOCOL, exercised against a simulated row-lock
// manager (this file) and against real PostgreSQL
// (`packages/core-backend/tests/integration/external-system-delete-bind-lock-protocol.db.test.ts`).
//
// THE HOLE (owner review of #5923, `docs/development/autonomous-run-20260921-outcome.md`
// "Q2/#5923（订正）"): `deleteExternalSystem` counted the pointer tables and then deleted, with no
// transaction and no row lock between the two. A pointer committed between count and DELETE dangled,
// and these tables deliberately carry no foreign key. "Making the delete transactional is not enough;
// the writers must participate in a lock protocol."
//
// THE PROTOCOL (`lib/external-system-pointer-lock.cjs`): delete = ONE transaction whose FIRST
// statement is `SELECT ... FOR UPDATE` on the system row, THEN the counts, THEN the DELETE. Every
// pointer writer takes `SELECT ... FOR KEY SHARE` on that row INSIDE its own write transaction BEFORE
// touching the pointer row, and refuses in its own values-free shape when the row is gone.
//
// WHAT THIS FILE PROVES, with an in-memory db whose `selectOneForUpdate` / `selectOneForKeyShare` /
// `deleteRows` implement PostgreSQL's row-lock conflict table (KEY SHARE vs FOR UPDATE conflict;
// KEY SHARE vs KEY SHARE do not; a DELETE takes the exclusive row lock) and whose transactions buffer
// writes until COMMIT:
//   L-01..L-03  079 stock-prep source binding (insert AND rebind), both interleavings
//   L-04..L-05  062 read-source config version mint, both interleavings
//   L-06..L-08  pipelines (source endpoint, target endpoint), both interleavings
//   L-09        template instantiation shares writePipelineRow (structural pin, path proven by L-06)
//   L-10        lock-order / values-free pins on the call logs (system row FIRST, tenant+id ONLY)
//   R-073       the REGISTERED RESIDUAL: sealed-export 073 provisioning (frozen S6-A module, runs as
//               a role with no privilege on integration_external_systems) does NOT participate; the
//               dangle is asserted so the day it is fixed this registration must be retired with it
//   M-D1        mutation: delete side without FOR UPDATE            -> L-01's interleaving dangles
//   M-W079      mutation: 079 writer with an unlocked read         -> dangles
//   M-W062      mutation: 062 writer with an unlocked read         -> dangles
//   M-WPIPE     mutation: pipeline endpoint check with plain SELECT -> dangles
// The mutations are in-memory (source text -> `_compile`), the working-tree files are never written.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const { createExternalSystemRegistry } = require('../lib/external-systems.cjs')
const {
  createStockPreparationSourceBindingStore,
  SOURCE_NOT_LIVE_CODE,
  BINDING_TABLE: STOCK_PREP_BINDING_TABLE,
} = require('../lib/stock-preparation-source-binding-store.cjs')
const {
  createReadSourceConfigStore,
  SYSTEM_NOT_FOUND_CODE,
} = require('../lib/read-source-config-store.cjs')
const { createPipelineRegistry } = require('../lib/pipelines.cjs')
const {
  createSealedExportLifecycleProvisioning,
} = require('../lib/sealed-export/sealed-export-lifecycle-provisioning.cjs')
const { createEd25519SignerMaterial } = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const { EXTERNAL_SYSTEMS_TABLE } = require('../lib/external-system-pointer-lock.cjs')

const READ_SOURCE_CONFIG_TABLE = 'integration_read_source_configs'
const READ_SOURCE_AUDIT_TABLE = 'integration_read_source_config_audit'
const PIPELINES_TABLE = 'integration_pipelines'
const SEALED_EXPORT_BINDING_TABLE = 'integration_sealed_export_stock_prep_bindings'
const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const NOW = Date.parse('2026-07-31T00:00:00Z')

const LIB = path.resolve(__dirname, '..', 'lib')
const MODULES = {
  externalSystems: path.join(LIB, 'external-systems.cjs'),
  stockPrepBindingStore: path.join(LIB, 'stock-preparation-source-binding-store.cjs'),
  readSourceConfigStore: path.join(LIB, 'read-source-config-store.cjs'),
  pipelines: path.join(LIB, 'pipelines.cjs'),
  integrationTemplates: path.join(LIB, 'integration-templates.cjs'),
}

// ---------------------------------------------------------------------------------------------------
// A scoped-db fake with a ROW-LOCK MANAGER and buffered transactions.
//
//   * Reads (selectOne / select / countRows) see COMMITTED rows only, no locks (READ COMMITTED).
//   * selectOneForUpdate: waits while another tx holds the exclusive lock OR any KEY SHARE on that
//     row; then holds the exclusive lock. Re-finds the row after every wait (a row deleted by the
//     tx it waited on reads as absent — PostgreSQL's EvalPlanQual re-check).
//   * selectOneForKeyShare: waits while another tx holds the exclusive lock; KEY SHARE holders do
//     not block each other. Re-finds after every wait.
//   * deleteRows: takes the exclusive lock on every matching row (a DELETE statement does), then
//     buffers the delete.
//   * insertOne / insertMany / updateRow: buffered; applied at COMMIT; dropped on ROLLBACK.
//   * Every lock is released at COMMIT / ROLLBACK.
//   * `gateBefore(op, table)`: the next such statement (any tx) parks until `release()`; `reached`
//     resolves when it parks. This is how the interleavings are scheduled deterministically.
//   * `waitUntilBlocked()`: resolves `true` once some tx is parked on a LOCK (not a gate), `false`
//     after a bounded number of turns with nobody blocked — which is what a mutant that skipped its
//     lock looks like.
// ---------------------------------------------------------------------------------------------------
function createLockingDb() {
  const committed = new Map()
  const locks = new Map() // rowKey -> { exclusive: txId | null, keyShare: Set<txId> }
  const calls = [] // { tx, op, table, where }
  const gates = new Map() // `${op}:${table}` -> { open: Promise, release, arrived }
  const blocked = new Set()
  let lockWaiters = []
  let txSeq = 0

  function rowsOf(table) {
    if (!committed.has(table)) committed.set(table, [])
    return committed.get(table)
  }
  function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  function rowKey(table, row) {
    return `${table}:${row.id ?? row.binding_id ?? JSON.stringify(row)}`
  }
  function lockOf(key) {
    if (!locks.has(key)) locks.set(key, { exclusive: null, keyShare: new Set() })
    return locks.get(key)
  }
  function notifyLocks() {
    const waiters = lockWaiters
    lockWaiters = []
    for (const resolve of waiters) resolve()
  }
  function waitForLockChange(txId) {
    blocked.add(txId)
    return new Promise((resolve) => lockWaiters.push(() => { blocked.delete(txId); resolve() }))
  }
  async function gate(op, table) {
    const key = `${op}:${table}`
    const pending = gates.get(key)
    if (!pending) return
    gates.delete(key)
    pending.arrived()
    await pending.open
  }
  function releaseLocks(txId) {
    for (const lock of locks.values()) {
      if (lock.exclusive === txId) lock.exclusive = null
      lock.keyShare.delete(txId)
    }
    notifyLocks()
  }

  function handle(txId, buffer) {
    const autocommit = txId === null
    function record(op, table, where) {
      calls.push({ tx: txId, op, table, where: where ? { ...where } : undefined })
    }
    async function acquire(table, where, mode) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const row = rowsOf(table).find((candidate) => matches(candidate, where))
        if (!row) return null
        const lock = lockOf(rowKey(table, row))
        const othersKeyShare = [...lock.keyShare].some((holder) => holder !== txId)
        const otherExclusive = lock.exclusive !== null && lock.exclusive !== txId
        const conflict = mode === 'exclusive' ? (otherExclusive || othersKeyShare) : otherExclusive
        if (!conflict) {
          if (mode === 'exclusive') lock.exclusive = txId
          else lock.keyShare.add(txId)
          return { ...row }
        }
        if (autocommit) throw new Error('lock wait in autocommit is not modelled')
        await waitForLockChange(txId)
      }
    }
    return {
      async selectOne(table, where) {
        record('selectOne', table, where)
        const row = rowsOf(table).find((candidate) => matches(candidate, where))
        return row ? { ...row } : null
      },
      async select(table, options = {}) {
        record('select', table, options.where)
        const filtered = rowsOf(table).filter((row) => matches(row, options.where || {}))
        const offset = options.offset || 0
        return filtered.slice(offset, offset + (options.limit || 1000)).map((row) => ({ ...row }))
      },
      async countRows(table, where) {
        record('countRows', table, where)
        return rowsOf(table).filter((row) => matches(row, where)).length
      },
      async selectOneForUpdate(table, where) {
        record('selectOneForUpdate', table, where)
        return acquire(table, where, 'exclusive')
      },
      async selectOneForKeyShare(table, where) {
        record('selectOneForKeyShare', table, where)
        return acquire(table, where, 'keyShare')
      },
      async insertOne(table, row) {
        record('insertOne', table)
        await gate('insertOne', table)
        const stored = { created_at: '2026-09-25T00:00:00.000Z', updated_at: '2026-09-25T00:00:00.000Z', ...row }
        if (autocommit) rowsOf(table).push(stored)
        else buffer.push(() => rowsOf(table).push(stored))
        return [{ ...stored }]
      },
      async insertMany(table, rows) {
        record('insertMany', table)
        const stored = rows.map((row) => ({ ...row }))
        if (autocommit) rowsOf(table).push(...stored)
        else buffer.push(() => rowsOf(table).push(...stored))
        return stored.map((row) => ({ ...row }))
      },
      async updateRow(table, set, where) {
        record('updateRow', table, where)
        const target = rowsOf(table).find((row) => matches(row, where))
        if (!target) return []
        const merged = { ...target, ...set }
        if (autocommit) Object.assign(target, set)
        else buffer.push(() => Object.assign(target, set))
        return [merged]
      },
      async deleteRows(table, where) {
        record('deleteRows', table, where)
        await gate('deleteRows', table)
        const victims = []
        for (const row of rowsOf(table).filter((candidate) => matches(candidate, where))) {
          const locked = await acquire(table, { id: row.id }, 'exclusive')
          if (locked) victims.push(locked.id)
        }
        const apply = () => {
          const rows = rowsOf(table)
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (victims.includes(rows[index].id)) rows.splice(index, 1)
          }
        }
        if (autocommit) apply()
        else buffer.push(apply)
        return victims.map((id) => ({ id }))
      },
      async transaction(callback) {
        if (!autocommit) throw new Error('nested transaction is not modelled')
        const id = ++txSeq
        const writes = []
        calls.push({ tx: id, op: 'BEGIN' })
        try {
          const result = await callback(handle(id, writes))
          for (const write of writes) write()
          calls.push({ tx: id, op: 'COMMIT' })
          return result
        } catch (error) {
          calls.push({ tx: id, op: 'ROLLBACK' })
          throw error
        } finally {
          releaseLocks(id)
        }
      },
    }
  }

  const root = handle(null, null)
  return Object.assign(root, {
    calls,
    rows(table) { return rowsOf(table).map((row) => ({ ...row })) },
    seed(table, rows) { rowsOf(table).push(...rows.map((row) => ({ ...row }))) },
    gateBefore(op, table) {
      let arrived
      let release
      const reached = new Promise((resolve) => { arrived = resolve })
      const open = new Promise((resolve) => { release = resolve })
      gates.set(`${op}:${table}`, { open, release, arrived })
      return { reached, release }
    },
    async waitUntilBlocked(turns = 200) {
      for (let turn = 0; turn < turns; turn += 1) {
        if (blocked.size > 0) return true
        await new Promise((resolve) => setImmediate(resolve))
      }
      return false
    },
    txCalls(txId) { return calls.filter((call) => call.tx === txId) },
  })
}

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------
function credentialStore() {
  return {
    async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value) { return `fp_${Buffer.from(value).toString('hex').slice(0, 8)}` },
  }
}

function systemRow(overrides = {}) {
  return {
    id: 'sys_1',
    tenant_id: 't1',
    workspace_id: null,
    project_id: null,
    name: 'plm-read',
    kind: 'erp:k3-wise-webapi',
    role: 'source',
    config: { baseUrl: 'https://plm.example.test' },
    credentials_encrypted: null,
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }
}

function readSourceConfig(overrides = {}) {
  return {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'single_record',
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FNumber',
    containerPaths: ['Data'],
    fieldMap: [{ source: 'FName', target: 'name' }],
    ...overrides,
  }
}

function sealedExportProvisionInput(publicKey) {
  const scope = {
    roleBindingFingerprint: '4'.repeat(64),
    systemContentKey: '3'.repeat(64),
    tenantDomainBinding: '2'.repeat(64),
    tenantId: 't1',
    workspaceId: null,
  }
  return {
    authority: {
      bindingExpiresAt: '2026-08-01T00:00:00Z',
      publicKey,
      qualificationDigest: '5'.repeat(64),
      qualificationExpiresAt: '2026-08-01T00:00:00Z',
      scope,
      signerExpiresAt: '2026-08-02T00:00:00Z',
    },
    binding: {
      approvedConfigVersionId: 'config-s6a-v1',
      bindingId: 'binding-s6a-v1',
      bindingVersion: 'binding-s6a-v1',
      canonicalObjectVersion: 'stock-preparation-bom.v1',
      configContentKey: '1'.repeat(64),
      expiresAt: '2026-08-01T00:00:00Z',
      externalSystemId: 'sys_1',
      objectKey: 'stock-preparation-bom',
      relationId: 'sqlserver.relation.rowid_payload.v1',
      roleBindingFingerprint: scope.roleBindingFingerprint,
      systemContentKey: scope.systemContentKey,
      tableRef: 'dbo.stock_prep_sealed_rows',
      tenantDomainBinding: scope.tenantDomainBinding,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    },
  }
}

function settle(promise) {
  return promise.then((value) => ({ value, error: null }), (error) => ({ value: null, error }))
}

function deleteInput() {
  return { tenantId: 't1', workspaceId: null, id: 'sys_1' }
}

function newRegistry(db, factory = createExternalSystemRegistry) {
  return factory({ db, credentialStore: credentialStore(), idGenerator: () => 'generated' })
}

// ---------------------------------------------------------------------------------------------------
// The two interleavings. Both return what each side got plus whether a lock wait was OBSERVED.
// ---------------------------------------------------------------------------------------------------

// Delete side runs first: it holds FOR UPDATE and has counted ZERO when the writer starts. This is
// exactly the owner's interleaving ("计数为零后、DELETE 前并发写入者提交一条指针").
async function deleteFirst({ db, registry, writer }) {
  const beforeDelete = db.gateBefore('deleteRows', EXTERNAL_SYSTEMS_TABLE)
  const deletion = settle(registry.deleteExternalSystem(deleteInput()))
  await beforeDelete.reached
  const write = settle(writer())
  const writerBlocked = await db.waitUntilBlocked()
  beforeDelete.release()
  const [deleted, written] = await Promise.all([deletion, write])
  return { deleted, written, writerBlocked }
}

// Writer runs first: it holds KEY SHARE and is about to INSERT its pointer when the delete starts.
async function writeFirst({ db, registry, writer, pointerTable }) {
  const beforeInsert = db.gateBefore('insertOne', pointerTable)
  const write = settle(writer())
  await beforeInsert.reached
  const deletion = settle(registry.deleteExternalSystem(deleteInput()))
  const deleterBlocked = await db.waitUntilBlocked()
  beforeInsert.release()
  const [written, deleted] = await Promise.all([write, deletion])
  return { deleted, written, deleterBlocked }
}

function assertNoDangle(db, pointerTable, pointerColumn) {
  const dangling = db.rows(pointerTable).filter((row) => row[pointerColumn] === 'sys_1')
  const systemPresent = db.rows(EXTERNAL_SYSTEMS_TABLE).some((row) => row.id === 'sys_1')
  assert.ok(
    systemPresent || dangling.length === 0,
    `${pointerTable}: ${dangling.length} pointer row(s) at a deleted system — the protocol did not hold`,
  )
  return { systemPresent, pointerRows: dangling.length }
}

// ---------------------------------------------------------------------------------------------------
// 079 — stock-prep source binding
// ---------------------------------------------------------------------------------------------------
function stockPrepWriter(db, factory = createStockPreparationSourceBindingStore) {
  const store = factory({ db, idGenerator: () => 'bind_1' })
  return () => store.set({ tenantId: 't1', workspaceId: null, actionId: ACTION_ID, externalSystemId: 'sys_1', actor: 'admin' })
}

async function testStockPrepDeleteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer: stockPrepWriter(db) })

  assert.equal(writerBlocked, true, 'L-01: the bind WAITED on the delete\'s FOR UPDATE')
  assert.equal(deleted.error, null, 'L-01: the delete, which counted zero, goes through')
  assert.equal(deleted.value.deleted, true)
  assert.ok(written.error, 'L-01: the bind that resumed after the delete committed is refused')
  assert.equal(written.error.name, 'StockPreparationSourceBindingStoreError')
  assert.equal(written.error.code, SOURCE_NOT_LIVE_CODE)
  assert.equal(written.error.status, 409)
  assert.equal(JSON.stringify(written.error.details).includes('sys_1'), false, 'L-01: refusal details never name the system')
  const outcome = assertNoDangle(db, STOCK_PREP_BINDING_TABLE, 'external_system_id')
  assert.deepEqual(outcome, { systemPresent: false, pointerRows: 0 }, 'L-01: system gone, no binding written')
  console.log('  L-01 079 bind after delete counted zero: bind waits, then refuses SOURCE_BINDING_SOURCE_NOT_LIVE; no dangle')
}

async function testStockPrepWriteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, deleterBlocked } = await writeFirst({
    db, registry, writer: stockPrepWriter(db), pointerTable: STOCK_PREP_BINDING_TABLE,
  })

  assert.equal(deleterBlocked, true, 'L-02: the delete WAITED on the bind\'s KEY SHARE')
  assert.equal(written.error, null, 'L-02: the bind that held the lock lands')
  assert.equal(written.value.binding.externalSystemId, 'sys_1')
  assert.ok(deleted.error, 'L-02: the delete that resumed after the bind committed is refused')
  assert.equal(deleted.error.name, 'ExternalSystemConflictError')
  assert.equal(deleted.error.details.stockPrepSourceBindingCount, 1, 'L-02: the count taken under the lock sees the bind')
  assert.equal(deleted.error.details.referencedBindingCount, 1)
  const outcome = assertNoDangle(db, STOCK_PREP_BINDING_TABLE, 'external_system_id')
  assert.deepEqual(outcome, { systemPresent: true, pointerRows: 1 }, 'L-02: system kept, binding kept')
  console.log('  L-02 079 delete after bind holds KEY SHARE: delete waits, then 409 with the bind counted; no dangle')
}

async function testStockPrepRebindDeleteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow(), systemRow({ id: 'sys_0', name: 'old' })])
  db.seed(STOCK_PREP_BINDING_TABLE, [{
    id: 'bind_0', tenant_id: 't1', workspace_id: null, action_id: ACTION_ID, external_system_id: 'sys_0', updated_by: 'admin',
  }])
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer: stockPrepWriter(db) })

  assert.equal(writerBlocked, true, 'L-03: the REBIND (update path) waited on the delete too')
  assert.equal(deleted.error, null)
  assert.equal(written.error && written.error.code, SOURCE_NOT_LIVE_CODE, 'L-03: the rebind is refused')
  const [binding] = db.rows(STOCK_PREP_BINDING_TABLE)
  assert.equal(binding.external_system_id, 'sys_0', 'L-03: the existing binding still points at the old, live system')
  console.log('  L-03 079 rebind (update path) is locked the same way as a first bind')
}

// ---------------------------------------------------------------------------------------------------
// 062 — read-source config version mint
// ---------------------------------------------------------------------------------------------------
function readSourceWriter(db, factory = createReadSourceConfigStore) {
  let seq = 0
  const store = factory({ db, idGenerator: () => `rsc_${++seq}` })
  return () => store.saveVersion({ tenantId: 't1', workspaceId: null, actor: 'consultant', config: readSourceConfig() })
}

async function testReadSourceDeleteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer: readSourceWriter(db) })

  assert.equal(writerBlocked, true, 'L-04: the mint WAITED on the delete\'s FOR UPDATE')
  assert.equal(deleted.error, null)
  assert.ok(written.error, 'L-04: the mint that resumed after the delete committed is refused')
  assert.equal(written.error.name, 'ReadSourceConfigValidationError')
  assert.deepEqual(written.error.details.errors, [{ code: SYSTEM_NOT_FOUND_CODE, field: 'systemId', reason: 'not_found' }],
    'L-04: refused as the S1-shaped values-free tuple')
  assert.equal(db.rows(READ_SOURCE_CONFIG_TABLE).length, 0, 'L-04: no version row minted')
  assert.equal(db.rows(READ_SOURCE_AUDIT_TABLE).length, 0, 'L-04: no audit row either — the transaction rolled back whole')
  assertNoDangle(db, READ_SOURCE_CONFIG_TABLE, 'system_id')
  console.log('  L-04 062 mint after delete counted zero: mint waits, then refuses READ_SOURCE_SYSTEM_NOT_FOUND; no dangle')
}

async function testReadSourceWriteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, deleterBlocked } = await writeFirst({
    db, registry, writer: readSourceWriter(db), pointerTable: READ_SOURCE_CONFIG_TABLE,
  })

  assert.equal(deleterBlocked, true, 'L-05: the delete WAITED on the mint\'s KEY SHARE')
  assert.equal(written.error, null, 'L-05: the mint lands')
  assert.equal(written.value.status, 'draft')
  assert.equal(deleted.error && deleted.error.name, 'ExternalSystemConflictError', 'L-05: the delete is refused')
  assert.equal(deleted.error.details.readSourceConfigCount, 1, 'L-05: the draft is counted under the lock')
  assert.deepEqual(assertNoDangle(db, READ_SOURCE_CONFIG_TABLE, 'system_id'), { systemPresent: true, pointerRows: 1 })
  console.log('  L-05 062 delete after mint holds KEY SHARE: delete waits, then 409 with the draft counted; no dangle')
}

// ---------------------------------------------------------------------------------------------------
// integration_pipelines — source and target endpoints
// ---------------------------------------------------------------------------------------------------
function pipelineWriter(db, factory = createPipelineRegistry, { sourceSystemId = 'sys_1', targetSystemId = 'sys_target' } = {}) {
  const pipelines = factory({ db, idGenerator: () => 'pipe_1' })
  return () => pipelines.upsertPipeline({
    tenantId: 't1', workspaceId: null, name: 'material sync',
    sourceSystemId, sourceObject: 'materials', targetSystemId, targetObject: 't_material',
  })
}

function seedPipelineSystems(db) {
  db.seed(EXTERNAL_SYSTEMS_TABLE, [
    systemRow(),
    systemRow({ id: 'sys_target', name: 'k3', role: 'target' }),
  ])
}

async function testPipelineSourceDeleteFirst() {
  const db = createLockingDb()
  seedPipelineSystems(db)
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer: pipelineWriter(db) })

  assert.equal(writerBlocked, true, 'L-06: the pipeline write WAITED on the delete\'s FOR UPDATE')
  assert.equal(deleted.error, null)
  assert.ok(written.error, 'L-06: the pipeline write that resumed after the delete committed is refused')
  assert.equal(written.error.name, 'PipelineValidationError', 'L-06: as the values-free validation error the path always raised')
  assert.equal(written.error.message, 'sourceSystemId does not exist in this tenant/workspace')
  assert.equal(db.rows(PIPELINES_TABLE).length, 0, 'L-06: no pipeline row')
  assertNoDangle(db, PIPELINES_TABLE, 'source_system_id')
  console.log('  L-06 pipeline (source endpoint) after delete counted zero: write waits, then PipelineValidationError; no dangle')
}

async function testPipelineTargetDeleteFirst() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [
    systemRow({ id: 'sys_source', name: 'plm', role: 'source' }),
    systemRow({ role: 'target', name: 'k3' }), // sys_1 is the TARGET this time
  ])
  const registry = newRegistry(db)
  const writer = pipelineWriter(db, createPipelineRegistry, { sourceSystemId: 'sys_source', targetSystemId: 'sys_1' })
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer })

  assert.equal(writerBlocked, true, 'L-07: the SECOND endpoint lock (target) waited too')
  assert.equal(deleted.error, null)
  assert.equal(written.error && written.error.message, 'targetSystemId does not exist in this tenant/workspace', 'L-07')
  assert.equal(db.rows(PIPELINES_TABLE).length, 0)
  console.log('  L-07 pipeline (target endpoint) is locked the same way as the source endpoint')
}

async function testPipelineWriteFirst() {
  const db = createLockingDb()
  seedPipelineSystems(db)
  const registry = newRegistry(db)
  const { deleted, written, deleterBlocked } = await writeFirst({
    db, registry, writer: pipelineWriter(db), pointerTable: PIPELINES_TABLE,
  })

  assert.equal(deleterBlocked, true, 'L-08: the delete WAITED on the pipeline write\'s KEY SHARE')
  assert.equal(written.error, null, 'L-08: the pipeline lands')
  assert.equal(deleted.error && deleted.error.name, 'ExternalSystemConflictError')
  assert.equal(deleted.error.message, 'external system is used by pipelines', 'L-08: the on-wire pipeline wording is unchanged')
  assert.equal(deleted.error.details.sourcePipelineCount, 1)
  assert.deepEqual(assertNoDangle(db, PIPELINES_TABLE, 'source_system_id'), { systemPresent: true, pointerRows: 1 })
  console.log('  L-08 pipeline delete after write holds KEY SHARE: delete waits, then 409 with the pipeline counted; no dangle')
}

// Template instantiation writes its pipeline through the SAME `writePipelineRow` inside
// `db.transaction` (integration-templates.cjs instantiateTemplate step 6), so L-06/L-07/L-08 are its
// proof too. Pinned structurally so a later rewrite that bypasses writePipelineRow — or lifts it out
// of the transaction — flips this, not silently the coverage claim.
function testTemplateInstantiationSharesThePath() {
  const source = fs.readFileSync(MODULES.integrationTemplates, 'utf8').replace(/\r\n/g, '\n')
  const transactionStart = source.indexOf('return db.transaction(async (scopedDb) => {')
  const writeCall = source.indexOf('return writePipelineRow(scopedDb, normalized, idGenerator)')
  assert.ok(transactionStart > 0 && writeCall > transactionStart,
    'L-09: instantiateTemplate writes its pipeline through writePipelineRow INSIDE db.transaction')
  const pipelinesSource = fs.readFileSync(MODULES.pipelines, 'utf8').replace(/\r\n/g, '\n')
  assert.ok(pipelinesSource.includes('const row = await db.selectOneForKeyShare(EXTERNAL_SYSTEMS_TABLE, {'),
    'L-09: writePipelineRow\'s endpoint check is the KEY SHARE read')
  console.log('  L-09 template instantiation shares writePipelineRow inside db.transaction (structural pin)')
}

// ---------------------------------------------------------------------------------------------------
// Lock order and values-free scope — read off the call logs of L-01-style runs.
// ---------------------------------------------------------------------------------------------------
async function testLockOrderAndScopePins() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  await deleteFirst({ db, registry, writer: stockPrepWriter(db) })

  const begins = db.calls.filter((call) => call.op === 'BEGIN').map((call) => call.tx)
  assert.equal(begins.length, 2, 'L-10: exactly one delete transaction and one bind transaction')
  const [deleteTx, bindTx] = begins
  const deleteOps = db.txCalls(deleteTx).filter((call) => call.op !== 'BEGIN' && call.op !== 'COMMIT' && call.op !== 'ROLLBACK')
  assert.equal(deleteOps[0].op, 'selectOneForUpdate', 'L-10: the delete transaction\'s FIRST statement is the FOR UPDATE')
  assert.equal(deleteOps[0].table, EXTERNAL_SYSTEMS_TABLE)
  const countOps = deleteOps.filter((call) => call.op === 'countRows')
  assert.equal(countOps.length, 6, 'L-10: pipelines ×2 + 079 + 073 + 062 ×2 are all counted INSIDE the transaction')
  assert.equal(deleteOps[deleteOps.length - 1].op, 'deleteRows', 'L-10: the DELETE is the last statement')
  assert.ok(deleteOps.every((call) => call.op !== 'selectOneForUpdate' || call === deleteOps[0]),
    'L-10: the delete side takes exactly ONE row lock — it never locks a pointer row (no lock cycle is possible)')
  const probeCounts = db.calls.filter((call) => call.tx === null && call.op === 'countRows')
  assert.equal(probeCounts.length, 4, 'L-10: the 42P01 existence probe runs the 4 dependent counts in autocommit, before the transaction')

  const bindOps = db.txCalls(bindTx).filter((call) => call.op !== 'BEGIN' && call.op !== 'COMMIT' && call.op !== 'ROLLBACK')
  assert.equal(bindOps[0].op, 'selectOneForKeyShare', 'L-10: the bind transaction\'s FIRST statement is the KEY SHARE on the system row')
  assert.equal(bindOps[0].table, EXTERNAL_SYSTEMS_TABLE)
  assert.deepEqual(Object.keys(bindOps[0].where).sort(), ['id', 'tenant_id'],
    'L-10: the writer pins tenant + id ONLY — the delete guard\'s dependent-count scope; no workspace key')
  assert.equal(bindOps.length, 1, 'L-10: the refused bind issued nothing after the lock returned null')
  console.log('  L-10 lock order pinned: delete = FOR UPDATE → 6 counts → DELETE; writer = KEY SHARE(tenant,id) first')
}

// ---------------------------------------------------------------------------------------------------
// R-073 — the REGISTERED RESIDUAL, asserted so it cannot silently drift.
//
// `sealed-export-lifecycle-provisioning.cjs` is a FROZEN S6-A module (pinned in
// s6a-package-provenance-pins.json, never re-pinned since #4694) and its writer runs as the
// provisioning role, which migrations 073/074/075 grant NOTHING on integration_external_systems —
// and PostgreSQL requires UPDATE privilege on some column for any locking clause. Making it
// participate needs either a grant migration + frozen re-pin, or a NOT VALID foreign key on a
// generated live-pointer column (the #5784 `live_id` shape) — both DDL, both owner-gated. Until then
// the 073 writer takes no lock and the delete-first interleaving DANGLES. This test asserts that
// dangle: fixing 073 must retire this arm together with the design doc's residual entry.
// ---------------------------------------------------------------------------------------------------
async function testSealedExportResidualTripwire() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const material = createEd25519SignerMaterial()
  const provisioning = createSealedExportLifecycleProvisioning({ db, clock: () => NOW })
  const writer = () => provisioning.provisionInitialStockPreparationBinding(sealedExportProvisionInput(material.publicKey))
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer })

  assert.equal(writerBlocked, false, 'R-073: the frozen 073 writer takes NO lock on the system row (residual, not a regression)')
  assert.equal(written.error, null, 'R-073: provisioning lands')
  assert.equal(deleted.error, null, 'R-073: and the delete that counted zero lands too')
  const dangling = db.rows(SEALED_EXPORT_BINDING_TABLE).filter((row) => row.external_system_id === 'sys_1' && row.status === 'ACTIVE')
  assert.equal(dangling.length, 1, 'R-073: one ACTIVE sealed-export binding now points at a deleted system — the registered residual')
  assert.equal(db.rows(EXTERNAL_SYSTEMS_TABLE).length, 0)
  console.log('  R-073 sealed-export provisioning (frozen S6-A, provisioning role) still dangles — registered residual, asserted')
}

// ---------------------------------------------------------------------------------------------------
// Mutations (in-memory). Each removes ONE lock and shows the corresponding interleaving dangles.
// ---------------------------------------------------------------------------------------------------
function compileMutant(modulePath, replacements, label) {
  const source = fs.readFileSync(modulePath, 'utf8').replace(/\r\n/g, '\n')
  let patched = source
  for (const [from, to] of replacements) {
    assert.ok(patched.includes(from), `${label}: mutation anchor is missing, the mutation would be vacuous`)
    patched = patched.split(from).join(to)
  }
  assert.notEqual(patched, source, `${label}: mutation changed nothing`)
  const compiled = new Module(modulePath, null)
  compiled.filename = modulePath
  compiled.paths = Module._nodeModulePaths(path.dirname(modulePath))
  compiled._compile(patched, modulePath)
  return compiled.exports
}

function assertDangle(db, pointerTable, pointerColumn, label) {
  const dangling = db.rows(pointerTable).filter((row) => row[pointerColumn] === 'sys_1')
  assert.equal(db.rows(EXTERNAL_SYSTEMS_TABLE).some((row) => row.id === 'sys_1'), false, `${label}: the mutant let the delete through`)
  assert.equal(dangling.length, 1, `${label}: and the pointer landed — a dangling reference`)
}

async function testMutationDeleteSideWithoutForUpdate() {
  const mutant = compileMutant(MODULES.externalSystems, [
    ['const row = await trx.selectOneForUpdate(TABLE, where)', 'const row = await trx.selectOne(TABLE, where)'],
  ], 'M-D1')
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db, mutant.createExternalSystemRegistry)
  const { deleted, written, writerBlocked } = await deleteFirst({ db, registry, writer: stockPrepWriter(db) })
  assert.equal(writerBlocked, false, 'M-D1: with no FOR UPDATE the bind never waits')
  assert.equal(deleted.error, null)
  assert.equal(written.error, null, 'M-D1: the bind lands while the delete is between count and DELETE')
  assertDangle(db, STOCK_PREP_BINDING_TABLE, 'external_system_id', 'M-D1')
  console.log('  M-D1 delete side without FOR UPDATE: L-01\'s interleaving dangles (the lock is load-bearing)')
}

const UNLOCKED_READ = '(async ({ tenantId, id }) => trx.selectOne(\'integration_external_systems\', { tenant_id: tenantId, id }))({'

async function testMutationStockPrepWriterUnlocked() {
  const mutant = compileMutant(MODULES.stockPrepBindingStore, [
    ['const system = await lockExternalSystemForPointerWrite(trx, {', `const system = await ${UNLOCKED_READ}`],
  ], 'M-W079')
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({
    db, registry, writer: stockPrepWriter(db, mutant.createStockPreparationSourceBindingStore),
  })
  assert.equal(writerBlocked, false, 'M-W079: an unlocked read never waits on the delete')
  assert.equal(deleted.error, null)
  assert.equal(written.error, null, 'M-W079: the bind lands')
  assertDangle(db, STOCK_PREP_BINDING_TABLE, 'external_system_id', 'M-W079')
  console.log('  M-W079 079 writer with an unlocked read: dangles (the KEY SHARE is load-bearing)')
}

async function testMutationReadSourceWriterUnlocked() {
  const mutant = compileMutant(MODULES.readSourceConfigStore, [
    ['const system = await lockExternalSystemForPointerWrite(trx, {', `const system = await ${UNLOCKED_READ}`],
  ], 'M-W062')
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({
    db, registry, writer: readSourceWriter(db, mutant.createReadSourceConfigStore),
  })
  assert.equal(writerBlocked, false, 'M-W062')
  assert.equal(deleted.error, null)
  assert.equal(written.error, null, 'M-W062: the mint lands')
  assertDangle(db, READ_SOURCE_CONFIG_TABLE, 'system_id', 'M-W062')
  console.log('  M-W062 062 writer with an unlocked read: dangles (the KEY SHARE is load-bearing)')
}

async function testMutationPipelineWriterUnlocked() {
  const mutant = compileMutant(MODULES.pipelines, [
    ['const row = await db.selectOneForKeyShare(EXTERNAL_SYSTEMS_TABLE, {', 'const row = await db.selectOne(EXTERNAL_SYSTEMS_TABLE, {'],
  ], 'M-WPIPE')
  const db = createLockingDb()
  seedPipelineSystems(db)
  const registry = newRegistry(db)
  const { deleted, written, writerBlocked } = await deleteFirst({
    db, registry, writer: pipelineWriter(db, mutant.createPipelineRegistry),
  })
  assert.equal(writerBlocked, false, 'M-WPIPE')
  assert.equal(deleted.error, null)
  assert.equal(written.error, null, 'M-WPIPE: the pipeline lands')
  assertDangle(db, PIPELINES_TABLE, 'source_system_id', 'M-WPIPE')
  console.log('  M-WPIPE pipeline endpoint check with a plain SELECT: dangles (the KEY SHARE is load-bearing; the real FK is what saves this on PostgreSQL — see the real-DB suite)')
}

async function main() {
  await testStockPrepDeleteFirst()
  await testStockPrepWriteFirst()
  await testStockPrepRebindDeleteFirst()
  await testReadSourceDeleteFirst()
  await testReadSourceWriteFirst()
  await testPipelineSourceDeleteFirst()
  await testPipelineTargetDeleteFirst()
  await testPipelineWriteFirst()
  testTemplateInstantiationSharesThePath()
  await testLockOrderAndScopePins()
  await testSealedExportResidualTripwire()
  await testMutationDeleteSideWithoutForUpdate()
  await testMutationStockPrepWriterUnlocked()
  await testMutationReadSourceWriterUnlocked()
  await testMutationPipelineWriterUnlocked()
  // The genuine modules are untouched by the in-memory mutants: L-01 still refuses.
  await testStockPrepDeleteFirst()
  console.log('✓ external-systems delete × bind lock protocol: 079/062/pipelines participate; 073 residual asserted; 4 mutants dangle')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
