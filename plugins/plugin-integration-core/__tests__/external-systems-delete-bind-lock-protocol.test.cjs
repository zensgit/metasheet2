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
//   L-10        lock-order / values-free pins on the call logs for the 079 writer (system row FIRST;
//               the 079/062 writers, which go through lockExternalSystemForPointerWrite, pin
//               tenant + id ONLY)
//   L-11        SCOPE pins for the pipelines path, which does NOT go through that helper: the
//               pipeline writer's KEY SHARE carries tenant + workspace + id (its own scopeWhere), the
//               delete side's pipeline COUNT carries tenant + workspace + pointer column (the same
//               scope), and the 079/073/062 counts carry NO workspace key. A pipeline written under a
//               workspace hint cannot name a tenant-level system at all (refused before any write),
//               so the row it pins is still the one physical row the delete locks — or none.
//   FC-01..07   FAIL-CLOSED witnesses (a helper that cannot lock is REFUSED, never degraded to an
//               unlocked read): 079 / 062 constructors reject a db lacking ONLY selectOneForKeyShare;
//               lockExternalSystemForPointerWrite rejects an executor without it and never calls
//               selectOne; upsertPipeline rejects a db without transaction and a transaction handle
//               without selectOneForKeyShare; deleteExternalSystem rejects a db without transaction
//               and a transaction handle without selectOneForUpdate — each with nothing read or
//               written.
//   R-062-REUSE the REGISTERED reuse-path outcomes of saveVersion: the content-key reuse lookup runs
//               BEFORE the lock and does not consult the external system, so identical content that
//               already exists as a RETIRED version at a deleted system is refused 409
//               content_retired (not the 400 not_found tuple), and a pre-protocol LIVE row at a
//               system that no longer exists is reused (200, reuse_version audit) without a lock.
//               Only a mint (content not yet in the family) takes the lock. Asserted so the
//               guarantee stays scoped to the mint path; moving the existence check in front of the
//               reuse lookup is an externally visible behaviour change that is the owner's to make,
//               and whoever makes it must retire this arm with the design doc's entry.
//   R-073       the REGISTERED RESIDUAL: sealed-export 073 provisioning (frozen S6-A module, runs as
//               a role with no privilege on integration_external_systems) does NOT participate; the
//               dangle is asserted so the day it is fixed this registration must be retired with it
//   M-D1        mutation: delete side without FOR UPDATE            -> L-01's interleaving dangles
//   M-W079      mutation: 079 writer with an unlocked read         -> dangles
//   M-W062      mutation: 062 writer with an unlocked read         -> dangles
//   M-WPIPE     mutation: pipeline endpoint check with plain SELECT -> dangles
//   M-FC-*      mutations that DEGRADE a fail-closed guard to an unlocked read (lock helper, 079 and
//               062 constructors, pipeline endpoint check) -> the matching FC assertion flips
// The mutations are in-memory (source text -> `_compile`), the working-tree files are never written.
//
// The in-memory transaction handle models ONE PostgreSQL connection: statements run one at a time
// in issue order, and once a statement has failed the transaction is ABORTED — every later statement
// fails with SQLSTATE 25P02 until ROLLBACK. Without that, a 42P01 raised INSIDE the delete
// transaction would be swallowed by the count's tolerance and the delete would go through in memory
// while it fails 25P02 on PostgreSQL (the shape the real-DB suite's P-ABSENT pins, and
// external-systems-delete-dependent-references M-6 flips).

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
  contentKeyFor,
} = require('../lib/read-source-config-store.cjs')
const { validateReadSourceConfig } = require('../lib/read-source-config.cjs')
const { createPipelineRegistry } = require('../lib/pipelines.cjs')
const {
  createSealedExportLifecycleProvisioning,
} = require('../lib/sealed-export/sealed-export-lifecycle-provisioning.cjs')
const { createEd25519SignerMaterial } = require('../lib/sealed-export/sealed-export-signer-authority.cjs')
const { EXTERNAL_SYSTEMS_TABLE, lockExternalSystemForPointerWrite } = require('../lib/external-system-pointer-lock.cjs')

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
  pointerLock: path.join(LIB, 'external-system-pointer-lock.cjs'),
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
//   * A transaction handle is ONE connection: its statements run one at a time in issue order, and
//     after any statement throws the transaction is ABORTED — every later statement throws
//     `{ code: '25P02' }` until the transaction ends (PostgreSQL: "current transaction is aborted,
//     commands ignored until end of transaction block"). `failCountWith(table, error)` makes the
//     next COUNT of that table throw, on any handle.
// ---------------------------------------------------------------------------------------------------
function createLockingDb() {
  const committed = new Map()
  const locks = new Map() // rowKey -> { exclusive: txId | null, keyShare: Set<txId> }
  const calls = [] // { tx, op, table, where }
  const gates = new Map() // `${op}:${table}` -> { open: Promise, release, arrived }
  const countErrors = new Map()
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

  function handle(txId, buffer, txState = null) {
    const autocommit = txId === null
    function record(op, table, where) {
      calls.push({ tx: txId, op, table, where: where ? { ...where } : undefined })
    }
    // One connection per transaction: serialize, and abort on the first failure (25P02 after).
    function statement(run) {
      if (autocommit) return run()
      const next = txState.chain.then(async () => {
        if (txState.aborted) {
          throw Object.assign(new Error('错误: 当前事务被终止, 事务块结束之前的查询被忽略'), { code: '25P02' })
        }
        try {
          return await run()
        } catch (error) {
          txState.aborted = true
          throw error
        }
      })
      txState.chain = next.then(() => undefined, () => undefined)
      return next
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
      selectOne(table, where) {
        return statement(async () => {
          record('selectOne', table, where)
          const row = rowsOf(table).find((candidate) => matches(candidate, where))
          return row ? { ...row } : null
        })
      },
      select(table, options = {}) {
        return statement(async () => {
          record('select', table, options.where)
          const filtered = rowsOf(table).filter((row) => matches(row, options.where || {}))
          const offset = options.offset || 0
          return filtered.slice(offset, offset + (options.limit || 1000)).map((row) => ({ ...row }))
        })
      },
      countRows(table, where) {
        return statement(async () => {
          record('countRows', table, where)
          if (countErrors.has(table)) throw countErrors.get(table)
          return rowsOf(table).filter((row) => matches(row, where)).length
        })
      },
      selectOneForUpdate(table, where) {
        return statement(async () => {
          record('selectOneForUpdate', table, where)
          return acquire(table, where, 'exclusive')
        })
      },
      selectOneForKeyShare(table, where) {
        return statement(async () => {
          record('selectOneForKeyShare', table, where)
          return acquire(table, where, 'keyShare')
        })
      },
      insertOne(table, row) {
        return statement(async () => {
          record('insertOne', table)
          await gate('insertOne', table)
          const stored = { created_at: '2026-09-25T00:00:00.000Z', updated_at: '2026-09-25T00:00:00.000Z', ...row }
          if (autocommit) rowsOf(table).push(stored)
          else buffer.push(() => rowsOf(table).push(stored))
          return [{ ...stored }]
        })
      },
      insertMany(table, rows) {
        return statement(async () => {
          record('insertMany', table)
          const stored = rows.map((row) => ({ ...row }))
          if (autocommit) rowsOf(table).push(...stored)
          else buffer.push(() => rowsOf(table).push(...stored))
          return stored.map((row) => ({ ...row }))
        })
      },
      updateRow(table, set, where) {
        return statement(async () => {
          record('updateRow', table, where)
          const target = rowsOf(table).find((row) => matches(row, where))
          if (!target) return []
          const merged = { ...target, ...set }
          if (autocommit) Object.assign(target, set)
          else buffer.push(() => Object.assign(target, set))
          return [merged]
        })
      },
      deleteRows(table, where) {
        return statement(async () => {
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
        })
      },
      async transaction(callback) {
        if (!autocommit) throw new Error('nested transaction is not modelled')
        const id = ++txSeq
        const writes = []
        calls.push({ tx: id, op: 'BEGIN' })
        try {
          const result = await callback(handle(id, writes, { chain: Promise.resolve(), aborted: false }))
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
    failCountWith(table, error) { countErrors.set(table, error) },
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
    'L-10: the 079 writer (via lockExternalSystemForPointerWrite) pins tenant + id ONLY — the delete guard\'s dependent-count scope; no workspace key')
  assert.equal(bindOps.length, 1, 'L-10: the refused bind issued nothing after the lock returned null')
  console.log('  L-10 lock order pinned: delete = FOR UPDATE → 6 counts → DELETE; 079 writer = KEY SHARE(tenant,id) first')
}

// ---------------------------------------------------------------------------------------------------
// L-11 — SCOPE pins for the pipelines path. `pipelines.cjs` requireExternalSystem does NOT go through
// lockExternalSystemForPointerWrite: it takes KEY SHARE with the pipeline's OWN scope
// (`scopeWhere(normalized)` + id — tenant + workspace + id), and `countPipelineReferences` on the
// delete side is filtered by the same tenant + workspace (unlike the 079/073/062 counts, which carry
// no workspace key — see external-systems.cjs countDependentBindingReferences). The two are the SAME
// scope, and 057's FK backs the pairs outside it, so this is not a hole — but it is what the code
// does, and a guarantee that says "tenant + id only" for every writer is false. Pinned here so the
// wording and the code cannot drift apart again.
// ---------------------------------------------------------------------------------------------------
const opFilter = (call) => call.op !== 'BEGIN' && call.op !== 'COMMIT' && call.op !== 'ROLLBACK'

async function testPipelineScopePins() {
  const db = createLockingDb()
  seedPipelineSystems(db)
  const registry = newRegistry(db)
  await deleteFirst({ db, registry, writer: pipelineWriter(db) })

  const [deleteTx, writeTx] = db.calls.filter((call) => call.op === 'BEGIN').map((call) => call.tx)
  const writeOps = db.txCalls(writeTx).filter(opFilter)
  assert.equal(writeOps[0].op, 'selectOneForKeyShare', 'L-11: the pipeline transaction\'s FIRST statement is the KEY SHARE on the source system')
  assert.equal(writeOps[0].table, EXTERNAL_SYSTEMS_TABLE)
  assert.deepEqual(Object.keys(writeOps[0].where).sort(), ['id', 'tenant_id', 'workspace_id'],
    'L-11: the pipeline writer locks with ITS OWN scope — tenant + workspace + id — not the 079/062 writers\' tenant + id')

  const deleteCounts = db.txCalls(deleteTx).filter((call) => call.op === 'countRows')
  assert.deepEqual(
    deleteCounts.map((call) => [call.table, Object.keys(call.where).sort()]),
    [
      [PIPELINES_TABLE, ['source_system_id', 'tenant_id', 'workspace_id']],
      [PIPELINES_TABLE, ['target_system_id', 'tenant_id', 'workspace_id']],
      [STOCK_PREP_BINDING_TABLE, ['external_system_id', 'tenant_id']],
      [SEALED_EXPORT_BINDING_TABLE, ['external_system_id', 'status', 'tenant_id']],
      [READ_SOURCE_CONFIG_TABLE, ['status', 'system_id', 'tenant_id']],
      [READ_SOURCE_CONFIG_TABLE, ['status', 'system_id', 'tenant_id']],
    ],
    'L-11: the delete-side pipeline count IS workspace-filtered (the scope the pipeline writer locks with); 079/073/062 are NOT',
  )

  // Scope consistency, executed: a pipeline written under a workspace hint cannot name a tenant-level
  // (workspace NULL) system — refused before any write — while a 079 bind under the same hint lands,
  // because 079's lock (and count) is tenant + id.
  const scoped = createLockingDb()
  seedPipelineSystems(scoped)
  const pipelines = createPipelineRegistry({ db: scoped, idGenerator: () => 'pipe_ws' })
  const refused = await settle(pipelines.upsertPipeline({
    tenantId: 't1', workspaceId: 'ws_1', name: 'scoped', sourceSystemId: 'sys_1', sourceObject: 'materials', targetSystemId: 'sys_target', targetObject: 't_material',
  }))
  assert.equal(refused.error && refused.error.name, 'PipelineValidationError', 'L-11: a ws_1 pipeline naming a tenant-level system is refused')
  assert.equal(refused.error.message, 'sourceSystemId does not exist in this tenant/workspace')
  assert.equal(scoped.rows(PIPELINES_TABLE).length, 0, 'L-11: and nothing was written')
  const bound = await settle(createStockPreparationSourceBindingStore({ db: scoped, idGenerator: () => 'bind_ws' }).set({
    tenantId: 't1', workspaceId: 'ws_1', actionId: ACTION_ID, externalSystemId: 'sys_1', actor: 'admin',
  }))
  assert.equal(bound.error, null, 'L-11: a ws_1 079 bind at the same tenant-level system lands (tenant + id)')
  console.log('  L-11 scope pinned: pipelines lock/count = tenant+workspace+id (same scope, 057 FK behind it); 079/073/062 counts carry no workspace key')
}

// ---------------------------------------------------------------------------------------------------
// The fake's aborted-transaction semantics, asserted directly so the mutation arms that rely on them
// (dependent-references M-6) cannot go vacuous by a later "simplification" of this fake.
// ---------------------------------------------------------------------------------------------------
async function testFakeAbortsTransactionAfterAFailedStatement() {
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  db.failCountWith(STOCK_PREP_BINDING_TABLE, Object.assign(new Error('错误: 关系 "integration_stock_prep_source_binding" 不存在'), { code: '42P01' }))
  const outcome = await settle(db.transaction(async (trx) => {
    await assert.rejects(trx.countRows(STOCK_PREP_BINDING_TABLE, { tenant_id: 't1' }), (error) => error.code === '42P01')
    await assert.rejects(trx.selectOne(EXTERNAL_SYSTEMS_TABLE, { id: 'sys_1' }), (error) => error.code === '25P02',
      'F-25P02: after a failed statement every later statement in the SAME transaction fails 25P02')
    await assert.rejects(trx.deleteRows(EXTERNAL_SYSTEMS_TABLE, { id: 'sys_1' }), (error) => error.code === '25P02')
    return 'reached'
  }))
  assert.equal(outcome.error, null)
  assert.equal(db.rows(EXTERNAL_SYSTEMS_TABLE).length, 1, 'F-25P02: the aborted transaction wrote nothing')
  // Autocommit is unaffected: the same failing count in autocommit does not poison the next statement.
  await assert.rejects(db.countRows(STOCK_PREP_BINDING_TABLE, { tenant_id: 't1' }), (error) => error.code === '42P01')
  assert.ok(await db.selectOne(EXTERNAL_SYSTEMS_TABLE, { id: 'sys_1' }), 'F-25P02: autocommit statements are independent')
  console.log('  F-25P02 the fake aborts a transaction after a failed statement (25P02 until ROLLBACK); autocommit unaffected')
}

// ---------------------------------------------------------------------------------------------------
// FC-01..FC-07 — FAIL-CLOSED witnesses. Each guard is hit ALONE (every other method present), and the
// assertion is not only "it throws" but "it throws the protocol's refusal and issued no unlocked read
// and no write in its place". Before these, the constructor assertions elsewhere passed fakes that
// lacked `transaction` or `select` too, so the selectOneForKeyShare clause was never the one firing.
// ---------------------------------------------------------------------------------------------------
function without(object, ...names) {
  const copy = { ...object }
  for (const name of names) delete copy[name]
  return copy
}

function withTransactionHandleWithout(db, ...names) {
  return { ...db, transaction: (callback) => db.transaction((trx) => callback(without(trx, ...names))) }
}

function pipelineInput() {
  return { tenantId: 't1', workspaceId: null, name: 'material sync', sourceSystemId: 'sys_1', sourceObject: 'materials', targetSystemId: 'sys_target', targetObject: 't_material' }
}

const FAIL_CLOSED_RE = /\(external-system delete lock protocol\)/

async function testFailClosedGuards() {
  // FC-01 / FC-02: constructors, ONLY selectOneForKeyShare missing.
  const complete = createLockingDb()
  assert.throws(
    () => createStockPreparationSourceBindingStore({ db: without(complete, 'selectOneForKeyShare') }),
    /scoped db helper \(incl\. transaction, selectOneForKeyShare\) is required/,
    'FC-01: the 079 store refuses a db that lacks ONLY selectOneForKeyShare',
  )
  createStockPreparationSourceBindingStore({ db: complete })
  assert.throws(
    () => createReadSourceConfigStore({ db: without(complete, 'selectOneForKeyShare') }),
    /scoped db helper \(incl\. transaction, selectOneForKeyShare\) is required/,
    'FC-02: the 062 store refuses a db that lacks ONLY selectOneForKeyShare',
  )
  createReadSourceConfigStore({ db: complete })
  console.log('  FC-01/02 079 and 062 constructors refuse a db lacking only selectOneForKeyShare')

  // FC-03: the lock helper itself never degrades to selectOne.
  let unlockedReads = 0
  const executor = { async selectOne() { unlockedReads += 1; return systemRow() } }
  await assert.rejects(
    lockExternalSystemForPointerWrite(executor, { tenantId: 't1', id: 'sys_1' }),
    (error) => FAIL_CLOSED_RE.test(error.message) && /selectOneForKeyShare is required/.test(error.message),
    'FC-03: an executor without selectOneForKeyShare is refused',
  )
  await assert.rejects(lockExternalSystemForPointerWrite(null, { tenantId: 't1', id: 'sys_1' }), FAIL_CLOSED_RE)
  assert.equal(unlockedReads, 0, 'FC-03: and selectOne was NEVER called in its place')
  console.log('  FC-03 lockExternalSystemForPointerWrite refuses an executor without selectOneForKeyShare; selectOne untouched')

  // FC-04: upsertPipeline without db.transaction.
  const noTransaction = createLockingDb()
  seedPipelineSystems(noTransaction)
  const registryNoTransaction = createPipelineRegistry({ db: without(noTransaction, 'transaction'), idGenerator: () => 'pipe_1' })
  await assert.rejects(
    registryNoTransaction.upsertPipeline(pipelineInput()),
    (error) => FAIL_CLOSED_RE.test(error.message) && /db\.transaction is required to write a pipeline/.test(error.message),
    'FC-04: a pipeline write on a db without transaction is refused',
  )
  assert.equal(noTransaction.calls.length, 0, 'FC-04: refused before ANY statement — no autocommit endpoint check, no write')
  assert.equal(noTransaction.rows(PIPELINES_TABLE).length, 0)

  // FC-05: upsertPipeline on a transaction handle without selectOneForKeyShare.
  const noLock = createLockingDb()
  seedPipelineSystems(noLock)
  const registryNoLock = createPipelineRegistry({ db: withTransactionHandleWithout(noLock, 'selectOneForKeyShare'), idGenerator: () => 'pipe_1' })
  await assert.rejects(
    registryNoLock.upsertPipeline(pipelineInput()),
    (error) => FAIL_CLOSED_RE.test(error.message) && /transaction handle with selectOneForKeyShare is required to write a pipeline/.test(error.message),
    'FC-05: a transaction handle that cannot lock is refused',
  )
  assert.equal(noLock.calls.filter((call) => call.op !== 'BEGIN' && call.op !== 'ROLLBACK').length, 0,
    'FC-05: the transaction issued no statement — never a plain selectOne endpoint check, never an INSERT')
  assert.ok(noLock.calls.some((call) => call.op === 'ROLLBACK'), 'FC-05: and it rolled back')
  assert.equal(noLock.rows(PIPELINES_TABLE).length, 0)
  console.log('  FC-04/05 upsertPipeline refuses a db without transaction and a handle without selectOneForKeyShare; nothing issued')

  // FC-06: deleteExternalSystem without db.transaction.
  const noTransactionDelete = createLockingDb()
  noTransactionDelete.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  await assert.rejects(
    newRegistry(without(noTransactionDelete, 'transaction')).deleteExternalSystem(deleteInput()),
    (error) => FAIL_CLOSED_RE.test(error.message) && /scoped db helper with transaction is required/.test(error.message),
    'FC-06: a delete on a db without transaction is refused',
  )
  assert.equal(noTransactionDelete.calls.length, 0, 'FC-06: refused before the probe, the counts and the DELETE — no unlocked count-then-delete')
  assert.equal(noTransactionDelete.rows(EXTERNAL_SYSTEMS_TABLE).length, 1)

  // FC-07: deleteExternalSystem on a transaction handle without selectOneForUpdate.
  const noForUpdate = createLockingDb()
  noForUpdate.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  await assert.rejects(
    newRegistry(withTransactionHandleWithout(noForUpdate, 'selectOneForUpdate')).deleteExternalSystem(deleteInput()),
    (error) => FAIL_CLOSED_RE.test(error.message) && /transaction handle with selectOneForUpdate is required/.test(error.message),
    'FC-07: a transaction handle that cannot take FOR UPDATE is refused',
  )
  const insideTransaction = noForUpdate.calls.filter((call) => call.tx !== null && opFilter(call))
  assert.equal(insideTransaction.length, 0, 'FC-07: the transaction issued no statement — never a plain selectOne in place of FOR UPDATE, never a count, never the DELETE')
  assert.ok(noForUpdate.calls.some((call) => call.op === 'ROLLBACK'), 'FC-07: and it rolled back')
  assert.equal(noForUpdate.rows(EXTERNAL_SYSTEMS_TABLE).length, 1, 'FC-07: the row survives')
  console.log('  FC-06/07 deleteExternalSystem refuses a db without transaction and a handle without selectOneForUpdate; nothing issued')
}

// ---------------------------------------------------------------------------------------------------
// R-062-REUSE — the REGISTERED reuse-path outcomes of saveVersion (see the file header).
// ---------------------------------------------------------------------------------------------------
function readSourceStoreOn(db) {
  let seq = 0
  return createReadSourceConfigStore({ db, idGenerator: () => `rsc_${++seq}` })
}

async function testReadSourceReusePathRegistered() {
  // R-062-REUSE-A: identical content already exists as a RETIRED version; the system was deleted
  // afterwards (retired is not counted, so the delete goes through — B-05).
  const db = createLockingDb()
  db.seed(EXTERNAL_SYSTEMS_TABLE, [systemRow()])
  const registry = newRegistry(db)
  const store = readSourceStoreOn(db)
  const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
  const minted = await store.saveVersion({ ...scope, config: readSourceConfig() })
  await store.approve({ ...scope, id: minted.id })
  await store.retire({ ...scope, id: minted.id })
  const deleted = await settle(registry.deleteExternalSystem(deleteInput()))
  assert.equal(deleted.error, null, 'R-062-REUSE-A: a retired-only pointer does not refuse the delete')
  assert.equal(db.rows(EXTERNAL_SYSTEMS_TABLE).length, 0)

  const rowsBefore = db.rows(READ_SOURCE_CONFIG_TABLE).length
  const auditBefore = db.rows(READ_SOURCE_AUDIT_TABLE).length
  const issuedBefore = db.calls.length
  const same = await settle(store.saveVersion({ ...scope, config: readSourceConfig() }))
  assert.equal(same.error && same.error.name, 'ReadSourceConfigConflictError',
    'R-062-REUSE-A: identical content at the now-deleted system is answered by the reuse path, not by the lock')
  assert.deepEqual(same.error.details, { id: minted.id, reason: 'content_retired' })
  const issued = db.calls.slice(issuedBefore)
  assert.equal(issued.filter((call) => call.op === 'selectOneForKeyShare').length, 0, 'R-062-REUSE-A: no KEY SHARE — the reuse lookup runs BEFORE the lock')
  assert.equal(issued.filter((call) => call.op === 'BEGIN').length, 0, 'R-062-REUSE-A: no transaction was even opened')
  assert.equal(db.rows(READ_SOURCE_CONFIG_TABLE).length, rowsBefore, 'R-062-REUSE-A: no row')
  assert.equal(db.rows(READ_SOURCE_AUDIT_TABLE).length, auditBefore, 'R-062-REUSE-A: no audit')
  // Different content at the same deleted system takes the MINT path and gets the lock's tuple.
  const different = await settle(store.saveVersion({ ...scope, config: readSourceConfig({ object: 'bom' }) }))
  assert.equal(different.error && different.error.name, 'ReadSourceConfigValidationError')
  assert.deepEqual(different.error.details.errors, [{ code: SYSTEM_NOT_FOUND_CODE, field: 'systemId', reason: 'not_found' }],
    'R-062-REUSE-A: the mint path (content not in the family) is the one the lock guards')
  console.log('  R-062-REUSE-A identical content + retired version at a deleted system → 409 content_retired via the pre-lock reuse path (registered)')

  // R-062-REUSE-B: a pre-protocol LIVE row at a system that does not exist in this tenant (minted
  // before the protocol, when a pointer could precede its system). Identical content reuses it —
  // no lock, no existence check, a reuse_version audit row is written.
  const legacy = createLockingDb()
  const ghost = readSourceConfig({ systemId: 'sys_ghost' })
  const normalized = validateReadSourceConfig(ghost).normalized
  legacy.seed(READ_SOURCE_CONFIG_TABLE, [{
    id: 'legacy_1', tenant_id: 't1', workspace_id: null, system_id: 'sys_ghost', object: normalized.object, mode: normalized.mode,
    config: { ...normalized, version: 1 }, content_key: contentKeyFor(normalized), version: 1, status: 'draft', created_by: null, updated_by: null,
  }])
  const legacyStore = readSourceStoreOn(legacy)
  const reused = await settle(legacyStore.saveVersion({ ...scope, config: ghost }))
  assert.equal(reused.error, null, 'R-062-REUSE-B: the legacy live row is reused')
  assert.equal(reused.value.reused, true)
  assert.equal(reused.value.id, 'legacy_1')
  assert.equal(legacy.calls.filter((call) => call.op === 'selectOneForKeyShare').length, 0, 'R-062-REUSE-B: no lock, no existence check')
  const audits = legacy.rows(READ_SOURCE_AUDIT_TABLE)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'reuse_version', 'R-062-REUSE-B: a reuse_version audit row IS written')
  assert.equal(legacy.rows(READ_SOURCE_CONFIG_TABLE).length, 1, 'R-062-REUSE-B: no new pointer minted')
  const ghostDifferent = await settle(legacyStore.saveVersion({ ...scope, config: readSourceConfig({ systemId: 'sys_ghost', object: 'bom' }) }))
  assert.deepEqual(ghostDifferent.error && ghostDifferent.error.details.errors, [{ code: SYSTEM_NOT_FOUND_CODE, field: 'systemId', reason: 'not_found' }],
    'R-062-REUSE-B: new content at the same missing system is refused by the lock')
  assert.equal(legacy.rows(READ_SOURCE_CONFIG_TABLE).length, 1)
  console.log('  R-062-REUSE-B identical content + pre-protocol live row at a missing system → reused, reuse_version audit, no lock (registered)')
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

// ---------------------------------------------------------------------------------------------------
// M-FC-* — each DEGRADES one fail-closed guard to "fall back to the unlocked read" (the exact shape a
// well-meaning "compatibility" patch would take) and shows the matching FC assertion flips: the
// degraded code "works", through the very read the protocol forbids.
// ---------------------------------------------------------------------------------------------------
const CONSTRUCTOR_KEY_SHARE_CLAUSE = [
  "    typeof db.transaction !== 'function' ||\n    typeof db.selectOneForKeyShare !== 'function'\n  ) {",
  "    typeof db.transaction !== 'function'\n  ) {",
]

async function testMutationFailClosedGuardsDegraded() {
  // M-FC-LOCK: the helper falls back to selectOne when selectOneForKeyShare is missing.
  const lockMutant = compileMutant(MODULES.pointerLock, [
    ["if (!executor || typeof executor.selectOneForKeyShare !== 'function') {",
      "if (!executor || (typeof executor.selectOneForKeyShare !== 'function' && typeof executor.selectOne !== 'function')) {"],
    ['return executor.selectOneForKeyShare(EXTERNAL_SYSTEMS_TABLE, {',
      'return (executor.selectOneForKeyShare || executor.selectOne).call(executor, EXTERNAL_SYSTEMS_TABLE, {'],
  ], 'M-FC-LOCK')
  let unlockedReads = 0
  const executor = { async selectOne() { unlockedReads += 1; return systemRow() } }
  const degraded = await settle(lockMutant.lockExternalSystemForPointerWrite(executor, { tenantId: 't1', id: 'sys_1' }))
  assert.equal(degraded.error, null, 'M-FC-LOCK: the degraded helper "succeeds"')
  assert.equal(unlockedReads, 1, 'M-FC-LOCK: ...through the unlocked read FC-03 forbids — FC-03 is load-bearing')
  console.log('  M-FC-LOCK lock helper degraded to selectOne: FC-03 flips (unlocked read issued)')

  // M-FC-079 / M-FC-062: the constructor clause is dropped, so a db that cannot lock is admitted.
  const store079Mutant = compileMutant(MODULES.stockPrepBindingStore, [CONSTRUCTOR_KEY_SHARE_CLAUSE], 'M-FC-079')
  const complete = createLockingDb()
  assert.doesNotThrow(
    () => store079Mutant.createStockPreparationSourceBindingStore({ db: without(complete, 'selectOneForKeyShare') }),
    'M-FC-079: the 079 constructor now admits a db without selectOneForKeyShare — FC-01 is load-bearing',
  )
  const store062Mutant = compileMutant(MODULES.readSourceConfigStore, [CONSTRUCTOR_KEY_SHARE_CLAUSE], 'M-FC-062')
  assert.doesNotThrow(
    () => store062Mutant.createReadSourceConfigStore({ db: without(complete, 'selectOneForKeyShare') }),
    'M-FC-062: the 062 constructor now admits a db without selectOneForKeyShare — FC-02 is load-bearing',
  )
  console.log('  M-FC-079/062 constructor clause dropped: FC-01/FC-02 flip (a db that cannot lock is admitted)')

  // M-FC-PIPE: the endpoint check falls back to selectOne on a handle that cannot lock.
  const pipelineMutant = compileMutant(MODULES.pipelines, [
    ["if (!db || typeof db.selectOneForKeyShare !== 'function') {", 'if (!db) {'],
    ['const row = await db.selectOneForKeyShare(EXTERNAL_SYSTEMS_TABLE, {',
      'const row = await (db.selectOneForKeyShare || db.selectOne).call(db, EXTERNAL_SYSTEMS_TABLE, {'],
  ], 'M-FC-PIPE')
  const noLock = createLockingDb()
  seedPipelineSystems(noLock)
  const registry = pipelineMutant.createPipelineRegistry({ db: withTransactionHandleWithout(noLock, 'selectOneForKeyShare'), idGenerator: () => 'pipe_1' })
  const written = await settle(registry.upsertPipeline(pipelineInput()))
  assert.equal(written.error, null, 'M-FC-PIPE: the degraded endpoint check writes the pipeline')
  assert.equal(noLock.rows(PIPELINES_TABLE).length, 1, 'M-FC-PIPE: ...a pointer written with no lock at all — FC-05 is load-bearing')
  assert.ok(noLock.calls.some((call) => call.op === 'selectOne' && call.table === EXTERNAL_SYSTEMS_TABLE), 'M-FC-PIPE: through the plain selectOne')
  console.log('  M-FC-PIPE endpoint check degraded to selectOne on a handle without the lock method: FC-05 flips (pipeline written unlocked)')
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
  await testPipelineScopePins()
  await testFakeAbortsTransactionAfterAFailedStatement()
  await testFailClosedGuards()
  await testReadSourceReusePathRegistered()
  await testSealedExportResidualTripwire()
  await testMutationDeleteSideWithoutForUpdate()
  await testMutationStockPrepWriterUnlocked()
  await testMutationReadSourceWriterUnlocked()
  await testMutationPipelineWriterUnlocked()
  await testMutationFailClosedGuardsDegraded()
  // The genuine modules are untouched by the in-memory mutants: L-01 still refuses, FC-03 still refuses.
  await testStockPrepDeleteFirst()
  await testFailClosedGuards()
  console.log('✓ external-systems delete × bind lock protocol: 079/062/pipelines participate; scope + fail-closed pinned; 062 reuse path + 073 residual registered; 8 mutants flip')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
