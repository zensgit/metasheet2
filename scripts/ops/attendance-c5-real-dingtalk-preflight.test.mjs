import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'attendance-c5-real-dingtalk-preflight.mjs')
const envKeys = [
  'DATABASE_URL',
  'DINGTALK_APP_KEY',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_APP_SECRET',
  'DINGTALK_CLIENT_SECRET',
  'DINGTALK_AGENT_ID',
  'DINGTALK_NOTIFY_AGENT_ID',
  'DINGTALK_SMOKE_CONFIG_INTEGRATION_ID',
  'DINGTALK_SMOKE_EXTERNAL_USER_ID',
  'DINGTALK_SMOKE_SUBJECT_USER_ID',
  'DINGTALK_SMOKE_OWNER_USER_ID',
  'DINGTALK_SMOKE_SUB_OWNER_USER_ID',
  'SMOKE_TOKEN',
  'TOKEN',
  'DEPLOY_HOST',
  'DEPLOY_USER',
  'DEPLOY_SSH_KEY_B64',
  'ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES',
]
const requiredTables = [
  'attendance_notification_deliveries',
  'attendance_unscheduled_reminder_dispatch',
  'attendance_leave_balances',
  'attendance_group_managers',
  'directory_integrations',
  'directory_accounts',
  'directory_account_links',
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'attendance-c5-real-dingtalk-preflight-'))
}

