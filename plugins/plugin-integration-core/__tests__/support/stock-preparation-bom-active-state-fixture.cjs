'use strict'

// Independent SA01F real-chain tests. Only the source/read and persistence APIs
// are in memory: expansion, normalization, planning, tokens and writes are real.
const assert = require('node:assert/strict')
const bom = require('../../lib/stock-preparation-bom-expansion.cjs')
const actions = require('../../lib/stock-preparation-table-actions.cjs')
const jobs = require('../../lib/stock-preparation-large-bom-jobs.cjs')
const { createLibWriteLockHarness } = require('./stock-preparation-project-write-lock-kit.cjs')

const PROJECT = 'SYN-SA01F-PROJECT'
const SHEET = 'synthetic-sa01f-sheet'
const SCOPE = { tenantId: 'synthetic-tenant', workspaceId: 'synthetic-workspace' }
const NOW = '2026-09-30T00:00:00.000Z'
const clone = (value) => structuredClone(value)
const POLICY = { enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] }

function fixture({ second = false, subtree = false, versioned = false } = {}) {
  const plan = clone(bom.PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  if (versioned) plan.orderDetail.versionField = 'order_version'
  if (subtree) {
    plan.maxReadCount = 200
    plan.projectSubtree = { pathInfo: { parentIdField: 'folder_parent' }, bomHead: { pathIdField: 'folder_id' } }
  }
  // Fully different table AND column names; never rely on default bom_able.
  if (second) {
    for (const role of ['pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'part', 'bomHead', 'bomDetail']) {
      for (const key of Object.keys(plan[role])) plan[role][key] = `${role}_${key}`
    }
    plan.matchField = plan.pathExAttr.matchField
  }
  const p = plan
  const row = (role, values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [p[role][key], value]))
  const data = {
    [p.pathExAttr.object]: [row('pathExAttr', { matchField: PROJECT, pathIdField: 'P' })],
    [p.pathInfo.object]: [{ ...row('pathInfo', { idField: 'P' }), folder_parent: 'OUTSIDE' }],
    [p.orderHead.object]: subtree ? [] : [row('orderHead', { idField: 'O', pathIdField: 'P' })],
    [p.orderDetail.object]: subtree ? [] : [row('orderDetail', {
      orderIdField: 'O', componentIdField: 'A', quantityField: '2', ...(versioned ? { versionField: 'V1' } : {}),
    })],
    [p.part.object]: ['A', 'B', 'C'].map((id) => row('part', { idField: id, codeField: `${id}001`, versionField: 'V1' })),
    [p.bomHead.object]: ['A', 'B'].map((id) => ({ ...row('bomHead', {
      parentPartField: id, bomIdField: `H${id}`, versionField: 'V1', activeField: 1,
    }), folder_id: id === 'A' ? 'P' : 'OUTSIDE' })),
    [p.bomDetail.object]: [['A', 'B'], ['B', 'C']].map(([parent, child]) => row('bomDetail', {
      bomParentField: `H${parent}`, componentIdField: child, quantityField: '3',
    })),
  }
  return { plan, data }
}

function sourceFor(data, { unfiltered = false } = {}) {
  const calls = []
  return {
    kind: 'data-source:sql-readonly', calls,
    async read(input) {
      calls.push(clone(input))
      assert.ok(Object.hasOwn(data, input.object), 'only the explicit synthetic catalog may be queried')
      const matches = data[input.object].filter((row) => unfiltered || Object.entries(input.filters || {}).every(([key, value]) => row[key] === value))
      const offset = input.cursor ? Number(input.cursor) : 0
      const records = matches.slice(offset, offset + input.limit).map(clone)
      const done = offset + records.length >= matches.length
      return { records, done, nextCursor: done ? null : String(offset + records.length), metadata: { filtersApplied: !unfiltered } }
    },
  }
}

function storage() {
  const map = new Map()
  const writes = []
  return {
    durable: true, map, writes,
    async get(key) { return map.has(key) ? clone(map.get(key)) : null },
    async set(key, value) { writes.push(['set', key]); map.set(key, clone(value)) },
    async delete(key) { writes.push(['delete', key]); map.delete(key) },
    // The host's atomic consume (one DELETE ... RETURNING): the read and the removal are one synchronous step.
    async consume(key) {
      if (!map.has(key)) return null
      const value = map.get(key)
      writes.push(['consume', key])
      map.delete(key)
      return clone(value)
    },
  }
}

function recordsApi(existing = []) {
  const rows = existing.map((data, index) => ({ id: `row-${index}`, version: 1, sheetId: SHEET, data: clone(data) }))
  const writes = []
  return {
    rows, writes,
    async queryRecords(input) {
      return rows.filter((row) => row.sheetId === input.sheetId)
        .filter((row) => Object.entries(input.filters || {}).every(([key, value]) => row.data[key] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000)).map(clone)
    },
    async createRecord(input) {
      writes.push(['create', clone(input)])
      const row = { id: `row-${rows.length}`, version: 1, sheetId: input.sheetId, data: clone(input.data) }
      rows.push(row)
      return clone(row)
    },
    async patchRecord(input) {
      writes.push(['patch', clone(input)])
      const row = rows.find((entry) => entry.id === input.recordId && entry.sheetId === input.sheetId)
      assert.ok(row, 'the writer must patch an actual existing target')
      row.version += 1
      Object.assign(row.data, clone(input.changes))
      return clone(row)
    },
  }
}

function actionFor(plan) {
  return actions.normalizeStockPreparationActionConfig({
    actionId: actions.PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'synthetic-sa01f', kind: 'data-source:sql-readonly', readPlan: plan },
    target: { sheetId: SHEET, objectId: 'stockPreparationMain' }, pageLimit: 1000,
  })
}

