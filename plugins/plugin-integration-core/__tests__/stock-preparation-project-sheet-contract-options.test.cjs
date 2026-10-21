'use strict'

// 一个项目一张备料表 — THE G1 FIELD DEFECT (R67). At the G1 switch-on the field team pulled a project into a
// freshly created project sheet: dry-run 652 ready, apply 200 with `apply.status = failed`, `counts.failed =
// 652`, every row `select_option_not_found` — the sheet's contract select column (最近刷新决定,
// `lastPlmRefreshDecision`) had NO options, because the only writer of the contract set always targets the
// deployment object. And the registry then said `applied`, so 「最近拉取」 showed success.
//
// Hermetic: the shared project-sheet harness (REAL route stack, REAL registry store over a memory db, fake host
// provisioning with real per-object field sets) plus, on top of its records fake, the HOST's select validation
// (records.ts `normalizeSelectValue`: a select value must be one of the field's `property.options`) — the one
// check the field report hit. Synthetic values only.
//
//   G1-01 THE FIELD TEAM'S TEST: a project sheet created through the create route carries the 5 contract
//         options on its decision column (and nothing on the config_info selects); dry-run → apply writes ≥ 1
//         row under the host's validation; the registry says `applied`, no code.
//   G1-02 THE DEFECT, REPRODUCED AND REPAIRED: a sheet created BEFORE the fix (decision options stripped) fails
//         every row `select_option_not_found` → the registry says `failed` + SELECT_OPTION_NOT_FOUND (list route
//         and overview cell show it, zh and en); the repair call puts the 5 options back on THAT sheet; the
//         next apply writes and the registry says `applied` again.
//   G1-03 PARTIAL: 1 of 4 rows written, 2 refused `select_option_not_found`, 1 `missing_required_field` → the
//         registry says `failed` with the DOMINANT code (2 > 1, not the alphabetically first).
//   G1-04 CREATE IDEMPOTENT: provisioning the same sheet twice writes the same option body twice, the decision
//         field only; the create replay (200) does not re-patch; a patch the host refuses AFTER the ensure fails
//         the create with ONE typed code, registers nothing, and the retry reuses the ONE sheet.
//   G1-05 A HOST WITHOUT THE FIELD-METADATA PORT is refused BEFORE anything is provisioned.
//   G1-06 REPAIR, registered: 200; the patch addresses (the verified tenant's staging project, the REGISTRY
//         ROW's objectId), the decision field only; one audit row; idempotent.
//   G1-07 REPAIR resolves ONLY through the registry: a row whose objectId is not the derived one is patched at
//         the ROW's objectId, never the derived one.
//   G1-08 REPAIR refusals, none of which touches the host: unregistered → 404; another tenant's project → 404
//         (its sheet untouched); a request-carried tenant → refused; archived → 409; switch off → 404 DISABLED
//         with zero IO; below the admin tier → 403 with zero IO; any key beside projectNo → 400; a malformed
//         number → 400.
//   G1-09 WITHOUT projectNo the route is byte-identical to main: the response and the host call log of the
//         legacy sync are pinned to what origin/main (f106c7eff) answers for the same request on this fake.
//   G1-10 THE OVERVIEW CELL: `failed` + code in zh / en; applied / previewed / refused unchanged.
//   G1-11 THE VOCABULARY: the store enum is the four outcomes, set-equal to the web clamp's list and to the
//         migration that admits `failed`; 087's list is untouched; the store stamps `failed`.
//   G1-12 (review LOW-1) `projectNo` in the QUERY STRING, any case, is 400 with no IO — with an empty body (which
//         used to answer 200 after syncing the DEPLOYMENT object) and with a body that names it too; the body-only
//         repair is unchanged and a query without the key still reaches the legacy sync.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const { runFailClosedSuite } = require(path.join(__dirname, 'support', 'fail-closed-suite-runner.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { DEFAULT_CONTRACT_OPTION_SETS } = require(path.join(LIB, 'stock-preparation-option-sync.cjs'))
const { provisionProjectSheet, deriveProjectSheetObjectId } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { PROJECT_TARGET_PULL_OUTCOMES, createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const overview = require(path.join(LIB, 'stock-preparation-project-overview.cjs'))

const TENANT = 'tenant-g1-options'
const OTHER_TENANT = 'tenant-g1-foreign'
const PROJECT = 'PRJ-G1-OPT-1'
const PROJECT_B = 'PRJ-G1-OPT-2'
const STAGING = `${TENANT}:integration-core`
const DECISION_FIELD = 'lastPlmRefreshDecision'
const CONTRACT_VALUES = ['add', 'update', 'skip', 'inactive', 'manual_confirm']
const CONFIG_INFO_SELECTS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields
  .filter((field) => field.type === 'select' && field.optionSource && field.optionSource.type === 'config_info')
  .map((field) => field.id)

const PULLER = Object.freeze({ id: 'u_g1_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const ADMIN = Object.freeze({ id: 'u_g1_admin', tenantId: TENANT, permissions: ['role:admin', 'integration:admin'] })
const FOREIGN_ADMIN = Object.freeze({ id: 'u_g1_foreign', tenantId: OTHER_TENANT, permissions: ['role:admin', 'integration:admin'] })

const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const OPTIONS_SYNC_PATH = '/api/integration/stock-preparation/options/sync'
const LIST_PATH = '/api/integration/stock-preparation/project-targets'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'

const tests = []
const test = (name, fn) => tests.push([name, fn])
// The route's error envelope carries null-prototype detail objects; compare plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value))

// ── substrate ────────────────────────────────────────────────────────────────────────────────────────

/** The parts the synthetic PLM source answers for a project (one per part id; same shape as the harness'). */
function partsSource(projectNo, parts) {
  const data = {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'PATH-SYN' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-SYN' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-SYN', path_id: 'PATH-SYN' }],
    DN_PDM_OrderDetailInfo: parts.map((part, index) => ({ order_id: 'ORDER-SYN', part_id: `PART-SYN-${index + 1}`, quantity: String(index + 2) })),
    DN_PDM_PartLibraryInfo: parts.map((part, index) => ({ OBJ_ID: `PART-SYN-${index + 1}`, IdentityNo: part, IdentityName: `Synthetic part ${index + 1}`, Material: 'Synthetic', SysVer: 'V1' })),
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
  return async (input = {}) => {
    const rows = Array.isArray(data[input.object]) ? data[input.object] : []
    const found = rows.filter((row) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
    return { records: found.map(projectSheet.clone), nextCursor: null, done: true }
  }
}

/**
 * THE HOST'S SELECT VALIDATION on top of the harness records fake (records.ts `normalizeSelectValue`: '' passes,
 * anything else must be one of `property.options`), plus per-row refusals keyed by the row's 图号 for the partial
 * case. A refused write throws BEFORE the harness records it, so `createRecord` calls in `h.records.calls` are rows
 * that actually landed.
 */
function installHostValidation(h, { refuseByComponentCode = {} } = {}) {
  const locate = (sheetId) => {
    for (const [key, object] of h.provisioning.objects) {
      const slash = key.lastIndexOf('/')
      const projectId = key.slice(0, slash)
      const objectId = key.slice(slash + 1)
      if (h.provisioning.sheetIdOf(projectId, objectId) === sheetId) return { projectId, objectId, object }
    }
    return null
  }
  const validate = (sheetId, data) => {
    const hit = locate(sheetId)
    if (!hit) return
    const logical = (fieldId) => h.provisioning.getFieldId(hit.projectId, hit.objectId, fieldId)
    const refusal = refuseByComponentCode[(data || {})[logical('componentCode')]]
    if (refusal === 'required') {
      // An untyped host error whose message the writer classifies `missing_required_field`.
      throw new Error('Field is required: synthetic')
    }
    for (const [fieldId, field] of hit.object.fields) {
      const value = (data || {})[logical(fieldId)]
      if (field.type !== 'select' || value === undefined || value === null || value === '') continue
      const allowed = (Array.isArray(field.property && field.property.options) ? field.property.options : [])
        .map((option) => (typeof option === 'string' ? option : option && option.value))
      if (!allowed.includes(value) || refusal === 'select') {
        throw Object.assign(new Error(`Invalid select option for ${logical(fieldId)}: ${value}`), { name: 'MultitableRecordValidationError' })
      }
    }
  }
  const createRecord = h.records.createRecord
  h.records.createRecord = async (input = {}) => { validate(input.sheetId, input.data); return createRecord(input) }
  const patchRecord = h.records.patchRecord
  h.records.patchRecord = async (input = {}) => { validate(input.sheetId, input.changes); return patchRecord(input) }
}

function mount(options = {}) {
  const { parts, refuseByComponentCode, ...rest } = options
  const h = projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, ...rest })
  if (parts) h.source.adapter.read = partsSource(PROJECT, parts)
  installHostValidation(h, { refuseByComponentCode })
  tagLockPatches(h)
  return h
}

/**
 * B (awaiting owner): the create leg and the repair leg ALSO mark the template's plm_system columns read-only for
 * people — one `patchObjectFieldProperty` per column whose body is exactly `{ humanWriteLock: 'plm_system' }`
 * (stock-preparation-project-targets.cjs `markProjectSheetPlmSystemColumns`). Those calls are TAGGED here so the
 * option-patch assertions below keep their exact meaning (`patchCalls` = the contract option writes) while the
 * lock writes are asserted on their own (`lockPatchCalls`). The harness itself is untouched.
 */
function tagLockPatches(h) {
  const real = h.provisioning.patchObjectFieldProperty
  h.provisioning.patchObjectFieldProperty = async (input = {}) => {
    const result = await real.call(h.provisioning, input)
    const body = (input && input.propertyPatch) || {}
    if (Object.keys(body).length === 1 && body.humanWriteLock === 'plm_system') {
      const last = h.provisioning.calls[h.provisioning.calls.length - 1]
      if (last && last[0] === 'patchObjectFieldProperty') last.push('humanWriteLock')
    }
    return result
  }
}

const createTarget = (h, user = PULLER, projectNo = PROJECT) => projectSheet.call(h.routes, 'POST', CREATE_PATH, { user, params: { projectNo }, body: {} })
const repair = (h, body, { user = ADMIN, query = {} } = {}) => projectSheet.call(h.routes, 'POST', OPTIONS_SYNC_PATH, { user, body, query })
const listTargets = (h) => projectSheet.call(h.routes, 'GET', LIST_PATH, { user: PULLER, query: { tenantId: TENANT } })

async function dryRunThenApply(h, projectNo = PROJECT) {
  const dry = await projectSheet.call(h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo } }, query: { tenantId: TENANT } })
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.equal(dry.body.data.canApply, true, 'the dry-run plans a writable apply')
  const apply = await projectSheet.call(h.routes, 'POST', APPLY_PATH, {
    user: PULLER,
    params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
    body: { parameters: { projectNo }, confirm: { dryRunToken: dry.body.data.dryRunToken } },
    query: { tenantId: TENANT },
  })
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.body))
  return { dry: dry.body.data, apply: apply.body.data.apply }
}

