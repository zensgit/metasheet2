import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'dingtalk-oauth-stability-recording-lite.yml')
const checkScriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-check.sh')
const webhookScriptPath = path.join(repoRoot, 'scripts', 'ops', 'set-dingtalk-onprem-alertmanager-webhook-config.sh')

function assertContains(haystack, needle, label) {
  assert.ok(
    String(haystack).includes(needle),
    `${label} must include ${needle}`,
  )
}

function assertPinnedHostIdentity(raw, label = 'workflow') {
  // Workflow prepares a pinned known_hosts from DEPLOY_KNOWN_HOSTS and hands
  // SSH_KNOWN_HOSTS_FILE to the scripts; StrictHostKeyChecking=yes lives in the
  // called scripts (assertHardenedSshScript), not as an inline ssh_opts string.
  assert.match(raw, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/, `${label} must wire DEPLOY_KNOWN_HOSTS`)
  assert.match(raw, /DEPLOY_KNOWN_HOSTS is required/, `${label} must require DEPLOY_KNOWN_HOSTS`)
  assert.match(raw, /decoded_known_hosts=.*base64 -d/, `${label} must accept base64 known_hosts`)
  assert.match(raw, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/, `${label} must validate recognizable key types`)
  assert.match(raw, /did not resolve to a recognizable key/, `${label} must fail closed on unrecognizable keys`)
  assert.match(raw, /SSH_KNOWN_HOSTS_FILE=/, `${label} must pass SSH_KNOWN_HOSTS_FILE into scripts`)
  assert.match(raw, /known_hosts/, `${label} must materialize known_hosts`)
  assert.doesNotMatch(raw, /StrictHostKeyChecking=no/, `${label} must not use StrictHostKeyChecking=no`)
}

function assertHardenedSshScript(raw, label) {
  assert.match(raw, /StrictHostKeyChecking=yes/, `${label} must set StrictHostKeyChecking=yes`)
  assert.match(raw, /UserKnownHostsFile=/, `${label} must set UserKnownHostsFile`)
  assert.match(raw, /GlobalKnownHostsFile=\/dev\/null/, `${label} must set GlobalKnownHostsFile=/dev/null`)
  assert.match(raw, /BatchMode=yes/, `${label} must set BatchMode=yes`)
  assert.match(raw, /IdentitiesOnly=yes/, `${label} must set IdentitiesOnly=yes`)
  assert.doesNotMatch(raw, /StrictHostKeyChecking=no/, `${label} must not use StrictHostKeyChecking=no`)
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

test('DingTalk OAuth stability workflow pins deploy-host identity (DEPLOY_KNOWN_HOSTS)', () => {
  assertPinnedHostIdentity(readFileSync(workflowPath, 'utf8'))
})

test('OAuth stability production SSH scripts refuse StrictHostKeyChecking=no', () => {
  assertHardenedSshScript(readFileSync(checkScriptPath, 'utf8'), 'dingtalk-oauth-stability-check.sh')
  assertHardenedSshScript(
    readFileSync(webhookScriptPath, 'utf8'),
    'set-dingtalk-onprem-alertmanager-webhook-config.sh',
  )
})

test('host-identity contract is load-bearing (mutation would fail)', () => {
  const raw = readFileSync(workflowPath, 'utf8')
  assert.throws(
    () => assertPinnedHostIdentity(raw.replace(/SSH_KNOWN_HOSTS_FILE=/g, 'SSH_HOSTS_FILE=')),
    /must pass SSH_KNOWN_HOSTS_FILE|did not match/,
  )
  assert.throws(
    () => assertPinnedHostIdentity(raw.replace('DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}', '')),
    /must wire DEPLOY_KNOWN_HOSTS|did not match/,
  )
  assert.throws(
    () => assertPinnedHostIdentity(`${raw}\n-o StrictHostKeyChecking=no\n`),
    /must not use StrictHostKeyChecking=no|input was expected not to match|did not match/,
  )
  const check = readFileSync(checkScriptPath, 'utf8')
  assert.throws(
    () => assertHardenedSshScript(check.replace(/StrictHostKeyChecking=yes/g, 'StrictHostKeyChecking=no'), 'mutated'),
    /must set StrictHostKeyChecking=yes|must not use StrictHostKeyChecking=no|input was expected not to match|did not match/,
  )
})
