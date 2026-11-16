'use strict'

// R-71 ⑦.4 PR-4 — two template columns and the pull / write exclusions that keep existing sheets working.
//
//   发料确认日期 `issueConfirmDate`  plm_system (so the project sheet's human lock covers it) AND listed in
//                                   MACHINE_WRITEBACK_FIELD_IDS: a PLM refresh never writes it. Its one writer is the
//                                   YiDa issue-confirm write-back (PR-5, not in this slice).
//   项目规格型号 `projectSpecModel`  plm_system, an EMPTY column: its PLM source is field question F1 (open), so nothing
//                                   produces the key yet.
//
// Cases:
//   Y8-01 the template: both columns appended last, their ownership / type / zh label, neither key nor required.
//   Y8-02 the machine write-back contract is checked at load and refuses a list that names a non-column, a human
//         column, the key or a required column.
//   Y8-03 no template column is named `materialCode`, and neither new id is the suffix of any ext_ column of the two
//         shipped packs (the extension namespace refuses such a pair, FIELD_ID_TEMPLATE_COLLISION).
//   Y8-04 both columns are in the project sheet's human write lock.
//   Y8-05 the refresh bands: `issueConfirmDate` is outside the plm writable band (template-only and pack-aware) and
//         outside the human band; `projectSpecModel` is inside the writable band.
//   Y8-06 the planner never emits `issueConfirmDate` in an add record or an update patch, even when the intake row
//         carries one (a forged / mis-mapped row).
//   Y8-07 a written-back date on an existing row never triggers an update and is never blanked by one.
//   Y8-08 the planner's wall throws for each payload kind, and a change-plan entry naming the column throws.
//   Y8-09 `projectSpecModel` undeclared: the real BOM expansion (synthetic sources) produces no such key, so no
//         planned add / update carries it.
//   Y8-10 the apply writer refuses the column on an add, an update and an inactive patch, before any host write.
//   Y8-11 the writer's PR-8 one-re-read band excludes the column, and its own assertion bites.
//   Y8-12 a write-back committed between plan and apply is "a column the plugin does not write moved": the patch is
//         sent once more with the fresh version, the date survives, the run is NOT stopped.
//   Y8-13 the control for Y8-12: a moved plugin-written column on the same fake still stops the run.
//   Y8-14 pilot readiness on a pre-PR-4 sheet: red (columns missing) → columns added but unlocked: still red →
//         locked: green.
//   Y8-15 (备料 review item 3, data-loss guard) the planner treats `projectSpecModel` as a PLM-writable column with
//         no source value: an existing cell value (a person may type it on a deployment sheet) is never cleared — no
//         add / update / inactive / change-plan payload names it, an otherwise unchanged row is a SKIP, for both
//         band derivations (template-only and pack-aware) and for a key that is absent or present-but-undefined.
//   Y8-16a/b the same guard end to end through the real route stack (dry-run → apply), on a PROJECT sheet (a) and on
//         a DEPLOYMENT sheet (b), as two tests so one failing cannot mask the other: an existing row holding a typed
//         value and a moved PLM column → the update patch names the moved column and never `projectSpecModel`. The
//         deployment sheet is provisioned from the real sandbox descriptor, and (备料 review item 2) its two new
//         columns carry NO human write lock — a person may type into them there.
//   Y8-17 (备料 review item 1) the continuation exclusion: `projectSpecModel` (and the machine write-back column) is
//         neither a content trigger nor in the settlement machine band; the band is part of the sheet digest, so
//         removing the exclusion (the F1 slice) moves every governed sheet's machine digest once.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
// The demand-evidence golden harness must install its expansion capture switch BEFORE anything requires the table
// actions (the pilot-readiness module below does), so it is loaded first. Y8-09 drives it in 'off' mode only.
const goldenHarness = require('./support/stock-preparation-demand-evidence-golden-harness.cjs')
const expansionSwitch = goldenHarness.installExpansionCaptureSwitch()
const templates = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const planner = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const projectTargets = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { buildStockPreparationTargetDescriptor, sandboxStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { assertExtensionFieldIdValid } = require(path.join(LIB, 'stock-preparation-extension-namespace.cjs'))
const { normalizeCustomerPack } = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const { FACTORY_A_REHEARSAL_PACK } = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))
const { FACTORY_A_SAMPLE_PACK } = require(path.join(LIB, 'customer-packs', 'factory-a.sample.cjs'))
const { evaluatePilotReadiness } = require(path.join(LIB, 'stock-preparation-pilot-readiness.cjs'))
const continuation = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const projectSheet = require('./support/stock-preparation-project-sheet-harness.cjs')

