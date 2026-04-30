import { describe, expect, test } from 'vitest'

import {
  buildXlsxBuffer,
  buildXlsxImportRecords,
  mapXlsxColumnsToFields,
  normalizeXlsxColumnMapping,
  parseXlsxBuffer,
  serializeXlsxCell,
  type XlsxModule,
} from '../../src/multitable/xlsx-service'

const xlsx = await import('xlsx') as unknown as XlsxModule

describe('multitable xlsx service', () => {
  test('round-trips xlsx buffers into headers and rows', () => {
    const buffer = buildXlsxBuffer(xlsx, {
      sheetName: 'Orders',
      headers: ['Name', 'Amount'],
      rows: [
        ['Alpha', 12],
        ['Beta', 23],
      ],
    })

    const parsed = parseXlsxBuffer(xlsx, buffer)

    expect(parsed.sheetName).toBe('Orders')
    expect(parsed.headers).toEqual(['Name', 'Amount'])
    expect(parsed.rows).toEqual([
      ['Alpha', '12'],
      ['Beta', '23'],
    ])
    expect(parsed.truncated).toBe(false)
  })

  test('maps headers only to importable writable fields', () => {
    const result = mapXlsxColumnsToFields(
      ['Name', 'Lookup', 'Hidden', 'Status'],
      [
        { id: 'fld_name', name: 'Name', type: 'string', property: {} },
        { id: 'fld_lookup', name: 'Lookup', type: 'lookup', property: {} },
        { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { hidden: true } },
        { id: 'fld_status', name: 'Status', type: 'select', property: { options: [{ value: 'Open' }] } },
      ],
    )

    expect(result.mapping).toEqual({ 0: 'fld_name', 3: 'fld_status' })
    expect(result.unmappedHeaders).toEqual(['Lookup', 'Hidden'])
    expect(result.unmappedFields).toEqual([])
  })

  test('rejects explicit mapping to non-importable fields', () => {
    expect(() => normalizeXlsxColumnMapping(
      { 0: 'fld_formula' },
      ['Formula'],
      [{ id: 'fld_formula', name: 'Formula', type: 'formula', property: {} }],
    )).toThrow('non-importable field')
  })

  test('builds record payloads from mapped columns', () => {
    const result = buildXlsxImportRecords(
      { rows: [['Alpha', '12'], ['Beta', '23']] },
      { 0: 'fld_name', 1: 'fld_amount' },
    )

    expect(result).toEqual({
      records: [
        { fld_name: 'Alpha', fld_amount: '12' },
        { fld_name: 'Beta', fld_amount: '23' },
      ],
      rowIndexes: [0, 1],
    })
  })

  test('serializes complex export values without losing readable content', () => {
    expect(serializeXlsxCell(['rec_a', 'rec_b'])).toBe('rec_a, rec_b')
    expect(serializeXlsxCell({ id: 'att_1', filename: 'a.pdf' })).toBe('{"id":"att_1","filename":"a.pdf"}')
    expect(serializeXlsxCell(null)).toBe('')
  })
})
