'use strict'

const freshProjectWriteLock = () => require('./support/stock-preparation-project-write-lock-kit.cjs').createInMemoryProjectWriteLock({ timers: 'real' }).lock

const { consumableMap } = require('./support/consumable-storage.cjs')

// #6475 fix round 2 — 批次存档 (mvp-persist, the project-sync panel's step ④) KEEPS WHAT THE SYNC
// WROTE, OR NOTHING; AND A BATCH ALREADY KEPT STAYS KEEPABLE WHEN ONLY THE SHEET MOVED.
//
// Through the real route table, the real planner, the real apply writer, the real snapshot persist and
// the panel's own request shapes: ① and ③ carry the page scope as a query, ④ carries none and hands back
// the two digests step ③ answered (`sourceScopeDigest` from round 1, `sourceContentDigest` from this
// round). The fake PLM is MUTABLE, so the source can change between ③ and ④, and the fake records API
// can refuse a chosen row's create, so ③ can be partial.
//
// CASES
//   B1 the source changes between ③ and ④ — a quantity (2→5), a part added, a part removed, a part's
//      identity. ④ with the apply's digests answers 409 STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH
//      {reason: source_changed_since_write} and stores nothing. Each leg first replays the round-1
//      panel shape (scope digest only) in a twin mount, which is the review's executed P1: it answered
//      201 and kept what the sheet does not hold (or, for the identity leg, NOT_READY).
//   B1s the source does NOT change, but a PLM-owned cell on the sheet was edited by hand after ③:
//      the content digest agrees, the recomputed plan does not settle → 409 {reason: sheet_not_settled,
//      pending: {add 0, update 1, inactive 0}}. Isolates the second half of the gate.
//   B2 ③ is partial (one of two creates refused). ④ with the digests: 409 sheet_not_settled with
//      pending.add 1 and nothing stored; the round-1 shape (review P3) answered 201 and archived the row
//      ③ failed to write. Once the refusal is gone, the next sync writes the row and ④ keeps the batch.
//   B3 a batch already kept stays keepable when only the sheet moved —
//      B3a default rule, one 备注 edit plus one people-owned `ext_` column: ④ answers 200
//          persisted:false and there is still ONE batch (review P2 stored a second identical one).
//      B3b creation-hour rule, the same edit: 200, one batch (review P2 answered 409 forever).
//      B3c creation-hour rule, a hand edit of a PLM cell that the next sync puts back (the sheet's
//          refresh stamps move): 200 persisted:false, `replayedUnderKeptRun`.
//      B3d creation-hour rule, review P4: a partial ③ archived by a direct call (no content digest),
//          then the next sync completes the write — ④ answers 200, and again on the sync after.
//   B4 nothing loosened —
//      B4a creation-hour rule, a corrected quantity in the same hour is still 409
//          PERSIST_IDEMPOTENCY_CONFLICT snapshot_batch/content_mismatch;
//      B4b creation-hour rule, a newer part added and then removed again: the content is an OLDER
//          batch while a newer one is kept — still refused, never passed off as kept;
//      B4c default rule, the same add-then-remove still keeps a third batch;
//      B4d no false refusals: an unchanged sync archives (201), the next one is already kept (200);
//      B4e the newest-batch read fails: the persist's own refusal stands (not a 500);
//      B4f a ledger conflict that is not this batch's run id (a duplicated project row) is never
//          replayed — the unit of work opens once;
//      B4g a deployment with a source→`ext_` mapping (the real rehearsal pack): ③ expands WITH the
//          mapping, ④ deliberately without it, and ④ still archives (201).
//   B5 the wire: the apply answers `sourceContentDigest` (32 lowercase hex) and never the raw revision;
//      a malformed digest on ④ is a 400 before any source is loaded.
//   B6 the two revisions on their own: the content revision ignores row order and every tenant `ext_`
//      key and moves with any other row value; the archive revision is byte-identical to the dry-run
//      revision for a sheet nobody typed into, ignores the people-owned columns, keeps the declared
//      `ext_` band and the refresh stamps.
//   B7 the newest-batch identity read on its own: admin only; null for no tables, no rows, a tied top
//      version, an unparseable version or a top row with no run id; another project's rows ignored.
//
// MUTATIONS this suite is calibrated against (in-memory, never on disk; each case run alone):
//   SY1  drop the content check in prepareStockPreparationMvpSnapshot         => B1 red
//   SY2  drop the settled-sheet check                                         => B1s B2 red
//   SY3  the apply stops answering `sourceContentDigest`                     => B1 … B5 red
//   SY4  the content revision keeps `ext_` keys                              => B4g B6 red
//   SY5  the route mints from `revision` instead of `archiveRevision`        => B3a B3b red
//   SY5b the archive revision strips nothing                                 => B3a B3b B6 red
//   SY5c … strips the human columns but no `ext_` column                     => B3a B6 red
//   SY5d … strips the declared `ext_` band too                               => B6 red
//   SY6  drop the kept-run replay after the persist's refusal                 => B3c B3d B4a red
//   SY6b replay after ANY idempotency conflict                               => B4f red
//   SY7  the identity read picks the oldest batch                            => B4b B7 red
//   SY7b replay without requiring the newest batch to be this batch id        => B4b red
//   SY7c surface the replay's own refusal instead of the original            => B4a red
//   SY7d let an identity-read failure propagate                              => B4e red
//   SY8  let a malformed content digest through as if absent                 => B5 red
//   SY9 / SY10 / SY11 the identity read ignores a tie / skips a bad version /
//        returns a row with no run id                                        => B7 red
//   SY12 mvp-persist stops forwarding the content digest to the prepare step => B1 B1s B2 red

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  stockPreparationSourceContentDigest,
  __internals: { buildArchiveRevision, buildRevision, buildSourceContentRevision },
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))
const { readNewestSnapshotBatchIdentity } = require(path.join(LIB, 'stock-preparation-snapshot-reads.cjs'))
// B4g: the REAL committed rehearsal pack, so its ownership split cannot drift from this suite.
const { FACTORY_A_REHEARSAL_PACK } = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

