'use strict'

// 备料列级写权限 —— 对账的边界 (#5455, adversarial verification rounds 1-3)
//
// The sibling suite (stock-preparation-department-fields-and-write-scoping) proves the reconcile
// DOES the thing it exists for. This one proves the boundaries it must not cross and the reports it
// must not fake. Every case below is a defect an attack lane actually reproduced on the branch.
//
// THE ONE INVARIANT everything here is a boundary of:
//
//   Inside this pack's rectangle (ownsFieldIds × declared roles, on this sheet), the reconcile may
//   CHANGE only rows that are PROVABLY this pack's:
//     (a) rows carrying THIS pack's marker;
//     (b) pairs THIS pack re-declares, when the existing row is (a), adoptable legacy per (c), or
//         absent;
//     (c) pack-LESS legacy rows ONLY when the install ledger shows this pack is the only pack ever
//         installed on this sheet.
//   Every other row is FOREIGN and is never changed: another pack's marker REFUSES (422
//   PACK_CONFLICT) on a declared pair and is merely reported otherwise; an unattributable legacy row
//   REFUSES (422 LEGACY_UNATTRIBUTED); an operator row is SKIPPED and named.
//
//   RC1  A revision that governs a rectangle but derives ZERO denials (single-role ownership, or
//        total shared custody) must still reconcile. Keying the install on the DERIVED denial count
//        meant the reconcile, the census and the whole write-scope report vanished for exactly the
//        revision the mechanism was built to serve.
//
//   RC2  Two packs on one canonical sheet. `targetObjectId` defaults to that single table and the
//        physical ids are a pure function of (project, object, logical id), so overlapping
//        rectangles are the NORMAL case. Pack B must not delete pack A's enforced denials; it must
//        REFUSE, before the first schema write, with a coded 422 naming the other pack. And a pack
//        whose rectangle is DISJOINT must install cleanly — the negative control that pins the
//        rectangle conjunct (round-2 finding 5).
//
//   RC2L THE P0. A pack-less LEGACY row is not "nobody's": before #5455 the marker carried no pack
//        id at all, so every row every pack ever wrote looks like that. Adoption therefore requires
//        PROOF from the install ledger, and without it the install refuses (round-2 finding 1).
//
//   RC3  The dry-run's "about to be fixed" vs "a human must clear this" split must be witnessed on
//        BOTH axes, and it must promise NOTHING on any path where the install refuses (round-2
//        finding 10).
//
//   RC4  An operator's row inside the rectangle is never retired, never claimed, never OVERWRITTEN,
//        and is reported — in both real shapes: the `operator:` marker and `created_by` NULL, which
//        is what the authoring route wrote before this change (round-2 findings 3, 9, 14, 15, 16).
//
//   RC5  A host port that cannot honour a region is refused, not silently degraded, and the dry-run
//        says so instead of promising removals that will never happen.
//
//   RC6  A sibling pack's live rows are NOT stale and are never on the operator's to-do list
//        (round-2 finding 2).
//
//   RC7  The RETIRED-denials INFO line — the code's stated answer to "a permission that just
//        stopped applying must be named, not folded into a count" — is emitted by something, and it
//        no longer claims more than the port can deliver.
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
const { normalizeCustomerPack } = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  BASE_MARKER,
  OPERATOR_ROUTE_MARKER,
  markerFor,
  createWriteScopePort,
  packRow,
  legacyRow,
  operatorRow,
  seedRows,
  keyOf,
} = require(path.join(__dirname, 'support', 'stock-preparation-write-scope-port.cjs'))

const TENANT_ID = 'tenant_bounds'
const PROJECT_ID = 'proj_bounds'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const SHEET_ID = 'sheet_bounds'
const ROLE_PURCHASING = 'plugin-integration-core:bom-prep:purchasing'
const ROLE_WAREHOUSE = 'plugin-integration-core:bom-prep:warehouse'

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
 * THE INSTALL LEDGER, which is where `legacyAdoptable` gets its proof. `packIds` is the set of packs
 * that have EVER landed on this (project, object) — the same question the real store answers from
 * `integration_stock_prep_pack_installs`.
 */
function createLedger(packIds = []) {
  const seen = new Set(packIds)
  return {
    seen,
    async listInstalledPackIds() { return { packIds: [...seen].sort() } },
    async recordInstall(row) {
      seen.add(row.packId)
      return { status: 'installed', mode: row.mode, packId: row.packId, packVersion: row.packVersion, objectId: row.objectId, installedFields: row.installedFields || [] }
    },
  }
}

const packWith = (packId, packVersion, policies) => ({
  packId,
  packVersion,
  extensionFields: [],
  fieldWritePolicies: policies.map((policy) => ({ ...policy })),
})

