'use strict'

// R-71 ⑦.4 PR-3 — THE PROJECT-SHEET REPAIR LEG ADDS THE FROZEN TEMPLATE'S MISSING COLUMNS, REPORT-FIRST.
//
// Why: the pull's existence probe refuses a sheet that lacks any frozen template column (422
// TARGET_SCHEMA_INCOMPLETE), so a template column merged after a project sheet was created stops that sheet's
// pull until the column exists there. The repair leg of `POST …/options/sync` with `projectNo` is the project
// sheets' heal path (D10 option c: project sheets via this route, the deployment table via the ops script).
//
// Hermetic: the shared project-sheet harness (REAL route stack, REAL registry store over a memory db, fake host
// provisioning with real per-object field sets). On top of it this suite gives the fake host the two ports every
// real host has: the per-field read (`getObjectField`) and an ATOMIC `runObjectFieldsRepairTransaction` that
// snapshots the fake host's objects and restores them when the callback throws (the real one is a DB
// transaction). Synthetic values only.
//
//   RC-01 REPORT (no flag, the pre-PR-3 call): the missing columns are REPORTED, never added; options + lock run as
//         before; the audit row carries the column counts (added 0).
//   RC-02 DRY-RUN CHANGES NOTHING: zero writes of any kind (no column, no option patch, no lock patch, no
//         transaction), no audit row; reports `wouldAddFieldIds` and the lock state. `addMissingColumns: true`
//         beside it changes nothing either.
//   RC-03 ADD: exactly the missing set is written in ONE host transaction, each added column is the one the create
//         path lands (name / type / property, its option set and PLM lock included — columns run FIRST), every
//         pre-existing column is byte-identical, no row is touched; the audit row says how many were added.
//   RC-04 IDEMPOTENT: a second add reports every column already present, adds 0, makes no column write call.
//   RC-05 FAIL-CLOSED AND ATOMIC: a concurrent writer (skipped-existing), a write that touches an existing column,
//         a column still missing after the write, and an untyped host failure each refuse with ONE typed code;
//         the sheet is restored byte for byte; no option patch, no lock patch, no audit row.
//   RC-06 THE PULL: 422 TARGET_SCHEMA_INCOMPLETE before the add, dry-run → apply writes rows after it.
//   RC-07 BODY: the two flags are exact booleans (anything else 400 with zero IO); `false` is the report call.
//   RC-08 OLDER HOSTS + WRONG SHEET: no transaction port → add is 503 with nothing written (report still works); no
//         existence read → `checked: false`; a registry row whose sheet id is not the object's sheet → 409.
//   RC-09 REFUSED BEFORE ANY IO: the overview, the deployment's env object, anything outside the stock-prep sandbox
//         namespace. Archived → 409 in every mode; switch off → 404 with zero IO.
//   RC-10 OWNERSHIP REFUSAL (review round 1): a template whose human column is NOT in the human whitelist (the two
//         authorities disagree — injected by reloading the route stack against a whitelist without that column):
//         the add is 422 REPAIR_HUMAN_FIELD_FORBIDDEN with ZERO additive writes, the sheet restored, no option or lock
//         patch, no audit row; the report and the dry-run list the column in `refusedFieldIds` and keep it out of
//         `wouldAddFieldIds`.
//   RC-11 A COMMITTED ADD IS AUDITED EVEN WHEN A LATER STEP FAILS (review round 1): the PLM lock patch fails after the
//         column transaction committed → the call fails (500; 422 for the option sync), the added columns stay, and ONE audit row records them
//         (`outcome: failed_after_columns_added`, `failedStep: plm_lock`, columnAddedCount 3). The same for the
//         option sync. Nothing added + a later failure → no row (unchanged). The healed retry writes its normal row.

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
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  deriveProjectSheetObjectId,
  reconcileProjectSheetTemplateColumns,
  HUMAN_WRITE_LOCK_PROPERTY_KEY,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))

const TENANT = 'tenant-repair-cols'
const PROJECT = 'PRJ-RC-COLS-1'
const PROJECT_B = 'PRJ-RC-COLS-2'
const STAGING = `${TENANT}:integration-core`
const TEMPLATE_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const OWNERSHIP = new Map(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, field.ownership]))
const DECISION_FIELD = 'lastPlmRefreshDecision'
const PLM_COLUMN = 'componentSpec'
const HUMAN_COLUMN = HUMAN_PRESERVED_FIELD_IDS.find((id) => OWNERSHIP.get(id) === 'human_preserved')
// The three columns a "sheet created before the template grew" lacks here, in TEMPLATE order (the report's order).
const DROPPED = TEMPLATE_IDS.filter((id) => id === PLM_COLUMN || id === HUMAN_COLUMN || id === DECISION_FIELD)

