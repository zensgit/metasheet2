'use strict'

// #3751 stock-prep MVP W5b (#3890) — values-free audit store. Covered:
//   (a) append happy path — row shape (snake_case columns, scoped table), returned id;
//   (b) closed action vocabulary — all 9 accepted, unknown refused 422 (never stored);
//   (c) tenantId required fail-closed;
//   (d) STRUCTURAL values-free gate — long strings, strings with spaces (drawing-number shaped),
//       URL-shaped strings, arrays, deep nesting all refused; the thrown error carries the offending
//       PATH only, never the value; enum-shaped scalars + numeric count maps pass;
//   (e) list — tenant/project/action filters, bounded limit clamp, public entry mapping, unknown
//       action filter refused.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  createStockPreparationAuditStore,
  StockPreparationAuditError,
  STOCK_PREP_AUDIT_ACTIONS,
  AUDIT_TABLE,
  __internals: { MAX_LIST_LIMIT },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-audit-store.cjs'))

const SECRET = 'SECRET W4B值 7f2/x'

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function makeDb() {
  const inserted = []
  const selects = []
  return {
    inserted,
    selects,
    async insertOne(table, row) {
      inserted.push({ table, row: { ...row } })
      return { ...row }
    },
    async select(table, options) {
      selects.push({ table, options })
      return inserted.filter((entry) => entry.table === table).map((entry) => ({ ...entry.row, created_at: 't0' }))
    },
  }
}

function newStore() {
  const db = makeDb()
  let seq = 0
  const store = createStockPreparationAuditStore({ db, idGenerator: () => `audit_${++seq}` })
  return { db, store }
}

async function expectAuditError(promise, code) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected an error')
  assert.ok(caught instanceof StockPreparationAuditError, `expected audit error, got ${caught && caught.name}`)
  assert.equal(caught.code, code)
  return caught
}

