'use strict'

// 人工补充行 B4 — THE PER-SHEET SWITCH 「允许人工补充行」 (ADR adr-stock-prep-manual-rows-20261030 §4 / §5.3 / §8 「B4」;
// OQ6; register R-68), over the real route stack (support/stock-preparation-project-sheet-harness.cjs: the REAL
// registry store on a memory db with its real per-tenant lock, a host whose provisioning records every call and —
// opt-in here — offers the per-field read, the plugin's own durable storage).
//
//   MS-01 SWITCH OFF: GET / POST answer 404 DISABLED with ZERO IO for the admitted tiers; below ADMIN the gate refuses
//         first; only the EXACT literal 'true' turns the project-sheets switch on (every near miss is off, the host's
//         rule) — the same 404 the host answers a manual-row create with
//   MS-02 THE TIERS (OQ6): anonymous, a bare login, read-only, the floor operator, the 拉取人员 and the two orphan
//         grants are refused at the gate with ZERO IO, for both routes; stock-prep:admin and the platform admin read
//         AND set
//   MS-03 GET: an unregistered project → 200 `absent` with no host read; a registered one → the switch (allowed BY
//         DEFAULT), the PLM lock of the key column, the registry handles, `may.set` — exactly one host read, no write,
//         no audit row; an unlocked key column says `keyLocked: false`
//   MS-04 THE REMINDER (ADR §5.3): NO record = all zeros (status none, never an error); the record B1's own writer
//         persists is answered field for field, keyed by the REGISTRY row's sheet; a malformed record or an
//         unreadable store is 'unavailable' with null counts (never zeros), and the switch still answers
//   MS-05 THE STORED VALUE (ADR §4): absent → allowed (default); exactly 'allowed' → allowed (set); EVERY other present
//         value → disabled (set) — a junk value never reads as allowed
//   MS-06 THE REQUEST, PURE: a confirmation that does not repeat the path's number (missing / other / folded / prefix /
//         suffix / non-string / empty / null) → 400 CONFIRM_MISMATCH; a policy outside the two closed values → 400
//         POLICY_INVALID; an extra key or a malformed path number → 400 REQUEST_INVALID — ALL before any IO, and no
//         refusal echoes a value
//   MS-07 THE WRITE: disabled then allowed — each ONE one-key provisioning patch on the key column, read back, the
//         lock / the key stanza / every other key kept, ONE audit row (088 `project_fields_update`, mode
//         manual_rows_disabled / manual_rows_allowed, values-free detail); the same value again writes and audits
//         nothing; GET reads back what POST answered
//   MS-08 THE READ-BACK: a host whose patch drops the lock, flips the lock, drops the key stanza, ignores the value or
//         stores another one → 500 SWITCH_UNCONFIRMED naming the failed check, and NO audit row
//   MS-09 ARCHIVED: POST → 409 STOCK_PREPARATION_PROJECT_ARCHIVED with no field read, patch or audit row; GET still
//         answers (status archived, may.set false); an archive that commits between the route's read and its lock is
//         refused by the locked re-check in the same words
//   MS-10 THE TENANT WALL: an unregistered and another tenant's project are ABSENT here (GET 200 absent, POST 409);
//         a carried tenant contradicting the verified claim, a query steering to another tenant and a tenantless
//         platform admin are refused by the operator scope before the registry
//   MS-11 THE WIRING REFUSALS: a key column the sheet does not have → GET keyColumn missing / POST 409
//         KEY_COLUMN_MISSING; a host without the field-read port → 501 HOST_UNSUPPORTED; no audit store → 501 before
//         any IO; a database without 088's action → 503 before any read of the sheet
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PULL,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const manualRows = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))

const TENANT = 'tenant-mr-b4'
const OTHER_TENANT = 'tenant-mr-b4-foreign'
const PROJECT = 'PRJ-MR-B4-01'
const OTHER_PROJECT = 'PRJ-MR-B4-02'
const PATH = '/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'
const ARCHIVE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/archive'

