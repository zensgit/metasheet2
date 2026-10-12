'use strict'

// 「把系统表的英文表头改成中文」 — THROUGH THE REAL ROUTE TABLE (客户反馈 2026-09-24 #4a).
//
// The host primitive's own guarantees (compare-and-set in SQL, registry triple, config revision per
// rename, field ids / permissions untouched, fence and row locks first, the switch and the digest
// re-checked under the locks) are proven against a SQL-honouring fake in
// packages/core-backend/tests/unit/multitable-object-display-name-relabel.test.ts. This suite proves
// the PLUGIN half: who may call it, which tenant's project it acts on, which tables and which target
// names it asks for, that the dry run is the default, that an apply is bound to its preview, that the
// write is default OFF, and that what comes back is values-free.
//
//   L1  non-admin tiers (integration:write, the stock-prep operator, stock-prep:read, a bare user)
//       => 403 with ZERO host calls; no principal => 401.
//   L2  stock-prep:admin and platform admin both pass the gate.
//   L3  DRY RUN IS THE DEFAULT and the apply is BOUND TO IT: `{}` => mode dry_run + planDigest, every
//       host call carried apply:false, nothing changed; `{ apply: true, planDigest }` => apply,
//       renamed, revisions counted, each host write carried the table's expectedPlanDigest.
//   L4  the request cannot steer or smuggle: apply:"true" / apply:1, apply without a digest, a
//       malformed digest, a digest without apply, any other body key and ANY query key => 400 with
//       zero host calls.
//   L5  tenancy: the project is `${verifiedClaim}:integration-core` on EVERY host call; a claimless
//       token => 403 TENANT_CLAIM_REQUIRED even for platform admin; a header-filled user.tenantId
//       that contradicts the claim => 403; zero host calls in both refusals.
//   L6  targets: main + ledger, plus exactly the SANDBOX objectIds server config names (customer-pack
//       declarations AND the sandbox write allowlist, namespace-filtered) — never an objectId from the
//       request. Target names are pickTemplateLabel(…, 'zh-CN'); the ledger asks for the 16 agreed
//       names; the nine MVP tables are reported `outOfScope` (no agreed Chinese names).
//   L7  per-table outcomes: absent => `absent`; unregistered => `scope_unavailable`, and the host's
//       refusal message (which names the project id) never reaches the response or the log.
//   L8  hand-renamed / taken columns are reported and untouched; second run => all already_target,
//       hasPendingRenames false, zero revisions.
//   L9  values-free: no tenant id, project id, sheet id, physical field id or current (hand-typed)
//       name anywhere in the response.
//   L10 an old host (no relabelObjectDisplayNames) => 501 MANAGED_TABLE_RELABEL_API_UNAVAILABLE.
//   L11 a host answering an unknown status or no digest => 502, never passed through.
//   L12 the route table names the route exactly once, and its handler's gate is STOCK_PREP_ADMIN.
//   L13 the MODULE's own contract: anything but `apply === true` is a dry run, independent of the
//       route's boolean normalizer.
//   S3  THE OPERATOR SWITCH (default OFF): unset / 'TRUE' / '1' => the dry run answers
//       applyEnabled:false and the apply answers 409 MANAGED_TABLE_RELABEL_APPLY_DISABLED with ZERO
//       host calls; exactly 'true' => applies. The switch name is one string in three places.
//   S1  PREVIEW == APPLY: a stale digest (the tables moved after the preview) => 409
//       MANAGED_TABLE_RELABEL_PLAN_CHANGED (stage preview, zero writes); a move between the plugin's
//       re-plan and the host's locked write => 409 (stage apply, tablesApplied says how many
//       committed); two sandboxes with the same default name => the SECOND previews as
//       skipped_name_taken and is never renamed onto the first one's name.
//   N2  a recovery holding the sheet => 409 RECOVERY_IN_PROGRESS; N6 a PG deadlock (40P01) => 409
//       MANAGED_TABLE_RELABEL_CONCURRENT_CHANGE — never an opaque 500.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const REPO = path.join(__dirname, '..', '..', '..')
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  pickTemplateLabel,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { sandboxStockPreparationTemplate } = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const {
  MANAGED_TABLE_RELABEL_ENABLED_ENV,
  PLAN_DIGEST_PATTERN,
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
const SANDBOX_2 = 'plm_stock_preparation_sandbox_rehearsal'

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

function setSwitch(value) {
  if (value === undefined) delete process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]
  else process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV] = value
}