const MVP_PERSIST_GATE = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
const TENANT_ID = 'tenant_1'
const WS_PAGE = 'workspace_page'
const SOURCE_SYSTEM_ID = 'src_plm'
const CANONICAL_OBJECT_ID = 'stockPreparationMain'
const CANONICAL_SHEET_ID = `sheet_${CANONICAL_OBJECT_ID}`
const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
const PROJECT_NO = 'P-001'
const MVP_SHEET_IDS = Object.freeze([BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID].map((id) => `sheet_${id}`))
const PARITY = 'STOCK_PREPARATION_MVP_SYNC_PARITY_MISMATCH'
const DIGEST_SHAPE = /^[0-9a-f]{32}$/
// A tenant column the pack would declare human: not in the action's declared extension band.
const PEOPLE_EXT_COLUMN = 'ext_purchaseRemark'

// Synthetic parts. `hour` is the material creation time the creation-hour rule buckets on.
const PART = Object.freeze({
  A1: Object.freeze({ id: 'PART-1', code: 'A-1', qty: '2', hour: '2026-01-05 09:10:00' }),
  A2: Object.freeze({ id: 'PART-2', code: 'A-2', qty: '3', hour: '2026-01-05 09:20:00' }),
  A3: Object.freeze({ id: 'PART-3', code: 'A-3', qty: '1', hour: '2026-01-06 14:00:00' }),
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// ── the mutable PLM ───────────────────────────────────────────────────────────────────────────

function createSource(parts) {
  const state = { parts: parts.map((part) => ({ ...part })) }
  const tables = () => ({
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: state.parts.map((part, index) => ({
      order_id: 'ORDER-1', part_id: part.id, quantity: part.qty, sort_id: String((index + 1) * 10),
    })),
    DN_PDM_PartLibraryInfo: state.parts.map((part) => ({
      OBJ_ID: part.id, IdentityNo: part.code, IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Createtime: part.hour,
      // Two legacy columns only an ext mapping reads (B4g).
      Designer: 'designer-synthetic', SortNo: '10',
    })),
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  })
  return {
    state,
    adapter: {
      async read(input = {}) {
        const data = tables()
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        return { records: matches.map(clone), nextCursor: null, done: true }
      },
    },
    setQty(code, qty) { state.parts.find((part) => part.code === code).qty = qty },
    add(part) { state.parts.push({ ...part }) },
    remove(code) { state.parts = state.parts.filter((part) => part.code !== code) },
    recode(code, nextCode) { state.parts.find((part) => part.code === code).code = nextCode },
  }
}

// ── the records host: equality filters, a refusable create, the atomic unit of work ───────────

function createRecordsApi() {
  const sheets = new Map()
  const refuseCreate = new Set()
  const unitOfWork = { count: 0 }
  // `failHistoryRead`: the batch sheet refuses a read filtered by project ALONE — the shape only the
  // newest-batch identity read uses (the persist reads that sheet by batch id and by run id).
  const faults = { failHistoryRead: false }
  let seq = 0
  const sheetFor = (sheetId) => {
    if (!sheets.has(sheetId)) sheets.set(sheetId, new Map())
    return sheets.get(sheetId)
  }
  const api = {
    async queryRecords({ sheetId, filters, limit, offset } = {}) {
      const predicate = filters && typeof filters === 'object' ? filters : {}
      if (faults.failHistoryRead && sheetId === `sheet_${BATCH_OBJECT_ID}` && Object.keys(predicate).join() === 'projectId') {
        throw new Error('synthetic host failure')
      }
      const all = [...sheetFor(sheetId).values()]
        .filter((row) => Object.entries(predicate).every(([key, value]) => row.data[key] === value))
        .map((row) => ({ id: row.id, sheetId: row.sheetId, version: 1, data: { ...row.data } }))
      const start = Number.isInteger(offset) ? offset : 0
      return Number.isInteger(limit) ? all.slice(start, start + limit) : all.slice(start)
    },
    async createRecord({ sheetId, data } = {}) {
      if (sheetId === CANONICAL_SHEET_ID && data && refuseCreate.has(data.componentCode)) {
        throw new Error('validation failed: synthetic refusal')
      }
      seq += 1
      const id = `rec_${seq}`
      sheetFor(sheetId).set(id, { id, sheetId, data: { ...data } })
      return { id, sheetId, version: 1, data: { ...data } }
    },
    async patchRecord({ sheetId, recordId, changes } = {}) {
      const existing = sheetFor(sheetId).get(recordId)
      if (!existing) throw new Error(`patchRecord: unknown record ${recordId}`)
      const data = { ...existing.data, ...(changes || {}) }
      sheetFor(sheetId).set(recordId, { id: recordId, sheetId, data })
      return { id: recordId, sheetId, version: 2, data: { ...data } }
    },
    async runStockPreparationPersistUnitOfWork(_input, operation) {
      unitOfWork.count += 1
      return operation(api)
    },
  }
  return {
    api,
    refuseCreate,
    unitOfWork,
    faults,
    rows(sheetId) {
      return [...sheetFor(sheetId).values()].map((row) => ({ id: row.id, data: { ...row.data } }))
    },
    // A person typing into the sheet: no sync, no stamp.
    edit(code, changes) {
      const row = [...sheetFor(CANONICAL_SHEET_ID).values()].find((entry) => entry.data.componentCode === code)
      assert.ok(row, `edit: no sheet row for ${code}`)
      row.data = { ...row.data, ...changes }
    },
  }
}

function createProvisioning() {
  const identity = (fieldIds) => Object.fromEntries((Array.isArray(fieldIds) ? fieldIds : []).map((id) => [id, id]))
  return {
    // The installed pack's field stanzas, read back the way the refresh routes resolve the bands (B4g).
    async readObjectFieldsContent({ fieldIds } = {}) {
      const out = {}
      for (const fieldId of Array.isArray(fieldIds) ? fieldIds : []) {
        const declared = FACTORY_A_REHEARSAL_PACK.extensionFields.find((field) => field.id === fieldId)
        if (!declared) continue
        out[fieldId] = {
          name: fieldId,
          type: declared.type,
          property: {
            stockPreparation: {
              ownership: declared.ownership,
              preserveOnRefresh: declared.ownership === 'human_preserved',
              required: false,
              key: false,
              extension: true,
              packId: FACTORY_A_REHEARSAL_PACK.packId,
              packVersion: '1.0.0',
            },
          },
          order: 10,
        }
      }
      return out
    },
    getObjectSheetId(_projectId, objectId) {
      return `sheet_${objectId}`
    },
    async findObjectSheet({ objectId } = {}) {
      return { id: `sheet_${objectId}`, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async resolveExistingObjectFieldIds({ fieldIds } = {}) {
      return identity(fieldIds)
    },
    async ensureObject() {
      throw new Error('ensureObject must never be called on this path')
    },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function services(source, loads, { extMapping = false } = {}) {
  const system = (input = {}) => (input.id === SOURCE_SYSTEM_ID
    ? {
        id: input.id,
        tenantId: input.tenantId,
        name: 'Readonly PLM SQL',
        kind: 'data-source:sql-readonly',
        role: 'source',
        status: 'active',
        config: { dataSourceId: 'ds_plm', object: 'DN_PDM_PathExAttrInfo' },
      }
    : null)
  return {
    // Batch-refresh phase 0 step 1: apply holds the project write lease (fails closed 501 without the lock).
    stockPreparationProjectWriteLock: freshProjectWriteLock(),
    // SA-02: this legacy-path fixture explicitly models a reachable empty plan ledger.
    stockPreparationReadPlanStore: { async getActiveForRuntime() { return null } },
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
      async getExternalSystem(input = {}) { return system(input) },
      async getExternalSystemForAdapter(input = {}) {
        const found = system(input)
        return found ? { ...found, credentials: {} } : null
      },
    },
    adapterRegistry: {
      createAdapter() {
        loads.count += 1
        return source.adapter
      },
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
    stockPreparationAuditStore: { async append() { return { ok: true } } },
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    ...(extMapping
      ? {
          stockPreparationPackInstallStore: {
            async listInstalledFieldIds() {
              return { fieldIds: FACTORY_A_REHEARSAL_PACK.extensionFields.map((field) => field.id) }
            },
          },
        }
      : {}),
  }
}

// B4g: a deployment whose apply expands WITH a source→`ext_` mapping (mvp-persist never does).
const MAPPED_EXT = Object.freeze(['ext_designer', 'ext_parentSortNo'])
const EXT_MAPPING_CONFIG = Object.freeze({
  packId: FACTORY_A_REHEARSAL_PACK.packId,
  mappingId: 'synthetic-legacy',
  mappingVersion: 1,
  mappings: [
    { sourceColumn: 'Designer', target: MAPPED_EXT[0] },
    { sourceColumn: 'SortNo', target: MAPPED_EXT[1] },
  ],
})

function hourReadPlan() {
  return {
    ...clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN),
    part: { ...clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN.part), createTimeField: 'Createtime' },
    batchIdentity: { mode: 'material_create_hour' },
  }
}

function actionConfig({ hourRule = false, extMapping = false } = {}) {
  const fieldIds = extMapping ? [...TEMPLATE_FIELD_IDS, ...MAPPED_EXT] : TEMPLATE_FIELD_IDS
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: {
      externalSystemId: SOURCE_SYSTEM_ID,
      kind: 'data-source:sql-readonly',
      ...(hourRule ? { readPlan: hourReadPlan() } : {}),
    },
    target: {
      sheetId: CANONICAL_SHEET_ID,
      objectId: CANONICAL_OBJECT_ID,
      fieldIdMap: Object.fromEntries(fieldIds.map((id) => [id, id])),
    },
    ...(extMapping ? { extensionFieldIds: [...MAPPED_EXT] } : {}),
  }
}

function mount({ parts = [PART.A1], hourRule = false, extMapping = false } = {}) {
  const routes = new Map()
  const records = createRecordsApi()
  const source = createSource(parts)
  const loads = { count: 0 }
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: createProvisioning(), records: require('./support/stock-preparation-project-write-lock-kit.cjs').withFakeHostWriteFence(records.api) },
    },
    storage: consumableMap(),
    config: {
      stockPreparationTableActions: [actionConfig({ hourRule, extMapping })],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [CANONICAL_OBJECT_ID] },
      ...(extMapping
        ? {
            stockPreparationCustomerPacks: { [FACTORY_A_REHEARSAL_PACK.packId]: FACTORY_A_REHEARSAL_PACK },
            stockPreparationExtFieldMapping: EXT_MAPPING_CONFIG,
          }
        : {}),
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: services(source, loads, { extMapping }),
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, records, source, loads }
}