const PULLER = Object.freeze({ id: 'u_rc_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ADMIN = Object.freeze({ id: 'u_rc_admin', tenantId: TENANT, permissions: ['role:admin', 'integration:admin'] })

const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const OPTIONS_SYNC_PATH = '/api/integration/stock-preparation/options/sync'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'

const WRITE_CALLS = new Set(['ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureObject', 'ensureView', 'ensureObjectDefaultView', 'grantSheetRoleWrite', 'runObjectFieldsRepairTransaction'])

const tests = []
const test = (name, fn) => tests.push([name, fn])
const plain = (value) => JSON.parse(JSON.stringify(value))

function cloneObjects(objects, harness = projectSheet) {
  const out = new Map()
  for (const [key, object] of objects) {
    out.set(key, { ...object, fields: new Map([...object.fields].map(([id, field]) => [id, harness.clone(field)])) })
  }
  return out
}

/** The fake host's sheet as plain JSON (fields in insertion order), for byte-for-byte comparisons. */
function snapshotObject(object) {
  return JSON.stringify([...object.fields].map(([id, field]) => [id, field]))
}

/**
 * The harness plus the two ports a real host has. `h.tx.ensure` (when set) replaces the TRANSACTION-BOUND additive
 * write, so a suite can play a concurrent writer or a misbehaving host; a throw from the callback restores every
 * object the fake host holds, like a rolled-back transaction.
 */
function mount({ switchOn = true, txPort = true, readPort = true, harness = projectSheet } = {}) {
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn, fieldReads: readPort })
  h.harness = harness
  const p = h.provisioning
  h.tx = { ensure: null, count: 0 }
  if (txPort) {
    p.runObjectFieldsRepairTransaction = async (fn) => {
      p.calls.push(['runObjectFieldsRepairTransaction'])
      h.tx.count += 1
      const saved = cloneObjects(p.objects, harness)
      const surface = {
        findObjectSheet: (input) => p.findObjectSheet(input),
        resolveExistingObjectFieldIds: (input) => p.resolveExistingObjectFieldIds(input),
        readObjectFieldsContent: (input) => p.readObjectFieldsContent(input),
        ensureMissingObjectFields: (input) => (h.tx.ensure ? h.tx.ensure(input) : p.ensureMissingObjectFields(input)),
      }
      try {
        return await fn(surface)
      } catch (error) {
        p.objects.clear()
        for (const [key, object] of saved) p.objects.set(key, object)
        throw error
      }
    }
  }
  return h
}

const objectOf = (h, objectId) => h.provisioning.objects.get(`${STAGING}/${objectId}`)
const createTarget = (h, projectNo = PROJECT) => h.harness.call(h.routes, 'POST', CREATE_PATH, { user: PULLER, params: { projectNo }, body: {} })
const repair = (h, body, { user = ADMIN } = {}) => h.harness.call(h.routes, 'POST', OPTIONS_SYNC_PATH, { user, body, query: {} })
const writeCalls = (h) => h.provisioning.calls.filter((call) => WRITE_CALLS.has(call[0]))
const ensureCalls = (h) => h.provisioning.calls.filter((call) => call[0] === 'ensureMissingObjectFields')

/** A project sheet created through the REAL create route, then aged: the DROPPED columns removed. */
async function agedSheet(h, projectNo = PROJECT, dropped = DROPPED) {
  const created = await createTarget(h, projectNo)
  assert.equal(created.statusCode, 201, JSON.stringify(created.body))
  const objectId = deriveProjectSheetObjectId(TENANT, projectNo)
  const object = objectOf(h, objectId)
  for (const id of dropped) object.fields.delete(id)
  h.provisioning.calls.length = 0
  return { objectId, sheetId: created.body.data.sheetId || h.provisioning.sheetIdOf(STAGING, objectId), object }
}

async function pullDryRun(h, projectNo = PROJECT) {
  return projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
}

