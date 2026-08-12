#!/usr/bin/env node
// dingtalk-interactive-card-stream-staging-uat-contract.test.mjs
//
// Durable synthetic contract for the MINIMAL controlled Stream staging UAT lane:
//   EXECUTABLE: status | prepare | on | off
//
// Load-bearing rails:
//   * workflow wiring (dispatch choices, SSH, concurrency, no schedule)
//   * exact-SHA gate for prepare/on/off
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

test('workflow action choices are status/prepare/on/off with status default', () => {
  const doc = loadYaml(read(WORKFLOW))
  const inputs = workflowOn(doc).workflow_dispatch.inputs
  assert.deepEqual(inputs.action.options, ['status', 'prepare', 'on', 'off'])
  assert.equal(inputs.action.default, 'status')
  // Quote on/off so YAML 1.1 keeps strings (loadYaml may coerce bare on/off).
  const yaml = read(WORKFLOW)
  assert.match(yaml, /options:\s*\[status,\s*prepare,\s*'on',\s*'off'\]/)
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

// --- exact-SHA gate -------------------------------------------------------------------

test('workflow exact-SHA gate requires full 40-char deploy_sha for prepare/on/off', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.equal(validate.env.DEPLOY_SHA, '${{ inputs.deploy_sha }}')
  assert.match(validate.run, /ACTION" == "prepare" \|\| "\$ACTION" == "on" \|\| "\$ACTION" == "off"/)
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

test('remote script require_exact_deployed_sha used by prepare/on/off and not status-only path', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /require_exact_deployed_sha/)
  assert.match(source, /resolve_deployed_sha/)
  const prepare = actionBody(source, 'action_prepare', ['action_on'])
  const on = actionBody(source, 'action_on', ['action_off'])
  const off = actionBody(source, 'action_off')
  const status = actionBody(source, 'action_status', ['action_prepare'])
  assert.match(prepare, /require_exact_deployed_sha/)
  assert.match(on, /require_exact_deployed_sha/)
  assert.match(off, /require_exact_deployed_sha/)
  assert.doesNotMatch(status, /require_exact_deployed_sha/)
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
  const off = actionBody(source, 'action_off')
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
  assert.match(source, /schema=dingtalk-interactive-card-stream-staging-uat-status-v2/)
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
  const status = actionBody(source, 'action_status', ['action_prepare'])
  assert.match(status, /write_status_artifact/)
  assert.doesNotMatch(status, /atomic_upsert_env_keys_from_files/)
  assert.doesNotMatch(status, /atomic_set_stream_flag/)
  assert.doesNotMatch(status, /recreate_backend_only/)
  assert.doesNotMatch(status, /compose_staging_cmd up/)
  assert.doesNotMatch(status, /mv -f/)
  assert.doesNotMatch(status, />>\s*"\$STAGING_ENV_FILE"/)
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
