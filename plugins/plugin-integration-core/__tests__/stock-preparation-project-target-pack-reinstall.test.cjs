'use strict'

// 一个项目一张备料表 — S2 (ADR adr-stock-prep-project-sheets-20261008 §2 「客户包」, register R-36):
// THE DEPLOYMENT'S CUSTOMER PACK, RE-INSTALLED ONTO EACH PROJECT SHEET.
//
// `ensureObject` builds the frozen template's columns and nothing else, so a fresh project sheet has
// no `ext_` column; a deployment whose pull action declares `extensionFieldIds` answered its FIRST
// dry-run on a new project sheet with 422 TARGET_SCHEMA_INCOMPLETE (an open S1 limitation). S2
// re-places the pack the deployment installed on its env object onto the new object.
//
// Substrate: support/stock-preparation-project-sheet-harness.cjs (real routes, real stores, real
// installer, the shared field-permission invariant port; fake host with real per-object field sets).
//
//   PK-01 CREATE with a pack carrying ALL FOUR kinds (ext columns, an option set, a role view, column
//         write policies) and the port wired: every host and port WRITE addresses the project object
//         / sheet, never the env one; the ledger records the pack on the project object; the registry
//         row is written AFTER the install; audited values-free.
//   PK-02 THE 422 IS GONE: the first dry-run on the new sheet is 200 'ready'.
//   PK-03 A SHEET REGISTERED WITHOUT ITS PACK (S1's limitation, reproduced) answers the dry-run 422;
//         the 200 replay heals it and the next dry-run is 200.
//   PK-04 IDEMPOTENT REPLAY: a pack live on the project object at the catalog version, with its
//         columns present, is not re-run — no host write, no audit row.
//   PK-05 A GENUINE MID-INSTALL FAILURE leaves no registered row; repeated failures and the final
//         retry for the SAME project reuse ONE provisioned table (ensure-if-absent, derived objectId).
//   PK-06 A BAND NO PACK COVERS is refused 409 PACK_INCOMPLETE before anything is provisioned.
//   PK-07 retargetCustomerPack is BOUND to (tenant, project): the env main table, a hand-named sandbox
//         object and another tenant's derived sheet are refused; only the own derived sheet passes.
//   PK-08 buildProjectTargetBinding maps the declared band; without one the map is exactly S1's.
//   PK-09 SWITCH OFF: 404 DISABLED, no host call, no ledger read.
//   PK-10 THE CAP BOUNDARY (fix round 1): a REPEATING sheet-independent refusal — port absent, port
//         without reconcile, a declared role deleted on the host — across N distinct project numbers
//         provisions 0 tables and registers 0 rows.
//   PK-11 THE TENANT-CLAIM DOOR (fix round 1): a write-policy pack + a claimless login → 403
//         STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED before provisioning; a claimed login
//         → 201; a pack WITHOUT write policies needs no claim.
//   PK-12 HEAL ON COLUMN LOSS (fix round 1): ledger current but a declared `ext_` column deleted →
//         the replay reinstalls and audits once; the next replay does nothing.
//   PK-13 HEAL ON AN OLDER VERSION (fix round 1): ledger row at an older version → reinstall (ledger
//         mode 'reinstall', new version) and one audit row.
//   PK-14 GRANT HEAL FIRST (fix round 1): a replay whose pack heal refuses still heals the G1 grant.
//   PK-15 A DEPLOYMENT LOOKUP THAT FAILS for a non-config reason → 5xx, zero provisioning.
//   PK-16 THE INSTALLER'S BINDING: asked to install onto an objectId not derived for this
//         (tenant, project), it refuses before any host call.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  deriveProjectSheetObjectId,
  buildProjectTargetBinding,
  installProjectSheetCustomerPacks,
  planProjectSheetCustomerPacks,
  PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE,
} = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const {
  normalizeCustomerPack,
  retargetCustomerPack,
  isNormalizedCustomerPack,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const { createCustomerPackCatalog } = require(path.join(LIB, 'stock-preparation-customer-pack-catalog.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { createWriteScopePort } = require(path.join(__dirname, 'support', 'stock-preparation-write-scope-port.cjs'))
const {
  TEMPLATE_FIELD_IDS,
  clone,
  makeProvisioning,
  seedObject,
  mountProjectSheetRoutes,
  call,
} = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))

// Synthetic, obviously-fake values only.
const TENANT = 'tenant-s2-pack'
const OTHER_TENANT = 'tenant-s2-other'
const PROJECT = 'PRJ-S2-PACK'
const STAGING = `${TENANT}:integration-core`
const ENV_OBJECT = 'plm_stock_preparation_sandbox_s2_env'
const PACK_ID = 's2-synthetic-pack'
const PACK_VERSION = 3
const EXT_NOTE = 'ext_syntheticNote'
const EXT_FLAG = 'ext_syntheticFlag'
const EXT_GRADE = 'ext_syntheticGrade'
const ROLE_FLOOR = 'stock-prep_frontline'
const ROLE_PULLER = 'stock-prep_puller'

const PULLER = Object.freeze({ id: 'u_s2_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const CREATE_PATH = '/api/integration/stock-preparation/projects/:projectNo/target'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'

/** ext columns only — the S1-shaped pack. */
function bandPack(overrides = {}) {
  return {
    packId: PACK_ID,
    packVersion: PACK_VERSION,
    label: 'S2 synthetic pack',
    targetObjectId: ENV_OBJECT,
    extensionFields: [
      { id: EXT_NOTE, label: 'Synthetic note', type: 'string', ownership: 'human_preserved' },
      { id: EXT_FLAG, label: 'Synthetic flag', type: 'boolean', ownership: 'human_preserved' },
    ],
    ...overrides,
  }
}

/** ALL FOUR kinds a pack may carry. */
function fullPack(overrides = {}) {
  return bandPack({
    extensionFields: [
      { id: EXT_NOTE, label: 'Synthetic note', type: 'string', ownership: 'human_preserved' },
      { id: EXT_FLAG, label: 'Synthetic flag', type: 'boolean', ownership: 'human_preserved' },
      { id: EXT_GRADE, label: 'Synthetic grade', type: 'select', ownership: 'human_preserved' },
    ],
    optionSets: [{ fieldId: EXT_GRADE, options: [{ value: 'Grade alpha' }, { value: 'Grade beta' }] }],
    roleViews: [{ viewId: 'synthetic-floor', label: 'Synthetic floor view', hideOwnerships: ['plm_system'], hideFieldIds: [] }],
    fieldWritePolicies: [
      { roleId: ROLE_FLOOR, label: 'Floor', ownsFieldIds: [EXT_NOTE] },
      { roleId: ROLE_PULLER, label: 'Puller', ownsFieldIds: [EXT_FLAG] },
    ],
    ...overrides,
  })
}

function mount(options = {}) {
  return mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    envObjectId: ENV_OBJECT,
    envExtFieldIds: [EXT_NOTE, EXT_FLAG],
    extensionFieldIds: [EXT_NOTE, EXT_FLAG],
    packs: { [PACK_ID]: bandPack() },
    ledger: [{ packId: PACK_ID, packVersion: PACK_VERSION }],
    ...options,
  })
}

const createTarget = (h, { projectNo = PROJECT, claimed = false } = {}) => call(h.routes, 'POST', CREATE_PATH, {
  user: PULLER,
  params: { projectNo },
  body: {},
  ...(claimed ? { authenticatedTenantId: TENANT } : {}),
})
const dryRun = (h) => call(h.routes, 'POST', DRY_RUN_PATH, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body: { parameters: { projectNo: PROJECT } }, query: { tenantId: TENANT } })

