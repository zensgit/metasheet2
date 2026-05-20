#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

function parseArgs(argv) {
  const opts = {
    migrateListFile: '',
    outDir: 'output/staging-migration-alignment-report',
    runList: false,
    title: 'Staging migration alignment report',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--migrate-list-file') {
      opts.migrateListFile = argv[++i] || ''
    } else if (arg === '--out-dir') {
      opts.outDir = argv[++i] || ''
    } else if (arg === '--run-list') {
      opts.runList = true
    } else if (arg === '--title') {
      opts.title = argv[++i] || opts.title
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/staging-migration-alignment-report.mjs --migrate-list-file <file> [--out-dir <dir>]
  node scripts/ops/staging-migration-alignment-report.mjs --run-list [--out-dir <dir>]
  cat migrate-list.txt | node scripts/ops/staging-migration-alignment-report.mjs [--out-dir <dir>]

This script is read-only. It parses \`migrate --list\` output, classifies pending
migrations, scans local migration files for obvious replay risk, and writes
report.json + report.md + schema-probes.sql.`)
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return ''
  return readFileSync(0, 'utf8')
}

function runMigrateList() {
  const result = spawnSync(
    'pnpm',
    ['--silent', '--filter', '@metasheet/core-backend', 'exec', 'tsx', 'src/db/migrate.ts', '--list'],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  if (result.error) {
    throw new Error(`Failed to spawn migrate --list: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`migrate --list failed with exit ${result.status}: ${String(result.stderr || '').slice(0, 1200)}`)
  }
  return result.stdout
}

function readMigrateList(opts) {
  if (opts.migrateListFile) {
    return readFileSync(path.resolve(opts.migrateListFile), 'utf8')
  }
  if (opts.runList) return runMigrateList()
  const stdin = readStdinIfAvailable()
  if (stdin.trim()) return stdin
  throw new Error('Provide --migrate-list-file, --run-list, or pipe migrate --list output on stdin.')
}

function parseMigrateList(text) {
  const appliedMatch = text.match(/Applied:\s*(\d+)/i)
  const pendingMatch = text.match(/Pending:\s*(\d+)/i)
  if (!appliedMatch || !pendingMatch) {
    throw new Error('Unable to parse Applied/Pending counts from migrate --list output.')
  }

  const pending = []
  let inPending = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^Pending migrations/i.test(line)) {
      inPending = true
      continue
    }
    if (!inPending) continue
    const match = line.match(/^-\s+(.+)$/)
    if (match) pending.push(match[1].trim())
  }

  return {
    applied: Number.parseInt(appliedMatch[1], 10),
    pending: Number.parseInt(pendingMatch[1], 10),
    pendingNames: pending,
  }
}

function loadSupersededLegacyNames() {
  const providerPath = path.join(REPO_ROOT, 'packages/core-backend/src/db/migration-provider.ts')
  const source = readFileSync(providerPath, 'utf8')
  const match = source.match(/SUPERSEDED_LEGACY_SQL_MIGRATIONS\s*=\s*\[([\s\S]*?)\]/)
  if (!match) return new Set()
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((it) => it[1]))
}

function findMigrationFile(name) {
  const candidates = [
    path.join(REPO_ROOT, 'packages/core-backend/src/db/migrations', `${name}.ts`),
    path.join(REPO_ROOT, 'packages/core-backend/src/db/migrations', `${name}.js`),
    path.join(REPO_ROOT, 'packages/core-backend/src/db/migrations', `${name}.sql`),
    path.join(REPO_ROOT, 'packages/core-backend/migrations', `${name}.sql`),
    path.join(REPO_ROOT, 'packages/core-backend/migrations', `${name}.ts`),
    path.join(REPO_ROOT, 'packages/core-backend/migrations', `${name}.js`),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || ''
}

function classifyName(name, supersededLegacyNames) {
  if (supersededLegacyNames.has(name)) return 'superseded_legacy_noop_marker'
  if (/^\d{3}_/.test(name)) return 'legacy_executable_sql'
  if (/^\d{8}_/.test(name)) return 'timestamp_sql'
  if (/^zzzz\d+_/.test(name)) return 'modern_timestamp_migration'
  return 'other'
}

function analyzeMigrationFile(filePath) {
  if (!filePath) {
    return {
      filePath: '',
      fileKind: 'missing',
      hasCreateTableWithoutIfNotExists: false,
      hasKyselyCreateTableWithoutIfNotExists: false,
      hasDropStatement: false,
      hasAlterTable: false,
      hasIfNotExists: false,
      hasCheckTableExistsGuard: false,
      schemaTargets: emptySchemaTargets(),
    }
  }
  const source = readFileSync(filePath, 'utf8')
  const upSource = extractUpSource(source)
  const scanSource = stripComments(upSource)
  return {
    filePath: path.relative(REPO_ROOT, filePath),
    fileKind: path.extname(filePath).replace(/^\./, '') || 'unknown',
    hasCreateTableWithoutIfNotExists: /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i.test(scanSource),
    hasKyselyCreateTableWithoutIfNotExists: hasUnguardedKyselyCreateTable(scanSource),
    hasDropStatement: /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|DATABASE)\b/i.test(scanSource),
    hasAlterTable: /\bALTER\s+TABLE\b/i.test(scanSource),
    hasIfNotExists: /IF\s+NOT\s+EXISTS|\.ifNotExists\s*\(/i.test(scanSource),
    hasCheckTableExistsGuard: /checkTableExists|to_regclass\s*\(/i.test(scanSource),
    schemaTargets: extractSchemaTargets(scanSource),
  }
}

function extractUpSource(source) {
  const upMatch = source.match(/export\s+async\s+function\s+up\b|async\s+function\s+up\b/)
  if (!upMatch || upMatch.index === undefined) return source
  const downMatch = source.slice(upMatch.index + upMatch[0].length).match(/export\s+async\s+function\s+down\b|async\s+function\s+down\b/)
  if (!downMatch || downMatch.index === undefined) return source.slice(upMatch.index)
  return source.slice(upMatch.index, upMatch.index + upMatch[0].length + downMatch.index)
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
}

function hasUnguardedKyselyCreateTable(source) {
  const calls = [...source.matchAll(/\.createTable\s*\([^)]*\)([\s\S]*?)(?=\.execute\s*\(\s*\)|;)/g)]
  return calls.some((call) => !/\.ifNotExists\s*\(/.test(call[1]))
}

function emptySchemaTargets() {
  return {
    createTables: [],
    alterTables: [],
    addColumns: [],
    indexes: [],
  }
}

function cleanSqlIdentifier(identifier) {
  return String(identifier || '')
    .trim()
    .replace(/[;,)]*$/g, '')
    .split(/\s*\.\s*/)
    .map((part) => part.trim().replace(/^["'`\[]/, '').replace(/["'`\]]$/, ''))
    .filter(Boolean)
    .join('.')
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function uniqueColumnTargets(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (!value.table || !value.column) continue
    const key = `${value.table}.${value.column}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`))
}

function uniqueIndexTargets(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (!value.table || !value.index) continue
    const key = `${value.table}.${value.index}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result.sort((a, b) => `${a.table}.${a.index}`.localeCompare(`${b.table}.${b.index}`))
}

function splitStatementSegments(source) {
  return source
    .split(/;\s*|\.execute\s*\([^)]*\)/g)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function findMatchingParen(source, openIndex) {
  let depth = 0
  let quote = ''
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]
    const prev = source[i - 1]
    if (quote) {
      if (char === quote && prev !== '\\') quote = ''
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevelComma(source) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const prev = source[i - 1]
    if (quote) {
      if (char === quote && prev !== '\\') quote = ''
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function extractSqlCreateTableColumns(source, identifierPattern) {
  const targets = []
  const createTableRegex = new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${identifierPattern})`, 'gi')
  for (const match of source.matchAll(createTableRegex)) {
    if (match.index === undefined) continue
    const table = cleanSqlIdentifier(match[1])
    const afterName = match.index + match[0].length
    const nextText = source.slice(afterName, afterName + 80)
    if (/^\s+PARTITION\s+OF\b/i.test(nextText)) continue
    const openIndex = source.indexOf('(', afterName)
    if (openIndex < 0 || openIndex > afterName + 200) continue
    const closeIndex = findMatchingParen(source, openIndex)
    if (closeIndex < 0) continue
    for (const entry of splitTopLevelComma(source.slice(openIndex + 1, closeIndex))) {
      const firstToken = entry.match(/^\s*("[^"]+"|`[^`]+`|'[^']+'|[A-Za-z_][A-Za-z0-9_$]*)/)
      if (!firstToken) continue
      const column = cleanSqlIdentifier(firstToken[1])
      if (/^(PRIMARY|CONSTRAINT|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)$/i.test(column)) continue
      targets.push({ table, column })
    }
  }
  return targets
}

function extractSchemaTargets(source) {
  const identifier = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`
  const createTables = []
  const alterTables = []
  const addColumns = []
  const indexes = []

  for (const match of source.matchAll(new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${identifier})`, 'gi'))) {
    createTables.push(cleanSqlIdentifier(match[1]))
  }

  for (const match of source.matchAll(/\.createTable\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
    createTables.push(cleanSqlIdentifier(match[2]))
  }

  for (const match of source.matchAll(new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${identifier})\s+ON\s+(${identifier})`, 'gi'))) {
    indexes.push({
      index: cleanSqlIdentifier(match[1]),
      table: cleanSqlIdentifier(match[2]),
    })
  }

  for (const match of source.matchAll(/\.createIndex\s*\(\s*(['"`])([^'"`]+)\1\s*\)([\s\S]*?)(?=\.execute\s*\(\s*\)|;)/g)) {
    const onMatch = match[3].match(/\.on\s*\(\s*(['"`])([^'"`]+)\1\s*\)/)
    if (!onMatch) continue
    indexes.push({
      index: cleanSqlIdentifier(match[2]),
      table: cleanSqlIdentifier(onMatch[2]),
    })
  }

  addColumns.push(...extractSqlCreateTableColumns(source, identifier))

  for (const segment of splitStatementSegments(source)) {
    const alterMatch = segment.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${identifier})`, 'i'))
    if (!alterMatch) continue
    const table = cleanSqlIdentifier(alterMatch[1])
    alterTables.push(table)
    const addColumnMatches = [...segment.matchAll(new RegExp(String.raw`\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${identifier})`, 'gi'))]
    for (const addColumnMatch of addColumnMatches) {
      addColumns.push({
        table,
        column: cleanSqlIdentifier(addColumnMatch[1]),
      })
    }
  }

  for (const match of source.matchAll(/\.alterTable\s*\(\s*(['"`])([^'"`]+)\1\s*\)([\s\S]*?)(?=\.execute\s*\(\s*\)|;)/g)) {
    const table = cleanSqlIdentifier(match[2])
    for (const columnMatch of match[3].matchAll(/\.addColumn\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      addColumns.push({
        table,
        column: cleanSqlIdentifier(columnMatch[2]),
      })
    }
  }

  for (const match of source.matchAll(/\.createTable\s*\(\s*(['"`])([^'"`]+)\1\s*\)([\s\S]*?)(?=\.execute\s*\(\s*\)|;)/g)) {
    const table = cleanSqlIdentifier(match[2])
    for (const columnMatch of match[3].matchAll(/\.addColumn\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      addColumns.push({
        table,
        column: cleanSqlIdentifier(columnMatch[2]),
      })
    }
  }

  return {
    createTables: uniqueSorted(createTables),
    alterTables: uniqueSorted(alterTables),
    addColumns: uniqueColumnTargets(addColumns),
    indexes: uniqueIndexTargets(indexes),
  }
}

function riskFor(category, fileInfo) {
  if (category === 'superseded_legacy_noop_marker') {
    return {
      level: 'ledger_review',
      reason: 'Provider treats this legacy SQL name as a visible no-op marker by default.',
    }
  }
  if (fileInfo.fileKind === 'missing') {
    return {
      level: 'unknown',
      reason: 'No local migration file was found for this name.',
    }
  }
  if (fileInfo.hasCreateTableWithoutIfNotExists || fileInfo.hasKyselyCreateTableWithoutIfNotExists || fileInfo.hasDropStatement) {
    return {
      level: 'high',
      reason: 'Migration up path contains non-idempotent-looking CREATE TABLE or DROP statement.',
    }
  }
  if (category === 'legacy_executable_sql' || category === 'timestamp_sql') {
    return {
      level: 'medium',
      reason: 'Legacy/timestamp SQL should be rehearsed before replaying on a drifted DB.',
    }
  }
  if (fileInfo.hasAlterTable && !fileInfo.hasIfNotExists && !fileInfo.hasCheckTableExistsGuard) {
    return {
      level: 'medium',
      reason: 'ALTER TABLE migration lacks an obvious IF NOT EXISTS or table-existence guard.',
    }
  }
  return {
    level: 'low',
    reason: 'No obvious replay risk detected by static scan.',
  }
}

function countBy(items, key) {
  const counts = {}
  for (const item of items) {
    const value = item[key]
    counts[value] = (counts[value] || 0) + 1
  }
  return counts
}

function buildSchemaProbePlan(items) {
  return items
    .filter((item) => (
      item.schemaTargets.createTables.length > 0
      || item.schemaTargets.alterTables.length > 0
      || item.schemaTargets.addColumns.length > 0
      || item.schemaTargets.indexes.length > 0
      || item.risk === 'high'
      || item.risk === 'unknown'
    ))
    .map((item) => ({
      migration: item.name,
      category: item.category,
      risk: item.risk,
      filePath: item.filePath,
      tablesToCheck: uniqueSorted([
        ...item.schemaTargets.createTables,
        ...item.schemaTargets.alterTables,
        ...item.schemaTargets.addColumns.map((column) => column.table),
        ...item.schemaTargets.indexes.map((index) => index.table),
      ]),
      columnsToCheck: item.schemaTargets.addColumns.map((column) => `${column.table}.${column.column}`),
      indexesToCheck: item.schemaTargets.indexes.map((index) => `${index.table}.${index.index}`),
      notes: item.schemaTargets.createTables.length === 0
        && item.schemaTargets.alterTables.length === 0
        && item.schemaTargets.addColumns.length === 0
        && item.schemaTargets.indexes.length === 0
        ? 'No obvious table/column targets were extracted; inspect the migration manually.'
        : 'Verify these targets on a cloned or backed-up DB before applying or marking migrations.',
    }))
}

function buildReport(migrateList, opts) {
  const supersededLegacyNames = loadSupersededLegacyNames()
  const items = migrateList.pendingNames.map((name) => {
    const category = classifyName(name, supersededLegacyNames)
    const filePath = findMigrationFile(name)
    const fileInfo = analyzeMigrationFile(filePath)
    const risk = riskFor(category, fileInfo)
    return {
      name,
      category,
      risk: risk.level,
      riskReason: risk.reason,
      ...fileInfo,
    }
  })

  const highRisk = items.filter((item) => item.risk === 'high')
  const executable = items.filter((item) => item.category !== 'superseded_legacy_noop_marker')
  const decision = migrateList.pending === 0
    ? 'aligned'
    : highRisk.length > 0
      ? 'do_not_run_full_migrate'
      : executable.length > 0
        ? 'rehearse_before_migrate'
        : 'ledger_review_only'

  const recommendation = {
    decision,
    fullMigrateRecommended: decision === 'aligned',
    nextAction: decision === 'aligned'
      ? 'No migration alignment action is required.'
      : 'Use a cloned or backed-up staging DB for rehearsal before applying migrations to staging.',
  }
  const schemaProbePlan = buildSchemaProbePlan(items)

  return {
    ok: true,
    title: opts.title,
    generatedAt: new Date().toISOString(),
    applied: migrateList.applied,
    pending: migrateList.pending,
    pendingNamesParsed: migrateList.pendingNames.length,
    categoryCounts: countBy(items, 'category'),
    riskCounts: countBy(items, 'risk'),
    recommendation,
    schemaProbePlan,
    schemaProbeSqlCounts: countSchemaProbeSqlRows(schemaProbePlan),
    items,
  }
}

function splitSchemaName(identifier) {
  const parts = String(identifier || '').split('.').filter(Boolean)
  if (parts.length <= 1) {
    return {
      schema: null,
      name: parts[0] || '',
    }
  }
  return {
    schema: parts[0],
    name: parts.slice(1).join('.'),
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined || value === '') return 'NULL'
  return `'${String(value).replace(/'/g, "''")}'`
}

function uniqueProbeRows(rows, keyFn) {
  const seen = new Set()
  const result = []
  for (const row of rows) {
    const key = keyFn(row)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result.sort((a, b) => keyFn(a).localeCompare(keyFn(b)))
}

function buildSchemaProbeSqlRows(schemaProbePlan) {
  const tableRows = []
  const columnRows = []
  const indexRows = []

  for (const entry of schemaProbePlan) {
    for (const table of entry.tablesToCheck) {
      const parsed = splitSchemaName(table)
      if (!parsed.name) continue
      tableRows.push({
        migration: entry.migration,
        schema: parsed.schema,
        table: parsed.name,
      })
    }

    for (const columnTarget of entry.columnsToCheck) {
      const parts = String(columnTarget).split('.').filter(Boolean)
      if (parts.length < 2) continue
      const column = parts.pop()
      const parsed = splitSchemaName(parts.join('.'))
      if (!parsed.name || !column) continue
      columnRows.push({
        migration: entry.migration,
        schema: parsed.schema,
        table: parsed.name,
        column,
      })
    }

    for (const indexTarget of entry.indexesToCheck) {
      const parts = String(indexTarget).split('.').filter(Boolean)
      if (parts.length < 2) continue
      const index = parts.pop()
      const parsed = splitSchemaName(parts.join('.'))
      if (!parsed.name || !index) continue
      indexRows.push({
        migration: entry.migration,
        schema: parsed.schema,
        table: parsed.name,
        index,
      })
    }
  }

  return {
    tables: uniqueProbeRows(tableRows, (row) => `${row.migration}.${row.schema || ''}.${row.table}`),
    columns: uniqueProbeRows(columnRows, (row) => `${row.migration}.${row.schema || ''}.${row.table}.${row.column}`),
    indexes: uniqueProbeRows(indexRows, (row) => `${row.migration}.${row.schema || ''}.${row.table}.${row.index}`),
  }
}

function countSchemaProbeSqlRows(schemaProbePlan) {
  const rows = buildSchemaProbeSqlRows(schemaProbePlan)
  return {
    tables: rows.tables.length,
    columns: rows.columns.length,
    indexes: rows.indexes.length,
  }
}

function renderValues(rows, columns) {
  if (rows.length === 0) return ''
  return rows
    .map((row) => `    (${columns.map((column) => sqlLiteral(row[column])).join(', ')})`)
    .join(',\n')
}

function buildUnifiedProbeRows(schemaProbePlan) {
  const rows = buildSchemaProbeSqlRows(schemaProbePlan)
  return [
    ...rows.tables.map((row) => ({
      kind: 'table',
      migration: row.migration,
      schema: row.schema,
      table: row.table,
      column: null,
      index: null,
    })),
    ...rows.columns.map((row) => ({
      kind: 'column',
      migration: row.migration,
      schema: row.schema,
      table: row.table,
      column: row.column,
      index: null,
    })),
    ...rows.indexes.map((row) => ({
      kind: 'index',
      migration: row.migration,
      schema: row.schema,
      table: row.table,
      column: null,
      index: row.index,
    })),
  ].sort((a, b) => (
    `${a.migration}.${a.kind}.${a.schema || ''}.${a.table}.${a.column || ''}.${a.index || ''}`
      .localeCompare(`${b.migration}.${b.kind}.${b.schema || ''}.${b.table}.${b.column || ''}.${b.index || ''}`)
  ))
}

function renderSchemaProbeSql(report) {
  const rows = buildUnifiedProbeRows(report.schemaProbePlan)
  const lines = [
    '-- Staging migration alignment schema probe SQL',
    `-- Generated at: ${report.generatedAt}`,
    '-- Read-only catalog checks generated from migration up-path static analysis.',
    '-- Run only against a cloned or backed-up rehearsal DB unless explicitly approved.',
    '-- This is not a migration safety proof: index checks verify name/table presence, not definition equivalence.',
    '-- Unqualified table names are not assumed to be public; matched_schemas reports every non-system schema match.',
    '',
    'BEGIN READ ONLY;',
    '',
  ]

  if (rows.length > 0) {
    lines.push(
      'WITH probe_plan(kind, migration, schema_name, table_name, column_name, index_name) AS (',
      '  VALUES',
      renderValues(rows, ['kind', 'migration', 'schema', 'table', 'column', 'index']),
      ')',
      'SELECT',
      '  p.kind AS probe_type,',
      '  migration,',
      '  concat_ws(',
      "    '.',",
      "    nullif(coalesce(p.schema_name, ''), ''),",
      '    p.table_name,',
      '    p.column_name,',
      '    p.index_name',
      '  ) AS target,',
      '  probe.match_count > 0 AS exists,',
      '  probe.match_count,',
      "  coalesce(probe.matched_schemas, '') AS matched_schemas",
      'FROM probe_plan p',
      'CROSS JOIN LATERAL (',
      '  SELECT count(*)::integer AS match_count, string_agg(DISTINCT schema_match, \', \' ORDER BY schema_match) AS matched_schemas',
      '  FROM (',
      '    SELECT n.nspname AS schema_match',
      '    FROM pg_catalog.pg_class c',
      '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
      "    WHERE p.kind = 'table'",
      '      AND c.relname = p.table_name',
      "      AND c.relkind IN ('r', 'p')",
      "      AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
      '      AND (p.schema_name IS NULL OR n.nspname = p.schema_name)',
      '    UNION ALL',
      '    SELECT n.nspname AS schema_match',
      '    FROM pg_catalog.pg_attribute a',
      '    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid',
      '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
      "    WHERE p.kind = 'column'",
      '      AND c.relname = p.table_name',
      '      AND a.attname = p.column_name',
      '      AND a.attnum > 0',
      '      AND NOT a.attisdropped',
      "      AND c.relkind IN ('r', 'p')",
      "      AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
      '      AND (p.schema_name IS NULL OR n.nspname = p.schema_name)',
      '    UNION ALL',
      '    SELECT n.nspname AS schema_match',
      '    FROM pg_catalog.pg_class i',
      '    JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace',
      '    JOIN pg_catalog.pg_index ix ON ix.indexrelid = i.oid',
      '    JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid',
      "    WHERE p.kind = 'index'",
      '      AND i.relname = p.index_name',
      '      AND t.relname = p.table_name',
      "      AND i.relkind IN ('i', 'I')",
      "      AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
      '      AND (p.schema_name IS NULL OR n.nspname = p.schema_name)',
      '  ) matches',
      ') probe',
      'ORDER BY migration, probe_type, target;',
      '',
    )
  } else {
    lines.push('-- No schema probes extracted.', '')
  }

  lines.push('ROLLBACK;', '')
  return `${lines.join('\n')}`
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`
  const sep = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${columns.map((col) => String(col.value(row)).replace(/\|/g, '\\|')).join(' | ')} |`)
  return [header, sep, ...body].join('\n')
}

function renderMarkdown(report) {
  const categoryRows = Object.entries(report.categoryCounts).map(([category, count]) => ({ category, count }))
  const riskRows = Object.entries(report.riskCounts).map(([risk, count]) => ({ risk, count }))
  const highOrUnknown = report.items
    .filter((item) => item.risk === 'high' || item.risk === 'unknown')
    .slice(0, 25)
  const schemaProbePlan = report.schemaProbePlan.slice(0, 40)

  const lines = [
    `# ${report.title}`,
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Applied migrations: ${report.applied}`,
    `- Pending migrations: ${report.pending}`,
    `- Parsed pending names: ${report.pendingNamesParsed}`,
    `- Decision: \`${report.recommendation.decision}\``,
    `- Full migrate recommended: \`${report.recommendation.fullMigrateRecommended}\``,
    `- Next action: ${report.recommendation.nextAction}`,
    `- Probe SQL targets: ${report.schemaProbeSqlCounts.tables} tables, ${report.schemaProbeSqlCounts.columns} columns, ${report.schemaProbeSqlCounts.indexes} indexes`,
    '',
    '## Category Counts',
    '',
    markdownTable(categoryRows, [
      { label: 'Category', value: (row) => row.category },
      { label: 'Count', value: (row) => row.count },
    ]),
    '',
    '## Risk Counts',
    '',
    markdownTable(riskRows, [
      { label: 'Risk', value: (row) => row.risk },
      { label: 'Count', value: (row) => row.count },
    ]),
    '',
    '## High / Unknown Replay Risk',
    '',
  ]

  if (highOrUnknown.length === 0) {
    lines.push('No high or unknown replay-risk migrations were detected by the static scan.')
  } else {
    lines.push(markdownTable(highOrUnknown, [
      { label: 'Migration', value: (row) => row.name },
      { label: 'Category', value: (row) => row.category },
      { label: 'Risk', value: (row) => row.risk },
      { label: 'File', value: (row) => row.filePath || '(missing)' },
      { label: 'Reason', value: (row) => row.riskReason },
    ]))
  }

  lines.push(
    '',
    '## Schema Probe Plan',
    '',
    'Use this as a read-only rehearsal checklist on a cloned or backed-up DB. It is not a safety proof.',
    '',
    'The companion `schema-probes.sql` file contains read-only PostgreSQL catalog queries for these extracted targets.',
    '',
  )

  if (schemaProbePlan.length === 0) {
    lines.push('No obvious schema probe targets were extracted.')
  } else {
    lines.push(markdownTable(schemaProbePlan, [
      { label: 'Migration', value: (row) => row.migration },
      { label: 'Risk', value: (row) => row.risk },
      { label: 'Tables to check', value: (row) => row.tablesToCheck.join(', ') || '(manual)' },
      { label: 'Columns to check', value: (row) => row.columnsToCheck.join(', ') || '(none)' },
      { label: 'Indexes to check', value: (row) => row.indexesToCheck.join(', ') || '(none)' },
      { label: 'Note', value: (row) => row.notes },
    ]))
  }

  lines.push(
    '',
    '## Pending Migrations',
    '',
    markdownTable(report.items, [
      { label: 'Migration', value: (row) => row.name },
      { label: 'Category', value: (row) => row.category },
      { label: 'Risk', value: (row) => row.risk },
      { label: 'File', value: (row) => row.filePath || '(missing)' },
    ]),
    '',
    '## Boundary',
    '',
    'This report is read-only. It does not run migrations, modify `kysely_migration`, or connect to the database directly.',
  )

  return `${lines.join('\n')}\n`
}

function writeOutputs(report, outDir) {
  const absoluteOut = path.resolve(REPO_ROOT, outDir)
  mkdirSync(absoluteOut, { recursive: true })
  const jsonPath = path.join(absoluteOut, 'report.json')
  const mdPath = path.join(absoluteOut, 'report.md')
  const probeSqlPath = path.join(absoluteOut, 'schema-probes.sql')
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderMarkdown(report), 'utf8')
  writeFileSync(probeSqlPath, renderSchemaProbeSql(report), 'utf8')
  return { jsonPath, mdPath, probeSqlPath }
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      printHelp()
      return
    }
    const migrateListText = readMigrateList(opts)
    const migrateList = parseMigrateList(migrateListText)
    const report = buildReport(migrateList, opts)
    const outputs = writeOutputs(report, opts.outDir)
    console.log(`[staging-migration-alignment-report] decision=${report.recommendation.decision}`)
    console.log(`[staging-migration-alignment-report] JSON: ${outputs.jsonPath}`)
    console.log(`[staging-migration-alignment-report] MD: ${outputs.mdPath}`)
    console.log(`[staging-migration-alignment-report] schema probes SQL: ${outputs.probeSqlPath}`)
  } catch (error) {
    console.error(`[staging-migration-alignment-report] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}

main()
