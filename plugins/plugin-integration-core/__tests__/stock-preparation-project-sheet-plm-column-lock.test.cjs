'use strict'

// 一个项目一张备料表 — OPTION B (awaiting the owner's A/B/C ruling on #6079): the project sheet's PLM columns are
// read-only for PEOPLE. Field review on #6452 found project sheets are born with their plm_system columns
// (项目号 / 唯一键 / PLM 物料ID / BOM 路径 / 图号 / 名称 / 材料 / 用量 / 有效 / 刷新痕迹 …) editable; a range fill
// (1,000 cells, irreversible) over 唯一键 corrupts the identity the NEXT pull matches on.
//
// The HOST refuses the person writes (core-backend multitable/human-write-lock.ts; real-DB proof in
// tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts PB-01..08). THIS suite pins the plugin
// half, hermetically (the shared project-sheet harness: REAL route stack, REAL registry store over a memory db,
// fake host provisioning with real per-object field sets). Synthetic values only.
//
//   PL-01 CREATE marks exactly the template's plm_system columns of the NEW sheet (`humanWriteLock: 'plm_system'`,
//         one patch each, body exactly the lock), none of the human_preserved ones; response + audit carry counts.
//   PL-02 IDEMPOTENT with the host's read port: a re-provision writes nothing and reports `alreadyMarked`.
//   PL-03 A column the sheet does not have is COUNTED as missing and skipped — never invented, never fatal.
//   PL-04 REFUSED before any host call: the read-only overview, an id outside the stock-prep sandbox namespace,
//         a non-string id; a host without the field-metadata port is 503.
//   PL-05 A host failure part-way is ONE typed code naming the column; the retry finishes the rest.
//   PL-06 THE ROLLOUT (repair leg of POST …/options/sync with projectNo): a registered sheet created before the
//         lock gets marked at the REGISTRY ROW's object; audited with counts; a second call writes no lock again.
//   PL-07 THE PLUGIN STILL WRITES: dry-run → apply after the marking writes ≥ 1 row, and the rows it writes carry
//         plm_system columns (the apply path is the system writer the lock exists to keep).
//   PL-08 THE OVERVIEW IS UNAFFECTED: the create route provisions the overview, and no lock touches it.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const { runFailClosedSuite } = require(path.join(__dirname, 'support', 'fail-closed-suite-runner.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  provisionProjectSheet,
  markProjectSheetPlmSystemColumns,
  deriveProjectSheetObjectId,
  PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS,
  HUMAN_WRITE_LOCK_PROPERTY_KEY,
  HUMAN_WRITE_LOCK_PLM_SYSTEM,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))

const TENANT = 'tenant-plm-lock'
const PROJECT = 'PRJ-PLM-LOCK-1'
const PROJECT_B = 'PRJ-PLM-LOCK-2'
const STAGING = `${TENANT}:integration-core`
const PLM_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.ownership === 'plm_system').map((field) => field.id)
const HUMAN_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.ownership === 'human_preserved').map((field) => field.id)

const PULLER = Object.freeze({ id: 'u_plm_lock_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ADMIN = Object.freeze({ id: 'u_plm_lock_admin', tenantId: TENANT, permissions: ['role:admin', 'integration:admin'] })

const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const OPTIONS_SYNC_PATH = '/api/integration/stock-preparation/options/sync'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * Record every lock patch (body exactly `{ humanWriteLock: 'plm_system' }`) with its (objectId, fieldId), and
 * optionally give the fake host the `getObjectField` read port every real host has (plugin-scope.ts) — the harness
 * itself is left untouched so the other project-sheet suites keep their exact host call logs.
 */
function mount({ readPort = false, stampsSystemKind = false } = {}) {
  const h = projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, stampsSystemKind })
  h.lockPatches = []
  const real = h.provisioning.patchObjectFieldProperty
  h.provisioning.patchObjectFieldProperty = async (input = {}) => {
    const body = (input && input.propertyPatch) || {}
    if (Object.keys(body).length === 1 && body[HUMAN_WRITE_LOCK_PROPERTY_KEY] === HUMAN_WRITE_LOCK_PLM_SYSTEM) {
      h.lockPatches.push([input.objectId, input.fieldId])
    }
    return real.call(h.provisioning, input)
  }
  if (readPort) {
    h.provisioning.getObjectField = async ({ projectId, objectId, fieldId }) => {
      h.provisioning.calls.push(['getObjectField', objectId, fieldId])
      const object = h.provisioning.objects.get(`${projectId}/${objectId}`)
      const field = object && object.fields.get(fieldId)
      return field ? { id: `fld_${fieldId}`, property: projectSheet.clone(field.property || {}) } : null
    }
  }
  return h
}