const WRITE_CALLS = new Set(['ensureObject', 'ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureView', 'ensureObjectDefaultView'])
const hostWrites = (h) => h.provisioning.calls.filter((c) => WRITE_CALLS.has(c[0]))
const installerWrites = (h) => h.provisioning.calls.filter((c) => ['ensureMissingObjectFields', 'patchObjectFieldProperty'].includes(c[0]))
const provisionedProjectObjects = (h) => [...h.provisioning.objects.keys()].filter((key) => key.includes('plm_stock_preparation_sandbox_p_'))

/**
 * Register a sheet for PROJECT: provisioned and registered. Template columns only by default (an
 * S1-era sheet, no pack); `extraFieldIds` seeds columns that are already there.
 */
function registerWithoutPack(h, extraFieldIds = []) {
  const objectId = h.projectObjectId()
  seedObject(h.provisioning, STAGING, objectId, extraFieldIds)
  const sheetId = h.provisioning.getObjectSheetId(STAGING, objectId)
  h.registryRows().push({ id: 'seed-s1', tenant_id: TENANT, project_no: PROJECT, sheet_id: sheetId, object_id: objectId, status: 'active', created_by: 'seed', created_at: new Date('2026-10-08T00:00:00Z'), archived_at: null })
  return { objectId, sheetId }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('PK-01 create: a pack with ALL FOUR kinds lands on the PROJECT object only, ledgered there, registered AFTER the install, audited values-free', async () => {
  const port = createWriteScopePort({ knownRoleIds: [ROLE_FLOOR, ROLE_PULLER] })
  const h = mount({ packs: { [PACK_ID]: fullPack() }, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_GRADE], fieldPermissions: port })
  try {
    const res = await createTarget(h, { claimed: true })
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    const objectId = h.projectObjectId()
    const sheetId = h.provisioning.getObjectSheetId(STAGING, objectId)
    // 1. ext columns.
    assert.deepEqual(h.provisioning.calls.filter((c) => c[0] === 'ensureMissingObjectFields'), [['ensureMissingObjectFields', objectId, [EXT_NOTE, EXT_FLAG, EXT_GRADE]]])
    // 2. the option set (a property patch on the select column).
    assert.ok(h.provisioning.calls.some((c) => c[0] === 'patchObjectFieldProperty' && c[1] === objectId && c[2] === EXT_GRADE), 'the option set landed on the project object')
    // 3. the role view.
    assert.ok(h.provisioning.calls.some((c) => c[0] === 'ensureView' && c[2] === objectId && c[3] === sheetId && String(c[1]).includes('synthetic-floor')), 'the role view landed on the project sheet')
    // 4. the column write policies, through the port, on the project sheet.
    assert.equal(port.applyCalls.length, 1)
    assert.equal(port.applyCalls[0].sheetId, sheetId)
    assert.equal(port.applyCalls[0].packId, PACK_ID)
    assert.ok(port.applyCalls[0].entries.length > 0 && port.applyCalls[0].entries.every((entry) => entry.fieldId.includes(objectId.slice(-8))), 'every write-scope entry names a project-object column')
    // NOTHING addresses the env object or sheet.
    const envSheet = h.provisioning.getObjectSheetId(STAGING, ENV_OBJECT)
    for (const writeCall of hostWrites(h)) {
      assert.ok(!writeCall.includes(ENV_OBJECT) && !writeCall.includes(envSheet), `no write on the env object: ${JSON.stringify(writeCall)}`)
    }
    assert.ok(port.applyCalls.every((c) => c.sheetId !== envSheet))
    assert.ok([...port.rows.values()].every((row) => row.sheetId === sheetId), 'every field_permissions row is on the project sheet')
    // The ledger and the order.
    const ledger = h.ledgerRowsOn(objectId)
    assert.equal(ledger.length, 1, 'the install ledger records the pack ON THE PROJECT OBJECT')
    assert.equal(ledger[0].pack_version, String(PACK_VERSION), 'the ledger stores the version as TEXT (migration 076)')
    assert.equal(ledger[0].project_id, STAGING)
    const ledgerAt = h.db.calls.indexOf('upsertOne:integration_stock_prep_pack_installs')
    const registryAt = h.db.calls.indexOf('insertOne:integration_stock_prep_project_target')
    assert.ok(ledgerAt !== -1 && registryAt !== -1 && ledgerAt < registryAt, `install BEFORE register (${ledgerAt} < ${registryAt})`)
    assert.deepEqual(res.body.data.customerPacks, { planned: 1, installed: 1, reinstalled: 0, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [
      ['project_target_create', 'sheet_created'],
      ['project_target_create', 'customer_pack_installed'],
    ])
    assert.equal(h.auditAppends[1].detail.installedPackCount, 1)
    assert.deepEqual(h.auditAppends[1].detail.packVersions, { [PACK_ID]: PACK_VERSION })
  } finally { h.restore() }
})

test('PK-02 the first dry-run on the new sheet is 200 ready — no 422 — and the probe judged the ext columns on the project object', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    const res = await dryRun(h)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.status, 'ready')
    const probes = h.provisioning.calls.filter((c) => c[0] === 'resolveExistingObjectFieldIds' && c[1] === h.projectObjectId())
    assert.ok(probes.some((c) => c[2].includes(EXT_NOTE) && c[2].includes(EXT_FLAG)), 'the dry-run probe asked about the declared ext columns')
    assert.ok(h.source.calls.length > 0, 'the plan really read the source')
  } finally { h.restore() }
})

