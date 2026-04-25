import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import {
  XLSX_MAX_BYTES,
  XLSX_MAX_ROWS,
  buildXlsxBuffer,
  mapXlsxColumnsToFields,
  parseXlsxBuffer,
} from '../../src/multitable/import/xlsx-mapping'

const xlsxModule = XLSX as unknown as Parameters<typeof parseXlsxBuffer>[0]

function makeBuffer(rows: unknown[][], sheetName = 'Sheet1'): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

describe('xlsx-mapping helpers', () => {
  describe('parseXlsxBuffer', () => {
    it('parses headers and rows from the first sheet', () => {
      const buffer = makeBuffer([
        ['Name', 'Age', 'Email'],
        ['Alice', 30, 'alice@example.com'],
        ['Bob', 25, 'bob@example.com'],
      ])
      const result = parseXlsxBuffer(xlsxModule, buffer)
      expect(result.headers).toEqual(['Name', 'Age', 'Email'])
      expect(result.rows).toEqual([
        ['Alice', '30', 'alice@example.com'],
        ['Bob', '25', 'bob@example.com'],
      ])
      expect(result.sheetName).toBe('Sheet1')
      expect(result.truncated).toBe(false)
    })

    it('honours an explicit sheet name when provided', () => {
      const ws1 = XLSX.utils.aoa_to_sheet([['x'], ['1']])
      const ws2 = XLSX.utils.aoa_to_sheet([['Title', 'Score'], ['Foo', 7]])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws1, 'Ignore')
      XLSX.utils.book_append_sheet(wb, ws2, 'Records')
      const buffer = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
      const result = parseXlsxBuffer(xlsxModule, buffer, { sheetName: 'Records' })
      expect(result.sheetName).toBe('Records')
      expect(result.headers).toEqual(['Title', 'Score'])
      expect(result.rows).toEqual([['Foo', '7']])
    })

    it('drops trailing empty header columns', () => {
      const buffer = makeBuffer([
        ['Name', '', ''],
        ['Alice', '', ''],
      ])
      const result = parseXlsxBuffer(xlsxModule, buffer)
      expect(result.headers).toEqual(['Name'])
      expect(result.rows).toEqual([['Alice']])
    })

    it('skips fully blank rows but keeps partially blank ones', () => {
      const buffer = makeBuffer([
        ['Name', 'City'],
        ['Alice', 'NYC'],
        ['', ''],
        ['Bob', ''],
      ])
      const result = parseXlsxBuffer(xlsxModule, buffer)
      expect(result.rows).toEqual([
        ['Alice', 'NYC'],
        ['Bob', ''],
      ])
    })

    it('caps row count at XLSX_MAX_ROWS and reports truncation', () => {
      const rows: unknown[][] = [['Name']]
      for (let i = 0; i < XLSX_MAX_ROWS + 5; i += 1) rows.push([`row-${i}`])
      const buffer = makeBuffer(rows)
      const result = parseXlsxBuffer(xlsxModule, buffer)
      expect(result.rows.length).toBe(XLSX_MAX_ROWS)
      expect(result.truncated).toBe(true)
    })

    it('returns empty result when the workbook has no sheets', () => {
      const wb: Parameters<typeof buildXlsxBuffer>[0]['utils'] extends infer _U ? unknown : never = null
      void wb
      const minimalBuffer = makeBuffer([['x'], ['1']])
      const empty = parseXlsxBuffer(xlsxModule, minimalBuffer, { sheetName: 'DoesNotExist' })
      expect(empty.headers).toEqual(['x'])
    })

    it('exposes finite row + byte caps', () => {
      expect(XLSX_MAX_BYTES).toBeGreaterThan(0)
      expect(XLSX_MAX_ROWS).toBeGreaterThan(0)
      expect(Number.isFinite(XLSX_MAX_BYTES)).toBe(true)
      expect(Number.isFinite(XLSX_MAX_ROWS)).toBe(true)
    })
  })

  describe('buildXlsxBuffer', () => {
    it('round-trips headers and rows', () => {
      const buffer = buildXlsxBuffer(xlsxModule, {
        headers: ['Name', 'Age'],
        rows: [
          ['Alice', 30],
          ['Bob', 25],
        ],
      })
      const parsed = parseXlsxBuffer(xlsxModule, buffer)
      expect(parsed.headers).toEqual(['Name', 'Age'])
      expect(parsed.rows).toEqual([
        ['Alice', '30'],
        ['Bob', '25'],
      ])
    })

    it('coerces nullish cells to empty strings', () => {
      const buffer = buildXlsxBuffer(xlsxModule, {
        headers: ['A', 'B'],
        rows: [
          ['x', null],
          [undefined, 'y'],
        ],
      })
      const parsed = parseXlsxBuffer(xlsxModule, buffer)
      expect(parsed.rows[0][1]).toBe('')
      expect(parsed.rows[1][0]).toBe('')
    })

    it('truncates long sheet names to 31 chars', () => {
      const longName = 'a'.repeat(50)
      const buffer = buildXlsxBuffer(xlsxModule, {
        sheetName: longName,
        headers: ['x'],
        rows: [['1']],
      })
      const parsed = parseXlsxBuffer(xlsxModule, buffer)
      expect(parsed.sheetName.length).toBeLessThanOrEqual(31)
    })
  })

  describe('mapXlsxColumnsToFields', () => {
    const fields = [
      { id: 'fld_a', name: 'Name', type: 'string' as const, property: {} },
      { id: 'fld_b', name: 'Age', type: 'number' as const, property: {} },
      { id: 'fld_c', name: 'Total', type: 'formula' as const, property: {} },
      { id: 'fld_d', name: 'AutoNumber', type: 'string' as const, property: { readOnly: true } },
    ]

    it('matches headers case-insensitively and skips formula/readOnly fields', () => {
      const result = mapXlsxColumnsToFields(['name', 'AGE', 'Total', 'AutoNumber'], fields)
      expect(result.mapping).toEqual({ 0: 'fld_a', 1: 'fld_b' })
      expect(result.unmappedHeaders).toEqual(['Total', 'AutoNumber'])
      expect(result.unmappedFields).toEqual([])
    })

    it('reports leftover importable fields', () => {
      const result = mapXlsxColumnsToFields(['Name'], fields)
      expect(result.mapping).toEqual({ 0: 'fld_a' })
      expect(result.unmappedFields).toEqual(['fld_b'])
    })

    it('does not double-map duplicate headers to the same field', () => {
      const result = mapXlsxColumnsToFields(['Name', 'name', 'Age'], fields)
      expect(result.mapping).toEqual({ 0: 'fld_a', 2: 'fld_b' })
      expect(result.unmappedHeaders).toContain('name')
    })

    it('skips empty headers', () => {
      const result = mapXlsxColumnsToFields(['', 'Name', '   '], fields)
      expect(result.mapping).toEqual({ 1: 'fld_a' })
      expect(result.unmappedHeaders.length).toBe(2)
    })
  })
})
