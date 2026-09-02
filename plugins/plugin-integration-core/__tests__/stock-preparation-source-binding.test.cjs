'use strict'

// 工作台里选源 — the eligibility contract, the durable store, the per-request resolver seam, and the
// two migrations behind them.
//
// THE PROPERTY THIS SUITE EXISTS TO PROVE, stated as the mutation that must red it: change
// `applyPersistedSourceBinding` to ignore the resolver (return the action unchanged) and R-01 must
// fail. That is the whole feature — "the source an admin picked is the source the next request
// reads" — and every other case here is a fence around it.
//
// Covered:
//   R-01  a persisted binding CHANGES what the next getTableAction resolves — no restart, no
//         re-registration, no cache flush. Asserted by mutating the store BETWEEN two calls on ONE
//         registry instance, which is exactly the object activation built.
//   R-02  no persisted binding -> the deploy-time env default stands, byte-identical to a registry
//         built without the seam at all.
//   R-03  a resolver THROW propagates; it does NOT degrade to the env default.
//   R-04  a wired resolver invoked without a tenant scope is REFUSED, not silently skipped.
//   R-05  the override moves `externalSystemId` and NOTHING else (kind / readPlan / workspaceId /
//         target / template / bounds are deploy-time), and a stored junk value is re-normalized
//         through normalizeSource rather than reaching the adapter loader.
//   R-06  eligibility is an ALLOWLIST: only the two BOM read kinds, active, non-target, and a data
//         source the caller may actually use (#5401). Every refusal carries its own reason token.
//   R-07  the K3 write kind is refused BY THE ALLOWLIST and the refusal does NOT borrow
//         K3_WISE_EXTERNAL_WRITE_DISABLED (§15.2 E4-06: a read-path refusal must not be swallowed
//         into the write fence's token), and this module does not import the fence at all.
//   R-08  the store: scope triple, insert-vs-update, previous value read inside the same
//         transaction, `changed` computed from it, transaction required at construction.
//   R-09  migration 079/080 text: table shape, unique scope index, values-free columns, no DROP
//         TABLE, and the audit CHECK stays set-equal to the store constant.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'core-backend', 'migrations')

const {
  ELIGIBLE_SOURCE_KINDS,
  SOURCE_BINDING_REFUSAL_REASONS,
  StockPreparationSourceBindingError,
  assertBindableSource,
  isBindableSource,
  isEligibleSourceKind,
  listEligibleSources,
  projectEligibleSource,
  sourceBindingRefusalReason,
} = require(path.join(LIB, 'stock-preparation-source-binding.cjs'))
const {
  BINDING_TABLE,
  createStockPreparationSourceBindingStore,
} = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))
const {
  StockPreparationTableActionError,
  createStockPreparationTableActionRegistry,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREP_AUDIT_ACTIONS,
} = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  K3_EXTERNAL_WRITE_TARGET_KIND,
} = require(path.join(LIB, 'k3-external-write-permanent-fence.cjs'))

const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'tenant-a'
const ENV_DEFAULT_SOURCE = 'sys_env_default'
const PICKED_SOURCE = 'sys_customer_plm'

let passed = 0
let failed = 0

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

// The deploy-time config shape a real deployment puts in
// INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON.
function envConfiguredActions(externalSystemId = ENV_DEFAULT_SOURCE) {
  return [{
    actionId: ACTION_ID,
    source: { externalSystemId },
    target: { sheetId: 'sheet_stock_prep' },
  }]
}