const {
  HUMAN_PRESERVED_FIELD_IDS,
  MACHINE_WRITEBACK_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  StockPreparationTemplateError,
  assertMachineWritebackContract,
} = templates
const { DECISIONS, RUN_FIELD_IDS, derivePackAwarePlmWritableFields, planStockPreparationConflicts, StockPreparationConflictPlannerError } = planner
const { applyStockPreparationPlan, CHANGE_PLAN_STALE_CODE } = writer

const tests = []
const test = (name, fn) => tests.push([name, fn])

const ISSUE = 'issueConfirmDate'
const SPEC = 'projectSpecModel'
const NEW_COLUMNS = Object.freeze([ISSUE, SPEC])
const TEMPLATE_FIELDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
const fieldOf = (id) => TEMPLATE_FIELDS.find((field) => field.id === id)
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// ── fixtures for the planner ──────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run_y8_synthetic'
const PLANNED_AT = '2026-11-06T00:00:00.000Z'

function keyOf(component) {
  return JSON.stringify({ projectNo: 'P-Y8', componentSourceId: component, parentSourceId: null, path: [component] })
}

function row(component, extra = {}) {
  return {
    projectNo: 'P-Y8',
    idempotencyKey: keyOf(component),
    componentSourceId: component,
    path: component,
    componentCode: `${component}-C`,
    componentName: `${component} name`,
    material: 'M-1',
    rawQuantity: 2,
    totalQuantity: 2,
    active: true,
    ...extra,
  }
}

function payloadsOf(plan) {
  return plan.decisions.flatMap((decision) => [decision.record, decision.patch].filter(Boolean))
}

// ── Y8-01 .. Y8-04: the template ─────────────────────────────────────────────────────────────────────

test('Y8-01 the template: both columns appended last; plm_system; date / string; zh labels; neither key nor required', () => {
  assert.deepEqual(TEMPLATE_FIELDS.slice(-2).map((field) => field.id), [...NEW_COLUMNS], 'appended last, so no deployed column moves')
  assert.equal(TEMPLATE_FIELDS.length, 35)
  assert.deepEqual(
    NEW_COLUMNS.map((id) => [fieldOf(id).ownership, fieldOf(id).type, fieldOf(id).labelZh, fieldOf(id).label]),
    [['plm_system', 'date', '发料确认日期', 'Issue Confirm Date'], ['plm_system', 'string', '项目规格型号', 'Project Spec Model']],
  )
  for (const id of NEW_COLUMNS) {
    assert.notEqual(fieldOf(id).required, true, `${id} is optional (a refresh builds a whole row without it)`)
    assert.notEqual(fieldOf(id).key, true, `${id} is not a key`)
    assert.equal(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.keyFields.includes(id), false)
    assert.equal(HUMAN_PRESERVED_FIELD_IDS.includes(id), false, `${id} is not on the human whitelist`)
    assert.equal(fieldOf(id).preserveOnRefresh, undefined, `${id} carries no human preserve flag`)
  }
  assert.deepEqual([...MACHINE_WRITEBACK_FIELD_IDS], [ISSUE])
  assert.ok(Object.isFrozen(MACHINE_WRITEBACK_FIELD_IDS), 'the list is frozen')
})

test('Y8-02 the machine write-back contract refuses a non-column, a human column, the key and a required column', () => {
  assert.equal(assertMachineWritebackContract(), true)
  for (const bad of ['notAColumn', 'notes', 'idempotencyKey', 'totalQuantity', 'projectNo']) {
    assert.throws(
      () => assertMachineWritebackContract({ machineWritebackFieldIds: [bad] }),
      (error) => error instanceof StockPreparationTemplateError,
      bad,
    )
  }
})

test('Y8-03 no column is named materialCode; neither new id is an ext_ suffix of either shipped pack; both packs still normalize', () => {
  const ids = TEMPLATE_FIELDS.map((field) => field.id.toLowerCase())
  assert.equal(ids.includes('materialcode'), false, 'materialCode would collide with the installed ext_materialCode')
  const templateFieldIds = TEMPLATE_FIELDS.map((field) => field.id)
  let extCount = 0
  for (const pack of [FACTORY_A_REHEARSAL_PACK, FACTORY_A_SAMPLE_PACK]) {
    for (const extension of pack.extensionFields) {
      extCount += 1
      const suffix = extension.id.slice('ext_'.length).toLowerCase()
      for (const id of NEW_COLUMNS) assert.notEqual(suffix, id.toLowerCase(), `${extension.id} collides with ${id}`)
      assert.doesNotThrow(() => assertExtensionFieldIdValid(extension.id, { templateFieldIds }), extension.id)
    }
    assert.doesNotThrow(() => normalizeCustomerPack(pack), pack.id)
  }
  assert.ok(extCount > 0, 'the packs carry ext_ columns (not vacuous)')
  assert.ok([FACTORY_A_REHEARSAL_PACK, FACTORY_A_SAMPLE_PACK].some((pack) => pack.extensionFields.some((field) => field.id === 'ext_materialCode')),
    'the pack column the materialCode rule protects is really installed by a shipped pack')
  // The rule bites: a template id equal to that suffix is refused by the namespace.
  assert.throws(() => assertExtensionFieldIdValid('ext_materialCode', { templateFieldIds: [...templateFieldIds, 'materialCode'] }),
    (error) => error.reason === 'FIELD_ID_TEMPLATE_COLLISION')
})

