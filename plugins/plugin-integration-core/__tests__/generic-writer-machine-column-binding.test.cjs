'use strict'

// D2 round 2 (switch-on precondition for the YiDa issue-confirm write-back, register R-96). Round 1
// (generic-writer-machine-column-shield.test.cjs) stripped the machine write-back columns (MACHINE_WRITEBACK_FIELD_IDS,
// today `issueConfirmDate`) from the generic writers' UPDATE payloads on a stock-prep target, but read the strip set
// from the WRITER'S CONFIG — so a config without a projectId that named the column by another logical name, or by its
// raw physical id, still erased the write-back's date (refuter finding 1). Round 2 reads the set from THE SHEET: the
// registry row's binding (lib/generic-writer-machine-columns.cjs), accepted only when the pair provably names the sheet.
//
//   B-01..B-09  F0: the strip set comes from the sheet's binding (aliases, raw physical ids, namespace keys without a
//               projectId, a registry row of another tenant), the binding is the one table-actions and the write-back
//               bind through, a registered sheet whose machine columns cannot be resolved is refused before IO, a
//               machine column as the lookup key is refused, and the probe's additive binding read (B-09).
//   B-10        round 3: a source scan pins that binding read (values-bearing, no tenant filter) to ONE call site.
//   K-01..K-04  F1: creates on a stock-prep target never carry a machine column (pipeline upsert, C6 insertRows, ERP).
//   R-01..R-04  F2: ERP feedback re-reads by key and re-sends the stripped patch with the fresh version (3 attempts).
//   D-01..D-04  F3: the C6 value diff ignores the machine columns on a stock-prep target (no churn), a machine-only
//               update is not reported as written, and test() on any other target makes no new call (D-04).
//   U-01        F5: an unreadable version is its own, NOT retryable code.
// Every test drives the PUBLIC factories only (adapter, write-source, feedback writers, the C6 planner), so each one
// fails on its own against a lib without the fix. Values-free: every id below is synthetic.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const adapterLib = require(path.join(LIB, 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const { createErpFeedbackWriter, createMultitableFeedbackWriter } = require(path.join(LIB, 'erp-feedback.cjs'))
const c6 = require(path.join(LIB, 'external-write-dry-run.cjs'))
const { MACHINE_WRITEBACK_FIELD_IDS } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
// Test-only imports: the bindings a registered sheet's OTHER readers use (table-actions' project overlay and the
// write-back's sheet port). The writers do not require these modules (their load graph stays small).
const { buildProjectTargetBinding } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { resolveTargetFieldIds } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const { createMetaSheetMultitableTargetAdapter, createMetaSheetMultitableWriteSource, MULTITABLE_WRITE_PROFILE } = adapterLib

const tests = []
const test = (name, fn) => tests.push([name, fn])

const MACHINE = MACHINE_WRITEBACK_FIELD_IDS[0]
const TENANT = 'tenant_d2r2_a'
const OTHER_TENANT = 'tenant_d2r2_b'
const projectOf = (tenantId) => `${tenantId}:integration-core`
const PROJECT_ID = projectOf(TENANT)
const REG_OBJECT = ownBase.deriveStockPreparationProjectSheetObjectId(TENANT, 'PRJ-D2R2')
const OTHER_OBJECT = ownBase.deriveStockPreparationProjectSheetObjectId(TENANT, 'PRJ-D2R2-OTHER')

const CODES = Object.freeze({
  UNRESOLVED: 'METASHEET_MULTITABLE_MACHINE_COLUMNS_UNRESOLVED',
  KEY_REFUSED: 'METASHEET_MULTITABLE_MACHINE_COLUMN_KEY_REFUSED',
  CONFLICT: 'METASHEET_MULTITABLE_VERSION_CONFLICT',
  UNREADABLE: 'METASHEET_MULTITABLE_VERSION_UNREADABLE',
  ERP_CONFLICT: 'ERP_FEEDBACK_VERSION_CONFLICT',
  ERP_UNREADABLE: 'ERP_FEEDBACK_VERSION_UNREADABLE',
  ERP_UNRESOLVED: 'ERP_FEEDBACK_MACHINE_COLUMNS_UNRESOLVED',
})

const SEEDED_DATE = '2026-11-01'
const RACED_DATE = '2026-11-02'

// The host's derivations, as provisioning.ts does them: one-way digests of (projectId, objectId[, fieldId]).
const digest = (...parts) => crypto.createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24)
const sheetIdOf = (projectId, objectId) => `sheet_${digest(projectId, objectId)}`
const fieldIdOf = (projectId, objectId, fieldId) => `fld_${digest(projectId, objectId, fieldId)}`

function hostProvisioning({ omit = [] } = {}) {
  const calls = []
  const api = {
    getObjectSheetId(projectId, objectId) { calls.push(['getObjectSheetId', projectId, objectId]); return sheetIdOf(projectId, objectId) },
    async resolveFieldIds(input) { calls.push(['resolveFieldIds', input.projectId, input.objectId]); return Object.fromEntries(input.fieldIds.map((id) => [id, fieldIdOf(input.projectId, input.objectId, id)])) },
    async findObjectSheet(input) { return { id: sheetIdOf(input.projectId, input.objectId) } },
    getFieldId(projectId, objectId, fieldId) { return fieldIdOf(projectId, objectId, fieldId) },
  }
  for (const name of omit) delete api[name]
  api.calls = calls
  return api
}

// The registered sheet: provisioned under (TENANT's staging project, REG_OBJECT), exactly as the route does it.
const SHEET = sheetIdOf(PROJECT_ID, REG_OBJECT)
const PHYS = Object.freeze({
  idempotencyKey: fieldIdOf(PROJECT_ID, REG_OBJECT, 'idempotencyKey'),
  material: fieldIdOf(PROJECT_ID, REG_OBJECT, 'material'),
  [MACHINE]: fieldIdOf(PROJECT_ID, REG_OBJECT, MACHINE),
})