const LOGGED_IN = Object.freeze({ id: 'u_mr_plain', tenantId: TENANT, permissions: [] })
const READ_ONLY = Object.freeze({ id: 'u_mr_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const FLOOR = Object.freeze({ id: 'u_mr_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const PULLER = Object.freeze({ id: 'u_mr_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const PULL_ORPHAN = Object.freeze({ id: 'u_mr_pull_orphan', tenantId: TENANT, permissions: [STOCK_PREP_PULL] })
const OPERATE_ORPHAN = Object.freeze({ id: 'u_mr_op_orphan', tenantId: TENANT, permissions: [STOCK_PREP_OPERATE] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_mr_wb', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_mr_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const TENANTLESS_PLATFORM_ADMIN = Object.freeze({ id: 'u_mr_root', roles: ['admin'], permissions: ['integration:admin'] })
const FOREIGN_ADMIN = Object.freeze({ id: 'u_mr_wb_foreign', tenantId: OTHER_TENANT, permissions: [STOCK_PREP_ADMIN] })

// The key column as a provisioned, locked project sheet carries it: the template stanza (the host's predicate (b) finds
// K by `stockPreparation.key === true`), the PLM human-write lock, the required rule — and no switch yet.
const KEY_PROPERTY = Object.freeze({
  stockPreparation: Object.freeze({ ownership: 'plm_system', key: true }),
  humanWriteLock: 'plm_system',
  validation: Object.freeze([Object.freeze({ type: 'required' })]),
})
const NO_RECORD = Object.freeze({
  status: 'none', at: null, mode: null, rowCount: 0, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [],
})
const UNAVAILABLE = Object.freeze({
  status: 'unavailable', at: null, mode: null, rowCount: null, unboundKeyCount: null, matchedManualCount: null, matchedManualRecordIds: [], unboundRecordIds: [],
})

const clone = (value) => JSON.parse(JSON.stringify(value))

function mount(options = {}) {
  return projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, fieldReads: true, ...options })
}

function keyField(h, objectId, tenant = TENANT) {
  const object = h.provisioning.objects.get(`${tenant}:integration-core/${objectId}`)
  assert.ok(object, 'the project sheet object exists on the host')
  return object.fields.get('idempotencyKey')
}

/** Register a project (sheet provisioned on the fake host) and give its key column `keyProperty`. Clears the call logs. */
function seed(h, { projectNo = PROJECT, archived = false, tenant = TENANT, keyProperty = KEY_PROPERTY } = {}) {
  const seeded = h.seedRegistryRow(projectNo, { archived, tenant })
  keyField(h, seeded.objectId, tenant).property = clone(keyProperty)
  return seeded
}

function read(h, user, { projectNo = PROJECT, query = { tenantId: TENANT }, authenticatedTenantId } = {}) {
  return projectSheet.call(h.routes, 'GET', PATH, {
    user, params: { projectNo }, query, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}),
  })
}

function setSwitch(h, user, policy, { projectNo = PROJECT, confirmProjectNo = projectNo, body, authenticatedTenantId } = {}) {
  return projectSheet.call(h.routes, 'POST', PATH, {
    user, params: { projectNo }, body: body || { confirmProjectNo, policy }, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}),
  })
}

function assertNoIo(h, label) {
  assert.deepEqual(h.db.calls, [], `${label}: no registry statement`)
  assert.deepEqual(h.provisioning.calls, [], `${label}: no host call`)
  assert.deepEqual(h.auditAppends, [], `${label}: no audit row`)
  assert.deepEqual(h.tenantDirectoryCalls, [], `${label}: not even the scope lookup`)
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('MS-01 switch OFF: 404 DISABLED with zero IO for the admitted tiers; below ADMIN the gate refuses first; only the exact literal is on', async () => {
  const h = mount({ switchOn: false })
  try {
    const { objectId } = seed(h)
    for (const user of [WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
      for (const [label, run] of [['GET', () => read(h, user)], ['POST', () => setSwitch(h, user, 'disabled')]]) {
        const res = await run()
        assert.equal(res.statusCode, 404, `${label} as ${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      }
    }
    for (const user of [FLOOR, READ_ONLY, PULLER]) {
      for (const run of [() => read(h, user), () => setSwitch(h, user, 'disabled')]) {
        const res = await run()
        assert.equal(res.statusCode, 403, `${user.id}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'FORBIDDEN')
      }
    }
    assertNoIo(h, 'switch off')
    assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY), 'the key column is untouched')
  } finally { h.restore() }

  // EXACT literal only — `stockPreparationProjectSheetsEnabled` (stock-preparation-project-targets.cjs), the rule the
  // host's manual-row create reads per request too (ADR §3.2 condition 5): a near miss is OFF on both sides.
  for (const value of [' true', 'true ', 'TRUE', 'True', '1', 'yes', 'on', '']) {
    const m = mount({ switchOn: false })
    try {
      process.env[PROJECT_SHEETS_ENABLED_ENV] = value
      seed(m)
      for (const run of [() => read(m, PLATFORM_ADMIN), () => setSwitch(m, PLATFORM_ADMIN, 'disabled')]) {
        const res = await run()
        assert.equal(res.statusCode, 404, `${JSON.stringify(value)}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      }
      assertNoIo(m, `switch ${JSON.stringify(value)}`)
    } finally { m.restore() }
  }
})

test('MS-02 the tiers (OQ6): every non-admin tier is refused at the gate with zero IO; stock-prep:admin and the platform admin read and set', async () => {
  for (const user of [undefined, LOGGED_IN, READ_ONLY, FLOOR, PULLER, PULL_ORPHAN, OPERATE_ORPHAN]) {
    const h = mount()
    try {
      const { objectId } = seed(h)
      for (const [label, run] of [['GET', () => read(h, user)], ['POST', () => setSwitch(h, user, 'disabled')]]) {
        const res = await run()
        assert.equal(res.statusCode, user ? 403 : 401, `${label} as ${user ? user.id : 'anonymous'}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, user ? 'FORBIDDEN' : 'UNAUTHENTICATED')
      }
      assertNoIo(h, `refused ${user ? user.id : 'anonymous'}`)
      assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY), 'the key column is untouched')
    } finally { h.restore() }
  }
  for (const user of [WORKBENCH_ADMIN, PLATFORM_ADMIN]) {
    const h = mount()
    try {
      const { objectId } = seed(h)
      const before = await read(h, user)
      assert.equal(before.statusCode, 200, JSON.stringify(before.body))
      assert.equal(before.body.data.policy, 'allowed')
      const set = await setSwitch(h, user, 'disabled')
      assert.equal(set.statusCode, 200, JSON.stringify(set.body))
      assert.equal(set.body.data.policy, 'disabled')
      assert.equal(keyField(h, objectId).property.stockPreparationManualRows, 'disabled')
      assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.mode, entry.actor]), [['project_fields_update', 'manual_rows_disabled', user.id]])
    } finally { h.restore() }
  }
})

