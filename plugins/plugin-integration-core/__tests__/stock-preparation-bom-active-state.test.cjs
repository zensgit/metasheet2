'use strict'

// Independent SA01F real-chain tests. Only the source/read and persistence APIs
// are in memory: expansion, normalization, planning, tokens and writes are real.
const assert = require('node:assert/strict')
const bom = require('../lib/stock-preparation-bom-expansion.cjs')
const actions = require('../lib/stock-preparation-table-actions.cjs')
const jobs = require('../lib/stock-preparation-large-bom-jobs.cjs')

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
  changeState(f, locus, value, mode)
  const source = sourceFor(f.data)
  const expansion = await bom.expandPlmProjectBom({ sourceAdapter: source, projectNo: PROJECT, readPlan: f.plan })
  const input = inputFor(f.plan, source, target)
  const dry = await actions.dryRunStockPreparationAction(input)
  const issued = input.tokenStore.map.size
  const planner = await actions.prepareStockPreparationConfirmationDecisions(input)
  const token = dry.dryRunToken || await actions.__internals.createDryRunToken(input.tokenStore, {
    actionId: input.action.actionId, parametersHash: actions.__internals.hashJson(input.parameters), revision: dry.revision, conflictPolicyReview: null,
  })
  let failure
  try {
    await actions.applyStockPreparationAction({ ...input, dryRunToken: token, permission: 'write', sandboxPolicy: POLICY,
      acceptManualConfirmHold: true, acceptDuplicateResolution: true })
  } catch (error) { failure = error }
  assert.equal(target.writes.length, 0, 'unknown head state reached actual create/patch')
  assert.deepEqual(target.rows, before, 'unknown state must not inactivate existing descendants')
  assert.equal(failure && failure.code, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE')
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
  const dry = await actions.dryRunStockPreparationAction(input)
  assert.equal(dry.canApply, true, 'known inactive state is normal reconciliation, not a global blocker')
  assert.ok(dry.dryRunToken)
  await actions.applyStockPreparationAction({ ...input, dryRunToken: dry.dryRunToken, permission: 'write', sandboxPolicy: POLICY, acceptManualConfirmHold: true })
  assert.equal(target.rows[0].data.active, false, 'actual writer must inactivate the existing child')
  assert.ok(target.writes.some(([kind, call]) => kind === 'patch' && call.changes.active === false))
}

async function backgroundBlocked() {
  const f = fixture()
  changeState(f, 'recursive', 'SYN-SECRET-UNKNOWN')
  const store = storage()
  const action = actionFor(f.plan)
  const common = { storage: store, ...SCOPE, actionId: action.actionId, jobId: 'bad-head' }
  await jobs.createLargeBomBackgroundExpansionJob({ ...common, action, parameters: { projectNo: PROJECT }, principal: 'synthetic-user', createJobId: () => common.jobId })
  const result = await jobs.runLargeBomBackgroundExpansionJob({ ...common, sourceAdapter: sourceFor(f.data), expansionOptions: { readPlan: f.plan } })
  assert.equal(result.status, 'failed')
  assert.equal(jobs.isAuthoritativeLargeBomExpansion(result), false)
  assert.equal(result.artifact, undefined)
  await assert.rejects(() => jobs.planLargeBomBackgroundExpansionJob({ ...common, existingRows: [] }), { code: 'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE' })
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
    ['object', {}], ['array', []], ['nan', NaN], ['infinity', Infinity], ['ambiguous', 1, 'ambiguous'], ['string-true', 'true'], ['string-01', '01'], ['string-1.0', '1.0']]
  for (const second of [false, true]) {
    for (const locus of ['root', 'recursive', 'subtree']) {
      for (const [label, value, mode] of unknown) cases.push([`blocked-${second ? 'second' : 'default'}-${locus}-${label}`, () => assertBlocked({ second, locus, value, mode })])
    }
    for (const value of [null, 1, true, ' 1 ']) cases.push([`active-${second}-${JSON.stringify(value)}`, () => activeControl(value, { second })])
    for (const value of [0, 2, -1, false, '0', ' FaLsE ', 'n', 'NO', 'disabled', 'inactive']) cases.push([`inactive-writer-${second}-${JSON.stringify(value)}`, () => inactiveWrites(value, { second })])
    cases.push([`inactive-subtree-writer-${second}`, () => inactiveWrites(2, { second, subtree: true })])
  }
  cases.push(['membership-and-undeclared', membershipAndUndeclared], ['background-unknown-not-authoritative', backgroundBlocked])
  await runCases(cases, 'SA01F active-state')
}

module.exports = { PROJECT, SHEET, SCOPE, NOW, fixture, sourceFor, storage, recordsApi, actionFor, runCases, clone, main }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
