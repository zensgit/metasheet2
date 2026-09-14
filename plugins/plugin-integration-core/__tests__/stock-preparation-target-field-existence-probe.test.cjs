'use strict'

// 目标表字段存在性探针 — the plan-time half of the readiness probe (stock-preparation-table-actions.cjs
// `assertTargetFieldsExist`, run first thing inside `computeDryRun`).
//
// THE INCIDENT THIS PINS (2026-09-14). A customer deleted five template columns from the managed 备料
// table. Readiness/ensure said 422 TARGET_SCHEMA_INCOMPLETE; dry-run and apply said nothing, because the
// only gate on the plan path inspected the SHAPE of the pasted `fieldIdMap`. The existing-row read then
// returned the deleted columns as `undefined`, the planner read that as `lineage_mismatch` (580
// manual_confirm on one project), and a project with no existing rows took the ADD branch and reported
// `ready` for 211 rows the writer could not address.
//
// WHAT IS ASSERTED, per the spec:
//   (a) a host whose DB-backed read omits five logical ids => 422 TARGET_SCHEMA_INCOMPLETE, details
//       carry exactly those five, and NOTHING else happened: no ensureObject, no source read, no
//       records read, no token, no plan.
//   (b) the same host with nothing missing => the result is deep-equal to the pre-probe result.
//   (c) an older host without the DB read => deep-equal to the pre-probe result, and the probe made
//       ZERO provisioning calls.
//   (d) a host whose DB read throws MultitableObjectScopeError => same as (c) (degraded, not refused).
//   (e) apply is refused through the SAME layer, before any write.
//   (f) values-free: the refusal carries logical ids only — no physical id, no sheet id, no extra key.
//   (g) same 口径 as ensure/readiness: the five the probe reports are the five readiness reports for
//       the same host, ext fields included.
//   (h) the ext_ half of the verdict: a declared extension column the host does not hold is reported.
//   (i) the probe judges the BOUND sheet or judges nothing: a binding whose (project, object) pair the
//       host derives to a different sheet than `target.sheetId` is never judged on that other sheet —
//       no refusal, no DB read, the pre-probe result (反驳 r1 blocker).
//   (j) a host failure on the DB read is a values-free 503 TARGET_SCHEMA_UNAVAILABLE, never a plan and
//       never the driver's text (反驳 r1 minor).
//   (k) apply refuses BEFORE the single-use token is consumed: the same token applies once the columns
//       are back (反驳 r1 minor).
//
// MUTATIONS this suite is calibrated against (run in-memory by the implementer's mutation runner, never
// on disk): M1 probe call removed => (a)(e) red; M2 probe reads the fieldIdMap shape instead of the host
// => (a) red; M3 refuse in every mode / on old hosts => (c)(d) red; M4 details carry values => (f) red;
// M5 probe moved after the source read => (a)'s zero-read assertions red; M6 sheet-identity gate removed
// => (i) red; M7 apply's pre-token probe removed => (k) red; M8 host failure rethrown raw => (j) red.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  applyStockPreparationAction,
  dryRunStockPreparationAction,
  __internals: tableActionInternals,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))
const {
  inspectStockPreparationCanonicalTarget,
  resolveFieldExistence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))

const TEMPLATE_FIELD_IDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)
// Five template columns of the kind a customer deletes from the grid: machine plumbing the fill view
// hides. `componentSourceId` and `path` are the two the planner reads for lineage — the pair that
// turned into 580 `lineage_mismatch` holds in the incident.
const MISSING_FIVE = Object.freeze(['componentSourceId', 'parentSourceId', 'path', 'depth', 'lastPlmRefreshRunId'])
for (const id of MISSING_FIVE) assert.ok(TEMPLATE_FIELD_IDS.includes(id), `${id} is a template field`)
const EXT_FIELD_IDS = Object.freeze(['ext_designer', 'ext_parentSortNo'])

const OBJECT_ID = 'stockPreparationMain'
const SHEET_ID = 'sheet_stock'
const PROJECT_ID = 'tenant_1:integration-core'
const PLANNED_AT = '2026-09-14T00:00:00.000Z'
const RUN_ID = 'run_probe_1'
const SANDBOX_POLICY = { enabled: true, allowedTargetObjectIds: [OBJECT_ID] }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function physical(fieldId) {
  return `fld_${fieldId}`
}

