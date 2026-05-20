#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

const REQUIRED_COLUMNS = ['probe_type', 'migration', 'target', 'exists', 'match_count', 'matched_schemas']

function parseArgs(argv) {
  const opts = {
    format: 'auto',
    inputFile: '',
    outDir: 'output/staging-migration-alignment-report',
    title: 'Staging migration schema probe results',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input' || arg === '--probe-results-file') {
      opts.inputFile = argv[++i] || ''
    } else if (arg === '--format') {
      opts.format = argv[++i] || 'auto'
      if (!['auto', 'csv', 'tsv'].includes(opts.format)) {
        throw new Error(`Unsupported --format value: ${opts.format}`)
      }
    } else if (arg === '--out-dir') {
      opts.outDir = argv[++i] || ''
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
  node scripts/ops/staging-migration-schema-probe-summary.mjs --input <csv-or-tsv> [--format auto|csv|tsv] [--out-dir <dir>]
  cat schema-probe-results.tsv | node scripts/ops/staging-migration-schema-probe-summary.mjs --format tsv [--out-dir <dir>]

This script is read-only. It parses CSV/TSV output produced by running
schema-probes.sql on a cloned or backed-up rehearsal database and writes
schema-probe-summary.json + schema-probe-summary.md. It does not connect to a
database or run migrations.`)
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return ''
  return readFileSync(0, 'utf8')
}

function readProbeResults(opts) {
  if (opts.inputFile) {
    return readFileSync(path.resolve(opts.inputFile), 'utf8')
  }
  const stdin = readStdinIfAvailable()
  if (stdin.trim()) return stdin
  throw new Error('Provide --input or pipe schema probe CSV/TSV output on stdin.')
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function parseCsvRows(text) {
  const rows = []
  let row = []
  let value = ''
  let inQuotes = false

  const input = normalizeNewlines(text)
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    const next = input[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        value += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(value)
      value = ''
    } else if (ch === '\n') {
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else {
      value += ch
    }
  }

  if (inQuotes) throw new Error('CSV input ended inside a quoted field.')
  if (value || row.length > 0) {
    row.push(value)
    rows.push(row)
  }

  return rows.filter((it) => it.some((cell) => String(cell).trim() !== ''))
}

function parseTsvRows(text) {
  return normalizeNewlines(text)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'))
}

function detectDelimiter(text, format = 'auto') {
  if (format === 'csv') return ','
  if (format === 'tsv') return '\t'
  const firstLine = normalizeNewlines(text).split('\n').find((line) => line.trim() !== '') || ''
  if (firstLine.includes('\t') && !firstLine.includes(',')) return '\t'
  return ','
}

function normalizeHeader(value) {
  return String(value || '').trim().replace(/^\uFEFF/, '').toLowerCase()
}

function parseBoolean(value, rowNumber) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['true', 't', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', 'f', '0', 'no', 'n', ''].includes(normalized)) return false
  throw new Error(`Invalid exists value on row ${rowNumber}: ${value}`)
}

function parseInteger(value, rowNumber) {
  const normalized = String(value || '').trim()
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid match_count value on row ${rowNumber}: ${value}`)
  }
  return Number.parseInt(normalized, 10)
}

function parseSchemas(value) {
  return String(value || '')
    .split(',')
    .map((it) => it.trim())
    .filter(Boolean)
}

function parseProbeResultRows(text, format = 'auto') {
  const delimiter = detectDelimiter(text, format)
  const rawRows = delimiter === '\t' ? parseTsvRows(text) : parseCsvRows(text)
  if (rawRows.length === 0) throw new Error('Probe results input is empty.')

  const headers = rawRows[0].map(normalizeHeader)
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column))
  if (missing.length > 0) {
    throw new Error(`Probe results input is missing required column(s): ${missing.join(', ')}`)
  }

  return rawRows.slice(1).map((cells, index) => {
    const rowNumber = index + 2
    const data = {}
    headers.forEach((header, headerIndex) => {
      data[header] = cells[headerIndex] ?? ''
    })
    const matchCount = parseInteger(data.match_count, rowNumber)
    const exists = parseBoolean(data.exists, rowNumber)
    const matchedSchemas = parseSchemas(data.matched_schemas)
    const status = !exists || matchCount === 0
      ? 'missing'
      : matchCount > 1 || matchedSchemas.length > 1
        ? 'ambiguous'
        : 'matched'

    return {
      probeType: String(data.probe_type || '').trim(),
      migration: String(data.migration || '').trim(),
      target: String(data.target || '').trim(),
      exists,
      matchCount,
      matchedSchemas,
      status,
    }
  })
}

function emptyStatusCounts() {
  return {
    total: 0,
    matched: 0,
    missing: 0,
    ambiguous: 0,
  }
}

function addStatus(counts, row) {
  counts.total += 1
  counts[row.status] += 1
}

