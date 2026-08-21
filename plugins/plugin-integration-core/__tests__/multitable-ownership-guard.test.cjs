'use strict'

// ---------------------------------------------------------------------------
// Ownership write-guard for the GENERIC metasheet:multitable target adapter.
//
// The thing under test is a safety property, so most assertions are about what did
// NOT happen: which columns never appeared in a patch/create payload, which writes
// were never attempted, and - just as load-bearing - that a sheet WITHOUT ownership
// metadata still produces byte-identical payloads, so every pre-existing pipeline is
// untouched.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createMetaSheetMultitableTargetAdapter,
  createMetaSheetMultitableWriteSource,
  MultitableOwnershipGuardError,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const {
  createMultitableOwnershipGuard,
  OWNERSHIP_GUARD_UNVERIFIED,
  OWNERSHIP_GUARD_PROTECTED_KEY_FIELD,
  __internals: guardInternals,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'multitable-ownership-guard.cjs'))

const PROJECT_ID = 'default:integration-core'
const SHEET_ID = 'sheet_stock_prep_landing'

// property blobs exactly as the two provisioning modules write them
const plmOwned = { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: false, key: false } }
const humanOwned = { stockPreparation: { ownership: 'human_preserved', preserveOnRefresh: true, required: false, key: false } }
// ownership says plm_system, but the field is pinned against refresh - preserveOnRefresh ALONE protects
const pinnedOnly = { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: true } }
// MVP namespace
const mvpHumanOwned = { stockPreparationMvp: { role: 'main', ownership: 'human_preserved', preserveOnRefresh: false } }
// the customer-pack installer writes the CANONICAL namespace plus pack keys
const packHumanOwned = {
  stockPreparation: { ownership: 'human_preserved', preserveOnRefresh: true, extension: true, packId: 'pack_a', packVersion: '1' },
}

/**
 * @param fields  {logicalFieldId: propertyBlob} - the sheet's ownership metadata. `null` means
 *                the host exposes NO readObjectFieldsContent at all (legacy construction).
 */
function createContext({ existing = [], fields = null, readFields = null, includeProvisioning = true } = {}) {
  const rows = existing.map((row) => ({ ...row, data: { ...row.data } }))
  const calls = []
  const warnings = []
  const multitable = {
    records: {
      async queryRecords(input) {
        calls.push(['queryRecords', JSON.parse(JSON.stringify(input))])
        return rows
          .filter((row) => Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value))
          .slice(0, input.limit || 1000)
      },
      async createRecord(input) {
        calls.push(['createRecord', JSON.parse(JSON.stringify(input))])
        const row = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
        rows.push(row)
        return row
      },
      async patchRecord(input) {
        calls.push(['patchRecord', JSON.parse(JSON.stringify(input))])
        const row = rows.find((item) => item.id === input.recordId && item.sheetId === input.sheetId)
        if (!row) throw new Error(`record not found: ${input.recordId}`)
        row.version += 1
        row.data = { ...row.data, ...input.changes }
        return row
      },
    },
  }
  if (includeProvisioning && (fields || readFields)) {
    multitable.provisioning = {
      async readObjectFieldsContent(input) {
        calls.push(['readObjectFieldsContent', { projectId: input.projectId, objectId: input.objectId, fieldIds: [...input.fieldIds].sort() }])
        if (readFields) return readFields(input)
        const out = {}
        for (const fieldId of input.fieldIds) {
          if (!Object.prototype.hasOwnProperty.call(fields, fieldId)) continue
          out[fieldId] = { name: fieldId, type: 'string', property: fields[fieldId], order: 1 }
        }
        return out
      },
    }
  }
  return {
    calls,
    rows,
    warnings,
    context: {
      logger: { warn: (message) => warnings.push(message) },
      api: { multitable },
    },
  }
}

function createSystem({ projectId = PROJECT_ID, keyFields = ['code'], fieldIds = ['code', 'quantity', 'humanNote'] } = {}) {
  return {
    id: 'metasheet_stock_prep_target',
    name: 'Stock preparation landing',
    kind: 'metasheet:multitable',
    role: 'target',
    config: {
      ...(projectId ? { projectId } : {}),
      objects: {
        stock_prep_landing: {
          name: 'Stock preparation landing',
          sheetId: SHEET_ID,
          keyFields,
          fieldDetails: fieldIds.map((id) => ({ id, name: id, type: 'string' })),
        },
      },
    },
  }
}

function writeCalls(calls) {
  return calls.filter(([name]) => name === 'createRecord' || name === 'patchRecord')
}

