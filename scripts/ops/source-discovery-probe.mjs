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
 * DRAFT MODE (H1, `--emit-draft --preset <path> --out-dir <dir>`). Given a VENDOR PRESET — which
 * encodes HOW TO DISCOVER (vendor table topology + where the dictionary tables are) and never WHAT
 * WAS DISCOVERED — the probe additionally reads the CUSTOMER'S OWN dictionary tables (through the
 * same row-cap guard, enabled rows only) and emits a draft `ext_` field mapping plus a customer-pack
 * skeleton for a human to confirm. See scripts/ops/source-discovery-draft-emitter.mjs for the
 * fail-closed rule (nothing the dictionaries do not positively justify is ever proposed) and for
 * `adaptVendorPresetShape`, the single function that isolates the assumed preset schema.
 *
 * THE VALUES SPLIT, and it is the whole point of the flag being separate:
 *   * the DRAFT files (in --out-dir, which must be OUTSIDE this repository) CONTAIN customer values —
 *     dictionary labels and option vocabularies — because a draft a human confirms has to;
 *   * the REPORT (--out) and STDOUT stay values-free exactly as before. What crosses back is
 *     `report.draftEmission`: identifiers, coded tokens and counts, no label, no option value and no
 *     prose. It is NOT in assertValuesFree's excluded-section list, so the leak guard sweeps it.
 *
 * Exit codes:
 *   0  report produced (structural findings may be empty — that is a valid, informative result)
 *   1  unexpected runtime/DB error, or the values-free self-check refused to write the report
 *   2  required input missing (env vars, --out, or a draft flag / bad --out-dir / bad preset file)
 *   3  draft emission REFUSED with a coded reason — most often no vendor preset's signature was met,
 *      or two tied. Never a guess. The report itself is not written in this case.
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// H1 — the confirm-ready DRAFT EMITTER. Every function it exports is pure (rows in, drafts out);
// this file keeps ALL the I/O, the connection, the row-cap guard and the values-free self-check.
// See its header for the fail-closed rule and for the one adapter function
// (adaptVendorPresetShape) that isolates what a vendor preset is assumed to look like.
import {
  DRAFT_FILE_NAMES,
  SourceDraftEmitterError,
  SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
  adaptVendorPresetShape,
  buildCatalogTableIndex,
  selectVendorPreset,
  readDictionaryEntries,
  completeDictionarySpec,
  discoverValueSetRefColumn,
  discoverValueSetColumns,
  extractOptionSet,
  resolveTargets,
  buildExtFieldMappingDraft,
  buildCustomerPackDraft,
  renderDraftReadme,
  buildDraftEmissionSummary,
  assertDraftOutDirOutsideRepo,
  canonicalizeExistingAncestor,
} from './source-discovery-draft-emitter.mjs'

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
    // DETERMINISTIC ORDER. `SELECT TOP (n)` with no ORDER BY returns rows in whatever order the
    // storage engine finds convenient, and that order can differ between two runs against the same
    // database. Everything downstream that resolves a conflict by position — and every `basis`
    // string that cites a ROW INDEX for a human to go and look at — was therefore reporting a
    // driver-dependent fact. Ordering by every column is exact and affordable here precisely because
    // this query only ever runs on tables already proven to be under SMALL_TABLE_ROW_CAP.
    const orderBy = table.columns.length > 0 ? ` ORDER BY ${columnList}` : ''
    const result = await pool.request().query(`SELECT TOP (${boundedCap}) ${columnList} FROM ${qualified}${orderBy}`)
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

  // DISPLAY-NAME CANDIDATE = non-ASCII ratio WEIGHTED BY COVERAGE.
  //
  // Ratio alone was the rule, and the first run against a real customer PLM showed exactly what it
  // costs. On `DN_PM_PartExAttrInfo` (73 rows) the real label column `ShowName` is populated on
  // 73/73 rows and is almost entirely CJK, while a rarely-used template column is populated on
  // 8/73 — all of them CJK, so its ratio is a perfect 1.0 and it WON. Every one of the 65 rows the
  // winner has nothing for then read as "an enabled slot with no label", the dictionary yielded
  // ZERO usable entries, and the draft came out empty. A false negative shaped exactly like a
  // correct answer, which is this file's oldest lesson (see coerceRowCount).
  //
  // Multiplying by coverage is the smallest rule that separates the two: a column that says nothing
  // about most rows cannot be what those rows are named by. It changes nothing where the old rule
  // was already right (a fully-populated label column scores its own ratio), and ties still resolve
  // to the first candidate as before.
  let displayNameColumn = null
  let displayNameRatio = null
  let bestScore = null
  const sampledRowCount = rows.length || 1
  for (const col of otherColumns) {
    if (!isTextType(col.dataType)) continue
    const values = distinctNonNull(rows.map((r) => r[col.name]))
    if (values.length === 0) continue
    const populated = rows.reduce((count, r) => {
      const v = r[col.name]
      return count + (v === null || v === undefined || String(v).trim() === '' ? 0 : 1)
    }, 0)
    const ratio = nonAsciiRatio(values)
    const score = ratio * (populated / sampledRowCount)
    if (bestScore === null || score > bestScore) {
      bestScore = score
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
  // value -> which collector armed it. Diagnostics ONLY (PROBE_SELF_CHECK_DIAG): a refusal that
  // names the category tells an operator which read produced the offending value without printing
  // it. Never serialized into any report.
  const valueCategories = new Map()
  const arm = (value, category) => {
    const text = String(value)
    if (!text) return
    leakGuardValues.add(text)
    if (!valueCategories.has(text)) valueCategories.set(text, category)
  }

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
      // The CODE only. The sampler's message embeds the table key, and `table` above already carries
      // it as an identifier field — the same "no identifier inside prose" rule the BOM-pair note now
      // follows, for the same reason.
      const message = String(err && err.message ? err.message : err)
      screenedTables.push({ table: key, reason: 'sampler_error', detail: message.split(':')[0] })
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
          if (!existsElsewhere(index, key, normalize(v))) arm(v, 'below-threshold-table')
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
      if (!existsElsewhere(index, key, normalize(v))) arm(v, 'unmatched-key-column')
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
      // Text columns only — a numeric/bit flag (e.g. an unmatched row's
      // enabled=1) has such low cardinality that guarding it would produce
      // near-certain false positives against the report's own counts/ratios
      // without meaningfully protecting anything; it is also never written
      // to the output regardless (buildMappingRows only emits matched rows).
      for (const col of table.columns) {
        if (!isTextType(col.dataType)) continue
        const v = row[col.name]
        if (v === null || v === undefined) continue
        // A MATCHED ROW'S CELLS ARE ARMED TOO, and the legitimate-emission subtraction is what
        // un-arms exactly the ones the report actually prints (attrName / displayLabel / enabled /
        // type). Leaving them unarmed was the hole: a matched row has OTHER cells — on this vendor
        // family the cell naming a value-set table — which the draft emitter reads and which no
        // report section is entitled to print. One of those reaching the report was an executed
        // leak. Arming everything and subtracting precisely is the fail-safe direction; arming
        // nothing and hoping no other reader appears is not.
        arm(v, matchedRow ? 'matched-row-companion-cell' : 'unmatched-row-text')
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

  return { dictionaries, screenedTables, leakGuardValues, valueCategories }
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
        // NO IDENTIFIER IS INTERPOLATED INTO THIS PROSE. It used to read
        // `...head.${headPartColumn.name} / detail.${detailPartColumn.name}...`, and on the first
        // real customer PLM the column names are CJK — so a two-character column name sat as a
        // DELIMITED TOKEN inside an English sentence, which is indistinguishable from a leaked
        // business value and failed the whole run closed. The names are already emitted, as
        // identifiers, in this same object's `headPartColumn` / `detailPartColumn` fields, where the
        // guard's identifier exemption is scoped; repeating them in prose bought nothing and cost
        // the run. The type is a catalog type name, not a customer identifier.
        confidenceNotes.push(`shared part-like column of matching type ${headPartColumn.dataType} on both sides`)
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
// The occurrence test lives in containsAsDelimitedToken(), below — a character-adjacency walk
// written out rather than done with a RegExp so the guarded value never has to be escaped into a
// pattern (an escaping slip here would silently weaken the guard).
// Written as an explicit code-point walk rather than a RegExp with hex escapes: these predicates
// decide when a guarded value fires, so they must be readable in a diff without anyone having to
// decode an escape sequence.
function hasNonAscii(text) {
  for (const ch of String(text)) {
    if (ch.codePointAt(0) > 127) return true
  }
  return false
}

// CJK ideographs + the two extensions and the compatibility block, plus kana. These are the scripts
// in which a business label of this vendor family is actually written, and — crucially — they are
// scripts that DO NOT USE SPACES, which is why ASCII word boundaries are meaningless around them.
function isCjkChar(ch) {
  if (!ch) return false
  const cp = ch.codePointAt(0)
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0x20000 && cp <= 0x2ebef) // CJK ext B..F
  )
}

function isAsciiWordChar(ch) {
  return Boolean(ch) && (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_'
  )
}

// "Do these two adjacent characters continue the SAME token?" Two ASCII word characters do
// (`workshop` inside `base_workshop`). Two CJK characters do (`件` inside `附件`). Anything else is a
// token boundary — a space, a colon, a bracket, or a script change.
function continuesToken(a, b) {
  if (isAsciiWordChar(a) && isAsciiWordChar(b)) return true
  if (isCjkChar(a) && isCjkChar(b)) return true
  return false
}

/**
 * SCRIPT-AWARE BOUNDARY MATCH — the single occurrence test for a guarded value inside a leaf.
 *
 * Replaces a pair of failures that pulled in opposite directions:
 *   * the ASCII-only word test degraded to a NAIVE SUBSTRING around CJK (every position is a
 *     "boundary" when neither neighbour is `[0-9a-z_]`), so a guarded unit `件` fired inside the
 *     label `附件` the report is entitled to emit;
 *   * exempting every non-ASCII value from the sweep outright (the first fix) retired the sweep for
 *     the whole script, so a guarded label sitting as a DELIMITED token inside a longer sentence
 *     leaf — `单位: 件` — stopped firing at all. That traded a false positive for a false negative,
 *     which is the wrong trade in a leak guard.
 *
 * Boundary is decided by SCRIPT CONTINUATION, so both cases come out right: `件` does not match
 * inside `附件` (CJK continues CJK) but does match in `单位: 件` (a space is not CJK), exactly as
 * `workshop` does not match inside `base_workshop` but does in `the workshop is here`.
 */
function containsAsDelimitedToken(haystack, needle) {
  if (!needle) return false
  const first = needle[0]
  const last = needle[needle.length - 1]
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : haystack[at - 1]
    const after = haystack[at + needle.length] || ''
    if (!continuesToken(before, first) && !continuesToken(last, after)) return true
    from = at + 1
  }
}