const projectObject = (h, projectNo = PROJECT, tenantId = TENANT) => h.provisioning.objects.get(`${tenantId}:integration-core/${deriveProjectSheetObjectId(tenantId, projectNo)}`)
const decisionOptions = (object) => {
  const property = object.fields.get(DECISION_FIELD).property || {}
  return Array.isArray(property.options) ? property.options.map((option) => option.value) : null
}
const registryRow = (h, projectNo = PROJECT) => h.registryRows().find((row) => row.project_no === projectNo && row.tenant_id === TENANT)
const writtenRows = (h) => h.records.calls.filter((call) => call[0] === 'createRecord').length
const patchCalls = (h) => h.provisioning.calls.filter((call) => call[0] === 'patchObjectFieldProperty' && call[3] !== 'humanWriteLock')
const lockPatchCalls = (h) => h.provisioning.calls.filter((call) => call[0] === 'patchObjectFieldProperty' && call[3] === 'humanWriteLock')
const PLM_SYSTEM_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((field) => field.ownership === 'plm_system').map((field) => field.id)

/** A sheet created BEFORE the fix: the ensure landed the columns, nothing wrote the contract set. */
function stripDecisionOptions(object) {
  const field = object.fields.get(DECISION_FIELD)
  field.property = { stockPreparation: { ...(field.property.stockPreparation || {}) } }
  delete field.property.stockPreparation.optionSync
  delete field.property.stockPreparation.optionActionBindings
}

