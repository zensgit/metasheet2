#!/usr/bin/env node
/**
 * source-discovery-probe.mjs
 *
 * H0 of docs/development/platform-overall-design/source-onboarding-self-service-design-20260830.md
 * (step ① 探测 — "connect read-only → read structure + dictionary tables → produce a list of
 * semantically-meaningful columns", fully automatic, zero business rows).
 *
 * STRUCTURE ONLY, VALUES-FREE BY CONSTRUCTION. This script enumerates a source database's
 * tables/columns/types/row-counts from catalog views, and applies a small set of dialect-agnostic
 * heuristics (dictionary-table detection, BOM head/detail pairing, self-referencing tree
 * detection, quantity-column candidates) to draft a structural onboarding map. It is
 * constitutionally incapable of reading arbitrary business rows:
 *
 *   - The ONLY data (non-catalog) read this script ever performs is: for a table whose row count
 *     (from sys.partitions metadata) is <= SMALL_TABLE_ROW_CAP, read up to DISTINCT_SAMPLE_CAP of
 *     its rows, and ONLY to test whether its text-column values look like OTHER tables' column
 *     names (the dictionary-table heuristic proven on the first customer PLM — see the design doc
 *     §4.1 / §9). A table above the cap is never sampled — see isSmallTable()/sampleSmallTableRows().
 *   - Any sampled value that does NOT match a column name elsewhere in the schema is counted
 *     (leak-guard bookkeeping only, kept OUT of the report object) and NEVER written to the
 *     output. Only matched attribute names + their companion "decoded entry" values (display
 *     label / enabled flag / type — the whole point of the dictionary heuristic is to recover
 *     these) reach the report, and only for rows whose key value matched a real column name.
 *   - assertValuesFree() re-scans the fully-assembled report's JSON serialization for every
 *     connection-env value and for every leak-guard-tracked unmatched sample value, and throws
 *     before anything is written to disk if any is found. This is a self-check on our own output,
 *     not a proof the heuristics above are bug-free — see the leak-guard test in the companion
 *     .test.mjs for the RED/GREEN evidence that it actually catches a regression.
 *
 * DIALECT: SQL Server only for now (mssql catalog views: sys.tables/sys.columns/sys.types/
 * sys.partitions). The DIALECTS registry below is the seam for adding MySQL/Postgres later — a
 * new dialect only needs to produce the same abstract `catalog` shape (see buildCatalogFromRows())
 * and a `sampleRows(pool, table, cap)` function; every detection heuristic below is dialect-free,
 * operating purely on that abstract shape.
 *
 * Input: connection via env ONLY — PROBE_MSSQL_SERVER / PROBE_MSSQL_PORT / PROBE_MSSQL_DATABASE /
 * PROBE_MSSQL_USER / PROBE_MSSQL_PASSWORD. Never argv (argv leaks into process listings/logs).
 * Output path via --out <file> (a values-free JSON report; a human-readable `.md` summary is
 * written alongside it, same basename).
 *
 * Usage:
 *   PROBE_MSSQL_SERVER=host PROBE_MSSQL_PORT=1433 PROBE_MSSQL_DATABASE=db \
 *   PROBE_MSSQL_USER=readonly_role PROBE_MSSQL_PASSWORD=*** \
 *     node scripts/ops/source-discovery-probe.mjs --out out/probe-report.json
 *
 * `mssql` is a dependency of packages/core-backend and plugins/plugin-integration-core, not of
 * this repo's root package.json — this script is invoked from the root but is not itself a
 * workspace package. If `node scripts/ops/source-discovery-probe.mjs` reports it cannot find
 * module 'mssql', point NODE_PATH at a workspace member that has it installed, the same pattern
 * already used by the root "verify:readonly-ui" script for apps/web-react:
 *   NODE_PATH=packages/core-backend/node_modules node scripts/ops/source-discovery-probe.mjs --out ...
 * This is a real, currently-unresolved packaging gap for this script's actual use as an ops tool
 * (as opposed to its hermetic test suite, which never imports `mssql` at all — see connect()).
 *
 * Exit codes:
 *   0  report produced (structural findings may be empty — that is a valid, informative result)
 *   1  unexpected runtime/DB error, or the values-free self-check refused to write the report
 *   2  required input missing (env vars or --out)
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')

// ---------------------------------------------------------------------------
// Thresholds (the whole heuristic budget — kept in one place, all overridable
// by callers/tests, never by CLI flags: the point of these numbers is that a
// customer/operator never has to think about them).
// ---------------------------------------------------------------------------

const SMALL_TABLE_ROW_CAP = 500 // dictionary-table candidacy: table eligibility bound
const DISTINCT_SAMPLE_CAP = 1000 // hard cap on rows a single sample query may return
const DICTIONARY_MATCH_THRESHOLD = 0.8 // >=80% of distinct key-column values must match a column name

const ENV_VAR_NAMES = Object.freeze([
  'PROBE_MSSQL_SERVER',
  'PROBE_MSSQL_PORT',
  'PROBE_MSSQL_DATABASE',
  'PROBE_MSSQL_USER',
  'PROBE_MSSQL_PASSWORD',
])

// ---------------------------------------------------------------------------
// Dialect-agnostic type classification. Each dialect module maps its own type
// vocabulary onto these three buckets before anything downstream sees it.
// ---------------------------------------------------------------------------

const MSSQL_TEXT_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext', 'xml'])
const MSSQL_NUMERIC_TYPES = new Set([
  'tinyint',
  'smallint',
  'int',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney',
  'bit',
])

function isTextType(dataType) {
  return MSSQL_TEXT_TYPES.has(String(dataType || '').toLowerCase())
}

function isNumericType(dataType) {
  return MSSQL_NUMERIC_TYPES.has(String(dataType || '').toLowerCase())
}

// ---------------------------------------------------------------------------
// Abstract catalog shape (dialect-free):
//   { dialect, tables: [{ schema, name, rowCount, columns: [
//       { name, dataType, maxLength, nullable, isPrimaryKey }
//   ]}] }
// rowCount is null when unknown (metadata gap) and MUST be treated as "not
// small" — never guess a table is safe to sample.
// ---------------------------------------------------------------------------

function tableKey(table) {
  return `${table.schema}.${table.name}`
}

function isSmallTable(table, cap = SMALL_TABLE_ROW_CAP) {
  return typeof table.rowCount === 'number' && Number.isFinite(table.rowCount) && table.rowCount <= cap
}

// Groups the flat catalog-view row set (one row per column) into the abstract
// table/column shape. Shared by every dialect's fetchCatalog().
function buildCatalogFromRows(dialectName, rows) {
  const byTable = new Map()
  for (const r of rows) {
    const key = `${r.schemaName}.${r.tableName}`
    if (!byTable.has(key)) {
      byTable.set(key, {
        schema: r.schemaName,
        name: r.tableName,
        rowCount: typeof r.rowCount === 'number' ? r.rowCount : null,
        columns: [],
      })
    }
    byTable.get(key).columns.push({
      name: r.columnName,
      dataType: r.dataType,
      maxLength: r.maxLength ?? null,
      nullable: !!r.nullable,
      isPrimaryKey: !!r.isPrimaryKey,
    })
  }
  return { dialect: dialectName, tables: [...byTable.values()] }
}

function escapeMssqlIdentifier(name) {
  return `[${String(name).replace(/]/g, ']]')}]`
}

// ---------------------------------------------------------------------------
// mssql dialect module. `mssql` is imported lazily inside connect() so that a
// hermetic `node --test` run (no pnpm install / no node_modules) never fails
// at module-load time before a single test runs — see createPgExecutor() in
// scripts/ops/data-source-exposure-inventory.mjs for the same pattern.
// ---------------------------------------------------------------------------

const MSSQL_CATALOG_QUERY = `
SELECT
  s.name AS schemaName,
  t.name AS tableName,
  c.name AS columnName,
  ty.name AS dataType,
  c.max_length AS maxLength,
  c.is_nullable AS nullable,
  CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey,
  p.rows AS rowCount
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id
  FROM sys.index_columns ic
  JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
  WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
LEFT JOIN (
  SELECT object_id, SUM(rows) AS rows
  FROM sys.partitions
  WHERE index_id IN (0, 1)
  GROUP BY object_id
) p ON p.object_id = t.object_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id
`

const mssqlDialect = {
  name: 'mssql',
  isTextType,
  isNumericType,

  async connect(env) {
    const server = (env.PROBE_MSSQL_SERVER || '').trim()
    const database = (env.PROBE_MSSQL_DATABASE || '').trim()
    const user = (env.PROBE_MSSQL_USER || '').trim()
    const password = env.PROBE_MSSQL_PASSWORD || ''
    const portRaw = (env.PROBE_MSSQL_PORT || '').trim()
    const missing = []
    if (!server) missing.push('PROBE_MSSQL_SERVER')
    if (!database) missing.push('PROBE_MSSQL_DATABASE')
    if (!user) missing.push('PROBE_MSSQL_USER')
    if (!password) missing.push('PROBE_MSSQL_PASSWORD')
    if (!portRaw) missing.push('PROBE_MSSQL_PORT')
    if (missing.length > 0) {
      throw new Error(`PROBE_ENV_MISSING: ${missing.join(', ')}`)
    }
    const port = Number(portRaw)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('PROBE_ENV_INVALID: PROBE_MSSQL_PORT must be a positive integer port number')
    }

    // Lazy import — see module header comment.
    const { default: mssql } = await import('mssql')
    const pool = await mssql.connect({
      server,
      port,
      database,
      user,
      password,
      options: { trustServerCertificate: true, encrypt: true },
      pool: { max: 2 },
    })
    return pool
  },

  async close(pool) {
    if (pool && typeof pool.close === 'function') await pool.close()
  },

  async fetchCatalog(pool) {
    const result = await pool.request().query(MSSQL_CATALOG_QUERY)
    return buildCatalogFromRows('mssql', result.recordset)
  },

  // Reads up to `cap` full rows of ALL columns of `table`. This single read
  // serves every downstream heuristic that needs row-correlated values
  // (dictionary key-column candidacy AND its companion display/enabled/type
  // values come from the SAME row) — see sampleSmallTableRows() for the
  // row-cap guard that must run before this is ever called.
  async sampleRows(pool, table, cap) {
    const columnList = table.columns.map((c) => escapeMssqlIdentifier(c.name)).join(', ')
    const qualified = `${escapeMssqlIdentifier(table.schema)}.${escapeMssqlIdentifier(table.name)}`
    const boundedCap = Math.max(0, Math.min(cap, DISTINCT_SAMPLE_CAP))
    const result = await pool.request().query(`SELECT TOP (${boundedCap}) ${columnList} FROM ${qualified}`)
    return result.recordset.map((row) => {
      const out = {}
      for (const c of table.columns) out[c.name] = row[c.name]
      return out
    })
  },
}

const DIALECTS = Object.freeze({ mssql: mssqlDialect })

// ---------------------------------------------------------------------------
// Row-cap guard. This is the single choke point every sampling call must go
// through — detectDictionaryTables() never calls a dialect's sampleRows()
// directly, only through this wrapper.
// ---------------------------------------------------------------------------

async function sampleSmallTableRows({ sampleFn, table, cap = SMALL_TABLE_ROW_CAP, distinctCap = DISTINCT_SAMPLE_CAP }) {
  if (!isSmallTable(table, cap)) {
    throw new Error(
      `ROW_CAP_REFUSED: table ${tableKey(table)} rowCount=${table.rowCount ?? 'unknown'} exceeds the dictionary-detection sampling cap (${cap}) — refusing to read any row from it`,
    )
  }
  const rows = await sampleFn({ table, cap: distinctCap })
  if (rows.length > distinctCap) {
    // Defense in depth: a misbehaving sampler ignored the cap it was given.
    throw new Error(`SAMPLE_CAP_EXCEEDED: sampler for ${tableKey(table)} returned ${rows.length} rows (cap ${distinctCap})`)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Column-name index — "does this value match a column name elsewhere in the
// schema" (design doc §4.1: 若某列的行值集合 ⊆ 其他表的列名集合).
// ---------------------------------------------------------------------------

function buildColumnNameIndex(catalog) {
  const locations = new Map() // lowercase name -> Set(tableKey)
  const canonical = new Map() // lowercase name -> first-seen original-case name
  for (const table of catalog.tables) {
    const key = tableKey(table)
    for (const col of table.columns) {
      const lower = col.name.toLowerCase()
      if (!locations.has(lower)) locations.set(lower, new Set())
      locations.get(lower).add(key)
      if (!canonical.has(lower)) canonical.set(lower, col.name)
    }
  }
  return { locations, canonical }
}

// "elsewhere" = some table OTHER than excludeKey carries this column name.
function existsElsewhere(index, excludeKey, lowerName) {
  const set = index.locations.get(lowerName)
  if (!set) return false
  if (set.size > 1) return true
  return !set.has(excludeKey)
}

function distinctNonNull(values) {
  const seen = new Set()
  const out = []
  for (const v of values) {
    if (v === null || v === undefined) continue
    const s = String(v)
    if (seen.has(s)) continue
    seen.add(s)
    out.push(v)
  }
  return out
}

function valueOrNull(v) {
  return v === undefined ? null : v
}

function normalize(v) {
  return String(v).trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Companion-column heuristics (design doc §4.1 / task spec): display-name =
// highest non-ASCII ratio text column; enabled-flag = numeric column named
// like isable/enabled/is_show; type column = named like type. These are
// metadata-only EXCEPT display-name, which needs the values already fetched
// by the one permitted read (no extra query).
// ---------------------------------------------------------------------------

const ENABLED_FLAG_NAME_PATTERN = /is[_-]?able|enab(?:le)?d?|is[_-]?show/i
const TYPE_NAME_PATTERN = /type/i

function nonAsciiRatio(values) {
  let nonAscii = 0
  let total = 0
  for (const v of values) {
    for (const ch of String(v)) {
      total += 1
      if (ch.codePointAt(0) > 127) nonAscii += 1
    }
  }
  return total === 0 ? 0 : nonAscii / total
}

function detectCompanionColumns({ table, keyColumn, rows }) {
  const otherColumns = table.columns.filter((c) => c.name !== keyColumn)

  let displayNameColumn = null
  let displayNameRatio = null
  for (const col of otherColumns) {
    if (!isTextType(col.dataType)) continue
    const values = distinctNonNull(rows.map((r) => r[col.name]))
    if (values.length === 0) continue
    const ratio = nonAsciiRatio(values)
    if (displayNameRatio === null || ratio > displayNameRatio) {
      displayNameRatio = ratio
      displayNameColumn = col.name
    }
  }

  const enabledColumn = otherColumns.find((c) => isNumericType(c.dataType) && ENABLED_FLAG_NAME_PATTERN.test(c.name)) ?? null
  const typeColumn = otherColumns.find((c) => c.name !== displayNameColumn && TYPE_NAME_PATTERN.test(c.name)) ?? null

  return {
    displayNameColumn,
    displayNameNonAsciiRatio: displayNameRatio,
    enabledColumn: enabledColumn ? enabledColumn.name : null,
    typeColumn: typeColumn ? typeColumn.name : null,
  }
}

// Builds the mapping rows (attrName -> displayLabel/enabled/type). Only rows
// whose key value matched a real column name elsewhere contribute an entry —
// this is what keeps the companion values (which ARE written to the report)
// values-free: they are only ever surfaced for a row we have independently
// verified is a schema-identifier row, never for an arbitrary business row.
function buildMappingRows({ rows, keyColumn, index, excludeKey, companions }) {
  const entries = new Map() // lowercase attrName -> entry
  let collisionCount = 0
  for (const row of rows) {
    const raw = row[keyColumn]
    if (raw === null || raw === undefined) continue
    const norm = normalize(raw)
    if (!existsElsewhere(index, excludeKey, norm)) continue
    const attrName = index.canonical.get(norm) ?? norm
    const entry = {
      attrName,
      displayLabel: companions.displayNameColumn ? valueOrNull(row[companions.displayNameColumn]) : null,
      enabled: companions.enabledColumn ? valueOrNull(row[companions.enabledColumn]) : null,
      type: companions.typeColumn ? valueOrNull(row[companions.typeColumn]) : null,
    }
    const dedupeKey = attrName.toLowerCase()
    if (entries.has(dedupeKey)) {
      collisionCount += 1
    } else {
      entries.set(dedupeKey, entry)
    }
  }
  return { entries: [...entries.values()], collisionCount }
}

// ---------------------------------------------------------------------------
// Dictionary-table detection (task step 2 / design doc §4.1).
// ---------------------------------------------------------------------------

async function detectDictionaryTables({
  catalog,
  sampleFn,
  rowCap = SMALL_TABLE_ROW_CAP,
  distinctCap = DISTINCT_SAMPLE_CAP,
  matchThreshold = DICTIONARY_MATCH_THRESHOLD,
}) {
  const index = buildColumnNameIndex(catalog)
  const dictionaries = []
  const screenedTables = []
  // Leak-guard bookkeeping ONLY — never attached to the report object, never
  // serialized. See assertValuesFree(), which re-scans the final report for
  // any of these values as an independent, load-bearing second check.
  const leakGuardValues = new Set()

  for (const table of catalog.tables) {
    const key = tableKey(table)
    if (!isSmallTable(table, rowCap)) {
      screenedTables.push({ table: key, reason: 'row_cap_exceeded', rowCount: table.rowCount ?? null })
      continue
    }
    const textColumns = table.columns.filter((c) => isTextType(c.dataType))
    if (textColumns.length === 0) {
      screenedTables.push({ table: key, reason: 'no_text_columns' })
      continue
    }

    let rows
    try {
      rows = await sampleSmallTableRows({ sampleFn, table, cap: rowCap, distinctCap })
    } catch (err) {
      screenedTables.push({ table: key, reason: 'sampler_error', detail: String(err && err.message ? err.message : err) })
      continue
    }

    // Score every text column as a key-column candidate. This is pure
    // in-memory bookkeeping — nothing is added to leakGuardValues yet,
    // because we don't yet know whether this table qualifies as a
    // dictionary, and a losing candidate column here may turn out to be a
    // legitimate display-name/type COMPANION of the winning key column
    // (whose values are supposed to reach the output for matched rows).
    // Tagging every non-matching candidate value as "forbidden" at this
    // stage would wrongly flag a dictionary's own decoded display labels.
    let best = null
    const perColumnStats = []
    for (const col of textColumns) {
      const distinctValues = distinctNonNull(rows.map((r) => r[col.name]))
      if (distinctValues.length === 0) continue
      let matched = 0
      for (const v of distinctValues) {
        if (existsElsewhere(index, key, normalize(v))) matched += 1
      }
      const ratio = matched / distinctValues.length
      const stat = { column: col.name, ratio, matchedCount: matched, totalDistinct: distinctValues.length, distinctValues }
      perColumnStats.push(stat)
      if (!best || ratio > best.ratio) best = stat
    }

    if (!best || best.ratio < matchThreshold) {
      // The whole table fails candidacy: NONE of its data will ever reach
      // the report, so every genuinely-unmatched value seen on any
      // candidate column is now permanently forbidden from the output.
      for (const stat of perColumnStats) {
        for (const v of stat.distinctValues) {
          if (!existsElsewhere(index, key, normalize(v))) leakGuardValues.add(String(v))
        }
      }
      screenedTables.push({
        table: key,
        reason: 'below_match_threshold',
        bestColumn: best ? best.column : null,
        bestMatchRatio: best ? best.ratio : null,
        totalDistinctCount: best ? best.totalDistinct : null,
        matchedDistinctCount: best ? best.matchedCount : null,
      })
      continue
    }

    // Confirmed dictionary. The winning key column's own unmatched distinct
    // values are excluded from the mapping by construction (buildMappingRows
    // only emits rows whose key matched) — guard them explicitly too.
    for (const v of best.distinctValues) {
      if (!existsElsewhere(index, key, normalize(v))) leakGuardValues.add(String(v))
    }

    const companions = detectCompanionColumns({ table, keyColumn: best.column, rows })

    // Row-level guard: a row whose key value did NOT match a real column
    // name elsewhere is not a verified schema-identifier row — it could be
    // anything (a stray note, a placeholder, real business data). NONE of
    // that row's column values, including what would otherwise look like a
    // companion display/enabled/type value, may reach the report. A row
    // whose key DID match is the one case where companion values are
    // intentionally exposed (that is the entire point of this heuristic).
    for (const row of rows) {
      const rawKey = row[best.column]
      const matchedRow = rawKey !== null && rawKey !== undefined && existsElsewhere(index, key, normalize(rawKey))
      if (matchedRow) continue
      // Text columns only — a numeric/bit flag (e.g. an unmatched row's
      // enabled=1) has such low cardinality that guarding it would produce
      // near-certain false positives against the report's own counts/ratios
      // without meaningfully protecting anything; it is also never written
      // to the output regardless (buildMappingRows only emits matched rows).
      for (const col of table.columns) {
        if (!isTextType(col.dataType)) continue
        const v = row[col.name]
        if (v !== null && v !== undefined) leakGuardValues.add(String(v))
      }
    }

    const mapping = buildMappingRows({ rows, keyColumn: best.column, index, excludeKey: key, companions })

    dictionaries.push({
      table: key,
      keyColumn: best.column,
      matchRatio: best.ratio,
      matchedDistinctCount: best.matchedCount,
      totalDistinctCount: best.totalDistinct,
      unmatchedDistinctCount: best.totalDistinct - best.matchedCount,
      companions,
      entryCollisionCount: mapping.collisionCount,
      entries: mapping.entries,
    })
  }

  return { dictionaries, screenedTables, leakGuardValues }
}

// ---------------------------------------------------------------------------
// BOM head/detail pair detection (task step 3 / design doc §4.2). Metadata
// only — no data read.
// ---------------------------------------------------------------------------

const PID_LIKE_PATTERN = /pid|parent/i
const PART_LIKE_PATTERN = /part|item|material|物料|编码|matcode/i

function findPrimaryKeyColumn(table) {
  return table.columns.find((c) => c.isPrimaryKey) ?? null
}

function detectBomPairCandidates(catalog) {
  const candidates = []
  for (const head of catalog.tables) {
    const headPk = findPrimaryKeyColumn(head)
    if (!headPk) continue
    const headPartColumn = head.columns.find((c) => PART_LIKE_PATTERN.test(c.name)) ?? null

    for (const detail of catalog.tables) {
      if (detail === head) continue
      const pidColumn = detail.columns.find((c) => PID_LIKE_PATTERN.test(c.name) && c.dataType === headPk.dataType)
      if (!pidColumn) continue
      const detailPartColumn = detail.columns.find((c) => PART_LIKE_PATTERN.test(c.name)) ?? null

      const confidenceNotes = []
      let confidence = 'low'
      if (headPartColumn && detailPartColumn && headPartColumn.dataType === detailPartColumn.dataType) {
        confidence = 'medium'
        confidenceNotes.push(
          `shared part-like column head.${headPartColumn.name} / detail.${detailPartColumn.name} with matching type ${headPartColumn.dataType}`,
        )
      } else {
        confidenceNotes.push('no shared part-like column of matching type found between head and detail — low confidence')
      }

      candidates.push({
        head: tableKey(head),
        detail: tableKey(detail),
        headPrimaryKeyColumn: headPk.name,
        detailParentIdColumn: pidColumn.name,
        headPartColumn: headPartColumn ? headPartColumn.name : null,
        detailPartColumn: detailPartColumn ? detailPartColumn.name : null,
        confidence,
        confidenceNotes,
      })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Self-referencing tree detection (task step 4 / design doc §4.5). Metadata
// only — no data read.
// ---------------------------------------------------------------------------

const PARENT_ID_NAME_PATTERN = /parent.*id|p[_-]?id$/i

function detectTreeCandidates(catalog) {
  const candidates = []
  for (const table of catalog.tables) {
    const idColumn = findPrimaryKeyColumn(table) ?? table.columns.find((c) => /^id$/i.test(c.name)) ?? null
    if (!idColumn) continue
    const parentColumn = table.columns.find(
      (c) => c.name !== idColumn.name && PARENT_ID_NAME_PATTERN.test(c.name) && c.dataType === idColumn.dataType,
    )
    if (!parentColumn) continue
    candidates.push({
      table: tableKey(table),
      idColumn: idColumn.name,
      parentIdColumn: parentColumn.name,
      dataType: idColumn.dataType,
    })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Quantity-column candidates per BOM detail table (task step 5). Metadata
// only — no data read.
// ---------------------------------------------------------------------------

const QUANTITY_NAME_PATTERN = /qty|quantity|num(?:ber)?|count|数量/i

function detectQuantityCandidates(catalog, bomPairCandidates) {
  const detailKeys = new Set(bomPairCandidates.map((c) => c.detail))
  const results = []
  for (const table of catalog.tables) {
    const key = tableKey(table)
    if (!detailKeys.has(key)) continue
    const numericColumns = table.columns.filter((c) => isNumericType(c.dataType) && c.dataType !== 'bit')
    if (numericColumns.length === 0) continue
    const ranked = numericColumns
      .map((c) => ({ column: c.name, dataType: c.dataType, nameMatchesQuantityPattern: QUANTITY_NAME_PATTERN.test(c.name) }))
      .sort((a, b) => Number(b.nameMatchesQuantityPattern) - Number(a.nameMatchesQuantityPattern))
    results.push({ table: key, candidates: ranked })
  }
  return results
}

// ---------------------------------------------------------------------------
// Report assembly + values-free self-check.
// ---------------------------------------------------------------------------

function buildSchemaInventory(catalog) {
  return catalog.tables.map((t) => ({
    table: tableKey(t),
    rowCount: t.rowCount,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      maxLength: c.maxLength,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
    })),
  }))
}

function buildReport({ catalog, dictionaryResult, bomPairCandidates, treeCandidates, quantityCandidates }) {
  return {
    generatedAt: new Date().toISOString(),
    dialect: catalog.dialect,
    thresholds: {
      smallTableRowCap: SMALL_TABLE_ROW_CAP,
      distinctSampleCap: DISTINCT_SAMPLE_CAP,
      dictionaryMatchThreshold: DICTIONARY_MATCH_THRESHOLD,
    },
    schemaInventory: buildSchemaInventory(catalog),
    dictionaries: dictionaryResult.dictionaries,
    screenedTables: dictionaryResult.screenedTables,
    bomPairCandidates,
    treeCandidates,
    quantityCandidates,
    limits: {
      note:
        'Structure + dictionary-table decoded entries only. No business row was read from any table above the row cap, and no unmatched sampled value from a small table appears anywhere in this report — see the leak-guard test in source-discovery-probe.test.mjs.',
    },
  }
}

// Collects every STRING leaf value in a JSON-shaped structure — deliberately
// NEVER object keys. A naive JSON.stringify()+substring scan cannot make
// that distinction (both a key and a string value serialize as `"text"`),
// which caused a real false positive during development: this script's own
// static `limits.note` field KEY collided with an unrelated leak-guard VALUE
// "note". Walking actual value leaves avoids that whole class of collision.
function collectStringLeaves(value, out) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectStringLeaves(v, out)
  }
}

// Independent, load-bearing second check: re-walks the FINAL report's string
// values for (a) every connection-env value and (b) every value the
// dictionary detector saw but could not match to a column name. Throws
// (refusing to write output) if either is found — see the module header.
// Scoped to string leaves only (see collectStringLeaves) — numbers/booleans
// are never scanned, and neither are object keys.
function assertValuesFree(report, { env = {}, leakGuardValues = new Set() } = {}) {
  const leaves = []
  collectStringLeaves(report, leaves)
  const violations = []

  for (const name of ENV_VAR_NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value.length > 0 && leaves.some((leaf) => leaf.includes(value))) {
      violations.push(`env:${name}`)
    }
  }

  for (const value of leakGuardValues) {
    const s = String(value)
    if (s.length === 0) continue
    if (leaves.some((leaf) => leaf.includes(s))) {
      violations.push('unmatched-sample-value')
      break // one is enough to fail closed; do not enumerate business data into an error message
    }
  }

  if (violations.length > 0) {
    throw new Error(`VALUES_FREE_SELF_CHECK_FAILED: report would have leaked: ${violations.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering — same data as the JSON report, human-readable.
// ---------------------------------------------------------------------------

function renderMarkdownSummary(report) {
  const lines = []
  lines.push(`# Source discovery probe report`)
  lines.push('')
  lines.push(`- generated: ${report.generatedAt}`)
  lines.push(`- dialect: ${report.dialect}`)
  lines.push(`- tables scanned: ${report.schemaInventory.length}`)
  lines.push(
    `- thresholds: smallTableRowCap=${report.thresholds.smallTableRowCap}, distinctSampleCap=${report.thresholds.distinctSampleCap}, dictionaryMatchThreshold=${report.thresholds.dictionaryMatchThreshold}`,
  )
  lines.push('')

  lines.push(`## Dictionary tables (${report.dictionaries.length})`)
  if (report.dictionaries.length === 0) {
    lines.push('_none detected_')
  }
  for (const d of report.dictionaries) {
    lines.push('')
    lines.push(`### ${d.table}`)
    lines.push(
      `- key column: \`${d.keyColumn}\` (matchRatio=${d.matchRatio.toFixed(2)}, matched=${d.matchedDistinctCount}/${d.totalDistinctCount}, unmatched=${d.unmatchedDistinctCount})`,
    )
    lines.push(
      `- companions: displayName=\`${d.companions.displayNameColumn ?? '(none)'}\`, enabled=\`${d.companions.enabledColumn ?? '(none)'}\`, type=\`${d.companions.typeColumn ?? '(none)'}\``,
    )
    if (d.entryCollisionCount > 0) lines.push(`- entry collisions (duplicate attrName rows, kept first): ${d.entryCollisionCount}`)
    lines.push('')
    lines.push('| attrName | displayLabel | enabled | type |')
    lines.push('|---|---|---|---|')
    for (const e of d.entries) {
      lines.push(`| ${e.attrName} | ${e.displayLabel ?? ''} | ${e.enabled ?? ''} | ${e.type ?? ''} |`)
    }
  }

  lines.push('')
  lines.push(`## BOM head/detail candidates (${report.bomPairCandidates.length})`)
  for (const c of report.bomPairCandidates) {
    lines.push(
      `- ${c.head} (pk=${c.headPrimaryKeyColumn}) -> ${c.detail} (fk=${c.detailParentIdColumn}) — confidence: ${c.confidence} (${c.confidenceNotes.join('; ')})`,
    )
  }

  lines.push('')
  lines.push(`## Self-referencing tree candidates (${report.treeCandidates.length})`)
  for (const t of report.treeCandidates) {
    lines.push(`- ${t.table}: id=${t.idColumn}, parentId=${t.parentIdColumn} (${t.dataType})`)
  }

  lines.push('')
  lines.push(`## Quantity-column candidates per BOM detail table`)
  for (const q of report.quantityCandidates) {
    const cols = q.candidates.map((c) => `${c.column}${c.nameMatchesQuantityPattern ? ' *' : ''}`).join(', ')
    lines.push(`- ${q.table}: ${cols}`)
  }

  lines.push('')
  lines.push('_(\\* = column name matches a quantity-like pattern)_')
  lines.push('')
  lines.push(`> ${report.limits.note}`)
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// End-to-end orchestration — a pure function of (catalog, sampleFn); no I/O.
// ---------------------------------------------------------------------------

async function runProbe({ catalog, sampleFn }) {
  const dictionaryResult = await detectDictionaryTables({ catalog, sampleFn })
  const bomPairCandidates = detectBomPairCandidates(catalog)
  const treeCandidates = detectTreeCandidates(catalog)
  const quantityCandidates = detectQuantityCandidates(catalog, bomPairCandidates)
  const report = buildReport({ catalog, dictionaryResult, bomPairCandidates, treeCandidates, quantityCandidates })
  return { report, leakGuardValues: dictionaryResult.leakGuardValues }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--out': {
        const value = argv[++i]
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('--out requires a file path argument')
        }
        opts.out = value
        break
      }
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return opts
}

function printHelp() {
  process.stdout.write(
    [
      'source-discovery-probe.mjs — structure + dictionary-table detection, values-free by construction (H0)',
      '',
      'Usage:',
      '  PROBE_MSSQL_SERVER=... PROBE_MSSQL_PORT=... PROBE_MSSQL_DATABASE=... \\',
      '  PROBE_MSSQL_USER=... PROBE_MSSQL_PASSWORD=... \\',
      '    node scripts/ops/source-discovery-probe.mjs --out <file.json>',
      '',
      'Writes <file.json> and a human-readable <file>.md summary alongside it.',
      '',
    ].join('\n'),
  )
}

function writeError(reason) {
  process.stderr.write(`[source-discovery-probe] ERROR: ${reason}\n`)
}

function mdPathFor(outPath) {
  const ext = path.extname(outPath)
  const base = ext ? outPath.slice(0, -ext.length) : outPath
  return `${base}.md`
}

async function main(argv = process.argv.slice(2), env = process.env, { dialects = DIALECTS } = {}) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    writeError(err.message)
    return 2
  }
  if (opts.help) {
    printHelp()
    return 0
  }
  if (!opts.out) {
    writeError('--out <file> is required')
    return 2
  }

  const dialect = dialects.mssql

  let pool = null
  try {
    pool = await dialect.connect(env)
    const catalog = await dialect.fetchCatalog(pool)
    const sampleFn = ({ table, cap }) => dialect.sampleRows(pool, table, cap)

    const { report, leakGuardValues } = await runProbe({ catalog, sampleFn })

    // Load-bearing: refuses to write anything if the self-check fails.
    assertValuesFree(report, { env, leakGuardValues })

    const outDir = path.dirname(path.resolve(opts.out))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8')
    writeFileSync(mdPathFor(opts.out), renderMarkdownSummary(report), 'utf8')

    process.stdout.write(
      `[source-discovery-probe] wrote ${opts.out} (${report.schemaInventory.length} tables, ${report.dictionaries.length} dictionaries, ${report.bomPairCandidates.length} BOM candidates, ${report.treeCandidates.length} tree candidates)\n`,
    )
    return 0
  } catch (err) {
    if (err && /^PROBE_ENV_(MISSING|INVALID):/.test(err.message)) {
      writeError(err.message)
      return 2
    }
    writeError(err && err.message ? err.message : String(err))
    return 1
  } finally {
    if (pool) {
      try {
        await dialect.close(pool)
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
const isEntry = entryPath && entryPath === fileURLToPath(import.meta.url)
if (isEntry) {
  main().then((code) => {
    process.exitCode = code
  })
}

export {
  SMALL_TABLE_ROW_CAP,
  DISTINCT_SAMPLE_CAP,
  DICTIONARY_MATCH_THRESHOLD,
  ENV_VAR_NAMES,
  isTextType,
  isNumericType,
  tableKey,
  isSmallTable,
  buildCatalogFromRows,
  buildColumnNameIndex,
  existsElsewhere,
  sampleSmallTableRows,
  detectCompanionColumns,
  buildMappingRows,
  detectDictionaryTables,
  detectBomPairCandidates,
  detectTreeCandidates,
  detectQuantityCandidates,
  buildSchemaInventory,
  buildReport,
  assertValuesFree,
  renderMarkdownSummary,
  runProbe,
  parseArgs,
  main,
  DIALECTS,
  REPO_ROOT,
}