// Retained under its historical name because the leak-guard regression tests and the module header
// both refer to it; it is now the ASCII case of the script-aware test above.
function containsAsWholeWord(haystack, needle) {
  return containsAsDelimitedToken(haystack, needle)
}

/**
 * MINIMUM LENGTH FOR THE TOKEN SWEEP — the other half of a rule this file has always stated and only
 * half-implemented. Its own comment says: "a dictionary's unmatched '1' / '0' / 'no' is a substring
 * of some structural string in every report ... keep the substring sweep only for values long enough
 * that an accidental collision is not credible." The numeric half shipped; the SHORT-STRING half did
 * not, and the first run against a real customer PLM found it immediately: of 1959 guarded values,
 * 237 were three characters or shorter, and one two-character ASCII business value appeared as a
 * delimited token inside this tool's own static English sentence "no shared part-like column ...".
 * The run failed closed over a report that leaked nothing.
 *
 * Four is the first length at which an accidental hit on ordinary English prose stops being
 * credible: `no`, `of`, `on`, `to` are two; `the`, `and`, `for`, `low` are three.
 *
 * SCRIPT-AWARE, and this is the point: the floor applies ONLY to values that are entirely ASCII,
 * because ASCII prose is the thing they collide with. A value carrying CJK cannot collide with an
 * English sentence at all, and CJK-inside-CJK is already handled by the continuation rule — so a
 * two-character Chinese label keeps firing as a delimited token, which is exactly the `单位: 件`
 * case that must not be lost.
 *
 * NOTHING IS RETIRED. A short value stays armed for WHOLE-LEAF EQUALITY (a genuine leak of `no`
 * arrives as its own leaf, which no prose trips) and for the COMPOSED-LEAF check.
 */
const ASCII_TOKEN_SWEEP_MIN_LENGTH = 4

// Above this length a connection value cannot plausibly be a fragment of an ordinary identifier, so
// the env sweep keeps its naive-substring breadth. Below it, the same precision as everywhere else
// applies — see the env sweep in assertValuesFree for the live collision that forced the split.
const ENV_VALUE_SUBSTRING_MIN_LENGTH = 8

function isEligibleForTokenSweep(normalizedValue) {
  if (/^[0-9]+$/.test(normalizedValue)) return false
  if (hasNonAscii(normalizedValue)) return true
  return normalizedValue.length >= ASCII_TOKEN_SWEEP_MIN_LENGTH
}