test('MS-03 GET: absent → 200 absent, no host read; registered → the switch (allowed by default), the lock, the handles, may.set; one host read, no write, no audit', async () => {
  const h = mount()
  try {
    const absent = await read(h, WORKBENCH_ADMIN)
    assert.equal(absent.statusCode, 200, JSON.stringify(absent.body))
    assert.deepEqual(absent.body.data, {
      projectNo: PROJECT, status: 'absent', sheetId: null, viewId: null, keyColumn: null, policy: null, policySource: null, keyLocked: null, lastPull: null, may: { set: false },
    })
    assert.deepEqual(h.provisioning.calls, [], 'an unregistered project costs no host call')

    const { sheetId, objectId } = seed(h)
    const res = await read(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data, {
      projectNo: PROJECT,
      status: 'active',
      sheetId,
      viewId: h.provisioning.getObjectViewId(h.staging, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID),
      keyColumn: 'present',
      policy: 'allowed',
      policySource: 'default',
      keyLocked: true,
      lastPull: { ...NO_RECORD },
      may: { set: true },
    })
    assert.deepEqual(h.provisioning.calls, [['getObjectField', objectId, 'idempotencyKey']], 'exactly one host read — the key column of the REGISTRY row\'s object')
    assert.deepEqual(h.auditAppends, [], 'a read writes no audit row')
    assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY), 'a read writes nothing')

    // A key column that does not carry the PLM lock yet (an older registered sheet, OQ8 ④): said so.
    const { objectId: otherObjectId } = seed(h, { projectNo: OTHER_PROJECT, keyProperty: { stockPreparation: { ownership: 'plm_system', key: true } } })
    const unlocked = await read(h, WORKBENCH_ADMIN, { projectNo: OTHER_PROJECT })
    assert.equal(unlocked.statusCode, 200, JSON.stringify(unlocked.body))
    assert.equal(unlocked.body.data.keyLocked, false)
    assert.equal(unlocked.body.data.policy, 'allowed')
    assert.ok(h.provisioning.calls.some((call) => call[1] === otherObjectId), 'the other project reads its own object')
  } finally { h.restore() }
})