function activeSystem(overrides = {}) {
  return {
    id: PICKED_SOURCE,
    name: '客户 PLM 只读库',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_1' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// An in-memory scoped-db stand-in with a REAL single-row transaction: the callback receives the
// same handle, so the store's read-then-write inside `transaction` is exercised rather than stubbed
// away. `calls` records every operation so a test can assert the read happened inside the unit of
// work rather than merely that the result looked right.
//
// It returns the pg RESULT shape (`{ rows: [...] }`) that lib/db.cjs's insertOne/updateRow actually
// produce (`database.query(... RETURNING *)`), NOT a bare row — a fake that returned the friendlier
// shape would let a store bug in `firstRow` pass here and fail against a real database.
//
// `failInsertOnce` simulates the 23505 the unique scope index raises when two concurrent first-binds
// both observed "absent": under READ COMMITTED a transaction does not prevent that, so the store's
// bounded retry is the thing being exercised.
// ---------------------------------------------------------------------------
function makeDb({ seed = [], failInsertOnce = false } = {}) {
  const rows = seed.map((row) => ({ ...row }))
  const calls = []
  let pendingInsertFailure = failInsertOnce
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => (row[column] ?? null) === (value ?? null))
  }
  function result(row) {
    return { rows: row ? [{ ...row }] : [] }
  }
  const handle = {
    rows,
    calls,
    async selectOne(table, where) {
      calls.push({ op: 'selectOne', table, where })
      return rows.find((row) => row.__table === table && matches(row, where)) || null
    },
    async insertOne(table, row) {
      calls.push({ op: 'insertOne', table, row })
      if (pendingInsertFailure) {
        pendingInsertFailure = false
        // The row the concurrent winner already committed — what the loser will see on re-entry.
        rows.push({ __table: table, created_at: 't0', updated_at: 't0', ...row, external_system_id: 'sys_winner', id: 'bind_winner' })
        const violation = new Error('duplicate key value violates unique constraint')
        violation.code = '23505'
        violation.constraint = 'uniq_integration_stock_prep_source_binding_scope'
        throw violation
      }
      const stored = { __table: table, created_at: 't0', updated_at: 't0', ...row }
      rows.push(stored)
      return result(stored)
    },
    async updateRow(table, set, where) {
      calls.push({ op: 'updateRow', table, set, where })
      const target = rows.find((row) => row.__table === table && matches(row, where))
      if (!target) return result(null)
      Object.assign(target, set)
      return result(target)
    },
    async transaction(callback) {
      calls.push({ op: 'transaction' })
      return callback(handle)
    },
  }
  return handle
}

function newStore(options) {
  const db = makeDb(options)
  let seq = 0
  return { db, store: createStockPreparationSourceBindingStore({ db, idGenerator: () => `bind_${++seq}` }) }
}

async function expectError(promise, predicate, label) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `${label}: expected a throw`)
  predicate(caught)
  return caught
}

