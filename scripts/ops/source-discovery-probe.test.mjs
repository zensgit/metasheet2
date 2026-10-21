import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  SMALL_TABLE_ROW_CAP,
  DICTIONARY_MATCH_THRESHOLD,
  tableKey,
  isSmallTable,
  buildColumnNameIndex,
  existsElsewhere,
  sampleSmallTableRows,
  detectDictionaryTables,
  detectCompanionColumns,
  detectBomPairCandidates,
  detectTreeCandidates,
  detectQuantityCandidates,
  buildReport,
  assertValuesFree,
  runProbe,
  parseArgs,
  main,
  coerceRowCount,
  isBareIpAddress,
} from './source-discovery-probe.mjs'

// ---------------------------------------------------------------------------
// Fixture: a small PLM-shaped schema, entirely in memory. No DB, no mssql
// import — this is the whole point of the dialect seam (see runProbe(),
// which takes an already-fetched `catalog` plus a `sampleFn` and never
// touches a dialect module).
// ---------------------------------------------------------------------------

function col(name, dataType, { isPrimaryKey = false, nullable = true, maxLength = null } = {}) {
  return { name, dataType, maxLength, nullable, isPrimaryKey }
}

function table(schema, name, rowCount, columns) {
  return { schema, name, rowCount, columns }
}

function buildFixtureCatalog() {
  const orderHead = table('dbo', 'T_ORDER_HEAD', 200, [
    col('ORDER_ID', 'int', { isPrimaryKey: true }),
    col('ISU_DATE', 'varchar'),
    col('MAIN_PART_CODE', 'varchar'),
    col('STATUS', 'varchar'),
  ])
  const orderDetail = table('dbo', 'T_ORDER_DETAIL', 4000, [
    col('DETAIL_ID', 'int', { isPrimaryKey: true }),
    col('ORDER_PID', 'int'),
    col('PART_CODE', 'varchar'),
    col('QTY', 'float'),
  ])
  const fieldDict = table('dbo', 'T_FIELD_DICT', 5, [
    col('FIELD_NAME', 'varchar'),
    col('DISPLAY_NAME', 'nvarchar'),
    col('IS_ENABLED', 'int'),
    col('FIELD_TYPE', 'varchar'),
  ])
  const miscSmall = table('dbo', 'T_MISC_SMALL', 3, [col('LABEL', 'varchar')])
  const category = table('dbo', 'T_CATEGORY', 50, [col('ID', 'int', { isPrimaryKey: true }), col('PARENT_ID', 'int')])
  const bigTable = table('dbo', 'T_HUGE', 50000, [col('NOTE', 'varchar')])

  return { dialect: 'mssql', tables: [orderHead, orderDetail, fieldDict, miscSmall, category, bigTable] }
}

const NEGATIVE_UNMATCHED_VALUES = ['foo bar baz', 'hello world', 'random business note']
// A 5th row in T_FIELD_DICT whose FIELD_NAME does NOT match any column name
// elsewhere — i.e. not a verified schema-identifier row. Its companion
// values look exactly like a legitimate dictionary entry (Chinese display
// label, enabled flag, type) but must NEVER reach the report: only rows
// whose key matched are allowed to expose their companions. Combined with
// 4 matching rows this keeps the table's overall match ratio at the 0.8
// threshold (still a hit) while proving the per-row guard, not just the
// per-column guard.
const JUNK_ROW_KEY = 'SECRET_JUNK_LABEL'
const JUNK_ROW_DISPLAY = '机密业务备注'
const JUNK_ROW_TYPE = 'note'