// ── RC-01 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-01 the report call (no flag) reports the missing columns and adds none; options + lock as before; audit counts', async () => {
  assert.ok(HUMAN_COLUMN, 'the template carries a whitelisted human column')
  assert.equal(DROPPED.length, 3)
  const h = mount()
  try {
    // The pre-PR-3 option sync needs the decision column, so this aged sheet keeps it and lacks the other two.
    const expectedMissing = DROPPED.filter((id) => id !== DECISION_FIELD)
    const { object } = await agedSheet(h, PROJECT, expectedMissing)
    const auditBefore = h.auditAppends.length
    const res = await repair(h, { projectNo: PROJECT })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(plain(res.body.data.columns), {
      mode: 'report',
      checked: true,
      templateFieldCount: TEMPLATE_IDS.length,
      alreadyPresent: TEMPLATE_IDS.length - expectedMissing.length,
      missingFieldIds: expectedMissing,
      wouldAddFieldIds: expectedMissing,
      addedFieldIds: [],
      added: 0,
      refusedFieldIds: [],
    })
    assert.deepEqual(ensureCalls(h), [], 'no column write')
    assert.equal(h.tx.count, 0, 'no repair transaction')
    for (const id of expectedMissing) assert.equal(object.fields.has(id), false, `${id} still absent`)
    assert.deepEqual(res.body.data.plmColumnLock, { marked: 0, alreadyMarked: 19, missing: 1 }, 'the lock leg ran as before (the missing PLM column is counted, not invented)')
    const appended = h.auditAppends.slice(auditBefore)
    assert.equal(appended.length, 1)
    assert.equal(appended[0].mode, 'contract_options_synced')
    assert.equal(appended[0].detail.columnMode, 'report')
    assert.equal(appended[0].detail.columnAddedCount, 0)
    assert.equal(appended[0].detail.columnMissingBeforeCount, 2)
    assert.equal(appended[0].detail.columnAlreadyPresentCount, TEMPLATE_IDS.length - 2)
    assert.equal(h.records.calls.length, 0, 'never a row')
  } finally { h.restore() }
})

// ── RC-02 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-02 dry-run changes nothing — no column, no patch, no transaction, no audit row — and reports what an add would add', async () => {
  const h = mount()
  try {
    const { objectId, sheetId, object } = await agedSheet(h)
    // Strip one lock too, so "would mark" is visible.
    delete object.fields.get('componentCode').property[HUMAN_WRITE_LOCK_PROPERTY_KEY]
    const before = snapshotObject(object)
    const auditBefore = h.auditAppends.length
    for (const body of [{ projectNo: PROJECT, dryRun: true }, { projectNo: PROJECT, dryRun: true, addMissingColumns: true }]) {
      h.provisioning.calls.length = 0
      const res = await repair(h, body)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(writeCalls(h), [], `zero writes: ${JSON.stringify(body)}`)
      assert.equal(snapshotObject(objectOf(h, objectId)), before, 'the sheet is byte-identical')
      assert.equal(h.auditAppends.length, auditBefore, 'no audit row for a dry-run')
      assert.deepEqual(plain(res.body.data), {
        ok: true,
        dryRun: true,
        projectNo: PROJECT,
        target: { sheetId, objectId },
        columns: {
          mode: 'dry_run',
          checked: true,
          templateFieldCount: TEMPLATE_IDS.length,
          alreadyPresent: TEMPLATE_IDS.length - DROPPED.length,
          missingFieldIds: DROPPED,
          wouldAddFieldIds: DROPPED,
          addedFieldIds: [],
          added: 0,
          refusedFieldIds: [],
        },
        plmColumnLock: { checked: true, alreadyMarked: 17, unmarked: 1, missing: 2 },
      })
    }
    assert.equal(h.records.calls.length, 0)
  } finally { h.restore() }
})