// The EXPLICIT physical map, complete for template + ext ids. Explicit on purpose: it is exactly the
// shape the shape-only gate (`assertTargetFieldMapCompleteness`) passes, which is the whole point —
// a complete map says nothing about whether the columns behind it still exist.
function completeFieldIdMap(extensionFieldIds = []) {
  return Object.fromEntries(TEMPLATE_FIELD_IDS.concat(extensionFieldIds).map((id) => [id, physical(id)]))
}

function action({ extensionFieldIds = [] } = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'plm_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: SHEET_ID, objectId: OBJECT_ID, fieldIdMap: completeFieldIdMap(extensionFieldIds) },
    ...(extensionFieldIds.length ? { extensionFieldIds } : {}),
  }
}

function plmData() {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [{ OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' }],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

function createSourceAdapter(data = plmData()) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const matches = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
        return { records: matches.map(clone), nextCursor: null, done: true }
      },
    },
  }
}

function createRecordsApi(existing = []) {
  const rows = existing.map((data, index) => ({ id: `rec_${index + 1}`, sheetId: SHEET_ID, version: 1, data: { ...data } }))
  const calls = []
  return {
    calls,
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        const record = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
        if (!record) throw new Error(`record not found: ${input.recordId}`)
        record.version += 1
        record.data = { ...record.data, ...(input.changes || {}) }
        return clone(record)
      },
    },
  }
}

function createMemoryStore() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.has(key) ? clone(map.get(key)) : null },
    async set(key, value) { map.set(key, clone(value)) },
    async delete(key) { map.delete(key) },
  }
}

/**
 * A provisioning fake in the host's own vocabulary.
 *
 *   dbRead: true  — implements `resolveExistingObjectFieldIds` (the W2 DB-backed read). It omits every
 *                   id in `missing`, exactly as the host omits ids absent from `meta_fields`.
 *   dbRead: false — an older host: compute-only `resolveFieldIds` and nothing else.
 *   scopeError    — the DB read throws it (MultitableObjectScopeError shape) instead of answering.
 *   derivedSheetId — what `getObjectSheetId(project, object)` answers: the sheet the host's DB read
 *                   would key `meta_fields` on. SHEET_ID by default (a binding whose two halves name
 *                   one tuple, i.e. a sheet ensure provisioned); anything else is the pre-registry /
 *                   hand-bound shape the probe must not judge.
 *
 * `computedMissing` makes the compute-only map ALSO omit ids. A real compute-only host never omits
 * (it derives an id for every field it is asked about), so this is not a model of production — it is
 * the instrument that lets (c) and (d) SEE a probe that refuses on a non-db verdict (mutation M3):
 * with a complete compute map such a probe would find nothing to refuse and the guard would be
 * unobservable.
 *
 * `ensureObject` is present so a probe that tried to heal would be caught, and it throws so the
 * attempt cannot pass silently.
 */
function createProvisioning({ missing = [], dbRead = true, scopeError = null, computedMissing = missing, derivedSheetId = SHEET_ID } = {}) {
  const calls = []
  const answer = (fieldIds, omit) => Object.fromEntries(
    (Array.isArray(fieldIds) ? fieldIds : []).filter((id) => !omit.includes(id)).map((id) => [id, physical(id)]),
  )
  const provisioning = {
    // Pure derivation, exactly the host's: no IO, and the id the DB read below keys on.
    getObjectSheetId(projectId, objectId) {
      calls.push(['getObjectSheetId', { projectId, objectId }])
      return derivedSheetId
    },
    async findObjectSheet({ projectId, objectId } = {}) {
      calls.push(['findObjectSheet', { projectId, objectId }])
      return { id: SHEET_ID, baseId: null, name: objectId, description: null }
    },
    async resolveFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.push(['resolveFieldIds', { projectId, objectId, fieldIds: [...fieldIds] }])
      return answer(fieldIds, computedMissing)
    },
    async ensureObject() {
      calls.push(['ensureObject'])
      throw new Error('ensureObject must never be called by the plan layer')
    },
  }
  if (dbRead) {
    provisioning.resolveExistingObjectFieldIds = async ({ projectId, objectId, fieldIds } = {}) => {
      calls.push(['resolveExistingObjectFieldIds', { projectId, objectId, fieldIds: [...fieldIds] }])
      if (scopeError) throw scopeError
      return answer(fieldIds, missing)
    }
  }
  return { provisioning, calls, callNames: () => calls.map(([name]) => name) }
}