const install = (port, pack, { logger, provisioning, ledger } = {}) => installCustomerPack({
  provisioning: provisioning || createFakeProvisioning(),
  projectId: PROJECT_ID,
  pack,
  logger: logger || { info() {}, warn() {} },
  fieldPermissions: port,
  packInstallStore: ledger || null,
  tenantId: ledger ? TENANT_ID : undefined,
})

const dryRun = (port, pack, { ledger } = {}) => planCustomerPackInstall({
  provisioning: createFakeProvisioning(),
  projectId: PROJECT_ID,
  pack,
  fieldPermissions: port,
  packInstallStore: ledger || null,
  tenantId: ledger ? TENANT_ID : undefined,
})

const rowKeys = (port) => [...port.rows.keys()].sort()
const key = (row) => `${row.fieldId} ${row.roleId}`

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
  const port = createWriteScopePort()
  const ledger = createLedger()
  const v1 = await install(port, packWith('bounds', 1, V1_SPLIT), { ledger })
  assert.equal(v1.appliedWriteScopes, 4, 'v1 denies each role the other role\'s two columns')
  assert.deepEqual(rowKeys(port), [
    `${physical('procurementDone')} ${ROLE_WAREHOUSE}`,
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
    `${physical('warehouseDone')} ${ROLE_PURCHASING}`,
  ])

  // THE DRY RUN must rehearse this, not go silent because the denial count is zero.
  const plan = await dryRun(port, packWith('bounds', 2, V2_SHARED), { ledger })
  assert.equal(plan.writeScopeCheck, 'checked', 'a governed rectangle is always classified')
  assert.equal(plan.counts.fieldWriteDenials, 0, 'shared custody derives no denial — that is the point')
  assert.equal(plan.counts.willRemoveWriteScopes, 4, 'and all four v1 denials are about to be retired')
  assert.deepEqual(plan.operatorMustClearWriteScopes, [], 'none of them needs a human')
  assert.equal(plan.canInstall, true)

  // THE INSTALL must actually issue the delete.
  const v2 = await install(port, packWith('bounds', 2, V2_SHARED), { ledger })
  assert.equal(v2.writeScopeReconcile, 'reconciled')
  assert.equal(v2.removedWriteScopeCount, 4)
  assert.deepEqual(rowKeys(port), [], 'the rectangle now holds no denial at all')
  assert.equal(v2.writeScopeCheck, 'checked')
  assert.deepEqual(v2.operatorMustClearWriteScopes, [], 'and nothing is left for an operator')
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
  const port = createWriteScopePort()
  const ledger = createLedger()
  await install(port, packWith('bounds', 1, V1_SPLIT), { ledger })
  const v2 = await install(port, packWith('bounds', 2, V2_SINGLE), { ledger })
  assert.equal(v2.writeScopeReconcile, 'reconciled')
  assert.deepEqual(v2.removedWriteScopes, [
    { fieldId: physical('warehouseConfirmation'), roleId: ROLE_PURCHASING },
    { fieldId: physical('warehouseDone'), roleId: ROLE_PURCHASING },
  ], 'the two in-rectangle denials go')
  assert.deepEqual(rowKeys(port), [
    `${physical('procurementDone')} ${ROLE_WAREHOUSE}`,
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
  ], 'the dropped role\'s rows survive — the pack no longer governs that role')
  // They are THIS pack's own rows, outside the rectangle: exactly what an operator must clear.
  assert.equal(v2.operatorMustClearWriteScopeCount, 2)
  assert.deepEqual(v2.operatorMustClearWriteScopes.map(key).sort(), [
    `${physical('procurementDone')} ${ROLE_WAREHOUSE}`,
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
  ].sort())
}