// The host's OWN refusal shape for an unclaimed object: no status, and a message that NAMES the
// project id (packages/core-backend/src/multitable/plugin-scope.ts MultitableObjectScopeError).
function hostObjectScopeError(projectId, objectId) {
  return Object.assign(
    new Error(`Plugin integration-core cannot claim multitable object ${projectId}/${objectId}; owned by unclaimed`),
    { name: 'MultitableObjectScopeError', code: 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN' },
  )
}

function digestOf(objectId, renames) {
  const canonical = JSON.stringify([`sheet_${objectId}`, renames.map((entry) => [entry.entity, entry.from, entry.to])])
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/**
 * A host with English-named managed tables, behaving like the real primitive: a column is renamed
 * only while its current name equals expectedName; a target another column holds is
 * `skipped_name_taken`; a sheet target another sheet (all tables share one base here) holds OR that
 * `takenSheetNames` lists is `skipped_name_taken`; a dry run answers a digest over its would-be
 * renames; the write leg refuses without the switch, refuses a digest that differs from its own
 * re-plan, and otherwise writes.
 */
function createHost({ tables = [MAIN, LEDGER], unregistered = [], withRelabel = true, badStatus = false, noDigest = false, deletedAfterFind = [] } = {}) {
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
  let beforeApply = null
  let applyFailure = null
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
      const apply = input.apply === true
      if (apply && beforeApply) {
        const hook = beforeApply
        beforeApply = null
        hook()
      }
      if (apply && applyFailure) {
        const failure = applyFailure
        applyFailure = null
        throw failure
      }
      if (apply && process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV] !== 'true') {
        throw Object.assign(new Error('disabled'), { name: 'MultitableRelabelDisabledError', code: 'MULTITABLE_RELABEL_APPLY_DISABLED' })
      }
      if (unregistered.includes(input.objectId) || !state.has(input.objectId)) throw hostObjectScopeError(input.projectId, input.objectId)
      if (deletedAfterFind.includes(input.objectId)) {
        return { present: false, applied: apply, sheetId: 'sheet_x', sheetName: null, fields: [], planDigest: digestOf(input.objectId, []), revisionCount: 0, batchId: null }
      }
      const table = state.get(input.objectId)
      const otherSheetNames = [...state.entries()].filter(([id]) => id !== input.objectId).map(([, other]) => other.sheetName)
      const classify = (current, request, taken) => {
        if (current === undefined) return 'missing'
        if (current === request.nextName) return 'already_target'
        if (current !== request.expectedName) return 'skipped_name_changed'
        if (taken) return 'skipped_name_taken'
        return 'would_rename'
      }
      const allNames = () => [...table.columns.values(), ...table.extraNames]
      const fieldPlan = input.fields.map((request) => {
        const current = table.columns.get(request.fieldId)
        const taken = allNames().some((name) => name === request.nextName) && current !== request.nextName
        return { request, status: classify(current, request, taken) }
      })
      const takenSheet = Boolean(input.sheetName)
        && (otherSheetNames.includes(input.sheetName.nextName) || (input.takenSheetNames || []).includes(input.sheetName.nextName))
      const sheetStatus = input.sheetName ? classify(table.sheetName, input.sheetName, takenSheet) : null
      const renames = []
      if (sheetStatus === 'would_rename') renames.push({ entity: 'sheet', from: input.sheetName.expectedName, to: input.sheetName.nextName })
      for (const item of fieldPlan) {
        if (item.status === 'would_rename') renames.push({ entity: `field:${item.request.fieldId}`, from: item.request.expectedName, to: item.request.nextName })
      }
      const planDigest = noDigest ? undefined : digestOf(input.objectId, renames)
      if (!apply) {
        return {
          present: true,
          applied: false,
          sheetId: `sheet_${input.objectId}`,
          sheetName: sheetStatus ? { status: badStatus ? 'overwritten' : sheetStatus } : null,
          fields: fieldPlan.map((item) => ({ fieldId: item.request.fieldId, status: badStatus ? 'overwritten' : item.status })),
          planDigest,
          revisionCount: 0,
          batchId: null,
        }
      }
      if (input.expectedPlanDigest !== planDigest) {
        throw Object.assign(new Error('plan changed'), { name: 'MultitableRelabelPlanChangedError', code: 'MULTITABLE_RELABEL_PLAN_CHANGED' })
      }
      let revisionCount = 0
      const fields = fieldPlan.map((item) => {
        if (item.status !== 'would_rename') return { fieldId: item.request.fieldId, status: item.status }
        table.columns.set(item.request.fieldId, item.request.nextName)
        revisionCount += 1
        return { fieldId: item.request.fieldId, status: 'renamed' }
      })
      let sheetName = sheetStatus ? { status: sheetStatus } : null
      if (sheetStatus === 'would_rename') {
        table.sheetName = input.sheetName.nextName
        revisionCount += 1
        sheetName = { status: 'renamed' }
      }
      revisions += revisionCount
      return { present: true, applied: true, sheetId: `sheet_${input.objectId}`, sheetName, fields, planDigest, revisionCount, batchId: revisionCount ? 'batch_1' : null }
    }
  }
  return {
    provisioning,
    calls,
    state,
    revisions: () => revisions,
    applyCalls: () => calls.relabel.filter((call) => call.apply === true),
    hostCallCount: () => calls.findObjectSheet.length + calls.relabel.length + calls.other.length,
    rename(objectId, fieldId, name) { state.get(objectId).columns.set(fieldId, name) },
    addColumnNamed(objectId, name) { state.get(objectId).extraNames.push(name) },
    onNextApply(hook) { beforeApply = hook },
    failNextApply(error) { applyFailure = error },
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

function mount(hostOptions = {}, { packs, sandboxAllowlist } = {}) {
  const routes = new Map()
  const host = createHost(hostOptions)
  const logLines = []
  const config = {}
  if (packs) config.stockPreparationCustomerPacks = packs
  if (sandboxAllowlist) config.stockPrepApplySandbox = { enabled: true, allowedTargetObjectIds: sandboxAllowlist }
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
    config,
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

/** The only legal way to write: preview, then apply exactly that preview's digest. */
async function previewThenApply(harness, options = {}) {
  const preview = await relabel(harness, options)
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body))
  const applied = await relabel(harness, { ...options, body: { apply: true, planDigest: preview.body.data.planDigest } })
  return { preview, applied }
}

