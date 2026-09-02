'use strict'

// 备料列级写权限 —— 对账的边界 (#5455 adversarial verification round)
//
// The sibling suite (stock-preparation-department-fields-and-write-scoping) proves the reconcile
// DOES the thing it exists for. This one proves the four boundaries it must not cross and the two
// reports it must not fake, each one a defect an attack lane actually reproduced on the branch:
//
//   RC1  A revision that governs a rectangle but derives ZERO denials (single-role ownership, or
//        total shared custody) must still reconcile. Keying the install on the DERIVED denial count
//        meant the reconcile, the census and the whole write-scope report vanished for exactly the
//        revision the mechanism was built to serve — and the previous revision's denials kept the
//        columns locked for every role the new one names as their owner.
//
//   RC2  Two packs on one canonical sheet. `targetObjectId` defaults to that single table and the
//        physical ids are a pure function of (project, object, logical id), so overlapping
//        rectangles are the NORMAL case. Pack B must not delete pack A's enforced denials; it must
//        REFUSE, before the first schema write, with a coded 422 naming the other pack.
//
//   RC3  The dry-run's "about to be fixed" vs "a human must clear this" split must be witnessed on
//        BOTH axes. The suite only ever had an out-of-region row on the ROLE axis, so dropping the
//        COLUMN conjunct — or the willRemove filter entirely — stayed green.
//
//   RC4  An operator's own row inside the rectangle is never retired and never claimed: it is
//        reported as held by somebody else.
//
//   RC5  A host port that cannot honour a region is refused, not silently degraded, and the dry-run
//        says so instead of promising removals that will never happen.
//
//   RC7  The RETIRED-denials INFO line — the code's stated answer to "a permission that just
//        stopped applying must be named, not folded into a count" — is emitted by something.
//
// Values-free throughout: ids, role ids, counts, closed tokens. No labels, no option values.

const assert = require('node:assert')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  installCustomerPack,
  planCustomerPackInstall,
  __internals: installerInternals,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const PROJECT_ID = 'proj_bounds'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const SHEET_ID = 'sheet_bounds'
const ROLE_PURCHASING = 'plugin-integration-core:bom-prep:purchasing'
const ROLE_WAREHOUSE = 'plugin-integration-core:bom-prep:warehouse'

const BASE_MARKER = 'plugin:plugin-integration-core/stock-preparation'
const markerFor = (packId) => `${BASE_MARKER}#${packId}`
const OPERATOR_MARKER = 'operator:univer-meta-authoring-route'

const physical = (fieldId) => `fld_${PROJECT_ID}_${OBJECT_ID}_${fieldId}`

// ---------------------------------------------------------------------------
// A minimal host: a pure field-id derivation plus a mutable `field_permissions`.
// ---------------------------------------------------------------------------
function createFakeProvisioning() {
  const fields = new Map()
  // Every host WRITE primitive is recorded by name, so "refused before the first schema write" is a
  // checkable claim rather than an ordering the reader has to take on trust.
  const writes = []
  return {
    fields,
    writes,
    getFieldId: (projectId, objectId, fieldId) => `fld_${projectId}_${objectId}_${fieldId}`,
    async findObjectSheet() { return { id: SHEET_ID } },
    async readObjectFieldsContent() { return { fields: [...fields.values()] } },
    async ensureMissingObjectFields({ fields: requested }) {
      writes.push('ensureMissingObjectFields')
      const created = []
      for (const field of requested || []) {
        if (fields.has(field.id)) continue
        fields.set(field.id, { id: field.id, property: {} })
        created.push(field.id)
      }
      return { created, skipped: [] }
    },
    async patchObjectFieldProperty() { writes.push('patchObjectFieldProperty'); return { ok: true } },
    async ensureView() { writes.push('ensureView'); return { ok: true } },
    async ensureObjectView() { return { ok: true } },
    async listObjectViews() { return { views: [] } },
  }
}

/**
 * A port over a real (in-memory) `field_permissions`, implementing exactly the semantics the host
 * service implements: the per-pack provenance marker, the CASE-guarded upsert that never launders
 * somebody else's row, and the region-bounded delete over this pack's marker plus the legacy one.
 */
