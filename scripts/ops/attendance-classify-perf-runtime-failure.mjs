import fs from 'node:fs/promises'

function findLastFailureLine(logText) {
  const lines = String(logText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (/^\[attendance-import-perf\] Failed:/.test(line)) {
      return line
    }
  }

  return lines.slice(-40).join(' ').trim()
}

function hasAny(upper, needles) {
  return needles.some((needle) => upper.includes(needle))
}

function collectSignals(logText, failureLine) {
  const upper = `${logText || ''}\n${failureLine || ''}`.toUpperCase()
  const signals = []

  if (hasAny(upper, ['HTTP 502', 'BAD GATEWAY'])) signals.push('http_502')
  if (upper.includes('HTTP 503')) signals.push('http_503')
  if (upper.includes('HTTP 504')) signals.push('http_504')
  if (hasAny(upper, ['FETCH FAILED', 'ECONNRESET', 'ETIMEDOUT', 'NETWORK ERROR'])) {
    signals.push('network_error')
  }
  if (upper.includes('ASYNC COMMIT JOB POLL TIMED OUT')) {
    signals.push('async_commit_poll_timeout')
  }
  if (upper.includes('ASYNC COMMIT JOB TIMED OUT')) {
    signals.push('async_commit_timeout')
  }
  if (hasAny(upper, ['STALLMS=', 'NO PROGRESS', 'STALLED'])) {
    signals.push('async_commit_stall')
  }
  if (upper.includes('STATEMENT TIMEOUT')) signals.push('db_statement_timeout')
  if (upper.includes('DEADLOCK DETECTED')) signals.push('db_deadlock')

  return [...new Set(signals)]
}

function classifyRuntimeFailure({ logText, failureLine }) {
  const upper = `${logText || ''}\n${failureLine || ''}`.toUpperCase()
  if (upper.includes('CSV EXCEEDS MAX ROWS')) return null

  const signals = collectSignals(logText, failureLine)
  if (signals.length === 0) return null

  const hasGatewayOrNetwork = signals.some((signal) => (
    signal === 'http_502'
    || signal === 'http_503'
    || signal === 'http_504'
    || signal === 'network_error'
  ))
  const hasAsyncCommit = signals.some((signal) => signal.startsWith('async_commit_'))

  if (hasAsyncCommit && hasGatewayOrNetwork) {
    return {
      classification: 'async_commit_runtime_unstable',
      signals,
      suggestedAction: 'Inspect backend, web/nginx, and container health during the import job window; then decide whether the fix is infra capacity, import throughput, or timeout budget.',
    }
  }

  if (signals.includes('async_commit_timeout') || signals.includes('async_commit_poll_timeout')) {
    return {
      classification: 'async_commit_timeout',
      signals,
      suggestedAction: 'Inspect async import worker throughput and timeout settings for the high-scale commit workload, then rerun the benchmark.',
    }
  }

  if (signals.includes('http_502')) {
    return {
      classification: 'upstream_502',
      signals,
      suggestedAction: 'Inspect web/nginx upstream and backend container health around the benchmark window, then rerun.',
    }
  }

  if (signals.includes('http_503') || signals.includes('http_504')) {
    return {
      classification: 'upstream_5xx',
      signals,
      suggestedAction: 'Inspect gateway upstream health and timeout budget around the benchmark window, then rerun.',
    }
  }

  if (signals.includes('db_statement_timeout') || signals.includes('db_deadlock')) {
    return {
      classification: 'database_contention',
      signals,
      suggestedAction: 'Inspect database slow queries and lock/timeout evidence during the import window, then rerun.',
    }
  }

  return null
}

async function main() {
  const perfLogPath = process.env.PERF_LOG
  if (!perfLogPath) {
    console.error('PERF_LOG is required')
    process.exit(2)
  }

  const logText = await fs.readFile(perfLogPath, 'utf8')
  const failureLine = findLastFailureLine(logText)
  const classification = classifyRuntimeFailure({ logText, failureLine })
  if (!classification) {
    process.exit(1)
  }

  const payload = {
    ...classification,
    failureLine,
  }
  const outputJson = `${JSON.stringify(payload, null, 2)}\n`
  const outputFile = process.env.OUTPUT_FILE
  if (outputFile) {
    await fs.writeFile(outputFile, outputJson, 'utf8')
  }
  process.stdout.write(outputJson)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})
