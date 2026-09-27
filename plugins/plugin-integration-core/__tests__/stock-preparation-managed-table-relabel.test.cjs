'use strict'

// 「把系统表的英文表头改成中文」 — THROUGH THE REAL ROUTE TABLE (客户反馈 2026-09-24 #4a).
//
// The host primitive's own guarantees (compare-and-set in SQL, registry triple, config revision per
// rename, field ids / permissions untouched, fence first) are proven against a SQL-honouring fake in
// packages/core-backend/tests/unit/multitable-object-display-name-relabel.test.ts. This suite proves
// the PLUGIN half: who may call it, which tenant's project it acts on, which tables and which target
// names it asks for, that the dry run is the default, and that what comes back is values-free.
//
//   L1  non-admin tiers (integration:write, the stock-prep operator, stock-prep:read, a bare user)
//       => 403 with ZERO host calls; no principal => 401.
//   L2  stock-prep:admin and platform admin both pass the gate.
//   L3  DRY RUN IS THE DEFAULT: `{}` => mode dry_run, every host call carried apply:false, the fake
//       table is unchanged; `{ apply: true }` => apply, renamed, revisions counted.
//   L4  the request cannot steer or smuggle: apply:"true" / apply:1, any other body key (tenantId,
//       projectId, objectId, fields, baseId, locale) and ANY query key => 400 with zero host calls.
//   L5  tenancy: the project is `${verifiedClaim}:integration-core` on EVERY host call; a claimless
//       token => 403 TENANT_CLAIM_REQUIRED even for platform admin; a header-filled user.tenantId
//       that contradicts the claim => 403; zero host calls in both refusals.
//   L6  targets: the main table and the ledger always, plus exactly the SANDBOX objectIds the
//       configured customer packs declare — never an objectId from the request. Target names are
//       pickTemplateLabel(…, 'zh-CN'); the ledger asks for the 16 agreed names.
//   L7  per-table outcomes: an absent table is `absent`; a table the registry does not bind to this
//       project is `scope_unavailable` and the host's refusal message (which names the project id)
//       never reaches the response or the log.
//   L8  hand-renamed / taken columns are reported and untouched; second run => all already_target,
//       hasPendingRenames false, zero revisions.
//   L9  values-free: no tenant id, project id, sheet id, physical field id or current (hand-typed)
//       name anywhere in the response.
//   L10 an old host (no relabelObjectDisplayNames) => 501 MANAGED_TABLE_RELABEL_API_UNAVAILABLE.
//   L11 a host answering an unknown status => 502, never passed through to the admin's screen.
//   L12 the route table names the route exactly once, and its handler's gate is STOCK_PREP_ADMIN.
//   L13 the MODULE's own contract: anything but `apply === true` is a dry run (undefined / null /
//       'true' / 1 / {}), independent of the route's boolean normalizer.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  pickTemplateLabel,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { sandboxStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const {
  buildRelabelRequests,
  listManagedTableRelabelTargets,
  runStockPreparationManagedTableRelabel,
} = require(path.join(LIB, 'stock-preparation-managed-table-relabel.cjs'))
const { FACTORY_A_SAMPLE_PACK } = require(path.join(LIB, 'customer-packs', 'factory-a.sample.cjs'))

const ROUTE = '/api/integration/stock-preparation/managed-tables/relabel-zh'
const TENANT_ID = 'tenant_relabel_a'
const OTHER_TENANT_ID = 'tenant_relabel_b'
const STAGING_PROJECT_ID = `${TENANT_ID}:integration-core`
const MAIN = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const LEDGER = STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId
const SANDBOX = 'plm_stock_preparation_sandbox_factory_a'