function assertValuesFree(payload, label, extra = []) {
  const text = JSON.stringify(payload)
  for (const token of [TENANT_ID, 'integration-core', 'sheet_', 'fld_', SANDBOX, SANDBOX_2, ...extra]) {
    assert.equal(text.includes(token), false, `${label} must not carry "${token}"`)
  }
}

function tableOf(res, kind, index = 0) {
  return res.body.data.tables.filter((table) => table.kind === kind)[index]
}

// ── L1 / L2 ───────────────────────────────────────────────────────────────────────────────────

async function l1NonAdminTiersAreRefusedBeforeAnyHostCall() {
  for (const name of ['integrationWriter', 'operator', 'reader', 'bare']) {
    const harness = mount()
    const res = await relabel(harness, { user: USERS[name], body: { apply: true, planDigest: `sha256:${'0'.repeat(64)}` } })
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

async function l3DryRunIsTheDefaultAndApplyIsBoundToIt() {
  setSwitch('true')
  const harness = mount()
  const dry = await relabel(harness)
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.body.data.mode, 'dry_run')
  assert.match(dry.body.data.planDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(dry.body.data.applyEnabled, true)
  assert.ok(harness.host.calls.relabel.length === 2, 'L3: main + ledger were evaluated')
  assert.ok(harness.host.calls.relabel.every((call) => call.apply === false), 'L3: every host call of the dry run carried apply:false')
  assert.equal(harness.host.revisions(), 0, 'L3: the dry run wrote nothing')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), 'Status', 'L3: the table is unchanged after the dry run')
  assert.equal(dry.body.data.hasPendingRenames, true)
  const ledger = tableOf(dry, 'ledger')
  assert.equal(ledger.status, 'present')
  assert.ok(ledger.fields.every((field) => field.status === 'would_rename'))
  assert.deepEqual(ledger.sheetName, { from: 'Stock Preparation Confirmation Decision', to: '备料确认账本', status: 'would_rename' })

  const applied = await relabel(harness, { body: { apply: true, planDigest: dry.body.data.planDigest } })
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.data.mode, 'apply')
  const writes = harness.host.applyCalls()
  assert.equal(writes.length, 2, 'L3: one host write per table with renames')
  for (const write of writes) {
    assert.match(write.expectedPlanDigest, /^sha256:[0-9a-f]{64}$/, 'L3: every host write carried the table digest')
    assert.equal(write.actorId, USERS.stockPrepAdmin.id, 'L3: the caller is the attributed actor')
  }
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
}

