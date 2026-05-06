import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-postdeploy-summary.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-postdeploy-summary-'))
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

test('renders compact pass summary from evidence JSON', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: false,
      summary: { pass: 2, skipped: 1, fail: 0 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'authenticated-integration-contract', status: 'skipped' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Status: \*\*PASS\*\*/)
    assert.match(result.stdout, /Summary: `2 pass \/ 1 skipped \/ 0 fail`/)
    assert.match(result.stdout, /`api-health`: `pass`/)
    assert.match(result.stdout, /`authenticated-integration-contract`: `skipped`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('renders blocked internal signoff for public-only smoke evidence', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: false,
      signoff: {
        internalTrial: 'blocked',
        reason: 'authenticated checks did not run',
      },
      summary: { pass: 2, skipped: 1, fail: 0 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'authenticated-integration-contract', status: 'skipped' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /Signoff reason: authenticated checks did not run/)
    assert.match(result.stdout, /Status: \*\*PASS\*\*/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('renders passing internal signoff for authenticated smoke evidence', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      signoff: {
        internalTrial: 'pass',
        reason: 'authenticated smoke passed',
      },
      summary: { pass: 8, skipped: 0, fail: 0 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'auth-me', status: 'pass' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*PASS\*\*/)
    assert.match(result.stdout, /Signoff reason: authenticated smoke passed/)
    assert.match(result.stdout, /Authenticated checks: `yes`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks explicit pass when signoff evidence says top-level ok is false', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: false,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      signoff: {
        internalTrial: 'pass',
        reason: 'authenticated smoke passed',
      },
      summary: { pass: 8, skipped: 0, fail: 0 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'auth-me', status: 'pass' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /authenticated signoff evidence is inconsistent: top-level ok is not true/)
    assert.match(result.stdout, /Status: \*\*FAIL\*\*/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks explicit pass when signoff evidence is not authenticated', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: false,
      signoff: {
        internalTrial: 'pass',
        reason: 'authenticated smoke passed',
      },
      summary: { pass: 8, skipped: 0, fail: 0 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'auth-me', status: 'pass' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /authenticated signoff evidence is inconsistent: authenticated checks did not run/)
    assert.match(result.stdout, /Authenticated checks: `no`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks explicit pass when signoff evidence has failed checks', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      signoff: {
        internalTrial: 'pass',
        reason: 'authenticated smoke passed',
      },
      summary: { pass: 8, skipped: 0, fail: 1 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'auth-me', status: 'pass' },
        { id: 'integration-route-contract', status: 'fail' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /authenticated signoff evidence is inconsistent: summary\.fail is not 0/)
    assert.match(result.stdout, /Summary: `8 pass \/ 0 skipped \/ 1 fail`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('blocks inferred pass when authenticated evidence has failed checks', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      summary: { pass: 8, skipped: 0, fail: 1 },
      checks: [
        { id: 'api-health', status: 'pass' },
        { id: 'auth-me', status: 'pass' },
        { id: 'integration-route-contract', status: 'fail' },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath, '--require-auth-signoff'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /Signoff reason: one or more smoke checks failed/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('renders fail summary without failing the summary renderer', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: false,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      summary: { pass: 1, skipped: 0, fail: 1 },
      checks: [
        { id: 'api-health', status: 'pass' },
        {
          id: 'integration-route-contract',
          status: 'fail',
          details: {
            missingAdapters: ['erp:k3-wise-webapi'],
            missingRoutes: ['POST /api/integration/dead-letters/:id/replay'],
          },
        },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Status: \*\*FAIL\*\*/)
    assert.match(result.stdout, /Authenticated checks: `yes`/)
    assert.match(result.stdout, /`integration-route-contract`: `fail`/)
    assert.match(result.stdout, /missingAdapters: `erp:k3-wise-webapi`/)
    assert.match(result.stdout, /missingRoutes: `POST \/api\/integration\/dead-letters\/:id\/replay`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('renders staging missing field details for failed descriptor checks', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'evidence.json')
  try {
    writeFileSync(evidencePath, `${JSON.stringify({
      ok: false,
      baseUrl: 'http://127.0.0.1:8081',
      authenticated: true,
      summary: { pass: 3, skipped: 0, fail: 1 },
      checks: [
        {
          id: 'staging-descriptor-contract',
          status: 'fail',
          details: {
            missingFields: {
              standard_materials: ['erpSyncStatus'],
              integration_exceptions: ['errorMessage', 'status'],
            },
            invalidFields: {
              standard_materials: {
                status: [
                  'expected type select but got string',
                  'missing options: active, obsolete',
                ],
              },
            },
          },
        },
      ],
    })}\n`)

    const result = await runScript(['--input', evidencePath])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /`staging-descriptor-contract`: `fail`/)
    assert.match(result.stdout, /missingFields: standard_materials: `erpSyncStatus`/)
    assert.match(result.stdout, /integration_exceptions: `errorMessage`, `status`/)
    assert.match(result.stdout, /invalidFields: standard_materials: status: `expected type select but got string`, `missing options: active, obsolete`/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('missing evidence can be rendered as not run for always-run workflow summaries', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'missing.json')
  try {
    const result = await runScript(['--input', evidencePath, '--missing-ok'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Status: \*\*NOT RUN\*\*/)
    assert.match(result.stdout, /evidence file missing/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('missing evidence can render blocked signoff for always-run workflow summaries', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'missing.json')
  try {
    const result = await runScript(['--input', evidencePath, '--require-auth-signoff', '--missing-ok'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Internal trial signoff: \*\*BLOCKED\*\*/)
    assert.match(result.stdout, /Signoff reason: evidence file missing; authenticated smoke did not run/)
    assert.match(result.stdout, /Status: \*\*NOT RUN\*\*/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('missing evidence fails by default', async () => {
  const outDir = makeTmpDir()
  const evidencePath = path.join(outDir, 'missing.json')
  try {
    const result = await runScript(['--input', evidencePath])

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
  assert.match(result.stdout, /Usage: node scripts\/ops\/integration-k3wise-postdeploy-summary\.mjs/)
})