// ── G1-01 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-01 the field team\'s test: create → the decision column carries the 5 contract options → apply writes ≥ 1 row → applied', async () => {
  const h = mount()
  try {
    const created = await createTarget(h)
    assert.equal(created.statusCode, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.data.options, { synced: 1, skipped: 0 }, 'the create says what it wrote, counts only')
    const object = projectObject(h)
    assert.deepEqual(decisionOptions(object), CONTRACT_VALUES, 'the decision column carries exactly the 5 contract values, in contract order')
    assert.deepEqual(decisionOptions(object), DEFAULT_CONTRACT_OPTION_SETS.plm_stock_preparation_decision_v1.map((option) => option.value), 'from the server-held contract set')
    for (const fieldId of CONFIG_INFO_SELECTS) {
      assert.equal(object.fields.get(fieldId).property.options, undefined, `${fieldId}: a config_info select is never given options by this path`)
    }
    assert.deepEqual(patchCalls(h).map((call) => [call[1], call[2]]), [[deriveProjectSheetObjectId(TENANT, PROJECT), DECISION_FIELD]], 'ONE patch, the decision field of THIS project sheet')
    assert.deepEqual(lockPatchCalls(h).map((call) => [call[1], call[2]]), PLM_SYSTEM_FIELD_IDS.map((id) => [deriveProjectSheetObjectId(TENANT, PROJECT), id]), 'B: every plm_system column of THIS sheet marked once, nothing else')
    assert.deepEqual(created.body.data.plmColumnLock, { marked: PLM_SYSTEM_FIELD_IDS.length, alreadyMarked: 0, missing: 0 })
    assert.deepEqual(h.auditAppends.map((entry) => [entry.action, entry.mode]), [['project_target_create', 'sheet_created']], 'the create\'s own audit trail is unchanged')

    const { apply } = await dryRunThenApply(h)
    assert.equal(apply.status, 'succeeded', JSON.stringify(apply))
    assert.ok(apply.written >= 1, 'at least one row written')
    assert.equal(apply.counts.failed, 0)
    assert.equal(writtenRows(h), apply.written, 'the host accepted every row the apply reports')
    const row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'applied')
    assert.equal(row.last_pull_code, null)
  } finally { h.restore() }
})