async function main() {
  await run('append writes a scoped snake_case row and returns the id', async () => {
    const { db, store } = newStore()
    const result = await store.append({
      tenantId: 'tenant_1',
      workspaceId: 'ws_1',
      projectId: 'proj_1',
      action: 'mapping_confirm',
      subjectId: 'stockprep_mapping_abc123',
      mode: 'confirmed',
      actor: 'user_admin_1',
      detail: { persisted: true },
    })
    assert.equal(result.id, 'audit_1')
    assert.equal(db.inserted.length, 1)
    const { table, row } = db.inserted[0]
    assert.equal(table, AUDIT_TABLE)
    assert.equal(row.tenant_id, 'tenant_1')
    assert.equal(row.project_id, 'proj_1')
    assert.equal(row.action, 'mapping_confirm')
    assert.equal(row.subject_id, 'stockprep_mapping_abc123')
    assert.equal(row.mode, 'confirmed')
    assert.equal(row.actor, 'user_admin_1')
    assert.deepEqual(row.detail, { persisted: true })
  })

  await run('every vocabulary action is accepted; an unknown action is refused and never stored', async () => {
    const { db, store } = newStore()
    for (const action of STOCK_PREP_AUDIT_ACTIONS) {
      await store.append({ tenantId: 'tenant_1', action, detail: { count: 1 } })
    }
    assert.equal(db.inserted.length, STOCK_PREP_AUDIT_ACTIONS.length)
    await expectAuditError(store.append({ tenantId: 'tenant_1', action: 'bogus_action' }), 'AUDIT_ACTION_INVALID')
    await expectAuditError(store.append({ tenantId: 'tenant_1' }), 'AUDIT_ACTION_INVALID')
    assert.equal(db.inserted.length, STOCK_PREP_AUDIT_ACTIONS.length, 'refused actions never reach the table')
  })

  await run('tenantId is required fail-closed', async () => {
    const { db, store } = newStore()
    await expectAuditError(store.append({ action: 'generation_run' }), 'AUDIT_CONFIG_INVALID')
    assert.equal(db.inserted.length, 0)
  })

  await run('structural values-free gate refuses unshaped values and never echoes them', async () => {
    const { db, store } = newStore()
    const base = { tenantId: 'tenant_1', action: 'generation_run' }
    for (const [label, detail] of [
      ['string with spaces (drawing-number shaped)', { note: SECRET }],
      ['overlong string', { token: 'x'.repeat(81) }],
      ['URL-shaped string', { endpoint: 'https://internal.example.com/x' }],
      ['array value', { list: ['a', 'b'] }],
      ['deep nesting', { outer: { inner: { deep: 1 } } }],
      ['nested non-numeric', { counts: { open: 'many' } }],
      ['non-object detail', 'just-a-string'],
      ['unshaped KEY', { [`bad key ${SECRET}`]: 1 }],
      ['NaN number', { count: NaN }],
      ['Infinity number', { count: Infinity }],
      ['negative Infinity nested', { counts: { open: -Infinity } }],
    ]) {
      const error = await expectAuditError(store.append({ ...base, detail }), label === 'non-object detail' ? 'AUDIT_DETAIL_INVALID' : 'AUDIT_DETAIL_INVALID')
      assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes(SECRET), `${label}: error must not echo the value`)
    }
    assert.equal(db.inserted.length, 0, 'nothing unshaped ever reaches the table')
    // shaped payloads pass: enum scalars, booleans, numbers, one-level numeric count maps.
    await store.append({ ...base, detail: { status: 'partial', ready: false, linesCreated: 3, byType: { missing_mapping: 2, unit_missing: 1 } } })
    assert.equal(db.inserted.length, 1)
  })

  // WHICH COLUMNS THE SHAPE GATE MAY GOVERN — and why applying it to the rest was a fail-closed bug.
  //
  // The gate exists so a values-free trail stays values-free. But a shape gate is only safe on a
  // column whose contents the SERVER generates. Round 2 of this PR applied it to all five nullable
  // TEXT columns, including the two that carry CALLER and CUSTOMER data, and that turned a
  // values-free guarantee into an availability bug in two directions:
  //
  //   * project_id is where the export route stamps the customer's own projectNo — deliberately,
  //     it is that route's subject. A customer whose project numbers contain a Chinese character, a
  //     space or a slash is not exotic; with the gate on that column their export 422s. The workbook
  //     they came for is refused to protect a trail from a value the trail is SUPPOSED to carry.
  //   * eight write routes append AFTER their effect. A 422 there does not prevent anything — the
  //     write already happened — it only destroys the audit row that was supposed to record it. The
  //     gate would convert "audited write" into "unaudited write plus an error", which is strictly
  //     worse than the thing it was guarding against.
  //
  // So the gate is confined to the columns the SERVER controls and that are closed by construction:
  // `mode` (a closed enum, chosen from a frozen set in code) and `subject_id` (a content handle).
  // `project_id`, `workspace_id` and `actor` go back to `optionalString`. The values-free property
  // for those is kept where it belongs and where it can be kept without refusing real work — AT THE
  // ROUTES, which no longer forward a caller's raw `?workspaceId` at all.
  await run('the shape gate governs the SERVER-generated columns, and only those', async () => {
    const { db, store } = newStore()
    const base = { tenantId: 'tenant_1', action: 'generation_run' }

    // GATED: mode and subject_id. Both are server-chosen, so a non-conforming value is a bug in this
    // repository, not a customer's data — fail closed, name the column, never echo the value.
    for (const column of ['subjectId', 'mode']) {
      const error = await expectAuditError(store.append({ ...base, [column]: SECRET }), 'AUDIT_FIELD_INVALID')
      assert.ok(
        !JSON.stringify(error.details || {}).includes(SECRET),
        `${column}: the refusal must name the column, never echo the value`,
      )
      assert.equal(error.details && error.details.field, column, `${column}: the offending column is named`)
      await expectAuditError(store.append({ ...base, [column]: 'x'.repeat(81) }), 'AUDIT_FIELD_INVALID')
      await expectAuditError(store.append({ ...base, [column]: 'has space' }), 'AUDIT_FIELD_INVALID')
    }
    assert.equal(db.inserted.length, 0, 'a refused server-generated value never reaches the table')

    // NOT GATED: the columns that carry caller/customer data. A free-text projectNo is exactly what
    // the export route stamps, and refusing it would refuse the export.
    for (const [column, value] of [
      ['projectId', '注射水缓冲罐 / RY2-2023'],
      ['workspaceId', 'my workspace (2026)'],
      ['actor', 'ops.lead+beiliao@example.com'],
      ['actor', '张三'],
    ]) {
      const before = db.inserted.length
      await store.append({ ...base, [column]: value })
      assert.equal(
        db.inserted.length,
        before + 1,
        `${column}: a caller/customer value must be STORED, not refused — the gate here would only `
        + 'destroy the audit row of work that already happened',
      )
      const row = db.inserted[db.inserted.length - 1].row
      const stored = column === 'projectId' ? row.project_id : (column === 'workspaceId' ? row.workspace_id : row.actor)
      assert.equal(stored, value, `${column}: stored verbatim`)
    }

    // And the shapes real call sites pass still go through.
    await store.append({
      ...base,
      workspaceId: 'workspace-default',
      projectId: 'tenant_1:integration-core',
      subjectId: 'sha16:0000000000000001',
      mode: 'created',
      actor: 'ops.lead@example.com',
    })
    await store.append({ ...base })
  })

  await run('list filters by tenant/action/project, clamps limit, and maps public entries', async () => {
    const { db, store } = newStore()
    await store.append({ tenantId: 'tenant_1', projectId: 'proj_1', action: 'unit_confirm', subjectId: 'rule_1', mode: 'created', actor: 'user_admin_1', detail: { persisted: true } })
    const result = await store.list({ tenantId: 'tenant_1', projectId: 'proj_1', action: 'unit_confirm', limit: 99999 })
    assert.equal(result.rowCount, 1)
    const entry = result.entries[0]
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['action', 'actor', 'createdAt', 'detail', 'id', 'mode', 'projectId', 'subjectId', 'tenantId', 'workspaceId'],
    )
    assert.equal(entry.action, 'unit_confirm')
    const call = db.selects[0]
    assert.equal(call.table, AUDIT_TABLE)
    assert.deepEqual(call.options.where, { tenant_id: 'tenant_1', action: 'unit_confirm', project_id: 'proj_1' })
    // NIT (review #4029): workspaceId is a real filter, not a dead allowlist key.
    await store.list({ tenantId: 'tenant_1', workspaceId: 'ws_9' })
    assert.deepEqual(db.selects[1].options.where, { tenant_id: 'tenant_1', workspace_id: 'ws_9' })
    assert.equal(call.options.limit, MAX_LIST_LIMIT, 'limit clamps to the bound')
    await expectAuditError(store.list({ tenantId: 'tenant_1', action: 'bogus' }), 'AUDIT_ACTION_INVALID')
    await expectAuditError(store.list({}), 'AUDIT_CONFIG_INVALID')
  })

  const total = passed + failed
  console.log(`\nstock-preparation-audit-store: ${passed}/${total} passed`)
  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-audit-store')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