// --------------------------------------------------------------------------
// 1. protected field stripped on PATCH and on CREATE
// --------------------------------------------------------------------------
async function testProtectedFieldStrippedOnPatchAndCreate() {
  const harness = createContext({
    existing: [{ id: 'rec_existing', sheetId: SHEET_ID, version: 3, data: { code: 'MAT-001', quantity: 1, humanNote: 'keep me' } }],
    fields: { code: plmOwned, quantity: plmOwned, humanNote: humanOwned },
  })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })

  const result = await adapter.upsert({
    object: 'stock_prep_landing',
    records: [
      { code: 'MAT-001', quantity: 9, humanNote: 'PIPELINE CLOBBER' }, // existing -> patch
      { code: 'MAT-002', quantity: 4, humanNote: 'PIPELINE CLOBBER' }, // new -> create
    ],
  })

  assert.equal(result.written, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)

  const patch = harness.calls.find(([name]) => name === 'patchRecord')
  assert.deepEqual(patch[1].changes, { code: 'MAT-001', quantity: 9 }, 'human-owned column stripped from the patch payload')
  const create = harness.calls.find(([name]) => name === 'createRecord')
  assert.deepEqual(create[1].data, { code: 'MAT-002', quantity: 4 }, 'human-owned column stripped from the create payload')

  assert.equal(harness.rows.find((row) => row.id === 'rec_existing').data.humanNote, 'keep me', 'the human value survived the refresh')
  assert.equal(JSON.stringify(harness.calls).includes('PIPELINE CLOBBER'), false, 'the protected value never reached the records API')

  assert.deepEqual(result.metadata.ownershipGuard, {
    guardActive: true,
    protectedFieldsStripped: 2,
    rowsSkippedEmptyAfterStrip: 0,
  })
  assert.equal(JSON.stringify(result.metadata.ownershipGuard).includes('humanNote'), false, 'the summary is counts only, values-free')
}

// --------------------------------------------------------------------------
// 2. preserveOnRefresh ALONE protects (ownership stays plm_system)
// --------------------------------------------------------------------------
async function testPreserveOnRefreshAloneProtects() {
  const harness = createContext({
    existing: [{ id: 'rec_pin', sheetId: SHEET_ID, version: 1, data: { code: 'MAT-100', quantity: 1, humanNote: 'x' } }],
    fields: { code: plmOwned, quantity: pinnedOnly, humanNote: plmOwned },
  })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })
  const result = await adapter.upsert({
    object: 'stock_prep_landing',
    records: [{ code: 'MAT-100', quantity: 77, humanNote: 'refreshed' }],
  })
  assert.equal(result.written, 1)
  const patch = harness.calls.find(([name]) => name === 'patchRecord')
  assert.deepEqual(
    patch[1].changes,
    { code: 'MAT-100', humanNote: 'refreshed' },
    'preserveOnRefresh:true protects even when ownership says plm_system',
  )
  assert.equal(harness.rows[0].data.quantity, 1, 'the pinned value was not overwritten')
}

// --------------------------------------------------------------------------
// 3. BOTH property namespaces honored (+ the customer-pack extension shape)
// --------------------------------------------------------------------------
async function testBothNamespacesHonored() {
  const harness = createContext({
    existing: [],
    fields: { code: plmOwned, quantity: mvpHumanOwned, humanNote: packHumanOwned },
  })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })
  await adapter.upsert({
    object: 'stock_prep_landing',
    records: [{ code: 'MAT-200', quantity: 5, humanNote: 'note' }],
  })
  const create = harness.calls.find(([name]) => name === 'createRecord')
  assert.deepEqual(
    create[1].data,
    { code: 'MAT-200' },
    'stockPreparationMvp and the customer-pack stockPreparation extension shape both protect',
  )

  // and the predicate itself, directly
  assert.equal(guardInternals.isProtectedFieldProperty(humanOwned), true)
  assert.equal(guardInternals.isProtectedFieldProperty(mvpHumanOwned), true)
  assert.equal(guardInternals.isProtectedFieldProperty(pinnedOnly), true)
  assert.equal(guardInternals.isProtectedFieldProperty(packHumanOwned), true)
  assert.equal(guardInternals.isProtectedFieldProperty(plmOwned), false)
  assert.equal(guardInternals.isProtectedFieldProperty({}), false)
  assert.equal(guardInternals.isProtectedFieldProperty(null), false)
  assert.equal(
    guardInternals.isProtectedFieldProperty({ someOtherPlugin: { ownership: 'human_preserved' } }),
    false,
    'an unrecognised namespace does not protect - the guard honors exactly the two known ones',
  )
}