// ── RC-03 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-03 add writes exactly the missing set in one transaction, as the create path lands it; existing columns byte-identical; audited', async () => {
  const h = mount()
  try {
    const { objectId, object } = await agedSheet(h)
    // The reference: a sheet the create path lands today, with options and locks.
    assert.equal((await createTarget(h, PROJECT_B)).statusCode, 201)
    const reference = objectOf(h, deriveProjectSheetObjectId(TENANT, PROJECT_B))
    h.provisioning.calls.length = 0
    const existingBefore = JSON.stringify([...object.fields].filter(([id]) => id !== DECISION_FIELD).map(([id, f]) => [id, f]))
    const auditBefore = h.auditAppends.length
    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(plain(res.body.data.columns), {
      mode: 'add',
      checked: true,
      templateFieldCount: TEMPLATE_IDS.length,
      alreadyPresent: TEMPLATE_IDS.length - DROPPED.length,
      missingFieldIds: DROPPED,
      wouldAddFieldIds: [],
      addedFieldIds: DROPPED,
      added: DROPPED.length,
      refusedFieldIds: [],
    })
    assert.equal(h.tx.count, 1, 'ONE host transaction')
    assert.deepEqual(ensureCalls(h), [['ensureMissingObjectFields', objectId, DROPPED]], 'one additive write, the missing set only, at the registry row object')
    const first = h.provisioning.calls.findIndex((call) => call[0] === 'ensureMissingObjectFields')
    const firstPatch = h.provisioning.calls.findIndex((call) => call[0] === 'patchObjectFieldProperty')
    assert.ok(first >= 0 && first < firstPatch, 'columns FIRST, then options and lock')
    const after = objectOf(h, objectId)
    for (const id of DROPPED) {
      const added = after.fields.get(id)
      const ref = reference.fields.get(id)
      assert.ok(added, `${id} added`)
      assert.deepEqual([added.name, added.type, added.property], [ref.name, ref.type, ref.property], `${id} is the column the create path lands (options + lock included)`)
    }
    assert.equal(after.fields.get(PLM_COLUMN).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', 'the added PLM column is locked in the same call')
    assert.equal(after.fields.get(HUMAN_COLUMN).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], undefined, 'the added human column stays editable')
    assert.equal(
      JSON.stringify([...after.fields].filter(([id]) => !DROPPED.includes(id)).map(([id, f]) => [id, f])),
      existingBefore,
      'every pre-existing column is byte-identical',
    )
    assert.equal(after.fields.size, TEMPLATE_IDS.length)
    const appended = h.auditAppends.slice(auditBefore)
    assert.equal(appended.length, 1, 'ONE audit row')
    assert.equal(appended[0].mode, 'contract_options_synced')
    assert.deepEqual(
      [appended[0].detail.columnMode, appended[0].detail.columnAddedCount, appended[0].detail.columnMissingBeforeCount, appended[0].detail.columnAlreadyPresentCount, appended[0].detail.columnRefusedCount],
      ['add', 3, 3, TEMPLATE_IDS.length - 3, 0],
    )
    assert.equal(h.records.calls.length, 0, 'never a row')
  } finally { h.restore() }
})

// ── RC-04 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-04 idempotent: a second add reports every column already present, adds 0, makes no column write', async () => {
  const h = mount()
  try {
    const { objectId } = await agedSheet(h)
    assert.equal((await repair(h, { projectNo: PROJECT, addMissingColumns: true })).statusCode, 200)
    const settled = snapshotObject(objectOf(h, objectId))
    h.provisioning.calls.length = 0
    const auditBefore = h.auditAppends.length
    const again = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.columns.alreadyPresent, TEMPLATE_IDS.length)
    assert.equal(again.body.data.columns.added, 0)
    assert.deepEqual(plain(again.body.data.columns.missingFieldIds), [])
    assert.deepEqual(ensureCalls(h), [], 'no column write call on the second run')
    assert.deepEqual(again.body.data.plmColumnLock, { marked: 0, alreadyMarked: 20, missing: 0 })
    assert.equal(snapshotObject(objectOf(h, objectId)), settled, 'the sheet did not move')
    const appended = h.auditAppends.slice(auditBefore)
    assert.equal(appended.length, 1)
    assert.equal(appended[0].detail.columnAddedCount, 0)
    assert.equal(appended[0].detail.columnAlreadyPresentCount, TEMPLATE_IDS.length)
  } finally { h.restore() }
})

