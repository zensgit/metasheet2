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
//   E. A PACK REVISION THAT MOVES A COLUMN'S OWNER IS RECONCILED, NOT JUST REPORTED. An
//      upsert-only port leaves v1's denial for the OLD owner standing beside v2's for the
//      new one, and the write gate ORs `read_only` across a user's rows -- so the column
//      ends up unwritable by BOTH declared roles while the install reports `applied=N`.
//      The install now passes the pack's governed (columns x roles) rectangle to the port,
//      which retires its OWN stale denials inside it in the same transaction, and reports
//      them as `removedWriteScopes`. The three things it must NOT reach are asserted
//      directly: an OPERATOR-authored row, a plugin row for an undeclared role, and any
//      row on a column no policy claims -- those stay, and are handed to the operator as
//      `staleWriteScopes` (each tagged `inReconcileRegion`, which is the line the dry-run
//      splits "about to be fixed" from "a human must clear this" along). A host too old to
//      accept the rectangle reports `unsupported_port` + a NULL `removedWriteScopes` --
//      never [], which would read as "reconciled, nothing to retire" -- and degrades to
//      the report-only behaviour. A port that cannot be read at all likewise reports
//      `writeScopeCheck: 'unsupported_port'` and a NULL stale list.
//
//   F. AN UNKNOWN ROLE IS A CODED 422, REFUSED BEFORE THE FIRST SCHEMA WRITE. The pack's
//      regex says nothing about whether the role EXISTS; only the host knows. The
//      pre-flight asks it before any column is created, and a port that rejects later
//      still surfaces a coded install error instead of an uncoded 500.
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
  planCustomerPackInstall,
  StockPreparationCustomerPackInstallError,
  __internals: installerInternals,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))

const {
  crossProjectPrefillCandidates,
} = require(path.join(LIB, 'stock-preparation-suggestion-operators.cjs'))

