import fs from 'fs'
import path from 'path'

function usage() {
  console.log(`\nUsage:
  node scripts/attendance/dingtalk-csv-to-import.mjs \\
    --input <csv> \\
    --columns <columns-json> \\
    --out <output-json> [options]\n
Options:
  --user-map <user-map-json>   Map empNo -> userId/name (optional)
  --mapping <mapping-json>     Attach import mapping (optional)
  --status-map <json>          Attach statusMap to payload (optional)
  --normalize-status <true|1>  Normalize long attendance status strings
  --source <source>            Source tag (default: dingtalk_csv)
  --from <YYYY-MM-DD>          Filter start date (inclusive)
  --to <YYYY-MM-DD>            Filter end date (inclusive)
  --timezone <tz>              Timezone tag (default: Asia/Shanghai)
  --org-id <orgId>             Attach orgId to each row (optional)
  --debug <true|1>             Print parse stats
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
  const raw = String(value).trim()
  if (!raw) return ''
  if (raw.includes('T')) return raw.slice(0, 10)
  if (raw.includes(' ')) return raw.split(' ')[0]
  return raw.slice(0, 10)
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

function loadColumnMap(columnsData) {
  const columns = columnsData?.result?.columns || columnsData?.columns || []
  const map = new Map()
  for (const column of columns) {
    const name = String(column.name || '').trim()
    const alias = String(column.alias || '').trim()
    if (name && alias) {
      map.set(name, alias)
    }
  }
  return map
}

function loadUserMap(userMapPath) {
  if (!userMapPath) return null
  const data = loadJson(userMapPath)
  const mapping = data.mapping || data
  return mapping || null
}

function resolveUser(row, userMap) {
  const empNo = row['工号'] || row['员工工号'] || row['empNo'] || ''
  const account = row['钉钉账号'] || row['账号'] || row['account'] || ''
  const name = row['姓名'] || row['name'] || ''

  if (userMap && empNo && userMap[empNo]) {
    return {
      userId: userMap[empNo].userId,
      name: userMap[empNo].name || name,
      empNo,
    }
  }

  if (userMap && account && userMap[account]) {
    return {
      userId: userMap[account].userId,
      name: userMap[account].name || name,
      empNo,
    }
  }

  const fallback = empNo || account || name || `tmp_${Math.random().toString(36).slice(2, 10)}`
  return { userId: `tmp_${fallback}`, name, empNo }
}

function loadMapping(mappingPath) {
  if (!mappingPath) return null
  const data = loadJson(mappingPath)
  if (data.mapping) return data.mapping
  if (data.columns) return { columns: data.columns }
  return null
}

function loadStatusMap(statusMapPath) {
  if (!statusMapPath) return null
  const data = loadJson(statusMapPath)
  return data.statusMap ?? data
}

function normalizeStatusText(value, statusMap) {
  if (value === null || value === undefined) return value
  const text = String(value).trim()
  if (!text) return text
  if (text.length <= 20) return text
  const defaultOrder = [
    '补卡申请', '加班', '事假', '病假', '工伤假', '调休', '出差', '外出', '请假', '外勤', '缺卡', '迟到早退', '迟到', '早退', '旷工', '正常', '休息',
  ]
  const keys = statusMap ? Object.keys(statusMap) : []
  const candidates = (keys.length ? keys : defaultOrder)
    .filter((key) => key !== '休息')
    .concat((keys.length ? keys.includes('休息') : defaultOrder.includes('休息')) ? ['休息'] : [])
  const lowerText = text.toLowerCase()
  const sorted = candidates.sort((a, b) => b.length - a.length)
  for (const key of sorted) {
    if (!key) continue
    const lowerKey = String(key).toLowerCase()
    if (lowerText.includes(lowerKey)) return key
  }
  return text.slice(0, 20)
}

function parseCsv(raw) {
  const rows = []
  let row = []
  let value = ''
  let inQuotes = false
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    const next = raw[i + 1]
    if (char === '"' && inQuotes && next === '"') {
      value += '"'
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      row.push(value)
      value = ''
      continue
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(value)
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      value = ''
      continue
    }
    value += char
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value)
    rows.push(row)
  }
  return rows
}

function main() {
  const args = parseArgs()
  const inputPath = args.input
  const columnsPath = args.columns
  const outPath = args.out

  if (!inputPath || !columnsPath || !outPath) {
    usage()
    process.exit(1)
  }

  const from = normalizeDate(args.from)
  const to = normalizeDate(args.to)
  const source = args.source || 'dingtalk_csv'
  const timezone = args.timezone || 'Asia/Shanghai'
  const orgId = args['org-id'] || ''
  const debug = ['1', 'true', 'yes'].includes(String(args.debug || '').toLowerCase())
  const normalizeStatus = ['1', 'true', 'yes'].includes(String(args['normalize-status'] || '').toLowerCase())

  const columnsData = loadJson(columnsPath)
  const columnMap = loadColumnMap(columnsData)
  columnMap.set('考勤组', 'attendance_group')
  columnMap.set('出勤班次', 'attendance_class')
  columnMap.set('班次', 'plan_detail')

  const userMap = loadUserMap(args['user-map'])
  const mapping = loadMapping(args.mapping)
  const statusMap = loadStatusMap(args['status-map'])

  const csvRaw = fs.readFileSync(inputPath, 'utf-8')
  if (debug) {
    console.log(`Reading CSV: ${inputPath} (${csvRaw.length} chars)`)
  }
  const csvRows = parseCsv(csvRaw)
  if (csvRows.length === 0) {
    throw new Error('CSV has no rows')
  }
  const headers = csvRows[0].map((header) => header.trim())
  if (headers.length > 0) {
    headers[0] = headers[0].replace(/^\uFEFF/, '')
  }
  const records = csvRows.slice(1).map((row) => {
    const record = {}
    headers.forEach((header, index) => {
      record[header] = row[index] ?? ''
    })
    return record
  })
  if (debug) {
    console.log(`Parsed ${records.length} records, headers: ${headers.slice(0, 8).join(', ')}`)
  }

  const rows = []
  for (const row of records) {
    const workDate = normalizeDate(row['日期'] || row['date'] || row['Date'] || '')
    if (!withinRange(workDate, from, to)) continue

    const user = resolveUser(row, userMap)
    const fields = {}
    for (const [key, value] of Object.entries(row)) {
      if (key === '日期' || key === 'date' || key === 'Date') continue
      if (value === '' || value === null || typeof value === 'undefined') continue
      const trimmedKey = key.trim()
      const alias = columnMap.get(trimmedKey) || trimmedKey
      let nextValue = typeof value === 'string' ? value.trim() : value
      if (normalizeStatus && alias === 'attend_result' && typeof nextValue === 'string') {
        nextValue = normalizeStatusText(nextValue, statusMap)
      }
      fields[alias] = nextValue
    }
    if (user.name) fields.name = user.name
    fields.attendance_group = fields.attendance_group || row['考勤组'] || row['attendance_group'] || ''

    const payload = {
      userId: user.userId,
      workDate,
      fields,
    }
    if (orgId) payload.orgId = orgId
    if (timezone) payload.timezone = timezone
    if (user.empNo) payload.empNo = user.empNo
    rows.push(payload)
  }

  rows.sort((a, b) => (a.workDate > b.workDate ? 1 : -1))
  if (debug && rows.length > 0) {
    console.log('Sample row:', rows[0])
  }

  const output = { source, rows }
  if (mapping) output.mapping = mapping
  if (statusMap) output.statusMap = statusMap

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`Wrote ${rows.length} rows to ${outPath}`)
}

main()
