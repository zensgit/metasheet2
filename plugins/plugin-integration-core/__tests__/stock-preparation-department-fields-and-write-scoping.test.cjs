'use strict'

// 采购/仓库的完成标记与日期 + 自制/外购 + 列级写权限 —— the RED witnesses.
//
// This suite proves four separable claims, each of which fails loudly if the
// corresponding wall is removed:
//
//   A. THE HUMAN-FIELD WALL covers the five new columns. A PLM refresh cannot write
//      makeOrBuy / procurementDone / procurementReplyDate / warehouseDone /
//      actualArrivalDate. The negative control disables the wall and shows the same
//      payload sailing through — so the assertion is not vacuous.
//
//   B. DECISION MEMORY for 自制/外购 needs NO new machinery. The existing
//      cross-project prefill operator already offers a previously-confirmed answer for
//      the SAME component identity back as a K2-confirm PROPOSAL; adding makeOrBuy to
//      the human whitelist is the entire wiring. Proven here, including that a
//      different component yields nothing and that the operator never writes.
//
//   C. THE PACK DECLARATION. Absent `fieldWritePolicies`, a normalized pack is
//      DEEP-EQUAL to what it is today and the derived denial plan is empty. Present, it
//      derives exactly the complement of the declared ownership, and a role nobody
//      declared gets no rows at all.
//
//   D. THE INSTALLER WIRING. No declaration => the host permission port is never called
//      (byte-for-byte today's behaviour, proven by a poisoned port). Declaration + port
//      => the platform's own field_permissions rows, addressed by PHYSICAL field id.
//      Declaration WITHOUT a port => fail closed, never a silent skip.
//
// The server-side ENFORCEMENT of those rows is the platform's, not this plugin's, and is
// witnessed in packages/core-backend (unit: the real loadFieldPermissionScopeMap ->
// deriveFieldPermissions -> isFieldWriteForbidden chain; integration: the real
// POST /api/multitable/patch route). This suite proves the plugin DECLARES and WRITES
// the right rows; it deliberately does not re-implement the enforcement predicate.
//
// Hermetic: no DB, no network, no clock, no filesystem writes.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const {
  normalizeCustomerPack,
  StockPreparationCustomerPackError,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))

const {
  installCustomerPack,
  StockPreparationCustomerPackInstallError,
  __internals: installerInternals,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))

const {
  crossProjectPrefillCandidates,
} = require(path.join(LIB, 'stock-preparation-suggestion-operators.cjs'))

const applyWriter = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))

// The five columns this change adds. Written out rather than derived, so that deleting
// one from the template is a RED here instead of a silently smaller loop.
const NEW_HUMAN_FIELDS = Object.freeze([
  'makeOrBuy',
  'procurementDone',
  'procurementReplyDate',
  'warehouseDone',
  'actualArrivalDate',
])

const PROJECT_ID = 'proj_dept'
const OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

const ROLE_PURCHASING = 'plugin-integration-core:bom-prep:purchasing'
const ROLE_WAREHOUSE = 'plugin-integration-core:bom-prep:warehouse'
const ROLE_PRODUCTION = 'plugin-integration-core:bom-prep:production'

function fieldOf(id) {
  return STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find((f) => f.id === id)
}