function inputFor(plan, sourceAdapter, target = recordsApi()) {
  return { action: actionFor(plan), parameters: { projectNo: PROJECT }, sourceAdapter, recordsApi: target, tokenStore: storage(), plannedAt: NOW }
}

// Local wrapped aliases over the real production functions (their exports are frozen). The real lock,
// generation binders and fence-enforcing fake host come from the shared write-lock kit.
function lockedActions(harness = createLibWriteLockHarness()) {
  return {
    harness,
    dryRun: harness.wrapDryRun(actions.dryRunStockPreparationAction),
    apply: harness.wrapApply(actions.applyStockPreparationAction),
  }
}

function lockedJobs(harness = createLibWriteLockHarness()) {
  return {
    harness,
    create: harness.wrapLargeExpansionStart(jobs.createLargeBomBackgroundExpansionJob),
    plan: harness.wrapLargePlan(jobs.planLargeBomBackgroundExpansionJob),
    approve: harness.wrapLargeApprove(jobs.createLargeBomCheckpointApplyJob),
    chunk: harness.wrapLargeChunk(jobs.runLargeBomCheckpointApplyJobChunk),
  }
}

function changeState(f, locus, value, mode) {
  const head = f.data[f.plan.bomHead.object][locus === 'recursive' ? 1 : 0]
  const field = f.plan.bomHead.activeField
  if (mode === 'missing') delete head[field]
  else if (mode === 'ambiguous') { head[field] = 1; head[field.toUpperCase()] = 0 }
  else head[field] = value
}