const MARKS = Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 })
const REGISTERED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: true, pilot: false, tenantMatches: true }), marks: MARKS })
const NOT_REGISTERED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: false }), marks: MARKS })

// A probe that answers `answer` and, for the registry binding read, `binding` (or no such method at all).
function probeOf(answer = REGISTERED, binding = { tenantId: TENANT, objectId: REG_OBJECT }, { withBindingRead = true } = {}) {
  const calls = []
  const probe = {
    calls,
    async probe(input) { calls.push(['probe', { ...input }]); return answer },
    async assertSheetWritable(input) { calls.push(['assertSheetWritable', { ...input }]); return answer },
  }
  if (withBindingRead) {
    probe.registryBindingBySheet = async (input) => { calls.push(['registryBindingBySheet', { ...input }]); return binding }
  }
  return probe
}

// A records API with the host SDK's semantics on the points that matter: query returns { id, version, data }; patch
// honours `expectedVersion` (VERSION_CONFLICT) and merges; `between(row, attempt)` runs before each patch is applied.
function createRecords({ rows = [], between = null } = {}) {
  const store = rows.map((row) => ({ ...row, data: { ...row.data } }))
  const calls = []
  let patchAttempt = 0
  const records = {
    async queryRecords(input) {
      calls.push(['queryRecords', JSON.parse(JSON.stringify(input))])
      return store
        .filter((row) => row.sheetId === input.sheetId && Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value))
        .slice(0, input.limit || 1000)
        .map((row) => ({ id: row.id, version: row.version, data: { ...row.data } }))
    },
    async createRecord(input) {
      calls.push(['createRecord', JSON.parse(JSON.stringify(input))])
      const row = { id: `rec_${store.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
      store.push(row)
      return { id: row.id, version: row.version, data: { ...row.data } }
    },
    async patchRecord(input) {
      calls.push(['patchRecord', JSON.parse(JSON.stringify(input))])
      patchAttempt += 1
      const row = store.find((item) => item.id === input.recordId && item.sheetId === input.sheetId)
      if (!row) throw new Error('record not found')
      if (between) between(row, patchAttempt, store)
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        const conflict = new Error('Record version conflict')
        conflict.name = 'MultitableRecordVersionConflictError'
        conflict.code = 'VERSION_CONFLICT'
        throw conflict
      }
      row.version += 1
      row.data = { ...row.data, ...input.changes }
      return { id: row.id, version: row.version, data: { ...row.data } }
    },
  }
  return { records, calls, store }
}

const raceWriteback = (row) => { row.data = { ...row.data, [PHYS[MACHINE]]: RACED_DATE }; row.version += 1 }
const seededRow = (version = 3) => ({ id: 'rec_seed', sheetId: SHEET, version, data: { [PHYS.idempotencyKey]: 'idem-1', [PHYS.material]: 'M-OLD', [PHYS[MACHINE]]: SEEDED_DATE } })

const QUIET = { warn() {} }
const callsNamed = (calls, name) => calls.filter(([entry]) => entry === name).map(([, input]) => input)
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

function systemWith(objectKey, objectConfig, extra = {}) {
  return { id: 'es_d2r2', tenantId: TENANT, name: 'D2 round 2 target', kind: 'metasheet:multitable', role: 'target', config: { ...extra, objects: { [objectKey]: { sheetId: SHEET, keyFields: ['idempotencyKey'], mode: 'upsert', ...objectConfig } } } }
}
// Free key `main`, no projectId, the machine column under ANOTHER logical name (`confirmDate`).
const aliasSystem = () => systemWith('main', { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material, confirmDate: PHYS[MACHINE] }, fields: [{ name: 'idempotencyKey' }, { name: 'material' }, { name: 'confirmDate' }] })
// Free key `main`, no projectId, no field list (every payload key passes): the machine column by its RAW physical id.
const rawSystem = () => systemWith('main', { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material } })
const contextOf = (records, provisioning = hostProvisioning()) => ({ api: { multitable: { records, provisioning } }, logger: QUIET })

async function upsertOne({ system, object = 'main', record, probe = probeOf(), provisioning = hostProvisioning(), rows = [seededRow()], between = null }) {
  const world = createRecords({ rows, between })
  const adapter = createMetaSheetMultitableTargetAdapter({ system, context: contextOf(world.records, provisioning), governedSheetProbe: probe })
  const result = await adapter.upsert({ object, records: [record] })
  return { ...world, result }
}

function assertShielded({ calls, store }, label) {
  const [patch] = callsNamed(calls, 'patchRecord')
  assert.ok(patch, `${label}: one patch`)
  assert.equal(has(patch.changes, PHYS[MACHINE]), false, `${label}: the sheet's machine column is not in the patch`)
  assert.equal(has(patch.changes, MACHINE), false, `${label}: nor its logical id`)
  assert.equal(has(patch.changes, 'confirmDate'), false, `${label}: nor an alias`)
  assert.equal(patch.changes[PHYS.material], 'M-NEW', `${label}: the other fields still write`)
  assert.equal(patch.expectedVersion, 3, `${label}: fenced with the version read`)
  assert.equal(store[0].data[PHYS[MACHINE]], SEEDED_DATE, `${label}: the date survives`)
}

// ── F0: the strip set from the SHEET ──────────────────────────────────────────────────────────────

test('B-01 pipeline upsert, REGISTERED sheet, free key, NO projectId: the machine column named by ANOTHER logical name (a fieldIdMap alias) is not written', async () => {
  const out = await upsertOne({ system: aliasSystem(), record: { idempotencyKey: 'idem-1', material: 'M-NEW', confirmDate: null } })
  assert.deepEqual([out.result.written, out.result.failed], [1, 0])
  assertShielded(out, 'alias')
})

test('B-02 pipeline upsert, REGISTERED sheet, free key, NO projectId: the machine column named by its RAW physical id is not written', async () => {
  const out = await upsertOne({ system: rawSystem(), record: { idempotencyKey: 'idem-1', material: 'M-NEW', [PHYS[MACHINE]]: null } })
  assert.deepEqual([out.result.written, out.result.failed], [1, 0])
  assertShielded(out, 'raw physical id')
})

test('B-03 pipeline upsert, a stock-prep NAMESPACE object key with NO projectId on the registered sheet: raw physical id and alias are both stripped', async () => {
  const raw = await upsertOne({ system: systemWith(REG_OBJECT, { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material } }), object: REG_OBJECT, record: { idempotencyKey: 'idem-1', material: 'M-NEW', [PHYS[MACHINE]]: null } })
  assertShielded(raw, 'namespace key, raw')
  const alias = await upsertOne({ system: systemWith(REG_OBJECT, { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material, confirmDate: PHYS[MACHINE] }, fields: [{ name: 'idempotencyKey' }, { name: 'material' }, { name: 'confirmDate' }] }), object: REG_OBJECT, record: { idempotencyKey: 'idem-1', material: 'M-NEW', confirmDate: null } })
  assertShielded(alias, 'namespace key, alias')
})

