import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { evaluateReadiness } from './github-actions-runtime-readiness.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'github-actions-runtime-readiness.mjs')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'github-actions-runtime-readiness-'))
}

function writeFixture(dir, name, payload) {
  const filePath = path.join(dir, name)
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  return filePath
}

test('readiness passes when K3 variables and DingTalk self-heal secrets are configured', () => {
  const result = evaluateReadiness({
    repo: 'zensgit/metasheet2',
    checkedAt: '2026-05-05T00:00:00.000Z',
    secrets: [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
      { name: 'SLACK_WEBHOOK_URL' },
    ],
    variables: [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'true' },
    ],
  })

  assert.equal(result.status, 'PASS')
  assert.equal(result.checks.dingtalkDeploySecrets.ok, true)
  assert.equal(result.checks.dingtalkWebhookSelfHeal.ok, true)
  assert.equal(result.checks.k3DeployAuthGate.ok, true)
})

test('readiness fails with actionable output when webhook self-heal secret is missing', () => {
  const result = evaluateReadiness({
    repo: 'zensgit/metasheet2',
    checkedAt: '2026-05-05T00:00:00.000Z',
    secrets: [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
    ],
    variables: [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'true' },
    ],
  })

  assert.equal(result.status, 'FAIL')
  assert.equal(result.checks.dingtalkDeploySecrets.ok, true)
  assert.equal(result.checks.dingtalkWebhookSelfHeal.ok, false)
  assert.match(result.nextActions.join('\n'), /Configure one supported webhook secret/)
})

test('readiness fails when the K3 deploy auth gate variable is absent or false', () => {
  const result = evaluateReadiness({
    repo: 'zensgit/metasheet2',
    checkedAt: '2026-05-05T00:00:00.000Z',
    secrets: [
      { name: 'DEPLOY_HOST' },
      { name: 'DEPLOY_USER' },
      { name: 'DEPLOY_SSH_KEY_B64' },
      { name: 'ALERTMANAGER_WEBHOOK_URL' },
    ],
    variables: [
      { name: 'METASHEET_TENANT_ID', value: 'default' },
      { name: 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH', value: 'false' },
    ],
  })

  assert.equal(result.status, 'FAIL')
  assert.equal(result.checks.k3DeployAuthGate.ok, false)
  assert.equal(result.checks.k3DeployAuthGate.requireAuthEnabled, false)
  assert.match(result.nextActions.join('\n'), /K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true/)
})

test('fixture mode does not leak accidental secret values', () => {
  const dir = makeTmpDir()
  try {
    const secretsPath = writeFixture(dir, 'secrets.json', [
      { name: 'DEPLOY_HOST', value: 'host-secret-value' },
      { name: 'DEPLOY_USER', value: 'user-secret-value' },
      { name: 'DEPLOY_SSH_KEY_B64', value: 'ssh-secret-value' },
      { name: 'SLACK_WEBHOOK_URL', value: 'https://hooks.slack.com/services/secret-value' },
    ])
    const variablesPath = writeFixture(dir, 'variables.json', [
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
      secretsPath,
      '--variables-json',
      variablesPath,
      '--strict',
    ], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"status": "PASS"/)
    assert.doesNotMatch(result.stdout, /secret-value/)
    assert.doesNotMatch(result.stdout, /hooks\.slack\.com\/services/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