test('PK-03 a sheet registered WITHOUT its pack answers the dry-run 422; the 200 replay heals it and the next dry-run is 200', async () => {
  const h = mount()
  try {
    registerWithoutPack(h)
    const before = await dryRun(h)
    assert.equal(before.statusCode, 422, JSON.stringify(before.body))
    assert.equal(before.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
    assert.deepEqual([...before.body.error.details.missingFields].sort(), [EXT_FLAG, EXT_NOTE].sort())
    assert.deepEqual(h.source.calls, [], 'refused before any source read')
    const healed = await createTarget(h)
    assert.equal(healed.statusCode, 200, JSON.stringify(healed.body))
    assert.equal(healed.body.data.created, false)
    assert.deepEqual(healed.body.data.customerPacks, { planned: 1, installed: 1, reinstalled: 0, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [['project_target_create', 'customer_pack_installed']])
    assert.equal(h.registryRows().length, 1)
    const after = await dryRun(h)
    assert.equal(after.statusCode, 200, JSON.stringify(after.body))
  } finally { h.restore() }
})

test('PK-04 idempotent replay: a pack live at the catalog version with its columns present is never re-run — no host write, no audit row', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    h.provisioning.calls.length = 0
    const auditsBefore = h.auditAppends.length
    const again = await createTarget(h)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.deepEqual(again.body.data.customerPacks, { planned: 1, installed: 0, reinstalled: 0, alreadyInstalled: 1, notInCatalog: 0 })
    assert.deepEqual(hostWrites(h), [], 'no host write on the replay')
    assert.ok(h.provisioning.calls.some((c) => c[0] === 'resolveExistingObjectFieldIds' && c[1] === h.projectObjectId()), 'the column-existence probe ran before the skip')
    assert.deepEqual(h.auditAppends.slice(auditsBefore), [])
    assert.equal(h.ledgerRowsOn(h.projectObjectId()).length, 1)
  } finally { h.restore() }
})