// ── L4 ────────────────────────────────────────────────────────────────────────────────────────

async function l4TheRequestCannotSteerOrSmuggle() {
  setSwitch('true')
  const goodDigest = `sha256:${'a'.repeat(64)}`
  const bodies = [
    // Without a digest these are refused ONLY by the boolean check (a coerced apply:'true' would
    // otherwise silently become a dry run) — with a digest the digest rule would mask it.
    { apply: 'true' },
    { apply: 1 },
    { apply: 'true', planDigest: goodDigest },
    { apply: 1, planDigest: goodDigest },
    { apply: true },
    { apply: true, planDigest: 'sha256:short' },
    { apply: true, planDigest: `SHA256:${'a'.repeat(64)}` },
    { apply: true, planDigest: 42 },
    { planDigest: goodDigest },
    { apply: false, planDigest: goodDigest },
    { tenantId: TENANT_ID },
    { projectId: STAGING_PROJECT_ID },
    { objectId: SANDBOX },
    { fields: [{ fieldId: 'status', nextName: 'x' }] },
    { baseId: 'base_x' },
    { locale: 'en' },
    { takenSheetNames: ['x'] },
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
  // `{ apply: false }` alone is a legal dry run.
  const harness = mount()
  const dry = await relabel(harness, { body: { apply: false } })
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.body.data.mode, 'dry_run')
}

// ── L5 ────────────────────────────────────────────────────────────────────────────────────────

async function l5TheProjectIsTheVerifiedTenantsStagingProject() {
  setSwitch('true')
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX] }, { packs: { 'factory-a': sandboxPack() } })
  await previewThenApply(harness)
  const projects = [...harness.host.calls.findObjectSheet, ...harness.host.calls.relabel].map((call) => call.projectId)
  assert.ok(projects.length >= 6)
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
  // Without config: exactly main + ledger.
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

  // A pack-declared sandbox AND an allowlisted sandbox are both relabelled, each with the sandbox's own names.
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX, SANDBOX_2] }, { packs: { 'factory-a': sandboxPack() }, sandboxAllowlist: [SANDBOX_2, MAIN, 'not_a_sandbox'] })
  const res = await relabel(harness)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.deepEqual(harness.host.calls.relabel.map((call) => call.objectId), [MAIN, LEDGER, SANDBOX, SANDBOX_2], 'L6: pack sandbox then allowlist sandbox; canonical/foreign allowlist entries dropped')
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
  // S4a: the nine MVP tables carry no agreed Chinese names — reported, not silently skipped.
  const outOfScope = res.body.data.outOfScope
  assert.deepEqual(outOfScope.map((entry) => entry.objectId), STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => template.objectId))
  assert.ok(outOfScope.some((entry) => entry.label === 'PLM BOM Snapshot Line'))
}

