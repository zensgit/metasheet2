'use strict'

// MILESTONE 1 — a customer pack may install into the stock-preparation SANDBOX
// namespace, and the whole `ext_` chain follows it there.
//
// THE DEFECT THIS BATTERY PINS SHUT. Packs could only ever install onto the
// canonical object (`targetObjectId` was hardcoded to
// STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId and was not in PACK_KEYS), while
// apply refuses the canonical object unconditionally. The two sets were DISJOINT,
// so every appliable target had no `ext_` columns, the install-ledger lookup by
// `action.target.objectId` found nothing, the pack-aware writable band contained
// no `ext_` id, and a mapped value was dropped one layer before the write. No
// tenant `ext_` value could reach a sheet by any route.
//
// WHAT MAY NOT REGRESS, and each has its own case below:
//   1. The target is NEVER request-supplied. The old hardcode was itself a guard;
//      the replacement must keep the property, not merely the behaviour.
//   2. Canonical posture unchanged — canonical install still works, apply still
//      refuses the canonical object unconditionally.
//   3. Fail-closed — an unlisted / malformed sandbox objectId refuses with a
//      typed reason, and the namespace pattern is enforced.
//   4. The ledger, `derivePackAwarePlmWritableFields` and
//      `assertExtFieldMappingAgreesWithAction` all work for the sandbox target.
//
// No DB, no network. The host provisioning API and the install ledger are mocks
// that reproduce the semantics the production code depends on.
// Values-free: schema ids, ownership tokens and counts only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  StockPreparationCustomerPackError,
  normalizeCustomerPack,
  summarizeCustomerPackForEvidence,
  __internals: packInternals,
} = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))

const {
  StockPreparationCustomerPackCatalogError,
  createCustomerPackCatalog,
} = require(path.join(LIB, 'stock-preparation-customer-pack-catalog.cjs'))

const {
  installCustomerPack,
  planCustomerPackInstall,
} = require(path.join(LIB, 'stock-preparation-customer-pack-installer.cjs'))

