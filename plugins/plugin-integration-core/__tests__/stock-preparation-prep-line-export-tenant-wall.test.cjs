'use strict'

// 按项目导出物料 — THE TENANT WALL ON THE READ SIDE OF THE SHEET THE 结转 WRITES.
//
// THE HOLE. The materials export reads the deployment-bound table-action target (`action.target`).
// That binding is DEPLOY-GLOBAL: `getTableAction` is keyed by actionId alone, and the persisted
// per-tenant source binding overrides only the source, never the target. The route resolved the
// caller's tenant through the host-vouched operator scope (#5445), but nothing between that scope
// and the records read asked whose sheet the binding named — so an operator of tenant B, whose scope
// resolved cleanly to tenant B, was served tenant A's material names and quantities, 200, by naming
// one of tenant A's project numbers. The carry route (#5459 line) closed exactly this on its WRITE
// side with `assertCarryTargetBelongsToTenant`; the READ side of the same sheet stayed open, and the
// export handler's own comment said so ("Making this route's target tenant-scoped is a separate
// change").
//
// THE FIX IS NOT A SECOND WALL. The export now runs THE SAME wall — one function,
// `assertStockPreparationTargetBelongsToTenant`, the same two facts gathered in the same order from
// the same host port, decided by the same `decideCarryTargetOwnership` — answering in its own
// PREP_LINE_EXPORT_TARGET_* vocabulary instead of the carry's CONFIRM_CARRY_*.
//
// WHAT THIS SUITE PINS (each has a RED witness — see the PR body's mutation table):
//   X-01 DEMO-MACHINE SHAPE STILL EXPORTS. The binding a live deployment runs today: a sheet the
//        tenant's own ensure provisioned (so the ownership REGISTRY names it), bound by hand, with an
//        action config that names no objectId (so it defaults to the canonical one) — i.e. the bound
//        sheetId is NOT the id derived for (this tenant, target.objectId). The registry alone must
//        carry it: 200, the workbook, and the derived-id fallback never even consulted.
//   X-02 OTHER TENANT REFUSED, ZERO READS. Same deployment, an operator of the OTHER tenant (a real
//        member — the scope resolves) is refused 409 PREP_LINE_EXPORT_TARGET_TENANT_MISMATCH with
//        ZERO records reads, no audit row, no workbook, no value in the body, values-free details.
//   X-03 PRE-REGISTRY INSTALL STILL EXPORTS. No registry row, but the bound sheetId IS the id derived
//        for (this tenant, target.objectId): the fallback carries it, exactly as on the carry.
//   X-04 A DERIVED id of ANOTHER tenant is not a pass for this one.
//   X-05 UNDECIDABLE (registry miss, no derivation on this host) refuses with its own code.
//   X-06 NO OWNERSHIP PORT is a typed 501, not a fail-open and not a generic 503.
//   X-07 THE PROJECT THE REGISTRY IS ASKED ABOUT comes from the VERIFIED scope, never the request.
//   X-08 ONE VERDICT, TWO VOCABULARIES: for every refusing state the export and the carry answer
//        with their own code family and never each other's.
//   X-09 STRUCTURE: the export handler calls the shared wall BEFORE the records read and does not
//        grow a private ownership check; http-routes.cjs asks the ownership port in exactly one place.
//
// Hermetic: no DB, no network, no xlsx. The real-registry, real-records witness of X-01/X-02/X-03 is
// packages/core-backend/tests/integration/stock-preparation-prep-line-export-tenant-wall-realdb.test.ts.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  CARRY_TARGET_OWNERSHIP_STATES,
  CARRY_TARGET_OWNERSHIP_REFUSAL_CODES,
  PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const {
  derivedSheetId,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const EXPORT_PATH = '/api/integration/stock-preparation/prep-lines/export'

const TENANT_A = 'tenant-wall-a'
const TENANT_B = 'tenant-wall-b'
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`

// A sheet tenant A's own ensure provisioned and the deployment was bound to BY HAND: its id is not
// the one derived for (STAGING_A, the canonical objectId) — the ONLY thing that attributes it to
// tenant A is the registry row.
const HAND_BOUND_SHEET = 'sheet_hand_bound_by_tenant_a_ensure'

const PROJECT_NO_A = 'PRJ-WALL-A'
// Canaries: tenant A's values, which tenant B's operator must never see.
const A_MATERIAL = 'ZZTENANTAMATERIALNAMEZZ'
const A_SPEC = 'ZZTENANTASPECZZ'

const OPERATOR_A = Object.freeze({ id: 'u_wall_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const OPERATOR_B = Object.freeze({ id: 'u_wall_op_b', tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const MEMBERSHIPS = Object.freeze({ u_wall_op_a: [TENANT_A], u_wall_op_b: [TENANT_B] })

let passed = 0
let failed = 0
async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
  }
}

// Every template column bound — the deploy-time completeness gate refuses anything less before the
// export is reached. Physical ids are tenant A's, because the bound sheet is tenant A's.
function fieldIdMapFor(stagingProjectId) {
  return Object.fromEntries(
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, physicalFieldId(stagingProjectId, MAIN_OBJECT_ID, field.id)]),
  )
}

function seededRows(stagingProjectId) {
  return [
    physicalRow(stagingProjectId, MAIN_OBJECT_ID, {
      projectNo: PROJECT_NO_A,
      active: true,
      componentCode: 'DWG-WALL-1',
      componentName: A_MATERIAL,
      componentSpec: A_SPEC,
      material: 'Q235B',
      totalQuantity: 3,
    }, 'rec_wall_a1'),
  ]
}

/**
 * One deployment. `boundSheet` is the deploy-global target; `objectId` is what the action config
 * names (`undefined` = the config omits it, and normalizeTarget defaults it to the canonical id —
 * the shape a hand-edited config has). `registry` is plugin_multitable_object_registry as
 * { sheetId: projectId }. `port` shapes the host provisioning surface:
 *   'full'        isSheetOwnedByProject + getObjectSheetId (a current host)
 *   'no-derive'   isSheetOwnedByProject only (a host exposing no derivation)
 *   'no-port'     a provisioning surface without the ownership port
 *   'none'        no provisioning surface at all
 */
function mount({ boundSheet = HAND_BOUND_SHEET, objectId, registry = { [HAND_BOUND_SHEET]: STAGING_A }, port = 'full', rowsStaging = STAGING_A } = {}) {
  const routes = new Map()
  const records = makeStrictRecordsApi({
    stagingProjectId: rowsStaging,
    objectIdBySheetId: { [boundSheet]: MAIN_OBJECT_ID },
    rowsBySheet: { [boundSheet]: seededRows(rowsStaging) },
  })
  const recordsReads = []
  const countingRecords = {
    async queryRecords(input) {
      recordsReads.push(input && input.sheetId)
      return records.queryRecords(input)
    },
    async createRecord() { throw new Error('unexpected records write: createRecord') },
    async patchRecord() { throw new Error('unexpected records write: patchRecord') },
  }
  const registryCalls = []
  const deriveCalls = []
  let provisioning
  if (port !== 'none') {
    provisioning = {
      async findObjectSheet() { throw new Error('unexpected provisioning read: findObjectSheet') },
      async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
    }
    if (port !== 'no-port') {
      provisioning.isSheetOwnedByProject = async (sheetId, projectId) => {
        registryCalls.push({ sheetId, projectId })
        return Object.prototype.hasOwnProperty.call(registry, sheetId) && registry[sheetId] === projectId
      }
    }
    if (port === 'full') {
      provisioning.getObjectSheetId = (projectId, derivedObjectId) => {
        deriveCalls.push({ projectId, objectId: derivedObjectId })
        return derivedSheetId(projectId, derivedObjectId)
      }
    }
  }
  const target = { sheetId: boundSheet, fieldIdMap: fieldIdMapFor(rowsStaging) }
  if (objectId !== undefined) target.objectId = objectId
  const auditAppends = []
  const xlsxCalls = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: provisioning ? { records: countingRecords, provisioning } : { records: countingRecords },
    },
    storage: new Map(),
    config: {
      stockPreparationTableActions: [{
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
        target,
      }],
    },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  services.stockPreparationXlsxExport = {
    async buildWorkbookBuffer(params) {
      xlsxCalls.push(params)
      return Buffer.from(JSON.stringify(params), 'utf8')
    },
  }
  // A seam modelling a REAL membership relation: each operator belongs to exactly one tenant, so a
  // refusal below is the WALL, never a scope refusal wearing its clothes.
  services.tenantPrincipalDirectory = {
    async verifyTenantMembership(input) {
      return { member: (MEMBERSHIPS[input && input.userId] || []).includes(input && input.tenantId) }
    },
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return { routes, recordsReads, registryCalls, deriveCalls, auditAppends, xlsxCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentBuffer: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

async function exportAs(harness, user, query = {}) {
  const handler = harness.routes.get(`GET ${EXPORT_PATH}`)
  assert.ok(handler, 'the export route is registered')
  const res = createResponse()
  await handler({ user, authenticatedTenantId: user.tenantId, body: {}, query: { projectNo: PROJECT_NO_A, ...query }, params: {} }, res)
  return res
}

// The route's sanitizer hands back null-prototype objects; compare their JSON shape.
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function everythingSent(res) {
  return [
    res.body === undefined ? '' : JSON.stringify(res.body),
    Buffer.isBuffer(res.sentBuffer) ? res.sentBuffer.toString('utf8') : '',
    JSON.stringify(res.headers),
  ].join('\n')
}

function assertRefusedWithZeroReads(harness, res, status, code) {
  assert.equal(res.statusCode, status, `expected ${status} ${code}, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`)
  assert.equal(res.body && res.body.error && res.body.error.code, code)
  assert.deepEqual(harness.recordsReads, [], 'refused before a single records read of the target sheet')
  assert.deepEqual(harness.auditAppends, [], 'no audit row for a read that never happened')
  assert.deepEqual(harness.xlsxCalls, [], 'no workbook built')
  const sent = everythingSent(res)
  assert.equal(sent.includes(A_MATERIAL), false, 'no material name in anything sent')
  assert.equal(sent.includes(A_SPEC), false, 'no spec in anything sent')
  assert.equal(/^CONFIRM_CARRY_/.test(res.body.error.code), false, 'the export answers in its OWN vocabulary, never a carry code')
}

function assertExported(harness, res) {
  assert.equal(res.statusCode, 200, `expected the export to succeed, got ${res.statusCode} ${JSON.stringify(res.body && res.body.error)}`)
  assert.ok(Buffer.isBuffer(res.sentBuffer), 'a workbook buffer was sent')
  const workbook = JSON.parse(res.sentBuffer.toString('utf8'))
  assert.ok(JSON.stringify(workbook.rows).includes(A_MATERIAL), 'the workbook carries the tenant\'s own material rows')
  assert.ok(harness.recordsReads.length > 0, 'the export DID read the bound sheet')
  assert.ok(harness.recordsReads.every((sheetId) => sheetId === harness.boundSheet), 'and only the bound sheet')
  assert.equal(harness.auditAppends.length, 1, 'one audit row')
}

async function main() {
  // Sanity on the fixture itself: the hand-bound sheet is derived for NOTHING this suite asks about,
  // so a pass on X-01 cannot be the derived-id fallback in disguise.
  for (const staging of [STAGING_A, STAGING_B]) {
    assert.notEqual(HAND_BOUND_SHEET, derivedSheetId(staging, MAIN_OBJECT_ID))
  }

  await run('X-01 demo-machine shape (registry hit, hand-bound, config names no objectId): the owning tenant exports', async () => {
    const harness = { ...mount(), boundSheet: HAND_BOUND_SHEET }
    const res = await exportAs(harness, OPERATOR_A)
    assertExported(harness, res)
    assert.deepEqual(harness.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_A }],
      'the registry is asked exactly once, about the bound sheet, for the caller\'s own staging project')
    assert.deepEqual(harness.deriveCalls, [], 'registry-proven: the derived-id fallback is never consulted')
  })

  await run('X-02 the OTHER tenant\'s operator is refused 409 with zero records reads (same deployment)', async () => {
    const harness = mount()
    const res = await exportAs(harness, OPERATOR_B)
    assertRefusedWithZeroReads(harness, res, 409, PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES[CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED])
    assert.equal(res.body.error.code, 'PREP_LINE_EXPORT_TARGET_TENANT_MISMATCH')
    // Values-free details: the public objectId and nothing else — no sheet id, no project id.
    assert.deepEqual(plain(res.body.error.details), { objectId: MAIN_OBJECT_ID })
    assert.equal(everythingSent(res).includes(HAND_BOUND_SHEET), false, 'the refusal names no sheet id')
    assert.equal(everythingSent(res).includes(STAGING_A), false, 'the refusal names no project id')
  })

  await run('X-03 pre-registry install (no registry row, bound sheet IS the derived id): the owning tenant exports', async () => {
    const legacySheet = derivedSheetId(STAGING_A, MAIN_OBJECT_ID)
    const harness = { ...mount({ boundSheet: legacySheet, objectId: MAIN_OBJECT_ID, registry: {} }), boundSheet: legacySheet }
    const res = await exportAs(harness, OPERATOR_A)
    assertExported(harness, res)
    assert.deepEqual(harness.deriveCalls, [{ projectId: STAGING_A, objectId: MAIN_OBJECT_ID }],
      'the fallback derived for the caller\'s own project and the target\'s own objectId')
  })

  await run('X-04 a sheet derived for ANOTHER tenant is not this tenant\'s (registry miss): refused, zero reads', async () => {
    const foreignDerived = derivedSheetId(STAGING_A, MAIN_OBJECT_ID)
    const harness = mount({ boundSheet: foreignDerived, objectId: MAIN_OBJECT_ID, registry: {} })
    const res = await exportAs(harness, OPERATOR_B)
    assertRefusedWithZeroReads(harness, res, 409, 'PREP_LINE_EXPORT_TARGET_TENANT_MISMATCH')
    assert.deepEqual(harness.deriveCalls, [{ projectId: STAGING_B, objectId: MAIN_OBJECT_ID }])
  })

  await run('X-05 registry miss on a host with no derivation: undecidable, refused with its own code, zero reads', async () => {
    const harness = mount({ registry: {}, port: 'no-derive' })
    const res = await exportAs(harness, OPERATOR_A)
    assertRefusedWithZeroReads(harness, res, 409, 'PREP_LINE_EXPORT_TARGET_OWNER_UNKNOWN')
  })

  await run('X-06 no ownership port: typed 501, never a fail-open read', async () => {
    for (const port of ['no-port', 'none']) {
      const harness = mount({ port })
      const res = await exportAs(harness, OPERATOR_A)
      assertRefusedWithZeroReads(harness, res, 501, 'PREP_LINE_EXPORT_PROVISIONING_UNAVAILABLE')
      assert.deepEqual(plain(res.body.error.details), { requiredMethods: ['isSheetOwnedByProject'] }, `${port}: names the missing port`)
    }
  })

  await run('X-07 the registry is asked about the VERIFIED tenant\'s project; a request tenantId cannot move it', async () => {
    // Tenant B's operator echoing tenant A's id is refused by the scope before the wall...
    const steered = mount()
    const refused = await exportAs(steered, OPERATOR_B, { tenantId: TENANT_A })
    assert.equal(refused.statusCode, 403)
    assert.deepEqual(steered.registryCalls, [], 'a steering attempt never reaches the registry')
    assert.deepEqual(steered.recordsReads, [])
    // ...and a legitimate compatibility echo of the caller's OWN tenant asks about the caller's own.
    const echoed = mount()
    const res = await exportAs(echoed, OPERATOR_B, { tenantId: TENANT_B })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(echoed.registryCalls, [{ sheetId: HAND_BOUND_SHEET, projectId: STAGING_B }])
  })

  await run('X-08 one verdict, two vocabularies: every refusing state maps to its own family on each route', async () => {
    const { assertStockPreparationTargetBelongsToTenant, STOCK_PREPARATION_TARGET_TENANT_WALLS } = httpRoutes.__internals
    const cases = [
      { state: CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED, provisioning: { async isSheetOwnedByProject() { return false }, getObjectSheetId: () => 'sheet_other' }, target: { sheetId: 'sheet_bound', objectId: MAIN_OBJECT_ID } },
      { state: CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE, provisioning: { async isSheetOwnedByProject() { return false } }, target: { sheetId: 'sheet_bound', objectId: MAIN_OBJECT_ID } },
      { state: CARRY_TARGET_OWNERSHIP_STATES.UNBOUND, provisioning: { async isSheetOwnedByProject() { return true } }, target: { sheetId: '', objectId: MAIN_OBJECT_ID } },
    ]
    for (const { state, provisioning, target } of cases) {
      for (const [wallName, codes] of [['carry', CARRY_TARGET_OWNERSHIP_REFUSAL_CODES], ['prepLineExport', PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES]]) {
        await assert.rejects(
          assertStockPreparationTargetBelongsToTenant({ provisioning, targetProjectId: STAGING_A, target, wall: STOCK_PREPARATION_TARGET_TENANT_WALLS[wallName] }),
          (error) => {
            assert.equal(error.status, 409)
            assert.equal(error.code, codes[state], `${wallName}/${state}`)
            return true
          },
        )
      }
      assert.match(CARRY_TARGET_OWNERSHIP_REFUSAL_CODES[state], /^CONFIRM_CARRY_/)
      assert.match(PREP_LINE_EXPORT_TARGET_OWNERSHIP_REFUSAL_CODES[state], /^PREP_LINE_EXPORT_/)
    }
    // The carry vocabulary is UNCHANGED by the extraction (the preflight and the runbook quote it).
    assert.deepEqual({ ...CARRY_TARGET_OWNERSHIP_REFUSAL_CODES }, {
      [CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED]: 'CONFIRM_CARRY_TARGET_TENANT_MISMATCH',
      [CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE]: 'CONFIRM_CARRY_TARGET_OWNER_UNKNOWN',
      [CARRY_TARGET_OWNERSHIP_STATES.UNBOUND]: 'CONFIRM_CARRY_TARGET_TENANT_MISMATCH',
    })
    assert.equal(STOCK_PREPARATION_TARGET_TENANT_WALLS.carry.portUnavailableCode, 'CONFIRM_CARRY_PROVISIONING_UNAVAILABLE')
    assert.equal(STOCK_PREPARATION_TARGET_TENANT_WALLS.prepLineExport.portUnavailableCode, 'PREP_LINE_EXPORT_PROVISIONING_UNAVAILABLE')
    // And both passing states pass on both routes.
    for (const wallName of ['carry', 'prepLineExport']) {
      await assertStockPreparationTargetBelongsToTenant({
        provisioning: { async isSheetOwnedByProject() { return true } },
        targetProjectId: STAGING_A,
        target: { sheetId: HAND_BOUND_SHEET, objectId: MAIN_OBJECT_ID },
        wall: STOCK_PREPARATION_TARGET_TENANT_WALLS[wallName],
      })
      await assertStockPreparationTargetBelongsToTenant({
        provisioning: { async isSheetOwnedByProject() { return false }, getObjectSheetId: (projectId, objectId) => derivedSheetId(projectId, objectId) },
        targetProjectId: STAGING_A,
        target: { sheetId: derivedSheetId(STAGING_A, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID },
        wall: STOCK_PREPARATION_TARGET_TENANT_WALLS[wallName],
      })
    }
  })

  await run('X-09 structure: the export handler runs the SHARED wall before the records read, and ownership is asked in one place', async () => {
    const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
    const start = source.indexOf('    async stockPreparationPrepLineExport(req, res) {')
    assert.ok(start > 0, 'found the export handler')
    const end = source.indexOf('\n    },\n', start)
    const body = source.slice(start, end)
    const wallAt = body.indexOf('await assertPrepLineExportTargetBelongsToTenant(')
    const readAt = body.indexOf('await exportStockPreparationPrepLines(')
    assert.ok(wallAt > 0, 'the export handler calls the shared wall')
    assert.ok(readAt > wallAt, 'and calls it BEFORE the records read')
    assert.equal(/isSheetOwnedByProject\(/.test(body), false, 'the handler grows no private ownership check')
    assert.equal(/getObjectSheetId\(/.test(body), false, 'nor a private derived-id check')
    // Code only (comment lines stripped): the ownership port is CALLED in exactly one place — the
    // shared wall — so the carry and the export cannot come to gather different facts.
    const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    assert.equal((code.match(/\.isSheetOwnedByProject\(/g) || []).length, 1, 'one ownership-port call site in http-routes.cjs')
    assert.ok(/function assertPrepLineExportTargetBelongsToTenant\([^)]*\) \{\n\s+return assertStockPreparationTargetBelongsToTenant\(/.test(code),
      'the export wrapper delegates to the shared wall')
    assert.ok(/function assertCarryTargetBelongsToTenant\([^)]*\) \{\n\s+return assertStockPreparationTargetBelongsToTenant\(/.test(code),
      'and so does the carry wrapper')
  })

  console.log(`\nstock-preparation-prep-line-export-tenant-wall: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('stock-preparation-prep-line-export-tenant-wall FAILED')
    process.exitCode = 1
    return
  }
  console.log('stock-preparation-prep-line-export-tenant-wall OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