test('MS-04 the reminder: no record = all zeros; B1\'s record answered field for field, keyed by the registry sheet; malformed or unreadable = unavailable, never zeros', async () => {
  const h = mount()
  try {
    const { sheetId } = seed(h)
    let res = await read(h, WORKBENCH_ADMIN)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data.lastPull, { ...NO_RECORD }, 'NO record is all zeros (B1 interpretation 1), never an error')

    // Another sheet's record is not this sheet's.
    const summary = { rowCount: 3, unboundKeyCount: 2, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_b4_m1'], unboundRecordIds: ['rec_mr_b4_u1', 'rec_mr_b4_u2'] }
    assert.equal(await manualRows.persistManualRowsLastPull({ store: h.context.storage, sheetId: 'sheet_mr_b4_someone_else', mode: 'dry_run', at: '2026-10-30T01:02:03.000Z', summary }), true)
    res = await read(h, WORKBENCH_ADMIN)
    assert.deepEqual(res.body.data.lastPull, { ...NO_RECORD }, 'a record keyed by another sheet is not read')

    // B1's own writer, on THIS sheet.
    assert.equal(await manualRows.persistManualRowsLastPull({ store: h.context.storage, sheetId, mode: 'apply', at: '2026-10-30T04:05:06.000Z', summary }), true)
    res = await read(h, WORKBENCH_ADMIN)
    assert.deepEqual(res.body.data.lastPull, { status: 'recorded', at: '2026-10-30T04:05:06.000Z', mode: 'apply', ...summary })
    assert.equal(res.body.data.policy, 'allowed', 'the switch answers beside it')

    // A later pull with nothing to say overwrites the existing record with zeros (B1): recorded, all zeros.
    assert.equal(await manualRows.persistManualRowsLastPull({ store: h.context.storage, sheetId, mode: 'dry_run', at: '2026-10-30T07:08:09.000Z', summary: null }), true)
    res = await read(h, WORKBENCH_ADMIN)
    assert.deepEqual(res.body.data.lastPull, { ...NO_RECORD, status: 'recorded', at: '2026-10-30T07:08:09.000Z', mode: 'dry_run' })

    // Not the shape B1 writes → unavailable (null counts), never zeros; the switch still answers.
    const key = manualRows.manualRowsLastPullKey(sheetId)
    const valid = { at: '2026-10-30T04:05:06.000Z', mode: 'apply', ...summary }
    const malformed = [
      42, 'a text', [], true,
      { ...valid, rowCount: -1 }, { ...valid, unboundKeyCount: 1.5 }, { ...valid, matchedManualCount: '1' }, { ...valid, rowCount: undefined },
      { ...valid, mode: 'later' }, { ...valid, mode: undefined }, { ...valid, at: 'not a time' }, { ...valid, at: null },
      { ...valid, matchedManualRecordIds: [7] }, { ...valid, matchedManualRecordIds: [' '] }, { ...valid, unboundRecordIds: 'rec_mr_b4_u1' }, { ...valid, unboundRecordIds: undefined },
    ]
    for (const value of malformed) {
      h.context.storage.set(key, value)
      res = await read(h, WORKBENCH_ADMIN)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.data.lastPull, { ...UNAVAILABLE }, `malformed ${JSON.stringify(value)}`)
      assert.equal(res.body.data.policy, 'allowed')
    }

    // The id lists are capped at B1's limit even if a record carried more.
    const many = Array.from({ length: manualRows.MANUAL_SUPPLEMENT_ID_LIMIT + 7 }, (_, index) => `rec_mr_b4_${String(index).padStart(3, '0')}`)
    h.context.storage.set(key, { ...valid, matchedManualCount: many.length, rowCount: many.length, matchedManualRecordIds: many })
    res = await read(h, WORKBENCH_ADMIN)
    assert.equal(res.body.data.lastPull.status, 'recorded')
    assert.equal(res.body.data.lastPull.matchedManualRecordIds.length, manualRows.MANUAL_SUPPLEMENT_ID_LIMIT)

    // An unreadable store.
    const storage = h.context.storage
    const ownGet = storage.get
    storage.get = async () => { throw Object.assign(new Error('synthetic storage outage'), { code: 'SYNTHETIC_STORAGE_DOWN' }) }
    try {
      res = await read(h, WORKBENCH_ADMIN)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.data.lastPull, { ...UNAVAILABLE })
      assert.equal(res.body.data.policy, 'allowed')
      assert.ok(!JSON.stringify(res.body).includes('synthetic storage outage'), 'the store error never reaches the answer')
    } finally { storage.get = ownGet }
  } finally { h.restore() }
})

test('MS-05 the stored value: absent → allowed (default); exactly allowed → allowed (set); every other present value → disabled (set), never allowed', async () => {
  const JUNK = ['disabled', 'ALLOWED', 'Allowed', ' allowed', 'allowed ', 'allow', 'enabled', 'true', '', null, true, false, 0, 1, {}, [], ['allowed'], { value: 'allowed' }]
  for (const value of JUNK) {
    const h = mount()
    try {
      seed(h, { keyProperty: { ...KEY_PROPERTY, stockPreparationManualRows: value } })
      const res = await read(h, WORKBENCH_ADMIN)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.equal(res.body.data.policy, 'disabled', `stored ${JSON.stringify(value)} reads as disabled`)
      assert.equal(res.body.data.policySource, 'set')
    } finally { h.restore() }
  }
  for (const [property, policy, source] of [
    [{ ...KEY_PROPERTY, stockPreparationManualRows: 'allowed' }, 'allowed', 'set'],
    [{ ...KEY_PROPERTY }, 'allowed', 'default'],
  ]) {
    const h = mount()
    try {
      seed(h, { keyProperty: property })
      const res = await read(h, WORKBENCH_ADMIN)
      assert.equal(res.body.data.policy, policy)
      assert.equal(res.body.data.policySource, source)
    } finally { h.restore() }
  }
  // The pure reader takes a property as the host may store it — an object or JSON text — and agrees with itself.
  assert.equal(manualRows.manualRowsPolicyOfProperty(JSON.stringify({ stockPreparationManualRows: 'nope' })), 'disabled')
  assert.equal(manualRows.manualRowsPolicyOfProperty(JSON.stringify({ stockPreparationManualRows: 'allowed' })), 'allowed')
  assert.equal(manualRows.manualRowsPolicyOfProperty('{not json'), 'allowed', 'an unparseable property carries no switch')
  assert.equal(manualRows.manualRowsPolicyValueOf({ stockPreparationManualRows: undefined }), null, 'undefined is absent (JSON cannot store it)')
})