// ── L7 ────────────────────────────────────────────────────────────────────────────────────────

async function l7AbsentAndUnregisteredTablesAreReportedNotGuessed() {
  setSwitch('true')
  const harness = mount({ tables: [MAIN, LEDGER], unregistered: [LEDGER] })
  harness.host.state.delete(MAIN)
  const { preview, applied } = await previewThenApply(harness)
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  for (const res of [preview, applied]) {
    assert.equal(tableOf(res, 'main').status, 'absent')
    assert.equal(tableOf(res, 'ledger').status, 'scope_unavailable')
    assert.deepEqual(tableOf(res, 'ledger').fields, [])
    assertValuesFree(res.body, 'L7 response')
  }
  assert.equal(harness.host.revisions(), 0)
  assert.deepEqual(harness.host.applyCalls(), [], 'L7: nothing to write, so no host write at all')
  assert.ok(harness.host.calls.relabel.every((call) => call.objectId === LEDGER), 'L7: an absent table is never handed to the host')
  for (const line of harness.logLines) assertValuesFree(line[2] || {}, 'L7 log detail')

  // Found by the plugin, then gone by the time the host looked: reported absent, never projected.
  const raced = mount({ deletedAfterFind: [LEDGER] })
  const racedRes = await relabel(raced)
  assert.equal(racedRes.statusCode, 200, JSON.stringify(racedRes.body))
  assert.equal(tableOf(racedRes, 'ledger').status, 'absent')
  assert.deepEqual(tableOf(racedRes, 'ledger').fields, [])
}

// ── L8 ────────────────────────────────────────────────────────────────────────────────────────

async function l8HandRenamedAndTakenAreLeftAloneAndTheSecondRunIsANoOp() {
  setSwitch('true')
  const harness = mount()
  harness.host.rename(LEDGER, 'status', '处理状态')
  harness.host.addColumnNamed(LEDGER, '备注')
  const { preview, applied: first } = await previewThenApply(harness)
  assert.equal(tableOf(preview, 'ledger').fields.find((field) => field.fieldId === 'status').status, 'skipped_name_changed', 'L8: the PREVIEW already says so')
  const ledger = tableOf(first, 'ledger')
  assert.equal(ledger.fields.find((field) => field.fieldId === 'status').status, 'skipped_name_changed')
  assert.equal(ledger.fields.find((field) => field.fieldId === 'notes').status, 'skipped_name_taken')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), '处理状态')
  assert.equal(harness.host.state.get(LEDGER).columns.get('notes'), 'Notes')
  assert.equal(ledger.counts.skipped_name_changed, 1)
  assert.equal(ledger.counts.skipped_name_taken, 1)
  assertValuesFree(first.body, 'L8 response', ['处理状态'])

  const { applied: second } = await previewThenApply(harness)
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
  setSwitch('true')
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX] }, { packs: { 'factory-a': sandboxPack() } })
  const { preview, applied } = await previewThenApply(harness)
  assertValuesFree(preview.body, 'L9 dry run')
  assertValuesFree(applied.body, 'L9 apply')
}

// ── L10 / L11 ─────────────────────────────────────────────────────────────────────────────────

async function l10AnOldHostIsNotImplemented() {
  const harness = mount({ withRelabel: false })
  const res = await relabel(harness)
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_API_UNAVAILABLE')
  assert.equal(harness.host.hostCallCount(), 0)
}