test('Y8-04 both columns are in the project sheet\'s human write lock (a person cannot edit either)', () => {
  for (const id of NEW_COLUMNS) assert.ok(projectTargets.PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS.includes(id), id)
  assert.deepEqual(
    [...projectTargets.PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS],
    TEMPLATE_FIELDS.filter((field) => field.ownership === 'plm_system').map((field) => field.id),
  )
})

// ── Y8-05 .. Y8-09: the planner ──────────────────────────────────────────────────────────────────────

test('Y8-05 the refresh bands: issueConfirmDate is outside the writable band and the human band; projectSpecModel is inside the writable band', () => {
  const installed = [
    { id: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
    { id: ISSUE, property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
  ]
  for (const installedFieldProperties of [undefined, installed]) {
    const bands = derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties })
    assert.equal(bands.plmWritableFieldIds.includes(ISSUE), false, 'never in the writable band')
    assert.equal(bands.humanPreservedFieldIds.includes(ISSUE), false, 'not human either')
    assert.ok(bands.plmWritableFieldIds.includes(SPEC), 'the empty column is an ordinary refresh column')
    for (const id of RUN_FIELD_IDS) assert.equal(bands.plmWritableFieldIds.includes(id), false)
  }
  assert.equal(planner.__internals.plmRefreshFieldIds(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE).includes(ISSUE), false)
  assert.ok(planner.__internals.plmRefreshFieldIds(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE).includes(SPEC))
})

test('Y8-06 a forged intake row carrying issueConfirmDate: no add record and no update patch carries it', () => {
  const plan = planStockPreparationConflicts({
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    expandedRows: [row('A', { [ISSUE]: '2026-01-01' }), row('B', { [ISSUE]: '2026-01-02', totalQuantity: 5 })],
    existingRows: [row('B')],
  })
  assert.deepEqual(plan.decisions.map((decision) => decision.decision).sort(), [DECISIONS.ADD, DECISIONS.UPDATE].sort())
  for (const payload of payloadsOf(plan)) assert.equal(Object.prototype.hasOwnProperty.call(payload, ISSUE), false)
  for (const decision of plan.decisions) assert.equal((decision.changedFields || []).includes(ISSUE), false)
  assert.equal(plan.summary.plmSystemFields.includes(ISSUE), false, 'not reported as a refreshed column')
})

test('Y8-07 a written-back date on an existing row never triggers an update and is never blanked by one', () => {
  const unchanged = planStockPreparationConflicts({
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    expandedRows: [row('A'), row('B', { [ISSUE]: '2027-12-31' })],
    existingRows: [row('A', { [ISSUE]: '2026-10-01' }), row('B', { [ISSUE]: '2026-10-02' })],
  })
  assert.deepEqual(unchanged.decisions.map((decision) => decision.decision), [DECISIONS.SKIP, DECISIONS.SKIP])
  const changed = planStockPreparationConflicts({
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    expandedRows: [row('A', { totalQuantity: 9 })],
    existingRows: [row('A', { [ISSUE]: '2026-10-01' })],
  })
  assert.equal(changed.decisions[0].decision, DECISIONS.UPDATE)
  assert.equal(Object.prototype.hasOwnProperty.call(changed.decisions[0].patch, ISSUE), false, 'the patch never names the column, so the date survives')
})

test('Y8-08 the planner wall throws for each payload kind, and a change-plan entry naming the column throws', () => {
  const { assertNoMachineWritebackFields, makeChangePlanUpdateDecision } = planner.__internals
  for (const context of ['add record', 'update patch', 'change plan patch', 'inactive patch']) {
    assert.throws(() => assertNoMachineWritebackFields({ [ISSUE]: '2026-01-01' }, context),
      (error) => error instanceof StockPreparationConflictPlannerError && error.details.field === ISSUE && error.details.context === context)
    assert.doesNotThrow(() => assertNoMachineWritebackFields({ [SPEC]: 'S', material: 'M' }, context))
  }
  const entry = { writeFields: { material: { before: 'M-1', after: 'M-2' }, [ISSUE]: { before: null, after: '2026-01-01' } } }
  assert.throws(() => makeChangePlanUpdateDecision(keyOf('A'), entry, RUN_ID, PLANNED_AT, HUMAN_PRESERVED_FIELD_IDS.slice(), 'cp_y8'),
    (error) => error instanceof StockPreparationConflictPlannerError && error.details.field === ISSUE)
  const ok = makeChangePlanUpdateDecision(keyOf('A'), { writeFields: { material: { before: 'M-1', after: 'M-2' } } }, RUN_ID, PLANNED_AT, HUMAN_PRESERVED_FIELD_IDS.slice(), 'cp_y8')
  assert.equal(ok.patch.material, 'M-2')
})

