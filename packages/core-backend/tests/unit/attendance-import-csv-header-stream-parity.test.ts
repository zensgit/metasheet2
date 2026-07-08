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

// P1 FOLLOW-UP: the fix above (skip a DingTalk title row) was necessary but not
// sufficient. `isLikelyImportHeaderRow` still only recognized a literal 姓名/name
// cell as "this is the header" — but two of the three *shipped* import templates
// (dingtalk_api_columns, manual_rows) have no name column at all; they identify the
// subject by workDate/userId. Because readImportCsvHeaderFromFile falls back to the
// first non-empty row when nothing "looks like" a header, upload *validation* passed
// by luck (the fallback happened to land on the real header) — but the *streaming
// parser* (iterateImportRowsFromCsvFileAsync) had no such fallback, so it never
// resolved a header at all and silently produced 0 data rows, 400ing with "CSV must
// include at least 1 non-empty data row" for CSVs that plainly had a row.
// This suite proves the fold onto the real vocabulary (IMPORT_HEADER_DATE_KEYS /
// IMPORT_HEADER_CONTEXT_KEYS) + normalization, table-driven over the profiles the
// product actually ships, and end-to-end through validateImportUploadCsvOrThrow —
// the exact function the upload route calls before ever reaching the parser.
describe('attendance CSV import — shipped template parity (DT-HARDEN-10 P1 fix)', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeTmpCsv(contents: string) {
    const dir = mkdtempSync(join(tmpdir(), 'dt-harden-10-template-'))
    tmpDirs.push(dir)
    const csvPath = join(dir, 'import.csv')
    writeFileSync(csvPath, contents, 'utf8')
    return csvPath
  }

  const profiles = helpers.IMPORT_MAPPING_PROFILES as Array<{
    id: string
    templateColumns: string[]
    templateSampleRow: string[]
  }>

  it('covers exactly the three shipped profiles (fails loudly if one is added/renamed/removed)', () => {
    expect(profiles.map((p) => p.id)).toEqual([
      'dingtalk_csv_daily_summary',
      'dingtalk_api_columns',
      'manual_rows',
    ])
  })

  for (const profile of profiles) {
    it(`${profile.id}: template header is detected AND upload validates with rowCount > 0`, async () => {
      const csvText = [profile.templateColumns.join(','), profile.templateSampleRow.join(',')].join('\n')
      const csvPath = writeTmpCsv(csvText)

      // (a) header detection: the inline detector and both readers must recognize
      // row 0 as the header, not fall through to some other row.
      expect(helpers.detectCsvHeaderIndex(csvText, ',')).toBe(0)
      expect(helpers.readImportCsvHeaderFromText(csvText, ',')).toEqual(profile.templateColumns)
      await expect(helpers.readImportCsvHeaderFromFile(csvPath, ',')).resolves.toEqual(profile.templateColumns)

      // (b) upload/parse: the actual upload-validation entry point — this is what
      // 400'd for dingtalk_api_columns and manual_rows before the fix.
      const result = await helpers.validateImportUploadCsvOrThrow({ csvPath, csvOptions: {} })
      expect(result).toEqual({ rowCount: 1, warnings: [] })
    })
  }
})

describe('attendance CSV import header — normalization cases (DT-HARDEN-10)', () => {
  it('normalizes "Work Date" (space + mixed case) onto the workdate date key', () => {
    expect(helpers.isLikelyImportHeaderRow(['userId', 'Work Date'])).toBe(true)
  })

  it('normalizes "姓 名" (internal space) onto the 姓名 context key', () => {
    expect(helpers.isLikelyImportHeaderRow(['姓 名', 'date'])).toBe(true)
  })

  it('normalizes "EMP_NO" (underscore + upper case) onto the empno context key', () => {
    expect(helpers.isLikelyImportHeaderRow(['EMP_NO', 'date'])).toBe(true)
  })

  it('a CSV whose header only uses these normalized variants is still detected as row 0', () => {
    const csvText = ['EMP_NO,Work Date,姓 名', 'E001,2026-03-23,张三'].join('\n')
    expect(helpers.detectCsvHeaderIndex(csvText, ',')).toBe(0)
    expect(helpers.readImportCsvHeaderFromText(csvText, ',')).toEqual(['EMP_NO', 'Work Date', '姓 名'])
  })
})

describe('attendance CSV import — headerless fallback, streaming path (DT-HARDEN-10)', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeTmpCsv(contents: string) {
    const dir = mkdtempSync(join(tmpdir(), 'dt-harden-10-headerless-stream-'))
    tmpDirs.push(dir)
    const csvPath = join(dir, 'import.csv')
    writeFileSync(csvPath, contents, 'utf8')
    return csvPath
  }

  // The streaming parser cannot replay rows it already discarded while still hunting
  // for a header, so it cannot implement the fallback inline (a one-line
  // `found ? idx : 0` the way the old sync detectCsvHeaderIndex could) — it needs a
  // bounded peek pass first. This directly exercises that peek's own contract.
  it('detectCsvHeaderRowIndexFromFile resolves to the first non-empty row when nothing looks like a header', async () => {
    const csvPath = writeTmpCsv(HEADERLESS_CSV)
    await expect(helpers.detectCsvHeaderRowIndexFromFile(csvPath, ',')).resolves.toBe(0)
  })

  it('iterateImportRowsFromCsvFileAsync falls back to the first non-empty row as header — not stuck at 0 rows forever', async () => {
    const csvPath = writeTmpCsv(HEADERLESS_CSV)
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
    expect(summary).toEqual({ rowCount: 1, warnings: [], limitExceeded: false, maxRows: 100 })
    expect(rows).toEqual([
      { workDate: '', fields: { '随便一行': 'a', '不是表头': 'b' }, userId: undefined },
    ])
  })

  it('validateImportUploadCsvOrThrow still rejects a genuinely headerless CSV (no silent pass-through)', async () => {
    const csvPath = writeTmpCsv(HEADERLESS_CSV)
    await expect(helpers.validateImportUploadCsvOrThrow({ csvPath, csvOptions: {} })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'CSV header must include a work date column and at least one user or attendance column',
    })
  })
})