test('B-04 C6 updateRows, REGISTERED sheet, free key: alias and raw physical id are stripped, the patch is fenced', async () => {
  for (const [label, system, row] of [
    ['alias', aliasSystem(), { idempotencyKey: 'idem-1', material: 'M-NEW', confirmDate: null }],
    ['raw', rawSystem(), { idempotencyKey: 'idem-1', material: 'M-NEW', [PHYS[MACHINE]]: null }],
  ]) {
    const world = createRecords({ rows: [seededRow()] })
    const source = createMetaSheetMultitableWriteSource({ system, context: contextOf(world.records), governedSheetProbe: probeOf() })
    const out = await source.updateRows('mt', 'main', [row], { keyFields: ['idempotencyKey'] })
    assert.equal(out.rowCount, 1, label)
    assertShielded(world, `C6 ${label}`)
  }
})

test('B-05 BOUND != DERIVED: a registry row of ANOTHER tenant on a sheet this tenant provisioned — the column is the one the SHEET binds (the pair that derives the sheet id), not the one the registry tenant would derive', async () => {
  // The registry tenant's derivation names a column this sheet does not have; a strip derived from it alone lets the
  // raw physical id of the REAL column through.
  assert.notEqual(fieldIdOf(projectOf(OTHER_TENANT), REG_OBJECT, MACHINE), PHYS[MACHINE])
  const probe = probeOf({ ...REGISTERED, registry: { present: true, pilot: false, tenantMatches: false } }, { tenantId: OTHER_TENANT, objectId: REG_OBJECT })
  const out = await upsertOne({ system: rawSystem(), probe, record: { idempotencyKey: 'idem-1', material: 'M-NEW', [PHYS[MACHINE]]: null } })
  assert.deepEqual([out.result.written, out.result.failed], [1, 0])
  assertShielded(out, 'registry of another tenant')
})

test('B-06 FAIL CLOSED: a registered sheet whose machine columns cannot be resolved is refused with the closed code BEFORE any records IO (no query, patch or create) — upsert, C6 test() / updateRows / insertRows, ERP feedback', async () => {
  const cases = [
    ['sheet_binding_mismatch', probeOf(REGISTERED, { tenantId: TENANT, objectId: OTHER_OBJECT }), hostProvisioning(), 409],
    ['registry_row_absent', probeOf(REGISTERED, null), hostProvisioning(), 409],
    ['registry_binding_read_absent', probeOf(REGISTERED, null, { withBindingRead: false }), hostProvisioning(), 501],
    ['provisioning_absent', probeOf(), hostProvisioning({ omit: ['getObjectSheetId'] }), 501],
  ]
  for (const [reason, probe, provisioning, status] of cases) {
    const world = createRecords({ rows: [seededRow()] })
    const adapter = createMetaSheetMultitableTargetAdapter({ system: rawSystem(), context: contextOf(world.records, provisioning), governedSheetProbe: probe })
    let caught = null
    try { await adapter.upsert({ object: 'main', records: [{ idempotencyKey: 'idem-1', material: 'M-NEW', [PHYS[MACHINE]]: null }] }) } catch (error) { caught = error }
    assert.ok(caught, `${reason}: upsert refused`)
    assert.deepEqual([caught.status, caught.code, caught.details && caught.details.reason], [status, CODES.UNRESOLVED, reason], reason)
    for (const value of [SHEET, PHYS[MACHINE], TENANT, PROJECT_ID, REG_OBJECT, OTHER_OBJECT]) {
      assert.equal(caught.message.includes(value) || JSON.stringify(caught.details).includes(value), false, `${reason}: values-free message and details`)
    }
    const source = createMetaSheetMultitableWriteSource({ system: rawSystem(), context: contextOf(world.records, provisioning), governedSheetProbe: probe })
    let testCaught = null
    try { await source.test() } catch (error) { testCaught = error }
    assert.equal(testCaught && testCaught.code, CODES.UNRESOLVED, `${reason}: C6 test() refuses before any row`)
    for (const method of ['updateRows', 'insertRows']) {
      let rowCaught = null
      try { await source[method]('mt', 'main', [{ idempotencyKey: 'idem-1', material: 'M-NEW' }], { keyFields: ['idempotencyKey'] }) } catch (error) { rowCaught = error }
      assert.equal(rowCaught && rowCaught.code, CODES.UNRESOLVED, `${reason}: C6 ${method}`)
      assert.equal(c6.__internals.valuesFreeErrorCode(rowCaught), CODES.UNRESOLVED, `${reason}: the C6 row vocabulary keeps the code`)
    }
    assert.deepEqual(world.calls.map(([name]) => name), [], `${reason}: no records IO at all`)
    assert.equal(world.store[0].data[PHYS[MACHINE]], SEEDED_DATE)
  }
  // ERP feedback: reported by its own reason token, nothing written.
  const world = createRecords({ rows: [seededRow()] })
  const feedback = createErpFeedbackWriter({ context: contextOf(world.records), clock: () => '2026-11-17T00:00:00.000Z', governedSheetProbe: probeOf(REGISTERED, { tenantId: TENANT, objectId: OTHER_OBJECT }) })
  const out = await feedback.writeBack({
    tenantId: TENANT, runId: 'run_d2r2', workspaceId: null,
    pipeline: { id: 'pipe_d2r2', projectId: PROJECT_ID, options: { erpFeedback: { objectId: REG_OBJECT, keyField: 'idempotencyKey', fieldMap: { status: 'material' } } } },
    cleanRecords: [{ sourceRecord: {}, targetRecord: { idempotencyKey: 'idem-1' } }],
    writeResult: { results: [{ key: 'idem-1', externalId: 'ext_d2r2' }] },
  })
  assert.deepEqual([out.ok, out.reason, out.code], [false, CODES.ERP_UNRESOLVED, CODES.UNRESOLVED])
  assert.deepEqual(callsNamed(world.calls, 'patchRecord').concat(callsNamed(world.calls, 'createRecord')), [], 'ERP: nothing written')
})

