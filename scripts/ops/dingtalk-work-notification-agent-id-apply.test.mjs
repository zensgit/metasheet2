import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-work-notification-agent-id-apply.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-work-notification-agent-id-apply-'))
}

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('applies a missing DingTalk agent id without printing the value', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const agentIdFile = path.join(tmpDir, 'agent-id.txt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(envFile, 'DINGTALK_CLIENT_ID=client-id\nDINGTALK_CLIENT_SECRET=client-secret\n', 'utf8')
    writeFileSync(agentIdFile, '123456789\n', 'utf8')

    const result = runScript([
      '--env-file', envFile,
      '--agent-id-file', agentIdFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /123456789|client-secret/)
    assert.match(readFileSync(envFile, 'utf8'), /DINGTALK_AGENT_ID=123456789/)

    const summaryText = readFileSync(outputJson, 'utf8')
    assert.doesNotMatch(summaryText, /123456789|client-secret/)
    const summary = JSON.parse(summaryText)
    assert.equal(summary.status, 'pass')
    assert.equal(summary.action, 'updated')
    assert.equal(summary.agentId.length, 9)
    assert.equal(summary.targetKey, 'DINGTALK_AGENT_ID')
    assert.equal(summary.backupFile.endsWith('app.env.backup-before-dingtalk-agent-id-'), false)
    assert.match(summary.backupFile, /app\.env\.backup-before-dingtalk-agent-id-/)
    assert.equal(existsSync(path.join(repoRoot, summary.backupFile)), true)
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /123456789|client-secret/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
test('dry-run validates but does not change the env file', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const agentIdFile = path.join(tmpDir, 'agent-id.txt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(envFile, 'DINGTALK_CLIENT_ID=client-id\n', 'utf8')
    writeFileSync(agentIdFile, '987654321\n', 'utf8')

    const result = runScript([
      '--env-file', envFile,
      '--agent-id-file', agentIdFile,
      '--dry-run',
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(readFileSync(envFile, 'utf8'), 'DINGTALK_CLIENT_ID=client-id\n')
    const summary = readJson(outputJson)
    assert.equal(summary.action, 'would_update')
    assert.equal(summary.backupFile, '')
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /987654321/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('reuses an existing legacy alias as the target key', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const agentIdFile = path.join(tmpDir, 'agent-id.txt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(envFile, 'DINGTALK_NOTIFY_AGENT_ID=111222333\n', 'utf8')
    writeFileSync(agentIdFile, '111222333\n', 'utf8')

    const result = runScript([
      '--env-file', envFile,
      '--agent-id-file', agentIdFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const summary = readJson(outputJson)
    assert.equal(summary.action, 'unchanged')
    assert.equal(summary.targetKey, 'DINGTALK_NOTIFY_AGENT_ID')
    assert.equal(readFileSync(envFile, 'utf8'), 'DINGTALK_NOTIFY_AGENT_ID=111222333\n')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('blocks replacing an existing different agent id unless forced', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const agentIdFile = path.join(tmpDir, 'agent-id.txt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(envFile, 'DINGTALK_AGENT_ID=111222333\n', 'utf8')
    writeFileSync(agentIdFile, '444555666\n', 'utf8')

    const result = runScript([
      '--env-file', envFile,
      '--agent-id-file', agentIdFile,
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 1)
    assert.equal(readFileSync(envFile, 'utf8'), 'DINGTALK_AGENT_ID=111222333\n')
    const summary = readJson(outputJson)
    assert.equal(summary.status, 'blocked')
    assert.equal(summary.checks.find((check) => check.id === 'existing-agent-id-conflict')?.status, 'fail')
    assert.doesNotMatch(readFileSync(outputMd, 'utf8'), /111222333|444555666/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('force replaces an existing different agent id after creating a backup', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const agentIdFile = path.join(tmpDir, 'agent-id.txt')
  const outputJson = path.join(tmpDir, 'summary.json')
  const outputMd = path.join(tmpDir, 'summary.md')
  try {
    writeFileSync(envFile, 'DINGTALK_AGENT_ID=111222333\n', 'utf8')
    writeFileSync(agentIdFile, '444555666\n', 'utf8')

    const result = runScript([
      '--env-file', envFile,
      '--agent-id-file', agentIdFile,
      '--force',
      '--output-json', outputJson,
      '--output-md', outputMd,
    ])

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(readFileSync(envFile, 'utf8'), 'DINGTALK_AGENT_ID=444555666\n')
    const summary = readJson(outputJson)
    assert.equal(summary.action, 'updated')
    assert.equal(existsSync(path.join(repoRoot, summary.backupFile)), true)
    assert.doesNotMatch(readFileSync(outputJson, 'utf8'), /111222333|444555666/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('rejects empty and non-numeric agent id files', () => {
  const tmpDir = makeTmpDir()
  const envFile = path.join(tmpDir, 'app.env')
  const emptyFile = path.join(tmpDir, 'empty.txt')
  const invalidFile = path.join(tmpDir, 'invalid.txt')
  try {
    writeFileSync(envFile, '', 'utf8')
    writeFileSync(emptyFile, '\n', 'utf8')
    writeFileSync(invalidFile, 'agent-id=abc\n', 'utf8')

    const empty = runScript(['--env-file', envFile, '--agent-id-file', emptyFile])
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /empty/)

    const invalid = runScript(['--env-file', envFile, '--agent-id-file', invalidFile])
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /numeric/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