test('PK-05 a genuine mid-install failure leaves NO registered row; repeated failures and the retry reuse ONE table for the project', async () => {
  const h = mount()
  try {
    h.provisioning.state.failFieldWrite = true
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await createTarget(h)
      assert.equal(failed.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED', JSON.stringify(failed.body))
      assert.deepEqual({ ...failed.body.error.details }, { packId: PACK_ID, installCode: 'CUSTOMER_PACK_FIELD_WRITE_FAILED' })
      assert.ok(!JSON.stringify(failed.body).includes('host refused'), 'the host message never reaches the response')
    }
    assert.equal(h.registryRows().length, 0, 'no registry row points at a sheet without its pack')
    assert.deepEqual(provisionedProjectObjects(h), [`${STAGING}/${h.projectObjectId()}`], 'ONE table for the project, however often the install fails')
    assert.equal(h.provisioning.calls.filter((c) => c[0] === 'ensureObject').length, 1, 'ensure-if-absent: created once, then reused')
    assert.deepEqual(h.ledgerRowsOn(h.projectObjectId()), [])
    assert.deepEqual(h.auditAppends, [])
    h.provisioning.state.failFieldWrite = false
    const retried = await createTarget(h)
    assert.equal(retried.statusCode, 201, JSON.stringify(retried.body))
    assert.equal(h.registryRows().length, 1)
    assert.equal(h.provisioning.calls.filter((c) => c[0] === 'ensureObject').length, 1, 'the retry reused the same table')
  } finally { h.restore() }
})