const USERS = Object.freeze({
  platformAdmin: { id: 'u_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: [] },
  integrationAdmin: { id: 'u_int_admin', tenantId: TENANT_ID, roles: [], permissions: ['integration:admin'] },
  stockPrepAdmin: { id: 'u_sp_admin', tenantId: TENANT_ID, roles: [], permissions: ['stock-prep:admin'] },
  integrationWriter: { id: 'u_writer', tenantId: TENANT_ID, roles: [], permissions: ['integration:write'] },
  operator: { id: 'u_operator', tenantId: TENANT_ID, roles: [], permissions: ['stock-prep:read', 'stock-prep:operate'] },
  reader: { id: 'u_reader', tenantId: TENANT_ID, roles: [], permissions: ['stock-prep:read'] },
  bare: { id: 'u_bare', tenantId: TENANT_ID, roles: [], permissions: [] },
})

// The agreed ledger vocabulary (stock-preparation-template-zh-labels.test.cjs), restated so this
// suite fails if the relabel ever asks for something else.
const LEDGER_ZH = Object.freeze({
  decisionId: '裁决ID',
  stableDecisionKey: '稳定裁决键',
  projectNo: '项目号',
  rowIdentity: '行身份',
  conflictType: '冲突类型',
  inputFingerprint: '输入指纹',
  sourceRevision: '源修订',
  status: '状态',
  openedAt: '开启时间',
  resolutionAction: '处理动作',
  resolvedValue: '录入值',
  resolvedAuxValue: '录入辅助值',
  notes: '备注',
  confirmedBy: '确认人',
  confirmedAt: '确认时间',
  supersededAt: '作废时间',
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function templateFor(objectId) {
  if (objectId === MAIN) return STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
  if (objectId === LEDGER) return STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE
  return sandboxStockPreparationTemplate({ objectId })
}

// The host's OWN refusal shape for an unclaimed object: no status, and a message that NAMES the
// project id (packages/core-backend/src/multitable/plugin-scope.ts MultitableObjectScopeError).
function hostObjectScopeError(projectId, objectId) {
  return Object.assign(
    new Error(`Plugin integration-core cannot claim multitable object ${projectId}/${objectId}; owned by unclaimed`),
    { name: 'MultitableObjectScopeError', code: 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN' },
  )
}

/**
 * A host with English-named managed tables. `tables` lists which objectIds exist; `unregistered`
 * ones exist but have no registry row. The relabel primitive follows the host contract: a column is
 * renamed only while its current name equals expectedName, a target held by another column is
 * `skipped_name_taken`, apply !== true writes nothing.
 */
function createHost({ tables = [MAIN, LEDGER], unregistered = [], withRelabel = true, badStatus = false, deletedAfterFind = [] } = {}) {
  const state = new Map()
  for (const objectId of tables) {
    const template = templateFor(objectId)
    state.set(objectId, {
      sheetName: template.label,
      columns: new Map(template.fields.map((field) => [field.id, field.label])),
      extraNames: [],
    })
  }
  const calls = { findObjectSheet: [], relabel: [], other: [] }
  let revisions = 0
  const provisioning = {
    async findObjectSheet({ projectId, objectId }) {
      calls.findObjectSheet.push({ projectId, objectId })
      return state.has(objectId) ? { id: `sheet_${objectId}`, baseId: 'base_sp', name: 'x', description: null } : null
    },
    async resolveFieldIds() { calls.other.push('resolveFieldIds'); throw new Error('the relabel route must not resolve field ids') },
    async ensureObject() { calls.other.push('ensureObject'); throw new Error('the relabel route must not ensure objects') },
    async patchObjectFieldProperty() { calls.other.push('patchObjectFieldProperty'); throw new Error('the relabel route must not patch properties') },
  }
  if (withRelabel) {
    provisioning.relabelObjectDisplayNames = async (input) => {
      calls.relabel.push(clone(input))
      // Faithful to the real stack: an object that was never provisioned has no registry row, so the
      // plugin-scope object check refuses it BEFORE the host primitive runs — exactly like an
      // explicitly unregistered (hand-made / dump-restored) sheet.
      if (unregistered.includes(input.objectId) || !state.has(input.objectId)) throw hostObjectScopeError(input.projectId, input.objectId)
      // Registered, but the sheet was deleted between the plugin's find and the host's transaction.
      if (deletedAfterFind.includes(input.objectId)) {
        return { present: false, applied: input.apply === true, sheetId: 'sheet_x', sheetName: null, fields: [], revisionCount: 0, batchId: null }
      }
      const table = state.get(input.objectId)
      const apply = input.apply === true
      const allNames = () => [...table.columns.values(), ...table.extraNames]
      const decide = (current, request, takenBy) => {
        if (current === undefined) return 'missing'
        if (current === request.nextName) return 'already_target'
        if (current !== request.expectedName) return 'skipped_name_changed'
        if (takenBy) return 'skipped_name_taken'
        return apply ? 'renamed' : 'would_rename'
      }
      let revisionCount = 0
      const fields = input.fields.map((request) => {
        const current = table.columns.get(request.fieldId)
        const takenBy = allNames().filter((name) => name === request.nextName).length > 0 && current !== request.nextName
        const status = decide(current, request, takenBy)
        if (status === 'renamed') {
          table.columns.set(request.fieldId, request.nextName)
          revisionCount += 1
        }
        return { fieldId: request.fieldId, status: badStatus ? 'overwritten' : status }
      })
      let sheetName = null
      if (input.sheetName) {
        const status = decide(table.sheetName, input.sheetName, false)
        if (status === 'renamed') {
          table.sheetName = input.sheetName.nextName
          revisionCount += 1
        }
        sheetName = { status }
      }
      revisions += revisionCount
      return { present: true, applied: apply, sheetId: `sheet_${input.objectId}`, sheetName, fields, revisionCount, batchId: revisionCount ? 'batch_1' : null }
    }
  }
  return {
    provisioning,
    calls,
    state,
    revisions: () => revisions,
    hostCallCount: () => calls.findObjectSheet.length + calls.relabel.length + calls.other.length,
    rename(objectId, fieldId, name) { state.get(objectId).columns.set(fieldId, name) },
    addColumnNamed(objectId, name) { state.get(objectId).extraNames.push(name) },
  }
}

function inertService(methods) {
  const service = {}
  for (const method of methods) service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems', 'getExternalSystemForAdapter']),
    adapterRegistry: { createAdapter() { throw new Error('unexpected adapter creation') }, listAdapterKinds() { return [] } },
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

function sandboxPack() {
  return { ...clone(FACTORY_A_SAMPLE_PACK), targetObjectId: SANDBOX }
}

function mount(hostOptions = {}, { packs } = {}) {
  const routes = new Map()
  const host = createHost(hostOptions)
  const logLines = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          const key = `${method.toUpperCase()} ${routePath}`
          assert.equal(routes.has(key), false, `route ${key} registered twice`)
          routes.set(key, handler)
        },
      },
      multitable: { provisioning: host.provisioning, records: {} },
    },
    storage: Object.assign(new Map(), { durable: true }),
    config: packs ? { stockPreparationCustomerPacks: packs } : {},
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: baseServices(),
    logger: {
      info(message, detail) { logLines.push(['info', message, detail]) },
      warn(message, detail) { logLines.push(['warn', message, detail]) },
      error(message, detail) { logLines.push(['error', message, detail]) },
    },
  })
  return { routes, host, logLines }
}