async function assertBlocked({ second = false, locus = 'root', value, mode } = {}) {
  const f = fixture({ second, subtree: locus === 'subtree' })
  const full = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data), projectNo: PROJECT, readPlan: f.plan })
  assert.equal(full.valid, true, 'same-layout complete positive expansion')
  const child = full.rows.find((row) => row.componentSourceId === 'C')
  assert.ok(child, 'positive source really reaches the descendant which could be wrongly inactivated')
  const target = recordsApi([{ ...child, active: true }])
  const before = clone(target.rows)
  // Mint a genuine, write-bound token from a real dry-run on the valid original fixture, in its own store.
  const locked = lockedActions()
  const validInput = inputFor(f.plan, sourceFor(f.data), target)
  const validDry = await locked.dryRun(validInput)
  assert.equal(validDry.canApply, true, 'original valid fixture must yield an applyable dry-run')
  assert.ok(validDry.dryRunToken, 'original valid dry-run must issue a real token')
  assert.equal(validInput.tokenStore.map.size, 1, 'the real token lives in the original store')
  changeState(f, locus, value, mode)
  const source = sourceFor(f.data)
  const expansion = await bom.expandPlmProjectBom({ sourceAdapter: source, projectNo: PROJECT, readPlan: f.plan })
  // Invalid dry-run uses a distinct, fresh, empty token store.
  const input = inputFor(f.plan, source, target)
  assert.notEqual(input.tokenStore, validInput.tokenStore)
  assert.equal(input.tokenStore.map.size, 0)
  const dry = await locked.dryRun(input)
  const issued = input.tokenStore.map.size
  const planner = await actions.prepareStockPreparationConfirmationDecisions(input)
  let failure
  try {
    // Apply the genuine original token from the original store against the now-invalid source.
    await locked.apply({ ...input, tokenStore: validInput.tokenStore, dryRunToken: validDry.dryRunToken, permission: 'write', sandboxPolicy: POLICY,
      acceptManualConfirmHold: true, acceptDuplicateResolution: true })
  } catch (error) { failure = error }
  assert.equal(target.writes.length, 0, 'unknown head state reached actual create/patch')
  assert.deepEqual(target.rows, before, 'unknown state must not inactivate existing descendants')
  // A genuine token from the earlier valid source is now stale. Apply compares the
  // recomputed revision before canApply; the invalid preview/planner assertions
  // below independently pin the active-state refusal without minting a fake token.
  assert.equal(failure && failure.code, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH')
  assert.equal(dry.canApply, false)
  assert.equal(dry.dryRunToken, null)
  assert.equal(issued, 0)
  assert.equal(planner.canApply, false)
  assert.equal(expansion.valid, false)
  assert.ok(expansion.errors.some((error) => error.type === 'read_failed' && error.causeClass === 'BOM_HEAD_ACTIVE_VALUE_INVALID'))
  assert.equal(expansion.rowErrors.some((error) => error.type === 'read_failed'), false)
  assert.equal(bom.isLargeBomBoundedExpansion(expansion), false)
  assert.equal(JSON.stringify(bom.summarizeBomExpansionForEvidence(expansion)).includes('SYN-SECRET-UNKNOWN'), false)
  if (locus === 'recursive') assert.ok(expansion.rows.length > 0, 'the failure follows actual ancestor expansion')
  assert.ok(source.calls.some((call) => call.object === f.plan.bomHead.object))
}

async function activeControl(value, options) {
  const f = fixture(options)
  changeState(f, 'root', value)
  const result = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data), projectNo: PROJECT, readPlan: f.plan })
  assert.equal(result.valid, true)
  assert.equal(result.rows.filter((row) => row.componentSourceId === 'C').length, 1)
}

async function inactiveWrites(value, options) {
  const f = fixture(options)
  const full = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data), projectNo: PROJECT, readPlan: f.plan })
  assert.equal(full.valid, true)
  const child = full.rows.find((row) => row.componentSourceId === 'C')
  assert.ok(child)
  const target = recordsApi([{ ...child, active: true }])
  changeState(f, 'root', value)
  const input = inputFor(f.plan, sourceFor(f.data), target)
  if (options && options.subtree) {
    const expansion = await bom.expandPlmProjectBom({ sourceAdapter: input.sourceAdapter, projectNo: PROJECT, readPlan: f.plan })
    assert.equal(expansion.rows.length, 0, 'inactive subtree heads must not become root rows')
  }
  const locked = lockedActions()
  const dry = await locked.dryRun(input)
  assert.equal(dry.canApply, true, 'known inactive state is normal reconciliation, not a global blocker')
  assert.ok(dry.dryRunToken)
  await locked.apply({ ...input, dryRunToken: dry.dryRunToken, permission: 'write', sandboxPolicy: POLICY, acceptManualConfirmHold: true })
  assert.equal(target.rows[0].data.active, false, 'actual writer must inactivate the existing child')
  assert.ok(target.writes.some(([kind, call]) => kind === 'patch' && call.changes.active === false))
}