async function main() {
  // -------------------------------------------------------------------------
  // R-01 — THE FEATURE. One registry instance (the object activation builds), a persisted binding
  // written between two calls, and the SECOND call resolves the new source. Nothing is re-created
  // in between: no new registry, no re-registration, no reload. That is "no restart", proven.
  // -------------------------------------------------------------------------
  await run('R-01 a persisted binding changes what the NEXT request resolves — same registry, no restart', async () => {
    const { store } = newStore()
    const registry = createStockPreparationTableActionRegistry({
      actions: envConfiguredActions(),
      resolveSourceBinding: async (scope) => {
        const binding = await store.get(scope)
        return binding ? binding.externalSystemId : null
      },
    })
    const scope = { tenantId: TENANT, actionId: ACTION_ID }

    const before = await registry.getTableAction(scope)
    assert.equal(before.source.externalSystemId, ENV_DEFAULT_SOURCE, 'starts on the deploy-time default')

    await store.set({ tenantId: TENANT, actionId: ACTION_ID, externalSystemId: PICKED_SOURCE, actor: 'u_admin' })

    const after = await registry.getTableAction(scope)
    assert.equal(after.source.externalSystemId, PICKED_SOURCE, 'the very next call reads the newly bound source')
    // And it did not corrupt the activation-time snapshot for anyone else: a DIFFERENT tenant with
    // no binding still resolves the env default off the same registry object.
    const otherTenant = await registry.getTableAction({ tenantId: 'tenant-b', actionId: ACTION_ID })
    assert.equal(otherTenant.source.externalSystemId, ENV_DEFAULT_SOURCE, 'the deploy-time snapshot is not mutated')
  })

  // -------------------------------------------------------------------------
  // R-02 — the fallback. Nothing bound anywhere: byte-identical to a registry with no seam.
  // -------------------------------------------------------------------------
  await run('R-02 with no persisted override the env default stands, identical to a registry without the seam', async () => {
    const { store } = newStore()
    const withSeam = createStockPreparationTableActionRegistry({
      actions: envConfiguredActions(),
      resolveSourceBinding: async (scope) => {
        const binding = await store.get(scope)
        return binding ? binding.externalSystemId : null
      },
    })
    const withoutSeam = createStockPreparationTableActionRegistry({ actions: envConfiguredActions() })

    const bound = await withSeam.getTableAction({ tenantId: TENANT, actionId: ACTION_ID })
    const plain = await withoutSeam.getTableAction({ tenantId: TENANT, actionId: ACTION_ID })
    assert.deepEqual(bound, plain, 'an unbound deployment is byte-identical to the pre-seam behaviour')
    assert.equal(bound.source.externalSystemId, ENV_DEFAULT_SOURCE)

    // A store present but empty and a store absent entirely must agree.
    const noStore = createStockPreparationTableActionRegistry({ actions: envConfiguredActions(), resolveSourceBinding: null })
    assert.deepEqual(await noStore.getTableAction({ tenantId: TENANT, actionId: ACTION_ID }), plain)
  })

  // -------------------------------------------------------------------------
  // R-03 — fail-closed. "The binding table is unreachable" must NOT look like "nothing is bound",
  // because the second one silently resolves the env default — on a customer deployment, the
  // synthetic demo source.
  // -------------------------------------------------------------------------
  await run('R-03 a resolver throw propagates and does NOT degrade to the env default', async () => {
    const registry = createStockPreparationTableActionRegistry({
      actions: envConfiguredActions(),
      resolveSourceBinding: async () => {
        throw new Error('binding table unreachable')
      },
    })
    await expectError(
      registry.getTableAction({ tenantId: TENANT, actionId: ACTION_ID }),
      (error) => assert.equal(error.message, 'binding table unreachable'),
      'R-03',
    )
  })

  // -------------------------------------------------------------------------
  // R-04 — a wired resolver with no tenant scope is refused. Skipping the lookup would resolve the
  // env default while an admin's chosen source sat unread in the table, invisibly.
  // -------------------------------------------------------------------------
  await run('R-04 a wired resolver invoked without a tenant scope is refused, not skipped', async () => {
    let called = 0
    const registry = createStockPreparationTableActionRegistry({
      actions: envConfiguredActions(),
      resolveSourceBinding: async () => {
        called += 1
        return PICKED_SOURCE
      },
    })
    const error = await expectError(
      registry.getTableAction({ actionId: ACTION_ID }),
      (caught) => {
        assert.ok(caught instanceof StockPreparationTableActionError)
        assert.equal(caught.code, 'TABLE_ACTION_SOURCE_BINDING_SCOPE_REQUIRED')
        assert.equal(caught.status, 500)
      },
      'R-04',
    )
    assert.ok(error)
    assert.equal(called, 0, 'the resolver is never consulted with an unscoped lookup')

    // Without a resolver an unscoped lookup is still fine — this refusal is armed only when there is
    // an override that could have been missed.
    const noSeam = createStockPreparationTableActionRegistry({ actions: envConfiguredActions() })
    assert.equal((await noSeam.getTableAction({ actionId: ACTION_ID })).source.externalSystemId, ENV_DEFAULT_SOURCE)
  })

  // -------------------------------------------------------------------------
  // R-05 — the override's blast radius is ONE field, and a stored value still has to be valid.
  // -------------------------------------------------------------------------
  await run('R-05 the override moves externalSystemId only, and a junk stored value is re-normalized', async () => {
    const baseline = await createStockPreparationTableActionRegistry({ actions: envConfiguredActions() })
      .getTableAction({ tenantId: TENANT, actionId: ACTION_ID })

    const registry = createStockPreparationTableActionRegistry({
      actions: envConfiguredActions(),
      resolveSourceBinding: async () => PICKED_SOURCE,
    })
    const bound = await registry.getTableAction({ tenantId: TENANT, actionId: ACTION_ID })

    assert.equal(bound.source.externalSystemId, PICKED_SOURCE)
    assert.equal(bound.source.kind, baseline.source.kind, 'kind stays deploy-time')
    assert.deepEqual(bound.source.readPlan, baseline.source.readPlan, 'readPlan stays deploy-time')
    assert.equal(bound.source.workspaceId, baseline.source.workspaceId, 'source workspaceId stays deploy-time')
    assert.deepEqual(bound.target, baseline.target, 'target stays deploy-time')
    assert.deepEqual(bound.template, baseline.template, 'template stays deploy-time')
    // Everything except `source` must be identical, so a future field added to the action config
    // cannot quietly become bindable.
    const { source: _boundSource, ...boundRest } = bound
    const { source: _baseSource, ...baseRest } = baseline
    assert.deepEqual(boundRest, baseRest, 'no key outside `source` moves')

    // A stored value that would fail normalizeSource is refused HERE, not at the adapter loader.
    for (const junk of ['', '   ']) {
      const junkRegistry = createStockPreparationTableActionRegistry({
        actions: envConfiguredActions(),
        resolveSourceBinding: async () => junk,
      })
      // Blank-ish values normalize to "no override" (optionalString), so the env default stands —
      // which is the safe direction: it can never resolve an EMPTY source id into a lookup.
      const resolved = await junkRegistry.getTableAction({ tenantId: TENANT, actionId: ACTION_ID })
      assert.equal(resolved.source.externalSystemId, ENV_DEFAULT_SOURCE, `blank override (${JSON.stringify(junk)}) falls back`)
    }
  })

  // -------------------------------------------------------------------------
  // R-06 — the allowlist, one refusal reason per disqualifying property.
  // -------------------------------------------------------------------------
  await run('R-06 eligibility is an allowlist with a distinct reason token per refusal', async () => {
    assert.deepEqual([...ELIGIBLE_SOURCE_KINDS].sort(), ['bridge:legacy-sql-readonly', 'data-source:sql-readonly'])
    assert.ok(isEligibleSourceKind('data-source:sql-readonly'))
    assert.ok(!isEligibleSourceKind('data-source:sql-write-gated'))
    assert.ok(!isEligibleSourceKind('metasheet:multitable'))
    assert.ok(!isEligibleSourceKind(undefined))

    assert.equal(sourceBindingRefusalReason(activeSystem(), { dataSourceAccessible: true }), null)
    assert.equal(sourceBindingRefusalReason(null), 'not_found')
    assert.equal(sourceBindingRefusalReason(activeSystem({ kind: 'http' })), 'kind_ineligible')
    assert.equal(sourceBindingRefusalReason(activeSystem({ role: 'target' })), 'role_ineligible')
    assert.equal(sourceBindingRefusalReason(activeSystem({ status: 'inactive' })), 'not_active')
    assert.equal(sourceBindingRefusalReason(activeSystem({ status: 'error' })), 'not_active')
    assert.equal(sourceBindingRefusalReason(activeSystem(), { dataSourceAccessible: false }), 'data_source_not_accessible')
    // Undecided (no descriptor seam on this host, or a self-contained kind) must NOT disqualify —
    // a host without the seam would otherwise silently empty the picker.
    assert.equal(sourceBindingRefusalReason(activeSystem(), { dataSourceAccessible: undefined }), null)

    // The thrown shapes: 404 for not-found ONLY, 422 for everything else.
    await expectError(
      Promise.resolve().then(() => assertBindableSource(null)),
      (error) => {
        assert.ok(error instanceof StockPreparationSourceBindingError)
        assert.equal(error.status, 404)
        assert.equal(error.code, 'SOURCE_BINDING_SOURCE_NOT_FOUND')
        assert.equal(error.details.reason, 'not_found')
      },
      'R-06 not found',
    )
    await expectError(
      Promise.resolve().then(() => assertBindableSource(activeSystem({ status: 'inactive' }))),
      (error) => {
        assert.equal(error.status, 422)
        assert.equal(error.code, 'SOURCE_BINDING_SOURCE_INELIGIBLE')
        assert.equal(error.details.reason, 'not_active')
      },
      'R-06 inactive',
    )

    // The picker DROPS ineligible rows rather than greying them out (R-11).
    const rows = listEligibleSources(
      [
        activeSystem(),
        activeSystem({ id: 'sys_bridge', kind: 'bridge:legacy-sql-readonly', config: {} }),
        activeSystem({ id: 'sys_http', kind: 'http' }),
        activeSystem({ id: 'sys_inactive', status: 'inactive' }),
        activeSystem({ id: 'sys_target', role: 'target' }),
        activeSystem({ id: 'sys_notmine' }),
      ],
      { dataSourceAccessibility: new Map([[PICKED_SOURCE, true], ['sys_notmine', false]]) },
    )
    assert.deepEqual(rows.map((row) => row.externalSystemId), [PICKED_SOURCE, 'sys_bridge'])
    // Plain language FIRST (#5391 register), reusing 对接总览's own labels rather than a second table.
    assert.equal(rows[0].kindLabel.zh, '只读数据库桥接')
    assert.equal(rows[1].kindLabel.zh, '旧库只读桥接 (Bridge Agent)')
    // The projected row carries handles/enums/labels and NOTHING off the system's config.
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['externalSystemId', 'kind', 'kindLabel', 'name', 'role', 'status'],
    )
    assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], 'config'))
    assert.ok(!JSON.stringify(rows).includes('ds_1'), 'no data-source pointer leaks into the picker')
  })

  // -------------------------------------------------------------------------
  // R-07 — the K3 boundary, in BOTH directions. Refused by the allowlist; refusal NOT wearing the
  // fence's token; the module does not reach for the fence at all.
  // -------------------------------------------------------------------------
  await run('R-07 the K3 write kind is refused by the allowlist and never borrows the fence token', async () => {
    assert.ok(!isEligibleSourceKind(K3_EXTERNAL_WRITE_TARGET_KIND), 'the K3 write connector is not a bindable source')
    assert.equal(sourceBindingRefusalReason(activeSystem({ kind: K3_EXTERNAL_WRITE_TARGET_KIND })), 'kind_ineligible')
    // Nor is the K3 SQL channel, nor the write-gated data source: only the two BOM READ kinds.
    for (const kind of ['erp:k3-wise-sqlserver', 'data-source:sql-write-gated']) {
      assert.equal(sourceBindingRefusalReason(activeSystem({ kind })), 'kind_ineligible', kind)
    }

    const error = await expectError(
      Promise.resolve().then(() => assertBindableSource(activeSystem({ kind: K3_EXTERNAL_WRITE_TARGET_KIND }))),
      () => {},
      'R-07',
    )
    // §15.2 E4-06: a READ-path refusal must surface its own code and must never be swallowed into
    // the permanent write fence's token, or a mistyped source id would read as an attempted
    // external write and the fence's own tests could not tell the two apart.
    assert.equal(error.code, 'SOURCE_BINDING_SOURCE_INELIGIBLE')
    assert.notEqual(error.code, K3_WISE_EXTERNAL_WRITE_DISABLED)
    assert.ok(!JSON.stringify(error.details).includes(K3_WISE_EXTERNAL_WRITE_DISABLED))

    // Structural, not incidental: this module must not depend on the fence, so it cannot acquire the
    // token by accident later either.
    const moduleSource = fs.readFileSync(path.join(LIB, 'stock-preparation-source-binding.cjs'), 'utf8')
    const requires = [...moduleSource.matchAll(/require\('(\.[^']+)'\)/g)].map((match) => match[1])
    assert.ok(
      !requires.some((entry) => entry.includes('k3-external-write-permanent-fence')),
      'the read-side binding contract must not import the write fence',
    )
    // The token appears in this file's PROSE (the E4-06 note) but never as code it can emit.
    assert.ok(
      !new RegExp(`^(?!\\s*(//|\\*)).*${K3_WISE_EXTERNAL_WRITE_DISABLED}`, 'm').test(moduleSource),
      'the fence token must not appear outside prose',
    )
  })

  // -------------------------------------------------------------------------
  // R-08 — the store.
  // -------------------------------------------------------------------------
  await run('R-08 the store keys on the scope triple and reads the replaced value inside the write', async () => {
    const { db, store } = newStore()

    assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION_ID }), null, 'unbound scope reads null')

    const first = await store.set({ tenantId: TENANT, actionId: ACTION_ID, externalSystemId: PICKED_SOURCE, actor: 'u_admin' })
    assert.equal(first.previousExternalSystemId, null)
    assert.equal(first.changed, true)
    assert.equal(first.binding.externalSystemId, PICKED_SOURCE)
    assert.equal(first.binding.actionId, ACTION_ID)
    assert.equal(first.binding.workspaceId, null)
    assert.equal(first.binding.updatedBy, 'u_admin')

    const insert = db.calls.find((call) => call.op === 'insertOne')
    assert.equal(insert.table, BINDING_TABLE)
    assert.ok(BINDING_TABLE.startsWith('integration_'), 'the table stays inside the plugin db prefix')
    // Values-free: every persisted column is a handle.
    assert.deepEqual(
      Object.keys(insert.row).sort(),
      ['action_id', 'external_system_id', 'id', 'tenant_id', 'updated_by', 'workspace_id'],
    )

    // The read that produces `previousExternalSystemId` happens INSIDE the transaction, so the audit
    // trail can never name a source that was not actually replaced. Asserted as an ORDER over the
    // recorded operations: transaction opens, THEN the select, THEN the write.
    const transactionAt = db.calls.findIndex((call) => call.op === 'transaction')
    assert.ok(transactionAt >= 0, 'the write opens a transaction')
    const inTransaction = db.calls.slice(transactionAt)
    const selectAt = inTransaction.findIndex((call) => call.op === 'selectOne' && call.table === BINDING_TABLE)
    const writeAt = inTransaction.findIndex((call) => call.op === 'insertOne' || call.op === 'updateRow')
    assert.ok(selectAt >= 0 && writeAt > selectAt, 'the previous value is read inside the transaction, before the write')

    const rebind = await store.set({ tenantId: TENANT, actionId: ACTION_ID, externalSystemId: 'sys_other', actor: 'u_admin2' })
    assert.equal(rebind.previousExternalSystemId, PICKED_SOURCE, 'the replaced id is reported')
    assert.equal(rebind.changed, true)
    assert.ok(db.calls.some((call) => call.op === 'updateRow'), 'a rebind updates rather than inserting a second row')

    const resave = await store.set({ tenantId: TENANT, actionId: ACTION_ID, externalSystemId: 'sys_other', actor: 'u_admin2' })
    assert.equal(resave.changed, false, 're-confirming the same source is recorded but not a change')

    // Scope isolation: another tenant and another workspace are different rows.
    assert.equal(await store.get({ tenantId: 'tenant-b', actionId: ACTION_ID }), null)
    assert.equal(await store.get({ tenantId: TENANT, workspaceId: 'ws_2', actionId: ACTION_ID }), null)
    await store.set({ tenantId: TENANT, workspaceId: 'ws_2', actionId: ACTION_ID, externalSystemId: 'sys_ws2' })
    assert.equal((await store.get({ tenantId: TENANT, workspaceId: 'ws_2', actionId: ACTION_ID })).externalSystemId, 'sys_ws2')
    assert.equal((await store.get({ tenantId: TENANT, actionId: ACTION_ID })).externalSystemId, 'sys_other', 'the null-workspace row is untouched')

    // Fail-closed scope validation.
    await expectError(store.get({ actionId: ACTION_ID }), (error) => assert.equal(error.code, 'SOURCE_BINDING_SCOPE_INVALID'), 'R-08 tenant')
    await expectError(store.set({ tenantId: TENANT, actionId: ACTION_ID }), (error) => assert.equal(error.code, 'SOURCE_BINDING_SCOPE_INVALID'), 'R-08 system')

    // `transaction` is REQUIRED at construction: a helper without it cannot make the read-then-write
    // atomic, and a non-atomic one would let a concurrent rebind falsify the audit trail.
    assert.throws(
      () => createStockPreparationSourceBindingStore({ db: { selectOne() {}, insertOne() {}, updateRow() {} } }),
      /scoped db helper \(incl\. transaction\) is required/,
    )
  })

  // Two concurrent FIRST binds. A transaction does not prevent this under READ COMMITTED, so the
  // unique index arbitrates and the loser must re-enter and land an UPDATE — reporting the winner's
  // id as the previous binding, which is the truth. Without the retry this is a raw 23505 surfacing
  // as a 500 on an admin's Save.
  await run('R-08b a losing concurrent first-bind retries and reports the winner as the previous source', async () => {
    const { db, store } = newStore({ failInsertOnce: true })
    const result = await store.set({ tenantId: TENANT, actionId: ACTION_ID, externalSystemId: PICKED_SOURCE, actor: 'u_loser' })
    assert.equal(result.previousExternalSystemId, 'sys_winner', 'the concurrent winner is reported as the replaced source')
    assert.equal(result.binding.externalSystemId, PICKED_SOURCE)
    assert.equal(result.changed, true)
    assert.equal(db.calls.filter((call) => call.op === 'transaction').length, 2, 'the retry opened a FRESH transaction')
    assert.ok(db.calls.some((call) => call.op === 'updateRow'), 'the second attempt took the update path')
  })

  // -------------------------------------------------------------------------
  // R-09 — the migrations.
  // -------------------------------------------------------------------------
  await run('R-09 migration 079 declares a values-free scoped table; 080 keeps the audit vocabulary set-equal', async () => {
    const bindingPath = path.join(MIGRATIONS_DIR, '079_create_integration_stock_prep_source_binding.sql')
    const rawBinding = fs.readFileSync(bindingPath, 'utf8')
    const binding = rawBinding.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

    assert.doesNotMatch(binding, /\bDROP\s+TABLE\b/i, 'forward migration must not drop tables')
    const blockMatch = binding.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${BINDING_TABLE} \\(([\\s\\S]*?)\\n\\);`, 'm'))
    assert.ok(blockMatch, `expected a CREATE TABLE block for ${BINDING_TABLE}`)
    const block = blockMatch[1]
    for (const column of ['id', 'tenant_id', 'workspace_id', 'action_id', 'external_system_id', 'updated_by', 'created_at', 'updated_at']) {
      assert.ok(new RegExp(`(^|\\n)\\s*${column}\\s`).test(block), `binding table must declare ${column}`)
    }
    assert.match(block, /tenant_id\s+TEXT NOT NULL/, 'tenant_id is required')
    assert.match(block, /external_system_id\s+TEXT NOT NULL/, 'a binding without a source is not a binding')
    // ONE live binding per (tenant, workspace, action) — and the NULL workspace is collapsed the way
    // 057 does it, because PG14 has no NULLS NOT DISTINCT.
    assert.match(
      binding,
      new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS \\S+\\s+ON ${BINDING_TABLE} \\(tenant_id, COALESCE\\(workspace_id, ''\\), action_id\\)`),
      'the scope triple is unique',
    )
    // No column may ever carry connection material or a business value.
    for (const forbidden of ['credential', 'token', 'password', 'host', 'base_url', 'dsn', 'connection', 'secret']) {
      assert.ok(!block.includes(forbidden), `binding table must not declare a ${forbidden} column`)
    }

    // 080 widens the closed audit vocabulary, and the store constant stays set-equal to it. (The
    // audit-migration suite asserts this too, against the LATEST vocabulary migration it discovers;
    // restating it here keeps this feature's own suite self-contained about the action it adds.)
    //
    // The expected list below is 080's OWN historical vocabulary — frozen, not derived from the live
    // STOCK_PREP_AUDIT_ACTIONS import. 080 is a point-in-time migration; a LATER PR may legitimately
    // widen the vocabulary further (081: 按项目导出物料 Excel added `prep_line_export`) without ever
    // making 080's own CHECK list wrong. Comparing against the live constant here would make this
    // assertion fail every time a future action is added anywhere in the plugin — which is exactly
    // the failure mode stock-preparation-audit-migration.test.cjs's "discover the LATEST migration"
    // design avoids; this restatement stays self-contained by freezing what 080 actually declared.
    assert.ok(STOCK_PREP_AUDIT_ACTIONS.includes('source_binding_set'), 'the store still knows the action 080 added')
    const vocabulary = fs.readFileSync(path.join(MIGRATIONS_DIR, '080_extend_stock_prep_audit_source_binding_action.sql'), 'utf8')
    assert.doesNotMatch(vocabulary, /\bDROP\s+TABLE\b/i)
    const checkMatch = vocabulary.match(/ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK \(action IN \(([\s\S]*?)\)\)/)
    assert.ok(checkMatch, '080 installs the widened CHECK vocabulary')
    const checkActions = [...checkMatch[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]).sort()
    const actionsAsOf080 = [
      'exception_bulk_resolve', 'exception_resolve', 'generation_run',
      'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
      'persist_repair_once', 'source_binding_set', 'unit_confirm', 'unit_retire',
    ].sort()
    assert.deepEqual(checkActions, actionsAsOf080, "080's CHECK vocabulary matches what this feature introduced")
  })

  // -------------------------------------------------------------------------
  // R-19 — THE CROSS-KIND FOOTGUN. Both BOM read kinds are bindable in the abstract, but the
  // binding does NOT move `source.kind`, and `loadTableActionSourceAdapter` refuses any system whose
  // kind differs from it. So without `requiredKind` a bridge-kind pick against a
  // data-source-kind action would SAVE, report itself live, and then break every read.
  //
  // Fail-closed is not good enough here: it is fail-closed AND undiscoverable, which is exactly the
  // onboarding cost this feature exists to remove.
  // -------------------------------------------------------------------------
  await run('R-19 a candidate of the OTHER BOM read kind is refused for THIS action, and never offered', async () => {
    const dataSourceKind = 'data-source:sql-readonly'
    const bridgeKind = 'bridge:legacy-sql-readonly'
    const bridge = activeSystem({ id: 'sys_bridge', kind: bridgeKind, config: {} })

    // Both kinds remain bindable in the abstract — the allowlist is unchanged...
    assert.equal(sourceBindingRefusalReason(bridge), null, 'a bridge source is a valid 备料 source in general')
    // ...but not for an action wired for the OTHER kind.
    assert.equal(sourceBindingRefusalReason(bridge, { requiredKind: dataSourceKind }), 'kind_mismatch')
    assert.equal(sourceBindingRefusalReason(activeSystem(), { requiredKind: dataSourceKind }), null, 'the matching kind still passes')
    assert.equal(sourceBindingRefusalReason(activeSystem(), { requiredKind: bridgeKind }), 'kind_mismatch')
    // `kind_mismatch` is DISTINCT from `kind_ineligible`: one says "never a 备料 source", the other
    // says "fine, but not for this deployment". They need different words, so they need different
    // tokens.
    assert.equal(sourceBindingRefusalReason(activeSystem({ kind: 'http' }), { requiredKind: dataSourceKind }), 'kind_ineligible')
    assert.ok(SOURCE_BINDING_REFUSAL_REASONS.includes('kind_mismatch'))

    // The thrown refusal names the kind the ACTION wants — the admin cannot see it anywhere else,
    // because it comes off deploy-time config.
    const error = await expectError(
      Promise.resolve().then(() => assertBindableSource(bridge, { requiredKind: dataSourceKind })),
      (caught) => {
        assert.equal(caught.status, 422)
        assert.equal(caught.code, 'SOURCE_BINDING_SOURCE_INELIGIBLE')
        assert.equal(caught.details.reason, 'kind_mismatch')
      },
      'R-19 assert',
    )
    assert.equal(error.details.requiredKind, dataSourceKind, 'the refusal names the kind the action is wired for')

    // THE PICKER STAYS HONEST: a cross-kind candidate is absent, not greyed out.
    const offered = listEligibleSources([activeSystem(), bridge], {
      dataSourceAccessibility: new Map([[PICKED_SOURCE, true]]),
      requiredKind: dataSourceKind,
    })
    assert.deepEqual(offered.map((row) => row.externalSystemId), [PICKED_SOURCE], 'only the action\'s own kind is offered')
    // ...and the reverse, so the filter is the ACTION's kind and not a hardcoded preference.
    const offeredBridge = listEligibleSources([activeSystem(), bridge], { requiredKind: bridgeKind })
    assert.deepEqual(offeredBridge.map((row) => row.externalSystemId), ['sys_bridge'])

    // Omitting requiredKind keeps the old, wider question for callers with no action context.
    const unscoped = listEligibleSources([activeSystem(), bridge], {
      dataSourceAccessibility: new Map([[PICKED_SOURCE, true]]),
    })
    assert.equal(unscoped.length, 2, 'without an action context both kinds remain bindable')
  })

  // A tiny projection check kept separate so a failure names the projection, not the picker.
  await run('projectEligibleSource reports the refusal reason for an ineligible candidate', async () => {
    const row = projectEligibleSource(activeSystem({ kind: 'http' }))
    assert.equal(row.eligible, false)
    assert.equal(row.ineligibleReason, 'kind_ineligible')
    assert.equal(row.kindLabel.zh, '通用 HTTP 接口')
    assert.ok(!isBindableSource(activeSystem({ kind: 'http' })))
  })

  const total = passed + failed
  console.log(`\nstock-preparation-source-binding: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-source-binding')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
