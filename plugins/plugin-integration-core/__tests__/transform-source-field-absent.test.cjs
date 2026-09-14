'use strict'

// ---------------------------------------------------------------------------
// X02: "the source record does not carry this field" is not "the source emptied
// this field".
//
// Before this suite's fix, a mapping whose sourceField was absent from a record
// resolved to `undefined`, was written to the target anyway, and blanked a
// column that held a correct value - with no error, rowsFailed still 0, and the
// watermark advancing. These tests pin the three dispositions apart:
//
//   absent path            -> target field LEFT UNWRITTEN + SOURCE_FIELD_ABSENT
//   path present, null/''  -> written, exactly as before (a real clearing)
//   defaultValue configured -> default applied, exactly as before
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  SOURCE_FIELD_ABSENT,
  getPath,
  resolveSourcePath,
  transformValue,
  transformRecord,
  __internals: { absentSourceLookupKey },
} = require(path.join(__dirname, '..', 'lib', 'transform-engine.cjs'))
const { validateRecord } = require(path.join(__dirname, '..', 'lib', 'validator.cjs'))
const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
const {
  createMetaSheetMultitableTargetAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-multitable-target-adapter.cjs'))
// The REGISTRY's own mapping factories. Every run-level fixture that matters is built with
// these rather than with object literals: the two shapes differ by exactly one key
// (`defaultValue`), and that difference is what made the first version of this guard inert.
const {
  __internals: { normalizeFieldMappings, rowToFieldMapping },
} = require(path.join(__dirname, '..', 'lib', 'pipelines.cjs'))
const {
  applyExternalWrite,
  dryRunExternalWrite,
} = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))

function ownKeys(object) {
  return Object.keys(object).sort()
}

function warningCodes(result) {
  return (result.warnings || []).map((warning) => warning.code)
}

// --- 1. absent source path: nothing is written, and the fact is reported -----
function testAbsentSourcePathLeavesTargetUnwritten() {
  const mappings = [
    { sourceField: 'code', targetField: 'FNumber' },
    { sourceField: 'spec', targetField: 'FSpec' },
  ]

  const result = transformRecord({ code: 'MAT-001' }, mappings)

  assert.equal(result.ok, true, 'an absent source field is reported, not failed')
  assert.deepEqual(result.errors, [], 'absence is not a transform error')
  assert.deepEqual(ownKeys(result.value), ['FNumber'], 'FSpec must not appear in the payload at all')
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.value, 'FSpec'),
    false,
    'the key must be ABSENT, not present-holding-undefined: a present key is what patches the target to blank',
  )
  assert.deepEqual(result.warnings, [{
    field: 'FSpec',
    sourceField: 'spec',
    index: 1,
    code: 'SOURCE_FIELD_ABSENT',
    message: 'source field is absent from this record; target field left unwritten',
    details: {},
  }])
  assert.equal(SOURCE_FIELD_ABSENT, 'SOURCE_FIELD_ABSENT')

  // Values-free: the notice carries the two CONFIGURED identifiers and nothing else.
  const serialized = JSON.stringify(result.warnings)
  assert.equal(serialized.includes('MAT-001'), false, 'the notice must never carry a source value')

  // Nested + array paths behave the same, and the skipped write must not even
  // create the parent container.
  const nested = transformRecord({ head: {} }, [
    { sourceField: 'head.code', targetField: 'body.FNumber' },
    { sourceField: 'lines[].qty', targetField: 'FChildItems[].FQty' },
    { sourceField: 'head.rev', targetField: 'body.FRev' },
  ])
  assert.deepEqual(nested.value, {}, 'no parent object/array is materialised for a skipped write')
  assert.deepEqual(warningCodes(nested), [
    'SOURCE_FIELD_ABSENT',
    'SOURCE_FIELD_ABSENT',
    'SOURCE_FIELD_ABSENT',
  ])

  // An array that exists but is empty has no element 0 to read -> absent.
  const emptyArray = transformRecord({ lines: [] }, [{ sourceField: 'lines[].qty', targetField: 'FQty' }])
  assert.deepEqual(emptyArray.value, {})
  assert.deepEqual(warningCodes(emptyArray), ['SOURCE_FIELD_ABSENT'])
}

// --- 2. present-but-empty is UNCHANGED: the source really did clear it -------
function testPresentButEmptyStillWrites() {
  const cases = [
    { record: { spec: null }, expected: null, label: 'null' },
    { record: { spec: '' }, expected: '', label: 'empty string' },
    { record: { spec: 0 }, expected: 0, label: 'zero' },
    { record: { spec: false }, expected: false, label: 'false' },
    { record: { spec: undefined }, expected: undefined, label: 'own key holding undefined' },
  ]
  for (const { record, expected, label } of cases) {
    const result = transformRecord(record, [{ sourceField: 'spec', targetField: 'FSpec' }])
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.value, 'FSpec'),
      true,
      `${label}: the path EXISTS, so the clearing must still be written`,
    )
    assert.equal(result.value.FSpec, expected, `${label}: value is written unchanged`)
    assert.deepEqual(result.warnings, [], `${label}: an existing path is never reported absent`)
  }

  // Nested + array forms of "present but empty".
  const nested = transformRecord({ head: { code: null }, lines: [{ qty: '' }] }, [
    { sourceField: 'head.code', targetField: 'FNumber' },
    { sourceField: 'lines[].qty', targetField: 'FQty' },
  ])
  assert.deepEqual(nested.value, { FNumber: null, FQty: '' })
  assert.deepEqual(nested.warnings, [])
}

// --- 3. defaultValue and value-producing transforms keep their precedence ----
function testDefaultsAndTransformsStillProduceValues() {
  const withDefault = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', defaultValue: 'UNKNOWN' },
  ])
  assert.deepEqual(withDefault.value, { FSpec: 'UNKNOWN' }, 'mapping defaultValue still fills an absent field')
  assert.deepEqual(withDefault.warnings, [], 'a filled default is not a silent blanking, so nothing is reported')

  // A BLANK defaultValue is covered by its own case below (testBlankDefaultValueIsUnset): it is
  // the registry's encoding of "unset", not an operator-supplied value.

  // A transform chain that manufactures a value out of nothing still writes it.
  const manufactured = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', transform: { fn: 'defaultValue', value: 'FALLBACK' } },
    { sourceField: 'status', targetField: 'FStatus', transform: { fn: 'dictMap', map: {}, defaultValue: 'unknown' } },
    { sourceField: 'first', targetField: 'FKey', transform: { fn: 'concat', values: ['LITERAL'], separator: '|' } },
  ])
  assert.deepEqual(manufactured.value, { FSpec: 'FALLBACK', FStatus: 'unknown', FKey: 'LITERAL' })
  assert.deepEqual(manufactured.warnings, [], 'a transform-produced value is a real value, not an absence')

  // A transform chain that passes the nothing through DOES skip.
  const passthrough = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', transform: ['trim', 'upper'] },
    { sourceField: 'qty', targetField: 'FQty', transform: 'toNumber' },
  ])
  assert.deepEqual(passthrough.value, {})
  assert.deepEqual(warningCodes(passthrough), ['SOURCE_FIELD_ABSENT', 'SOURCE_FIELD_ABSENT'])
}