function createPort({ supportsReconcile = true, rows = new Map() } = {}) {
  const port = {
    rows,
    applyCalls: [],
    async applyRoleWriteScopes({ sheetId, entries, packId, reconcile }) {
      this.applyCalls.push({ sheetId, entries, packId, reconcile })
      const createdBy = typeof packId === 'string' && packId ? markerFor(packId) : BASE_MARKER
      for (const entry of entries) {
        const key = `${entry.fieldId} ${entry.roleId}`
        const existing = rows.get(key)
        if (existing) {
          // Adopt ONLY a row this call could also delete; anything else keeps its provenance.
          const adoptable = existing.createdBy === createdBy || existing.createdBy === BASE_MARKER
          rows.set(key, { ...existing, readOnly: true, createdBy: adoptable ? createdBy : existing.createdBy })
        } else {
          rows.set(key, { ...entry, sheetId, readOnly: true, createdBy })
        }
      }
      if (!supportsReconcile || !reconcile) return { applied: entries.length, entries }

      const desired = new Set(entries.map((entry) => `${entry.fieldId} ${entry.roleId}`))
      const fieldIds = new Set(reconcile.fieldIds)
      const roleIds = new Set(reconcile.roleIds)
      const mine = new Set([createdBy, BASE_MARKER])
      const removed = []
      for (const [key, row] of [...rows.entries()]) {
        if (row.sheetId !== sheetId) continue
        if (!mine.has(row.createdBy)) continue
        if (row.readOnly !== true) continue
        if (!fieldIds.has(row.fieldId) || !roleIds.has(row.roleId)) continue
        if (desired.has(key)) continue
        rows.delete(key)
        removed.push({ fieldId: row.fieldId, roleId: row.roleId })
      }
      removed.sort((left, right) => (left.fieldId === right.fieldId
        ? left.roleId.localeCompare(right.roleId)
        : left.fieldId.localeCompare(right.fieldId)))
      return { applied: entries.length, entries, removed }
    },
    async listRoleWriteScopes({ sheetId }) {
      const entries = []
      const foreignEntries = []
      for (const row of rows.values()) {
        if (row.sheetId !== sheetId || row.readOnly !== true) continue
        if (row.createdBy === BASE_MARKER) {
          entries.push({ fieldId: row.fieldId, roleId: row.roleId, createdBy: row.createdBy, packId: null })
        } else if (typeof row.createdBy === 'string' && row.createdBy.startsWith(`${BASE_MARKER}#`)) {
          entries.push({
            fieldId: row.fieldId,
            roleId: row.roleId,
            createdBy: row.createdBy,
            packId: row.createdBy.slice(BASE_MARKER.length + 1),
          })
        } else {
          foreignEntries.push({ fieldId: row.fieldId, roleId: row.roleId, createdBy: row.createdBy || null })
        }
      }
      return { sheetId, entries, foreignEntries }
    },
    async findMissingRoleIds() { return { missing: [] } },
  }
  if (supportsReconcile) port.supportsWriteScopeReconcile = true
  return port
}

const packWith = (packId, packVersion, policies) => ({
  packId,
  packVersion,
  extensionFields: [],
  fieldWritePolicies: policies.map((policy) => ({ ...policy })),
})

const install = (port, pack, logger, provisioning) => installCustomerPack({
  provisioning: provisioning || createFakeProvisioning(),
  projectId: PROJECT_ID,
  pack,
  logger: logger || { info() {}, warn() {} },
  fieldPermissions: port,
})

const dryRun = (port, pack) => planCustomerPackInstall({
  provisioning: createFakeProvisioning(),
  projectId: PROJECT_ID,
  pack,
  fieldPermissions: port,
})

const rowKeys = (port) => [...port.rows.keys()].sort()

// ---------------------------------------------------------------------------
// RC1. A governed rectangle with ZERO derived denials still reconciles.
// ---------------------------------------------------------------------------
const V1_SPLIT = [
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation', 'warehouseDone'] },
]
// SHARED CUSTODY: both roles own all four governed columns, so NO denial is derived at all.
const V2_SHARED = [
  {
    roleId: ROLE_PURCHASING,
    ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation', 'warehouseDone'],
  },
  {
    roleId: ROLE_WAREHOUSE,
    ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation', 'warehouseDone'],
  },
]
// SINGLE-ROLE OWNERSHIP: one declared role owning everything derives no denial either.
const V2_SINGLE = [
  {
    roleId: ROLE_PURCHASING,
    ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation', 'warehouseDone'],
  },
]