const ROUTE = Object.freeze({
  dryRun: '/api/integration/table-actions/:actionId/dry-run',
  apply: '/api/integration/table-actions/:actionId/apply',
  mvpPersist: '/api/integration/table-actions/:actionId/mvp-persist',
})
const ACTION_PARAMS = Object.freeze({ actionId: PLM_STOCK_PREPARATION_ACTION_ID })

function adminUser() {
  return {
    id: 'user_admin',
    tenantId: TENANT_ID,
    roles: ['admin'],
    permissions: ['integration:admin', 'stock-prep:read', 'stock-prep:operate'],
  }
}

async function call(routes, routePath, { body = {}, query = {} } = {}) {
  const handler = routes.get(`POST ${routePath}`)
  assert.ok(handler, `route POST ${routePath} is registered`)
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
  try {
    await handler({ user: adminUser(), authenticatedTenantId: TENANT_ID, body, query, params: ACTION_PARAMS }, res)
  } catch (error) {
    res.statusCode = error && error.status ? error.status : 500
    res.body = { ok: false, error: { code: error && error.code ? error.code : 'THREW', message: error && error.message, details: error && error.details ? clone(error.details) : undefined } }
  }
  assert.notEqual(res.body, undefined, `POST ${routePath} produced a body`)
  return res
}

