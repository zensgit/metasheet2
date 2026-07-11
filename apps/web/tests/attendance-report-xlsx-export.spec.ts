import { describe, expect, it } from 'vitest'
import { REPORT_XLSX_MIME, csvTextToXlsxArrayBuffer, xlsxFilenameFromCsv } from '../src/views/attendance/reportXlsxExport'

describe('xlsxFilenameFromCsv', () => {
  it('swaps a .csv name for .xlsx, preserving the prefix', () => {
    expect(xlsxFilenameFromCsv('attendance-export.csv')).toBe('attendance-export.xlsx')
    expect(xlsxFilenameFromCsv('dingtalk_csv-2026-07.csv')).toBe('dingtalk_csv-2026-07.xlsx')
  })
  it('is idempotent on an .xlsx name and appends when there is no .csv suffix', () => {
    expect(xlsxFilenameFromCsv('report.xlsx')).toBe('report.xlsx')
    expect(xlsxFilenameFromCsv('report')).toBe('report.xlsx')
    expect(xlsxFilenameFromCsv('')).toBe('attendance-export.xlsx')
  })
})

describe('csvTextToXlsxArrayBuffer', () => {
  it('produces a valid .xlsx (zip PK magic) from report CSV text', async () => {
    const csv = '姓名,日期,状态\n张三,2026-06-01,正常\n"李,四",2026-06-02,迟到\n'
    const buf = await csvTextToXlsxArrayBuffer(csv)
    const bytes = new Uint8Array(buf)
    // .xlsx is a zip container → starts with the PK local-file-header magic.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])
    expect(bytes.byteLength).toBeGreaterThan(200)
  })

  it('round-trips the rows: reading the produced workbook back yields the same cells (quote-aware)', async () => {
    const csv = '姓名,日期,状态\n张三,2026-06-01,正常\n"李,四",2026-06-02,迟到\n'
    const buf = await csvTextToXlsxArrayBuffer(csv)
    const XLSX = await import('xlsx')
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ 姓名: '张三', 日期: '2026-06-01', 状态: '正常' })
    // the quoted comma survived the CSV→xlsx conversion.
    expect(rows[1]['姓名']).toBe('李,四')
  })

  it('exposes the OOXML spreadsheet MIME', () => {
    expect(REPORT_XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })
})
