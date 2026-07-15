import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'github-dingtalk-oauth-stability-summary.py')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'github-dingtalk-oauth-stability-summary-'))
}

function runSummary(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`summary timed out\nstdout=${stdout}\nstderr=${stderr}`))
    }, 10_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

// Extracts the raw text between a `## <heading>` line and the next `## ` heading (or EOF), so
// assertions can be scoped to the section they claim to be about instead of matching anywhere
// in the document.
function extractSection(markdown, heading) {
  const lines = markdown.split('\n')
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (startIndex === -1) {
    return null
  }
  const rest = lines.slice(startIndex + 1)
  const endOffset = rest.findIndex((line) => line.startsWith('## '))
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset)
  return body.join('\n')
}

async function runWithPayload(outDir, payload, env) {
  const jsonPath = path.join(outDir, 'stability.json')
  const logPath = path.join(outDir, 'stability.log')
  const summaryPath = path.join(outDir, 'summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(payload)}\n`)
  writeFileSync(logPath, 'log tail\n')
  const result = await runSummary([jsonPath, logPath, summaryPath], env)
  const summary = result.status === 0 ? JSON.parse(readFileSync(path.join(outDir, 'summary.json'), 'utf8')) : null
  return { result, summary }
}

// PIN (a) — the owner's masking case. A real OAuth-metrics outage (oauthMetricsPresent=false)
// must be reported as the failure reason. An unconfigured webhook (a separate, DEFERRED,
// by-design concern) must never appear as a failure reason again — that coupling is exactly
// what let the real outage go unreported while the summary blamed webhook config instead.
test('DT-CLOSE-01B pin (a): metrics-absent is reported; webhook/notify wording never appears as a failure reason', async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-04-29T12:50:55Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'ok', plugins: 13, ok: true },
        webhookConfig: { configured: false, host: '', pathLength: 0 },
        alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 0 },
        storage: { root: { usePercent: 40, availableKBlocks: 4941512, maxUsePercent: 95 } },
        bridge: { notifyEventsLastWindow: 0, resolvedEventsLastWindow: 0 },
        metrics: { operationsSamples: [], fallbackSamples: [], redisSamples: [] },
        oauthMetricsPresent: false,
        alertDeliveryObservability: 'deferred',
        healthy: false,
      },
      { STABILITY_RC: '0', HEALTHY: 'false', WEBHOOK_SECRET_AVAILABLE: 'false' },
    )

    assert.equal(result.status, 0, result.stderr)

    // Authoritative pin: the failure-reasons array is exactly the metrics-absent reason — no
    // webhook/notify/host-drift reason survives, no matter how the JSON payload is shaped.
    assert.deepEqual(summary.failureReasons, [
      'OAuth state-operation metrics are absent from /metrics/prom (producer not running/not deployed, or the scrape is broken)',
    ])

    const outcomeSection = extractSection(result.stdout, 'Outcome')
    assert.match(outcomeSection, /OAuth state-operation metrics are absent/)
    assert.doesNotMatch(outcomeSection, /webhook/i)
    assert.doesNotMatch(outcomeSection, /notify/i)
    assert.doesNotMatch(outcomeSection, /host drifted/i)

    // The next action for the metrics-absent reason points at the actual thing to check.
    assert.ok(
      summary.nextActions.some((action) => action.includes('METRICS_SCRAPE_TOKEN') && action.includes('OAuth state-metrics producer')),
      `expected a METRICS_SCRAPE_TOKEN next action, got: ${JSON.stringify(summary.nextActions)}`,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// PIN (b) — deferred alert-delivery topology never produces a failure reason, even though the
// summary must still surface it as context so a human knows why it reads that way.
test("DT-CLOSE-01B pin (b): healthy=true + alertDeliveryObservability='deferred' yields zero failure reasons and a deferred info line", async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-07-14T03:00:00Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'ok', plugins: 13, ok: true },
        webhookConfig: { configured: false, host: '', pathLength: 0 },
        alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 0 },
        storage: { root: { usePercent: 40, availableKBlocks: 4941512, maxUsePercent: 95 } },
        bridge: { notifyEventsLastWindow: 0, resolvedEventsLastWindow: 0 },
        metrics: { operationsSamples: ['metasheet_dingtalk_oauth_state_operations_total{result="ok"} 3'], fallbackSamples: [], redisSamples: [] },
        oauthMetricsPresent: true,
        alertDeliveryObservability: 'deferred',
        healthy: true,
      },
      { STABILITY_RC: '0', HEALTHY: 'true', WEBHOOK_SECRET_AVAILABLE: 'false' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(summary.status, 'PASS')
    assert.deepEqual(summary.failureReasons, [])

    const infoSection = extractSection(result.stdout, 'Alert Delivery Observability')
    assert.ok(infoSection, 'expected an Alert Delivery Observability section in the markdown')
    assert.match(infoSection, /`deferred`/)
    assert.match(infoSection, /deferred by design/)
    assert.match(infoSection, /NOT part of the OAuth-stability health verdict/)
    assert.match(infoSection, /Webhook configured \(context only\): `False`/)

    assert.ok(
      summary.nextActions.some((action) => action.includes('deferred') && action.includes('switch ledger')),
      `expected a deferred-topology next action, got: ${JSON.stringify(summary.nextActions)}`,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// PIN (c) — an observed topology with delivery errors gets a WARNING line, explicitly marked as
// not a failure reason, and the failure-reasons array stays empty.
test('DT-CLOSE-01B pin (c): observed + notifyErrors>0 emits a warning line but zero failure reasons', async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-07-14T03:05:00Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'ok', plugins: 13, ok: true },
        webhookConfig: { configured: true, host: 'hooks.slack.com', pathLength: 40 },
        alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 3 },
        storage: { root: { usePercent: 40, availableKBlocks: 4941512, maxUsePercent: 95 } },
        bridge: { notifyEventsLastWindow: 2, resolvedEventsLastWindow: 2 },
        metrics: { operationsSamples: ['metasheet_dingtalk_oauth_state_operations_total{result="ok"} 3'], fallbackSamples: [], redisSamples: [] },
        oauthMetricsPresent: true,
        alertDeliveryObservability: 'observed',
        healthy: true,
      },
      { STABILITY_RC: '0', HEALTHY: 'true', WEBHOOK_SECRET_AVAILABLE: 'true' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(summary.status, 'PASS')
    assert.deepEqual(summary.failureReasons, [])

    const infoSection = extractSection(result.stdout, 'Alert Delivery Observability')
    assert.ok(infoSection, 'expected an Alert Delivery Observability section in the markdown')
    assert.match(infoSection, /`observed`/)
    assert.match(infoSection, /WARNING: Alertmanager reported 3 delivery error\(s\)/)
    assert.match(infoSection, /NOT a failure reason/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('backend health not ok still reports as a failure reason', async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-07-14T03:10:00Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'degraded', plugins: 13, ok: false },
        webhookConfig: { configured: true, host: 'hooks.slack.com', pathLength: 40 },
        alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 0 },
        storage: { root: { usePercent: 40, availableKBlocks: 4941512, maxUsePercent: 95 } },
        bridge: { notifyEventsLastWindow: 0, resolvedEventsLastWindow: 0 },
        metrics: { operationsSamples: ['metasheet_dingtalk_oauth_state_operations_total{result="ok"} 3'], fallbackSamples: [], redisSamples: [] },
        oauthMetricsPresent: true,
        alertDeliveryObservability: 'observed',
        healthy: false,
      },
      { STABILITY_RC: '0', HEALTHY: 'false', WEBHOOK_SECRET_AVAILABLE: 'true' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(summary.failureReasons, ['backend health is not ok (status=degraded ok=False)'])
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('root filesystem at/over gate still reports as a failure reason', async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-07-14T03:15:00Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'ok', plugins: 13, ok: true },
        webhookConfig: { configured: true, host: 'hooks.slack.com', pathLength: 40 },
        alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 0 },
        storage: { root: { usePercent: 96, availableKBlocks: 100, maxUsePercent: 95 } },
        bridge: { notifyEventsLastWindow: 0, resolvedEventsLastWindow: 0 },
        metrics: { operationsSamples: ['metasheet_dingtalk_oauth_state_operations_total{result="ok"} 3'], fallbackSamples: [], redisSamples: [] },
        oauthMetricsPresent: true,
        alertDeliveryObservability: 'observed',
        healthy: false,
      },
      { STABILITY_RC: '0', HEALTHY: 'false', WEBHOOK_SECRET_AVAILABLE: 'true' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(summary.failureReasons, ['root filesystem is at or above gate (96% / 95% max)'])
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('stability-check command failure and missing JSON keep their existing behavior', async () => {
  const outDir = makeTmpDir()
  const jsonPath = path.join(outDir, 'stability.json')
  const logPath = path.join(outDir, 'stability.log')
  const summaryPath = path.join(outDir, 'summary.md')
  try {
    writeFileSync(logPath, 'ssh connection refused\n')
    const result = await runSummary([jsonPath, logPath, summaryPath], {
      STABILITY_RC: '255',
      HEALTHY: 'false',
      WEBHOOK_SECRET_AVAILABLE: 'false',
    })

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.deepEqual(summary.failureReasons, [
      'stability-check command failed (rc=255)',
      'stability JSON missing or unreadable',
    ])
    assert.equal(summary.status, 'FAIL')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// Instruction 4: the summary must never crash on partial JSON — missing storage / alertmanager /
// alertDeliveryObservability / oauthMetricsPresent keys should degrade gracefully, not throw.
test('partial JSON with missing keys does not crash and still surfaces the metrics-absent reason', async () => {
  const outDir = makeTmpDir()
  try {
    const { result, summary } = await runWithPayload(
      outDir,
      {
        checkedAt: '2026-07-14T03:20:00Z',
        host: 'mainuser@23.254.236.11',
        health: { status: 'ok', plugins: 13, ok: true },
        // storage, alertmanager, webhookConfig, alertDeliveryObservability, oauthMetricsPresent
        // are all intentionally absent.
        healthy: false,
      },
      { STABILITY_RC: '0', HEALTHY: 'false', WEBHOOK_SECRET_AVAILABLE: 'false' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      summary.failureReasons.includes(
        'OAuth state-operation metrics are absent from /metrics/prom (producer not running/not deployed, or the scrape is broken)',
      ),
      `expected the metrics-absent reason, got: ${JSON.stringify(summary.failureReasons)}`,
    )
    // Absent storage defaults both usePercent and maxUsePercent to 0, so 0 >= 0 also fires —
    // this is documented fail-closed behavior, not a bug, and must not crash.
    assert.ok(
      summary.failureReasons.some((reason) => reason.startsWith('root filesystem is at or above gate')),
      `expected a storage-gate reason from the 0/0 default, got: ${JSON.stringify(summary.failureReasons)}`,
    )

    const infoSection = extractSection(result.stdout, 'Alert Delivery Observability')
    assert.ok(infoSection, 'expected the info section to render even with missing keys')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