/**
 * COMPOSED-LEAF CHECK. A leak can also arrive as a leaf that is nothing but guarded values stuck
 * together: `零件` + `图纸` serialized as `零件图纸`. Neither piece fires on whole-leaf equality (the
 * leaf equals neither) and neither fires on the boundary test (CJK continues CJK on the seam), yet
 * the leaf carries both values in full.
 *
 * So: tile the leaf with guarded values. If the ENTIRE leaf can be covered by two or more of them
 * end to end, it is a composition and it fires. One piece covering the whole leaf is just whole-leaf
 * equality, which is handled separately.
 *
 * Bounded on purpose — this runs per leaf per report: only short leaves are considered, and only the
 * guarded values that actually occur in the leaf are candidates.
 */
const COMPOSED_LEAF_MAX_LENGTH = 128

function composedFromGuardedValues(leaf, normalizedGuarded) {
  const text = leaf.trim().toLowerCase()
  if (!text || text.length > COMPOSED_LEAF_MAX_LENGTH) return null
  const candidates = []
  for (const value of normalizedGuarded) {
    if (value.length > 0 && value.length < text.length && text.includes(value)) candidates.push(value)
  }
  if (candidates.length < 2) return null
  // Minimal number of pieces needed to reach each index; index 0 costs 0.
  const pieces = new Array(text.length + 1).fill(Number.POSITIVE_INFINITY)
  const used = new Array(text.length + 1).fill(null)
  pieces[0] = 0
  for (let i = 0; i < text.length; i += 1) {
    if (pieces[i] === Number.POSITIVE_INFINITY) continue
    for (const candidate of candidates) {
      if (!text.startsWith(candidate, i)) continue
      const next = i + candidate.length
      if (pieces[i] + 1 < pieces[next]) {
        pieces[next] = pieces[i] + 1
        used[next] = candidate
      }
    }
  }
  return pieces[text.length] >= 2 && pieces[text.length] !== Number.POSITIVE_INFINITY
    ? { pieceCount: pieces[text.length], lastPiece: used[text.length] }
    : null
}

// String leaves WITH their JSON path, so a violation can name WHERE it landed (diagnostics) and so
// an exemption can be scoped to the kind of field it landed in (see isIdentifierLeafPath).
function collectStringLeavesWithPaths(value, path, out) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push({ path, value })
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectStringLeavesWithPaths(item, `${path}[${index}]`, out)
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectStringLeavesWithPaths(item, path ? `${path}.${key}` : key, out)
  }
}

// FIELDS WHOSE CONTENT IS A SCHEMA IDENTIFIER BY CONSTRUCTION. A table/column/schema name is
// legitimate output HERE and nowhere else: the identifier-subtraction is scoped to these paths, so a
// sampled customer value that merely COINCIDES with a table name (or with the bare schema `dbo`)
// still fires if it turns up in a label, a note or any other field. Anything not on this list gets
// no identifier exemption, which is the fail-safe direction — a new field is scanned by default.
const IDENTIFIER_LEAF_FIELDS = new Set([
  'table', 'schema', 'name', 'column', 'keyColumn', 'bestColumn',
  'displayNameColumn', 'enabledColumn', 'typeColumn',
  'attrName', 'slot', 'sourceColumn', 'sourceTable', 'sourceTableName', 'describesTable',
  'idColumn', 'parentIdColumn', 'headPartColumn', 'detailPartColumn',
  'headPrimaryKeyColumn', 'detailParentIdColumn', 'head', 'detail', 'target',
  // `valueSetKey` is on this list ONLY because buildDraftEmissionSummary nulls it whenever the ref
  // is unverified — a verified one is a preset key or a declared-family table name, both
  // vendor-generic by construction. If that nulling is ever removed, this entry must go with it.
  'valueSetKey',
])

function isIdentifierLeafPath(leafPath) {
  const withoutIndexes = String(leafPath).replace(/\[[0-9]+\]/g, '')
  const last = withoutIndexes.slice(withoutIndexes.lastIndexOf('.') + 1)
  return IDENTIFIER_LEAF_FIELDS.has(last)
}

/**
 * NAMED SECTION EXCLUSION, WITH ITS JUSTIFICATION: `dictionaries[*].entries[*].*`.
 *
 * This is THE ONE DOOR sampled values are documented to come through. `buildMappingRows` emits an
 * entry ONLY for a row whose key value was independently verified to be a real column name
 * elsewhere in the schema — that verification is the whole dictionary heuristic, and the module
 * header calls recovering these labels "the entire point". So a string at this path is, by
 * construction, a verified-row value the report is entitled to print.
 *
 * Scanning it therefore cannot find a real leak, while it collides constantly with the customer's
 * own vocabulary — both shapes appeared on the first real PLM run:
 *   * a perfectly ordinary 7-character label tiles out of two unrelated guarded values from other
 *     tables (the composed check), and
 *   * a 4-character armed cell sits as a delimited token inside a longer decoded label.
 * Each failed the whole run closed over output that leaked nothing.
 *
 * WHAT THIS DOES NOT EXCUSE: the executed leak that motivated arming matched rows' companion cells
 * came through `draftEmission.optionSets`, NOT through this section — the arming stays, and every
 * other section stays scanned. The connection-env sweep covers the entire report regardless.
 */
function isDecodedDictionaryEntryPath(leafPath) {
  return /^dictionaries\[[0-9]+\]\.entries\[[0-9]+\]\./.test(String(leafPath))
}

/**
 * @param {object} report
 * @param {object} options
 * @param {object} options.env             connection env, swept over the WHOLE report
 * @param {Set}    options.leakGuardValues values the detector saw but could not match to a column
 * @param {Map}    options.valueCategories optional value -> collector name, for diagnostics only
 * @param {boolean} options.diagnostics    when true, a violation also names the JSON PATH of the
 *                                         offending leaf and the CATEGORY of the guarded value.
 *                                         Masked value only — never the value. Fail-closed
 *                                         behaviour is identical either way; this only widens what
 *                                         the REFUSAL says, and is driven by PROBE_SELF_CHECK_DIAG.
 */
