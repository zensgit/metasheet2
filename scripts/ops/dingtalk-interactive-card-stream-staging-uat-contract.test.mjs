#!/usr/bin/env node
// dingtalk-interactive-card-stream-staging-uat-contract.test.mjs
//
// Durable synthetic contract for the MINIMAL controlled Stream staging UAT lane:
//   EXECUTABLE: status | observe | prepare | on | off | https-on | https-off
//
// Load-bearing rails:
//   * workflow wiring (dispatch choices, SSH, concurrency, no schedule)
//   * exact-SHA gate for every non-status action
//   * secret demotion + chmod-600 file transport (prepare only)
//   * prepare forces Stream OFF while writing four credential/id keys
//   * on flips only Stream flag true after LOG_LEVEL + prerequisite checks
//   * off is fail-safe Stream OFF + worker stop proof
//   * no echo of secrets / raw IDs / PII
//   * status is read-only (no env writes, no flag flips)
//   * lifecycle flags never written true by this lane
//
// No network, no secrets, no workflow execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const REMOTE_SH = join(HERE, 'dingtalk-interactive-card-stream-staging-uat-remote.sh')
const WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'dingtalk-interactive-card-stream-staging-uat.yml',
)
const UAT_CHECKLIST = join(
  REPO_ROOT,
  'docs',
  'development',
  'approval-dingtalk-slice-b-uat-checklist-20260710.md',
)
const DINGTALK_CLIENT = join(
  REPO_ROOT,
  'packages',
  'core-backend',
  'src',
  'integrations',
  'dingtalk',
  'client.ts',
)
const ATTENDANCE_WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'attendance-staging-window-runner.yml',
)
const LIFECYCLE_WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'dingtalk-lifecycle-staging-canary.yml',
)
const PLUGIN_TESTS_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'plugin-tests.yml')

function read(path) {
  return readFileSync(path, 'utf8')
}

function loadYaml(text) {
  const require = createRequire(import.meta.url)
  const candidates = [
    () => require('js-yaml'),
    () => require(join(REPO_ROOT, 'node_modules/js-yaml')),
    () => require(join(REPO_ROOT, 'packages/openapi/node_modules/js-yaml')),
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

/** GitHub Actions `on:` is boolean true under YAML 1.1. */
function workflowOn(doc) {
  return doc.on ?? doc.true ?? doc[true]
}

function actionBody(source, name, nextNames = []) {
  const start = source.indexOf(`${name}()`)
  assert.notEqual(start, -1, `${name}() must exist`)
  let end = source.length
  for (const next of nextNames) {
    const idx = source.indexOf(`\n${next}()`, start + 1)
    if (idx !== -1 && idx < end) end = idx
  }
  const mainIdx = source.indexOf('\n# --- main', start + 1)
  if (mainIdx !== -1 && mainIdx < end) end = mainIdx
  return source.slice(start, end)
}

function runObserveFixture(observe, { dir, expected, lines }) {
  const output = join(dir, 'output')
  const logs = join(dir, 'backend.log')
  const harness = join(dir, 'harness.sh')
  writeFileSync(logs, `${lines.join('\n')}\n`)
  writeFileSync(
    harness,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'log() { :; }',
      'fail() { echo "$*" >&2; exit 1; }',
      'assert_staging_only() { :; }',
      'require_exact_deployed_sha() { :; }',
      'require_lifecycle_flags_off() { :; }',
      'require_log_level_info_or_debug() { :; }',
      'register_ephemeral() { :; }',
      'read_flag_from_container() { printf true; }',
      'docker() { [[ "$1" == "logs" ]] || return 1; cat "$LOG_FIXTURE"; }',
      'BACKEND_CONTAINER=metasheet-staging-backend',
      'FLAG_STREAM=DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
      'mkdir -p "$STREAM_UAT_PERSIST_DIR" "$OUTPUT_DIR"',
      observe,
      'action_observe',
    ].join('\n'),
  )
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPECTED_DELIVERY_ID: expected,
      LOG_FIXTURE: logs,
      OUTPUT_DIR: output,
      STREAM_UAT_PERSIST_DIR: dir,
    },
  })
  return { output, result }
}

function removeObserveGuard(observe, condition) {
  const start = observe.indexOf(`  [[ "${condition}" -gt 0 ]] ` + '\\')
  assert.notEqual(start, -1, `${condition} guard must exist for mutation test`)
  const firstEnd = observe.indexOf('\n', start)
  const secondEnd = observe.indexOf('\n', firstEnd + 1)
  assert.notEqual(secondEnd, -1, `${condition} guard must have a failure line`)
  return observe.slice(0, start) + observe.slice(secondEnd + 1)
}

// --- parse / presence -----------------------------------------------------------------

test('remote script and workflow files exist', () => {
  assert.ok(existsSync(REMOTE_SH))
  assert.ok(existsSync(WORKFLOW))
})

test('embedded remote script parses (bash -n)', () => {
  const result = spawnSync('bash', ['-n', REMOTE_SH], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('workflow YAML parses with repository-available parser', () => {
  const doc = loadYaml(read(WORKFLOW))
  assert.equal(doc.name, 'DingTalk Interactive Card Stream Staging UAT')
  assert.ok(workflowOn(doc)?.workflow_dispatch?.inputs?.action)
  assert.ok(doc.jobs?.run)
})

// --- workflow wiring ------------------------------------------------------------------

test('workflow action choices include observer and reversible HTTPS gateway actions', () => {
  const doc = loadYaml(read(WORKFLOW))
  const inputs = workflowOn(doc).workflow_dispatch.inputs
  assert.deepEqual(inputs.action.options, ['status', 'observe', 'prepare', 'on', 'off', 'https-on', 'https-off'])
  assert.equal(inputs.action.default, 'status')
  // Quote on/off so YAML 1.1 keeps strings (loadYaml may coerce bare on/off).
  const yaml = read(WORKFLOW)
  assert.match(yaml, /options:\s*\[status,\s*observe,\s*prepare,\s*'on',\s*'off',\s*https-on,\s*https-off\]/)
  assert.ok(
    inputs.action.options.every((o) => typeof o === 'string'),
    'on/off must remain strings after parse',
  )
})

test('workflow is manual-only (no schedule/push/pull_request)', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const on = workflowOn(doc)
  assert.ok(on.workflow_dispatch)
  assert.equal(on.schedule, undefined)
  assert.equal(on.push, undefined)
  assert.equal(on.pull_request, undefined)
  assert.doesNotMatch(yaml, /schedule:/)
  assert.doesNotMatch(yaml, /cron:/)
})

test('workflow shares concurrency with attendance staging runner and lifecycle lane', () => {
  const stream = loadYaml(read(WORKFLOW))
  const attendance = loadYaml(read(ATTENDANCE_WORKFLOW))
  const lifecycle = loadYaml(read(LIFECYCLE_WORKFLOW))
  assert.equal(stream.concurrency.group, attendance.concurrency.group)
  assert.equal(stream.concurrency.group, lifecycle.concurrency.group)
  assert.equal(stream.concurrency.group, 'attendance-staging-window-runner')
  assert.equal(stream.concurrency['cancel-in-progress'], false)
})

test('workflow remote commands use bash -o pipefail -c; SSH pins known_hosts', () => {
  const yaml = read(WORKFLOW)
  assert.ok((yaml.match(/bash -o pipefail -c/g) || []).length >= 2)
  assert.doesNotMatch(yaml, /bash\s+-s\b/)
  assert.match(yaml, /DEPLOY_KNOWN_HOSTS/)
  assert.match(yaml, /StrictHostKeyChecking=yes/)
  assert.match(yaml, /UserKnownHostsFile=/)
  assert.match(yaml, /GlobalKnownHostsFile=\/dev\/null/)
  assert.match(yaml, /BatchMode=yes/)
  assert.match(yaml, /IdentitiesOnly=yes/)
  assert.doesNotMatch(yaml, /StrictHostKeyChecking=no/)
})

test('workflow Validate inputs runs bash -n on remote script and self-test step exists', () => {
  const doc = loadYaml(read(WORKFLOW))
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.ok(validate?.run)
  assert.match(validate.run, /bash -n scripts\/ops\/dingtalk-interactive-card-stream-staging-uat-remote\.sh/)
  const selfTest = doc.jobs.run.steps.find((s) => s.name === 'Run pipeline self-test (contract suite)')
  assert.ok(selfTest?.run)
  assert.match(
    selfTest.run,
    /node --test scripts\/ops\/dingtalk-interactive-card-stream-staging-uat-contract\.test\.mjs/,
  )
})

test('contract suite is wired into the required Node 20 plugin-tests lane', () => {
  const doc = loadYaml(read(PLUGIN_TESTS_WORKFLOW))
  const requiredJob = doc.jobs?.test
  assert.ok(requiredJob, 'plugin-tests test job must exist')
  const step = requiredJob.steps?.find(
    (candidate) => candidate.id === 'dingtalk-production-readiness-inventory-contract',
  )
  assert.ok(step?.run, 'required DingTalk contract step must exist')
  assert.equal(step.if, "matrix.node-version == '20.x'")
  assert.match(
    step.run,
    /node --test scripts\/ops\/dingtalk-interactive-card-stream-staging-uat-contract\.test\.mjs/,
  )
})

test('U6 keeps card forwarding disabled and uses controlled callback injection for B', () => {
  const checklist = read(UAT_CHECKLIST)
  assert.match(
    checklist,
    /\| U6 \| 非受理人 B 的受控技术注入同意回调（不依赖卡片转发） \|[^\n]*supportForward=false/,
  )
  assert.doesNotMatch(checklist, /\| U6 \|[^\n]*转发的卡/)
  assert.match(read(DINGTALK_CLIENT), /supportForward:\s*false/)
})

test('U11-a distinguishes an absent corp anchor from a real corp mismatch', () => {
  const checklist = read(UAT_CHECKLIST)
  const u11a = checklist.split('\n').find((line) => line.startsWith('| **U11-a**'))
  assert.ok(u11a, 'U11-a checklist row must exist')
  assert.match(checklist, /两者都缺 ⇒ 判 `corp_anchor_absent`/)
  assert.match(u11a, /`corp_anchor_absent` ⇒ 真实帧缺企业锚点/)
  assert.match(u11a, /`corp_mismatch` ⇒ 锚点存在但企业确实不一致/)
  assert.doesNotMatch(u11a, /corp_mismatch.*根本不带/)
})

// --- exact-SHA gate -------------------------------------------------------------------

test('workflow exact-SHA gate requires full 40-char deploy_sha for every non-status action', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.equal(validate.env.DEPLOY_SHA, '${{ inputs.deploy_sha }}')
  assert.match(validate.run, /"\$ACTION" != "status"/)
  assert.match(
    validate.run,
    /deploy_sha must be the FULL 40-char lowercase commit SHA for action=\$\{ACTION\}/,
  )
  assert.match(validate.run, /\^\[0-9a-f\]\{40\}\$/)
  // status may omit deploy_sha
  assert.doesNotMatch(
    validate.run,
    /deploy_sha must be the FULL 40-char lowercase commit SHA for action=status/,
  )
})

test('observe exclusively requires a lowercase expected delivery UUID and never emits it', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.equal(validate.env.EXPECTED_DELIVERY_ID, '${{ inputs.expected_delivery_id }}')
  assert.match(validate.run, /observe requires expected_delivery_id as a lowercase UUID/)
  assert.match(validate.run, /expected_delivery_id is accepted only for action=observe/)
  assert.match(validate.run, /\[1-5\]\[0-9a-f\]\{3\}/)
  const remoteStep = doc.jobs.run.steps.find((s) => s.name === 'Run remote action')
  assert.equal(remoteStep.env.EXPECTED_DELIVERY_ID, '${{ inputs.expected_delivery_id }}')
  assert.match(remoteStep.run, /refusing invalid expected_delivery_id in remote execution step/)
  assert.match(remoteStep.run, /refusing expected_delivery_id outside action=observe/)
  assert.match(remoteStep.run, /case "\$ACTION" in status\|observe\|prepare\|on\|off\|https-on\|https-off/)
  assert.match(remoteStep.run, /refusing invalid deploy_sha in remote execution step/)
  assert.match(remoteStep.run, /refusing invalid optional deploy_sha in remote execution step/)
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  assert.match(observe, /grep -F -c "\$EXPECTED_DELIVERY_ID"/)
  assert.doesNotMatch(observe, /echo .*EXPECTED_DELIVERY_ID/)
})

