#!/usr/bin/env node
// dingtalk-production-readiness-inventory-contract.test.mjs
//
// Contract for the manual-only, values-free, READ-ONLY DingTalk production
// readiness inventory lane. No network, no secrets, no workflow dispatch.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'dingtalk-production-readiness-inventory.yml')
const remoteScriptPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-production-readiness-inventory-remote.sh')
const oauthWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'dingtalk-oauth-stability-recording-lite.yml')
const oauthCheckPath = path.join(repoRoot, 'scripts', 'ops', 'dingtalk-oauth-stability-check.sh')
const oauthWebhookPath = path.join(repoRoot, 'scripts', 'ops', 'set-dingtalk-onprem-alertmanager-webhook-config.sh')
const pluginTestsPath = path.join(repoRoot, '.github', 'workflows', 'plugin-tests.yml')

function read(p) {
  return readFileSync(p, 'utf8')
}

function loadYaml(text) {
  const require = createRequire(import.meta.url)
  const candidates = [
    () => require('js-yaml'),
    () => require(path.join(repoRoot, 'node_modules/js-yaml')),
    () => require(path.join(repoRoot, 'packages/openapi/node_modules/js-yaml')),
  ]
  for (const load of candidates) {
    try {
      return load().load(text)
    } catch {
      // try next
    }
  }
  const py = spawnSync(
    'python3',
    ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    { input: text, encoding: 'utf8' },
  )
  if (py.status !== 0) {
    throw new Error(`YAML parse failed: ${py.stderr || py.stdout}`)
  }
  return JSON.parse(py.stdout)
}

function workflowOn(doc) {
  return doc.on ?? doc.true ?? doc[true]
}

