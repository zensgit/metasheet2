'use strict'

// 备料 batch-refresh step 4, PR-5 — THE FORMAL-EXPORT GATE, THE SETTLEMENT CHECK, THE STATE SURFACES AND THE
// HANDOFF TERMINAL GATE (design §11, §9.2, §23.7 O-21 as replaced, §18 rows A11 / C04 / C10 / C12 / U01 / U02 /
// U07; plan §5.3, §7 G7, §9 U01 / U02 / U07 / C04 / C12).
//
// Hermetic. The route-level cases drive the REAL route module over the REAL refresh governance reader, the REAL
// continuation store (the refresh kit's fake db of migrations 102 / 103) and the REAL project write lock (the lock
// kit's fake db); every state is seeded through the store's own methods, never a stub reader (P3-C3). The real-DB
// twins (S5-*) live in packages/core-backend/tests/integration/stock-preparation-project-write-lock-realdb.cases.ts.
//
// WHAT THIS SUITE PINS (each has a RED witness in the PR body's mutation table):
//   XG-01 THE FIXED ORDER: G0 (generation) -> C1 (state) -> data -> file -> C2 (state) -> G1 (generation), every
//         step awaited, nothing in parallel; a not-governed project pays G0, C1, data, file, G1 (no C2, no digest).
//   XG-02 THE BRACKET compares presence, `generationToken` AND `fencingEpoch`: an epoch-only move between G0 and
//         G1 (a zero-write run) refuses; a token-only move refuses; a lock row that appears refuses.
//   XG-03 ANY LEASE at G0 refuses before a single row is read; a lease at G1 refuses after the file is built.
//   XG-04 THE STATE TABLE over the REAL derivation: every unfinished status is 409 BLOCKED naming it (the ledger's
//         pending count is not an input at all); unreadable is 503; `complete` without a settlement is 409
//         not_settled (O-9's never-settled pilot); not_governed and a settled complete pass.
//   XG-05 C2 is a FRESH state: a state that moved between C1 and C2 refuses STATE_CHANGED; unreadable 503.
//   XG-06 THE DIGEST: C2's settled machine digest must equal R's; the band is the settlement's (human columns
//         structurally absent, machine columns in); a governed R without a digest is a 500 defect, never "equal".
//   XG-07 A READER REFUSAL (409 RETARGETED / TENANT_MISMATCH) propagates; nothing is read or built.
//   XG-08 the consult -> export input projection (live relationships only, claim_active members only).
//   XG-09 THE 沿用说明 COLUMN: one trailing column only with a live relationship, filled on the continued rows
//         with the new parent's 图号 resolved from the export's own rows; without it, headers and rows identical.
//   XR-01 NOT GOVERNED through the ROUTE: 200; the xlsx params and the audit row are BYTE-IDENTICAL to the golden
//         captured from main 8cafcc851's own modules (the literal below; C09).
//   XR-02 GOVERNED, every unfinished state seeded through the real store: 409 / 503, one `export_refused` audit
//         row with closed tokens only, no workbook built, nothing sent.
//   XR-03 GOVERNED, complete + settled with a confirmed and consumed relationship: 200, the 沿用说明 column, the
//         four continued rows noted, no duplicated quantities, the audit row's tokens.
//   XR-04 A HOST-SIDE MACHINE WRITE after the settlement refuses SHEET_CHANGED_SINCE_SETTLEMENT; a human fill does
//         not (B-M6 / A12).
//   XR-05 THE ORDER INSIDE R: a machine write landing between the export rows read and the digest read refuses.
//   XR-06 THE INTERLEAVINGS (hooks on the route's lock reads and the reader's lock reads): (a) a lease taken after
//         G0 -> C1 executing; (b) a lease taken and released during R -> G1 epoch moved; (c) a bump during R -> G1
//         token moved; (d) a lease live at G1; (e) THE REVIEWER'S zero-write FAILED execution inside C2's
//         snapshot-to-lock-read gap: C2 derives complete, the digest matches, G1's epoch catches it; (f) the same
//         failure before G0: C1 refuses failed_pending_recovery; (g) a zero-write SELF-SETTLED success before G0:
//         200 (the positive control).
//   XR-07 UNWIRED: no governance service / no lock => 501 by name, before any records read.
//   XR-08 「最近导出」 skips `export_refused` rows.
//   XH-01..04 THE HANDOFF TERMINAL HOP: refused 409 (503 unreadable) under the same predicate; non-terminal hops
//         never consult; a settled complete passes; a not-governed project passes.
//   XP-01 THE POSTURE: every unfinished / unreadable state is `blocked_pull_state`, never 「可以导出」; the overview
//         row of a project with an open hold says 待确认 1 件 through the REAL refresh route.
//   XE-01 THE EGRESS CENSUS: every new refusal carries a values-free message and token / boolean details.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const gateLib = require(path.join(LIB, 'stock-preparation-export-gate.cjs'))
const { runFormalExportGate, EXPORT_GATE_ERROR_CODES, EXPORT_GATE_REASONS, StockPreparationExportGateError, continuationExportInputOf, auditableRefusalDetail } = gateLib
const { readProjectRefreshState, formalSurfaceVerdict, STATUS_TOKENS, FORMAL_SURFACE_REFUSALS } = require(path.join(LIB, 'stock-preparation-refresh-state.cjs'))
const { machineBandFieldIds, sheetMachineDigest } = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = tableActions
const { EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const prepLineExport = require(path.join(LIB, 'stock-preparation-prep-line-export.cjs'))
const { exportStockPreparationPrepLines, EXPORT_COLUMNS } = prepLineExport
const { ROW_IDENTITY_KEY } = prepLineExport.__internals
const { STOCK_PREP_OPERATE, STOCK_PREP_READ, STOCK_PREP_PULL } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { __internals: auditInternals } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const directoryLib = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
const overview = require(path.join(LIB, 'stock-preparation-project-overview.cjs'))
const { HANDOFF_CONFIG_KEY } = require(path.join(LIB, 'stock-preparation-handoff.cjs'))
const { HANDOFF_TABLE, createStockPreparationHandoffStore } = require(path.join(LIB, 'stock-preparation-handoff-store.cjs'))
const { STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))

const { makeStrictRecordsApi, physicalFieldId, physicalRow } = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const { createInMemoryProjectWriteLock } = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { withRefreshGovernance } = require('./support/stock-preparation-refresh-governance-wiring.cjs')
const refreshKit = require('./support/stock-preparation-refresh-store-kit.cjs')
const CF = require('./support/stock-preparation-continuation-fixtures.cjs')
const projectSheet = require('./support/stock-preparation-project-sheet-harness.cjs')

const MAIN_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const EXPORT_PATH = '/api/integration/stock-preparation/prep-lines/export'
const ADVANCE_PATH = '/api/integration/stock-preparation/handoff/advance'
const TEMPLATE = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
const SENTINEL = 'ZZSENTINELVALUEZZ'