test('B-07 THE SAME BINDING: on a registered sheet the stripped physical id is exactly the one table-actions binds (buildProjectTargetBinding, the project overlay) and the write-back binds (resolveTargetFieldIds, its sheet port)', async () => {
  const provisioning = hostProvisioning()
  const overlay = await buildProjectTargetBinding({ provisioning, projectId: PROJECT_ID, target: { sheetId: SHEET, objectId: REG_OBJECT } })
  const writeback = await resolveTargetFieldIds(provisioning, PROJECT_ID, REG_OBJECT)
  assert.equal(overlay.fieldIdMap[MACHINE], PHYS[MACHINE])
  assert.equal(writeback[MACHINE], PHYS[MACHINE])
  for (const physical of new Set([overlay.fieldIdMap[MACHINE], writeback[MACHINE]])) {
    const out = await upsertOne({ system: rawSystem(), provisioning, record: { idempotencyKey: 'idem-1', material: 'M-NEW', [physical]: null } })
    assertShielded(out, 'the bound id')
  }
})

test('B-08 a lookup key that IS the machine column (by alias) on a stock-prep target is refused before any records IO — stripping it would write keyless rows', async () => {
  const system = systemWith('main', { keyFields: ['confirmDate'], fieldIdMap: { confirmDate: PHYS[MACHINE], material: PHYS.material }, fields: [{ name: 'confirmDate' }, { name: 'material' }] })
  const world = createRecords({ rows: [seededRow()] })
  const adapter = createMetaSheetMultitableTargetAdapter({ system, context: contextOf(world.records), governedSheetProbe: probeOf() })
  let caught = null
  try { await adapter.upsert({ object: 'main', records: [{ confirmDate: SEEDED_DATE, material: 'M-NEW' }] }) } catch (error) { caught = error }
  assert.equal(caught && caught.code, CODES.KEY_REFUSED)
  assert.deepEqual(world.calls.map(([name]) => name), [])
})

test('B-09 the probe\'s ADDITIVE binding read over the REAL registry store: the registered row\'s { tenantId, objectId } (frozen), null when none; a failed read is 503 STORE_FAILED (operation binding_by_sheet), a row without its handles 503, no registry read 501; the verdict answer is unchanged (no binding in it)', async () => {
  const refreshKit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))
  const continuationLib = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
  const registryLib = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
  const probeLib = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))
  const fixture = await refreshKit.candidateHoldFixture()
  const db = refreshKit.createFakeRefreshDb({ clock: refreshKit.createClock() })
  const projectTargetStore = registryLib.createStockPreparationProjectTargetStore({ db })
  const probe = probeLib.createStockPreparationGovernedSheetProbe({ continuationStore: continuationLib.createStockPreparationContinuationStore({ db }), projectTargetStore })
  assert.equal(await probe.registryBindingBySheet({ sheetId: SHEET }), null, 'nothing registered')
  await db.insertOne(refreshKit.REGISTRY_TABLE, refreshKit.registryRow({ tenantId: TENANT, projectNo: fixture.projectNo, sheetId: SHEET, objectId: REG_OBJECT, pilot: false }))
  const binding = await probe.registryBindingBySheet({ sheetId: SHEET })
  assert.deepEqual({ ...binding }, { tenantId: TENANT, objectId: REG_OBJECT })
  assert.ok(Object.isFrozen(binding))
  const answer = await probe.probe({ sheetId: SHEET, tenantId: TENANT })
  assert.deepEqual(JSON.parse(JSON.stringify(answer.registry)), { present: true, pilot: false, tenantMatches: true }, 'the verdict answer carries no binding')
  db.faults.selectOne = refreshKit.sqlError('42703', 'column "object_id" does not exist')
  let caught = null
  try { await probe.registryBindingBySheet({ sheetId: SHEET }) } catch (error) { caught = error }
  assert.deepEqual([caught && caught.status, caught && caught.code, caught && caught.details.operation, caught && caught.details.sqlState], [503, 'STOCK_PREP_REFRESH_STORE_FAILED', 'binding_by_sheet', '42703'])
  assert.equal(caught.message.includes('object_id'), false, 'the driver message never reaches the error')
  const handleless = probeLib.createStockPreparationGovernedSheetProbe({ continuationStore: {}, projectTargetStore: { getPilotStateBySheetId: async () => ({ pilot: false }) } })
  caught = null
  try { await handleless.registryBindingBySheet({ sheetId: SHEET }) } catch (error) { caught = error }
  assert.equal(caught && caught.status, 503)
  const unwired = probeLib.createStockPreparationGovernedSheetProbe({})
  caught = null
  try { await unwired.registryBindingBySheet({ sheetId: SHEET }) } catch (error) { caught = error }
  assert.equal(caught && caught.status, 501)
  caught = null
  try { await probe.registryBindingBySheet({ sheetId: '  ' }) } catch (error) { caught = error }
  assert.equal(caught && caught.status, 422)
})

