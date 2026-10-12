'use strict'

// 一个项目一张备料表 — the switch, the sheet identity, the registry OVERLAY on the table-action
// registry, the apply WRITE GATE's project-sheet branch, provisioning and the G1 call (S1 of ADR
// adr-stock-prep-project-sheets-20261008). Hermetic: in-memory registry store, fake host provisioning.
//
// THE GUARANTEES, each written to red if its production line is removed:
//   T-01 THE SWITCH IS THE EXACT LITERAL 'true' — no trim, no case fold, no '1'.
//   T-02 THE SHEET IDENTITY: project-sheet shape, deterministic, tenant- and project-sensitive, and
//        the raw project number is NOT a substring of it.
//   T-03 SWITCH OFF ⇒ BYTE-IDENTICAL: with the resolver WIRED and the switch off, `getTableAction`
//        answers deep-equal to a registry with no resolver at all, for every input shape (with and
//        without projectNo, every targetPurpose), and the store is never consulted. Mutation: make
//        `stockPreparationProjectSheetsEnabled` return true for 'TRUE' and T-01 reds; make the
//        resolver ignore the switch and T-03 reds.
//   T-04 SWITCH ON: active → the project sheet replaces the env target and the overlay marker rides
//        (with the env objectId captured); `assertStockPreparationTargetReady` keeps the marker;
//        archived → 409 on 'write', the sheet on 'read'; absent → 409; missing projectNo → 400;
//        'source' / 'readiness' → never overlaid, store never consulted; no tenant → 500.
//   T-05 THE WRITE GATE'S FOUR CONDITIONS, each knocked out alone → refused (existing refusal codes),
//        all four present → admitted; the prod canonical is still refused regardless; and with no
//        gate input at all the gate is the pre-S1 gate.
//   T-06 PROVISIONING goes through the one create path (template stamped for the object, own-base
//        resolution opted in) and writes the to-fill view on the CREATE leg only, with the nested
//        live-AND-(a-OR-b) filter.
//   T-07 G1: no roles → skipped (G2); no port → api_unavailable; port called with exactly the
//        configured roles; a port refusal propagates.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  PROJECT_SHEETS_ENABLED_ENV,
  PROJECT_SHEET_GRANT_ROLE_IDS_ENV,
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN,
  StockPreparationProjectTargetError,
  isStockPreparationProjectSheetObjectId,
  stockPreparationProjectSheetsEnabled,
  resolveProjectSheetGrantRoleIds,
  deriveProjectSheetObjectId,
  projectSheetTemplate,
  resolveProjectTargetForAction,
  provisionProjectSheet,
  grantProjectSheetRoles,
  projectSheetViewHandles,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const { createStockPreparationProjectTargetStore } = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  StockPreparationTableActionError,
  assertStockPrepApplySandboxAllowed,
  assertStockPrepApplyAllowed,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID,
  STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID,
  buildStockPreparationTodoViewDescriptor,
  ensureStockPreparationTodoView,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const { stockPreparationOwnBasePairPartners } = require(path.join(LIB, 'stock-preparation-own-base.cjs'))

const TENANT = 'tenant-s1-targets'
const PROJECT_ID = `${TENANT}:integration-core`
const PROJECT = 'PRJ-S1-T1'
const ENV_SHEET = 'sheet_env_mixed'
const ENV_OBJECT = 'plm_stock_preparation_sandbox_env_twin'
const ON = { [PROJECT_SHEETS_ENABLED_ENV]: 'true' }
const OFF = {}

function envAction() {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
    target: { sheetId: ENV_SHEET, objectId: ENV_OBJECT, fieldIdMap: {} },
  }
}

// ── substrate ────────────────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const rows = []
  const calls = []
  const matches = (row, where) => Object.entries(where).every(([c, v]) => (row[c] === undefined ? null : row[c]) === (v === undefined ? null : v))
  const api = {
    rows,
    calls,
    async transaction(fn) { calls.push('transaction'); return fn({ ...api, async advisoryXactLock() { calls.push('advisoryXactLock') } }) },
    async selectOne(_t, where) { calls.push('selectOne'); return rows.find((r) => matches(r, where)) || null },
    async select(_t, { where } = {}) { calls.push('select'); return rows.filter((r) => matches(r, where || {})) },
    async insertOne(_t, row) { calls.push('insertOne'); const s = { archived_at: null, ...row }; rows.push(s); return [s] },
    async countRows(_t, where) { calls.push('countRows'); return rows.filter((r) => matches(r, where || {})).length },
  }
  return api
}

