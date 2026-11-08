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
//         (fix round 2: the plm_lock leg strips the lock off one OLDER PLM column, the only way the lock step can
//         still have a patch to fail on now that an added PLM column is inserted locked; the added ones stay locked.)
//   RC-12 THE LOCK RIDES THE INSERT (Y7 review MEDIUM-1): the additive INSERT of a re-added plm_system column carries
//         humanWriteLock 'plm_system', a re-added human column does not; the later lock step patches none of them;
//         when the step after the add fails, the added PLM columns are STILL locked and the dry-run says unmarked 0.
//   RC-13a-d NOT ON THE OTHER PATHS (Y7 review MEDIUM-1, negative): the shared reconcile helper called WITHOUT the flag,
//         the canonical repair verb, the descriptor builder the ops script uses, and the deployment (MVP) repair
//         insert no humanWriteLock at all.
//   RC-14 AFTER EVERY EXISTING COLUMN (Y7 review MEDIUM-2): on a sheet whose last template columns are missing and
//         which carries an ext_ column, a RIGHT-side pull-batch band and a person-created column, the re-added
//         columns land strictly after every existing column (max + 1 + i, template order), no order collides, no
//         existing order moves; a second run adds nothing and moves nothing.
//   RC-15 LEFT-SIDE BAND (Y7 review MEDIUM-2): band at −2 / −1 keeps its place, the re-added columns go after the
//         current max.
//   RC-17 THE GATE IS THE PLATFORM/INTEGRATION ADMIN TIER: the route's requireAccess(req, 'admin') admits role:admin or
//         integration:admin only; a holder of the whole stock-prep vocabulary (stock-prep:admin included) is 403 in
//         every mode with zero host calls.
//   RC-16 OLDER HOST / BAD READ (Y7 review MEDIUM-2): a repair transaction without readObjectMaxFieldOrder → 503 with
//         nothing written and no audit row (a nothing-missing run still answers 200); a non-integer max → 500,
//         nothing written.
//   RC-18 THE UPGRADE ORDER FOR THE TWO PR-4 COLUMNS (R-71 ⑦.4 PR-4; was Y8's RC-12 before the Y7 merge): a sheet
//         without issueConfirmDate / projectSpecModel → pull 422, nothing written → ONE repair adds both, their
//         INSERT already carrying the PLM lock (no later lock patch on either) → the pull writes rows carrying neither.
//   RC-19 THE WINDOW BEFORE THE REPAIR (R-71 ⑦.4 PR-4; was Y8's RC-13): pull 422 naming exactly the two columns;
//         export, archive and restore answer 200 with no host write.
//   RC-20 THE TWO PR-4 COLUMNS UNDER R-89: template positions stay 33 / 34, but where a right-side band (with or
//         without an ext_ column) already holds 33 / 34 the repair appends them at max + 1 / max + 2 (35 / 36 and
//         36 / 37), locked on INSERT, no order tie, no existing order moved.

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
// RC-11: a PLM column the aged sheet KEEPS (never dropped), playing a column from before the lock existed.
const OLDER_UNLOCKED_PLM_COLUMN = 'material'
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
function mount({ switchOn = true, txPort = true, readPort = true, maxOrderPort = true, harness = projectSheet, serviceExtras = {} } = {}) {
  const h = harness.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn, fieldReads: readPort, serviceExtras })
  h.harness = harness
  const p = h.provisioning
  h.tx = { ensure: null, count: 0, maxOrder: null }
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
        // Y7 review MEDIUM-2: the largest order over EVERY field of the object (the real host: MAX("order") over
        // meta_fields of the sheet). `h.tx.maxOrder` (when set) replaces it, to play a misbehaving host.
        ...(maxOrderPort ? {
          readObjectMaxFieldOrder: async ({ projectId, objectId }) => {
            p.calls.push(['readObjectMaxFieldOrder', objectId])
            if (h.tx.maxOrder) return h.tx.maxOrder({ projectId, objectId })
            const object = p.objects.get(`${projectId}/${objectId}`)
            const orders = object ? [...object.fields.values()].map((field) => field.order) : []
            return orders.length ? Math.max(...orders) : null
          },
        } : {}),
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
    assert.deepEqual(res.body.data.plmColumnLock, { marked: 0, alreadyMarked: 21, missing: 1 }, 'the lock leg ran as before (the missing PLM column is counted, not invented)')
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
        plmColumnLock: { checked: true, alreadyMarked: 19, unmarked: 1, missing: 2 },
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
    assert.deepEqual(again.body.data.plmColumnLock, { marked: 0, alreadyMarked: 22, missing: 0 })
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
      const { objectId, object } = await agedSheet(h)
      // An OLDER PLM column from before the lock existed: the lock step's only patch, so it has something to fail on.
      if (step === 'plm_lock') delete object.fields.get(OLDER_UNLOCKED_PLM_COLUMN).property[HUMAN_WRITE_LOCK_PROPERTY_KEY]
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
      for (const id of DROPPED.filter((fieldId) => OWNERSHIP.get(fieldId) === 'plm_system')) {
        assert.equal(objectOf(h, objectId).fields.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `${step}: the added PLM column ${id} is locked although the ${step} step failed`)
      }
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