// ── G1-02 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-02 a pre-fix sheet: every row select_option_not_found → failed + code (list, overview cell); the repair call restores the options; the next apply is applied', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    stripDecisionOptions(projectObject(h))
    assert.equal(decisionOptions(projectObject(h)), null, 'the pre-fix state: no options on the decision column')

    const broken = await dryRunThenApply(h)
    const planned = broken.dry.counts.add + broken.dry.counts.update + broken.dry.counts.inactive
    assert.ok(planned >= 1)
    assert.equal(broken.apply.status, 'failed', JSON.stringify(broken.apply))
    assert.equal(broken.apply.ok, false)
    assert.equal(broken.apply.counts.failed, planned, 'every planned row failed')
    assert.equal(broken.apply.written, 0)
    assert.deepEqual(broken.apply.errorCodes, ['select_option_not_found'])
    assert.equal(writtenRows(h), 0)
    let row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'failed', 'the registry no longer says applied over a fully failed apply')
    assert.equal(row.last_pull_code, 'SELECT_OPTION_NOT_FOUND', 'the dominant row code, in the registry\'s closed code shape')
    const list = await listTargets(h)
    assert.equal(list.statusCode, 200, JSON.stringify(list.body))
    assert.equal(list.body.data.items[0].lastPullOutcome, 'failed')
    assert.equal(list.body.data.items[0].lastPullCode, 'SELECT_OPTION_NOT_FOUND')
    const target = await h.projectTargetStore.get({ tenantId: TENANT, projectNo: PROJECT })
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh-CN' }).lastPullOutcome, '拉取失败:SELECT_OPTION_NOT_FOUND')
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'en' }).lastPullOutcome, 'failed: SELECT_OPTION_NOT_FOUND')

    h.provisioning.calls.length = 0
    const repaired = await repair(h, { projectNo: PROJECT })
    assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.body))
    assert.deepEqual(decisionOptions(projectObject(h)), CONTRACT_VALUES, 'the repair put the 5 options back on THIS sheet')

    const healed = await dryRunThenApply(h)
    assert.equal(healed.apply.status, 'succeeded', JSON.stringify(healed.apply))
    assert.ok(healed.apply.written >= 1)
    row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'applied')
    assert.equal(row.last_pull_code, null)
  } finally { h.restore() }
})

// ── G1-03 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-03 a partial failure is failed, with the DOMINANT row code (2 select > 1 required), not the first code', async () => {
  const h = mount({
    parts: ['SYN-G1-0001', 'SYN-G1-0002', 'SYN-G1-0003', 'SYN-G1-0004'],
    refuseByComponentCode: { 'SYN-G1-0002': 'select', 'SYN-G1-0003': 'select', 'SYN-G1-0004': 'required' },
  })
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    const { apply } = await dryRunThenApply(h)
    assert.equal(apply.status, 'partial', JSON.stringify(apply))
    assert.equal(apply.written, 1, 'one row landed')
    assert.equal(apply.counts.failed, 3)
    assert.deepEqual(apply.errorCodes, ['missing_required_field', 'select_option_not_found'], 'two codes; the alphabetically first is NOT the dominant one')
    assert.equal(writtenRows(h), 1)
    const row = registryRow(h)
    assert.equal(row.last_pull_outcome, 'failed', 'some written, some refused: failed')
    assert.equal(row.last_pull_code, 'SELECT_OPTION_NOT_FOUND', 'the most frequent row code')
  } finally { h.restore() }
})

// ── G1-04 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-04 create idempotency: the same option body on a re-provision, no re-patch on the replay, a failed patch registers nothing and the retry reuses the ONE sheet', async () => {
  const h = mount()
  try {
    const context = h.context
    const first = await provisionProjectSheet({ context, projectId: STAGING, tenantId: TENANT, projectNo: PROJECT_B, env: process.env })
    const firstProperty = projectSheet.clone(projectObject(h, PROJECT_B).fields.get(DECISION_FIELD).property)
    const second = await provisionProjectSheet({ context, projectId: STAGING, tenantId: TENANT, projectNo: PROJECT_B, env: process.env })
    assert.equal(first.created, true)
    assert.equal(second.created, false, 'the second call found the sheet ready')
    assert.deepEqual(first.options, second.options, 'the same summary both times')
    assert.deepEqual(projectObject(h, PROJECT_B).fields.get(DECISION_FIELD).property, firstProperty, 'the same field metadata after the re-run')
    assert.deepEqual(decisionOptions(projectObject(h, PROJECT_B)), CONTRACT_VALUES)
    assert.deepEqual(patchCalls(h).map((call) => call[2]), [DECISION_FIELD, DECISION_FIELD], 'one patch per call, the decision field only')
    assert.equal(h.provisioning.calls.filter((call) => call[0] === 'ensureObject').length, 1, 'ONE sheet')

    // The route: create, then the replay — 200, no re-patch, the options stand.
    assert.equal((await createTarget(h)).statusCode, 201)
    h.provisioning.calls.length = 0
    const replay = await createTarget(h)
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.body))
    assert.ok(!('options' in replay.body.data), 'the replay provisions nothing, so it reports no option write')
    assert.equal(patchCalls(h).length, 0)
    assert.deepEqual(decisionOptions(projectObject(h)), CONTRACT_VALUES)
  } finally { h.restore() }

  const g = mount()
  try {
    const realPatch = g.provisioning.patchObjectFieldProperty
    g.provisioning.patchObjectFieldProperty = async () => { throw Object.assign(new Error('synthetic host refusal'), { code: 'SYNTHETIC_HOST_REFUSAL' }) }
    const refused = await createTarget(g)
    assert.equal(refused.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_OPTIONS_SYNC_FAILED', JSON.stringify(refused.body))
    assert.equal(refused.body.error.details.optionSyncCode, 'OPTION_SYNC_FIELD_PATCH_FAILED')
    assert.equal(g.registryRows().length, 0, 'nothing registered')
    g.provisioning.patchObjectFieldProperty = realPatch
    const retried = await createTarget(g)
    assert.equal(retried.statusCode, 201, JSON.stringify(retried.body))
    assert.equal(g.provisioning.calls.filter((call) => call[0] === 'ensureObject').length, 1, 'the retry reused the ONE sheet')
    assert.deepEqual(decisionOptions(projectObject(g)), CONTRACT_VALUES)
    assert.equal(g.registryRows().length, 1)
  } finally { g.restore() }
})

