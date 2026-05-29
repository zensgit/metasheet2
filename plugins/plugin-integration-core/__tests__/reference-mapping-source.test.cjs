'use strict'

// DF-T3b-2b wire-vs-fixture test: prove the index comes from a REAL staging-source-adapter bulk-read
// (the multitable records API by sheetId), NOT a hand-passed mock index. We drive the ACTUAL
// createMetaSheetStagingSourceAdapter with a mocked recordsApi.queryRecords and assert the paginated
// read loop ran (queryRecords called, offsets advance, stops on done) and the index resolves.

const assert = require('node:assert/strict')
const path = require('node:path')

const { createMetaSheetStagingSourceAdapter } = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-staging-source-adapter.cjs'))
const { buildReferenceMappingIndexes, bulkReadRows } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-source.cjs'))
const { resolveReference, OUTCOME } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-resolver.cjs'))
const { K3_REFERENCE_MAPPING_TEMPLATES } = require(path.join(__dirname, '..', 'lib', 'reference-mapping-templates.cjs'))

const UNIT = K3_REFERENCE_MAPPING_TEMPLATES.find((t) => t.domain === 'unit')

// Mocked multitable records API: paginates via offset/limit and RECORDS every queryRecords call so the
// test can assert the real bulk-read loop ran through the adapter.
function createContext(rows) {
  const calls = []
  return {
    calls,
    context: {
      api: {
        multitable: {
          records: {
            async queryRecords(input) {
              calls.push(input)
              const offset = Number(input.offset || 0)
              const limit = Number(input.limit || rows.length)
              return rows.slice(offset, offset + limit)
            },
          },
        },
      },
    },
  }
}

function stagingSystem(object, sheetId) {
  return {
    id: 'ms_staging_1', name: 'MetaSheet staging', kind: 'metasheet:staging', role: 'source',
    config: { objects: { [object]: { name: object, sheetId, fieldDetails: [
      { id: 'sourceCode', name: 'sourceCode', type: 'string' },
      { id: 'fNumber', name: 'fNumber', type: 'string' },
      { id: 'fName', name: 'fName', type: 'string' },
      { id: 'enabled', name: 'enabled', type: 'boolean' },
    ] } } },
  }
}

function mappingRow(id, data) {
  return { id, sheetId: 'sheet_unit_dict', data }
}

async function main() {
  const rows = [
    mappingRow('m1', { sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }),
    mappingRow('m2', { sourceCode: 'EA', fNumber: '11', fName: 'Piece', enabled: true }),
    mappingRow('m3', { sourceCode: 'BOX', fNumber: '12', fName: 'Box', enabled: true }),
  ]

  // ---- the real bulk-read: pageLimit:1 forces PAGINATION across the 3 rows ----
  {
    const { context, calls } = createContext(rows)
    const adapter = createMetaSheetStagingSourceAdapter({ system: stagingSystem('unit_dict', 'sheet_unit_dict'), context })
    const indexes = await buildReferenceMappingIndexes(adapter, [{ domain: 'unit', object: 'unit_dict', template: UNIT }], { pageLimit: 1 })

    // queryRecords actually ran, MORE THAN ONCE (pagination), against the configured sheetId
    assert.ok(calls.length >= 3, `paginated bulk-read called queryRecords per page (got ${calls.length})`)
    assert.ok(calls.every((c) => c.sheetId === 'sheet_unit_dict'), 'bulk-read targets the configured sheetId')
    assert.deepEqual(calls.slice(0, 3).map((c) => c.offset), [0, 1, 2], 'cursor/offset ADVANCES across pages')

    // the index was built FROM the read rows and resolves
    const out = resolveReference(indexes.unit, 'STD', { field: 'FUnitGroupID' })
    assert.equal(out.status, OUTCOME.RESOLVED, 'index built from the real bulk-read resolves a sourceCode')
    assert.deepEqual(out.reference, { FNumber: '10', FName: 'Each' })
    assert.equal(resolveReference(indexes.unit, 'BOX').status, OUTCOME.RESOLVED, 'all paginated rows are indexed')
    assert.equal(resolveReference(indexes.unit, 'NOPE').status, OUTCOME.UNRESOLVED)
  }

  // ---- single page (default): still a real read, stops on done ----
  {
    const { context, calls } = createContext(rows)
    const adapter = createMetaSheetStagingSourceAdapter({ system: stagingSystem('unit_dict', 'sheet_unit_dict'), context })
    const rowsRead = await bulkReadRows(adapter, 'unit_dict')
    assert.equal(rowsRead.length, 3, 'bulk-read returns all rows in one page when under the limit')
    assert.ok(calls.length >= 1, 'queryRecords was called')
  }

  // ---- maxPages cap: a never-done source must THROW, not silently truncate the dictionary ----
  {
    // queryRecords that always returns a full page (never fewer than limit → never done)
    const ctx = { api: { multitable: { records: { async queryRecords(input) {
      const limit = Number(input.limit || 1)
      return Array.from({ length: limit }, (_, i) => mappingRow(`r${input.offset}-${i}`, { sourceCode: 'X', fNumber: '1', fName: 'Y', enabled: true }))
    } } } } }
    const adapter = createMetaSheetStagingSourceAdapter({ system: stagingSystem('unit_dict', 'sheet_unit_dict'), context: ctx })
    await assert.rejects(
      () => buildReferenceMappingIndexes(adapter, [{ domain: 'unit', object: 'unit_dict', template: UNIT }], { pageLimit: 1, maxPages: 5 }),
      /exceeded 5 pages/,
      'unbounded bulk-read fails closed at the page cap (never silently truncates)',
    )
  }

  // ---- binding validation: a malformed binding throws ----
  {
    const { context } = createContext(rows)
    const adapter = createMetaSheetStagingSourceAdapter({ system: stagingSystem('unit_dict', 'sheet_unit_dict'), context })
    await assert.rejects(() => buildReferenceMappingIndexes(adapter, [{ domain: 'unit', object: 'unit_dict' }]), /requires \{ domain, object, template \}/, 'missing template rejected')
    await assert.rejects(() => bulkReadRows({}, 'unit_dict'), /requires a source adapter with read\(\)/, 'non-adapter rejected')
  }

  console.log('reference-mapping-source.test.cjs OK')
}

main().catch((err) => {
  console.error('reference-mapping-source FAILED')
  console.error(err)
  process.exit(1)
})