// --------------------------------------------------------------------------
// 4. a sheet with NO ownership metadata is byte-identical to the pre-guard adapter
// --------------------------------------------------------------------------
async function testPlainSheetPayloadsAreByteIdentical() {
  const seed = () => [{ id: 'rec_plain', sheetId: SHEET_ID, version: 1, data: { code: 'MAT-001', quantity: 1, humanNote: 'a' } }]
  const records = [
    { code: 'MAT-001', quantity: 2, humanNote: 'b' },
    { code: 'MAT-003', quantity: 3, humanNote: 'c' },
  ]

  // reader PRESENT, every field plain (no ownership property at all)
  const tagged = createContext({ existing: seed(), fields: { code: {}, quantity: {}, humanNote: {} } })
  const withReader = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: tagged.context })
  const guardedResult = await withReader.upsert({ object: 'stock_prep_landing', records })

  // reader ABSENT (legacy construction) - the pre-guard behavior
  const legacy = createContext({ existing: seed(), fields: null })
  const withoutReader = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: legacy.context })
  const legacyResult = await withoutReader.upsert({ object: 'stock_prep_landing', records })

  assert.equal(
    JSON.stringify(writeCalls(tagged.calls)),
    JSON.stringify(writeCalls(legacy.calls)),
    'an untagged sheet produces byte-identical write payloads with and without the guard',
  )
  assert.deepEqual(writeCalls(tagged.calls)[0][1].changes, { code: 'MAT-001', quantity: 2, humanNote: 'b' })
  assert.equal(guardedResult.written, 2)
  assert.equal(guardedResult.skipped, 0)
  assert.equal(legacyResult.written, 2)
  assert.deepEqual(guardedResult.metadata.ownershipGuard, {
    guardActive: true,
    protectedFieldsStripped: 0,
    rowsSkippedEmptyAfterStrip: 0,
  })
}

// --------------------------------------------------------------------------
// 5. reader ABSENT -> passthrough + exactly one values-free warn per run
// --------------------------------------------------------------------------
async function testAbsentReaderPassesThroughAndWarnsOnce() {
  const harness = createContext({ existing: [], fields: null })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })
  const result = await adapter.upsert({
    object: 'stock_prep_landing',
    records: [
      { code: 'MAT-A', quantity: 1, humanNote: 'kept' },
      { code: 'MAT-B', quantity: 2, humanNote: 'kept' },
    ],
  })
  assert.equal(result.written, 2)
  assert.deepEqual(harness.calls.find(([name]) => name === 'createRecord')[1].data, { code: 'MAT-A', quantity: 1, humanNote: 'kept' })
  assert.deepEqual(result.metadata.ownershipGuard, {
    guardActive: false,
    protectedFieldsStripped: 0,
    rowsSkippedEmptyAfterStrip: 0,
  })
  assert.equal(harness.warnings.length, 1, 'warned exactly once for the run, not once per row')
  assert.match(harness.warnings[0], /ownership guard inactive: no fields reader/)
  assert.equal(harness.warnings[0].includes(SHEET_ID), false, 'the warning is values-free')

  // a second batch on the SAME adapter (same run) does not re-warn
  await adapter.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-C', quantity: 3 }] })
  assert.equal(harness.warnings.length, 1)

  // a target with no projectId cannot key the reader - same warn-and-passthrough posture
  const noProject = createContext({ existing: [], fields: { code: plmOwned, humanNote: humanOwned } })
  const noProjectAdapter = createMetaSheetMultitableTargetAdapter({
    system: createSystem({ projectId: null }),
    context: noProject.context,
  })
  const noProjectResult = await noProjectAdapter.upsert({
    object: 'stock_prep_landing',
    records: [{ code: 'MAT-D', quantity: 1, humanNote: 'kept' }],
  })
  assert.equal(noProjectResult.metadata.ownershipGuard.guardActive, false)
  assert.deepEqual(noProject.calls.find(([name]) => name === 'createRecord')[1].data, { code: 'MAT-D', quantity: 1, humanNote: 'kept' })
  assert.match(noProject.warnings[0], /ownership guard inactive: target object has no projectId/)
  assert.equal(noProject.calls.some(([name]) => name === 'readObjectFieldsContent'), false, 'no reader call without a projectId')
}

