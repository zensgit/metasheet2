import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-work-notification-env-status.mjs')
const envKeys = [
  'DINGTALK_APP_KEY',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_APP_SECRET',
  'DINGTALK_CLIENT_SECRET',
  'DINGTALK_AGENT_ID',
  'DINGTALK_NOTIFY_AGENT_ID',
]

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-work-notification-env-status-'))
}

function runScript(args, env = {}) {
  const baseEnv = { ...process.env }
  for (const key of envKeys) delete baseEnv[key]
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

test('dingtalk-work-notification-env-status reports blocked missing inputs without leaking values', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY="unit-app-key"',
      'DINGTALK_APP_SECRET="unit-app-credential"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
      '--allow-blocked',
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /unit-app-key|unit-app-credential/)
    assert.equal(existsSync(outputJson), true)
    assert.equal(existsSync(outputMd), true)

    const summaryText = readFileSync(outputJson, 'utf8')
    assert.doesNotMatch(summaryText, /unit-app-key|unit-app-credential/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.overallStatus, 'blocked')
    assert.equal(summary.requirements['app-key'].present, true)
    assert.equal(summary.requirements['app-secret'].present, true)
    assert.equal(summary.requirements['agent-id'].present, false)
    assert.deepEqual(summary.missingInputs.map((item) => item.id), ['agent-id-present'])

    const markdown = readFileSync(outputMd, 'utf8')
    assert.match(markdown, /Overall Status: `blocked`/)
    assert.match(markdown, /DINGTALK_AGENT_ID/)
    assert.doesNotMatch(markdown, /unit-app-key|unit-app-credential/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status exits non-zero for blocked inputs by default', () => {
  const tmpDir = makeTmpDir()
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    const result = runScript(['--output-json', outputJson, '--output-md', outputMd])

    assert.equal(result.status, 1)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'blocked')
    assert.equal(summary.missingInputs.length, 3)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status passes complete primary envs', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY="unit-app-key"',
      'DINGTALK_APP_SECRET="unit-app-credential"',
      'DINGTALK_AGENT_ID="123456789"',
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
    assert.equal(summary.requirements['app-key'].selectedKey, 'DINGTALK_APP_KEY')
    assert.equal(summary.requirements['agent-id'].selectedKey, 'DINGTALK_AGENT_ID')
    assert.match(summary.nextCommands.join('\n'), /expect-person-status success/)
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /unit-app-key|unit-app-credential/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status accepts legacy aliases', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_CLIENT_ID="unit-client-id"',
      'DINGTALK_CLIENT_SECRET="unit-client-credential"',
      'DINGTALK_NOTIFY_AGENT_ID="987654321"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.equal(summary.requirements['app-key'].selectedKey, 'DINGTALK_CLIENT_ID')
    assert.equal(summary.requirements['app-secret'].selectedKey, 'DINGTALK_CLIENT_SECRET')
    assert.equal(summary.requirements['agent-id'].selectedKey, 'DINGTALK_NOTIFY_AGENT_ID')
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /unit-client-id|unit-client-credential/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status lets process env override env files', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeEnv(envFile, [
      'DINGTALK_APP_KEY="file-key"',
      'DINGTALK_APP_SECRET="file-secret"',
      'DINGTALK_AGENT_ID="file-agent"',
    ])

    const result = runScript([
      '--env-file', envFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ], {
      DINGTALK_CLIENT_ID: 'process-client-id',
      DINGTALK_CLIENT_SECRET: 'process-client-secret',
      DINGTALK_NOTIFY_AGENT_ID: 'process-agent',
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.overallStatus, 'ready')
    assert.equal(summary.requirements['app-key'].selectedKey, 'DINGTALK_APP_KEY')
    assert.equal(summary.requirements['app-key'].aliasCount, 2)
    assert.equal(summary.requirements['agent-id'].aliasCount, 2)
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /process-client|process-agent|file-key|file-secret|file-agent/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status writes a safe env template', () => {
  const tmpDir = makeTmpDir()
  const template = path.join(tmpDir, 'work-notification.env')
  try {
    const result = runScript(['--write-env-template', template])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(existsSync(template), true)
    const text = readFileSync(template, 'utf8')
    assert.match(text, /DINGTALK_APP_KEY=""/)
    assert.match(text, /DINGTALK_APP_SECRET=""/)
    assert.match(text, /DINGTALK_AGENT_ID=""/)
    assert.doesNotMatch(text, /access_token=|SEC[A-Za-z0-9+/=_-]{8,}|eyJ[A-Za-z0-9._-]{20,}|dt-app-secret/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dingtalk-work-notification-env-status refuses to overwrite templates unless forced', () => {
  const tmpDir = makeTmpDir()
  const template = path.join(tmpDir, 'work-notification.env')
  try {
    writeFileSync(template, 'EXISTING=1\n', 'utf8')

    const blocked = runScript(['--write-env-template', template])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /already exists/)
    assert.equal(readFileSync(template, 'utf8'), 'EXISTING=1\n')

    const forced = runScript(['--write-env-template', template, '--force'])
    assert.equal(forced.status, 0, forced.stderr || forced.stdout)
    assert.match(readFileSync(template, 'utf8'), /DINGTALK_APP_KEY/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
