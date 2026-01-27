#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises')

const argv = process.argv.slice(2)

const getArg = (name, fallback) => {
  const flag = `--${name}`
  const idx = argv.findIndex(value => value === flag || value.startsWith(`${flag}=`))
  if (idx === -1) return fallback
  const raw = argv[idx]
  if (raw.includes('=')) return raw.slice(flag.length + 1)
  const next = argv[idx + 1]
  if (!next || next.startsWith('--')) return true
  return next
}

const source = getArg('source', '')
const orgId = getArg('org', 'default')
const from = getArg('from', '')
const to = getArg('to', '')
const outFile = getArg('file', '')

if (!source) {
  console.error('Missing --source (e.g. dingtalk_csv_test)')
  process.exit(1)
}

const where = []
where.push(`org_id = '${orgId}'`)
where.push(`source = '${source}'`)
if (from) where.push(`occurred_at >= '${from}'`)
if (to) where.push(`occurred_at < '${to}'`)

const whereSql = where.join(' AND ')

const sql = `-- Cleanup attendance data imported by source tag
BEGIN;

WITH affected AS (
  SELECT DISTINCT user_id, work_date, org_id
  FROM attendance_events
  WHERE ${whereSql}
)
DELETE FROM attendance_records r
USING affected a
WHERE r.org_id = a.org_id
  AND r.user_id = a.user_id
  AND r.work_date = a.work_date;

DELETE FROM attendance_events
WHERE ${whereSql};

COMMIT;
`

if (outFile) {
  fs.writeFile(outFile, sql, 'utf-8')
    .then(() => console.log(outFile))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
} else {
  console.log(sql)
}