const pageQuery = () => ({ tenantId: TENANT_ID, workspaceId: WS_PAGE })
const pull = () => ({ parameters: { projectNo: PROJECT_NO } })

// ① + ③ in the panel's shapes. Returns ③'s answer.
async function write(h, { expectStatus = 'succeeded' } = {}) {
  const planned = await call(h.routes, ROUTE.dryRun, { body: pull(), query: pageQuery() })
  assert.equal(planned.statusCode, 200, `① dry-run: ${JSON.stringify(planned.body)}`)
  assert.equal(planned.body.data.status, 'ready', `① control: ready (${JSON.stringify(planned.body.data.counts)})`)
  const applied = await call(h.routes, ROUTE.apply, {
    body: { ...pull(), confirm: { dryRunToken: planned.body.data.dryRunToken } },
    query: pageQuery(),
  })
  assert.equal(applied.statusCode, 200, `③ apply: ${JSON.stringify(applied.body)}`)
  assert.equal(applied.body.data.status, expectStatus, `③ control: ${expectStatus}`)
  return applied.body.data
}

// ④. `shape`: 'panel' (both digests — this round's panel), 'scope' (round 1's panel: the scope digest
// only), 'none' (a direct call).
async function archive(h, applied, shape = 'panel') {
  const body = { ...pull() }
  if (shape === 'panel' || shape === 'scope') body.sourceScopeDigest = applied.sourceScopeDigest
  if (shape === 'panel') body.sourceContentDigest = applied.sourceContentDigest
  return call(h.routes, ROUTE.mvpPersist, { body, query: {} })
}

async function sync(h, shape = 'panel') {
  const applied = await write(h)
  return archive(h, applied, shape)
}

function sheetParts(h) {
  return h.records.rows(CANONICAL_SHEET_ID).map((row) => `${row.data.componentCode}x${row.data.rawQuantity}`).sort()
}

function archivedParts(h) {
  return h.records.rows(`sheet_${LINE_OBJECT_ID}`).map((row) => `${row.data.childDrawingNo}x${row.data.designQty}`).sort()
}

function batchCount(h) {
  return h.records.rows(`sheet_${BATCH_OBJECT_ID}`).length
}

function snapshotRowCount(h) {
  return MVP_SHEET_IDS.reduce((total, sheetId) => total + h.records.rows(sheetId).length, 0)
}

function assertStatus(res, status, label) {
  assert.equal(res.statusCode, status, `${label}: HTTP ${status} (got ${res.statusCode} ${JSON.stringify(res.body && (res.body.error || res.body.data && res.body.data.status))})`)
}