const objectOf = (h, objectId) => h.provisioning.objects.get(`${STAGING}/${objectId}`)
const lockOf = (object, fieldId) => (object.fields.get(fieldId).property || {})[HUMAN_WRITE_LOCK_PROPERTY_KEY]
const createTarget = (h, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', CREATE_PATH, { user: PULLER, params: { projectNo }, body: {} })
const repair = (h, body) => projectSheet.call(h.routes, 'POST', OPTIONS_SYNC_PATH, { user: ADMIN, body, query: {} })

/** A sheet created BEFORE the lock existed: no column carries the marker. */
function stripLocks(object) {
  for (const field of object.fields.values()) {
    if (field.property) delete field.property[HUMAN_WRITE_LOCK_PROPERTY_KEY]
  }
}

// ── PL-01 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-01 create marks exactly the plm_system columns of THIS sheet, nothing human_preserved; counts in response + audit', async () => {
  const h = mount()
  try {
    assert.equal(PLM_IDS.length, 20, 'the frozen template carries 20 plm_system columns (13 human_preserved)')
    assert.equal(HUMAN_IDS.length, 13)
    assert.deepEqual(PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS, PLM_IDS, 'the lock list IS the template ownership band, in template order')
    const created = await createTarget(h)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
    assert.deepEqual(h.lockPatches, PLM_IDS.map((id) => [objectId, id]), 'one lock patch per plm_system column, on the new sheet only')
    const object = objectOf(h, objectId)
    for (const id of PLM_IDS) assert.equal(lockOf(object, id), 'plm_system', `${id} locked`)
    for (const id of HUMAN_IDS) assert.equal(lockOf(object, id), undefined, `${id} stays editable`)
    assert.deepEqual(created.body.data.plmColumnLock, { marked: 20, alreadyMarked: 0, missing: 0 })
    const createAudit = h.auditAppends.find((entry) => entry.mode === 'sheet_created')
    assert.ok(createAudit, 'the create audit row')
    assert.equal(createAudit.detail.plmLockMarkedFieldCount, 20)
    assert.equal(createAudit.detail.plmLockAlreadyMarkedFieldCount, 0)
    assert.equal(createAudit.detail.plmLockMissingFieldCount, 0)
  } finally { h.restore() }
})

// ── PL-02 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-02 idempotent with the host read port: a re-provision writes no lock and reports alreadyMarked', async () => {
  const h = mount({ readPort: true })
  try {
    const first = await provisionProjectSheet({ context: h.context, projectId: STAGING, tenantId: TENANT, projectNo: PROJECT_B, env: process.env })
    assert.deepEqual(plain(first.plmColumnLock), { fieldCount: 20, marked: 20, alreadyMarked: 0, missing: 0, readBeforeWrite: true, markedFieldIds: PLM_IDS })
    const patchesAfterFirst = h.lockPatches.length
    const second = await provisionProjectSheet({ context: h.context, projectId: STAGING, tenantId: TENANT, projectNo: PROJECT_B, env: process.env })
    assert.equal(second.created, false)
    assert.deepEqual(plain(second.plmColumnLock), { fieldCount: 20, marked: 0, alreadyMarked: 20, missing: 0, readBeforeWrite: true, markedFieldIds: [] })
    assert.equal(h.lockPatches.length, patchesAfterFirst, 'no lock write on the second call')
  } finally { h.restore() }
})

// ── PL-03 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-03 a column the sheet lacks is counted missing and skipped, never invented', async () => {
  const h = mount({ readPort: true })
  try {
    const { objectId } = h.seedRegistryRow(PROJECT)
    objectOf(h, objectId).fields.delete('componentSpec')
    const summary = await markProjectSheetPlmSystemColumns({ provisioning: h.provisioning, projectId: STAGING, objectId })
    assert.equal(summary.missing, 1)
    assert.equal(summary.marked, 19)
    assert.equal(objectOf(h, objectId).fields.has('componentSpec'), false, 'nothing created')
    assert.ok(!h.lockPatches.some(([, fieldId]) => fieldId === 'componentSpec'))
  } finally { h.restore() }
})

// ── PL-04 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-04 refused before any host call: the overview, outside the sandbox namespace, a non-string id; no port → 503', async () => {
  const h = mount({ readPort: true })
  try {
    h.provisioning.calls.length = 0
    for (const objectId of [STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE.objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, 'plm_stock_preparation_sandbox_', 'some_other_object', '', null, 42]) {
      await assert.rejects(
        markProjectSheetPlmSystemColumns({ provisioning: h.provisioning, projectId: STAGING, objectId }),
        (error) => error.code === 'STOCK_PREPARATION_PROJECT_TARGET_PLM_LOCK_OBJECT_REFUSED',
        String(objectId),
      )
    }
    assert.deepEqual(h.provisioning.calls, [], 'zero host IO for every refusal')
    assert.deepEqual(h.lockPatches, [])
    await assert.rejects(
      markProjectSheetPlmSystemColumns({ provisioning: {}, projectId: STAGING, objectId: deriveProjectSheetObjectId(TENANT, PROJECT) }),
      (error) => error.status === 503 && error.code === 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE',
    )
  } finally { h.restore() }
})