// ── G1-05 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-05 a host without patchObjectFieldProperty is refused BEFORE anything is provisioned', async () => {
  const h = mount()
  try {
    delete h.provisioning.patchObjectFieldProperty
    const res = await createTarget(h)
    assert.equal(res.statusCode, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE')
    assert.deepEqual(plain(res.body.error.details), { requiredMethods: ['patchObjectFieldProperty'] })
    assert.equal(h.provisioning.calls.filter((call) => call[0] === 'ensureObject' || call[0] === 'ensureView').length, 0, 'no table, no view')
    assert.equal(h.registryRows().length, 0)
  } finally { h.restore() }
})

// ── G1-06 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-06 repair, registered: 200, the registry row\'s sheet in the verified tenant\'s staging project, the decision field only, one audit row, idempotent', async () => {
  const h = mount()
  try {
    const { sheetId, objectId } = h.seedRegistryRow(PROJECT)
    const auditBefore = h.auditAppends.length
    const res = await repair(h, { projectNo: PROJECT })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.target, { sheetId, objectId, fieldCount: 1 })
    assert.equal(res.body.data.projectNo, PROJECT)
    assert.equal(res.body.data.evidence.objectId, objectId)
    assert.deepEqual(res.body.data.evidence.fields.map((entry) => [entry.field, entry.optionCount]), [[DECISION_FIELD, 5]])
    assert.deepEqual(patchCalls(h).map((call) => [call[1], call[2]]), [[objectId, DECISION_FIELD]])
    assert.deepEqual(lockPatchCalls(h).map((call) => [call[1], call[2]]), PLM_SYSTEM_FIELD_IDS.map((id) => [objectId, id]), 'B: the repair leg marks the registry row sheet')
    assert.deepEqual(res.body.data.plmColumnLock, { marked: PLM_SYSTEM_FIELD_IDS.length, alreadyMarked: 0, missing: 0 })
    const object = h.provisioning.objects.get(`${STAGING}/${objectId}`)
    assert.deepEqual(decisionOptions(object), CONTRACT_VALUES)
    const appended = h.auditAppends.slice(auditBefore)
    assert.deepEqual(appended.map((entry) => [entry.action, entry.projectId, entry.subjectId, entry.mode, entry.actor]), [
      ['project_target_create', PROJECT, sheetId, 'contract_options_synced', ADMIN.id],
    ])
    assert.deepEqual(appended[0].detail, {
      objectId,
      syncedFieldCount: 1,
      skippedFieldCount: 0,
      optionCount: 5,
      plmLockMarkedFieldCount: PLM_SYSTEM_FIELD_IDS.length,
      plmLockAlreadyMarkedFieldCount: 0,
      plmLockMissingFieldCount: 0,
    })
    // Idempotent: the same body again.
    const before = projectSheet.clone(object.fields.get(DECISION_FIELD).property)
    const again = await repair(h, { projectNo: PROJECT })
    assert.equal(again.statusCode, 200)
    assert.deepEqual(object.fields.get(DECISION_FIELD).property, before)
    assert.deepEqual(again.body.data, res.body.data)
  } finally { h.restore() }
})