async function sharedCustodyRevisionRetiresEveryDenial() {
  const port = createPort()
  const v1 = await install(port, packWith('bounds', 1, V1_SPLIT))
  assert.equal(v1.appliedWriteScopes, 4, 'v1 denies each role the other role\'s two columns')
  assert.deepEqual(rowKeys(port), [
    `${physical('procurementDone')} ${ROLE_WAREHOUSE}`,
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
    `${physical('warehouseDone')} ${ROLE_PURCHASING}`,
  ])

  // THE DRY RUN must rehearse this, not go silent because the denial count is zero.
  const plan = await dryRun(port, packWith('bounds', 2, V2_SHARED))
  assert.equal(plan.writeScopeCheck, 'checked', 'a governed rectangle is always censused')
  assert.equal(plan.counts.fieldWriteDenials, 0, 'shared custody derives no denial — that is the point')
  assert.equal(plan.counts.willRemoveWriteScopes, 4, 'and all four v1 denials are about to be retired')
  assert.deepEqual(plan.operatorMustClearWriteScopes, [], 'none of them needs a human')
  assert.equal(plan.canInstall, true)

  // THE INSTALL must actually issue the delete.
  const v2 = await install(port, packWith('bounds', 2, V2_SHARED))
  assert.equal(v2.writeScopeReconcile, 'reconciled')
  assert.equal(v2.removedWriteScopeCount, 4)
  assert.deepEqual(rowKeys(port), [], 'the rectangle now holds no denial at all')
  assert.equal(v2.writeScopeCheck, 'checked')
  assert.deepEqual(v2.staleWriteScopes, [], 'and nothing is left for an operator')
  // The port really was called, with an empty entry list and the full rectangle.
  const lastCall = port.applyCalls[port.applyCalls.length - 1]
  assert.deepEqual(lastCall.entries, [])
  assert.equal(lastCall.reconcile.fieldIds.length, 4)
}

async function singleRoleRevisionRetiresEveryDenialItStillGoverns() {
  // ONE declared role owning every governed column also derives zero denials. The reconcile still
  // fires — and it retires exactly the rows inside the rectangle it now declares, which is the two
  // for the surviving role. Dropping a ROLE from the declaration shrinks the rectangle, so the
  // dropped role's rows become orphans only an operator can clear; that is the honest outcome and
  // it is asserted rather than glossed, because "retires everything" would be the wrong promise.
  const port = createPort()
  await install(port, packWith('bounds', 1, V1_SPLIT))
  const v2 = await install(port, packWith('bounds', 2, V2_SINGLE))
  assert.equal(v2.writeScopeReconcile, 'reconciled')
  assert.deepEqual(v2.removedWriteScopes, [
    { fieldId: physical('warehouseConfirmation'), roleId: ROLE_PURCHASING },
    { fieldId: physical('warehouseDone'), roleId: ROLE_PURCHASING },
  ], 'the two in-rectangle denials go')
  assert.deepEqual(rowKeys(port), [
    `${physical('procurementDone')} ${ROLE_WAREHOUSE}`,
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
  ], 'the dropped role\'s rows survive — the pack no longer governs that role')
  assert.equal(v2.staleWriteScopeCount, 2)
  for (const row of v2.staleWriteScopes) assert.equal(row.inReconcileRegion, false)
}

async function aPackWithNoPoliciesStillTouchesNothing() {
  // The other side of the same gate: no declaration at all means no region, no call, no delete.
  const port = createPort()
  const summary = await install(port, { packId: 'bounds', packVersion: 1, extensionFields: [] })
  assert.equal(port.applyCalls.length, 0, 'the port is never called')
  assert.equal(summary.writeScopeReconcile, 'not_declared')
  assert.equal(summary.removedWriteScopes, null)
  assert.equal(summary.writeScopeCheck, 'not_declared')
  assert.equal(summary.staleWriteScopes, null)
  const plan = await dryRun(port, { packId: 'bounds', packVersion: 1, extensionFields: [] })
  assert.equal(plan.writeScopeRegion, null)
  assert.equal(plan.writeScopeCheck, 'not_declared')
}

// ---------------------------------------------------------------------------
// RC2. A second pack on the same sheet is REFUSED, never resolved by deletion.
// ---------------------------------------------------------------------------
const PACK_A_POLICIES = [
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation'] },
]
// Pack B claims the SAME two columns and the SAME two roles — an overlapping rectangle.
const PACK_B_POLICIES = [
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['warehouseConfirmation'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['procurementReply'] },
]

