#!/usr/bin/env node
/**
 * data-source-exposure-inventory.mjs
 *
 * B1c exposure inventory (READ-ONLY, values-free by construction).
 *
 * Replaces an earlier ad-hoc SQL inventory that was rejected NO-GO because it was written
 * from ASSUMED schema. Its four verified errors — never repeat any of these:
 *   1. filtered external-system status with `<> 'disabled'`; the real vocabulary (CHECK
 *      constraint on integration_external_systems.status, see migration 057) is
 *      'active' | 'inactive' | 'error'.
 *   2. queried `integration_pipeline_runs`, which does not exist; the real table is
 *      `integration_runs` (migration 057_create_integration_core_tables.sql).
 *   3. assumed a `metrics.pageCount` JSON field; the real integration_runs columns are
 *      `details` (jsonb) and `rows_read` / `rows_cleaned` / `rows_written` / `rows_failed`.
 *   4. used `data_sources.deleted_at` / `is_active` unconditionally. Those columns exist in
 *      the MODERN shape (packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts)
 *      but NOT in the legacy shape (packages/core-backend/migrations/040_data_sources.sql —
 *      now a no-op history marker on fresh installs, see migration-provider.ts
 *      SUPERSEDED_LEGACY_SQL_MIGRATIONS, but still the shape some already-migrated databases
 *      may carry). The two shapes even use different status vocabularies
 *      ('active'/'inactive'/'error' vs 'connected'/'disconnected'/'error'). This script
 *      NEVER assumes either shape — see probeSchema() / buildPlan() below.
 *
 * THEREFORE: this script schema-probes FIRST (information_schema.tables / .columns) and
 * refuses to guess. If a required table or column is not verified present, the affected
 * report item is UNAVAILABLE with a stated reason — it never emits a query against an
 * unverified shape and never silently substitutes a column.
 *
 * VALUES-FREE BY CONSTRUCTION: every DB query on the allowlist below returns COUNTS only
 * (or, for information_schema probes, table/column *names* that are our own hardcoded
 * constants being confirmed present — never arbitrary row content). Type/status buckets in
 * the report are always drawn from fixed, pre-initialized constant keys (SUPPORTED_DATA_SOURCE
 * roster / the CHECK-constraint-backed status vocabularies) — a database value is only ever
 * used to select which pre-existing bucket to increment, never written into the report as a
 * new key or string.
 *
 * READ-ONLY, structurally: the query executor never receives a caller-built SQL string. Every
 * query is looked up by a fixed `tag` in QUERY_ALLOWLIST (see runQuery()); an unrecognised tag
 * throws. assertReadOnlyAllowlist() asserts, at module load, that every allowlisted statement
 * starts with SELECT and contains no non-trailing semicolon (so a hand-edited entry like
 * `SELECT 1; DROP TABLE x` cannot silently become "structurally read-only"). This is a load-time
 * check on a hand-authored constant, not a runtime SQL-injection guard or a full parser — it says
 * nothing about a value reaching QUERY_ALLOWLIST some other way, and it is not the reason
 * multi-statement execution is actually prevented at runtime (the pg client's parameterized-query
 * path used by runQuery()/createPgExecutor() does not execute stacked statements). Values passed
 * as bind parameters are either fixed module constants (the 'data-source:sql-readonly' kind,
 * table/column names) or a bounded, validated integer (--window-days) — never string-interpolated
 * into SQL text.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/ops/data-source-exposure-inventory.mjs [--window-days N] [--json]
 *   node scripts/ops/data-source-exposure-inventory.mjs --dry-run [--window-days N]   # no DB required
 *
 * Exit codes:
 *   0  ran successfully (report produced; the verdict itself may be MIGRATION_REQUIRED —
 *      that is information, this script is an inventory, not a gate)
 *   1  unexpected runtime/DB error
 *   2  required input missing (DATABASE_URL absent outside --dry-run)
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')

// ---------------------------------------------------------------------------
// Constants (closed vocabularies — never invented, always re-verified against
// the real source at authoring time; see the header comment / task report for
// citations of the exact commit/migration each one was checked against).
// ---------------------------------------------------------------------------

// Mirrors packages/core-backend/src/data-adapters/DataSourceManager.ts
// `SUPPORTED_DATA_SOURCE_TYPES` (pinned by commit 68bcd9a67 / #4583). The
// contract test derives the authoritative keys from DEFAULT_ADAPTER_REGISTRY,
// and the workflow reruns when DataSourceManager.ts changes.
const SUPPORTED_DATA_SOURCE_TYPES = Object.freeze([
  'postgresql',
  'postgres',
  'http',
  'sqlserver',
  'mysql',
  'plm',
])

// CHECK constraint on integration_external_systems.status (migration
// 057_create_integration_core_tables.sql line: `CHECK (status IN ('active', 'inactive', 'error'))`).
const EXTERNAL_SYSTEM_STATUSES = Object.freeze(['active', 'inactive', 'error'])

// The plugin kind string this inventory is scoped to (verified against
// plugins/plugin-integration-core/lib/pipeline-runner.cjs DATA_SOURCE_SQL_READONLY_KIND and
// the `source.kind` validators in stock-preparation-table-actions.cjs / stock-preparation-templates.cjs).
const TARGET_KIND = 'data-source:sql-readonly'

const DEFAULT_WINDOW_DAYS = 30
const MIN_WINDOW_DAYS = 1
const MAX_WINDOW_DAYS = 365

// Appended to every "table/column not found" reason. information_schema only
// reports objects visible to the connected role. A role that was never granted
// the required privileges is indistinguishable from a genuinely absent object
// and will UNAVAILABLE that item too. Count queries explicitly qualify the same
// public schema, so connection-level search_path cannot redirect them elsewhere.
const SCHEMA_PROBE_CAVEAT =
  "probed via information_schema.tables/.columns, table_schema='public', as the DATABASE_URL role — missing visibility/privileges report the same as a genuinely absent object"

// ---------------------------------------------------------------------------
// QUERY_ALLOWLIST — the ONLY SQL statements this script will ever execute.
// runQuery() rejects any tag not in this object. Every statement is SELECT-only;
// assertReadOnlyAllowlist() enforces that structurally at module load.
// ---------------------------------------------------------------------------

const QUERY_ALLOWLIST = Object.freeze({
  'probe.table_exists': {
    sql: `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 AND table_type = 'BASE TABLE' LIMIT 1`,
    describe: 'schema probe: does table $1 exist',
  },
  'probe.columns': {
    sql: `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    describe: 'schema probe: which columns exist on table $1',
  },
  'count.data_sources_all_types': {
    sql: `SELECT type, count(*)::bigint AS n FROM public.data_sources GROUP BY type`,
    describe: 'registered data_sources grouped by type',
  },
  'count.data_sources_active_types.with_deleted_at': {
    sql: `SELECT type, count(*)::bigint AS n FROM public.data_sources WHERE is_active = true AND deleted_at IS NULL GROUP BY type`,
    describe: 'active, non-soft-deleted data_sources grouped by type (modern schema shape)',
  },
  'count.data_sources_active_types.without_deleted_at': {
    sql: `SELECT type, count(*)::bigint AS n FROM public.data_sources WHERE is_active = true GROUP BY type`,
    describe: 'active data_sources grouped by type (is_active present, no deleted_at column)',
  },
  'count.external_systems_status_by_kind': {
    sql: `SELECT status, count(*)::bigint AS n FROM public.integration_external_systems WHERE kind = $1 GROUP BY status`,
    describe: 'integration_external_systems of a given kind, grouped by status',
  },
  'count.approved_read_source_configs_by_kind': {
    sql: `SELECT count(*)::bigint AS n
          FROM public.integration_read_source_configs c
          JOIN public.integration_external_systems s ON s.id = c.system_id
          WHERE s.kind = $1 AND c.status = 'approved'`,
    describe: 'approved integration_read_source_configs bound to external systems of a given kind',
  },
  'count.pipelines_by_source_kind': {
    sql: `SELECT count(*)::bigint AS n
          FROM public.integration_pipelines p
          JOIN public.integration_external_systems s ON s.id = p.source_system_id
          WHERE s.kind = $1`,
    describe: 'integration_pipelines whose source_system_id resolves to a given kind',
  },
  'count.runs_by_kind_window': {
    sql: `SELECT count(*)::bigint AS n
          FROM public.integration_runs r
          JOIN public.integration_pipelines p ON p.id = r.pipeline_id
          JOIN public.integration_external_systems s ON s.id = p.source_system_id
          WHERE s.kind = $1 AND r.created_at >= NOW() - make_interval(days => $2::int)`,
    describe: 'integration_runs within a window, for pipelines whose source resolves to a given kind',
  },
})

function assertReadOnlyAllowlist(allowlist) {
  for (const [tag, entry] of Object.entries(allowlist)) {
    if (!/^\s*SELECT\b/i.test(entry.sql)) {
      throw new Error(
        `data-source-exposure-inventory: QUERY_ALLOWLIST entry "${tag}" is not a SELECT statement — refusing to load a non-read-only query.`,
      )
    }
    // Reject a non-trailing semicolon: without this, `SELECT 1; DROP TABLE x`
    // would pass the start-anchored check above by virtue of starting with
    // SELECT. A single semicolon at the very end (harmless statement
    // terminator) is still allowed.
    const trimmed = entry.sql.trim()
    const withoutTrailingSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
    if (withoutTrailingSemicolon.includes(';')) {
      throw new Error(
        `data-source-exposure-inventory: QUERY_ALLOWLIST entry "${tag}" contains a non-trailing semicolon — refusing to load a possible multi-statement query.`,
      )
    }
  }
}
assertReadOnlyAllowlist(QUERY_ALLOWLIST)

async function runQuery(exec, tag, params = []) {
  const entry = QUERY_ALLOWLIST[tag]
  if (!entry) {
    throw new Error(`data-source-exposure-inventory: query tag not on allowlist: ${tag}`)
  }
  return exec(entry.sql, params)
}

// ---------------------------------------------------------------------------
// Schema probing
// ---------------------------------------------------------------------------

const TABLE_SPECS = Object.freeze({
  data_sources: ['type', 'is_active', 'deleted_at', 'status'],
  integration_external_systems: ['id', 'kind', 'status'],
  integration_read_source_configs: ['system_id', 'status'],
  integration_pipelines: ['id', 'source_system_id'],
  integration_runs: ['id', 'pipeline_id', 'created_at'],
})

async function tableExists(exec, tableName) {
  const { rows } = await runQuery(exec, 'probe.table_exists', [tableName])
  return rows.length > 0
}

async function probeColumns(exec, tableName, wantedColumns) {
  const { rows } = await runQuery(exec, 'probe.columns', [tableName])
  const present = new Set(rows.map((r) => r.column_name))
  const result = {}
  for (const col of wantedColumns) result[col] = present.has(col)
  return result
}

async function probeSchema(exec) {
  const schema = {}
  for (const [table, cols] of Object.entries(TABLE_SPECS)) {
    const exists = await tableExists(exec, table)
    const columns = exists
      ? await probeColumns(exec, table, cols)
      : Object.fromEntries(cols.map((c) => [c, false]))
    schema[table] = { exists, columns }
  }
  return schema
}

// ---------------------------------------------------------------------------
// Plan builder — pure function of (schema, options). Used identically by
// --dry-run (to print the plan without executing counts) and by report mode
// (to execute it). This is the single place that decides UNAVAILABLE vs OK.
// ---------------------------------------------------------------------------

function planDataSources(schema) {
  const t = schema.data_sources
  if (!t.exists) {
    return { status: 'unavailable', reason: `table data_sources not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  if (!t.columns.type) {
    return { status: 'unavailable', reason: `data_sources.type column not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  const registered = { tag: 'count.data_sources_all_types', params: [] }
  let active
  if (!t.columns.is_active) {
    active = {
      status: 'unavailable',
      reason: `data_sources.is_active column not present (${SCHEMA_PROBE_CAVEAT}) — either a legacy pre-modern-migration install (see 040_data_sources.sql vs 20251206000001_create_data_sources_table.ts) or a privilege gap; refusing to guess an "active" predicate from the status column, whose vocabulary also differs across those two shapes`,
    }
  } else if (t.columns.deleted_at) {
    active = { status: 'ok', tag: 'count.data_sources_active_types.with_deleted_at', params: [] }
  } else {
    active = { status: 'ok', tag: 'count.data_sources_active_types.without_deleted_at', params: [] }
  }
  return { status: 'ok', registered, active }
}

function planExternalSystems(schema, kind) {
  const t = schema.integration_external_systems
  if (!t.exists) {
    return { status: 'unavailable', reason: `table integration_external_systems not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  const missing = ['kind', 'status'].filter((c) => !t.columns[c])
  if (missing.length) {
    return {
      status: 'unavailable',
      reason: `integration_external_systems missing column(s): ${missing.join(', ')} (${SCHEMA_PROBE_CAVEAT})`,
    }
  }
  return { status: 'ok', tag: 'count.external_systems_status_by_kind', params: [kind] }
}

function planApprovedConfigs(schema, kind) {
  const c = schema.integration_read_source_configs
  const s = schema.integration_external_systems
  const missingTables = []
  if (!c.exists) missingTables.push('integration_read_source_configs')
  if (!s.exists) missingTables.push('integration_external_systems')
  if (missingTables.length) {
    return { status: 'unavailable', reason: `missing table(s): ${missingTables.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  const missingCols = []
  if (!c.columns.system_id) missingCols.push('integration_read_source_configs.system_id')
  if (!c.columns.status) missingCols.push('integration_read_source_configs.status')
  if (!s.columns.id) missingCols.push('integration_external_systems.id')
  if (!s.columns.kind) missingCols.push('integration_external_systems.kind')
  if (missingCols.length) {
    return { status: 'unavailable', reason: `missing column(s): ${missingCols.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  return { status: 'ok', tag: 'count.approved_read_source_configs_by_kind', params: [kind] }
}

function planPipelines(schema, kind) {
  const p = schema.integration_pipelines
  const s = schema.integration_external_systems
  const missingTables = []
  if (!p.exists) missingTables.push('integration_pipelines')
  if (!s.exists) missingTables.push('integration_external_systems')
  if (missingTables.length) {
    return { status: 'unavailable', reason: `missing table(s): ${missingTables.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  const missingCols = []
  if (!p.columns.source_system_id) missingCols.push('integration_pipelines.source_system_id')
  if (!s.columns.id) missingCols.push('integration_external_systems.id')
  if (!s.columns.kind) missingCols.push('integration_external_systems.kind')
  if (missingCols.length) {
    return { status: 'unavailable', reason: `missing column(s): ${missingCols.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  return { status: 'ok', tag: 'count.pipelines_by_source_kind', params: [kind] }
}

function planRunsWindow(schema, kind, windowDays) {
  const r = schema.integration_runs
  const p = schema.integration_pipelines
  const s = schema.integration_external_systems
  const missingTables = []
  if (!r.exists) missingTables.push('integration_runs')
  if (!p.exists) missingTables.push('integration_pipelines')
  if (!s.exists) missingTables.push('integration_external_systems')
  if (missingTables.length) {
    return { status: 'unavailable', reason: `missing table(s): ${missingTables.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  const missingCols = []
  if (!r.columns.pipeline_id) missingCols.push('integration_runs.pipeline_id')
  if (!r.columns.created_at) missingCols.push('integration_runs.created_at')
  if (!p.columns.id) missingCols.push('integration_pipelines.id')
  if (!p.columns.source_system_id) missingCols.push('integration_pipelines.source_system_id')
  if (!s.columns.id) missingCols.push('integration_external_systems.id')
  if (!s.columns.kind) missingCols.push('integration_external_systems.kind')
  if (missingCols.length) {
    return { status: 'unavailable', reason: `missing column(s): ${missingCols.join(', ')} (${SCHEMA_PROBE_CAVEAT})` }
  }
  return { status: 'ok', tag: 'count.runs_by_kind_window', params: [kind, windowDays] }
}

function buildPlan(schema, { windowDays = DEFAULT_WINDOW_DAYS, kind = TARGET_KIND } = {}) {
  return {
    kind,
    windowDays,
    dataSources: planDataSources(schema),
    externalSystems: planExternalSystems(schema, kind),
    approvedConfigs: planApprovedConfigs(schema, kind),
    pipelines: planPipelines(schema, kind),
    runsWindow: planRunsWindow(schema, kind, windowDays),
  }
}

// ---------------------------------------------------------------------------
// Bucketing — DB values are only ever used to pick which pre-existing key to
// increment. The serialized report never contains a key or string that did
// not already exist as one of these fixed constants.
// ---------------------------------------------------------------------------

function normalizeCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error('data-source-exposure-inventory: invalid aggregate count')
}

function addCounts(left, right) {
  return normalizeCount(left + right)
}

function bucketDataSourceTypeCounts(rows) {
  const buckets = Object.fromEntries(SUPPORTED_DATA_SOURCE_TYPES.map((t) => [t, 0]))
  buckets.other = 0
  let total = 0
  for (const row of rows) {
    const n = normalizeCount(row.n)
    total = addCounts(total, n)
    if (SUPPORTED_DATA_SOURCE_TYPES.includes(row.type)) {
      buckets[row.type] = addCounts(buckets[row.type], n)
    } else {
      buckets.other = addCounts(buckets.other, n)
    }
  }
  return { buckets, total }
}

function bucketExternalSystemStatusCounts(rows) {
  const buckets = Object.fromEntries(EXTERNAL_SYSTEM_STATUSES.map((s) => [s, 0]))
  buckets.unexpected = 0
  let total = 0
  for (const row of rows) {
    const n = normalizeCount(row.n)
    total = addCounts(total, n)
    if (EXTERNAL_SYSTEM_STATUSES.includes(row.status)) {
      buckets[row.status] = addCounts(buckets[row.status], n)
    } else {
      buckets.unexpected = addCounts(buckets.unexpected, n)
    }
  }
  return { buckets, total }
}

// ---------------------------------------------------------------------------
// Plan execution — only runs queries for items the plan marked 'ok'.
// ---------------------------------------------------------------------------

async function executeDataSourcesPlan(exec, plan) {
  if (plan.status !== 'ok') return plan
  const registeredResult = await runQuery(exec, plan.registered.tag, plan.registered.params)
  const registered = bucketDataSourceTypeCounts(registeredResult.rows)

  let active
  if (plan.active.status !== 'ok') {
    active = { status: 'unavailable', reason: plan.active.reason }
  } else {
    const activeResult = await runQuery(exec, plan.active.tag, plan.active.params)
    const bucketed = bucketDataSourceTypeCounts(activeResult.rows)
    active = { status: 'ok', byType: bucketed.buckets, total: bucketed.total }
  }

  return {
    status: 'ok',
    registeredByType: registered.buckets,
    registeredTotal: registered.total,
    active,
  }
}

async function executeExternalSystemsPlan(exec, plan) {
  if (plan.status !== 'ok') return plan
  const { rows } = await runQuery(exec, plan.tag, plan.params)
  const { buckets, total } = bucketExternalSystemStatusCounts(rows)
  return { status: 'ok', kind: plan.params[0], byStatus: buckets, total }
}

async function executeScalarCountPlan(exec, plan) {
  if (plan.status !== 'ok') return plan
  const { rows } = await runQuery(exec, plan.tag, plan.params)
  if (rows.length !== 1) {
    throw new Error('data-source-exposure-inventory: invalid aggregate row count')
  }
  const count = normalizeCount(rows[0].n)
  return { status: 'ok', count }
}

async function executePlan(exec, plan) {
  const [dataSources, externalSystems, approvedConfigs, pipelines, runsWindow] = await Promise.all([
    executeDataSourcesPlan(exec, plan.dataSources),
    executeExternalSystemsPlan(exec, plan.externalSystems),
    executeScalarCountPlan(exec, plan.approvedConfigs),
    executeScalarCountPlan(exec, plan.pipelines),
    executeScalarCountPlan(exec, plan.runsWindow),
  ])
  return { dataSources, externalSystems, approvedConfigs, pipelines, runsWindow }
}

// ---------------------------------------------------------------------------
// Static in-repo caller enumeration (item 2). Needs no database. Fails closed
// (marks the item unavailable) if an anchor file cannot be found, rather than
// silently reporting zero call sites because of a wrong repoRoot / cwd.
// ---------------------------------------------------------------------------

// Verified against the real symbols at authoring time and rechecked by anchors:
//   - plugins/plugin-integration-core/lib/pipeline-runner.cjs
//       DATA_SOURCE_SQL_READONLY_KIND
//   - packages/core-backend/src/routes/data-sources.ts
//       router.post('/api/data-sources/:id/select', ...)
//   - packages/core-backend/src/data-adapters/DataSourceManager.ts
//       sourceAdapter.select(...) inside DataSourceManager.select
//   - packages/core-backend/src/data-adapters/DataSourceManager.ts
//       async copyData(...) — has no live in-tree caller (verified: repo-wide
//       grep for `.copyData(` outside this file's own definition line and
//       outside univer-meta.ts's unrelated `copyData` object-literal variable
//       found zero call sites)
//   - plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs
//       api.select(...)
const DEFAULT_ANCHORS = Object.freeze([
  {
    id: 'target_kind',
    file: 'plugins/plugin-integration-core/lib/pipeline-runner.cjs',
    pattern:
      /const\s+DATA_SOURCE_SQL_READONLY_KIND\s*=\s*'data-source:sql-readonly'/,
  },
  {
    id: 'select_route',
    file: 'packages/core-backend/src/routes/data-sources.ts',
    pattern: /router\.post\(\s*'\/api\/data-sources\/:id\/select'/,
  },
  {
    id: 'manager_select_internal',
    file: 'packages/core-backend/src/data-adapters/DataSourceManager.ts',
    pattern: /sourceAdapter\.select\(/,
  },
  {
    id: 'copy_data_definition',
    file: 'packages/core-backend/src/data-adapters/DataSourceManager.ts',
    pattern: /async\s+copyData\(/,
  },
  {
    id: 'sql_readonly_adapter_select',
    file: 'plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs',
    pattern: /\bapi\.select\(/,
  },
])

const DEFAULT_SCAN_ROOTS = Object.freeze(['packages/core-backend/src', 'plugins'])
const SCAN_EXTENSIONS = new Set(['.ts', '.cjs', '.js'])
const TEST_PATH_PATTERN = /(^|[/\\])(__tests__|__mocks__|fixtures)([/\\]|$)|\.(test|spec)\.[cm]?[jt]s$/

const SELECT_CALL_PATTERN = /\b(?:manager|adapter|sourceAdapter|api)\.select\s*\(/
const COPY_DATA_CALL_PATTERN = /\.copyData\s*\(/
const SELECT_ROUTE_STRING_PATTERN = /'\/api\/data-sources\/:id\/select'/

function walkFiles(rootAbs, extSet, out, failures) {
  let entries
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true })
  } catch {
    failures.push('directory_read_failed')
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const fullAbs = path.join(rootAbs, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullAbs, extSet, out, failures)
    } else if (extSet.has(path.extname(entry.name))) {
      out.push(fullAbs)
    }
  }
}

function enumerateStaticCallSites({ repoRoot = REPO_ROOT, anchors = DEFAULT_ANCHORS, scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const anchorsMissing = []
  const anchorsVerified = []
  for (const anchor of anchors) {
    const abs = path.join(repoRoot, anchor.file)
    let content = null
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      anchorsMissing.push(anchor.id)
      continue
    }
    if (anchor.pattern.test(content)) {
      anchorsVerified.push(anchor.id)
    } else {
      // File exists but the expected shape drifted — also fail closed: the
      // enumerator's assumptions about this file no longer hold.
      anchorsMissing.push(anchor.id)
    }
  }

  if (anchorsMissing.length > 0) {
    return {
      status: 'unavailable',
      reason: `anchor file(s)/pattern(s) not verified: ${anchorsMissing.join(', ')} — refusing to report a caller count that a wrong repoRoot or code drift could make silently zero`,
      anchorsVerified,
      anchorsMissing,
    }
  }

  const files = []
  const scanFailures = []
  for (const root of scanRoots) {
    walkFiles(path.join(repoRoot, root), SCAN_EXTENSIONS, files, scanFailures)
  }
  if (scanFailures.length > 0) {
    return {
      status: 'unavailable',
      reason:
        'one or more declared scan roots or directories could not be read — refusing to report a partial caller count',
      anchorsVerified,
      anchorsMissing,
      scanFailureCount: scanFailures.length,
    }
  }

  const counts = {
    managerOrAdapterSelectCallSites: { nonTest: 0, test: 0 },
    copyDataCallSites: { nonTest: 0, test: 0 },
    selectRouteDefinitions: { nonTest: 0, test: 0 },
  }

  for (const fileAbs of files) {
    const relPath = path.relative(repoRoot, fileAbs)
    const isTest = TEST_PATH_PATTERN.test(relPath)
    let content
    try {
      content = readFileSync(fileAbs, 'utf8')
    } catch {
      scanFailures.push('file_read_failed')
      continue
    }
    const bucket = isTest ? 'test' : 'nonTest'
    const codeOnly = stripLineCommentLines(content)
    counts.managerOrAdapterSelectCallSites[bucket] += countMatches(codeOnly, SELECT_CALL_PATTERN)
    counts.copyDataCallSites[bucket] += countMatches(codeOnly, COPY_DATA_CALL_PATTERN)
    counts.selectRouteDefinitions[bucket] += countMatches(codeOnly, SELECT_ROUTE_STRING_PATTERN)
  }
  if (scanFailures.length > 0) {
    return {
      status: 'unavailable',
      reason:
        'one or more declared source files could not be read — refusing to report a partial caller count',
      anchorsVerified,
      anchorsMissing,
      scanFailureCount: scanFailures.length,
    }
  }

  return {
    status: 'ok',
    scanRoots,
    scannedFileCount: files.length,
    anchorsVerified,
    counts,
    limitation:
      'text-line scan, not an AST parse: whole-line comments are stripped before matching, but an inline trailing comment or the interior of a /* */ block can still be mis-counted; errs toward over-, not under-, counting',
    knownCallers: [
      { id: 'select_route', note: 'POST /api/data-sources/:id/select' },
      { id: 'sql_readonly_adapter', note: 'plugin data-source:sql-readonly adapter (api.select)' },
      {
        id: 'copy_data',
        note: 'DataSourceManager.copyData',
        hasLiveCaller: counts.copyDataCallSites.nonTest > 0,
      },
    ],
  }
}