// --- 3b. a BLANK defaultValue is "unset", not an operator-supplied value -----
// The registry puts a `defaultValue` key on EVERY mapping it hands back (`pipelines.cjs:318`
// reads a SQL NULL column as `null`; `pipelines.cjs:201` collapses an undefined one into `null`),
// so "the key is present" cannot mean "the operator supplied a default".
function testBlankDefaultValueIsUnset() {
  for (const blankDefault of [null, undefined]) {
    const blanked = transformRecord({}, [
      { sourceField: 'spec', targetField: 'FSpec', defaultValue: blankDefault },
    ])
    assert.equal(
      Object.prototype.hasOwnProperty.call(blanked.value, 'FSpec'),
      false,
      `defaultValue: ${String(blankDefault)} is the registry's encoding of "unset", not a supplied value`,
    )
    assert.deepEqual(warningCodes(blanked), ['SOURCE_FIELD_ABSENT'])
  }

  // An empty-string default IS a value an operator can type and JSON can carry, so it still writes.
  const emptyDefault = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', defaultValue: '' },
  ])
  assert.deepEqual(emptyDefault.value, { FSpec: '' })
  assert.deepEqual(emptyDefault.warnings, [])

  // The VALUE precedence for a path that EXISTS is untouched, blank default included: a present
  // but blank source value still collapses to the configured default exactly as before.
  assert.deepEqual(
    transformRecord({ spec: '' }, [{ sourceField: 'spec', targetField: 'FSpec', defaultValue: null }]).value,
    { FSpec: null },
    'present-but-blank + defaultValue: null still writes null',
  )
  assert.deepEqual(
    transformRecord({ spec: null }, [{ sourceField: 'spec', targetField: 'FSpec', defaultValue: 'X' }]).value,
    { FSpec: 'X' },
    'present-but-blank + a real default still takes the default',
  )
}

// --- 3c. a concat with NOTHING to join produces nothing, and nothing is written
// #5628 left this as a pinned residual: `concat` filtered its blank parts and join()ed them, so a
// concat whose every part was absent returned '' rather than undefined, the third no-write
// condition (`outputValue === undefined`) read that '' as "the chain produced a value", and the
// manufactured empty string was written over a correct target value with NO warning. It is now
// closed at the source (`transform-engine.cjs` `concat`): join() of zero SUPPLIED parts produces
// nothing instead of ''.
//
// "Supplied" is PRESENCE, not non-blankness, and the whole short circuit is fenced to the one
// branch that would otherwise blank a target (the mapping's own path absent AND no default). Both
// halves are pinned below, because widening either of them would stop writing values a chain was
// explicitly asked to manufacture - `{fn:'defaultValue', value:''}` and `{fn:'concat',
// values:['']}` - which is the one thing this line of work refuses to do.
async function testAllAbsentConcatWritesNothing() {
  // 1. Nothing supplied -> nothing written, and the absence is REPORTED (it used to be silent).
  const nothingSupplied = [
    { label: 'bare concat', transform: { fn: 'concat' } },
    { label: 'every field absent', transform: { fn: 'concat', fields: ['colour', 'shade'], separator: '-' } },
    { label: 'includeCurrent:false and no parts', transform: { fn: 'concat', includeCurrent: false } },
    { label: 'empty fields/values arrays', transform: { fn: 'concat', fields: [], values: [] } },
    { label: 'concat then upper', transform: [{ fn: 'concat' }, { fn: 'upper' }] },
    { label: 'concat then trim', transform: [{ fn: 'concat' }, { fn: 'trim' }] },
    { label: 'concat then toNumber', transform: [{ fn: 'concat' }, { fn: 'toNumber' }] },
    { label: 'trim then concat', transform: [{ fn: 'trim' }, { fn: 'concat' }] },
  ]
  for (const { label, transform } of nothingSupplied) {
    // The registry shape (`defaultValue: null`) is the one every stored pipeline actually has.
    for (const extra of [{}, { defaultValue: null }, { defaultValue: undefined }]) {
      const result = transformRecord({ code: 'MAT-001' }, [
        { sourceField: 'code', targetField: 'FNumber' },
        { sourceField: 'spec', targetField: 'FSpec', transform, ...extra },
      ])
      assert.deepEqual(
        ownKeys(result.value),
        ['FNumber'],
        `${label}: a concat with nothing to join must not manufacture a value over the target`,
      )
      assert.equal(
        Object.prototype.hasOwnProperty.call(result.value, 'FSpec'),
        false,
        `${label}: the key must be ABSENT, not present-holding-''`,
      )
      assert.deepEqual(warningCodes(result), ['SOURCE_FIELD_ABSENT'], `${label}: and the absence is reported`)
      assert.equal(result.ok, true, `${label}: an absence is still not a failure`)
    }
  }

  // 2. POSITIVE CONTROLS - one supplied part is enough, and it still joins exactly as before.
  const stillWrites = [
    { label: 'literal', record: {}, transform: { fn: 'concat', values: ['LITERAL'], separator: '|' }, expected: 'LITERAL' },
    { label: 'EMPTY literal', record: {}, transform: { fn: 'concat', values: [''] }, expected: '' },
    { label: 'one of two fields present', record: { colour: 'RED' }, transform: { fn: 'concat', fields: ['colour', 'shade'], separator: '-' }, expected: 'RED' },
    { label: 'both fields present', record: { colour: 'RED', shade: 'DARK' }, transform: { fn: 'concat', fields: ['colour', 'shade'], separator: '-' }, expected: 'RED-DARK' },
    // Presence, not non-blankness: the record DOES carry `colour`, it is just empty. The join
    // still runs and still filters the blank out, so the answer is '' and it is still written.
    { label: 'field present holding ""', record: { colour: '' }, transform: { fn: 'concat', fields: ['colour'], separator: '-' }, expected: '' },
    { label: 'field present holding null', record: { colour: null }, transform: { fn: 'concat', fields: ['colour'], separator: '-' }, expected: '' },
    { label: 'field present holding 0', record: { colour: 0 }, transform: { fn: 'concat', fields: ['colour'], separator: '-' }, expected: '0' },
    { label: 'concat then a defaultValue', record: {}, transform: [{ fn: 'concat' }, { fn: 'defaultValue', args: { value: 'D' } }], expected: 'D' },
    // The pre-change chain handed a later dictMap the '' that concat used to return; that LOOKUP
    // KEY is kept alive, so a dictionary answer that fires today keeps firing.
    { label: 'concat then a dictMap keyed on ""', record: {}, transform: [{ fn: 'concat' }, { fn: 'dictMap', args: { map: { '': 'EMPTY' } } }], expected: 'EMPTY' },
    { label: 'a defaultValue then concat', record: {}, transform: [{ fn: 'defaultValue', args: { value: 'D' } }, { fn: 'concat' }], expected: 'D' },
  ]
  for (const { label, record, transform, expected } of stillWrites) {
    for (const extra of [{}, { defaultValue: null }]) {
      const result = transformRecord(record, [{ sourceField: 'spec', targetField: 'FSpec', transform, ...extra }])
      assert.deepEqual(result.value, { FSpec: expected }, `${label}: a supplied part still produces its join`)
      assert.deepEqual(result.warnings, [], `${label}: a produced value is not an absence`)
    }
  }

  // 3. The mapping's own path EXISTS -> the source spoke, and '' is its answer. Untouched.
  for (const record of [{ spec: '' }, { spec: null }, { spec: undefined }]) {
    const result = transformRecord(record, [{ sourceField: 'spec', targetField: 'FSpec', transform: { fn: 'concat' } }])
    assert.deepEqual(
      result.value,
      { FSpec: '' },
      `${JSON.stringify(record)}: a path that EXISTS is the source clearing the value, written as before`,
    )
    assert.deepEqual(result.warnings, [])
  }
  // A real default supplies the part, so there is something to join.
  assert.deepEqual(
    transformRecord({}, [{ sourceField: 'spec', targetField: 'FSpec', defaultValue: 'X', transform: { fn: 'concat' } }]).value,
    { FSpec: 'X' },
  )

  // 4. The third no-write condition was NOT widened to isBlank(): a chain explicitly asked for an
  //    empty string still writes one. (This is why the fix belongs in `concat`, not in the gate.)
  const deliberateEmpty = transformRecord({}, [
    { sourceField: 'spec', targetField: 'T', transform: { fn: 'defaultValue', value: '' } },
  ])
  assert.deepEqual(deliberateEmpty.value, { T: '' }, 'a chain asked for an empty string still writes one')
  assert.deepEqual(deliberateEmpty.warnings, [])

  // 5. NO CONTEXT, NO SHORT CIRCUIT. The exported transformValue() - every caller outside
  //    transformRecord() - keeps getting '' for the same arguments.
  assert.equal(transformValue(undefined, { fn: 'concat' }), '', 'transformValue() with no context is unchanged')
  assert.equal(transformValue(undefined, { fn: 'concat', includeCurrent: false }), '')
  assert.equal(transformValue('A', { fn: 'concat', values: ['B'], separator: '-' }), 'A-B')

  // 6. END TO END through the runner and the real multitable adapter: the stored value survives.
  const harness = createHarness({
    fieldMappings: [
      { id: 'fm1', pipeline_id: 'pipe_x02', source_field: 'code', target_field: 'code', transform: null, validation: null, default_value: null, sort_order: 0, created_at: null },
      { id: 'fm2', pipeline_id: 'pipe_x02', source_field: 'name', target_field: 'name', transform: JSON.stringify({ fn: 'concat', args: { fields: ['nickname'], separator: '-' } }), validation: null, default_value: null, sort_order: 1, created_at: null },
      { id: 'fm3', pipeline_id: 'pipe_x02', source_field: 'quantity', target_field: 'quantity', transform: null, validation: null, default_value: null, sort_order: 2, created_at: null },
    ].map(rowToFieldMapping),
    multitableRows: [{ id: 'rec_existing', sheetId: 'sheet_approved_materials', version: 1, data: { code: 'MAT-001', name: 'Correct bolt', quantity: 7 } }],
    sourceRecords: [{ code: 'MAT-001', quantity: 9, updatedAt: '2026-09-10T00:00:00.000Z' }],
  })
  const runResult = await harness.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
  assert.equal(runResult.metrics.rowsFailed, 0)
  assert.equal(
    harness.storedRows[0].data.name,
    'Correct bolt',
    'an all-absent concat must not blank the stored value through the runner either',
  )
  assert.equal(harness.storedRows[0].data.quantity, 9, 'the column the source did carry is still written')
  const runRow = harness.db.tables.get('integration_runs')[0]
  assert.deepEqual(runRow.details.sourceFieldAbsent, {
    code: 'SOURCE_FIELD_ABSENT',
    rows: 1,
    fields: [{ sourceField: 'name', targetField: 'name' }],
  }, 'and the run reports it instead of losing it')
}

