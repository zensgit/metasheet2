'use strict'

// Batch-refresh step 4, PR-6 — the GENERIC MULTITABLE WRITERS refuse a GOVERNED stock-prep sheet
// (lib/adapters/metasheet-multitable-target-adapter.cjs; design §7.1 row 17, D-21; F-6). Before PR-6 the pipelines
// target adapter wrote a governed, suspended pilot sheet unrefused (review of #6550, V50B-12). Each seam is driven
// with a RECORDING records API (every host records / provisioning call logged in order) and either a scripted probe
// or the REAL probe over the refresh-store kit's fake db:
//
//   A-01 `upsert` on a governed sheet: ONE typed 409 (surface pipeline_upsert) for the batch — zero queryRecords /
//        createRecord / patchRecord, no field-map resolve, no ownership read; the probe is called ONCE for a 3-row
//        batch with the configured sheet and the SYSTEM's tenant. The real probe over a real open hold refuses too.
//   A-02 the probe throws 503: it propagates, zero records IO; the failure is not cached — the next upsert on the same
//        instance probes again and writes when the sheet is now not governed.
//   A-03 BYTE-IDENTITY: the same 3-row upsert through an adapter WITHOUT a probe and one whose probe answers "not
//        governed" (scripted, and the REAL probe over an empty store) — the recorded host calls and the result
//        deep-equal; one probe per object per instance (a second upsert reuses the answer); previewUpsert never
//        calls the probe.
//   A-04 NOT WIRED: no probe + an object key in the stock-prep namespace (a per-project sheet, the env main sheet) —
//        501 STOCK_PREP_GOVERNED_SHEET_PROBE_UNWIRED before any IO on upsert, insertRows, updateRows and test().
//   A-05 a read-only system sheet that is also governed: the host read-only refusal keeps precedence (the probe is
//        not asked); on a host without the read-only probe the governance refusal stands alone.
//   A-06 C6 `test()`: governed => throws the 409 (surface c6_target_test); through dryRunExternalWrite: the throw
//        propagates, NO token in the store, no source read, zero records IO; two objects with only the second
//        governed => refused; not governed => `{ success, capabilityState }` byte-identical to a probe-less source
//        and the plan proceeds.
//   A-07 C6 apply: a token minted while not governed, the sheet governed before the apply (a fresh write-source per
//        request, as the routes build it) => the re-plan's `test()` throws the 409, the token is CONSUMED (burned,
//        fail-closed), zero writes. Defence in depth: an apply whose `test()` skips the probe meets the refusal in
//        insertRows — every row fails with the REGISTERED code (not WRITE_FAILED), a dead letter per row, zero writes.
//   A-08 insertRows / updateRows called directly: refused before queryRecords and any write; lookupByKey (a read)
//        is not probed.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const adapterLib = require(path.join(LIB, 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const { dryRunExternalWrite, applyExternalWrite } = require(path.join(LIB, 'external-write-dry-run.cjs'))
const probeLib = require(path.join(LIB, 'stock-preparation-governed-sheet-probe.cjs'))
const storeModule = require(path.join(LIB, 'stock-preparation-continuation-store.cjs'))
const registryModule = require(path.join(LIB, 'stock-preparation-project-target-store.cjs'))
const ownBase = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
const refreshKit = require(path.join(__dirname, 'support', 'stock-preparation-refresh-store-kit.cjs'))

const {
  createMetaSheetMultitableTargetAdapter,
  createMetaSheetMultitableTargetAdapterFactory,
  createMetaSheetMultitableWriteSource,
  MULTITABLE_WRITE_PROFILE,
  MultitableSystemSheetWriteError,
  StockPreparationGovernedSheetWriteError,
  GOVERNED_SHEET_WRITE_CODES: CODES,
} = adapterLib

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant_mgs_a'
const SHEET = 'sheet_mgs_target'
const OTHER_SHEET = 'sheet_mgs_second'

