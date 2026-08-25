'use strict'

// THE WIRING, not the mapper.
//
// stock-preparation-ext-field-mapping.test.cjs already pins what the mapper DOES. This suite pins
// the only thing that makes any of it matter: that a real HTTP refresh route reaches it.
//
// #5118 shipped the mapper and gave `computeDryRun` an `extFieldMapping` parameter. No route-side
// wrapper passed it and `http-routes.cjs` did not contain the word, so "no production code produces
// an `ext_` value from any source" stayed true after the feature landed. The three assertions here
// are the ones that would have been red then:
//
//   1. ABSENT CONFIG IS INERT. A dry-run through the route produces no `ext_` key and a revision
//      identical to the same dry-run computed the pre-change way (with the parameter simply not
//      passed). "Inert" is asserted against that recomputation, not against a remembered constant.
//   2. CONFIGURED MAPPING REACHES A WRITTEN RECORD. Through the real routes, the real planner and
//      the real apply writer — an all-string legacy cell lands in the records API as a coerced
//      value under its PHYSICAL field id.
//   3. MALFORMED CONFIG THROWS AT ACTIVATION. Not on the first dry-run: route registration is where
//      a deployer finds out, matching the customer-pack catalog's posture exactly.
//
// Plus the reconciliation that the wiring must not be able to bypass: a mapping writing a column the
// ACTION config does not declare is refused before a single source row is read
// (`assertExtFieldMappingAgreesWithAction`).
//
// Hermetic and dependency-free: no DB, no network, no clock assertions, no filesystem writes. The
// customer pack is the REAL committed rehearsal pack, so a change to its ownership split shows up
// here as a failure rather than as agreeing drift on both sides. Values-free throughout: the only
// literals are schema ids, frozen reason tokens and synthetic cell text.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  dryRunStockPreparationAction,
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  EXT_FIELD_MAPPING_CONFIG_KEY,
  StockPreparationExtFieldMappingConfigError,
  createConfiguredExtFieldMapping,
  resolveExtFieldMappingConfig,
} = require(path.join(LIB, 'stock-preparation-ext-field-mapping-config.cjs'))
const {
  createCustomerPackCatalog,
} = require(path.join(LIB, 'stock-preparation-customer-pack-catalog.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  FACTORY_A_REHEARSAL_PACK,
} = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

// The literal the HOST writes onto server config (packages/core-backend/src/plugin-runtime-config.ts).
// Stated as a literal rather than taken from the module under test: importing the constant and then
// configuring with it is self-referential — it passes just as happily when the constant is mistyped
// and the capability is permanently dormant.
assert.equal(EXT_FIELD_MAPPING_CONFIG_KEY, 'stockPreparationExtFieldMapping')

const PACK = FACTORY_A_REHEARSAL_PACK
const PACK_ID = PACK.packId
const TENANT_ID = 'tenant_1'
const PROJECT_ID = `${TENANT_ID}:integration-core`
const OBJECT_ID = 'stockPreparationMain'
const SOURCE_SYSTEM_ID = 'plm_sql_source'
const SHEET_ID = 'sheet_stock_configured'

// The three targets this suite maps into. Read off the pack rather than restated, so a change to the
// pack's bands breaks the suite instead of silently agreeing with it.
const MAPPED_STRING = 'ext_designer'
const MAPPED_NUMBER = 'ext_parentSortNo'
const HUMAN_TARGET = PACK.extensionFields.find((field) => field.ownership === 'human_preserved').id
for (const [id, type] of [[MAPPED_STRING, 'string'], [MAPPED_NUMBER, 'number']]) {
  const declared = PACK.extensionFields.find((field) => field.id === id)
  assert.ok(declared, `${id} must be declared by the rehearsal pack`)
  assert.equal(declared.ownership, 'plm_system', `${id} must be plm_system in the pack`)
  assert.equal(declared.type, type, `${id} must be ${type} in the pack`)
}

const MAPPING_CONFIG = Object.freeze({
  packId: PACK_ID,
  mappingId: 'factory-a-legacy',
  mappingVersion: 1,
  mappings: [
    { sourceColumn: 'Designer', target: MAPPED_STRING },
    { sourceColumn: 'SortNo', target: MAPPED_NUMBER },
  ],
})

const READ_USER = Object.freeze({ id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const ADMIN_USER = Object.freeze({ id: 'user_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })

// ── fixtures ──────────────────────────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// The legacy source row, all-string exactly as the customer system stores it.
function sourceData(partOverrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{
      OBJ_ID: 'PART-A',
      IdentityNo: 'A-001',
      IdentityName: 'Assembly',
      Material: 'Steel',
      SysVer: 'V1',
      Designer: 'designer-one',
      SortNo: '10',
      ...partOverrides,
    }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data = sourceData()) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      return { records: matches.map(clone), nextCursor: null, done: true }
    },
  }
}

/**
 * Records-API spy.
 *
 * `calls` keeps the UN-CLONED payload alongside a defensive clone, and every negative assertion in
 * this file reads the un-cloned one. A `JSON.parse(JSON.stringify(...))` round trip DELETES keys
 * whose value is `undefined`, so a cloned payload cannot tell "no `ext_` key was produced" apart
 * from "an `ext_` key was produced with the value undefined" — which is exactly the distinction the
 * inertness proof rests on. Production is not affected (`createRow` merges only through
 * `isPlainObject(extValues)`), so this is test strength, not a bug being papered over.
 */
function createRecordsApi() {
  const rows = []
  const calls = []
  const record = (name, input) => calls.push([name, clone(input), input])
  return {
    calls,
    /** The payload as the route actually passed it — keys with undefined values still present. */
    rawPayload(name) {
      const call = calls.find(([callName]) => callName === name)
      assert.ok(call, `expected ${name} to have been called`)
      return call[2]
    },
    api: {
      async queryRecords(input = {}) {
        record('queryRecords', input)
        return rows.filter((row) => row.sheetId === input.sheetId).map(clone)
      },
      async createRecord(input = {}) {
        record('createRecord', input)
        const created = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(created)
        return clone(created)
      },
      async patchRecord(input = {}) {
        record('patchRecord', input)
        const row = rows.find((entry) => entry.id === input.recordId)
        row.version += 1
        row.data = { ...row.data, ...(input.changes || {}) }
        return clone(row)
      },
    },
  }
}

// The install ledger + host read-back the refresh routes use to resolve `installedFieldProperties`.
// Stanzas are the ones the pack installer stamps, restated (same discipline as the pack-aware
// refresh suite) so a silent change to the installer surfaces as a failure here.
function packStanza(ownership) {
  return {
    ownership,
    preserveOnRefresh: ownership === 'human_preserved',
    required: false,
    key: false,
    extension: true,
    packId: PACK.packId,
    packVersion: '1.0.0',
  }
}

function createPackInstallStore() {
  return {
    async listInstalledFieldIds() {
      return { fieldIds: PACK.extensionFields.map((field) => field.id) }
    },
  }
}

function createProvisioning() {
  return {
    async readObjectFieldsContent({ fieldIds }) {
      const out = {}
      for (const fieldId of fieldIds) {
        const declared = PACK.extensionFields.find((field) => field.id === fieldId)
        if (!declared) continue
        out[fieldId] = {
          name: fieldId,
          type: declared.type,
          property: { stockPreparation: packStanza(declared.ownership) },
          order: 10,
        }
      }
      return out
    },
    async findObjectSheet() { return { id: SHEET_ID, baseId: null, name: OBJECT_ID, description: null } },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function baseServices(sourceAdapter) {
  return {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) {
        return {
          id: input.id,
          tenantId: input.tenantId,
          name: 'Readonly PLM SQL',
          kind: 'data-source:sql-readonly',
          role: 'source',
          status: 'active',
          config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
        }
      },
    },
    adapterRegistry: {
      createAdapter() { return sourceAdapter },
      listAdapterKinds() { return [] },
    },
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationPackInstallStore: createPackInstallStore(),
  }
}

// Explicit physical bindings, so an `ext_` value in a written payload proves the MAP is what
// addresses the column (`mapFieldName` refuses to fall back for an `ext_` id under an explicit map).
function resolvedFieldIdMap(extensionFieldIds = []) {
  const map = Object.fromEntries(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, `fld_${field.id}`]))
  for (const id of extensionFieldIds) map[id] = `fld_${id}`
  return map
}