// --------------------------------------------------------------------------
// 6. reader THROWS -> typed refusal, and NOTHING is written
// --------------------------------------------------------------------------
async function testReaderFailureIsATypedRefusal() {
  const harness = createContext({
    existing: [{ id: 'rec_x', sheetId: SHEET_ID, version: 1, data: { code: 'MAT-001', quantity: 1, humanNote: 'keep me' } }],
    readFields: () => { throw new Error('meta_fields read failed for host db-01 user svc_pipeline') },
  })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })

  await assert.rejects(
    () => adapter.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-001', quantity: 9, humanNote: 'clobber' }] }),
    (error) => {
      assert.ok(error instanceof MultitableOwnershipGuardError, 'refusal is the typed guard error')
      assert.equal(error.name, 'MultitableOwnershipGuardError')
      assert.equal(error.code, OWNERSHIP_GUARD_UNVERIFIED)
      assert.equal(error.details.reason, 'fields_read_failed')
      // the underlying cause is deliberately non-enumerable so a serialized evidence blob
      // cannot leak whatever the host put in the read failure message
      assert.equal(JSON.stringify(error.details).includes('db-01'), false)
      assert.equal(Object.keys(error).includes('cause'), false, 'cause is non-enumerable')
      return true
    },
  )
  assert.equal(writeCalls(harness.calls).length, 0, 'an unverifiable ownership state refuses BEFORE any write')
  assert.equal(harness.rows[0].data.humanNote, 'keep me')

  // a malformed (non-object) metadata response is the same refusal, not a silent passthrough
  const malformed = createContext({ existing: [], readFields: () => 'not-an-object' })
  const malformedAdapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: malformed.context })
  await assert.rejects(
    () => malformedAdapter.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-9', quantity: 1 }] }),
    (error) => error.code === OWNERSHIP_GUARD_UNVERIFIED && error.details.reason === 'fields_read_malformed',
  )
  assert.equal(writeCalls(malformed.calls).length, 0)
}

// --------------------------------------------------------------------------
// 7. a payload that is EMPTY only because of stripping is skipped, not failed
// --------------------------------------------------------------------------
async function testEmptyAfterStripIsSkipped() {
  const harness = createContext({
    existing: [{ id: 'rec_only_human', sheetId: SHEET_ID, version: 1, data: { code: 'MAT-001', humanNote: 'mine' } }],
    fields: { code: plmOwned, humanNote: humanOwned, quantity: humanOwned },
  })
  const adapter = createMetaSheetMultitableTargetAdapter({
    // no keyFields -> append mode, so the row is a bare create whose every field is protected
    system: createSystem({ keyFields: [], fieldIds: ['humanNote', 'quantity'] }),
    context: harness.context,
  })
  const result = await adapter.upsert({
    object: 'stock_prep_landing',
    records: [
      { humanNote: 'clobber', quantity: 1 }, // everything protected -> nothing left to write
      { humanNote: 'clobber', quantity: 2 },
    ],
  })
  assert.equal(writeCalls(harness.calls).length, 0, 'no write attempted for a fully-stripped row')
  assert.equal(result.skipped, 2)
  assert.equal(result.written, 0)
  assert.equal(result.failed, 0, 'a skip is not an error')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].status, 'skipped')
  // the runner reconciles written+skipped+failed against the row count
  assert.equal(result.written + result.skipped + result.failed, 2)
  assert.deepEqual(result.metadata.ownershipGuard, {
    guardActive: true,
    protectedFieldsStripped: 4,
    rowsSkippedEmptyAfterStrip: 2,
  })
}

// --------------------------------------------------------------------------
// 8. the field-property map is read ONCE per (run, target sheet), not per row
// --------------------------------------------------------------------------
async function testFieldMetadataReadIsCachedPerRun() {
  const harness = createContext({ existing: [], fields: { code: plmOwned, quantity: plmOwned, humanNote: humanOwned } })
  const adapter = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })
  const records = Array.from({ length: 25 }, (_, i) => ({ code: `MAT-${i}`, quantity: i, humanNote: 'clobber' }))

  await adapter.upsert({ object: 'stock_prep_landing', records })
  const reads = harness.calls.filter(([name]) => name === 'readObjectFieldsContent')
  assert.equal(reads.length, 1, '25 rows, one ownership metadata read')
  assert.deepEqual(reads[0][1], {
    projectId: PROJECT_ID,
    objectId: 'stock_prep_landing',
    fieldIds: ['code', 'humanNote', 'quantity'],
  }, 'the reader is asked only about the fields the batch is about to write')

  // a second batch in the same run reuses the cache
  await adapter.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-Z', quantity: 1, humanNote: 'clobber' }] })
  assert.equal(harness.calls.filter(([name]) => name === 'readObjectFieldsContent').length, 1, 'cache spans the run')
  assert.equal(JSON.stringify(harness.calls).includes('clobber'), false)

  // a NEW adapter is a new run and reads again
  const next = createMetaSheetMultitableTargetAdapter({ system: createSystem(), context: harness.context })
  await next.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-Y', quantity: 1 }] })
  assert.equal(harness.calls.filter(([name]) => name === 'readObjectFieldsContent').length, 2, 'a new run re-reads')
}