test('Y8-09 projectSpecModel undeclared: the real expansion produces no such key, so no planned add / update carries it', async () => {
  const observed = await goldenHarness.observeAll(expansionSwitch, 'off', undefined, { handle: 'wired' })
  let rows = 0
  for (const scenario of Object.values(observed)) {
    for (const call of scenario.__calls) {
      for (const expandedRow of (call.result && call.result.rows) || []) {
        rows += 1
        for (const id of NEW_COLUMNS) assert.equal(Object.prototype.hasOwnProperty.call(expandedRow, id), false, `an expansion row carries ${id}`)
      }
      const plan = planStockPreparationConflicts({ runId: RUN_ID, plannedAt: PLANNED_AT, expandedRows: (call.result && call.result.rows) || [], existingRows: [] })
      for (const payload of payloadsOf(plan)) {
        for (const id of NEW_COLUMNS) assert.equal(Object.prototype.hasOwnProperty.call(payload, id), false, `a planned payload carries ${id}`)
      }
    }
  }
  assert.ok(rows > 0, 'the synthetic expansions produced rows (not vacuous)')
})

// ── Y8-10 .. Y8-13: the apply writer ────────────────────────────────────────────────────────────────

const SHEET = 'sheet_y8_main'

function seedRecord(component, id, extra = {}) {
  return { id, sheetId: SHEET, version: 3, data: { ...row(component), notes: null, ...extra } }
}

function versionConflict() {
  return Object.assign(new Error('Record version conflict'), { code: 'VERSION_CONFLICT', name: 'MultitableRecordVersionConflictError' })
}