async function l11AnUnknownHostAnswerIsRefused() {
  for (const options of [{ badStatus: true }, { noDigest: true }]) {
    const harness = mount(options)
    const res = await relabel(harness)
    assert.equal(res.statusCode, 502, JSON.stringify(options))
    assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_HOST_ANSWER_INVALID')
  }
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

// ── L13 ───────────────────────────────────────────────────────────────────────────────────────

async function l13TheModuleWritesOnlyOnExactlyTrue() {
  const env = { [MANAGED_TABLE_RELABEL_ENABLED_ENV]: 'true' }
  for (const apply of [undefined, null, 'true', 1, {}]) {
    const host = createHost()
    const result = await runStockPreparationManagedTableRelabel({ provisioning: host.provisioning, projectId: STAGING_PROJECT_ID, apply, planDigest: `sha256:${'a'.repeat(64)}`, env })
    assert.equal(result.mode, 'dry_run', `L13: apply=${JSON.stringify(apply)} is a dry run`)
    assert.ok(host.calls.relabel.every((call) => call.apply === false), `L13: apply=${JSON.stringify(apply)} reached the host as apply:false`)
    assert.equal(host.revisions(), 0)
  }
  setSwitch('true')
  const host = createHost()
  const plan = await runStockPreparationManagedTableRelabel({ provisioning: host.provisioning, projectId: STAGING_PROJECT_ID, env })
  const result = await runStockPreparationManagedTableRelabel({ provisioning: host.provisioning, projectId: STAGING_PROJECT_ID, apply: true, planDigest: plan.planDigest, env })
  assert.equal(result.mode, 'apply')
  assert.ok(host.revisions() > 0)
}

// ── S3 — THE OPERATOR SWITCH ──────────────────────────────────────────────────────────────────

async function s3TheWriteIsDefaultOff() {
  for (const value of [undefined, 'TRUE', '1', ' true', 'yes']) {
    setSwitch(value)
    const harness = mount()
    const dry = await relabel(harness)
    assert.equal(dry.statusCode, 200, `S3: the dry run works with the switch at ${JSON.stringify(value)}`)
    assert.equal(dry.body.data.applyEnabled, false, `S3: switch ${JSON.stringify(value)} reports applyEnabled:false`)
    assert.equal(dry.body.data.enableWith, 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED')
    const callsBefore = harness.host.hostCallCount()
    const res = await relabel(harness, { body: { apply: true, planDigest: dry.body.data.planDigest } })
    assert.equal(res.statusCode, 409, `S3: apply with switch ${JSON.stringify(value)} is refused`)
    assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_APPLY_DISABLED')
    assert.equal(harness.host.hostCallCount(), callsBefore, 'S3: a disabled server asks the host NOTHING on apply')
    assert.equal(harness.host.revisions(), 0)
    assert.equal(harness.host.state.get(LEDGER).columns.get('status'), 'Status')
    assertValuesFree(res.body, 'S3 refusal')
  }
  setSwitch('true')
  const harness = mount()
  const { applied } = await previewThenApply(harness)
  assert.equal(applied.statusCode, 200, 'S3: exactly "true" applies')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), '状态')
}