// --------------------------------------------------------------------------
// 9. the BULK C6 write-source paths are guarded too
// --------------------------------------------------------------------------
async function testBulkWriteSourcePathsAreGuarded() {
  const harness = createContext({
    existing: [{ id: 'rec_bulk', sheetId: SHEET_ID, version: 1, data: { code: 'MAT-001', quantity: 1, humanNote: 'mine' } }],
    fields: { code: plmOwned, quantity: plmOwned, humanNote: humanOwned },
  })
  const writeSource = createMetaSheetMultitableWriteSource({ system: createSystem(), context: harness.context })

  await writeSource.insertRows('mt', 'stock_prep_landing', [{ code: 'MAT-500', quantity: 5, humanNote: 'clobber' }], {}, 'owner')
  assert.deepEqual(
    harness.calls.find(([name]) => name === 'createRecord')[1].data,
    { code: 'MAT-500', quantity: 5 },
    'insertRows strips the human-owned column',
  )

  const updated = await writeSource.updateRows(
    'mt',
    'stock_prep_landing',
    [{ code: 'MAT-001', quantity: 42, humanNote: 'clobber' }],
    { keyFields: ['code'] },
    'owner',
  )
  assert.equal(updated.rowCount, 1)
  assert.deepEqual(
    harness.calls.find(([name]) => name === 'patchRecord')[1].changes,
    { code: 'MAT-001', quantity: 42 },
    'updateRows strips the human-owned column',
  )
  assert.equal(harness.rows.find((row) => row.id === 'rec_bulk').data.humanNote, 'mine')
  assert.equal(JSON.stringify(harness.calls).includes('clobber'), false)

  // one read for BOTH bulk calls - the guard cache is per write-source instance
  assert.equal(harness.calls.filter(([name]) => name === 'readObjectFieldsContent').length, 1)
  assert.deepEqual(writeSource.ownershipGuardSummary(), {
    guardActive: true,
    protectedFieldsStripped: 2,
    rowsSkippedEmptyAfterStrip: 0,
  })

  // fully-stripped bulk rows are skipped, never written, and never looked up
  const humanOnly = createContext({ existing: [], fields: { humanNote: humanOwned } })
  const humanOnlySource = createMetaSheetMultitableWriteSource({
    system: createSystem({ keyFields: ['humanNote'], fieldIds: ['humanNote'] }),
    context: humanOnly.context,
  })
  const inserted = await humanOnlySource.insertRows('mt', 'stock_prep_landing', [{ humanNote: 'clobber' }], {}, 'owner')
  assert.deepEqual(inserted.data, [], 'nothing inserted when the whole row is protected')
  assert.equal(writeCalls(humanOnly.calls).length, 0)

  // and a bulk reader failure refuses the same way the row path does
  const failing = createContext({ existing: [], readFields: () => { throw new Error('read failed') } })
  const failingSource = createMetaSheetMultitableWriteSource({ system: createSystem(), context: failing.context })
  await assert.rejects(
    () => failingSource.insertRows('mt', 'stock_prep_landing', [{ code: 'MAT-1', quantity: 1 }], {}, 'owner'),
    (error) => error instanceof MultitableOwnershipGuardError && error.code === OWNERSHIP_GUARD_UNVERIFIED,
  )
  assert.equal(writeCalls(failing.calls).length, 0)
}

