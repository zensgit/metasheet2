import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceImportCsvHeaderForTests

// Regression for DT-HARDEN-10: DingTalk exports commonly prepend a title/export-notice
// row before the real 姓名/日期 header row. The inline (small-file) import path detects
// the header by scanning for a row that contains BOTH a name column and a date column
// (detectCsvHeaderIndex). The large-file/streaming path used to unconditionally trust
// row 0 as the header (`rowIndex === 0 || (hasName && hasDate)`), which misaligned every
// column for the rest of the file and made every row look like it was missing workDate.
// This test locks the two paths to produce byte-identical parsed rows for the same CSV.

const DINGTALK_STYLE_CSV = [
  '某某集团有限公司考勤明细导出,,,,',
  '姓名,日期,UserId,上班1打卡时间,下班1打卡时间',
  '张三,2026-06-01,1001,09:00,18:00',
  '李四,2026-06-02,1002,09:05,18:02',
].join('\n')

// A file with no name+date row anywhere: the readers must still fall back to the
// first non-empty row so upload validation keeps producing its existing 400.
const HEADERLESS_CSV = ['随便一行,不是表头', 'a,b'].join('\n')

async function collectInlineRows(csvText: string) {
  const rows: Array<{ workDate: string; fields: Record<string, string>; userId?: string }> = []
  const summary = await helpers.iterateImportRowsFromCsv({
    csvText,
    csvOptions: {},
    maxRows: 100,
    onRow: (row: any) => {
      rows.push(row)
      return true
    },
  })
  return { rows, summary }
}

describe('attendance CSV import header detection — inline vs streaming parity', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function collectStreamedRows(csvText: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ms2-attendance-csv-header-'))
    tmpDirs.push(dir)
    const csvPath = join(dir, 'import.csv')
    writeFileSync(csvPath, csvText, 'utf8')

    const rows: Array<{ workDate: string; fields: Record<string, string>; userId?: string }> = []
    const summary = await helpers.iterateImportRowsFromCsvFileAsync({
      csvPath,
      csvOptions: {},
      maxRows: 100,
      onRow: (row: any) => {
        rows.push(row)
        return true
      },
    })
    return { rows, summary }
  }

  it('detects the real header row (skipping a DingTalk title row) via the inline path', () => {
    const index = helpers.detectCsvHeaderIndex(DINGTALK_STYLE_CSV, ',')
    expect(index).toBe(1)
  })

  it('streaming (large-file) parsing yields the exact same rows as inline parsing', async () => {
    const inline = await collectInlineRows(DINGTALK_STYLE_CSV)
    const streamed = await collectStreamedRows(DINGTALK_STYLE_CSV)

    expect(inline.rows).toEqual([
      {
        workDate: '2026-06-01',
        fields: {
          '姓名': '张三',
          '日期': '2026-06-01',
          UserId: '1001',
          '上班1打卡时间': '09:00',
          '下班1打卡时间': '18:00',
        },
        userId: '1001',
      },
      {
        workDate: '2026-06-02',
        fields: {
          '姓名': '李四',
          '日期': '2026-06-02',
          UserId: '1002',
          '上班1打卡时间': '09:05',
          '下班1打卡时间': '18:02',
        },
        userId: '1002',
      },
    ])

    // The bug this test guards: the streaming path used to misalign the header, which
    // showed up as every row having an empty workDate. Assert non-empty explicitly so a
    // regression that reintroduces the "trust row 0" bug fails loudly here, not silently
    // downstream as a "missing workDate" skip.
    for (const row of streamed.rows) {
      expect(row.workDate).not.toBe('')
    }

    expect(streamed.rows).toEqual(inline.rows)
    expect(streamed.summary.rowCount).toBe(inline.summary.rowCount)
    expect(streamed.summary.warnings).toEqual(inline.summary.warnings)
  })

  it('still honors an explicit headerRowIndex override on the streaming path', async () => {
    const csvText = [
      '导出说明,,,,',
      '姓名,日期,UserId',
      '王五,2026-06-03,2001',
    ].join('\n')

    const dir = mkdtempSync(join(tmpdir(), 'ms2-attendance-csv-header-override-'))
    tmpDirs.push(dir)
    const csvPath = join(dir, 'import.csv')
    writeFileSync(csvPath, csvText, 'utf8')

    const rows: Array<{ workDate: string; fields: Record<string, string>; userId?: string }> = []
    const summary = await helpers.iterateImportRowsFromCsvFileAsync({
      csvPath,
      csvOptions: { headerRowIndex: 1 },
      maxRows: 100,
      onRow: (row: any) => {
        rows.push(row)
        return true
      },
    })

    expect(rows).toEqual([
      {
        workDate: '2026-06-03',
        fields: { '姓名': '王五', '日期': '2026-06-03', UserId: '2001' },
        userId: '2001',
      },
    ])
    expect(summary.rowCount).toBe(1)
  })
})

