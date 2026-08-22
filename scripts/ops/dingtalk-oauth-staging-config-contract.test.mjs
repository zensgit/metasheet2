import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/dingtalk-oauth-staging-config.yml', import.meta.url), 'utf8')
const remote = readFileSync(new URL('./dingtalk-oauth-staging-config-remote.sh', import.meta.url), 'utf8')
const contractWorkflow = readFileSync(new URL('../../.github/workflows/dingtalk-oauth-staging-config-contract.yml', import.meta.url), 'utf8')

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`)
  assert.notEqual(start, -1, `shell function missing: ${name}`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `shell function end missing: ${name}`)
  return source.slice(start, end + 3)
}

function runDigestIdentity({ identity, override, digest, functionName = 'resolve_image_pin' }) {
  const functions = [
    extractShellFunction(remote, 'read_attendance_deploy_identity_field'),
    extractShellFunction(remote, 'resolve_live_backend_image_pin'),
    extractShellFunction(remote, 'resolve_image_pin'),
    extractShellFunction(remote, 'deployed_sha'),
  ].join('\n')
  return spawnSync('bash', ['-o', 'pipefail', '-c', `set -euo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 1; }
health_commit() { printf stale-health-metadata; }
${functions}
ATTENDANCE_DEPLOY_IDENTITY_FILE="$IDENTITY_FILE"
ATTENDANCE_OVERRIDE_FILE="$OVERRIDE_FILE"
BACKEND_CONTAINER=metasheet-staging-backend
docker() { printf '%s' "$LIVE_DIGEST"; }
${functionName}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IDENTITY_FILE: identity,
      OVERRIDE_FILE: override,
      LIVE_DIGEST: digest,
    },
  })
}

test('workflow is manual, staging-serialized, pinned-SSH, and fail-honest', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /group: attendance-staging-window-runner/)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /StrictHostKeyChecking=yes/)
  assert.match(workflow, /UserKnownHostsFile=/)
  assert.match(workflow, /GlobalKnownHostsFile=\/dev\/null/)
  assert.match(workflow, /continue-on-error: true/)
  assert.match(workflow, /Fail on remote error/)
})

test('contract has a path-scoped pull-request workflow on Node 20', () => {
  assert.match(contractWorkflow, /pull_request:/)
  assert.match(contractWorkflow, /node-version: '20'/)
  assert.match(contractWorkflow, /node --test scripts\/ops\/dingtalk-oauth-staging-config-contract\.test\.mjs/)
  for (const file of [
    '.github/workflows/dingtalk-oauth-staging-config.yml',
    '.github/workflows/dingtalk-oauth-staging-config-contract.yml',
    'scripts/ops/dingtalk-oauth-staging-config-contract.test.mjs',
    'scripts/ops/dingtalk-oauth-staging-config-remote.sh',
  ]) {
    assert.match(contractWorkflow, new RegExp(file.replaceAll('.', '\\.')))
  }
})