function assertValuesFree(report, {
  env = {},
  leakGuardValues = new Set(),
  valueCategories = null,
  emittedIdentifiers = null,
  diagnostics = false,
} = {}) {
  const allLeaves = []
  collectStringLeavesWithPaths(report, '', allLeaves)
  const violations = []

  // THE ENV SWEEP COVERS THE WHOLE REPORT — every section, no exclusions, because a credential
  // appearing anywhere at all is unacceptable and this is the one sweep for which breadth beats
  // precision.
  //
  // Its MATCHING, however, could not stay a naive substring, and the first live run said why: the
  // customer's database is named `plm`, and this tool's own frozen ownership vocabulary contains
  // the constant `plm_system`. Every draft run failed closed on the tool's own literal. A short
  // connection value is a fragment of ordinary identifiers; a real credential is not.
  //
  // So: a LONG value (a password, a hostname, a real database name) keeps the naive substring sweep
  // — the broadest possible test, for the values that actually matter. A SHORT one is matched as a
  // whole leaf or a delimited token, which still catches every shape a leak of it can take here: as
  // its own leaf, inside a sentence, or inside a connection string (`=plm;` is delimited on both
  // sides). It does not fire inside `plm_system`, where `_` continues the token.
  for (const name of ENV_VAR_NAMES) {
    const value = env[name]
    if (typeof value !== 'string' || value.length === 0) continue
    const needle = value.toLowerCase()
    const broad = value.length >= ENV_VALUE_SUBSTRING_MIN_LENGTH
    const hit = allLeaves.find((leaf) => {
      const lower = leaf.value.toLowerCase()
      if (broad) return lower.includes(needle)
      return lower.trim() === needle || containsAsDelimitedToken(lower, needle)
    })
    if (hit) violations.push(`env:${name}${diagnostics ? `(path=${hit.path})` : ''}`)
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
  const pathedLeaves = []
  collectStringLeavesWithPaths(scannable, '', pathedLeaves)
  // Normalized guarded values, once — the composed-leaf tiling needs the whole set per leaf.
  const normalizedGuarded = []
  for (const value of leakGuardValues) {
    const norm = String(value).trim().toLowerCase()
    if (norm) normalizedGuarded.push(norm)
  }
  // COMPOSED LEAVES. Checked per LEAF rather than per guarded value: a composition is a property of
  // the leaf, and the pieces are by construction values that individually do not fire.
  // A LEAF THE REPORT IS ENTITLED TO EMIT AS AN IDENTIFIER is exempt — but only where an identifier
  // is what that field holds. A customer value that merely COINCIDES with a table name (or with the
  // bare schema `dbo`) still fires everywhere else, which is what a global subtraction gave away.
  const identifierSet = emittedIdentifiers instanceof Set ? emittedIdentifiers : new Set()
  const leafIsExemptIdentifier = (leaf) =>
    identifierSet.has(leaf.value.trim().toLowerCase()) && isIdentifierLeafPath(leaf.path)

  for (const leaf of pathedLeaves) {
    if (leafIsExemptIdentifier(leaf) || isDecodedDictionaryEntryPath(leaf.path)) continue
    const composed = composedFromGuardedValues(leaf.value, normalizedGuarded)
    if (!composed) continue
    violations.push(
      'composed-sample-values(pieces=' + composed.pieceCount + ', leafLen=' + leaf.value.trim().length +
      (diagnostics ? ', path=' + leaf.path + ', category=composed' : '') + ')',
    )
    break
  }
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
    let hitPath = null
    const hit = pathedLeaves.some((leaf) => {
      // Scoped exemption, not a global one: this leaf holds an identifier field AND the value is one
      // the report legitimately emits as an identifier. The decoded-entry section is excluded by
      // name — see isDecodedDictionaryEntryPath for why scanning it cannot find a real leak.
      if (leafIsExemptIdentifier(leaf) || isDecodedDictionaryEntryPath(leaf.path)) return false
      const lower = leaf.value.toLowerCase()
      if (lower.trim() === norm) { hitPath = leaf.path; return true }
      // ELIGIBILITY FOR THE TOKEN SWEEP. A purely numeric guarded value is excluded: it carries no
      // business meaning on its own and collides constantly with the structural numbers the report
      // legitimately prints -- a sampled '2026' is a whole word inside this run's own generatedAt
      // timestamp. A SHORT ALL-ASCII value is excluded for the same reason against prose rather than
      // numbers -- see ASCII_TOKEN_SWEEP_MIN_LENGTH, and the live run that proved it. Both stay
      // armed for whole-leaf equality and for the composed-leaf check.
      if (!isEligibleForTokenSweep(norm)) return false
      // A NON-ASCII guarded value used to be excluded from the sweep entirely. That closed one hole
      // (`件` firing inside `附件`) by opening another: a guarded label sitting as a DELIMITED token
      // inside a longer sentence leaf stopped firing at all. containsAsDelimitedToken decides the
      // boundary by SCRIPT CONTINUATION instead, so both cases are right and neither script is
      // exempted from the sweep. See its own comment for the two failures it replaces.
      if (containsAsDelimitedToken(lower, norm)) { hitPath = leaf.path; return true }
      return false
    })
    if (hit) {
      // Masked so an operator can act on it without the value itself entering a log.
      const masked = s.length <= 2 ? '*'.repeat(s.length) : s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
      const category = valueCategories && valueCategories.get(s) ? valueCategories.get(s) : 'unknown'
      violations.push(
        'unmatched-sample-value(len=' + s.length + ', masked=' + masked +
        (diagnostics ? ', path=' + hitPath + ', category=' + category : '') + ')',
      )
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

  if (report.draftEmission) {
    const d = report.draftEmission
    lines.push('')
    lines.push('## Draft emission (H1)')
    lines.push('')
    // Prose lives HERE, in the renderer, and never in the report object: the
    // report's string leaves are swept for guarded values with whole-word
    // matching, and an ordinary-English sentence is precisely the surface a
    // sampled business word collides with.
    lines.push('The drafts contain customer values by design and were written to the `--out-dir` given on the')
    lines.push('command line. This report does not carry them: counts and identifiers only.')
    lines.push('')
    lines.push(`- preset: \`${d.presetId}\` v${d.presetVersion} (vendor \`${d.vendor}\`)`)
    lines.push(
      `- signature: confidence ${d.signature.confidence.toFixed(2)} (minimum ${d.signature.minimumConfidence.toFixed(2)}), ` +
      `${d.signature.matchedRequiredTableCount}/${d.signature.requiredTableCount} required tables`,
    )
    lines.push(
      `- targets: ${d.targetCounts.declared} declared, ${d.targetCounts.resolved} resolved ` +
      `(${d.targetCounts.mappable} mappable, ${d.targetCounts.deferred} deferred), ` +
      `**${d.targetCounts.unresolved} UNRESOLVED**, ${d.targetCounts.placeholderProposed} placeholder proposals`,
    )
    lines.push(`- draft files: ${Object.values(DRAFT_FILE_NAMES).map((n) => `\`${n}\``).join(', ')}`)
    lines.push('')
    lines.push('| dictionary | table | read | rows | enabled entries |')
    lines.push('|---|---|---|---|---|')
    for (const read of d.dictionaryReads) {
      // Plain ASCII on purpose, em dash included: this whole section is asserted to carry no
      // non-ASCII character at all, which is the cheapest possible proof that no customer label or
      // option value slipped into it.
      lines.push(
        `| ${read.key} | ${read.table} | ${read.read ? 'yes' : `NO (${read.reason})`} | ` +
        `${read.rowsRead ?? 'n/a'} | ${read.enabledEntryCount ?? 'n/a'} |`,
      )
    }
    if (d.unresolvedTargets.length > 0) {
      lines.push('')
      lines.push('| unresolved target | via | reason |')
      lines.push('|---|---|---|')
      for (const item of d.unresolvedTargets) {
        lines.push(`| ${item.target ?? '(placeholder)'} | ${item.via} | \`${item.reason}\` |`)
      }
    }
  }

  lines.push('')
  lines.push(`> ${report.limits.note}`)
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// DRAFT EMISSION (H1) — orchestration only. Every decision lives in the pure
// functions of source-discovery-draft-emitter.mjs; what happens here is
// (a) resolving the preset's table references against the discovered catalog,
// (b) reading the named dictionary/value-set tables THROUGH THE EXISTING ROW-CAP
// GUARD, and (c) assembling the artifacts.
//
// (b) is the part that matters: `sampleSmallTableRows` is the single choke point
// every data read in this file goes through, and the draft mode does not get its
// own back door. A dictionary table above the cap is simply NOT READ, and the
// draft says so with a coded reason instead of quietly producing fewer entries.
// ---------------------------------------------------------------------------

