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
// widened to ANOTHER WORKSPACE's row — F-07 below is the fence for that: it seeds a SINGLE sibling
// under a DIFFERENT workspace than the one queried, which a guardless `get()` (one that let a
// non-null hint reach the sibling scan) WOULD wrongly return. F-12 repeats the same fence with the
// UI's own `'default'` hint.
//
// DIRECTION B, not `external-systems.cjs`'s `selectScopedRow`. That helper widens a MISSING hint by
// falling back to the TENANT-WIDE (null) row when a SPECIFIC hint misses — the opposite shape. Here
// the tenant-wide (null) row is the one nothing writes on its own; the workspace-scoped row is the
// one an admin actually saved. Copying `selectScopedRow`'s direction alone would not close this gap.
//
// DIRECTION A — THE THIRD QUADRANT (F-04, F-11..F-16). `selectScopedRow`'s own shape is ALSO
// needed here, and was missing: the web workbench sends `workspaceId=default` on every request,
// while a binding written by the delivery guide's §3 script (a bare POST carrying only
// `x-tenant-id`) lands on the `workspace_id IS NULL` row. #5471 fixed the external-system table for
// a non-null hint; the sibling scan above fixed the binding table for a NULL hint; the pairing
// (binding on the null row, caller with a non-null hint) read `null`, fell through to the deploy
// default, and 404'd the UI's dry-run while the script's own hint-less probe returned 200. Now a
// non-null hint that misses falls back ONCE to the SAME tenant's null row, annotated
// `matchedWorkspaceId: null, scopeFallback: 'tenant_null_row'`. The two directions never compose:
// a non-null hint reaches the null row and NOTHING else (never the sibling scan — F-07/F-12, and
// F-16 asserts `db.select` is not even called); the fallback query carries the caller's own
// `tenant_id` (F-13, and F-16 on the literal where-clause); the exact row still wins (F-11/F-14);
// and `set()` is not widened — a hint-carrying write lands on its own row (F-15).
//
// MUTATION EVIDENCE for direction A, both probed in memory and reverted:
//   * drop `tenant_id` from the fallback's where-clause -> F-13 and F-16 go red (another tenant's
//     null row is handed to this tenant);
//   * drop `workspace_id: null` from that where-clause (any workspace) -> F-07, F-12 and F-16 go
//     red (another workspace's single row is handed to a hint that never named it).
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
  // F-04 — DIRECTION A, THE THIRD QUADRANT. The binding sits on the `workspace_id IS NULL` row (the
  // delivery guide's §3 script shape: a bare POST with only `x-tenant-id`), and the caller carries
  // the UI's own `workspaceId=default` hint. Before this fallback the read was `null` and the
  // action fell through to the deploy default. (This case used to assert the opposite — that a
  // non-null miss stays null even with a null row present — which is exactly the hole being closed;
  // stock-preparation-source-binding.test.cjs's R-08 `ws_2` assertion flipped with it.)
  // -------------------------------------------------------------------------
  await run("F-04 a non-null hint miss falls back to the SAME tenant's null-workspace row, annotated", async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })

    const result = await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID })
    assert.ok(result, "the tenant-wide null row is offered to the 'default' hint")
    assert.equal(result.externalSystemId, 'sys_null_row')
    assert.equal(result.workspaceId, null, "rowToPublicBinding still names the row's own (null) workspace")
    assert.equal(result.matchedWorkspaceId, null, 'matchedWorkspaceId names the null row actually returned, not the hint')
    assert.equal(result.scopeFallback, 'tenant_null_row')
    assert.equal(db.calls.filter((call) => call.op === 'select').length, 0, 'direction A never reaches the sibling scan')
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

  // -------------------------------------------------------------------------
  // F-11 — direction A never shadows an exact hit: the 'default' row exists, the 'default' hint
  // reads it, and the result is NOT annotated as a fallback.
  // -------------------------------------------------------------------------
  await run("F-11 a 'default' hint with its own 'default' row is an exact hit, not a fallback", async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_default_row' })
    db.calls.length = 0

    const result = await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID })
    assert.ok(result)
    assert.equal(result.externalSystemId, 'sys_default_row')
    assert.equal(result.workspaceId, 'default')
    assert.equal(result.matchedWorkspaceId, 'default', 'an exact hit echoes the hint')
    assert.equal(result.scopeFallback, null, 'an exact hit is never reported as a fallback')
    const reads = db.calls.filter((call) => call.op === 'selectOne' && call.table === BINDING_TABLE)
    assert.equal(reads.length, 1, 'an exact hit issues exactly one lookup — the null row is never consulted')
  })

  // -------------------------------------------------------------------------
  // F-12 — direction A reaches the null row and NOTHING else. The only row is at 'ws_b' (another
  // NON-null workspace); the 'default' hint must not be handed it. Same fence as F-07, stated with
  // the UI's own hint. Dropping `workspace_id: null` from the fallback's where-clause turns this red.
  // -------------------------------------------------------------------------
  await run("F-12 a 'default' hint is never widened to another workspace's row when no null row exists", async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: 'ws_b', externalSystemId: 'sys_b' })

    assert.equal(
      await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID }),
      null,
      "'default' must never resolve to ws_b's binding — the null row is the only fallback target",
    )
    assert.equal(db.calls.filter((call) => call.op === 'select').length, 0, 'and the sibling scan is not consulted for a non-null hint')
  })

  // -------------------------------------------------------------------------
  // F-13 — TENANT ISOLATION on direction A. Tenant B's null row must never answer tenant A's hint.
  // Dropping `tenant_id` from the fallback's where-clause turns this red.
  // -------------------------------------------------------------------------
  await run("F-13 another tenant's null-workspace row never answers this tenant's 'default' hint", async () => {
    const { store } = newStore()
    await bind(store, { tenantId: 'tenant-b', workspaceId: null, externalSystemId: 'sys_tenant_b' })

    assert.equal(
      await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID }),
      null,
      "tenant-b's tenant-wide row does not leak into tenant-a's fallback",
    )
    // And the same with the SAME tenant but another action: the fallback is keyed on action_id too.
    await bind(store, { workspaceId: null, externalSystemId: 'sys_other_action', actionId: 'plm.other-action.v1' })
    assert.equal(
      await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID }),
      null,
      "another action's null row does not leak in either",
    )
  })

  // -------------------------------------------------------------------------
  // F-14 — PRECEDENCE with both rows present: the 'default' hint reads the 'default' row (exact),
  // the null hint reads the null row (exact); neither is reported as a fallback and neither reads
  // the other's row.
  // -------------------------------------------------------------------------
  await run("F-14 with both a null row and a 'default' row, each hint reads its own row exactly", async () => {
    const { store } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })
    await bind(store, { workspaceId: 'default', externalSystemId: 'sys_default_row' })

    const hinted = await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID })
    assert.equal(hinted.externalSystemId, 'sys_default_row', "the 'default' row wins for the 'default' hint")
    assert.equal(hinted.scopeFallback, null)
    assert.equal(hinted.matchedWorkspaceId, 'default')

    const hintless = await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.equal(hintless.externalSystemId, 'sys_null_row', 'the null row wins for the null hint')
    assert.equal(hintless.scopeFallback, null)
    assert.equal(hintless.matchedWorkspaceId, null)
  })

  // -------------------------------------------------------------------------
  // F-15 — THE WRITE PATH IS NOT WIDENED. A null row exists; a `set()` carrying the 'default' hint
  // must INSERT a 'default' row, not UPDATE the null row it would have read through the fallback.
  // Afterwards the 'default' hint is an exact hit on the new row and the null row is untouched.
  // -------------------------------------------------------------------------
  await run("F-15 set() with a 'default' hint writes the 'default' row and leaves the null row untouched", async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })
    const writesBefore = db.calls.filter((call) => call.op === 'insertOne' || call.op === 'updateRow').length

    const written = await store.set({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID, externalSystemId: 'sys_default_row', actor: 'u_admin' })
    assert.equal(written.previousExternalSystemId, null, 'the hinted write saw NO previous value — the null row is not its target')
    assert.equal(written.changed, true)
    assert.equal(written.binding.workspaceId, 'default')

    const writes = db.calls.slice(0).filter((call) => call.op === 'insertOne' || call.op === 'updateRow').slice(writesBefore)
    assert.deepEqual(writes.map((call) => call.op), ['insertOne'], 'a hinted first-bind INSERTS its own row rather than updating the null row')
    assert.equal(writes[0].row.workspace_id, 'default')

    const rows = db.rows.filter((row) => row.__table === BINDING_TABLE && row.tenant_id === TENANT && row.action_id === ACTION_ID)
    assert.equal(rows.length, 2, 'two rows now coexist under the COALESCE unique index')
    assert.equal(rows.find((row) => row.workspace_id === null).external_system_id, 'sys_null_row', 'the null row is byte-for-byte untouched')

    const hinted = await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID })
    assert.equal(hinted.externalSystemId, 'sys_default_row')
    assert.equal(hinted.scopeFallback, null, "after the write, the 'default' hint is an exact hit")
    const hintless = await store.get({ tenantId: TENANT, actionId: ACTION_ID })
    assert.equal(hintless.externalSystemId, 'sys_null_row', 'and the null hint still reads the null row')
  })

  // -------------------------------------------------------------------------
  // F-16 — THE LITERAL WHERE-CLAUSE of direction A, fenced structurally. The fallback must be one
  // `selectOne` at exactly (this tenant, workspace_id null, this action) and must not touch
  // `db.select` at all. A where-clause missing `tenant_id` (cross-tenant) or `workspace_id`
  // (cross-workspace) fails here on the recorded call, independently of any seeded data.
  // -------------------------------------------------------------------------
  await run('F-16 direction A is exactly one selectOne at (tenant, null, action) and never the sibling scan', async () => {
    const { store, db } = newStore()
    await bind(store, { workspaceId: null, externalSystemId: 'sys_null_row' })
    db.calls.length = 0

    await store.get({ tenantId: TENANT, workspaceId: 'default', actionId: ACTION_ID })

    const reads = db.calls.filter((call) => call.op === 'selectOne' && call.table === BINDING_TABLE)
    assert.equal(reads.length, 2, 'exact lookup, then exactly one fallback lookup')
    assert.deepEqual(reads[0].where, { tenant_id: TENANT, workspace_id: 'default', action_id: ACTION_ID })
    assert.deepEqual(
      reads[1].where,
      { tenant_id: TENANT, workspace_id: null, action_id: ACTION_ID },
      'the fallback carries the caller\'s tenant, a literal null workspace, and the action — nothing wider',
    )
    assert.equal(db.calls.filter((call) => call.op === 'select').length, 0, 'db.select (the sibling scan) is never reached for a non-null hint')
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