// --- 3e. a dictMap that answers the PRE-CHANGE lookup key still writes --------
// Reviewer correction to this cut: "no non-empty write is lost" was false for one shape. The
// pre-change engine never handed the chain `undefined` for an absent path - the value fill-in
// handed it `mapping.defaultValue`, i.e. `null` for every registry-stored mapping - so a
// dictionary carrying a "null" key really did fire and really did write `UNKNOWN`. Reproduced on
// 919582e71 vs 0a35028d9: `{dictMap: {"null": "UNKNOWN"}}` + an absent source went from `UNKNOWN`
// to nothing at all. The fix restores the LOOKUP KEY for dictMap alone; these assertions pin both
// halves - the dictionary answer is written again, and everything else still is not.
function testDictMapNullKeyStillAnswersAbsentSource() {
  const absent = { code: 'MAT-001', quantity: 9 } // the record simply does not carry `name`
  const dictRow = (map) => rowToFieldMapping({
    id: 'fm_dict',
    pipeline_id: 'pipe_x02',
    source_field: 'name',
    target_field: 'name',
    transform: JSON.stringify({ fn: 'dictMap', args: { map } }),
    validation: null,
    default_value: null,
    sort_order: 0,
    created_at: null,
  })

  // 1. The REGISTRY's own factories, with the dictionary stored as JSON (a JSON object key is a
  //    string, so "null" is exactly what an operator can store and exactly what used to fire).
  const stored = dictRow({ null: 'UNKNOWN' })
  assert.equal(stored.defaultValue, null, 'the stored mapping still carries the registry-encoded unset default')
  const viaStored = transformRecord(absent, [stored])
  assert.deepEqual(viaStored.value, { name: 'UNKNOWN' }, 'the dictionary answer for an absent source is still written')
  assert.deepEqual(viaStored.warnings, [], 'a dictionary answer is a produced value, not an absence')
  const viaNormalize = normalizeFieldMappings([{
    sourceField: 'name',
    targetField: 'name',
    transform: { fn: 'dictMap', args: { map: { null: 'UNKNOWN' } } },
    sortOrder: 0,
  }])
  assert.deepEqual(transformRecord(absent, viaNormalize).value, { name: 'UNKNOWN' }, 'same through the write-side entry point')

  // 2. The key is consulted wherever the chain still carries the nothing, because the steps in
  //    front of dictMap passed `null` through before this cut and pass `undefined` through now.
  const chains = [
    [[{ fn: 'trim' }, { fn: 'dictMap', args: { map: { null: 'UNKNOWN' } } }], 'UNKNOWN'],
    [[{ fn: 'upper' }, { fn: 'dictMap', args: { map: { null: 'UNKNOWN' } } }], 'UNKNOWN'],
    [[{ fn: 'dictMap', args: { map: { null: 'unknown' } } }, { fn: 'upper' }], 'UNKNOWN'],
  ]
  for (const [transform, expected] of chains) {
    const result = transformRecord(absent, [{ ...stored, transform }])
    assert.deepEqual(result.value, { name: expected }, `chain ${JSON.stringify(transform)} still produces its answer`)
    assert.deepEqual(result.warnings, [])
  }

  // 3. A MISS still writes nothing: the key is swapped, the VALUE flowing down the chain is not,
  //    so `outputValue === undefined` still holds. (Pre-change this wrote `null` - a blank.)
  const miss = transformRecord(absent, [dictRow({ A: 'a' })])
  assert.equal(
    Object.prototype.hasOwnProperty.call(miss.value, 'name'),
    false,
    'a dictionary with no answer still leaves the target alone',
  )
  assert.deepEqual(warningCodes(miss), ['SOURCE_FIELD_ABSENT'])

  // 4. NO GLOBAL NORMALISATION. Only dictMap consults the key; every other step still passes the
  //    nothing through and the target still goes unwritten. If `undefined` were normalised to
  //    `null` for the whole chain, each of these would start writing `null` again - the exact
  //    blanking this cut removes.
  for (const transform of ['trim', 'upper', 'lower', 'toNumber', 'toDate']) {
    const result = transformRecord(absent, [{ ...stored, transform }])
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.value, 'name'),
      false,
      `${transform} must still pass the nothing through and leave the target unwritten`,
    )
    assert.deepEqual(warningCodes(result), ['SOURCE_FIELD_ABSENT'])
  }

  // 5. The key follows what THIS MAPPING would have fed the chain, not a blanket "null". A mapping
  //    with no defaultValue key at all fed `undefined` before this cut, so a "null" entry must NOT
  //    fire for it - otherwise the fix would start writing values 919582e71 never wrote.
  const noDefaultKey = {
    sourceField: 'name',
    targetField: 'name',
    transform: { fn: 'dictMap', args: { map: { null: 'UNKNOWN' } } },
  }
  assert.equal(Object.prototype.hasOwnProperty.call(noDefaultKey, 'defaultValue'), false)
  assert.deepEqual(
    transformRecord(absent, [noDefaultKey]).value,
    {},
    'a "null" entry does not fire for a mapping that never fed null',
  )
  assert.deepEqual(warningCodes(transformRecord(absent, [noDefaultKey])), ['SOURCE_FIELD_ABSENT'])
  const undefKeyMap = { ...noDefaultKey, transform: { fn: 'dictMap', args: { map: { undefined: 'FROM_UNDEF' } } } }
  assert.deepEqual(
    transformRecord(absent, [undefKeyMap]).value,
    { name: 'FROM_UNDEF' },
    'and the key it DID feed still fires',
  )
  // Both entries present: the stored mapping fed `null`, so the "null" entry wins - which is the
  // answer 919582e71 gives.
  const bothKeys = transformRecord(absent, [dictRow({ null: 'FROM_NULL', undefined: 'FROM_UNDEF' })])
  assert.deepEqual(bothKeys.value, { name: 'FROM_NULL' })

  // 6. Neighbours unchanged: a present-but-null source still maps, the dictMap fallback still wins
  //    on a miss, and a real mapping default still pre-empts the dictionary.
  assert.deepEqual(transformRecord({ name: null }, [stored]).value, { name: 'UNKNOWN' }, 'present-but-null is unchanged')
  assert.deepEqual(
    transformRecord(absent, [{ ...stored, transform: { fn: 'dictMap', args: { map: { A: 'a' }, defaultValue: 'FB' } } }]).value,
    { name: 'FB' },
    'the dictMap fallback still wins on a miss',
  )
  assert.deepEqual(
    transformRecord(absent, [{ ...stored, defaultValue: 'D' }]).value,
    { name: 'D' },
    'a real mapping default still pre-empts the dictionary, exactly as before',
  )

  // 7. The key itself is the string the pre-change engine would have looked up.
  assert.equal(absentSourceLookupKey({ defaultValue: null }), 'null')
  assert.equal(absentSourceLookupKey({ defaultValue: undefined }), 'undefined')
  assert.equal(absentSourceLookupKey({}), 'undefined')
}

