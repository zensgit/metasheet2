import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-release-readiness.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-release-readiness-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function writeEnv(file, overrides = {}) {
  const values = {
    DINGTALK_P4_API_BASE: 'http://142.171.239.56:8900',
    DINGTALK_P4_WEB_BASE: 'http://142.171.239.56:8081',
    DINGTALK_P4_AUTH_TOKEN: 'secret-admin-token',
    DINGTALK_P4_GROUP_A_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a',
    DINGTALK_P4_GROUP_B_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
    DINGTALK_P4_GROUP_A_SECRET: 'SECabcdefghijklmnop12345678',
    DINGTALK_P4_GROUP_B_SECRET: '',
    DINGTALK_P4_ALLOWED_USER_IDS: 'user_authorized',
    DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS: '',
    DINGTALK_P4_PERSON_USER_IDS: 'user_person_bound',
    DINGTALK_P4_AUTHORIZED_USER_ID: '',
    DINGTALK_P4_UNAUTHORIZED_USER_ID: 'user_unauthorized',
    DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID: 'dt_no_email_001',
    ...overrides,
  }
  const content = Object.entries(values)
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join('\n')
  writeFileSync(file, `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

function readSummary(outputDir) {
  return JSON.parse(readFileSync(path.join(outputDir, 'release-readiness-summary.json'), 'utf8'))
}

test('dingtalk-p4-release-readiness fails when private env readiness fails even if regression passes', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, {
      DINGTALK_P4_AUTH_TOKEN: '',
      DINGTALK_P4_GROUP_B_WEBHOOK: '',
      DINGTALK_P4_UNAUTHORIZED_USER_ID: '',
      DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID: '',
    })

    const result = runScript([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'release-readiness-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.match(summaryText, /access_token=<redacted>/)

    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.gates.find((gate) => gate.id === 'env-readiness').status, 'fail')
    assert.equal(summary.gates.find((gate) => gate.id === 'regression-gate').status, 'pass')
    assert.ok(summary.gates.find((gate) => gate.id === 'env-readiness').details.failedChecks.includes('dingtalk_p4_auth_token'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness passes with complete env and passing regression', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile)

    const result = runScript([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.gates.every((gate) => gate.status === 'pass'), true)
    const markdown = readFileSync(path.join(outputDir, 'release-readiness-summary.md'), 'utf8')
    assert.match(markdown, /dingtalk-p4-smoke-session\.mjs/)
    assert.match(markdown, /--require-manual-targets/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness reports manual_pending when regression is plan-only', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile)

    const result = runScript([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--regression-plan-only',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 1)
    const summary = readSummary(outputDir)
    assert.equal(summary.overallStatus, 'manual_pending')
    assert.equal(summary.gates.find((gate) => gate.id === 'regression-gate').status, 'skipped')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness allow-failures keeps reports inspectable with zero exit', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, { DINGTALK_P4_AUTH_TOKEN: '' })

    const result = runScript([
      '--p4-env-file', envFile,
      '--regression-profile', 'selftest',
      '--allow-failures',
      '--output-dir', outputDir,
    ])

    assert.equal(result.status, 0)
    assert.equal(readSummary(outputDir).overallStatus, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-release-readiness rejects invalid public regression profile', () => {
  const result = runScript(['--regression-profile', 'bad'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--regression-profile must be one of: ops, product, all/)
})
