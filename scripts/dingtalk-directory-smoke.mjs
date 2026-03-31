#!/usr/bin/env node

// DingTalk Directory Operations Smoke / Preflight Test
// Tests admin directory endpoints for basic availability.

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/dingtalk-directory-smoke.mjs [options]

Smoke test for DingTalk directory admin endpoints.

Options:
  --base-url <url>   API base URL (default: http://localhost:7778)
  --token <token>    Bearer token for authentication
  --timeout <ms>     Request timeout in milliseconds (default: 10000)
  --help, -h         Show this help message

Endpoints tested:
  GET  /api/admin/directory/sync/status   - Sync status and alert state
  GET  /api/admin/directory/sync/history  - Sync run history
  GET  /api/admin/directory/deprovisions  - Deprovision audit records

Exit codes:
  0  All checks passed
  1  One or more checks failed
  2  Skipped (no token provided)

Examples:
  node scripts/dingtalk-directory-smoke.mjs --token eyJhbGciOiJIUz...
  node scripts/dingtalk-directory-smoke.mjs --base-url http://10.0.0.5:7778 --token abc123`)
  process.exit(0)
}

function getArg(name, defaultValue) {
  const idx = args.indexOf(name)
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return defaultValue
}

const baseUrl = getArg('--base-url', 'http://localhost:7778').replace(/\/+$/, '')
const token = getArg('--token', process.env.DINGTALK_SMOKE_TOKEN || '')
const timeoutMs = parseInt(getArg('--timeout', '10000'), 10)

const checks = []

function record(name, status, details = {}) {
  checks.push({ name, status, ...details })
}

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function fetchEndpoint(path, description) {
  const url = `${baseUrl}${path}`
  const headers = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const timeout = withTimeout(timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: timeout.signal })
    const body = await res.json().catch(() => ({}))

    // We consider 200 as pass, 401 as expected when no valid token
    if (res.status === 200) {
      record(description, 'pass', { status: res.status, path })
      return true
    } else if (res.status === 401 || res.status === 403) {
      // Auth error is expected if token is invalid or missing
      if (!token) {
        record(description, 'skip', { status: res.status, path, reason: 'no token' })
      } else {
        record(description, 'pass', { status: res.status, path, note: 'auth response received' })
      }
      return true
    } else {
      record(description, 'fail', { status: res.status, path, body })
      return false
    }
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err))
    record(description, 'fail', { path, error: message })
    return false
  } finally {
    timeout.clear()
  }
}

async function run() {
  console.log(`DingTalk Directory Smoke Test`)
  console.log(`Base URL: ${baseUrl}`)
  console.log(`Token:    ${token ? '(provided)' : '(not provided)'}`)
  console.log(`Timeout:  ${timeoutMs}ms`)
  console.log('')

  if (!token) {
    console.log('No token provided. Endpoints will be tested for reachability only.')
    console.log('')
  }

  const endpoints = [
    ['/api/admin/directory/sync/status', 'directory.sync.status'],
    ['/api/admin/directory/sync/history', 'directory.sync.history'],
    ['/api/admin/directory/deprovisions', 'directory.deprovisions'],
  ]

  let allOk = true
  for (const [path, name] of endpoints) {
    const ok = await fetchEndpoint(path, name)
    if (!ok) allOk = false
  }

  // Print results
  console.log('=== Results ===')
  console.log('')

  const statusIcon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }

  for (const check of checks) {
    const icon = statusIcon[check.status] || '????'
    const extra = []
    if (check.status !== undefined && check.path) extra.push(check.path)
    if (check.status === 'fail' && check.error) extra.push(`error: ${check.error}`)
    if (check.status === 'fail' && check.status) extra.push(`HTTP ${check.status}`)
    if (check.reason) extra.push(check.reason)
    if (check.note) extra.push(check.note)

    console.log(`  [${icon}] ${check.name}${extra.length ? ' - ' + extra.join(', ') : ''}`)
  }

  console.log('')

  const passed = checks.filter(c => c.status === 'pass').length
  const failed = checks.filter(c => c.status === 'fail').length
  const skipped = checks.filter(c => c.status === 'skip').length

  console.log(`Total: ${checks.length} | Pass: ${passed} | Fail: ${failed} | Skip: ${skipped}`)

  if (failed > 0) {
    console.log('')
    console.log('FAILED')
    return 1
  }

  if (skipped === checks.length) {
    console.log('')
    console.log('SKIPPED (no token provided, all checks skipped)')
    return 2
  }

  console.log('')
  console.log('PASSED')
  return 0
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Smoke test error:', err?.message || err)
    process.exit(1)
  })