async function readPresetTable({ tableIndex, sampleFn, reference }) {
  const hit = tableIndex.resolve(reference)
  if (!hit.ok) return { ok: false, reason: hit.reason }
  try {
    const rows = await sampleSmallTableRows({ sampleFn, table: hit.table })
    return { ok: true, table: hit.table, rows }
  } catch (err) {
    const message = String(err && err.message ? err.message : err)
    // ROW_CAP_REFUSED / SAMPLE_CAP_EXCEEDED both land here. The code is kept, the
    // message is not: it names a table and a count, never a value.
    return { ok: false, reason: message.startsWith('ROW_CAP_REFUSED') ? 'ROW_CAP_REFUSED' : 'SAMPLER_ERROR' }
  }
}

async function buildDraftArtifacts({ catalog, sampleFn, presets, generatedAt, detectedDictionaries = [] }) {
  const tableIndex = buildCatalogTableIndex(catalog)
  // The probe's OWN dictionary heuristic, indexed by qualified table name. A preset that declines to
  // name a dictionary's columns (`mechanism: 'rows-name-columns'`) is completed against this: the
  // heuristic already proved which column of that table holds values that name columns elsewhere,
  // and which of its companions are the label / flag / type columns. Reusing it beats re-deriving it,
  // and it means the two halves of the tool cannot disagree about what a dictionary's key column is.
  const detectedByTable = new Map()
  for (const entry of detectedDictionaries) detectedByTable.set(String(entry.table).toLowerCase(), entry)
  const detectedFor = (table) => detectedByTable.get(`${table.schema}.${table.name}`.toLowerCase()) || null

  // NEVER GUESS A VENDOR. A preset applies only when its OWN signature clears its
  // OWN declared bar and no rival preset ties with it.
  const selection = selectVendorPreset({ presets, tableIndex })
  if (!selection.ok) {
    throw new SourceDraftEmitterError(
      `draft emission refused: ${selection.detail}`,
      selection.reason,
      { scores: selection.scores.map((s) => ({ presetId: s.presetId, confidence: s.confidence })) },
    )
  }
  const { preset, score } = selection

  // --- dictionaries ---------------------------------------------------------
  const dictionaryReads = []
  const entriesByDictionary = new Map()
  const valueSetTableTests = []
  // The vendor's own flag convention, taken from whichever dictionary declared it. A vocabulary table
  // of the same family names its flag column the same way; using the vendor's declaration beats
  // inventing a second rule for the same thing.
  let vendorFlag = { candidates: [], polarity: null }
  for (const spec of preset.dictionaries.values()) {
    if ((spec.enabledColumnCandidates || []).length > 0 && vendorFlag.candidates.length === 0) {
      vendorFlag = { candidates: spec.enabledColumnCandidates, polarity: spec.enabledPolarity }
    }
  }
  for (const declared of preset.dictionaries.values()) {
    const base = { key: declared.key, table: declared.table, describesTable: declared.describesTable }
    const described = tableIndex.resolve(declared.describesTable)
    if (!described.ok) {
      const record = { ...base, ok: false, reason: described.reason }
      dictionaryReads.push(record)
      entriesByDictionary.set(declared.key, record)
      continue
    }
    const read = await readPresetTable({ tableIndex, sampleFn, reference: declared.table })
    if (!read.ok) {
      const record = { ...base, ok: false, reason: read.reason }
      dictionaryReads.push(record)
      entriesByDictionary.set(declared.key, record)
      continue
    }
    const dictionaryColumns = tableIndex.columnsOf(read.table)
    const completed = completeDictionarySpec({
      spec: declared,
      tableColumns: dictionaryColumns,
      detected: detectedFor(read.table),
    })
    if (!completed.ok) {
      // The preset said "the rows name columns" and the heuristic could not say WHICH column does
      // what. That is a gap, not an invitation to pick by name.
      const record = { ...base, ok: false, reason: completed.reason }
      dictionaryReads.push(record)
      entriesByDictionary.set(declared.key, record)
      continue
    }
    let spec = completed.spec
    if (spec.valueSetTableFamily) {
      const family = spec.valueSetTableFamily
      // The value-set table family is a STRUCTURED family, exactly like a column family, so the
      // "is this a value-set table" test is a generated matcher rather than an authored pattern.
      const isValueSetTableName = (name) => preset.isFamilyColumn(family, name)
      valueSetTableTests.push(isValueSetTableName)
      if (!spec.valueSetColumn) {
        const refColumn = discoverValueSetRefColumn({
          rows: read.rows,
          columns: dictionaryColumns,
          isValueSetTableName,
          exclude: [spec.slotColumn, spec.labelColumn, spec.enabledColumn, spec.typeColumn],
        })
        if (refColumn) spec = { ...spec, valueSetColumn: refColumn }
      }
    }
    const parsed = readDictionaryEntries({
      spec,
      rows: read.rows,
      describedColumns: tableIndex.columnsOf(described.table),
      isFamilyColumn: preset.isFamilyColumn,
    })
    const record = { ...base, ok: true, rowsRead: read.rows.length, ...parsed }
    dictionaryReads.push(record)
    entriesByDictionary.set(declared.key, record)
  }

  // --- value sets -----------------------------------------------------------
  // Two sources, one map, keyed by whatever string a resolved target carries as its `valueSetRef`:
  //   * the preset's own explicitly declared value sets (keyed by their preset key), and
  //   * vocabulary tables NAMED BY THE CUSTOMER'S OWN DICTIONARY ROWS (keyed by that table name).
  // The second is the whole point on a rows-name-columns preset: which vocabulary table a list-typed
  // slot points at is a customer fact, and the preset only says what such a table is NAMED like.
  const optionSets = new Map()
  for (const spec of preset.valueSets.values()) {
    const read = await readPresetTable({ tableIndex, sampleFn, reference: spec.table })
    if (!read.ok) {
      optionSets.set(spec.key, { ok: false, reason: read.reason === 'TABLE_ABSENT' ? 'VALUE_SET_NOT_READ' : read.reason, valueSetKey: spec.key, table: spec.table })
      continue
    }
    optionSets.set(spec.key, extractOptionSet({ spec, rows: read.rows }))
  }

  // A ref's LOCATOR: which dictionary rows named it. This is what an unverified ref contributes to
  // the report instead of its text — an operator opens those rows, and nothing of the customer's
  // travels. (A hash would also have been values-free; a locator is strictly less invertible and
  // just as actionable, so it is what gets carried.)
  const refLocators = new Map()
  const discoveredRefs = new Set()
  for (const record of dictionaryReads) {
    if (record.ok !== true) continue
    for (const entry of record.entries) {
      if (!entry.valueSetRef) continue
      discoveredRefs.add(entry.valueSetRef)
      if (!refLocators.has(entry.valueSetRef)) refLocators.set(entry.valueSetRef, { dictionaryKey: record.key, rowIndexes: [] })
      refLocators.get(entry.valueSetRef).rowIndexes.push(entry.rowIndex)
    }
  }
  const unverified = (ref, reason, extra = {}) => ({
    ok: false,
    reason,
    // NOT the ref. A dictionary cell that failed the vendor family check is an ARBITRARY CUSTOMER
    // VALUE — echoing it into the values-free report as `valueSetKey`/`table` was an executed leak,
    // and it passed the self-check precisely because a matched row's companion cells were not armed.
    // Both halves of that are closed: the cells are armed now, and this carries a locator.
    verified: false,
    valueSetKey: null,
    table: null,
    locator: refLocators.get(ref) || null,
    refLength: String(ref).length,
    ...extra,
  })
  for (const ref of discoveredRefs) {
    if (optionSets.has(ref)) continue
    // FAIL-CLOSED ON WHAT WE READ: a dictionary cell naming a table is not on its own permission to
    // read that table. It must be a member of the value-set table FAMILY the preset declared.
    if (!valueSetTableTests.some((isValueSetTableName) => isValueSetTableName(ref))) {
      optionSets.set(ref, unverified(ref, 'VALUE_SET_TABLE_PATTERN_MISMATCH'))
      continue
    }
    const resolvedTable = tableIndex.resolve(ref)
    if (!resolvedTable.ok) {
      // Family-verified but absent from the catalog: the NAME is vendor-generic by construction
      // (it matched the declared family), so it is safe to carry as an identifier.
      optionSets.set(ref, { ok: false, reason: 'VALUE_SET_NOT_READ', verified: true, valueSetKey: ref, table: ref })
      continue
    }
    const columns = tableIndex.columnsOf(resolvedTable.table)
    const shape = discoverValueSetColumns({ columns, enabledColumnCandidates: vendorFlag.candidates })
    if (!shape.ok) {
      optionSets.set(ref, { ok: false, reason: shape.reason, verified: true, valueSetKey: ref, table: ref, candidates: shape.candidates })
      continue
    }
    const read = await readPresetTable({ tableIndex, sampleFn, reference: ref })
    if (!read.ok) {
      optionSets.set(ref, {
        ok: false,
        reason: read.reason === 'TABLE_ABSENT' ? 'VALUE_SET_NOT_READ' : read.reason,
        verified: true,
        valueSetKey: ref,
        table: ref,
      })
      continue
    }
    optionSets.set(ref, extractOptionSet({
      spec: {
        key: ref,
        table: ref,
        valueColumn: shape.valueColumn,
        labelColumn: null,
        enabledColumn: shape.enabledColumn,
        enabledValues: [],
        enabledPolarity: shape.enabledColumn ? vendorFlag.polarity : null,
      },
      rows: read.rows,
    }))
  }

  const resolution = resolveTargets({ preset, tableIndex, entriesByDictionary })

  return {
    preset,
    score,
    resolution,
    optionSets,
    dictionaryReads,
    summary: buildDraftEmissionSummary({ preset, score, resolution, optionSets, dictionaryReads }),
    files: {
      [DRAFT_FILE_NAMES.mapping]: JSON.stringify(buildExtFieldMappingDraft({ preset, resolution, generatedAt }), null, 2) + '\n',
      [DRAFT_FILE_NAMES.pack]: JSON.stringify(buildCustomerPackDraft({ preset, resolution, optionSets, generatedAt }), null, 2) + '\n',
      [DRAFT_FILE_NAMES.readme]: renderDraftReadme({ preset, score, resolution, optionSets, dictionaryReads, generatedAt }),
    },
  }
}