function buildFixtureSampleFn({ trackCalls } = {}) {
  const rowsByTable = {
    'dbo.T_FIELD_DICT': [
      { FIELD_NAME: 'ISU_DATE', DISPLAY_NAME: '下单日期', IS_ENABLED: 1, FIELD_TYPE: 'date' },
      { FIELD_NAME: 'PART_CODE', DISPLAY_NAME: '物料编码', IS_ENABLED: 1, FIELD_TYPE: 'text' },
      { FIELD_NAME: 'QTY', DISPLAY_NAME: '数量', IS_ENABLED: 0, FIELD_TYPE: 'number' },
      { FIELD_NAME: 'STATUS', DISPLAY_NAME: '状态', IS_ENABLED: 1, FIELD_TYPE: 'text' },
      { FIELD_NAME: JUNK_ROW_KEY, DISPLAY_NAME: JUNK_ROW_DISPLAY, IS_ENABLED: 1, FIELD_TYPE: JUNK_ROW_TYPE },
    ],
    'dbo.T_MISC_SMALL': NEGATIVE_UNMATCHED_VALUES.map((v) => ({ LABEL: v })),
    'dbo.T_HUGE': [{ NOTE: 'should never be read' }],
  }
  return async ({ table: t, cap }) => {
    const key = tableKey(t)
    if (trackCalls) trackCalls[key] = (trackCalls[key] || 0) + 1
    const rows = rowsByTable[key] || []
    return rows.slice(0, cap)
  }
}

// ---------------------------------------------------------------------------
// Dictionary detection — positive
// ---------------------------------------------------------------------------

describe('detectDictionaryTables — positive', () => {
  test('flags T_FIELD_DICT and decodes attrName/displayLabel/enabled/type entries', async () => {
    const catalog = buildFixtureCatalog()
    const sampleFn = buildFixtureSampleFn()
    const { dictionaries } = await detectDictionaryTables({ catalog, sampleFn })

    const hit = dictionaries.find((d) => d.table === 'dbo.T_FIELD_DICT')
    assert.ok(hit, 'T_FIELD_DICT should be detected as a dictionary table')
    assert.equal(hit.keyColumn, 'FIELD_NAME')
    assert.equal(hit.matchRatio, 0.8) // 4 matched / 5 distinct (see JUNK_ROW_KEY) — exactly at threshold
    assert.equal(hit.matchedDistinctCount, 4)
    assert.equal(hit.totalDistinctCount, 5)
    assert.equal(hit.unmatchedDistinctCount, 1)
    assert.equal(hit.companions.displayNameColumn, 'DISPLAY_NAME')
    assert.equal(hit.companions.enabledColumn, 'IS_ENABLED')
    assert.equal(hit.companions.typeColumn, 'FIELD_TYPE')

    const byAttr = Object.fromEntries(hit.entries.map((e) => [e.attrName, e]))
    assert.equal(byAttr.ISU_DATE.displayLabel, '下单日期')
    assert.equal(byAttr.ISU_DATE.enabled, 1)
    assert.equal(byAttr.ISU_DATE.type, 'date')
    assert.equal(byAttr.PART_CODE.displayLabel, '物料编码')
    assert.equal(byAttr.QTY.enabled, 0)
    assert.equal(byAttr.STATUS.displayLabel, '状态')
    // The junk row (key did not match any real column name) must never
    // surface as a mapping entry, however dictionary-shaped it looks.
    assert.equal(byAttr[JUNK_ROW_KEY], undefined)
    assert.equal(hit.entries.length, 4)
  })

  test('PER-ROW LEAK GUARD: an unmatched row inside an otherwise-passing dictionary table never leaks its companion values', async () => {
    const catalog = buildFixtureCatalog()
    const sampleFn = buildFixtureSampleFn()
    const { report } = await runProbe({ catalog, sampleFn })
    const serialized = JSON.stringify(report)

    assert.equal(serialized.includes(JUNK_ROW_KEY), false, 'junk row key must not leak')
    assert.equal(serialized.includes(JUNK_ROW_DISPLAY), false, 'junk row display label must not leak')
    // 'note' is short enough to risk a coincidental substring match elsewhere
    // in the JSON (e.g. inside "annotate"); assert via the leak-guard set
    // directly instead of a raw substring search on the serialized report.
    const { leakGuardValues } = await detectDictionaryTables({ catalog, sampleFn })
    assert.ok(leakGuardValues.has(JUNK_ROW_TYPE), 'junk row type value should be tracked by the leak guard')
  })

  test('threshold constant matches design doc (>=80%)', () => {
    assert.equal(DICTIONARY_MATCH_THRESHOLD, 0.8)
  })
})

// ---------------------------------------------------------------------------
// Dictionary detection — negative + leak guard
// ---------------------------------------------------------------------------