function runSourcedInventoryShell(body, env = {}) {
  return spawnSync('bash', ['-c', `source "$INVENTORY_SCRIPT"\n${body}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DINGTALK_PRODUCTION_READINESS_SOURCE_ONLY: 'true',
      INVENTORY_SCRIPT: remoteScriptPath,
      ...env,
    },
  })
}

function assertPinnedHostIdentity(raw, label = 'surface') {
  assert.match(raw, /DEPLOY_KNOWN_HOSTS/, `${label}: DEPLOY_KNOWN_HOSTS required`)
  assert.match(raw, /DEPLOY_KNOWN_HOSTS is required/, `${label}: fail closed when missing`)
  assert.match(raw, /decoded_known_hosts=.*base64 -d/, `${label}: accept base64`)
  assert.match(raw, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/, `${label}: key type check`)
  assert.match(raw, /did not resolve to a recognizable key/, `${label}: unrecognizable key fails`)
  assert.match(raw, /StrictHostKeyChecking=yes/, `${label}: StrictHostKeyChecking=yes`)
  assert.match(raw, /UserKnownHostsFile/, `${label}: UserKnownHostsFile`)
  assert.match(raw, /GlobalKnownHostsFile=\/dev\/null/, `${label}: GlobalKnownHostsFile=/dev/null`)
  assert.match(raw, /BatchMode=yes/, `${label}: BatchMode`)
  assert.match(raw, /IdentitiesOnly=yes/, `${label}: IdentitiesOnly`)
  assert.doesNotMatch(raw, /StrictHostKeyChecking=no/, `${label}: no StrictHostKeyChecking=no`)
}

// --- presence / parse -----------------------------------------------------------------

test('inventory workflow + remote script exist', () => {
  assert.ok(existsSync(workflowPath))
  assert.ok(existsSync(remoteScriptPath))
})

test('remote inventory script parses (bash -n)', () => {
  const result = spawnSync('bash', ['-n', remoteScriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('inventory workflow YAML parses', () => {
  const doc = loadYaml(read(workflowPath))
  assert.equal(doc.name, 'DingTalk Production Readiness Inventory')
  assert.ok(workflowOn(doc)?.workflow_dispatch !== undefined)
  assert.ok(doc.jobs?.inventory)
})

// --- manual-only / read-only ----------------------------------------------------------

test('inventory workflow is manual-only (no schedule/push/pull_request)', () => {
  const raw = read(workflowPath)
  const doc = loadYaml(raw)
  const on = workflowOn(doc)
  assert.ok(on.workflow_dispatch !== undefined && on.workflow_dispatch !== null)
  assert.equal(on.schedule, undefined)
  assert.equal(on.push, undefined)
  assert.equal(on.pull_request, undefined)
  assert.doesNotMatch(raw, /schedule:/)
  assert.doesNotMatch(raw, /cron:/)
  assert.doesNotMatch(raw, /\bpush:/)
  assert.doesNotMatch(raw, /\bpull_request:/)
})

test('inventory lane is read-only: never writes env/DB or flips lifecycle flags', () => {
  const script = read(remoteScriptPath)
  const workflow = read(workflowPath)

  assert.match(script, /READ-ONLY|read-only|read_only=true/i)
  assert.match(workflow, /READ-ONLY|read-only/i)

  // No mutating SQL verbs in the remote inventory path.
  assert.doesNotMatch(script, /\bINSERT\b/i)
  assert.doesNotMatch(script, /\bUPDATE\b/i)
  assert.doesNotMatch(script, /\bDELETE\b/i)
  assert.doesNotMatch(script, /\bDROP\b/i)
  assert.doesNotMatch(script, /\bTRUNCATE\b/i)
  assert.doesNotMatch(script, /\bALTER\b/i)

  // Never write env files or lifecycle overrides.
  assert.doesNotMatch(script, />>\s*['"]?\$\{?.*\.env/)
  assert.doesNotMatch(script, /docker-compose\..*override\.yml/)
  assert.doesNotMatch(script, /AUTH_LOGIN_USE_ALIASES=true/)
  assert.doesNotMatch(script, /DIRECTORY_PENDING_ACTIVATION_ENABLED=true/)
  assert.doesNotMatch(script, /DIRECTORY_DEPROVISION_ENABLED=true/)
  assert.doesNotMatch(script, /DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=true/)

  // Must report the four flags as exact OFF state (read, not write).
  for (const flag of [
    'AUTH_LOGIN_USE_ALIASES',
    'DIRECTORY_PENDING_ACTIVATION_ENABLED',
    'DIRECTORY_DEPROVISION_ENABLED',
    'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
  ]) {
    assert.match(script, new RegExp(flag))
  }
  assert.match(script, /lifecycle_flags_all_off/)
})

test('inventory never emits or chooses a canary subject/integration', () => {
  const script = read(remoteScriptPath)
  assert.doesNotMatch(script, /canary_subject/i)
  assert.doesNotMatch(script, /canary_integration/i)
  // Selecting the same config row as runtime is required for truthful readiness;
  // the selected row's identifier is never projected or emitted.
  assert.match(script, /WITH selected AS/)
  assert.doesNotMatch(script, /SELECT id, status, config[\s\S]{0,120}WITH selected AS/i)
  // Counts only — no SELECT of identifying columns into the artifact path.
  assert.match(script, /count\(\*\)/i)
  assert.match(script, /Counts \+ presence only/)
})

// --- host key enforcement -------------------------------------------------------------

test('inventory workflow pins deploy-host identity like production maintenance lanes', () => {
  assertPinnedHostIdentity(read(workflowPath), 'inventory workflow')
})

test('OAuth stability production path also pins host identity (cross-lane consistency)', () => {
  // OAuth workflow prepares known_hosts + SSH_KNOWN_HOSTS_FILE; SSH options live in scripts.
  const oauthWorkflow = read(oauthWorkflowPath)
  assert.match(oauthWorkflow, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(oauthWorkflow, /DEPLOY_KNOWN_HOSTS is required/)
  assert.match(oauthWorkflow, /decoded_known_hosts=.*base64 -d/)
  assert.match(oauthWorkflow, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/)
  assert.match(oauthWorkflow, /SSH_KNOWN_HOSTS_FILE=/)
  assert.doesNotMatch(oauthWorkflow, /StrictHostKeyChecking=no/)
  for (const [label, p] of [
    ['oauth check', oauthCheckPath],
    ['oauth webhook config', oauthWebhookPath],
  ]) {
    const raw = read(p)
    assert.match(raw, /StrictHostKeyChecking=yes/, `${label}`)
    assert.match(raw, /UserKnownHostsFile=/, `${label}`)
    assert.match(raw, /GlobalKnownHostsFile=\/dev\/null/, `${label}`)
    assert.match(raw, /BatchMode=yes/, `${label}`)
    assert.match(raw, /IdentitiesOnly=yes/, `${label}`)
    assert.doesNotMatch(raw, /StrictHostKeyChecking=no/, `${label}`)
  }
})

// --- values-free / required inventory fields ------------------------------------------

const REQUIRED_INVENTORY_KEYS = [
  'schema=dingtalk-production-readiness-inventory-v1',
  'deployed_sha=',
  'deployed_sha_verified=',
  'app_key_present=',
  'app_secret_present=',
  'agent_id_present=',
  'app_credentials_ready=',
  'allowed_corp_allowlist_ready=',
  'allowed_corp_allowlist_reason=',
  'active_dingtalk_integration_count=',
  'active_corp_anchored_integration_count=',
  'active_directory_account_count=',
  'active_linked_local_user_count=',
  'password_capable_alias_admin_count=',
  'pending_user_count=',
  'at_least_two_linked_users_ready=',
  'directory_uat_baseline_ready=',
  'log_level_ready=',
  'log_level_reason=',
  'stream_client_id_present=',
  'stream_client_secret_present=',
  'stream_template_id_present=',
  'stream_integration_id_present=',
  'stream_credentials_ready=',
  'auth_login_use_aliases=',
  'directory_pending_activation_enabled=',
  'directory_deprovision_enabled=',
  'dingtalk_interactive_card_stream_enabled=',
  'lifecycle_flags_all_off=',
  'read_only=true',
]

test('inventory artifact keys cover required readiness signals', () => {
  const script = read(remoteScriptPath)
  for (const key of REQUIRED_INVENTORY_KEYS) {
    assert.match(script, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing inventory key ${key}`)
  }
})