function scopeError(shape) {
  const error = new Error('object is not in this plugin scope')
  if (shape === 'name') error.name = 'MultitableObjectScopeError'
  if (shape === 'code') error.code = 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'
  return error
}

function dryRunInput({ action: config = action(), targetFieldExistence, tokenStore = createMemoryStore(), source = createSourceAdapter(), records = createRecordsApi() } = {}) {
  return {
    action: config,
    parameters: { projectNo: 'P-001' },
    sourceAdapter: source.adapter,
    recordsApi: records.recordsApi,
    tokenStore,
    policyStore: createMemoryStore(),
    plannedAt: PLANNED_AT,
    runId: RUN_ID,
    ...(targetFieldExistence !== undefined ? { targetFieldExistence } : {}),
  }
}

/** The dry-run result minus the one field that is random by construction (the minted token). */
function comparable(result) {
  const { dryRunToken, ...rest } = result
  return { ...clone(rest), dryRunTokenShape: typeof dryRunToken }
}

/** The stored token record minus the two wall-clock stamps. */
function storedTokenRecord(store) {
  const entries = [...store.map.entries()]
  assert.equal(entries.length, 1, 'exactly one token record is stored by a ready dry-run')
  const { createdAt, expiresAt, ...rest } = entries[0][1]
  assert.ok(createdAt && expiresAt)
  return rest
}

async function expectRefusal(fn) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected the call to refuse')
  assert.equal(caught.name, 'StockPreparationTableActionError', 'the refusal is the table-action error class')
  assert.equal(caught.status, 422)
  assert.equal(caught.code, 'TARGET_SCHEMA_INCOMPLETE')
  return caught
}

// ── the pre-probe baseline every "byte-identical" claim below is measured against ──────────────
//
// Computed WITHOUT `targetFieldExistence` at all — the call shape every existing caller in this
// repository still uses — over the same fixtures the probed runs get.
async function baseline(config = action()) {
  const tokenStore = createMemoryStore()
  const result = await dryRunStockPreparationAction(dryRunInput({ action: config, tokenStore }))
  return { result: comparable(result), token: storedTokenRecord(tokenStore) }
}

// ── (a) five template columns gone => 422, and nothing else happened ──────────────────────────

async function aMissingColumnsRefuseBeforeAnyReadOrPlan() {
  const host = createProvisioning({ missing: MISSING_FIVE })
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const tokenStore = createMemoryStore()
  const error = await expectRefusal(() => dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
    tokenStore,
    source,
    records,
  })))
  assert.deepEqual(error.details.missingFields, [...MISSING_FIVE], '(a) details name exactly the five missing logical ids')
  assert.equal(error.details.fieldExistenceMode, 'db')
  assert.equal(error.details.targetObjectId, OBJECT_ID)
  // ZERO of everything downstream: this is the "before the first source row, before any plan" claim.
  assert.deepEqual(source.calls, [], '(a) zero source reads')
  assert.deepEqual(records.calls, [], '(a) zero records reads or writes — no plan was built')
  assert.equal(tokenStore.map.size, 0, '(a) zero tokens minted')
  assert.deepEqual(host.callNames(), ['getObjectSheetId', 'resolveExistingObjectFieldIds'], '(a) one derivation, one DB read, zero ensureObject, zero findObjectSheet')
  assert.deepEqual(host.calls[0][1], { projectId: PROJECT_ID, objectId: OBJECT_ID }, '(a) the derivation names the sheet the DB read is about')
  const probeCall = host.calls[1][1]
  assert.equal(probeCall.projectId, PROJECT_ID, '(a) the probe asks under the threaded project')
  assert.equal(probeCall.objectId, OBJECT_ID, '(a) the probe asks about the action target object')
  assert.deepEqual(probeCall.fieldIds, TEMPLATE_FIELD_IDS, '(a) the probe asks about every template field')
}

