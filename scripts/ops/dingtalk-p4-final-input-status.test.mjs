import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-final-input-status.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-final-input-status-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function writeEnv(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('dingtalk-p4-final-input-status reports blocked final inputs without leaking secrets', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK=""',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_PERSON_USER_IDS="user_authorized"',
      'DINGTALK_P4_AUTHORIZED_USER_ID="user_authorized"',
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
    assert.doesNotMatch(result.stdout, /secret-admin-token|robot-secret-a|robot-sign-a/)
    const summaryText = readFileSync(outputJson, 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.doesNotMatch(summaryText, /robot-sign-a/)
    assert.doesNotMatch(summaryText, /1690000000000/)

    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'blocked')
    assert.equal(summary.environment.authTokenPresent, true)
    assert.match(summary.environment.groupAWebhook, /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?<redacted>; \d+ chars$/)
    assert.ok(summary.missingInputs.some((item) => item.id === 'group-b-webhook-present'))
    assert.ok(summary.missingInputs.some((item) => item.id === 'unauthorized-target-present'))
    assert.ok(summary.missingInputs.some((item) => item.id === 'no-email-external-id-present'))

    const markdown = readFileSync(outputMd, 'utf8')
    assert.match(markdown, /Overall Status: `blocked`/)
    assert.doesNotMatch(markdown, /robot-secret-a|secret-admin-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-input-status passes complete final inputs', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b"',
      'DINGTALK_P4_GROUP_A_SECRET="SECabcdefghijklmnop12345678"',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_PERSON_USER_IDS="user_person_bound"',
      'DINGTALK_P4_AUTHORIZED_USER_ID="user_authorized"',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_unauthorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
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
    assert.equal(summary.nextCommands.some((command) => command.includes('--run-smoke-session')), true)
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /robot-secret|secret-admin-token/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-input-status rejects reused unauthorized target', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b"',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_PERSON_USER_IDS="user_person_bound"',
      'DINGTALK_P4_AUTHORIZED_USER_ID="user_authorized"',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_authorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
      '--allow-blocked',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'blocked')
    const distinct = summary.checks.find((check) => check.id === 'unauthorized-target-distinct')
    assert.equal(distinct.status, 'fail')
    assert.equal(distinct.details.unauthorizedInAllowedUsers, true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-final-input-status exits non-zero when blocked unless allowed', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
    ])

    const result = runScript(['--env-file', envFile])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /blocked/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