// B-10 (D2 round 3, stock-prep verdict X4): the probe's binding read is VALUES-BEARING and has NO tenant filter (the
// store reads by sheet only), so it may have exactly one consumer. A source scan of lib/ (recursive) plus index.cjs,
// comments stripped first so a comment alone cannot satisfy the call checks. The regex stripper is not a tokenizer: a
// '/*' inside prose or a string can hide the code after it (round-3 refuter finding 1). So (round 4) the scan ALSO
// reads the RAW text of every file under lib/ (any extension) plus index.cjs: the files that name the identifier at
// all, comments included, must be a subset of the probe, its one consumer and the store (whose comment names it). The
// raw check pins the FILE SET only; the call count inside those three files rests on the stripped checks.
const B10_PLUGIN_DIR = path.join(__dirname, '..')
const B10_RAW_ALLOWED = Object.freeze([
  'lib/generic-writer-machine-columns.cjs',
  'lib/stock-preparation-governed-sheet-probe.cjs',
  'lib/stock-preparation-project-target-store.cjs',
])
const b10StripComments = (source) => source.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
function b10Walk(filter) {
  const out = []
  const walk = (dir) => {
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (filter(entry.name)) out.push(full)
    }
  }
  walk(LIB)
  out.push(path.join(B10_PLUGIN_DIR, 'index.cjs'))
  return out
}
const b10SourceFiles = () => b10Walk((name) => /\.(cjs|mjs|js|mts|ts)$/.test(name))
const b10AllFiles = () => b10Walk(() => true)

test('B-10 the probe\'s values-bearing, tenant-unscoped binding read has EXACTLY ONE call in lib/ + index.cjs — in resolveRegisteredSheetMachineColumns of generic-writer-machine-columns.cjs; the identifier appears in no other file (no alias, no destructure, no literal bracket access; raw text too)', () => {
  const fs = require('node:fs')
  // RAW (round 4, refuter finding 1): no comment stripping, every file type — a '/*' in prose cannot hide a mention.
  const rawNaming = b10AllFiles()
    .filter((file) => fs.readFileSync(file, 'utf8').includes('registryBindingBySheet'))
    .map((file) => path.relative(B10_PLUGIN_DIR, file).split(path.sep).join('/'))
    .sort()
  const outsideAllowed = rawNaming.filter((rel) => !B10_RAW_ALLOWED.includes(rel))
  assert.deepEqual(outsideAllowed, [], 'raw text: only the probe, its one consumer and the store name the binding read')
  const calls = []
  const mentions = new Map()
  for (const file of b10SourceFiles()) {
    const code = b10StripComments(fs.readFileSync(file, 'utf8'))
    const rel = path.relative(B10_PLUGIN_DIR, file).split(path.sep).join('/')
    const count = (code.match(/registryBindingBySheet/g) || []).length
    if (count > 0) mentions.set(rel, count)
    const callPattern = /registryBindingBySheet\s*\(/g
    let match = callPattern.exec(code)
    while (match) {
      // The probe's own declaration is not a call.
      if (!/function\s+$/.test(code.slice(Math.max(0, match.index - 16), match.index))) calls.push({ rel, index: match.index, code })
      match = callPattern.exec(code)
    }
  }
  assert.deepEqual([...mentions.keys()].sort(), ['lib/generic-writer-machine-columns.cjs', 'lib/stock-preparation-governed-sheet-probe.cjs'], 'the binding read is named only by the probe (its definition) and its one consumer')
  // The probe: the declaration and the frozen export. The consumer: the `typeof` wiring check and the call.
  assert.equal(mentions.get('lib/stock-preparation-governed-sheet-probe.cjs'), 2, 'the probe names it at its declaration and its export only')
  assert.equal(mentions.get('lib/generic-writer-machine-columns.cjs'), 2, 'the consumer names it at its typeof check and its one call only')
  assert.deepEqual(calls.map(({ rel }) => rel), ['lib/generic-writer-machine-columns.cjs'], 'exactly one call')
  const [{ index, code }] = calls
  const start = code.indexOf('async function resolveRegisteredSheetMachineColumns(')
  assert.ok(start >= 0, 'the consumer function exists (a rename must not turn this scan into a no-op)')
  const end = code.indexOf('\n}\n', start)
  assert.ok(index > start && index < end, 'the one call sits inside resolveRegisteredSheetMachineColumns')
  assert.match(code.slice(index - 40, index), /await governedSheetProbe\.$/, 'the call is the awaited member call on the injected probe')
})

// ── F1: creates ──────────────────────────────────────────────────────────────────────────────────

test('K-01 pipeline upsert CREATE (no existing row, and append mode) on a REGISTERED sheet: no machine column by logical id, alias or raw physical id; the other fields are created', async () => {
  for (const mode of ['upsert', 'append']) {
    const system = systemWith('main', { mode, fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material, confirmDate: PHYS[MACHINE] } })
    const out = await upsertOne({ system, rows: [], record: { idempotencyKey: 'idem-new', material: 'M-NEW', confirmDate: '2026-12-01', [PHYS[MACHINE]]: '2026-12-02', [MACHINE]: '2026-12-03' } })
    assert.deepEqual([out.result.written, out.result.failed], [1, 0], mode)
    const [create] = callsNamed(out.calls, 'createRecord')
    assert.ok(create, `${mode}: created`)
    assert.deepEqual(Object.keys(create.data).sort(), [PHYS.idempotencyKey, PHYS.material].sort(), `${mode}: no machine column in the create`)
    assert.equal(has(out.store[0].data, PHYS[MACHINE]), false, `${mode}: the stored row has no planted date`)
  }
})

