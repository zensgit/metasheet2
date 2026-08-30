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

// SUM() over a bigint column (sys.partitions.rows) comes back from the SQL Server driver as a
// STRING, not a number. A naive typeof check therefore yields null for EVERY table, and because an
// unknown row count is treated as 'over the cap' (fail-closed, by design), the whole run screens
// out every table and reports zero dictionaries -- a false negative that looks exactly like a valid
// answer. Coerce numeric-looking strings; keep null for anything genuinely unknown.
function coerceRowCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
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
        rowCount: coerceRowCount(r.rowCount),
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
  -- [rowCount] and rowTotal are BRACKETED / renamed on purpose: ROWCOUNT and ROWS are reserved
  -- words in SQL Server (SET ROWCOUNT / @@ROWCOUNT; ROWS in OFFSET-FETCH and window frames).
  -- An unbracketed reserved alias breaks the parse, and the engine reports the failure at the
  -- NEXT token -- the derived-table alias -- which reads as a nonsense complaint about a join.
  p.rowTotal AS [rowCount]
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
  -- ROWS is a reserved word in SQL Server (OFFSET/FETCH, window frames): aliasing to it
  -- breaks the parse and the error surfaces at the NEXT token, which reads as a nonsense
  -- complaint about the derived-table alias. Alias to a non-reserved name instead.
  SELECT object_id, SUM(rows) AS rowTotal
  FROM sys.partitions
  WHERE index_id IN (0, 1)
  GROUP BY object_id
) p ON p.object_id = t.object_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id
`

function isBareIpAddress(host) {
  if (typeof host !== 'string') return false
  const trimmed = host.trim()
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(trimmed)) return true
  return trimmed.startsWith('[') || trimmed.includes(':')
}

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
      // TLS negotiates against a SERVER NAME. When `server` is a bare IP -- the common case for an
      // on-prem PLM/ERP on a LAN -- the driver refuses to set the TLS servername to an address
      // ('Setting the TLS ServerName to an IP address is not permitted'), so encrypt:true fails
      // before a single catalog row is read. Discovery reads schema metadata only, over a link the
      // deployment already trusts for its data-source connections, so an IP target negotiates
      // without encryption rather than failing on a name it structurally cannot verify. A HOSTNAME
      // target keeps encryption ON.
      options: { trustServerCertificate: true, encrypt: !isBareIpAddress(server) },
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
// A word-character-adjacency test, written out rather than done with a RegExp so the guarded value
// never has to be escaped into a pattern (an escaping slip here would silently weaken the guard).
function containsAsWholeWord(haystack, needle) {
  if (!needle) return false
  const isWordChar = (ch) => ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'z' || ch === '_'
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : haystack[at - 1]
    const after = haystack[at + needle.length] || ''
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
}
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

  // MATCHING PRECISION. A raw `includes` on every guarded value fires on any SHORT value -- a
  // dictionary's unmatched '1' / '0' / 'no' is a substring of some structural string in every
  // report -- which fails the run closed on a leak that never happened. A real leak surfaces as a
  // whole leaf value, so compare by EQUALITY, and keep the substring sweep only for values long
  // enough that an accidental collision is not credible. Fail-closed remains the default on any
  // genuine match.
  // WHAT THE GUARDED-VALUE SWEEP SCANS. Sampled rows enter the report through one door -- the
  // decoded dictionary entries -- while these named sections are built from CATALOG METADATA and
  // the tool's own literals, and never see a sampled value. Scanning them cannot find a real leak,
  // but it collides endlessly with structural strings (a sampled '2026' is a whole word inside this
  // run's own generatedAt; a localized column name in the inventory equals some other table's
  // unmatched label), failing the run closed over output that leaked nothing. They are excluded BY
  // NAME, so any section a future change adds is scanned by default -- the fail-safe direction.
  // The connection-env sweep above deliberately still covers the ENTIRE report: a credential must
  // never appear anywhere, including in a section this list excuses.
  const CATALOG_DERIVED_SECTIONS = new Set(['generatedAt', 'dialect', 'thresholds', 'limits', 'schemaInventory'])
  const scannable = {}
  for (const [key, value] of Object.entries(report || {})) {
    if (!CATALOG_DERIVED_SECTIONS.has(key)) scannable[key] = value
  }
  const dictionaryLeaves = []
  collectStringLeaves(scannable, dictionaryLeaves)
  for (const value of leakGuardValues) {
    const s = String(value)
    if (s.length === 0) continue
    const norm = s.trim().toLowerCase()
    // WHOLE-LEAF OR WHOLE-WORD -- never a naive substring. A leak can arrive two ways: as its own
    // leaf, or composed into a message ('...report accidentally contains X'). A plain `includes`
    // catches both but ALSO fires on an ordinary word living inside an identifier the report is
    // entitled to emit -- a sampled value 'workshop' inside the key 'base_workshop' -- which fails
    // the run closed on the tool's own output. A word-boundary match separates the two exactly:
    // '_' is a word character, so 'workshop' does not match inside 'base_workshop', while a
    // space-delimited occurrence in a sentence does. Word boundaries are meaningless around CJK
    // (non-word characters on both sides make every position a boundary), so a value carrying
    // non-ASCII falls back to whole-leaf equality; the legitimate-emission subtraction in runProbe
    // is what keeps those precise.
    // WHOLE LEAF, OR A WHOLE-WORD OCCURRENCE INSIDE ONE -- never a naive substring. A leak arrives
    // two ways: as its own leaf, or composed into a message ('...accidentally contains X'). A plain
    // `includes` catches both but ALSO fires on an ordinary word living inside an identifier the
    // report is entitled to emit -- a sampled value 'workshop' inside the key 'base_workshop' --
    // failing the run closed on the tool's own output. containsAsWholeWord() separates them: '_'
    // counts as a word character, so 'workshop' does not match inside 'base_workshop', while a
    // space-delimited occurrence does. Multi-word values and CJK labels work unchanged, because the
    // test is on the characters ADJACENT to the match, not on the value's own shape.
    const hit = dictionaryLeaves.some((leaf) => {
      const lower = leaf.toLowerCase()
      if (lower.trim() === norm) return true
      // A PURELY NUMERIC guarded value is excluded from the whole-word sweep: it carries no
      // business meaning on its own and collides constantly with the structural numbers the report
      // legitimately prints -- a sampled '2026' is a whole word inside this run's own generatedAt
      // timestamp. Such a value stays armed for whole-leaf equality, which a timestamp never trips.
      if (/^[0-9]+$/.test(norm)) return false
      return containsAsWholeWord(lower, norm)
    })
    if (hit) {
      // Masked so an operator can act on it without the value itself entering a log.
      const masked = s.length <= 2 ? '*'.repeat(s.length) : s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
      violations.push('unmatched-sample-value(len=' + s.length + ', masked=' + masked + ')')
      break // one is enough to fail closed; never enumerate business data into an error message
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
  // CROSS-TABLE FALSE POSITIVE. `leakGuardValues` is global, but a value one table left UNMATCHED
  // can be identical to a label another table legitimately CONTRIBUTES to the report -- a generic
  // word like a field's display name is the common case. Guarding it globally fails the whole run
  // closed over a leak that did not happen. Subtract the strings the report is entitled to emit
  // (matched dictionary rows' attribute names and their labels): a value that is already legitimate
  // output somewhere is not evidence of a leak anywhere. Every other guarded value stays armed.
  const emitted = collectEmittedDictionaryStrings(report)
  const guarded = new Set()
  for (const value of dictionaryResult.leakGuardValues) {
    if (!emitted.has(String(value).trim().toLowerCase())) guarded.add(value)
  }
  return { report, leakGuardValues: guarded }
}

function collectEmittedDictionaryStrings(report) {
  const out = new Set()
  const add = (v) => { if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase()) }
  for (const dict of report.dictionaries || []) {
    for (const row of dict.entries || dict.rows || []) {
      for (const v of Object.values(row || {})) add(v)
    }
    // Companion COLUMN NAMES are schema identifiers, i.e. intended output. A localized column name
    // (2 CJK characters is ordinary here) can equal some other dictionary's unmatched sample value;
    // guarding it would fail the run closed on a name the report is meant to print.
    for (const v of Object.values(dict.companions || {})) add(v)
    add(dict.keyColumn)
    add(dict.table)
  }
  // SCHEMA IDENTIFIERS ARE LEGITIMATE OUTPUT BY CONSTRUCTION -- the report IS a structure report,
  // so every table and column name in it is intended. A localized column name (a Chinese label
  // used AS a column name is ordinary in these systems) can equal some other table's unmatched
  // sample value; guarding it would fail the run closed on the tool's own intended output.
  for (const t of report.schemaInventory || []) {
    add(t.name); add(t.schema)
    for (const c of t.columns || []) add(typeof c === 'string' ? c : c && c.name)
  }
  return out
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
  coerceRowCount,
  isBareIpAddress,
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