async function aPackWithNoPoliciesStillTouchesNothing() {
  // The other side of the same gate: no declaration at all means no region, no call, no delete.
  const port = createWriteScopePort()
  const summary = await install(port, { packId: 'bounds', packVersion: 1, extensionFields: [] })
  assert.equal(port.applyCalls.length, 0, 'the port is never called')
  assert.equal(port.classifyCalls.length, 0, 'and never classified either')
  assert.equal(summary.writeScopeReconcile, 'not_declared')
  assert.equal(summary.removedWriteScopes, null)
  assert.equal(summary.writeScopeCheck, 'not_declared')
  assert.equal(summary.operatorMustClearWriteScopes, null)
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
// Pack B claims authority over the SAME two columns for the SAME two roles, and therefore DERIVES
// the same two denials pack A already enforces. That — an overlap on a pair BOTH packs DECLARE — is
// the conflict, and it is the only one: a sibling pack merely holding a row inside this rectangle on
// a pair this pack does NOT declare is a live, correctly owned denial that coexists (see
// `aSiblingPacksLiveRowsAreNeverOnTheOperatorsList`). Refusing on mere rectangle overlap would brick
// every legitimate second pack on the canonical table (round-2 finding 5).
const PACK_B_POLICIES = [
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation'] },
]

async function aSecondPackIsRefusedNotResolvedByDeletion() {
  const port = createWriteScopePort()
  const ledger = createLedger()
  const a = await install(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger })
  assert.equal(a.appliedWriteScopes, 2)
  const afterA = rowKeys(port)
  assert.deepEqual(afterA, [
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ])
  // Every one of pack A's rows carries pack A's marker — that is what makes it attributable.
  for (const row of port.rows.values()) assert.equal(row.createdBy, markerFor('pack-alpha'))

  // THE DRY RUN names the conflict and refuses to say canInstall.
  const plan = await dryRun(port, packWith('pack-beta', 1, PACK_B_POLICIES), { ledger })
  assert.equal(plan.writeScopeCheck, 'pack_conflict')
  assert.equal(plan.canInstall, false, 'a deployer is told BEFORE they try')
  assert.deepEqual(plan.packConflictWriteScopes.map(key), [
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ])
  for (const row of plan.packConflictWriteScopes) assert.equal(row.packId, 'pack-alpha')
  assert.equal(plan.counts.packConflictWriteScopes, 2)
  // ═══ THE REHEARSAL PROMISES NOTHING ON A REFUSING PATH. ═══
  // `willRemoveWriteScopes` says "this install will retire these rows"; on a path where the install
  // REFUSES, no install runs and nothing is retired. Reporting `[]` would be a promise about an
  // install that never happens, and reporting rows would be worse (round-2 finding 10). NULL is the
  // only honest answer, and it is gated on the dry-run's OWN verdict.
  assert.equal(plan.willRemoveWriteScopes, null, 'a refused install retires nothing, and says so')
  assert.equal(plan.operatorMustClearWriteScopes, null, 'and hands out no to-do list either')
  assert.equal(plan.counts.willRemoveWriteScopes, 0)

  // THE INSTALL refuses with a coded 422 that names the other pack, over an UNTOUCHED sheet.
  // A pack that WOULD create a column, so "before the first schema write" is observable rather than
  // an ordering the reader takes on trust (round-2 finding 7).
  const packBThatCreatesAColumn = {
    ...packWith('pack-beta', 1, PACK_B_POLICIES),
    extensionFields: [{ id: 'ext_betaProbe', label: '冲突探针', type: 'string', ownership: 'human_preserved' }],
  }
  const provisioning = createFakeProvisioning()
  let caught = null
  try {
    await install(port, packBThatCreatesAColumn, { provisioning, ledger })
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
  assert.deepEqual(provisioning.writes, [], 'not one host write primitive was called')
  assert.equal(provisioning.fields.size, 0, 'and not one column was created')

  // …and pack A can still reconcile its OWN rows afterwards.
  const a2 = await install(port, packWith('pack-alpha', 2, [
    { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'warehouseConfirmation'] },
    { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['procurementReply', 'warehouseConfirmation'] },
  ]), { ledger })
  assert.equal(a2.writeScopeReconcile, 'reconciled')
  assert.equal(a2.removedWriteScopeCount, 2)
  assert.deepEqual(rowKeys(port), [])
}

/**
 * THE NEGATIVE CONTROL FOR THE RECTANGLE CONJUNCT (round-2 finding 5).
 *
 * The conflict refusal is `another pack's marker AND inside my rectangle`. With only the positive
 * case witnessed, DROPPING the rectangle conjunct — refusing on any sibling row anywhere on the
 * sheet — left the whole battery green while bricking every legitimate second pack on the canonical
 * table. A pack whose columns AND role are disjoint from pack A's must install cleanly.
 */
async function aDisjointSiblingPackInstallsCleanly() {
  const port = createWriteScopePort()
  const ledger = createLedger()
  await install(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger })
  const before = rowKeys(port)
  assert.equal(before.length, 2)

  const ROLE_QUALITY = 'plugin-integration-core:bom-prep:quality'
  const ROLE_FINANCE = 'plugin-integration-core:bom-prep:finance'
  // DISJOINT ON BOTH AXES: different columns AND two roles pack A never declares.
  const PACK_C_POLICIES = [
    { roleId: ROLE_QUALITY, ownsFieldIds: ['procurementDone'] },
    { roleId: ROLE_FINANCE, ownsFieldIds: ['warehouseDone'] },
  ]
  const plan = await dryRun(port, packWith('pack-gamma', 1, PACK_C_POLICIES), { ledger })
  assert.deepEqual(plan.packConflictWriteScopes, [], 'a disjoint rectangle is not a conflict')
  assert.equal(plan.writeScopeCheck, 'checked')
  assert.equal(plan.canInstall, true, 'a legitimate sibling pack must not be bricked')

  const c = await install(port, packWith('pack-gamma', 1, PACK_C_POLICIES), { ledger })
  assert.equal(c.appliedWriteScopes, 2)
  assert.deepEqual(c.removedWriteScopes, [], 'and it retires none of pack A\'s rows')
  for (const existing of before) assert.ok(port.rows.has(existing), 'pack A is untouched')
  // And pack A's rows are not visible to pack gamma as anything at all: they are outside its
  // rectangle on both axes, so they are neither stale, nor conflicting, nor governed-by-other.
  assert.deepEqual(c.governedByOtherPacks, [])
  assert.deepEqual(c.operatorMustClearWriteScopes, [])
}

