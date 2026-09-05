'use strict'

// 工作台里选源 — the null-workspace SCOPE FALLBACK in `stock-preparation-source-binding-store.cjs`'s
// `get()` (direction B).
//
// THE GAP THIS CLOSES. The unique index on integration_stock_prep_source_binding is
// `(tenant_id, COALESCE(workspace_id, ''), action_id)` — so a `workspace_id IS NULL` row and a
// `workspace_id = 'default'` row for the same tenant+action can coexist. The UI writes under
// `workspaceId=default` (its own query hint), but reconcile, mvp-persist, carry, export, handoff and
// the project board all call `getTableAction`/`store.get()` with NO workspace hint at all — an
// omitted `workspaceId` normalizes to `null` (`optionalString(undefined) -> null`), so their lookup
// is always `workspace_id IS NULL` and a binding saved under `'default'` was invisible to them.
// (`stockPreparationSourcePreflight` at `http-routes.cjs:6163` calls `getTableAction({ actionId })`
// with no `tenantId` at all, so `applyPersistedSourceBinding` throws and the route's own `catch`
// swallows it before this fallback is ever reached — that is a separate, pre-existing bug, and
// preflight is NOT one of this fallback's beneficiaries.)
//
// THE FIX, one seam, `get()` only: when the caller's hint is `null` AND the exact
// `workspace_id IS NULL` row is absent, look for this `(tenant_id, action_id)`'s OTHER
// (`workspace_id IS NOT NULL`) rows. Exactly one -> return it, annotated. Zero or two-or-more ->
// `null`, same as today: this is fail-closed, not "guess". A NON-null hint that misses is NEVER
// widened — that behaviour is asserted independently by stock-preparation-source-binding.test.cjs's
// R-08 scope-isolation case (`assert.equal(await store.get({ ... workspaceId: 'ws_2', ... }), null)`
// on an unbound ws_2 scope — referenced by ASSERTION TEXT, not a line number, because a line number
// drifts the moment an earlier line in that file changes; this exact drift is what moved that
// assertion from :482 to :486 earlier in this same PR), and F-07 below is THIS file's own fence for it:
// F-04 (a non-null miss with only a NULL-workspace row seeded) does NOT actually exercise the
// `scope.workspaceId !== null` guard, because the sibling scan's own `IS NOT NULL` filter would
// throw that row away regardless of whether the guard ran — deleting the guard leaves F-04 green.
// F-07 seeds a SINGLE sibling under a DIFFERENT workspace than the one queried, which the guardless
// code WOULD wrongly return; that is the mutation-resistant fence.
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
// file is scoped to the fallback branch and its guardrails. The one real consumer of the two
// annotation keys is `loadTableActionSourceAdapter` in `http-routes.cjs` (F3) — see
// `stock-preparation-source-binding-routes.test.cjs`'s R-22 for that end-to-end proof; this file
// stays scoped to the store.
//
// SILENT DEGRADE, BY DESIGN, UNDOCUMENTED AT RUNTIME: if a second workspace ever binds this action's
// source, the fallback's "exactly one sibling" condition stops holding and `get()` quietly goes back
// to returning `null` for every hint-less caller — exactly today's pre-fallback behaviour, with no
// error, no log line, and no event. This store takes no logger/onEvent dependency, so there is
// nowhere to raise one from; the operator-facing note lives in
// `docs/development/takeover-beiliao-20260821/222-rehearsal-full-run-20260904.md`'s scope-fallback
// section instead.

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
// `calls` records every `select` invocation (table, where, options) so F-10 can assert `get()` asks
// for `limit: 2` rather than merely happening to behave correctly with a larger page.
function makeDb() {
  const rows = []
  const calls = []
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
    async select(table, options = {}) {
      calls.push({ op: 'select', table, options })
      const { where } = options
      return rows.filter((row) => row.__table === table && matches(row, where || {}))
    },
    async insertOne(table, row) {
      calls.push({ op: 'insertOne', table, row })
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

// Injects an arbitrary raw row directly, bypassing `store.set()` — used only by F-09's read-read
// race, which needs `select()` to see a row that `selectOne()` (called a statement earlier, inside
// the SAME `get()`) does not.
function seedRawRow(db, { tenantId = TENANT, workspaceId = null, actionId = ACTION_ID, externalSystemId }) {
  db.rows.push({
    __table: BINDING_TABLE,
    id: `raw_${db.rows.length}`,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    action_id: actionId,
    external_system_id: externalSystemId,
    updated_by: null,
    created_at: 't0',
    updated_at: 't0',
  })
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
  // F-04 — mirrors stock-preparation-source-binding.test.cjs's R-08 scope-isolation assertion (a
  // `get({ ..., workspaceId: 'ws_2', ... })` miss on an unbound scope returns `null`): a NON-null
  // hint that misses stays null even with a null-workspace row present. NOTE this alone does NOT fence the
  // `scope.workspaceId !== null` guard in `get()` — with only a null-workspace row seeded, the
  // sibling scan's own `workspace_id IS NOT NULL` filter throws that row away regardless of whether
  // the guard ran, so deleting the guard leaves this test green. F-07 below is the real fence: it
  // seeds a SINGLE sibling under a DIFFERENT workspace, which a guardless `get()` would wrongly
  // return.
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

  // -------------------------------------------------------------------------
  // F-07 — THE REAL FENCE for the `scope.workspaceId !== null` guard. A SINGLE sibling exists, under
  // a DIFFERENT workspace than the one queried. A guardless `get()` would reach the sibling scan on
  // this non-null miss, find exactly one candidate, and wrongly return it — which is precisely the
  // "guess which workspace the admin meant" this guard exists to refuse. Unlike F-04 (only a
  // null-workspace row seeded), THIS seed is not filtered away by the sibling scan's own
  // `workspace_id IS NOT NULL` check, so deleting the guard changes this test's OUTCOME, not merely
  // the suite total.
  // -------------------------------------------------------------------------
  await run("F-07 a non-null hint miss is never widened to a DIFFERENT workspace's single binding", async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: 'ws_a', externalSystemId: 'sys_a' })

    assert.equal(
      await store.get({ tenantId: TENANT, workspaceId: 'ws_b', actionId: ACTION_ID }),
      null,
      "ws_b must never resolve to ws_a's single binding — that is a guess, not a match",
    )
  })

  // -------------------------------------------------------------------------
  // F-08 — the store refuses to construct without `db.select`, the same posture
  // stock-preparation-source-binding.test.cjs already asserts for `db.transaction`. `select` backs
  // the scope fallback's sibling scan; a fake (or a future host binding) that omits it must fail
  // LOUDLY at construction, not with a bare `TypeError: db.select is not a function` the first time a
  // null-hint caller's exact lookup happens to miss.
  // -------------------------------------------------------------------------
  await run('F-08 construction refuses a db that has every method except select', async () => {
    const { select: _select, ...withoutSelect } = makeDb()
    assert.throws(
      () => createStockPreparationSourceBindingStore({ db: withoutSelect }),
      /scoped db helper \(incl\. transaction\) is required/,
    )
  })

  // -------------------------------------------------------------------------
  // F-09 — READ-READ RACE. `get()`'s exact lookup (`selectOne`) and its sibling scan (`select`) are
  // two separate statements, not one snapshot. Simulated here by forcing `selectOne` to report the
  // null-workspace row absent while `select` — reading the SAME underlying rows — sees it, because a
  // concurrent INSERT could land in that exact window on a real database. Precedence says the
  // null-workspace row should win when it exists; discovering it only in the wider scan, after the
  // exact check already said "absent", is a state `get()` cannot trust either half of — so it refuses
  // outright rather than resolving to the workspace-scoped sibling (which would silently override the
  // row that OUGHT to have won) or synthesizing an exact hit it never actually observed.
  // -------------------------------------------------------------------------
  await run('F-09 a read-read race — select() sees a null-workspace row selectOne() just reported absent — refuses outright', async () => {
    const inner = makeDb()
    seedRawRow(inner, { workspaceId: null, externalSystemId: 'sys_null_row' })
    seedRawRow(inner, { workspaceId: 'ws_a', externalSystemId: 'sys_a' })
    // Everything except `selectOne` behaves normally (reads the live `rows` the two seeds landed in);
    // `selectOne` alone is forced to report "not found", simulating the exact statement having run a
    // moment before the INSERT that `select` (a later statement) already sees.
    const racyDb = {
      ...inner,
      async selectOne(table, where) {
        inner.calls.push({ op: 'selectOne(forced-null, simulating a stale exact read)', table, where })
        return null
      },
    }
    const store = createStockPreparationSourceBindingStore({ db: racyDb, idGenerator: () => 'bind_race' })

    const result = await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.equal(result, null, 'the inconsistency between the two reads refuses rather than guessing')
  })

  // -------------------------------------------------------------------------
  // F-10 — the fallback's sibling scan caps at `limit: 2`. The unique scope index guarantees at most
  // one null-workspace row, so two rows back already proves "more than one workspace-scoped
  // candidate" without a hint-less caller's every `get()` paging through a deployment's entire
  // (tenant, action) row set just to refuse an ambiguous one.
  // -------------------------------------------------------------------------
  await run('F-10 the fallback query passes limit: 2 to db.select', async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_customer_plm' })

    await store.get({ tenantId: TENANT, actionId: ACTION_ID })

    const selectCalls = db.calls.filter((call) => call.op === 'select')
    assert.equal(selectCalls.length, 1, 'the fallback makes exactly one select() call')
    assert.equal(selectCalls[0].options.limit, 2, 'and caps it at 2 rows')
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
