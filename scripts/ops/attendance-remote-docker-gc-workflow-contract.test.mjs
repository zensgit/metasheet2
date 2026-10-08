import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'attendance-remote-docker-gc-prod.yml')
const storageWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'attendance-remote-storage-prod.yml')
const pluginTestsWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'plugin-tests.yml')

function assertPinnedHostIdentity(raw) {
  assert.match(raw, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(raw, /DEPLOY_KNOWN_HOSTS is required/)
  assert.match(raw, /decoded_known_hosts=.*base64 -d/)
  assert.match(raw, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/)
  assert.match(raw, /did not resolve to a recognizable key/)
  assert.match(raw, /StrictHostKeyChecking=yes/)
  assert.match(raw, /UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts/)
  assert.match(raw, /GlobalKnownHostsFile=\/dev\/null/)
  assert.doesNotMatch(raw, /StrictHostKeyChecking=no/)
}

test('remote Docker GC summary caps snippets without pipefail-sensitive head pipeline', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.ok(raw.includes('name: Attendance Remote Docker GC (Prod)'))
  assert.ok(raw.includes('set -euo pipefail'))
  assert.ok(raw.includes('^=== DOCKER GC START ===$'))
  assert.ok(raw.includes('printing && count < 120 { print; count++ }'))
  assert.ok(!raw.includes("' \"$gc_log\" | head -n 120"))
})

test('production Docker GC and storage health pin the deploy-host identity', () => {
  for (const target of [workflowPath, storageWorkflowPath]) {
    assertPinnedHostIdentity(readFileSync(target, 'utf8'))
  }
})

test('host identity contract is load-bearing for both production workflows', () => {
  for (const target of [workflowPath, storageWorkflowPath]) {
    const raw = readFileSync(target, 'utf8')
    assert.throws(
      () => assertPinnedHostIdentity(raw.replace('StrictHostKeyChecking=yes', 'StrictHostKeyChecking=no')),
      /input was expected not to match|did not match/,
    )
    assert.throws(
      () => assertPinnedHostIdentity(raw.replace('DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}', '')),
      /did not match/,
    )
  }
})

test('host identity contract runs in the required Node 20 test context', () => {
  const raw = readFileSync(pluginTestsWorkflowPath, 'utf8')
  const requiredJobStart = raw.indexOf('\n  test:\n')
  const requiredJobEnd = raw.indexOf('\n  after-sales-integration:\n')
  assert.ok(requiredJobStart >= 0 && requiredJobEnd > requiredJobStart)
  const requiredJob = raw.slice(requiredJobStart, requiredJobEnd)
  const requiredStepStart = requiredJob.indexOf(
    '      - name: Production maintenance SSH host-identity contract (required lane)',
  )
  const requiredStepEnd = requiredJob.indexOf('\n      - name:', requiredStepStart + 1)
  assert.ok(requiredStepStart >= 0 && requiredStepEnd > requiredStepStart)
  const requiredStep = requiredJob.slice(requiredStepStart, requiredStepEnd)

  assert.match(
    requiredStep,
    /- name: Production maintenance SSH host-identity contract \(required lane\)\n        id: production-maintenance-ssh-host-identity-contract\n        if: matrix\.node-version == '20\.x'\n        run: node --test scripts\/ops\/attendance-remote-docker-gc-workflow-contract\.test\.mjs/,
  )
  assert.doesNotMatch(requiredStep, /continue-on-error:/)
})