function baseFacts(overrides = {}) {
  return {
    tables: Object.fromEntries(requiredTables.map((table) => [table, true])),
    activeDingTalkIntegrations: [],
    directoryAccountCount: 0,
    directoryLinkCount: 0,
    dueDeliveryRows: 0,
    ...overrides,
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function runPreflight(args, env = {}) {
  const baseEnv = { ...process.env }
  for (const key of envKeys) delete baseEnv[key]
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function runWithMock(tmpDir, facts, options = {}) {
  const mockDb = path.join(tmpDir, 'db.json')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  writeJson(mockDb, facts)
  const result = runPreflight([
    '--mock-db-json', mockDb,
    '--output-json', outputJson,
    '--output-md', outputMd,
    ...(options.args ?? []),
  ], options.env ?? {})
  return { result, outputJson, outputMd }
}

test('attendance C5 real DingTalk preflight blocks missing real-mode prerequisites without leaking secrets', () => {
  const tmpDir = makeTmpDir()
  try {
    const { result, outputJson, outputMd } = runWithMock(tmpDir, baseFacts(), {
      args: ['--allow-blocked'],
      env: {
        DINGTALK_APP_KEY: 'unit-app-key-secret',
        DINGTALK_APP_SECRET: 'unit-app-secret-value',
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(outputJson), true)
    assert.equal(existsSync(outputMd), true)
    assert.doesNotMatch(result.stdout, /unit-app-key-secret|unit-app-secret-value/)

    const jsonText = readFileSync(outputJson, 'utf8')
    const markdown = readFileSync(outputMd, 'utf8')
    assert.doesNotMatch(jsonText, /unit-app-key-secret|unit-app-secret-value/)
    assert.doesNotMatch(markdown, /unit-app-key-secret|unit-app-secret-value/)

    const summary = JSON.parse(jsonText)
    assert.equal(summary.overallStatus, 'blocked')
    assert.deepEqual(summary.missingCheckIds.sort(), ['auth-token', 'dingtalk-config', 'recipient'].sort())
    assert.equal(summary.checks.find((check) => check.id === 'tables').status, 'pass')
    assert.equal(summary.checks.find((check) => check.id === 'dingtalk-config').details.envKeys.appKey, 'DINGTALK_APP_KEY')
    assert.equal(summary.checks.find((check) => check.id === 'dingtalk-config').details.envKeys.appSecret, 'DINGTALK_APP_SECRET')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('attendance C5 real DingTalk preflight passes with complete env config, recipient, and token', () => {
  const tmpDir = makeTmpDir()
  try {
    const { result, outputJson } = runWithMock(tmpDir, baseFacts(), {
      env: {
        DINGTALK_CLIENT_ID: 'unit-client-id',
        DINGTALK_CLIENT_SECRET: 'unit-client-secret',
        DINGTALK_NOTIFY_AGENT_ID: '123456',
        DINGTALK_SMOKE_EXTERNAL_USER_ID: 'dingtalk-user-001',
        SMOKE_TOKEN: 'header.payload.signature',
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.deepEqual(summary.missingCheckIds, [])
    assert.equal(summary.selectedConfigSource, 'env')
    assert.equal(summary.checks.find((check) => check.id === 'dingtalk-config').details.envKeys.appKey, 'DINGTALK_CLIENT_ID')
    assert.equal(summary.checks.find((check) => check.id === 'recipient').status, 'pass')
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /unit-client-secret|header\.payload\.signature/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('attendance C5 real DingTalk preflight blocks missing C5 tables', () => {
  const tmpDir = makeTmpDir()
  try {
    const tables = Object.fromEntries(requiredTables.map((table) => [table, true]))
    tables.attendance_notification_deliveries = false
    const { result, outputJson } = runWithMock(tmpDir, baseFacts({ tables }), {
      args: ['--allow-blocked'],
      env: {
        DINGTALK_APP_KEY: 'unit-app-key',
        DINGTALK_APP_SECRET: 'unit-app-secret',
        DINGTALK_AGENT_ID: '123456',
        DINGTALK_SMOKE_EXTERNAL_USER_ID: 'dingtalk-user-001',
        SMOKE_TOKEN: 'header.payload.signature',
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'blocked')
    assert.deepEqual(summary.missingCheckIds, ['tables'])
    assert.match(summary.checks.find((check) => check.id === 'tables').message, /attendance_notification_deliveries/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('attendance C5 real DingTalk preflight asks for an explicit stored integration id before using stored config', () => {
  const tmpDir = makeTmpDir()
  try {
    const { result, outputJson } = runWithMock(tmpDir, baseFacts({
      activeDingTalkIntegrations: [
        {
          id: 'integration-ready',
          name: 'Staging DingTalk',
          status: 'active',
          config: {
            appKey: 'stored-app-key-secret',
            appSecret: 'stored-app-secret-value',
            workNotificationAgentId: '999001',
          },
        },
      ],
    }), {
      args: ['--allow-blocked'],
      env: {
        DINGTALK_SMOKE_EXTERNAL_USER_ID: 'dingtalk-user-001',
        SMOKE_TOKEN: 'header.payload.signature',
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    const configCheck = summary.checks.find((check) => check.id === 'dingtalk-config')
    assert.equal(summary.overallStatus, 'blocked')
    assert.deepEqual(summary.missingCheckIds, ['dingtalk-config'])
    assert.match(configCheck.message, /set DINGTALK_SMOKE_CONFIG_INTEGRATION_ID/)
    assert.deepEqual(configCheck.details.configuredIntegrationIds, ['integration-ready'])
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /stored-app-key-secret|stored-app-secret-value/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('attendance C5 real DingTalk preflight passes with requested complete stored integration config', () => {
  const tmpDir = makeTmpDir()
  try {
    const { result, outputJson } = runWithMock(tmpDir, baseFacts({
      activeDingTalkIntegrations: [
        {
          id: 'integration-ready',
          name: 'Staging DingTalk',
          status: 'active',
          config: JSON.stringify({
            appKey: 'stored-app-key-secret',
            appSecret: 'stored-app-secret-value',
            agentId: '999001',
          }),
        },
      ],
    }), {
      env: {
        DINGTALK_SMOKE_CONFIG_INTEGRATION_ID: 'integration-ready',
        DINGTALK_SMOKE_SUBJECT_USER_ID: 'subject-ext-id',
        DINGTALK_SMOKE_OWNER_USER_ID: 'owner-ext-id',
        DINGTALK_SMOKE_SUB_OWNER_USER_ID: 'sub-owner-ext-id',
        DEPLOY_HOST: '23.254.236.11',
        DEPLOY_USER: 'mainuser',
        DEPLOY_SSH_KEY_B64: Buffer.from('unit-key').toString('base64'),
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.equal(summary.selectedConfigSource, 'DINGTALK_SMOKE_CONFIG_INTEGRATION_ID')
    assert.equal(summary.checks.find((check) => check.id === 'auth-token').details.hasDeployHostFallback, true)
    assert.equal(summary.checks.find((check) => check.id === 'recipient').details.sharedRecipient, false)
    assert.deepEqual(summary.checks.find((check) => check.id === 'recipient').details.roleRecipients, [true, true, true])
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /stored-app-key-secret|stored-app-secret-value|unit-key/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('attendance C5 real DingTalk preflight blocks due delivery rows unless explicitly overridden', () => {
  const tmpDir = makeTmpDir()
  const env = {
    DINGTALK_APP_KEY: 'unit-key',
    DINGTALK_APP_SECRET: 'unit-secret',
    DINGTALK_AGENT_ID: '999001',
    DINGTALK_SMOKE_EXTERNAL_USER_ID: 'dingtalk-user-001',
    SMOKE_TOKEN: 'header.payload.signature',
  }
  try {
    const blocked = runWithMock(tmpDir, baseFacts({ dueDeliveryRows: 2 }), {
      args: ['--allow-blocked'],
      env,
    })
    assert.equal(blocked.result.status, 0, blocked.result.stderr || blocked.result.stdout)
    const blockedSummary = readJson(blocked.outputJson)
    assert.equal(blockedSummary.overallStatus, 'blocked')
    assert.deepEqual(blockedSummary.missingCheckIds, ['due-deliveries'])
    assert.equal(blockedSummary.checks.find((check) => check.id === 'due-deliveries').details.allowOverride, false)

    const overridden = runWithMock(tmpDir, baseFacts({ dueDeliveryRows: 2 }), {
      env: {
        ...env,
        ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES: '1',
      },
    })
    assert.equal(overridden.result.status, 0, overridden.result.stderr || overridden.result.stdout)
    const overriddenSummary = readJson(overridden.outputJson)
    assert.equal(overriddenSummary.overallStatus, 'ready')
    assert.equal(overriddenSummary.checks.find((check) => check.id === 'due-deliveries').details.allowOverride, true)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