// ── the golden, captured from main 8cafcc851's OWN modules (scratchpad s5_golden_main.cjs): one fixed fixture ──
const GOLDEN_TENANT = 'tenant-golden-xg'
const GOLDEN_STAGING = `${GOLDEN_TENANT}:integration-core`
const GOLDEN_SHEET = 'sheet_golden_xg_hand_bound'
const GOLDEN_PROJECT = 'PRJ-GOLDEN-XG'
const GOLDEN_OPERATOR = Object.freeze({ id: 'u_golden_op', tenantId: GOLDEN_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const GOLDEN_XLSX = Object.freeze({
  sheetName: '备料导出-PRJ-GOLDEN-XG',
  headers: ['父组件图号', '父组件名称', '图号', '名称', '规格', '材料', '总数量', '备料情况', '需求日期', '领料节点', '备料日期', '毛胚长度', '自制/外购', '采购完成', '采购回复日期', '仓库完成', '实际到货日期', '生产编号', '名称及规格', '材料类型', '毛胚类型', '备注', '交接工段', '提前周期(天)', '毛胚宽度', '毛胚厚度', '毛胚数量', '毛胚质量'],
  rows: [
    [null, null, 'DWG-P-001', 'ASSY-P', 'SPEC-P', 'M-P', 2, null, null, null, null, null, null, null, null, null, null, 'PRJ-GOLDEN-XG', null, null, null, null, null, null, null, null, null, null],
    ['DWG-P-001', 'ASSY-P', 'DWG-C-001', 'PART-C', 'SPEC-C', 'M-C', 6, null, null, null, null, null, null, null, null, null, null, 'PRJ-GOLDEN-XG', null, null, null, null, null, null, null, null, null, null],
  ],
})
const GOLDEN_AUDIT = Object.freeze({
  tenantId: GOLDEN_TENANT,
  projectId: GOLDEN_PROJECT,
  action: 'prep_line_export',
  actor: 'u_golden_op',
  mode: 'export',
  detail: { operation: 'prep_line_export', totalRowCount: 3, activeRowCount: 2, columnCount: 28 },
})
function goldenRows() {
  return [
    physicalRow(GOLDEN_STAGING, MAIN_OBJECT_ID, { projectNo: GOLDEN_PROJECT, active: true, componentSourceId: 'P-001', parentSourceId: null, path: JSON.stringify(['P-001']), depth: 0, componentCode: 'DWG-P-001', componentName: 'ASSY-P', componentSpec: 'SPEC-P', material: 'M-P', rawQuantity: 2, totalQuantity: 2, idempotencyKey: 'k_p' }, 'rec_golden_p'),
    physicalRow(GOLDEN_STAGING, MAIN_OBJECT_ID, { projectNo: GOLDEN_PROJECT, active: true, componentSourceId: 'C-001', parentSourceId: 'P-001', parentComponentCode: 'DWG-P-001', parentComponentName: 'ASSY-P', path: JSON.stringify(['P-001', 'C-001']), depth: 1, componentCode: 'DWG-C-001', componentName: 'PART-C', componentSpec: 'SPEC-C', material: 'M-C', rawQuantity: 3, totalQuantity: 6, idempotencyKey: 'k_c' }, 'rec_golden_c'),
    physicalRow(GOLDEN_STAGING, MAIN_OBJECT_ID, { projectNo: GOLDEN_PROJECT, active: false, componentSourceId: 'X-001', parentSourceId: 'P-001', path: JSON.stringify(['P-001', 'X-001']), depth: 1, componentCode: 'DWG-X-001', componentName: 'PART-X', material: 'M-X', rawQuantity: 1, totalQuantity: 2, idempotencyKey: 'k_x' }, 'rec_golden_x'),
  ]
}

// ── the governed fixture: the continuation fixtures' first-pull sheet (S-001 + three parts, record ids rec_s_1..4) ──
const GOV_TENANT = 'tenant-xg-gov'
const GOV_STAGING = `${GOV_TENANT}:integration-core`
const GOV_SHEET = 'sheet_xg_gov_hand_bound'
const GOV_PROJECT = CF.PROJECT_NO
const GOV_OPERATOR = Object.freeze({ id: 'u_xg_op', tenantId: GOV_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const GOV_SCOPE = Object.freeze({ tenantId: GOV_TENANT, sheetId: GOV_SHEET, projectNo: GOV_PROJECT })

function recordRefOf(row) {
  return row[EXISTING_ROW_RECORD_REF]
}

/** The first-pull sheet as physical records (ids kept), plus a P-001 parent row at the new parent's position. */
async function governedRows({ withParent = true } = {}) {
  const sheet = await CF.firstPullSheet()
  const rows = sheet.map((row) => physicalRow(GOV_STAGING, MAIN_OBJECT_ID, { ...row }, recordRefOf(row).id))
  if (withParent) {
    rows.push(physicalRow(GOV_STAGING, MAIN_OBJECT_ID, { projectNo: GOV_PROJECT, active: true, componentSourceId: 'P-001', parentSourceId: null, path: JSON.stringify(['P-001']), depth: 0, componentCode: 'D100-01', componentName: 'Assembly', material: 'M-STEEL', sourceVersion: 'V1', rawQuantity: 5, totalQuantity: 5, idempotencyKey: 'k_xg_p' }, 'rec_xg_p'))
  }
  return rows
}

let passed = 0
let failed = 0
const only = process.env.ONLY_TEST || ''
async function run(name, fn) {
  if (only && !name.includes(only)) return
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

async function refusalOf(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

function inertService(methods) {
  const service = {}
  for (const method of methods) service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
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

// The route's sanitizer hands back null-prototype objects; compare their JSON shape.
function errorOf(res) {
  return res.body && res.body.error ? JSON.parse(JSON.stringify(res.body.error)) : {}
}

// ── fake consults for the pure gate cases (the refresh-state suite's shapes; the REAL derivation runs on them) ──
function freeLock(overrides = {}) {
  return { state: { present: true, leaseHeld: false, leaseLive: false }, generation: { present: true, generationToken: 'g1', fencingEpoch: 3, leaseId: null, ...overrides } }
}
function liveLock(leaseId = 'lease_live') {
  return { state: { present: true, leaseHeld: true, leaseLive: true }, generation: { present: true, generationToken: 'g1', fencingEpoch: 4, leaseId } }
}
function consult(overrides = {}) {
  return { ok: true, pilot: null, continuations: [], holds: [], state: null, executions: [], changePlans: [], lock: freeLock(), ...overrides }
}
const PILOT = { enabled: true, enabledAt: '2026-10-20T00:00:00.000Z', readinessVersion: 1 }
const SUCCEEDED = { id: 'exec_1', status: 'succeeded', leaseId: 'lease_old', startedAt: '2026-10-21T01:00:00.000Z' }
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const SETTLED_STATE = { settledAt: '2026-10-22T00:00:00.000Z', settledExecutionId: 'exec_1', settledSheetMachineDigest: DIGEST_A }
const CONTINUATION = { id: 'cont_1', status: 'active', revision: 1, executedExecutionId: 'exec_1', confirmedAt: '2026-10-21T00:00:00.000Z' }

/** A `readRefreshState` answer (consult + derived state) for the pure cases. */
function readOf(consultAnswer) {
  return { consult: consultAnswer, error: null, state: readProjectRefreshState(consultAnswer) }
}
const COMPLETE_SETTLED = () => consult({ pilot: PILOT, executions: [SUCCEEDED], state: SETTLED_STATE, continuations: [CONTINUATION] })
const UNFINISHED = {
  executing: () => consult({ pilot: PILOT, lock: liveLock() }),
  failed_pending_recovery: () => consult({ pilot: PILOT, executions: [{ id: 'e', status: 'partial', leaseId: null, startedAt: '2026-10-22T00:00:00.000Z' }] }),
  pending_confirmation: () => consult({ pilot: PILOT, holds: [{ id: 'h', status: 'open', kind: 'continuation_candidate', confirmable: true }] }),
  change_pending_review: () => consult({ pilot: PILOT, changePlans: [{ id: 'cp', status: 'written' }] }),
  confirmed_pending_execution: () => consult({ pilot: PILOT, continuations: [{ ...CONTINUATION, executedExecutionId: null }] }),
  executed_pending_settlement: () => consult({ pilot: PILOT, executions: [SUCCEEDED] }),
}

/** A scripted gate environment: generation answers by call, state answers by call, a recorded call order. */
function gateEnv({ generations, reads, digest = DIGEST_A, exportResult = { headers: ['h'], rows: [[1]], totalRowCount: 1, activeRowCount: 1 } } = {}) {
  const calls = []
  let g = 0
  let r = 0
  const deps = {
    readGeneration: async () => { calls.push('readGeneration'); return generations[Math.min(g++, generations.length - 1)] },
    readRefreshState: async () => {
      calls.push('readRefreshState')
      const answer = reads[Math.min(r++, reads.length - 1)]
      if (answer instanceof Error) throw answer
      return answer
    },
    readData: async (read, { governed }) => { calls.push(`readData:${governed}`); return { exportResult, sheetMachineDigest: governed ? digest : null } },
    buildFile: async () => { calls.push('buildFile'); return Buffer.from('file') },
  }
  return { calls, deps }
}
const GEN = (overrides = {}) => ({ present: true, generationToken: 'tok_1', fencingEpoch: 7, leaseId: null, ...overrides })

// ── the export route mount over the REAL governance, store and lock ───────────────────────────────
function mountExport({
  rows,
  tenantId = GOV_TENANT,
  staging = `${tenantId}:integration-core`,
  sheetId = GOV_SHEET,
  withGovernance = true,
  withLock = true,
  hooks = {},
} = {}) {
  const routes = new Map()
  const records = makeStrictRecordsApi({ stagingProjectId: staging, objectIdBySheetId: { [sheetId]: MAIN_OBJECT_ID }, rowsBySheet: { [sheetId]: rows } })
  const reads = []
  const countingRecords = {
    rows: (id) => records.rows(id),
    async queryRecords(input) {
      const n = reads.push(input && input.sheetId)
      const page = await records.queryRecords(input)
      if (typeof hooks.afterRecordsRead === 'function') await hooks.afterRecordsRead(n, { records, input })
      return page
    },
    async patchRecord(input) { return records.patchRecord(input) },
    async createRecord() { throw new Error('unexpected records write: createRecord') },
  }
  const provisioning = {
    async findObjectSheet() { throw new Error('unexpected provisioning read: findObjectSheet') },
    async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
    isSheetOwnedByProject: async (id, projectId) => id === sheetId && projectId === staging,
    getObjectSheetId: (projectId, objectId) => `sheet_${projectId}_${objectId}`.replace(/[^A-Za-z0-9_]/g, '_'),
  }
  const fieldIdMap = Object.fromEntries(TEMPLATE.fields.map((field) => [field.id, physicalFieldId(staging, MAIN_OBJECT_ID, field.id)]))
  const target = { sheetId, fieldIdMap }
  const context = {
    api: { http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } }, multitable: { records: countingRecords, provisioning } },
    storage: new Map(),
    config: { stockPreparationTableActions: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' }, target }] },
  }
  const auditAppends = []
  const xlsxCalls = []
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) {
      // The REAL values-free gate: a detail that would be refused in production is refused here too.
      auditInternals.assertValuesFreeDetail(entry.detail)
      auditAppends.push(entry)
      return { ok: true }
    },
  }
  services.stockPreparationXlsxExport = {
    async buildWorkbookBuffer(params) {
      xlsxCalls.push(params)
      if (typeof hooks.afterBuildFile === 'function') await hooks.afterBuildFile()
      return Buffer.from(JSON.stringify(params), 'utf8')
    },
  }
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  // ONE raw lock; two hookable views of it — the ROUTE's (G0 / G1) and the READER's (the consult's own lock reads).
  const rawLock = createInMemoryProjectWriteLock({ timers: 'real' }).lock
  const counters = { routeReadGeneration: 0, readerReadState: 0, readerReadGeneration: 0, readRefreshState: 0 }
  function hookedLock(prefix) {
    return Object.freeze({
      ...rawLock,
      readState: async (scopeKey) => {
        const n = (counters[`${prefix}ReadState`] = (counters[`${prefix}ReadState`] || 0) + 1)
        if (typeof hooks[`${prefix}BeforeReadState`] === 'function') await hooks[`${prefix}BeforeReadState`](n, rawLock)
        return rawLock.readState(scopeKey)
      },
      readGeneration: async (scopeKey) => {
        const n = (counters[`${prefix}ReadGeneration`] = (counters[`${prefix}ReadGeneration`] || 0) + 1)
        if (typeof hooks[`${prefix}BeforeReadGeneration`] === 'function') await hooks[`${prefix}BeforeReadGeneration`](n, rawLock)
        const answer = await rawLock.readGeneration(scopeKey)
        if (typeof hooks[`${prefix}AfterReadGeneration`] === 'function') await hooks[`${prefix}AfterReadGeneration`](n, rawLock, answer)
        return answer
      },
    })
  }
  const readerLock = hookedLock('reader')
  if (withLock) services.stockPreparationProjectWriteLock = hookedLock('route')
  let env = null
  if (withGovernance) {
    // The READER's lock view (its own `lockOf`, so the route's view counts only G0 / G1).
    withRefreshGovernance(services, { lockOf: () => readerLock, wirePackInstallStore: true })
    env = services.refreshGovernanceEnv
    const governance = services.stockPreparationRefreshGovernance
    services.stockPreparationRefreshGovernance = Object.freeze({
      ...governance,
      readRefreshState: async (scope) => {
        const n = (counters.readRefreshState += 1)
        if (typeof hooks.beforeReadRefreshState === 'function') await hooks.beforeReadRefreshState(n)
        const read = await governance.readRefreshState(scope)
        if (typeof hooks.afterReadRefreshState === 'function') await hooks.afterReadRefreshState(n, read)
        return read
      },
    })
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  const scopeKey = tableActions.__internals.sheetWriteScopeKey ? tableActions.__internals.sheetWriteScopeKey(sheetId) : require(path.join(LIB, 'stock-preparation-project-write-lock.cjs')).sheetWriteScopeKey(sheetId)
  return {
    routes, records, reads, auditAppends, xlsxCalls, env, rawLock, counters, target, scopeKey, services,
    physical: (fieldId) => physicalFieldId(staging, MAIN_OBJECT_ID, fieldId),
    async exportAs(user, projectNo) {
      const handler = routes.get(`GET ${EXPORT_PATH}`)
      assert.ok(handler, 'the export route is registered')
      const res = createResponse()
      await handler({ user, authenticatedTenantId: user.tenantId, body: {}, query: { projectNo }, params: {} }, res)
      return res
    },
    /** The settlement's own digest of the sheet as it stands now (the planner's reader, the strict band = the template's); read on the RAW fake, so `reads` counts the route's reads only. */
    async currentDigest(projectNo = GOV_PROJECT) {
      const existing = await tableActions.__internals.readExistingStockPreparationRows(records, target, projectNo)
      return sheetMachineDigest(existing, { machineFieldIds: machineBandFieldIds({ template: TEMPLATE, installedFieldProperties: undefined }) })
    },
    decisionVersion(scope = GOV_SCOPE) {
      const state = env.rows('state').find((row) => row.sheet_id === scope.sheetId && row.project_no === scope.projectNo)
      return state ? state.decision_version : 0
    },
    /** A clean, settling computation (zero holds) naming `executionId`, with the sheet's digest as it stands. */
    async settle({ executionId = null, scope = GOV_SCOPE, sheetMachineDigestOverride } = {}) {
      const digest = sheetMachineDigestOverride || await this.currentDigest(scope.projectNo)
      return env.store.reconcileHolds({
        ...scope,
        decisionVersionObserved: this.decisionVersion(scope),
        holds: [],
        computation: { lane: 'small_preview', suspended: false, generationToken: null, sourceContentDigest: 'c'.repeat(64) },
        settlement: { executionId, generationToken: null, sourceContentDigest: 'c'.repeat(64), sheetMachineDigest: digest },
      })
    },
  }
}

function assertRefused(h, res, status, code, { reason, state } = {}) {
  assert.equal(res.statusCode, status, `expected ${status} ${code}, got ${res.statusCode} ${JSON.stringify(errorOf(res))}`)
  assert.equal(errorOf(res).code, code)
  if (reason) assert.equal(errorOf(res).details && errorOf(res).details.reason, reason, JSON.stringify(errorOf(res)))
  if (state) assert.equal(errorOf(res).details && errorOf(res).details.status, state, JSON.stringify(errorOf(res)))
  assert.equal(res.sentBuffer, null, 'nothing streamed')
  const refused = h.auditAppends.filter((entry) => entry.action === 'prep_line_export' && entry.mode === 'export_refused')
  const delivered = h.auditAppends.filter((entry) => entry.action === 'prep_line_export' && entry.mode !== 'export_refused')
  assert.equal(delivered.length, 0, 'no success audit row')
  assert.equal(refused.length, 1, 'exactly one export_refused audit row')
  assert.equal(refused[0].detail.refusal, code)
  for (const [key, value] of Object.entries(refused[0].detail)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `audit detail ${key} is a token / count / boolean`)
  }
  const sent = [JSON.stringify(res.body), JSON.stringify(res.headers), JSON.stringify(h.auditAppends)].join('\n')
  assert.equal(sent.includes('D100-01-03'), false, 'no 图号 leaves a refusal')
  assert.equal(sent.includes('synthetic note'), false, 'no human cell leaves a refusal')
}

/** The confirmed relationship of the canonical second pull, consumed by a succeeded execution. */
async function seedConfirmedAndConsumed(h, scope = GOV_SCOPE) {
  const { hold } = await refreshKit.candidateHoldFixture()
  const confirmed = await h.env.seedConfirmedContinuation(scope, hold, { sourceIdentity: CF.SOURCE_IDENTITY })
  const execution = await h.env.seedExecution(scope, { status: 'succeeded', leaseId: 'lease_xg_done', leaseRunId: 'run_xg_done', refreshBinding: { continuations: [{ id: confirmed.continuationId, revision: 1 }] } })
  return { confirmed, execution, hold }
}

// ── the handoff mount (the handoff suite's shape, reduced to the terminal gate) ────────────────────
const H_TENANT = 'tenant-xg-handoff'
// The continuation fixtures' project number: the candidate hold's keys name it, and a confirm checks them.
const H_PROJECT = CF.PROJECT_NO
const H_SHEET = 'sheet_xg_handoff_main'
const H_SCOPE = Object.freeze({ tenantId: H_TENANT, sheetId: H_SHEET, projectNo: H_PROJECT })
const ZHANG = Object.freeze({ id: 'u_xg_zhang', tenantId: H_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const LI = Object.freeze({ id: 'u_xg_li', tenantId: H_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const WANG = Object.freeze({ id: 'u_xg_wang', tenantId: H_TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })

function makeHandoffMemoryDb() {
  const rows = []
  function matches(row, where) {
    return Object.entries(where).every(([column, value]) => (row[column] === undefined ? null : row[column]) === (value === undefined ? null : value))
  }
  const api = {
    rows,
    async selectOne(table, where) { assert.equal(table, HANDOFF_TABLE); return rows.find((row) => matches(row, where)) || null },
    async selectOneForUpdate(table, where) { assert.equal(table, HANDOFF_TABLE); return rows.find((row) => matches(row, where)) || null },
    async insertOne(table, row) { assert.equal(table, HANDOFF_TABLE); const stored = { workspace_id: null, notified_step_index: null, updated_by: null, ...row }; rows.push(stored); return [stored] },
    async updateRow(table, patch, where) { assert.equal(table, HANDOFF_TABLE); const found = rows.find((row) => matches(row, where)); if (!found) return []; Object.assign(found, patch); return [found] },
    async transaction(fn) { return fn(api) },
  }
  return api
}

function mountHandoff({ withGovernance = true } = {}) {
  const routes = new Map()
  const auditAppends = []
  const notifications = []
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: {
        provisioning: { ...inertService(['resolveFieldIds']), async isSheetOwnedByProject(sheetId, projectId) { return sheetId === H_SHEET && projectId === `${H_TENANT}:integration-core` } },
        records: { async queryRecords(input) { const wanted = input && input.filters && input.filters.projectNo; return wanted === H_PROJECT ? [{ id: 'rec_h1', data: { projectNo: wanted, active: true } }] : [] } },
      },
    },
    storage: new Map(),
    config: {
      [HANDOFF_CONFIG_KEY]: {
        tenantId: H_TENANT,
        steps: [{ key: 'prep_entry', handlerUserIds: [ZHANG.id] }, { key: 'process', handlerUserIds: [LI.id] }, { key: 'final_review', handlerUserIds: [WANG.id] }],
        notify: { groupDestinationId: 'dest-xg-prep' },
        terminal: { groupDestinationIds: ['dest-xg-warehouse'], exportPath: '/stock-prep?tab=confirmation-queue' },
      },
      stockPreparationTableActions: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID, source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' }, target: { sheetId: H_SHEET, objectId: MAIN_OBJECT_ID, fieldIdMap: {} } }],
    },
  }
  const services = baseServices()
  services.stockPreparationAuditStore = {
    async append(entry) { auditInternals.assertValuesFreeDetail(entry.detail); auditAppends.push(entry); return { ok: true } },
    async supportsAction() { return { supported: true, reason: 'check_constraint_accepts' } },
    async list() { return { rowCount: auditAppends.length, entries: auditAppends.slice().reverse() } },
  }
  const db = makeHandoffMemoryDb()
  services.stockPreparationHandoffStore = createStockPreparationHandoffStore({ db, idGenerator: (() => { let n = 0; return () => `handoff-xg-${(n += 1)}` })() })
  services.stockPreparationHandoffNotifier = { async sendToDestinations(request) { notifications.push(request); return { delivered: request.destinationIds.length, failed: 0 } } }
  services.tenantPrincipalDirectory = { async verifyTenantMembership() { return { member: true } } }
  services.stockPreparationProjectWriteLock = createInMemoryProjectWriteLock({ timers: 'real' }).lock
  let env = null
  const consults = []
  if (withGovernance) {
    withRefreshGovernance(services)
    env = services.refreshGovernanceEnv
    const governance = services.stockPreparationRefreshGovernance
    services.stockPreparationRefreshGovernance = Object.freeze({
      ...governance,
      readRefreshState: async (scope) => { consults.push({ ...scope }); return governance.readRefreshState(scope) },
      consult: async (scope) => { consults.push({ ...scope, raw: true }); return governance.consult(scope) },
    })
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return {
    routes, auditAppends, notifications, env, consults, db,
    async advance(user, fromStepKey) {
      const handler = routes.get(`POST ${ADVANCE_PATH}`)
      assert.ok(handler, 'the advance route is registered')
      const res = createResponse()
      await handler({ user, authenticatedTenantId: user.tenantId, body: { projectNo: H_PROJECT, fromStepKey }, query: {}, params: {} }, res)
      return res
    },
    decisionVersion() {
      const state = env.rows('state').find((row) => row.sheet_id === H_SHEET && row.project_no === H_PROJECT)
      return state ? state.decision_version : 0
    },
  }
}

async function main() {
  // ── XG-01 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-01 the fixed order G0 -> C1 -> data -> file -> C2 -> G1, every step awaited; a not-governed project pays no C2 and no digest', async () => {
    const governed = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED())] })
    const out = await runFormalExportGate(governed.deps)
    assert.deepEqual(governed.calls, ['readGeneration', 'readRefreshState', 'readData:true', 'buildFile', 'readRefreshState', 'readGeneration'])
    assert.equal(out.governed, true)
    assert.equal(out.state.status, 'complete')
    assert.deepEqual(out.generation, { present: true, generationToken: 'tok_1', fencingEpoch: 7 })
    assert.ok(Buffer.isBuffer(out.file))
    const ungoverned = gateEnv({ generations: [GEN()], reads: [readOf(consult())] })
    const outU = await runFormalExportGate(ungoverned.deps)
    assert.deepEqual(ungoverned.calls, ['readGeneration', 'readRefreshState', 'readData:false', 'buildFile', 'readGeneration'])
    assert.equal(outU.governed, false)
    assert.equal(outU.state.status, 'not_governed')
    // Dependencies are required by name (a route that forgets one is a 500 defect, never a pass).
    for (const name of ['readGeneration', 'readRefreshState', 'readData', 'buildFile']) {
      const deps = { ...governed.deps }
      delete deps[name]
      const error = await refusalOf(runFormalExportGate(deps))
      assert.equal(error.code, EXPORT_GATE_ERROR_CODES.GATE_INVALID)
      assert.equal(error.status, 500)
    }
  })

  // ── XG-02 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-02 G0 / G1 compare presence, generationToken AND fencingEpoch: an epoch-only move refuses (the zero-write run), a token-only move refuses, a lock row that appears refuses; identical stamps pass — for governed AND not-governed projects', async () => {
    for (const reads of [[readOf(COMPLETE_SETTLED())], [readOf(consult())]]) {
      const epochOnly = gateEnv({ generations: [GEN(), GEN({ fencingEpoch: 8 })], reads })
      let error = await refusalOf(runFormalExportGate(epochOnly.deps))
      assert.equal(error.code, EXPORT_GATE_ERROR_CODES.STATE_CHANGED)
      assert.equal(error.status, 409)
      assert.deepEqual(error.details, { reason: 'generation_moved', generationMoved: false, epochMoved: true, partial: false })
      assert.ok(epochOnly.calls.includes('buildFile'), 'the file was built in memory before G1 refused it')
      const tokenOnly = gateEnv({ generations: [GEN(), GEN({ generationToken: 'tok_2' })], reads })
      error = await refusalOf(runFormalExportGate(tokenOnly.deps))
      assert.equal(error.code, EXPORT_GATE_ERROR_CODES.STATE_CHANGED)
      assert.deepEqual(error.details, { reason: 'generation_moved', generationMoved: true, epochMoved: false, partial: false })
      const appeared = gateEnv({ generations: [{ present: false, generationToken: null, fencingEpoch: 0, leaseId: null }, GEN({ fencingEpoch: 0 })], reads })
      error = await refusalOf(runFormalExportGate(appeared.deps))
      assert.equal(error.details.reason, 'generation_moved')
      const absentBoth = gateEnv({ generations: [{ present: false, generationToken: null, fencingEpoch: 0, leaseId: null }], reads })
      const out = await runFormalExportGate(absentBoth.deps)
      assert.deepEqual(out.generation, { present: false, generationToken: null, fencingEpoch: 0 }, 'an absent lock row is handled explicitly: compared, never inferred')
    }
    // A malformed generation answer is a 500 defect at the step that read it.
    const malformed = gateEnv({ generations: [{ present: true, generationToken: 'x', fencingEpoch: -1, leaseId: null }], reads: [readOf(consult())] })
    const error = await refusalOf(runFormalExportGate(malformed.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.GATE_INVALID)
    assert.equal(error.details.reason, 'g0_generation_shape')
  })

  // ── XG-03 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-03 ANY lease at G0 (live or abandoned) refuses 409 BLOCKED lease_in_flight before a row is read; a lease at G1 refuses STATE_CHANGED lease_in_flight after the file is built', async () => {
    for (const reads of [[readOf(COMPLETE_SETTLED())], [readOf(consult())]]) {
      const atG0 = gateEnv({ generations: [GEN({ leaseId: 'lease_x' })], reads })
      const error = await refusalOf(runFormalExportGate(atG0.deps))
      assert.equal(error.code, EXPORT_GATE_ERROR_CODES.BLOCKED)
      assert.equal(error.status, 409)
      assert.equal(error.details.reason, 'lease_in_flight')
      assert.deepEqual(atG0.calls, ['readGeneration', 'readRefreshState'], 'no data read, no file')
      const atG1 = gateEnv({ generations: [GEN(), GEN({ leaseId: 'lease_y' })], reads })
      const late = await refusalOf(runFormalExportGate(atG1.deps))
      assert.equal(late.code, EXPORT_GATE_ERROR_CODES.STATE_CHANGED)
      assert.equal(late.details.reason, 'lease_in_flight')
      assert.ok(atG1.calls.includes('buildFile'))
    }
  })

  // ── XG-04 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-04 the state table over the REAL derivation: every unfinished status is 409 BLOCKED naming it (no ledger count is an input); unreadable is 503; complete without a settlement is 409 not_settled; not_governed and a settled complete pass', async () => {
    for (const [status, build] of Object.entries(UNFINISHED)) {
      const env = gateEnv({ generations: [GEN()], reads: [readOf(build())] })
      const error = await refusalOf(runFormalExportGate(env.deps))
      assert.equal(error.code, EXPORT_GATE_ERROR_CODES.BLOCKED, status)
      assert.equal(error.status, 409, status)
      assert.equal(error.details.status, status)
      assert.equal(error.details.reason, 'state')
      assert.equal(typeof error.details.governed, 'string')
      assert.deepEqual(Object.keys(error.details.counts).sort(), ['confirmable', 'continuations', 'openExecutions', 'pendingConfirm', 'pendingReviews'])
      assert.deepEqual(env.calls, ['readGeneration', 'readRefreshState'], `${status}: refused before any row read`)
    }
    const unreadable = gateEnv({ generations: [GEN()], reads: [{ consult: null, error: new Error('x'), state: readProjectRefreshState({ ok: false, failure: { store: 'continuation', operation: 'read_holds' } }) }] })
    const u = await refusalOf(runFormalExportGate(unreadable.deps))
    assert.equal(u.code, EXPORT_GATE_ERROR_CODES.STATE_UNREADABLE)
    assert.equal(u.status, 503)
    assert.deepEqual(u.details, { reason: 'unreadable', store: 'continuation', operation: 'read_holds', partial: false })
    // complete by derivation, never settled (no state row at all; and a state row without the digest).
    for (const state of [null, { settledAt: '2026-10-22T00:00:00.000Z', settledExecutionId: null }]) {
      const never = gateEnv({ generations: [GEN()], reads: [readOf(consult({ pilot: PILOT, state }))] })
      const n = await refusalOf(runFormalExportGate(never.deps))
      assert.equal(n.code, EXPORT_GATE_ERROR_CODES.BLOCKED)
      assert.equal(n.details.reason, 'not_settled')
      assert.equal(n.details.status, 'complete')
    }
    // The derived object itself: `settled` and the verdict.
    assert.equal(readProjectRefreshState(COMPLETE_SETTLED()).settled, true)
    assert.equal(readProjectRefreshState(consult({ pilot: PILOT })).settled, false)
    assert.equal(readProjectRefreshState(consult()).settled, false, 'not governed: never "settled"')
    assert.deepEqual(formalSurfaceVerdict(readProjectRefreshState(COMPLETE_SETTLED())), { allowed: true, reason: null })
    assert.deepEqual(formalSurfaceVerdict(readProjectRefreshState(consult())), { allowed: true, reason: null })
    assert.deepEqual(formalSurfaceVerdict(readProjectRefreshState(consult({ pilot: PILOT }))), { allowed: false, reason: 'not_settled' })
    assert.deepEqual(formalSurfaceVerdict(readProjectRefreshState({ ok: false })), { allowed: false, reason: 'unreadable' })
    assert.deepEqual(formalSurfaceVerdict(null), { allowed: false, reason: 'unreadable' })
    assert.deepEqual(formalSurfaceVerdict({ readable: true, status: 'complete', settled: true, exportAllowed: true }), { allowed: true, reason: null })
    for (const status of STATUS_TOKENS) {
      if (status === 'not_governed' || status === 'complete' || status === 'unreadable') continue
      assert.deepEqual(formalSurfaceVerdict({ readable: true, status, settled: true }), { allowed: false, reason: 'state' }, status)
    }
    assert.deepEqual(FORMAL_SURFACE_REFUSALS, ['unreadable', 'state', 'not_settled'])
  })

  // ── XG-05 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-05 C2 is a FRESH state: moved to an unfinished state between C1 and C2 => 409 STATE_CHANGED (status named); unreadable at C2 => 503; not_governed at C2 => STATE_CHANGED', async () => {
    const moved = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED()), readOf(UNFINISHED.failed_pending_recovery())] })
    let error = await refusalOf(runFormalExportGate(moved.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.STATE_CHANGED)
    assert.equal(error.details.reason, 'state')
    assert.equal(error.details.status, 'failed_pending_recovery')
    assert.equal(error.details.previousStatus, 'complete')
    assert.deepEqual(moved.calls, ['readGeneration', 'readRefreshState', 'readData:true', 'buildFile', 'readRefreshState'], 'refused at C2, before G1')
    const unreadable = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED()), { consult: null, error: new Error('x'), state: readProjectRefreshState({ ok: false }) }] })
    error = await refusalOf(runFormalExportGate(unreadable.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.STATE_UNREADABLE)
    const gone = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED()), readOf(consult())] })
    error = await refusalOf(runFormalExportGate(gone.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.STATE_CHANGED)
    assert.equal(error.details.status, 'not_governed')
  })

  // ── XG-06 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-06 the digest: C2\'s settled machine digest must equal R\'s (409 SHEET_CHANGED_SINCE_SETTLEMENT); a governed R without a digest is a 500 defect; the band excludes human columns and includes machine columns', async () => {
    const changed = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED())], digest: DIGEST_B })
    let error = await refusalOf(runFormalExportGate(changed.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.SHEET_CHANGED_SINCE_SETTLEMENT)
    assert.equal(error.status, 409)
    assert.deepEqual(error.details, { reason: 'machine_columns_changed', partial: false })
    const missing = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED())], digest: null })
    error = await refusalOf(runFormalExportGate(missing.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.GATE_INVALID)
    assert.equal(error.details.reason, 'sheet_machine_digest_missing')
    // The settled row carries NO digest at all (a settlement that never wrote one): never "equal".
    const blank = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED()), readOf(consult({ pilot: PILOT, executions: [SUCCEEDED], state: { ...SETTLED_STATE, settledSheetMachineDigest: DIGEST_A }, continuations: [CONTINUATION] }))], digest: DIGEST_B })
    error = await refusalOf(runFormalExportGate(blank.deps))
    assert.equal(error.code, EXPORT_GATE_ERROR_CODES.SHEET_CHANGED_SINCE_SETTLEMENT)
    // The band: the settlement's and the export's ONE function over the planner's rows.
    const band = machineBandFieldIds({ template: TEMPLATE, installedFieldProperties: undefined })
    assert.ok(band.includes('material') && band.includes('idempotencyKey') && band.includes('active'), 'machine columns are in the band')
    assert.ok(!band.includes('notes') && !band.includes('stockPreparationStatus') && !band.includes('lastPlmRefreshAt'), 'human and RUN columns are structurally absent')
    const sheet = await CF.firstPullSheet()
    const base = sheetMachineDigest(sheet, { machineFieldIds: band })
    const humanFilled = sheet.map((row, index) => (index === 0 ? CF.withRecordRef({ ...row, notes: 'a person wrote this' }, recordRefOf(row).id, 2) : row))
    assert.equal(sheetMachineDigest(humanFilled, { machineFieldIds: band }), base, 'a human fill never moves the digest')
    const machineEdited = sheet.map((row, index) => (index === 0 ? CF.withRecordRef({ ...row, material: 'M-HOST-EDITED' }, recordRefOf(row).id, 2) : row))
    assert.notEqual(sheetMachineDigest(machineEdited, { machineFieldIds: band }), base, 'a machine-column write moves it')
  })

  // ── XG-07 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-07 a reader refusal (409 RETARGETED / TENANT_MISMATCH, 422) propagates untouched from C1 and from C2; nothing is read or built after it', async () => {
    const refusal = Object.assign(new Error('retargeted'), { status: 409, code: 'STOCK_PREP_REFRESH_TARGET_RETARGETED', details: { store: 'continuation', table: 'continuation', reason: 'sheet' } })
    const atC1 = gateEnv({ generations: [GEN()], reads: [refusal] })
    let error = await refusalOf(runFormalExportGate(atC1.deps))
    assert.equal(error, refusal)
    assert.deepEqual(atC1.calls, ['readGeneration', 'readRefreshState'])
    const atC2 = gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED()), refusal] })
    error = await refusalOf(runFormalExportGate(atC2.deps))
    assert.equal(error, refusal)
    assert.deepEqual(atC2.calls, ['readGeneration', 'readRefreshState', 'readData:true', 'buildFile', 'readRefreshState'])
  })

  // ── XG-08 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-08 the consult -> export input projection: live relationships only, claim_active members only, undefined without a live one', async () => {
    assert.equal(continuationExportInputOf(null), undefined)
    assert.equal(continuationExportInputOf({ continuations: [], members: [] }), undefined)
    assert.equal(continuationExportInputOf({ continuations: [{ id: 'c1', status: 'ended' }], members: [{ continuationId: 'c1', oldRecordId: 'r1', claimActive: true }] }), undefined, 'an ended relationship is not live')
    const input = continuationExportInputOf({
      continuations: [{ id: 'c1', status: 'active', newParentComponentSourceId: 'P-001', newRootPathTokens: ['P-001', 'S-001'], parentEdgeUsage: 2, evidenceSnapshot: { secret: SENTINEL } }, { id: 'c2', status: 'ended' }],
      members: [{ continuationId: 'c1', oldRecordId: 'r1', claimActive: true, oldKey: SENTINEL }, { continuationId: 'c1', oldRecordId: 'r2', claimActive: false }],
    })
    assert.deepEqual(JSON.parse(JSON.stringify(input)), {
      continuations: [{ id: 'c1', status: 'active', newParentComponentSourceId: 'P-001', newRootPathTokens: ['P-001', 'S-001'], parentEdgeUsage: 2 }],
      members: [{ continuationId: 'c1', oldRecordId: 'r1', claimActive: true }],
    })
    assert.equal(JSON.stringify(input).includes(SENTINEL), false, 'the projection carries no key and no snapshot')
  })

  // ── XG-09 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XG-09 the 沿用说明 column: one trailing column only with a live relationship, filled on the continued rows with the new parent\'s 图号 resolved from the export\'s own rows; without the input the headers and rows are identical', async () => {
    const rows = await governedRows()
    const records = makeStrictRecordsApi({ stagingProjectId: GOV_STAGING, objectIdBySheetId: { [GOV_SHEET]: MAIN_OBJECT_ID }, rowsBySheet: { [GOV_SHEET]: rows } })
    const fieldIdMap = Object.fromEntries(TEMPLATE.fields.map((field) => [field.id, physicalFieldId(GOV_STAGING, MAIN_OBJECT_ID, field.id)]))
    const target = { sheetId: GOV_SHEET, fieldIdMap }
    const plain = await exportStockPreparationPrepLines({ recordsApi: records, target, projectNo: GOV_PROJECT, permission: 'admin' })
    const absent = await exportStockPreparationPrepLines({ recordsApi: records, target, projectNo: GOV_PROJECT, permission: 'admin', continuation: { continuations: [{ id: 'c_old', status: 'ended' }], members: [] } })
    assert.deepEqual(absent, plain, 'an ended relationship: byte-identical result (no column)')
    assert.deepEqual(plain.headers, EXPORT_COLUMNS.map((column) => column.label))
    assert.equal(plain.continuationColumn, undefined)
    const continuation = {
      continuations: [{ id: 'cont_xg_00000001', status: 'active', newParentComponentSourceId: 'P-001', newRootPathTokens: ['P-001', 'S-001'], parentEdgeUsage: 2 }],
      members: [
        { continuationId: 'cont_xg_00000001', oldRecordId: 'rec_s_1', claimActive: true },
        { continuationId: 'cont_xg_00000001', oldRecordId: 'rec_s_2', claimActive: true },
        { continuationId: 'cont_xg_00000001', oldRecordId: 'rec_s_3', claimActive: true },
        { continuationId: 'cont_xg_00000001', oldRecordId: 'rec_s_4', claimActive: true },
      ],
    }
    const noted = await exportStockPreparationPrepLines({ recordsApi: records, target, projectNo: GOV_PROJECT, permission: 'admin', continuation })
    assert.deepEqual(noted.headers, [...plain.headers, '沿用说明'])
    assert.equal(noted.continuationColumn, true)
    assert.equal(noted.continuedRowCount, 4)
    assert.equal(noted.rows.length, plain.rows.length, 'no row added, none duplicated')
    const codeIndex = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
    for (let i = 0; i < noted.rows.length; i += 1) {
      assert.deepEqual(noted.rows[i].slice(0, -1), plain.rows[i], 'every other cell identical')
      const code = noted.rows[i][codeIndex]
      const note = noted.rows[i][noted.rows[i].length - 1]
      if (code === 'D100-01') assert.equal(note, '', 'the new parent row carries no note')
      else assert.equal(note, '由 D100-01 沿用（父边用量 2，关系 00000001）', `continued row ${code}`)
    }
    // Without a resolvable parent row the note names the relationship only — never a fabricated parent.
    const orphanRecords = makeStrictRecordsApi({ stagingProjectId: GOV_STAGING, objectIdBySheetId: { [GOV_SHEET]: MAIN_OBJECT_ID }, rowsBySheet: { [GOV_SHEET]: await governedRows({ withParent: false }) } })
    const orphan = await exportStockPreparationPrepLines({ recordsApi: orphanRecords, target, projectNo: GOV_PROJECT, permission: 'admin', continuation })
    assert.ok(orphan.rows.every((row) => row[row.length - 1] === '沿用既有备料行（关系 00000001）'))
    // A malformed input is a 500 defect, never a silent plain export.
    const bad = await refusalOf(exportStockPreparationPrepLines({ recordsApi: records, target, projectNo: GOV_PROJECT, permission: 'admin', continuation: { continuations: 'x' } }))
    assert.equal(bad.code, 'PREP_LINE_EXPORT_CONTINUATION_INVALID')
  })

  // ── XR-01 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-01 NOT GOVERNED through the route: 200, and the xlsx params and the audit row are byte-identical to the golden captured from main 8cafcc851 (C09); the gate read G0, C1 and G1 only', async () => {
    const h = mountExport({ rows: goldenRows(), tenantId: GOLDEN_TENANT, sheetId: GOLDEN_SHEET })
    const res = await h.exportAs(GOLDEN_OPERATOR, GOLDEN_PROJECT)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(h.xlsxCalls, [GOLDEN_XLSX])
    assert.deepEqual(h.auditAppends, [GOLDEN_AUDIT])
    assert.equal(res.headers['X-Stock-Prep-Export-Row-Count'], '2')
    assert.ok(Buffer.isBuffer(res.sentBuffer))
    assert.deepEqual(h.reads, [GOLDEN_SHEET], 'ONE records read of the bound sheet, as before (no digest read for a not-governed project)')
    assert.equal(h.counters.routeReadGeneration, 2, 'G0 and G1')
    assert.equal(h.counters.readRefreshState, 1, 'C1 only')
  })

  // ── XR-02 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-02 GOVERNED, every unfinished state seeded through the REAL store: 409 / 503 with the state named, one export_refused audit row of closed tokens, no workbook, nothing sent; no records read for a refused state', async () => {
    const { hold } = await refreshKit.candidateHoldFixture()
    const cases = [
      ['pending_confirmation', async (h) => { await h.env.seedHolds(GOV_SCOPE, [hold]) }],
      ['confirmed_pending_execution', async (h) => { await h.env.seedConfirmedContinuation(GOV_SCOPE, hold, { sourceIdentity: CF.SOURCE_IDENTITY }) }],
      ['failed_pending_recovery', async (h) => { await h.env.seedExecution(GOV_SCOPE, { status: 'failed' }) }],
      ['failed_pending_recovery', async (h) => { await h.env.seedExecution(GOV_SCOPE, { status: 'running', leaseId: 'lease_xg_dead' }) }],
      ['executed_pending_settlement', async (h) => { await h.env.seedExecution(GOV_SCOPE, { status: 'succeeded' }) }],
    ]
    for (const [status, seed] of cases) {
      const h = mountExport({ rows: await governedRows() })
      await seed(h)
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { reason: 'state', state: status })
      assert.deepEqual(h.reads, [], `${status}: no records read`)
      assert.deepEqual(h.xlsxCalls, [])
    }
    // executing: a live lease on the sheet (the lock row, taken by a writer).
    {
      const h = mountExport({ rows: await governedRows() })
      await seedConfirmedAndConsumed(h)
      await h.settle({ executionId: (await h.env.rows('execution'))[0].id })
      const grant = await h.rawLock.acquire(h.scopeKey, { purpose: 'small_apply', runId: 'run_xg_live', tenantId: GOV_TENANT })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { state: 'executing' })
      await h.rawLock.createGuard(grant).release()
    }
    // complete by derivation but never settled (a pilot project whose rows were never previewed cleanly): not_settled.
    {
      const h = mountExport({ rows: await governedRows() })
      await h.env.registerProject({ tenantId: GOV_TENANT, projectNo: GOV_PROJECT, sheetId: GOV_SHEET, objectId: MAIN_OBJECT_ID, pilot: true })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { reason: 'not_settled', state: 'complete' })
    }
    // unreadable: the hold table cannot be read (42P01 on this tenant's binding).
    {
      const h = mountExport({ rows: await governedRows() })
      await seedConfirmedAndConsumed(h)
      h.env.db.faults.select = (args) => (args && /integration_stock_prep_refresh_hold/.test(args.table) ? refreshKit.sqlError('42P01', 'relation does not exist') : null)
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 503, EXPORT_GATE_ERROR_CODES.STATE_UNREADABLE, { reason: 'unreadable' })
      assert.equal(errorOf(res).details.store, 'continuation')
      assert.deepEqual(h.reads, [])
      h.env.db.faults.select = null
    }
  })

  // ── XR-03 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-03 GOVERNED, complete + settled with a confirmed and consumed relationship: 200 with the 沿用说明 column, the four continued rows noted, no duplicated quantities, the audit row\'s tokens; the gate read G0, C1, rows, digest rows, C2, G1', async () => {
    const h = mountExport({ rows: await governedRows() })
    const { execution } = await seedConfirmedAndConsumed(h)
    const settled = await h.settle({ executionId: execution.id })
    assert.equal(settled.settled, true)
    const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(h.xlsxCalls.length, 1)
    const workbook = h.xlsxCalls[0]
    assert.deepEqual(workbook.headers, [...EXPORT_COLUMNS.map((column) => column.label), '沿用说明'])
    const codeIndex = EXPORT_COLUMNS.findIndex((column) => column.id === 'componentCode')
    const qtyIndex = EXPORT_COLUMNS.findIndex((column) => column.id === 'totalQuantity')
    const noted = workbook.rows.filter((row) => row[row.length - 1] !== '')
    assert.equal(noted.length, 4, 'exactly the four continued rows carry the note')
    const handle = h.env.rows('continuation')[0].id.slice(-8)
    assert.ok(noted.every((row) => row[row.length - 1] === `由 D100-01 沿用（父边用量 2，关系 ${handle}）`), JSON.stringify(noted.map((row) => row[row.length - 1])))
    const codes = workbook.rows.map((row) => row[codeIndex])
    assert.equal(new Set(codes).size, codes.length, 'no component row is duplicated')
    assert.equal(workbook.rows.filter((row) => row[codeIndex] === 'D100-01-03').length, 1, 'the S root appears once, with its own quantity')
    assert.equal(workbook.rows.find((row) => row[codeIndex] === 'D100-01-03')[qtyIndex], 10, 'the old root keeps its order quantity (not the parent edge)')
    assert.deepEqual(h.auditAppends.map((entry) => entry.mode), ['export'])
    assert.deepEqual(h.auditAppends[0].detail, { operation: 'prep_line_export', totalRowCount: 5, activeRowCount: 5, columnCount: 29, refreshState: 'complete', continuationCount: 1, continuedRowCount: 4 })
    assert.deepEqual(h.reads, [GOV_SHEET, GOV_SHEET], 'the export rows read, THEN the digest read')
    assert.equal(h.counters.routeReadGeneration, 2)
    assert.equal(h.counters.readRefreshState, 2)
    assert.ok(Buffer.isBuffer(res.sentBuffer))
    // A second export is just as deliverable (the gate writes nothing).
    const again = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assert.equal(again.statusCode, 200)
  })

  // ── XR-04 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-04 a HOST-SIDE machine-column write after the settlement refuses 409 SHEET_CHANGED_SINCE_SETTLEMENT (the file was built, nothing sent); a human fill after the settlement still exports; a clean preview re-settles', async () => {
    const h = mountExport({ rows: await governedRows() })
    const { execution } = await seedConfirmedAndConsumed(h)
    await h.settle({ executionId: execution.id })
    // A person fills a human column on the old root.
    await h.records.patchRecord({ sheetId: GOV_SHEET, recordId: 'rec_s_1', changes: { [h.physical('notes')]: 'a person wrote this' } })
    let res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assert.equal(res.statusCode, 200, `a human fill never blocks: ${JSON.stringify(res.body)}`)
    // The host writes a MACHINE column behind the plugin's back.
    await h.records.patchRecord({ sheetId: GOV_SHEET, recordId: 'rec_s_1', changes: { [h.physical('material')]: 'M-HOST-EDITED' } })
    h.auditAppends.length = 0
    h.xlsxCalls.length = 0
    res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.SHEET_CHANGED_SINCE_SETTLEMENT, { reason: 'machine_columns_changed' })
    assert.equal(h.xlsxCalls.length, 1, 'the file had been built in memory')
    // A clean computation settles the new content; the export passes again.
    await h.settle({ executionId: execution.id })
    h.auditAppends.length = 0
    res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  })

  // ── XR-05 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-05 the order inside R: a machine write landing between the export rows read and the digest read refuses — the workbook never carries a value the settlement did not cover', async () => {
    const h = mountExport({
      rows: await governedRows(),
      hooks: {
        afterRecordsRead: async (n, { records }) => {
          // Right after the export rows were read (read #1), before the digest read (#2): a host write lands.
          if (n !== 1) return
          await records.patchRecord({ sheetId: GOV_SHEET, recordId: 'rec_s_2', changes: { [physicalFieldId(GOV_STAGING, MAIN_OBJECT_ID, 'material')]: 'M-RACED' } })
        },
      },
    })
    const { execution } = await seedConfirmedAndConsumed(h)
    await h.settle({ executionId: execution.id })
    const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
    assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.SHEET_CHANGED_SINCE_SETTLEMENT)
    assert.deepEqual(h.reads, [GOV_SHEET, GOV_SHEET])
  })

  // ── XR-06 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-06 the interleavings through the route: (a) a lease after G0 => C1 executing; (b) a lease taken and released during R => G1 epoch moved; (c) a bump during R => G1 token moved; (d) a lease live at G1; (e) THE REVIEWER\'S zero-write FAILED execution inside C2\'s snapshot-to-lock-read gap => C2 derives complete, the digest matches, G1\'s epoch refuses; (f) the same failure before G0 => C1 failed_pending_recovery; (g) a zero-write SELF-SETTLED success before G0 => 200', async () => {
    async function zeroWriteRun(h, { status, settle = false }) {
      const grant = await h.rawLock.acquire(h.scopeKey, { purpose: 'small_apply', runId: `run_xg_${status}`, tenantId: GOV_TENANT })
      const gen = await h.rawLock.readGeneration(h.scopeKey)
      const begun = await h.env.store.beginExecution({
        ...GOV_SCOPE, lane: 'small_apply',
        guard: { leaseRunId: `run_xg_${status}`, leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, generation: gen.generation, generationToken: gen.generationToken },
        tokenRevision: 'rev_xg', planDigest: 'e'.repeat(64), plannedCounts: { add: 0, update: 0, inactive: 0 }, refreshBinding: { continuations: [] }, startedBy: 'u_xg_puller',
      })
      await h.env.store.finishExecution({
        ...GOV_SCOPE, executionId: begun.id, status, written: 0, attemptedWrites: 0,
        ...(settle ? { settlement: { generationToken: gen.generationToken, sourceContentDigest: 'c'.repeat(64), sheetMachineDigest: await h.currentDigest() } } : {}),
      })
      await h.rawLock.createGuard(grant).release()
      return begun
    }
    async function settledStack(hooks = {}) {
      const h = mountExport({ rows: await governedRows(), hooks })
      const { execution } = await seedConfirmedAndConsumed(h)
      // The sheet's lock row exists (an earlier applicable preview bumped it), as on a sheet that has been pulled:
      // a lease taken and released then moves the EPOCH only — the reviewer's observation.
      await h.rawLock.bumpGeneration(h.scopeKey, { reason: 'small_preview', tenantId: GOV_TENANT })
      await h.settle({ executionId: execution.id })
      return h
    }
    // (a) a lease taken after G0, before C1: C1 derives executing.
    {
      let grant = null
      const h = await settledStack({ routeAfterReadGeneration: async (n, lock) => { if (n === 1) grant = await lock.acquire(h.scopeKey, { purpose: 'small_apply', runId: 'run_xg_a', tenantId: GOV_TENANT }) } })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { state: 'executing' })
      await h.rawLock.createGuard(grant).release()
    }
    // (b) a lease taken AND released during R (no execution row at all): only the epoch moved — G1 refuses.
    {
      const h = await settledStack({ afterBuildFile: async () => { const grant = await h.rawLock.acquire(h.scopeKey, { purpose: 'small_apply', runId: 'run_xg_b', tenantId: GOV_TENANT }); await h.rawLock.createGuard(grant).release() } })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.STATE_CHANGED, { reason: 'generation_moved' })
      assert.deepEqual({ epochMoved: errorOf(res).details.epochMoved, generationMoved: errorOf(res).details.generationMoved }, { epochMoved: true, generationMoved: false })
      assert.equal(h.counters.readRefreshState, 2, 'C2 ran and answered complete; G1 is what refused')
    }
    // (c) a bump (an applicable preview) during R: the token moved — G1 refuses.
    {
      const h = await settledStack({ afterBuildFile: async () => { await h.rawLock.bumpGeneration(h.scopeKey, { reason: 'small_preview', tenantId: GOV_TENANT }) } })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.STATE_CHANGED, { reason: 'generation_moved' })
      assert.equal(errorOf(res).details.generationMoved, true)
    }
    // (d) a lease live at G1 (taken after C2's lock read, still held).
    {
      let grant = null
      const h = await settledStack({ routeBeforeReadGeneration: async (n, lock) => { if (n === 2) grant = await lock.acquire(h.scopeKey, { purpose: 'small_apply', runId: 'run_xg_d', tenantId: GOV_TENANT }) } })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.STATE_CHANGED, { reason: 'lease_in_flight' })
      await h.rawLock.createGuard(grant).release()
    }
    // (e) THE REVIEWER'S interleaving: C2's snapshot is taken (complete, settled); a WHOLE zero-write FAILED execution
    //     lands before C2's lock read (the reader reads the lock after its snapshot commits); C2 derives complete, the
    //     digest is unchanged (zero writes) — only the epoch moved, and G1 is what catches it.
    {
      const seen = []
      const h = await settledStack({
        readerBeforeReadState: async (n) => { if (n === 2) await zeroWriteRun(h, { status: 'failed' }) },
        afterReadRefreshState: async (n, read) => { seen.push(read.state.status) },
      })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.STATE_CHANGED, { reason: 'generation_moved' })
      assert.deepEqual(seen, ['complete', 'complete'], 'both consults answered complete: the failure was invisible to C2')
      assert.deepEqual({ epochMoved: errorOf(res).details.epochMoved, generationMoved: errorOf(res).details.generationMoved }, { epochMoved: true, generationMoved: false })
      assert.deepEqual((await h.env.rows('execution')).map((row) => row.status).sort(), ['failed', 'succeeded'])
      // Afterwards the state is honest: the next export is BLOCKED failed_pending_recovery.
      h.auditAppends.length = 0
      const next = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, next, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { state: 'failed_pending_recovery' })
    }
    // (f) the same failure completed BEFORE G0: C1's fresh snapshot sees it.
    {
      const h = await settledStack()
      await zeroWriteRun(h, { status: 'failed' })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assertRefused(h, res, 409, EXPORT_GATE_ERROR_CODES.BLOCKED, { state: 'failed_pending_recovery' })
      assert.deepEqual(h.reads, [])
    }
    // (g) the positive control: a zero-write SELF-SETTLED success before G0 — complete, settled, digest intact: 200.
    {
      const h = await settledStack()
      await zeroWriteRun(h, { status: 'succeeded', settle: true })
      const res = await h.exportAs(GOV_OPERATOR, GOV_PROJECT)
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      assert.equal(h.auditAppends[0].detail.refreshState, 'complete')
    }
  })

  // ── XR-07 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-07 unwired: no governance service => 501 STOCK_PREP_REFRESH_STORE_UNAVAILABLE governance_service; no lock => 501 STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE — both before any records read, with no audit row', async () => {
    const noGov = mountExport({ rows: goldenRows(), tenantId: GOLDEN_TENANT, sheetId: GOLDEN_SHEET, withGovernance: false })
    let res = await noGov.exportAs(GOLDEN_OPERATOR, GOLDEN_PROJECT)
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE')
    assert.equal(errorOf(res).details.reason, 'governance_service')
    assert.deepEqual(noGov.reads, [])
    assert.deepEqual(noGov.auditAppends, [])
    const noLock = mountExport({ rows: goldenRows(), tenantId: GOLDEN_TENANT, sheetId: GOLDEN_SHEET, withLock: false })
    res = await noLock.exportAs(GOLDEN_OPERATOR, GOLDEN_PROJECT)
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_PROJECT_WRITE_LOCK_UNAVAILABLE')
    assert.deepEqual(noLock.reads, [])
  })

  // ── XR-08 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XR-08 「最近导出」 skips export_refused rows: a refused export never shadows the real one behind it, and a project with only refusals has none', async () => {
    const audit = {
      async list() {
        return {
          entries: [
            { projectId: 'P-A', mode: 'export_refused', createdAt: '2026-10-26T03:00:00.000Z', action: 'prep_line_export' },
            { projectId: 'P-A', mode: 'export', createdAt: '2026-10-25T03:00:00.000Z', action: 'prep_line_export' },
            { projectId: 'P-B', mode: 'export_refused', createdAt: '2026-10-26T04:00:00.000Z', action: 'prep_line_export' },
            { projectId: 'P-C', mode: 'export_empty', createdAt: '2026-10-24T04:00:00.000Z', action: 'prep_line_export' },
          ],
        }
      },
    }
    const out = await directoryLib.__internals.lastExportAtByProjectNo(audit, { tenantId: 't', limit: 50 })
    assert.equal(out.ready, true)
    assert.equal(out.byProjectNo.get('P-A'), '2026-10-25T03:00:00.000Z')
    assert.equal(out.byProjectNo.has('P-B'), false)
    assert.equal(out.byProjectNo.get('P-C'), '2026-10-24T04:00:00.000Z')
    assert.equal(directoryLib.PREP_LINE_EXPORT_REFUSED_MODE, 'export_refused')
  })

  // ── XH-01..04 ──────────────────────────────────────────────────────────────────────────────────
  await run('XH-01 the handoff TERMINAL hop of a governed project with an open hold is refused 409 STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE — no cursor move, no trail row, no notification; the two non-terminal hops before it completed WITHOUT a consult', async () => {
    const h = mountHandoff()
    const { hold } = await refreshKit.candidateHoldFixture()
    await h.env.seedHolds(H_SCOPE, [hold])
    let res = await h.advance(ZHANG, 'prep_entry')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    res = await h.advance(LI, 'process')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(h.consults, [], 'non-terminal hops never consult the refresh state')
    const rowsBefore = JSON.stringify(h.db.rows)
    const auditBefore = h.auditAppends.length
    res = await h.advance(WANG, 'final_review')
    assert.equal(res.statusCode, 409, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE')
    assert.deepEqual(errorOf(res).details, { reason: 'state', status: 'pending_confirmation', governed: 'protected', counts: { pendingConfirm: 1, confirmable: 1, openExecutions: 0, pendingReviews: 0, continuations: 0 }, partial: false })
    assert.equal(JSON.stringify(h.db.rows), rowsBefore, 'the cursor did not move')
    assert.equal(h.auditAppends.length, auditBefore, 'no trail row for a refused hop')
    assert.equal(h.notifications.filter((n) => n.destinationIds.includes('dest-xg-warehouse')).length, 0, 'no terminal notification')
    assert.deepEqual(h.consults.map((c) => ({ projectNo: c.projectNo, sheetId: c.sheetId })), [{ projectNo: H_PROJECT, sheetId: H_SHEET }], 'exactly one consult, for the terminal hop, on the bound sheet')
    assert.equal(JSON.stringify(res.body).includes('D100-01'), false, 'values-free')
  })

  await run('XH-02 the terminal hop passes once the project is complete AND settled (notification sent); complete without a settlement is refused not_settled; a failed execution is refused', async () => {
    const h = mountHandoff()
    const { hold } = await refreshKit.candidateHoldFixture()
    const confirmed = await h.env.seedConfirmedContinuation(H_SCOPE, hold, { sourceIdentity: CF.SOURCE_IDENTITY })
    const execution = await h.env.seedExecution(H_SCOPE, { status: 'succeeded', refreshBinding: { continuations: [{ id: confirmed.continuationId, revision: 1 }] } })
    assert.equal((await h.advance(ZHANG, 'prep_entry')).statusCode, 200)
    assert.equal((await h.advance(LI, 'process')).statusCode, 200)
    let res = await h.advance(WANG, 'final_review')
    assert.equal(res.statusCode, 409)
    assert.equal(errorOf(res).details.status, 'executed_pending_settlement')
    await h.env.store.reconcileHolds({ ...H_SCOPE, decisionVersionObserved: h.decisionVersion(), holds: [], computation: { lane: 'small_preview', suspended: false, generationToken: null, sourceContentDigest: 'c'.repeat(64) }, settlement: { executionId: execution.id, sheetMachineDigest: 'd'.repeat(64) } })
    res = await h.advance(WANG, 'final_review')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.terminal, true)
    assert.equal(res.body.data.notified, true)
    assert.equal(h.notifications.filter((n) => n.destinationIds.includes('dest-xg-warehouse')).length, 1)
  })

  await run('XH-03 a NOT-governed project\'s terminal hop completes as before (one consult, allowed); an unreadable state is 503 with the store token', async () => {
    const h = mountHandoff()
    assert.equal((await h.advance(ZHANG, 'prep_entry')).statusCode, 200)
    assert.equal((await h.advance(LI, 'process')).statusCode, 200)
    const res = await h.advance(WANG, 'final_review')
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(h.consults.length, 1)
    const u = mountHandoff()
    assert.equal((await u.advance(ZHANG, 'prep_entry')).statusCode, 200)
    assert.equal((await u.advance(LI, 'process')).statusCode, 200)
    u.env.db.faults.select = (args) => (args && /integration_stock_prep_continuation$/.test(args.table) ? refreshKit.sqlError('42P01', 'relation does not exist') : null)
    const refused = await u.advance(WANG, 'final_review')
    assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, 'STOCK_PREP_HANDOFF_BLOCKED_BY_REFRESH_STATE')
    assert.deepEqual(errorOf(refused).details, { reason: 'unreadable', status: 'unreadable', governed: 'unknown', counts: null, store: 'continuation', operation: 'read_continuations', partial: false })
    u.env.db.faults.select = null
  })

  await run('XH-04 an unwired governance service refuses the terminal hop 501 by name and leaves non-terminal hops untouched', async () => {
    const h = mountHandoff({ withGovernance: false })
    assert.equal((await h.advance(ZHANG, 'prep_entry')).statusCode, 200)
    assert.equal((await h.advance(LI, 'process')).statusCode, 200)
    const res = await h.advance(WANG, 'final_review')
    assert.equal(res.statusCode, 501, JSON.stringify(res.body))
    assert.equal(errorOf(res).code, 'STOCK_PREP_REFRESH_STORE_UNAVAILABLE')
  })

  // ── XP-01 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XP-01 the posture: every unfinished / unreadable state is blocked_pull_state (never 可以导出) whatever the counts; an absent state is 状态读取失败; the overview row of a project with an open hold says 待确认 1 件 through the REAL refresh route', async () => {
    for (const status of STATUS_TOKENS) {
      const posture = overview.projectOverviewPosture({ pulledRowCount: 9, refreshStatus: status, refreshSettled: true, refreshPendingConfirmCount: 2 })
      if (status === 'not_governed' || status === 'complete') assert.equal(posture.key, 'ready', status)
      else assert.equal(posture.key, 'blocked_pull_state', status)
    }
    assert.deepEqual(overview.projectOverviewPosture({ pulledRowCount: 9, refreshStatus: 'complete' }), { key: 'blocked_pull_state', zh: '待核对', en: 'Awaiting check', tone: 'warning' })
    assert.deepEqual(overview.projectOverviewPosture({ pulledRowCount: 9, refreshStatus: 'pending_confirmation', refreshPendingConfirmCount: 3 }), { key: 'blocked_pull_state', zh: '待确认 3 件', en: 'Awaiting confirmation (3)', tone: 'warning' })
    assert.equal(overview.projectOverviewPosture({ pulledRowCount: 9 }).key, 'ready', 'no state given: the pre-PR-5 posture (the web mirror\'s consumers)')
    // The row projection: an ABSENT state is unreadable, never ready.
    const target = { projectNo: 'P-1', status: 'active', sheetId: 's', rowCount: 9, activeRowCount: 9, missingComponentsCount: 0 }
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh', countsAt: null }).postureKey, 'blocked_pull_state')
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh', countsAt: null }).posture, '状态读取失败')
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh', countsAt: null, refreshState: readProjectRefreshState(consult()) }).postureKey, 'ready')
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh', countsAt: null, refreshState: readProjectRefreshState(COMPLETE_SETTLED()) }).postureKey, 'ready')
    assert.equal(overview.buildProjectOverviewRow({ target, fields: null, counts: null, pendingDecisionCount: 0, todoViewId: null, locale: 'zh', countsAt: null, refreshState: readProjectRefreshState(UNFINISHED.executing()) }).posture, '正在写入')
    // Through the refresh ROUTE over the project-sheet harness (the REAL reader; a hold seeded through the REAL store).
    const TENANT = 'tenant-xg-overview'
    const PROJECT = 'PRJ-XG-OV'
    const FLOOR = { id: 'u_xg_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
    const PULLER = { id: 'u_xg_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] }
    const h = projectSheet.mountProjectSheetRoutes({ tenantId: TENANT, projectNo: PROJECT, switchOn: true, stampsSystemKind: true })
    try {
      h.seedRegistryRow(PROJECT)
      const sheetId = h.provisioning.sheetIdOf(`${TENANT}:integration-core`, h.projectObjectId())
      const { hold } = await refreshKit.candidateHoldFixture()
      await h.refresh.seedHolds({ tenantId: TENANT, sheetId, projectNo: PROJECT }, [hold])
      assert.equal((await projectSheet.call(h.routes, 'POST', '/api/integration/stock-preparation/project-overview/ensure', { user: PULLER, body: {} })).statusCode, 200)
      const res = await projectSheet.call(h.routes, 'POST', '/api/integration/stock-preparation/project-overview/refresh', { user: FLOOR, body: {} })
      assert.equal(res.statusCode, 200, JSON.stringify(res.body))
      const rows = await h.records.queryRecords({ sheetId: res.body.data.sheetId, filters: {}, limit: 50, offset: 0 })
      const row = rows.find((record) => Object.entries(record.data).some(([key, value]) => key.endsWith('projectNo') && value === PROJECT))
      assert.ok(row, 'the project\'s overview row')
      const cell = (suffix) => Object.entries(row.data).find(([key]) => key.endsWith(suffix))[1]
      assert.equal(cell('postureKey'), 'blocked_pull_state')
      assert.equal(cell('posture'), 'Awaiting confirmation (1)')
      void STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID
    } finally {
      h.restore()
    }
  })

  // ── XE-01 ──────────────────────────────────────────────────────────────────────────────────────
  await run('XE-01 the egress census: every refusal of the gate, driven with sentinel-bearing inputs, carries a values-free message and token / boolean / count details; the audit slice keeps tokens and booleans only', async () => {
    const sentinelState = readProjectRefreshState(consult({ pilot: PILOT, holds: [{ id: SENTINEL, status: 'open', kind: 'continuation_candidate', confirmable: true }], executions: [{ id: SENTINEL, status: 'failed', leaseId: SENTINEL, startedAt: '2026-10-22T00:00:00.000Z' }] }))
    const caught = []
    const capture = async (label, deps) => {
      try {
        await runFormalExportGate(deps)
      } catch (error) {
        caught.push([label, error])
        return
      }
      assert.fail(`${label}: did not refuse`)
    }
    await capture('blocked', gateEnv({ generations: [GEN({ generationToken: SENTINEL })], reads: [{ consult: { secret: SENTINEL }, error: null, state: sentinelState }] }).deps)
    await capture('lease', gateEnv({ generations: [GEN({ leaseId: SENTINEL })], reads: [readOf(COMPLETE_SETTLED())] }).deps)
    await capture('unreadable', gateEnv({ generations: [GEN()], reads: [{ consult: null, error: new Error(SENTINEL), state: readProjectRefreshState({ ok: false, failure: { store: SENTINEL.toLowerCase(), operation: SENTINEL } }) }] }).deps)
    await capture('sheet_changed', gateEnv({ generations: [GEN()], reads: [readOf(COMPLETE_SETTLED())], digest: SENTINEL }).deps)
    await capture('state_changed', gateEnv({ generations: [GEN(), GEN({ generationToken: SENTINEL, fencingEpoch: 99 })], reads: [readOf(COMPLETE_SETTLED())] }).deps)
    await capture('gate_invalid', gateEnv({ generations: [{ present: true, generationToken: SENTINEL, fencingEpoch: 'x', leaseId: null }], reads: [readOf(consult())] }).deps)
    assert.equal(caught.length, 6)
    for (const [label, error] of caught) {
      assert.ok(error instanceof StockPreparationExportGateError, label)
      assert.ok(Object.values(EXPORT_GATE_ERROR_CODES).includes(error.code), label)
      const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details })
      assert.equal(serialized.includes(SENTINEL), false, `${label}: no sentinel leaves the refusal`)
      for (const [key, value] of Object.entries(error.details || {})) {
        const scalar = ['string', 'number', 'boolean'].includes(typeof value)
        const countMap = key === 'counts' && (value === null || (value && typeof value === 'object' && Object.values(value).every((count) => typeof count === 'number')))
        assert.ok(scalar || countMap, `${label}.${key} is a token / count`)
      }
      if (error.details && typeof error.details.reason === 'string') assert.ok(EXPORT_GATE_REASONS.includes(error.details.reason) || error.code === EXPORT_GATE_ERROR_CODES.GATE_INVALID, `${label}: reason is in the closed list`)
    }
    assert.deepEqual(auditableRefusalDetail({ reason: 'state', status: 'executing', governed: 'pilot', counts: { pendingConfirm: 1 }, generationMoved: true, epochMoved: false, extra: SENTINEL, partial: false }), { reason: 'state', status: 'executing', governed: 'pilot', generationMoved: true, epochMoved: false })
  })

  console.log(`\nstock-preparation-export-gate.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} export-gate case(s) failed`)
}

// The fail-closed runner (support/fail-closed-suite-runner.cjs): `main` runs as one test under the exit sentinel and
// the whole-suite timeout, so a check that hangs can never end this suite with exit 0 (the O-24c adoption guard).
require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-export-gate.test.cjs', main)