function assertParity(res, reason, label) {
  assertStatus(res, 409, label)
  assert.equal(res.body.error.code, PARITY, `${label}: the typed parity code`)
  assert.equal(res.body.error.details.reason, reason, `${label}: reason ${reason}`)
}

// ── B1 ───────────────────────────────────────────────────────────────────────────────────────

const SOURCE_CHANGES = Object.freeze([
  { label: 'a quantity 2→5', parts: [PART.A1], change: (s) => s.setQty('A-1', '5'), roundOne: 201 },
  { label: 'a part added', parts: [PART.A1], change: (s) => s.add(PART.A3), roundOne: 201 },
  { label: 'a part removed', parts: [PART.A1, PART.A2], change: (s) => s.remove('A-2'), roundOne: 201 },
  { label: 'a part re-coded (identity)', parts: [PART.A1], change: (s) => s.recode('A-1', 'A-1R'), roundOne: 409 },
])

async function b1SourceChangedBetweenWriteAndArchive() {
  for (const leg of SOURCE_CHANGES) {
    // The review's executed P1, in a twin mount: round 1's panel shape (no content digest).
    const twin = mount({ parts: leg.parts })
    const twinApplied = await write(twin)
    leg.change(twin.source)
    const roundOne = await archive(twin, twinApplied, 'scope')
    assertStatus(roundOne, leg.roundOne, `B1 ${leg.label}, round-1 shape (control)`)
    if (leg.roundOne === 201) {
      assert.notDeepEqual(archivedParts(twin), sheetParts(twin), `B1 ${leg.label} control: round 1 kept what the sheet does not hold`)
    } else {
      assert.equal(roundOne.body.error.code, 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', `B1 ${leg.label} control: round 1 said NOT_READY`)
    }

    const h = mount({ parts: leg.parts })
    const applied = await write(h)
    assert.match(applied.sourceContentDigest, DIGEST_SHAPE, `B1 ${leg.label}: the apply answers the content digest`)
    leg.change(h.source)
    assertParity(await archive(h, applied), 'source_changed_since_write', `B1 ${leg.label}`)
    assert.equal(snapshotRowCount(h), 0, `B1 ${leg.label}: nothing stored`)
  }
}

// ── B1s ──────────────────────────────────────────────────────────────────────────────────────

async function b1sSheetEditedAfterTheWrite() {
  const h = mount({ parts: [PART.A1] })
  const applied = await write(h)
  h.records.edit('A-1', { rawQuantity: 7, totalQuantity: 7 })
  const res = await archive(h, applied)
  assertParity(res, 'sheet_not_settled', 'B1s')
  assert.deepEqual({ ...res.body.error.details.pending }, { add: 0, update: 1, inactive: 0 }, 'B1s: one row still to update, counts only')
  assert.equal(snapshotRowCount(h), 0, 'B1s: nothing stored')
}

// ── B2 ───────────────────────────────────────────────────────────────────────────────────────

async function b2PartialWriteIsNotArchived() {
  // The review's executed P3, in a twin mount: round 1's panel shape after a partial ③.
  const twin = mount({ parts: [PART.A1, PART.A2] })
  twin.records.refuseCreate.add('A-2')
  const twinApplied = await write(twin, { expectStatus: 'partial' })
  assert.deepEqual([twinApplied.apply.counts.created, twinApplied.apply.counts.failed], [1, 1], 'B2 control: created 1, failed 1')
  const roundOne = await archive(twin, twinApplied, 'scope')
  assertStatus(roundOne, 201, 'B2 round-1 shape (control)')
  assert.ok(archivedParts(twin).some((part) => part.startsWith('A-2x')), 'B2 control: round 1 archived the row ③ failed to write')
  assert.ok(!sheetParts(twin).some((part) => part.startsWith('A-2x')), 'B2 control: …which is not on the sheet')

  const h = mount({ parts: [PART.A1, PART.A2] })
  h.records.refuseCreate.add('A-2')
  const applied = await write(h, { expectStatus: 'partial' })
  const res = await archive(h, applied)
  assertParity(res, 'sheet_not_settled', 'B2')
  assert.deepEqual({ ...res.body.error.details.pending }, { add: 1, update: 0, inactive: 0 }, 'B2: the row ③ failed is still to add')
  assert.equal(snapshotRowCount(h), 0, 'B2: nothing stored')

  // The refusal clears; the next sync writes the row and keeps the batch the sheet now holds.
  h.records.refuseCreate.clear()
  const next = await sync(h)
  assertStatus(next, 201, 'B2 next sync')
  assert.deepEqual(archivedParts(h), sheetParts(h), 'B2 next sync: the batch is what the sheet holds')
}

// ── B3 ───────────────────────────────────────────────────────────────────────────────────────

async function assertAlreadyKept(h, label, { replayed = false } = {}) {
  const res = await sync(h)
  assertStatus(res, 200, label)
  assert.equal(res.body.data.persisted, false, `${label}: nothing new stored`)
  assert.equal(res.body.data.status, 'skipped_existing', `${label}: already kept`)
  assert.equal(res.body.data.replayedUnderKeptRun === true, replayed, `${label}: replayedUnderKeptRun ${replayed}`)
  assert.equal(batchCount(h), 1, `${label}: still one batch`)
}

async function b3aDefaultRuleNotesEdit() {
  const h = mount({ parts: [PART.A1] })
  assertStatus(await sync(h), 201, 'B3a first sync')
  h.records.edit('A-1', { notes: 'synthetic remark', [PEOPLE_EXT_COLUMN]: 'synthetic' })
  await assertAlreadyKept(h, 'B3a after a 备注 edit (default rule)')
}

async function b3bHourRuleNotesEdit() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  const first = await sync(h)
  assertStatus(first, 201, 'B3b first sync')
  assert.equal(first.body.data.batchIdentity.mode, 'material_create_hour', 'B3b control: the hour rule is in effect')
  h.records.edit('A-1', { notes: 'synthetic remark' })
  await assertAlreadyKept(h, 'B3b after a 备注 edit (creation-hour rule)')
}