// ── G1-07 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-07 repair resolves ONLY through the registry row: a row naming another object of the tenant is patched there, never at the derived id', async () => {
  const h = mount()
  try {
    // A row registered by hand for PROJECT (the runbook's adopt-the-old-sheet path writes such a row).
    const adoptedObject = 'plm_stock_preparation_sandbox_adopted_g1'
    projectSheet.seedObject(h.provisioning, STAGING, adoptedObject)
    const adoptedSheet = h.provisioning.sheetIdOf(STAGING, adoptedObject)
    h.db.rowsOf(projectSheet.PROJECT_TARGET_TABLE).push({
      id: 'seed-adopted', tenant_id: TENANT, project_no: PROJECT, sheet_id: adoptedSheet, object_id: adoptedObject,
      status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null, updated_at: new Date('2026-10-08T00:00:00Z'),
    })
    h.provisioning.calls.length = 0
    const res = await repair(h, { projectNo: PROJECT })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(patchCalls(h).map((call) => call[1]), [adoptedObject], 'the registry row\'s object, not deriveProjectSheetObjectId(...)')
    assert.equal(res.body.data.target.objectId, adoptedObject)
    assert.equal(res.body.data.target.sheetId, adoptedSheet)
    assert.equal(h.provisioning.objects.has(`${STAGING}/${deriveProjectSheetObjectId(TENANT, PROJECT)}`), false, 'nothing was created at the derived id')
  } finally { h.restore() }
})