test('MS-06 the request, pure: confirmation / policy / allowlist / path refusals, all 400 before any IO, none echoing a value', async () => {
  const h = mount()
  try {
    const { objectId } = seed(h)
    seed(h, { projectNo: OTHER_PROJECT })
    h.db.calls.length = 0
    h.provisioning.calls.length = 0
    const confirmations = [undefined, OTHER_PROJECT, PROJECT.toLowerCase(), PROJECT.slice(0, -1), `${PROJECT}-X`, 7, '', null, [PROJECT]]
    for (const confirmProjectNo of confirmations) {
      const body = { policy: 'disabled', ...(confirmProjectNo === undefined ? {} : { confirmProjectNo }) }
      const res = await setSwitch(h, WORKBENCH_ADMIN, null, { body })
      assert.equal(res.statusCode, 400, `confirm ${JSON.stringify(confirmProjectNo)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH')
      assert.deepEqual({ ...res.body.error.details }, { field: 'confirmProjectNo' })
      assert.ok(!res.body.error.message.includes(PROJECT) && !res.body.error.message.includes(OTHER_PROJECT), 'the refusal echoes neither number')
    }
    // Trimmed the same way on both sides (the S4 rule): surrounding spaces still match.
    // (Asserted below with a real write in MS-07; here only the refusals.)
    for (const policy of [undefined, 'ALLOWED', 'Allowed', ' disabled', 'enabled', 'disable', 'on', true, null, 1, ['disabled'], { value: 'disabled' }]) {
      const body = { confirmProjectNo: PROJECT, ...(policy === undefined ? {} : { policy }) }
      const res = await setSwitch(h, WORKBENCH_ADMIN, null, { body })
      assert.equal(res.statusCode, 400, `policy ${JSON.stringify(policy)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREP_MANUAL_ROWS_POLICY_INVALID')
      assert.deepEqual({ ...res.body.error.details }, { field: 'policy' })
    }
    const extra = await setSwitch(h, WORKBENCH_ADMIN, null, { body: { confirmProjectNo: PROJECT, policy: 'disabled', tenantId: TENANT } })
    assert.equal(extra.statusCode, 400, JSON.stringify(extra.body))
    assert.equal(extra.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    assert.deepEqual({ ...extra.body.error.details }, { field: 'tenantId' })
    for (const badNo of ['PRJ MR B4', '-PRJ', 'PRJ?x', '']) {
      const res = await setSwitch(h, WORKBENCH_ADMIN, null, { projectNo: badNo, body: { confirmProjectNo: badNo, policy: 'disabled' } })
      assert.equal(res.statusCode, 400, `path ${JSON.stringify(badNo)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
      const got = await read(h, WORKBENCH_ADMIN, { projectNo: badNo })
      assert.equal(got.statusCode, 400, `GET path ${JSON.stringify(badNo)}`)
    }
    const unknownQuery = await read(h, WORKBENCH_ADMIN, { query: { projectNo: PROJECT } })
    assert.equal(unknownQuery.statusCode, 400)
    assert.equal(unknownQuery.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    assertNoIo(h, 'malformed requests')
    assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY), 'nothing was written')
  } finally { h.restore() }
})

test('MS-07 the write: one one-key patch on the key column, read back, lock / stanza / other keys kept, one audit row per write; the same value again does nothing', async () => {
  const h = mount()
  try {
    const { sheetId, objectId } = seed(h)
    const disabled = await setSwitch(h, WORKBENCH_ADMIN, 'disabled', { confirmProjectNo: `  ${PROJECT} ` })
    assert.equal(disabled.statusCode, 200, JSON.stringify(disabled.body))
    assert.deepEqual(disabled.body.data, {
      projectNo: PROJECT,
      status: 'active',
      sheetId,
      viewId: h.provisioning.getObjectViewId(h.staging, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID),
      keyColumn: 'present',
      policy: 'disabled',
      policySource: 'set',
      keyLocked: true,
      lastPull: { ...NO_RECORD },
      may: { set: true },
      written: true,
      changed: true,
    })
    // The host was asked exactly: read the key column, patch ONE key on it, read it back.
    assert.deepEqual(h.provisioning.calls, [
      ['getObjectField', objectId, 'idempotencyKey'],
      ['patchObjectFieldProperty', objectId, 'idempotencyKey'],
      ['getObjectField', objectId, 'idempotencyKey'],
    ])
    assert.deepEqual(keyField(h, objectId).property, { ...clone(KEY_PROPERTY), stockPreparationManualRows: 'disabled' }, 'the lock, the stanza and the rule kept; the switch set')
    assert.deepEqual(h.auditAppends, [{
      tenantId: TENANT,
      projectId: PROJECT,
      action: 'project_fields_update',
      subjectId: sheetId,
      mode: 'manual_rows_disabled',
      actor: WORKBENCH_ADMIN.id,
      detail: { objectId, fromPolicy: 'allowed', fromSource: 'default', toPolicy: 'disabled', confirmed: true },
    }])

    // GET reads back what POST answered.
    const after = await read(h, WORKBENCH_ADMIN)
    assert.equal(after.body.data.policy, 'disabled')
    assert.equal(after.body.data.policySource, 'set')

    h.provisioning.calls.length = 0
    const allowed = await setSwitch(h, PLATFORM_ADMIN, 'allowed')
    assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body))
    assert.equal(allowed.body.data.policy, 'allowed')
    assert.equal(allowed.body.data.policySource, 'set')
    assert.equal(allowed.body.data.written, true)
    assert.equal(allowed.body.data.changed, true)
    assert.equal(keyField(h, objectId).property.stockPreparationManualRows, 'allowed')
    assert.equal(keyField(h, objectId).property.humanWriteLock, 'plm_system')
    assert.deepEqual(h.auditAppends.map((entry) => [entry.mode, entry.actor, entry.detail.fromPolicy, entry.detail.fromSource, entry.detail.toPolicy]), [
      ['manual_rows_disabled', WORKBENCH_ADMIN.id, 'allowed', 'default', 'disabled'],
      ['manual_rows_allowed', PLATFORM_ADMIN.id, 'disabled', 'set', 'allowed'],
    ])

    // The same value again: read, no patch, no audit row.
    h.provisioning.calls.length = 0
    const again = await setSwitch(h, WORKBENCH_ADMIN, 'allowed')
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.written, false)
    assert.equal(again.body.data.changed, false)
    assert.deepEqual(h.provisioning.calls, [['getObjectField', objectId, 'idempotencyKey']], 'no second patch')
    assert.equal(h.auditAppends.length, 2, 'no audit row for a write that did not happen')

    // From the DEFAULT, setting 'allowed' makes it explicit: written, audited, but the effect did not change.
    const m = mount()
    try {
      seed(m)
      const explicit = await setSwitch(m, WORKBENCH_ADMIN, 'allowed')
      assert.equal(explicit.statusCode, 200, JSON.stringify(explicit.body))
      assert.equal(explicit.body.data.written, true)
      assert.equal(explicit.body.data.changed, false)
      assert.equal(explicit.body.data.policySource, 'set')
      assert.deepEqual(m.auditAppends.map((entry) => [entry.mode, entry.detail.fromSource]), [['manual_rows_allowed', 'default']])
    } finally { m.restore() }

    // A stored JUNK value (read as disabled) is replaced by the closed value asked for.
    const j = mount()
    try {
      const { objectId: junkObject } = seed(j, { keyProperty: { ...KEY_PROPERTY, stockPreparationManualRows: 'ALLOWED' } })
      const fixed = await setSwitch(j, WORKBENCH_ADMIN, 'allowed')
      assert.equal(fixed.statusCode, 200, JSON.stringify(fixed.body))
      assert.equal(fixed.body.data.changed, true)
      assert.equal(keyField(j, junkObject).property.stockPreparationManualRows, 'allowed')
      assert.deepEqual(j.auditAppends.map((entry) => [entry.detail.fromPolicy, entry.detail.fromSource, entry.detail.toPolicy]), [['disabled', 'set', 'allowed']])
    } finally { j.restore() }
  } finally { h.restore() }
})

test('MS-08 the read-back: a host that drops or flips the lock, drops the stanza, ignores the value, stores another or cannot be read back → the landed write is audited unconfirmed, then 500 SWITCH_UNCONFIRMED naming the check', async () => {
  // Each double MERGES the patch the way the host does (per key), then misbehaves in exactly one way.
  const cases = [
    ['lock', (merged) => { const { humanWriteLock: _dropped, ...rest } = merged; return rest }, 'disabled'],
    ['lock', (merged) => ({ ...merged, humanWriteLock: 'plm_system_x' }), 'disabled'],
    ['key_stanza', (merged) => { const { stockPreparation: _dropped, ...rest } = merged; return rest }, 'disabled'],
    ['key_stanza', (merged) => ({ ...merged, stockPreparation: { ownership: 'plm_system' } }), 'disabled'],
    ['policy', (merged) => { const { stockPreparationManualRows: _ignored, ...rest } = merged; return rest }, 'allowed'],
    ['policy', (merged) => ({ ...merged, stockPreparationManualRows: 'allowed' }), 'allowed'],
  ]
  for (const [check, misbehave, readBack] of cases) {
    const h = mount()
    try {
      const { sheetId, objectId } = seed(h)
      h.provisioning.patchObjectFieldProperty = async ({ objectId: patchedObject, fieldId, propertyPatch }) => {
        h.provisioning.calls.push(['patchObjectFieldProperty', patchedObject, fieldId])
        const field = keyField(h, patchedObject)
        field.property = misbehave({ ...clone(field.property), ...clone(propertyPatch) })
        return { id: fieldId, property: field.property }
      }
      const res = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
      assert.equal(res.statusCode, 500, `${check}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREP_MANUAL_ROWS_SWITCH_UNCONFIRMED')
      assert.deepEqual({ ...res.body.error.details }, { check }, `${check}: the failed check is named, nothing else`)
      assert.ok(h.provisioning.calls.some((call) => call[0] === 'patchObjectFieldProperty' && call[1] === objectId))
      // The patch LANDED, so it is audited — as unconfirmed, with what the read-back showed (OQ6: never unaudited).
      assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.mode, entry.subjectId, entry.detail]), [[
        'project_fields_update', 'manual_rows_disabled', sheetId,
        { objectId, fromPolicy: 'allowed', fromSource: 'default', toPolicy: readBack, confirmed: false },
      ]], `${check}: one unconfirmed audit row`)
    } finally { h.restore() }
  }

  // The read-back itself fails (the column cannot be read after the patch): audited `unreadable`, 500 'readback'.
  const h = mount()
  try {
    const { objectId } = seed(h)
    const ownRead = h.provisioning.getObjectField
    let reads = 0
    h.provisioning.getObjectField = async (input) => {
      reads += 1
      if (reads > 1) throw Object.assign(new Error('synthetic read-back outage'), { code: 'SYNTHETIC_READ_DOWN' })
      return ownRead.call(h.provisioning, input)
    }
    const res = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
    assert.equal(res.statusCode, 500, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREP_MANUAL_ROWS_SWITCH_UNCONFIRMED')
    assert.deepEqual({ ...res.body.error.details }, { check: 'readback' })
    assert.ok(!JSON.stringify(res.body).includes('synthetic read-back outage'), 'the host error never reaches the answer')
    assert.equal(keyField(h, objectId).property.stockPreparationManualRows, 'disabled', 'the patch landed')
    assert.deepEqual(h.auditAppends.map((entry) => [entry.mode, entry.detail.toPolicy, entry.detail.confirmed]), [['manual_rows_disabled', 'unreadable', false]])
  } finally { h.restore() }

  // A junk lock value is NO lock (the host's rule; its sanitizer drops it on any write): dropping it is not a change.
  const j = mount()
  try {
    const { objectId } = seed(j, { keyProperty: { ...KEY_PROPERTY, humanWriteLock: 'not_a_lock' } })
    j.provisioning.patchObjectFieldProperty = async ({ objectId: patchedObject, fieldId, propertyPatch }) => {
      j.provisioning.calls.push(['patchObjectFieldProperty', patchedObject, fieldId])
      const field = keyField(j, patchedObject)
      const { humanWriteLock: _junkDropped, ...kept } = { ...clone(field.property), ...clone(propertyPatch) }
      field.property = kept
      return { id: fieldId, property: field.property }
    }
    const res = await setSwitch(j, WORKBENCH_ADMIN, 'disabled')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.keyLocked, false)
    assert.equal(keyField(j, objectId).property.stockPreparationManualRows, 'disabled')
    assert.deepEqual(j.auditAppends.map((entry) => entry.detail.confirmed), [true])
  } finally { j.restore() }
})

test('MS-09 archived: POST 409 ARCHIVED with no field read / patch / audit; GET still answers; an archive committing between the read and the lock is refused by the locked re-check', async () => {
  const h = mount()
  try {
    const { objectId } = seed(h, { archived: true })
    const refused = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.deepEqual({ ...refused.body.error.details }, { field: 'projectNo' })
    assert.deepEqual(h.provisioning.calls, [], 'no field read, no patch')
    assert.deepEqual(h.auditAppends, [])
    assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY))
    const got = await read(h, WORKBENCH_ADMIN)
    assert.equal(got.statusCode, 200, JSON.stringify(got.body))
    assert.equal(got.body.data.status, 'archived')
    assert.equal(got.body.data.policy, 'allowed')
    assert.equal(got.body.data.may.set, false)
  } finally { h.restore() }

  // The race: the route's first registry read answers ACTIVE, a real archive (its own route) commits right after.
  const r = mount()
  try {
    const { objectId } = seed(r)
    const unlockedRead = r.db.selectOne
    let raced = false
    r.db.selectOne = async (table, where) => {
      const row = await unlockedRead.call(r.db, table, where)
      if (!raced && table === projectSheet.PROJECT_TARGET_TABLE && row && row.status === 'active') {
        raced = true
        const snapshot = { ...row }
        const archived = await projectSheet.call(r.routes, 'POST', ARCHIVE_PATH, { user: PULLER, params: { projectNo: PROJECT }, body: { confirmProjectNo: PROJECT } })
        assert.equal(archived.statusCode, 200, `the racing archive commits: ${JSON.stringify(archived.body)}`)
        return snapshot
      }
      return row
    }
    const res = await setSwitch(r, WORKBENCH_ADMIN, 'disabled')
    assert.ok(raced, 'the interleaving was forced')
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.deepEqual({ ...res.body.error.details }, { field: 'projectNo' })
    assert.ok(/manual-rows switch/.test(res.body.error.message), 'the refusal speaks about the switch, not about creating a sheet')
    assert.ok(!r.provisioning.calls.some((call) => call[0] === 'patchObjectFieldProperty' || call[0] === 'getObjectField'), 'nothing read or written on the sheet')
    assert.deepEqual(r.auditAppends.map((entry) => entry.action), ['project_target_archive'], 'only the archive is audited')
    assert.deepEqual(keyField(r, objectId).property, clone(KEY_PROPERTY))
  } finally { r.restore() }
})