const NOT_GOVERNED = Object.freeze({ ok: true, governed: false, reason: null, registry: Object.freeze({ present: false }), marks: Object.freeze({ continuation: 0, openHold: 0, state: 0, execution: 0 }) })
const governedAnswer = (reason = 'hold') => Object.freeze({ ok: true, governed: true, reason, registry: Object.freeze({ present: true, pilot: reason === 'pilot', tenantMatches: true }), marks: Object.freeze({ continuation: 0, openHold: 1, state: 1, execution: 0 }) })
const unreadable = () => new StockPreparationGovernedSheetWriteError(503, CODES.STORE_FAILED, 'unreadable', { store: 'continuation', operation: 'read_sheet_governance_marks', sqlState: '42P01', partial: false })

// A scripted probe: `answerFor(input, n)` returns an answer or an Error (thrown). Records every call.
function scriptedProbe(answerFor = () => NOT_GOVERNED) {
  const calls = []
  let script = answerFor
  const probe = {
    calls,
    script(next) { script = next },
    async probe(input) {
      calls.push({ ...input })
      const answer = script(input, calls.length)
      if (answer instanceof Error) throw answer
      return answer
    },
    async assertSheetWritable() {
      throw new Error('the adapter seams must use probe() + their per-object cache, not assertSheetWritable()')
    },
  }
  return probe
}

// The REAL probe over the refresh-store kit (real continuation store + real registry store, one fake plugin db).
function realProbeWorld() {
  const clock = refreshKit.createClock()
  const db = refreshKit.createFakeRefreshDb({ clock })
  const continuationStore = storeModule.createStockPreparationContinuationStore({ db, now: clock.now })
  const projectTargetStore = registryModule.createStockPreparationProjectTargetStore({ db })
  return { db, clock, continuationStore, probe: probeLib.createStockPreparationGovernedSheetProbe({ continuationStore, projectTargetStore }) }
}

async function seedOpenHold(world, sheetId = SHEET) {
  const fixture = await refreshKit.candidateHoldFixture()
  await world.continuationStore.reconcileHolds({ tenantId: TENANT, projectNo: fixture.projectNo, sheetId, decisionVersionObserved: 0, holds: [fixture.hold], computation: { lane: 'small_preview', suspended: true, generationToken: 'g', sourceContentDigest: 's' } })
}

function memoryStore() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) || null },
    async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async consume(key) { const v = map.get(key) || null; map.delete(key); return v },
    async delete(key) { map.delete(key) },
  }
}

// Every host call the writers can make, recorded in order: records (query / create / patch / the read-only probe)
// and provisioning (the field-map resolve, the ownership metadata read).
function createContext({ existing = [], readOnlySheets = null } = {}) {
  const rows = existing.map((row) => ({ ...row, data: { ...row.data } }))
  const calls = []
  const records = {
    async queryRecords(input) {
      calls.push(['queryRecords', input])
      return rows.filter((row) => row.sheetId === input.sheetId && Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value)).slice(0, input.limit || 1000)
    },
    async createRecord(input) {
      calls.push(['createRecord', input])
      const row = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
      rows.push(row)
      return row
    },
    async patchRecord(input) {
      calls.push(['patchRecord', input])
      const row = rows.find((item) => item.id === input.recordId && item.sheetId === input.sheetId)
      if (!row) throw new Error('record not found')
      row.version += 1
      row.data = { ...row.data, ...input.changes }
      return row
    },
  }
  if (readOnlySheets) {
    records.isReadOnlySystemSheet = async ({ sheetId }) => {
      calls.push(['isReadOnlySystemSheet', { sheetId }])
      return readOnlySheets.includes(sheetId)
    }
  }
  const provisioning = {
    async resolveFieldIds(input) {
      calls.push(['resolveFieldIds', input])
      return Object.fromEntries(input.fieldIds.map((id) => [id, `fld_${id}`]))
    },
    async readObjectFieldsContent(input) {
      calls.push(['readObjectFieldsContent', input])
      return {}
    },
  }
  return { calls, rows, context: { api: { multitable: { records, provisioning } } } }
}

function objectConfig(sheetId = SHEET, extra = {}) {
  return {
    sheetId,
    projectId: `${TENANT}:integration-core`,
    keyFields: ['code'],
    fieldDetails: [
      { id: 'code', name: 'Code', type: 'string' },
      { id: 'name', name: 'Name', type: 'string' },
      { id: 'quantity', name: 'Quantity', type: 'number' },
    ],
    ...extra,
  }
}