test('inventory forbids secret/PII/id field emission in artifact contract', () => {
  const script = read(remoteScriptPath)
  // Artifact writing block must not echo secret-bearing env values or PII columns.
  const forbiddenArtifactPatterns = [
    /echo\s+[\"']?(app_key|app_secret|client_secret|corp_id|email|mobile|password)=/i,
    /echo\s+[\"']?DINGTALK_APP_(KEY|SECRET)=/,
    /echo\s+[\"']?DINGTALK_ALLOWED_CORP_IDS=/,
    /printenv\s+DINGTALK_APP_KEY\s*>>/,
  ]
  // Presence checks of config keys are OK; selecting/printing secret values is not.
  // stored credentials readiness uses nullif(trim(config->>'appSecret'), '') IS NOT NULL — presence only.
  assert.match(script, /nullif\(trim\(config->>'appSecret'\), ''\) IS NOT NULL/)
  // Executable SQL must not project secret/PII columns (comments are ignored by stripping # lines).
  const executable = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && !/^\s*\/\//.test(line))
    .join('\n')
  assert.doesNotMatch(executable, /SELECT\s+config->>'appSecret'/i)
  assert.doesNotMatch(executable, /SELECT\s+[^`]*\bu\.email\b/i)
  assert.doesNotMatch(executable, /SELECT\s+[^`]*\bu\.mobile\b/i)
  assert.doesNotMatch(executable, /SELECT\s+password_hash\b/i)
  assert.doesNotMatch(executable, /SELECT\s+corp_id\b/i)
  assert.doesNotMatch(executable, /SELECT\s+[^`]*\bas\s+email\b/i)
  for (const re of forbiddenArtifactPatterns) {
    assert.doesNotMatch(script, re)
  }
})

test('inventory uses docker compose exec and fail-closed unknown on query errors', () => {
  const script = read(remoteScriptPath)
  assert.match(script, /docker compose/)
  assert.match(script, /exec -T/)
  assert.match(script, /BEGIN READ ONLY/)
  assert.match(script, /ROLLBACK/)
  assert.match(script, /to_regclass/)
  assert.match(script, /unknown/)
  assert.match(script, /docker-compose\.app\.yml/)
})

test('inventory counts only active integration-backed users and rejects mixed placeholder allowlists', () => {
  const script = read(remoteScriptPath)
  assert.match(script, /JOIN directory_integrations i ON i\.id = a\.integration_id/)
  assert.match(script, /JOIN users u ON u\.id = l\.local_user_id/)
  assert.match(script, /i\.status = 'active'/)
  assert.match(script, /u\.is_active = TRUE/)
  assert.match(script, /count\(DISTINCT u\.id\)::int AS n/)
  assert.match(script, /GROUP BY i\.id/)
  assert.match(script, /HAVING count\(DISTINCT l\.local_user_id\) >= 2/)
  assert.match(script, /i\.corp_id = ANY\(\$1::text\[\]\)/)
  assert.match(script, /hasPlaceholderCorpId/)
  assert.match(script, /effective_app_credentials_ready/)
  assert.match(script, /directory_uat_baseline_ready/)
  assert.match(script, /WITH selected AS \([\s\S]*SELECT id, status, corp_id, config[\s\S]*GROUP BY i\.id/)
  assert.match(script, /INVENTORY_ENV_APP_KEY_PRESENT/)
  assert.match(script, /INVENTORY_ENV_APP_SECRET_PRESENT/)
  assert.match(script, /INVENTORY_ENV_AGENT_ID_PRESENT/)
  assert.match(script, /has_placeholder=true/)
  assert.doesNotMatch(script, /COALESCE\(u\.role, ''\) = 'admin'/)
})

test('credential readiness is coherent within one active DingTalk integration', () => {
  const script = read(remoteScriptPath)
  const effectiveStart = script.indexOf('result.effective_app_credentials_ready')
  const effectiveEnd = script.indexOf('    }\n    if ((await tableExists', effectiveStart)
  assert.ok(effectiveStart >= 0 && effectiveEnd > effectiveStart)
  const effective = script.slice(effectiveStart, effectiveEnd)
  assert.match(effective, /WITH selected AS/)
  assert.match(effective, /FROM directory_integrations/)
  assert.match(effective, /provider = 'dingtalk'/)
  assert.match(effective, /status = 'active'/)
  assert.match(effective, /ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC/)
  assert.match(effective, /LIMIT 1/)
  assert.match(effective, /config->>'appKey'/)
  assert.match(effective, /config->>'appSecret'/)
  assert.match(effective, /config->>'workNotificationAgentId'/)
  assert.doesNotMatch(script, /APP_CREDS_READY="\$\(tri_and/)
})

test('allowlist classifier matches runtime comma-or-whitespace tokenization', () => {
  const cases = [
    ['replace-me changeme', 'false|placeholder'],
    ['real-corp placeholder', 'false|placeholder'],
    ['real-corp,second-corp', 'true|configured'],
    ['real-corp\nsecond-corp', 'true|configured'],
    ['  \t\n', 'false|empty'],
  ]
  for (const [input, expected] of cases) {
    const result = runSourcedInventoryShell(
      `read_env_raw_or_empty() { printf '%s' "$ALLOWLIST_UNDER_TEST"; }\nclassify_allowlist\nprintf '%s|%s' "$ALLOWLIST_READY" "$ALLOWLIST_REASON"`,
      { ALLOWLIST_UNDER_TEST: input },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected, JSON.stringify(input))
  }
})

test('deployed SHA is exact only when image and health sources agree', () => {
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  const cases = [
    [`repo:${shaA}`, JSON.stringify({ build: { commit: shaA } }), `${shaA}|true`],
    [`repo:${shaA}`, '{}', 'unknown|false'],
    ['repo:latest', JSON.stringify({ build: { commit: shaA } }), 'unknown|false'],
    [`repo:${shaA}`, JSON.stringify({ build: { commit: shaB } }), 'conflict|false'],
  ]
  for (const [image, health, expected] of cases) {
    const result = runSourcedInventoryShell(
      `docker() { printf '%s' "$IMAGE_REF"; }\ncurl() { printf '%s' "$HEALTH_BODY"; }\nBACKEND_CONTAINER_ID=test\nresolve_deployed_sha\nprintf '%s|%s' "$DEPLOYED_SHA" "$DEPLOYED_SHA_VERIFIED"`,
      { IMAGE_REF: image, HEALTH_BODY: health },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected, image)
  }
})

test('values-free artifacts exclude SSH transport logs', () => {
  const workflow = read(workflowPath)
  assert.match(workflow, /ssh_log="\$RUNNER_TEMP\//)
  assert.doesNotMatch(workflow, /output\/dingtalk-production-readiness-inventory\/ssh\.log/)
})

// --- required CI wiring (test 20.x) ----------------------------------------------------

test('inventory contract is wired into required plugin-tests test (20.x) lane', () => {
  const raw = read(pluginTestsPath)
  const requiredJobStart = raw.indexOf('\n  test:\n')
  const requiredJobEnd = raw.indexOf('\n  after-sales-integration:\n')
  assert.ok(requiredJobStart >= 0 && requiredJobEnd > requiredJobStart, 'required test job bounds')
  const requiredJob = raw.slice(requiredJobStart, requiredJobEnd)

  const stepMarker = 'DingTalk production-readiness inventory contract (required lane)'
  const stepStart = requiredJob.indexOf(stepMarker)
  assert.ok(stepStart >= 0, 'required-lane step must exist in test job')
  // Grab from the step name line through the next step.
  const nameIdx = requiredJob.lastIndexOf('\n      - name:', stepStart)
  const stepEnd = requiredJob.indexOf('\n      - name:', stepStart + 1)
  assert.ok(nameIdx >= 0 && stepEnd > nameIdx)
  const step = requiredJob.slice(nameIdx, stepEnd)

  assert.match(
    step,
    /if: matrix\.node-version == '20\.x'/,
    'must run only on the required 20.x leg',
  )
  assert.match(
    step,
    /node --test scripts\/ops\/dingtalk-production-readiness-inventory-contract\.test\.mjs/,
  )
  assert.match(
    step,
    /node --test scripts\/ops\/dingtalk-oauth-stability-workflow-contract\.test\.mjs/,
  )
  assert.doesNotMatch(step, /continue-on-error:/)
})

test('host-identity mutation would fail the inventory contract', () => {
  const raw = read(workflowPath)
  assert.throws(
    () => assertPinnedHostIdentity(raw.replace(/StrictHostKeyChecking=yes/g, 'StrictHostKeyChecking=no')),
    /StrictHostKeyChecking=yes|must not use StrictHostKeyChecking=no|input was expected not to match|did not match/,
  )
  assert.throws(
    () => assertPinnedHostIdentity(raw.replace(/DEPLOY_KNOWN_HOSTS is required/g, 'DEPLOY_KNOWN_HOSTS optional')),
    /fail closed when missing|did not match/,
  )
})