test('K-02 C6 insertRows on a REGISTERED sheet: the create carries no machine column', async () => {
  const world = createRecords({ rows: [] })
  const source = createMetaSheetMultitableWriteSource({ system: aliasSystem(), context: contextOf(world.records), governedSheetProbe: probeOf() })
  await source.insertRows('mt', 'main', [{ idempotencyKey: 'idem-new', material: 'M-NEW', confirmDate: '2026-12-01' }], { keyFields: ['idempotencyKey'] })
  const [create] = callsNamed(world.calls, 'createRecord')
  assert.deepEqual(Object.keys(create.data).sort(), [PHYS.idempotencyKey, PHYS.material].sort())
})

test('K-03 ERP feedback CREATE on a stock-prep target (namespace object, and a registered sheet): the create carries no machine column', async () => {
  for (const answer of [NOT_REGISTERED, REGISTERED]) {
    const world = createRecords({ rows: [] })
    const writer = createMultitableFeedbackWriter({ context: contextOf(world.records), governedSheetProbe: probeOf(answer) })
    const result = await writer.updateRecords({ tenantId: TENANT, projectId: PROJECT_ID, objectId: REG_OBJECT, keyField: 'idempotencyKey', updates: [{ key: 'idem-new', fields: { [MACHINE]: 'synced', material: 'M-FB' } }] })
    assert.equal(result.created, 1)
    const [create] = callsNamed(world.calls, 'createRecord')
    assert.deepEqual(Object.keys(create.data).sort(), [PHYS.idempotencyKey, PHYS.material].sort(), `registry present ${answer.registry.present}`)
  }
})

test('K-04 REGRESSION creates on a NON-stock-prep target are byte-identical: the configured machine-named column is created as before', async () => {
  const system = systemWith('main', { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material, [MACHINE]: PHYS[MACHINE] } })
  const out = await upsertOne({ system, probe: probeOf(NOT_REGISTERED), rows: [], record: { idempotencyKey: 'idem-new', material: 'M-NEW', [MACHINE]: '2026-12-01' } })
  const [create] = callsNamed(out.calls, 'createRecord')
  assert.deepEqual(create.data, { [PHYS.idempotencyKey]: 'idem-new', [PHYS.material]: 'M-NEW', [PHYS[MACHINE]]: '2026-12-01' })
  const world = createRecords({ rows: [] })
  const source = createMetaSheetMultitableWriteSource({ system, context: contextOf(world.records), governedSheetProbe: probeOf(NOT_REGISTERED) })
  await source.insertRows('mt', 'main', [{ idempotencyKey: 'idem-new', material: 'M-NEW', [MACHINE]: '2026-12-01' }], { keyFields: ['idempotencyKey'] })
  assert.deepEqual(callsNamed(world.calls, 'createRecord')[0].data, { [PHYS.idempotencyKey]: 'idem-new', [PHYS.material]: 'M-NEW', [PHYS[MACHINE]]: '2026-12-01' })
})

// ── F2: ERP feedback bounded re-read + re-send ───────────────────────────────────────────────────

const feedbackUpdate = { key: 'idem-1', fields: { [MACHINE]: 'synced', material: 'M-FB' } }
const feedbackInput = (updates = [feedbackUpdate]) => ({ tenantId: TENANT, projectId: PROJECT_ID, objectId: REG_OBJECT, keyField: 'idempotencyKey', updates })

test('R-01 ERP feedback, one racing write-back: the row is re-read by key and the stripped patch re-sent with the FRESH version — written, the raced date stands', async () => {
  const world = createRecords({ rows: [seededRow(5)], between: (row, attempt) => { if (attempt === 1) raceWriteback(row) } })
  const writer = createMultitableFeedbackWriter({ context: contextOf(world.records), governedSheetProbe: probeOf() })
  const result = await writer.updateRecords(feedbackInput())
  assert.deepEqual({ ok: result.ok, patched: result.patched, conflicted: result.conflicted }, { ok: true, patched: 1, conflicted: undefined })
  const patches = callsNamed(world.calls, 'patchRecord')
  assert.deepEqual(patches.map((patch) => patch.expectedVersion), [5, 6], 'second attempt fenced with the re-read version')
  for (const patch of patches) assert.equal(has(patch.changes, PHYS[MACHINE]), false)
  assert.equal(world.store[0].data[PHYS[MACHINE]], RACED_DATE, 'the write-back stands')
  assert.equal(world.store[0].data[PHYS.material], 'M-FB', 'the feedback landed')
})

test('R-02 ERP feedback, a write-back racing EVERY attempt: exactly three fenced attempts, then the row is conflicted — writeBack ok:false, ERP_FEEDBACK_VERSION_CONFLICT, retryable', async () => {
  const world = createRecords({ rows: [seededRow(5)], between: (row) => raceWriteback(row) })
  const feedback = createErpFeedbackWriter({ context: contextOf(world.records), clock: () => '2026-11-17T00:00:00.000Z', governedSheetProbe: probeOf() })
  const out = await feedback.writeBack({
    tenantId: TENANT, runId: 'run_d2r2', workspaceId: null,
    pipeline: { id: 'pipe_d2r2', projectId: PROJECT_ID, options: { erpFeedback: { objectId: REG_OBJECT, keyField: 'idempotencyKey', fieldMap: { status: 'material' } } } },
    cleanRecords: [{ sourceRecord: {}, targetRecord: { idempotencyKey: 'idem-1' } }],
    writeResult: { results: [{ key: 'idem-1', externalId: 'ext_d2r2' }] },
  })
  assert.deepEqual([out.ok, out.reason, out.retryable, out.result && out.result.conflicted], [false, CODES.ERP_CONFLICT, true, 1])
  assert.equal(callsNamed(world.calls, 'patchRecord').length, 3, 'bounded: three attempts')
  assert.equal(world.store[0].data[PHYS.material], 'M-OLD', 'nothing of the row was written')
})

