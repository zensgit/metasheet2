'use strict'

// 工作台里选源 — the null-workspace SCOPE FALLBACK in `stock-preparation-source-binding-store.cjs`'s
// `get()` (direction B).
//
// THE GAP THIS CLOSES. The unique index on integration_stock_prep_source_binding is
// `(tenant_id, COALESCE(workspace_id, ''), action_id)` — so a `workspace_id IS NULL` row and a
// `workspace_id = 'default'` row for the same tenant+action can coexist. The UI writes under
// `workspaceId=default` (its own query hint), but reconcile, mvp-persist, source preflight, carry,
// export, handoff and the project board all call `getTableAction`/`store.get()` with NO workspace
// hint at all — an omitted `workspaceId` normalizes to `null` (`optionalString(undefined) -> null`),
// so their lookup is always `workspace_id IS NULL` and a binding saved under `'default'` was
// invisible to them.
//
// THE FIX, one seam, `get()` only: when the caller's hint is `null` AND the exact
// `workspace_id IS NULL` row is absent, look for this `(tenant_id, action_id)`'s OTHER
// (`workspace_id IS NOT NULL`) rows. Exactly one -> return it, annotated. Zero or two-or-more ->
// `null`, same as today: this is fail-closed, not "guess". A NON-null hint that misses is NEVER
// widened — that behaviour (asserted independently at
// stock-preparation-source-binding.test.cjs:482) must survive this change unchanged, so R-04 below
// re-asserts it here as this suite's own fence.
//
// DIRECTION, not `external-systems.cjs`'s `selectScopedRow`. That helper widens a MISSING hint by
// falling back to the TENANT-WIDE (null) row when a SPECIFIC hint misses — the opposite shape. Here
// the tenant-wide (null) row is the one nothing writes on its own; the workspace-scoped row is the
// one an admin actually saved. Copying `selectScopedRow`'s direction would not close this gap.
//
// SHAPE. A non-null `get()` result gains two keys on EVERY path, not only the fallback one, so the
// shape is uniform regardless of which query answered it:
//   * exact hit (null-hint row present, or a non-null hint that matched):
//       matchedWorkspaceId: <the value the caller passed in>, scopeFallback: null
//   * fallback hit (null hint, null row absent, exactly one sibling):
//       matchedWorkspaceId: <that sibling row's own workspace_id>, scopeFallback: 'single_workspace_binding'
// `stock-preparation-source-binding.test.cjs`'s R-08 already covers ordinary exact-hit gets; this
// file is scoped to the fallback branch and its guardrails.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  BINDING_TABLE,
  createStockPreparationSourceBindingStore,
} = require(path.join(LIB, 'stock-preparation-source-binding-store.cjs'))

const TENANT = 'tenant-scope-fallback'
const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

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

// The same in-memory scoped-db stand-in shape as stock-preparation-source-binding.test.cjs's
// `makeDb` — pg RESULT shape (`{ rows: [...] }`) off insertOne/updateRow, a bare array off `select`,
// and a REAL single-row transaction so `set()` (used only to seed rows here) is exercised for real.
function makeDb() {
  const rows = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => (row[column] ?? null) === (value ?? null))
  }
  function result(row) {
    return { rows: row ? [{ ...row }] : [] }
  }
  const handle = {
    rows,
    async selectOne(table, where) {
      return rows.find((row) => row.__table === table && matches(row, where)) || null
    },
    async select(table, { where } = {}) {
      return rows.filter((row) => row.__table === table && matches(row, where || {}))
    },
    async insertOne(table, row) {
      const stored = { __table: table, created_at: 't0', updated_at: 't0', ...row }
      rows.push(stored)
      return result(stored)
    },
    async updateRow(table, set, where) {
      const target = rows.find((row) => row.__table === table && matches(row, where))
      if (!target) return result(null)
      Object.assign(target, set)
      return result(target)
    },
    async transaction(callback) {
      return callback(handle)
    },
  }
  return handle
}

function newStore() {
  const db = makeDb()
  let seq = 0
  return { db, store: createStockPreparationSourceBindingStore({ db, idGenerator: () => `bind_${++seq}` }) }
}

async function bind(store, { workspaceId, externalSystemId, actionId = ACTION_ID, tenantId = TENANT }) {
  await store.set({ tenantId, workspaceId, actionId, externalSystemId, actor: 'u_admin' })
}