// `user` / `claim` are read by PRESENCE, not by default parameter: an explicit `undefined` means "no
// principal" / "claimless token" and must not silently become the default admin.
async function relabel(harness, options = {}) {
  const user = Object.prototype.hasOwnProperty.call(options, 'user') ? options.user : USERS.stockPrepAdmin
  const claim = Object.prototype.hasOwnProperty.call(options, 'claim') ? options.claim : TENANT_ID
  const body = options.body || {}
  const query = options.query || {}
  const handler = harness.routes.get(`POST ${ROUTE}`)
  assert.ok(handler, 'the relabel route is registered')
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
  const req = { user, body, query, params: {} }
  if (claim !== undefined) req.authenticatedTenantId = claim
  await handler(req, res)
  assert.notEqual(res.body, undefined, 'the route produced a body')
  return res
}

function assertValuesFree(payload, label, extra = []) {
  const text = JSON.stringify(payload)
  for (const token of [TENANT_ID, 'integration-core', 'sheet_', 'fld_', SANDBOX, ...extra]) {
    assert.equal(text.includes(token), false, `${label} must not carry "${token}"`)
  }
}

function tableOf(res, kind) {
  return res.body.data.tables.find((table) => table.kind === kind)
}

// ── L1 / L2 ───────────────────────────────────────────────────────────────────────────────────