test('R-03 ERP feedback: a row that VANISHES on the re-read is conflicted, never created', async () => {
  const world = createRecords({ rows: [seededRow(5)], between: (row, attempt, store) => { if (attempt === 1) { raceWriteback(row); row.data[PHYS.idempotencyKey] = 'idem-moved' } } })
  const writer = createMultitableFeedbackWriter({ context: contextOf(world.records), governedSheetProbe: probeOf() })
  const result = await writer.updateRecords(feedbackInput())
  assert.deepEqual({ ok: result.ok, patched: result.patched, created: result.created, conflicted: result.conflicted }, { ok: false, patched: 0, created: 0, conflicted: 1 })
  assert.equal(callsNamed(world.calls, 'createRecord').length, 0)
})

test('R-04 ERP feedback: an UNREADABLE version is its own, NOT retryable reason (ERP_FEEDBACK_VERSION_UNREADABLE); no patch is sent', async () => {
  const world = createRecords({ rows: [{ ...seededRow(), version: undefined }] })
  const writer = createMultitableFeedbackWriter({ context: contextOf(world.records), governedSheetProbe: probeOf() })
  const result = await writer.updateRecords(feedbackInput())
  assert.deepEqual({ ok: result.ok, reason: result.reason, retryable: result.retryable, unreadable: result.unreadable }, { ok: false, reason: CODES.ERP_UNREADABLE, retryable: false, unreadable: 1 })
  assert.equal(callsNamed(world.calls, 'patchRecord').length, 0)
})

// ── F3: the C6 value diff ────────────────────────────────────────────────────────────────────────

function memoryTokenStore() {
  const map = new Map()
  return { map, async get(key) { return map.get(key) }, async set(key, value) { map.set(key, value) }, async delete(key) { map.delete(key) } }
}

function c6Input({ system, records, probe = probeOf(), sourceRows, writableTarget = 'confirmDate', tokenStore = memoryTokenStore() }) {
  return {
    pipeline: {
      id: 'pipe_d2r2_c6', tenantId: TENANT, workspaceId: 'w_d2r2', sourceSystemId: 'src_d2r2', sourceObject: 'items', targetSystemId: system.id, targetObject: 'main', createdBy: 'owner_d2r2',
      options: { source: { filters: { fixtureScope: 'd2r2' } } },
      fieldMappings: [
        { sourceField: 'k', targetField: 'idempotencyKey', validation: [{ type: 'required' }] },
        { sourceField: 'm', targetField: 'material' },
        { sourceField: 'd', targetField: writableTarget },
      ],
    },
    sourceSystem: { id: 'src_d2r2', kind: 'data-source:sql-readonly' },
    targetSystem: { id: system.id, kind: 'metasheet:multitable', config: { dataSourceId: 'mt_d2r2', object: 'main', keyFields: ['idempotencyKey'], writableFields: ['material', writableTarget] } },
    sourceAdapter: { async read() { return { records: sourceRows, done: true, nextCursor: null } } },
    dataSourceWrites: createMetaSheetMultitableWriteSource({ system, context: contextOf(records), governedSheetProbe: probe }),
    targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    tokenStore,
    dryRunUser: 'owner_d2r2',
    dataSourceOwnerPrincipal: 'owner_d2r2',
    maxRows: 100,
  }
}

test('D-01 C6 on a REGISTERED sheet with the machine column MAPPED as a writable field (alias): a machine-only difference plans SKIP on every dry-run; apply writes nothing, reports skip (writePerformed false), and the version does not move', async () => {
  const world = createRecords({ rows: [seededRow()] })
  const sourceRows = [{ k: 'idem-1', m: 'M-OLD', d: '2026-12-31' }]
  const first = await c6.dryRunExternalWrite(c6Input({ system: aliasSystem(), records: world.records, sourceRows }))
  assert.deepEqual({ update: first.counts.update, skip: first.counts.skip }, { update: 0, skip: 1 }, 'machine-only difference => skip')
  const tokenStore = memoryTokenStore()
  const second = await c6.dryRunExternalWrite(c6Input({ system: aliasSystem(), records: world.records, sourceRows, tokenStore }))
  assert.deepEqual({ update: second.counts.update, skip: second.counts.skip }, { update: 0, skip: 1 }, 'no churn')
  const applied = await c6.applyExternalWrite({ ...c6Input({ system: aliasSystem(), records: world.records, sourceRows, tokenStore }), dryRunToken: second.dryRunToken, applyUser: 'owner_d2r2', runId: 'run_d2r2_c6' })
  assert.deepEqual({ written: applied.counts.written, update: applied.counts.update, skip: applied.counts.skip }, { written: 0, update: 0, skip: 1 })
  assert.equal(callsNamed(world.calls, 'patchRecord').length, 0, 'no patch')
  assert.equal(world.store[0].version, 3, 'no version bump')
  assert.equal(world.store[0].data[PHYS[MACHINE]], SEEDED_DATE)
  // A real difference beside the machine column still plans and writes an update (machine column stripped).
  const changed = [{ k: 'idem-1', m: 'M-NEW', d: '2026-12-31' }]
  const third = await c6.dryRunExternalWrite(c6Input({ system: aliasSystem(), records: world.records, sourceRows: changed, tokenStore }))
  assert.equal(third.counts.update, 1)
  const applied2 = await c6.applyExternalWrite({ ...c6Input({ system: aliasSystem(), records: world.records, sourceRows: changed, tokenStore }), dryRunToken: third.dryRunToken, applyUser: 'owner_d2r2', runId: 'run_d2r2_c6b' })
  assert.deepEqual({ written: applied2.counts.written, update: applied2.counts.update }, { written: 1, update: 1 })
  assert.equal(world.store[0].data[PHYS[MACHINE]], SEEDED_DATE)
  assert.equal(world.store[0].data[PHYS.material], 'M-NEW')
})

