/**
 * 客户反馈 2026-09-24 #4c — Excel NATIVE date cells on XLSX import (PR #6083 review, must-fix item 1).
 *
 * A date-typed Excel cell is a serial number with a date number format (built-in numFmt 22 `m/d/yy h:mm`,
 * 14 `m/d/yy`). `sheet_to_json({ raw: false })` renders it as `"9/24/26 9:00"`, which the import grammar
 * rejects — a production regression versus the pre-#6083 `new Date(text)` (which read it in the process
 * zone). `normalizeXlsxDateCells` turns such cells into the grammar's own `YYYY-MM-DD[ HH:mm]` text from the
 * serial (SSF arithmetic, no timezone), so a dateTime field reads the Excel wall clock in the business zone
 * and a date field keeps the calendar day as written.
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { normalizeXlsxDateCells, parseXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'
import { validateDateTimeValue } from '../../src/multitable/field-codecs'

const xlsx = XLSX as unknown as XlsxModule

// Excel serial for 2026-09-24: days since 1899-12-30. 0.375 = 09:00.
const SERIAL_DAY = 46289
const SERIAL_0900 = 46289.375

function workbookWithDateCells(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'When', 'Day', 'Custom', 'Typed', 'Amount', 'Clock'],
    ['Alpha', SERIAL_0900, SERIAL_DAY, SERIAL_0900, '2026-09-24 09:00', 12.5, 0.375],
  ])
  ;(ws as Record<string, any>).B2.z = 'm/d/yy h:mm' // built-in numFmt 22 (dateTime)
  ;(ws as Record<string, any>).C2.z = 'm/d/yy' // built-in numFmt 14 (date-only)
  ;(ws as Record<string, any>).D2.z = 'yyyy-mm-dd hh:mm:ss' // custom date-time format
  ;(ws as Record<string, any>).F2.z = '0.00' // a plain number format — must NOT be touched
  ;(ws as Record<string, any>).G2.z = 'h:mm' // built-in numFmt 20 (time-only)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Rows')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

describe('XLSX import — Excel native date cells become the import grammar text', () => {
  it('negative control: without the normaliser SheetJS renders the SAME cells as "9/24/26 9:00" / "9/24/26"', () => {
    const wb = XLSX.read(workbookWithDateCells(), { type: 'buffer', cellNF: true })
    const ws = wb.Sheets[wb.SheetNames[0]] as Record<string, any>
    expect(ws.B2).toMatchObject({ t: 'n', v: SERIAL_0900, z: 'm/d/yy h:mm' })
    expect(ws.C2).toMatchObject({ t: 'n', v: SERIAL_DAY, z: 'm/d/yy' })
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as string[][]
    expect(rows[1].slice(0, 3)).toEqual(['Alpha', '9/24/26 9:00', '9/24/26'])
    // …and that text is exactly what the grammar refuses (the regression the normaliser fixes).
    expect(() => validateDateTimeValue('9/24/26 9:00', 'fld')).toThrow(/Invalid DateTime/)
  })

  it('parseXlsxBuffer yields YYYY-MM-DD HH:mm for numFmt 22, YYYY-MM-DD for numFmt 14, leaves text and numbers alone', () => {
    const parsed = parseXlsxBuffer(xlsx, workbookWithDateCells())
    expect(parsed.headers).toEqual(['Name', 'When', 'Day', 'Custom', 'Typed', 'Amount', 'Clock'])
    expect(parsed.rows).toEqual([[
      'Alpha',
      '2026-09-24 09:00', // numFmt 22 — the Excel wall clock as written
      '2026-09-24', // numFmt 14 — the calendar day as written
      '2026-09-24 09:00', // custom date-time format
      '2026-09-24 09:00', // a TEXT cell is never touched
      '12.50', // a numeric format is never touched
      '09:00', // a time-only serial: readable text (a dateTime field refuses a bare time)
    ]])
  })

  it('the normalised text round-trips through the server write path to the business-zone instant', () => {
    const parsed = parseXlsxBuffer(xlsx, workbookWithDateCells())
    const [, when, day] = parsed.rows[0]
    expect(validateDateTimeValue(when, 'fld_when')).toBe('2026-09-24T01:00:00.000Z') // 09:00 北京时间
    expect(validateDateTimeValue(when, 'fld_when', { timezone: 'Asia/Tokyo' })).toBe('2026-09-24T00:00:00.000Z')
    expect(validateDateTimeValue(day, 'fld_when')).toBe('2026-09-23T16:00:00.000Z') // a bare day into a dateTime field = business midnight
    expect(() => validateDateTimeValue(parsed.rows[0][6], 'fld_when')).toThrow(/Invalid DateTime/) // time-only
  })

  it('normalizeXlsxDateCells: reports how many cells it rewrote, is a no-op without SSF or on non-date cells', () => {
    const wb = XLSX.read(workbookWithDateCells(), { type: 'buffer', cellNF: true })
    const ws = wb.Sheets[wb.SheetNames[0]] as Record<string, any>
    expect(normalizeXlsxDateCells({ SSF: undefined }, ws)).toBe(0)
    expect(ws.B2.t).toBe('n')
    expect(normalizeXlsxDateCells(xlsx, ws)).toBe(4) // B2, C2, D2, G2
    expect(ws.B2).toMatchObject({ t: 's', v: '2026-09-24 09:00', w: '2026-09-24 09:00' })
    expect(ws.C2).toMatchObject({ t: 's', v: '2026-09-24' })
    expect(ws.E2).toMatchObject({ t: 's', v: '2026-09-24 09:00' })
    expect(ws.F2).toMatchObject({ t: 'n', v: 12.5, z: '0.00' })
    expect(normalizeXlsxDateCells(xlsx, ws)).toBe(0) // idempotent
    expect(normalizeXlsxDateCells(xlsx, null)).toBe(0)
  })

  it('a SheetJS Date-typed cell (t: "d") takes the same route from its UTC parts', () => {
    const ws: Record<string, any> = {
      '!ref': 'A1:B1',
      A1: { t: 'd', v: new Date(Date.UTC(2026, 8, 24, 9, 0, 0)), z: 'm/d/yy h:mm' },
      B1: { t: 'd', v: new Date(Date.UTC(2026, 8, 24, 0, 0, 0)) },
    }
    expect(normalizeXlsxDateCells(xlsx, ws)).toBe(2)
    expect(ws.A1.v).toBe('2026-09-24 09:00')
    expect(ws.B1.v).toBe('2026-09-24') // no format, midnight → a day
  })
})