function actionConfig({ extensionFieldIds, explicitFieldMap = false } = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, kind: 'data-source:sql-readonly' },
    target: {
      sheetId: SHEET_ID,
      objectId: OBJECT_ID,
      ...(explicitFieldMap ? { fieldIdMap: resolvedFieldIdMap(extensionFieldIds) } : {}),
    },
    ...(extensionFieldIds ? { extensionFieldIds } : {}),
  }
}

function mount({ config = {}, sourceAdapter, records, provisioning } = {}) {
  const routes = new Map()
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: provisioning || createProvisioning(),
        records: records ? records.api : createRecordsApi().api,
      },
    },
    // `durable: true` is what the large-BOM job store demands before it accepts a job; the
    // small-BOM token/policy store ignores the flag entirely.
    storage: Object.assign(new Map(), { durable: true }),
    config,
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(sourceAdapter || createSourceAdapter()),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, context }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a body`)
  return res
}

const DRY_RUN_ROUTE = '/api/integration/table-actions/:actionId/dry-run'
const APPLY_ROUTE = '/api/integration/table-actions/:actionId/apply'
const ACTION_PARAMS = { actionId: PLM_STOCK_PREPARATION_ACTION_ID }

async function routeDryRun(routes, user = READ_USER) {
  return call(routes, 'POST', DRY_RUN_ROUTE, {
    user,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
}

// ── 1. absent config is inert, and the plan is what it was ───────────────────

async function absentConfigIsInertAndUnchanged() {
  const extensionFieldIds = [MAPPED_STRING, MAPPED_NUMBER]
  // The HARD version of "inert": the pack IS installed, its columns ARE declared by the action and
  // ARE bound to physical ids, and the planner's bands ARE pack-aware. The only thing missing is the
  // mapping — and that alone must be enough for nothing to fill an `ext_` column.
  const action = actionConfig({ extensionFieldIds, explicitFieldMap: true })
  const records = createRecordsApi()
  const { routes } = mount({
    config: {
      stockPreparationTableActions: [action],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
    },
    records,
  })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.status, 'ready')
  assert.equal('extFieldMapping' in res.body.data.evidence, false, 'evidence gains no key when no mapping is configured')

  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' }, confirm: { dryRunToken: res.body.data.dryRunToken } },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  // UN-CLONED: a JSON round trip would drop an `undefined`-valued key and make this pass vacuously.
  const written = records.rawPayload('createRecord').data
  assert.deepEqual(
    Object.keys(written).filter((key) => key.startsWith('fld_ext_')),
    [],
    'with no mapping configured, not one ext_ column is written — not even as an undefined value',
  )
  assert.equal(written.fld_componentCode, 'A-001', 'the canonical half is written exactly as before')

  // THE BASELINE. Recomputed the pre-change way: `dryRunStockPreparationAction` called WITHOUT the
  // `extFieldMapping` key at all — literally the call shape that shipped in #5118 — over the same
  // fixtures and the same pack-aware bands the route resolved. The revision is the plan's identity
  // (it is what apply's token gates on), so equality here is the "byte-identical plan" claim.
  const baseline = await dryRunStockPreparationAction({
    action,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: createSourceAdapter(),
    recordsApi: createRecordsApi().api,
    tokenStore: new Map(),
    policyStore: new Map(),
    installedFieldProperties: await createPackInstallStore().listInstalledFieldIds().then(async ({ fieldIds }) => {
      const content = await createProvisioning().readObjectFieldsContent({ fieldIds })
      return fieldIds.filter((id) => content[id]).map((id) => ({ fieldId: id, property: content[id].property }))
    }),
  })

  assert.equal(res.body.data.revision, baseline.revision, 'the wired route plans exactly what the unwired call planned')
  assert.deepEqual(res.body.data.counts, baseline.counts)
  assert.deepEqual(res.body.data.evidence, baseline.evidence, 'evidence is unchanged when no mapping is configured')
  assert.equal('extFieldMapping' in baseline.evidence, false)
}

// ── 2. a configured mapping reaches a written record, through the real stack ──

async function configuredMappingReachesTheWrittenRecord() {
  const extensionFieldIds = [MAPPED_STRING, MAPPED_NUMBER]
  const records = createRecordsApi()
  const { routes } = mount({
    config: {
      stockPreparationTableActions: [actionConfig({ extensionFieldIds, explicitFieldMap: true })],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG,
      // FOS-4b-3 P0: sandbox apply for the non-canonical suite target.
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
    },
    records,
  })

  const dry = await routeDryRun(routes)
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  assert.equal(dry.body.data.status, 'ready')

  // The evidence names the mapping and stays values-free: schema ids and coercion types only.
  const evidence = dry.body.data.evidence.extFieldMapping
  assert.ok(evidence, 'a configured mapping is named in the dry-run evidence')
  assert.equal(evidence.mappingId, MAPPING_CONFIG.mappingId)
  assert.equal(evidence.packId, PACK_ID)
  assert.deepEqual(evidence.targetFieldIds, [MAPPED_STRING, MAPPED_NUMBER])
  const evidenceText = JSON.stringify(dry.body.data.evidence)
  assert.equal(evidenceText.includes('designer-one'), false, 'evidence never carries a source cell')
  assert.equal(evidenceText.includes('A-001'), false)

  // THE PAYLOAD. Apply re-expands with the SAME mapping, matches the revision, and writes.
  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' }, confirm: { dryRunToken: dry.body.data.dryRunToken } },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.apply.counts.created, 1)

  const data = records.rawPayload('createRecord').data
  // The all-string legacy cell landed as a coerced value, under the PHYSICAL id.
  assert.equal(data[`fld_${MAPPED_STRING}`], 'designer-one')
  assert.equal(data[`fld_${MAPPED_NUMBER}`], 10)
  assert.equal(typeof data[`fld_${MAPPED_NUMBER}`], 'number', 'an all-string source lands as a real number')
  assert.equal(data.fld_componentCode, 'A-001', 'the canonical half still lands')
  // No logical id survives translation, and no human column ever enters a payload. Both are read off
  // the UN-CLONED payload so an undefined-valued key cannot hide behind a JSON round trip.
  assert.equal(Object.keys(data).some((key) => key.startsWith('ext_')), false, 'a logical ext_ id must not survive translation')
  assert.equal(Object.prototype.hasOwnProperty.call(data, `fld_${HUMAN_TARGET}`), false, 'a human column is never written by a refresh')
}

// ── 3. malformed config throws at ACTIVATION, not on the first dry-run ────────

function mountWithMapping(mapping, { packs = { [PACK_ID]: PACK } } = {}) {
  return mount({
    config: {
      stockPreparationTableActions: [actionConfig({ extensionFieldIds: [MAPPED_STRING, MAPPED_NUMBER] })],
      stockPreparationCustomerPacks: packs,
      [EXT_FIELD_MAPPING_CONFIG_KEY]: mapping,
    },
  })
}

function assertRegistrationRefuses(mapping, expected, label, options) {
  let thrown = null
  try {
    mountWithMapping(mapping, options)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: registration must throw`)
  assert.ok(
    thrown instanceof StockPreparationExtFieldMappingConfigError,
    `${label}: wrong error class (${thrown && thrown.name})`,
  )
  assert.equal(thrown.code, 'EXT_FIELD_MAPPING_CONFIG_INVALID', label)
  assert.equal(thrown.status, 500, label)
  if (expected) assert.equal(thrown.details.reason, expected, `${label}: wrong mapper reason`)
  // Values-free: a refusal names schema ids and frozen tokens, never a source cell or a label.
  assert.equal(JSON.stringify(thrown.details).includes('designer-one'), false, `${label}: refusal must be values-free`)
}

