#!/usr/bin/env node

const DEFAULTS = {
  timeoutMs: 8000,
  maxActiveDocs: 200,
  maxFlushFailures: 10,
  maxPendingWrites: 50,
  maxActiveSockets: 500,
}

function printHelp() {
  console.log(`Usage: node scripts/ops/check-yjs-rollout-status.mjs [options]

Checks Yjs rollout runtime status from /api/admin/yjs/status.

Options:
  --base-url <url>             Base URL, default from YJS_BASE_URL or http://localhost:3000
  --token <token>              Admin bearer token, default from YJS_ADMIN_TOKEN or ADMIN_TOKEN
  --timeout-ms <ms>            Request timeout in milliseconds, default ${DEFAULTS.timeoutMs}
  --max-active-docs <count>    Alert threshold, default ${DEFAULTS.maxActiveDocs}
  --max-flush-failures <count> Alert threshold, default ${DEFAULTS.maxFlushFailures}
  --max-pending-writes <count> Alert threshold, default ${DEFAULTS.maxPendingWrites}
  --max-active-sockets <count> Alert threshold, default ${DEFAULTS.maxActiveSockets}
  --json                       Print raw JSON payload after the summary
  --help                       Show this help

Exit codes:
  0  healthy
  1  usage or request failure
  2  status fetched but rollout is not healthy
`)
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.YJS_BASE_URL || 'http://localhost:3000',
    token: process.env.YJS_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    timeoutMs: DEFAULTS.timeoutMs,
    maxActiveDocs: DEFAULTS.maxActiveDocs,
    maxFlushFailures: DEFAULTS.maxFlushFailures,
    maxPendingWrites: DEFAULTS.maxPendingWrites,
    maxActiveSockets: DEFAULTS.maxActiveSockets,
    showJson: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--base-url':
        opts.baseUrl = next
        i += 1
        break
      case '--token':
        opts.token = next
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number(next)
        i += 1
        break
      case '--max-active-docs':
        opts.maxActiveDocs = Number(next)
        i += 1
        break
      case '--max-flush-failures':
        opts.maxFlushFailures = Number(next)
        i += 1
        break
      case '--max-pending-writes':
        opts.maxPendingWrites = Number(next)
        i += 1
        break
      case '--max-active-sockets':
        opts.maxActiveSockets = Number(next)
        i += 1
        break
      case '--json':
        opts.showJson = true
        break
      case '--help':
        printHelp()
        process.exit(0)
      default:
        console.error(`Unknown argument: ${arg}`)
        printHelp()
        process.exit(1)
    }
  }

  return opts
}

function toNonNegativeNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function assessStatus(payload, thresholds) {
  const yjs = payload?.yjs ?? {}
  const sync = yjs.sync ?? {}
  const bridge = yjs.bridge ?? {}
  const socket = yjs.socket ?? {}

  const metrics = {
    enabled: Boolean(yjs.enabled),
    initialized: Boolean(yjs.initialized),
    activeDocCount: toNonNegativeNumber(sync.activeDocCount),
    pendingWriteCount: toNonNegativeNumber(bridge.pendingWriteCount),
    flushSuccessCount: toNonNegativeNumber(bridge.flushSuccessCount),
    flushFailureCount: toNonNegativeNumber(bridge.flushFailureCount),
    activeSocketCount: toNonNegativeNumber(socket.activeSocketCount),
    activeRecordCount: toNonNegativeNumber(socket.activeRecordCount),
  }

  const failures = []

  if (!metrics.enabled) failures.push('ENABLE_YJS_COLLAB is false')
  if (!metrics.initialized) failures.push('Yjs runtime is not initialized')
  if (metrics.activeDocCount > thresholds.maxActiveDocs) {
    failures.push(`activeDocCount ${metrics.activeDocCount} > ${thresholds.maxActiveDocs}`)
  }
  if (metrics.flushFailureCount > thresholds.maxFlushFailures) {
    failures.push(`flushFailureCount ${metrics.flushFailureCount} > ${thresholds.maxFlushFailures}`)
  }
  if (metrics.pendingWriteCount > thresholds.maxPendingWrites) {
    failures.push(`pendingWriteCount ${metrics.pendingWriteCount} > ${thresholds.maxPendingWrites}`)
  }
  if (metrics.activeSocketCount > thresholds.maxActiveSockets) {
    failures.push(`activeSocketCount ${metrics.activeSocketCount} > ${thresholds.maxActiveSockets}`)
  }

  return { metrics, failures }
}

function printSummary(baseUrl, metrics, failures) {
  console.log(`Yjs rollout status: ${failures.length === 0 ? 'HEALTHY' : 'UNHEALTHY'}`)
  console.log(`Base URL: ${baseUrl}`)
  console.log(`Enabled: ${metrics.enabled}`)
  console.log(`Initialized: ${metrics.initialized}`)
  console.log(`Active docs: ${metrics.activeDocCount}`)
  console.log(`Pending writes: ${metrics.pendingWriteCount}`)
  console.log(`Flush successes: ${metrics.flushSuccessCount}`)
  console.log(`Flush failures: ${metrics.flushFailureCount}`)
  console.log(`Active records: ${metrics.activeRecordCount}`)
  console.log(`Active sockets: ${metrics.activeSocketCount}`)

  if (failures.length > 0) {
    console.log('Failures:')
    for (const failure of failures) {
      console.log(`- ${failure}`)
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.token) {
    console.error('Missing admin token. Use --token, YJS_ADMIN_TOKEN, or ADMIN_TOKEN.')
    process.exit(1)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)

  try {
    const url = new URL('/api/admin/yjs/status', opts.baseUrl).toString()
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error(`Request failed: ${response.status} ${response.statusText}`)
      const body = await response.text().catch(() => '')
      if (body) console.error(body)
      process.exit(1)
    }

    const payload = await response.json()
    const { metrics, failures } = assessStatus(payload, opts)
    printSummary(opts.baseUrl, metrics, failures)

    if (opts.showJson) {
      console.log(JSON.stringify(payload, null, 2))
    }

    process.exit(failures.length === 0 ? 0 : 2)
  } catch (error) {
    console.error(`Failed to fetch Yjs status: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  } finally {
    clearTimeout(timeout)
  }
}

await main()