// ── (b) same host, nothing missing => the pre-probe result, deep-equal ────────────────────────

async function bCompleteHostLeavesTheResultUntouched() {
  const expected = await baseline()
  const host = createProvisioning({ missing: [] })
  const tokenStore = createMemoryStore()
  const result = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
    tokenStore,
  }))
  assert.equal(result.status, 'ready')
  assert.deepEqual(comparable(result), expected.result, '(b) a complete target plans exactly what the unprobed call planned')
  assert.deepEqual(storedTokenRecord(tokenStore), expected.token, '(b) and mints the same token record')
  assert.equal('fieldExistenceMode' in result.evidence, false, '(b) evidence gains no key on the db leg either')
  assert.deepEqual(host.callNames(), ['getObjectSheetId', 'resolveExistingObjectFieldIds'], '(b) the probe cost exactly one DB read (the derivation is pure)')
}

// ── (c) older host, no DB read => the pre-probe result, and the probe never spoke to the host ──

async function cOldHostIsByteIdenticalAndUntouched() {
  const expected = await baseline()
  // `computedMissing` omits the five ON PURPOSE (see createProvisioning): a probe that consulted the
  // compute-only map on an old host would find them missing and refuse. This host must not be asked.
  const host = createProvisioning({ dbRead: false, computedMissing: MISSING_FIVE })
  const tokenStore = createMemoryStore()
  const result = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
    tokenStore,
  }))
  assert.deepEqual(comparable(result), expected.result, '(c) an old host plans exactly what it planned before the probe existed')
  assert.deepEqual(storedTokenRecord(tokenStore), expected.token)
  assert.deepEqual(host.calls, [], '(c) an old host is not asked anything — not one provisioning call')

  // The other two "nothing threaded" shapes are the same path: no input at all, and a host object
  // without provisioning (what a route on a host lacking the multitable API would thread).
  for (const targetFieldExistence of [undefined, null, {}, { provisioning: null, projectId: PROJECT_ID }, { provisioning: host.provisioning, projectId: '' }]) {
    const store = createMemoryStore()
    const again = await dryRunStockPreparationAction(dryRunInput({ targetFieldExistence, tokenStore: store }))
    assert.deepEqual(comparable(again), expected.result, `(c) shape ${JSON.stringify(targetFieldExistence)} is inert`)
  }
  assert.deepEqual(host.calls, [], '(c) still not one provisioning call')
}

// ── (d) DB read refuses the object scope => degraded to compute-only, not refused ─────────────

async function dScopeRefusalDegradesInsteadOfRefusing() {
  const expected = await baseline()
  for (const shape of ['name', 'code']) {
    const host = createProvisioning({ missing: MISSING_FIVE, scopeError: scopeError(shape), computedMissing: MISSING_FIVE })
    const tokenStore = createMemoryStore()
    const result = await dryRunStockPreparationAction(dryRunInput({
      targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
      tokenStore,
    }))
    assert.deepEqual(comparable(result), expected.result, `(d/${shape}) a scope-refused probe plans exactly the pre-probe plan`)
    assert.deepEqual(storedTokenRecord(tokenStore), expected.token)
    assert.deepEqual(
      host.callNames(),
      ['getObjectSheetId', 'resolveExistingObjectFieldIds', 'resolveFieldIds'],
      `(d/${shape}) the probe degraded through resolveFieldExistence's own fallback — no ensureObject, no refusal`,
    )
    // And the degradation IS the provisioning module's, not a re-implementation: the same host
    // answers the same mode through the exported probe.
    const direct = await resolveFieldExistence({ provisioning: host.provisioning, projectId: PROJECT_ID, objectId: OBJECT_ID, fieldIds: TEMPLATE_FIELD_IDS })
    assert.equal(direct.fieldExistenceMode, 'computed_scope_unavailable')
  }
}

// ── (e) apply is refused through the same layer, before any write ─────────────────────────────