// --- 3d. an empty array SEGMENT is absent - decided, not accidental -----------
// `tags[]` names element 0 of `tags`; an empty array has no element 0, so there is nothing to
// read (`transform-engine.cjs:74-77`). The rejected alternative (`found: true, value: undefined`)
// would not clear the target either - it would write `undefined`, i.e. exactly the blanking this
// cut removes - so it buys nothing and reopens the hole. A source that wants to clear a repeating
// target field maps the ARRAY, which does exist and is written as [].
function testEmptyArraySegmentIsAbsentByDecision() {
  assert.deepEqual(resolveSourcePath({ tags: [] }, 'tags[]'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ tags: [] }, 'tags'), { found: true, value: [] })

  const viaElement = transformRecord({ tags: [] }, [{ sourceField: 'tags[]', targetField: 'FTag' }])
  assert.deepEqual(viaElement.value, {}, 'element-0 of an empty array is absent, so nothing is written')
  assert.deepEqual(warningCodes(viaElement), ['SOURCE_FIELD_ABSENT'])

  const viaArray = transformRecord({ tags: [] }, [{ sourceField: 'tags', targetField: 'FTags' }])
  assert.deepEqual(viaArray.value, { FTags: [] }, 'mapping the array itself DOES clear the target to []')
  assert.deepEqual(viaArray.warnings, [])
}

// --- 4. the skip branch does not bypass the existing guards ------------------
function testSkipDoesNotBypassGuards() {
  // An unsafe targetField must keep failing even when its source field is absent
  // (before, setPath() was what raised it; skipping the write must not skip it).
  for (const targetField of ['__proto__', 'a.constructor.b', 'x.prototype']) {
    const result = transformRecord({}, [{ sourceField: 'absent', targetField }])
    assert.equal(result.ok, false, `${targetField}: unsafe target path still fails`)
    assert.equal(result.errors[0].code, 'TRANSFORM_FAILED')
    assert.equal(result.errors[0].message, 'targetField contains an unsafe path segment')
    assert.deepEqual(result.warnings, [], 'a refused mapping is not reported as an absence')
  }

  // `required` keeps its meaning: an unwritten target field reads back as empty
  // to the validator, exactly as the written-undefined did.
  const mappings = [{ sourceField: 'spec', targetField: 'FSpec', validation: [{ type: 'required' }] }]
  const transformed = transformRecord({}, mappings)
  assert.equal(transformed.ok, true)
  const validation = validateRecord(transformed.value, mappings)
  assert.equal(validation.ok, false, 'required still rejects a record whose source lacked the field')
  assert.equal(validation.errors[0].code, 'REQUIRED')

  // A mapping with no sourceField at all is the pre-existing "constant mapping"
  // shape; it must keep behaving as it did (nothing found, nothing produced).
  const noSource = transformRecord({ a: 1 }, [{ targetField: 'FSpec' }])
  assert.deepEqual(noSource.value, {})
  assert.deepEqual(warningCodes(noSource), ['SOURCE_FIELD_ABSENT'])
  assert.equal(noSource.warnings[0].sourceField, undefined)
}