async function main() {
  // -------------------------------------------------------------------------
  // F-01 — THE FEATURE. Null hint, exactly one workspace-scoped row ('default', the UI's own query
  // hint) — the fallback fires and is annotated.
  // -------------------------------------------------------------------------
  await run('F-01 null hint with a single workspace-scoped row resolves it via the scope fallback', async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_customer_plm' })

    const result = await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.ok(result, 'the single workspace-scoped binding is returned, not null')
    assert.equal(result.externalSystemId, 'sys_customer_plm')
    assert.equal(result.workspaceId, 'default', 'rowToPublicBinding still names the row\'s own workspace')
    assert.equal(result.matchedWorkspaceId, 'default', 'matchedWorkspaceId names the sibling actually returned')
    assert.equal(result.scopeFallback, 'single_workspace_binding')
  })

  // -------------------------------------------------------------------------
  // F-02 — AMBIGUITY IS REFUSED, NOT GUESSED. Two workspace-scoped rows, null hint: fail-closed to
  // null exactly like zero would, never "pick one".
  // -------------------------------------------------------------------------
  await run('F-02 null hint with TWO workspace-scoped rows refuses to guess and returns null', async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: 'ws_a', externalSystemId: 'sys_a' })
    await bind(store, { workspaceId: 'ws_b', externalSystemId: 'sys_b' })

    assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION_ID }), null, 'two candidates -> refuse, not a guess')
  })

  // -------------------------------------------------------------------------
  // F-03 — PRECEDENCE. When the exact null-workspace row exists, it wins outright — the fallback
  // query is never reached, even though a workspace-scoped sibling also exists.
  // -------------------------------------------------------------------------
  await run('F-03 an exact null-workspace hit takes precedence over any workspace-scoped sibling', async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_default_row' })

    const result = await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.ok(result)
    assert.equal(result.externalSystemId, 'sys_null_row', 'the exact null-workspace row is returned, not the sibling')
    assert.equal(result.workspaceId, null)
    assert.equal(result.matchedWorkspaceId, null, 'exact hits echo the caller\'s own (null) hint')
    assert.equal(result.scopeFallback, null, 'an exact hit is never reported as a fallback')
  })

  // -------------------------------------------------------------------------
  // F-04 — THE GUARDRAIL. A NON-null hint that misses is NEVER widened, even though a null-workspace
  // row exists — mirrors stock-preparation-source-binding.test.cjs:482 so this file's own suite
  // fences the one behaviour direction B must never touch.
  // -------------------------------------------------------------------------
  await run('F-04 a non-null hint miss stays null and is never widened, even with a null-workspace row present', async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })

    assert.equal(
      await store.get({ tenantId: TENANT, workspaceId: 'ws_2', actionId: ACTION_ID }),
      null,
      'a specific miss stays a miss; the null-workspace row is not offered in its place',
    )
  })

  // -------------------------------------------------------------------------
  // F-05 — the ordinary empty case, unaffected: zero rows anywhere for this scope is still null,
  // with no `db.select` misbehaviour surfacing as a throw instead of a clean miss.
  // -------------------------------------------------------------------------
  await run('F-05 no rows anywhere for the scope resolves null, exactly as before', async () => {
    const { store, db } = newStore()
    assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION_ID }), null)
    assert.deepEqual(db.rows, [], 'nothing was written by a read')

    // A different tenant's binding must never satisfy this tenant's fallback — the sibling query is
    // scoped by tenant_id AND action_id, not merely action_id.
    await bind(store, { tenantId: 'tenant-other', workspaceId: 'default', externalSystemId: 'sys_other_tenant' })
    assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION_ID }), null, 'another tenant\'s row does not leak in')

    // Nor a different action's binding under the SAME tenant.
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_other_action', actionId: 'plm.other-action.v1' })
    assert.equal(await store.get({ tenantId: TENANT, actionId: ACTION_ID }), null, 'another action\'s row does not leak in')
  })

  // -------------------------------------------------------------------------
  // F-06 — table identity sanity: the store still reads/writes the one binding table.
  // -------------------------------------------------------------------------
  await run('F-06 the fallback query stays scoped to the binding table', async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_customer_plm' })
    await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.ok(db.rows.every((row) => row.__table === BINDING_TABLE))
  })

  const total = passed + failed
  console.log(`\nstock-preparation-source-binding-scope-fallback: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-source-binding-scope-fallback')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