function createSystem(objects = { approved_materials: objectConfig() }) {
  return { id: 'mgs_target', tenantId: TENANT, name: 'MGS target', kind: 'metasheet:multitable', role: 'target', config: { objects } }
}

const BATCH = [
  { code: 'MGS-001', name: 'Bolt', quantity: 2 },
  { code: 'MGS-002', name: 'Nut', quantity: 3 },
  { code: 'MGS-003', name: 'Gear', quantity: 4 },
]
const EXISTING = [{ id: 'rec_seed', sheetId: SHEET, version: 1, data: { fld_code: 'MGS-002', fld_name: 'Nut', fld_quantity: 1 } }]
const recordIo = (calls) => calls.filter(([name]) => ['queryRecords', 'createRecord', 'patchRecord'].includes(name))

async function expectError(promise, { status, code, reason, surface }) {
  let caught = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected a throw (${code})`)
  if (status !== undefined) assert.equal(caught.status, status, `${caught.code}: ${caught.message}`)
  if (code !== undefined) assert.equal(caught.code, code, caught.message)
  if (reason !== undefined) assert.equal(caught.details && caught.details.reason, reason, JSON.stringify(caught.details))
  if (surface !== undefined) assert.equal(caught.details && caught.details.surface, surface, JSON.stringify(caught.details))
  return caught
}

function c6Input({ writeSource, tokenStore, sourceRows = BATCH, deadLetterStore } = {}) {
  return {
    pipeline: {
      id: 'pipe_mgs', tenantId: TENANT, workspaceId: 'w1',
      sourceSystemId: 'src', sourceObject: 'items',
      targetSystemId: 'mgs_target', targetObject: 'approved_materials',
      createdBy: 'owner-1',
      options: { source: { filters: { fixtureScope: 'mgs' } } },
      fieldMappings: [
        { sourceField: 'code', targetField: 'code', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'name' },
        { sourceField: 'quantity', targetField: 'quantity' },
      ],
    },
    sourceSystem: { id: 'src', kind: 'data-source:sql-readonly' },
    targetSystem: { id: 'mgs_target', kind: 'metasheet:multitable', config: { dataSourceId: 'mt', object: 'approved_materials', keyFields: ['code'], writableFields: ['name', 'quantity'] } },
    sourceAdapter: {
      reads: 0,
      async read() { this.reads += 1; return { records: sourceRows, done: true, nextCursor: null } },
    },
    dataSourceWrites: writeSource,
    targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    tokenStore,
    dryRunUser: 'owner-1',
    dataSourceOwnerPrincipal: 'owner-1',
    maxRows: 100,
    ...(deadLetterStore ? { deadLetterStore } : {}),
  }
}

// ── A-01 / A-02 / A-03 ───────────────────────────────────────────────────────────────────────────

test('A-01 upsert on a governed sheet: ONE typed 409 for the batch, zero records IO, no field-map resolve, no ownership read; the probe is called once with the configured sheet and the system tenant', async () => {
  const { context, calls } = createContext({ existing: EXISTING })
  const probe = scriptedProbe(() => governedAnswer('continuation'))
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context, governedSheetProbe: probe })
  const error = await expectError(adapter.upsert({ object: 'approved_materials', records: BATCH, keyFields: ['code'] }), { status: 409, code: CODES.REFUSED, surface: 'pipeline_upsert', reason: 'continuation' })
  assert.ok(error instanceof StockPreparationGovernedSheetWriteError)
  assert.equal(error.details.object, 'approved_materials')
  assert.equal(error.details.partial, false)
  assert.deepEqual(calls, [], 'no host call at all: no records IO, no resolveFieldIds, no ownership metadata read')
  assert.deepEqual(probe.calls, [{ sheetId: SHEET, tenantId: TENANT }])
  assert.equal(JSON.stringify(error.details).includes(SHEET), false, 'values-free: no sheet id in the details')
  // The SAME refusal through the factory index.cjs registers (one instance per run).
  const factory = createMetaSheetMultitableTargetAdapterFactory({ context, governedSheetProbe: probe })
  await expectError(factory({ system: createSystem() }).upsert({ object: 'approved_materials', records: BATCH }), { status: 409, code: CODES.REFUSED })
  assert.equal(probe.calls.length, 2, 'a new instance (a new run) probes again')
  // The REAL probe over a real open hold on the sheet.
  const world = realProbeWorld()
  await seedOpenHold(world)
  const real = createContext({ existing: EXISTING })
  const realAdapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: real.context, governedSheetProbe: world.probe })
  await expectError(realAdapter.upsert({ object: 'approved_materials', records: BATCH }), { status: 409, code: CODES.REFUSED, reason: 'hold', surface: 'pipeline_upsert' })
  assert.deepEqual(real.calls, [])
})

test('A-02 the probe throws 503: it propagates with zero records IO; the failure is not cached — the next upsert probes again and writes when the sheet is not governed', async () => {
  const { context, calls, rows } = createContext({ existing: EXISTING })
  const probe = scriptedProbe((input, n) => (n === 1 ? unreadable() : NOT_GOVERNED))
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context, governedSheetProbe: probe })
  await expectError(adapter.upsert({ object: 'approved_materials', records: BATCH }), { status: 503, code: CODES.STORE_FAILED })
  assert.deepEqual(calls, [])
  const result = await adapter.upsert({ object: 'approved_materials', records: BATCH })
  assert.equal(probe.calls.length, 2, 'the failure was not remembered')
  assert.equal(result.written, 3)
  assert.equal(rows.length, 3, 'two created, one patched')
})

test('A-03 BYTE-IDENTITY for a sheet that is not governed: the recorded host calls and the result deep-equal an adapter without a probe (scripted and REAL probe); one probe per object per instance; previewUpsert never probes', async () => {
  async function run(governedSheetProbe) {
    const { context, calls, rows } = createContext({ existing: EXISTING })
    const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context, governedSheetProbe })
    const first = await adapter.upsert({ object: 'approved_materials', records: BATCH, keyFields: ['code'] })
    const second = await adapter.upsert({ object: 'approved_materials', records: BATCH.slice(0, 1), keyFields: ['code'] })
    const preview = await adapter.previewUpsert({ object: 'approved_materials', records: BATCH, keyFields: ['code'] })
    return { calls, rows, first, second, preview }
  }
  const legacy = await run(undefined)
  const scripted = scriptedProbe()
  const probed = await run(scripted)
  const world = realProbeWorld()
  const real = await run(world.probe)
  for (const [label, other] of [['scripted', probed], ['real', real]]) {
    assert.deepEqual(other.calls, legacy.calls, `${label}: host calls identical (names, order, payloads)`)
    assert.deepEqual(other.first, legacy.first, `${label}: first result identical`)
    assert.deepEqual(other.second, legacy.second, `${label}: second result identical`)
    assert.deepEqual(other.preview, legacy.preview, `${label}: preview identical`)
    assert.deepEqual(other.rows, legacy.rows, `${label}: stored rows identical`)
  }
  assert.ok(recordIo(legacy.calls).length > 0, 'not vacuous: the legacy run did write')
  assert.equal(legacy.first.written, 3)
  assert.deepEqual(scripted.calls, [{ sheetId: SHEET, tenantId: TENANT }], 'ONE probe for two upserts and a preview on one instance')
  // The real probe read the plugin db only: one registry selectOne + four counts, once.
  assert.deepEqual(world.db.log.map(([method]) => method), ['selectOne', 'countRows', 'countRows', 'countRows', 'countRows'])
  // A preview alone never probes.
  const previewOnly = scriptedProbe()
  const { context } = createContext()
  await createMetaSheetMultitableTargetAdapter({ system: createSystem(), context, governedSheetProbe: previewOnly }).previewUpsert({ object: 'approved_materials', records: BATCH })
  assert.equal(previewOnly.calls.length, 0)
})

// ── A-04 / A-05 ──────────────────────────────────────────────────────────────────────────────────

test('A-04 NOT WIRED: no probe + an object key in the stock-prep namespace => 501 PROBE_UNWIRED before any IO on upsert / insertRows / updateRows / test(); any other key writes as before', async () => {
  const projectSheet = ownBase.deriveStockPreparationProjectSheetObjectId(TENANT, 'PRJ-MGS')
  for (const key of [projectSheet, 'plm_stock_preparation_main']) {
    const { context, calls } = createContext({ existing: EXISTING })
    const system = createSystem({ [key]: objectConfig() })
    const adapter = createMetaSheetMultitableTargetAdapter({ system, context })
    const error = await expectError(adapter.upsert({ object: key, records: BATCH }), { status: 501, code: CODES.PROBE_UNWIRED, reason: 'probe_absent', surface: 'pipeline_upsert' })
    assert.equal(error.details.object, key)
    const source = createMetaSheetMultitableWriteSource({ system, context })
    await expectError(source.insertRows('mt', key, BATCH, { keyFields: ['code'] }), { status: 501, code: CODES.PROBE_UNWIRED, surface: 'c6_insert_rows' })
    await expectError(source.updateRows('mt', key, BATCH, { keyFields: ['code'] }), { status: 501, code: CODES.PROBE_UNWIRED, surface: 'c6_update_rows' })
    await expectError(source.test('mt', 'owner-1'), { status: 501, code: CODES.PROBE_UNWIRED, surface: 'c6_target_test' })
    assert.deepEqual(calls, [], `${key}: nothing reached the host`)
  }
  // Outside the namespace and without a probe: today's behaviour (A-03's legacy leg writes).
  const { context, rows } = createContext()
  const plain = await createMetaSheetMultitableTargetAdapter({ system: createSystem({ approved_materials: objectConfig() }), context }).upsert({ object: 'approved_materials', records: BATCH })
  assert.equal(plain.written, 3)
  assert.equal(rows.length, 3)
})

test('A-05 a read-only system sheet that is also governed: the host read-only refusal keeps precedence (probe not asked); without the host read-only probe the governance refusal stands alone', async () => {
  const readOnly = createContext({ existing: EXISTING, readOnlySheets: [SHEET] })
  const probe = scriptedProbe(() => governedAnswer('pilot'))
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: readOnly.context, governedSheetProbe: probe })
  const error = await expectError(adapter.upsert({ object: 'approved_materials', records: BATCH }), { code: adapterLib.METASHEET_MULTITABLE_SYSTEM_SHEET_READ_ONLY })
  assert.ok(error instanceof MultitableSystemSheetWriteError)
  assert.equal(probe.calls.length, 0, 'the read-only refusal came first')
  assert.deepEqual(readOnly.calls.map(([name]) => name), ['isReadOnlySystemSheet'])
  // A host that answers "not read-only": the governance refusal follows the host probe.
  const ordinary = createContext({ existing: EXISTING, readOnlySheets: [] })
  await expectError(createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: ordinary.context, governedSheetProbe: probe }).upsert({ object: 'approved_materials', records: BATCH }), { status: 409, code: CODES.REFUSED, reason: 'pilot' })
  assert.deepEqual(ordinary.calls.map(([name]) => name), ['isReadOnlySystemSheet'])
  // No host read-only probe at all: the governance refusal alone.
  const older = createContext({ existing: EXISTING })
  await expectError(createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: older.context, governedSheetProbe: probe }).upsert({ object: 'approved_materials', records: BATCH }), { status: 409, code: CODES.REFUSED })
  assert.deepEqual(older.calls, [])
})

// ── A-06 / A-07 / A-08 (C6) ──────────────────────────────────────────────────────────────────────

test('A-06 C6 test(): governed => the 409 (c6_target_test); through dryRunExternalWrite no token, no source read, zero records IO; second of two objects governed => refused; not governed => byte-identical capability answer and the plan proceeds', async () => {
  const governed = createContext({ existing: EXISTING })
  const probe = scriptedProbe(() => governedAnswer('state'))
  const source = createMetaSheetMultitableWriteSource({ system: createSystem(), context: governed.context, governedSheetProbe: probe })
  await expectError(source.test('mt', 'owner-1'), { status: 409, code: CODES.REFUSED, surface: 'c6_target_test', reason: 'state' })
  const tokenStore = memoryStore()
  const input = c6Input({ writeSource: createMetaSheetMultitableWriteSource({ system: createSystem(), context: governed.context, governedSheetProbe: probe }), tokenStore })
  await expectError(dryRunExternalWrite(input), { status: 409, code: CODES.REFUSED, surface: 'c6_target_test' })
  assert.equal(tokenStore.map.size, 0, 'no dry-run token minted')
  assert.equal(input.sourceAdapter.reads, 0, 'no source read')
  assert.deepEqual(governed.calls, [], 'no lookupByKey, no records IO')

  // Two objects, only the SECOND governed: test() is not told which object the plan writes — refused.
  const two = createContext({ existing: EXISTING })
  const second = scriptedProbe(({ sheetId }) => (sheetId === OTHER_SHEET ? governedAnswer('execution') : NOT_GOVERNED))
  const both = createMetaSheetMultitableWriteSource({ system: createSystem({ approved_materials: objectConfig(), audit_copy: objectConfig(OTHER_SHEET) }), context: two.context, governedSheetProbe: second })
  const refusal = await expectError(both.test('mt', 'owner-1'), { status: 409, code: CODES.REFUSED, reason: 'execution' })
  assert.equal(refusal.details.object, 'audit_copy')
  assert.deepEqual(second.calls.map((call) => call.sheetId), [SHEET, OTHER_SHEET])

  // Not governed: the capability answer is the probe-less one, and the full dry-run is identical.
  const plainCtx = createContext({ existing: EXISTING })
  const probedCtx = createContext({ existing: EXISTING })
  const legacySource = createMetaSheetMultitableWriteSource({ system: createSystem(), context: plainCtx.context })
  const okProbe = scriptedProbe()
  const probedSource = createMetaSheetMultitableWriteSource({ system: createSystem(), context: probedCtx.context, governedSheetProbe: okProbe })
  assert.deepEqual(await probedSource.test('mt', 'owner-1'), await legacySource.test('mt', 'owner-1'))
  assert.deepEqual(await probedSource.test('mt', 'owner-1'), { success: true, capabilityState: { ownSheetTarget: true, externalWrite: false } })
  const legacyDry = await dryRunExternalWrite(c6Input({ writeSource: legacySource, tokenStore: memoryStore() }))
  const probedDry = await dryRunExternalWrite(c6Input({ writeSource: probedSource, tokenStore: memoryStore() }))
  assert.equal(probedDry.status, 'ready')
  const strip = (dry) => ({ ...dry, dryRunToken: dry.dryRunToken ? 'minted' : null, evidence: { ...dry.evidence, dryRunToken: undefined } })
  assert.deepEqual(strip(probedDry), strip(legacyDry), 'dry-run identical (bar the random token)')
  assert.deepEqual(probedCtx.calls, plainCtx.calls, 'records IO identical')
  assert.equal(okProbe.calls.length, 1, 'one probe per object for the instance (test() x3 + the plan)')
})

test('A-07 C6 apply: governed between dry-run and apply => the re-plan test() refuses 409, the token is BURNED, zero writes; defence in depth — a test() that skips the probe meets the refusal in insertRows: every row carries the REGISTERED code, a dead letter per row, zero writes', async () => {
  const ctx = createContext({ existing: EXISTING })
  let governedNow = false
  const probe = scriptedProbe(() => (governedNow ? governedAnswer('hold') : NOT_GOVERNED))
  const tokenStore = memoryStore()
  // Dry-run request: its own write-source (the routes build one per request).
  const dry = await dryRunExternalWrite(c6Input({ writeSource: createMetaSheetMultitableWriteSource({ system: createSystem(), context: ctx.context, governedSheetProbe: probe }), tokenStore }))
  assert.equal(dry.status, 'ready')
  assert.equal(tokenStore.map.size, 1)
  const ioBefore = recordIo(ctx.calls).length
  governedNow = true
  // Apply request: a FRESH write-source (its cache is empty, so it probes again).
  const applyInput = { ...c6Input({ writeSource: createMetaSheetMultitableWriteSource({ system: createSystem(), context: ctx.context, governedSheetProbe: probe }), tokenStore }), dryRunToken: dry.dryRunToken, applyUser: 'owner-1', runId: 'run_mgs_apply' }
  await expectError(applyExternalWrite(applyInput), { status: 409, code: CODES.REFUSED, surface: 'c6_target_test', reason: 'hold' })
  assert.equal(tokenStore.map.size, 0, 'the token was consumed before the re-plan (burned; a re-preview answers 409 and mints nothing)')
  assert.equal(recordIo(ctx.calls).filter(([name]) => name !== 'queryRecords').length, 0, 'no createRecord / patchRecord')
  assert.equal(recordIo(ctx.calls).length, ioBefore, 'not even a lookup after the refusal')

  // Defence in depth: `test()` skipped (a write-source whose test does not probe), the sheet governed at the rows.
  const defence = createContext({ existing: EXISTING })
  let rowGoverned = false
  const rowProbe = scriptedProbe(() => (rowGoverned ? governedAnswer('continuation') : NOT_GOVERNED))
  const store = memoryStore()
  const dry2 = await dryRunExternalWrite(c6Input({ writeSource: createMetaSheetMultitableWriteSource({ system: createSystem(), context: defence.context, governedSheetProbe: rowProbe }), tokenStore: store }))
  assert.equal(dry2.counts.add + dry2.counts.update, 3)
  rowGoverned = true
  const real = createMetaSheetMultitableWriteSource({ system: createSystem(), context: defence.context, governedSheetProbe: rowProbe })
  const skipTest = { ...real, async test() { return { success: true, capabilityState: { ownSheetTarget: true, externalWrite: false } } } }
  const deadLetters = []
  const writesBefore = defence.calls.filter(([name]) => name === 'createRecord' || name === 'patchRecord').length
  const result = await applyExternalWrite({
    ...c6Input({ writeSource: skipTest, tokenStore: store, deadLetterStore: { async createDeadLetter(letter) { deadLetters.push(letter); return { id: `dl_${deadLetters.length}` } } } }),
    dryRunToken: dry2.dryRunToken, applyUser: 'owner-1', runId: 'run_mgs_defence',
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.counts.failed, 3)
  assert.equal(result.counts.written, 0)
  assert.deepEqual(result.rowErrors.map((entry) => entry.errorCode), [CODES.REFUSED, CODES.REFUSED, CODES.REFUSED], 'the registered code, not WRITE_FAILED')
  assert.equal(result.deadLetters.attempted, 3)
  assert.equal(deadLetters.length, 3)
  assert.equal(defence.calls.filter(([name]) => name === 'createRecord' || name === 'patchRecord').length, writesBefore, 'zero writes')
})

test('A-08 insertRows / updateRows called directly: refused before queryRecords and any write; lookupByKey (a read) is not probed', async () => {
  const { context, calls } = createContext({ existing: EXISTING })
  const probe = scriptedProbe(() => governedAnswer('pilot'))
  const source = createMetaSheetMultitableWriteSource({ system: createSystem(), context, governedSheetProbe: probe })
  const lookup = await source.lookupByKey('mt', 'approved_materials', { code: 'MGS-002' }, { keyFields: ['code'] }, 'owner-1')
  assert.equal(lookup.data.length, 1)
  assert.equal(probe.calls.length, 0, 'a read is not probed')
  const before = calls.length
  await expectError(source.insertRows('mt', 'approved_materials', BATCH, { keyFields: ['code'] }), { status: 409, code: CODES.REFUSED, surface: 'c6_insert_rows' })
  await expectError(source.updateRows('mt', 'approved_materials', BATCH, { keyFields: ['code'] }), { status: 409, code: CODES.REFUSED, surface: 'c6_update_rows' })
  assert.equal(calls.length, before, 'no field-map resolve, no ownership read, no lookup, no write')
  assert.equal(probe.calls.length, 1, 'one probe for the instance; the governed answer is reused')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('metasheet-multitable-governed-sheet.test.cjs', tests)