// ── RC-12 ────────────────────────────────────────────────────────────────────────────────────────────

const PLM_DROPPED = DROPPED.filter((id) => OWNERSHIP.get(id) === 'plm_system')
// Derived, not a literal: a later template column (Y8) changes the count, not these assertions.
const PLM_COLUMN_COUNT = TEMPLATE_IDS.filter((id) => OWNERSHIP.get(id) === 'plm_system').length
const HUMAN_DROPPED = DROPPED.filter((id) => OWNERSHIP.get(id) !== 'plm_system')

/** Wrap the transaction-bound additive write so a suite sees exactly the descriptors the INSERT receives. */
function captureInsert(h) {
  const inserted = []
  h.tx.ensure = async (input) => {
    inserted.push(plain(input.fields))
    return h.provisioning.ensureMissingObjectFields(input)
  }
  return inserted
}

test('RC-12 the INSERT of a re-added plm_system column carries the lock (a human one does not); the later lock step patches none of them; a failing later step leaves them locked and the dry-run says unmarked 0', async () => {
  assert.ok(PLM_DROPPED.length >= 1 && HUMAN_DROPPED.length >= 1, 'the dropped set mixes PLM and human columns')
  const h = mount()
  try {
    await agedSheet(h)
    const inserted = captureInsert(h)
    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(inserted.length, 1, 'one additive write')
    const byId = new Map(inserted[0].map((field) => [field.id, field]))
    for (const id of PLM_DROPPED) assert.equal(byId.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `the INSERT of ${id} carries the lock`)
    for (const id of HUMAN_DROPPED) assert.equal(Object.prototype.hasOwnProperty.call(byId.get(id).property || {}, HUMAN_WRITE_LOCK_PROPERTY_KEY), false, `the INSERT of the human column ${id} carries no lock`)
    assert.deepEqual(plain(res.body.data.plmColumnLock), { marked: 0, alreadyMarked: PLM_COLUMN_COUNT, missing: 0 }, 'the lock step found every added PLM column already marked')
    const lockPatches = h.provisioning.calls.filter((call) => call[0] === 'patchObjectFieldProperty' && PLM_DROPPED.includes(call[2]) && call[2] !== DECISION_FIELD)
    assert.deepEqual(lockPatches, [], 'no lock patch on an added PLM column')
    const appended = h.auditAppends[h.auditAppends.length - 1]
    assert.equal(appended.detail.plmLockMarkedFieldCount, 0, 'no double count of a column the INSERT already locked')
    assert.equal(appended.detail.plmLockAlreadyMarkedFieldCount, PLM_COLUMN_COUNT)
  } finally { h.restore() }

  // The failure case: the option sync after the add fails (422). The added PLM columns are still locked.
  const f = mount()
  try {
    const { objectId } = await agedSheet(f)
    const p = f.provisioning
    const realPatch = p.patchObjectFieldProperty
    p.patchObjectFieldProperty = async (input) => {
      if (!Object.prototype.hasOwnProperty.call(input.propertyPatch || {}, HUMAN_WRITE_LOCK_PROPERTY_KEY)) throw new Error('synthetic option patch failure')
      return realPatch(input)
    }
    const res = await repair(f, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 422, JSON.stringify(res.body))
    for (const id of PLM_DROPPED) assert.equal(objectOf(f, objectId).fields.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `${id} is locked although the step after the add failed`)
    for (const id of HUMAN_DROPPED) assert.equal(objectOf(f, objectId).fields.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], undefined, `${id} stays editable`)
    const dry = await repair(f, { projectNo: PROJECT, dryRun: true })
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.deepEqual(plain(dry.body.data.plmColumnLock), { checked: true, alreadyMarked: PLM_COLUMN_COUNT, unmarked: 0, missing: 0 }, 'the dry-run after the failed call: unmarked 0')
  } finally { f.restore() }
})