async function l1NonAdminTiersAreRefusedBeforeAnyHostCall() {
  for (const name of ['integrationWriter', 'operator', 'reader', 'bare']) {
    const harness = mount()
    const res = await relabel(harness, { user: USERS[name], body: { apply: true } })
    assert.equal(res.statusCode, 403, `L1: ${name} must be refused, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, 'FORBIDDEN')
    assert.equal(harness.host.hostCallCount(), 0, `L1: ${name} reached the host`)
  }
  const harness = mount()
  const res = await relabel(harness, { user: undefined })
  assert.equal(res.statusCode, 401, 'L1: no principal => 401')
  assert.equal(harness.host.hostCallCount(), 0)
}

async function l2AdminTiersPassTheGate() {
  for (const name of ['stockPrepAdmin', 'platformAdmin', 'integrationAdmin']) {
    const harness = mount()
    const res = await relabel(harness, { user: USERS[name] })
    assert.equal(res.statusCode, 200, `L2: ${name} must pass, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  }
}

// ── L3 ────────────────────────────────────────────────────────────────────────────────────────

async function l3DryRunIsTheDefaultAndApplyWrites() {
  const harness = mount()
  const dry = await relabel(harness)
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.body.data.mode, 'dry_run')
  assert.ok(harness.host.calls.relabel.length === 2, 'L3: main + ledger were evaluated')
  assert.ok(harness.host.calls.relabel.every((call) => call.apply === false), 'L3: every host call of the dry run carried apply:false')
  assert.equal(harness.host.revisions(), 0, 'L3: the dry run wrote nothing')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), 'Status', 'L3: the table is unchanged after the dry run')
  assert.equal(dry.body.data.hasPendingRenames, true)
  const ledger = tableOf(dry, 'ledger')
  assert.equal(ledger.status, 'present')
  assert.ok(ledger.fields.every((field) => field.status === 'would_rename'))
  assert.deepEqual(ledger.sheetName, { from: 'Stock Preparation Confirmation Decision', to: '备料确认账本', status: 'would_rename' })

  const applied = await relabel(harness, { body: { apply: true } })
  assert.equal(applied.statusCode, 200)
  assert.equal(applied.body.data.mode, 'apply')
  assert.ok(harness.host.calls.relabel.slice(2).every((call) => call.apply === true), 'L3: apply reached the host as apply:true')
  assert.ok(harness.host.calls.relabel.every((call) => call.actorId === USERS.stockPrepAdmin.id), 'L3: the caller is the attributed actor')
  const ledgerApplied = tableOf(applied, 'ledger')
  assert.ok(ledgerApplied.fields.every((field) => field.status === 'renamed'))
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), '状态')
  assert.equal(harness.host.state.get(LEDGER).sheetName, '备料确认账本')
  const expectedRevisions = 16 + 1 + STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length + 1
  assert.equal(applied.body.data.revisionCount, expectedRevisions, 'L3: revisionCount is the host total')
  assert.equal(applied.body.data.totals.renamed, expectedRevisions)
  const log = harness.logLines.find((line) => /managed-table relabel applied/.test(line[1]))
  assert.ok(log, 'L3: apply is logged (counts only)')
  // The message carries the plugin's own [plugin-integration-core] tag; the DETAIL is what must be values-free.
  assertValuesFree(log[2], 'L3 log detail')
  assert.deepEqual(Object.keys(log[2]).sort(), ['renamed', 'revisionCount', 'skippedNameChanged', 'skippedNameTaken', 'tableCount'])
  return harness
}

// ── L4 ────────────────────────────────────────────────────────────────────────────────────────