test('PK-06 a declared band no pack covers is refused 409 PACK_INCOMPLETE before anything is provisioned', async () => {
  for (const [label, options] of [
    ['no ledger row on the env object', { ledger: [] }],
    ['the ledger pack is no longer in this server\'s catalog', { packs: {} }],
  ]) {
    const h = mount(options)
    try {
      const res = await createTarget(h)
      assert.equal(res.statusCode, 409, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE', label)
      assert.deepEqual([...res.body.error.details.missingExtensionFields].sort(), [EXT_FLAG, EXT_NOTE].sort(), label)
      assert.deepEqual(hostWrites(h), [], `${label}: nothing provisioned`)
      assert.equal(h.registryRows().length, 0, label)
    } finally { h.restore() }
  }
  const bare = mount({ extensionFieldIds: [], ledger: [], packs: {} })
  try {
    const res = await createTarget(bare)
    assert.equal(res.statusCode, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.customerPacks, { planned: 0, installed: 0, reinstalled: 0, alreadyInstalled: 0, notInCatalog: 0 })
    assert.deepEqual(installerWrites(bare), [])
  } finally { bare.restore() }
})

test('PK-07 retargetCustomerPack is bound to (tenant, project): env main, hand-named, another tenant\'s derived are refused; the own derived passes', () => {
  const own = deriveProjectSheetObjectId(TENANT, PROJECT)
  const source = normalizeCustomerPack(bandPack())
  const moved = retargetCustomerPack(source, { tenantId: TENANT, projectNo: PROJECT, targetObjectId: own })
  assert.ok(isNormalizedCustomerPack(moved))
  assert.equal(normalizeCustomerPack(moved), moved)
  assert.equal(moved.targetObjectId, own)
  const { targetObjectId: _a, ...restMoved } = moved
  const { targetObjectId: _b, ...restSource } = source
  assert.deepEqual(clone(restMoved), clone(restSource))
  assert.deepEqual(Object.keys(moved), Object.keys(source))
  const shapes = [
    ['the env main table', STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, 'not_project_sheet'],
    ['a hand-named sandbox object', ENV_OBJECT, 'not_project_sheet'],
    ['another tenant\'s derived sheet (well-formed)', deriveProjectSheetObjectId(OTHER_TENANT, PROJECT), 'not_this_project_sheet'],
    ['another project\'s derived sheet (well-formed)', deriveProjectSheetObjectId(TENANT, 'PRJ-S2-OTHER'), 'not_this_project_sheet'],
  ]
  for (const [label, objectId, reason] of shapes) {
    assert.throws(
      () => retargetCustomerPack(source, { tenantId: TENANT, projectNo: PROJECT, targetObjectId: objectId }),
      (error) => error.reason === 'PACK_TARGET_OBJECT_ID_INVALID' && error.details.provisioningReason === reason,
      label,
    )
  }
  assert.throws(() => retargetCustomerPack(source, { targetObjectId: own }), (error) => error.details.provisioningReason === 'project_scope_missing', 'no scope, no re-placement')
})

test('PK-08 buildProjectTargetBinding: the declared band joins the map; without one the map is S1\'s', async () => {
  const provisioning = makeProvisioning()
  const target = { sheetId: 'sheet_x', objectId: deriveProjectSheetObjectId(TENANT, PROJECT) }
  const bare = await buildProjectTargetBinding({ provisioning, projectId: STAGING, target })
  assert.deepEqual(Object.keys(bare.fieldIdMap), TEMPLATE_FIELD_IDS)
  const withBand = await buildProjectTargetBinding({ provisioning, projectId: STAGING, target, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_NOTE, 7] })
  assert.deepEqual(Object.keys(withBand.fieldIdMap), [...TEMPLATE_FIELD_IDS, EXT_NOTE, EXT_FLAG])
})

test('PK-09 switch OFF: 404 DISABLED, no host call, no ledger read', async () => {
  const h = mount({ switchOn: false })
  try {
    const res = await createTarget(h)
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
    assert.deepEqual(h.provisioning.calls, [])
    assert.deepEqual(h.db.calls, [])
  } finally { h.restore() }
})