// ── RC-05 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-05 fail-closed and atomic: concurrent writer, a touched existing column, still-missing, host failure — one code each, sheet restored, nothing else written', async () => {
  const h = mount()
  try {
    const { objectId } = await agedSheet(h)
    const before = snapshotObject(objectOf(h, objectId))
    const p = h.provisioning
    const cases = [
      ['REPAIR_CONCURRENT_FIELD_APPEARED', 409, async (input) => {
        // A competitor landed the first missing column between our read and our write.
        const object = p.objects.get(`${input.projectId}/${input.objectId}`)
        object.fields.set(input.fields[0].id, { name: 'competitor', type: 'string', property: {}, order: 99 })
        return p.ensureMissingObjectFields(input)
      }],
      ['REPAIR_MUTATED_EXISTING_FIELD', 409, async (input) => {
        const result = await p.ensureMissingObjectFields(input)
        p.objects.get(`${input.projectId}/${input.objectId}`).fields.get('componentCode').name = 'renamed by the write'
        return result
      }],
      ['TEMPLATE_COLUMN_REPAIR_INCOMPLETE', 409, async (input) => p.ensureMissingObjectFields({ ...input, fields: input.fields.slice(1) })],
      ['STOCK_PREPARATION_PROJECT_TARGET_COLUMNS_REPAIR_FAILED', 500, async () => { throw new Error('synthetic host failure') }],
    ]
    for (const [code, status, ensure] of cases) {
      h.tx.ensure = ensure
      p.calls.length = 0
      const auditBefore = h.auditAppends.length
      const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(res.statusCode, status, `${code}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, code)
      assert.equal(snapshotObject(objectOf(h, objectId)), before, `${code}: the sheet is restored byte for byte`)
      assert.deepEqual(p.calls.filter((call) => call[0] === 'patchObjectFieldProperty'), [], `${code}: no option or lock patch`)
      assert.equal(h.auditAppends.length, auditBefore, `${code}: no audit row`)
      assert.deepEqual(Object.keys(plain(res.body.error.details || {})).sort().filter((key) => !['objectId', 'skippedExistingFieldCount', 'mutatedFieldCount', 'missingFieldCount'].includes(key)), [], `${code}: values-free details`)
    }
    // And the same request heals once the host behaves.
    h.tx.ensure = null
    const healed = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(healed.statusCode, 200, JSON.stringify(healed.body))
    assert.equal(healed.body.data.columns.added, DROPPED.length)
  } finally { h.restore() }
})

// ── RC-06 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-06 the pull: 422 TARGET_SCHEMA_INCOMPLETE before the add, dry-run → apply writes rows after it', async () => {
  const h = mount()
  try {
    await agedSheet(h)
    const blocked = await pullDryRun(h)
    assert.equal(blocked.statusCode, 422, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    const report = await repair(h, { projectNo: PROJECT, dryRun: true })
    assert.deepEqual(plain(report.body.data.columns.wouldAddFieldIds), DROPPED)
    assert.equal((await pullDryRun(h)).statusCode, 422, 'a dry-run repair heals nothing')
    assert.equal((await repair(h, { projectNo: PROJECT, addMissingColumns: true })).statusCode, 200)
    const dry = await pullDryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.equal(dry.body.data.canApply, true)
    const apply = await projectSheet.call(h.routes, 'POST', APPLY_PATH, {
      user: PULLER,
      params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
      body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: dry.body.data.dryRunToken } },
      query: { tenantId: TENANT },
    })
    assert.equal(apply.statusCode, 200, JSON.stringify(apply.body))
    assert.equal(apply.body.data.apply.counts.failed, 0, JSON.stringify(apply.body.data.apply))
    assert.ok(apply.body.data.apply.written >= 1)
  } finally { h.restore() }
})

// ── RC-07 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-07 the two flags are exact booleans: anything else is 400 with zero IO; false is the report call', async () => {
  const h = mount()
  try {
    const { object } = await agedSheet(h, PROJECT, DROPPED.filter((id) => id !== DECISION_FIELD))
    const before = snapshotObject(object)
    for (const [flag, value] of [['dryRun', 'true'], ['dryRun', 1], ['dryRun', null], ['dryRun', {}], ['addMissingColumns', 'true'], ['addMissingColumns', 1], ['addMissingColumns', []]]) {
      h.provisioning.calls.length = 0
      h.db.calls.length = 0
      const res = await repair(h, { projectNo: PROJECT, [flag]: value })
      assert.equal(res.statusCode, 400, `${flag}=${JSON.stringify(value)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID')
      assert.deepEqual(plain(res.body.error.details), { field: flag })
      assert.deepEqual(h.provisioning.calls, [], 'no host IO')
      assert.deepEqual(h.db.calls, [], 'no registry IO')
      assert.equal(snapshotObject(object), before)
    }
    h.provisioning.calls.length = 0
    const falses = await repair(h, { projectNo: PROJECT, dryRun: false, addMissingColumns: false })
    assert.equal(falses.statusCode, 200, JSON.stringify(falses.body))
    assert.equal(falses.body.data.columns.mode, 'report')
    assert.deepEqual(ensureCalls(h), [])
    assert.equal(falses.body.data.columns.added, 0)
    assert.equal(object.fields.has(PLM_COLUMN), false, 'false adds nothing')
  } finally { h.restore() }
})