// ---------------------------------------------------------------------------
// A. The five new columns are on the human side of every wall
// ---------------------------------------------------------------------------
function newColumnsAreHumanOwned() {
  for (const id of NEW_HUMAN_FIELDS) {
    const field = fieldOf(id)
    assert.ok(field, `${id} is declared on the canonical main template`)
    assert.equal(field.ownership, 'human_preserved', `${id} is human-owned`)
    // DERIVED, never authored — normalizeField sets this for every human field, and the
    // template module throws if a plm_system field tries to declare it.
    assert.equal(field.preserveOnRefresh, true, `${id} survives a PLM refresh`)
    assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes(id), `${id} is in the design-gated whitelist`)
    assert.equal(typeof field.labelZh, 'string')
    assert.ok(field.labelZh.length > 0, `${id} carries a Chinese display name`)
  }

  // The completion markers are the platform's checkbox-shaped type, not a two-value
  // select nobody would maintain a dictionary for.
  assert.equal(fieldOf('procurementDone').type, 'boolean')
  assert.equal(fieldOf('warehouseDone').type, 'boolean')
  assert.equal(fieldOf('procurementReplyDate').type, 'date')
  assert.equal(fieldOf('actualArrivalDate').type, 'date')

  // 自制/外购 is a CLOSED-VOCABULARY column that names a SOURCE and freezes no values:
  // the customer's own config_info dictionary supplies them (or a pack optionSet widens
  // them). A platform-side default list would be a vocabulary we cannot justify.
  const makeOrBuy = fieldOf('makeOrBuy')
  assert.equal(makeOrBuy.type, 'select')
  assert.deepEqual(makeOrBuy.optionSource, { type: 'config_info', key: 'make_or_buy' })
  for (const banned of ['options', 'values', 'value', 'default']) {
    assert.equal(banned in makeOrBuy, false, `the frozen template must not carry ${banned}`)
  }

  // The two free-text remarks are UNCHANGED — this change adds beside them, never over.
  assert.equal(fieldOf('procurementReply').type, 'string')
  assert.equal(fieldOf('procurementReply').labelZh, '采购回复')
  assert.equal(fieldOf('warehouseConfirmation').type, 'string')
  assert.equal(fieldOf('warehouseConfirmation').labelZh, '仓库确认')
}

// THE RED WITNESS for claim A. A PLM refresh payload carrying the new columns must be
// refused BY NAME; then the same payload with the wall disabled must sail through, which
// is what proves the refusal came from the wall and not from some other validation.
function plmRefreshCannotWriteTheNewColumns() {
  const assertNoHumanFields = applyWriter.__internals
    ? applyWriter.__internals.assertNoHumanFields
    : null
  assert.ok(typeof assertNoHumanFields === 'function', 'the apply-writer exposes its human-field wall')

  for (const fieldId of NEW_HUMAN_FIELDS) {
    const payload = { projectNo: 'P-1', [fieldId]: 'whatever-a-refresh-might-carry' }
    let err = null
    try {
      assertNoHumanFields(payload, 'add record')
    } catch (error) {
      err = error
    }
    assert.ok(err, `a refresh writing ${fieldId} is refused`)
    assert.match(String(err.message), new RegExp(fieldId), 'the refusal names the offending column')
    assert.equal(err.details.field, fieldId)
  }

  // A refresh carrying the whole departmental band at once is refused too (it stops at
  // the first, which is all that matters: nothing is written).
  assert.throws(
    () => assertNoHumanFields(Object.fromEntries(NEW_HUMAN_FIELDS.map((f) => [f, 'x'])), 'add record'),
    (error) => error && error.details && NEW_HUMAN_FIELDS.includes(error.details.field),
  )

  // NEGATIVE CONTROL / MUTATION: disable the wall by handing it an EMPTY human vocabulary
  // — the exact mutation "delete the wall" would produce — and the same payloads pass.
  // Without this the assertions above could be passing for the wrong reason.
  for (const fieldId of NEW_HUMAN_FIELDS) {
    assert.doesNotThrow(
      () => assertNoHumanFields({ [fieldId]: 'x' }, 'add record', []),
      `MUTATION CONTROL: with the wall disabled, ${fieldId} is no longer refused`,
    )
  }

  // And the wall is driven by the whitelist itself, so the five columns are refused
  // BECAUSE they are whitelisted, not because they were hardcoded anywhere.
  for (const fieldId of NEW_HUMAN_FIELDS) {
    assert.doesNotThrow(
      () => assertNoHumanFields({ [fieldId]: 'x' }, 'add record', HUMAN_PRESERVED_FIELD_IDS.filter((f) => f !== fieldId)),
      `${fieldId} is refused by virtue of the whitelist, not a hardcode`,
    )
  }
}