test('workflow and remote preflights reject cross-action delivery-id injection before SSH construction', () => {
  const doc = loadYaml(read(WORKFLOW))
  const steps = doc.jobs.run.steps
  const validate = steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  const remoteStep = steps.find((s) => s.name === 'Run remote action')
  const remotePreflightEnd = remoteStep.run.indexOf('for pair in')
  assert.ok(remotePreflightEnd > 0, 'remote preflight must precede path validation and SSH construction')
  const remotePreflight = `${remoteStep.run.slice(0, remotePreflightEnd)}\nexit 0\n`
  const sha = 'a'.repeat(40)
  const deliveryId = '12345678-1234-4123-8123-123456789abc'

  const runValidate = (action, deploySha, expectedDeliveryId) => spawnSync(
    'bash',
    ['-c', validate.run],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: action,
        DEPLOY_SHA: deploySha,
        EXPECTED_DELIVERY_ID: expectedDeliveryId,
      },
    },
  )
  const runRemotePreflight = (action, deploySha, expectedDeliveryId) => spawnSync(
    'bash',
    ['-c', remotePreflight],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: action,
        DEPLOY_SHA: deploySha,
        EXPECTED_DELIVERY_ID: expectedDeliveryId,
        STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID: '',
        STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET: '',
        STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID: '',
      },
    },
  )

  for (const action of ['status', 'observe', 'prepare', 'on', 'off', 'https-on', 'https-off']) {
    const deploySha = action === 'status' ? '' : sha
    const expectedDeliveryId = action === 'observe' ? deliveryId : ''
    assert.equal(runValidate(action, deploySha, expectedDeliveryId).status, 0, `validate ${action}`)
    assert.equal(runRemotePreflight(action, deploySha, expectedDeliveryId).status, 0, `remote ${action}`)
  }

  for (const unsafe of [deliveryId, "'; touch /tmp/stream-uat-injection; #"]) {
    assert.equal(runValidate('status', '', unsafe).status, 2)
    assert.equal(runRemotePreflight('status', '', unsafe).status, 2)
  }
  assert.equal(runValidate('observe', sha, '').status, 2)
  assert.equal(runRemotePreflight('observe', sha, '').status, 2)
  assert.equal(runValidate('observe', sha, "'; touch /tmp/stream-uat-injection; #").status, 2)
  assert.equal(runRemotePreflight('observe', sha, "'; touch /tmp/stream-uat-injection; #").status, 2)
  assert.equal(runValidate('status', "'; touch /tmp/stream-uat-injection; #", '').status, 2)
  assert.equal(runRemotePreflight('status', "'; touch /tmp/stream-uat-injection; #", '').status, 2)
  assert.equal(runRemotePreflight('https-on', 'not-a-sha', '').status, 2)
})

test('remote script require_exact_deployed_sha used by every non-status action and not status', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /require_exact_deployed_sha/)
  assert.match(source, /resolve_deployed_sha/)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  const prepare = actionBody(source, 'action_prepare', ['action_on'])
  const on = actionBody(source, 'action_on', ['action_off'])
  const off = actionBody(source, 'action_off', ['action_https_on'])
  const httpsOn = actionBody(source, 'action_https_on', ['action_https_off'])
  const httpsOff = actionBody(source, 'action_https_off')
  const status = actionBody(source, 'action_status', ['action_observe'])
  assert.match(observe, /require_exact_deployed_sha "observe"/)
  assert.match(prepare, /require_exact_deployed_sha/)
  assert.match(on, /require_exact_deployed_sha/)
  assert.match(off, /require_exact_deployed_sha/)
  assert.match(httpsOn, /require_exact_deployed_sha/)
  assert.match(httpsOff, /require_exact_deployed_sha/)
  assert.doesNotMatch(status, /require_exact_deployed_sha/)
})