describe('detectDictionaryTables — negative and leak guard', () => {
  test('a small table whose values are NOT column names is never flagged', async () => {
    const catalog = buildFixtureCatalog()
    const sampleFn = buildFixtureSampleFn()
    const { dictionaries, screenedTables } = await detectDictionaryTables({ catalog, sampleFn })

    assert.equal(
      dictionaries.find((d) => d.table === 'dbo.T_MISC_SMALL'),
      undefined,
      'T_MISC_SMALL must not be flagged as a dictionary table',
    )
    const screened = screenedTables.find((s) => s.table === 'dbo.T_MISC_SMALL')
    assert.ok(screened, 'T_MISC_SMALL should appear in screenedTables with a reason')
    assert.equal(screened.reason, 'below_match_threshold')
    assert.equal(screened.bestMatchRatio, 0)
  })

  test('LEAK GUARD: unmatched sample values never reach the assembled report', async () => {
    const catalog = buildFixtureCatalog()
    const sampleFn = buildFixtureSampleFn()
    const { report } = await runProbe({ catalog, sampleFn })
    const serialized = JSON.stringify(report)

    for (const forbidden of NEGATIVE_UNMATCHED_VALUES) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `unmatched business value "${forbidden}" must never appear in the report`,
      )
    }
  })

  test('LEAK GUARD: assertValuesFree throws when a report contains a leak-guard-tracked value', () => {
    const leaked = { note: `this report accidentally contains ${NEGATIVE_UNMATCHED_VALUES[0]}` }
    assert.throws(
      () => assertValuesFree(leaked, { env: {}, leakGuardValues: new Set(NEGATIVE_UNMATCHED_VALUES) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('LEAK GUARD: assertValuesFree throws when a report contains a connection-env value', () => {
    const leaked = { note: 'connected to 10.0.0.5 as reported' }
    assert.throws(
      () => assertValuesFree(leaked, { env: { PROBE_MSSQL_SERVER: '10.0.0.5' }, leakGuardValues: new Set() }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('assertValuesFree does not throw on a clean report', () => {
    const clean = { note: 'nothing sensitive here', tables: ['dbo.T_ORDER_HEAD'] }
    assert.doesNotThrow(() =>
      assertValuesFree(clean, {
        env: { PROBE_MSSQL_SERVER: '10.0.0.5', PROBE_MSSQL_PASSWORD: 'hunter2' },
        leakGuardValues: new Set(NEGATIVE_UNMATCHED_VALUES),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Row-cap refusal
// ---------------------------------------------------------------------------

describe('row-cap guard', () => {
  test('sampleSmallTableRows refuses a table above SMALL_TABLE_ROW_CAP without calling sampleFn', async () => {
    const oversized = table('dbo', 'T_HUGE', SMALL_TABLE_ROW_CAP + 1, [col('NOTE', 'varchar')])
    let called = false
    await assert.rejects(
      () =>
        sampleSmallTableRows({
          sampleFn: async () => {
            called = true
            return []
          },
          table: oversized,
        }),
      /ROW_CAP_REFUSED/,
    )
    assert.equal(called, false, 'sampleFn must never be invoked for a table above the row cap')
  })

  test('a table with unknown (null) rowCount is treated as NOT small — refused', async () => {
    const unknown = table('dbo', 'T_UNKNOWN_SIZE', null, [col('NOTE', 'varchar')])
    assert.equal(isSmallTable(unknown), false)
    await assert.rejects(() => sampleSmallTableRows({ sampleFn: async () => [], table: unknown }), /ROW_CAP_REFUSED/)
  })

  test('detectDictionaryTables never calls sampleFn for an oversized table (T_HUGE)', async () => {
    const catalog = buildFixtureCatalog()
    const trackCalls = {}
    const sampleFn = buildFixtureSampleFn({ trackCalls })
    const { screenedTables } = await detectDictionaryTables({ catalog, sampleFn })

    assert.equal(trackCalls['dbo.T_HUGE'], undefined, 'sampleFn must never be called for T_HUGE')
    const screened = screenedTables.find((s) => s.table === 'dbo.T_HUGE')
    assert.ok(screened)
    assert.equal(screened.reason, 'row_cap_exceeded')
    assert.equal(screened.rowCount, 50000)
  })

  test('a misbehaving sampler that ignores its cap is rejected (defense in depth)', async () => {
    const small = table('dbo', 'T_SMALL', 2, [col('NOTE', 'varchar')])
    await assert.rejects(
      () =>
        sampleSmallTableRows({
          sampleFn: async () => Array.from({ length: 5 }, (_, i) => ({ NOTE: `v${i}` })),
          table: small,
          distinctCap: 3,
        }),
      /SAMPLE_CAP_EXCEEDED/,
    )
  })
})

// ---------------------------------------------------------------------------
// BOM head/detail pair detection — positive
// ---------------------------------------------------------------------------

describe('detectBomPairCandidates — positive', () => {
  test('detects T_ORDER_HEAD/T_ORDER_DETAIL as a medium-confidence BOM pair', () => {
    const catalog = buildFixtureCatalog()
    const candidates = detectBomPairCandidates(catalog)
    const hit = candidates.find((c) => c.head === 'dbo.T_ORDER_HEAD' && c.detail === 'dbo.T_ORDER_DETAIL')
    assert.ok(hit, 'expected a BOM pair candidate for T_ORDER_HEAD/T_ORDER_DETAIL')
    assert.equal(hit.headPrimaryKeyColumn, 'ORDER_ID')
    assert.equal(hit.detailParentIdColumn, 'ORDER_PID')
    assert.equal(hit.headPartColumn, 'MAIN_PART_CODE')
    assert.equal(hit.detailPartColumn, 'PART_CODE')
    assert.equal(hit.confidence, 'medium')
    assert.ok(hit.confidenceNotes.length > 0)
  })

  test('does not pair a table with itself', () => {
    const catalog = buildFixtureCatalog()
    const candidates = detectBomPairCandidates(catalog)
    assert.equal(
      candidates.find((c) => c.head === c.detail),
      undefined,
    )
  })
})

// ---------------------------------------------------------------------------
// Self-referencing tree detection
// ---------------------------------------------------------------------------

describe('detectTreeCandidates', () => {
  test('detects T_CATEGORY (ID/PARENT_ID, same type) as a tree candidate', () => {
    const catalog = buildFixtureCatalog()
    const candidates = detectTreeCandidates(catalog)
    const hit = candidates.find((c) => c.table === 'dbo.T_CATEGORY')
    assert.ok(hit)
    assert.equal(hit.idColumn, 'ID')
    assert.equal(hit.parentIdColumn, 'PARENT_ID')
    assert.equal(hit.dataType, 'int')
  })
})

// ---------------------------------------------------------------------------
// Quantity-column candidates
// ---------------------------------------------------------------------------

describe('detectQuantityCandidates', () => {
  test('ranks QTY above other numeric columns for the BOM detail table', () => {
    const catalog = buildFixtureCatalog()
    const bomPairCandidates = detectBomPairCandidates(catalog)
    const candidates = detectQuantityCandidates(catalog, bomPairCandidates)
    const detail = candidates.find((c) => c.table === 'dbo.T_ORDER_DETAIL')
    assert.ok(detail)
    assert.equal(detail.candidates[0].column, 'QTY')
    assert.equal(detail.candidates[0].nameMatchesQuantityPattern, true)
  })
})

// ---------------------------------------------------------------------------
// buildColumnNameIndex / existsElsewhere
// ---------------------------------------------------------------------------

describe('buildColumnNameIndex', () => {
  test('existsElsewhere is case-insensitive and excludes the table itself', () => {
    const catalog = buildFixtureCatalog()
    const index = buildColumnNameIndex(catalog)
    assert.equal(existsElsewhere(index, 'dbo.T_FIELD_DICT', 'order_id'), true)
    // FIELD_NAME only exists on T_FIELD_DICT itself -> not "elsewhere" for that table
    assert.equal(existsElsewhere(index, 'dbo.T_FIELD_DICT', 'field_name'), false)
    // ...but IS "elsewhere" from the point of view of a different excluded table
    assert.equal(existsElsewhere(index, 'dbo.T_ORDER_HEAD', 'field_name'), true)
  })
})

// ---------------------------------------------------------------------------
// buildReport is values-free of connection details by construction
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  test('never includes raw env values because it is never passed them', async () => {
    const catalog = buildFixtureCatalog()
    const sampleFn = buildFixtureSampleFn()
    const { report } = await runProbe({ catalog, sampleFn })
    // Structural assertion: the report object has no key resembling a
    // connection credential at all — not just "value absent by luck".
    const serialized = JSON.stringify(report).toLowerCase()
    for (const forbiddenKey of ['password', 'server', 'connectionstring', 'user']) {
      assert.equal(serialized.includes(`"${forbiddenKey}"`), false, `report must not carry a "${forbiddenKey}" field`)
    }
  })
})

// ---------------------------------------------------------------------------
// CLI: parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('requires --out to have a value', () => {
    assert.throws(() => parseArgs(['--out']), /requires a file path/)
  })

  test('rejects unknown arguments', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
  })

  test('parses --out and --help', () => {
    assert.deepEqual(parseArgs(['--out', 'x.json']), {
      out: 'x.json',
      help: false,
      emitDraft: false,
      preset: null,
      outDir: null,
    })
    assert.equal(parseArgs(['--help']).help, true)
  })
})

// ---------------------------------------------------------------------------
// CLI: main() — env validation and end-to-end file output via a fake dialect
// (never imports the real `mssql` package, so this test suite is hermetic).
// ---------------------------------------------------------------------------

describe('main()', () => {
  test('exits 2 with no DB env vars set (never argv-based)', async () => {
    const code = await main(['--out', 'unused.json'], {})
    assert.equal(code, 2)
  })

  test('exits 2 when --out is missing', async () => {
    const code = await main([], {
      PROBE_MSSQL_SERVER: 'host',
      PROBE_MSSQL_PORT: '1433',
      PROBE_MSSQL_DATABASE: 'db',
      PROBE_MSSQL_USER: 'u',
      PROBE_MSSQL_PASSWORD: 'p',
    })
    assert.equal(code, 2)
  })

  test('writes a values-free JSON report + markdown summary via an injected fake dialect', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'source-discovery-probe-'))
    const outPath = path.join(tmpDir, 'report.json')
    try {
      const catalog = buildFixtureCatalog()
      const sampleFn = buildFixtureSampleFn()
      const fakeDialect = {
        connect: async () => ({ fake: true }),
        close: async () => {},
        fetchCatalog: async () => catalog,
        sampleRows: async (_pool, t, cap) => sampleFn({ table: t, cap }),
      }
      const env = {
        PROBE_MSSQL_SERVER: 'sekrit-host.internal',
        PROBE_MSSQL_PORT: '1433',
        PROBE_MSSQL_DATABASE: 'sekrit-db',
        PROBE_MSSQL_USER: 'sekrit-user',
        PROBE_MSSQL_PASSWORD: 'sekrit-pass-123',
      }

      const code = await main(['--out', outPath], env, { dialects: { mssql: fakeDialect } })
      assert.equal(code, 0)
      assert.ok(existsSync(outPath))
      const mdPath = path.join(tmpDir, 'report.md')
      assert.ok(existsSync(mdPath))

      const jsonText = readFileSync(outPath, 'utf8')
      const mdText = readFileSync(mdPath, 'utf8')
      const parsed = JSON.parse(jsonText)
      assert.ok(parsed.dictionaries.find((d) => d.table === 'dbo.T_FIELD_DICT'))

      for (const secret of ['sekrit-host.internal', 'sekrit-db', 'sekrit-user', 'sekrit-pass-123']) {
        assert.equal(jsonText.includes(secret), false, `JSON output must not contain ${secret}`)
        assert.equal(mdText.includes(secret), false, `MD output must not contain ${secret}`)
      }
      for (const forbidden of NEGATIVE_UNMATCHED_VALUES) {
        assert.equal(jsonText.includes(forbidden), false)
        assert.equal(mdText.includes(forbidden), false)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('rejects an invalid PROBE_MSSQL_PORT with exit code 2', async () => {
    const code = await main(['--out', 'unused.json'], {
      PROBE_MSSQL_SERVER: 'host',
      PROBE_MSSQL_PORT: 'not-a-number',
      PROBE_MSSQL_DATABASE: 'db',
      PROBE_MSSQL_USER: 'u',
      PROBE_MSSQL_PASSWORD: 'p',
    })
    assert.equal(code, 2)
  })
})

describe('live-instance regressions (second wave: the first real CUSTOMER PLM, 277 tables)', () => {
  test('a SHORT ALL-ASCII guarded value does not fire inside this tool\'s own prose', () => {
    // Shape, structurally: of 1959 guarded values on the live instance, 237 were <= 3 characters,
    // and one two-character ASCII business value sat as a delimited token inside the tool's own
    // static sentence "no shared part-like column of matching type found between head and detail".
    // The run failed closed over a report that leaked nothing. This file's own comment had named the
    // case ("'no' is a substring of some structural string in every report") and only the NUMERIC
    // half was ever implemented.
    const prose = { schemaInventory: [], dictionaries: [], bomPairCandidates: [{ confidenceNotes: ['no shared part-like column of matching type found between head and detail'] }] }
    for (const short of ['no', 'of', 'on', 'low']) {
      assert.doesNotThrow(
        () => assertValuesFree(prose, { leakGuardValues: new Set([short]) }),
        `a ${short.length}-char ASCII value must not fire inside ordinary prose`,
      )
    }
    // NOTHING IS RETIRED: the same short value still fires as its own leaf...
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], stray: 'no' }, { leakGuardValues: new Set(['no']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
    // ...and a 4-character ASCII value is long enough that a prose collision is not credible, so it
    // keeps the token sweep.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], note: 'the head and detail rows' }, { leakGuardValues: new Set(['head']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
    // A short CJK value is not ASCII prose's problem and keeps firing as a delimited token.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], note: '单位: 件' }, { leakGuardValues: new Set(['件']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('a short connection value does not fire inside this tool\'s own constants', () => {
    // The customer database is named `plm`; this tool's frozen ownership vocabulary contains
    // `plm_system`. Every draft run failed closed on the tool's own literal.
    const report = { schemaInventory: [], dictionaries: [], draftEmission: { resolvedTargets: [{ ownership: 'plm_system' }] } }
    assert.doesNotThrow(() => assertValuesFree(report, { env: { PROBE_MSSQL_DATABASE: 'plm' } }))
    // It still fires as its own leaf, inside a sentence, and inside a connection string.
    for (const leaf of ['plm', 'connected to plm today', 'Server=x;Database=plm;Uid=y']) {
      assert.throws(
        () => assertValuesFree({ schemaInventory: [], dictionaries: [], stray: leaf }, { env: { PROBE_MSSQL_DATABASE: 'plm' } }),
        /VALUES_FREE_SELF_CHECK_FAILED/,
      )
    }
    // A long credential keeps the broadest possible sweep, substring and all.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], stray: 'xxhunter2-longpassxx' }, { env: { PROBE_MSSQL_PASSWORD: 'hunter2-longpass' } }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('the display-name column is chosen by COVERAGE x non-ASCII ratio, not ratio alone', () => {
    // The live shape, to scale: `ShowName` is populated on 73/73 rows and is almost entirely CJK;
    // a rarely-used template column is populated on 8/73, all CJK, so its ratio is a perfect 1.0 and
    // under ratio-alone it WON. Every row the winner had nothing for then read as "an enabled slot
    // with no label", both dictionaries yielded ZERO usable entries, and the draft came out empty —
    // a false negative shaped exactly like a correct answer.
    const rows = []
    for (let i = 0; i < 73; i += 1) {
      rows.push({
        Name: `ExAttr${i + 1}`,
        // Mostly CJK but not purely so, exactly like a real label column.
        ShowName: `属性${i + 1}`,
        filetemplatehead: i < 8 ? '模板' : null,
      })
    }
    const table = {
      schema: 'dbo',
      name: 'T_ATTR_DICT',
      rowCount: 73,
      columns: [
        col('Name', 'varchar'),
        col('ShowName', 'varchar'),
        col('filetemplatehead', 'nvarchar'),
      ],
    }
    const companions = detectCompanionColumns({ table, keyColumn: 'Name', rows })
    assert.equal(companions.displayNameColumn, 'ShowName')
    // The sparse column really does have the higher RATIO — that is why ratio alone lost.
    assert.equal(companions.displayNameNonAsciiRatio < 1, true)
  })
})

describe('live-instance regressions (all four found by the first real SQL Server run)', () => {
  test('a bigint row count arriving as a STRING is still a row count', () => {
    // SUM() over sys.partitions.rows returns bigint, which the driver hands back as a string. A
    // typeof check therefore yielded null for EVERY table; because unknown counts are treated as
    // over-cap (fail-closed), the run screened out every table and reported ZERO dictionaries --
    // a false negative shaped exactly like a valid answer. This is the guard against that.
    assert.equal(coerceRowCount('30'), 30)
    assert.equal(coerceRowCount(' 500 '), 500)
    assert.equal(coerceRowCount(30), 30)
    assert.equal(coerceRowCount(30n), 30)
    assert.equal(coerceRowCount('abc'), null)
    assert.equal(coerceRowCount(null), null)
    assert.equal(coerceRowCount(undefined), null)
  })

  test('a string row count under the cap makes the table samplable', () => {
    const table = { schema: 'dbo', name: 'Dict', rowCount: coerceRowCount('30'), columns: [] }
    assert.equal(isSmallTable(table, SMALL_TABLE_ROW_CAP), true)
  })

  test('a bare IP target is recognised so TLS is not asked to verify an address', () => {
    // encrypt:true against an IP fails before a single catalog row is read: the driver refuses to
    // set the TLS servername to an address. On-prem PLM/ERP hosts are reached by IP.
    assert.equal(isBareIpAddress('10.0.0.1'), true)
    assert.equal(isBareIpAddress(' 192.168.1.10 '), true)
    assert.equal(isBareIpAddress('[2001:db8::1]'), true)
    assert.equal(isBareIpAddress('plm.internal.example'), false)
    assert.equal(isBareIpAddress(''), false)
    assert.equal(isBareIpAddress(undefined), false)
  })

  test('CJK BOUNDARIES: embedded in a word no fire, delimited token fires, composition fires', () => {
    // Three shapes an adversarial pass proved must all come out right at once. The first fix here
    // exempted every non-ASCII value from the sweep, which got case 1 right by retiring the sweep —
    // and thereby got cases 2 and 3 wrong. Boundaries are decided by SCRIPT CONTINUATION instead.
    const guarded = new Set(['件'])
    // 1. 件 INSIDE 附件 — a matched dictionary row's label the report is entitled to emit. NO FIRE:
    //    CJK continues CJK, exactly as `workshop` does not match inside `base_workshop`.
    assert.doesNotThrow(() =>
      assertValuesFree(
        { schemaInventory: [], dictionaries: [{ table: 'dbo.T', keyColumn: 'c', companions: {}, entries: [{ attrName: 'part_ExAttr21', displayLabel: '附件' }] }] },
        { leakGuardValues: guarded },
      ),
    )
    // 2. 件 AS A DELIMITED TOKEN inside a longer sentence leaf. FIRES: a space is not CJK, so this
    //    is an occurrence, not a fragment. Retiring the sweep for the script lost exactly this.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], note: '单位: 件' }, { leakGuardValues: guarded }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
    // 3. A leaf that is nothing but two guarded values CONCATENATED. Neither piece equals the leaf
    //    and neither is delimited at the seam, yet the leaf carries both in full.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], note: '零件图纸' }, { leakGuardValues: new Set(['零件', '图纸']) }),
      /composed-sample-values/,
    )
    // ...and an ordinary leaf that merely contains one of them is not a composition.
    assert.doesNotThrow(() =>
      assertValuesFree({ schemaInventory: [], dictionaries: [], stray: 'A' }, { leakGuardValues: new Set(['零件', '图纸']) }),
    )
  })

  test('IDENTIFIER SUBTRACTION IS SCOPED: a value coinciding with a table name still fires elsewhere', () => {
    // Subtracting table names globally meant a sampled customer value that happened to equal a table
    // name (or the bare schema `dbo`) stopped firing anywhere at all.
    const identifiers = new Set(['dbo.t_unit', 't_unit', 'dbo'])
    const guarded = new Set(['T_UNIT'])
    // At an identifier field: legitimate output, no fire.
    assert.doesNotThrow(() =>
      assertValuesFree(
        { schemaInventory: [], dictionaries: [{ table: 'dbo.T_UNIT', keyColumn: 'c', companions: {}, entries: [] }] },
        { leakGuardValues: guarded, emittedIdentifiers: identifiers },
      ),
    )
    // OUTSIDE an identifier field, the same string is a customer value and still fires. (The
    // decoded-entry section is excluded by name for its own documented reason — see
    // isDecodedDictionaryEntryPath — so the scoping is demonstrated on an ordinary section.)
    assert.throws(
      () => assertValuesFree(
        { schemaInventory: [], dictionaries: [], someSection: { label: 'T_UNIT' } },
        { leakGuardValues: guarded, emittedIdentifiers: identifiers },
      ),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
    // ...and the bare schema name gets no free pass outside an identifier field either.
    assert.throws(
      () => assertValuesFree(
        { schemaInventory: [], dictionaries: [], someSection: { label: 'dbo' } },
        { leakGuardValues: new Set(['dbo']), emittedIdentifiers: identifiers },
      ),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('PROBE_SELF_CHECK_DIAG names the leaf PATH and the collector CATEGORY, never the value', () => {
    const guarded = new Set(['SEKRIT_LABEL'])
    const categories = new Map([['SEKRIT_LABEL', 'matched-row-companion-cell']])
    const report = { schemaInventory: [], dictionaries: [], someSection: { nested: ['SEKRIT_LABEL'] } }
    let message = ''
    try {
      assertValuesFree(report, { leakGuardValues: guarded, valueCategories: categories, diagnostics: true })
    } catch (err) { message = err.message }
    assert.match(message, /path=someSection\.nested\[0\]/)
    assert.match(message, /category=matched-row-companion-cell/)
    assert.match(message, /masked=S\*+L/)
    assert.equal(message.includes('SEKRIT_LABEL'), false, 'the value itself must never enter the message')
    // Without the flag the refusal is identical minus the diagnostics — the DECISION never depends
    // on it.
    let plain = ''
    try {
      assertValuesFree(report, { leakGuardValues: guarded, valueCategories: categories })
    } catch (err) { plain = err.message }
    assert.match(plain, /VALUES_FREE_SELF_CHECK_FAILED/)
    assert.equal(plain.includes('path='), false)
  })

  test('a NON-ASCII guarded value is compared whole-leaf, never as a substring', () => {
    // The whole-word sweep is meaningless around CJK: `isWordChar` recognises only [0-9a-z_], so
    // every position inside a CJK string is a "boundary" and containsAsWholeWord degrades to exactly
    // the naive substring test this guard rejects by name. The guard's own comment said a non-ASCII
    // value falls back to whole-leaf equality; until this change the code did not do it, and the
    // collision below -- a unit vocabulary carrying 件 alongside an attribute label 附件 that a
    // MATCHED dictionary row legitimately contributes -- failed the whole run closed over output that
    // leaked nothing.
    const report = {
      schemaInventory: [],
      dictionaries: [{ table: 'dbo.T_DICT', keyColumn: 'code', companions: {}, entries: [{ attrName: 'part_ExAttr21', displayLabel: '附件' }] }],
    }
    assert.doesNotThrow(() => assertValuesFree(report, { leakGuardValues: new Set(['件']) }))
    // ...and a real leak of the same value, arriving as its own leaf, is still caught.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], stray: '件' }, { leakGuardValues: new Set(['件']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
    // A multi-character CJK value leaked as its own leaf is caught too.
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], stray: '机密业务备注' }, { leakGuardValues: new Set(['机密业务备注']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })

  test('the values-free check compares whole leaves, not substrings', () => {
    // A guarded value that is an ordinary word ('workshop') is a substring of an identifier the
    // report is entitled to emit ('base_workshop'). Substring matching failed the run closed on
    // the tool's own output; equality still catches a value leaked as its own leaf.
    const report = { schemaInventory: [{ schema: 'dbo', name: 'T', columns: [{ name: 'base_workshop' }] }], dictionaries: [] }
    assert.doesNotThrow(() => assertValuesFree(report, { leakGuardValues: new Set(['workshop']) }))
    assert.throws(
      () => assertValuesFree({ schemaInventory: [], dictionaries: [], note: 'workshop' }, { leakGuardValues: new Set(['workshop']) }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })
})