test('MS-10 the tenant wall: unregistered / foreign projects are ABSENT; a contradicted claim, a steering query and a tenantless platform admin are refused by the scope', async () => {
  const h = mount()
  try {
    const foreign = seed(h, { projectNo: OTHER_PROJECT, tenant: OTHER_TENANT })
    for (const projectNo of [PROJECT, OTHER_PROJECT]) {
      const got = await read(h, WORKBENCH_ADMIN, { projectNo })
      assert.equal(got.statusCode, 200, JSON.stringify(got.body))
      assert.equal(got.body.data.status, 'absent', `${projectNo} is not this tenant's`)
      const set = await setSwitch(h, WORKBENCH_ADMIN, 'disabled', { projectNo })
      assert.equal(set.statusCode, 409, JSON.stringify(set.body))
      assert.equal(set.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    }
    assert.deepEqual(keyField(h, foreign.objectId, OTHER_TENANT).property, clone(KEY_PROPERTY), 'the other tenant\'s sheet is untouched')
    seed(h)
    h.db.calls.length = 0
    h.provisioning.calls.length = 0
    const refusals = [
      ['contradicted claim', () => read(h, WORKBENCH_ADMIN, { authenticatedTenantId: OTHER_TENANT }), 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
      ['contradicted claim (POST)', () => setSwitch(h, WORKBENCH_ADMIN, 'disabled', { authenticatedTenantId: OTHER_TENANT }), 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
      ['steering query', () => read(h, WORKBENCH_ADMIN, { query: { tenantId: OTHER_TENANT } }), 'OPERATOR_SCOPE_TENANT_MISMATCH'],
      ['tenantless platform admin', () => read(h, TENANTLESS_PLATFORM_ADMIN, { query: {} }), 'OPERATOR_SCOPE_TENANT_REQUIRED'],
      ['tenantless platform admin (POST)', () => setSwitch(h, TENANTLESS_PLATFORM_ADMIN, 'disabled'), 'OPERATOR_SCOPE_TENANT_REQUIRED'],
    ]
    for (const [label, run, code] of refusals) {
      const res = await run()
      assert.equal(res.statusCode, 403, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, code, label)
    }
    assert.deepEqual(h.db.calls, [], 'a scope refusal costs no registry statement')
    assert.deepEqual(h.provisioning.calls, [], 'a scope refusal costs no host call')
    assert.deepEqual(h.auditAppends, [])
    // The foreign tenant's own admin reaches its own project.
    const own = await read(h, FOREIGN_ADMIN, { projectNo: OTHER_PROJECT, query: { tenantId: OTHER_TENANT } })
    assert.equal(own.statusCode, 200, JSON.stringify(own.body))
    assert.equal(own.body.data.status, 'active')
  } finally { h.restore() }
})

test('MS-11 the wiring refusals: no key column, no field-read port, no audit store, no 088 vocabulary — each refused before any write', async () => {
  // A sheet without the key column: read says so, set is 409 with nothing written.
  let h = mount()
  try {
    const { objectId } = seed(h)
    h.provisioning.objects.get(`${h.staging}/${objectId}`).fields.delete('idempotencyKey')
    const got = await read(h, WORKBENCH_ADMIN)
    assert.equal(got.statusCode, 200, JSON.stringify(got.body))
    assert.equal(got.body.data.keyColumn, 'missing')
    assert.equal(got.body.data.policy, null)
    assert.equal(got.body.data.may.set, false)
    const set = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
    assert.equal(set.statusCode, 409, JSON.stringify(set.body))
    assert.equal(set.body.error.code, 'STOCK_PREP_MANUAL_ROWS_KEY_COLUMN_MISSING')
    assert.ok(!h.provisioning.calls.some((call) => call[0] === 'patchObjectFieldProperty'))
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }

  // A host without the per-field read port.
  h = mount({ fieldReads: false })
  try {
    seed(h)
    for (const run of [() => read(h, WORKBENCH_ADMIN), () => setSwitch(h, WORKBENCH_ADMIN, 'disabled')]) {
      const res = await run()
      assert.equal(res.statusCode, 501, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'STOCK_PREP_MANUAL_ROWS_HOST_UNSUPPORTED')
    }
    assert.ok(!h.provisioning.calls.some((call) => call[0] === 'patchObjectFieldProperty'))
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }

  // No audit store: refused before ANY IO (a switch nobody can audit is not flipped).
  h = mount()
  try {
    seed(h)
    h.services.stockPreparationAuditStore.append = undefined
    const res = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
    assertNoIo(h, 'no audit store')
  } finally { h.restore() }

  // A database without 088's action: 503 before the registry row or the sheet is read.
  h = mount()
  try {
    const { objectId } = seed(h)
    h.services.stockPreparationAuditStore.supportsAction = async () => ({ supported: false, reason: 'check_constraint_rejects' })
    const res = await setSwitch(h, WORKBENCH_ADMIN, 'disabled')
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
    assert.deepEqual(h.provisioning.calls, [], 'no field read or patch')
    assert.deepEqual(keyField(h, objectId).property, clone(KEY_PROPERTY))
  } finally { h.restore() }
})

// The fail-closed runner (support/fail-closed-suite-runner.cjs): the per-test loop, the exit sentinel and the per-test
// timeout — a hung test can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-manual-rows-switch-routes.test.cjs', tests, { passLine: '✓ stock-preparation-manual-rows-switch-routes' })