test('observe is read-only and emits values-free callback classes without raw logs or ids', () => {
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  assert.match(observe, /action=observe/)
  assert.match(observe, /require_lifecycle_flags_off "observe"/)
  assert.match(observe, /require_log_level_info_or_debug "observe"/)
  assert.match(observe, /header_event_corp_id_present=/)
  assert.match(observe, /body_corp_id_present=/)
  assert.match(observe, /latest_callback_outcome=/)
  assert.match(observe, /window_callback_handler_error_count=/)
  assert.match(observe, /card_update_failed_count=/)
  assert.match(observe, /callback_anchor_log_count=\$\{anchor_count\}/)
  assert.match(observe, /callback_handled_count=\$\{handled_count\}/)
  assert.match(observe, /outside closed set/)
  assert.doesNotMatch(observe, /handled_outcome="(?:other|unknown)"/)
  for (const outcome of [
    'ignored_unsupported_action',
    'delivery_not_found',
    'executed',
    'stale',
    'operator_unresolved',
    'link_secret_unavailable',
    'engine_rejected',
    'wrapper_not_found',
  ]) {
    assert.match(observe, new RegExp(`handled_outcome="${outcome}"`))
  }
  // A parse-time rejection has no delivery id and cannot be claimed as scoped
  // evidence for EXPECTED_DELIVERY_ID. The two out_track_id outcomes above do.
  assert.doesNotMatch(observe, /handled_outcome="rejected"/)
  assert.doesNotMatch(observe, /handled_outcome="(?:accepted|duplicate)"/)
  assert.doesNotMatch(observe, /echo "callback_handler_error_count=/)
  assert.doesNotMatch(observe, /cat "\$tmp"|echo "\$anchor_line"|deliveryId=/)
  assert.doesNotMatch(observe, /atomic_(?:set|upsert)|recreate_backend_only|compose_staging_cmd up/)
})

test('observe dynamically scopes Winston log evidence to the expected delivery', () => {
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  const dir = mkdtempSync(join(tmpdir(), 'stream-observer-'))
  const output = join(dir, 'output')
  const logs = join(dir, 'backend.log')
  const harness = join(dir, 'harness.sh')
  const expected = '12345678-1234-4123-8123-123456789abc'
  const other = '87654321-4321-4123-8123-cba987654321'
  try {
    writeFileSync(
      logs,
      [
        `info: DingTalk interactive-card callback corp anchor {"deliveryId":"${other}","headerEventCorpIdPresent":false,"bodyCorpIdPresent":true}`,
        `info: DingTalk interactive-card callback handled (stale delivery=${other})`,
        `info: DingTalk interactive-card callback corp anchor {"deliveryId":"${expected}","headerEventCorpIdPresent":true,"bodyCorpIdPresent":false}`,
        `info: DingTalk interactive-card callback handled (operator_unresolved:missing_link delivery=${expected})`,
        `info: DingTalk interactive-card callback handled (executed delivery=${expected})`,
        'warn: DingTalk interactive-card callback failed (callback_handler_error)',
        `warn: DingTalk approval-card terminal update failed (card_update_failed:Error) delivery=${expected}`,
      ].join('\n') + '\n',
    )
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { :; }',
        'fail() { echo "$*" >&2; exit 1; }',
        'assert_staging_only() { :; }',
        'require_exact_deployed_sha() { :; }',
        'require_lifecycle_flags_off() { :; }',
        'require_log_level_info_or_debug() { :; }',
        'register_ephemeral() { :; }',
        'read_flag_from_container() { printf true; }',
        'docker() { [[ "$1" == "logs" ]] || return 1; cat "$LOG_FIXTURE"; }',
        'BACKEND_CONTAINER=metasheet-staging-backend',
        'FLAG_STREAM=DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
        'mkdir -p "$STREAM_UAT_PERSIST_DIR" "$OUTPUT_DIR"',
        observe,
        'action_observe',
      ].join('\n'),
    )
    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_DELIVERY_ID: expected,
        LOG_FIXTURE: logs,
        OUTPUT_DIR: output,
        STREAM_UAT_PERSIST_DIR: dir,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const artifact = readFileSync(join(output, 'callback-observer.txt'), 'utf8')
    assert.match(artifact, /callback_anchor_log_count=1/)
    assert.match(artifact, /header_event_corp_id_present=true/)
    assert.match(artifact, /body_corp_id_present=false/)
    assert.match(artifact, /callback_handled_count=2/)
    assert.match(artifact, /latest_callback_outcome=executed/)
    assert.match(artifact, /window_callback_handler_error_count=1/)
    assert.match(artifact, /card_update_failed_count=1/)
    assert.doesNotMatch(artifact, new RegExp(`${expected}|${other}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('observe precisely classifies scoped out_track_id terminal outcomes', () => {
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  const dir = mkdtempSync(join(tmpdir(), 'stream-observer-out-track-'))
  const output = join(dir, 'output')
  const logs = join(dir, 'backend.log')
  const harness = join(dir, 'harness.sh')
  const expected = '12345678-1234-4123-8123-123456789abc'
  try {
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { :; }',
        'fail() { echo "$*" >&2; exit 1; }',
        'assert_staging_only() { :; }',
        'require_exact_deployed_sha() { :; }',
        'require_lifecycle_flags_off() { :; }',
        'require_log_level_info_or_debug() { :; }',
        'register_ephemeral() { :; }',
        'read_flag_from_container() { printf true; }',
        'docker() { [[ "$1" == "logs" ]] || return 1; cat "$LOG_FIXTURE"; }',
        'BACKEND_CONTAINER=metasheet-staging-backend',
        'FLAG_STREAM=DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED',
        'mkdir -p "$STREAM_UAT_PERSIST_DIR" "$OUTPUT_DIR"',
        observe,
        'action_observe',
      ].join('\n'),
    )
    for (const [line, expectedOutcome] of [
      [
        `info: DingTalk interactive-card callback handled (ignored_unsupported_action out_track_id=${expected})`,
        'ignored_unsupported_action',
      ],
      [
        `info: DingTalk interactive-card callback handled (delivery_not_found out_track_id=${expected})`,
        'delivery_not_found',
      ],
    ]) {
      writeFileSync(
        logs,
        [
          `info: DingTalk interactive-card callback corp anchor {"deliveryId":"${expected}","headerEventCorpIdPresent":true,"bodyCorpIdPresent":false}`,
          line,
        ].join('\n') + '\n',
      )
      const result = spawnSync('bash', [harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPECTED_DELIVERY_ID: expected,
          LOG_FIXTURE: logs,
          OUTPUT_DIR: output,
          STREAM_UAT_PERSIST_DIR: dir,
        },
      })
      assert.equal(result.status, 0, result.stderr)
      const artifact = readFileSync(join(output, 'callback-observer.txt'), 'utf8')
      assert.match(artifact, new RegExp(`latest_callback_outcome=${expectedOutcome}`))
      assert.doesNotMatch(artifact, new RegExp(expected))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('observe fails closed for missing scoped evidence and an unknown outcome', () => {
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  const dir = mkdtempSync(join(tmpdir(), 'stream-observer-negative-'))
  const expected = '12345678-1234-4123-8123-123456789abc'
  const anchor = `info: DingTalk interactive-card callback corp anchor {"deliveryId":"${expected}","headerEventCorpIdPresent":true,"bodyCorpIdPresent":false}`
  try {
    for (const { name, lines, reason } of [
      {
        name: 'anchor_count=0',
        lines: [`info: DingTalk interactive-card callback handled (executed delivery=${expected})`],
        reason: /callback_anchor_log_count=0/,
      },
      {
        name: 'handled_count=0',
        lines: [anchor],
        reason: /callback_handled_count=0/,
      },
      {
        name: 'outcome outside closed set',
        lines: [anchor, `info: DingTalk interactive-card callback handled (unexpected delivery=${expected})`],
        reason: /outside closed set/,
      },
    ]) {
      const { output, result } = runObserveFixture(observe, { dir, expected, lines })
      assert.notEqual(result.status, 0, `${name} must fail`)
      assert.match(result.stderr, reason)
      assert.doesNotMatch(result.stderr, new RegExp(expected))
      assert.equal(existsSync(join(output, 'callback-observer.txt')), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('observe evidence and outcome guards are mutation-killed', () => {
  const source = read(REMOTE_SH)
  const observe = actionBody(source, 'action_observe', ['action_prepare'])
  const expected = '12345678-1234-4123-8123-123456789abc'
  const anchor = `info: DingTalk interactive-card callback corp anchor {"deliveryId":"${expected}","headerEventCorpIdPresent":true,"bodyCorpIdPresent":false}`
  const mutations = [
    {
      name: 'remove anchor_count guard',
      lines: [`info: DingTalk interactive-card callback handled (executed delivery=${expected})`],
      mutate: (body) => removeObserveGuard(body, '$anchor_count'),
    },
    {
      name: 'remove handled_count guard',
      lines: [anchor],
      mutate: (body) => removeObserveGuard(body, '$handled_count'),
    },
    {
      name: 'restore open outcome fallback',
      lines: [anchor, `info: DingTalk interactive-card callback handled (unexpected delivery=${expected})`],
      mutate: (body) => body.replace(
        '      *) fail "action=observe observed callback outcome outside closed set (callback_handled_count=${handled_count})" ;;',
        '      *) handled_outcome="executed" ;;',
      ),
    },
  ]

  for (const { name, lines, mutate } of mutations) {
    const dir = mkdtempSync(join(tmpdir(), 'stream-observer-mutation-'))
    try {
      const original = runObserveFixture(observe, { dir, expected, lines })
      assert.notEqual(original.result.status, 0, `${name}: original must fail`)
      const mutatedObserve = mutate(observe)
      assert.notEqual(mutatedObserve, observe, `${name}: mutation must change the body`)
      const mutated = runObserveFixture(mutatedObserve, { dir, expected, lines })
      assert.equal(mutated.result.status, 0, `${name}: mutation must be caught by the test fixture`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// --- secret demotion ------------------------------------------------------------------

test('workflow Validate inputs does not receive Stream credential secrets', () => {
  const doc = loadYaml(read(WORKFLOW))
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.ok(validate?.env)
  assert.equal(validate.env.STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID, undefined)
  assert.equal(validate.env.STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET, undefined)
  assert.equal(validate.env.STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID, undefined)
  assert.doesNotMatch(validate.run, /STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT/)
})

test('workflow materializes prepare secrets inside Run remote action under EXIT trap with demotion', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const steps = doc.jobs.run.steps
  for (const step of steps) {
    const name = String(step.name || '')
    assert.doesNotMatch(name, /^Materialize/i)
  }
  assert.doesNotMatch(yaml, /id:\s*secrets\b/)
  assert.doesNotMatch(yaml, /steps\.secrets\.outputs/)

  const remoteStep = steps.find((s) => s.name === 'Run remote action')
  assert.ok(remoteStep?.run)
  assert.ok(remoteStep.env)
  assert.ok(remoteStep.env.STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID)
  assert.ok(remoteStep.env.STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET)
  assert.ok(remoteStep.env.STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID)
  // Conditional injection: prepare only.
  assert.match(
    String(remoteStep.env.STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID),
    /inputs\.action == 'prepare'/,
  )

  const runLines = String(remoteStep.run).split('\n')
  let sawSet = false
  let sawEnvUnset = false
  const linesBetweenSetAndEnvUnset = []
  for (const line of runLines) {
    const t = line.trim()
    if (!sawSet) {
      if (t === 'set -euo pipefail') {
        sawSet = true
      }
      continue
    }
    if (
      t.startsWith(
        'unset STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID',
      )
    ) {
      sawEnvUnset = true
      break
    }
    linesBetweenSetAndEnvUnset.push(t)
  }
  assert.equal(sawSet, true)
  assert.equal(sawEnvUnset, true, 'must unset exported secret env names early')
  const demoteCode = linesBetweenSetAndEnvUnset.filter((t) => t && !t.startsWith('#'))
  assert.deepEqual(
    demoteCode,
    [
      '_STREAM_CLIENT_ID="${STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID-}"',
      '_STREAM_CLIENT_SECRET="${STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET-}"',
      '_STREAM_TEMPLATE_ID="${STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID-}"',
    ],
    'only demote assignments (builtins) before secret env unset — no external commands',
  )

  assert.match(remoteStep.run, /trap cleanup_stream_uat_ephemeral_paths EXIT/)
  assert.match(remoteStep.run, /trap 'exit_after_stream_uat_cleanup 129' HUP/)
  assert.match(remoteStep.run, /trap 'exit_after_stream_uat_cleanup 130' INT/)
  assert.match(remoteStep.run, /trap 'exit_after_stream_uat_cleanup 143' TERM/)
  assert.match(
    remoteStep.run,
    /exit_after_stream_uat_cleanup\(\) \{[\s\S]*trap - EXIT HUP INT TERM[\s\S]*cleanup_stream_uat_ephemeral_paths[\s\S]*exit "\$signal_rc"/,
  )
  assert.match(remoteStep.run, /mktemp -d/)
  assert.match(remoteStep.run, /chmod 600/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_STREAM_CLIENT_ID\}"/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_STREAM_CLIENT_SECRET\}"/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_STREAM_TEMPLATE_ID\}"/)
  assert.match(remoteStep.run, /unset _STREAM_CLIENT_ID _STREAM_CLIENT_SECRET _STREAM_TEMPLATE_ID/)
  assert.match(remoteStep.run, /STREAM_CLIENT_ID_FILE=/)
  assert.match(remoteStep.run, /STREAM_CLIENT_SECRET_FILE=/)
  assert.match(remoteStep.run, /STREAM_TEMPLATE_ID_FILE=/)
  assert.match(remoteStep.run, /scp \$ssh_opts/)
  // Never export raw secret values into remote script env.
  assert.doesNotMatch(remoteStep.run, /export STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID=/)
  assert.doesNotMatch(remoteStep.run, /export STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET=/)
  assert.doesNotMatch(remoteStep.run, /export STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID=/)
  assert.doesNotMatch(remoteStep.run, /export STREAM_CLIENT_ID=/)
  assert.doesNotMatch(remoteStep.run, /export STREAM_CLIENT_SECRET=/)
})

// --- prepare forces off ---------------------------------------------------------------

test('remote prepare forces Stream flag false and writes four credential/id env keys', () => {
  const source = read(REMOTE_SH)
  const prepare = actionBody(source, 'action_prepare', ['action_on'])
  assert.match(prepare, /atomic_upsert_env_keys_from_files/)
  assert.match(prepare, /@literal:false/)
  assert.match(prepare, /DINGTALK_INTERACTIVE_CARD_CLIENT_ID|KEY_CLIENT_ID/)
  assert.match(prepare, /KEY_CLIENT_SECRET|DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET/)
  assert.match(prepare, /KEY_TEMPLATE_ID|DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID/)
  assert.match(prepare, /KEY_STREAM_INTEGRATION_ID|DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID/)
  assert.match(prepare, /FLAG_STREAM|DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED/)
  assert.match(prepare, /derive_exact_integration_id_file/)
  assert.match(prepare, /prepare must leave stream flag false/)
  assert.match(prepare, /backend_needs_restart_for_prepare|backend restart/)
  // Must not set stream true in prepare.
  assert.doesNotMatch(prepare, /atomic_set_stream_flag\s+"true"/)
  assert.doesNotMatch(prepare, /@literal:true/)
})

test('prepare refuses a live Stream worker instead of relying on a fallible restart to stop it', () => {
  const source = read(REMOTE_SH)
  const prepare = actionBody(source, 'action_prepare', ['action_on'])
  const readIdx = prepare.indexOf('read_flag_from_container "$FLAG_STREAM"')
  const offGuardIdx = prepare.indexOf('[[ "$pre_flag" == "false" ]]')
  const writeIdx = prepare.indexOf('atomic_upsert_env_keys_from_files')
  assert.ok(readIdx >= 0, 'prepare must read the live Stream flag')
  assert.ok(offGuardIdx > readIdx, 'prepare must require the live flag to be false')
  assert.ok(writeIdx > offGuardIdx, 'the OFF precondition must run before any credential write')
  assert.match(prepare, /run action=off first/)
})

test('remote prepare derives exactly one eligible integration under the live configured corp', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /process\.env\.DINGTALK_CORP_ID/)
  assert.match(source, /configuredRows = configuredCorpId/)
  assert.match(source, /String\(row\.corp_id \|\| ""\)\.trim\(\) === configuredCorpId/)
  assert.match(source, /eligibleRows = configuredRows\.filter/)
  assert.match(source, /eligibleRows\.length === 1/)
  assert.match(source, /requires exactly one eligible integration for configured corp/)
  assert.match(source, />=2 active linked local users/)
  assert.match(source, /count\(DISTINCT u\.id\)/)
  assert.match(source, /provider = 'dingtalk'/)
  assert.match(source, /status = 'active'/)
  assert.match(source, /corp_id IS NOT NULL/)
  assert.doesNotMatch(source, /requires exactly one active DingTalk integration with nonempty corp_id/)
  assert.match(source, /chmod 600 "\$id_tmp"/)
  // Never log integration id value.
  assert.doesNotMatch(source, /log ".*integration_id=\$/)
  assert.doesNotMatch(source, /echo .*\$id_val/)
})

// --- on / off behavior ----------------------------------------------------------------

test('remote on rechecks prerequisites, requires LOG_LEVEL info/debug, flips only Stream true', () => {
  const source = read(REMOTE_SH)
  const on = actionBody(source, 'action_on', ['action_off'])
  assert.match(on, /require_log_level_info_or_debug/)
  assert.match(on, /require_stream_prerequisites_for_on/)
  assert.match(on, /require_lifecycle_flags_off/)
  assert.match(on, /atomic_set_stream_flag\s+"true"/)
  assert.match(on, /recreate_backend_only/)
  assert.match(on, /wait_for_worker_started/)
  // on proves worker_started only; never claims SDK connected from startup logs.
  assert.match(on, /worker_started only/)
  assert.match(on, /stream_connected=\$\{STREAM_CONNECTED_UNKNOWN\}|stream_connected=unknown/)
  assert.match(on, /u12_u13_human_gated=true/)
  assert.doesNotMatch(on, /stream_connected=true/)
  assert.doesNotMatch(on, /worker connected|SDK connected|connection proven/i)
  // Must not write lifecycle flags.
  assert.doesNotMatch(on, /AUTH_LOGIN_USE_ALIASES=true/)
  assert.doesNotMatch(on, /DIRECTORY_PENDING_ACTIVATION_ENABLED=true/)
  assert.doesNotMatch(on, /DIRECTORY_DEPROVISION_ENABLED=true/)
  // Must not rewrite credential keys on on path.
  assert.doesNotMatch(on, /atomic_upsert_env_keys_from_files/)
})

test('action=on arms fatal-signal fail-safe Stream OFF rollback before atomic_set true (load-bearing)', () => {
  // P1 mutation surface: post-write failures must not leave Stream ON.
  // Arm BEFORE atomic_set true; disarm ONLY after all post-write checks + artifact.
  // Signal trap must exit (not return/continue). Rollback: disk flag false + recreate.
  const source = read(REMOTE_SH)
  const on = actionBody(source, 'action_on', ['action_off'])

  // Arm helpers exist and perform force-off + recreate.
  assert.match(source, /arm_stream_on_fail_safe_rollback/)
  assert.match(source, /disarm_stream_on_fail_safe_rollback/)
  assert.match(source, /stream_on_fail_safe_rollback/)
  assert.match(source, /STREAM_ON_ROLLBACK_ARMED/)

  const rollbackStart = source.indexOf('stream_on_fail_safe_rollback()')
  assert.notEqual(rollbackStart, -1)
  const rollbackEnd = source.indexOf('\narm_stream_on_fail_safe_rollback()', rollbackStart)
  assert.notEqual(rollbackEnd, -1)
  const rollbackBody = source.slice(rollbackStart, rollbackEnd)
  assert.match(rollbackBody, /atomic_set_stream_flag\s+"false"/)
  assert.match(rollbackBody, /recreate_backend_only/)
  assert.match(rollbackBody, /on_fail_safe_rollback=/)
  assert.match(rollbackBody, /STREAM_ON_ROLLBACK_DONE/)

  // Trap wiring includes SSH disconnect signals; forbid return-only cleanup_ephemeral.
  assert.doesNotMatch(source, /^[ \t]*trap[ \t]+cleanup_ephemeral\b/m)
  assert.doesNotMatch(source, /^[ \t]*trap[ \t]+['"]cleanup_ephemeral['"]/m)
  assert.match(source, /trap 'on_script_trap EXIT' EXIT/)
  assert.match(source, /trap 'on_script_trap HUP' HUP/)
  assert.match(source, /trap 'on_script_trap INT' INT/)
  assert.match(source, /trap 'on_script_trap TERM' TERM/)
  assert.match(source, /on_script_trap PIPE' PIPE/)
  const trapStart = source.indexOf('on_script_trap()')
  assert.notEqual(trapStart, -1)
  const trapEnd = source.indexOf("\ntrap 'on_script_trap EXIT'", trapStart)
  assert.notEqual(trapEnd, -1)
  const trapBody = source.slice(trapStart, trapEnd)
  assert.match(trapBody, /stream_on_fail_safe_rollback/)
  assert.match(trapBody, /cleanup_ephemeral/)
  // $? must be captured BEFORE any other command (including local reason=...).
  // Otherwise saved_rc becomes 0 and EXIT can turn a failed on action green.
  assert.match(
    trapBody,
    /on_script_trap\(\)\s*\{\s*\n\s*local saved_rc=\$\?/,
    'on_script_trap must capture $? as the first statement',
  )
  const savedRcIdx = trapBody.indexOf('local saved_rc=$?')
  const reasonIdx = trapBody.indexOf('local reason=')
  assert.ok(savedRcIdx >= 0 && reasonIdx > savedRcIdx, 'saved_rc=$? must precede local reason=')
  // Fatal signals must exit so main cannot continue after connection loss.
  assert.match(trapBody, /exit 129/)
  assert.match(trapBody, /exit 130/)
  assert.match(trapBody, /exit 141/)
  assert.match(trapBody, /exit 143/)
  assert.match(trapBody, /HUP\)/)
  assert.match(trapBody, /INT\)/)
  assert.match(trapBody, /PIPE\)/)
  assert.match(trapBody, /TERM\)/)
  // Load-bearing: after INT/TERM case labels, must exit (not bare return).
  assert.match(trapBody, /INT\)[\s\S]{0,80}exit 130/)
  assert.match(trapBody, /TERM\)[\s\S]{0,80}exit 143/)

  // Load-bearing order inside action_on:
  // arm → atomic_set true → post checks → artifact → disarm
  // Search post-write needles AFTER the true write so comment mentions do not win.
  const armIdx = on.indexOf('arm_stream_on_fail_safe_rollback')
  const setTrueIdx = on.indexOf('atomic_set_stream_flag "true"')
  assert.ok(armIdx >= 0, 'must arm fail-safe rollback')
  assert.ok(setTrueIdx > armIdx, 'arm must precede atomic_set true')
  const afterWrite = on.slice(setTrueIdx)
  const recreateRel = afterWrite.indexOf('if ! recreate_backend_only')
  const shaRel = afterWrite.indexOf('require_exact_deployed_sha "on-post-restart"')
  const liveFlagRel = afterWrite.indexOf('live stream flag is not true')
  const workerRel = afterWrite.indexOf('wait_for_worker_started')
  const lifeRel = afterWrite.indexOf('require_lifecycle_flags_off "on-post"')
  const artifactRel = afterWrite.indexOf('write_status_artifact "on_ok"')
  const summaryRel = afterWrite.indexOf('on_fail_safe_rollback_disarmed=true')
  const disarmRel = afterWrite.indexOf('disarm_stream_on_fail_safe_rollback')

  assert.ok(recreateRel >= 0, 'recreate after write')
  assert.ok(shaRel >= 0, 'post-restart SHA after write')
  assert.ok(liveFlagRel >= 0, 'live flag check after write')
  assert.ok(workerRel >= 0, 'worker_started after write')
  assert.ok(lifeRel >= 0, 'lifecycle post after write')
  assert.ok(artifactRel > workerRel && artifactRel > lifeRel, 'artifact after post checks')
  assert.ok(summaryRel > artifactRel, 'summary lines after write_status_artifact')
  assert.ok(disarmRel > summaryRel, 'disarm only after artifact + summary writes')
  assert.ok(disarmRel > shaRel && disarmRel > workerRel && disarmRel > lifeRel)

  // Manual restore-only path without arm is insufficient; arm is required.
  assert.match(on, /fail-safe rollback armed|fail-safe rollback ARMED|arm_stream_on_fail_safe_rollback/)
})

test('action=on post-write rollback covers every later failure and signal (load-bearing mutation)', () => {
  // Removing arm, moving disarm before checks, or reintroducing return-only INT/TERM trap
  // must redden this test.
  const source = read(REMOTE_SH)
  const on = actionBody(source, 'action_on', ['action_off'])

  // Every post-write check is inside the armed window (between arm and disarm).
  const armIdx = on.indexOf('arm_stream_on_fail_safe_rollback')
  const disarmIdx = on.indexOf('disarm_stream_on_fail_safe_rollback')
  assert.ok(armIdx >= 0 && disarmIdx > armIdx)
  const armedWindow = on.slice(armIdx, disarmIdx)
  for (const needle of [
    'atomic_set_stream_flag "true"',
    'if ! recreate_backend_only',
    'require_exact_deployed_sha "on-post-restart"',
    'live stream flag is not true',
    'wait_for_worker_started',
    'require_lifecycle_flags_off "on-post"',
    'write_status_artifact "on_ok"',
  ]) {
    assert.ok(
      armedWindow.includes(needle),
      `armed window must include post-write step: ${needle}`,
    )
  }

  // Rollback body must force false + recreate and report result.
  assert.match(source, /stream_on_fail_safe_rollback\(\)[\s\S]*?atomic_set_stream_flag\s+"false"[\s\S]*?recreate_backend_only/)
  assert.match(source, /on_fail_safe_rollback=/)

  // Signal handling: no cleanup_ephemeral-only trap action; INT/TERM exit.
  assert.doesNotMatch(source, /^[ \t]*trap[ \t]+cleanup_ephemeral\b/m)
  assert.match(source, /on_script_trap\(\)[\s\S]*?INT\)[\s\S]*?exit 130/)
  assert.match(source, /on_script_trap\(\)[\s\S]*?TERM\)[\s\S]*?exit 143/)
  // Trap invokes rollback then cleanup (order).
  const trapBody = source.slice(
    source.indexOf('on_script_trap()'),
    source.indexOf("trap 'on_script_trap EXIT'"),
  )
  const rbIdx = trapBody.indexOf('stream_on_fail_safe_rollback')
  const clIdx = trapBody.indexOf('cleanup_ephemeral')
  assert.ok(rbIdx >= 0 && clIdx > rbIdx, 'trap must rollback then cleanup_ephemeral')
})

test('on_script_trap EXIT preserves nonzero status; stubbed rollback runs exactly once (dynamic)', () => {
  // Dynamic proof of the $? ordering P1:
  // Armed post-write failure → EXIT trap → rollback once → process exits nonzero.
  // If saved_rc is captured after `local reason=...`, trap body success can exit 0.
  const source = read(REMOTE_SH)
  const trapStart = source.indexOf('on_script_trap()')
  assert.notEqual(trapStart, -1)
  const trapEnd = source.indexOf("\ntrap 'on_script_trap EXIT'", trapStart)
  assert.notEqual(trapEnd, -1)
  const trapFn = source.slice(trapStart, trapEnd).trim()
  // Guard: extracted body still has the load-bearing first-statement capture.
  assert.match(trapFn, /^on_script_trap\(\)\s*\{\s*local saved_rc=\$\?/m)

  const dir = mkdtempSync(join(tmpdir(), 'stream-uat-trap-'))
  const outFile = join(dir, 'rollback.count')
  const scriptFile = join(dir, 'trap-probe.sh')
  const script = `set -euo pipefail
OUT="${outFile}"
ROLLBACK_COUNT=0
STREAM_ON_ROLLBACK_ARMED=true
STREAM_ON_SUCCESS=false
STREAM_ON_ROLLBACK_DONE=false
TRAP_IN_PROGRESS=false

stream_on_fail_safe_rollback() {
  # Stub: count invocations only (no docker / env mutation).
  ROLLBACK_COUNT=$((ROLLBACK_COUNT + 1))
  printf 'rollback_count=%s\\n' "$ROLLBACK_COUNT" >> "$OUT"
}

cleanup_ephemeral() {
  :
}

${trapFn}

trap 'on_script_trap EXIT' EXIT

# Simulate armed post-write failure (e.g. require_exact_deployed_sha / wait_for_worker_started).
exit 17
`
  try {
    writeFileSync(scriptFile, script, 'utf8')
    const result = spawnSync('bash', [scriptFile], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    assert.notEqual(
      result.status,
      0,
      `armed EXIT trap must not turn failed on-action green; status=${result.status} stderr=${result.stderr}`,
    )
    assert.equal(
      result.status,
      17,
      `EXIT trap must re-exit with original nonzero status 17, got ${result.status}`,
    )
    assert.ok(existsSync(outFile), 'stubbed rollback must write count file')
    const countOut = readFileSync(outFile, 'utf8').trim()
    assert.equal(
      countOut,
      'rollback_count=1',
      `stubbed rollback must run exactly once, got: ${JSON.stringify(countOut)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('action=on live STREAM_INTEGRATION_ID equals uniquely-derived anchor via file_digest vs env_key_digest_in_container', () => {
  // SPECIFICALLY NAMED load-bearing mutation test.
  // Fails if the comparison lines are removed from require_stream_prerequisites_for_on.
  // Presence + "DB has one eligible anchor" alone must NOT pass; live env id must equal
  // the uniquely-derived anchor via digests (never print ID).
  const source = read(REMOTE_SH)
  const prereqStart = source.indexOf('require_stream_prerequisites_for_on()')
  assert.notEqual(prereqStart, -1, 'require_stream_prerequisites_for_on must exist')
  const prereqEnd = source.indexOf('\n# --- artifact writers', prereqStart)
  assert.notEqual(prereqEnd, -1)
  const prereq = source.slice(prereqStart, prereqEnd)

  // After unique anchor probe: secure materialize.
  assert.match(prereq, /derive_exact_integration_id_file\s+"on"/)
  assert.match(prereq, /INTEGRATION_ID_FILE/)

  // INLINE comparison lines (not only a helper call) — removal of these fails this test.
  assert.match(
    prereq,
    /dig_want="\$\(file_digest "\$INTEGRATION_ID_FILE"\)"/,
    'require_stream_prerequisites_for_on must call file_digest on INTEGRATION_ID_FILE',
  )
  assert.match(
    prereq,
    /dig_live="\$\(env_key_digest_in_container "\$KEY_STREAM_INTEGRATION_ID"\)"/,
    'require_stream_prerequisites_for_on must call env_key_digest_in_container on KEY_STREAM_INTEGRATION_ID',
  )
  assert.match(
    prereq,
    /\[\[\s*"\$dig_live"\s*!=\s*"\$dig_want"\s*\]\]/,
    'require_stream_prerequisites_for_on must compare dig_live != dig_want',
  )
  assert.match(
    prereq,
    /digest mismatch|does not match uniquely-derived eligible anchor/,
    'require_stream_prerequisites_for_on must fail closed on digest mismatch',
  )
  assert.match(prereq, /stale\/wrong|refuse stale/)
  assert.match(prereq, /values not printed|never print id/i)

  // Order is load-bearing: derive/materialize before digest compare.
  const deriveIdx = prereq.indexOf('derive_exact_integration_id_file "on"')
  const fileDigIdx = prereq.indexOf('file_digest "$INTEGRATION_ID_FILE"')
  const envDigIdx = prereq.indexOf('env_key_digest_in_container "$KEY_STREAM_INTEGRATION_ID"')
  const neIdx = prereq.indexOf('"$dig_live" != "$dig_want"')
  assert.ok(deriveIdx >= 0, 'derive_exact_integration_id_file "on" required')
  assert.ok(fileDigIdx > deriveIdx, 'file_digest must follow derive')
  assert.ok(envDigIdx > deriveIdx, 'env_key_digest_in_container must follow derive')
  assert.ok(neIdx > fileDigIdx && neIdx > envDigIdx, 'dig_live != dig_want must follow both digests')

  // Never print/log the raw id value in this function body.
  assert.doesNotMatch(prereq, /echo "\$\{?id_val/)
  assert.doesNotMatch(prereq, /log ".*\$\{?id_val/)
  assert.doesNotMatch(prereq, /printenv\s+\$KEY_STREAM_INTEGRATION_ID|printenv\s+DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID/)

  // action=on must call this prereq (not a weaker path).
  const on = actionBody(source, 'action_on', ['action_off'])
  assert.equal(
    (on.match(/require_stream_prerequisites_for_on/g) || []).length,
    2,
    'on must check the loaded integration anchor before and after backend recreate',
  )
  const recreateIdx = on.indexOf('recreate_backend_only')
  const firstGateIdx = on.indexOf('require_stream_prerequisites_for_on')
  const secondGateIdx = on.indexOf('require_stream_prerequisites_for_on', firstGateIdx + 1)
  assert.ok(firstGateIdx < recreateIdx)
  assert.ok(secondGateIdx > recreateIdx)
})

test('remote off is fail-safe: forces Stream false, restarts, verifies worker stopped', () => {
  const source = read(REMOTE_SH)
  const off = actionBody(source, 'action_off', ['action_https_on'])
  assert.match(off, /atomic_set_stream_flag\s+"false"/)
  assert.match(off, /recreate_backend_only/)
  assert.match(off, /wait_for_worker_disabled/)
  assert.match(off, /fail_safe_off|Fail-safe|fail-safe/)
  assert.match(source, /WORKER_DISABLED_MSG|worker disabled/)
  assert.doesNotMatch(off, /atomic_set_stream_flag\s+"true"/)
})

test('stream flag rewrite removes candidate files before either failure exit', () => {
  const source = read(REMOTE_SH)
  const body = actionBody(source, 'atomic_set_stream_flag', ['recreate_backend_only'])
  assert.match(
    body,
    /if ! python3[\s\S]*rm -f "\$py_script" "\$tmp"[\s\S]*fail "stream flag rewrite failed/,
  )
  assert.match(
    body,
    /if ! compose_staging_cmd_with_env_file[\s\S]*rm -f "\$tmp"[\s\S]*fail "candidate stream-flag env failed/,
  )
})

test('env replacement stays atomic when staging env parent is root-owned', () => {
  const source = read(REMOTE_SH)
  const replace = actionBody(source, 'atomic_replace_staging_env', [
    'atomic_upsert_env_keys_from_files',
  ])
  const upsert = actionBody(source, 'atomic_upsert_env_keys_from_files', [
    'compose_staging_cmd_with_env_file',
  ])
  const setFlag = actionBody(source, 'atomic_set_stream_flag', ['recreate_backend_only'])

  assert.match(replace, /if \[\[ -w "\$target_dir" \]\]/)
  assert.match(replace, /docker inspect -f '\{\{\.Config\.Image\}\}' "\$BACKEND_CONTAINER"/)
  assert.match(
    replace,
    /timeout 30s docker run --rm --pull never --network none --entrypoint \/bin\/sh/,
  )
  assert.match(replace, /type=bind,src=\$\{candidate\},dst=\/stream-uat-candidate,readonly/)
  assert.match(replace, /type=bind,src=\$\{target_dir\},dst=\/stream-uat-target/)
  assert.match(replace, /umask 077/)
  assert.match(replace, /cleanup_and_exit\(\) \{ cleanup; exit "\$1"; \}/)
  assert.match(replace, /trap "cleanup_and_exit 129" HUP/)
  assert.match(replace, /trap "cleanup_and_exit 130" INT/)
  assert.match(replace, /trap "cleanup_and_exit 143" TERM/)
  const chownIdx = replace.indexOf('chown "${STREAM_UAT_TARGET_UID}:${STREAM_UAT_TARGET_GID}"')
  const chmodIdx = replace.indexOf('chmod 600 "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"')
  const renameIdx = replace.indexOf('mv -f "/stream-uat-target/${STREAM_UAT_TARGET_TMP}"')
  assert.ok(chownIdx >= 0, 'helper must preserve the existing env owner/group')
  assert.ok(chmodIdx > chownIdx, 'helper must set mode after ownership')
  assert.ok(renameIdx > chmodIdx, 'helper must rename only after ownership and mode are final')
  assert.match(
    replace,
    /mv -f "\/stream-uat-target\/\$\{STREAM_UAT_TARGET_TMP\}" "\/stream-uat-target\/\$\{STREAM_UAT_TARGET_NAME\}"/,
  )
  assert.match(replace, /previous env retained/)
  assert.match(replace, /rm -f "\$candidate"/)
  assert.match(upsert, /atomic_replace_staging_env "\$tmp"/)
  assert.match(setFlag, /atomic_replace_staging_env "\$tmp"/)
  assert.doesNotMatch(upsert, /mv -f "\$tmp" "\$STAGING_ENV_FILE"/)
  assert.doesNotMatch(setFlag, /mv -f "\$tmp" "\$STAGING_ENV_FILE"/)
  assert.doesNotMatch(replace, /sudo/)
  assert.match(replace, /Rootless\/userns-remapped Docker fails closed/)
})

test('remote worker proofs use values-free log message classes only', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /DingTalk interactive-card Stream worker started/)
  assert.match(source, /DingTalk interactive-card Stream worker disabled/)
  assert.match(source, /DingTalk interactive-card Stream worker failed to start/)
  assert.match(source, /probe_worker_state_from_logs/)
  // Must not dump full docker logs to stdout.
  assert.doesNotMatch(source, /docker logs[^\n]*\| tee/)
  assert.doesNotMatch(source, /cat "\$tmp"/)
})

test('lane never claims stream_connected from worker_started logs; U12/U13 human-gated', () => {
  const source = read(REMOTE_SH)
  const yaml = read(WORKFLOW)
  // Explicit unknown constant + artifact key.
  assert.match(source, /STREAM_CONNECTED_UNKNOWN="unknown"/)
  assert.match(source, /stream_connected=\$\{STREAM_CONNECTED_UNKNOWN\}/)
  assert.match(source, /stream_connected remains unknown|stream_connected=unknown always/i)
  // Documents SDK connect() resolves + retries forever / not a connect proof.
  assert.match(source, /connect\(\) resolves|retries forever|NOT that the SDK is connected|not a connect proof/i)
  assert.match(source, /U12\/U13|u12_u13_human_gated/)
  // Never assign stream_connected=true from this lane.
  assert.doesNotMatch(source, /stream_connected=true/)
  assert.doesNotMatch(source, /STREAM_CONNECTED_UNKNOWN="true"/)
  assert.doesNotMatch(source, /stream_connected proven|connection proven|SDK connected proven/i)
  assert.match(yaml, /worker_started only|stream_connected stays unknown|U12\/U13 remain human-gated/)
  assert.doesNotMatch(yaml, /stream_connected=true|prove[sd]? connected|connection proven/i)
})

// --- no echo of secrets ---------------------------------------------------------------

test('workflow and remote script never echo secrets or raw credential env values', () => {
  const yaml = read(WORKFLOW)
  const source = read(REMOTE_SH)
  for (const body of [yaml, source]) {
    // Forbid echoing shell variables that hold secret material (names in prose are OK).
    assert.doesNotMatch(body, /echo\s+[\"']?\$\{?(_STREAM_CLIENT_ID|_STREAM_CLIENT_SECRET|_STREAM_TEMPLATE_ID)\b/)
    assert.doesNotMatch(body, /echo\s+[\"']?\$\{?(STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_ID|STAGING_DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET|STAGING_DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID)\b/)
    assert.doesNotMatch(body, /printenv\s+DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET/)
    assert.doesNotMatch(body, /printenv\s+DINGTALK_INTERACTIVE_CARD_CLIENT_ID/)
    assert.doesNotMatch(body, /cat\s+[\"']?\$\{?STREAM_CLIENT_SECRET_FILE/)
    assert.doesNotMatch(body, /cat\s+[\"']?\$\{?STREAM_CLIENT_ID_FILE/)
  }
  // Digest comparison only — sha256sum of values, never plaintext log.
  assert.match(source, /sha256sum/)
  assert.match(source, /env_key_digest_in_container|file_digest/)
  // Integration id written to file only.
  assert.match(source, /INTEGRATION_ID_FILE/)
  assert.doesNotMatch(source, /echo "\$\{?id_val/)
})

test('status artifacts emit only booleans/counts/reason classes/sha schema keys', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /schema=dingtalk-interactive-card-stream-staging-uat-status-v3/)
  for (const key of [
    'stream_enabled=',
    'client_id_present=',
    'client_secret_present=',
    'template_id_present=',
    'stream_integration_id_present=',
    'active_corp_anchored_integration_count=',
    'configured_corp_present=',
    'configured_corp_anchor_count=',
    'eligible_anchor_count=',
    'linked_local_users_for_eligible_anchor_count=',
    'single_configured_corp_eligible_anchor_ready=',
    'lifecycle_flags_all_off=',
    'log_level_ready=',
    'log_level_reason=',
    'worker_state=',
    'stream_connected=',
    'backend_health=',
    'deployed_sha=',
    'deployed_sha_match=',
    'https_port_80_listener=',
    'https_port_443_listener=',
    'https_port_80_docker_publishers=',
    'https_port_443_docker_publishers=',
    'https_sudo_noninteractive=',
    'https_host_nginx_present=',
    'https_host_caddy_present=',
    'https_host_certbot_present=',
    'https_gateway_container_running=',
    'https_gateway_health=',
    'https_gateway_image_match=',
    'https_env_backup_present=',
    'https_public_url_match=',
    'https_cors_origin_match=',
    'https_dingtalk_redirect_match=',
  ]) {
    assert.match(source, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  // stream_connected is always the unknown constant (never log-inferred true).
  assert.match(source, /echo "stream_connected=\$\{STREAM_CONNECTED_UNKNOWN\}"/)
  // Must not emit secret-like keys into artifacts.
  assert.doesNotMatch(source, /echo "client_id=/)
  assert.doesNotMatch(source, /echo "client_secret=/)
  assert.doesNotMatch(source, /echo "template_id=/)
  assert.doesNotMatch(source, /echo "integration_id=/)
  assert.doesNotMatch(source, /echo "corp_id=/)
})

// --- status read-only -----------------------------------------------------------------

test('status action is read-only: no env writes, no flag flips, no compose up', () => {
  const source = read(REMOTE_SH)
  const status = actionBody(source, 'action_status', ['action_observe'])
  assert.match(status, /write_status_artifact/)
  assert.doesNotMatch(status, /atomic_upsert_env_keys_from_files/)
  assert.doesNotMatch(status, /atomic_set_stream_flag/)
  assert.doesNotMatch(status, /recreate_backend_only/)
  assert.doesNotMatch(status, /compose_staging_cmd up/)
  assert.doesNotMatch(status, /mv -f/)
  assert.doesNotMatch(status, />>\s*"\$STAGING_ENV_FILE"/)
})

test('status reports only bounded HTTPS gateway facts', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /probe_https_gateway_status/)
  assert.match(source, /docker ps --format '\{\{\.Names\}\}\|\{\{\.Ports\}\}'/)
  assert.match(source, /sudo -n true/)
  assert.match(source, /https_port_80_docker_publishers=/)
  assert.match(source, /https_port_443_docker_publishers=/)
  assert.doesNotMatch(source, /docker inspect.*Env/)
})

test('https-on is pinned, exact-SHA gated, TLS-ALPN only, and rollback-armed', () => {
  const source = read(REMOTE_SH)
  const httpsOn = actionBody(source, 'action_https_on', ['action_https_off'])
  assert.match(source, /caddy:2\.10\.2-alpine@sha256:[0-9a-f]{64}/)
  assert.match(source, /disable_http_challenge/)
  assert.match(source, /auto_https disable_redirects/)
  assert.match(source, /"\$HTTPS_GATEWAY_IMAGE" caddy validate --config \/etc\/caddy\/Caddyfile/)
  assert.match(httpsOn, /require_exact_deployed_sha/)
  assert.match(httpsOn, /require_lifecycle_flags_off/)
  assert.match(httpsOn, /requires Stream OFF/)
  assert.match(httpsOn, /probe_tcp_listener 443/)
  assert.match(httpsOn, /getent ahostsv4 "\$HTTPS_GATEWAY_HOST"/)
  assert.match(httpsOn, /resolved_ip.*HTTPS_GATEWAY_EXPECTED_IP/)
  assert.match(httpsOn, /arm_https_on_fail_safe_rollback/)
  assert.match(httpsOn, /atomic_upsert_env_keys_from_files/)
  assert.match(httpsOn, /PUBLIC_APP_URL/)
  assert.match(httpsOn, /CORS_ORIGIN/)
  assert.match(httpsOn, /DINGTALK_REDIRECT_URI/)
  assert.match(httpsOn, /recreate_backend_only/)
  assert.match(httpsOn, /disarm_https_on_fail_safe_rollback/)
  assert.ok(
    httpsOn.indexOf('arm_https_on_fail_safe_rollback') < httpsOn.indexOf('docker run -d'),
    'rollback must arm before gateway mutation',
  )
})

test('HTTPS transitions never write the Stream flag', () => {
  const source = read(REMOTE_SH)
  const httpsOn = actionBody(source, 'action_https_on', ['action_https_off'])
  const httpsOff = actionBody(source, 'action_https_off')
  assert.doesNotMatch(httpsOn, /atomic_set_stream_flag/)
  assert.doesNotMatch(httpsOff, /atomic_set_stream_flag/)
})

test('HTTPS success requires a certificate valid for at least 24 hours', () => {
  const source = read(REMOTE_SH)
  const wait = actionBody(source, 'wait_for_https_gateway', ['require_https_live_env_matches'])
  assert.match(wait, /openssl s_client .* -servername "\$HTTPS_GATEWAY_HOST"/)
  assert.match(wait, /openssl x509 -checkend 86400 -noout/)
})

test('https-on rollback detects a completed env write and preserves the gateway when env restore fails', () => {
  const source = read(REMOTE_SH)
  const rollback = actionBody(source, 'https_on_fail_safe_rollback', ['arm_https_on_fail_safe_rollback'])
  assert.match(rollback, /https_env_file_matches_gateway[\s\S]*env_match_rc=\$\?/)
  assert.match(rollback, /HTTPS_ENV_WRITTEN.*true.*\|\|.*env_match_rc.*0/)
  assert.match(rollback, /env_match_rc.*2[\s\S]*env_was_switched="unknown"/)
  assert.match(rollback, /env_rc.*0.*&&.*recreate_rc.*0/)
  assert.match(rollback, /gateway_rc=2/)
  assert.match(rollback, /skipped_env_not_restored/)
  assert.match(
    rollback,
    /if \[\[ "\$env_was_switched" == "false" \|\| \( "\$env_rc" == "0" && "\$recreate_rc" == "0" \) \]\]; then\s+remove_https_gateway_if_present \|\| gateway_rc=1\s+else[\s\S]*?gateway_rc=2/,
  )
})

test('HTTPS env-state detection is tri-state and fails closed on unknown reads', () => {
  const source = read(REMOTE_SH)
  const detector = actionBody(source, 'https_env_file_matches_gateway', ['remove_https_gateway_if_present'])
  assert.match(detector, /STAGING_ENV_FILE.*\|\| return 2/)
  assert.match(detector, /UNKNOWN[\s\S]*return 2/)
  assert.doesNotMatch(detector, /UNKNOWN[\s\S]*return 1/)
})

test('HTTPS env restore changes only the three URL keys and preserves intervening env changes', () => {
  const source = read(REMOTE_SH)
  const restore = actionBody(source, 'restore_https_env_backup', ['https_env_file_matches_gateway'])
  assert.match(restore, /require_https_env_backup_integrity \|\| return 1/)
  assert.match(restore, /target_keys = \("PUBLIC_APP_URL", "CORS_ORIGIN", "DINGTALK_REDIRECT_URI"\)/)
  assert.match(restore, /read_lines\(current_path\)/)
  assert.match(restore, /backup_values/)
  assert.doesNotMatch(restore, /cp -p "\$HTTPS_ENV_BACKUP" "\$candidate"/)
})

test('HTTPS backup is checksum-sealed before gateway mutation and verified before restore', () => {
  const source = read(REMOTE_SH)
  const httpsOn = actionBody(source, 'action_https_on', ['action_https_off'])
  const httpsOff = actionBody(source, 'action_https_off')
  assert.match(httpsOn, /write_https_env_backup_checksum \|\| fail/)
  assert.ok(
    httpsOn.indexOf('write_https_env_backup_checksum') < httpsOn.indexOf('docker pull'),
    'backup must be sealed before gateway mutation',
  )
  assert.match(httpsOff, /require_https_env_backup_integrity \|\| fail/)
  assert.ok(
    httpsOff.indexOf('require_https_env_backup_integrity') <
      httpsOff.indexOf('restore_https_env_backup'),
    'backup integrity must be verified before restore',
  )
  assert.match(httpsOff, /rm -f "\$HTTPS_ENV_BACKUP" "\$HTTPS_ENV_BACKUP_SHA256"/)
})

test('HTTPS backup checksum detects tampering without printing values', () => {
  const source = read(REMOTE_SH)
  const writeChecksum = actionBody(source, 'write_https_env_backup_checksum', [
    'validate_legacy_https_env_backup',
  ])
  const validateLegacy = actionBody(source, 'validate_legacy_https_env_backup', [
    'require_https_env_backup_integrity',
  ])
  const requireIntegrity = actionBody(source, 'require_https_env_backup_integrity', [
    'restore_https_env_backup',
  ])
  const dir = mkdtempSync(join(tmpdir(), 'https-env-checksum-'))
  const backup = join(dir, 'backup.env')
  const checksum = join(dir, 'backup.env.sha256')
  try {
    writeFileSync(
      backup,
      [
        'PUBLIC_APP_URL=http://old.example',
        'CORS_ORIGIN=http://old.example',
        'DINGTALK_REDIRECT_URI=http://old.example/login/dingtalk/callback',
      ].join('\n') + '\n',
    )
    const harness = `
set -euo pipefail
HTTPS_ENV_BACKUP="$1"
HTTPS_ENV_BACKUP_SHA256="$2"
HTTPS_GATEWAY_ORIGIN="https://gateway.example"
HTTPS_GATEWAY_CALLBACK="https://gateway.example/login/dingtalk/callback"
HTTPS_ENV_BACKUP_LEGACY_SEALED=false
RUN_STAMP=test
register_ephemeral() { :; }
${writeChecksum}
${validateLegacy}
${requireIntegrity}
write_https_env_backup_checksum
require_https_env_backup_integrity
printf '\\n# tampered\\n' >>"$HTTPS_ENV_BACKUP"
if require_https_env_backup_integrity; then
  exit 19
fi
`
    const result = spawnSync('bash', ['-c', harness, 'bash', backup, checksum], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy HTTPS backup adoption accepts one coherent prior URL triplet and rejects ambiguity', () => {
  const source = read(REMOTE_SH)
  const validator = actionBody(source, 'validate_legacy_https_env_backup', [
    'require_https_env_backup_integrity',
  ])
  const match = validator.match(/<<'PY'\n([\s\S]*?)\nPY/)
  assert.ok(match, 'legacy backup validator must be extractable')
  const dir = mkdtempSync(join(tmpdir(), 'https-legacy-backup-'))
  const backup = join(dir, 'backup.env')
  const run = () =>
    spawnSync(
      'python3',
      [
        '-c',
        match[1],
        backup,
        'https://gateway.example',
        'https://gateway.example/login/dingtalk/callback',
      ],
      { encoding: 'utf8' },
    )
  try {
    writeFileSync(
      backup,
      [
        'PUBLIC_APP_URL=http://old.example',
        'CORS_ORIGIN=http://old.example',
        'DINGTALK_REDIRECT_URI=http://old.example/login/dingtalk/callback',
      ].join('\n') + '\n',
    )
    assert.equal(run().status, 0)

    writeFileSync(
      backup,
      [
        'PUBLIC_APP_URL=http://old.example',
        'PUBLIC_APP_URL=http://other.example',
        'CORS_ORIGIN=http://old.example',
        'DINGTALK_REDIRECT_URI=http://old.example/login/dingtalk/callback',
      ].join('\n') + '\n',
    )
    assert.notEqual(run().status, 0, 'duplicate URL keys must be rejected')

    writeFileSync(
      backup,
      [
        'PUBLIC_APP_URL=https://gateway.example',
        'CORS_ORIGIN=https://gateway.example',
        'DINGTALK_REDIRECT_URI=https://gateway.example/login/dingtalk/callback',
      ].join('\n') + '\n',
    )
    assert.notEqual(run().status, 0, 'already-gateway snapshot must be rejected')

    writeFileSync(
      backup,
      ['PUBLIC_APP_URL=http://old.example', 'CORS_ORIGIN=http://old.example'].join('\n') + '\n',
    )
    assert.notEqual(run().status, 0, 'truncated snapshot must be rejected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTPS restore helper dynamically restores only URL keys and removes backup-missing keys', () => {
  const source = read(REMOTE_SH)
  const restore = actionBody(source, 'restore_https_env_backup', ['https_env_file_matches_gateway'])
  const match = restore.match(/cat >"\$py_script" <<'PY'\n([\s\S]*?)\nPY/)
  assert.ok(match, 'embedded targeted restore script must be extractable')

  const dir = mkdtempSync(join(tmpdir(), 'https-env-restore-'))
  const current = join(dir, 'current.env')
  const backup = join(dir, 'backup.env')
  const candidate = join(dir, 'candidate.env')
  try {
    writeFileSync(
      current,
      [
        'PUBLIC_APP_URL=https://gateway.example',
        'CORS_ORIGIN=https://gateway.example',
        'DINGTALK_REDIRECT_URI=https://gateway.example/login/dingtalk/callback',
        'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=true',
        'ROTATED_CREDENTIAL=new-marker',
      ].join('\n') + '\n',
    )
    writeFileSync(
      backup,
      [
        'PUBLIC_APP_URL=http://old.example',
        'CORS_ORIGIN=http://old.example',
        'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=false',
        'ROTATED_CREDENTIAL=old-marker',
      ].join('\n') + '\n',
    )
    const result = spawnSync('python3', ['-c', match[1], current, backup, candidate], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const restored = read(candidate)
    assert.match(restored, /^PUBLIC_APP_URL=http:\/\/old\.example$/m)
    assert.match(restored, /^CORS_ORIGIN=http:\/\/old\.example$/m)
    assert.doesNotMatch(restored, /^DINGTALK_REDIRECT_URI=/m)
    assert.match(restored, /^DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=true$/m)
    assert.match(restored, /^ROTATED_CREDENTIAL=new-marker$/m)
    assert.doesNotMatch(restored, /old-marker/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('https-off verifies restored live env and fails closed until the gateway is absent', () => {
  const source = read(REMOTE_SH)
  const httpsOff = actionBody(source, 'action_https_off')
  assert.match(httpsOff, /restore_https_env_backup/)
  assert.match(httpsOff, /recreate_backend_only/)
  assert.match(httpsOff, /require_https_live_env_matches_backup/)
  assert.match(httpsOff, /require_lifecycle_flags_off/)
  assert.match(httpsOff, /requires Stream OFF/)
  assert.match(httpsOff, /HTTPS env backup integrity check failed/)
  assert.match(httpsOff, /remove_https_gateway_if_present \|\| fail/)
  assert.match(httpsOff, /rm -f "\$HTTPS_ENV_BACKUP" "\$HTTPS_ENV_BACKUP_SHA256"/)
  assert.doesNotMatch(httpsOff, /docker rm -f[\s\S]*\|\| true/)
  assert.ok(
    httpsOff.indexOf('restore_https_env_backup') < httpsOff.indexOf('remove_https_gateway_if_present'),
    'env/backend restore must precede gateway removal',
  )
  assert.ok(
    httpsOff.indexOf('remove_https_gateway_if_present') < httpsOff.indexOf('write_status_artifact'),
    'status success must follow verified gateway removal',
  )
})

test('gateway removal helper treats absence as success but verifies a present container is gone', () => {
  const source = read(REMOTE_SH)
  const remove = actionBody(source, 'remove_https_gateway_if_present', ['https_on_fail_safe_rollback'])
  assert.match(remove, /if ! docker inspect/)
  assert.match(remove, /docker rm -f .* \|\| return 1/)
  assert.match(remove, /! docker inspect/)
})

// --- lifecycle isolation --------------------------------------------------------------

test('lane never writes lifecycle flags true; only reads them for guard/status', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /AUTH_LOGIN_USE_ALIASES/)
  assert.match(source, /DIRECTORY_PENDING_ACTIVATION_ENABLED/)
  assert.match(source, /DIRECTORY_DEPROVISION_ENABLED/)
  assert.match(source, /require_lifecycle_flags_off|read_lifecycle_all_off/)
  assert.doesNotMatch(source, /AUTH_LOGIN_USE_ALIASES=true/)
  assert.doesNotMatch(source, /DIRECTORY_PENDING_ACTIVATION_ENABLED=true/)
  assert.doesNotMatch(source, /DIRECTORY_DEPROVISION_ENABLED=true/)
  // Stream true only via action=on path flag setter.
  assert.match(source, /atomic_set_stream_flag\s+"true"/)
})

// --- staging rails --------------------------------------------------------------------

test('remote script enforces staging-only containers and recreate backend-only safety', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /assert_staging_only/)
  assert.match(source, /metasheet-staging-backend/)
  assert.match(source, /metasheet-staging-postgres/)
  assert.match(source, /refusing production fallback|PROD-track/)
  assert.match(source, /recreate_backend_only/)
  assert.match(source, /--no-deps --force-recreate backend/)
  assert.match(source, /postgres\/redis untouched/)
  // Unified EXIT/INT/TERM trap cleans ephemerals (and on-armed Stream rollback).
  assert.match(source, /trap 'on_script_trap EXIT' EXIT/)
  assert.match(source, /trap 'on_script_trap HUP' HUP/)
  assert.match(source, /trap 'on_script_trap INT' INT/)
  assert.match(source, /trap 'on_script_trap TERM' TERM/)
  assert.match(source, /on_script_trap PIPE' PIPE/)
  assert.match(source, /cleanup_ephemeral/)
  assert.match(source, /chmod 600/)
  assert.match(source, /mktemp/)
})

test('workflow does not claim to implement human U1-U13 clicks; U12/U13 human-gated', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /Does NOT implement human U1/)
  assert.match(yaml, /U12\/U13 remain human-gated/)
  assert.doesNotMatch(yaml, /U1–U13 automated/)
  assert.doesNotMatch(yaml, /U12\/U13 automated/)
})