// ── RC-13 ────────────────────────────────────────────────────────────────────────────────────────────

const {
  reconcileFrozenTemplateColumnsOnObject,
  repairStockPreparationCanonicalTarget,
  buildStockPreparationTargetDescriptor,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { repairStockPreparationMvpTargets } = require(path.join(LIB, 'stock-preparation-mvp-provisioning.cjs'))
const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

/**
 * A bare host whose objects each lack `missing` (logical ids); the tx surface records every INSERT's descriptors
 * and answers the reads from what landed. Enough for the helper, the canonical verb and the MVP repair.
 */
function bareRepairHost({ fieldIdsByObject, missing }) {
  const present = new Map([...fieldIdsByObject].map(([objectId, ids]) => [objectId, new Map(ids.filter((id) => !missing.includes(id)).map((id, order) => [id, { name: id, type: 'string', property: {}, order }]))]))
  const inserted = []
  const surface = {
    findObjectSheet: async ({ objectId }) => (present.has(objectId) ? { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null, systemKind: null } : null),
    resolveExistingObjectFieldIds: async ({ objectId, fieldIds }) => Object.fromEntries(fieldIds.filter((id) => present.get(objectId) && present.get(objectId).has(id)).map((id) => [id, `fld_${id}`])),
    readObjectFieldsContent: async ({ objectId, fieldIds }) => Object.fromEntries(fieldIds.filter((id) => present.get(objectId) && present.get(objectId).has(id)).map((id) => [id, plain(present.get(objectId).get(id))])),
    ensureMissingObjectFields: async ({ objectId, fields }) => {
      inserted.push(...plain(fields))
      const object = present.get(objectId)
      for (const field of fields) object.set(field.id, { name: field.name, type: field.type, property: plain(field.property || {}), order: field.order })
      return { addedFieldIds: fields.map((field) => `fld_${field.id}`), skippedExistingFieldIds: [] }
    },
    readObjectMaxFieldOrder: async ({ objectId }) => Math.max(-1, ...[...present.get(objectId).values()].map((field) => field.order)),
  }
  const provisioning = {
    runObjectFieldsRepairTransaction: async (fn) => fn(surface),
    findObjectSheet: surface.findObjectSheet,
    resolveExistingObjectFieldIds: surface.resolveExistingObjectFieldIds,
  }
  return { provisioning, inserted, context: { api: { multitable: { provisioning } } } }
}

const hasLock = (field) => Boolean(field.property) && Object.prototype.hasOwnProperty.call(field.property, HUMAN_WRITE_LOCK_PROPERTY_KEY)

test('RC-13a no PLM lock off the project path: the shared reconcile helper called without the flag inserts no humanWriteLock', async () => {
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const helper = bareRepairHost({ fieldIdsByObject: new Map([[objectId, TEMPLATE_IDS]]), missing: DROPPED })
  const summary = await reconcileFrozenTemplateColumnsOnObject({ provisioning: helper.provisioning, projectId: STAGING, objectId, apply: true })
  assert.deepEqual(summary.addedFieldIds, DROPPED)
  assert.equal(helper.inserted.length, DROPPED.length)
  for (const field of helper.inserted) assert.equal(hasLock(field), false, `the helper without the flag inserts ${field.id} unlocked`)
})

test('RC-13b no PLM lock off the project path: the canonical repair verb (the deployment\'s own main object) inserts no humanWriteLock', async () => {
  const canonicalObjectId = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
  const canonical = bareRepairHost({ fieldIdsByObject: new Map([[canonicalObjectId, TEMPLATE_IDS]]), missing: PLM_DROPPED })
  const repaired = await repairStockPreparationCanonicalTarget({ context: canonical.context, projectId: STAGING, permission: 'admin' })
  assert.equal(repaired.mode, 'canonical_repaired')
  assert.deepEqual(canonical.inserted.map((field) => field.id), PLM_DROPPED)
  for (const field of canonical.inserted) assert.equal(hasLock(field), false, `the canonical verb inserts ${field.id} unlocked`)
})

test('RC-13c no PLM lock off the project path: the shared descriptor builder the ops script (scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs) inserts from carries none', async () => {
  for (const field of buildStockPreparationTargetDescriptor({}).fields) assert.equal(hasLock(field), false, `the shared descriptor of ${field.id} carries no lock`)
})

test('RC-13d no PLM lock off the project path: the deployment (MVP) repair re-adds a plm_system column unlocked', async () => {
  const mvp = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((template) => template.fields.some((field) => field.ownership === 'plm_system'))
  assert.ok(mvp, 'an MVP template with a plm_system column')
  const mvpPlm = mvp.fields.filter((field) => field.ownership === 'plm_system').map((field) => field.id).slice(0, 1)
  const deployment = bareRepairHost({ fieldIdsByObject: new Map([[mvp.objectId, mvp.fields.map((field) => field.id)]]), missing: mvpPlm })
  await repairStockPreparationMvpTargets({ context: deployment.context, projectId: STAGING, permission: 'admin', objectIds: [mvp.objectId] })
  assert.deepEqual(deployment.inserted.map((field) => field.id), mvpPlm)
  for (const field of deployment.inserted) assert.equal(hasLock(field), false, `the deployment repair inserts ${field.id} unlocked`)
})

// ── RC-14 / RC-15 / RC-16 ────────────────────────────────────────────────────────────────────────────

const { pullBatchBandFieldDescriptors } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
// The template's LAST two columns: exactly where a right-side band of a sheet without them sits.
const TAIL = TEMPLATE_IDS.slice(-2)
const EXT_COLUMN = 'ext_site_note'
const PERSON_COLUMN = 'fld_person_created_7f3a'

/** Put a column straight into the fake host's object, at an explicit order (a pack, a band, a person did it). */
function plant(object, id, order, property = {}) {
  object.fields.set(id, { name: id, type: 'string', property: plain(property), order })
}
const ordersOf = (object) => new Map([...object.fields].map(([id, field]) => [id, field.order]))
/** The grid's order: (order, id), loaders.ts. */
const gridOrder = (object) => [...object.fields].sort(([a, fa], [b, fb]) => (fa.order - fb.order) || (a < b ? -1 : a > b ? 1 : 0)).map(([id]) => id)

test('RC-14 right-side band, an ext_ column and a person-created column: the re-added columns land strictly after every existing column, no order collides, nothing existing moves; a second run moves nothing', async () => {
  assert.ok(TAIL.every((id) => OWNERSHIP.get(id) === 'plm_system' || HUMAN_PRESERVED_FIELD_IDS.includes(id)), 'the template tail is repairable (plm_system or whitelisted human columns)')
  const h = mount()
  try {
    const { objectId, object } = await agedSheet(h, PROJECT, TAIL)
    const maxTemplate = Math.max(...[...object.fields.values()].map((field) => field.order))
    // The tail was dropped, so a pack's ext_ column and then a right-side band go right after the known columns —
    // exactly the orders the template tail would take by its index.
    plant(object, EXT_COLUMN, maxTemplate + 1)
    for (const band of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'right', maxExistingOrder: maxTemplate + 1 })) plant(object, band.id, band.order, band.property)
    plant(object, PERSON_COLUMN, maxTemplate + 4)
    const templateIndex = TAIL.map((id) => TEMPLATE_IDS.indexOf(id))
    const existingOrders = [...object.fields.values()].map((field) => field.order)
    assert.ok(templateIndex.every((order) => existingOrders.includes(order)), 'precondition: the template-index orders are already taken (the collision this test exists for)')
    const before = ordersOf(object)
    const maxBefore = Math.max(...before.values())
    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(plain(res.body.data.columns.addedFieldIds), TAIL)
    const after = objectOf(h, objectId)
    assert.deepEqual(TAIL.map((id) => after.fields.get(id).order), TAIL.map((_id, index) => maxBefore + 1 + index), 'the re-added columns are max + 1 + i, in template order')
    for (const [id, order] of before) assert.equal(after.fields.get(id).order, order, `${id} keeps its order`)
    const orders = [...after.fields.values()].map((field) => field.order)
    assert.equal(new Set(orders).size, orders.length, 'no two columns share an order')
    assert.deepEqual(gridOrder(after).slice(-TAIL.length), TAIL, 'the grid shows the re-added columns after the band, the ext_ and the person column')
    assert.ok(h.provisioning.calls.findIndex((call) => call[0] === 'readObjectMaxFieldOrder') < h.provisioning.calls.findIndex((call) => call[0] === 'ensureMissingObjectFields'), 'the max is read before the INSERT, inside the transaction')

    const settled = snapshotObject(after)
    h.provisioning.calls.length = 0
    const again = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(again.body.data.columns.added, 0)
    assert.deepEqual(ensureCalls(h), [], 'the second run writes no column')
    assert.equal(snapshotObject(objectOf(h, objectId)), settled, 'the second run moves no order')
  } finally { h.restore() }
})