test('D-02 REGRESSION C6 on a NON-stock-prep target: a difference in the machine-named column still plans UPDATE (byte-identical planner)', async () => {
  const world = createRecords({ rows: [seededRow()] })
  const plan = await c6.dryRunExternalWrite(c6Input({ system: aliasSystem(), records: world.records, probe: probeOf(NOT_REGISTERED), sourceRows: [{ k: 'idem-1', m: 'M-OLD', d: '2026-12-31' }] }))
  assert.deepEqual({ update: plan.counts.update, skip: plan.counts.skip }, { update: 1, skip: 0 })
})

test('D-04 REGRESSION C6 test() on a NON-stock-prep target makes no provisioning call (its call trace is unchanged); on a registered sheet it resolves the binding there', async () => {
  const withProject = systemWith('main', { fieldIdMap: { idempotencyKey: PHYS.idempotencyKey, material: PHYS.material } }, { projectId: PROJECT_ID })
  const plain = hostProvisioning()
  const world = createRecords({ rows: [seededRow()] })
  const source = createMetaSheetMultitableWriteSource({ system: withProject, context: contextOf(world.records, plain), governedSheetProbe: probeOf(NOT_REGISTERED) })
  const out = await source.test()
  assert.equal(out.success, true)
  assert.deepEqual(plain.calls, [], 'no provisioning call for a non-target object')
  const registered = hostProvisioning()
  const regProbe = probeOf()
  const regSource = createMetaSheetMultitableWriteSource({ system: withProject, context: contextOf(world.records, registered), governedSheetProbe: regProbe })
  await regSource.test()
  assert.ok(regProbe.calls.some(([name]) => name === 'registryBindingBySheet'), 'the registered sheet resolves its binding in test()')
  assert.deepEqual(world.calls, [], 'test() makes no records IO')
})

test('D-03 C6 apply: an update the write-source skips as machine-only is counted SKIP with writePerformed:false, never written', async () => {
  const world = createRecords({ rows: [seededRow()] })
  const source = createMetaSheetMultitableWriteSource({ system: aliasSystem(), context: contextOf(world.records), governedSheetProbe: probeOf() })
  const out = await source.updateRows('mt', 'main', [{ idempotencyKey: 'idem-1', confirmDate: '2026-12-31' }], { keyFields: ['idempotencyKey'] })
  assert.deepEqual({ rowCount: out.rowCount, machineColumnsOnlySkipped: out.machineColumnsOnlySkipped }, { rowCount: 0, machineColumnsOnlySkipped: 1 })
  // The apply loop, given that answer for a row the plan classed `update`.
  const sourceRows = [{ k: 'idem-1', m: 'M-NEW', d: '2026-12-31' }]
  const tokenStore = memoryTokenStore()
  const input = c6Input({ system: aliasSystem(), records: world.records, sourceRows, tokenStore })
  const plan = await c6.dryRunExternalWrite(input)
  const applyInput = { ...c6Input({ system: aliasSystem(), records: world.records, sourceRows, tokenStore }), dryRunToken: plan.dryRunToken, applyUser: 'owner_d2r2', runId: 'run_d2r2_c6d' }
  const real = applyInput.dataSourceWrites
  applyInput.dataSourceWrites = { ...real, test: real.test, lookupByKey: real.lookupByKey, insertRows: real.insertRows, async updateRows() { return { rowCount: 0, results: [], machineColumnsOnlySkipped: 1 } } }
  if (typeof real.machineColumnDiffExclusions === 'function') applyInput.dataSourceWrites.machineColumnDiffExclusions = real.machineColumnDiffExclusions
  const applied = await c6.applyExternalWrite(applyInput)
  assert.deepEqual({ written: applied.counts.written, update: applied.counts.update, skip: applied.counts.skip }, { written: 0, update: 0, skip: 1 })
  const events = (applied.provenanceEvents || []).map((event) => event && event.attrs && event.attrs.writePerformed)
  assert.equal(events.includes(true), false, 'no event claims a write')
})

// ── F5: an unreadable version ────────────────────────────────────────────────────────────────────

test('U-01 an UNREADABLE version on a stock-prep target is METASHEET_MULTITABLE_VERSION_UNREADABLE — NOT retryable — at the pipeline upsert and the C6 update (and the C6 row vocabulary keeps it)', async () => {
  const out = await upsertOne({ system: aliasSystem(), rows: [{ ...seededRow(), version: undefined }], record: { idempotencyKey: 'idem-1', material: 'M-NEW' } })
  assert.equal(out.result.failed, 1)
  assert.equal(out.result.errors[0].code, CODES.UNREADABLE)
  assert.notEqual(out.result.errors[0].retryable, true, 'not retryable')
  assert.equal(callsNamed(out.calls, 'patchRecord').length, 0)
  const world = createRecords({ rows: [{ ...seededRow(), version: undefined }] })
  const source = createMetaSheetMultitableWriteSource({ system: aliasSystem(), context: contextOf(world.records), governedSheetProbe: probeOf() })
  let caught = null
  try { await source.updateRows('mt', 'main', [{ idempotencyKey: 'idem-1', material: 'M-NEW' }], { keyFields: ['idempotencyKey'] }) } catch (error) { caught = error }
  assert.equal(caught && caught.code, CODES.UNREADABLE)
  assert.notEqual(caught.retryable, true)
  assert.equal(c6.__internals.valuesFreeErrorCode(caught), CODES.UNREADABLE)
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('generic-writer-machine-column-binding.test.cjs', tests)
