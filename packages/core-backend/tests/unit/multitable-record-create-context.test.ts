import { describe, expect, test } from 'vitest'
import { extractMultitableRecordCreateContextFromUrl } from '../../src/routes/univer-meta'

describe('multitable record-create context helpers', () => {
  test('extracts sheet and view ids from an authenticated multitable route', () => {
    expect(extractMultitableRecordCreateContextFromUrl(
      'http://localhost:8081/multitable/sheet_standard_materials/view_grid?baseId=base_legacy',
    )).toEqual({
      sheetId: 'sheet_standard_materials',
      viewId: 'view_grid',
    })
  })

  test('extracts sheet and view ids from a hash-backed multitable route', () => {
    expect(extractMultitableRecordCreateContextFromUrl(
      'http://localhost:8081/#/multitable/sheet_hash_materials/view_hash_grid?baseId=base_legacy',
    )).toEqual({
      sheetId: 'sheet_hash_materials',
      viewId: 'view_hash_grid',
    })
  })

  test('extracts sheet and view ids from query parameters as a final fallback', () => {
    expect(extractMultitableRecordCreateContextFromUrl(
      'http://localhost:8081/grid?sheetId=sheet_query_materials&viewId=view_query_grid',
    )).toEqual({
      sheetId: 'sheet_query_materials',
      viewId: 'view_query_grid',
    })
  })

  test('does not extract public-form context for authenticated record creation', () => {
    expect(extractMultitableRecordCreateContextFromUrl(
      'http://localhost:8081/multitable/public-form/sheet_public/view_public',
    )).toEqual({})
  })
})