// ── RC-08 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-08 older hosts and a wrong sheet: no transaction port → 503 nothing written; no existence read → checked false; sheet mismatch → 409', async () => {
  const noTx = mount({ txPort: false })
  try {
    const { objectId, object } = await agedSheet(noTx)
    const before = snapshotObject(object)
    const auditBefore = noTx.auditAppends.length
    const res = await repair(noTx, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TEMPLATE_COLUMN_REPAIR_API_UNAVAILABLE')
    assert.deepEqual(writeCalls(noTx), [])
    assert.equal(snapshotObject(objectOf(noTx, objectId)), before)
    assert.equal(noTx.auditAppends.length, auditBefore)
    const report = await repair(noTx, { projectNo: PROJECT, dryRun: true })
    assert.equal(report.statusCode, 200)
    assert.deepEqual(plain(report.body.data.columns.wouldAddFieldIds), DROPPED, 'the report still works without the transaction port')
  } finally { noTx.restore() }

  const noRead = mount()
  try {
    const { objectId } = await agedSheet(noRead)
    delete noRead.provisioning.resolveExistingObjectFieldIds
    const summary = await reconcileProjectSheetTemplateColumns({ provisioning: noRead.provisioning, projectId: STAGING, objectId, add: false })
    assert.equal(summary.checked, false)
    assert.equal(summary.alreadyPresent, null)
    assert.deepEqual(summary.missingFieldIds, [])
  } finally { noRead.restore() }

  const mismatch = mount()
  try {
    const { objectId, object } = await agedSheet(mismatch)
    mismatch.registryRows().find((row) => row.project_no === PROJECT).sheet_id = 'sheet_not_this_object'
    const before = snapshotObject(object)
    const res = await repair(mismatch, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TEMPLATE_COLUMN_REPAIR_SHEET_MISMATCH')
    assert.deepEqual(ensureCalls(mismatch), [])
    assert.equal(snapshotObject(objectOf(mismatch, objectId)), before)
  } finally { mismatch.restore() }
})

// ── RC-09 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-09 refused before any IO off the project-sheet namespace; archived 409 in every mode; switch off 404 with zero IO', async () => {
  const h = mount()
  try {
    h.provisioning.calls.length = 0
    for (const objectId of [STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE.objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, 'plm_stock_preparation_sandbox_', 'some_other_object', '', null, 42]) {
      for (const add of [false, true]) {
        await assert.rejects(
          reconcileProjectSheetTemplateColumns({ provisioning: h.provisioning, projectId: STAGING, objectId, add }),
          (error) => error.code === 'STOCK_PREPARATION_PROJECT_TARGET_COLUMNS_OBJECT_REFUSED',
          `${String(objectId)} add=${add}`,
        )
      }
    }
    assert.deepEqual(h.provisioning.calls, [], 'zero host IO for every refusal')

    const { objectId } = await agedSheet(h)
    const row = h.registryRows().find((entry) => entry.project_no === PROJECT)
    row.status = 'archived'
    row.archived_at = new Date('2026-10-10T00:00:00Z')
    const before = snapshotObject(objectOf(h, objectId))
    for (const body of [{ projectNo: PROJECT }, { projectNo: PROJECT, dryRun: true }, { projectNo: PROJECT, addMissingColumns: true }]) {
      h.provisioning.calls.length = 0
      const res = await repair(h, body)
      assert.equal(res.statusCode, 409, JSON.stringify(body))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
      assert.deepEqual(h.provisioning.calls, [], `archived: no host IO (${JSON.stringify(body)})`)
    }
    assert.equal(snapshotObject(objectOf(h, objectId)), before)
  } finally { h.restore() }

  const off = mount({ switchOn: false })
  try {
    off.seedRegistryRow(PROJECT)
    for (const body of [{ projectNo: PROJECT, dryRun: true }, { projectNo: PROJECT, addMissingColumns: true }]) {
      off.db.calls.length = 0
      off.provisioning.calls.length = 0
      const res = await repair(off, body)
      assert.equal(res.statusCode, 404)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
      assert.deepEqual(off.db.calls, [])
      assert.deepEqual(off.provisioning.calls, [])
    }
  } finally { off.restore() }
})