async function b3cHourRuleSheetRewrittenBack() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  assertStatus(await sync(h), 201, 'B3c first sync')
  h.records.edit('A-1', { rawQuantity: 7, totalQuantity: 7 })
  // ① plans an UPDATE back to the source value; ③ writes it (new refresh stamps); ④ is unchanged content.
  await assertAlreadyKept(h, 'B3c after the sync put a hand-edited PLM cell back', { replayed: true })
}

async function b3dHourRulePartialThenCompleted() {
  const h = mount({ parts: [PART.A1, PART.A2], hourRule: true })
  h.records.refuseCreate.add('A-2')
  const partial = await write(h, { expectStatus: 'partial' })
  // A direct call (no content digest) archives the source as it is — what review P4 started from.
  assertStatus(await archive(h, partial, 'scope'), 201, 'B3d direct archive after the partial write')
  h.records.refuseCreate.clear()
  await assertAlreadyKept(h, 'B3d the sync that completes the write', { replayed: true })
  // The kept run id came from the partial-era sheet, so every later archive of this content is the
  // same replay — and stays a 200, never the review's permanent 409.
  await assertAlreadyKept(h, 'B3d the sync after that', { replayed: true })
}

// ── B4 ───────────────────────────────────────────────────────────────────────────────────────

async function b4aHourRuleCorrectionInTheSameHourStillRefused() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  assertStatus(await sync(h), 201, 'B4a first sync')
  h.source.setQty('A-1', '5')
  const before = h.records.unitOfWork.count
  const res = await sync(h)
  assertStatus(res, 409, 'B4a corrected quantity, same hour')
  assert.equal(res.body.error.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
  // The ORIGINAL refusal, not the replay's own (which would name the differing snapshot_line).
  assert.deepEqual({ target: res.body.error.details.target, reason: res.body.error.details.reason }, { target: 'snapshot_batch', reason: 'content_mismatch' })
  assert.equal(h.records.unitOfWork.count - before, 2, 'B4a: the persist, then one replay under the kept run, which refused')
  assert.equal(batchCount(h), 1, 'B4a: the kept batch is untouched')
}

async function b4fOtherLedgerConflictsAreNotReplayed() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  assertStatus(await sync(h), 201, 'B4f first sync')
  // A duplicated project ledger row: a conflict that is not about this batch's run id.
  const [projectRow] = h.records.rows(`sheet_${PROJECT_OBJECT_ID}`)
  await h.records.api.createRecord({ sheetId: `sheet_${PROJECT_OBJECT_ID}`, data: projectRow.data })
  h.records.edit('A-1', { rawQuantity: 7, totalQuantity: 7 })
  const before = h.records.unitOfWork.count
  const res = await sync(h)
  assertStatus(res, 409, 'B4f duplicated project ledger row')
  assert.deepEqual([res.body.error.code, res.body.error.details.target, res.body.error.details.reason], ['PERSIST_IDEMPOTENCY_CONFLICT', 'project', 'duplicate_key'])
  assert.equal(h.records.unitOfWork.count - before, 1, 'B4f: only a snapshot_batch/content_mismatch refusal is ever replayed')
}

async function b4gExtMappingDeploymentIsNotRefused() {
  const h = mount({ parts: [PART.A1, PART.A2], extMapping: true })
  const applied = await write(h)
  const written = h.records.rows(CANONICAL_SHEET_ID)
  assert.ok(written.every((row) => row.data[MAPPED_EXT[0]] === 'designer-synthetic'),
    'B4g control: the apply expanded WITH the mapping (the ext_ column is on the sheet)')
  const res = await archive(h, applied)
  assertStatus(res, 201, 'B4g: the archive (no mapping) agrees with the write (mapping) on content')
  assert.deepEqual(archivedParts(h), sheetParts(h), 'B4g: the batch is what ③ wrote')
}

async function b4eHistoryReadFailureKeepsTheOriginalRefusal() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  assertStatus(await sync(h), 201, 'B4e first sync')
  h.source.setQty('A-1', '5')
  h.records.faults.failHistoryRead = true
  const res = await sync(h)
  assertStatus(res, 409, 'B4e the identity read failed: the persist refusal stands')
  assert.equal(res.body.error.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
  assert.equal(res.body.error.details.target, 'snapshot_batch')
}