async function eApplyIsRefusedThroughTheSameLayer() {
  // A token minted while the schema was complete...
  const tokenStore = createMemoryStore()
  const complete = createProvisioning({ missing: [] })
  const dryRun = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: complete.provisioning, projectId: PROJECT_ID },
    tokenStore,
  }))
  assert.ok(dryRun.dryRunToken)
  // ...then the five columns are deleted before apply.
  const drifted = createProvisioning({ missing: MISSING_FIVE })
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const error = await expectRefusal(() => applyStockPreparationAction({
    ...dryRunInput({ targetFieldExistence: { provisioning: drifted.provisioning, projectId: PROJECT_ID }, tokenStore, source, records }),
    dryRunToken: dryRun.dryRunToken,
    permission: 'write',
    sandboxPolicy: SANDBOX_POLICY,
  }))
  assert.deepEqual(error.details.missingFields, [...MISSING_FIVE], '(e) apply reports the same five through the same probe')
  assert.deepEqual(source.calls, [], '(e) apply did not re-expand the source')
  assert.deepEqual(records.calls, [], '(e) apply wrote nothing and read nothing')
  assert.deepEqual(drifted.callNames(), ['getObjectSheetId', 'resolveExistingObjectFieldIds'], '(e) one DB read, zero ensureObject')
  // (k) the refusal landed BEFORE the token consume: the single-use token is still there...
  assert.equal(tokenStore.map.size, 1, '(k) a refused apply does not burn the dry-run token')
  // ...so the operator runs ensure (columns back) and applies the plan they proved, SAME token.
  const records3 = createRecordsApi()
  const applied3 = await applyStockPreparationAction({
    ...dryRunInput({ targetFieldExistence: { provisioning: complete.provisioning, projectId: PROJECT_ID }, tokenStore, records: records3 }),
    dryRunToken: dryRun.dryRunToken,
    permission: 'write',
    sandboxPolicy: SANDBOX_POLICY,
  })
  assert.equal(applied3.status, 'succeeded', '(k) the same token applies once the columns are back')
  assert.ok(records3.calls.some(([name]) => name === 'createRecord'), '(k) and the write happened')
  assert.equal(tokenStore.map.size, 0, '(k) only the apply that went through consumed the token')

  // Control: the same apply with the columns present goes through and writes.
  const tokenStore2 = createMemoryStore()
  const dryRun2 = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: complete.provisioning, projectId: PROJECT_ID },
    tokenStore: tokenStore2,
  }))
  const records2 = createRecordsApi()
  const applied = await applyStockPreparationAction({
    ...dryRunInput({ targetFieldExistence: { provisioning: complete.provisioning, projectId: PROJECT_ID }, tokenStore: tokenStore2, records: records2 }),
    dryRunToken: dryRun2.dryRunToken,
    permission: 'write',
    sandboxPolicy: SANDBOX_POLICY,
  })
  assert.equal(applied.status, 'succeeded')
  assert.ok(records2.calls.some(([name]) => name === 'createRecord'), '(e) control: a complete target is written')
}

// ── (f) values-free ───────────────────────────────────────────────────────────────────────────

async function fTheRefusalCarriesLogicalIdsOnly() {
  const host = createProvisioning({ missing: MISSING_FIVE })
  const error = await expectRefusal(() => dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
  })))
  assert.deepEqual(
    Object.keys(error.details).sort(),
    ['fieldExistenceMode', 'missingFields', 'targetObjectId'],
    '(f) details carry exactly the three keys the spec names and not one more',
  )
  const text = JSON.stringify(error.details) + JSON.stringify(error.message)
  assert.equal(text.includes('fld_'), false, '(f) no physical field id leaves the module')
  assert.equal(text.includes(SHEET_ID), false, '(f) no sheet id leaves the module')
  assert.equal(text.includes(PROJECT_ID), false, '(f) no project id leaves the module')
  assert.equal(text.includes('P-001'), false, '(f) no project number leaves the module')
  for (const id of error.details.missingFields) {
    assert.ok(TEMPLATE_FIELD_IDS.includes(id) || id.startsWith('ext_'), `(f) ${id} is a logical id`)
  }
}