async function backgroundBlocked() {
  const f = fixture()
  changeState(f, 'recursive', 'SYN-SECRET-UNKNOWN')
  const store = storage()
  const locked = lockedJobs()
  const action = actionFor(f.plan)
  const common = { storage: store, ...SCOPE, actionId: action.actionId, jobId: 'bad-head' }
  await locked.create({ ...common, action, parameters: { projectNo: PROJECT }, principal: 'synthetic-user', createJobId: () => common.jobId })
  const result = await jobs.runLargeBomBackgroundExpansionJob({ ...common, sourceAdapter: sourceFor(f.data), expansionOptions: { readPlan: f.plan } })
  assert.equal(result.status, 'failed')
  assert.equal(jobs.isAuthoritativeLargeBomExpansion(result), false)
  assert.equal(result.artifact, undefined)
  await assert.rejects(() => locked.plan({ ...common, existingRows: [] }), { code: 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE' })
}

// ── Configured typed active state (GOV-08) ───────────────────────────────────────────────────────
// Separate case list so the 155-case baseline above keeps its label and count.
const STATE_POLICY = { activeValues: [7, '启用'], inactiveValues: [8, '停用'] }

function configuredFixture(options, policy = STATE_POLICY) {
  const f = fixture(options)
  f.plan.bomActiveState = clone(policy)
  return f
}

function setAllStates(f, value) {
  for (const head of f.data[f.plan.bomHead.object]) head[f.plan.bomHead.activeField] = value
}

const expandWith = (f, extra = {}) =>
  bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data), projectNo: PROJECT, readPlan: f.plan, ...extra })
const componentIds = (result) => result.rows.map((row) => row.componentSourceId)

async function configuredKnown({ second = false, subtree = false, value, active, concurrency, policy }) {
  const f = configuredFixture({ second, subtree }, policy)
  setAllStates(f, value)
  const serial = await expandWith(f)
  const result = concurrency ? await expandWith(f, { readConcurrency: concurrency }) : serial
  for (const r of [serial, result]) {
    if (active) assert.equal(r.valid, true, JSON.stringify(r.errors))
    assert.equal(r.errors.some((error) => error.causeClass === 'BOM_HEAD_ACTIVE_VALUE_INVALID'), false)
    assert.equal(r.rows.filter((row) => row.componentSourceId === 'C').length, active ? 1 : 0)
  }
  assert.deepEqual(componentIds(result), componentIds(serial))
}

async function configuredBlocked({ second = false, locus, value, mode }) {
  const f = configuredFixture({ second, subtree: locus === 'subtree' })
  setAllStates(f, 7)
  const full = await expandWith(f)
  assert.equal(full.valid, true, 'same-layout positive expansion under the configured state')
  assert.ok(full.rows.some((row) => row.componentSourceId === 'C'))
  changeState(f, locus, value, mode)
  const source = sourceFor(f.data)
  const target = recordsApi()
  const input = inputFor(f.plan, source, target)
  const expansion = await bom.expandPlmProjectBom({ sourceAdapter: source, projectNo: PROJECT, readPlan: f.plan })
  assert.equal(expansion.valid, false)
  assert.ok(expansion.errors.some((error) => error.type === 'read_failed' && error.causeClass === 'BOM_HEAD_ACTIVE_VALUE_INVALID'))
  assert.equal(bom.isLargeBomBoundedExpansion(expansion), false)
  const dry = await lockedActions().dryRun(input)
  assert.equal(dry.canApply, false)
  assert.equal(dry.dryRunToken, null)
  assert.equal(input.tokenStore.map.size, 0)
  assert.equal(target.writes.length, 0)
  assert.equal(JSON.stringify([expansion.errors, dry]).includes('SYN-SECRET-UNKNOWN'), false)
}