async function l4TheRequestCannotSteerOrSmuggle() {
  const bodies = [
    { apply: 'true' },
    { apply: 1 },
    { tenantId: TENANT_ID },
    { projectId: STAGING_PROJECT_ID },
    { objectId: SANDBOX },
    { fields: [{ fieldId: 'status', nextName: 'x' }] },
    { baseId: 'base_x' },
    { locale: 'en' },
  ]
  for (const body of bodies) {
    const harness = mount()
    const res = await relabel(harness, { user: USERS.platformAdmin, body })
    assert.equal(res.statusCode, 400, `L4: body ${JSON.stringify(body)} must be refused, got ${res.statusCode}`)
    assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_REQUEST_INVALID')
    assert.equal(harness.host.hostCallCount(), 0, `L4: body ${JSON.stringify(body)} reached the host`)
  }
  for (const query of [{ apply: 'true' }, { tenantId: TENANT_ID }, { projectId: STAGING_PROJECT_ID }]) {
    const harness = mount()
    const res = await relabel(harness, { user: USERS.platformAdmin, query })
    assert.equal(res.statusCode, 400, `L4: query ${JSON.stringify(query)} must be refused`)
    assert.equal(harness.host.hostCallCount(), 0)
  }
}

// ── L5 ────────────────────────────────────────────────────────────────────────────────────────

async function l5TheProjectIsTheVerifiedTenantsStagingProject() {
  const harness = mount({}, { packs: { 'factory-a': sandboxPack() } })
  harness.host.state.set(SANDBOX, { sheetName: 'PLM Stock Preparation Sandbox', columns: new Map(), extraNames: [] })
  await relabel(harness, { body: { apply: true } })
  const projects = [...harness.host.calls.findObjectSheet, ...harness.host.calls.relabel].map((call) => call.projectId)
  assert.ok(projects.length >= 5)
  assert.deepEqual([...new Set(projects)], [STAGING_PROJECT_ID], 'L5: every host call named the verified tenant\'s staging project')

  const second = mount()
  await relabel(second, { user: { ...USERS.stockPrepAdmin, tenantId: OTHER_TENANT_ID }, claim: OTHER_TENANT_ID })
  assert.deepEqual(
    [...new Set(second.host.calls.relabel.map((call) => call.projectId))],
    [`${OTHER_TENANT_ID}:integration-core`],
    'L5: a second tenant acts on its own project',
  )

  for (const name of ['platformAdmin', 'stockPrepAdmin']) {
    const claimless = mount()
    const res = await relabel(claimless, { user: USERS[name], claim: undefined })
    assert.equal(res.statusCode, 403, `L5: a claimless ${name} is refused`)
    assert.equal(res.body.error.code, 'TENANT_CLAIM_REQUIRED')
    assert.equal(claimless.host.hostCallCount(), 0)
  }

  const contradicted = mount()
  const res = await relabel(contradicted, { user: { ...USERS.stockPrepAdmin, tenantId: OTHER_TENANT_ID }, claim: TENANT_ID })
  assert.equal(res.statusCode, 403, 'L5: a header-filled tenant contradicting the claim is refused')
  assert.equal(res.body.error.code, 'TENANT_MISMATCH')
  assert.equal(contradicted.host.hostCallCount(), 0)
}

// ── L6 ────────────────────────────────────────────────────────────────────────────────────────