async function b4bHourRuleBackToAnOlderBatchStillRefused() {
  const h = mount({ parts: [PART.A1], hourRule: true })
  assertStatus(await sync(h), 201, 'B4b A')
  h.source.add(PART.A3)
  assertStatus(await sync(h), 201, 'B4b B (a newer part: a newer hour, a new batch)')
  h.source.remove('A-3')
  const before = h.records.unitOfWork.count
  const res = await sync(h)
  assertStatus(res, 409, 'B4b back to A while B is the newest kept batch')
  assert.equal(h.records.unitOfWork.count - before, 1, 'B4b: the newest batch is another one, so no replay is even tried')
  assert.equal(res.body.error.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
  assert.equal(res.body.data, undefined, 'B4b: not answered as already kept')
  assert.equal(batchCount(h), 2)
}

async function b4cDefaultRuleBackAndForthKeepsItsHistory() {
  const h = mount({ parts: [PART.A1] })
  assertStatus(await sync(h), 201, 'B4c A')
  h.source.add(PART.A3)
  assertStatus(await sync(h), 201, 'B4c B')
  h.source.remove('A-3')
  assertStatus(await sync(h), 201, 'B4c back to A is a new batch under the default rule, as before')
  assert.equal(batchCount(h), 3)
}

async function b4dNoFalseRefusals() {
  for (const hourRule of [false, true]) {
    const label = `B4d ${hourRule ? 'creation-hour' : 'default'} rule`
    const h = mount({ parts: [PART.A1, PART.A2], hourRule })
    const res = await sync(h)
    assertStatus(res, 201, `${label}: archived`)
    assert.deepEqual(archivedParts(h), sheetParts(h), `${label}: the batch is what ③ wrote`)
    await assertAlreadyKept(h, `${label}: unchanged sync`)
  }
}

// ── B5 ───────────────────────────────────────────────────────────────────────────────────────

async function b5TheWire() {
  const h = mount({ parts: [PART.A1] })
  const applied = await write(h)
  assert.match(applied.sourceContentDigest, DIGEST_SHAPE)
  assert.equal('sourceContentRevision' in applied, false, 'B5: the raw content revision is never answered')
  assert.equal(JSON.stringify(applied).includes('A-1'), false, 'B5: no part value in the apply answer')

  for (const digest of ['', applied.sourceContentDigest.toUpperCase(), `${applied.sourceContentDigest}0`, 42, null]) {
    const fresh = mount({ parts: [PART.A1] })
    const res = await call(fresh.routes, ROUTE.mvpPersist, { body: { ...pull(), sourceContentDigest: digest }, query: {} })
    assertStatus(res, 400, `B5 malformed ${JSON.stringify(digest)}`)
    assert.equal(res.body.error.code, 'TABLE_ACTION_REQUEST_INVALID')
    assert.deepEqual({ ...res.body.error.details }, { field: 'sourceContentDigest' })
    assert.equal(fresh.loads.count, 0, 'B5: refused before any source was loaded')
  }
}

// ── B6 ───────────────────────────────────────────────────────────────────────────────────────

function b6TheRevisionsOnTheirOwn() {
  const action = {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SOURCE_SYSTEM_ID, workspaceId: null, readPlan: { id: 'plan' } },
    target: { sheetId: CANONICAL_SHEET_ID },
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    extensionFieldIds: ['ext_declared'],
  }
  const parameters = { projectNo: PROJECT_NO }
  const rowA = { idempotencyKey: 'k1', componentCode: 'A-1', rawQuantity: 2 }
  const rowB = { idempotencyKey: 'k2', componentCode: 'A-2', rawQuantity: 3 }
  const content = (rows) => buildSourceContentRevision({ action, parameters, expansion: { status: 'expanded', rows } })
  const base = content([rowA, rowB])
  assert.equal(content([rowB, rowA]), base, 'B6: row order does not move the content revision')
  assert.equal(content([{ ...rowA, ext_mapped: 'x' }, { ...rowB, ext_other: 1 }]), base, 'B6: tenant ext_ keys do not move it')
  assert.notEqual(content([{ ...rowA, rawQuantity: 5 }, rowB]), base, 'B6: a quantity moves it')
  assert.notEqual(content([rowA]), base, 'B6: a removed row moves it')
  assert.notEqual(content([rowA, rowB, { idempotencyKey: 'k3', componentCode: 'A-3' }]), base, 'B6: an added row moves it')
  assert.match(stockPreparationSourceContentDigest(base), DIGEST_SHAPE)
  assert.notEqual(stockPreparationSourceContentDigest(base), base.slice(0, 32), 'B6: the wire digest is domain-separated, not a prefix')

  const sheetRow = {
    idempotencyKey: 'k1', componentCode: 'A-1', rawQuantity: 2, lastPlmRefreshDecision: 'add', ext_declared: 'sync-written',
  }
  const dryRun = (existingRows) => ({
    expansion: { status: 'expanded', rows: [rowA] },
    existingRows,
    conflictPolicyReview: null,
    plan: { counts: { add: 0, update: 0, skip: 1, inactive: 0, manual_confirm: 0 }, valid: true, summary: { conflictTypes: ['unchanged'] } },
  })
  const archiveOf = (rows) => buildArchiveRevision({ action, parameters, dryRun: dryRun(rows) })
  const untouched = archiveOf([sheetRow])
  assert.equal(untouched, buildRevision({ action, parameters, ...dryRun([sheetRow]) }),
    'B6: for a sheet nobody typed into the archive revision IS the dry-run revision (no kept batch re-keyed)')
  assert.equal(archiveOf([{ ...sheetRow, notes: 'synthetic', procurementReply: 'synthetic', [PEOPLE_EXT_COLUMN]: 'synthetic' }]), untouched,
    'B6: the columns people own do not move it')
  assert.notEqual(archiveOf([{ ...sheetRow, ext_declared: 'rewritten' }]), untouched, 'B6: the declared ext_ band stays in')
  assert.notEqual(archiveOf([{ ...sheetRow, lastPlmRefreshDecision: 'update' }]), untouched, 'B6: the refresh stamps stay in')
  assert.notEqual(archiveOf([{ ...sheetRow, rawQuantity: 7 }]), untouched, 'B6: a PLM-owned cell stays in')
}