// ── G1-08 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-08 repair refusals: absent 404, another tenant 404, request tenant refused, archived 409, switch off 404 with zero IO, below admin 403 with zero IO, extra keys 400, bad number 400 — none touches the host', async () => {
  const h = mount()
  try {
    const { objectId } = h.seedRegistryRow(PROJECT)
    const object = h.provisioning.objects.get(`${STAGING}/${objectId}`)
    stripDecisionOptions(object)
    const untouched = () => {
      assert.equal(patchCalls(h).length, 0, 'no patch')
      assert.equal(decisionOptions(object), null, 'the registered sheet is untouched')
    }

    const absent = await repair(h, { projectNo: PROJECT_B })
    assert.equal(absent.statusCode, 404, JSON.stringify(absent.body))
    assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    assert.deepEqual(plain(absent.body.error.details), { field: 'projectNo' })
    untouched()

    const foreign = await repair(h, { projectNo: PROJECT }, { user: FOREIGN_ADMIN })
    assert.equal(foreign.statusCode, 404, `another tenant asking for this tenant's project number finds nothing: ${JSON.stringify(foreign.body)}`)
    assert.equal(foreign.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
    untouched()

    const steered = await repair(h, { projectNo: PROJECT }, { user: FOREIGN_ADMIN, query: { tenantId: TENANT } })
    assert.ok(steered.statusCode >= 400 && steered.statusCode < 500, `a request-carried tenant never steers the repair: ${JSON.stringify(steered.body)}`)
    assert.match(steered.body.error.code, /^OPERATOR_SCOPE_/)
    untouched()

    for (const body of [
      { projectNo: PROJECT, optionSets: { plm_stock_preparation_decision_v1: [{ value: 'add' }] } },
      { projectNo: PROJECT, projectId: STAGING },
      { projectNo: PROJECT, tenantId: TENANT },
      { projectNo: PROJECT, objectId },
      { projectNo: PROJECT, workspaceId: 'w1' },
    ]) {
      const res = await repair(h, body)
      assert.equal(res.statusCode, 400, JSON.stringify(body))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID')
    }
    untouched()

    for (const projectNo of ['', '   ', 'bad number with spaces', null, 7, ['PRJ-G1-OPT-1']]) {
      const res = await repair(h, { projectNo })
      assert.equal(res.statusCode, 400, JSON.stringify(projectNo))
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    }
    untouched()

    // Below the route's admin tier: refused before ANY IO — the puller passes the create, not this route.
    h.db.calls.length = 0
    const puller = await repair(h, { projectNo: PROJECT }, { user: PULLER })
    assert.equal(puller.statusCode, 403)
    assert.deepEqual(h.db.calls, [])
    assert.deepEqual(h.tenantDirectoryCalls.filter((call) => call.userId === PULLER.id), [])
    untouched()

    // Archived: 409, re-read under the tenant lock.
    h.registryRows().find((row) => row.project_no === PROJECT).status = 'archived'
    h.registryRows().find((row) => row.project_no === PROJECT).archived_at = new Date('2026-10-10T00:00:00Z')
    const auditBefore = h.auditAppends.length
    const archived = await repair(h, { projectNo: PROJECT })
    assert.equal(archived.statusCode, 409, JSON.stringify(archived.body))
    assert.equal(archived.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.equal(h.auditAppends.length, auditBefore, 'no audit row for a refusal')
    untouched()
  } finally { h.restore() }

  const off = mount({ switchOn: false })
  try {
    off.seedRegistryRow(PROJECT)
    off.db.calls.length = 0
    const res = await repair(off, { projectNo: PROJECT })
    assert.equal(res.statusCode, 404, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
    assert.deepEqual(off.db.calls, [], 'switch off: no registry IO')
    assert.deepEqual(off.provisioning.calls, [], 'switch off: no host IO')
    assert.deepEqual(off.tenantDirectoryCalls, [], 'switch off: not even the scope lookup')
  } finally { off.restore() }
})

// ── G1-09 ────────────────────────────────────────────────────────────────────────────────────────────

// What origin/main (f106c7eff) answers for the legacy request below on this exact fake: captured by running the
// SAME request through main's lib on the SAME harness, then pinned. Any drift in the projectNo-less wire reds here.
const LEGACY_SYNC_RESPONSE_AT_MAIN = {
  ok: true,
  data: {
    ok: true,
    target: { objectId: 'plm_stock_preparation_main', fieldCount: 2 },
    evidence: {
      objectId: 'plm_stock_preparation_main',
      fields: [
        { field: 'lastPlmRefreshDecision', optionSource: { type: 'contract', key: 'plm_stock_preparation_decision_v1' }, optionCount: 5, actionBindingCount: 0 },
        { field: 'materialType', optionSource: { type: 'config_info', key: 'material_type' }, optionCount: 1, actionBindingCount: 0 },
      ],
      skipped: [
        { field: 'blankType', optionSource: { type: 'config_info', key: 'blank_type' }, reason: 'config_info_not_supplied' },
        { field: 'stockPreparationStatus', optionSource: { type: 'config_info', key: 'stock_preparation_status' }, reason: 'config_info_not_supplied' },
        { field: 'makeOrBuy', optionSource: { type: 'config_info', key: 'make_or_buy' }, reason: 'config_info_not_supplied' },
      ],
    },
  },
}
const LEGACY_SYNC_HOST_CALLS_AT_MAIN = [
  ['findObjectSheet', 'plm_stock_preparation_main'],
  ['resolveExistingObjectFieldIds', 'plm_stock_preparation_main'],
  ['patchObjectFieldProperty', 'plm_stock_preparation_main', 'lastPlmRefreshDecision'],
  ['patchObjectFieldProperty', 'plm_stock_preparation_main', 'materialType'],
]

test('G1-09 without projectNo the route is byte-identical to main (response + host call log pinned), switch on or off', async () => {
  for (const switchOn of [true, false]) {
    const h = mount({ switchOn })
    try {
      projectSheet.seedObject(h.provisioning, STAGING, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
      h.provisioning.calls.length = 0
      const res = await repair(h, { optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body, LEGACY_SYNC_RESPONSE_AT_MAIN)
      assert.deepEqual(h.provisioning.calls.map((call) => call.slice(0, call[0] === 'resolveExistingObjectFieldIds' ? 2 : 3)), LEGACY_SYNC_HOST_CALLS_AT_MAIN)
      assert.deepEqual(h.auditAppends, [], 'the legacy sync writes no audit row, as before')
      assert.deepEqual(h.db.calls, [], 'and never touches the registry')
      const refused = await repair(h, { optionSets: {}, objectId: 'x' })
      assert.equal(refused.statusCode, 400)
      assert.deepEqual(plain(refused.body.error), { code: 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID', message: 'unsupported request field: objectId', details: { field: 'objectId' } })
    } finally { h.restore() }
  }
})

// ── G1-10 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-10 the overview cell: failed carries its code in zh / en; applied / previewed / refused are the enum word as before', () => {
  const cell = (lastPullOutcome, lastPullCode, locale) => overview.buildProjectOverviewRow({
    target: { projectNo: PROJECT, sheetId: 'sheet_g1', status: 'active', lastPullOutcome, lastPullCode },
    fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale,
  }).lastPullOutcome
  assert.equal(cell('failed', 'SELECT_OPTION_NOT_FOUND', 'zh-CN'), '拉取失败:SELECT_OPTION_NOT_FOUND')
  assert.equal(cell('failed', 'SELECT_OPTION_NOT_FOUND', 'en'), 'failed: SELECT_OPTION_NOT_FOUND')
  assert.equal(cell('failed', null, 'zh-CN'), '拉取失败')
  assert.equal(cell('failed', null, 'en'), 'failed')
  assert.equal(cell('failed', 'not a code', 'en'), 'failed', 'a code without code shape is never rendered')
  for (const outcome of ['applied', 'previewed', 'refused']) {
    for (const locale of ['zh-CN', 'en']) assert.equal(cell(outcome, 'TARGET_SCHEMA_INCOMPLETE', locale), outcome, `${outcome} (${locale}) is unchanged`)
  }
  assert.equal(cell(null, null, 'zh-CN'), null)
})

// ── G1-11 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-11 the vocabulary: store = web clamp = the admitting migration; 087 untouched; the store stamps failed', async () => {
  assert.deepEqual([...PROJECT_TARGET_PULL_OUTCOMES], ['applied', 'previewed', 'refused', 'failed'])
  const repo = path.join(__dirname, '..', '..', '..')
  const listIn = (text, pattern, label) => {
    const match = text.match(pattern)
    assert.ok(match, `${label}: the outcome list is readable`)
    return match[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean)
  }
  const web = fs.readFileSync(path.join(repo, 'apps', 'web', 'src', 'services', 'integration', 'stockPreparation', 'projectTarget.ts'), 'utf8')
  assert.deepEqual(listIn(web, /STOCK_PREP_PROJECT_TARGET_PULL_OUTCOMES = Object\.freeze\(\[([^\]]*)\] as const\)/, 'web').sort(), [...PROJECT_TARGET_PULL_OUTCOMES].sort(), 'the web clamp admits exactly what the server stamps')
  const migration = fs.readFileSync(path.join(repo, 'packages', 'core-backend', 'src', 'db', 'migrations', 'zzzz20261015090000_admit_stock_prep_project_target_failed_pull_outcome.ts'), 'utf8')
  assert.deepEqual(listIn(migration, /export const PULL_OUTCOMES = Object\.freeze\(\[([^\]]*)\] as const\)/, 'migration').sort(), [...PROJECT_TARGET_PULL_OUTCOMES].sort(), 'the DB admits exactly what the store stamps')
  const sql087 = fs.readFileSync(path.join(repo, 'packages', 'core-backend', 'migrations', '087_create_integration_stock_prep_project_target.sql'), 'utf8')
  assert.deepEqual(listIn(sql087, /last_pull_outcome IN \(([^)]*)\)/, '087'), ['applied', 'previewed', 'refused'], 'migration 087 is not edited')
  assert.deepEqual(listIn(migration, /export const PULL_OUTCOMES_087 = Object\.freeze\(\[([^\]]*)\] as const\)/, 'migration down list'), ['applied', 'previewed', 'refused'], 'down() restores exactly 087\'s list')

  const rows = []
  const db = {
    async selectOne() { return null },
    async select() { return [] },
    async insertOne() { return [] },
    async countRows() { return 0 },
    async transaction(fn) { return fn(db) },
    async updateRow(_table, set, where) {
      rows.push({ set, where })
      return [{ ...where, ...set }]
    },
  }
  const store = createStockPreparationProjectTargetStore({ db })
  assert.equal(await store.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'failed', code: 'SELECT_OPTION_NOT_FOUND' }), true)
  assert.equal(rows[0].set.last_pull_outcome, 'failed')
  assert.equal(rows[0].set.last_pull_code, 'SELECT_OPTION_NOT_FOUND')
  assert.equal(await store.recordPullOutcome({ tenantId: TENANT, projectNo: PROJECT, outcome: 'succeeded' }), false, 'an outcome outside the enum still stamps nothing')
})