function makeStore(db = makeMemoryDb()) {
  let n = 0
  return { db, store: createStockPreparationProjectTargetStore({ db, idGenerator: () => `pt-${(n += 1)}` }) }
}

/** A deterministic fake of the host provisioning surface: ids derived by a visible rule. */
function makeProvisioning({ existingObjects = new Map(), withEnsureView = true, grantResult } = {}) {
  const calls = []
  const sheetIdOf = (projectId, objectId) => `sheet_${projectId}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_')
  const api = {
    calls,
    getObjectSheetId: (projectId, objectId) => sheetIdOf(projectId, objectId),
    getFieldId: (projectId, objectId, fieldId) => `fld_${objectId.slice(-6)}_${fieldId}`,
    getObjectViewId: (projectId, objectId, viewId) => `view_${objectId.slice(-6)}_${viewId}`,
    async findObjectSheet({ projectId, objectId }) {
      calls.push(['findObjectSheet', objectId])
      const existing = existingObjects.get(objectId)
      return existing ? { id: sheetIdOf(projectId, objectId), baseId: existing.baseId ?? null, name: existing.name || objectId, description: null } : null
    },
    async resolveFieldIds({ projectId, objectId, fieldIds }) {
      calls.push(['resolveFieldIds', objectId])
      const map = {}
      for (const fieldId of fieldIds) map[fieldId] = api.getFieldId(projectId, objectId, fieldId)
      return map
    },
    async ensureObject({ projectId, baseId, descriptor }) {
      calls.push(['ensureObject', descriptor.id, baseId ?? null, descriptor.name])
      existingObjects.set(descriptor.id, { baseId: baseId ?? null, name: descriptor.name })
      return {
        baseId: baseId ?? null,
        sheet: { id: sheetIdOf(projectId, descriptor.id), baseId: baseId ?? null, name: descriptor.name, description: null },
        fields: descriptor.fields.map((field, index) => ({ id: api.getFieldId(projectId, descriptor.id, field.id), sheetId: sheetIdOf(projectId, descriptor.id), name: field.name, type: field.type, property: {}, order: index })),
      }
    },
    async ensureObjectDefaultView({ objectId, name }) {
      calls.push(['ensureObjectDefaultView', objectId, name])
      return { created: true, existingViewCount: 0 }
    },
    async ensureSystemBase({ baseId }) {
      calls.push(['ensureSystemBase', baseId])
      return { baseId, created: true }
    },
    async isSheetOwnedByProject() { return true },
  }
  if (withEnsureView) {
    api.ensureView = async ({ projectId, sheetId, descriptor }) => {
      calls.push(['ensureView', descriptor.id, sheetId, descriptor])
      return { id: api.getObjectViewId(projectId, descriptor.objectId, descriptor.id), sheetId, name: descriptor.name, type: 'grid', filterInfo: descriptor.filterInfo, sortInfo: descriptor.sortInfo, groupInfo: descriptor.groupInfo || {}, hiddenFieldIds: descriptor.hiddenFieldIds, config: descriptor.config }
    }
  }
  if (grantResult !== undefined) {
    api.grantSheetRoleWrite = async (input) => {
      calls.push(['grantSheetRoleWrite', input])
      if (grantResult instanceof Error) throw grantResult
      return grantResult
    }
  }
  return api
}

async function expectError(promise, Type, status, code) {
  let caught = null
  try { await promise } catch (error) { caught = error }
  assert.ok(caught, `expected ${code}`)
  assert.ok(caught instanceof Type, `expected ${Type.name}, got ${caught && caught.name}: ${caught && caught.message}`)
  assert.equal(caught.status, status, `${code}: status`)
  assert.equal(caught.code, code)
  return caught
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ── T-01 / T-02 ──────────────────────────────────────────────────────────────────────────────────

test('T-01 the switch is the exact literal true', () => {
  assert.equal(stockPreparationProjectSheetsEnabled(ON), true)
  for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', '', undefined, null, true]) {
    assert.equal(stockPreparationProjectSheetsEnabled({ [PROJECT_SHEETS_ENABLED_ENV]: value }), false, `${JSON.stringify(value)} is OFF`)
  }
  assert.equal(stockPreparationProjectSheetsEnabled(undefined), false)
  assert.equal(stockPreparationProjectSheetsEnabled(null), false)
  // The role list: trimmed, de-duplicated, order kept, never thrown on.
  assert.deepEqual(resolveProjectSheetGrantRoleIds({ [PROJECT_SHEET_GRANT_ROLE_IDS_ENV]: ' stock-prep_frontline, stock-prep_puller ,stock-prep_frontline,,' }), ['stock-prep_frontline', 'stock-prep_puller'])
  assert.deepEqual(resolveProjectSheetGrantRoleIds({}), [])
  assert.deepEqual(resolveProjectSheetGrantRoleIds({ [PROJECT_SHEET_GRANT_ROLE_IDS_ENV]: '' }), [])
})

test('T-02 the sheet identity: project-sheet shape, deterministic, scope-sensitive, number-free', () => {
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  assert.match(objectId, STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN)
  assert.ok(isStockPreparationProjectSheetObjectId(objectId))
  assert.equal(deriveProjectSheetObjectId(TENANT, PROJECT), objectId, 'deterministic')
  assert.equal(deriveProjectSheetObjectId(`${TENANT} `, ` ${PROJECT}`), objectId, 'trimmed like the pull parameter')
  assert.notEqual(deriveProjectSheetObjectId('tenant-s1-other', PROJECT), objectId, 'tenant-sensitive')
  assert.notEqual(deriveProjectSheetObjectId(TENANT, 'PRJ-S1-T2'), objectId, 'project-sensitive')
  assert.ok(!objectId.includes(PROJECT), 'the raw project number is not a substring of the identifier')
  for (const notProject of ['plm_stock_preparation_sandbox', 'plm_stock_preparation_sandbox_validation', 'plm_stock_preparation_sandbox_p_', 'plm_stock_preparation_sandbox_p_abc', `${objectId}0`, objectId.toUpperCase(), STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId]) {
    assert.equal(isStockPreparationProjectSheetObjectId(notProject), false, `${notProject} is not a project sheet`)
  }
  const blank = tryCatch(() => deriveProjectSheetObjectId(TENANT, ''))
  assert.ok(blank instanceof StockPreparationProjectTargetError && blank.status === 400 && blank.code === 'STOCK_PREPARATION_PROJECT_NO_REQUIRED', 'a blank project number is refused 400')
  // The template: the frozen columns, this objectId, a display name that carries the number.
  const template = projectSheetTemplate({ tenantId: TENANT, projectNo: PROJECT })
  assert.equal(template.objectId, objectId)
  assert.equal(template.label, `Stock prep ${PROJECT}`)
  assert.equal(template.labelZh, `备料-${PROJECT}`)
  assert.deepEqual(template.fields.map((f) => f.id), STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((f) => f.id))
  assert.notEqual(template.id, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.id)
  // own-base: a project sheet anchors ONE-WAY to the ledger (first) and the main table; neither
  // pair member lists a project sheet.
  assert.deepEqual(stockPreparationOwnBasePairPartners(objectId), ['plm_stock_preparation_confirmation_decision', STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId])
  assert.deepEqual(stockPreparationOwnBasePairPartners(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId), ['plm_stock_preparation_confirmation_decision'])
})

function tryCatch(fn) { try { return fn() } catch (error) { return error } }

// ── T-03 / T-04: the registry overlay ────────────────────────────────────────────────────────────

function resolverFor({ store, provisioning, env }) {
  return async ({ tenantId, projectNo, targetPurpose }) => resolveProjectTargetForAction({
    store, provisioning, projectId: `${tenantId}:integration-core`, tenantId, projectNo, targetPurpose, env,
  })
}

const LOOKUP_SHAPES = [
  { tenantId: TENANT },
  { tenantId: TENANT, projectNo: PROJECT },
  { tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'write' },
  { tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'read' },
  { tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'source' },
  { tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'readiness' },
  { tenantId: TENANT, workspaceId: 'ws-1', projectNo: 'PRJ-S1-NOPE', targetPurpose: 'write' },
]

test('T-03 switch OFF: a wired resolver answers deep-equal to no resolver, and never consults the store', async () => {
  const { db, store } = makeStore()
  await store.create({ tenantId: TENANT, projectNo: PROJECT, sheetId: 'sheet_p1', objectId: deriveProjectSheetObjectId(TENANT, PROJECT) })
  db.calls.length = 0
  const bare = createStockPreparationTableActionRegistry({ actions: [envAction()] })
  const wired = createStockPreparationTableActionRegistry({ actions: [envAction()], resolveProjectTarget: resolverFor({ store, provisioning: makeProvisioning(), env: OFF }) })
  for (const input of LOOKUP_SHAPES) {
    const expected = await bare.getTableAction({ ...input, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
    const actual = await wired.getTableAction({ ...input, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
    assert.deepEqual(actual, expected, `byte-identical for ${JSON.stringify(input)}`)
    assert.equal(actual.target.sheetId, ENV_SHEET)
    assert.ok(!('projectTarget' in actual), 'no overlay marker while the switch is off')
  }
  assert.deepEqual(await wired.listTableActions(), await bare.listTableActions())
  assert.deepEqual(db.calls, [], 'the registry store is never consulted while the switch is off')
})

test('T-04 switch ON: active overlays, archived splits by purpose, absent / missing / source / readiness / no-tenant', async () => {
  const { db, store } = makeStore()
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  await store.create({ tenantId: TENANT, projectNo: PROJECT, sheetId: 'sheet_p1', objectId })
  await store.create({ tenantId: TENANT, projectNo: 'PRJ-S1-ARCH', sheetId: 'sheet_p2', objectId: deriveProjectSheetObjectId(TENANT, 'PRJ-S1-ARCH') })
  Object.assign(db.rows[1], { status: 'archived', archived_at: new Date() })
  const provisioning = makeProvisioning()
  const registry = createStockPreparationTableActionRegistry({ actions: [envAction()], resolveProjectTarget: resolverFor({ store, provisioning, env: ON }) })
  const lookup = (input) => registry.getTableAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID, ...input })

  // active, write (the default purpose)
  const active = await lookup({ tenantId: TENANT, projectNo: PROJECT })
  assert.equal(active.target.sheetId, 'sheet_p1')
  assert.equal(active.target.objectId, objectId)
  assert.equal(active.target.keyField, 'idempotencyKey')
  assert.equal(Object.keys(active.target.fieldIdMap).length, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length, 'a FULL logical→physical map')
  assert.equal(active.target.fieldIdMap.projectNo, provisioning.getFieldId(PROJECT_ID, objectId, 'projectNo'))
  assert.deepEqual(active.projectTarget, { projectNo: PROJECT, status: 'active', deploymentTargetObjectId: ENV_OBJECT })
  assert.equal(active.source.externalSystemId, 'plm_sql_source', 'the source is untouched by the overlay')
  // ...and the marker survives the route's re-normalization.
  const ready = assertStockPreparationTargetReady(active)
  assert.deepEqual(ready.projectTarget, active.projectTarget)
  assert.equal(ready.target.sheetId, 'sheet_p1')
  // ...and a plain env action re-normalized has no marker (conditional spread).
  assert.ok(!('projectTarget' in assertStockPreparationTargetReady(envAction())))

  // archived: write refused, read served
  await expectError(lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-ARCH', targetPurpose: 'write' }), StockPreparationProjectTargetError, 409, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
  await expectError(lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-ARCH' }), StockPreparationProjectTargetError, 409, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
  const archivedRead = await lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-ARCH', targetPurpose: 'read' })
  assert.equal(archivedRead.target.sheetId, 'sheet_p2')
  assert.equal(archivedRead.projectTarget.status, 'archived')

  // absent: both purposes
  await expectError(lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-NOPE' }), StockPreparationProjectTargetError, 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
  await expectError(lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-NOPE', targetPurpose: 'read' }), StockPreparationProjectTargetError, 409, 'STOCK_PREPARATION_PROJECT_ABSENT')
  // another tenant's registration is not this tenant's
  await expectError(lookup({ tenantId: 'tenant-s1-other', projectNo: PROJECT }), StockPreparationProjectTargetError, 409, 'STOCK_PREPARATION_PROJECT_ABSENT')

  // missing projectNo
  await expectError(lookup({ tenantId: TENANT }), StockPreparationProjectTargetError, 400, 'STOCK_PREPARATION_PROJECT_NO_REQUIRED')
  await expectError(lookup({ tenantId: TENANT, projectNo: '   ' }), StockPreparationProjectTargetError, 400, 'STOCK_PREPARATION_PROJECT_NO_REQUIRED')

  // source / readiness: never overlaid, store never consulted
  db.calls.length = 0
  for (const targetPurpose of ['source', 'readiness']) {
    const untouched = await lookup({ tenantId: TENANT, projectNo: 'PRJ-S1-NOPE', targetPurpose })
    assert.equal(untouched.target.sheetId, ENV_SHEET, `${targetPurpose}: env target`)
    assert.ok(!('projectTarget' in untouched))
  }
  assert.deepEqual(db.calls, [], 'source / readiness lookups never touch the registry')

  // no tenant: refused, not skipped
  await expectError(lookup({ projectNo: PROJECT }), StockPreparationTableActionError, 500, 'TABLE_ACTION_SOURCE_BINDING_SCOPE_REQUIRED')

  // store unavailable while the switch is on: a 501, never a silent env fallback
  await expectError(
    resolveProjectTargetForAction({ store: null, provisioning, projectId: PROJECT_ID, tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'write', env: ON }),
    StockPreparationProjectTargetError, 501, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE',
  )
})

// ── T-08 (R4): the overlay marker is the registry's alone ───────────────────────────────────────

test('T-08 (R4) a deploy-time config carrying `projectTarget` is drained WITHOUT it; only the registry stamps the marker', async () => {
  const marker = { projectNo: PROJECT, status: 'active', deploymentTargetObjectId: ENV_OBJECT }
  const stamped = { ...envAction(), projectTarget: marker }
  const bare = createStockPreparationTableActionRegistry({ actions: [envAction()] })
  const fromStamped = createStockPreparationTableActionRegistry({ actions: [stamped] })
  for (const input of LOOKUP_SHAPES) {
    const actual = await fromStamped.getTableAction({ ...input, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
    assert.ok(!('projectTarget' in actual), `no marker from deploy-time config for ${JSON.stringify(input)}`)
    assert.deepEqual(actual, await bare.getTableAction({ ...input, actionId: PLM_STOCK_PREPARATION_ACTION_ID }))
  }
  assert.deepEqual(await fromStamped.listTableActions(), await bare.listTableActions())
  // The strip is on the CONFIG DRAIN, not on the normalizer: a resolved action a route re-normalizes
  // keeps the marker the registry stamped...
  const { store } = makeStore()
  await store.create({ tenantId: TENANT, projectNo: PROJECT, sheetId: 'sheet_p1', objectId: deriveProjectSheetObjectId(TENANT, PROJECT) })
  const wired = createStockPreparationTableActionRegistry({ actions: [stamped], resolveProjectTarget: resolverFor({ store, provisioning: makeProvisioning(), env: ON }) })
  const resolved = await wired.getTableAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID, tenantId: TENANT, projectNo: PROJECT })
  assert.deepEqual(resolved.projectTarget, marker)
  assert.deepEqual(assertStockPreparationTargetReady(resolved).projectTarget, marker)
  // ...while a readiness lookup on the same stamped config, switch on, still carries none.
  const readiness = await wired.getTableAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID, tenantId: TENANT, projectNo: PROJECT, targetPurpose: 'readiness' })
  assert.ok(!('projectTarget' in readiness))
  assert.equal(readiness.target.sheetId, ENV_SHEET)
})

// ── T-05: the write gate ─────────────────────────────────────────────────────────────────────────

test('T-05 the apply write gate: all four conditions admit; each one missing alone refuses; canonical still refused', () => {
  const projectObjectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const target = { sheetId: 'sheet_p1', objectId: projectObjectId }
  const policy = { enabled: true, allowedTargetObjectIds: [ENV_OBJECT] }
  const gate = { enabled: true, registeredProjectObjectId: projectObjectId, deploymentTargetObjectId: ENV_OBJECT }
  const refused = (t, p, g, code, reason) => {
    const error = tryCatch(() => assertStockPrepApplySandboxAllowed(t, p, g))
    assert.ok(error instanceof StockPreparationTableActionError, `expected a refusal (${reason})`)
    assert.equal(error.status, 403)
    assert.equal(error.code, code)
    assert.equal(error.details.reason, reason)
  }

  // all four present → admitted
  assert.equal(assertStockPrepApplySandboxAllowed(target, policy, gate), undefined)
  assert.deepEqual(assertStockPrepApplyAllowed(target, { sandboxPolicy: policy, projectSheetGate: gate, route: 'small', actionId: PLM_STOCK_PREPARATION_ACTION_ID }), { mode: 'sandbox', maxCleanRows: null })

  // condition 1: switch off
  refused(target, policy, { ...gate, enabled: false }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  refused(target, policy, { ...gate, enabled: 'true' }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  // condition 2a: objectId must equal the REGISTERED one
  refused(target, policy, { ...gate, registeredProjectObjectId: deriveProjectSheetObjectId(TENANT, 'PRJ-S1-T2') }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  refused(target, policy, { ...gate, registeredProjectObjectId: null }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  // condition 2b: ...AND match the project-sheet pattern — a hand-named sandbox twin that is
  // "registered" (a forged marker) is still refused
  refused({ sheetId: 'sheet_x', objectId: 'plm_stock_preparation_sandbox_handmade' }, policy, { ...gate, registeredProjectObjectId: 'plm_stock_preparation_sandbox_handmade' }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  // condition 3: the sandbox policy must be enabled
  refused(target, { ...policy, enabled: false }, gate, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'sandbox_disabled')
  refused(target, undefined, gate, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'sandbox_disabled')
  // condition 4: the DEPLOYMENT's own env objectId must be allowlisted — the project sheet inherits
  // that authorization and cannot widen it
  refused(target, { enabled: true, allowedTargetObjectIds: ['plm_stock_preparation_sandbox_other'] }, gate, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  refused(target, { enabled: true, allowedTargetObjectIds: [] }, gate, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  refused(target, policy, { ...gate, deploymentTargetObjectId: null }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  // the prod canonical is refused BEFORE the branch, gate or no gate
  refused({ sheetId: 'sheet_c', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId }, policy, { ...gate, registeredProjectObjectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId }, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'prod_canonical')
  // no gate input at all (switch off / no overlay): the pre-S1 gate, byte for byte
  refused(target, policy, undefined, 'STOCK_PREP_APPLY_SANDBOX_ONLY', 'target_not_allowlisted')
  assert.equal(assertStockPrepApplySandboxAllowed({ sheetId: ENV_SHEET, objectId: ENV_OBJECT }, policy, undefined), undefined, 'the env twin still passes its own allowlist')
  assert.equal(assertStockPrepApplySandboxAllowed({ sheetId: ENV_SHEET, objectId: ENV_OBJECT }, policy, gate), undefined, 'the env twin still passes WITH a gate present (additive branch)')
})

// ── T-06: provisioning + the to-fill view ────────────────────────────────────────────────────────

test('T-06 provisioning: the one create path, own-base opted in, to-fill view on the create leg only', async () => {
  const provisioning = makeProvisioning()
  const context = { api: { multitable: { provisioning } } }
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const first = await provisionProjectSheet({ context, projectId: PROJECT_ID, tenantId: TENANT, projectNo: PROJECT, env: { MULTITABLE_STOCK_PREP_OWN_BASE: 'true' }, locale: 'zh-CN' })
  assert.equal(first.created, true)
  assert.equal(first.mode, 'canonical_create')
  assert.equal(first.objectId, objectId)
  assert.equal(first.sheetId, provisioning.getObjectSheetId(PROJECT_ID, objectId))
  assert.equal(first.ownBaseSource, 'derived', 'resolveOwnBase was opted in (no pair partner exists → derived)')
  const ensure = provisioning.calls.find((c) => c[0] === 'ensureObject')
  assert.equal(ensure[1], objectId)
  assert.match(ensure[2], /^base_integration-core_sp_/, 'landed in the plugin-derived own base')
  assert.equal(ensure[3], `备料-${PROJECT}`, 'the display name carries the project number, in the requested locale')
  const views = provisioning.calls.filter((c) => c[0] === 'ensureView').map((c) => c[1])
  assert.deepEqual(views, [STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID], 'fill view, then to-fill view')
  assert.equal(first.todoView.created, true)
  assert.equal(first.todoView.viewId, provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID))
  const todo = provisioning.calls.find((c) => c[0] === 'ensureView' && c[1] === STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID)[3]
  assert.equal(todo.name, '待填写')
  assert.equal(todo.filterInfo.conjunction, 'and')
  assert.deepEqual(todo.filterInfo.conditions[0], { fieldId: provisioning.getFieldId(PROJECT_ID, objectId, 'active'), operator: 'is', value: true })
  assert.deepEqual(todo.filterInfo.conditions[1], {
    conjunction: 'or',
    conditions: [
      { fieldId: provisioning.getFieldId(PROJECT_ID, objectId, 'procurementDone'), operator: 'isNot', value: true },
      { fieldId: provisioning.getFieldId(PROJECT_ID, objectId, 'warehouseDone'), operator: 'isNot', value: true },
    ],
  })
  assert.ok(!JSON.stringify(todo).includes(PROJECT), 'the view carries no project number')
  // a second call: already ready → no ensureObject, no view writes, created:false
  provisioning.calls.length = 0
  const again = await provisionProjectSheet({ context, projectId: PROJECT_ID, tenantId: TENANT, projectNo: PROJECT, env: {} })
  assert.equal(again.created, false)
  assert.equal(again.mode, 'canonical_existing')
  assert.equal(again.sheetId, first.sheetId)
  assert.deepEqual(again.todoView, { created: false, skipped: 'already_ready', viewId: null })
  assert.ok(!provisioning.calls.some((c) => c[0] === 'ensureObject' || c[0] === 'ensureView'), 'an existing sheet is left alone')
  // the handles
  assert.deepEqual(projectSheetViewHandles({ provisioning, projectId: PROJECT_ID, objectId }), {
    viewId: provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID),
    todoViewId: provisioning.getObjectViewId(PROJECT_ID, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID),
  })
  // the to-fill view refuses the sibling ids and degrades without the capability
  assert.notEqual(STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID, STOCK_PREPARATION_DEFAULT_VIEW_LOGICAL_ID)
  assert.notEqual(STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  assert.equal(buildStockPreparationTodoViewDescriptor({ provisioning, projectId: PROJECT_ID, objectId, locale: 'en' }).name, 'Stock Preparation To Fill')
  assert.deepEqual(await ensureStockPreparationTodoView({ provisioning: makeProvisioning({ withEnsureView: false }), projectId: PROJECT_ID, objectId, sheetId: 's' }), { created: false, skipped: 'api_unavailable', viewId: null })
  assert.deepEqual(await ensureStockPreparationTodoView({ provisioning, projectId: PROJECT_ID, objectId, sheetId: '' }), { created: false, skipped: 'sheet_unknown', viewId: null })
})

// ── T-07: G1 ─────────────────────────────────────────────────────────────────────────────────────

test('T-07 G1: skipped without roles, api_unavailable without the port, exact roles through the port, refusal propagates', async () => {
  const objectId = deriveProjectSheetObjectId(TENANT, PROJECT)
  const base = { projectId: PROJECT_ID, sheetId: 'sheet_p1', objectId, actorId: 'u_pull' }
  assert.deepEqual(await grantProjectSheetRoles({ ...base, provisioning: makeProvisioning({ grantResult: { granted: [] } }), roleIds: [] }), { attempted: false, skipped: 'no_roles_configured', roleCount: 0, granted: 0, alreadyGranted: 0 })
  assert.deepEqual(await grantProjectSheetRoles({ ...base, provisioning: makeProvisioning(), roleIds: ['stock-prep_frontline'] }), { attempted: false, skipped: 'api_unavailable', roleCount: 1, granted: 0, alreadyGranted: 0 })
  const port = makeProvisioning({ grantResult: { sheetId: 'sheet_p1', granted: ['stock-prep_frontline'], alreadyGranted: ['stock-prep_puller'] } })
  const outcome = await grantProjectSheetRoles({ ...base, provisioning: port, roleIds: ['stock-prep_frontline', 'stock-prep_puller'] })
  assert.deepEqual(outcome, { attempted: true, skipped: null, roleCount: 2, granted: 1, alreadyGranted: 1 })
  const call = port.calls.find((c) => c[0] === 'grantSheetRoleWrite')[1]
  assert.deepEqual(call, { projectId: PROJECT_ID, sheetId: 'sheet_p1', objectId, roleIds: ['stock-prep_frontline', 'stock-prep_puller'], actorId: 'u_pull' })
  const refusal = Object.assign(new Error('role outside namespace'), { status: 422, code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE' })
  let caught = null
  try { await grantProjectSheetRoles({ ...base, provisioning: makeProvisioning({ grantResult: refusal }), roleIds: ['multitable_admin'] }) } catch (error) { caught = error }
  assert.equal(caught, refusal, 'a host refusal propagates unwrapped')
})

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — the same per-test loop
// and output lines, plus the exit sentinel and the per-test timeout: a hung test can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-targets.test.cjs', tests, { passLine: '✓ stock-preparation-project-targets' })