/**
 * Load vendor presets from a FILE (one preset) or a DIRECTORY (`*.json`, auto-selected by signature).
 * Each one goes through the adapter, so a malformed preset fails here with the adapter's own coded
 * reason rather than producing a subtly wrong draft.
 */
// THE PRESET SCHEMA MODULE, IF IT IS HERE.
//
// `plugins/plugin-integration-core/lib/source-vendor-presets/preset-schema.cjs` owns the preset
// contract: the closed hint vocabularies, the generated family matchers, and `assertVendorPreset`,
// whose anti-smuggling scans exist because an adversarial review EXECUTED nine smuggles past the
// first cut. When that module is present this script consumes it rather than reimplementing it, so
// the two halves cannot drift; when it is not (a checkout predating the preset catalog), the
// emitter's local mirror is used and `hintVocabularySource` says so in the report.
//
// Loaded lazily and defensively: a missing module must degrade to the mirror, never crash the probe,
// and a module that throws on load is treated the same way.
let cachedPresetSchema
function loadPresetSchemaModule() {
  if (cachedPresetSchema !== undefined) return cachedPresetSchema
  cachedPresetSchema = null
  const modulePath = path.join(REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib', 'source-vendor-presets', 'preset-schema.cjs')
  try {
    if (statSync(modulePath).isFile()) {
      cachedPresetSchema = createRequire(import.meta.url)(modulePath)
    }
  } catch {
    cachedPresetSchema = null
  }
  return cachedPresetSchema
}

/**
 * Load vendor presets from a FILE (one preset) or a DIRECTORY (`*.json`, auto-selected by
 * signature). Each one goes through the adapter, so a malformed preset fails here with the adapter's
 * own coded reason rather than producing a subtly wrong draft. A preset written in the SCHEMA's own
 * dialect is additionally put through the schema's `assertVendorPreset` when that module is
 * available — its anti-smuggling scans are the authority, and re-implementing a weaker copy here is
 * exactly the drift this arrangement avoids.
 */
function loadVendorPresets(presetPath) {
  const resolved = path.resolve(presetPath)
  const stat = statSync(resolved)
  const files = stat.isDirectory()
    ? readdirSync(resolved).filter((name) => name.toLowerCase().endsWith('.json')).sort().map((name) => path.join(resolved, name))
    : [resolved]
  if (files.length === 0) {
    throw new SourceDraftEmitterError(`no *.json vendor preset found under ${presetPath}`, 'PRESET_SET_EMPTY', {})
  }
  const schema = loadPresetSchemaModule()
  return files.map((file) => {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (schema && typeof schema.assertVendorPreset === 'function' && raw && raw.presetSchema === SOURCE_VENDOR_PRESET_SCHEMA_MARKER) {
      try {
        schema.assertVendorPreset(raw, `preset file ${path.basename(file)}`)
      } catch (err) {
        throw new SourceDraftEmitterError(
          `preset ${path.basename(file)} was refused by the preset schema validator: ${err && err.message ? err.message : err}`,
          'PRESET_NOT_AN_OBJECT',
          { file: path.basename(file) },
        )
      }
    }
    return adaptVendorPresetShape(raw, { schema })
  })
}

// ---------------------------------------------------------------------------
// End-to-end orchestration — a pure function of (catalog, sampleFn); no I/O.
// ---------------------------------------------------------------------------

async function runProbe({ catalog, sampleFn, presets = null }) {
  const dictionaryResult = await detectDictionaryTables({ catalog, sampleFn })
  const bomPairCandidates = detectBomPairCandidates(catalog)
  const treeCandidates = detectTreeCandidates(catalog)
  const quantityCandidates = detectQuantityCandidates(catalog, bomPairCandidates)
  const report = buildReport({ catalog, dictionaryResult, bomPairCandidates, treeCandidates, quantityCandidates })

  // DRAFT EMISSION. The artifacts CONTAIN customer values (dictionary labels, option vocabularies)
  // and are returned separately, to be written to the deploy-host --out-dir. What crosses back into
  // the REPORT is `summary` only: identifiers, coded tokens and counts, no label, no option value and
  // no prose. It is deliberately NOT added to CATALOG_DERIVED_SECTIONS, so assertValuesFree sweeps it
  // like any other section -- the fail-safe direction.
  let draft = null
  if (presets) {
    draft = await buildDraftArtifacts({
      catalog,
      sampleFn,
      presets,
      generatedAt: report.generatedAt,
      detectedDictionaries: dictionaryResult.dictionaries,
    })
    report.draftEmission = draft.summary
  }

  // CROSS-TABLE FALSE POSITIVE. `leakGuardValues` is global, but a value one table left UNMATCHED
  // can be identical to a label another table legitimately CONTRIBUTES to the report -- a generic
  // word like a field's display name is the common case. Guarding it globally fails the whole run
  // closed over a leak that did not happen. Subtract the strings the report is entitled to emit
  // (matched dictionary rows' attribute names and their labels): a value that is already legitimate
  // output somewhere is not evidence of a leak anywhere. Every other guarded value stays armed.
  // TWO KINDS OF LEGITIMATE EMISSION, AND THEY GET DIFFERENT TREATMENT.
  //
  //   CONTENT — a matched dictionary row's decoded values (attrName / displayLabel / enabled /
  //   type). These ARE the documented value-bearing output of the dictionary heuristic, so a value
  //   that is already content somewhere is not evidence of a leak anywhere: subtracted globally.
  //
  //   IDENTIFIERS — table, schema and column names. These are legitimate output only WHERE AN
  //   IDENTIFIER IS WHAT THE FIELD HOLDS. Subtracting them globally (what this did before) means a
  //   sampled customer value that merely coincides with a table name — or with the bare schema
  //   `dbo` — stops firing everywhere, including inside a label or a note. So they are handed to
  //   assertValuesFree separately and exempted only at identifier-typed leaf paths.
  const emitted = collectEmittedDictionaryStrings(report)
  const guarded = new Set()
  for (const value of dictionaryResult.leakGuardValues) {
    if (!emitted.content.has(String(value).trim().toLowerCase())) guarded.add(value)
  }
  return {
    report,
    leakGuardValues: guarded,
    emittedIdentifiers: emitted.identifiers,
    valueCategories: dictionaryResult.valueCategories,
    draft,
  }
}

function collectEmittedDictionaryStrings(report) {
  const content = new Set()
  const identifiers = new Set()
  const addTo = (set, v) => { if (typeof v === 'string' && v.trim()) set.add(v.trim().toLowerCase()) }
  for (const dict of report.dictionaries || []) {
    for (const row of dict.entries || dict.rows || []) {
      for (const v of Object.values(row || {})) addTo(content, v)
    }
    // Companion COLUMN NAMES are schema identifiers, i.e. intended output. A localized column name
    // (2 CJK characters is ordinary here) can equal some other dictionary's unmatched sample value;
    // guarding it would fail the run closed on a name the report is meant to print.
    for (const v of Object.values(dict.companions || {})) addTo(identifiers, v)
    addTo(identifiers, dict.keyColumn)
    addTo(identifiers, dict.table)
  }
  // SCHEMA IDENTIFIERS ARE LEGITIMATE OUTPUT BY CONSTRUCTION -- the report IS a structure report,
  // so every table and column name in it is intended. A localized column name (a Chinese label
  // used AS a column name is ordinary in these systems) can equal some other table's unmatched
  // sample value; guarding it AT AN IDENTIFIER FIELD would fail the run closed on the tool's own
  // intended output. Elsewhere it stays armed.
  for (const t of report.schemaInventory || []) {
    // buildSchemaInventory emits the QUALIFIED key on `table` ("schema.name") and carries no separate
    // `name`/`schema` properties -- so the two adds below were reading undefined and TABLE names were
    // never actually subtracted. Both spellings are kept: other report shapes (and the regression
    // test for whole-leaf matching) build inventory entries as { schema, name }.
    addTo(identifiers, t.table)
    if (typeof t.table === 'string') {
      const dot = t.table.indexOf('.')
      if (dot > 0) { addTo(identifiers, t.table.slice(0, dot)); addTo(identifiers, t.table.slice(dot + 1)) }
    }
    addTo(identifiers, t.name); addTo(identifiers, t.schema)
    for (const c of t.columns || []) addTo(identifiers, typeof c === 'string' ? c : c && c.name)
  }
  return { content, identifiers }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, help: false, emitDraft: false, preset: null, outDir: null }
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
      case '--emit-draft':
        opts.emitDraft = true
        break
      case '--preset': {
        const value = argv[++i]
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('--preset requires a file or directory path argument')
        }
        opts.preset = value
        break
      }
      case '--out-dir': {
        const value = argv[++i]
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('--out-dir requires a directory path argument')
        }
        opts.outDir = value
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
  // Both flags are REQUIRED by --emit-draft rather than defaulted. A defaulted
  // --out-dir would eventually default into a working copy, and the drafts carry
  // customer values; a defaulted --preset would mean guessing a vendor.
  if (opts.emitDraft) {
    const missing = []
    if (!opts.preset) missing.push('--preset')
    if (!opts.outDir) missing.push('--out-dir')
    if (missing.length > 0) {
      throw new Error(`--emit-draft requires ${missing.join(' and ')}`)
    }
  } else if (opts.preset || opts.outDir) {
    throw new Error('--preset/--out-dir are only meaningful together with --emit-draft')
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
      'Draft mode (H1) — read the customer\'s OWN dictionary tables per a vendor preset and emit a',
      'confirm-ready ext-field mapping + customer-pack skeleton:',
      '',
      '  ... node scripts/ops/source-discovery-probe.mjs --out <file.json> \\',
      '        --emit-draft --preset <preset.json|preset-dir> --out-dir <deploy-host dir>',
      '',
      `Writes ${Object.values(DRAFT_FILE_NAMES).join(', ')} into --out-dir.`,
      'THE DRAFTS CONTAIN CUSTOMER VALUES (dictionary labels, option vocabularies) by design; the',
      'report on --out stays values-free. --out-dir must be OUTSIDE this repository and the run is',
      'refused if it is not.',
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

  // Resolved BEFORE the connection: an --out-dir inside a working copy of this
  // repository must fail before a single customer row has been read, not after.
  let draftOutDir = null
  let presets = null
  if (opts.emitDraft) {
    try {
      draftOutDir = assertDraftOutDirOutsideRepo(opts.outDir, REPO_ROOT, { realpath: realpathSync.native })
      presets = loadVendorPresets(opts.preset)
    } catch (err) {
      writeError(err && err.reason ? `${err.reason}: ${err.message}` : String(err && err.message ? err.message : err))
      return 2
    }
  }

  let pool = null
  try {
    pool = await dialect.connect(env)
    const catalog = await dialect.fetchCatalog(pool)
    const sampleFn = ({ table, cap }) => dialect.sampleRows(pool, table, cap)

    const { report, leakGuardValues, emittedIdentifiers, valueCategories, draft } = await runProbe({ catalog, sampleFn, presets })

    // Load-bearing: refuses to write ANYTHING — report and drafts alike — if the
    // self-check fails. The drafts are written last, and only after the report has
    // proven itself values-free.
    //
    // PROBE_SELF_CHECK_DIAG=1 widens only what the REFUSAL SAYS — the JSON path of the offending
    // leaf and which collector armed the value — so an operator staring at
    // `unmatched-sample-value(len=2, masked=**)` on a live source has something to act on. The
    // masked value is unchanged and the fail-closed behaviour is identical; nothing about the
    // decision depends on this flag.
    assertValuesFree(report, {
      env,
      leakGuardValues,
      emittedIdentifiers,
      valueCategories,
      diagnostics: env.PROBE_SELF_CHECK_DIAG === '1',
    })

    const outDir = path.dirname(path.resolve(opts.out))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8')
    writeFileSync(mdPathFor(opts.out), renderMarkdownSummary(report), 'utf8')

    process.stdout.write(
      `[source-discovery-probe] wrote ${opts.out} (${report.schemaInventory.length} tables, ${report.dictionaries.length} dictionaries, ${report.bomPairCandidates.length} BOM candidates, ${report.treeCandidates.length} tree candidates)\n`,
    )

    if (draft) {
      mkdirSync(draftOutDir, { recursive: true })
      for (const [name, contents] of Object.entries(draft.files)) {
        writeFileSync(path.join(draftOutDir, name), contents, 'utf8')
      }
      const counts = draft.summary.targetCounts
      // Counts and file names only — the drafts' contents are customer values and
      // STDOUT is not a deploy-host file.
      process.stdout.write(
        `[source-discovery-probe] wrote ${Object.keys(draft.files).length} draft files (preset ${draft.summary.presetId} v${draft.summary.presetVersion}, ` +
        `confidence ${draft.summary.signature.confidence.toFixed(2)}: ${counts.mappable} mappable, ${counts.deferred} deferred, ${counts.unresolved} UNRESOLVED, ${counts.placeholderProposed} placeholder)\n`,
      )
      if (counts.unresolved > 0 || counts.mappable === 0) {
        // Loud on STDERR too: a draft with gaps that scrolls past on STDOUT is the
        // silent-omission failure wearing a different hat.
        process.stderr.write(
          `[source-discovery-probe] DRAFT HAS GAPS: ${counts.unresolved} unresolved, ${counts.mappable} mappable entries — read ${DRAFT_FILE_NAMES.readme} before installing anything\n`,
        )
      }
    }
    return 0
  } catch (err) {
    if (err && /^PROBE_ENV_(MISSING|INVALID):/.test(err.message)) {
      writeError(err.message)
      return 2
    }
    if (err instanceof SourceDraftEmitterError) {
      // A CODED REFUSAL, not a crash: the probe connected, read the catalog and
      // then declined to draft anything (most often because no vendor preset's
      // signature was met). Its own exit code so an operator's script can tell
      // "we would have had to guess" apart from "the tool broke".
      writeError(`${err.reason}: ${err.message}`)
      return 3
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
  collectEmittedDictionaryStrings,
  // H1 draft mode
  buildDraftArtifacts,
  loadVendorPresets,
  readPresetTable,
}