function withMapping(overrides) {
  return { ...MAPPING_CONFIG, ...overrides }
}

function malformedConfigFailsAtRegistration() {
  // Shape, before the pack is even consulted.
  assertRegistrationRefuses([MAPPING_CONFIG], null, 'an array is not a mapping object')
  assertRegistrationRefuses('factory-a-legacy', null, 'a string is not a mapping object')
  assertRegistrationRefuses(withMapping({ extraKey: true }), null, 'an unknown key is refused')
  assertRegistrationRefuses(withMapping({ packId: undefined }), null, 'a mapping must name its pack')

  // Authority: the pack allowlist is the only source of a pack.
  assertRegistrationRefuses(withMapping({ packId: 'not-configured' }), null, 'an unlisted packId is refused')
  assertRegistrationRefuses(MAPPING_CONFIG, null, 'no configured pack at all', { packs: {} })

  // The mapper's own refusals, carried through with their closed reason tokens intact.
  assertRegistrationRefuses(
    withMapping({ mappings: [{ sourceColumn: 'PrepDate', target: HUMAN_TARGET }] }),
    'TARGET_HUMAN_OWNED',
    'a human-owned target is refused',
  )
  assertRegistrationRefuses(
    withMapping({ mappings: [{ sourceColumn: 'IdentityNo', target: 'componentCode' }] }),
    'TARGET_IS_TEMPLATE_FIELD',
    'a frozen template column is refused',
  )
  assertRegistrationRefuses(
    withMapping({ mappings: [{ sourceColumn: 'Designer', target: 'ext_notInThePack' }] }),
    'TARGET_NOT_DECLARED_IN_PACK',
    'a target the pack does not declare is refused',
  )
  assertRegistrationRefuses(
    withMapping({
      mappings: [
        { sourceColumn: 'Designer', target: MAPPED_STRING },
        { sourceColumn: 'Designer', target: MAPPED_NUMBER },
      ],
    }),
    'SOURCE_COLUMN_DUPLICATE',
    'an order-sensitive config is refused',
  )
  assertRegistrationRefuses(withMapping({ mappingVersion: 0 }), 'MAPPING_VERSION_INVALID', 'an unversioned mapping is refused')
  assertRegistrationRefuses(withMapping({ mappings: [] }), 'MAPPINGS_INVALID', 'an empty mapping list is refused')

  // A VALID mapping registers, and is the branded object the expansion demands.
  const { routes } = mountWithMapping(MAPPING_CONFIG)
  assert.ok(routes.get(`POST ${DRY_RUN_ROUTE}`), 'a valid mapping registers the refresh routes')
}