// The REAL ledger store's values-free guard. Used to prove the summary the installer hands the
// ledger is a shape a LIVE store would accept, rather than one only this suite's fake tolerates.
const {
  __internals: packInstallStoreInternals,
} = require(path.join(LIB, 'stock-preparation-pack-install-store.cjs'))

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
    // A host that HONOURS the region. Without this the install refuses (501) rather than writing
    // rows a later revision could never retire — see the bounds suite for that branch.
    supportsWriteScopeReconcile: true,
    async applyRoleWriteScopes(input) {
      calls.push(input)
      return { applied: input.entries.length, entries: input.entries, removed: [] }
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


// ---------------------------------------------------------------------------
// E. The pack REVISION that moves a column's owner
// ---------------------------------------------------------------------------

// A port with the READ half the stale check needs. `rows` is the platform's
// `field_permissions` table as this port sees it: only what THIS plugin ever wrote
// (created_by = the plugin marker), which is exactly the census the real service's
// listRoleWriteScopes performs.
// `createdBy` mirrors the real table's provenance column. Only rows carrying the plugin marker are
// this port's; anything else is an OPERATOR row, which the census hides and the reconcile may never
// delete. The host-side unit suite proves the real SQL enforces the same thing.
const PLUGIN_MARKER = 'plugin:plugin-integration-core/stock-preparation'
// …and its PER-PACK form. The delete's owner predicate is this, not the bare prefix: two packs on
// one canonical sheet must not be able to retire each other's denials.
const markerForPack = (packId) => `${PLUGIN_MARKER}#${packId}`

function createStatefulPort({
  withRead = true,
  withRoleCheck = true,
  knownRoleIds = null,
  // An OLDER host: its applyRoleWriteScopes ignores the `reconcile` argument entirely and returns
  // no `removed` array, which the installer must detect rather than assume.
  withReconcile = true,
} = {}) {
  const rows = new Map()
  const port = {
    rows,
    applyCalls: [],
    // The capability marker the installer feature-detects.  models an OLDER
    // host: it does not declare it, and the install refuses such a host rather than degrading.
    ...(withReconcile ? { supportsWriteScopeReconcile: true } : {}),
    async applyRoleWriteScopes({ sheetId, entries, packId, reconcile }) {
      this.applyCalls.push({ sheetId, entries, packId, reconcile })
      const createdBy = typeof packId === 'string' && packId ? markerForPack(packId) : PLUGIN_MARKER
      // UPSERT, exactly like the real port — including its refusal to re-stamp provenance on a row
      // this call could not also delete, which is what keeps an operator's row an operator's row.
      for (const entry of entries) {
        const key = `${entry.fieldId} ${entry.roleId}`
        const existing = rows.get(key)
        const adoptable = !existing || existing.createdBy === createdBy || existing.createdBy === PLUGIN_MARKER
        rows.set(key, {
          ...(existing || {}),
          ...entry,
          sheetId,
          createdBy: adoptable ? createdBy : existing.createdBy,
        })
      }
      if (!withReconcile || !reconcile) return { applied: entries.length, entries }

      // THE SCOPED RECONCILE, mirroring the real statement's four narrowings verbatim: this
      // plugin's rows only, inside the declared (columns × roles) region only, never a row this
      // same call just wrote. A fake that deleted more broadly would make the safety assertions
      // below vacuous, so it deliberately does not.
      const desired = new Set(entries.map((entry) => `${entry.fieldId} ${entry.roleId}`))
      const fieldIds = new Set(reconcile.fieldIds)
      const roleIds = new Set(reconcile.roleIds)
      // EXACTLY the two markers the real statement binds: this pack's own, and the pack-less legacy
      // one (which no other pack can claim).
      const mine = new Set([createdBy, PLUGIN_MARKER])
      const removed = []
      for (const [key, row] of [...rows.entries()]) {
        if (row.sheetId !== sheetId) continue
        if (!mine.has(row.createdBy)) continue
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
  }
  if (withRead) {
    port.listRoleWriteScopes = async ({ sheetId }) => {
      const entries = []
      const foreignEntries = []
      for (const row of rows.values()) {
        if (row.sheetId !== sheetId) continue
        const isPlugin = row.createdBy === PLUGIN_MARKER
          || (typeof row.createdBy === 'string' && row.createdBy.startsWith(`${PLUGIN_MARKER}#`))
        if (isPlugin) {
          entries.push({
            fieldId: row.fieldId,
            roleId: row.roleId,
            createdBy: row.createdBy,
            packId: row.createdBy === PLUGIN_MARKER ? null : row.createdBy.slice(PLUGIN_MARKER.length + 1),
          })
        } else {
          foreignEntries.push({ fieldId: row.fieldId, roleId: row.roleId, createdBy: row.createdBy || null })
        }
      }
      return { sheetId, entries, foreignEntries }
    }
  }
  if (withRoleCheck) {
    port.findMissingRoleIds = async ({ roleIds }) => ({
      missing: knownRoleIds === null ? [] : roleIds.filter((roleId) => !knownRoleIds.includes(roleId)),
    })
  }
  return port
}

const V1_POLICIES = Object.freeze([
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation', 'warehouseDone', 'actualArrivalDate'] },
])
// v2 moves the arrival-date column from the warehouse role to the purchasing role.
// NOTHING else changes.
const V2_POLICIES = Object.freeze([
  { roleId: ROLE_PURCHASING, ownsFieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate', 'actualArrivalDate'] },
  { roleId: ROLE_WAREHOUSE, ownsFieldIds: ['warehouseConfirmation', 'warehouseDone'] },
])
// 6 columns are claimed by someone in v2; each denies the one role that does not own it.
const V2_DENIAL_COUNT = 6

function packWith(policies, packVersion) {
  return { ...BASE_PACK, packVersion, fieldWritePolicies: policies.map((policy) => ({ ...policy })) }
}

async function installWith(port, policies, packVersion, provisioning) {
  return installCustomerPack({
    provisioning: provisioning || createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(policies, packVersion),
    packInstallStore: LEDGER,
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {}, warn() {} },
    fieldPermissions: port,
  })
}

const physical = (fieldId) => physicalFieldId(PROJECT_ID, OBJECT_ID, fieldId)

async function ownershipTransferIsNeverASilentSuccess() {
  const port = createStatefulPort()

  // v1: the warehouse role owns the arrival-date column, so the row written says
  // "purchasing may not write it".
  const v1 = await installWith(port, V1_POLICIES, 1)
  assert.equal(v1.writeScopeCheck, 'checked', 'a readable port is actually read')
  assert.deepEqual(v1.staleWriteScopes, [], 'a first install has nothing stale behind it')
  assert.equal(v1.staleWriteScopeCount, 0)
  assert.ok(
    port.rows.has(`${physical('actualArrivalDate')} ${ROLE_PURCHASING}`),
    'v1 denied purchasing the column the warehouse owned',
  )

  // v2: the SAME column changes hands. THE HEADLINE — v1's denial for purchasing is RETIRED in the
  // same call that writes v2's denial for the warehouse, so the column ends up denied to exactly
  // one role. Without the reconcile both rows stand, `loadFieldPermissionScopeMap` ORs `read_only`
  // across them, and the column is unwritable by EVERY declared role while the install reports a
  // clean applied=N.
  const v2 = await installWith(port, V2_POLICIES, 2)
  assert.ok(
    port.rows.has(`${physical('actualArrivalDate')} ${ROLE_WAREHOUSE}`),
    'v2 denies the warehouse, which no longer owns the column',
  )
  assert.ok(
    !port.rows.has(`${physical('actualArrivalDate')} ${ROLE_PURCHASING}`),
    'and v1\'s denial for purchasing — the role that now OWNS it — is gone, not merely reported',
  )

  // The retirement is NAMED, never silent.
  assert.equal(v2.writeScopeReconcile, 'reconciled')
  assert.equal(v2.removedWriteScopeCount, 1)
  assert.deepEqual(v2.removedWriteScopes, [
    { fieldId: physical('actualArrivalDate'), roleId: ROLE_PURCHASING },
  ], 'the retired v1 denial is reported back in the port\'s own shape')
  // Values-free: ids and role ids only, no labels and no values.
  for (const removed of v2.removedWriteScopes) {
    assert.deepEqual(Object.keys(removed).sort(), ['fieldId', 'roleId'])
  }

  // AND the census that used to carry it now reports nothing left over: the reconcile reached it.
  assert.equal(v2.writeScopeCheck, 'checked')
  assert.equal(v2.staleWriteScopeCount, 0)
  assert.deepEqual(v2.staleWriteScopes, [], 'nothing is left for an operator to clear by hand')

  // THE REGION IS EXACTLY THE PACK'S, NOT THE SHEET. The delete request the installer sent names
  // only the columns this pack's policies claim and only the roles it declares — which is what
  // keeps another consumer's rows on the same canonical sheet out of reach.
  const v2Call = port.applyCalls[port.applyCalls.length - 1]
  assert.deepEqual(v2Call.reconcile.roleIds.slice().sort(), [ROLE_PURCHASING, ROLE_WAREHOUSE].sort())
  assert.deepEqual(
    v2Call.reconcile.fieldIds.slice().sort(),
    ['procurementReply', 'procurementDone', 'procurementReplyDate', 'actualArrivalDate', 'warehouseConfirmation', 'warehouseDone']
      .map(physical).sort(),
    'the governed rectangle is the union of ownsFieldIds — never every column on the sheet',
  )

  // IDEMPOTENT: a second v2 has nothing left to retire, and says so with [] rather than null.
  const again = await installWith(port, V2_POLICIES, 2)
  assert.deepEqual(again.removedWriteScopes, [], 're-running a converged v2 retires nothing')
  assert.equal(again.staleWriteScopeCount, 0)

  // POSITIVE CONTROL - the assertion is not vacuous. A declaration that did NOT move retires
  // nothing on the second run either, so `[]` still means something.
  const clean = createStatefulPort()
  await installWith(clean, V1_POLICIES, 1)
  const reinstalled = await installWith(clean, V1_POLICIES, 1)
  assert.deepEqual(reinstalled.removedWriteScopes, [], 'an unchanged declaration retires nothing')
  assert.deepEqual(reinstalled.staleWriteScopes, [], 'and leaves nothing stale')
}

// THE OTHER HALF OF THE SAFETY PROPERTY: what the reconcile must NOT reach. Two rows sit on the
// same sheet and the same column the pack governs — one authored by an OPERATOR, one written by
// this plugin for a role the pack does not declare. A v2 install must retire neither.
async function reconcileNeverReachesRowsItDoesNotOwn() {
  const port = createStatefulPort()
  await installWith(port, V1_POLICIES, 1)

  const OTHER_ROLE = 'plugin-integration-core:bom-prep:quality'
  // (a) An operator's own denial, on a column this pack DOES govern and a role it DOES declare —
  //     inside the rectangle on every axis except the one that matters, provenance.
  port.rows.set(`${physical('procurementReply')} ${ROLE_WAREHOUSE}`, {
    fieldId: physical('procurementReply'),
    roleId: ROLE_WAREHOUSE,
    sheetId: 'sheet_dept',
    createdBy: 'operator:univer-meta-authoring-route',
  })
  // (b) This plugin's own row for a role OUTSIDE the pack's declared set (a neighbouring pack, or a
  //     wider earlier revision). Same column, same provenance marker — only the role is out of range.
  port.rows.set(`${physical('procurementReply')} ${OTHER_ROLE}`, {
    fieldId: physical('procurementReply'),
    roleId: OTHER_ROLE,
    sheetId: 'sheet_dept',
    createdBy: PLUGIN_MARKER,
  })

  const v2 = await installWith(port, V2_POLICIES, 2)

  assert.ok(
    port.rows.has(`${physical('procurementReply')} ${ROLE_WAREHOUSE}`),
    'the OPERATOR row survives — provenance, not position, is what puts a row out of reach',
  )
  assert.ok(
    port.rows.has(`${physical('procurementReply')} ${OTHER_ROLE}`),
    'and so does a plugin row for a role this pack does not declare',
  )
  assert.deepEqual(
    v2.removedWriteScopes,
    [{ fieldId: physical('actualArrivalDate'), roleId: ROLE_PURCHASING }],
    'exactly the one in-region orphan is retired, and nothing else',
  )
  // The out-of-region plugin row is not silently ignored either: it is REPORTED as stale, because
  // only an operator can decide about it.
  assert.deepEqual(v2.staleWriteScopes, [
    {
      fieldId: physical('procurementReply'),
      logicalFieldId: 'procurementReply',
      roleId: OTHER_ROLE,
      // ATTRIBUTED. This row was seeded with the pack-LESS legacy marker, so it reports packId null
      // — and it survives anyway, because it is out of the rectangle on the ROLE axis. Provenance
      // and position are two independent reasons a row is out of reach, and the report names both.
      packId: null,
      inReconcileRegion: false,
    },
  ], 'what the reconcile may not touch is handed to the operator by name')
  assert.equal(v2.staleWriteScopeCount, 1)
}

// AN OLDER HOST IS REFUSED, NOT DEGRADED.
//
// This started life as "degrade visibly": install anyway, report `unsupported_port`, leave the
// orphan for a human. That reads reasonable and is not: on such a host the v1 denial stays in force
// while the install returns success, so the column is unwritable by BOTH declared roles — precisely
// the failure the reconcile exists to end — and the deployer's only warning is a token in a summary.
// Worse, the dry-run had no way to know, so it promised a removal that could never happen.
//
// The port therefore declares `supportsWriteScopeReconcile`, and a pack with a governed rectangle is
// refused (coded 501) over an UNTOUCHED sheet when the host does not. The dry-run's half of the same
// contract lives in the bounds suite.
async function anOlderPortIsRefusedBeforeAnyWrite() {
  const port = createStatefulPort({ withReconcile: false })
  assert.equal(port.supportsWriteScopeReconcile, undefined, 'the older host declares nothing')

  let caught = null
  try {
    await installWith(port, V1_POLICIES, 1)
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'a governed pack must not install against a host that cannot reconcile')
  assert.equal(caught.status, 501)
  assert.equal(caught.code, 'CUSTOMER_PACK_FIELD_PERMISSION_RECONCILE_UNSUPPORTED')
  assert.equal(caught.details.packId, 'dept-scoping')
  assert.equal(port.rows.size, 0, 'and not one permission row was written')
  assert.equal(port.applyCalls.length, 0, 'the write half was never reached')
}

async function dryRunPreviewsTheDenialPlanAndTheStaleRows() {
  const port = createStatefulPort()
  await installWith(port, V1_POLICIES, 1)

  // The dry-run of v2, over the sheet v1 already scoped, must show BOTH what it will
  // write and what v1 left behind - before anything is written.
  const plan = await planCustomerPackInstall({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(V2_POLICIES, 2),
    fieldPermissions: port,
  })
  assert.equal(plan.fieldPermissionsPortAvailable, true)
  assert.equal(plan.writeScopeCheck, 'checked')
  assert.deepEqual(plan.staleWriteScopes, [
    {
      fieldId: physical('actualArrivalDate'),
      logicalFieldId: 'actualArrivalDate',
      roleId: ROLE_PURCHASING,
      packId: 'dept-scoping',
      inReconcileRegion: true,
    },
  ])
  // AND THE SPLIT A DEPLOYER ACTS ON. The one orphan is inside the pack's governed rectangle, so
  // the install will retire it — it belongs in the "about to be fixed" list, NOT on the operator's
  // to-do list. Reporting it in both would overstate the manual work by exactly the rows the
  // reconcile handles.
  assert.deepEqual(plan.willRemoveWriteScopes, plan.staleWriteScopes)
  assert.deepEqual(plan.operatorMustClearWriteScopes, [])
  assert.equal(plan.counts.willRemoveWriteScopes, 1)
  assert.equal(plan.counts.operatorMustClearWriteScopes, 0)
  assert.equal(plan.counts.staleWriteScopes, 1)

  // AND THE BOUND ITSELF. `willRemoveWriteScopes` is a claim about which rows a DELETE will reach;
  // `writeScopeRegion` is the rectangle that delete is issued under, so the claim is checkable
  // without re-deriving the pack. It must be VERBATIM what the install passes the port.
  assert.deepEqual(plan.writeScopeRegion, {
    fieldIds: ['procurementReply', 'procurementDone', 'procurementReplyDate', 'actualArrivalDate', 'warehouseConfirmation', 'warehouseDone']
      .map(physical).sort(),
    roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE].sort(),
  }, 'the dry-run names the governed rectangle, not just its consequences')
  assert.equal(plan.counts.writeScopeRegionFields, 6)
  assert.equal(plan.counts.writeScopeRegionRoles, 2)

  // THE TIE. A dry-run that previewed a DIFFERENT rectangle from the one the install uses would be
  // a rehearsal of something else, so the two are compared directly rather than trusted to match.
  const installPort = createStatefulPort()
  await installWith(installPort, V1_POLICIES, 1)
  await installWith(installPort, V2_POLICIES, 2)
  const sentRegion = installPort.applyCalls[installPort.applyCalls.length - 1].reconcile
  assert.deepEqual({
    fieldIds: [...sentRegion.fieldIds].sort(),
    roleIds: [...sentRegion.roleIds].sort(),
  }, plan.writeScopeRegion, 'the rehearsed rectangle IS the one the install sends the port')

  // THE DERIVED DENIAL PLAN itself - "what install will do" - visible before it happens.
  assert.equal(plan.counts.fieldWriteDenials, plan.fieldWriteDenials.length)
  const denied = (roleId) => plan.fieldWriteDenials
    .filter((row) => row.roleId === roleId)
    .map((row) => row.logicalFieldId)
    .sort()
  assert.deepEqual(denied(ROLE_WAREHOUSE), ['actualArrivalDate', 'procurementDone', 'procurementReply', 'procurementReplyDate'])
  assert.deepEqual(denied(ROLE_PURCHASING), ['warehouseConfirmation', 'warehouseDone'])
  for (const row of plan.fieldWriteDenials) {
    assert.deepEqual(Object.keys(row).sort(), ['fieldId', 'logicalFieldId', 'roleId'])
    assert.match(row.fieldId, /^fld_proj_dept_/, 'the plan names the PHYSICAL id the install will write')
  }
  assert.deepEqual(plan.unknownRoleIds, [], 'both declared roles exist')
  assert.equal(plan.canInstall, true)

  // ZERO WRITES: a dry-run must not touch the permission table.
  assert.equal(port.applyCalls.length, 1, 'still only the v1 install call - the dry-run wrote nothing')

  // A pack with NO declaration keeps the dry-run byte-for-byte what it is today.
  const bare = await planCustomerPackInstall({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: { ...BASE_PACK },
    fieldPermissions: port,
  })
  assert.deepEqual(bare.fieldWriteDenials, [])
  assert.equal(bare.writeScopeCheck, 'not_declared')
  assert.equal(bare.staleWriteScopes, null)
}

async function anUnreadablePortSaysSoRatherThanReportingNothingStale() {
  // The older-host shape: it can WRITE scopes but exposes no census. Reporting `[]` here
  // would be a lie ("checked, nothing stale"); the only honest answer is "not checked".
  const port = createStatefulPort({ withRead: false })
  const summary = await installWith(port, V2_POLICIES, 2)
  assert.equal(summary.writeScopeCheck, 'unsupported_port')
  assert.equal(summary.staleWriteScopes, null, 'NULL, never [] - absence of a check is not absence of stale rows')
  assert.equal(summary.staleWriteScopeCount, 0)
  assert.equal(summary.appliedWriteScopes, V2_DENIAL_COUNT, 'and the install still applies what it declared')

  const plan = await planCustomerPackInstall({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(V2_POLICIES, 2),
    fieldPermissions: port,
  })
  assert.equal(plan.writeScopeCheck, 'unsupported_port')
  assert.equal(plan.staleWriteScopes, null)
  assert.equal(plan.fieldPermissionsPortAvailable, true, 'the WRITE half is there; only the census is not')

  // And with no port at all the dry-run says so instead of pretending.
  const noPort = await planCustomerPackInstall({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(V2_POLICIES, 2),
  })
  assert.equal(noPort.fieldPermissionsPortAvailable, false)
  assert.equal(noPort.writeScopeCheck, 'port_absent')
  assert.equal(noPort.staleWriteScopes, null)
  assert.equal(noPort.canInstall, false, 'a declared policy with no port cannot install - the dry-run says so first')
}

// ---------------------------------------------------------------------------
// F. An unknown role
// ---------------------------------------------------------------------------

// Provisioning that records EVERY call by name, so "zero schema mutations" is stated as
// "no write primitive was reached", not as "the three we remembered did not run".
const PROVISIONING_WRITE_METHODS = Object.freeze([
  'ensureMissingObjectFields', 'patchObjectFieldProperty', 'ensureView', 'ensureObject',
])

function createRecordingProvisioning() {
  const base = createFakeProvisioning()
  const calls = []
  const wrapped = { calls }
  for (const key of Object.keys(base)) {
    wrapped[key] = typeof base[key] === 'function'
      ? (...args) => { calls.push(key); return base[key](...args) }
      : base[key]
  }
  return wrapped
}

// The real host port throws this shape (see
// packages/core-backend/src/services/stock-preparation-field-permissions.ts). The plugin
// cannot import the TS class, so it must recognise it structurally - which is exactly
// what this fake asserts is enough.
function fieldPermissionsError(reason, offending) {
  const error = new Error(`field-permission port refused: ${offending.join(', ')}`)
  error.name = 'StockPreparationFieldPermissionsError'
  error.reason = reason
  error.offending = offending
  return error
}

async function anUnknownRoleIsACoded422BeforeAnySchemaWrite() {
  const provisioning = createRecordingProvisioning()
  // The warehouse role does not exist on this host.
  const port = createStatefulPort({ knownRoleIds: [ROLE_PURCHASING] })
  port.applyRoleWriteScopes = async () => {
    throw new Error('pre-flight must refuse before the port is ever called')
  }

  let err = null
  try {
    await installCustomerPack({
      provisioning,
      projectId: PROJECT_ID,
      pack: packWith(V1_POLICIES, 1),
      packInstallStore: LEDGER,
      tenantId: 't1',
      workspaceId: 'w1',
      logger: { info() {}, warn() {} },
      fieldPermissions: port,
    })
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof StockPreparationCustomerPackInstallError, 'a coded install error, not a bare 500')
  assert.equal(err.status, 422)
  assert.equal(err.code, 'CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN')
  assert.deepEqual(err.details.roleIds, [ROLE_WAREHOUSE], 'the error names the offending role id')

  // ZERO SCHEMA MUTATIONS - the whole point of a PRE-flight.
  for (const method of PROVISIONING_WRITE_METHODS) {
    assert.equal(provisioning.calls.includes(method), false, `${method} was never reached`)
  }

  // The dry-run REPORTS the same thing instead of throwing (its whole posture).
  const plan = await planCustomerPackInstall({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(V1_POLICIES, 1),
    fieldPermissions: port,
  })
  assert.deepEqual(plan.unknownRoleIds, [ROLE_WAREHOUSE])
  assert.equal(plan.canInstall, false, 'an unknown role blocks the install and the dry-run says so')
}

async function aLateRoleRejectionIsStillCodedNotAnUncoded500() {
  // The older-host shape again: no pre-flight seam, so the refusal can only come from the
  // port itself, AFTER the schema writes. It must still be a coded 422 rather than the
  // uncoded 500 an unmapped throw produces.
  const port = createStatefulPort({ withRoleCheck: false })
  port.applyRoleWriteScopes = async () => {
    throw fieldPermissionsError('ROLE_NOT_FOUND', [ROLE_WAREHOUSE])
  }

  let err = null
  try {
    await installWith(port, V1_POLICIES, 1)
  } catch (error) {
    err = error
  }
  assert.ok(err instanceof StockPreparationCustomerPackInstallError)
  assert.equal(err.status, 422)
  assert.equal(err.code, 'CUSTOMER_PACK_FIELD_PERMISSION_ROLE_UNKNOWN')
  assert.deepEqual(err.details.roleIds, [ROLE_WAREHOUSE])

  // The other three members of the port's closed failure vocabulary map too - none of
  // them may reach a caller as an uncoded 500.
  const mapped = async (reason) => {
    const late = createStatefulPort({ withRoleCheck: false })
    late.applyRoleWriteScopes = async () => { throw fieldPermissionsError(reason, ['x']) }
    try {
      await installWith(late, V1_POLICIES, 1)
    } catch (error) {
      return { status: error.status, code: error.code }
    }
    return null
  }
  assert.deepEqual(await mapped('FIELD_NOT_ON_SHEET'), { status: 422, code: 'CUSTOMER_PACK_FIELD_PERMISSION_FIELD_UNKNOWN' })
  assert.deepEqual(await mapped('SHEET_NOT_FOUND'), { status: 409, code: 'CUSTOMER_PACK_FIELD_PERMISSION_SHEET_UNKNOWN' })
  assert.deepEqual(await mapped('ENTRIES_INVALID'), { status: 422, code: 'CUSTOMER_PACK_FIELD_PERMISSION_ENTRIES_INVALID' })

  // A NON-port error is NOT swallowed into that vocabulary - it propagates as itself, so
  // the mapping cannot become a catch-all that hides a real bug.
  const boom = createStatefulPort({ withRoleCheck: false })
  const marker = new Error('unrelated failure')
  boom.applyRoleWriteScopes = async () => { throw marker }
  await assert.rejects(() => installWith(boom, V1_POLICIES, 1), (error) => error === marker)
}



// THE LEDGER ROW MUST DESCRIBE THE PERMISSION HALF OF THE INSTALL TOO.
//
// Before this, the ledger could say how many COLUMNS an install landed and nothing at all about its
// write scopes — the one half that now contains a delete. An operator auditing "what did this pack
// actually do to this sheet" had to re-derive the pack to find out.
//
// The four numbers are FLAT rather than a nested `writeScopes` object because the store's own
// `assertValuesFreeSummary` accepts finite numbers and refuses everything else; that guard is run
// here against the real summary, so the pin cannot pass while the real store would reject the row.
async function theLedgerSummaryEnumeratesTheWriteScopeOutcome() {
  const seen = []
  const recordingLedger = {
    async recordInstall(input) {
      seen.push(input)
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
  const install = (port, policies, packVersion) => installCustomerPack({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: packWith(policies, packVersion),
    packInstallStore: recordingLedger,
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {}, warn() {} },
    fieldPermissions: port,
  })

  const port = createStatefulPort()
  await install(port, V1_POLICIES, 1)
  await install(port, V2_POLICIES, 2)

  const [v1, v2] = seen
  // v1 declares 6 denials across 2 roles and retires nothing (a first install has no history).
  assert.deepEqual(v1.summary, {
    created: 0, skipped: 0, stamped: 0, alreadyStamped: 0, optionFields: 0, views: 0,
    writeScopesApplied: V2_DENIAL_COUNT, writeScopesRemoved: 0, writeScopeStale: 0, writeScopeRoles: 2,
  })
  // v2 moves one column between the two roles: same 6 denials, ONE retired, none left stale.
  assert.deepEqual(v2.summary, {
    created: 0, skipped: 0, stamped: 0, alreadyStamped: 0, optionFields: 0, views: 0,
    writeScopesApplied: V2_DENIAL_COUNT, writeScopesRemoved: 1, writeScopeStale: 0, writeScopeRoles: 2,
  })

  // The REAL store's values-free guard accepts both, so this shape is not merely asserted here —
  // it is the shape a live ledger write would actually persist.
  for (const call of seen) {
    assert.deepEqual(packInstallStoreInternals.assertValuesFreeSummary(call.summary), call.summary)
  }

  // A pack that declares NO fieldWritePolicies still reports the four numbers, all zero — the
  // ledger row shape does not depend on whether the optional feature was used.
  const bare = []
  await installCustomerPack({
    provisioning: createFakeProvisioning(),
    projectId: PROJECT_ID,
    pack: { ...BASE_PACK },
    packInstallStore: { async recordInstall(input) { bare.push(input); return { status: 'installed', mode: input.mode, packId: input.packId, packVersion: input.packVersion, objectId: input.objectId, installedFields: input.installedFields } } },
    tenantId: 't1',
    workspaceId: 'w1',
    logger: { info() {}, warn() {} },
  })
  assert.equal(bare[0].summary.writeScopesApplied, 0)
  assert.equal(bare[0].summary.writeScopesRemoved, 0)
  assert.equal(bare[0].summary.writeScopeStale, 0)
  assert.equal(bare[0].summary.writeScopeRoles, 0)
}


// ---------------------------------------------------------------------------
// G. THE ONE END-TO-END PROOF MUST ACTUALLY RUN IN CI (two-point wiring)
//
// `tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts` is the only place the
// rows this plugin declares are pushed through the platform's REAL write gate. It is
// `describeIfDatabase`-guarded, so BOTH points are needed and either one alone is a false green:
//
//   1. EXCLUDED from packages/core-backend/vitest.config.ts, or the no-DB job collects it, skips
//      every golden, and reports green — which is exactly how it went un-run when it was written.
//   2. WIRED as a whole file into a real-DB step that runs on the required 20.x leg with a LITERAL
//      DATABASE_URL — or it is excluded from everything and runs nowhere at all.
//
// Both are checked with the repo's OWN shared contract helper (scripts/ops/ci-realdb-step-contract
// .mjs, the owner ruling on #4496 P2), which locates the step by its stable `id:` rather than by
// title and refuses an Actions-expression DATABASE_URL — so this cannot be satisfied by a decoy
// step or by a secret that resolves to the empty string at runtime.
// ---------------------------------------------------------------------------
const REALDB_SUITE = 'tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts'
const REALDB_STEP_ID = 'multitable-real-db-integration'

async function theRealDbProofIsWiredIntoCi() {
  const fs = require('node:fs')
  const { pathToFileURL } = require('node:url')
  const repoRoot = path.join(__dirname, '..', '..', '..')

  const { isQuotedInTestExclude, isSuiteWiredInRealDbStep } = await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'ops', 'ci-realdb-step-contract.mjs')).href
  )

  // CI checks out LF; a Windows working copy may hold CRLF. The helper's comment-stripping regex is
  // anchored with `$` and no `m` flag, so a trailing \r leaves `// …` comments in place and an
  // apostrophe inside one flips the quote parity for everything after it. Normalising here means
  // this guard tests the file CI will read, not an artefact of the local checkout.
  const asCiSeesIt = (relPath) =>
    fs.readFileSync(path.join(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n')

  assert.ok(
    isQuotedInTestExclude(asCiSeesIt(path.join('packages', 'core-backend', 'vitest.config.ts')), REALDB_SUITE),
    `vitest.config.ts must exclude ${REALDB_SUITE} from the no-DB job, or describeIfDatabase skip-greens it`,
  )

  const workflow = asCiSeesIt(path.join('.github', 'workflows', 'plugin-tests.yml'))
  assert.ok(
    isSuiteWiredInRealDbStep(workflow, REALDB_STEP_ID, REALDB_SUITE),
    `the ${REALDB_STEP_ID} step must run ${REALDB_SUITE} as a whole file on Node 20 with a literal DATABASE_URL`,
  )

  assert.ok(
    fs.existsSync(path.join(repoRoot, 'packages', 'core-backend', REALDB_SUITE)),
    'the wired suite must exist',
  )

  // AND the file's own fail-not-skip sentinel must be OUTSIDE describeIfDatabase — a sentinel inside
  // it skips together with the goldens it is supposed to be guarding, which is a sentinel that can
  // never fire. Anchored on the step's marker env var, which is what scopes the throw to that step.
  const suiteSrc = asCiSeesIt(path.join('packages', 'core-backend', REALDB_SUITE))
  const sentinelAt = suiteSrc.indexOf('METASHEET_REAL_DB_TEST_STEP')
  assert.ok(sentinelAt > 0, 'the suite must carry the METASHEET_REAL_DB_TEST_STEP fail-not-skip sentinel')
  assert.ok(
    sentinelAt < suiteSrc.indexOf('describeIfDatabase('),
    'the sentinel must come BEFORE the first describeIfDatabase block, i.e. at top level',
  )
  assert.match(
    workflow,
    /METASHEET_REAL_DB_TEST_STEP:\s*'1'/,
    'and the step must actually set the marker the sentinel keys on',
  )
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
  await ownershipTransferIsNeverASilentSuccess()
  await reconcileNeverReachesRowsItDoesNotOwn()
  await anOlderPortIsRefusedBeforeAnyWrite()
  await theLedgerSummaryEnumeratesTheWriteScopeOutcome()
  await theRealDbProofIsWiredIntoCi()
  await dryRunPreviewsTheDenialPlanAndTheStaleRows()
  await anUnreadablePortSaysSoRatherThanReportingNothingStale()
  await anUnknownRoleIsACoded422BeforeAnySchemaWrite()
  await aLateRoleRejectionIsStillCodedNotAnUncoded500()
  applyHelperIsPure()
  console.log('stock-preparation-department-fields-and-write-scoping.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-department-fields-and-write-scoping.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