const {
  assertSandboxObjectId,
  StockPreparationTargetProvisioningError,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const {
  derivePackAwarePlmWritableFields,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const {
  StockPreparationTableActionError,
  assertStockPrepApplySandboxAllowed,
  __internals: tableActionInternals,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const {
  normalizeExtFieldMapping,
} = require(path.join(LIB, 'stock-preparation-ext-field-mapping.cjs'))

const {
  loadPackInstalledFieldProperties,
} = require(path.join(LIB, 'stock-preparation-pack-installed-fields.cjs'))

const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_m1'
const PROJECT_ID = 'tenant-unit:integration-core'
const TENANT_ID = 'tenant-unit'
const SILENT_LOGGER = { info() {}, warn() {} }

// A synthetic pack. Deliberately NOT the factory-a sample, so a change to the
// sample cannot make these cases vacuous. One plm_system string column (the one
// a mapper may target) and one human_preserved column (the one it may not).
function sandboxPack(overrides = {}) {
  return {
    packId: 'sandbox-pack',
    packVersion: 1,
    label: 'Sandbox probe pack',
    targetObjectId: SANDBOX_OBJECT_ID,
    extensionFields: [
      { id: 'ext_probeSystem', label: '探针系统列', type: 'string', ownership: 'plm_system' },
      { id: 'ext_probeHuman', label: '探针人工列', type: 'number', ownership: 'human_preserved' },
    ],
    optionSets: [],
    roleViews: [],
    ...overrides,
  }
}

function assertPackReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof StockPreparationCustomerPackError,
    `${label}: expected StockPreparationCustomerPackError, got ${thrown && thrown.name}`,
  )
  assert.equal(thrown.reason, reason, `${label}: wrong reason`)
  return thrown
}

// ---------------------------------------------------------------------------
// Mock host provisioning, parameterized by objectId (the installer test's mock
// is hardwired to the canonical object; the whole point here is a different one).
// ---------------------------------------------------------------------------
function physicalFieldId(projectId, objectId, fieldId) {
  return `fld_${projectId}_${objectId}_${fieldId}`
}

function mergeJsonObjectLikeHost(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
    ) {
      out[key] = mergeJsonObjectLikeHost(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function createMockProvisioning({ objectId, sheetMissing = false } = {}) {
  const fieldsByPhysicalId = new Map()
  if (!sheetMissing) {
    for (const [order, field] of STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.entries()) {
      fieldsByPhysicalId.set(physicalFieldId(PROJECT_ID, objectId, field.id), {
        name: field.label,
        type: field.type,
        property: { stockPreparation: { ownership: field.ownership } },
        order,
      })
    }
  }
  const provisioning = {
    getFieldId: (projectId, obj, fieldId) => physicalFieldId(projectId, obj, fieldId),
    async findObjectSheet({ projectId, objectId: obj }) {
      if (sheetMissing || obj !== objectId) return null
      return { id: `sheet_${obj}`, baseId: 'base_unit', name: obj, description: null }
    },
    async readObjectFieldsContent({ projectId, objectId: obj, fieldIds }) {
      const out = {}
      for (const fieldId of fieldIds || []) {
        const row = fieldsByPhysicalId.get(physicalFieldId(projectId, obj, fieldId))
        if (!row) continue
        out[fieldId] = {
          name: row.name,
          type: row.type,
          property: JSON.parse(JSON.stringify(row.property || {})),
          order: row.order,
        }
      }
      return out
    },
    async ensureMissingObjectFields({ projectId, objectId: obj, fields }) {
      const addedFieldIds = []
      const skippedExistingFieldIds = []
      for (const [index, field] of (fields || []).entries()) {
        const id = physicalFieldId(projectId, obj, field.id)
        if (fieldsByPhysicalId.has(id)) {
          skippedExistingFieldIds.push(id)
          continue
        }
        fieldsByPhysicalId.set(id, {
          name: field.name,
          type: field.type,
          property: JSON.parse(JSON.stringify(field.property || {})),
          order: typeof field.order === 'number' ? field.order : index,
        })
        addedFieldIds.push(id)
      }
      return { addedFieldIds, skippedExistingFieldIds }
    },
    async patchObjectFieldProperty({ projectId, objectId: obj, fieldId, propertyPatch }) {
      const id = physicalFieldId(projectId, obj, fieldId)
      const row = fieldsByPhysicalId.get(id)
      if (!row) throw new Error(`mock: provisioned field not found: ${obj}.${fieldId}`)
      row.property = mergeJsonObjectLikeHost(row.property || {}, JSON.parse(JSON.stringify(propertyPatch)))
      return { id, sheetId: `sheet_${obj}`, name: row.name, type: row.type, property: row.property, order: row.order }
    },
    async ensureView({ projectId, sheetId, descriptor }) {
      return { id: `view_${descriptor.objectId}_${descriptor.id}`, sheetId, name: descriptor.name }
    },
    async ensureObject() {
      throw new Error('mock: ensureObject must never be called by the customer pack installer')
    },
  }
  return { provisioning, fieldsByPhysicalId }
}

// Mock install ledger with the production store's real identity semantics:
// upsert on (tenant, project, object, pack); listInstalledFieldIds reads on
// (tenant, project, object) only — the union across packs on that sheet.
function createMockPackInstallStore() {
  const rows = new Map()
  const key = (t, p, o, pk) => [t, p, o, pk].join(' ')
  return {
    rows,
    async recordInstall({ tenantId, projectId, objectId, packId, packVersion, mode, installedFields, summary, warnings }) {
      const row = {
        tenantId,
        projectId,
        objectId,
        packId,
        packVersion,
        mode,
        status: (warnings || []).length === 0 ? 'installed' : 'partial',
        installedFields,
        summary,
        warnings: warnings || [],
      }
      rows.set(key(tenantId, projectId, objectId, packId), row)
      return row
    },
    async listInstalledFieldIds({ tenantId, projectId, objectId }) {
      const fieldIds = new Set()
      const packIds = new Set()
      for (const row of rows.values()) {
        if (row.tenantId !== tenantId || row.projectId !== projectId || row.objectId !== objectId) continue
        if (row.status !== 'installed' && row.status !== 'partial') continue
        packIds.add(row.packId)
        for (const entry of row.installedFields || []) fieldIds.add(entry.fieldId)
      }
      return { fieldIds: [...fieldIds].sort(), packIds: [...packIds].sort() }
    },
  }
}

// ===========================================================================
// INVARIANT 3 — fail-closed on the target value itself.
// ===========================================================================
function unlistedAndMalformedTargetsAreRefused() {
  // The namespace pattern is enforced. Every one of these is OUTSIDE
  // `plm_stock_preparation_sandbox*` and must be refused, not coerced and not
  // silently defaulted back to the canonical object.
  const outsideNamespace = [
    'plm_stock_preparation_evil',
    'plm_stock_preparation_sandboxx',      // no separator: `sandboxx` is a different word
    'sandbox_plm_stock_preparation',
    'plm_stock_prep_sandbox',
    'other_object',
    'PLM_STOCK_PREPARATION_SANDBOX',       // case matters; the host folds nothing here
    '../plm_stock_preparation_sandbox',
    'plm_stock_preparation_main_sandbox',
  ]
  for (const targetObjectId of outsideNamespace) {
    const thrown = assertPackReason(
      () => normalizeCustomerPack(sandboxPack({ targetObjectId })),
      'PACK_TARGET_OBJECT_ID_INVALID',
      `unlisted target ${targetObjectId}`,
    )
    assert.equal(thrown.details.provisioningReason, 'not_sandbox_namespace', targetObjectId)
    assert.equal(thrown.details.field, 'pack.targetObjectId')
  }

  // Malformed SHAPES fail the same way — a non-string can never become a target.
  for (const targetObjectId of ['', '   ', 42, true, {}, [], { objectId: SANDBOX_OBJECT_ID }]) {
    assertPackReason(
      () => normalizeCustomerPack(sandboxPack({ targetObjectId })),
      'PACK_TARGET_OBJECT_ID_INVALID',
      `malformed target ${JSON.stringify(targetObjectId)}`,
    )
  }

  // The accepted shapes: the bare namespace and its `_` / `-` suffixed forms.
  for (const targetObjectId of [
    'plm_stock_preparation_sandbox',
    'plm_stock_preparation_sandbox_m1',
    'plm_stock_preparation_sandbox-a',
  ]) {
    const pack = normalizeCustomerPack(sandboxPack({ targetObjectId }))
    assert.equal(pack.targetObjectId, targetObjectId, `${targetObjectId} must be accepted`)
  }

  // Whitespace is trimmed by the shared validator rather than rejected — pinned
  // so the trim is a decision on the record, not an accident.
  assert.equal(
    normalizeCustomerPack(sandboxPack({ targetObjectId: `  ${SANDBOX_OBJECT_ID}  ` })).targetObjectId,
    SANDBOX_OBJECT_ID,
  )
}

// ===========================================================================
// INVARIANT 2 — the canonical posture is untouched.
// ===========================================================================
function canonicalPostureUnchanged() {
  // ABSENT targetObjectId is how a pack asks for the canonical sheet, exactly as
  // before this key existed.
  for (const value of [undefined, null]) {
    const pack = normalizeCustomerPack(sandboxPack({ targetObjectId: value }))
    assert.equal(pack.targetObjectId, CANONICAL_OBJECT_ID, 'absent target must mean canonical')
  }
  const { targetObjectId, ...withoutKey } = sandboxPack()
  assert.equal(normalizeCustomerPack(withoutKey).targetObjectId, CANONICAL_OBJECT_ID)

  // EXPLICIT canonical is REFUSED. Omission already says "canonical"; spelling the
  // canonical id out is not a second way to say it, it is the shape a redirection
  // attempt takes. The reason names the actual diagnosis.
  const thrown = assertPackReason(
    () => normalizeCustomerPack(sandboxPack({ targetObjectId: CANONICAL_OBJECT_ID })),
    'PACK_TARGET_OBJECT_ID_INVALID',
    'explicit canonical target',
  )
  assert.equal(thrown.details.provisioningReason, 'prod_canonical')

  // The shared validator is the one authority, and it agrees.
  assert.throws(
    () => assertSandboxObjectId(CANONICAL_OBJECT_ID),
    (error) => error instanceof StockPreparationTargetProvisioningError
      && error.code === 'TARGET_SANDBOX_OBJECT_ID_INVALID'
      && error.details.reason === 'prod_canonical',
  )

  // APPLY still refuses the canonical object UNCONDITIONALLY — before any policy
  // is read, and however generous the sandbox allowlist is.
  const generousPolicy = { enabled: true, allowedTargetObjectIds: [CANONICAL_OBJECT_ID, SANDBOX_OBJECT_ID] }
  for (const target of [
    { objectId: CANONICAL_OBJECT_ID, sheetId: 'sheet_x' },
    { sheetId: 'sheet_x' },            // omitted objectId defaults to canonical
    { objectId: '   ', sheetId: 'sheet_x' },
  ]) {
    assert.throws(
      () => assertStockPrepApplySandboxAllowed(target, generousPolicy),
      (error) => error instanceof StockPreparationTableActionError
        && error.status === 403
        && error.code === 'STOCK_PREP_APPLY_SANDBOX_ONLY'
        && error.details.reason === 'prod_canonical',
      `canonical apply must stay refused for ${JSON.stringify(target)}`,
    )
  }

  // ...and the sandbox target is appliable only when the APPLY allowlist names it.
  // Install authority (the pack catalog) and apply authority (the sandbox policy)
  // stay separate gates: installing columns somewhere does not make it writable.
  assert.throws(
    () => assertStockPrepApplySandboxAllowed(
      { objectId: SANDBOX_OBJECT_ID },
      { enabled: true, allowedTargetObjectIds: [] },
    ),
    (error) => error.details.reason === 'target_not_allowlisted',
    'a pack-installed sandbox target is still not appliable until the apply allowlist names it',
  )
  assert.doesNotThrow(() => assertStockPrepApplySandboxAllowed(
    { objectId: SANDBOX_OBJECT_ID },
    { enabled: true, allowedTargetObjectIds: [SANDBOX_OBJECT_ID] },
  ))
}

// ===========================================================================
// INVARIANT 1 — the target is never request-supplied.
// ===========================================================================
function targetIsServerHeldOnly() {
  // The catalog is the ONLY door a pack comes through, and it normalizes at
  // BUILD time — so a deployment that mis-declares a target fails at plugin
  // activation, not on a deployer's first install call.
  assert.throws(
    () => createCustomerPackCatalog({ packs: { 'sandbox-pack': sandboxPack({ targetObjectId: 'plm_stock_preparation_evil' }) } }),
    (error) => error instanceof StockPreparationCustomerPackCatalogError
      && error.status === 500
      && error.code === 'CUSTOMER_PACK_CATALOG_INVALID'
      && error.details.reason === 'PACK_TARGET_OBJECT_ID_INVALID',
    'a bad sandbox target must fail catalog build',
  )

  // A well-formed one builds, and the catalog hands back the server-held target.
  const catalog = createCustomerPackCatalog({ packs: { 'sandbox-pack': sandboxPack() } })
  assert.equal(catalog.get('sandbox-pack').targetObjectId, SANDBOX_OBJECT_ID)
  // An unlisted packId is refused — there is no route to a pack the server did
  // not configure, hence no route to a target it did not declare.
  assert.throws(
    () => catalog.get('not-configured'),
    (error) => error.status === 403 && error.code === 'CUSTOMER_PACK_NOT_ALLOWED',
  )

  // THE REQUEST-SUPPLIED ATTEMPT. The install route's body allowlist is the
  // single key `mode`. This restates the production allowlist and proves a
  // `targetObjectId` (or a whole `pack`) in a request body is refused — the
  // property the old hardcode was really protecting.
  const routesSource = require('node:fs').readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  const allowlist = /const VALID_CUSTOMER_PACK_INSTALL_BODY_KEYS = new Set\(\[([^\]]*)\]\)/.exec(routesSource)
  assert.ok(allowlist, 'the install body allowlist must still exist')
  const allowedKeys = [...allowlist[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(allowedKeys, ['mode'], 'the install route must accept ONLY `mode` in its body')
  for (const forbidden of ['pack', 'targetObjectId', 'objectId', 'projectId', 'tenantId']) {
    assert.equal(allowedKeys.includes(forbidden), false, `request body must never carry ${forbidden}`)
  }

  // And the route resolves the pack from the catalog by packId — it never
  // constructs one from the request.
  assert.ok(
    /customerPackCatalog\.get\(firstString\(requestParams\(req\)\.packId\)\)/.test(routesSource),
    'install must resolve the pack from the server-held catalog by packId',
  )
}

// ===========================================================================
// INVARIANT 4 — installer, ledger, writable band and mapping all follow the
// sandbox target.
// ===========================================================================
async function theWholeChainFollowsTheSandboxTarget() {
  const pack = normalizeCustomerPack(sandboxPack())
  const { provisioning, fieldsByPhysicalId } = createMockProvisioning({ objectId: SANDBOX_OBJECT_ID })
  const store = createMockPackInstallStore()

  // DRY RUN reports the sandbox object.
  const plan = await planCustomerPackInstall({ provisioning, projectId: PROJECT_ID, pack })
  assert.equal(plan.objectId, SANDBOX_OBJECT_ID)
  assert.deepEqual(plan.willCreateFieldIds, ['ext_probeHuman', 'ext_probeSystem'])

  // INSTALL lands the columns on the SANDBOX object, not the canonical one.
  const summary = await installCustomerPack({
    provisioning,
    projectId: PROJECT_ID,
    pack,
    logger: SILENT_LOGGER,
    packInstallStore: store,
    tenantId: TENANT_ID,
    workspaceId: 'workspace-default',
    mode: 'install',
  })
  assert.equal(summary.objectId, SANDBOX_OBJECT_ID)
  assert.equal(summary.createdFields.length, 2)
  for (const fieldId of ['ext_probeSystem', 'ext_probeHuman']) {
    assert.ok(
      fieldsByPhysicalId.has(physicalFieldId(PROJECT_ID, SANDBOX_OBJECT_ID, fieldId)),
      `${fieldId} must exist on the sandbox object`,
    )
    assert.equal(
      fieldsByPhysicalId.has(physicalFieldId(PROJECT_ID, CANONICAL_OBJECT_ID, fieldId)),
      false,
      `${fieldId} must NOT have landed on the canonical object`,
    )
  }

  // THE LEDGER keyed the row on the sandbox objectId...
  assert.equal(summary.ledger.objectId, SANDBOX_OBJECT_ID)
  assert.equal(summary.ledger.status, 'installed')
  // ...so the read-back lookup by `action.target.objectId` FINDS it. This is the
  // exact join that returned nothing before: install wrote canonical, apply read
  // sandbox.
  const installed = await loadPackInstalledFieldProperties({
    packInstallStore: store,
    provisioning,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    objectId: SANDBOX_OBJECT_ID,
    logger: SILENT_LOGGER,
  })
  assert.ok(Array.isArray(installed), 'the read-back seam must find the sandbox install')
  assert.deepEqual(installed.map((entry) => entry.fieldId).sort(), ['ext_probeHuman', 'ext_probeSystem'])

  // A lookup against the CANONICAL object still finds nothing — the install did
  // not leak across objects.
  assert.equal(
    await loadPackInstalledFieldProperties({
      packInstallStore: store,
      provisioning,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      objectId: CANONICAL_OBJECT_ID,
      logger: SILENT_LOGGER,
    }),
    undefined,
  )

  // THE WRITABLE BAND now contains the pack's plm_system `ext_` column and does
  // NOT contain its human one. Before the fix this band was template-only,
  // because `installed` above was undefined.
  const derived = derivePackAwarePlmWritableFields({
    templateFields: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields,
    installedFieldProperties: installed,
  })
  assert.equal(derived.packAware, true, 'the band must be pack-aware for the sandbox target')
  assert.ok(
    derived.plmWritableFieldIds.includes('ext_probeSystem'),
    'the pack plm_system column must be writable — this is the layer that used to drop the value',
  )
  assert.ok(derived.humanPreservedFieldIds.includes('ext_probeHuman'))
  assert.equal(derived.plmWritableFieldIds.includes('ext_probeHuman'), false, 'the human wall holds')
  assert.deepEqual(derived.unclassifiedPackFieldIds, [], 'every pack column must be classified')

  // THE MAPPING derives its own targetObjectId from the pack, so a sandbox pack
  // yields a sandbox mapping without anyone restating the id.
  const mapping = normalizeExtFieldMapping({
    mappingId: 'sandbox-probe',
    mappingVersion: 1,
    mappings: [{ sourceColumn: 'IdentityName', target: 'ext_probeSystem' }],
  }, { pack })
  assert.equal(mapping.targetObjectId, SANDBOX_OBJECT_ID)
  assert.deepEqual([...mapping.targetFieldIds], ['ext_probeSystem'])

  // The mapper's human wall still refuses the human column even on a sandbox pack.
  assert.throws(
    () => normalizeExtFieldMapping({
      mappingId: 'sandbox-human',
      mappingVersion: 1,
      mappings: [{ sourceColumn: 'IdentityName', target: 'ext_probeHuman' }],
    }, { pack }),
    (error) => error.reason === 'TARGET_HUMAN_OWNED',
  )

  // AGREEMENT between the durable half (action.extensionFieldIds) and the runtime
  // half (the mapping) holds against a sandbox action target.
  const sandboxAction = {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    extensionFieldIds: ['ext_probeSystem'],
    target: { objectId: SANDBOX_OBJECT_ID, sheetId: `sheet_${SANDBOX_OBJECT_ID}`, fieldIdMap: {} },
  }
  assert.doesNotThrow(() => tableActionInternals.assertExtFieldMappingAgreesWithAction(sandboxAction, mapping))

  // ...and an action that does NOT declare the column is refused, with the
  // sandbox objectId named in the values-free details. That refusal firing is the
  // gate a deployer must pass, not an accident.
  const undeclaring = { ...sandboxAction, extensionFieldIds: [] }
  assert.throws(
    () => tableActionInternals.assertExtFieldMappingAgreesWithAction(undeclaring, mapping),
    (error) => error instanceof StockPreparationTableActionError
      && error.status === 422
      && error.code === 'TARGET_SCHEMA_INCOMPLETE'
      && error.details.targetObjectId === SANDBOX_OBJECT_ID
      && error.details.undeclaredExtensionFields.includes('ext_probeSystem'),
  )

  // The fieldIdMap completeness gate covers the pack columns for the sandbox
  // target too: a declared `ext_` id with no physical binding refuses UP FRONT
  // rather than at the records-API boundary, per row.
  assert.throws(
    () => tableActionInternals.assertTargetFieldMapCompleteness({
      ...sandboxAction,
      target: {
        ...sandboxAction.target,
        // A non-empty map turns the gate on; the ext_ id is deliberately unbound.
        fieldIdMap: Object.fromEntries(
          STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]),
        ),
      },
    }),
    (error) => error.code === 'TARGET_SCHEMA_INCOMPLETE'
      && error.details.targetObjectId === SANDBOX_OBJECT_ID
      && error.details.missingExtensionFields.includes('ext_probeSystem'),
  )
}

// ===========================================================================
// The installer refuses a sandbox target whose sheet is not provisioned — the
// pack installer creates columns, never tables.
// ===========================================================================
async function absentSandboxSheetFailsClosed() {
  const pack = normalizeCustomerPack(sandboxPack())
  const { provisioning } = createMockProvisioning({ objectId: SANDBOX_OBJECT_ID, sheetMissing: true })
  await assert.rejects(
    () => installCustomerPack({
      provisioning,
      projectId: PROJECT_ID,
      pack,
      logger: SILENT_LOGGER,
      packInstallStore: createMockPackInstallStore(),
      tenantId: TENANT_ID,
    }),
    (error) => error.code === 'CUSTOMER_PACK_TARGET_ABSENT' || error.status === 409 || error.status === 404,
    'an unprovisioned sandbox target must fail closed, not be created here',
  )
}

// ===========================================================================
// Evidence stays values-free and reports the target it actually used.
// ===========================================================================
function evidenceReportsTheTarget() {
  const evidence = summarizeCustomerPackForEvidence(sandboxPack())
  assert.equal(evidence.targetObjectId, SANDBOX_OBJECT_ID)
  const serialized = JSON.stringify(evidence)
  // Ownership tokens, ids and counts only — no labels, no option values.
  assert.equal(serialized.includes('探针'), false, 'evidence must not carry column labels')
}

function internalsExposeTheNormalizer() {
  // The normalizer is reachable for targeted testing without going through a
  // whole pack, and it agrees with the pack-level behaviour.
  assert.equal(packInternals.normalizePackTargetObjectId(undefined), CANONICAL_OBJECT_ID)
  assert.equal(packInternals.normalizePackTargetObjectId(SANDBOX_OBJECT_ID), SANDBOX_OBJECT_ID)
  assert.ok(packInternals.PACK_KEYS.includes('targetObjectId'), 'targetObjectId must be an authorable pack key')
}

async function main() {
  unlistedAndMalformedTargetsAreRefused()
  canonicalPostureUnchanged()
  targetIsServerHeldOnly()
  await theWholeChainFollowsTheSandboxTarget()
  await absentSandboxSheetFailsClosed()
  evidenceReportsTheTarget()
  internalsExposeTheNormalizer()
  console.log('stock-preparation-pack-sandbox-target.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