// ── RC-10 ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Loads a FRESH copy of the plugin lib and the project-sheet harness in which `HUMAN_PRESERVED_FIELD_IDS` lacks
 * `removedId` (the frozen template is untouched, so that column is human_preserved in the template and NOT
 * whitelisted — the disagreement `assertRepairableFieldOwnership` exists to refuse). Every module the swap could
 * reach is dropped from the require cache first and the original cache entries are put back afterwards, so no
 * other case (and no other suite in the chain) ever sees the patched whitelist.
 */
async function withWhitelistWithout(removedId, fn) {
  const Module = require('node:module')
  const libDir = path.resolve(LIB) + path.sep
  const supportDir = path.resolve(__dirname, 'support') + path.sep
  const templatesPath = require.resolve(path.join(LIB, 'stock-preparation-templates.cjs'))
  const ownedByTheSwap = (key) => key.startsWith(libDir) || key.startsWith(supportDir)
  const saved = Object.entries(require.cache).filter(([key]) => ownedByTheSwap(key))
  const original = require(templatesPath)
  assert.ok(original.HUMAN_PRESERVED_FIELD_IDS.includes(removedId), 'the column is whitelisted today')
  const dropOwned = () => { for (const key of Object.keys(require.cache)) if (ownedByTheSwap(key)) delete require.cache[key] }
  dropOwned()
  const patched = new Module(templatesPath, module)
  patched.filename = templatesPath
  patched.loaded = true
  patched.exports = { ...original, HUMAN_PRESERVED_FIELD_IDS: Object.freeze(original.HUMAN_PRESERVED_FIELD_IDS.filter((id) => id !== removedId)) }
  require.cache[templatesPath] = patched
  try {
    const harness = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
    const provisioningLib = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
    return await fn({ harness, provisioningLib })
  } finally {
    dropOwned()
    for (const [key, entry] of saved) require.cache[key] = entry
  }
}

test('RC-10 a human column the whitelist does not name: add is 422 REPAIR_HUMAN_FIELD_FORBIDDEN with zero writes; report and dry-run list it as refused, never as would-add', async () => {
  assert.equal(OWNERSHIP.get(HUMAN_COLUMN), 'human_preserved')
  await withWhitelistWithout(HUMAN_COLUMN, async ({ harness, provisioningLib }) => {
    // The swap reached the module under test (otherwise this case would prove nothing).
    assert.throws(
      () => provisioningLib.assertRepairableFieldOwnership({ fieldId: HUMAN_COLUMN, ownership: 'human_preserved', isWhitelisted: false, templateFieldIds: TEMPLATE_IDS, objectId: 'x' }),
      (error) => error.code === 'REPAIR_HUMAN_FIELD_FORBIDDEN',
    )
    const h = mount({ harness })
    try {
      const { objectId, object } = await agedSheet(h)
      const before = snapshotObject(object)
      const expectedWouldAdd = DROPPED.filter((id) => id !== HUMAN_COLUMN)

      // Add mode: refused as a whole, before any write — nothing half-added.
      const auditBefore = h.auditAppends.length
      const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(res.statusCode, 422, JSON.stringify(res.body))
      assert.equal(res.body.error.code, 'REPAIR_HUMAN_FIELD_FORBIDDEN')
      assert.deepEqual(plain(res.body.error.details), { objectId, fieldId: HUMAN_COLUMN }, 'logical ids only')
      assert.deepEqual(ensureCalls(h), [], 'ZERO additive writes')
      assert.equal(snapshotObject(objectOf(h, objectId)), before, 'the sheet is byte-identical')
      assert.deepEqual(h.provisioning.calls.filter((call) => call[0] === 'patchObjectFieldProperty'), [], 'no option or lock patch')
      assert.equal(h.auditAppends.length, auditBefore, 'no audit row for a refused add')

      // Dry-run: the refused column is reported as refused and is NOT something an add would add.
      h.provisioning.calls.length = 0
      const dry = await repair(h, { projectNo: PROJECT, dryRun: true })
      assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
      assert.deepEqual(plain(dry.body.data.columns.missingFieldIds), DROPPED)
      assert.deepEqual(plain(dry.body.data.columns.refusedFieldIds), [HUMAN_COLUMN])
      assert.deepEqual(plain(dry.body.data.columns.wouldAddFieldIds), expectedWouldAdd)
      assert.deepEqual(writeCalls(h), [], 'the dry-run still writes nothing')

      // Report (the plain call): the same verdict, and its audit row counts the refusal. The plain call's option
      // sync needs the decision column, so this sheet keeps it.
      const r = mount({ harness })
      try {
        const kept = DROPPED.filter((id) => id !== DECISION_FIELD)
        await agedSheet(r, PROJECT, kept)
        const rAuditBefore = r.auditAppends.length
        const report = await repair(r, { projectNo: PROJECT })
        assert.equal(report.statusCode, 200, JSON.stringify(report.body))
        assert.deepEqual(plain(report.body.data.columns.refusedFieldIds), [HUMAN_COLUMN])
        assert.deepEqual(plain(report.body.data.columns.wouldAddFieldIds), kept.filter((id) => id !== HUMAN_COLUMN))
        assert.deepEqual(ensureCalls(r), [], 'the report adds nothing')
        const appended = r.auditAppends.slice(rAuditBefore)
        assert.equal(appended.length, 1)
        assert.equal(appended[0].detail.columnRefusedCount, 1)
      } finally { r.restore() }
    } finally { h.restore() }
  })
  // And the swap is gone: the module the other cases use still whitelists the column.
  assert.ok(require(path.join(LIB, 'stock-preparation-templates.cjs')).HUMAN_PRESERVED_FIELD_IDS.includes(HUMAN_COLUMN))
})

