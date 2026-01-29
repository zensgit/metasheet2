import fs from 'fs'
import path from 'path'

function usage() {
  console.log(`\nUsage:
  node scripts/attendance/dingtalk-json-to-import.mjs \\
    --input <dingtalk-json> \\
    --columns <columns-json> \\
    --user-id <userId> \\
    --out <output-json> [options]\n
Options:
  --mapping <mapping-json>     Attach import mapping (optional)
  --override <override-json>   Column id -> field key overrides (optional)
  --source <source>            Source tag (default: dingtalk)
  --from <YYYY-MM-DD>          Filter start date (inclusive)
  --to <YYYY-MM-DD>            Filter end date (inclusive)
  --org-id <orgId>             Attach orgId to each row (optional)
  --name <displayName>         Attach name to fields (optional)
`)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]
    if (!key.startsWith('--')) continue
    const value = args[i + 1]
    result[key.slice(2)] = value
    i += 1
  }
  return result
}

function normalizeDate(value) {
  if (!value) return ''
  if (value.includes('T')) return value.slice(0, 10)
  if (value.includes(' ')) return value.split(' ')[0]
  return value.slice(0, 10)
}

function withinRange(dateStr, from, to) {
  if (!dateStr) return false
  if (from && dateStr < from) return false
  if (to && dateStr > to) return false
  return true
}

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw)
}

function loadColumnMap(columnsData, overrides = {}) {
  const columns = columnsData?.result?.columns || columnsData?.columns || []
  const map = new Map()
  for (const column of columns) {
    const id = String(column.id)
    const override = overrides[id]
    if (override) {
      map.set(id, override)
      continue
    }
    if (column.alias) {
      map.set(id, column.alias)
      continue
    }
    if (column.name) {
      map.set(id, column.name)
      continue
    }
  }
  return map
}

function mergeColumnVals(payload) {
  const results = []
  if (payload?.result?.column_vals) {
    results.push(payload.result)
  }
  if (Array.isArray(payload?.results)) {
    for (const item of payload.results) {
      if (item?.column_vals) results.push(item)
    }
  }
  return results
}

function buildRows(columnResults, columnMap, options) {
  const records = new Map()

  for (const result of columnResults) {
    for (const column of result.column_vals || []) {
      const columnId = String(column.column_vo?.id || '')
      if (!columnId) continue
      const fieldKey = columnMap.get(columnId) || `col_${columnId}`

      for (const entry of column.column_vals || []) {
        const date = normalizeDate(entry.date)
        if (!withinRange(date, options.from, options.to)) continue
        if (!records.has(date)) {
          records.set(date, {})
        }
        const fields = records.get(date)
        fields[fieldKey] = entry.value ?? fields[fieldKey] ?? ''
      }
    }
  }

  const rows = []
  for (const [date, fields] of records.entries()) {
    const row = {
      userId: options.userId,
      workDate: date,
      fields: { ...fields },
    }
    if (options.orgId) row.orgId = options.orgId
    if (options.name) row.fields.name = options.name
    rows.push(row)
  }

  rows.sort((a, b) => (a.workDate > b.workDate ? 1 : -1))
  return rows
}

function loadMapping(mappingPath) {
  if (!mappingPath) return null
  const data = loadJson(mappingPath)
  if (data.mapping) return data.mapping
  if (data.columns) return { columns: data.columns }
  return null
}

function main() {
  const args = parseArgs()
  const inputPath = args.input
  const columnsPath = args.columns
  const userId = args['user-id']
  const outPath = args.out

  if (!inputPath || !columnsPath || !userId || !outPath) {
    usage()
    process.exit(1)
  }

  const source = args.source || 'dingtalk'
  const from = args.from
  const to = args.to
  const orgId = args['org-id'] || ''
  const name = args.name || ''

  const overrides = args.override ? loadJson(args.override) : {}
  const columnsData = loadJson(columnsPath)
  const columnMap = loadColumnMap(columnsData, overrides)

  const inputData = loadJson(inputPath)
  const columnResults = mergeColumnVals(inputData)
  if (columnResults.length === 0) {
    throw new Error('No column_vals found in input JSON')
  }

  const rows = buildRows(columnResults, columnMap, { userId, from, to, orgId, name })
  const mapping = loadMapping(args.mapping)

  const payload = {
    source,
    rows,
  }
  if (mapping) payload.mapping = mapping

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`Wrote ${rows.length} rows to ${outPath}`)
}

main()