// ── PL-05 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-05 a host failure part-way is ONE typed code naming the column; the retry finishes the rest', async () => {
  const h = mount({ readPort: true })
  try {
    const { objectId } = h.seedRegistryRow(PROJECT)
    const real = h.provisioning.patchObjectFieldProperty
    let n = 0
    h.provisioning.patchObjectFieldProperty = async (input) => {
      n += 1
      if (n === 6) throw Object.assign(new Error('synthetic host refusal'), { code: 'SYNTHETIC_HOST_REFUSAL' })
      return real(input)
    }
    await assert.rejects(
      markProjectSheetPlmSystemColumns({ provisioning: h.provisioning, projectId: STAGING, objectId }),
      (error) => error.code === 'STOCK_PREPARATION_PROJECT_TARGET_PLM_LOCK_FAILED' && error.details.fieldId === PLM_IDS[5] && error.details.objectId === objectId,
    )
    h.provisioning.patchObjectFieldProperty = real
    const retried = await markProjectSheetPlmSystemColumns({ provisioning: h.provisioning, projectId: STAGING, objectId })
    assert.equal(retried.alreadyMarked, 5)
    assert.equal(retried.marked, 15)
    for (const id of PLM_IDS) assert.equal(lockOf(objectOf(h, objectId), id), 'plm_system', id)
  } finally { h.restore() }
})

// ── PL-06 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-06 the rollout: the repair leg marks a pre-lock registered sheet at the registry row\'s object, audited, then writes no lock again', async () => {
  const h = mount({ readPort: true })
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    stripLocks(objectOf(h, objectId))
    const auditBefore = h.auditAppends.length
    const res = await repair(h, { projectNo: PROJECT })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.plmColumnLock, { marked: 20, alreadyMarked: 0, missing: 0 })
    assert.deepEqual(h.lockPatches, PLM_IDS.map((id) => [objectId, id]))
    for (const id of PLM_IDS) assert.equal(lockOf(objectOf(h, objectId), id), 'plm_system', id)
    for (const id of HUMAN_IDS) assert.equal(lockOf(objectOf(h, objectId), id), undefined, id)
    const appended = h.auditAppends.slice(auditBefore)
    assert.equal(appended.length, 1, 'ONE audit row')
    assert.equal(appended[0].subjectId, sheetId)
    assert.equal(appended[0].mode, 'contract_options_synced')
    assert.equal(appended[0].detail.plmLockMarkedFieldCount, 20)
    assert.equal(appended[0].detail.plmLockAlreadyMarkedFieldCount, 0)
    assert.equal(appended[0].detail.plmLockMissingFieldCount, 0)

    h.lockPatches.length = 0
    const again = await repair(h, { projectNo: PROJECT })
    assert.equal(again.statusCode, 200)
    assert.deepEqual(again.body.data.plmColumnLock, { marked: 0, alreadyMarked: 20, missing: 0 })
    assert.deepEqual(h.lockPatches, [], 'the second rollout call writes no lock')
    assert.equal(h.records.calls.length, 0, 'the rollout touches no row — metadata only')
  } finally { h.restore() }
})

// ── PL-07 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-07 the plugin still writes: dry-run → apply after the marking writes ≥ 1 row carrying plm_system columns', async () => {
  const h = mount({ readPort: true })
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
    for (const id of PLM_IDS) assert.equal(lockOf(objectOf(h, objectId), id), 'plm_system')
    const dry = await projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.data.canApply, true)
    const apply = await projectSheet.call(h.routes, 'POST', APPLY_PATH, {
      user: PULLER,
      params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
      body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: dry.body.data.dryRunToken } },
      query: { tenantId: TENANT },
    })
    assert.equal(apply.statusCode, 200, JSON.stringify(apply.body))
    const result = apply.body.data.apply
    assert.equal(result.counts.failed, 0, JSON.stringify(result))
    assert.ok(result.written >= 1, 'at least one row written')
    const writes = h.records.calls.filter((call) => call[0] === 'createRecord' && call[1] === h.provisioning.sheetIdOf(STAGING, objectId))
    assert.ok(writes.length >= 1, 'the rows landed on the locked project sheet')
    const keyColumn = h.provisioning.getFieldId(STAGING, objectId, 'idempotencyKey')
    const sheetRows = await h.records.queryRecords({ sheetId: h.provisioning.sheetIdOf(STAGING, objectId) })
    assert.ok(sheetRows.length >= 1 && sheetRows.every((row) => typeof row.data[keyColumn] === 'string' && row.data[keyColumn]), 'every written row carries the locked unique key')
  } finally { h.restore() }
})

// ── PL-08 ────────────────────────────────────────────────────────────────────────────────────────────

test('PL-08 the read-only overview is unaffected: provisioned by the create route, never marked', async () => {
  const h = mount({ readPort: true, stampsSystemKind: true })
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    const overviewId = STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE.objectId
    const overview = objectOf(h, overviewId)
    assert.ok(overview, 'the create route provisioned the overview on this host')
    for (const field of overview.fields.values()) {
      assert.equal((field.property || {})[HUMAN_WRITE_LOCK_PROPERTY_KEY], undefined)
    }
    assert.ok(!h.lockPatches.some(([objectId]) => objectId === overviewId), 'no lock patch on the overview')
  } finally { h.restore() }
})

runFailClosedSuite('stock-preparation-project-sheet-plm-column-lock.test.cjs', tests)
