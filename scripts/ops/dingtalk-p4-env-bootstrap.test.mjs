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

function runScript(args, env = {}) {
  const nextEnv = { ...process.env, ...env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete nextEnv[key]
  }
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: nextEnv,
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
    assert.equal(summary.checks.find((check) => check.id === 'person-smoke-input').status, 'fail')
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
    assert.equal(summary.checks.find((check) => check.id === 'group-a-webhook-shape').status, 'pass')
    assert.equal(summary.checks.find((check) => check.id === 'group-b-webhook-shape').status, 'pass')
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

test('dingtalk-p4-env-bootstrap requires person smoke input for final P4 readiness', () => {
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

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8'))
    const personCheck = summary.checks.find((check) => check.id === 'person-smoke-input')
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(personCheck.status, 'fail')
    assert.equal(personCheck.details.personUserCount, 0)
    assert.match(personCheck.details.notes, /delivery-history-group-person/)
    assert.equal(summary.nextCommands.some((command) => command.includes('--require-person-user')), true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap rejects duplicate webhooks and reused unauthorized target', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-same&timestamp=1"',
      'DINGTALK_P4_GROUP_B_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=robot-secret-same&timestamp=2"',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_PERSON_USER_IDS="user_person_bound"',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_authorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
    ])

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8'))
    assert.equal(summary.checks.find((check) => check.id === 'group-webhooks-distinct').status, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'unauthorized-target-distinct').status, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap rejects non-canonical DingTalk robot webhook shapes', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    writeEnv(envFile, [
      'DINGTALK_P4_API_BASE="http://142.171.239.56:8900"',
      'DINGTALK_P4_WEB_BASE="http://142.171.239.56:8081"',
      'DINGTALK_P4_AUTH_TOKEN="secret-admin-token"',
      'DINGTALK_P4_GROUP_A_WEBHOOK="http://oapi.dingtalk.com/robot/send?access_token=robot-secret-a"',
      'DINGTALK_P4_GROUP_B_WEBHOOK="https://oapi.dingtalk.com/wrong/path?access_token=robot-secret-b"',
      'DINGTALK_P4_ALLOWED_USER_IDS="user_authorized"',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID="user_unauthorized"',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID="dt_no_email_001"',
    ])

    const result = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])

    assert.equal(result.status, 1)
    const summaryText = readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8')
    assert.doesNotMatch(summaryText, /robot-secret-a/)
    assert.doesNotMatch(summaryText, /robot-secret-b/)
    assert.match(summaryText, /access_token=<redacted>/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'group-a-webhook-shape').status, 'fail')
    assert.equal(summary.checks.find((check) => check.id === 'group-b-webhook-shape').status, 'fail')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap safely updates private env values without leaking secrets', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')
  const outputDir = path.join(tmpDir, 'readiness')

  try {
    const init = runScript(['--init', '--p4-env-file', envFile])
    assert.equal(init.status, 0, init.stderr || init.stdout)

    const update = runScript([
      '--p4-env-file',
      envFile,
      '--set-from-env',
      'DINGTALK_P4_AUTH_TOKEN',
      '--set',
      'DINGTALK_P4_GROUP_A_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-a',
      '--set',
      'DINGTALK_P4_GROUP_B_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=robot-secret-b',
      '--set',
      'DINGTALK_P4_ALLOWED_USER_IDS=user_authorized,user_secondary',
      '--set',
      'DINGTALK_P4_PERSON_USER_IDS=user_person_bound',
      '--set',
      'DINGTALK_P4_UNAUTHORIZED_USER_ID=user_unauthorized',
      '--set',
      'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=dt_no_email_001',
    ], {
      DINGTALK_P4_AUTH_TOKEN: 'secret-admin-token',
    })

    assert.equal(update.status, 0, update.stderr || update.stdout)
    assert.doesNotMatch(update.stdout, /secret-admin-token/)
    assert.doesNotMatch(update.stdout, /robot-secret-a/)
    assert.match(update.stdout, /DINGTALK_P4_AUTH_TOKEN: <redacted>/)
    assert.match(update.stdout, /DINGTALK_P4_ALLOWED_USER_IDS: 2 entries/)
    if (process.platform !== 'win32') {
      assert.equal(statSync(envFile).mode & 0o777, 0o600)
    }

    const envText = readFileSync(envFile, 'utf8')
    assert.match(envText, /DINGTALK_P4_AUTH_TOKEN="secret-admin-token"/)
    assert.match(envText, /access_token=robot-secret-a/)

    const check = runScript(['--check', '--p4-env-file', envFile, '--output-dir', outputDir])
    assert.equal(check.status, 0, check.stderr || check.stdout)
    const summary = JSON.parse(readFileSync(path.join(outputDir, 'readiness-summary.json'), 'utf8'))
    assert.equal(summary.overallStatus, 'pass')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-p4-env-bootstrap rejects unsafe update keys and missing source env values', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'dingtalk-p4.env')

  try {
    const init = runScript(['--init', '--p4-env-file', envFile])
    assert.equal(init.status, 0, init.stderr || init.stdout)

    const unknown = runScript(['--p4-env-file', envFile, '--set', 'UNKNOWN=value'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /only supports known DingTalk P4 env keys/)

    const missing = runScript([
      '--p4-env-file',
      envFile,
      '--set-from-env',
      'DINGTALK_P4_AUTH_TOKEN',
    ], {
      DINGTALK_P4_AUTH_TOKEN: undefined,
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /is not present in the process environment/)
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