test('RC-15 left-side band (−2 / −1): it keeps its place and the re-added columns go after the current max', async () => {
  const h = mount()
  try {
    const { objectId, object } = await agedSheet(h, PROJECT, TAIL)
    for (const band of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' })) plant(object, band.id, band.order, band.property)
    const before = ordersOf(object)
    const gridBefore = gridOrder(object)
    const maxBefore = Math.max(...before.values())
    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = objectOf(h, objectId)
    for (const [id, order] of before) assert.equal(after.fields.get(id).order, order, `${id} keeps its order`)
    assert.deepEqual(TAIL.map((id) => after.fields.get(id).order), TAIL.map((_id, index) => maxBefore + 1 + index))
    assert.deepEqual(gridOrder(after), [...gridBefore, ...TAIL], 'the band stays leftmost; the existing layout is unchanged; the re-added columns are appended')
  } finally { h.restore() }
})

test('RC-16 a repair transaction without readObjectMaxFieldOrder is 503 with nothing written (a nothing-missing run still 200); a non-integer max is 500 with nothing written', async () => {
  const old = mount({ maxOrderPort: false })
  try {
    const { objectId, object } = await agedSheet(old)
    const before = snapshotObject(object)
    const auditBefore = old.auditAppends.length
    const res = await repair(old, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'TEMPLATE_COLUMN_REPAIR_API_UNAVAILABLE')
    assert.deepEqual(ensureCalls(old), [], 'no column write')
    assert.equal(snapshotObject(objectOf(old, objectId)), before)
    assert.equal(old.auditAppends.length, auditBefore, 'no audit row')
  } finally { old.restore() }

  const settledOld = mount({ maxOrderPort: false })
  try {
    await agedSheet(settledOld, PROJECT, [])
    const res = await repair(settledOld, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.columns.added, 0, 'nothing missing needs no max read')
  } finally { settledOld.restore() }

  for (const bad of [1.5, '31', Number.NaN]) {
    const h = mount()
    try {
      const { objectId, object } = await agedSheet(h)
      h.tx.maxOrder = async () => bad
      const before = snapshotObject(object)
      const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(res.statusCode, 500, `${String(bad)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'TEMPLATE_COLUMN_REPAIR_ORDER_UNREADABLE')
      assert.deepEqual(ensureCalls(h), [])
      assert.equal(snapshotObject(objectOf(h, objectId)), before)
    } finally { h.restore() }
  }
})

test('RC-17 stock-prep:admin is not the repair gate: 403 FORBIDDEN in every mode with zero host calls; integration:admin alone passes', async () => {
  const STOCK_PREP_ADMIN_ONLY = Object.freeze({ id: 'u_rc_sp_admin', tenantId: TENANT, permissions: ['stock-prep:admin', STOCK_PREP_OPERATE, STOCK_PREP_READ, STOCK_PREP_PULL] })
  const INTEGRATION_ADMIN_ONLY = Object.freeze({ id: 'u_rc_int_admin', tenantId: TENANT, permissions: ['integration:admin'] })
  const h = mount()
  try {
    const { objectId, object } = await agedSheet(h)
    const before = snapshotObject(object)
    for (const body of [{ projectNo: PROJECT }, { projectNo: PROJECT, dryRun: true }, { projectNo: PROJECT, addMissingColumns: true }]) {
      h.provisioning.calls.length = 0
      const res = await repair(h, body, { user: STOCK_PREP_ADMIN_ONLY })
      assert.equal(res.statusCode, 403, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'FORBIDDEN')
      assert.deepEqual(h.provisioning.calls, [], 'zero host calls')
    }
    assert.equal(snapshotObject(objectOf(h, objectId)), before)
    const ok = await repair(h, { projectNo: PROJECT, dryRun: true }, { user: INTEGRATION_ADMIN_ONLY })
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
  } finally { h.restore() }
})

// ── RC-18 ────────────────────────────────────────────────────────────────────────────────────────────

// R-71 ⑦.4 PR-4, THE UPGRADE ORDER on a sheet created before the template gained 发料确认日期 / 项目规格型号: install
// PR-3 + PR-4 → (pull now) a recoverable 422 with nothing written → the repair route once → the pull works, and the
// refresh writes neither column (issueConfirmDate is machine write-back only; projectSpecModel has no source yet).
test('RC-18 (R-71 7.4 PR-4) a pre-PR-4 sheet: pull 422 and nothing written; ONE repair adds the two new columns already locked by their INSERT (no later lock patch), existing columns byte-identical; the pull then writes rows carrying neither column', async () => {
  const NEW_COLUMNS = ['issueConfirmDate', 'projectSpecModel']
  for (const id of NEW_COLUMNS) assert.equal(OWNERSHIP.get(id), 'plm_system', `${id} is a plm_system template column`)
  assert.deepEqual(TEMPLATE_IDS.slice(-2), NEW_COLUMNS, 'appended last, so no deployed column moves')
  const h = mount()
  try {
    const { objectId, sheetId, object } = await agedSheet(h, PROJECT, NEW_COLUMNS)
    const existingBefore = JSON.stringify([...object.fields].map(([id, f]) => [id, f]))
    const blocked = await pullDryRun(h)
    assert.equal(blocked.statusCode, 422, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.equal(h.records.calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord').length, 0, 'the refused pull wrote nothing')
    const inserted = captureInsert(h)
    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(plain(res.body.data.columns.addedFieldIds), NEW_COLUMNS)
    // Y7 review MEDIUM-1: the lock rides the INSERT itself, so no later step (option sync, lock marking) can leave
    // either column human-writable. The post-state alone cannot tell the two apart; the INSERT's descriptors can.
    assert.equal(inserted.length, 1, 'one additive write')
    const insertedById = new Map(inserted[0].map((field) => [field.id, field]))
    assert.deepEqual([...insertedById.keys()], NEW_COLUMNS, 'the INSERT carries exactly the two new columns')
    for (const id of NEW_COLUMNS) {
      assert.equal(insertedById.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `the INSERT of ${id} carries the lock`)
    }
    assert.deepEqual(h.provisioning.calls.filter((call) => call[0] === 'patchObjectFieldProperty' && NEW_COLUMNS.includes(call[2])), [], 'no later property patch on either new column')
    const after = objectOf(h, objectId)
    for (const id of NEW_COLUMNS) {
      assert.equal(after.fields.get(id).property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `${id} is locked for people by the same repair call`)
    }
    assert.equal(
      JSON.stringify([...after.fields].filter(([id]) => !NEW_COLUMNS.includes(id)).map(([id, f]) => [id, f])),
      existingBefore,
      'every pre-existing column is byte-identical',
    )
    const again = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.deepEqual(plain(again.body.data.columns.addedFieldIds), [], 'a second repair adds nothing (idempotent)')
    const dry = await pullDryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    const apply = await projectSheet.call(h.routes, 'POST', APPLY_PATH, {
      user: PULLER,
      params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
      body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: dry.body.data.dryRunToken } },
      query: { tenantId: TENANT },
    })
    assert.equal(apply.statusCode, 200, JSON.stringify(apply.body))
    assert.equal(apply.body.data.apply.counts.failed, 0, JSON.stringify(apply.body.data.apply))
    // The rows the pull created (onto an empty sheet a pull only creates), read back through the fake host. They must
    // carry the ordinary refresh columns (anti-vacuity) and neither new column.
    const written = await h.records.queryRecords({ sheetId, filters: {}, limit: 1000 })
    assert.ok(written.length >= 1, 'the pull wrote rows')
    for (const record of written) {
      const written = record
      // The fake host stores PHYSICAL ids (`fld_<sheet hash>_<logical id>`); compare on the logical part.
      const keys = Object.keys(written.data || {}).map((key) => key.replace(/^fld_[0-9a-f]+_/, ''))
      assert.ok(keys.includes('componentSourceId') && keys.includes('lastPlmRefreshRunId'), `a written row carries the refresh columns: ${keys.join(',')}`)
      for (const id of NEW_COLUMNS) assert.equal(keys.includes(id), false, `a refresh write carried ${id}`)
    }
  } finally { h.restore() }
})

// ── RC-19 ────────────────────────────────────────────────────────────────────────────────────────────

// R-71 ⑦.4 PR-4, 备料 review item 5 — THE WINDOW BETWEEN INSTALL AND REPAIR on a sheet created before the template
// gained the two columns: what the floor can still do. The pull is a recoverable 422 with nothing written (RC-18); the
// project export (a fixed column projection, never the existence probe) and 归档 / 恢复 (registry row only) work as
// before, and touch neither the sheet's columns nor its rows.
test('RC-19 (R-71 7.4 PR-4) before the repair: the pull is 422, the export answers 200, archive / restore answer 200 with no host write; after the repair the pull is 200', async () => {
  const NEW_COLUMNS = ['issueConfirmDate', 'projectSpecModel']
  const h = mount({ serviceExtras: { stockPreparationXlsxExport: { async buildWorkbookBuffer() { return Buffer.from('xlsx-synthetic') } } } })
  try {
    const { objectId, sheetId, object } = await agedSheet(h, PROJECT, NEW_COLUMNS)
    for (const id of NEW_COLUMNS) assert.equal(object.fields.has(id), false, `${id} is missing on the aged sheet`)
    // One material row already on the sheet (written by an earlier pull), so the export has something to export.
    const fid = (fieldId) => h.provisioning.getFieldId(STAGING, objectId, fieldId)
    await h.records.createRecord({ sheetId, data: { [fid('projectNo')]: PROJECT, [fid('active')]: true, [fid('idempotencyKey')]: 'idem-rc19-1', [fid('componentCode')]: 'RC19-CODE' } })
    const sheetBefore = snapshotObject(object)
    h.provisioning.calls.length = 0
    h.records.calls.length = 0

    const blocked = await pullDryRun(h)
    assert.equal(blocked.statusCode, 422, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.deepEqual([...blocked.body.error.details.missingFields].sort(), [...NEW_COLUMNS].sort(), 'the refusal names exactly the two new columns')

    const exported = await projectSheet.call(h.routes, 'GET', '/api/integration/stock-preparation/prep-lines/export', { user: PULLER, query: { projectNo: PROJECT } })
    assert.equal(exported.statusCode, 200, JSON.stringify(exported.body))

    for (const verb of ['archive', 'restore']) {
      const res = await projectSheet.call(h.routes, 'POST', `/api/integration/stock-preparation/projects/:projectNo/target/${verb}`, { user: PULLER, params: { projectNo: PROJECT }, body: { confirmProjectNo: PROJECT } })
      assert.equal(res.statusCode, 200, `${verb}: ${JSON.stringify(res.body)}`)
    }
    assert.deepEqual(writeCalls(h), [], 'nothing in the window wrote to the host: no column, no property')
    assert.equal(h.records.calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord' || method === 'deleteRecord').length, 0, 'no row written')
    assert.equal(snapshotObject(objectOf(h, objectId)), sheetBefore, 'the sheet is exactly as it was')

    const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(plain(res.body.data.columns.addedFieldIds), NEW_COLUMNS)
    const dry = await pullDryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  } finally { h.restore() }
})

// ── RC-20 ────────────────────────────────────────────────────────────────────────────────────────────

// R-71 ⑦.4 PR-4 under R-89 (Y7 review MEDIUM-2): the two new columns keep TEMPLATE positions 33 / 34, but on an
// existing sheet the repair appends them after the sheet's current last column. A sheet that got a right-side pull-batch
// band before the repair already holds orders 33 / 34 (the band goes at the largest known order + 1 / + 2), so the
// template index would tie with it. Two layouts: a band only, and an ext_ column before the band.
test('RC-20 (R-71 7.4 PR-4, R-89) a right-side band (with and without an ext_ column) already sits at 33 / 34: the two new columns land at max + 1 / max + 2, locked on INSERT, no order tie, nothing existing moves', async () => {
  const NEW_COLUMNS = ['issueConfirmDate', 'projectSpecModel']
  assert.deepEqual(NEW_COLUMNS.map((id) => TEMPLATE_IDS.indexOf(id)), [33, 34], 'template positions 33 / 34')
  for (const [layout, withExt, expectedOrders] of [['band only', false, [35, 36]], ['ext_ + band', true, [36, 37]]]) {
    const h = mount()
    try {
      const { objectId, object } = await agedSheet(h, PROJECT, NEW_COLUMNS)
      const maxTemplate = Math.max(...[...object.fields.values()].map((field) => field.order))
      assert.equal(maxTemplate, 32, `${layout}: precondition, the aged sheet ends at order 32`)
      if (withExt) plant(object, EXT_COLUMN, maxTemplate + 1)
      const bandBase = withExt ? maxTemplate + 1 : maxTemplate
      for (const band of pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'right', maxExistingOrder: bandBase })) plant(object, band.id, band.order, band.property)
      const before = ordersOf(object)
      const taken = [...before.values()]
      assert.ok(taken.includes(33) && taken.includes(34), `${layout}: precondition, orders 33 and 34 are already taken`)
      const maxBefore = Math.max(...taken)
      const inserted = captureInsert(h)
      const res = await repair(h, { projectNo: PROJECT, addMissingColumns: true })
      assert.equal(res.statusCode, 200, `${layout}: ${JSON.stringify(res.body)}`)
      assert.deepEqual(plain(res.body.data.columns.addedFieldIds), NEW_COLUMNS)
      const after = objectOf(h, objectId)
      const landed = NEW_COLUMNS.map((id) => after.fields.get(id).order)
      assert.deepEqual(landed, [maxBefore + 1, maxBefore + 2], `${layout}: the new columns are max + 1 / max + 2`)
      assert.deepEqual(landed, expectedOrders, `${layout}: concretely ${expectedOrders.join(' / ')}`)
      assert.notDeepEqual(landed, [33, 34], `${layout}: not at the template positions`)
      for (const [id, order] of before) assert.equal(after.fields.get(id).order, order, `${layout}: ${id} keeps its order`)
      const orders = [...after.fields.values()].map((field) => field.order)
      assert.equal(new Set(orders).size, orders.length, `${layout}: no two columns share an order`)
      assert.deepEqual(gridOrder(after).slice(-NEW_COLUMNS.length), NEW_COLUMNS, `${layout}: the grid shows them after the band`)
      assert.equal(inserted.length, 1)
      for (const field of inserted[0]) assert.equal(field.property[HUMAN_WRITE_LOCK_PROPERTY_KEY], 'plm_system', `${layout}: the INSERT of ${field.id} carries the lock`)
    } finally { h.restore() }
  }
})

runFailClosedSuite('stock-preparation-project-sheet-repair-columns.test.cjs', tests)
