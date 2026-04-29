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

test('summary calls out missing GitHub webhook secret when self-heal was skipped', async () => {
  const outDir = makeTmpDir()
  const jsonPath = path.join(outDir, 'stability.json')
  const logPath = path.join(outDir, 'stability.log')
  const summaryPath = path.join(outDir, 'summary.md')
  try {
    writeFileSync(jsonPath, `${JSON.stringify({
      checkedAt: '2026-04-29T12:50:55Z',
      host: 'mainuser@142.171.239.56',
      health: { status: 'ok', plugins: 13, ok: true },
      webhookConfig: { configured: false, host: '', pathLength: 0 },
      alertmanager: { activeAlertsCount: 0, notifyErrorsLastWindow: 0 },
      storage: { root: { usePercent: 94, availableKBlocks: 4941512, maxUsePercent: 95 } },
      bridge: { notifyEventsLastWindow: 0, resolvedEventsLastWindow: 0 },
      metrics: { operationsSamples: [], fallbackSamples: [], redisSamples: [] },
      healthy: false,
    })}\n`)
    writeFileSync(logPath, 'self-heal skipped\n')

    const result = await runSummary([jsonPath, logPath, summaryPath], {
      STABILITY_RC: '0',
      HEALTHY: 'false',
      WEBHOOK_SECRET_AVAILABLE: 'false',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Webhook self-heal secret available: `false`/)
    assert.match(result.stdout, /Alertmanager webhook is not configured/)
    assert.match(result.stdout, /No supported GitHub webhook secret was available/)
    assert.match(result.stdout, /Configure one supported GitHub Actions secret/)

    const summary = JSON.parse(readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    assert.equal(summary.selfHeal.webhookSecretAvailable, false)
    assert.deepEqual(summary.failureReasons, [
      'Alertmanager webhook is not configured',
      'No supported GitHub webhook secret was available for Alertmanager self-heal',
    ])
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

