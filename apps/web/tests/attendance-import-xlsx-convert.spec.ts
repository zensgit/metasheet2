import { describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import {
  IMPORT_XLSX_MAX_BYTES,
  classifyXlsxReadError,
  convertXlsxFileToCsvText,
  isDirectConvertibleXlsxName,
  xlsxConvertFailureMessage,
} from '../src/views/attendance/importXlsxConvert'

function buildXlsxFile(rows: unknown[][], sheetName = '打卡日报', name = '考勤.xlsx'): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName)
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([buffer], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

describe('importXlsxConvert (X1, lock D2/D4)', () => {
  it('converts the first non-empty sheet, skipping leading empty sheets', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), '空表')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['日期', '姓名'],
      ['2026-06-01', '张三'],
    ]), '数据')
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = new File([buffer], '多表.xlsx', { type: 'application/octet-stream' })

    const result = await convertXlsxFileToCsvText(file)
    expect(result).toMatchObject({ ok: true, sheetName: '数据', sheetCount: 2 })
    if (result.ok) expect(result.csvText).toContain('2026-06-01,张三')
  })

  it('escapes commas/quotes/newlines so the backend CSV parser round-trips them', async () => {
    const file = buildXlsxFile([
      ['日期', '姓名', '异常原因'],
      ['2026-06-01', '张,三', '说 "引" 行\n第二行'],
    ])
    const result = await convertXlsxFileToCsvText(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.csvText).toContain('"张,三"')
      expect(result.csvText).toContain('"说 ""引"" 行\n第二行"')
    }
  })

  it('D4 too-large: rejects before reading a single byte or touching SheetJS', async () => {
    const arrayBuffer = vi.fn()
    const oversized = {
      name: 'huge.xlsx',
      size: IMPORT_XLSX_MAX_BYTES + 1,
      arrayBuffer,
    } as unknown as File

    await expect(convertXlsxFileToCsvText(oversized)).resolves.toEqual({ ok: false, reason: 'too-large' })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('D4 empty: a workbook with only empty sheets maps to the empty failure', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), '空表')
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = new File([buffer], '空.xlsx', { type: 'application/octet-stream' })

    await expect(convertXlsxFileToCsvText(file)).resolves.toEqual({ ok: false, reason: 'empty' })
  })

  it('D4 corrupt: junk bytes map to unreadable', async () => {
    const corrupt = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'broken.xlsx', {
      type: 'application/octet-stream',
    })
    await expect(convertXlsxFileToCsvText(corrupt)).resolves.toEqual({ ok: false, reason: 'unreadable' })
  })

  it('D4 encrypted: password/agile read errors classify as encrypted (unit-locked mapping)', () => {
    expect(classifyXlsxReadError(new Error('File is password-protected'))).toBe('encrypted')
    expect(classifyXlsxReadError(new Error('ECMA-376 Encrypted file'))).toBe('encrypted')
    expect(classifyXlsxReadError(new Error('agile encryption not supported'))).toBe('encrypted')
    expect(classifyXlsxReadError(new Error('Corrupted zip: missing bytes'))).toBe('unreadable')
    expect(classifyXlsxReadError('weird non-error')).toBe('unreadable')
  })

  it('failure copy is actionable in zh and en for every state', () => {
    for (const reason of ['too-large', 'encrypted', 'empty', 'unreadable'] as const) {
      const copy = xlsxConvertFailureMessage(reason)
      expect(copy.zh).toContain('CSV')
      expect(copy.en.length).toBeGreaterThan(10)
    }
    expect(xlsxConvertFailureMessage('too-large').zh).toContain('10MB')
  })

  it('v1 scope: only a plain .xlsx name is direct-convertible', () => {
    expect(isDirectConvertibleXlsxName('6月考勤(5).xlsx')).toBe(true)
    expect(isDirectConvertibleXlsxName('REPORT.XLSX')).toBe(true)
    expect(isDirectConvertibleXlsxName('macro.xlsm')).toBe(false)
    expect(isDirectConvertibleXlsxName('binary.xlsb')).toBe(false)
    expect(isDirectConvertibleXlsxName('legacy.xls')).toBe(false)
    expect(isDirectConvertibleXlsxName('data.csv')).toBe(false)
    expect(isDirectConvertibleXlsxName(null)).toBe(false)
  })
})
