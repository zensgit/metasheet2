import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  chooseLatestWorkflowDispatchRun,
  loadArtifactSummary,
  parseArgs,
} from './dingtalk-alertmanager-closeout.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-alertmanager-closeout.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'dingtalk-alertmanager-closeout-'))
}

function writeJson(dir, name, payload) {
  const filePath = path.join(dir, name)
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  return filePath
}

test('parses closeout runner defaults', () => {
  assert.deepEqual(parseArgs([]), {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    ref: 'main',
    workflow: 'dingtalk-oauth-stability-recording-lite.yml',
    output: null,
    outputDir: '',
    format: 'text',
    secretsJson: null,
    variablesJson: null,
    runId: '',
    trigger: false,
    wait: false,
    timeoutSeconds: 900,
    pollSeconds: 5,
    help: false,
  })
})

test('selects the latest workflow_dispatch run created after trigger start', () => {
  const run = chooseLatestWorkflowDispatchRun([
    {
      databaseId: 1,
      event: 'schedule',
      createdAt: '2026-05-05T01:00:00Z',
    },
    {
      databaseId: 2,
      event: 'workflow_dispatch',
      createdAt: '2026-05-05T01:00:10Z',
    },
    {
      databaseId: 3,
      event: 'workflow_dispatch',
      createdAt: '2026-05-05T01:00:30Z',
    },
  ], '2026-05-05T01:00:15Z')

  assert.equal(run.databaseId, 3)
})

test('loads downloaded DingTalk stability summary without requiring raw logs', () => {
  const dir = makeTmpDir()
  try {
    const artifactDir = path.join(dir, 'artifact')
    mkdirSync(artifactDir, { recursive: true })
    writeJson(artifactDir, 'summary.json', {
      status: 'FAIL',
      healthy: false,
      failureReasons: ['Alertmanager webhook is not configured'],
      nextActions: ['Configure one supported GitHub Actions secret.'],
      selfHeal: { webhookSecretAvailable: false },
      snapshot: {
        checkedAt: '2026-05-05T01:06:33Z',
        host: 'mainuser@142.171.239.56',
        health: { ok: true },
        webhookConfig: { configured: false, host: '' },
        alertmanager: { notifyErrorsLastWindow: 0 },
        storage: { root: { usePercent: 52 } },
      },
    })

    const summary = loadArtifactSummary(dir)
    assert.equal(summary.status, 'FAIL')
    assert.equal(summary.healthy, false)
    assert.deepEqual(summary.failureReasons, ['Alertmanager webhook is not configured'])
    assert.equal(summary.snapshot.webhookConfig.configured, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fixture mode blocks before triggering workflow when webhook secret is missing', () => {
  const dir = makeTmpDir()
  try {
    const secretsJson = writeJson(dir, 'secrets.json', [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
    ])
    const variablesJson = writeJson(dir, 'variables.json', [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'true' },
    ])

    const result = spawnSync('node', [
      scriptPath,
      '--repo',
      'zensgit/metasheet2',
      '--format',
      'json',
      '--secrets-json',
      secretsJson,
      '--variables-json',
      variablesJson,
      '--trigger',
    ], { encoding: 'utf8' })

    assert.equal(result.status, 2, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.status, 'BLOCKED')
    assert.equal(summary.triggered, false)
    assert.equal(summary.readiness.checks.dingtalkWebhookSelfHeal.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes rendered closeout summary to --output', () => {
  const dir = makeTmpDir()
  try {
    const secretsJson = writeJson(dir, 'secrets.json', [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
    ])
    const variablesJson = writeJson(dir, 'variables.json', [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'true' },
    ])
    const outputPath = path.join(dir, 'closeout.md')

    const result = spawnSync('node', [
      scriptPath,
      '--repo',
      'zensgit/metasheet2',
      '--format',
      'markdown',
      '--output',
      outputPath,
      '--secrets-json',
      secretsJson,
      '--variables-json',
      variablesJson,
    ], { encoding: 'utf8' })

    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
    const output = readFileSync(outputPath, 'utf8')
    assert.match(output, /Overall: \*\*BLOCKED\*\*/)
    assert.match(output, /dingtalkWebhookSelfHeal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fixture mode reports READY without side effects when all runtime inputs exist', () => {
  const dir = makeTmpDir()
  try {
    const secretsJson = writeJson(dir, 'secrets.json', [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
      { name: 'ALERTMANAGER_WEBHOOK_URL', value: 'https://hooks.slack.com/services/T/B/secret-value' },
    ])
    const variablesJson = writeJson(dir, 'variables.json', [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'true' },
    ])

    const result = spawnSync('node', [
      scriptPath,
      '--repo',
      'zensgit/metasheet2',
      '--format',
      'json',
      '--secrets-json',
      secretsJson,
      '--variables-json',
      variablesJson,
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.status, 'READY')
    assert.equal(summary.triggered, false)
    assert.doesNotMatch(result.stdout, /secret-value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