function configuredStateCases() {
  const cases = []
  const unknown = [['number-1', 1], ['true', true], ['null-unlisted', null], ['string-1', '1'], ['string-active-number', '7'], ['string-inactive-number', '8'], ['padded-enum', '启用 '],
    ['secret', 'SYN-SECRET-UNKNOWN'], ['number-9', 9], ['nan', NaN], ['missing', undefined, 'missing'], ['ambiguous', 7, 'ambiguous']]
  for (const second of [false, true]) {
    const tag = second ? 'second' : 'default'
    for (const locus of ['root', 'recursive', 'subtree']) {
      for (const [label, value, mode] of unknown) {
        cases.push([`configured-blocked-${tag}-${locus}-${label}`, () => configuredBlocked({ second, locus, value, mode })])
      }
    }
    for (const [label, value] of [['number', 7], ['enum', '启用']]) {
      for (const subtree of [false, true]) {
        for (const concurrency of [undefined, 4]) {
          cases.push([`configured-active-${tag}-${label}-subtree${subtree}-c${concurrency}`, () => configuredKnown({ second, subtree, value, active: true, concurrency })])
        }
      }
    }
    for (const [label, value] of [['number', 8], ['enum', '停用']]) {
      for (const subtree of [false, true]) {
        for (const concurrency of [undefined, 4]) {
          cases.push([`configured-inactive-${tag}-${label}-subtree${subtree}-c${concurrency}`, () => configuredKnown({ second, subtree, value, active: false, concurrency })])
        }
      }
    }
    cases.push([`configured-explicit-null-active-${tag}`, () => configuredKnown({
      second, value: null, active: true, policy: { activeValues: [null, 7], inactiveValues: [8] },
    })])
  }
  return cases
}

async function membershipAndUndeclared() {
  for (const second of [false, true]) {
    const f = fixture({ second, versioned: true })
    const h = f.plan.bomHead
    f.data[h.object].push({ [h.parentPartField]: 'FOREIGN', [h.bomIdField]: 'FOREIGN', [h.versionField]: 'V1', [h.activeField]: 'SYN-SECRET-UNKNOWN', folder_id: 'FOREIGN' })
    f.data[h.object].push({ [h.parentPartField]: 'A', [h.bomIdField]: 'WRONG-VERSION', [h.versionField]: 'V9', [h.activeField]: 'SYN-SECRET-UNKNOWN' })
    const result = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data, { unfiltered: true }), projectNo: PROJECT, readPlan: f.plan })
    assert.equal(result.valid, true, 'unrelated parent/version bad state must be filtered before state interpretation')
    assert.equal(result.rows.length, 3)
    delete f.plan.bomHead.activeField
    f.data[h.object][0][second ? 'bomHead_activeField' : 'bom_able'] = { unknown: true }
    const undeclared = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data), projectNo: PROJECT, readPlan: f.plan })
    assert.equal(undeclared.valid, true, 'undeclared role remains explicit no-state-filtering')
    assert.equal(undeclared.rows.length, 3)
  }
  const f = fixture({ subtree: true })
  f.data[f.plan.bomHead.object].push({ part_id: 'FOREIGN', bom_id: 'FOREIGN', SysVer: 'V1', bom_able: {}, folder_id: 'FOREIGN' })
  const result = await bom.expandPlmProjectBom({ sourceAdapter: sourceFor(f.data, { unfiltered: true }), projectNo: PROJECT, readPlan: f.plan })
  assert.equal(result.valid, true, 'unrelated folder bad state is not this project')
}

// ── Registered HTTP route lane ──────────────────────────────────────────────────────────────────
// The real route stack (registration, expansion, planner, token, apply) runs over the shared
// project-sheet harness; only the source rows and the persistence substrate are in memory.
const ROUTE_TENANT = 'tenant-sa01f-route'
const ROUTE_PROJECT = 'SYN-SA01F-ROUTE-0001'
// Mirrors the harness default env target (switchOn:false), whose sandbox allowlist is derived from it.
const ROUTE_TARGET_OBJECT = 'plm_stock_preparation_sandbox_synthetic_env'
const ROUTE_DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const ROUTE_APPLY_PATH = '/api/integration/table-actions/:actionId/apply'

