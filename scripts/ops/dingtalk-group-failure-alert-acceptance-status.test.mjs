import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-group-failure-alert-acceptance-status.mjs')
const fallbackEnvKeys = [
  'DINGTALK_GROUP_FAILURE_ALERT_API_BASE',
  'API_BASE',
  'DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN',
  'ADMIN_TOKEN',
  'AUTH_TOKEN',
  'DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE',
  'ADMIN_TOKEN_FILE',
  'AUTH_TOKEN_FILE',
  'DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID',
  'SHEET_ID',
  'DINGTALK_GROUP_FAILURE_ALERT_RULE_ID',
  'RULE_ID',
  'DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID',
  'RECORD_ID',
  'DINGTALK_GROUP_FAILURE_ALERT_EXPECT_PERSON_STATUS',
  'DINGTALK_GROUP_FAILURE_ALERT_SUBJECT',
  'ALERT_SUBJECT',
  'DINGTALK_GROUP_FAILURE_ALERT_PROBE_OUTPUT_DIR',
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-group-failure-alert-acceptance-status-'))
}

function runScript(args, env = {}) {
  const baseEnv = { ...process.env }
  for (const key of fallbackEnvKeys) {
    delete baseEnv[key]
  }
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  })
}

function writeEnv(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('dingtalk-group-failure-alert-acceptance-status reports blocked inputs without leaking token values', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'acceptance.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_GROUP_FAILURE_ALERT_API_BASE="http://142.171.239.56:8081"',
      'DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID="sheet_1"',
      'DINGTALK_GROUP_FAILURE_ALERT_RULE_ID="rule_1"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
      '--allow-blocked',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(outputJson), true)
    assert.equal(existsSync(outputMd), true)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)

    const summaryText = readFileSync(outputJson, 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'blocked')
    assert.equal(summary.inputs.authTokenPresent, true)
    assert.equal(summary.inputs.recordIdPresent, false)
    assert.deepEqual(summary.missingInputs.map((item) => item.id), ['record-id-present'])

    const markdown = readFileSync(outputMd, 'utf8')
    assert.match(markdown, /Overall Status: `blocked`/)
    assert.match(markdown, /Fresh failed test record id is present/)
    assert.doesNotMatch(markdown, /secret-admin-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status writes a fill-in env template without secrets', () => {
  const tmpDir = makeTmpDir()
  const envTemplate = path.join(tmpDir, '142.env')
  try {
    const result = runScript(['--write-env-template', envTemplate])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(envTemplate), true)
    const template = readFileSync(envTemplate, 'utf8')
    assert.match(template, /DINGTALK_GROUP_FAILURE_ALERT_API_BASE/)
    assert.match(template, /DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE/)
    assert.match(template, /DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID=""/)
    assert.match(template, /DINGTALK_GROUP_FAILURE_ALERT_RULE_ID=""/)
    assert.match(template, /DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID=""/)
    assert.doesNotMatch(template, /secret-admin-token|access_token=|SEC[A-Za-z0-9+/=_-]{8,}|eyJ[A-Za-z0-9._-]{20,}/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status refuses to overwrite env template unless forced', () => {
  const tmpDir = makeTmpDir()
  const envTemplate = path.join(tmpDir, '142.env')
  try {
    writeFileSync(envTemplate, 'EXISTING=1\n', 'utf8')

    const blocked = runScript(['--write-env-template', envTemplate])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /already exists/)
    assert.equal(readFileSync(envTemplate, 'utf8'), 'EXISTING=1\n')

    const forced = runScript(['--write-env-template', envTemplate, '--force'])
    assert.equal(forced.status, 0, forced.stderr || forced.stdout)
    assert.match(readFileSync(envTemplate, 'utf8'), /DINGTALK_GROUP_FAILURE_ALERT_API_BASE/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status passes complete inputs and writes probe commands', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'acceptance.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')
    writeEnv(envFile, [
      'DINGTALK_GROUP_FAILURE_ALERT_API_BASE="http://142.171.239.56:8081"',
      `DINGTALK_GROUP_FAILURE_ALERT_AUTH_TOKEN_FILE="${tokenFile}"`,
      'DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID="sheet_1"',
      'DINGTALK_GROUP_FAILURE_ALERT_RULE_ID="rule_1"',
      'DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID="record_1"',
      'DINGTALK_GROUP_FAILURE_ALERT_EXPECT_PERSON_STATUS="success"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.equal(summary.missingInputs.length, 0)
    assert.equal(summary.checks.every((check) => check.status === 'pass'), true)
    assert.equal(summary.nextCommands.length, 2)
    assert.match(summary.nextCommands[0], /dingtalk-group-failure-alert-probe\.mjs/)
    assert.match(summary.nextCommands[0], /--acceptance/)
    assert.match(summary.nextCommands[0], /--expect-person-status 'success'/)
    assert.match(summary.nextCommands[1], /--expect-alert disabled/)
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /secret-admin-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status lets CLI values override env file values', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'acceptance.env')
  const tokenFile = path.join(tmpDir, 'admin.jwt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(tokenFile, 'secret-admin-token\n', 'utf8')
    writeEnv(envFile, [
      'DINGTALK_GROUP_FAILURE_ALERT_API_BASE="not-a-url"',
      'DINGTALK_GROUP_FAILURE_ALERT_SHEET_ID="old_sheet"',
      'DINGTALK_GROUP_FAILURE_ALERT_RULE_ID="old_rule"',
      'DINGTALK_GROUP_FAILURE_ALERT_RECORD_ID="old_record"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--api-base', 'http://142.171.239.56:8081',
      '--auth-token-file', tokenFile,
      '--sheet-id', 'sheet_cli',
      '--rule-id', 'rule_cli',
      '--record-id', 'record_cli',
      '--expect-person-status', 'skipped',
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.match(summary.nextCommands[0], /'sheet_cli'/)
    assert.match(summary.nextCommands[0], /'rule_cli'/)
    assert.match(summary.nextCommands[0], /'record_cli'/)
    assert.match(summary.nextCommands[0], /--expect-person-status 'skipped'/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status blocks unreadable token files', () => {
  const tmpDir = makeTmpDir()
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  const missingTokenFile = path.join(tmpDir, 'missing.jwt')
  try {
    const result = runScript([
      '--api-base', 'http://142.171.239.56:8081',
      '--auth-token-file', missingTokenFile,
      '--sheet-id', 'sheet_1',
      '--rule-id', 'rule_1',
      '--record-id', 'record_1',
      '--output-json', outputJson,
      '--output-md', outputMd,
      '--allow-blocked',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'blocked')
    const check = summary.checks.find((entry) => entry.id === 'auth-token-file-readable')
    assert.equal(check.status, 'fail')
    assert.ok(summary.missingInputs.some((item) => item.id === 'auth-token-file-readable'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-group-failure-alert-acceptance-status exits non-zero when blocked unless allowed', () => {
  const tmpDir = makeTmpDir()
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    const result = runScript([
      '--api-base', 'http://142.171.239.56:8081',
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 1)
    assert.match(result.stdout, /blocked/)
    assert.equal(readJson(outputJson).overallStatus, 'blocked')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