// --- 5. resolveSourcePath cannot drift from getPath's VALUE ------------------
function testResolveSourcePathValueParityWithGetPath() {
  const records = [
    {},
    { a: 1 },
    { a: null },
    { a: undefined },
    { a: '' },
    { a: 0 },
    { a: { b: 2 } },
    { a: { b: null } },
    { a: 'hello' },
    { a: 5 },
    { a: [] },
    { a: [{ b: 3 }] },
    { a: [undefined] },
    { a: { b: [{ c: 4 }] } },
  ]
  const paths = [
    'a', 'a.b', 'a.b.c', 'a[]', 'a[].b', 'a.b[]', 'a.b[].c',
    'a.length', 'a.0', 'missing', 'missing.deep', '__proto__', 'a.__proto__',
  ]
  let checked = 0
  for (const record of records) {
    for (const p of paths) {
      const viaGetPath = getPath(record, p)
      const resolved = resolveSourcePath(record, p)
      assert.equal(
        Object.is(resolved.value, viaGetPath),
        true,
        `resolveSourcePath(${JSON.stringify(record)}, '${p}').value must equal getPath()'s answer`,
      )
      checked += 1
    }
  }
  assert.equal(checked, records.length * paths.length)
  assert.equal(checked, 182)

  // found is the NEW information, and it is what separates the two dispositions.
  assert.deepEqual(resolveSourcePath({ a: undefined }, 'a'), { found: true, value: undefined })
  assert.deepEqual(resolveSourcePath({}, 'a'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: {} }, 'a.b'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: { b: null } }, 'a.b'), { found: true, value: null })
  assert.deepEqual(resolveSourcePath(null, 'a'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: 1 }, ''), { found: false, value: undefined })
}

// --- 6. the target patch really does preserve the old value ------------------
// The point of not writing the key: the multitable target patches with the keys
// it is handed, so an omitted key leaves the stored value alone.
async function testTargetPatchPreservesExistingValue() {
  const rows = [{
    id: 'rec_existing',
    sheetId: 'sheet_approved_materials',
    version: 1,
    data: { code: 'MAT-001', name: 'Correct bolt', quantity: 7 },
  }]
  const context = {
    api: {
      multitable: {
        records: {
          async queryRecords(input) {
            return rows.filter((row) => Object.entries(input.filters || {})
              .every(([field, value]) => row.data[field] === value)).slice(0, input.limit || 10)
          },
          async createRecord(input) {
            const row = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
            rows.push(row)
            return row
          },
          async patchRecord(input) {
            const row = rows.find((item) => item.id === input.recordId)
            row.version += 1
            row.data = { ...row.data, ...input.changes }
            return row
          },
        },
      },
    },
  }
  const adapter = createMetaSheetMultitableTargetAdapter({
    system: {
      id: 'metasheet_target_project_1',
      name: 'MetaSheet target',
      kind: 'metasheet:multitable',
      role: 'target',
      config: {
        objects: {
          approved_materials: {
            name: 'Approved Materials',
            sheetId: 'sheet_approved_materials',
            keyFields: ['code'],
            fieldDetails: [
              { id: 'code', name: 'Code', type: 'string' },
              { id: 'name', name: 'Name', type: 'string' },
              { id: 'quantity', name: 'Quantity', type: 'number' },
            ],
          },
        },
      },
    },
    context,
  })

  const mappings = [
    { sourceField: 'code', targetField: 'code' },
    { sourceField: 'name', targetField: 'name' },
    { sourceField: 'quantity', targetField: 'quantity' },
  ]
  // The source row for this pull simply does not carry `name` (a column that was
  // renamed away, or a projection that dropped it).
  const transformed = transformRecord({ code: 'MAT-001', quantity: 9 }, mappings)
  assert.deepEqual(warningCodes(transformed), ['SOURCE_FIELD_ABSENT'])

  await adapter.upsert({
    object: 'approved_materials',
    records: [transformed.value],
    keyFields: ['code'],
  })

  assert.equal(rows.length, 1, 'the existing row was updated, not duplicated')
  assert.equal(rows[0].data.name, 'Correct bolt', 'the absent source column must NOT blank the stored value')
  assert.equal(rows[0].data.quantity, 9, 'the columns the source did carry are still written')
}