// ── G1-12 ────────────────────────────────────────────────────────────────────────────────────────────

test('G1-12 projectNo in the query string (any case) is 400 before any IO, with or without a body projectNo; the body-only repair is unchanged', async () => {
  const h = mount()
  try {
    const { objectId } = h.seedRegistryRow(PROJECT)
    projectSheet.seedObject(h.provisioning, STAGING, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
    const object = h.provisioning.objects.get(`${STAGING}/${objectId}`)
    stripDecisionOptions(object)
    for (const [query, body] of [
      [{ projectNo: PROJECT }, {}],
      [{ PROJECTNO: PROJECT }, {}],
      [{ ProjectNo: PROJECT }, { optionSets: { material_type: [{ value: 'plate' }] } }],
      [{ projectNo: PROJECT }, { projectNo: PROJECT }],
      [{ projectno: '' }, { projectNo: PROJECT }],
    ]) {
      h.provisioning.calls.length = 0
      h.db.calls.length = 0
      const auditBefore = h.auditAppends.length
      const res = await repair(h, body, { query })
      assert.equal(res.statusCode, 400, `${JSON.stringify(query)} + ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`)
      assert.deepEqual(plain(res.body.error), {
        code: 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID',
        message: 'projectNo must be sent in the JSON body, not in the query string',
        details: { field: 'projectNo' },
      })
      assert.deepEqual(h.provisioning.calls, [], 'no host IO: neither the deployment object nor the project sheet is patched')
      assert.deepEqual(h.db.calls, [], 'no registry IO')
      assert.equal(h.auditAppends.length, auditBefore, 'no audit row')
      assert.equal(decisionOptions(object), null, 'the project sheet is untouched')
    }
    // Below the admin tier the gate still answers first (403, not the 400).
    assert.equal((await repair(h, {}, { user: PULLER, query: { projectNo: PROJECT } })).statusCode, 403)

    // A query WITHOUT the key still reaches the legacy deployment sync (G1-09 pins its bytes).
    h.provisioning.calls.length = 0
    const legacy = await repair(h, { optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, { query: { tenantId: TENANT } })
    assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body))
    assert.equal(legacy.body.data.target.objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)

    // The body-only repair is unchanged.
    h.provisioning.calls.length = 0
    const repaired = await repair(h, { projectNo: PROJECT })
    assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.body))
    assert.equal(repaired.body.data.target.objectId, objectId)
    assert.deepEqual(patchCalls(h).map((call) => [call[1], call[2]]), [[objectId, DECISION_FIELD]])
    assert.deepEqual(decisionOptions(object), CONTRACT_VALUES)
  } finally { h.restore() }
})

runFailClosedSuite('stock-preparation-project-sheet-contract-options.test.cjs', tests)