// ── B7 ───────────────────────────────────────────────────────────────────────────────────────

async function b7NewestBatchIdentityRead() {
  const records = createRecordsApi()
  const provisioning = createProvisioning()
  const STAGING = `${TENANT_ID}:integration-core`
  const read = (overrides = {}) => readNewestSnapshotBatchIdentity({
    recordsApi: records.api, provisioning, targetProjectId: STAGING, businessProjectId: 'proj_1', permission: 'admin', ...overrides,
  })
  const batchRow = (api, data) => api.createRecord({ sheetId: `sheet_${BATCH_OBJECT_ID}`, data: { projectId: 'proj_1', ...data } })
  await assert.rejects(() => read({ permission: 'write' }), (error) => error.status === 403, 'B7: admin only')
  assert.equal(await read(), null, 'B7: no batch row')
  assert.equal(await read({ provisioning: { ...provisioning, async findObjectSheet() { return null } } }), null, 'B7: tables not built')
  await batchRow(records.api, { snapshotBatchId: 'b1', syncRunId: 'r1', snapshotVersion: 1 })
  await batchRow(records.api, { snapshotBatchId: 'b2', syncRunId: 'r2', snapshotVersion: '2' })
  await batchRow(records.api, { projectId: 'proj_other', snapshotBatchId: 'x', syncRunId: 'x', snapshotVersion: 9 })
  assert.deepEqual(await read(), { snapshotBatchId: 'b2', syncRunId: 'r2' }, 'B7: the highest version of THIS project')

  const tie = createRecordsApi()
  await batchRow(tie.api, { snapshotBatchId: 't1', syncRunId: 'r_t1', snapshotVersion: 3 })
  await batchRow(tie.api, { snapshotBatchId: 't2', syncRunId: 'r_t2', snapshotVersion: 3 })
  assert.equal(await read({ recordsApi: tie.api }), null, 'B7: two rows share the top version, no candidate')

  const loose = createRecordsApi()
  await batchRow(loose.api, { snapshotBatchId: 'v1', syncRunId: 'r1', snapshotVersion: 1 })
  await batchRow(loose.api, { snapshotBatchId: 'vx', syncRunId: 'rx', snapshotVersion: '02' })
  assert.equal(await read({ recordsApi: loose.api }), null, 'B7: a version that is not a strict positive integer, no candidate')

  const runless = createRecordsApi()
  await batchRow(runless.api, { snapshotBatchId: 'v1', snapshotVersion: 1 })
  assert.equal(await read({ recordsApi: runless.api }), null, 'B7: the newest row names no run, no candidate')
}

const CASES = Object.freeze({
  B1: b1SourceChangedBetweenWriteAndArchive,
  B1s: b1sSheetEditedAfterTheWrite,
  B2: b2PartialWriteIsNotArchived,
  B3a: b3aDefaultRuleNotesEdit,
  B3b: b3bHourRuleNotesEdit,
  B3c: b3cHourRuleSheetRewrittenBack,
  B3d: b3dHourRulePartialThenCompleted,
  B4a: b4aHourRuleCorrectionInTheSameHourStillRefused,
  B4b: b4bHourRuleBackToAnOlderBatchStillRefused,
  B4c: b4cDefaultRuleBackAndForthKeepsItsHistory,
  B4d: b4dNoFalseRefusals,
  B4e: b4eHistoryReadFailureKeepsTheOriginalRefusal,
  B4f: b4fOtherLedgerConflictsAreNotReplayed,
  B4g: b4gExtMappingDeploymentIsNotRefused,
  B5: b5TheWire,
  B6: b6TheRevisionsOnTheirOwn,
  B7: b7NewestBatchIdentityRead,
})

async function main() {
  const previousGate = process.env[MVP_PERSIST_GATE]
  process.env[MVP_PERSIST_GATE] = 'true'
  // `SYNC_PARITY_ONLY=B3c` runs one case — the mutation probes run each case alone.
  const only = process.env.SYNC_PARITY_ONLY
  try {
    for (const [name, run] of Object.entries(CASES)) {
      if (only && only !== name) continue
      await run()
    }
  } finally {
    if (previousGate === undefined) delete process.env[MVP_PERSIST_GATE]
    else process.env[MVP_PERSIST_GATE] = previousGate
  }
  console.log('stock-preparation-mvp-persist-sync-parity tests passed')
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-mvp-persist-sync-parity.test.cjs', main)