test('PK-10 the cap boundary: a REPEATING sheet-independent refusal across N project numbers provisions 0 tables and registers 0 rows', async () => {
  const N = 5
  for (const [label, port, installCode] of [
    ['no field-permission port on the host', null, 'CUSTOMER_PACK_FIELD_PERMISSIONS_UNAVAILABLE'],
    ['a port without reconcile support', createWriteScopePort({ supportsReconcile: false }), 'CUSTOMER_PACK_FIELD_PERMISSION_RECONCILE_UNSUPPORTED'],
    ['a declared role deleted on the host', createWriteScopePort({ knownRoleIds: [ROLE_FLOOR] }), 'CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN'],
  ]) {
    const h = mount({ packs: { [PACK_ID]: fullPack() }, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_GRADE], fieldPermissions: port })
    try {
      for (let i = 0; i < N; i += 1) {
        const res = await createTarget(h, { projectNo: `PRJ-S2-CAP-${i}`, claimed: true })
        assert.equal(res.body.error && res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED', `${label} #${i}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.details.installCode, installCode, `${label} #${i}`)
      }
      assert.deepEqual(provisionedProjectObjects(h), [], `${label}: NO table provisioned for any of the ${N} project numbers`)
      assert.deepEqual(hostWrites(h), [], `${label}: no host write at all`)
      assert.equal(h.registryRows().length, 0, `${label}: no registry row`)
      assert.deepEqual(h.auditAppends, [], label)
    } finally { h.restore() }
  }
})

test('PK-11 the tenant-claim door: a write-policy pack needs a claimed login before anything is provisioned; a band-only pack does not', async () => {
  const port = () => createWriteScopePort({ knownRoleIds: [ROLE_FLOOR, ROLE_PULLER] })
  const claimless = mount({ packs: { [PACK_ID]: fullPack() }, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_GRADE], fieldPermissions: port() })
  try {
    const res = await createTarget(claimless)
    assert.equal(res.statusCode, 403, JSON.stringify(res.body))
    assert.equal(res.body.error.code, PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE)
    assert.deepEqual({ ...res.body.error.details }, { writeScopePackCount: 1 }, 'values-free')
    assert.deepEqual(hostWrites(claimless), [], 'nothing provisioned')
    assert.equal(claimless.registryRows().length, 0)
  } finally { claimless.restore() }
  const claimed = mount({ packs: { [PACK_ID]: fullPack() }, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_GRADE], fieldPermissions: port() })
  try {
    assert.equal((await createTarget(claimed, { claimed: true })).statusCode, 201)
  } finally { claimed.restore() }
  const bandOnly = mount()
  try {
    assert.equal((await createTarget(bandOnly)).statusCode, 201, 'a pack that governs no write scope needs no claim')
  } finally { bandOnly.restore() }
})

test('PK-12 heal on column loss: ledger current but an ext column deleted → the replay reinstalls and audits once; the next replay does nothing', async () => {
  const h = mount()
  try {
    assert.equal((await createTarget(h)).statusCode, 201)
    h.provisioning.objects.get(`${STAGING}/${h.projectObjectId()}`).fields.delete(EXT_FLAG)
    const auditsBefore = h.auditAppends.length
    const healed = await createTarget(h)
    assert.equal(healed.statusCode, 200, JSON.stringify(healed.body))
    assert.deepEqual(healed.body.data.customerPacks, { planned: 1, installed: 0, reinstalled: 1, alreadyInstalled: 0, notInCatalog: 0 })
    assert.ok(h.provisioning.objects.get(`${STAGING}/${h.projectObjectId()}`).fields.has(EXT_FLAG), 'the column is back')
    assert.deepEqual(h.auditAppends.slice(auditsBefore).map((e) => [e.action, e.mode, e.detail.reinstalledPackCount]), [['project_target_create', 'customer_pack_installed', 1]])
    const quiet = await createTarget(h)
    assert.deepEqual(quiet.body.data.customerPacks, { planned: 1, installed: 0, reinstalled: 0, alreadyInstalled: 1, notInCatalog: 0 })
    assert.equal(h.auditAppends.length, auditsBefore + 1, 'audited exactly once')
  } finally { h.restore() }
})