// Heuristic-only: drops lines that are ENTIRELY a comment (leading //, /*, *,
// or #). This is a line-based text scan, not an AST parse — it will still
// mis-count an inline trailing comment (`foo() // adapter.select( example`)
// or a multi-line /* ... */ block whose interior lines don't start with `*`.
// It deliberately errs toward over-counting (a stray comment counted as a
// "call site") rather than under-counting (a real call site hidden inside a
// comment causing a false negative) — see the staticCallSiteEnumeration
// limitation note in the report.
function stripLineCommentLines(content) {
  return content
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*|#)/.test(line) ? '' : line))
    .join('\n')
}

function countMatches(content, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const matches = content.match(re)
  return matches ? matches.length : 0
}

// ---------------------------------------------------------------------------
// Access-log recipe (item 3) — text only, no execution, no DB.
// ---------------------------------------------------------------------------

function buildAccessLogRecipe({ windowDays }) {
  return {
    status: 'manual',
    note: 'Operator-run recipe. This script does NOT execute it or read any access log.',
    requiredOperatorInputs: ['ACCESS_LOG_PATH', 'RETENTION_SCOPE (which log retention window this covers)', 'OBSERVATION_WINDOW_START', 'OBSERVATION_WINDOW_END'],
    suggestedObservationWindowDays: windowDays,
    grepShape:
      "grep 'POST /api/data-sources/' \"$ACCESS_LOG_PATH\"",
    jqShape:
      'jq -R \'select(test("POST /api/data-sources/[^ ]+/select"))\' \\\n' +
      '  | jq -Rr \'capture("offset=(?<offset>[0-9]+)").offset? // empty\' # then cross-reference the same request for an absent orderBy param',
    fullRecipe: [
      '# Fill in ACCESS_LOG_PATH / RETENTION_SCOPE / OBSERVATION_WINDOW_START / OBSERVATION_WINDOW_END before running.',
      '# Counts requests to POST /api/data-sources/:id/select where the request body or query',
      '# carries offset>0 with no orderBy — the pattern PAGED_READ certification concerns itself with.',
      'grep "POST /api/data-sources/" "$ACCESS_LOG_PATH" \\',
      '  | awk -v start="$OBSERVATION_WINDOW_START" -v end="$OBSERVATION_WINDOW_END" \'$0 >= start && $0 <= end\' \\',
      '  | grep -E \'"offset":\\s*[1-9][0-9]*\' \\',
      '  | grep -vE \'"orderBy":\\s*"[^"]+"\' \\',
      '  | wc -l',
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Residual blind spots (item 4) — always non-empty; a zero result elsewhere
// in this report must never be read as "proven zero".
// ---------------------------------------------------------------------------

const STATIC_RESIDUAL_BLIND_SPOTS = Object.freeze([
  {
    id: 'adapter_telemetry_not_deployed',
    description:
      'The BaseAdapter chokepoint counter unorderedOffsetAttemptCount (offset>0 without orderBy) is NOT deployed/exposed anywhere in this codebase today (verified: zero repo hits) — the owner deliberately did not open that gate early. This inventory has no runtime signal for offset-without-orderBy calls that actually executed. A zero elsewhere in this report is DB/static coverage only, never proof of zero live risk.',
  },
  {
    id: 'access_log_window_is_operator_supplied',
    description:
      'The access-log recipe in this report is not executed by this script. Its coverage is exactly whatever retention window and log scope the operator supplies when they run it by hand against a real deployment access log — nothing outside that window, and nothing on a path that does not log query/body parameters (e.g. some reverse-proxy configurations).',
  },
  {
    id: 'db_inventory_scoped_to_target_kind',
    description:
      `The DB inventory (external systems / approved configs / pipelines / runs) is scoped to kind = '${TARGET_KIND}' only, per the B1c/PAGED_READ concern. It does not cross-check the general data_sources registry (item 1a, all types) against pagination usage — a data source of any type could in principle be reached via a caller this script's static enumeration did not anticipate.`,
  },
])

function buildResidualBlindSpots(
  coverage,
  { staticCallSiteEnumeration = null } = {},
) {
  const dynamic = []
  if (coverage.dataSources.status === 'unavailable') {
    dynamic.push({ id: 'data_sources_table_gap', description: coverage.dataSources.reason })
  } else if (coverage.dataSources.active.status === 'unavailable') {
    dynamic.push({ id: 'data_sources_active_column_gap', description: coverage.dataSources.active.reason })
  }
  for (const [key, item] of [
    ['external_systems_gap', coverage.externalSystems],
    ['approved_configs_gap', coverage.approvedConfigs],
    ['pipelines_gap', coverage.pipelines],
    ['runs_window_gap', coverage.runsWindow],
  ]) {
    if (item.status === 'unavailable') {
      dynamic.push({ id: key, description: item.reason })
    }
  }
  if (
    staticCallSiteEnumeration &&
    staticCallSiteEnumeration.status !== 'ok'
  ) {
    dynamic.push({
      id: 'static_call_site_enumeration_gap',
      description: staticCallSiteEnumeration.reason,
    })
  }
  return [...STATIC_RESIDUAL_BLIND_SPOTS, ...dynamic]
}

// ---------------------------------------------------------------------------
// Verdict — a positive control: three distinct reachable outcomes.
// ---------------------------------------------------------------------------

function computeVerdict(coverage) {
  const gapReasons = []
  if (coverage.dataSources.status !== 'ok') gapReasons.push(`dataSources: ${coverage.dataSources.reason}`)
  else if (coverage.dataSources.active.status !== 'ok') gapReasons.push(`dataSources.active: ${coverage.dataSources.active.reason}`)
  if (coverage.externalSystems.status !== 'ok') gapReasons.push(`externalSystems: ${coverage.externalSystems.reason}`)
  else if (
    !Number.isSafeInteger(coverage.externalSystems.byStatus?.unexpected) ||
    coverage.externalSystems.byStatus.unexpected !== 0
  ) {
    gapReasons.push(
      'externalSystems: status vocabulary drift detected; unexpected bucket must be exactly zero',
    )
  }
  if (coverage.approvedConfigs.status !== 'ok') gapReasons.push(`approvedConfigs: ${coverage.approvedConfigs.reason}`)
  if (coverage.pipelines.status !== 'ok') gapReasons.push(`pipelines: ${coverage.pipelines.reason}`)
  if (coverage.runsWindow.status !== 'ok') gapReasons.push(`runsWindow: ${coverage.runsWindow.reason}`)
  // staticCallSiteEnumeration is a declared coverage group (see COVERAGE_LABELS /
  // report.coverage.staticCallSiteEnumeration) with a real fail-closed UNAVAILABLE
  // state (anchor file missing/drifted — see enumerateStaticCallSites). A missing
  // key counts as a gap too (fail closed on an absent signal, never fail open).
  const staticCallSites = coverage.staticCallSiteEnumeration
  if (!staticCallSites || staticCallSites.status !== 'ok') {
    gapReasons.push(`staticCallSiteEnumeration: ${staticCallSites ? staticCallSites.reason : 'not supplied to computeVerdict'}`)
  }

  if (gapReasons.length > 0) {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [`coverage is partial — ${gapReasons.length} item(s) UNAVAILABLE`, ...gapReasons],
    }
  }

  const activeExternalSystems = coverage.externalSystems.byStatus.active
  const riskSum = activeExternalSystems + coverage.approvedConfigs.count + coverage.pipelines.count + coverage.runsWindow.count

  if (riskSum === 0) {
    return {
      verdict: 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE',
      reasons: [
        `all DB coverage items resolved (full schema coverage) and the kind='${coverage.externalSystems.kind}' risk surface is zero: 0 active external systems, 0 approved configs, 0 pipelines, 0 runs in the observation window`,
        'this is a within-coverage finding only — see residualBlindSpots for what it does NOT prove',
      ],
    }
  }

  return {
    verdict: 'MIGRATION_REQUIRED',
    reasons: [
      `kind='${coverage.externalSystems.kind}' exposure surface is non-zero within coverage (activeExternalSystems=${activeExternalSystems}, approvedConfigs=${coverage.approvedConfigs.count}, pipelines=${coverage.pipelines.count}, runsInWindow=${coverage.runsWindow.count}) — configuration/usage exists that a PAGED_READ semantics change would affect`,
      'this does NOT mean a paging defect (offset>0 without orderBy) was found or ever executed — this report has no runtime signal for that at all; it means the surface exists and must be planned for. See residualBlindSpots, especially adapter_telemetry_not_deployed and access_log_window_is_operator_supplied, before treating this as anything more specific than "plan a migration".',
    ],
  }
}

// ---------------------------------------------------------------------------
// Coverage labels — the brief requires every coverage item to state WHAT IT
// COVERS and its BLIND SPOT, not just a residual-blind-spots afterthought.
// ---------------------------------------------------------------------------

const COVERAGE_LABELS = Object.freeze({
  dbInventory: {
    covers:
      `config-driven plugin reads: registered/active data_sources by type; external systems, approved read-source configs, pipelines, and runs bound to kind='${TARGET_KIND}'.`,
    blindSpot:
      'DB rows only. A caller that reaches manager.select()/adapter.select() without ever registering a data_sources row, external system, pipeline, or run is invisible here — see staticCallSiteEnumeration for the code-path side of that gap.',
  },
  staticCallSiteEnumeration: {
    covers:
      "in-repo entry points: every static call site of manager.select() / adapter.select() / the POST /api/data-sources/:id/select route, plus DataSourceManager.copyData, found by scanning packages/core-backend/src and plugins.",
    blindSpot:
      'source code only, at the commit checked out when this ran. Says nothing about whether any call site ever executed, how often, or with what parameters — in particular, whether any real call used offset>0 without orderBy. It is also a line-based text scan, not an AST parse (see this item\'s own "limitation" field for the precision caveat).',
  },
  accessLogRecipe: {
    covers:
      'ad-hoc HTTP callers, within the operator-supplied observation window only: a grep/jq recipe to count POST /api/data-sources/:id/select requests carrying offset>0 with no orderBy in a real deployment access log.',
    blindSpot:
      'this script does not execute the recipe. Coverage is exactly the retention window and log scope the operator supplies by hand when they run it — nothing before/after that window, and nothing on a path that does not log the relevant request fields.',
  },
})

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

async function buildReport({ exec, windowDays = DEFAULT_WINDOW_DAYS, repoRoot = REPO_ROOT } = {}) {
  const schema = await probeSchema(exec)
  const plan = buildPlan(schema, { windowDays })
  const coverage = await executePlan(exec, plan)
  const staticCallSiteEnumeration = enumerateStaticCallSites({ repoRoot })
  const accessLogRecipe = buildAccessLogRecipe({ windowDays })
  const residualBlindSpots = buildResidualBlindSpots(coverage, {
    staticCallSiteEnumeration,
  })
  const { verdict, reasons } = computeVerdict({ ...coverage, staticCallSiteEnumeration })

  return {
    generatedAt: new Date().toISOString(),
    mode: 'report',
    observationWindow: { days: windowDays, unit: 'days', appliesTo: ['runsWindow', 'accessLogRecipe.suggestedObservationWindowDays'] },
    targetKind: TARGET_KIND,
    coverage: {
      dbInventory: {
        covers: COVERAGE_LABELS.dbInventory.covers,
        blindSpot: COVERAGE_LABELS.dbInventory.blindSpot,
        dataSources: coverage.dataSources,
        externalSystemsByStatus: coverage.externalSystems,
        approvedReadSourceConfigsBoundToKind: coverage.approvedConfigs,
        pipelinesBySourceKind: coverage.pipelines,
        runsByKindWithinWindow: coverage.runsWindow,
      },
      staticCallSiteEnumeration: {
        covers: COVERAGE_LABELS.staticCallSiteEnumeration.covers,
        blindSpot: COVERAGE_LABELS.staticCallSiteEnumeration.blindSpot,
        ...staticCallSiteEnumeration,
      },
      accessLogRecipe: {
        covers: COVERAGE_LABELS.accessLogRecipe.covers,
        blindSpot: COVERAGE_LABELS.accessLogRecipe.blindSpot,
        ...accessLogRecipe,
      },
    },
    residualBlindSpots,
    verdict,
    verdictReasons: reasons,
  }
}

// ---------------------------------------------------------------------------
// Dry-run / plan mode — resolves the SAME buildPlan() so the printed plan can
// never show a query/column the schema probe would have refused. If no
// executor is available (no live DB), falls back to a fully static listing of
// the allowlist plus the always-DB-free parts (static enumeration, recipe,
// blind spots) — still reviewable and testable without a DB.
// ---------------------------------------------------------------------------

async function buildDryRunReport({ exec, windowDays = DEFAULT_WINDOW_DAYS, repoRoot = REPO_ROOT } = {}) {
  const staticCallSiteEnumeration = enumerateStaticCallSites({ repoRoot })
  const accessLogRecipe = buildAccessLogRecipe({ windowDays })
  const labeledCoverage = {
    staticCallSiteEnumeration: {
      covers: COVERAGE_LABELS.staticCallSiteEnumeration.covers,
      blindSpot: COVERAGE_LABELS.staticCallSiteEnumeration.blindSpot,
      ...staticCallSiteEnumeration,
    },
    accessLogRecipe: {
      covers: COVERAGE_LABELS.accessLogRecipe.covers,
      blindSpot: COVERAGE_LABELS.accessLogRecipe.blindSpot,
      ...accessLogRecipe,
    },
  }

  if (!exec) {
    return {
      generatedAt: new Date().toISOString(),
      mode: 'dry-run-static',
      note: 'No query executor / DATABASE_URL supplied — schema was not probed. This lists every allowlisted query and the (unresolved) conditional gating logic; see buildPlan() in the script source for exact resolution rules.',
      observationWindow: { days: windowDays, unit: 'days' },
      targetKind: TARGET_KIND,
      allowlist: Object.fromEntries(Object.entries(QUERY_ALLOWLIST).map(([tag, e]) => [tag, { describe: e.describe, sql: e.sql }])),
      coverage: labeledCoverage,
      residualBlindSpots: STATIC_RESIDUAL_BLIND_SPOTS,
    }
  }

  const schema = await probeSchema(exec)
  const plan = buildPlan(schema, { windowDays })

  function describePlanItem(item) {
    if (item.status !== 'ok') return { status: 'unavailable', reason: item.reason }
    if (item.registered) {
      // dataSources shape: nested registered/active plans
      const out = {
        status: 'ok',
        registered: { tag: item.registered.tag, sql: QUERY_ALLOWLIST[item.registered.tag].sql, params: item.registered.params },
      }
      out.active =
        item.active.status === 'ok'
          ? { status: 'ok', tag: item.active.tag, sql: QUERY_ALLOWLIST[item.active.tag].sql, params: item.active.params }
          : { status: 'unavailable', reason: item.active.reason }
      return out
    }
    return { status: 'ok', tag: item.tag, sql: QUERY_ALLOWLIST[item.tag].sql, params: item.params }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    note: 'Schema WAS probed (read-only information_schema queries). No aggregate/count query below was executed — this is exactly what report mode would run next.',
    observationWindow: { days: windowDays, unit: 'days' },
    targetKind: TARGET_KIND,
    schema,
    plan: {
      covers: COVERAGE_LABELS.dbInventory.covers,
      blindSpot: COVERAGE_LABELS.dbInventory.blindSpot,
      dataSources: describePlanItem(plan.dataSources),
      externalSystems: describePlanItem(plan.externalSystems),
      approvedConfigs: describePlanItem(plan.approvedConfigs),
      pipelines: describePlanItem(plan.pipelines),
      runsWindow: describePlanItem(plan.runsWindow),
    },
    coverage: labeledCoverage,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHumanSummary(report) {
  const lines = []
  lines.push(`data-source-exposure-inventory — mode=${report.mode} generatedAt=${report.generatedAt}`)
  if (report.mode === 'report') {
    lines.push(`verdict: ${report.verdict}`)
    for (const r of report.verdictReasons) lines.push(`  - ${r}`)
    lines.push('')
    lines.push('coverage:')
    const db = report.coverage.dbInventory
    lines.push(`  data_sources:            ${db.dataSources.status}${db.dataSources.status === 'ok' ? ` (registeredTotal=${db.dataSources.registeredTotal}, active=${db.dataSources.active.status === 'ok' ? db.dataSources.active.total : 'UNAVAILABLE'})` : ` (${db.dataSources.reason})`}`)
    lines.push(`  external_systems(${report.targetKind}): ${db.externalSystemsByStatus.status}${db.externalSystemsByStatus.status === 'ok' ? ` (total=${db.externalSystemsByStatus.total})` : ` (${db.externalSystemsByStatus.reason})`}`)
    lines.push(`  approved_configs:        ${db.approvedReadSourceConfigsBoundToKind.status}${db.approvedReadSourceConfigsBoundToKind.status === 'ok' ? ` (count=${db.approvedReadSourceConfigsBoundToKind.count})` : ` (${db.approvedReadSourceConfigsBoundToKind.reason})`}`)
    lines.push(`  pipelines:               ${db.pipelinesBySourceKind.status}${db.pipelinesBySourceKind.status === 'ok' ? ` (count=${db.pipelinesBySourceKind.count})` : ` (${db.pipelinesBySourceKind.reason})`}`)
    lines.push(`  runs (window=${report.observationWindow.days}d):     ${db.runsByKindWithinWindow.status}${db.runsByKindWithinWindow.status === 'ok' ? ` (count=${db.runsByKindWithinWindow.count})` : ` (${db.runsByKindWithinWindow.reason})`}`)
    lines.push(`  static call sites:       ${report.coverage.staticCallSiteEnumeration.status}`)
    lines.push('')
    lines.push('residual blind spots (this report NEVER proves zero live risk beyond these):')
    for (const b of report.residualBlindSpots) lines.push(`  - [${b.id}] ${b.description}`)
  } else {
    lines.push(report.note)
    lines.push(`static call sites: ${report.coverage.staticCallSiteEnumeration.status}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, windowDays: DEFAULT_WINDOW_DAYS, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--dry-run':
      case '--plan':
        opts.dryRun = true
        break
      case '--window-days': {
        const raw = argv[++i]
        const next =
          typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)
            ? Number(raw)
            : Number.NaN
        if (!Number.isSafeInteger(next) || next < MIN_WINDOW_DAYS || next > MAX_WINDOW_DAYS) {
          throw new Error(`--window-days must be an integer between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}`)
        }
        opts.windowDays = next
        break
      }
      case '--json':
        opts.json = true
        break
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
      'data-source-exposure-inventory.mjs — values-free, schema-probing exposure inventory for the',
      "manager.select()/adapter.select() read path bound to kind='" + TARGET_KIND + "'.",
      '',
      'Usage:',
      '  DATABASE_URL=postgres://… node scripts/ops/data-source-exposure-inventory.mjs [--window-days N] [--json]',
      '  node scripts/ops/data-source-exposure-inventory.mjs --dry-run [--window-days N]',
      '',
      'Options:',
      '  --dry-run, --plan     Print the query plan without executing counts. Works without DATABASE_URL',
      '                        (falls back to a static allowlist listing) or with it (schema-probed, concrete plan).',
      '  --window-days N       Observation window for the runs-in-window count and the access-log recipe. Default 30.',
      '  --json                Print only the machine-readable JSON report (no human summary).',
      '  --help                Show this help.',
      '',
    ].join('\n'),
  )
}

async function createPgExecutor(databaseUrl) {
  // Lazy import: `pg` must never be required at module load, or a hermetic
  // `node --test` CI job with no `node_modules` (no pnpm install step) fails
  // at import time before a single test runs.
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  return {
    exec: (sql, params) => pool.query(sql, params),
    close: () => pool.end(),
  }
}

function writeClosedError(reason) {
  process.stderr.write(`[data-source-exposure-inventory] ERROR: ${reason}\n`)
}

async function closeExecutor(executor) {
  if (!executor) return true
  try {
    await executor.close()
    return true
  } catch {
    writeClosedError('INVENTORY_CLEANUP_FAILED')
    return false
  }
}

async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { executorFactory = createPgExecutor } = {},
) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch {
    writeClosedError('INVENTORY_ARGUMENT_INVALID')
    return 1
  }
  if (opts.help) {
    printHelp()
    return 0
  }

  const databaseUrl = (env.DATABASE_URL || '').trim()

  if (opts.dryRun) {
    let executor = null
    let exitCode = 0
    try {
      if (databaseUrl) executor = await executorFactory(databaseUrl)
      const report = await buildDryRunReport({ exec: executor ? executor.exec : null, windowDays: opts.windowDays })
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      } else {
        process.stdout.write(renderHumanSummary(report))
        process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n')
      }
    } catch {
      writeClosedError('INVENTORY_EXECUTION_FAILED')
      exitCode = 1
    }
    if (!(await closeExecutor(executor))) exitCode = 1
    return exitCode
  }

  if (!databaseUrl) {
    writeClosedError('INVENTORY_DATABASE_URL_REQUIRED')
    return 2
  }

  let executor = null
  let exitCode = 0
  try {
    executor = await executorFactory(databaseUrl)
    const report = await buildReport({ exec: executor.exec, windowDays: opts.windowDays })
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(renderHumanSummary(report))
      process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n')
    }
  } catch {
    writeClosedError('INVENTORY_EXECUTION_FAILED')
    exitCode = 1
  }
  if (!(await closeExecutor(executor))) exitCode = 1
  return exitCode
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
const isEntry = entryPath && entryPath === fileURLToPath(import.meta.url)
if (isEntry) {
  main().then((code) => {
    process.exitCode = code
  })
}

export {
  QUERY_ALLOWLIST,
  SUPPORTED_DATA_SOURCE_TYPES,
  EXTERNAL_SYSTEM_STATUSES,
  TARGET_KIND,
  DEFAULT_WINDOW_DAYS,
  assertReadOnlyAllowlist,
  runQuery,
  tableExists,
  probeColumns,
  probeSchema,
  buildPlan,
  normalizeCount,
  bucketDataSourceTypeCounts,
  bucketExternalSystemStatusCounts,
  executePlan,
  enumerateStaticCallSites,
  buildAccessLogRecipe,
  buildResidualBlindSpots,
  STATIC_RESIDUAL_BLIND_SPOTS,
  computeVerdict,
  buildReport,
  buildDryRunReport,
  renderHumanSummary,
  parseArgs,
  main,
  REPO_ROOT,
}