function groupCounts(rows, keyFn) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyFn(row) || '(empty)'
    if (!groups.has(key)) groups.set(key, emptyStatusCounts())
    addStatus(groups.get(key), row)
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function buildByMigration(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = row.migration || '(empty)'
    if (!groups.has(key)) {
      groups.set(key, {
        migration: key,
        status: 'all_matched',
        ...emptyStatusCounts(),
        missingTargets: [],
        ambiguousTargets: [],
      })
    }
    const group = groups.get(key)
    addStatus(group, row)
    if (row.status === 'missing') group.missingTargets.push(row.target)
    if (row.status === 'ambiguous') group.ambiguousTargets.push(row.target)
    if (group.missing > 0 && group.ambiguous > 0) {
      group.status = 'mixed_missing_and_ambiguous'
    } else if (group.missing > 0) {
      group.status = 'has_missing'
    } else if (group.ambiguous > 0) {
      group.status = 'has_ambiguous'
    } else {
      group.status = 'all_matched'
    }
  }
  return [...groups.values()].sort((a, b) => a.migration.localeCompare(b.migration))
}

function buildReport(rows, opts) {
  const counts = emptyStatusCounts()
  for (const row of rows) addStatus(counts, row)
  const decision = counts.missing > 0 || counts.ambiguous > 0
    ? 'manual_review_required'
    : 'schema_probe_targets_present'

  return {
    ok: true,
    title: opts.title,
    generatedAt: new Date().toISOString(),
    decision,
    recommendation: decision === 'schema_probe_targets_present'
      ? 'All emitted schema probe targets matched exactly once. Continue with migration alignment review; this is still not a replay safety proof.'
      : 'Review missing and ambiguous targets before marking migrations as applied or replaying migrations.',
    counts,
    byProbeType: groupCounts(rows, (row) => row.probeType),
    byMigration: buildByMigration(rows),
    missing: rows.filter((row) => row.status === 'missing'),
    ambiguous: rows.filter((row) => row.status === 'ambiguous'),
    rows,
  }
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`
  const sep = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${columns.map((col) => String(col.value(row)).replace(/\|/g, '\\|')).join(' | ')} |`)
  return [header, sep, ...body].join('\n')
}

function renderMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Decision: \`${report.decision}\``,
    `- Total probes: ${report.counts.total}`,
    `- Matched: ${report.counts.matched}`,
    `- Missing: ${report.counts.missing}`,
    `- Ambiguous: ${report.counts.ambiguous}`,
    `- Recommendation: ${report.recommendation}`,
    '',
    '## By Probe Type',
    '',
  ]

  lines.push(markdownTable(Object.entries(report.byProbeType).map(([probeType, counts]) => ({
    probeType,
    ...counts,
  })), [
    { label: 'Probe type', value: (row) => row.probeType },
    { label: 'Total', value: (row) => row.total },
    { label: 'Matched', value: (row) => row.matched },
    { label: 'Missing', value: (row) => row.missing },
    { label: 'Ambiguous', value: (row) => row.ambiguous },
  ]))

  lines.push('', '## By Migration', '')
  lines.push(markdownTable(report.byMigration, [
    { label: 'Migration', value: (row) => row.migration },
    { label: 'Status', value: (row) => row.status },
    { label: 'Total', value: (row) => row.total },
    { label: 'Matched', value: (row) => row.matched },
    { label: 'Missing', value: (row) => row.missing },
    { label: 'Ambiguous', value: (row) => row.ambiguous },
  ]))

  lines.push('', '## Missing Targets', '')
  if (report.missing.length === 0) {
    lines.push('No missing targets were reported.')
  } else {
    lines.push(markdownTable(report.missing.slice(0, 100), [
      { label: 'Migration', value: (row) => row.migration },
      { label: 'Type', value: (row) => row.probeType },
      { label: 'Target', value: (row) => row.target },
    ]))
  }

  lines.push('', '## Ambiguous Targets', '')
  if (report.ambiguous.length === 0) {
    lines.push('No ambiguous targets were reported.')
  } else {
    lines.push(markdownTable(report.ambiguous.slice(0, 100), [
      { label: 'Migration', value: (row) => row.migration },
      { label: 'Type', value: (row) => row.probeType },
      { label: 'Target', value: (row) => row.target },
      { label: 'Match count', value: (row) => row.matchCount },
      { label: 'Matched schemas', value: (row) => row.matchedSchemas.join(', ') },
    ]))
  }

  lines.push(
    '',
    '## Boundary',
    '',
    'This report is offline analysis of schema probe output. It does not connect to a database, run migrations, or write `kysely_migration`.',
    '',
  )
  return `${lines.join('\n')}`
}

function writeOutputs(report, outDir) {
  const absoluteOut = path.resolve(REPO_ROOT, outDir)
  mkdirSync(absoluteOut, { recursive: true })
  const jsonPath = path.join(absoluteOut, 'schema-probe-summary.json')
  const mdPath = path.join(absoluteOut, 'schema-probe-summary.md')
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
    const text = readProbeResults(opts)
    const rows = parseProbeResultRows(text, opts.format)
    const report = buildReport(rows, opts)
    const outputs = writeOutputs(report, opts.outDir)
    console.log(`[staging-migration-schema-probe-summary] decision=${report.decision}`)
    console.log(`[staging-migration-schema-probe-summary] JSON: ${outputs.jsonPath}`)
    console.log(`[staging-migration-schema-probe-summary] MD: ${outputs.mdPath}`)
  } catch (error) {
    console.error(`[staging-migration-schema-probe-summary] ERROR: ${error.message}`)
    process.exitCode = 1
  }
}

main()
