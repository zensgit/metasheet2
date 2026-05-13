import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-signoff-gate.mjs')
const requiredPassChecks = [
  'auth-me',
  'integration-route-contract',
  'integration-list-external-systems',
  'integration-list-pipelines',
  'integration-list-runs',
  'integration-list-dead-letters',
  'staging-descriptor-contract',
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-signoff-gate-'))
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`script timed out\nstdout=${stdout}\nstderr=${stderr}`))
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

function writeEvidence(dir, overrides = {}) {
  const evidence = {
    ok: true,
    generatedAt: '2026-05-06T00:00:00.000Z',
    baseUrl: 'http://127.0.0.1:8081',
    authenticated: true,
    requireAuth: true,
    signoff: {
      internalTrial: 'pass',
      reason: 'authenticated smoke passed',
    },
    checks: requiredPassChecks.map((id) => ({ id, status: 'pass' })),
    summary: { pass: requiredPassChecks.length + 3, skipped: 0, fail: 0 },
    ...overrides,
  }
  const evidencePath = path.join(dir, 'integration-k3wise-postdeploy-smoke.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  return evidencePath
}

test('passes authenticated postdeploy evidence with all required checks', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir)

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 0, result.stderr)
    const body = JSON.parse(result.stdout)
    assert.equal(body.ok, true)
    assert.equal(body.status, 'PASS')
    assert.equal(body.signoff, 'pass')
    assert.equal(body.summary.fail, 0)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks public-only evidence even when diagnostic smoke passed', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir, {
      authenticated: false,
      signoff: {
        internalTrial: 'blocked',
        reason: 'authenticated checks did not run',
      },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'integration-plugin-health', status: 'pass' },
        { id: 'k3-wise-frontend-route', status: 'pass' },
        { id: 'authenticated-integration-contract', status: 'skipped' },
      ],
      summary: { pass: 3, skipped: 1, fail: 0 },
    })

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 1)
    const body = JSON.parse(result.stdout)
    assert.equal(body.status, 'BLOCKED')
    assert.match(body.reason, /authenticated checks must have run/)
    assert.match(body.reason, /missing required checks: auth-me/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks stale explicit pass when top-level ok is false', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir, {
      ok: false,
      summary: { pass: requiredPassChecks.length, skipped: 0, fail: 0 },
    })

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 1)
    assert.match(JSON.parse(result.stdout).reason, /top-level ok must be true/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks stale explicit pass when summary.fail is nonzero', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir, {
      summary: { pass: requiredPassChecks.length, skipped: 0, fail: 1 },
    })

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 1)
    assert.match(JSON.parse(result.stdout).reason, /summary\.fail must be 0/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks when a required check is missing', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir, {
      checks: requiredPassChecks
        .filter((id) => id !== 'staging-descriptor-contract')
        .map((id) => ({ id, status: 'pass' })),
    })

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 1)
    assert.match(JSON.parse(result.stdout).reason, /missing required checks: staging-descriptor-contract/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks when a required check is not passing', async () => {
  const outDir = makeTmpDir()
  try {
    const evidencePath = writeEvidence(outDir, {
      checks: requiredPassChecks.map((id) => ({
        id,
        status: id === 'integration-list-runs' ? 'fail' : 'pass',
      })),
    })

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 1)
    assert.match(JSON.parse(result.stdout).reason, /required checks not passing: integration-list-runs:fail/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('missing evidence fails by default', async () => {
  const outDir = makeTmpDir()
  try {
    const result = await runScript(['--input', path.join(outDir, 'missing.json')])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /ENOENT/)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('help prints usage', async () => {
  const result = await runScript(['--help'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: node scripts\/ops\/integration-k3wise-signoff-gate\.mjs/)
  assert.match(result.stdout, /auth-me/)
})