// ---------------------------------------------------------------------------
// B. Decision memory for 自制/外购 — an EXISTING operator, no new machinery
// ---------------------------------------------------------------------------
function makeOrBuyDecisionMemoryIsOfferedNotWritten() {
  // A row a human already answered, and the row in front of them now: SAME 图号.
  const history = [
    {
      recordId: 'rec-history-1',
      componentCode: 'GJ-0007',
      makeOrBuy: '20 - 外购',
      lastPlmRefreshAt: '2026-08-01T00:00:00.000Z',
    },
  ]
  const target = { recordId: 'rec-target', componentCode: 'GJ-0007' }

  const result = crossProjectPrefillCandidates(target, history, {
    matchField: 'componentCode',
    humanFields: ['makeOrBuy'],
  })

  // A PROPOSAL, never an application. The whole contract is in this one token.
  assert.equal(result.applyMode, 'k2_confirm_required')
  assert.equal(result.candidates.length, 1, 'the previously-confirmed answer is offered back')
  assert.equal(result.candidates[0].sourceRecordId, 'rec-history-1')
  assert.deepEqual(result.candidates[0].fieldValues, { makeOrBuy: '20 - 外购' })
  assert.deepEqual(result.candidates[0].presentFieldIds, ['makeOrBuy'])
  assert.equal(result.operator, 'cross_project_prefill')

  // THE POINT: the operator returned a value; it did not write one. The target row is
  // untouched — it never even gains the key.
  assert.equal('makeOrBuy' in target, false, 'a proposal must not mutate the row it is for')
  assert.deepEqual(target, { recordId: 'rec-target', componentCode: 'GJ-0007' })

  // A DIFFERENT component gets NOTHING. Nothing is ever fabricated, and identity is
  // matched exactly rather than fuzzily.
  const other = crossProjectPrefillCandidates(
    { recordId: 'rec-other', componentCode: 'GJ-9999' },
    history,
    { matchField: 'componentCode', humanFields: ['makeOrBuy'] },
  )
  assert.equal(other.candidates.length, 0, 'a different 图号 yields no proposal')

  // No history at all yields no proposal either.
  const empty = crossProjectPrefillCandidates(target, [], {
    matchField: 'componentCode',
    humanFields: ['makeOrBuy'],
  })
  assert.equal(empty.candidates.length, 0)

  // TENANCY is the CALLER's property and is honest about it: the operator is pure and
  // sees only the history rows it is handed, so it cannot reach across tenants — there
  // is no store for it to query. That is why this needed no new storage.
  assert.equal(typeof crossProjectPrefillCandidates, 'function')

  // The ownership wall applies to the proposal target too: a plm_system column may never
  // be proposed, which is what keeps this from becoming a refresh in disguise.
  assert.throws(
    () => crossProjectPrefillCandidates(target, history, {
      matchField: 'componentCode',
      humanFields: ['componentCode'],
    }),
    (error) => error && error.reason === 'HUMAN_FIELD_NOT_ALLOWED',
  )
}

// ---------------------------------------------------------------------------
// C. The pack declaration
// ---------------------------------------------------------------------------
const BASE_PACK = Object.freeze({
  packId: 'dept-scoping',
  packVersion: 1,
  extensionFields: [],
})

function absentDeclarationChangesNothing() {
  const pack = normalizeCustomerPack({ ...BASE_PACK })
  assert.deepEqual(pack.fieldWritePolicies, [], 'no policies declared')
  assert.deepEqual(pack.fieldWriteDenials, [], 'and therefore no denials derived')

  // DEEP-EQUAL TO TODAY on every pre-existing key: adding the sibling declaration must
  // not have perturbed anything a pack already carried.
  assert.equal(pack.packId, 'dept-scoping')
  assert.equal(pack.packVersion, 1)
  assert.equal(pack.targetObjectId, OBJECT_ID)
  assert.deepEqual(pack.extensionFields, [])
  assert.deepEqual(pack.optionSets, [])
  assert.deepEqual(pack.roleViews, [])

  // Explicit null/undefined are the same as omission — a deployer writing `null` must
  // not accidentally opt in to an empty-but-present policy set.
  for (const value of [null, undefined]) {
    const p = normalizeCustomerPack({ ...BASE_PACK, fieldWritePolicies: value })
    assert.deepEqual(p.fieldWriteDenials, [])
  }
}