function routeFixture() {
  const f = fixture()
  f.data[f.plan.pathExAttr.object][0][f.plan.pathExAttr.matchField] = ROUTE_PROJECT
  return { f, source: sourceFor(f.data) }
}

function routeMount(f, source) {
  const harness = require('./stock-preparation-project-sheet-harness.cjs')
  const access = require('../../lib/stock-preparation-workbench-access.cjs')
  const h = harness.mountProjectSheetRoutes({
    tenantId: ROUTE_TENANT,
    projectNo: ROUTE_PROJECT,
    switchOn: false,
    configExtras: {
      stockPreparationTableActions: [{
        actionId: actions.PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_sql_source_synthetic', kind: 'data-source:sql-readonly', readPlan: clone(f.plan) },
        target: { sheetId: 'sheet_env_synthetic', objectId: ROUTE_TARGET_OBJECT, fieldIdMap: {} },
      }],
    },
    serviceExtras: { adapterRegistry: { createAdapter() { return source }, listAdapterKinds() { return [] } } },
  })
  const user = { id: 'u_sa01f_route', tenantId: ROUTE_TENANT, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE, access.STOCK_PREP_PULL] }
  const send = (routePath, body) => harness.call(h.routes, 'POST', routePath, {
    user, params: { actionId: actions.PLM_STOCK_PREPARATION_ACTION_ID }, body, query: { tenantId: ROUTE_TENANT }, authenticatedTenantId: ROUTE_TENANT,
  })
  return {
    h,
    dryRun: () => send(ROUTE_DRY_RUN_PATH, { parameters: { projectNo: ROUTE_PROJECT } }),
    apply: (token) => send(ROUTE_APPLY_PATH, { parameters: { projectNo: ROUTE_PROJECT }, confirm: { dryRunToken: token } }),
    writes: () => h.records.calls.filter(([kind]) => /^(overview\.)?(createRecord|patchRecord|deleteRecord)$/.test(kind)),
  }
}

const readBomHead = (f, source) => source.calls.some((call) => call.object === f.plan.bomHead.object)