async function aSecondPackIsRefusedNotResolvedByDeletion() {
  const port = createPort()
  const a = await install(port, packWith('pack-alpha', 1, PACK_A_POLICIES))
  assert.equal(a.appliedWriteScopes, 2)
  const afterA = rowKeys(port)
  assert.deepEqual(afterA, [
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ])
  // Every one of pack A's rows carries pack A's marker — that is what makes it attributable.
  for (const row of port.rows.values()) assert.equal(row.createdBy, markerFor('pack-alpha'))

  // THE DRY RUN names the conflict and refuses to say canInstall.
  const plan = await dryRun(port, packWith('pack-beta', 1, PACK_B_POLICIES))
  assert.equal(plan.writeScopeCheck, 'pack_conflict')
  assert.equal(plan.canInstall, false, 'a deployer is told BEFORE they try')
  assert.deepEqual(plan.packConflictWriteScopes, [
    { fieldId: physical('procurementReply'), roleId: ROLE_WAREHOUSE, packId: 'pack-alpha' },
    { fieldId: physical('warehouseConfirmation'), roleId: ROLE_PURCHASING, packId: 'pack-alpha' },
  ])
  assert.equal(plan.counts.packConflictWriteScopes, 2)
  // …and they are never counted as work THIS install will do. `inReconcileRegion` is a claim about
  // what the DELETE can reach, and it cannot reach another pack's rows however deep in the
  // rectangle they sit — so every one of them must land on the human's list, not the promise list.
  const conflictKeys = plan.packConflictWriteScopes.map((row) => `${row.fieldId} ${row.roleId}`)
  for (const row of plan.staleWriteScopes) {
    if (!conflictKeys.includes(`${row.fieldId} ${row.roleId}`)) continue
    assert.equal(row.inReconcileRegion, false, 'another pack row is never promised')
  }
  assert.deepEqual(plan.willRemoveWriteScopes, [], 'this install would retire nothing here')
  assert.equal(
    plan.operatorMustClearWriteScopes.length,
    plan.staleWriteScopes.length,
    'every stale row is a human decision while the conflict stands',
  )

  // THE INSTALL refuses with a coded 422 that names the other pack, over an UNTOUCHED sheet.
  let caught = null
  try {
    await install(port, packWith('pack-beta', 1, PACK_B_POLICIES))
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'pack B must not install over pack A')
  assert.equal(caught.status, 422)
  assert.equal(caught.code, 'CUSTOMER_PACK_FIELD_WRITE_SCOPE_PACK_CONFLICT')
  assert.deepEqual(caught.details.conflictingPackIds, ['pack-alpha'])
  assert.equal(caught.details.conflicts.length, 2)
  // BYTE-IDENTICAL: pack A's rows are exactly as they were, and pack B wrote nothing.
  assert.deepEqual(rowKeys(port), afterA, 'pack A\'s enforced denials are untouched')
  assert.equal(port.applyCalls.length, 1, 'the write port was never reached a second time')

  // …and pack A can still reconcile its OWN rows afterwards.
  const a2 = await install(port, packWith('pack-alpha', 2, [
    { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'warehouseConfirmation'] },
    { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['procurementReply', 'warehouseConfirmation'] },
  ]))
  assert.equal(a2.writeScopeReconcile, 'reconciled')
  assert.equal(a2.removedWriteScopeCount, 2)
  assert.deepEqual(rowKeys(port), [])
}

async function aLegacyPackLessRowIsAdoptedNotRefused() {
  // Rows written before the marker carried a pack id report packId null. They are nobody else's,
  // so they must NOT trip the conflict refusal — otherwise every upgraded deployment is bricked.
  const rows = new Map([
    [`${physical('procurementReply')} ${ROLE_WAREHOUSE}`, {
      fieldId: physical('procurementReply'),
      roleId: ROLE_WAREHOUSE,
      sheetId: SHEET_ID,
      readOnly: true,
      createdBy: BASE_MARKER,
    }],
  ])
  const port = createPort({ rows })
  const plan = await dryRun(port, packWith('pack-alpha', 1, PACK_A_POLICIES))
  assert.deepEqual(plan.packConflictWriteScopes, [], 'a legacy row is not another pack')
  assert.equal(plan.writeScopeCheck, 'checked')
  assert.equal(plan.canInstall, true)

  const summary = await install(port, packWith('pack-alpha', 1, PACK_A_POLICIES))
  assert.equal(summary.writeScopeReconcile, 'reconciled')
  // It was re-declared, so it is upserted and ADOPTED rather than retired.
  assert.equal(port.rows.get(`${physical('procurementReply')} ${ROLE_WAREHOUSE}`).createdBy, markerFor('pack-alpha'))
}