// The host as records.ts models it: read -> compare expectedVersion -> merge -> write version + 1.
function createHost(seed) {
  const rows = seed.map(clone)
  const calls = []
  const hooks = { beforeHostRead: null }
  const api = {
    supportsWriteFence: true,
    async queryRecords(input = {}) {
      calls.push(['queryRecords', clone(input)])
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => (Array.isArray(value) ? value.includes(record.data[field]) : record.data[field] === value)))
        .map(clone)
    },
    async createRecord(input = {}) {
      calls.push(['createRecord', clone(input)])
      const record = { id: `rec_y8_new_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      calls.push(['patchRecord', clone(input)])
      if (hooks.beforeHostRead) await hooks.beforeHostRead(input.recordId)
      const record = rows.find((entry) => entry.sheetId === input.sheetId && entry.id === input.recordId)
      if (!record) throw Object.assign(new Error('Record not found'), { name: 'MultitableRecordNotFoundError' })
      if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) throw versionConflict()
      record.data = { ...record.data, ...(input.changes || {}) }
      record.version += 1
      return clone(record)
    },
  }
  return { rows, calls, hooks, api }
}

function commit(host, recordId, changes) {
  const record = host.rows.find((entry) => entry.id === recordId)
  record.data = { ...record.data, ...changes }
  record.version += 1
}

const runStamps = { lastPlmRefreshRunId: RUN_ID, lastPlmRefreshAt: PLANNED_AT, lastPlmRefreshDecision: 'update', lastPlmConflictSummary: '{}' }

function apply(host, decisions, extra = {}) {
  return applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain' },
    recordsApi: host.api,
    ...extra,
  })
}

const hostWrites = (host) => host.calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord')

test('Y8-10 the writer refuses the column on an add, an update and an inactive patch, before any host write', async () => {
  const cases = [
    { decision: DECISIONS.ADD, idempotencyKey: keyOf('N'), record: { ...row('N'), [ISSUE]: '2026-01-01', ...runStamps } },
    { decision: DECISIONS.UPDATE, idempotencyKey: keyOf('A'), patch: { material: 'M-2', [ISSUE]: '2026-01-01', ...runStamps } },
    { decision: DECISIONS.INACTIVE, idempotencyKey: keyOf('A'), patch: { active: false, [ISSUE]: null, ...runStamps } },
  ]
  for (const decision of cases) {
    const host = createHost([seedRecord('A', 'rec_a')])
    const result = await apply(host, [decision])
    assert.equal(result.counts.failed, 1, decision.decision)
    assert.equal(result.errors[0].field, ISSUE, decision.decision)
    assert.deepEqual(hostWrites(host), [], `${decision.decision}: nothing reached the host`)
  }
  // The same payloads without the column are written (the refusal is the column, not the shape).
  const host = createHost([seedRecord('A', 'rec_a')])
  const result = await apply(host, [{ decision: DECISIONS.UPDATE, idempotencyKey: keyOf('A'), patch: { material: 'M-2', [SPEC]: 'SPEC-SYN', ...runStamps } }])
  assert.equal(result.status, 'succeeded')
  assert.equal(host.rows[0].data[SPEC], 'SPEC-SYN', 'the empty column is an ordinary refresh column for the writer')
})

test('Y8-11 the PR-8 one-re-read band excludes the column, and the writer\'s own band assertion bites', () => {
  const { assertWrittenBandExcludesMachineWriteback, assertNoMachineWritebackFields } = writer.__internals
  const bands = derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS })
  const band = Array.from(new Set([...bands.plmWritableFieldIds, ...RUN_FIELD_IDS])).sort()
  assert.equal(band.includes(ISSUE), false)
  assert.deepEqual(assertWrittenBandExcludesMachineWriteback(band), band)
  assert.throws(() => assertWrittenBandExcludesMachineWriteback([...band, ISSUE]), (error) => error.details.field === ISSUE)
  assert.throws(() => assertNoMachineWritebackFields({ [ISSUE]: 'x' }, 'add record'), (error) => error.details.field === ISSUE)
})

test('Y8-12 a write-back committed between plan and apply: one re-read, the same patch once more, the date survives, the run is not stopped', async () => {
  const seed = [seedRecord('A', 'rec_a')]
  const host = createHost(seed)
  const expectedRecords = new Map(seed.map((record) => [record.data.idempotencyKey, { id: record.id, version: record.version, row: clone(record.data) }]))
  let injected = false
  host.hooks.beforeHostRead = async (recordId) => {
    if (injected || recordId !== 'rec_a') return
    injected = true
    commit(host, 'rec_a', { [ISSUE]: '2026-11-05' })
  }
  const result = await apply(host, [{ decision: DECISIONS.UPDATE, idempotencyKey: keyOf('A'), patch: { material: 'M-2', ...runStamps }, changedFields: ['material'] }], { expectedRecords })
  assert.equal(result.status, 'succeeded', JSON.stringify(result.abort || result.errors))
  const patches = host.calls.filter(([method]) => method === 'patchRecord').map(([, input]) => input)
  assert.equal(patches.length, 2, 'one conflict, one retry')
  assert.equal(patches[0].expectedVersion, 3)
  assert.equal(patches[1].expectedVersion, 4, 'the retry carries the version the re-read found')
  assert.deepEqual(patches[1].changes, patches[0].changes, 'the same patch, never rebuilt from the re-read row')
  assert.equal(host.rows[0].data[ISSUE], '2026-11-05', 'the written-back date survives the refresh')
  assert.equal(host.rows[0].data.material, 'M-2')
})

test('Y8-13 control: on the same fake, a moved plugin-written column still stops the run (machine_columns_moved)', async () => {
  const seed = [seedRecord('A', 'rec_a')]
  const host = createHost(seed)
  const expectedRecords = new Map(seed.map((record) => [record.data.idempotencyKey, { id: record.id, version: record.version, row: clone(record.data) }]))
  let injected = false
  host.hooks.beforeHostRead = async () => {
    if (injected) return
    injected = true
    commit(host, 'rec_a', { componentName: 'moved by someone else' })
  }
  const outcome = await apply(host, [{ decision: DECISIONS.UPDATE, idempotencyKey: keyOf('A'), patch: { material: 'M-2', ...runStamps }, changedFields: ['material'] }], { expectedRecords })
    .then((result) => ({ result }), (error) => ({ error }))
  const error = outcome.error || (outcome.result && outcome.result.abort && outcome.result.abort.error)
  assert.ok(error, JSON.stringify(outcome.result))
  assert.equal(error.code, CHANGE_PLAN_STALE_CODE)
  assert.equal(error.details.reason, 'machine_columns_moved')
})

// ── Y8-14: pilot readiness across the upgrade ───────────────────────────────────────────────────────

test('Y8-14 pilot readiness on a pre-PR-4 sheet: red while the two columns are missing, red while they are unlocked, green once locked', async () => {
  const tenantId = 'tenant_y8_ready'
  const projectId = `${tenantId}:integration-core`
  const objectId = projectTargets.deriveProjectSheetObjectId(tenantId, 'P-Y8')
  const fields = new Map()
  for (const field of TEMPLATE_FIELDS) {
    if (NEW_COLUMNS.includes(field.id)) continue
    fields.set(field.id, { id: `fld_${field.id}`, property: field.ownership === 'plm_system' ? { [projectTargets.HUMAN_WRITE_LOCK_PROPERTY_KEY]: 'plm_system' } : {} })
  }
  const provisioning = {
    async resolveExistingObjectFieldIds({ fieldIds }) {
      const out = {}
      for (const id of fieldIds) if (fields.has(id)) out[id] = fields.get(id).id
      return out
    },
    async getObjectField({ fieldId }) {
      return fields.has(fieldId) ? clone(fields.get(fieldId)) : null
    },
    async patchObjectFieldProperty({ fieldId, propertyPatch }) {
      const field = fields.get(fieldId)
      field.property = { ...field.property, ...propertyPatch }
      return clone(field)
    },
  }
  const verdict = async () => {
    const result = await evaluatePilotReadiness({ provisioning, projectId, objectId })
    return Object.fromEntries(result.checks.filter((check) => ['target_fields_present', 'plm_column_lock'].includes(check.id)).map((check) => [check.id, check.ok]))
  }
  assert.deepEqual(await verdict(), { target_fields_present: false, plm_column_lock: false }, 'a pre-PR-4 sheet is not ready')
  for (const id of NEW_COLUMNS) fields.set(id, { id: `fld_${id}`, property: {} })
  assert.deepEqual(await verdict(), { target_fields_present: true, plm_column_lock: false }, 'added but unlocked: still not ready')
  const marked = await projectTargets.markProjectSheetPlmSystemColumns({ provisioning, projectId, objectId })
  assert.deepEqual([...marked.markedFieldIds].sort(), [...NEW_COLUMNS].sort(), 'the lock pass marks exactly the two new columns')
  assert.deepEqual(await verdict(), { target_fields_present: true, plm_column_lock: true }, 'locked: ready')
})

// ── Y8-15 .. Y8-16: an existing projectSpecModel value is never cleared by a refresh ────────────────────────

const TYPED_SPEC = 'SPEC-TYPED-BY-HAND'
const PACK_AWARE_INSTALLED = Object.freeze([
  { id: 'ext_nameAndSpec', property: { stockPreparation: { ownership: 'plm_system', extension: true } } },
])

test('Y8-15 data-loss guard (planner): the source lacks projectSpecModel → an existing value is never cleared, for both band derivations', () => {
  for (const installedFieldProperties of [undefined, PACK_AWARE_INSTALLED]) {
    const label = installedFieldProperties ? 'pack-aware' : 'template-only'
    // Anti-vacuity: the column IS in the writable band the planner patches from (that is the risk being guarded).
    assert.ok(derivePackAwarePlmWritableFields({ templateFields: TEMPLATE_FIELDS, installedFieldProperties }).plmWritableFieldIds.includes(SPEC), label)
    const plan = planStockPreparationConflicts({
      runId: RUN_ID,
      plannedAt: PLANNED_AT,
      installedFieldProperties,
      expandedRows: [
        row('A'), // unchanged apart from the typed cell: SKIP
        row('B', { totalQuantity: 7 }), // a real change: UPDATE without the column
        row('C', { [SPEC]: undefined, totalQuantity: 8 }), // key present, value undefined = absent
        row('N'), // new row: ADD without the column
      ],
      existingRows: [
        row('A', { [SPEC]: TYPED_SPEC }),
        row('B', { [SPEC]: TYPED_SPEC }),
        row('C', { [SPEC]: TYPED_SPEC }),
        row('D', { [SPEC]: TYPED_SPEC }), // gone from the source: INACTIVE without the column
      ],
    })
    const byKey = new Map(plan.decisions.map((decision) => [decision.idempotencyKey, decision]))
    assert.equal(byKey.get(keyOf('A')).decision, DECISIONS.SKIP, `${label}: a typed cell alone is not a change`)
    for (const component of ['B', 'C']) {
      const decision = byKey.get(keyOf(component))
      assert.equal(decision.decision, DECISIONS.UPDATE, `${label} ${component}`)
      assert.ok(Object.prototype.hasOwnProperty.call(decision.patch, 'totalQuantity'), `${label} ${component}: the real change is patched`)
      assert.equal(Object.prototype.hasOwnProperty.call(decision.patch, SPEC), false, `${label} ${component}: the update patch never names ${SPEC}`)
      assert.equal(decision.changedFields.includes(SPEC), false, `${label} ${component}`)
    }
    assert.equal(byKey.get(keyOf('N')).decision, DECISIONS.ADD, label)
    assert.equal(Object.prototype.hasOwnProperty.call(byKey.get(keyOf('N')).record, SPEC), false, `${label}: an add record never names ${SPEC}`)
    assert.equal(byKey.get(keyOf('D')).decision, DECISIONS.INACTIVE, label)
    assert.equal(Object.prototype.hasOwnProperty.call(byKey.get(keyOf('D')).patch, SPEC), false, `${label}: an inactive patch never names ${SPEC}`)
    for (const payload of payloadsOf(plan)) assert.equal(Object.prototype.hasOwnProperty.call(payload, SPEC), false, label)
  }
})

const Y16_TENANT = 'tenant_y8_spec_survives'
const Y16_PROJECT = 'PRJ-Y8-SPEC-1'
const Y16_ENV_OBJECT = 'plm_stock_preparation_sandbox_y8_env'
const Y16_ENV_SHEET = `sheet_${Y16_TENANT}:integration-core_${Y16_ENV_OBJECT}`.replace(/[^A-Za-z0-9_]/g, '_')
const Y16_PULLER = Object.freeze({ id: 'u_y8_pull', tenantId: Y16_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const Y16_ACTION_PATH = (verb) => `/api/integration/table-actions/:actionId/${verb}`

function mountSheetKind(kind) {
  if (kind === 'project') return projectSheet.mountProjectSheetRoutes({ tenantId: Y16_TENANT, projectNo: Y16_PROJECT, switchOn: true })
  // The deployment's env target: the sheet provisioning derives for this tenant's env object (the shape a sanctioned
  // config has; the switch is off, so the table action — not the registry — names the sheet).
  return projectSheet.mountProjectSheetRoutes({
    tenantId: Y16_TENANT,
    projectNo: Y16_PROJECT,
    switchOn: false,
    envObjectId: Y16_ENV_OBJECT,
    configExtras: {
      stockPreparationTableActions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly' },
        target: { sheetId: Y16_ENV_SHEET, objectId: Y16_ENV_OBJECT, fieldIdMap: {} },
      }],
    },
  })
}

async function pullOnce(h) {
  const call = (verb, body) => projectSheet.call(h.routes, 'POST', Y16_ACTION_PATH(verb), {
    user: Y16_PULLER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body,
    query: { tenantId: Y16_TENANT },
  })
  const dry = await call('dry-run', { parameters: { projectNo: Y16_PROJECT } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  const applied = await call('apply', { parameters: { projectNo: Y16_PROJECT }, confirm: { dryRunToken: dry.body.data.dryRunToken } })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.apply.counts.failed, 0, JSON.stringify(applied.body.data.apply))
  return applied.body.data.apply
}

// The stored key of a logical column on this sheet: the project sheet stores PHYSICAL ids (`fld_<hash>_<logical>`),
// the deployment sheet (fieldIdMap {}) logical ids. Derived from the row the first pull wrote.
function physicalKeyOf(data, logical) {
  const anchor = Object.keys(data).find((key) => key === 'componentSourceId' || key.endsWith('_componentSourceId'))
  assert.ok(anchor, 'a written row carries componentSourceId')
  return `${anchor.slice(0, anchor.length - 'componentSourceId'.length)}${logical}`
}

// The deployment sheet a real deployment has: provisioned by the sandbox ensure path's own descriptor
// (buildStockPreparationTargetDescriptor over sandboxStockPreparationTemplate, target-provisioning.cjs), replacing the
// harness's bare seed, so the column properties below are the ones a deployment really gets.
async function provisionDeploymentSheetFromDescriptor(h) {
  const descriptor = buildStockPreparationTargetDescriptor({ template: sandboxStockPreparationTemplate({ objectId: Y16_ENV_OBJECT }) })
  for (const id of NEW_COLUMNS) assert.ok(descriptor.fields.some((field) => field.id === id), `the sandbox descriptor carries ${id}`)
  await h.provisioning.ensureObject({ projectId: h.staging, descriptor })
}

function deploymentColumnProperty(h, id) {
  const object = h.provisioning.objects.get(`${h.staging}/${Y16_ENV_OBJECT}`)
  assert.ok(object, 'the deployment sheet exists on the host')
  const field = object.fields.get(id)
  assert.ok(field, `deployment: the sheet has ${id}`)
  return field.property || {}
}

async function assertRefreshNeverWritesSpecOverTypedValue(kind) {
  const h = mountSheetKind(kind)
  try {
    if (kind === 'deployment') await provisionDeploymentSheetFromDescriptor(h)
    if (kind === 'project') {
      const created = await projectSheet.call(h.routes, 'POST', '/api/integration/stock-preparation/projects/:projectNo/target', { user: Y16_PULLER, params: { projectNo: Y16_PROJECT }, body: {} })
      assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    }
    const first = await pullOnce(h)
    assert.ok(first.written >= 1, `${kind}: the first pull wrote rows`)
    const written = (await h.records.queryRecords({ sheetId: kind === 'project' ? h.provisioning.sheetIdOf(h.staging, h.projectObjectId()) : Y16_ENV_SHEET, filters: {}, limit: 1000 }))
    assert.ok(written.length >= 1, kind)
    const sheetId = written[0].sheetId
    const specKey = physicalKeyOf(written[0].data, SPEC)
    const movedKey = physicalKeyOf(written[0].data, 'totalQuantity')
    assert.equal(Object.prototype.hasOwnProperty.call(written[0].data, specKey), false, `${kind}: the first pull did not write ${SPEC}`)
    // What the host now answers for the sheet: a person typed the empty column (possible on a deployment sheet,
    // which carries no human lock) and the PLM column totalQuantity moved (not an identity column, so the next pull
    // plans a plain UPDATE rather than an identity hold).
    const realQuery = h.records.queryRecords
    h.records.queryRecords = async (input) => (await realQuery(input)).map((record) => (record.sheetId === sheetId
      ? { ...record, data: { ...record.data, [specKey]: TYPED_SPEC, [movedKey]: 999 } }
      : record))
    const patches = []
    const creates = []
    const realPatch = h.records.patchRecord
    const realCreate = h.records.createRecord
    h.records.patchRecord = async (input) => { patches.push(clone(input.changes || {})); return realPatch(input) }
    h.records.createRecord = async (input) => { creates.push(clone(input.data || {})); return realCreate(input) }
    const second = await pullOnce(h)
    assert.ok(second.counts.updated >= 1, `${kind}: the moved PLM column is refreshed (not vacuous): ${JSON.stringify(second.counts)}`)
    assert.ok(patches.length >= 1, kind)
    assert.ok(patches.some((changes) => Object.prototype.hasOwnProperty.call(changes, movedKey)), `${kind}: the patch restores the moved PLM column`)
    for (const changes of [...patches, ...creates]) {
      assert.equal(Object.prototype.hasOwnProperty.call(changes, specKey), false, `${kind}: a refresh write named ${SPEC}: ${JSON.stringify(Object.keys(changes))}`)
    }
    if (kind === 'deployment') {
      // 备料 review item 2: deployment (non-project) sheets are not locked — after provisioning and two pulls the two
      // new columns carry the template's plm_system marker (not vacuous: the real descriptor's property reached the
      // host) and NO humanWriteLock, so a person may type into them on this sheet.
      for (const id of NEW_COLUMNS) {
        const property = deploymentColumnProperty(h, id)
        assert.equal(property.stockPreparation && property.stockPreparation.ownership, 'plm_system', `deployment: ${id} came from the real descriptor`)
        assert.equal(Object.prototype.hasOwnProperty.call(property, 'humanWriteLock'), false, `deployment: ${id} carries no humanWriteLock: ${JSON.stringify(property)}`)
      }
    }
  } finally { h.restore() }
}

test('Y8-16a data-loss guard end to end on a PROJECT sheet: a refresh never writes projectSpecModel over a typed value', async () => {
  await assertRefreshNeverWritesSpecOverTypedValue('project')
})

test('Y8-16b data-loss guard end to end on a DEPLOYMENT sheet: a refresh never writes projectSpecModel over a typed value; the two columns carry no humanWriteLock', async () => {
  await assertRefreshNeverWritesSpecOverTypedValue('deployment')
})

// ── Y8-17: the continuation exclusion (备料 review item 1) ─────────────────────────────────────────────────

test('Y8-17 the continuation exclusion: projectSpecModel is no content trigger and not in the machine band; the band is part of the sheet digest', () => {
  assert.deepEqual([...continuation.UNSOURCED_PLM_FIELD_IDS], [SPEC], 'removed by the slice that answers F1 (PR-6), not before')
  for (const installedFieldProperties of [undefined, PACK_AWARE_INSTALLED]) {
    const triggers = continuation.contentTriggerFieldIds({ installedFieldProperties })
    const band = continuation.machineBandFieldIds({ installedFieldProperties })
    for (const id of NEW_COLUMNS) {
      assert.equal(triggers.includes(id), false, `${id} is not a content trigger`)
      assert.equal(band.includes(id), false, `${id} is not in the settlement machine band`)
    }
    // Positive control: sourced plm_system columns are triggers and in the band.
    for (const id of ['componentSpec', 'material']) {
      assert.ok(triggers.includes(id), id)
      assert.ok(band.includes(id), id)
    }
  }
  // The day the exclusion is removed: the band is hashed WITH the rows, so every governed sheet's machine digest moves
  // once even when every projectSpecModel cell is blank (the F1 slice must announce it).
  // The record reference the existing-row read attaches (stock-preparation-conflict-planner.cjs EXISTING_ROW_RECORD_REF).
  const rows = [{ ...row('A'), [Symbol.for('metasheet.stock-preparation.existingRow.recordRef')]: { id: 'rec_y8_a', version: 1 } }]
  const band = continuation.machineBandFieldIds({})
  assert.notEqual(
    continuation.sheetMachineDigest(rows, { machineFieldIds: band }),
    continuation.sheetMachineDigest(rows, { machineFieldIds: [...band, SPEC] }),
  )
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-template-issue-confirm-spec-columns.test.cjs', tests)