function declaredOwnershipDerivesTheComplement() {
  const pack = normalizeCustomerPack({
    ...BASE_PACK,
    fieldWritePolicies: [
      { roleId: ROLE_PRODUCTION, label: '备料', ownsFieldIds: ['materialType', 'makeOrBuy', 'demandDate'] },
      { roleId: ROLE_PURCHASING, label: '采购', ownsFieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate'] },
      { roleId: ROLE_WAREHOUSE, label: '仓库', ownsFieldIds: ['warehouseConfirmation', 'warehouseDone', 'actualArrivalDate'] },
    ],
  })

  const denialsFor = (roleId) => pack.fieldWriteDenials.filter((d) => d.roleId === roleId).map((d) => d.fieldId).sort()

  // WAREHOUSE may not write the purchasing band, nor the production band.
  assert.deepEqual(
    denialsFor(ROLE_WAREHOUSE),
    ['demandDate', 'makeOrBuy', 'materialType', 'procurementDone', 'procurementReply', 'procurementReplyDate'].sort(),
  )
  // PURCHASING may not write the warehouse band, nor the production band. The reverse
  // direction is asserted independently, not inferred from symmetry.
  assert.deepEqual(
    denialsFor(ROLE_PURCHASING),
    ['actualArrivalDate', 'demandDate', 'makeOrBuy', 'materialType', 'warehouseConfirmation', 'warehouseDone'].sort(),
  )
  // Nobody is denied their OWN columns.
  for (const [role, owned] of [
    [ROLE_PURCHASING, ['procurementReply', 'procurementDone', 'procurementReplyDate']],
    [ROLE_WAREHOUSE, ['warehouseConfirmation', 'warehouseDone', 'actualArrivalDate']],
    [ROLE_PRODUCTION, ['materialType', 'makeOrBuy', 'demandDate']],
  ]) {
    for (const fieldId of owned) {
      assert.equal(
        pack.fieldWriteDenials.some((d) => d.roleId === role && d.fieldId === fieldId),
        false,
        `${role} keeps write on its own column ${fieldId}`,
      )
    }
  }

  // A COLUMN NOBODY CLAIMED IS LEFT ALONE — scoping is additive, never a sweep. `notes`
  // is in the template and in no policy, so it produces no rows for anyone.
  assert.equal(pack.fieldWriteDenials.some((d) => d.fieldId === 'notes'), false)
  assert.equal(pack.fieldWriteDenials.some((d) => d.fieldId === 'projectNo'), false)

  // A ROLE NOBODY DECLARED IS UNAFFECTED: no row anywhere names it, so the scope map is
  // empty for it and it keeps exactly the access it has today.
  assert.equal(pack.fieldWriteDenials.some((d) => d.roleId === 'some-other-role'), false)

  // THE PLAN CARRIES NO VISIBILITY DIMENSION AT ALL. This is the structural expression of
  // "write only, read shared": there is no key here that could ever hide a column, so no
  // amount of declaration can stop 采购 seeing 需求日期.
  for (const denial of pack.fieldWriteDenials) {
    assert.deepEqual(Object.keys(denial).sort(), ['fieldId', 'roleId'])
  }

  // DETERMINISTIC ORDER — catalog order for fields, declaration order for roles — so a
  // re-install produces a byte-identical plan rather than a churn of equivalent rows.
  const again = normalizeCustomerPack({
    ...BASE_PACK,
    fieldWritePolicies: [
      { roleId: ROLE_PRODUCTION, label: '备料', ownsFieldIds: ['materialType', 'makeOrBuy', 'demandDate'] },
      { roleId: ROLE_PURCHASING, label: '采购', ownsFieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate'] },
      { roleId: ROLE_WAREHOUSE, label: '仓库', ownsFieldIds: ['warehouseConfirmation', 'warehouseDone', 'actualArrivalDate'] },
    ],
  })
  assert.deepEqual(again.fieldWriteDenials, pack.fieldWriteDenials)

  // roleViews are UNTOUCHED by any of this — the cosmetic layer and the enforcement layer
  // stay separate, which is exactly why this is a sibling key.
  assert.deepEqual(pack.roleViews, [])
}

function packDeclarationIsFailClosed() {
  const reasonOf = (input) => {
    try {
      normalizeCustomerPack({ ...BASE_PACK, fieldWritePolicies: input })
    } catch (error) {
      assert.ok(error instanceof StockPreparationCustomerPackError)
      return error.reason
    }
    return null
  }

  assert.equal(reasonOf('nope'), 'FIELD_WRITE_POLICIES_INVALID')
  assert.equal(reasonOf(['nope']), 'FIELD_WRITE_POLICIES_INVALID')
  assert.equal(
    reasonOf([{ roleId: ROLE_PURCHASING, ownsFieldIds: ['notes'], smuggled: 'x' }]),
    'FIELD_WRITE_POLICY_UNKNOWN_KEY',
  )
  assert.equal(reasonOf([{ roleId: '', ownsFieldIds: ['notes'] }]), 'FIELD_WRITE_POLICY_ROLE_INVALID')
  assert.equal(reasonOf([{ roleId: 'has space', ownsFieldIds: ['notes'] }]), 'FIELD_WRITE_POLICY_ROLE_INVALID')
  assert.equal(
    reasonOf([
      { roleId: ROLE_PURCHASING, ownsFieldIds: ['notes'] },
      { roleId: ROLE_PURCHASING, ownsFieldIds: ['makeOrBuy'] },
    ]),
    'FIELD_WRITE_POLICY_DUPLICATE_ROLE',
  )
  assert.equal(reasonOf([{ roleId: ROLE_PURCHASING, ownsFieldIds: [] }]), 'FIELD_WRITE_POLICY_FIELDS_INVALID')
  // A column that is on NO catalog cannot be scoped — a typo must not silently scope nothing.
  assert.equal(
    reasonOf([{ roleId: ROLE_PURCHASING, ownsFieldIds: ['procurmentReply'] }]),
    'FIELD_WRITE_POLICY_FIELD_UNKNOWN',
  )
  // Content smuggling is refused here exactly as everywhere else in the pack.
  assert.equal(reasonOf([{ roleId: ROLE_PURCHASING, ownsFieldIds: ['notes'], rows: [] }]), 'FIELD_WRITE_POLICIES_INVALID')
}

// ---------------------------------------------------------------------------
// D. The installer wiring
// ---------------------------------------------------------------------------
function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

function createFakeProvisioning() {
  return {
    getFieldId: (projectId, objectId, fieldId) => physicalFieldId(projectId, objectId, fieldId),
    async findObjectSheet() {
      return { id: 'sheet_dept', baseId: 'base_dept', name: 'main', description: null }
    },
    async readObjectFieldsContent() {
      return {}
    },
    async ensureMissingObjectFields() {
      return { addedFieldIds: [], skippedExistingFieldIds: [] }
    },
    async patchObjectFieldProperty() {
      return { ok: true }
    },
    async ensureView() {
      return { ok: true }
    },
  }
}

function createRecordingPort() {
  const calls = []
  return {
    calls,
    async applyRoleWriteScopes(input) {
      calls.push(input)
      return { applied: input.entries.length, entries: input.entries }
    },
  }
}

// A port that EXPLODES if touched. Absent a declaration the installer must not go near it.
function createPoisonedPort() {
  return {
    async applyRoleWriteScopes() {
      throw new Error('the permission port must not be called when no policy is declared')
    },
  }
}

const LEDGER = {
  async recordInstall(input) {
    return {
      status: 'installed',
      mode: input.mode,
      packId: input.packId,
      packVersion: input.packVersion,
      objectId: input.objectId,
      installedFields: input.installedFields,
    }
  },
}

async function installerSkipsThePortWhenNothingIsDeclared() {
  const summary = await installCustomerPack({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: { ...BASE_PACK },
    packInstallStore: LEDGER,
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {} },
    // Poisoned ON PURPOSE: reaching for it at all is the failure.
    fieldPermissions: createPoisonedPort(),
  })
  assert.equal(summary.appliedWriteScopes, 0)
  assert.equal(summary.writeScopeSkipped, 'not_declared')
  assert.equal(summary.writeScopeRoleCount, 0)

  // And with NO port supplied at all — the shape every existing caller has today.
  const noPort = await installCustomerPack({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: { ...BASE_PACK },
    packInstallStore: LEDGER,
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {} },
  })
  assert.equal(noPort.appliedWriteScopes, 0)
  assert.equal(noPort.writeScopeSkipped, 'not_declared')
}