/**
 * RC6 (round-2 finding 2). A sibling pack's rows INSIDE this pack's rectangle, on pairs this pack
 * does not declare, are live and correctly owned. They are not stale, they are not this install's
 * debris, and the operator must not be told to delete them.
 */
async function aSiblingPacksLiveRowsAreNeverOnTheOperatorsList() {
  const ledger = createLedger(['pack-alpha', 'pack-beta'])
  const port = createWriteScopePort({
    rows: seedRows(
      // Pack beta denies a pair pack alpha GOVERNS (the column is in alpha's rectangle, the role is
      // one alpha declares) but does NOT declare — alpha's own policy gives that role the column.
      packRow(SHEET_ID, physical('procurementReply'), ROLE_PURCHASING, 'pack-beta'),
    ),
  })
  const pack = packWith('pack-alpha', 1, PACK_A_POLICIES)
  const plan = await dryRun(port, pack, { ledger })
  assert.deepEqual(plan.packConflictWriteScopes, [], 'not a conflict — alpha does not declare that pair')
  assert.equal(plan.canInstall, true)
  assert.deepEqual(plan.governedByOtherPacks.map(key), [
    `${physical('procurementReply')} ${ROLE_PURCHASING}`,
  ], 'it is named as somebody else\'s, in its own projection')
  assert.deepEqual(plan.operatorMustClearWriteScopes, [], 'and NEVER on the human\'s to-do list')
  assert.deepEqual(plan.willRemoveWriteScopes, [], 'nor promised as a retirement')

  const summary = await install(port, pack, { ledger })
  assert.deepEqual(summary.removedWriteScopes, [], 'the install retires none of it')
  assert.ok(port.rows.has(`${physical('procurementReply')} ${ROLE_PURCHASING}`), 'beta\'s row stands')
  assert.equal(
    port.rows.get(`${physical('procurementReply')} ${ROLE_PURCHASING}`).createdBy,
    markerFor('pack-beta'),
    'and keeps its own provenance',
  )
  assert.deepEqual(summary.governedByOtherPacks.map(key), [
    `${physical('procurementReply')} ${ROLE_PURCHASING}`,
  ])
  assert.deepEqual(summary.operatorMustClearWriteScopes, [])
  assert.equal(summary.operatorMustClearWriteScopeCount, 0)
}

// ---------------------------------------------------------------------------
// RC2L. THE P0 — a pack-less LEGACY row is not "nobody's".
// ---------------------------------------------------------------------------
async function aLegacyPackLessRowIsRefusedWithoutProof() {
  // The shape of EVERY host in the field before this change: rows written by the plugin, carrying
  // the bare marker, with nothing in them that says which pack. The previous revision adopted them
  // unconditionally — so on a sheet two packs share, pack B retired pack A's live denials and
  // reported them as its own history.
  const port = createWriteScopePort({
    rows: seedRows(legacyRow(SHEET_ID, physical('procurementReply'), ROLE_WAREHOUSE)),
  })
  // A ledger showing TWO packs: the bare row could belong to either, so it cannot be attributed.
  const ambiguous = createLedger(['pack-alpha', 'pack-beta'])

  const plan = await dryRun(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger: ambiguous })
  assert.equal(plan.writeScopeCheck, 'legacy_unattributed')
  assert.equal(plan.canInstall, false, 'a guess with another pack\'s denials at stake is not an install')
  assert.deepEqual(plan.legacyUnattributedWriteScopes.map(key), [
    `${physical('procurementReply')} ${ROLE_WAREHOUSE}`,
  ])
  assert.equal(plan.legacyAdoption.allowed, false)
  assert.equal(plan.legacyAdoption.basis, 'multiple_packs')
  assert.equal(plan.willRemoveWriteScopes, null, 'and no retirement is promised on a refusing path')

  let caught = null
  const provisioning = createFakeProvisioning()
  try {
    await install(port, {
      ...packWith('pack-alpha', 1, PACK_A_POLICIES),
      extensionFields: [{ id: 'ext_legacyProbe', label: '遗留探针', type: 'string', ownership: 'human_preserved' }],
    }, { provisioning, ledger: ambiguous })
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'the install refuses rather than guessing')
  assert.equal(caught.status, 422)
  assert.equal(caught.code, 'CUSTOMER_PACK_FIELD_WRITE_SCOPE_LEGACY_UNATTRIBUTED')
  assert.equal(caught.details.conflicts.length, 1)
  assert.equal(port.applyCalls.length, 0, 'the write port was never reached')
  assert.deepEqual(provisioning.writes, [], 'and refused BEFORE the first schema write')
  assert.equal(port.rows.get(`${physical('procurementReply')} ${ROLE_WAREHOUSE}`).createdBy, BASE_MARKER)
}

