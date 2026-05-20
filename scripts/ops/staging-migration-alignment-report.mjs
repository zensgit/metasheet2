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
report.json + report.md.`)
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
    }
  }
  const source = readFileSync(filePath, 'utf8')
  const upSource = extractUpSource(source)
  return {
    filePath: path.relative(REPO_ROOT, filePath),
    fileKind: path.extname(filePath).replace(/^\./, '') || 'unknown',
    hasCreateTableWithoutIfNotExists: /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i.test(upSource),
    hasKyselyCreateTableWithoutIfNotExists: hasUnguardedKyselyCreateTable(upSource),
    hasDropStatement: /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|DATABASE)\b/i.test(upSource),
    hasAlterTable: /\bALTER\s+TABLE\b/i.test(upSource),
    hasIfNotExists: /IF\s+NOT\s+EXISTS|\.ifNotExists\s*\(/i.test(upSource),
    hasCheckTableExistsGuard: /checkTableExists|to_regclass\s*\(/i.test(upSource),
  }
}

function extractUpSource(source) {
  const upMatch = source.match(/export\s+async\s+function\s+up\b|async\s+function\s+up\b/)
  if (!upMatch || upMatch.index === undefined) return source
  const downMatch = source.slice(upMatch.index + upMatch[0].length).match(/export\s+async\s+function\s+down\b|async\s+function\s+down\b/)
  if (!downMatch || downMatch.index === undefined) return source.slice(upMatch.index)
  return source.slice(upMatch.index, upMatch.index + upMatch[0].length + downMatch.index)
}

function hasUnguardedKyselyCreateTable(source) {
  const calls = [...source.matchAll(/\.createTable\s*\([^)]*\)([\s\S]*?)(?=\.execute\s*\(\s*\)|;)/g)]
  return calls.some((call) => !/\.ifNotExists\s*\(/.test(call[1]))
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
    items,
  }
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
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderMarkdown(report), 'utf8')
  return { jsonPath, mdPath }
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
  } catch (error) {
    console.error(`[staging-migration-alignment-report] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}

main()