async function l6TargetsAreServerHeldAndTemplateNamed() {
  // Without packs: exactly main + ledger.
  assert.deepEqual(listManagedTableRelabelTargets({}).map((target) => target.objectId), [MAIN, LEDGER])

  // The ledger asks for the 16 agreed names, from its English template labels.
  const ledgerRequests = buildRelabelRequests(STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE)
  assert.equal(ledgerRequests.fields.length, 16)
  for (const request of ledgerRequests.fields) {
    const field = STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.fields.find((candidate) => candidate.id === request.fieldId)
    assert.equal(request.expectedName, field.label, `L6: ${request.fieldId} compares against its English template label`)
    assert.equal(request.nextName, LEDGER_ZH[request.fieldId], `L6: ${request.fieldId} targets the agreed name`)
    assert.equal(request.nextName, pickTemplateLabel(field, 'zh-CN'))
  }
  // The main table: every column, from pickTemplateLabel.
  const mainRequests = buildRelabelRequests(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  assert.equal(mainRequests.fields.length, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.length)
  assert.deepEqual(mainRequests.sheetName, { expectedName: 'PLM Stock Preparation Main', nextName: '备料主表' })

  // With a pack declaring a sandbox: exactly that one sandbox, with the sandbox's own names.
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX] }, { packs: { 'factory-a': sandboxPack() } })
  const res = await relabel(harness)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.deepEqual(harness.host.calls.relabel.map((call) => call.objectId), [MAIN, LEDGER, SANDBOX])
  const sandboxCall = harness.host.calls.relabel[2]
  assert.deepEqual(sandboxCall.sheetName, { expectedName: 'PLM Stock Preparation Sandbox', nextName: '备料主表(沙箱)' })
  const sandbox = tableOf(res, 'sandbox')
  assert.equal(typeof sandbox.objectIdHash, 'string', 'L6: the sandbox objectId travels hashed')
  assert.equal(sandbox.objectId, undefined)
  // A pack whose declared target is not in the sandbox namespace contributes nothing.
  assert.deepEqual(
    listManagedTableRelabelTargets({ packCatalog: { packIds: ['p'], get: () => ({ targetObjectId: MAIN }) } }).map((target) => target.objectId),
    [MAIN, LEDGER],
  )
}

// ── L7 ────────────────────────────────────────────────────────────────────────────────────────

async function l7AbsentAndUnregisteredTablesAreReportedNotGuessed() {
  const harness = mount({ tables: [MAIN, LEDGER], unregistered: [LEDGER] })
  harness.host.state.delete(MAIN)
  const res = await relabel(harness, { body: { apply: true } })
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(tableOf(res, 'main').status, 'absent')
  assert.equal(tableOf(res, 'ledger').status, 'scope_unavailable')
  assert.deepEqual(tableOf(res, 'ledger').fields, [])
  assert.equal(harness.host.revisions(), 0)
  assert.deepEqual(harness.host.calls.relabel.map((call) => call.objectId), [LEDGER], 'L7: an absent table is never handed to the host')
  assertValuesFree(res.body, 'L7 response')
  for (const line of harness.logLines) assertValuesFree(line[2] || {}, 'L7 log detail')

  // Found by the plugin, then gone by the time the host's transaction looked: reported absent, and
  // the (empty) host answer is never projected as if it were a plan.
  const raced = mount({ deletedAfterFind: [LEDGER] })
  const racedRes = await relabel(raced, { body: { apply: true } })
  assert.equal(racedRes.statusCode, 200, JSON.stringify(racedRes.body))
  assert.equal(tableOf(racedRes, 'ledger').status, 'absent')
  assert.deepEqual(tableOf(racedRes, 'ledger').fields, [])
}

// ── L13 — the MODULE's own dry-run contract, independent of the route's boolean normalizer ─────

async function l13TheModuleWritesOnlyOnExactlyTrue() {
  for (const apply of [undefined, null, 'true', 1, {}]) {
    const host = createHost()
    const result = await runStockPreparationManagedTableRelabel({ provisioning: host.provisioning, projectId: STAGING_PROJECT_ID, apply })
    assert.equal(result.mode, 'dry_run', `L13: apply=${JSON.stringify(apply)} is a dry run`)
    assert.ok(host.calls.relabel.every((call) => call.apply === false), `L13: apply=${JSON.stringify(apply)} reached the host as apply:false`)
    assert.equal(host.revisions(), 0)
  }
  const host = createHost()
  const result = await runStockPreparationManagedTableRelabel({ provisioning: host.provisioning, projectId: STAGING_PROJECT_ID, apply: true })
  assert.equal(result.mode, 'apply')
  assert.ok(host.revisions() > 0)
}

// ── L8 ────────────────────────────────────────────────────────────────────────────────────────

