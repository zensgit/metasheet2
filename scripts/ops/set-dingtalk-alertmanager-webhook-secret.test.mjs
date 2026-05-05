import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseArgs,
  validateSecretName,
  validateSlackWebhookUrl,
} from './set-dingtalk-alertmanager-webhook-secret.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'set-dingtalk-alertmanager-webhook-secret.mjs')

test('parses the default GitHub secret target', () => {
  assert.deepEqual(parseArgs([]), {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    name: 'ALERTMANAGER_WEBHOOK_URL',
    fromEnv: '',
    stdin: false,
    dryRun: false,
    help: false,
  })
})

test('accepts only supported DingTalk Alertmanager webhook secret names', () => {
  assert.doesNotThrow(() => validateSecretName('ALERTMANAGER_WEBHOOK_URL'))
  assert.doesNotThrow(() => validateSecretName('SLACK_WEBHOOK_URL'))
  assert.throws(
    () => validateSecretName('ATTENDANCE_ALERT_DINGTALK_WEBHOOK_URL'),
    /Unsupported secret name/,
  )
})

test('validates Slack webhook URL without returning the full URL in metadata', () => {
  const result = validateSlackWebhookUrl('https://hooks.slack.com/services/T000/B000/secret-value\n')

  assert.equal(result.host, 'hooks.slack.com')
  assert.equal(result.pathLength, '/services/T000/B000/secret-value'.length)
  assert.equal(result.value, 'https://hooks.slack.com/services/T000/B000/secret-value')
})

test('rejects non-Slack hosts because stability check requires hooks.slack.com', () => {
  assert.throws(
    () => validateSlackWebhookUrl('https://example.com/webhook'),
    /hooks\.slack\.com/,
  )
})

test('dry-run mode does not print the secret path', () => {
  const result = spawnSync('node', [
    scriptPath,
    '--stdin',
    '--dry-run',
    '--repo',
    'zensgit/metasheet2',
  ], {
    input: 'https://hooks.slack.com/services/T000/B000/secret-value\n',
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /validated ALERTMANAGER_WEBHOOK_URL/)
  assert.match(result.stdout, /host=hooks\.slack\.com/)
  assert.doesNotMatch(result.stdout, /secret-value/)
  assert.doesNotMatch(result.stderr, /secret-value/)
})