// --- 7. run-level visibility: count + field identifiers in run details -------
function createMockDb() {
  const tables = new Map([
    ['integration_dead_letters', []],
    ['integration_watermarks', []],
    ['integration_runs', []],
  ])
  function rowsOf(table) {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }
  function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }
  return {
    tables,
    async selectOne(table, where) { return rowsOf(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) {
      const stored = { ...row, created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:00.000Z' }
      rowsOf(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rowsOf(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-09-11T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) { return rowsOf(table).filter((row) => matches(row, options.where || {})) },
  }
}

// `multitableRows`, when given, swaps the collect-only mock target for the REAL
// metasheet:multitable target adapter over a stub records API, so "the target keeps its existing
// value" is observed on a STORED row rather than on a collected payload.
function createHarness({ sourceRecords, fieldMappings, multitableRows }) {
  const db = createMockDb()
  const writtenRecords = []
  const storedRows = (multitableRows || []).map((row) => ({ ...row, data: { ...row.data } }))
  const useMultitable = Array.isArray(multitableRows)
  const pipeline = {
    id: 'pipe_x02',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: 'target_1',
    targetObject: useMultitable ? 'approved_materials' : 'BD_MATERIAL',
    mode: 'incremental',
    status: 'active',
    idempotencyKeyFields: ['code'],
    options: { batchSize: 100, watermark: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'code' } },
    fieldMappings,
  }
  let nextRun = 1
  const pipelineRegistry = {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      await db.insertOne('integration_runs', {
        id,
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        pipeline_id: input.pipelineId,
        status: input.status,
        details: input.details || {},
      })
      return {
        id,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        pipelineId: input.pipelineId,
        status: input.status,
        details: input.details || {},
      }
    },
    async updatePipelineRun(input) {
      const updated = await db.updateRow('integration_runs', {
        status: input.status,
        rows_read: input.rowsRead,
        rows_cleaned: input.rowsCleaned,
        rows_written: input.rowsWritten,
        rows_failed: input.rowsFailed,
        details: input.details || {},
      }, { tenant_id: input.tenantId, workspace_id: input.workspaceId ?? null, id: input.id })
      const row = updated[0]
      return {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id ?? null,
        pipelineId: row.pipeline_id,
        status: row.status,
        rowsRead: row.rows_read,
        rowsCleaned: row.rows_cleaned,
        rowsWritten: row.rows_written,
        rowsFailed: row.rows_failed,
        details: row.details,
      }
    },
  }
  const multitableTargetSystem = {
    id: 'target_1',
    name: 'MetaSheet target',
    kind: 'metasheet:multitable',
    role: 'target',
    config: {
      objects: {
        approved_materials: {
          name: 'Approved Materials',
          sheetId: 'sheet_approved_materials',
          keyFields: ['code'],
          fieldDetails: [
            { id: 'code', name: 'Code', type: 'string' },
            { id: 'name', name: 'Name', type: 'string' },
            { id: 'quantity', name: 'Quantity', type: 'number' },
          ],
        },
      },
    },
  }
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'PLM mock', kind: 'mock-source', role: 'source', config: {} }],
    ['target_1', useMultitable
      ? multitableTargetSystem
      : { id: 'target_1', name: 'ERP mock', kind: 'mock-target', role: 'target', config: {} }],
  ])
  const multitableContext = {
    api: {
      multitable: {
        records: {
          async queryRecords(input) {
            return storedRows.filter((row) => Object.entries(input.filters || {})
              .every(([field, value]) => row.data[field] === value)).slice(0, input.limit || 10)
          },
          async createRecord(input) {
            const row = { id: `rec_${storedRows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
            storedRows.push(row)
            return row
          },
          async patchRecord(input) {
            const row = storedRows.find((item) => item.id === input.recordId)
            row.version += 1
            row.data = { ...row.data, ...input.changes }
            return row
          },
        },
      },
    },
  }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', ({ system }) => ({
      system,
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'materials' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: sourceRecords.slice() }) },
      async upsert() { throw new Error('source upsert should not be called') },
    }))
    .registerAdapter('mock-target', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'BD_MATERIAL' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async upsert(input) {
        writtenRecords.push(...input.records)
        return createUpsertResult({ written: input.records.length, skipped: 0, results: [] })
      },
    }))
    .registerAdapter('metasheet:multitable', ({ system }) => createMetaSheetMultitableTargetAdapter({
      system,
      context: multitableContext,
    }))
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry: {
      async getExternalSystem(input) { return systems.get(input.id) },
      async getExternalSystemForAdapter(input) {
        const system = systems.get(input.id)
        return system ? { ...system, credentials: { bearerToken: `${system.id}-token` } } : null
      },
    },
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    clock: (() => { let tick = 0; return () => tick++ * 25 })(),
  })
  return { db, pipeline, runner, writtenRecords, storedRows }
}

async function testRunReportsAbsenceWithCountAndFieldNames() {
  const fieldMappings = [
    { sourceField: 'code', targetField: 'FNumber' },
    { sourceField: 'spec', targetField: 'FSpec' },
    { sourceField: 'colour', targetField: 'FColour' },
  ]
  const { db, runner, writtenRecords } = createHarness({
    fieldMappings,
    sourceRecords: [
      { code: 'MAT-001', spec: 'S1', colour: 'red', updatedAt: '2026-09-10T00:00:00.000Z' },
      { code: 'MAT-002', colour: 'blue', updatedAt: '2026-09-10T01:00:00.000Z' },
      { code: 'MAT-003', updatedAt: '2026-09-10T02:00:00.000Z' },
    ],
  })

  const result = await runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })

  assert.equal(result.metrics.rowsRead, 3)
  assert.equal(result.metrics.rowsFailed, 0, 'absence is not a row failure')
  assert.equal(result.metrics.rowsWritten, 3)

  // The written payloads simply lack the columns the source did not carry.
  assert.deepEqual(ownKeys(writtenRecords[0]), ['FColour', 'FNumber', 'FSpec', '_integration_idempotency_key'])
  assert.deepEqual(ownKeys(writtenRecords[1]), ['FColour', 'FNumber', '_integration_idempotency_key'])
  assert.deepEqual(ownKeys(writtenRecords[2]), ['FNumber', '_integration_idempotency_key'])

  const runRow = db.tables.get('integration_runs')[0]
  assert.deepEqual(runRow.details.sourceFieldAbsent, {
    code: 'SOURCE_FIELD_ABSENT',
    rows: 2,
    fields: [
      { sourceField: 'colour', targetField: 'FColour' },
      { sourceField: 'spec', targetField: 'FSpec' },
    ],
  }, 'run details carry the COUNT of affected rows and the configured field identifiers')

  // Values-free: no source value, no row content, reaches the run record.
  const serialized = JSON.stringify(runRow.details)
  for (const value of ['MAT-001', 'MAT-002', 'MAT-003', 'red', 'blue', 'S1']) {
    assert.equal(serialized.includes(value), false, `run details must not carry the source value ${value}`)
  }

  // Documented, deliberately UNCHANGED in this change: the run still succeeds and
  // the watermark still advances after a SOURCE_FIELD_ABSENT. See the design doc.
  assert.equal(runRow.status, 'succeeded')
  const watermarkRow = db.tables.get('integration_watermarks')[0]
  assert.equal(watermarkRow.watermark_value, '2026-09-10T02:00:00.000Z', 'watermark semantics are untouched by this change')
}

async function testCleanRunCarriesNoAbsenceDetail() {
  const { db } = await (async () => {
    const harness = createHarness({
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber' },
        { sourceField: 'spec', targetField: 'FSpec' },
      ],
      sourceRecords: [{ code: 'MAT-001', spec: null, updatedAt: '2026-09-10T00:00:00.000Z' }],
    })
    await harness.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
    return harness
  })()
  const runRow = db.tables.get('integration_runs')[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(runRow.details, 'sourceFieldAbsent'),
    false,
    'a run where every mapped path existed carries no absence detail at all',
  )
}

// --- 9. the PRODUCTION mapping shape, built by the registry's own functions ----
// Load-bearing: every other run-level case here hands the runner hand-written literals, and a
// literal is a shape the registry NEVER produces. `rowToFieldMapping()` (`pipelines.cjs:310-322`)
// and `normalizeFieldMappings()` (`pipelines.cjs:181-205`) both put a `defaultValue` key on every
// mapping - null for an unset default - so a no-write gate that asked only whether the KEY existed
// was unreachable on every stored pipeline while this whole suite stayed green. This case is the
// one that can tell the two shapes apart.
async function testStoredMappingShapeIsNotBlanked() {
  const mappingRows = [
    { id: 'fm1', pipeline_id: 'pipe_x02', source_field: 'code', target_field: 'code', transform: null, validation: null, default_value: null, sort_order: 0, created_at: null },
    { id: 'fm2', pipeline_id: 'pipe_x02', source_field: 'name', target_field: 'name', transform: null, validation: null, default_value: null, sort_order: 1, created_at: null },
    { id: 'fm3', pipeline_id: 'pipe_x02', source_field: 'quantity', target_field: 'quantity', transform: null, validation: null, default_value: null, sort_order: 2, created_at: null },
  ]
  const fieldMappings = mappingRows.map(rowToFieldMapping)

  // The shape itself is part of the assertion: if the registry ever stops emitting the key, this
  // case must notice, because the gate's meaning depends on it.
  assert.deepEqual(
    fieldMappings.map((mapping) => [
      mapping.sourceField,
      Object.prototype.hasOwnProperty.call(mapping, 'defaultValue'),
      mapping.defaultValue,
    ]),
    [['code', true, null], ['name', true, null], ['quantity', true, null]],
    'rowToFieldMapping() emits defaultValue on EVERY mapping; a SQL NULL column reads back as null',
  )
  const viaNormalize = normalizeFieldMappings([{ sourceField: 'name', targetField: 'name', sortOrder: 0 }])
  assert.equal(Object.prototype.hasOwnProperty.call(viaNormalize[0], 'defaultValue'), true)
  assert.equal(viaNormalize[0].defaultValue, null, 'the write-side entry point collapses undefined to that same null')

  const { db, runner, storedRows } = createHarness({
    fieldMappings,
    multitableRows: [{
      id: 'rec_existing',
      sheetId: 'sheet_approved_materials',
      version: 1,
      data: { code: 'MAT-001', name: 'Correct bolt', quantity: 7 },
    }],
    sourceRecords: [{ code: 'MAT-001', quantity: 9, updatedAt: '2026-09-10T00:00:00.000Z' }],
  })

  const result = await runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })

  assert.equal(result.metrics.rowsFailed, 0, 'absence is not a row failure')
  assert.equal(storedRows.length, 1, 'the existing row was updated, not duplicated')
  assert.equal(storedRows[0].data.name, 'Correct bolt', 'a REGISTRY-SHAPED mapping must not blank the stored value either')
  assert.equal(storedRows[0].data.quantity, 9, 'the column the source did carry is still written')

  const runRow = db.tables.get('integration_runs')[0]
  assert.equal(runRow.details.sourceFieldAbsent.rows, 1, 'the run reports the affected row count')
  assert.deepEqual(runRow.details.sourceFieldAbsent.fields, [{ sourceField: 'name', targetField: 'name' }])
  assert.equal(JSON.stringify(runRow.details).includes('Correct bolt'), false, 'still values-free')

  // The two shapes must agree, mapping for mapping - that is the property the old gate broke.
  const sourceRecord = { code: 'MAT-001', quantity: 9 }
  const fromRegistry = transformRecord(sourceRecord, [fieldMappings[1]])
  const fromLiteral = transformRecord(sourceRecord, [{ sourceField: 'name', targetField: 'name' }])
  assert.deepEqual(ownKeys(fromRegistry.value), ownKeys(fromLiteral.value), 'a registry mapping and a literal mapping must write the same keys')
  assert.deepEqual(warningCodes(fromRegistry), warningCodes(fromLiteral))
}

// --- 9b. the dictMap compatibility survives the RUNNER, not just transformRecord ---
// The unit case pins the engine's answer; this one pins that the answer reaches the STORED row
// through runPipeline() + the real multitable target adapter, and that a dictionary MISS on the
// very same wiring still leaves the stored value alone and still reports the absence.
async function testDictMapCompatWritesThroughTheRunner() {
  const mappingRows = (map) => [
    { id: 'fm1', pipeline_id: 'pipe_x02', source_field: 'code', target_field: 'code', transform: null, validation: null, default_value: null, sort_order: 0, created_at: null },
    { id: 'fm2', pipeline_id: 'pipe_x02', source_field: 'name', target_field: 'name', transform: JSON.stringify({ fn: 'dictMap', args: { map } }), validation: null, default_value: null, sort_order: 1, created_at: null },
    { id: 'fm3', pipeline_id: 'pipe_x02', source_field: 'quantity', target_field: 'quantity', transform: null, validation: null, default_value: null, sort_order: 2, created_at: null },
  ].map(rowToFieldMapping)
  const existingRow = () => [{
    id: 'rec_existing',
    sheetId: 'sheet_approved_materials',
    version: 1,
    data: { code: 'MAT-001', name: 'Correct bolt', quantity: 7 },
  }]
  const sourceRecords = [{ code: 'MAT-001', quantity: 9, updatedAt: '2026-09-10T00:00:00.000Z' }]

  // The dictionary answers the key the pre-change engine looked up -> the value is written.
  const answered = createHarness({
    fieldMappings: mappingRows({ null: 'UNKNOWN' }),
    multitableRows: existingRow(),
    sourceRecords,
  })
  const answeredResult = await answered.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
  assert.equal(answeredResult.metrics.rowsFailed, 0)
  assert.equal(
    answered.storedRows[0].data.name,
    'UNKNOWN',
    'a dictMap answer for an absent source column is still written through the runner, as on 919582e71',
  )
  assert.equal(answered.storedRows[0].data.quantity, 9, 'the column the source did carry is written too')
  const answeredRun = answered.db.tables.get('integration_runs')[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(answeredRun.details, 'sourceFieldAbsent'),
    false,
    'nothing was left unwritten, so the run carries no absence detail',
  )

  // Same wiring, a dictionary with no answer -> the stored value is left alone and reported.
  const missed = createHarness({
    fieldMappings: mappingRows({ A: 'a' }),
    multitableRows: existingRow(),
    sourceRecords,
  })
  await missed.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
  assert.equal(
    missed.storedRows[0].data.name,
    'Correct bolt',
    'a dictionary MISS must still leave the stored value alone - the key swap must not widen the write',
  )
  const missedRun = missed.db.tables.get('integration_runs')[0]
  assert.equal(missedRun.details.sourceFieldAbsent.rows, 1)
  assert.deepEqual(missedRun.details.sourceFieldAbsent.fields, [{ sourceField: 'name', targetField: 'name' }])
}

// --- 10. the dry-run path reports the same fact and writes nothing ------------
async function testDryRunReportsAbsenceAndWritesNothing() {
  const { db, runner, writtenRecords } = createHarness({
    fieldMappings: normalizeFieldMappings([
      { sourceField: 'code', targetField: 'FNumber', sortOrder: 0 },
      { sourceField: 'spec', targetField: 'FSpec', sortOrder: 1 },
    ]),
    sourceRecords: [{ code: 'MAT-001', updatedAt: '2026-09-10T00:00:00.000Z' }],
  })

  const result = await runner.runPipeline({
    tenantId: 'tenant_1',
    pipelineId: 'pipe_x02',
    triggeredBy: 'test',
    dryRun: true,
  })

  assert.equal(writtenRecords.length, 0, 'a dry run writes nothing')
  assert.equal(result.metrics.rowsWritten, 0)
  assert.deepEqual(
    ownKeys(result.preview.records[0].transformed),
    ['FNumber', '_integration_idempotency_key'],
    'the PREVIEWED payload lacks the key the source did not carry, exactly like the live one',
  )
  const runRow = db.tables.get('integration_runs')[0]
  assert.equal(runRow.details.dryRun, true)
  assert.deepEqual(runRow.details.sourceFieldAbsent, {
    code: 'SOURCE_FIELD_ABSENT',
    rows: 1,
    fields: [{ sourceField: 'spec', targetField: 'FSpec' }],
  }, 'the dry run carries the same run detail as a live run')
  assert.equal(db.tables.get('integration_watermarks').length, 0, 'a dry run still does not move the watermark')
}

// --- 11. fieldsTruncated means "a pair was dropped", not "the cap was reached" -
async function testFieldsTruncatedOnlyWhenAPairWasDropped() {
  const mappingsOf = (count) => normalizeFieldMappings(Array.from({ length: count }, (unused, index) => ({
    sourceField: 'absent_' + index,
    targetField: 'T_' + index,
    sortOrder: index,
  })))
  const rowsOf = (count) => Array.from({ length: count }, (unused, index) => ({
    code: 'MAT-' + index,
    updatedAt: '2026-09-1' + index + 'T00:00:00.000Z',
  }))

  // Exactly the cap, seen on two rows: the list IS exhaustive, so nothing may claim truncation.
  const exact = createHarness({ fieldMappings: mappingsOf(50), sourceRecords: rowsOf(2) })
  await exact.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
  const exactDetail = exact.db.tables.get('integration_runs')[0].details.sourceFieldAbsent
  assert.equal(exactDetail.rows, 2)
  assert.equal(exactDetail.fields.length, 50)
  assert.equal(
    Object.prototype.hasOwnProperty.call(exactDetail, 'fieldsTruncated'),
    false,
    'a repeat of an already-recorded pair drops nothing, so it must not raise fieldsTruncated',
  )

  // One pair over the cap: a pair really was dropped, and the flag must still appear.
  const over = createHarness({ fieldMappings: mappingsOf(51), sourceRecords: rowsOf(1) })
  await over.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
  const overDetail = over.db.tables.get('integration_runs')[0].details.sourceFieldAbsent
  assert.equal(overDetail.rows, 1)
  assert.equal(overDetail.fields.length, 50)
  assert.equal(overDetail.fieldsTruncated, true, 'a genuinely dropped pair is still reported')
}

// --- 12. C6 external-write planner: an absent field must still CONVERGE -------
// Not writing the key changes what the planner sees. `writableDataFromRecord()`
// (`external-write-dry-run.cjs:545-551`) drops undefined, so the field is not in the update
// payload; if the classifier still counted it as a difference, every round would re-plan the same
// `update`, the write would change nothing, and counts/rowFingerprints would report churn for
// ever. Before this cut the planner "converged" only by writing null over the good value.
async function testPlannerConvergesWhenSourceFieldIsAbsent() {
  const stored = new Map([['P-002', { externalId: 'P-002', name: 'Old gadget', status: 'old' }]])
  const calls = { updateRows: [], insertRows: [] }
  const input = {
    pipeline: {
      id: 'pipe_c6',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      sourceSystemId: 'source_1',
      sourceObject: 'items',
      targetSystemId: 'target_1',
      targetObject: 'target_items',
      createdBy: 'owner-7',
      // C6 refuses a source without persisted equality filters; mirrors the planner suite fixture.
      options: { source: { filters: { approvedSlice: 'fixture' } } },
      // Registry shape again: these mappings carry defaultValue: null, like every stored one.
      fieldMappings: normalizeFieldMappings([
        { sourceField: 'code', targetField: 'externalId', sortOrder: 0 },
        { sourceField: 'name', targetField: 'name', sortOrder: 1 },
        { sourceField: 'status', targetField: 'status', sortOrder: 2 },
      ]),
    },
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    targetSystem: {
      id: 'target_1',
      kind: 'data-source:sql-write-gated',
      config: {
        dataSourceId: 'writable-ds',
        object: 'public.target_items',
        keyFields: ['externalId'],
        writableFields: ['name', 'status'],
      },
    },
    // The source row simply does not carry `name`.
    sourceAdapter: {
      async read() { return { records: [{ code: 'P-002', status: 'new' }], done: true, nextCursor: null } },
    },
    dataSourceWrites: {
      async test() {
        return { success: true, capabilityState: { readOnly: false, c6WriteTarget: true, genericQueryDisabled: true } }
      },
      async lookupByKey(id, object, key) {
        const row = stored.get(key.externalId)
        return { data: row ? [{ ...row }] : [], metadata: {} }
      },
      async insertRows(id, object, rows) {
        calls.insertRows.push(...rows)
        for (const row of rows) stored.set(row.externalId, { ...row })
        return { data: rows, metadata: {} }
      },
      async updateRows(id, object, rows) {
        calls.updateRows.push(...rows)
        // A keyed update writes the columns it is given; the ones it omits keep their value.
        for (const row of rows) stored.set(row.externalId, { ...stored.get(row.externalId), ...row })
        return { rowCount: rows.length, results: [] }
      },
    },
    tokenStore: (() => {
      const map = new Map()
      return {
        async get(key) { return map.get(key) || null },
        async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
        async consume(key) { const value = map.get(key) || null; map.delete(key); return value },
        async delete(key) { map.delete(key) },
      }
    })(),
    dryRunUser: 'user_write',
    dataSourceOwnerPrincipal: 'owner-7',
    maxRows: 100,
  }

  // Round 1: `status` really did change, so the row is an update - with a payload that does NOT
  // carry `name`.
  const first = await dryRunExternalWrite(input)
  assert.equal(first.counts.update, 1, 'a real difference is still planned as an update')
  assert.equal(first.counts.skip, 0)
  await applyExternalWrite({ ...input, dryRunToken: first.dryRunToken, applyUser: 'user_write', runId: 'run_c6_1' })
  assert.deepEqual(
    ownKeys(calls.updateRows[0]),
    ['externalId', 'status'],
    'the write payload omits the field the source did not carry',
  )
  assert.equal(stored.get('P-002').name, 'Old gadget', 'and the target keeps its value')

  // Round 2: nothing the row can write differs any more, so it must settle to `skip`. If the
  // classifier compared a field the payload cannot carry, this would be a second `update` and the
  // plan would never converge.
  const second = await dryRunExternalWrite(input)
  assert.equal(second.counts.update, 0, 'the plan converges instead of re-planning a no-op update')
  assert.equal(second.counts.skip, 1)
  assert.equal(calls.updateRows.length, 1, 'and no second write is issued')
  assert.equal(stored.get('P-002').name, 'Old gadget')
}

// Exported one-by-one so a mutation probe can run each case in isolation and count
// exactly how many go red; `node __tests__/...` (the test-chain shape) still runs them all.
const CASES = {
  testAbsentSourcePathLeavesTargetUnwritten,
  testPresentButEmptyStillWrites,
  testDefaultsAndTransformsStillProduceValues,
  testBlankDefaultValueIsUnset,
  testAllAbsentConcatWritesNothing,
  testDictMapNullKeyStillAnswersAbsentSource,
  testEmptyArraySegmentIsAbsentByDecision,
  testSkipDoesNotBypassGuards,
  testResolveSourcePathValueParityWithGetPath,
  testTargetPatchPreservesExistingValue,
  testRunReportsAbsenceWithCountAndFieldNames,
  testCleanRunCarriesNoAbsenceDetail,
  testStoredMappingShapeIsNotBlanked,
  testDictMapCompatWritesThroughTheRunner,
  testDryRunReportsAbsenceAndWritesNothing,
  testFieldsTruncatedOnlyWhenAPairWasDropped,
  testPlannerConvergesWhenSourceFieldIsAbsent,
}

async function main() {
  for (const run of Object.values(CASES)) await run()
  console.log('[pass] transform-source-field-absent: absent source fields no longer blank target values')
}

module.exports = { CASES }

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
