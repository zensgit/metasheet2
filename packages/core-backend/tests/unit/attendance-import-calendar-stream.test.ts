import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const { iterateImportCalendarRows } = require('../../../../plugins/plugin-attendance/lib/attendance-import-calendar.cjs')

function source(count: number) {
  const parsed: number[] = []
  const iterateRows = async (onRow: (row: { workDate: string; ordinal: number }, index: number) => Promise<boolean>) => {
    for (let ordinal = 0; ordinal < count; ordinal++) {
      parsed.push(ordinal)
      if (await onRow({ workDate: String(ordinal), ordinal }, ordinal) === false) break
    }
    return { rowCount: parsed.length, warnings: ['synthetic warning'], maxRows: 100000, limitExceeded: false }
  }
  return { parsed, iterateRows }
}

describe('streamed import calendar normalization', () => {
  it('normalizes bounded batches and preserves order, row indexes and parser diagnostics', async () => {
    const raw = source(1001)
    const batches: number[] = []
    const seen: number[] = []
    const result = await iterateImportCalendarRows({
      iterateRows: raw.iterateRows,
      normalizeRows: async (rows: Array<{ workDate: string; ordinal: number }>) => {
        batches.push(rows.length)
        return rows.map(row => ({ ...row, workDate: '2026-09-23' }))
      },
      onRow: async (row: { workDate: string; ordinal: number }, index: number) => {
        expect(row.workDate).toBe('2026-09-23')
        expect(index).toBe(row.ordinal)
        seen.push(index)
        return true
      },
    })
    expect(batches).toEqual([500, 500, 1])
    expect(seen).toEqual(Array.from({ length: 1001 }, (_, i) => i))
    expect(result).toEqual({ rowCount: 1001, warnings: ['synthetic warning'], maxRows: 100000, limitExceeded: false })
  })
  it('stops delivery at the first false callback and bounds parser read-ahead', async () => {
    const raw = source(1200)
    const onRow = vi.fn(async (_row: unknown, index: number) => index < 20)
    const result = await iterateImportCalendarRows({ iterateRows: raw.iterateRows, normalizeRows: async (rows: unknown[]) => rows, onRow })
    expect(result.rowCount).toBe(21)
    expect(onRow).toHaveBeenCalledTimes(21)
    expect(raw.parsed).toHaveLength(500)
  })
  it('propagates calendar ambiguity before delivering any row in that batch', async () => {
    const raw = source(501)
    const onRow = vi.fn()
    const failure = new Error('IMPORT_CALENDAR_DATE_UNRESOLVED')
    await expect(iterateImportCalendarRows({ iterateRows: raw.iterateRows, normalizeRows: async () => { throw failure }, onRow })).rejects.toBe(failure)
    expect(onRow).not.toHaveBeenCalled()
    expect(raw.parsed).toHaveLength(500)
  })
  it('preserves an empty-source diagnostic without resolving a calendar', async () => {
    const normalizeRows = vi.fn()
    const result = await iterateImportCalendarRows({ iterateRows: source(0).iterateRows, normalizeRows })
    expect(normalizeRows).not.toHaveBeenCalled()
    expect(result).toEqual({ rowCount: 0, warnings: ['synthetic warning'], maxRows: 100000, limitExceeded: false })
  })
})

const csvParser = require('../../../../plugins/plugin-attendance/index.cjs').__attendanceImportCsvHeaderForTests
const csvTemp = mkdtempSync(join(tmpdir(), 'csv-calendar-stream-'))
afterAll(() => rmSync(csvTemp, { recursive: true, force: true }))

function realFileSource() {
  const file = join(csvTemp, 'rows.csv')
  const lines = ['Synthetic export,,,,', '', 'UserId,日期,上班1打卡时间,下班1打卡时间,sequence']
  for (let i = 0; i < 1001; i++) {
    if (i === 500) lines.push(',,,,')
    const date = i === 499 ? '1790094600000' : i === 500 ? '2026-09-23' : '2030-01-01'
    lines.push('synthetic,' + date + ',09:00,18:00,' + i)
  }
  writeFileSync(file, lines.join('\n'))
  return (onRow: (row: unknown, index: number) => Promise<boolean>) =>
    csvParser.iterateImportRowsFromCsvFileAsync({ csvPath: file, csvOptions: {}, maxRows: 2000, onRow })
}

describe('real CSV parser with bounded calendar wrapper', () => {
  it('keeps source ordinals across title/blank rows and the 499/500 batch boundary', async () => {
    const rows: Array<{ index: number; sequence: number; date: string }> = []
    const batches: number[] = []
    const result = await iterateImportCalendarRows({
      iterateRows: realFileSource(),
      normalizeRows: async (input: Array<{ workDate: string; fields: { sequence: string } }>) => {
        batches.push(input.length)
        return input.map(row => ({ ...row, workDate: row.workDate === '1790094600000' ? '2026-09-23' : row.workDate }))
      },
      onRow: async (row: { workDate: string; fields: { sequence: string } }, index: number) => {
        rows.push({ index, sequence: Number(row.fields.sequence), date: row.workDate })
        return true
      },
    })
    expect(result).toEqual({ rowCount: 1001, warnings: [], limitExceeded: false, maxRows: 2000 })
    expect(batches).toEqual([500, 500, 1])
    expect(rows.map(({ index, sequence }) => ({ index, sequence }))).toEqual(Array.from({ length: 1001 }, (_, i) => ({ index: i, sequence: i })))
    expect(rows.slice(499, 501)).toEqual([{ index: 499, sequence: 499, date: '2026-09-23' }, { index: 500, sequence: 500, date: '2026-09-23' }])
  })
  for (const failingBatch of [2, 3]) {
    it('propagates a calendar failure in batch ' + failingBatch + ' without later callbacks', async () => {
      let batches = 0
      const failure = new Error('synthetic calendar failure')
      const onRow = vi.fn(async () => true)
      await expect(iterateImportCalendarRows({
        iterateRows: realFileSource(), onRow,
        normalizeRows: async (rows: unknown[]) => {
          if (++batches === failingBatch) throw failure
          return rows
        },
      })).rejects.toBe(failure)
      expect(onRow).toHaveBeenCalledTimes((failingBatch - 1) * 500)
      expect(batches).toBe(failingBatch)
    })
  }
  it('propagates callback failure at the second batch without later delivery', async () => {
    const failure = new Error('synthetic callback failure')
    const onRow = vi.fn(async (_row: unknown, index: number) => { if (index === 500) throw failure; return true })
    await expect(iterateImportCalendarRows({ iterateRows: realFileSource(), normalizeRows: async (rows: unknown[]) => rows, onRow })).rejects.toBe(failure)
    expect(onRow).toHaveBeenCalledTimes(501)
  })
  it('preserves a file read error before normalization or callbacks', async () => {
    const normalizeRows = vi.fn()
    const onRow = vi.fn()
    await expect(iterateImportCalendarRows({
      iterateRows: (consume: unknown) => csvParser.iterateImportRowsFromCsvFileAsync({ csvPath: join(csvTemp, 'missing.csv'), csvOptions: {}, onRow: consume }),
      normalizeRows, onRow,
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(normalizeRows).not.toHaveBeenCalled()
    expect(onRow).not.toHaveBeenCalled()
  })
})