test('prepare requires exact head, explicit OFF posture, and exact confirmation', () => {
  assert.match(remote, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(remote, /EXPECTED_CURRENT_MODE.*== off/)
  assert.match(remote, /CONFIGURE_METASHEETCANARY_OAUTH/)
  assert.match(remote, /lifecycle_all_off/)
  assert.match(workflow, /\[\[ -z "\$DEPLOY_SHA" \|\| "\$DEPLOY_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  assert.match(workflow, /\[\[ "\$EXPECTED_CURRENT_MODE" == off \]\]/)
  assert.match(workflow, /\[\[ -z "\$CONFIRMATION" \|\| "\$CONFIRMATION" == CONFIGURE_METASHEETCANARY_OAUTH \]\]/)
})

test('dedicated app and public callback are pinned', () => {
  assert.match(remote, /dingn9htcox9lc12rxmc/)
  assert.match(remote, /dingd1f07b3ff4c8042cbc961a6cb783455b/)
  assert.match(remote, /https:\/\/metasheet-staging\.ddns\.net/)
  assert.match(remote, /\/login\/dingtalk\/callback/)
})

test('credential transport is file-only and artifacts are values-free', () => {
  assert.match(workflow, /unset OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET/)
  assert.match(workflow, /chmod 600.*client\.id.*client\.secret/)
  assert.match(workflow, /secret in path\.read_bytes\(\)/)
  assert.match(workflow, /shutil\.rmtree\(root\)/)
  assert.match(remote, /OAUTH_CLIENT_ID_FILE/)
  assert.match(remote, /OAUTH_CLIENT_SECRET_FILE/)
  assert.doesNotMatch(remote, /echo[^\n]*\$\{?OAUTH_CLIENT_SECRET/)
  assert.match(remote, /client_secret_present=/)
  assert.match(remote, /container_secret_matches_file DINGTALK_CLIENT_SECRET/)
  assert.match(remote, /live_value="\$\(container_value "\$key"\)"/)
  assert.match(remote, /printf '%s' "\$live_value" \| sha256sum/)
  assert.doesNotMatch(remote, /container_value "\$key" \| sha256sum/)
})

test('write is compose-validated, atomic, backend-only, and rollback-capable', () => {
  assert.match(remote, /compose_with_env "\$candidate" config/)
  assert.match(remote, /atomic_install_env/)
  assert.match(remote, /--no-deps --force-recreate backend/)
  assert.match(remote, /restoring previous env/)
  assert.match(remote, /pg_before.*pg_after/s)
  assert.match(remote, /redis_before.*redis_after/s)
  assert.match(remote, /web_before.*web_after/s)
  assert.doesNotMatch(remote, /\[\[ -w "\$target_dir" \]\]/)
})

test('digest-pinned staging resolves only through the matching completion record and override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-digest-pin-'))
  const identity = join(dir, 'deploy-identity.env')
  const override = join(dir, 'attendance.override.yml')
  const sha = 'a'.repeat(40)
  const digest = `ghcr.io/zensgit/metasheet2-backend@sha256:${'b'.repeat(64)}`
  writeFileSync(identity, `deploy_sha=${sha}\nbackend_digest=${digest}\n`)
  writeFileSync(override, `services:\n  backend:\n    image: ${digest}\n`)

  try {
    const pin = runDigestIdentity({ identity, override, digest })
    assert.equal(pin.status, 0, pin.stderr)
    assert.equal(pin.stdout, `zensgit ${sha}`)

    const deployed = runDigestIdentity({ identity, override, digest, functionName: 'deployed_sha' })
    assert.equal(deployed.status, 0, deployed.stderr)
    assert.equal(deployed.stdout, sha, 'digest identity must not depend on stale health build metadata')

    writeFileSync(identity, `deploy_sha=${sha}\nbackend_digest=ghcr.io/zensgit/metasheet2-backend@sha256:${'c'.repeat(64)}\n`)
    const rejected = runDigestIdentity({ identity, override, digest })
    assert.notEqual(rejected.status, 0, 'a digest absent from the completion record must fail closed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transport input closed sets reject shell metacharacters', () => {
  const sha = (value) => value === '' || /^[0-9a-f]{40}$/.test(value)
  const mode = (value) => value === 'off'
  const confirmation = (value) => value === '' || value === 'CONFIGURE_METASHEETCANARY_OAUTH'
  for (const attack of ["x'; id; '", '$(id)', '`id`', 'off\nwhoami']) {
    assert.equal(sha(attack), false)
    assert.equal(mode(attack), false)
    assert.equal(confirmation(attack), false)
  }
})

test('all lifecycle gates are forced false in the candidate env', () => {
  for (const key of [
    'AUTH_LOGIN_USE_ALIASES',
    'DIRECTORY_PENDING_ACTIVATION_ENABLED',
    'DIRECTORY_DEPROVISION_ENABLED',
  ]) {
    assert.match(remote, new RegExp(`"${key}": "false"`))
  }
})