// ---------------------------------------------------------------------------
// RC3. The dry-run split is witnessed on BOTH axes.
// ---------------------------------------------------------------------------
async function theDryRunSplitIsWitnessedOnBothAxes() {
  const port = createPort()
  await install(port, packWith('bounds', 1, V1_SPLIT))

  // (a) OUT OF REGION ON THE COLUMN AXIS: a column no policy of this pack names.
  const UNGOVERNED = physical('actualArrivalDate')
  port.rows.set(`${UNGOVERNED} ${ROLE_PURCHASING}`, {
    fieldId: UNGOVERNED,
    roleId: ROLE_PURCHASING,
    sheetId: SHEET_ID,
    readOnly: true,
    createdBy: markerFor('bounds'),
  })
  // (b) OUT OF REGION ON THE ROLE AXIS: a role this pack does not declare.
  const OTHER_ROLE = 'plugin-integration-core:bom-prep:quality'
  port.rows.set(`${physical('procurementReply')} ${OTHER_ROLE}`, {
    fieldId: physical('procurementReply'),
    roleId: OTHER_ROLE,
    sheetId: SHEET_ID,
    readOnly: true,
    createdBy: markerFor('bounds'),
  })

  // v2 moves one column between the two declared roles, so exactly ONE in-region orphan appears.
  const V2_MOVE = [
    { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation'] },
    { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseDone'] },
  ]
  const plan = await dryRun(port, packWith('bounds', 2, V2_MOVE))

  const key = (row) => `${row.fieldId} ${row.roleId}`
  assert.deepEqual(plan.willRemoveWriteScopes.map(key), [
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ], 'only the in-region orphan is promised')
  assert.deepEqual(plan.operatorMustClearWriteScopes.map(key).sort(), [
    `${UNGOVERNED} ${ROLE_PURCHASING}`,
    `${physical('procurementReply')} ${OTHER_ROLE}`,
  ].sort(), 'BOTH out-of-region rows land on the human\'s list — column axis and role axis')
  assert.equal(plan.counts.willRemoveWriteScopes, 1)
  assert.equal(plan.counts.operatorMustClearWriteScopes, 2)
  for (const row of plan.operatorMustClearWriteScopes) assert.equal(row.inReconcileRegion, false)

  // And the install agrees with its own rehearsal: exactly that one row goes.
  const v2 = await install(port, packWith('bounds', 2, V2_MOVE))
  assert.deepEqual(v2.removedWriteScopes.map(key), [
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ])
  assert.ok(port.rows.has(`${UNGOVERNED} ${ROLE_PURCHASING}`), 'the ungoverned column survives')
  assert.ok(port.rows.has(`${physical('procurementReply')} ${OTHER_ROLE}`), 'the undeclared role survives')
}

// ---------------------------------------------------------------------------
// RC4. An operator's row inside the rectangle is reported, never retired.
// ---------------------------------------------------------------------------
async function anOperatorRowInsideTheRectangleIsReportedNotRetired() {
  const port = createPort()
  await install(port, packWith('bounds', 1, V1_SPLIT))

  // The operator hardens a pair the pack DOES govern and DOES currently declare.
  const held = `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`
  port.rows.set(held, {
    fieldId: physical('warehouseConfirmation'),
    roleId: ROLE_PURCHASING,
    sheetId: SHEET_ID,
    readOnly: true,
    createdBy: OPERATOR_MARKER,
  })

  // v2 hands that column to purchasing, so the pack no longer declares the denial.
  const V2_MOVE = [
    { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation'] },
    { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseDone'] },
  ]
  const v2 = await install(port, packWith('bounds', 2, V2_MOVE))

  assert.ok(port.rows.has(held), 'the operator\'s decision stands')
  assert.equal(port.rows.get(held).createdBy, OPERATOR_MARKER, 'and was never laundered')
  assert.deepEqual(v2.removedWriteScopes, [], 'nothing of this plugin\'s was there to retire')
  // It is REPORTED, attributed to whoever holds it — never counted as installer debris.
  const heldRows = v2.staleWriteScopes.filter((row) => row.heldBy)
  assert.deepEqual(heldRows, [{
    fieldId: physical('warehouseConfirmation'),
    logicalFieldId: 'warehouseConfirmation',
    roleId: ROLE_PURCHASING,
    packId: null,
    inReconcileRegion: false,
    heldBy: OPERATOR_MARKER,
  }])
}

// ---------------------------------------------------------------------------
// RC5. A host that cannot reconcile is refused, and the rehearsal says so.
// ---------------------------------------------------------------------------
async function aHostThatCannotReconcileIsRefusedNotDegraded() {
  const port = createPort({ supportsReconcile: false })
  assert.equal(port.supportsWriteScopeReconcile, undefined, 'the older host declares nothing')

  const plan = await dryRun(port, packWith('bounds', 1, V1_SPLIT))
  assert.equal(plan.fieldPermissionsPortAvailable, true, 'the port is THERE — it just cannot reconcile')
  assert.equal(plan.fieldPermissionsReconcileSupported, false)
  assert.equal(plan.writeScopeCheck, 'host_port_no_reconcile')
  assert.equal(plan.willRemoveWriteScopes, null, 'no removal is promised that cannot happen')
  assert.equal(plan.canInstall, false)

  const provisioning = createFakeProvisioning()
  let caught = null
  try {
    await install(port, packWith('bounds', 1, V1_SPLIT), undefined, provisioning)
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'the install refuses rather than silently doing nothing')
  assert.equal(caught.status, 501)
  assert.equal(caught.code, 'CUSTOMER_PACK_FIELD_PERMISSION_RECONCILE_UNSUPPORTED')
  assert.equal(port.applyCalls.length, 0, 'the permission port was never reached')
  assert.equal(port.rows.size, 0, 'and no permission row exists')
  // BEFORE THE FIRST SCHEMA WRITE, not merely before the permission call: a refusal that arrives
  // after the columns are created and stamped leaves a half-applied sheet behind, which is the
  // exact failure mode the pre-flight exists to prevent.
  assert.deepEqual(provisioning.writes, [], 'not one host write primitive was called')
  assert.equal(provisioning.fields.size, 0, 'and not one column was created')
}

// The 'unsupported_port' arm of applyFieldWritePolicies is unreachable through installCustomerPack
// (the pre-flight refuses such a host first), which is exactly why it is pinned directly here
// rather than left as an unreachable branch nothing can distinguish from dead code.
async function theUnsupportedPortArmIsPinnedDirectly() {
  const plan = installerInternals.deriveFieldWriteScopePlan({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
      .normalizeCustomerPack(packWith('bounds', 1, V1_SPLIT)),
  })
  const silentPort = {
    supportsWriteScopeReconcile: true,
    async applyRoleWriteScopes({ entries }) { return { applied: entries.length, entries } },
  }
  const result = await installerInternals.applyFieldWritePolicies({
    provisioning: createFakeProvisioning(),
    fieldPermissions: silentPort,
    projectId: PROJECT_ID,
    sheetId: SHEET_ID,
    pack: require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
      .normalizeCustomerPack(packWith('bounds', 1, V1_SPLIT)),
    plan,
  })
  assert.equal(result.reconcile, 'unsupported_port', 'no `removed` array means it never looked')
  assert.equal(result.removed, null, 'NULL, never [] — which would read as "reconciled, nothing to retire"')
}

// ---------------------------------------------------------------------------
// RC7. The RETIRED-denials INFO line is emitted, and names the rows.
// ---------------------------------------------------------------------------
async function theRetiredDenialsAreNamedInTheLog() {
  const port = createPort()
  await install(port, packWith('bounds', 1, V1_SPLIT))
  const lines = []
  const logger = { info: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) }
  await install(port, packWith('bounds', 2, V2_SHARED), logger)

  const retired = lines.find((line) => line.includes('RETIRED'))
  assert.ok(retired, 'a permission that just stopped applying is named at INFO, not folded into a count')
  assert.match(retired, /RETIRED 4 write scope\(s\)/)
  assert.match(retired, /pack=bounds v2/)
  // Values-free: the line carries a count, the pack handle and the rule — never a value or a label.
  assert.doesNotMatch(retired, /采购|仓库/)
}

async function main() {
  await sharedCustodyRevisionRetiresEveryDenial()
  await singleRoleRevisionRetiresEveryDenialItStillGoverns()
  await aPackWithNoPoliciesStillTouchesNothing()
  await aSecondPackIsRefusedNotResolvedByDeletion()
  await aLegacyPackLessRowIsAdoptedNotRefused()
  await theDryRunSplitIsWitnessedOnBothAxes()
  await anOperatorRowInsideTheRectangleIsReportedNotRetired()
  await aHostThatCannotReconcileIsRefusedNotDegraded()
  await theUnsupportedPortArmIsPinnedDirectly()
  await theRetiredDenialsAreNamedInTheLog()
  console.log('stock-preparation-write-scope-reconcile-bounds.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-write-scope-reconcile-bounds.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
