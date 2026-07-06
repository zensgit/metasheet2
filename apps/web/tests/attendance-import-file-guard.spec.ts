import { describe, expect, it } from 'vitest'
import {
  blockedSpreadsheetMessage,
  detectSpreadsheetByMagic,
  detectSpreadsheetByName,
  inspectImportFile,
} from '../src/views/attendance/importFileGuard'

const XLSX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const XLS_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

describe('importFileGuard', () => {
  describe('detectSpreadsheetByName', () => {
    it('flags xlsx-family extensions case-insensitively', () => {
      expect(detectSpreadsheetByName('6月考勤(5).xlsx')).toBe('xlsx')
      expect(detectSpreadsheetByName('REPORT.XLSX')).toBe('xlsx')
      expect(detectSpreadsheetByName('macro.xlsm')).toBe('xlsx')
      expect(detectSpreadsheetByName('binary.xlsb')).toBe('xlsx')
    })

    it('flags legacy .xls', () => {
      expect(detectSpreadsheetByName('六月考勤.xls')).toBe('xls')
      expect(detectSpreadsheetByName('OLD.XLS')).toBe('xls')
    })

    it('allows csv, other extensions, empty, and extensionless names', () => {
      expect(detectSpreadsheetByName('attendance.csv')).toBeNull()
      expect(detectSpreadsheetByName('data.txt')).toBeNull()
      expect(detectSpreadsheetByName('xlsx')).toBeNull()
      expect(detectSpreadsheetByName('')).toBeNull()
      expect(detectSpreadsheetByName(null)).toBeNull()
      expect(detectSpreadsheetByName(undefined)).toBeNull()
    })
  })

  describe('detectSpreadsheetByMagic', () => {
    it('detects ZIP/OOXML signatures as xlsx', () => {
      expect(detectSpreadsheetByMagic(XLSX_MAGIC)).toBe('xlsx')
      expect(detectSpreadsheetByMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe('xlsx')
      expect(detectSpreadsheetByMagic(new Uint8Array([0x50, 0x4b, 0x07, 0x08]))).toBe('xlsx')
    })

    it('detects the OLE2 compound signature as legacy xls', () => {
      expect(detectSpreadsheetByMagic(XLS_MAGIC)).toBe('xls')
    })

    it('allows plain text and short buffers', () => {
      expect(detectSpreadsheetByMagic(new TextEncoder().encode('日期,姓名\nu-1,2026-06-01\n'))).toBeNull()
      expect(detectSpreadsheetByMagic(new TextEncoder().encode('userId,workDate'))).toBeNull()
      expect(detectSpreadsheetByMagic(new Uint8Array([0x50, 0x4b]))).toBeNull()
      expect(detectSpreadsheetByMagic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBeNull()
      expect(detectSpreadsheetByMagic(new Uint8Array([]))).toBeNull()
    })
  })

  describe('inspectImportFile', () => {
    it('blocks by extension without touching the file bytes', async () => {
      const file = new File([XLSX_MAGIC], '6月考勤(5).xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      await expect(inspectImportFile(file)).resolves.toEqual({ ok: false, kind: 'xlsx' })
    })

    it('blocks a renamed spreadsheet via magic bytes', async () => {
      const renamed = new File([XLSX_MAGIC], 'data.csv', { type: 'text/csv' })
      await expect(inspectImportFile(renamed)).resolves.toEqual({ ok: false, kind: 'xlsx' })
      const renamedXls = new File([XLS_MAGIC], 'legacy.csv', { type: 'text/csv' })
      await expect(inspectImportFile(renamedXls)).resolves.toEqual({ ok: false, kind: 'xls' })
    })

    it('allows a clean csv file', async () => {
      const csv = new File(['userId,workDate\nu-1,2026-06-01\n'], 'attendance.csv', { type: 'text/csv' })
      await expect(inspectImportFile(csv)).resolves.toEqual({ ok: true })
    })

    it('falls back to allowing the file when byte reading fails', async () => {
      const broken = {
        name: 'attendance.csv',
        slice: () => {
          throw new Error('slice unavailable')
        },
        arrayBuffer: () => Promise.reject(new Error('read failed')),
      }
      await expect(inspectImportFile(broken as any)).resolves.toEqual({ ok: true })
    })
  })

  describe('blockedSpreadsheetMessage', () => {
    it('gives actionable en/zh copy naming the format and the fix', () => {
      const xlsx = blockedSpreadsheetMessage('xlsx')
      expect(xlsx.en).toContain('CSV')
      expect(xlsx.en).toContain('.xlsx')
      expect(xlsx.zh).toContain('另存为')
      expect(xlsx.zh).toContain('CSV')
      const xls = blockedSpreadsheetMessage('xls')
      expect(xls.en).toContain('.xls')
      expect(xls.zh).toContain('另存为')
    })
  })
})