// --------------------------------------------------------------------------
// 10. a protected KEY field is a refusal, not a strip
// --------------------------------------------------------------------------
async function testProtectedKeyFieldRefuses() {
  const harness = createContext({ existing: [], fields: { code: humanOwned, quantity: plmOwned } })
  const adapter = createMetaSheetMultitableTargetAdapter({
    system: createSystem({ keyFields: ['code'], fieldIds: ['code', 'quantity'] }),
    context: harness.context,
  })
  await assert.rejects(
    () => adapter.upsert({ object: 'stock_prep_landing', records: [{ code: 'MAT-001', quantity: 1 }] }),
    (error) => {
      assert.ok(error instanceof MultitableOwnershipGuardError)
      assert.equal(error.code, OWNERSHIP_GUARD_PROTECTED_KEY_FIELD)
      assert.deepEqual(error.details.fields, ['code'])
      return true
    },
  )
  // stripping the key instead would have created a keyless row, and the next refresh would
  // have missed it on lookup and created a duplicate - so this refuses rather than degrades.
  assert.equal(writeCalls(harness.calls).length, 0)
}

// --------------------------------------------------------------------------
// 11. guard module surface, exercised without the adapter
// --------------------------------------------------------------------------
async function testGuardModuleSurface() {
  const reads = []
  const guard = createMultitableOwnershipGuard({
    logger: { warn: () => {} },
    fieldsReader: async ({ fieldIds }) => {
      reads.push([...fieldIds].sort())
      return { humanNote: { name: 'humanNote', type: 'string', property: humanOwned, order: 1 } }
    },
  })
  const objectConfig = { objectId: 'obj', projectId: PROJECT_ID }

  const shield = await guard.forObject(objectConfig, ['code', 'humanNote'])
  assert.equal(shield.active, true)
  assert.equal(shield.isProtected('humanNote'), true)
  assert.equal(shield.isProtected('code'), false, 'a field the reader did not return carries no ownership tag')

  const payload = { code: 'A', quantity: 1 }
  const untouched = shield.strip(payload)
  assert.equal(untouched.data, payload, 'nothing protected -> the very same object, no copy')
  assert.equal(untouched.stripped, 0)
  assert.equal(untouched.skip, false)

  const alreadyEmpty = shield.strip({})
  assert.equal(alreadyEmpty.skip, false, 'a payload that was ALREADY empty keeps its pre-guard behavior')

  const stripped = shield.strip({ code: 'A', humanNote: 'x' })
  assert.deepEqual(stripped.data, { code: 'A' })
  assert.equal(stripped.stripped, 1)
  assert.equal(stripped.skip, false)

  // asking again for an already-inspected field set issues no second read
  await guard.forObject(objectConfig, ['code', 'humanNote'])
  assert.equal(reads.length, 1)
  // a NEW field is fetched incrementally, and only the new one
  await guard.forObject(objectConfig, ['code', 'humanNote', 'extra'])
  assert.deepEqual(reads[1], ['extra'])

  assert.deepEqual(guard.summary(), { guardActive: true, protectedFieldsStripped: 1, rowsSkippedEmptyAfterStrip: 0 })

  // concurrent resolution of the same field set must not double-read
  const parallelReads = []
  const parallelGuard = createMultitableOwnershipGuard({
    logger: { warn: () => {} },
    fieldsReader: async ({ fieldIds }) => {
      parallelReads.push([...fieldIds])
      return {}
    },
  })
  await Promise.all([
    parallelGuard.forObject(objectConfig, ['a', 'b']),
    parallelGuard.forObject(objectConfig, ['a', 'b']),
    parallelGuard.forObject(objectConfig, ['a', 'b']),
  ])
  assert.equal(parallelReads.length, 1, 'concurrent callers share one read')

  // resolveFieldsReader only accepts the real host surface
  assert.equal(guardInternals.resolveFieldsReader(undefined), null)
  assert.equal(guardInternals.resolveFieldsReader({ api: { multitable: { provisioning: {} } } }), null)
  assert.equal(
    typeof guardInternals.resolveFieldsReader({ api: { multitable: { provisioning: { readObjectFieldsContent: () => ({}) } } } }),
    'function',
  )
}

async function main() {
  await testProtectedFieldStrippedOnPatchAndCreate()
  await testPreserveOnRefreshAloneProtects()
  await testBothNamespacesHonored()
  await testPlainSheetPayloadsAreByteIdentical()
  await testAbsentReaderPassesThroughAndWarnsOnce()
  await testReaderFailureIsATypedRefusal()
  await testEmptyAfterStripIsSkipped()
  await testFieldMetadataReadIsCachedPerRun()
  await testBulkWriteSourcePathsAreGuarded()
  await testProtectedKeyFieldRefuses()
  await testGuardModuleSurface()
  console.log('✓ multitable-ownership-guard: generic target adapter ownership write-guard tests passed')
}

main().catch((err) => {
  console.error('✗ multitable-ownership-guard FAILED')
  console.error(err)
  process.exit(1)
})