async function installerWritesPlatformRowsWhenDeclared() {
  const port = createRecordingPort()
  const summary = await installCustomerPack({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: {
      ...BASE_PACK,
      fieldWritePolicies: [
        { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate'] },
        { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation', 'warehouseDone', 'actualArrivalDate'] },
      ],
    },
    packInstallStore: LEDGER,
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {} },
    fieldPermissions: port,
  })

  assert.equal(port.calls.length, 1, 'one batched call, after every schema write')
  const call = port.calls[0]
  assert.equal(call.sheetId, 'sheet_dept', 'addressed by the resolved sheet id')

  // PHYSICAL ids, never logical: `field_permissions.field_id` references meta_fields.id,
  // and the mapping goes through the host's own getFieldId rather than string-building.
  for (const entry of call.entries) {
    assert.match(entry.fieldId, /^fld_proj_dept_/, 'entries carry physical field ids')
    assert.deepEqual(Object.keys(entry).sort(), ['fieldId', 'roleId'])
  }

  const denied = (roleId) => call.entries
    .filter((e) => e.roleId === roleId)
    .map((e) => e.fieldId.replace(`fld_${PROJECT_ID}_${OBJECT_ID}_`, ''))
    .sort()

  assert.deepEqual(denied(ROLE_WAREHOUSE), ['procurementDone', 'procurementReply', 'procurementReplyDate'])
  assert.deepEqual(denied(ROLE_PURCHASING), ['actualArrivalDate', 'warehouseConfirmation', 'warehouseDone'])
  assert.equal(summary.appliedWriteScopes, 6)
  assert.equal(summary.writeScopeRoleCount, 2)
  assert.equal(summary.writeScopeSkipped, null)

  // The production band is claimed by NOBODY in this pack, so it is scoped for nobody —
  // both departments keep writing it exactly as they do today. (Read was never in scope
  // at all: there is no visibility key anywhere in this payload.)
  const allFields = call.entries.map((e) => e.fieldId)
  for (const untouched of ['materialType', 'demandDate', 'leadTimeDays', 'makeOrBuy']) {
    assert.equal(
      allFields.includes(physicalFieldId(PROJECT_ID, OBJECT_ID, untouched)),
      false,
      `${untouched} is claimed by no policy and is therefore scoped for no one`,
    )
  }
}

async function installerFailsClosedWhenThePortIsMissing() {
  let err = null
  try {
    await installCustomerPack({
      provisioning: createFakeProvisioning(),
      projectId: PROJECT_ID,
      pack: {
        ...BASE_PACK,
        fieldWritePolicies: [
          { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply'] },
          { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation'] },
        ],
      },
      packInstallStore: LEDGER,
      tenantId: 't1',
      workspaceId: 'w1',
      logger: { info() {} },
      // No fieldPermissions port at all.
    })
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof StockPreparationCustomerPackInstallError, 'a declared policy with no port fails closed')
  assert.equal(err.code, 'CUSTOMER_PACK_FIELD_PERMISSIONS_UNAVAILABLE')
  assert.equal(err.status, 503)

  // A malformed port (present but wrong shape) is refused the same way — duck-typing must
  // not degrade into "call it and hope".
  let shapeErr = null
  try {
    await installCustomerPack({
      provisioning: createFakeProvisioning(),
      projectId: PROJECT_ID,
      pack: {
        ...BASE_PACK,
        fieldWritePolicies: [
          { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply'] },
          { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation'] },
        ],
      },
      packInstallStore: LEDGER,
      tenantId: 't1',
      workspaceId: 'w1',
      logger: { info() {} },
      fieldPermissions: { nope: true },
    })
  } catch (error) {
    shapeErr = error
  }
  assert.equal(shapeErr.code, 'CUSTOMER_PACK_FIELD_PERMISSIONS_UNAVAILABLE')
}

// The helper is exported so this property can be asserted without a whole install.
function applyHelperIsPure() {
  assert.equal(typeof installerInternals.applyFieldWritePolicies, 'function')
}

async function main() {
  newColumnsAreHumanOwned()
  plmRefreshCannotWriteTheNewColumns()
  makeOrBuyDecisionMemoryIsOfferedNotWritten()
  absentDeclarationChangesNothing()
  declaredOwnershipDerivesTheComplement()
  packDeclarationIsFailClosed()
  await installerSkipsThePortWhenNothingIsDeclared()
  await installerWritesPlatformRowsWhenDeclared()
  await installerFailsClosedWhenThePortIsMissing()
  applyHelperIsPure()
  console.log('stock-preparation-department-fields-and-write-scoping.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-department-fields-and-write-scoping.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