async function aLegacyPackLessRowIsAdoptedOnceTheLedgerProvesSoleOwnership() {
  const port = createWriteScopePort({
    rows: seedRows(legacyRow(SHEET_ID, physical('procurementReply'), ROLE_WAREHOUSE)),
  })
  // ONE pack has ever landed here, and it is this one. Now the row can have no other owner.
  const sole = createLedger(['pack-alpha'])

  const plan = await dryRun(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger: sole })
  assert.equal(plan.writeScopeCheck, 'checked')
  assert.equal(plan.canInstall, true)
  assert.equal(plan.legacyAdoption.allowed, true)
  assert.equal(plan.legacyAdoption.basis, 'sole_pack')
  assert.deepEqual(plan.legacyUnattributedWriteScopes, [])

  const summary = await install(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger: sole })
  assert.equal(summary.writeScopeReconcile, 'reconciled')
  assert.equal(summary.legacyAdoption.basis, 'sole_pack')
  // It is RE-DECLARED by this pack, so it is upserted and ADOPTED rather than retired.
  assert.equal(
    port.rows.get(`${physical('procurementReply')} ${ROLE_WAREHOUSE}`).createdBy,
    markerFor('pack-alpha'),
  )
}

async function noLedgerAtAllMeansNoAdoption() {
  // A caller that supplies no store cannot prove anything, so the fail-closed default applies. The
  // basis is REPORTED rather than swallowed, because "run the backfill" and "another pack lives
  // here" are different instructions to a deployer.
  const port = createWriteScopePort({
    rows: seedRows(legacyRow(SHEET_ID, physical('procurementReply'), ROLE_WAREHOUSE)),
  })
  const plan = await dryRun(port, packWith('pack-alpha', 1, PACK_A_POLICIES))
  assert.equal(plan.legacyAdoption.allowed, false)
  assert.equal(plan.legacyAdoption.basis, 'no_ledger')
  assert.equal(plan.legacyAdoption.ledgerPackIds, null)
  assert.equal(plan.writeScopeCheck, 'legacy_unattributed')
  assert.equal(plan.canInstall, false)

  // A ledger that has never recorded an install here is a different basis with the same verdict.
  const empty = createLedger([])
  const plan2 = await dryRun(port, packWith('pack-alpha', 1, PACK_A_POLICIES), { ledger: empty })
  assert.equal(plan2.legacyAdoption.basis, 'no_install_recorded')
  assert.deepEqual(plan2.legacyAdoption.ledgerPackIds, [])
  assert.equal(plan2.canInstall, false)
}