// ── (g) the same 口径 as readiness/ensure ──────────────────────────────────────────────────────

async function gTheProbeAndReadinessReportTheSameMissingSet() {
  const missing = [...MISSING_FIVE, EXT_FIELD_IDS[1]]
  const host = createProvisioning({ missing })
  const config = action({ extensionFieldIds: [...EXT_FIELD_IDS] })
  const error = await expectRefusal(() => dryRunStockPreparationAction(dryRunInput({
    action: config,
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
  })))
  const readiness = await inspectStockPreparationCanonicalTarget({
    context: { api: { multitable: { provisioning: host.provisioning } } },
    permission: 'admin',
    projectId: PROJECT_ID,
    extensionFieldIds: [...EXT_FIELD_IDS],
  })
  assert.equal(readiness.ready, false)
  assert.equal(readiness.mode, 'canonical_incomplete')
  assert.equal(readiness.evidence.fieldExistenceMode, 'db')
  assert.deepEqual(
    error.details.missingFields,
    readiness.evidence.missingFields,
    '(g) the plan-time probe and the readiness probe report the identical missing set, ext included',
  )
  assert.deepEqual(error.details.missingFields, missing)
}

// ── (h) the ext_ half on its own ──────────────────────────────────────────────────────────────

async function hADeclaredExtensionColumnTheHostLacksIsReported() {
  const host = createProvisioning({ missing: [EXT_FIELD_IDS[0]] })
  const error = await expectRefusal(() => dryRunStockPreparationAction(dryRunInput({
    action: action({ extensionFieldIds: [...EXT_FIELD_IDS] }),
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
  })))
  assert.deepEqual(error.details.missingFields, [EXT_FIELD_IDS[0]])
  assert.deepEqual(host.calls[1][1].fieldIds, TEMPLATE_FIELD_IDS.concat(EXT_FIELD_IDS), '(h) the probe asks about template + declared ext ids')

  // And an action that declares no ext ids is not asked about any.
  const plain = createProvisioning({ missing: [] })
  await dryRunStockPreparationAction(dryRunInput({ targetFieldExistence: { provisioning: plain.provisioning, projectId: PROJECT_ID } }))
  assert.deepEqual(plain.calls[1][1].fieldIds, TEMPLATE_FIELD_IDS)
}

// ── (i) the probe judges the bound sheet, or it judges nothing ────────────────────────────────
//
// The host's DB read keys `meta_fields` on the sheet it DERIVES from (project, object); the plan reads
// and writes `target.sheetId` verbatim, and nothing requires the two to name one sheet (THE CARRY
// TENANT WALL, http-routes.cjs, retired exactly that rule). A probe that ignored this could refuse a
// healthy bound sheet because a DIFFERENT sheet lost columns — or pass a broken one because the
// derived sheet is whole. Either way the guarantee would be about a table the plan never touches.