// An invalid numeric head state, introduced AFTER a genuine valid preview minted a token.
async function routeBlocked(value) {
  const { f, source } = routeFixture()
  const r = routeMount(f, source)
  try {
    const valid = await r.dryRun()
    assert.equal(valid.statusCode, 200, JSON.stringify(valid.body))
    assert.equal(valid.body.data.canApply, true, 'original valid fixture must yield an applyable route preview')
    const earlierToken = valid.body.data.dryRunToken
    assert.ok(earlierToken, 'original valid route preview must issue a real token')
    const tokensBefore = r.h.context.storage.size
    assert.equal(tokensBefore, 1)
    changeState(f, 'root', value)
    source.calls.length = 0
    const dry = await r.dryRun()
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.ok(readBomHead(f, source), 'the route must have read the BOM head table (state interpretation reached)')
    assert.equal(dry.body.data.canApply, false)
    assert.equal(dry.body.data.dryRunToken, null)
    assert.equal(r.h.context.storage.size, tokensBefore, 'the invalid preview must not write a token')
    assert.equal(r.writes().length, 0)
    // The earlier genuine token is stale against the changed source. Apply compares the recomputed
    // revision before any canApply branch, so this pins "refused without writes", not canApply handling.
    const applied = await r.apply(earlierToken)
    assert.ok(applied.statusCode >= 400, JSON.stringify(applied.body))
    assert.equal(applied.body && applied.body.error && applied.body.error.code, 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH')
    assert.equal(r.writes().length, 0, 'a refused apply must not create, patch or delete any record')
  } finally { r.h.restore() }
}

// The same invalid state from the start: no token may ever exist.
async function routeColdBlocked(value) {
  const { f, source } = routeFixture()
  changeState(f, 'root', value)
  const r = routeMount(f, source)
  try {
    const dry = await r.dryRun()
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.ok(readBomHead(f, source))
    assert.equal(dry.body.data.canApply, false)
    assert.equal(dry.body.data.dryRunToken, null)
    assert.equal(r.h.context.storage.size, 0, 'no token was written')
    assert.equal(r.writes().length, 0)
  } finally { r.h.restore() }
}

// Legitimate known states are not refused by the real route, and the real apply writes.
async function routeKnown(value) {
  const { f, source } = routeFixture()
  changeState(f, 'root', value)
  const r = routeMount(f, source)
  try {
    const dry = await r.dryRun()
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    assert.ok(readBomHead(f, source))
    assert.equal(dry.body.data.canApply, true, 'a known head state must not be refused')
    assert.ok(dry.body.data.dryRunToken)
    const applied = await r.apply(dry.body.data.dryRunToken)
    assert.equal(applied.statusCode, 200, JSON.stringify(applied.body))
    assert.equal(applied.body.data.status, 'succeeded')
    assert.ok(r.writes().length > 0)
  } finally { r.h.restore() }
}

async function runCases(cases, label) {
  let passed = 0
  for (const [name, run] of cases) {
    try { await run(); passed++; console.log(`PASS ${name}`) }
    catch (error) { console.error(`FAIL ${name}: ${error.stack}`) }
  }
  console.log(`${label} ${passed}/${cases.length}`)
  if (passed !== cases.length) process.exitCode = 1
}

async function main() {
  globalThis.fetch = async () => { throw new Error('SYNTHETIC_TEST_FORBIDDEN_NETWORK') }
  const cases = []
  const unknown = [['missing', undefined, 'missing'], ['undefined', undefined], ['empty', ''], ['blank', '  '], ['unknown', 'SYN-SECRET-UNKNOWN'],
    ['object', {}], ['array', []], ['nan', NaN], ['infinity', Infinity], ['neg-infinity', -Infinity], ['ambiguous', 1, 'ambiguous'], ['string-true', 'true'], ['string-01', '01'], ['string-1.0', '1.0'],
    ['number-2', 2], ['number-minus-1', -1], ['fraction-half', 0.5], ['fraction-above-one', 1.5], ['fraction-negative', -0.5]]
  for (const second of [false, true]) {
    for (const locus of ['root', 'recursive', 'subtree']) {
      for (const [label, value, mode] of unknown) cases.push([`blocked-${second ? 'second' : 'default'}-${locus}-${label}`, () => assertBlocked({ second, locus, value, mode })])
    }
    for (const value of [null, 1, true, ' 1 ']) cases.push([`active-${second}-${JSON.stringify(value)}`, () => activeControl(value, { second })])
    for (const value of [0, false, '0', ' FaLsE ', 'n', 'NO', 'disabled', 'inactive']) cases.push([`inactive-writer-${second}-${JSON.stringify(value)}`, () => inactiveWrites(value, { second })])
    cases.push([`inactive-subtree-writer-${second}`, () => inactiveWrites(0, { second, subtree: true })])
  }
  for (const [label, value] of [['number-2', 2], ['number-minus-1', -1], ['fraction-half', 0.5], ['fraction-above-one', 1.5]]) {
    cases.push([`route-blocked-${label}`, () => routeBlocked(value)])
  }
  for (const [label, value] of [['number-2', 2], ['number-minus-1', -1]]) cases.push([`route-cold-blocked-${label}`, () => routeColdBlocked(value)])
  for (const value of [1, 0, true, false, null, ' 1 ', ' FaLsE ']) cases.push([`route-known-${JSON.stringify(value)}`, () => routeKnown(value)])
  cases.push(['membership-and-undeclared', membershipAndUndeclared], ['background-unknown-not-authoritative', backgroundBlocked])
  await runCases(cases, 'SA01F active-state')
  await runCases(configuredStateCases(), 'SA01F configured-state')
}

module.exports = { PROJECT, SHEET, SCOPE, NOW, fixture, sourceFor, storage, recordsApi, actionFor, lockedActions, lockedJobs, runCases, clone, main }