// ---------------------------------------------------------------------------
// RC3. The dry-run split is witnessed on BOTH axes.
// ---------------------------------------------------------------------------
async function theDryRunSplitIsWitnessedOnBothAxes() {
  const port = createWriteScopePort()
  const ledger = createLedger()
  await install(port, packWith('bounds', 1, V1_SPLIT), { ledger })

  // (a) OUT OF REGION ON THE COLUMN AXIS: a column no policy of this pack names.
  const UNGOVERNED = physical('actualArrivalDate')
  port.rows.set(`${UNGOVERNED} ${ROLE_PURCHASING}`, packRow(SHEET_ID, UNGOVERNED, ROLE_PURCHASING, 'bounds'))
  // (b) OUT OF REGION ON THE ROLE AXIS: a role this pack does not declare.
  const OTHER_ROLE = 'plugin-integration-core:bom-prep:quality'
  port.rows.set(
    `${physical('procurementReply')} ${OTHER_ROLE}`,
    packRow(SHEET_ID, physical('procurementReply'), OTHER_ROLE, 'bounds'),
  )

  // v2 moves one column between the two declared roles, so exactly ONE in-region orphan appears.
  const V2_MOVE = [
    { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation'] },
    { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseDone'] },
  ]
  const plan = await dryRun(port, packWith('bounds', 2, V2_MOVE), { ledger })

  assert.deepEqual(plan.willRemoveWriteScopes.map(key), [
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ], 'only the in-region orphan is promised')
  assert.deepEqual(plan.operatorMustClearWriteScopes.map(key).sort(), [
    `${UNGOVERNED} ${ROLE_PURCHASING}`,
    `${physical('procurementReply')} ${OTHER_ROLE}`,
  ].sort(), 'BOTH out-of-region rows land on the human\'s list — column axis and role axis')
  assert.equal(plan.counts.willRemoveWriteScopes, 1)
  assert.equal(plan.counts.operatorMustClearWriteScopes, 2)
  // Reported in the pack's OWN vocabulary as well as the platform's.
  const ungoverned = plan.operatorMustClearWriteScopes.find((row) => row.fieldId === UNGOVERNED)
  assert.equal(ungoverned.logicalFieldId, 'actualArrivalDate')

  // And the install agrees with its own rehearsal: exactly that one row goes.
  const v2 = await install(port, packWith('bounds', 2, V2_MOVE), { ledger })
  assert.deepEqual(v2.removedWriteScopes.map(key), [
    `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`,
  ])
  assert.deepEqual(v2.operatorMustClearWriteScopes.map(key).sort(), [
    `${UNGOVERNED} ${ROLE_PURCHASING}`,
    `${physical('procurementReply')} ${OTHER_ROLE}`,
  ].sort(), 'the install reports the same two rows the rehearsal named')
  assert.ok(port.rows.has(`${UNGOVERNED} ${ROLE_PURCHASING}`), 'the ungoverned column survives')
  assert.ok(port.rows.has(`${physical('procurementReply')} ${OTHER_ROLE}`), 'the undeclared role survives')
}

// ---------------------------------------------------------------------------
// RC4. An operator's row is reported, never retired, and NEVER OVERWRITTEN.
// ---------------------------------------------------------------------------

/**
 * The pair the pack no longer declares. This is the case the previous revision got right (the row
 * simply fails the DELETE's provenance predicate) — kept, and now run in BOTH real created_by
 * shapes, because the previous fixtures only ever used a marker string the authoring route never
 * wrote (round-2 findings 14 and 16).
 */
async function anOperatorRowInsideTheRectangleIsReportedNotRetired() {
  for (const createdBy of [OPERATOR_ROUTE_MARKER, null]) {
    const port = createWriteScopePort()
    const ledger = createLedger()
    await install(port, packWith('bounds', 1, V1_SPLIT), { ledger })

    // The operator hardens a pair the pack governs but v2 will no longer declare.
    const held = `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`
    port.rows.set(held, operatorRow(SHEET_ID, physical('warehouseConfirmation'), ROLE_PURCHASING, { createdBy }))

    const V2_MOVE = [
      { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'warehouseConfirmation'] },
      { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseDone'] },
    ]
    const v2 = await install(port, packWith('bounds', 2, V2_MOVE), { ledger })

    assert.ok(port.rows.has(held), `the operator's decision stands (created_by=${createdBy})`)
    assert.equal(port.rows.get(held).createdBy, createdBy, 'and was never laundered')
    assert.deepEqual(v2.removedWriteScopes, [], 'nothing of this plugin\'s was there to retire')
    // NOT on the operator-must-clear list: that list is THIS pack's own out-of-region debris. A row
    // a human authored is not debris and there is nothing for them to be told about it.
    assert.deepEqual(v2.operatorMustClearWriteScopes, [])
  }
}

/**
 * ═══ THE CASE THE PREVIOUS REVISION SILENTLY BROKE (round-2 findings 3, 9, 15). ═══
 *
 * An operator row on a pair the pack DOES declare. The upsert used to rewrite it unconditionally:
 * `visible = true` un-hid a column the operator had HIDDEN, `read_only = true` imposed a denial on a
 * row the reconcile could then never retire, and the dry-run said nothing about either. Now the
 * classification sees the row, the port SKIPS the pair entirely, and both the rehearsal and the
 * install name it.
 */
async function anOperatorRowOnADeclaredPairIsSkippedNotOverwritten() {
  for (const createdBy of [OPERATOR_ROUTE_MARKER, null]) {
    const port = createWriteScopePort()
    const ledger = createLedger()
    // The operator has HIDDEN this column for purchasing and left it writable — a read decision this
    // port is structurally incapable of making, and therefore one it must never undo.
    const heldKey = `${physical('warehouseConfirmation')} ${ROLE_PURCHASING}`
    port.rows.set(heldKey, operatorRow(SHEET_ID, physical('warehouseConfirmation'), ROLE_PURCHASING, {
      createdBy, visible: false, readOnly: false,
    }))

    // V1_SPLIT declares exactly that denial (warehouse owns the column, so purchasing is denied).
    const pack = packWith('bounds', 1, V1_SPLIT)
    const plan = await dryRun(port, pack, { ledger })
    assert.equal(plan.canInstall, true, 'an operator-held pair is not a blocker — it is a deferral')
    assert.deepEqual(plan.operatorHeldInRegion.map(key), [heldKey], 'the rehearsal names it BEFORE the fact')
    const previewed = plan.operatorHeldInRegion[0]
    assert.equal(previewed.declared, true, 'and says the install WOULD have written this pair')
    assert.equal(previewed.visible, false, 'and WHAT the human decided — the column is hidden')
    assert.equal(previewed.readOnly, false)
    assert.equal(previewed.heldBy, createdBy)
    assert.equal(plan.counts.operatorHeldInRegion, 1)

    const summary = await install(port, pack, { ledger })
    const after = port.rows.get(heldKey)
    assert.equal(after.visible, false, 'the operator\'s HIDE survives the install')
    assert.equal(after.readOnly, false, 'and so does their write decision')
    assert.equal(after.createdBy, createdBy, 'and their provenance')
    assert.deepEqual(summary.operatorHeldWriteScopes.map(key), [heldKey], 'the install names the deferral')
    assert.equal(summary.operatorHeldWriteScopeCount, 1)
    // `applied` counts rows WRITTEN, and the skipped pair is not one of them: V1_SPLIT derives four
    // denials, one of which the operator holds.
    assert.equal(summary.appliedWriteScopes, 3, 'the skipped pair is not counted as applied')
  }
}

// ---------------------------------------------------------------------------
// RC5. A host that cannot reconcile is refused, and the rehearsal says so.
// ---------------------------------------------------------------------------
async function aHostThatCannotReconcileIsRefusedNotDegraded() {
  const port = createWriteScopePort({ supportsReconcile: false })
  assert.equal(port.supportsWriteScopeReconcile, undefined, 'the older host declares nothing')

  const plan = await dryRun(port, packWith('bounds', 1, V1_SPLIT))
  assert.equal(plan.fieldPermissionsPortAvailable, true, 'the port is THERE — it just cannot reconcile')
  assert.equal(plan.fieldPermissionsReconcileSupported, false)
  assert.equal(plan.writeScopeCheck, 'host_port_no_reconcile')
  assert.equal(plan.willRemoveWriteScopes, null, 'no removal is promised that cannot happen')
  assert.equal(plan.canInstall, false)

  // A pack that WOULD create a column, so "refused before the first schema write" is observable:
  // with the pre-flight gone the refusal still happens, but only after this column exists.
  const packThatCreatesAColumn = {
    ...packWith('bounds', 1, V1_SPLIT),
    extensionFields: [{ id: 'ext_boundsProbe', label: '边界探针', type: 'string', ownership: 'human_preserved' }],
  }
  const provisioning = createFakeProvisioning()
  let caught = null
  try {
    await install(port, packThatCreatesAColumn, { provisioning })
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

// A host whose port has no CLASSIFIER at all: the installer must say so rather than report empty
// lists that would read as "classified, nothing found".
async function aHostWithoutAClassifierSaysSoRatherThanReportingNothing() {
  const port = createWriteScopePort({ withClassify: false })
  const plan = await dryRun(port, packWith('bounds', 1, V1_SPLIT))
  assert.equal(plan.writeScopeCheck, 'unsupported_port')
  assert.equal(plan.willRemoveWriteScopes, null, 'NULL, never [] — absence of a check is not absence of rows')
  assert.equal(plan.operatorMustClearWriteScopes, null)
  assert.equal(plan.operatorHeldInRegion, null)
  assert.equal(plan.governedByOtherPacks, null)
  assert.equal(plan.packConflictWriteScopes, null)
}

// The pre-flight's FIELD axis (round-2 finding 19): a column the pack governs but does not create,
// and that the sheet does not have, is refused BEFORE any schema write rather than by the port at
// the very end of the install.
async function anUnknownGovernedColumnIsRefusedBeforeAnySchemaWrite() {
  const governed = ['procurementReply', 'procurementDone', 'warehouseConfirmation', 'warehouseDone']
  const port = createWriteScopePort({
    // Every governed column exists EXCEPT one — and it is not one the pack creates.
    knownFieldIds: governed.filter((id) => id !== 'warehouseDone').map(physical),
  })
  const provisioning = createFakeProvisioning()
  let caught = null
  try {
    await install(port, {
      ...packWith('bounds', 1, V1_SPLIT),
      extensionFields: [{ id: 'ext_fieldProbe', label: '列探针', type: 'string', ownership: 'human_preserved' }],
    }, { provisioning })
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'a governed column the host does not have must refuse')
  assert.equal(caught.status, 422)
  assert.equal(caught.code, 'CUSTOMER_PACK_FIELD_PERMISSION_FIELD_UNKNOWN')
  assert.deepEqual(caught.details.fieldIds, [physical('warehouseDone')])
  assert.deepEqual(provisioning.writes, [], 'refused before the first schema write')
  assert.equal(port.applyCalls.length, 0)

  // …and the dry-run reports the same blocker rather than throwing.
  const plan = await dryRun(port, packWith('bounds', 1, V1_SPLIT))
  assert.deepEqual(plan.unknownFieldIds, [physical('warehouseDone')])
  assert.equal(plan.canInstall, false)
}

// The 'unsupported_port' arm of applyFieldWritePolicies is unreachable through installCustomerPack
// (the pre-flight refuses such a host first), which is exactly why it is pinned directly here
// rather than left as an unreachable branch nothing can distinguish from dead code.
async function theUnsupportedPortArmIsPinnedDirectly() {
  const normalized = normalizeCustomerPack(packWith('bounds', 1, V1_SPLIT))
  const plan = installerInternals.deriveFieldWriteScopePlan({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: normalized,
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
    pack: normalized,
    plan,
  })
  assert.equal(result.reconcile, 'unsupported_port', 'no `removed` array means it never looked')
  assert.equal(result.removed, null, 'NULL, never [] — which would read as "reconciled, nothing to retire"')
  assert.equal(result.operatorHeld, null, 'and the same for every other classification projection')
  assert.equal(result.governedByOtherPacks, null)
}

// ---------------------------------------------------------------------------
// RC7. The RETIRED-denials INFO line is emitted, and claims only what is true.
// ---------------------------------------------------------------------------
async function theRetiredDenialsAreNamedInTheLog() {
  const port = createWriteScopePort()
  const ledger = createLedger()
  await install(port, packWith('bounds', 1, V1_SPLIT), { ledger })
  const lines = []
  const logger = { info: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) }
  await install(port, packWith('bounds', 2, V2_SHARED), { logger, ledger })

  const retired = lines.find((line) => line.includes('RETIRED'))
  assert.ok(retired, 'a permission that just stopped applying is named at INFO, not folded into a count')
  assert.match(retired, /RETIRED 4 write scope\(s\)/)
  assert.match(retired, /pack=bounds v2/)
  // ═══ THE SENTENCE CLAIMS ONLY WHAT THE PORT CAN DELIVER (round-2 findings 12 and 17). ═══
  // "operator-authored rows are never touched" was false: an operator decision applied on top of a
  // pack row kept the PACK's marker until the authoring route started stamping, so the log asserted
  // a guarantee the data could not carry. The residue is now NAMED instead.
  assert.doesNotMatch(retired, /operator-authored rows are never touched/)
  assert.match(retired, /may\s+still carry this pack's marker/)
  // Values-free: the line carries a count, the pack handle and the rule — never a value or a label.
  assert.doesNotMatch(retired, /采购|仓库/)
}

async function theOperatorDeferralAndSiblingPackLinesAreDistinct() {
  const ledger = createLedger(['bounds', 'pack-beta'])
  const port = createWriteScopePort({
    rows: seedRows(
      // A human holds a pair this pack declares…
      operatorRow(SHEET_ID, physical('warehouseConfirmation'), ROLE_PURCHASING),
      // …and a sibling pack holds one it merely governs.
      packRow(SHEET_ID, physical('procurementReply'), ROLE_PURCHASING, 'pack-beta'),
    ),
  })
  const lines = []
  const logger = { info: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) }
  await install(port, packWith('bounds', 1, V1_SPLIT), { logger, ledger })

  const deferred = lines.find((line) => line.includes('DEFERRED'))
  assert.ok(deferred, 'a pair the install did NOT write because a human owns it must be named')
  assert.match(deferred, /DEFERRED to an operator on 1 declared \(column, role\) pair\(s\)/)

  const shared = lines.find((line) => line.includes('shares this sheet'))
  assert.ok(shared, 'a sibling pack\'s rows are reported…')
  assert.match(shared, /pack-beta/)
  assert.match(shared, /Nothing to do\./)
  // …and NEVER under a sentence telling the operator to delete them (round-2 finding 2).
  assert.doesNotMatch(shared, /Clear them with/)
  assert.doesNotMatch(shared, /STALE/)
  const stale = lines.find((line) => line.includes('STALE'))
  assert.equal(stale, undefined, 'there is no stale row here at all — only somebody else\'s')
}

async function main() {
  await sharedCustodyRevisionRetiresEveryDenial()
  await singleRoleRevisionRetiresEveryDenialItStillGoverns()
  await aPackWithNoPoliciesStillTouchesNothing()
  await aSecondPackIsRefusedNotResolvedByDeletion()
  await aDisjointSiblingPackInstallsCleanly()
  await aSiblingPacksLiveRowsAreNeverOnTheOperatorsList()
  await aLegacyPackLessRowIsRefusedWithoutProof()
  await aLegacyPackLessRowIsAdoptedOnceTheLedgerProvesSoleOwnership()
  await noLedgerAtAllMeansNoAdoption()
  await theDryRunSplitIsWitnessedOnBothAxes()
  await anOperatorRowInsideTheRectangleIsReportedNotRetired()
  await anOperatorRowOnADeclaredPairIsSkippedNotOverwritten()
  await aHostThatCannotReconcileIsRefusedNotDegraded()
  await aHostWithoutAClassifierSaysSoRatherThanReportingNothing()
  await anUnknownGovernedColumnIsRefusedBeforeAnySchemaWrite()
  await theUnsupportedPortArmIsPinnedDirectly()
  await theRetiredDenialsAreNamedInTheLog()
  await theOperatorDeferralAndSiblingPackLinesAreDistinct()
  console.log('stock-preparation-write-scope-reconcile-bounds.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-write-scope-reconcile-bounds.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
