#!/usr/bin/env node

/**
 * Smoke test for DingTalk OAuth endpoints.
 *
 * Verifies:
 *   1. GET /api/auth/dingtalk/launch — reachable (200 or 503)
 *   2. POST /api/auth/dingtalk/callback with missing code — returns 400
 *   3. POST /api/auth/dingtalk/callback with bad state — returns 400
 */

const DEFAULT_BASE_URL = 'http://localhost:7778'
const DEFAULT_TIMEOUT = 10_000

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL
  let timeout = DEFAULT_TIMEOUT
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base-url' && argv[i + 1]) {
      baseUrl = argv[++i]
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeout = Number(argv[++i]) || DEFAULT_TIMEOUT
    } else if (arg === '--help' || arg === '-h') {
      help = true
    }
  }

  return { baseUrl, timeout, help }
}

function printHelp() {
  console.log(`Usage: node scripts/dingtalk-oauth-smoke.mjs [options]

Smoke test for DingTalk OAuth auth endpoints.

Options:
  --base-url <url>   API base URL (default: ${DEFAULT_BASE_URL})
  --timeout <ms>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})
  --help, -h         Show this help message

Checks:
  1. GET  /api/auth/dingtalk/launch       — reachable (200 or 503)
  2. POST /api/auth/dingtalk/callback      — missing code → 400
  3. POST /api/auth/dingtalk/callback      — bad state → 400

Exit codes:
  0  All checks passed
  1  One or more checks failed`)
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function check(label, fn) {
  try {
    const ok = await fn()
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
    return ok
  } catch (error) {
    console.log(`  FAIL  ${label} — ${error.message}`)
    return false
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    printHelp()
    process.exit(0)
  }

  const base = opts.baseUrl.replace(/\/+$/, '')
  console.log(`DingTalk OAuth Smoke Test — ${base}\n`)

  const results = []

  // Check 1: launch endpoint is reachable
  results.push(await check('GET /api/auth/dingtalk/launch reachable', async () => {
    const res = await fetchWithTimeout(`${base}/api/auth/dingtalk/launch`, {}, opts.timeout)
    return res.status === 200 || res.status === 503
  }))

  // Check 2: callback rejects missing code
  results.push(await check('POST /api/auth/dingtalk/callback missing code → 400', async () => {
    const res = await fetchWithTimeout(`${base}/api/auth/dingtalk/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'test' }),
    }, opts.timeout)
    return res.status === 400
  }))

  // Check 3: callback rejects bad state
  results.push(await check('POST /api/auth/dingtalk/callback bad state → 400', async () => {
    const res = await fetchWithTimeout(`${base}/api/auth/dingtalk/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'invalid-state-that-was-never-issued' }),
    }, opts.timeout)
    return res.status === 400
  }))

  console.log('')
  const passed = results.every(Boolean)
  console.log(passed ? 'All checks passed.' : 'Some checks failed.')
  process.exit(passed ? 0 : 1)
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`)
  process.exit(1)
})