// ── RC-11 ────────────────────────────────────────────────────────────────────────────────────────────

test('RC-11 a committed add is audited even when the option sync (422) or the PLM lock (500) fails after it; nothing added → no row; the healed retry audits normally', async () => {
  const lockPatch = (input) => Boolean(input && input.propertyPatch && Object.prototype.hasOwnProperty.call(input.propertyPatch, HUMAN_WRITE_LOCK_PROPERTY_KEY))
  for (const [step, failsOn, status] of [['plm_lock', lockPatch, 500], ['options', (input) => !lockPatch(input), 422]]) {
    const h = mount()
    try {
      const { objectId } = await agedSheet(h)
      const p = h.provisioning
      const realPatch = p.patchObjectFieldProperty
      p.patchObjectFieldProperty = async (input) => {
        if (failsOn(input)) throw new Error(`synthetic ${step} patch failure`)
        return realPatch(input)
      }
      const auditBefore = h.auditAppends.length
      const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(res.statusCode, status, `${step}: ${JSON.stringify(res.body)}`)
      for (const id of DROPPED) assert.ok(objectOf(h, objectId).fields.has(id), `${step}: ${id} stays (the column transaction committed)`)
      const appended = h.auditAppends.slice(auditBefore)
      assert.equal(appended.length, 1, `${step}: ONE audit row records the committed add`)
      assert.equal(appended[0].action, 'project_target_create')
      assert.equal(appended[0].mode, 'contract_options_synced')
      assert.equal(appended[0].subjectId, h.registryRows().find((row) => row.project_no === PROJECT).sheet_id)
      assert.deepEqual(plain(appended[0].detail), {
        objectId,
        outcome: 'failed_after_columns_added',
        failedStep: step,
        failureCode: res.body.error.code,
        columnMode: 'add',
        columnsChecked: true,
        templateColumnCount: TEMPLATE_IDS.length,
        columnAlreadyPresentCount: TEMPLATE_IDS.length - DROPPED.length,
        columnMissingBeforeCount: DROPPED.length,
        columnAddedCount: DROPPED.length,
        columnRefusedCount: 0,
      }, `${step}: counts only, values-free`)

      // Nothing to add + the same later failure → no row (the pre-PR-3 failure behaviour).
      const quiet = h.auditAppends.length
      const again = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(again.statusCode, status)
      assert.equal(again.body.data, undefined)
      assert.equal(h.auditAppends.length, quiet, `${step}: nothing added, no failure row`)

      // Healed: the normal row, with nothing more to add.
      p.patchObjectFieldProperty = realPatch
      const healed = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(healed.statusCode, 200, JSON.stringify(healed.body))
      const last = h.auditAppends[h.auditAppends.length - 1]
      assert.equal(last.detail.outcome, undefined, 'the success row is unchanged')
      assert.equal(last.detail.columnAddedCount, 0)
    } finally { h.restore() }
  }
})

runFailClosedSuite('stock-preparation-project-sheet-repair-columns.test.cjs', tests)