test('PK-13 heal on an older version: the replay reinstalls (ledger mode reinstall, new version) and audits once', async () => {
  const h = mount()
  try {
    // The columns ARE on the sheet, so only the VERSION can make this replay reinstall.
    registerWithoutPack(h, [EXT_NOTE, EXT_FLAG])
    h.db.rowsOf('integration_stock_prep_pack_installs').push({
      id: 'seed-old', tenant_id: TENANT, workspace_id: null, project_id: STAGING, object_id: h.projectObjectId(),
      pack_id: PACK_ID, pack_version: String(PACK_VERSION - 1), mode: 'install', status: 'installed',
      installed_fields_json: [], summary_json: {}, warnings_json: [], last_install_at: new Date('2026-10-02T00:00:00Z'),
    })
    const res = await createTarget(h)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.customerPacks, { planned: 1, installed: 0, reinstalled: 1, alreadyInstalled: 0, notInCatalog: 0 })
    const ledger = h.ledgerRowsOn(h.projectObjectId())
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].pack_version, String(PACK_VERSION))
    assert.equal(ledger[0].mode, 'reinstall')
    assert.equal(h.auditAppends.filter((e) => e.mode === 'customer_pack_installed').length, 1)
    const again = await createTarget(h)
    assert.equal(again.body.data.customerPacks.alreadyInstalled, 1)
    assert.equal(h.auditAppends.filter((e) => e.mode === 'customer_pack_installed').length, 1, 'once')
  } finally { h.restore() }
})

test('PK-14 grant heal first: a replay whose pack heal refuses still heals the G1 grant (and audits it)', async () => {
  const h = mount({ grantRoleIds: [ROLE_FLOOR], packs: {} })
  try {
    registerWithoutPack(h)
    const res = await createTarget(h)
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE')
    assert.equal(h.provisioning.grantCalls.length, 1, 'the grant ran before the pack plan refused')
    assert.deepEqual(h.provisioning.grantCalls[0].roleIds, [ROLE_FLOOR])
    assert.deepEqual(h.auditAppends.map((e) => [e.action, e.mode]), [['project_target_grant', 'granted']])
  } finally { h.restore() }
  const claimless = mount({ grantRoleIds: [ROLE_FLOOR], packs: { [PACK_ID]: fullPack() }, extensionFieldIds: [EXT_NOTE, EXT_FLAG, EXT_GRADE], fieldPermissions: createWriteScopePort({ knownRoleIds: [ROLE_FLOOR, ROLE_PULLER] }) })
  try {
    registerWithoutPack(claimless)
    const res = await createTarget(claimless)
    assert.equal(res.statusCode, 403, JSON.stringify(res.body))
    assert.equal(res.body.error.code, PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE, 'the replay heal of a write-policy pack also needs the claim')
    assert.equal(claimless.provisioning.grantCalls.length, 1, 'and the grant was healed anyway')
    assert.deepEqual(installerWrites(claimless), [], 'no install ran')
  } finally { claimless.restore() }
})

test('PK-15 a deployment lookup that fails for a non-config reason is a 5xx with zero provisioning', async () => {
  const h = mount({ sourceBindingStore: { async get() { throw new Error('binding store unreachable') }, async set() {} } })
  try {
    const res = await createTarget(h)
    assert.ok(res.statusCode >= 500, JSON.stringify(res.body))
    assert.deepEqual(hostWrites(h), [])
    assert.equal(h.registryRows().length, 0)
    assert.deepEqual(h.auditAppends, [])
  } finally { h.restore() }
})

test('PK-16 the installer refuses an objectId not derived for this (tenant, project) before any host call', async () => {
  const catalog = createCustomerPackCatalog({ packs: { [PACK_ID]: bandPack() } })
  const plan = await planProjectSheetCustomerPacks({ tenantId: TENANT, projectId: STAGING, deploymentObjectId: ENV_OBJECT, extensionFieldIds: [EXT_NOTE], packCatalog: catalog, packInstallStore: { async listInstalledFieldIds() { return { fieldIds: [], packIds: [PACK_ID] } } } })
  const provisioning = makeProvisioning()
  for (const objectId of [deriveProjectSheetObjectId(OTHER_TENANT, PROJECT), ENV_OBJECT]) {
    await assert.rejects(
      installProjectSheetCustomerPacks({ plan, provisioning, projectId: STAGING, tenantId: TENANT, projectNo: PROJECT, objectId }),
      (error) => error.code === 'STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID',
    )
  }
  assert.deepEqual(provisioning.calls, [], 'no host call')
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`  ${name} OK`)
    } catch (error) {
      failed += 1
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    }
  }
  if (failed) {
    console.error(`stock-preparation-project-target-pack-reinstall.test.cjs FAILED (${failed})`)
    process.exit(1)
  }
  console.log('✓ stock-preparation-project-target-pack-reinstall')
})()
