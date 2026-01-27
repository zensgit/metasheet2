#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises')

const argv = process.argv.slice(2)

const getArg = (name, fallback) => {
  const flag = `--${name}`
  const idx = argv.findIndex(value => value === flag || value.startsWith(`${flag}=`))
  if (idx === -1) return fallback
  const raw = argv[idx]
  if (raw.includes('=')) {
    return raw.slice(flag.length + 1)
  }
  const next = argv[idx + 1]
  if (!next || next.startsWith('--')) return true
  return next
}

const hasFlag = name => argv.includes(`--${name}`)

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const filePath = getArg('file', process.env.ATTENDANCE_IMPORT_FILE)
const apiBase = (getArg('api', process.env.METASHEET_API_URL) || 'http://localhost:8900').replace(/\/$/, '')
const token = getArg('token', process.env.METASHEET_TOKEN || process.env.METASHEET_API_TOKEN)
const orgId = getArg('org', process.env.METASHEET_ORG_ID || 'default')
const sourceOverride = getArg('source', process.env.ATTENDANCE_IMPORT_SOURCE || '')
const concurrency = toNumber(getArg('concurrency', process.env.ATTENDANCE_IMPORT_CONCURRENCY || 4), 4)
const limit = toNumber(getArg('limit', process.env.ATTENDANCE_IMPORT_LIMIT || 0), 0)
const offset = toNumber(getArg('offset', process.env.ATTENDANCE_IMPORT_OFFSET || 0), 0)
const dryRun = hasFlag('dry-run')

if (!filePath) {
  console.error('Missing --file (or ATTENDANCE_IMPORT_FILE)')
  process.exit(1)
}
if (!token) {
  console.error('Missing --token (or METASHEET_TOKEN)')
  process.exit(1)
}
if (typeof fetch !== 'function') {
  console.error('This script requires Node.js 18+ with global fetch.')
  process.exit(1)
}

const normalizeEntry = (entry) => {
  const userId = entry.userId || entry.user_id || entry.userID
  const eventType = entry.eventType || entry.event_type
  const occurredAt = entry.occurredAt || entry.occurred_at
  const timezone = entry.timezone || entry.tz
  const source = sourceOverride || entry.source
  const meta = entry.meta || {}
  return { userId, eventType, occurredAt, timezone, source, meta }
}

const buildBody = (entry) => {
  const body = {
    eventType: entry.eventType,
    occurredAt: entry.occurredAt,
    timezone: entry.timezone,
    source: entry.source,
    meta: entry.meta,
    orgId,
  }
  Object.keys(body).forEach((key) => {
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      delete body[key]
    }
  })
  return body
}

const runPool = async (items, limit, worker) => {
  const results = []
  let index = 0
  const runners = new Array(Math.max(1, limit)).fill(null).map(async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

const main = async () => {
  const raw = await fs.readFile(filePath, 'utf-8')
  const parsed = JSON.parse(raw)
  const entries = Array.isArray(parsed) ? parsed : (parsed.entries || [])
  const normalized = entries.map(normalizeEntry).filter(entry => entry.userId && entry.eventType)
  const sliced = normalized.slice(offset, limit > 0 ? offset + limit : undefined)

  console.log(`Loaded ${entries.length} entries (${normalized.length} normalized).`)
  console.log(`API: ${apiBase} | Org: ${orgId} | Concurrency: ${concurrency} | Dry run: ${dryRun}`)
  if (sourceOverride) console.log(`Source override: ${sourceOverride}`)
  if (offset > 0) console.log(`Offset: ${offset}`)
  if (limit > 0) console.log(`Limit: ${limit}`)

  if (dryRun) return

  const results = await runPool(sliced, concurrency, async (entry, idx) => {
    const body = buildBody(entry)
    const res = await fetch(`${apiBase}/api/attendance/punch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-User-Id': entry.userId,
        'X-Org-Id': orgId,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      let payload = null
      try {
        payload = await res.json()
      } catch {
        payload = await res.text()
      }
      return { ok: false, status: res.status, idx, payload }
    }
    return { ok: true }
  })

  const success = results.filter(item => item && item.ok).length
  const failed = results.filter(item => item && !item.ok)
  console.log(`Done. Success: ${success}, Failed: ${failed.length}`)
  if (failed.length > 0) {
    console.log('First failures:')
    failed.slice(0, 5).forEach((item) => {
      console.log(`- #${item.idx} status=${item.status}`, item.payload)
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