function s3TheSwitchIsOneNameInThreePlaces() {
  assert.equal(MANAGED_TABLE_RELABEL_ENABLED_ENV, 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED')
  const hostSource = fs.readFileSync(path.join(REPO, 'packages', 'core-backend', 'src', 'multitable', 'object-display-name-relabel.ts'), 'utf8')
  assert.ok(hostSource.includes(`MANAGED_TABLE_RELABEL_ENABLED_ENV = '${MANAGED_TABLE_RELABEL_ENABLED_ENV}'`), 'S3: the host reads the same switch')
  assert.ok(hostSource.includes(`=== 'true'`), 'S3: the host compares against the exact literal')
  const manifest = fs.readFileSync(path.join(REPO, 'scripts', 'ops', 'global-history-flag-manifest.mjs'), 'utf8')
  assert.ok(manifest.includes(`key: '${MANAGED_TABLE_RELABEL_ENABLED_ENV}'`), 'S3: the switch is registered in the flag manifest')
}

// The plan-digest SHAPE lives once on the plugin side (the route imports the module's constant — no
// second literal in http-routes.cjs) and once in the host, which a CJS plugin cannot import; the host
// copy is pinned byte-equal here so the two can never accept different digests.
function s1TheDigestShapeIsOneConstant() {
  assert.equal(String(PLAN_DIGEST_PATTERN), '/^sha256:[0-9a-f]{64}$/')
  const routes = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
  assert.equal(routes.includes('sha256:[0-9a-f]{64}'), false, 'S1: http-routes.cjs carries no private copy of the digest pattern')
  assert.ok(routes.includes('PLAN_DIGEST_PATTERN: MANAGED_TABLE_RELABEL_PLAN_DIGEST_PATTERN'), 'S1: the route imports the module constant')
  const hostSource = fs.readFileSync(path.join(REPO, 'packages', 'core-backend', 'src', 'multitable', 'object-display-name-relabel.ts'), 'utf8')
  assert.ok(hostSource.includes(`RELABEL_PLAN_DIGEST_PATTERN = ${String(PLAN_DIGEST_PATTERN)}`), 'S1: the host pattern is byte-equal to the plugin one')
}

// ── S1 — PREVIEW == APPLY ─────────────────────────────────────────────────────────────────────

async function s1AStaleDigestIsRefusedBeforeAnyWrite() {
  setSwitch('true')
  const harness = mount()
  const preview = await relabel(harness)
  // After the preview a person renames a column back to English: the apply would now do MORE.
  harness.host.rename(LEDGER, 'status', '随手改的')
  const stalePreview = await relabel(harness)
  assert.notEqual(stalePreview.body.data.planDigest, preview.body.data.planDigest, 'S1: the digest moves when what would be written moves')
  const res = await relabel(harness, { body: { apply: true, planDigest: preview.body.data.planDigest } })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_PLAN_CHANGED')
  assert.equal(res.body.error.details.stage, 'preview')
  assert.equal(res.body.error.details.tablesApplied, 0)
  assert.deepEqual(harness.host.applyCalls(), [], 'S1: not one host write')
  assert.equal(harness.host.revisions(), 0)
}

async function s1AMoveBetweenRePlanAndLockedWriteIsRefusedByTheHost() {
  setSwitch('true')
  const harness = mount()
  const preview = await relabel(harness)
  // MAIN is applied first; just before the LEDGER's locked write, the ledger moves.
  let applies = 0
  const original = harness.host.provisioning.relabelObjectDisplayNames
  harness.host.provisioning.relabelObjectDisplayNames = async (input) => {
    if (input.apply === true) {
      applies += 1
      if (applies === 2) harness.host.rename(LEDGER, 'notes', '别人刚改的')
    }
    return original(input)
  }
  const res = await relabel(harness, { body: { apply: true, planDigest: preview.body.data.planDigest } })
  assert.equal(res.statusCode, 409, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'MANAGED_TABLE_RELABEL_PLAN_CHANGED')
  assert.equal(res.body.error.details.stage, 'apply')
  assert.equal(res.body.error.details.tablesApplied, 1, 'S1: the admin is told one table was already committed')
  assert.equal(harness.host.state.get(LEDGER).columns.get('status'), 'Status', 'S1: the moved table was not written at all')
  assertValuesFree(res.body, 'S1 refusal')
}

async function s1TwoSandboxesWithTheSameDefaultNameCannotBothTakeIt() {
  setSwitch('true')
  const harness = mount({ tables: [MAIN, LEDGER, SANDBOX, SANDBOX_2] }, { sandboxAllowlist: [SANDBOX, SANDBOX_2] })
  const { preview, applied } = await previewThenApply(harness)
  assert.equal(tableOf(preview, 'sandbox', 0).sheetName.status, 'would_rename')
  assert.equal(tableOf(preview, 'sandbox', 1).sheetName.status, 'skipped_name_taken', 'S1: the PREVIEW already shows the second sandbox skipped')
  const secondCall = harness.host.calls.relabel.find((call) => call.objectId === SANDBOX_2 && call.apply === false)
  // Every sheet name an EARLIER table of the same base is about to take — main, ledger and the first
  // sandbox — so no later table can preview a rename onto any of them.
  assert.deepEqual(secondCall.takenSheetNames, ['备料主表', '备料确认账本', '备料主表(沙箱)'], 'S1: the second sandbox was told what the earlier tables take')
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
  assert.equal(tableOf(applied, 'sandbox', 1).sheetName.status, 'skipped_name_taken')
  assert.equal(harness.host.state.get(SANDBOX).sheetName, '备料主表(沙箱)')
  assert.equal(harness.host.state.get(SANDBOX_2).sheetName, 'PLM Stock Preparation Sandbox', 'S1: never two tables with one name')
  // …while the second sandbox's COLUMNS still went through.
  assert.equal(harness.host.state.get(SANDBOX_2).columns.get('projectNo'), '项目号')
}

// ── N2 / N6 — write-leg conflicts are stable 409s, never an opaque 500 ────────────────────────

async function n2n6WriteLegConflictsAreStable409s() {
  setSwitch('true')
  const cases = [
    { error: Object.assign(new Error('Sheet is temporarily locked for writes by a recovery operation'), { name: 'SheetWriterBlockedError', code: 'SHEET_WRITER_BLOCKED' }), code: 'RECOVERY_IN_PROGRESS' },
    { error: Object.assign(new Error('deadlock detected'), { code: '40P01' }), code: 'MANAGED_TABLE_RELABEL_CONCURRENT_CHANGE' },
  ]
  for (const entry of cases) {
    const harness = mount()
    const preview = await relabel(harness)
    harness.host.failNextApply(entry.error)
    const res = await relabel(harness, { body: { apply: true, planDigest: preview.body.data.planDigest } })
    assert.equal(res.statusCode, 409, `${entry.code}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, entry.code)
    assert.equal(res.body.error.details.tablesApplied, 0)
    assertValuesFree(res.body, `${entry.code} refusal`)
  }
}

async function main() {
  const snapshot = process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]
  try {
    await l1NonAdminTiersAreRefusedBeforeAnyHostCall()
    await l2AdminTiersPassTheGate()
    await l3DryRunIsTheDefaultAndApplyIsBoundToIt()
    await l4TheRequestCannotSteerOrSmuggle()
    await l5TheProjectIsTheVerifiedTenantsStagingProject()
    await l6TargetsAreServerHeldAndTemplateNamed()
    await l7AbsentAndUnregisteredTablesAreReportedNotGuessed()
    await l8HandRenamedAndTakenAreLeftAloneAndTheSecondRunIsANoOp()
    await l9ResponsesAreValuesFree()
    await l10AnOldHostIsNotImplemented()
    await l11AnUnknownHostAnswerIsRefused()
    l12TheRouteIsRegisteredOnceAndGatedOnStockPrepAdmin()
    await l13TheModuleWritesOnlyOnExactlyTrue()
    await s3TheWriteIsDefaultOff()
    s3TheSwitchIsOneNameInThreePlaces()
    s1TheDigestShapeIsOneConstant()
    await s1AStaleDigestIsRefusedBeforeAnyWrite()
    await s1AMoveBetweenRePlanAndLockedWriteIsRefusedByTheHost()
    await s1TwoSandboxesWithTheSameDefaultNameCannotBothTakeIt()
    await n2n6WriteLegConflictsAreStable409s()
  } finally {
    setSwitch(snapshot)
  }
  console.log('stock-preparation-managed-table-relabel tests passed')
}

// S3 follow-ups 2 (item 5): the fail-closed runner (support/fail-closed-suite-runner.cjs) — `main` runs as one test
// under the exit sentinel and the whole-suite timeout, so a check that hangs can never end this suite with exit 0.
require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-managed-table-relabel.test.cjs', main)