async function iADivergentBindingIsNeverJudgedOnAnotherSheet() {
  const expected = await baseline()
  // The derived sheet is missing five columns. The bound sheet (the one the plan reads/writes) is
  // not the derived sheet, so the probe has no proof the DB read would be about it.
  const host = createProvisioning({ missing: MISSING_FIVE, derivedSheetId: 'sheet_derived_elsewhere' })
  const tokenStore = createMemoryStore()
  const result = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
    tokenStore,
  }))
  assert.deepEqual(comparable(result), expected.result, '(i) a divergent binding plans exactly the pre-probe plan')
  assert.deepEqual(storedTokenRecord(tokenStore), expected.token)
  assert.deepEqual(host.callNames(), ['getObjectSheetId'], '(i) the derivation ran and the DB read did NOT: nothing about another sheet was consulted')
  assert.deepEqual(host.calls[0][1], { projectId: PROJECT_ID, objectId: OBJECT_ID })

  // The reported shape: objectId OMITTED from the config (it defaults to the template's) while the
  // sheetId was bound by the deployment. The pair the host would judge is (staging project, default
  // object), which is not provably this sheet — so, again, no judgement.
  const defaulted = action()
  delete defaulted.target.objectId
  const host2 = createProvisioning({ missing: MISSING_FIVE, derivedSheetId: 'sheet_derived_elsewhere' })
  const again = await dryRunStockPreparationAction(dryRunInput({
    action: defaulted,
    targetFieldExistence: { provisioning: host2.provisioning, projectId: PROJECT_ID },
  }))
  assert.equal(again.status, 'ready', '(i) the defaulted-object binding is not refused on the derived sheet')
  assert.deepEqual(host2.callNames(), ['getObjectSheetId'])
  assert.equal(host2.calls[0][1].objectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)

  // And when the derived sheet IS the bound sheet, the same five refuse (the positive half of the
  // identity, so a gate that compared the wrong thing could not pass both arms).
  const bound = createProvisioning({ missing: MISSING_FIVE, derivedSheetId: SHEET_ID })
  await expectRefusal(() => dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: bound.provisioning, projectId: PROJECT_ID },
  })))
  assert.deepEqual(bound.callNames(), ['getObjectSheetId', 'resolveExistingObjectFieldIds'])

  // A host that cannot derive is not asked to judge either: no derivation, no DB read, no refusal.
  const underivable = createProvisioning({ missing: MISSING_FIVE })
  delete underivable.provisioning.getObjectSheetId
  const third = await dryRunStockPreparationAction(dryRunInput({
    targetFieldExistence: { provisioning: underivable.provisioning, projectId: PROJECT_ID },
  }))
  assert.deepEqual(comparable(third), expected.result, '(i) an underivable host plans the pre-probe plan')
  assert.deepEqual(underivable.calls, [], '(i) and is not asked anything')
}

// ── (j) a host failure on the DB read is a values-free 503, not a plan and not a driver string ──

async function jAHostFailureIsAValuesFree503() {
  const boom = new Error('connection terminated')
  boom.code = 'ECONNRESET'
  const host = createProvisioning({ scopeError: boom })
  const source = createSourceAdapter()
  const records = createRecordsApi()
  const tokenStore = createMemoryStore()
  let caught = null
  try {
    await dryRunStockPreparationAction(dryRunInput({
      targetFieldExistence: { provisioning: host.provisioning, projectId: PROJECT_ID },
      source,
      records,
      tokenStore,
    }))
  } catch (error) {
    caught = error
  }
  assert.ok(caught, '(j) the plan did not proceed on a schema nobody could read')
  assert.equal(caught.name, 'StockPreparationTableActionError')
  assert.equal(caught.status, 503)
  assert.equal(caught.code, 'TARGET_SCHEMA_UNAVAILABLE')
  assert.deepEqual(caught.details, { targetObjectId: OBJECT_ID }, '(j) details carry the object id and nothing else')
  assert.equal(caught.cause, boom, '(j) the host failure travels on cause, for the server log')
  const text = JSON.stringify(caught.details) + caught.message
  assert.equal(text.includes('connection terminated'), false, '(j) the driver text never leaves the module')
  assert.equal(text.includes('ECONNRESET'), false)
  assert.deepEqual(source.calls, [], '(j) zero source reads')
  assert.deepEqual(records.calls, [], '(j) zero records calls')
  assert.equal(tokenStore.map.size, 0, '(j) zero tokens minted')
}

// ── the probe is one exported thing, reachable for the route suite ────────────────────────────

function theProbeIsExportedFromTheInternals() {
  assert.equal(typeof tableActionInternals.assertTargetFieldsExist, 'function')
}

async function main() {
  await aMissingColumnsRefuseBeforeAnyReadOrPlan()
  await bCompleteHostLeavesTheResultUntouched()
  await cOldHostIsByteIdenticalAndUntouched()
  await dScopeRefusalDegradesInsteadOfRefusing()
  await eApplyIsRefusedThroughTheSameLayer()
  await fTheRefusalCarriesLogicalIdsOnly()
  await gTheProbeAndReadinessReportTheSameMissingSet()
  await hADeclaredExtensionColumnTheHostLacksIsReported()
  await iADivergentBindingIsNeverJudgedOnAnotherSheet()
  await jAHostFailureIsAValuesFree503()
  theProbeIsExportedFromTheInternals()
  console.log('stock-preparation-target-field-existence-probe tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
