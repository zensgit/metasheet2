import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-postdeploy-env-check.mjs')
const secretToken = 'header.payload.signature'

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'integration-k3wise-postdeploy-env-check-'))
}

function scrubEnv(extra = {}) {
  return {
    ...process.env,
    METASHEET_BASE_URL: '',
    PUBLIC_APP_URL: '',
    K3_WISE_SMOKE_TOKEN: '',
    METASHEET_AUTH_TOKEN: '',
    ADMIN_TOKEN: '',
    AUTH_TOKEN: '',
    METASHEET_AUTH_TOKEN_FILE: '',
    AUTH_TOKEN_FILE: '',
    K3_WISE_SMOKE_TENANT_ID: '',
    METASHEET_TENANT_ID: '',
    TENANT_ID: '',
    REQUIRE_AUTH: '',
    K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH: '',
    K3_WISE_PRE_SMOKE_REQUIRE_TENANT: '',
    ...extra,
  }
}

function runScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubEnv(options.env || {}),
    })
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

function parseStdout(stdout) {
  return JSON.parse(stdout)
}

test('fails when authenticated smoke is required without a token source', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--require-auth',
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 1)
    assert.equal(summary.ok, false)
    assert.equal(evidence.summary.fail, 1)
    assert.match(evidence.checks.find((check) => check.id === 'auth-token')?.message || '', /requires/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('fails when required token file is missing', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--require-auth',
      '--token-file',
      path.join(tmpDir, 'missing.jwt'),
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 1)
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'fail')
    assert.match(evidence.checks.find((check) => check.id === 'auth-token')?.message || '', /ENOENT|no such file/i)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('fails when required token file is empty', async () => {
  const tmpDir = makeTmpDir()
  try {
    const tokenPath = path.join(tmpDir, 'empty.jwt')
    writeFileSync(tokenPath, '\n')
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--require-auth',
      '--token-file',
      tokenPath,
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 1)
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'fail')
    assert.match(evidence.checks.find((check) => check.id === 'auth-token')?.message || '', /empty/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('fails when required token file is a directory', async () => {
  const tmpDir = makeTmpDir()
  try {
    const tokenDir = path.join(tmpDir, 'token-dir')
    mkdirSync(tokenDir)
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--require-auth',
      '--token-file',
      tokenDir,
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 1)
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'fail')
    assert.match(evidence.checks.find((check) => check.id === 'auth-token')?.message || '', /must point to a file/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('accepts K3_WISE_SMOKE_TOKEN without leaking the token', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--tenant-id',
      'tenant_1',
      '--out-dir',
      tmpDir,
    ], {
      env: {
        REQUIRE_AUTH: 'true',
        K3_WISE_SMOKE_TOKEN: secretToken,
      },
    })
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))
    const md = readFileSync(summary.mdPath, 'utf8')

    assert.equal(result.status, 0)
    assert.equal(summary.ok, true)
    assert.equal(summary.tokenSource, 'auth-token')
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'pass')
    assert.doesNotMatch(result.stdout, new RegExp(secretToken))
    assert.doesNotMatch(result.stderr, new RegExp(secretToken))
    assert.doesNotMatch(md, new RegExp(secretToken))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('allows unauthenticated precheck with a warning when auth is not required', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--out-dir',
      tmpDir,
    ], {
      env: {
        REQUIRE_AUTH: 'false',
      },
    })
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 0)
    assert.equal(summary.ok, true)
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'warn')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('rejects invalid base URL and query/hash URLs', async () => {
  const tmpDir = makeTmpDir()
  try {
    const secretQueryValue = 'super-secret-query-value'
    const invalid = await runScript(['--base-url', 'ftp://metasheet.example.test', '--out-dir', path.join(tmpDir, 'invalid')])
    const withQuery = await runScript(['--base-url', `https://metasheet.example.test?token=${secretQueryValue}`, '--out-dir', path.join(tmpDir, 'query')])
    const invalidEvidence = JSON.parse(readFileSync(parseStdout(invalid.stdout).jsonPath, 'utf8'))
    const querySummary = parseStdout(withQuery.stdout)
    const queryEvidenceText = readFileSync(querySummary.jsonPath, 'utf8')
    const queryEvidence = JSON.parse(queryEvidenceText)

    assert.equal(invalid.status, 1)
    assert.match(invalidEvidence.checks.find((check) => check.id === 'base-url')?.message || '', /must use http or https/)
    assert.equal(withQuery.status, 1)
    assert.match(queryEvidence.checks.find((check) => check.id === 'base-url')?.message || '', /must not contain query string or hash/)
    assert.doesNotMatch(withQuery.stdout, new RegExp(secretQueryValue))
    assert.doesNotMatch(withQuery.stderr, new RegExp(secretQueryValue))
    assert.doesNotMatch(queryEvidenceText, new RegExp(secretQueryValue))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('rejects inline base URL credentials without leaking them', async () => {
  const tmpDir = makeTmpDir()
  const secretPassword = 'super-secret-inline-password'
  try {
    const result = await runScript([
      '--base-url',
      `https://admin:${secretPassword}@metasheet.example.test`,
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidenceText = readFileSync(summary.jsonPath, 'utf8')
    const evidence = JSON.parse(evidenceText)

    assert.equal(result.status, 1)
    assert.match(evidence.checks.find((check) => check.id === 'base-url')?.message || '', /must not contain inline credentials/)
    assert.doesNotMatch(result.stdout, new RegExp(secretPassword))
    assert.doesNotMatch(result.stderr, new RegExp(secretPassword))
    assert.doesNotMatch(evidenceText, new RegExp(secretPassword))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('accepts boolean-like English and Chinese env values', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test',
      '--out-dir',
      tmpDir,
    ], {
      env: {
        REQUIRE_AUTH: '是',
        K3_WISE_PRE_SMOKE_REQUIRE_TENANT: '关闭',
        K3_WISE_SMOKE_TOKEN: secretToken,
      },
    })
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 0)
    assert.equal(summary.ok, true)
    assert.equal(evidence.requireAuth, true)
    assert.equal(evidence.requireTenant, false)
    assert.equal(evidence.checks.find((check) => check.id === 'auth-token')?.status, 'pass')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('warns when base URL includes a path', async () => {
  const tmpDir = makeTmpDir()
  try {
    const result = await runScript([
      '--base-url',
      'https://metasheet.example.test/app/',
      '--out-dir',
      tmpDir,
    ])
    const summary = parseStdout(result.stdout)
    const evidence = JSON.parse(readFileSync(summary.jsonPath, 'utf8'))

    assert.equal(result.status, 0)
    assert.equal(evidence.checks.find((check) => check.id === 'base-url-path')?.status, 'warn')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('rejects invalid timeout and boolean env values', async () => {
  const badTimeout = await runScript([
    '--base-url',
    'https://metasheet.example.test',
    '--timeout-ms',
    '0',
  ])
  const badBoolean = await runScript([
    '--base-url',
    'https://metasheet.example.test',
  ], {
    env: {
      REQUIRE_AUTH: 'sometimes',
    },
  })

  assert.equal(badTimeout.status, 1)
  assert.match(badTimeout.stderr, /--timeout-ms must be a positive integer/)
  assert.equal(badBoolean.status, 1)
  assert.match(badBoolean.stderr, /REQUIRE_AUTH must be a boolean/)
})
