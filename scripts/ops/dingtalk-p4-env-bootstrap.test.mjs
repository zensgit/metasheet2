import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-p4-env-bootstrap.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-p4-env-bootstrap-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
}

function writeEnv(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

test('dingtalk-p4-env-bootstrap creates a private env template and refuses accidental overwrite', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')

  try {
    const result = runScript(['--init', '--p4-env-file', envFile])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(envFile), true)
    const mode = statSync(envFile).mode & 0o777
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600)
    }

    const content = readFileSync(envFile, 'utf8')
    assert.match(content, /DINGTALK_P4_AUTH_TOKEN=""/)
    assert.match(content, /DINGTALK_P4_GROUP_A_WEBHOOK=""/)
    assert.match(content, /DINGTALK_P4_UNAUTHORIZED_USER_ID=""/)
    assert.doesNotMatch(content, /secret-admin-token/)

    const overwrite = runScript(['--init', '--p4-env-file', envFile])
    assert.equal(overwrite.status, 1)
    assert.match(overwrite.stderr, /already exists/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap reports missing readiness fields without leaking secrets', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a&timestamp=1690000000000&sign=robot-sign-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK=""',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
    ])

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout, /secret-admin-token/)
    assert.doesNotMatch(result.stderr, /secret-admin-token/)
    const summaryText = readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /secret-admin-token/)
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.doesNotMatch(summaryText, /robot-sign-a/)
    assert.doesNotMatch(summaryText, /1690000000000/)
    assert.match(summaryText, /access_token=<redacted>/)
    assert.match(summaryText, /timestamp=<redacted>/)
    assert.match(summaryText, /sign=<redacted>/)

    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'dingtalk_p4_group_b_webhook').status, 'fail')
    assert.deepEqual(summary.checks.find((check) => check.id === 'manual-targets-declared').details.missing, [
      'unauthorized user',
      'no-email DingTalk external id',
    ])
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap passes with complete env and derives authorized target from allowlist', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

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
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_unauthorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
    ])

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summaryText = readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8')
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'pass')
    assert.equal(summary.environment.authTokenPresent, true)
    assert.equal(summary.environment.groupASecretPresent, true)
    assert.deepEqual(summary.environment.manualTargets, {
      authorizedUserId: 'user_authorized',
      unauthorizedUserId: 'user_unauthorized',
      noEmailDingTalkExternalId: 'dt_no_email_001',
    })
    assert.equal(summary.nextCommands.some((command) => command.includes('--require-manual-targets')), true)
    assert.doesNotMatch(readFileSync(path.join(outputDir, 'readiness-summary.md'), 'utf8'), /robot-secret/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap rejects loose private env file permissions', () => {
  if (process.platform === 'win32') return

  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b"',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_unauthorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
    ])
    chmodSync(envFile, 0o644)

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8'))
    assert.equal(summary.checks.find((check) => check.id === 'env-file-private-mode').status, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