async function l8HandRenamedAndTakenAreLeftAloneAndTheSecondRunIsANoOp() {
  const harness = mount()
  harness.host.rename(LEDGER, 'status', '处理状态')
  harness.host.addColumnNamed(LEDGER, '备注')
  const first = await relabel(harness, { body: { apply: true } })
  const ledger = tableOf(first, 'ledger')
  assert.equal(ledger.fields.find((field) => field.fieldId === 'status').status, 'skipped_name_changed')
  assert.equal(ledger.fields.find((field) => field.fieldId === 'notes').status, 'skipped_name_taken')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), '处理状态')
  assert.equal(harness.host.state.get(LEDGER).columns.get('notes'), 'Notes')
  assert.equal(ledger.counts.skipped_name_changed, 1)
  assert.equal(ledger.counts.skipped_name_taken, 1)
  assertValuesFree(first.body, 'L8 response', ['处理状态'])

  const second = await relabel(harness, { body: { apply: true } })
  const again = tableOf(second, 'ledger')
  assert.equal(second.body.data.revisionCount, 0, 'L8: the second run wrote nothing')
  assert.equal(second.body.data.totals.renamed, 0)
  assert.equal(second.body.data.hasPendingRenames, false)
  assert.equal(again.sheetName.status, 'already_target')
  assert.ok(
    again.fields.filter((field) => !['status', 'notes'].includes(field.fieldId)).every((field) => field.status === 'already_target'),
    'L8: every column the first run renamed is already_target',
  )
  const dryAfter = await relabel(harness)
  assert.equal(dryAfter.body.data.hasPendingRenames, false, 'L8: a dry run after apply has nothing left to do')
}

// ── L9 ────────────────────────────────────────────────────────────────────────────────────────

async function l9ResponsesAreValuesFree() {
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX] }, { packs: { 'factory-a': sandboxPack() } })
  const dry = await relabel(harness)
  assertValuesFree(dry.body, 'L9 dry run')
  const applied = await relabel(harness, { body: { apply: true } })
  assertValuesFree(applied.body, 'L9 apply')
}

// ── L10 / L11 ─────────────────────────────────────────────────────────────────────────────────

async function l10AnOldHostIsNotImplemented() {
  const harness = mount({ withRelabel: false })
  const res = await relabel(harness, { body: { apply: true } })
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_API_UNAVAILABLE')
  assert.equal(harness.host.hostCallCount(), 0)
}

async function l11AnUnknownHostStatusIsRefused() {
  const harness = mount({ badStatus: true })
  const res = await relabel(harness)
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_HOST_ANSWER_INVALID')
}

// ── L12 ───────────────────────────────────────────────────────────────────────────────────────

function l12TheRouteIsRegisteredOnceAndGatedOnStockPrepAdmin() {
  const entries = httpRoutes.ROUTES.filter(([, routePath]) => routePath === ROUTE)
  assert.deepEqual(entries, [['POST', ROUTE, 'stockPreparationManagedTableRelabel']])
  const source = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  const start = source.indexOf('    async stockPreparationManagedTableRelabel(req, res) {')
  assert.ok(start > 0, 'L12: handler found')
  const body = source.slice(start, source.indexOf('\n    },', start))
  assert.match(body, /requireAccess\(req, STOCK_PREP_ADMIN\)/, 'L12: the gate is the stock-prep admin constant')
  assert.match(body, /resolveVerifiedClaimTenantId\(req, \{\}\)/, 'L12: the tenant is the verified claim')
}

async function main() {
  await l1NonAdminTiersAreRefusedBeforeAnyHostCall()
  await l2AdminTiersPassTheGate()
  await l3DryRunIsTheDefaultAndApplyWrites()
  await l4TheRequestCannotSteerOrSmuggle()
  await l5TheProjectIsTheVerifiedTenantsStagingProject()
  await l6TargetsAreServerHeldAndTemplateNamed()
  await l7AbsentAndUnregisteredTablesAreReportedNotGuessed()
  await l8HandRenamedAndTakenAreLeftAloneAndTheSecondRunIsANoOp()
  await l9ResponsesAreValuesFree()
  await l10AnOldHostIsNotImplemented()
  await l11AnUnknownHostStatusIsRefused()
  l12TheRouteIsRegisteredOnceAndGatedOnStockPrepAdmin()
  await l13TheModuleWritesOnlyOnExactlyTrue()
  console.log('stock-preparation-managed-table-relabel tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