// The parser fix alone is not enough: the upload path validates the header via
// readImportCsvHeaderFromFile BEFORE parsing (validateImportUploadCsvOrThrow), and
// header diagnostics read it via readImportCsvHeaderFromText. Both used to take the
// first non-empty row, so a title-row DingTalk export was rejected with
// "CSV header must include a work date column" and never reached the fixed parser.
describe('attendance CSV import header readers — title-row aware (DT-HARDEN-10)', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
  })

  function writeTmpCsv(contents: string) {
    const dir = mkdtempSync(join(tmpdir(), 'dt-harden-10-'))
    tmpDirs.push(dir)
    const csvPath = join(dir, 'import.csv')
    writeFileSync(csvPath, contents, 'utf8')
    return csvPath
  }

  const REAL_HEADER = ['姓名', '日期', 'UserId', '上班1打卡时间', '下班1打卡时间']

  it('isLikelyImportHeaderRow requires both a name and a date column', () => {
    expect(helpers.isLikelyImportHeaderRow(REAL_HEADER)).toBe(true)
    expect(helpers.isLikelyImportHeaderRow(['某某集团有限公司考勤明细导出', '', '', '', ''])).toBe(false)
    expect(helpers.isLikelyImportHeaderRow(['姓名', 'UserId'])).toBe(false)
    expect(helpers.isLikelyImportHeaderRow(['name', 'work_date'])).toBe(true)
  })

  it('readImportCsvHeaderFromText skips the title row and returns the real header', () => {
    expect(helpers.readImportCsvHeaderFromText(DINGTALK_STYLE_CSV, ',')).toEqual(REAL_HEADER)
  })

  it('readImportCsvHeaderFromFile skips the title row and returns the real header', async () => {
    const csvPath = writeTmpCsv(DINGTALK_STYLE_CSV)
    await expect(helpers.readImportCsvHeaderFromFile(csvPath, ',')).resolves.toEqual(REAL_HEADER)
  })

  it('both readers agree on the same CSV (upload validation vs inline diagnostics)', async () => {
    const csvPath = writeTmpCsv(DINGTALK_STYLE_CSV)
    const fromFile = await helpers.readImportCsvHeaderFromFile(csvPath, ',')
    expect(fromFile).toEqual(helpers.readImportCsvHeaderFromText(DINGTALK_STYLE_CSV, ','))
  })

  it('falls back to the first non-empty row when no name+date row exists (validation error preserved)', async () => {
    expect(helpers.readImportCsvHeaderFromText(HEADERLESS_CSV, ',')).toEqual(['随便一行', '不是表头'])
    const csvPath = writeTmpCsv(HEADERLESS_CSV)
    await expect(helpers.readImportCsvHeaderFromFile(csvPath, ',')).resolves.toEqual(['随便一行', '不是表头'])
  })

  it('a normal CSV whose header is already row 0 is unchanged', async () => {
    const normal = [REAL_HEADER.join(','), '张三,2026-06-01,1001,09:00,18:00'].join('\n')
    expect(helpers.readImportCsvHeaderFromText(normal, ',')).toEqual(REAL_HEADER)
    const csvPath = writeTmpCsv(normal)
    await expect(helpers.readImportCsvHeaderFromFile(csvPath, ',')).resolves.toEqual(REAL_HEADER)
  })
})