// ── 4. the config resolver itself: absent is inert, present-but-wrong is not ──

function configResolverPosture() {
  assert.equal(resolveExtFieldMappingConfig(undefined), undefined)
  assert.equal(resolveExtFieldMappingConfig({}), undefined)
  assert.equal(resolveExtFieldMappingConfig({ [EXT_FIELD_MAPPING_CONFIG_KEY]: undefined }), undefined)
  assert.equal(resolveExtFieldMappingConfig({ [EXT_FIELD_MAPPING_CONFIG_KEY]: null }), undefined)
  // Present-but-not-an-object is NOT quietly treated as absent: "no mapping" and "the mapping is the
  // wrong kind of thing" are different deployments, and only the first may be inert.
  assert.throws(
    () => resolveExtFieldMappingConfig({ [EXT_FIELD_MAPPING_CONFIG_KEY]: 'factory-a-legacy' }),
    (error) => error instanceof StockPreparationExtFieldMappingConfigError,
  )

  const catalog = createCustomerPackCatalog({ packs: { [PACK_ID]: PACK } })
  assert.equal(createConfiguredExtFieldMapping({ config: {}, packCatalog: catalog }), null, 'no config -> no mapping')
  const mapping = createConfiguredExtFieldMapping({
    config: { [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG },
    packCatalog: catalog,
  })
  assert.equal(Object.isFrozen(mapping), true, 'the produced mapping is frozen')
  assert.equal(mapping.packId, PACK_ID)
  assert.equal(mapping.packVersion, PACK.packVersion)
  assert.deepEqual([...mapping.targetFieldIds], [MAPPED_STRING, MAPPED_NUMBER])
  // The pack reference is this module's key and must not leak into the mapper's own vocabulary.
  assert.equal(JSON.stringify(mapping).includes('"packId"'), true)
  assert.throws(
    () => createConfiguredExtFieldMapping({ config: { [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG } }),
    (error) => error instanceof StockPreparationExtFieldMappingConfigError,
    'a mapping cannot be built without the server-held catalog',
  )
}

// ── 5. the wiring cannot bypass the durable/runtime reconciliation ────────────

async function undeclaredExtensionColumnIsRefusedBeforeAnySourceRead() {
  let reads = 0
  const countingAdapter = {
    async read(input = {}) {
      reads += 1
      return createSourceAdapter().read(input)
    },
  }
  // The mapping is valid against the PACK, but the ACTION config declares no extension columns —
  // so the completeness gate never covered them and an `ext_` key would fail at the records API.
  const { routes } = mount({
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG,
    },
    sourceAdapter: countingAdapter,
  })

  const res = await routeDryRun(routes)
  assert.equal(res.statusCode, 422, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(res.body.error.details.undeclaredExtensionFields, [MAPPED_STRING, MAPPED_NUMBER])
  assert.equal(reads, 0, 'the reconciliation fires before a single source row is read')

  // Declaring only ONE of the two is still a refusal — the gate is per column, not per mapping.
  const partial = mount({
    config: {
      stockPreparationTableActions: [actionConfig({ extensionFieldIds: [MAPPED_STRING] })],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG,
    },
  })
  const partialRes = await routeDryRun(partial.routes)
  assert.equal(partialRes.statusCode, 422)
  assert.deepEqual(partialRes.body.error.details.undeclaredExtensionFields, [MAPPED_NUMBER])
}

// ── 6. a malformed legacy cell drops THAT cell, through the route ─────────────

async function oneUnparseableCellDoesNotCostTheRow() {
  const extensionFieldIds = [MAPPED_STRING, MAPPED_NUMBER]
  const records = createRecordsApi()
  const { routes } = mount({
    config: {
      stockPreparationTableActions: [actionConfig({ extensionFieldIds, explicitFieldMap: true })],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG,
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [OBJECT_ID] },
    },
    sourceAdapter: createSourceAdapter(sourceData({ SortNo: '10件' })),
    records,
  })

  const dry = await routeDryRun(routes)
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
  // The refusal reaches the values-free summary as a frozen type token, never as the cell.
  assert.ok(dry.body.data.evidence.expansion.errorTypes.includes('SOURCE_VALUE_NOT_A_NUMBER'))
  assert.equal(JSON.stringify(dry.body).includes('10件'), false, 'the refused cell never reaches a response')
  // A coercion refusal is a C2 rowError, and the planner turns EVERY rowError into a manual-confirm
  // decision alongside the row's own add. So the refresh is HELD until an operator accepts it — the
  // mapper's "drop the cell, keep the row" posture reaches the route as "tell the operator, then
  // keep the row", not as a silent partial write.
  assert.equal(dry.body.data.counts.manual_confirm, 1)
  assert.equal(dry.body.data.counts.add, 1)

  const applied = await call(routes, 'POST', APPLY_ROUTE, {
    user: ADMIN_USER,
    params: ACTION_PARAMS,
    body: {
      parameters: { projectNo: 'P-001' },
      confirm: { dryRunToken: dry.body.data.dryRunToken, acceptManualConfirmHold: true },
    },
  })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  // UN-CLONED, so "absent" cannot be confused with "present and undefined".
  const created = records.rawPayload('createRecord')
  assert.equal(created.data[`fld_${MAPPED_STRING}`], 'designer-one', 'the row still lands — one bad cell must not cost a component its PLM data')
  assert.equal(
    Object.prototype.hasOwnProperty.call(created.data, `fld_${MAPPED_NUMBER}`),
    false,
    'a refused cell is absent from the payload, never truncated into it and never written as undefined',
  )
}

// ── 7. the large-BOM path announces that it does NOT apply the mapping ───────
//
// That path supplies neither `extFieldMapping` nor `installedFieldProperties`, and the second
// omission is what makes the first dangerous: with template-only bands the planner leaves `ext_` out
// of the update patch entirely, and a patch does not blank what it omits — so whatever a previous
// SMALL-path refresh wrote SURVIVES while every canonical column around it moves to today's source.
// Stale-but-plausible, not absent. Nor is the path chosen by anyone: a slow source alone
// (`read_time_limit_exceeded`) moves an unchanged project from one path to the other.

const LARGE_BOM_START_ROUTE = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'
const DIVERGENCE_KEY = 'extFieldMappingConfiguredButNotAppliedOnThisPath'

async function largeBomPathAnnouncesTheDivergence() {
  const extensionFieldIds = [MAPPED_STRING, MAPPED_NUMBER]

  const configured = mount({
    config: {
      stockPreparationTableActions: [actionConfig({ extensionFieldIds })],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: MAPPING_CONFIG,
    },
  })
  const started = await call(configured.routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(started.statusCode, 202, JSON.stringify(started.body))
  const notice = started.body.data[DIVERGENCE_KEY]
  assert.ok(notice, 'a configured mapping must be announced as NOT applied on the large-BOM path')
  assert.deepEqual(notice, { mappingId: MAPPING_CONFIG.mappingId, mappingVersion: MAPPING_CONFIG.mappingVersion })
  // Values-free: an id and an integer, never a source cell or a column label.
  assert.equal(JSON.stringify(started.body).includes('designer-one'), false)

  // CONDITIONAL. With no mapping configured the payload must be byte-identical to one produced
  // before this key existed — that is what keeps the inertness guarantee provable rather than
  // asserted, and it is why the notice is not simply always present.
  const dormant = mount({ config: { stockPreparationTableActions: [actionConfig({ extensionFieldIds })] } })
  const dormantStart = await call(dormant.routes, 'POST', LARGE_BOM_START_ROUTE, {
    user: READ_USER,
    params: ACTION_PARAMS,
    body: { parameters: { projectNo: 'P-001' } },
  })
  assert.equal(dormantStart.statusCode, 202, JSON.stringify(dormantStart.body))
  assert.equal(
    Object.prototype.hasOwnProperty.call(dormantStart.body.data, DIVERGENCE_KEY),
    false,
    'an unconfigured deployment gains no key at all',
  )
  // And the two payloads differ ONLY by the notice — `jobId` aside, which is a fresh uuid per call.
  const withoutNotice = { ...started.body.data, jobId: 'fixed' }
  delete withoutNotice[DIVERGENCE_KEY]
  assert.deepEqual(
    withoutNotice,
    { ...dormantStart.body.data, jobId: 'fixed' },
    'the notice is the only difference the mapping makes on this path',
  )
}

// ── 8. `false` is a kill switch, not a malformed value ───────────────────────
//
// This module is built inside `createHandlers`, so a throw fails registration for the WHOLE plugin.
// The obvious way to write "leave it off" must therefore not be the one that takes everything down.

async function falseIsAnOffSwitchAndNotAFatalValue() {
  const off = mount({
    config: {
      stockPreparationTableActions: [actionConfig()],
      stockPreparationCustomerPacks: { [PACK_ID]: PACK },
      [EXT_FIELD_MAPPING_CONFIG_KEY]: false,
    },
  })
  const res = await routeDryRun(off.routes)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal('extFieldMapping' in res.body.data.evidence, false, 'false leaves the mapper switched off')

  // Everything else non-object is still fatal: "switched off" and "the wrong kind of thing" are
  // different deployments, and only the first may be silent.
  for (const value of ['', 'off', 0, true, []]) {
    assertRegistrationRefuses(value, null, `${JSON.stringify(value)} is not an off switch`)
  }
}

async function main() {
  await absentConfigIsInertAndUnchanged()
  await configuredMappingReachesTheWrittenRecord()
  malformedConfigFailsAtRegistration()
  configResolverPosture()
  await undeclaredExtensionColumnIsRefusedBeforeAnySourceRead()
  await oneUnparseableCellDoesNotCostTheRow()
  await largeBomPathAnnouncesTheDivergence()
  await falseIsAnOffSwitchAndNotAFatalValue()
}

main().then(() => {
  console.log('stock-preparation-ext-field-mapping-wiring.test.cjs OK')
}, (error) => {
  console.error(error)
  process.exit(1)
})
