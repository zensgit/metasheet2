import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'dingtalk-oauth-stability-recording-lite.yml')

function assertContains(haystack, needle, label) {
  assert.ok(
    String(haystack).includes(needle),
    `${label} must include ${needle}`,
  )
}

test('DingTalk OAuth stability workflow reapplies Alertmanager webhook before checking health', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assertContains(raw, 'name: DingTalk OAuth Stability Recording (Lite)', 'workflow')
  assertContains(raw, 'cron:', 'workflow schedule')
  assertContains(raw, '- name: Prepare SSH key', 'ssh setup')
  assertContains(raw, '- name: Reapply Alertmanager webhook config', 'webhook self-heal step')
  assertContains(raw, 'id: webhook_self_heal', 'webhook self-heal step')
  assertContains(
    raw,
    'ALERTMANAGER_WEBHOOK_URL: ${{ secrets.ALERTMANAGER_WEBHOOK_URL || secrets.ALERT_WEBHOOK_URL || secrets.SLACK_WEBHOOK_URL || secrets.ATTENDANCE_ALERT_SLACK_WEBHOOK_URL }}',
    'webhook self-heal step',
  )
  assertContains(raw, 'DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}', 'webhook self-heal step')
  assertContains(raw, 'DEPLOY_USER: ${{ secrets.DEPLOY_USER }}', 'webhook self-heal step')
  assertContains(raw, 'echo "webhook_secret_available=false" >> "$GITHUB_OUTPUT"', 'webhook self-heal output')
  assertContains(raw, 'echo "webhook_secret_available=true" >> "$GITHUB_OUTPUT"', 'webhook self-heal output')
  assertContains(raw, 'No Alertmanager webhook secret is set; checked ALERTMANAGER_WEBHOOK_URL, ALERT_WEBHOOK_URL, SLACK_WEBHOOK_URL, and ATTENDANCE_ALERT_SLACK_WEBHOOK_URL. Alertmanager webhook self-heal skipped.', 'webhook self-heal skip notice')
  assertContains(raw, 'SSH_USER_HOST="${DEPLOY_USER}@${DEPLOY_HOST}"', 'webhook self-heal remote target')
  assertContains(raw, 'SSH_KEY="${HOME}/.ssh/deploy_key"', 'webhook self-heal remote key')
  assertContains(raw, 'scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh set', 'webhook self-heal command')
  assertContains(raw, '- name: Run remote stability check', 'stability check step')
  assert.ok(
    raw.indexOf('- name: Reapply Alertmanager webhook config') < raw.indexOf('- name: Run remote stability check'),
    'webhook self-heal must run before remote stability check',
  )
  assertContains(raw, '- name: Fail if stability check is unhealthy', 'final hard gate')
  assertContains(raw, "WEBHOOK_SECRET_AVAILABLE: ${{ steps.webhook_self_heal.outputs.webhook_secret_available || 'false' }}", 'summary env')
  assertContains(raw, 'stability check completed but reported healthy=false', 'final hard gate')
})
