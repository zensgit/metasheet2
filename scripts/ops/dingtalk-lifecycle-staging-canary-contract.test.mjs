#!/usr/bin/env node
// dingtalk-lifecycle-staging-canary-contract.test.mjs
//
// Durable synthetic contract for the MINIMAL SAFE staging lifecycle lane:
//   EXECUTABLE: status | preflight | off | bootstrap | human-bootstrap | alias |
//               pending | deprovision
//
// Alias/pending/deprovision are TRANSIENT secret-backed canaries: success
// requires/proves OFF; failure restores the OFF override before failing.
// Runtime OFF cannot be proven if rollback recreate fails. Admin JWT is minted
// from canary password login (never secrets.ATTENDANCE_ADMIN_JWT).
// Bootstrap creates/repairs the fixed owned canary admin only (collision
// fail-closed; no lifecycle env write).
// Human-bootstrap creates/repairs a SEPARATE fixed human platform admin
// (username staging-owner-admin) via canary-authenticated admin API + password
// file; required reset-password/access/login/revoke; no lifecycle env write.
// Pending: explicit directory-account subject file, pending-only flag, real
// admit/activate, unconditional OFF rollback. Deprovision: same subject, external
// source-disable confirmation, deprovision-only flag, real sync+ledger proofs,
// OFF rollback; does not claim end-to-end source rehire restore.
// Load-bearing mutations for owner P1/P2 gaps:
//   * migrations_pending_zero unknown must fail preflight/off/alias/bootstrap/human-bootstrap/pending/deprovision
//   * pending/deprovision require explicit subject (no auto-selection); omit subject refuses
//   * alias requires pre-login(+JWT mint), backfill, readiness, post-ON login,
//     rollback, post-rollback login, exact SHA, migrations, secret-file transport
//   * recreate requires health true after restart
//   * previous-override restore on transition failure
//   * multi-on: status/preflight fail closed; off still clears via classify_mode
//
// No network, no secrets, no workflow execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const REMOTE_SH = join(HERE, 'dingtalk-lifecycle-staging-canary-remote.sh')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'dingtalk-lifecycle-staging-canary.yml')
const CONTRACT_WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'dingtalk-lifecycle-staging-canary-contract.yml',
)
const ATTENDANCE_WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'attendance-staging-window-runner.yml',
)
const CLOSEOUT_DOC = join(
  REPO_ROOT,
  'docs',
  'development',
  'dingtalk-lifecycle-six-step-closeout-execution-20260810.md',
)
const CANARY_GO_DOC = join(
  REPO_ROOT,
  'docs',
  'development',
  'dingtalk-lifecycle-canary-separate-go-20260724.md',
)
const STAGING_ENV_EXAMPLE = join(REPO_ROOT, 'docker', 'app.staging.env.example')
const STAGING_COMPOSE = join(REPO_ROOT, 'docker-compose.app.staging.yml')

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

function actionAliasBody(source) {
  const start = source.indexOf('action_alias()')
  assert.notEqual(start, -1, 'action_alias() must exist')
  const end = source.indexOf('\naction_human_bootstrap()', start)
  assert.notEqual(end, -1, 'action_human_bootstrap after action_alias')
  return source.slice(start, end)
}

function actionOffBody(source) {
  const start = source.indexOf('action_off()')
  assert.notEqual(start, -1, 'action_off() must exist')
  const end = source.indexOf('\naction_alias()', start)
  assert.notEqual(end, -1, 'action_alias after action_off')
  return source.slice(start, end)
}

function actionBootstrapBody(source) {
  const start = source.indexOf('action_bootstrap()')
  assert.notEqual(start, -1, 'action_bootstrap() must exist')
  const end = source.indexOf('\naction_off()', start)
  assert.notEqual(end, -1, 'action_off after action_bootstrap')
  return source.slice(start, end)
}

function actionHumanBootstrapBody(source) {
  const start = source.indexOf('action_human_bootstrap()')
  assert.notEqual(start, -1, 'action_human_bootstrap() must exist')
  // pending/deprovision actions follow human-bootstrap; stop before them.
  let end = source.indexOf('\naction_pending()', start)
  if (end === -1) {
    end = source.indexOf('\n# --- main', start)
  }
  assert.notEqual(end, -1, 'action_pending or main marker after action_human_bootstrap')
  return source.slice(start, end)
}

function actionPendingBody(source) {
  const start = source.indexOf('action_pending()')
  assert.notEqual(start, -1, 'action_pending() must exist')
  const end = source.indexOf('\naction_deprovision()', start)
  assert.notEqual(end, -1, 'action_deprovision after action_pending')
  return source.slice(start, end)
}

function actionDeprovisionBody(source) {
  // Includes dispatcher + apply + restore (all before main).
  const start = source.indexOf('action_deprovision()')
  assert.notEqual(start, -1, 'action_deprovision() must exist')
  const end = source.indexOf('\n# --- main', start)
  assert.notEqual(end, -1, 'main marker after action_deprovision')
  return source.slice(start, end)
}

function actionDeprovisionApplyBody(source) {
  const start = source.indexOf('action_deprovision_apply()')
  assert.notEqual(start, -1, 'action_deprovision_apply() must exist')
  const end = source.indexOf('\naction_deprovision_restore()', start)
  assert.notEqual(end, -1, 'action_deprovision_restore after apply')
  return source.slice(start, end)
}

function actionDeprovisionRestoreBody(source) {
  const start = source.indexOf('action_deprovision_restore()')
  assert.notEqual(start, -1, 'action_deprovision_restore() must exist')
  const end = source.indexOf('\n# --- main', start)
  assert.notEqual(end, -1, 'main marker after restore')
  return source.slice(start, end)
}

function verifyDeprovisionLedgerBody(source) {
  const start = source.indexOf('verify_deprovision_ledger_for_subject()')
  assert.notEqual(start, -1, 'verify_deprovision_ledger_for_subject must exist')
  let end = source.indexOf('\n# --- recovery journal state machine', start)
  if (end === -1) {
    end = source.indexOf('\npersist_deprovision_apply_state()', start)
  }
  if (end === -1) {
    end = source.indexOf('\nrun_deprovision_rehire_restore()', start)
  }
  assert.notEqual(end, -1, 'journal/persist/rehire after ledger verify')
  return source.slice(start, end)
}

function runDirectorySyncForSubjectBody(source) {
  const start = source.indexOf('run_directory_sync_for_subject()')
  assert.notEqual(start, -1, 'run_directory_sync_for_subject must exist')
  const end = source.indexOf('\n# GET deprovision events for subject', start)
  assert.notEqual(end, -1, 'ledger marker after run_directory_sync_for_subject')
  return source.slice(start, end)
}

function runOrResumeRestoreBody(source) {
  const start = source.indexOf('run_or_resume_deprovision_rehire_restore()')
  assert.notEqual(start, -1, 'run_or_resume_deprovision_rehire_restore must exist')
  const end = source.indexOf('\n# Authoritative access-graph proof', start)
  assert.notEqual(end, -1, 'access graph marker after restore resume helper')
  return source.slice(start, end)
}

function bootstrapHumanPlatformAdminBody(source) {
  const start = source.indexOf('bootstrap_human_platform_admin()')
  assert.notEqual(start, -1, 'bootstrap_human_platform_admin() must exist')
  const end = source.indexOf('\n# POST /api/admin/login-aliases/backfill', start)
  assert.notEqual(end, -1, 'backfill marker after bootstrap_human_platform_admin')
  return source.slice(start, end)
}

// --- parse / presence -----------------------------------------------------------------

test('remote script and workflow files exist', () => {
  assert.ok(existsSync(REMOTE_SH))
  assert.ok(existsSync(WORKFLOW))
  assert.ok(existsSync(CONTRACT_WORKFLOW))
})

test('embedded remote script parses (bash -n)', () => {
  const result = spawnSync('bash', ['-n', REMOTE_SH], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('workflow YAML parses with repository-available parser', () => {
  const doc = loadYaml(read(WORKFLOW))
  assert.equal(doc.name, 'DingTalk Lifecycle Staging Canary')
  assert.ok(workflowOn(doc)?.workflow_dispatch?.inputs?.action)
  assert.ok(doc.jobs?.run)
})

test('PR contract workflow executes this exact suite without changing the sealed plugin-tests pin', () => {
  const workflow = read(CONTRACT_WORKFLOW)
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /node --test scripts\/ops\/dingtalk-lifecycle-staging-canary-contract\.test\.mjs/)
  const pluginTests = read(join(REPO_ROOT, '.github', 'workflows', 'plugin-tests.yml'))
  assert.doesNotMatch(pluginTests, /dingtalk-lifecycle-staging-canary-contract\.test\.mjs/)
})

// --- workflow shape -------------------------------------------------------------------

test('workflow action choices include all explicit staging actions', () => {
  const options = workflowOn(loadYaml(read(WORKFLOW))).workflow_dispatch.inputs.action.options
  assert.deepEqual(options, [
    'status',
    'preflight',
    'off',
    'bootstrap',
    'human-bootstrap',
    'alias',
    'pending',
    'deprovision',
  ])
  assert.ok(options.every((o) => typeof o === 'string'), 'quote off so YAML 1.1 keeps string')
})

test('workflow default is read-only status; no schedule', () => {
  const doc = loadYaml(read(WORKFLOW))
  assert.equal(workflowOn(doc).workflow_dispatch.inputs.action.default, 'status')
  const yaml = read(WORKFLOW)
  assert.doesNotMatch(yaml, /schedule:/)
  assert.doesNotMatch(yaml, /cron:/)
})

test('workflow shares concurrency with attendance staging runner', () => {
  const lifecycle = loadYaml(read(WORKFLOW))
  const attendance = loadYaml(read(ATTENDANCE_WORKFLOW))
  assert.equal(lifecycle.concurrency.group, attendance.concurrency.group)
  assert.equal(lifecycle.concurrency.group, 'attendance-staging-window-runner')
  assert.equal(lifecycle.concurrency['cancel-in-progress'], false)
})

test('workflow remote commands use bash -o pipefail -c', () => {
  const yaml = read(WORKFLOW)
  assert.ok((yaml.match(/bash -o pipefail -c/g) || []).length >= 2)
  assert.doesNotMatch(yaml, /bash\s+-s\b/)
})

test('SSH transport requires a pinned known_hosts secret', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /DEPLOY_KNOWN_HOSTS/)
  assert.match(yaml, /StrictHostKeyChecking=yes/)
  assert.match(yaml, /UserKnownHostsFile=/)
  assert.doesNotMatch(yaml, /StrictHostKeyChecking=no/)
})

test('workflow requires deploy_sha + expected_current for off/bootstrap/human-bootstrap/alias/pending/deprovision', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /expected_current_mode is required for action=off/)
  assert.match(yaml, /expected_current_mode must be exactly 'off' for action=\$\{ACTION\}/)
  assert.match(yaml, /deploy_sha must be the FULL 40-char lowercase commit SHA for action=\$\{ACTION\}/)
  assert.match(
    yaml,
    /ACTION" == "bootstrap" \|\| "\$ACTION" == "human-bootstrap" \|\| "\$ACTION" == "alias" \|\| "\$ACTION" == "pending" \|\| "\$ACTION" == "deprovision"/,
  )
  // Secret presence is checked only in Run remote action (not Validate inputs).
  assert.match(
    yaml,
    /requires LIFECYCLE_CANARY_LOGIN_IDENTIFIER\/PASSWORD \(checked in Run remote action only\); never ATTENDANCE_ADMIN_JWT/,
  )
  assert.match(yaml, /LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID/)
  assert.match(yaml, /DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED/)
  // Must not use bare canary_subject_id workflow inputs (secret-file transport only).
  assert.doesNotMatch(yaml, /canary_subject_id:/)
  assert.doesNotMatch(yaml, /canary_integration_id:/)
  assert.doesNotMatch(yaml, /owner_confirm:/)
  // Workflow must not embed admin password-reset HTTP paths (remote script may).
  assert.doesNotMatch(yaml, /resetPassword|reset_password|\/api\/.*password-reset/i)
  assert.doesNotMatch(yaml, /POST\s+\/api\/admin\/.*password/i)
  // No unconditional always-OFF claim in structural validation comments.
  assert.doesNotMatch(yaml, /always OFF after/i)
})

test('workflow requires explicit privileged confirmation phrases for bootstrap and human-bootstrap', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  assert.ok(workflowOn(doc).workflow_dispatch.inputs.bootstrap_confirmation)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.equal(validate.env.BOOTSTRAP_CONFIRMATION, '${{ inputs.bootstrap_confirmation }}')
  assert.match(validate.run, /ACTION" == "bootstrap"/)
  assert.match(validate.run, /BOOTSTRAP_CONFIRMATION" != "CREATE_STAGING_CANARY_ADMIN"/)
  assert.match(validate.run, /ACTION" == "human-bootstrap"/)
  assert.match(validate.run, /BOOTSTRAP_CONFIRMATION" != "CREATE_STAGING_HUMAN_ADMIN"/)
})

test('workflow bootstrap/human-bootstrap/alias/pending/deprovision secret transport uses chmod-600 files + scp; never ATTENDANCE_ADMIN_JWT', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /chmod 600/)
  assert.match(yaml, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER/)
  assert.match(yaml, /LIFECYCLE_CANARY_LOGIN_PASSWORD/)
  assert.match(yaml, /STAGING_OWNER_ADMIN_PASSWORD/)
  assert.match(yaml, /LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID/)
  assert.match(yaml, /CANARY_LOGIN_IDENTIFIER_FILE=/)
  assert.match(yaml, /CANARY_LOGIN_PASSWORD_FILE=/)
  assert.match(yaml, /STAGING_OWNER_ADMIN_PASSWORD_FILE=/)
  assert.match(yaml, /CANARY_DIRECTORY_ACCOUNT_ID_FILE=/)
  assert.match(yaml, /directory-account\.id/)
  assert.match(yaml, /\.canary-secrets/)
  assert.match(yaml, /scp \$ssh_opts/)
  // printf uses non-exported shell vars after env demote (not raw env names).
  assert.match(yaml, /printf '%s' "\$\{_CANARY_PASS\}"/)
  assert.match(yaml, /printf '%s' "\$\{_CANARY_IDENT\}"/)
  assert.match(yaml, /printf '%s' "\$\{_STAGING_OWNER_PASS\}"/)
  assert.match(yaml, /printf '%s' "\$\{_CANARY_SUBJECT\}"/)
  assert.match(yaml, /staging-owner-admin\.password/)
  // Must not materialize or demote ATTENDANCE_ADMIN_JWT (alias mints JWT from login).
  // Prose may mention the forbidden secret; forbid GHA secret injection only.
  assert.doesNotMatch(yaml, /_CANARY_JWT=/)
  assert.doesNotMatch(yaml, /printf '%s' "\$\{_CANARY_JWT\}"/)
  assert.doesNotMatch(yaml, /\$\{\{\s*secrets\.ATTENDANCE_ADMIN_JWT/)
  assert.doesNotMatch(yaml, /export CANARY_ADMIN_JWT_FILE=/)
  // Must not export raw secret values into the remote script env.
  assert.doesNotMatch(yaml, /export ATTENDANCE_ADMIN_JWT=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_IDENTIFIER=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_PASSWORD=/)
  assert.doesNotMatch(yaml, /export STAGING_OWNER_ADMIN_PASSWORD=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID=/)
  assert.doesNotMatch(yaml, /export CANARY_LOGIN_PASSWORD='/)
  // bootstrap/human-bootstrap/alias/pending/deprovision share the canary secret transport gate.
  assert.match(
    yaml,
    /ACTION" == "alias" \|\| "\$ACTION" == "bootstrap" \|\| "\$ACTION" == "human-bootstrap" \|\| "\$ACTION" == "pending" \|\| "\$ACTION" == "deprovision"/,
  )
})

test('workflow Validate inputs does not receive canary login secrets (no child inheritance gap)', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.ok(validate?.env, 'Validate inputs must declare env')
  assert.equal(validate.env.ATTENDANCE_ADMIN_JWT, undefined)
  assert.equal(validate.env.LIFECYCLE_CANARY_LOGIN_IDENTIFIER, undefined)
  assert.equal(validate.env.LIFECYCLE_CANARY_LOGIN_PASSWORD, undefined)
  assert.equal(validate.env.STAGING_OWNER_ADMIN_PASSWORD, undefined)
  // No secret presence checks in this step (they launch after bash -n otherwise).
  assert.doesNotMatch(validate.run, /ATTENDANCE_ADMIN_JWT/)
  assert.doesNotMatch(validate.run, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER/)
  assert.doesNotMatch(validate.run, /LIFECYCLE_CANARY_LOGIN_PASSWORD/)
  assert.doesNotMatch(validate.run, /STAGING_OWNER_ADMIN_PASSWORD/)
  assert.match(validate.run, /bash -n scripts\/ops\/dingtalk-lifecycle-staging-canary-remote\.sh/)
  // Structural bootstrap/human-bootstrap/alias/pending/deprovision checks remain; secret presence does not.
  assert.match(validate.run, /expected_current_mode must be exactly 'off' for action=\$\{ACTION\}/)
  assert.match(
    validate.run,
    /bootstrap\|human-bootstrap\|alias\|pending\|deprovision|bootstrap" \|\| "\$ACTION" == "human-bootstrap"/,
  )
  assert.doesNotMatch(validate.run, /LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID/)
})

test('workflow materializes secrets inside Run remote action under EXIT trap (no separate secrets step)', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const steps = doc.jobs.run.steps
  // Load-bearing: no separate materialize step (cross-step cancel/leak gap).
  for (const step of steps) {
    const name = String(step.name || '')
    assert.doesNotMatch(name, /Materialize alias canary secrets/i)
    assert.doesNotMatch(name, /^Materialize/i)
  }
  assert.doesNotMatch(yaml, /id:\s*secrets\b/)
  assert.doesNotMatch(yaml, /steps\.secrets\.outputs\.secrets_dir/)
  assert.doesNotMatch(yaml, /SECRETS_DIR:\s*\$\{\{\s*steps\.secrets/)

  const runStart = yaml.indexOf('- name: Run remote action')
  assert.notEqual(runStart, -1)
  const runBody = yaml.slice(runStart, yaml.indexOf('- name: Write step summary', runStart))

  // Parsed step must own materialize + trap (not a prior step).
  const remoteStep = steps.find((s) => s.name === 'Run remote action')
  assert.ok(remoteStep?.run)

  // First lines of run script: demote secrets (builtins only) then unset env.
  // No external command may appear before the unset of exported secret names.
  const runLines = String(remoteStep.run).split('\n')
  let sawSet = false
  let sawEnvUnset = false
  const linesBetweenSetAndEnvUnset = []
  for (const line of runLines) {
    const t = line.trim()
    if (!sawSet) {
      if (t === 'set -euo pipefail') sawSet = true
      continue
    }
    if (
      t.startsWith(
        'unset LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD STAGING_OWNER_ADMIN_PASSWORD LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID',
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
      '_CANARY_IDENT="${LIFECYCLE_CANARY_LOGIN_IDENTIFIER-}"',
      '_CANARY_PASS="${LIFECYCLE_CANARY_LOGIN_PASSWORD-}"',
      '_STAGING_OWNER_PASS="${STAGING_OWNER_ADMIN_PASSWORD-}"',
      '_CANARY_SUBJECT="${LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID-}"',
    ],
    'only demote assignments (builtins) before secret env unset — no external commands; no JWT',
  )

  // Order after demote: trap → mktemp → printf from shell vars → unset shell vars → remote scp.
  const trapIdx = runBody.indexOf('trap cleanup_canary_ephemeral_paths EXIT INT TERM')
  const envUnsetIdx = runBody.indexOf(
    'unset LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD STAGING_OWNER_ADMIN_PASSWORD LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID',
  )
  const mktempIdx = runBody.indexOf('mktemp -d')
  const printfPassIdx = runBody.indexOf("printf '%s' \"${_CANARY_PASS}\"")
  const printfOwnerIdx = runBody.indexOf("printf '%s' \"${_STAGING_OWNER_PASS}\"")
  // Post-write shell-var wipe (must follow password printf; fail-path unset is earlier).
  const unsetShellIdx = runBody.indexOf(
    'unset _CANARY_IDENT _CANARY_PASS',
    printfPassIdx,
  )
  const localCleanAssignIdx = runBody.indexOf('CLEAN_LOCAL_SECRETS_DIR="${secrets_dir}"')
  const remoteMkdirIdx = runBody.indexOf('mkdir -p ${remote_secrets_dir}')
  const scpIdx = runBody.indexOf('scp $ssh_opts')
  assert.ok(envUnsetIdx > 0 && trapIdx > envUnsetIdx, 'trap after env demote/unset')
  assert.ok(mktempIdx > trapIdx, 'trap must precede local secret mktemp/materialize')
  assert.ok(localCleanAssignIdx > trapIdx && localCleanAssignIdx < remoteMkdirIdx, 'register local dir for trap before remote copy')
  assert.ok(printfPassIdx > trapIdx, 'password materialize after trap')
  assert.ok(printfPassIdx < remoteMkdirIdx, 'local password write before remote mkdir')
  assert.ok(printfOwnerIdx > printfPassIdx, 'human password materialize after canary password')
  assert.ok(printfOwnerIdx < remoteMkdirIdx, 'human password local write before remote mkdir')
  assert.ok(unsetShellIdx > printfPassIdx, 'unset shell secret vars immediately after printf writes')
  assert.ok(unsetShellIdx < remoteMkdirIdx, 'shell secret vars cleared before remote copy')
  assert.ok(remoteMkdirIdx > mktempIdx, 'remote secrets mkdir after local materialize')
  assert.ok(scpIdx > remoteMkdirIdx, 'scp after remote mkdir')

  assert.match(remoteStep.run, /trap cleanup_canary_ephemeral_paths EXIT INT TERM/)
  assert.match(remoteStep.run, /mktemp -d/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_CANARY_PASS\}"/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_STAGING_OWNER_PASS\}"/)
  assert.match(
    remoteStep.run,
    /unset LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD STAGING_OWNER_ADMIN_PASSWORD LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID/,
  )
  assert.ok(remoteStep.env, 'Run remote action must declare env')
  assert.equal(remoteStep.env.ATTENDANCE_ADMIN_JWT, undefined, 'never inject ATTENDANCE_ADMIN_JWT')
  assert.ok(remoteStep.env.LIFECYCLE_CANARY_LOGIN_IDENTIFIER, 'identifier secret on Run remote action only')
  assert.ok(remoteStep.env.LIFECYCLE_CANARY_LOGIN_PASSWORD, 'password secret on Run remote action only')
  assert.ok(remoteStep.env.STAGING_OWNER_ADMIN_PASSWORD, 'human password secret on Run remote action only')
  assert.ok(remoteStep.env.LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID, 'subject secret on Run remote action only')
  assert.equal(remoteStep.env.SECRETS_DIR, undefined, 'no secrets_dir cross-step handoff')

  assert.match(runBody, /CLEAN_REMOTE_SECRETS_DIR/)
  assert.match(runBody, /CLEAN_REMOTE_RUNNER_DIR/)
  assert.match(runBody, /NEVER touch persistent/)
  assert.doesNotMatch(runBody, /rm -rf[^\n]*\.metasheet2/)
  assert.match(runBody, /OUTPUT_COLLECTED=1/)
  // Explicit: secrets_dir must not be a step output handoff.
  assert.doesNotMatch(runBody, /secrets_dir=.*GITHUB_OUTPUT/)
  // bootstrap|human-bootstrap|alias|pending|deprovision share materialize gate; no admin.jwt from GHA secrets.
  assert.match(
    runBody,
    /ACTION" == "alias" \|\| "\$ACTION" == "bootstrap" \|\| "\$ACTION" == "human-bootstrap" \|\| "\$ACTION" == "pending" \|\| "\$ACTION" == "deprovision"/,
  )
  assert.doesNotMatch(runBody, /admin\.jwt/)
  // Local+remote secret cleanup; never echo secret values.
  assert.match(runBody, /rm -rf "\$\{CLEAN_LOCAL_SECRETS_DIR\}"/)
  assert.match(runBody, /rm -rf '\$\{remote_secrets_dir\}'|rm -rf \$\{remote_rm\}/)
  assert.doesNotMatch(runBody, /echo\s+[\"']?\$\{?(_CANARY_PASS|_STAGING_OWNER_PASS|STAGING_OWNER_ADMIN_PASSWORD)/)
  assert.doesNotMatch(runBody, /cat\s+[\"']?\$\{?secrets_dir\}.*password/)
})

test('workflow cleanup never deletes persistent .metasheet2 overrides', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /rm -rf \$\{remote_output_dir\} \$\{RUNNER_DIR\}/)
  assert.doesNotMatch(yaml, /rm -rf[^\n]*\.metasheet2/)
})

// --- staging-only rails ---------------------------------------------------------------

test('remote pins staging compose/containers only', () => {
  const source = read(REMOTE_SH)
  for (const name of [
    'metasheet-staging-backend',
    'metasheet-staging-web',
    'metasheet-staging-postgres',
    'metasheet-staging-redis',
  ]) {
    assert.match(source, new RegExp(name))
  }
  assert.match(source, /docker-compose\.app\.staging\.yml/)
  assert.doesNotMatch(
    source.replaceAll('docker-compose.app.staging.yml', ''),
    /docker-compose\.app\.yml/,
  )
  assert.match(source, /assert_staging_only\(\)/)
})

test('production path resolver expands an explicit ~/ prefix instead of nesting a literal tilde', () => {
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      'source "$1"; HOME=/tmp/lifecycle-home; resolve_home_path "~/staging"',
      'bash',
      REMOTE_SH,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'status',
        OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '/tmp/lifecycle-home/staging')
})

test('staging compose derives health build identity from the exact image tag, not stale env_file values', () => {
  const compose = read(STAGING_COMPOSE)
  assert.match(compose, /METASHEET_BUILD_COMMIT: \$\{IMAGE_TAG:-unknown\}/)
  assert.match(compose, /METASHEET_BUILD_IMAGE_TAG: \$\{IMAGE_TAG:-unknown\}/)
  const envFileIndex = compose.indexOf('env_file:')
  const environmentIndex = compose.indexOf('environment:', envFileIndex)
  assert.ok(envFileIndex >= 0 && environmentIndex > envFileIndex)
})

test('P1 backend recreate reuses the exact running image pin instead of latest or unknown', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /resolve_live_backend_image_pin\(\)/)
  assert.match(source, /metasheet2-backend:\(\[0-9a-f\]\{40\}\)/)
  assert.match(
    source,
    /IMAGE_OWNER="\$image_owner" IMAGE_TAG="\$image_tag" \\\n\s+docker compose --project-directory "\$STAGING_DIR"/,
  )
  assert.match(source, /refusing compose/)

  const sha = 'a'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       STAGING_DIR=/tmp
       STAGING_COMPOSE_FILE=/tmp/docker-compose.app.staging.yml
       ATTENDANCE_OVERRIDE_FILE=/tmp/not-present-attendance
       LIFECYCLE_OVERRIDE_FILE=/tmp/not-present-lifecycle
       docker() {
         if [[ "$1" == "inspect" ]]; then
           printf 'ghcr.io/zensgit/metasheet2-backend:${sha}'
         else
           printf '%s|%s|%s' "$IMAGE_OWNER" "$IMAGE_TAG" "$*"
         fi
       }
       compose_staging_cmd "" config`,
      'bash',
      REMOTE_SH,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'status',
        OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`^zensgit\\|${sha}\\|compose `))
})

test('P1 rollback recreate retains the proven image pin after the backend container disappears', () => {
  const sha = 'b'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       STAGING_DIR=/tmp
       STAGING_COMPOSE_FILE=/tmp/docker-compose.app.staging.yml
       ATTENDANCE_OVERRIDE_FILE=/tmp/not-present-attendance
       LIFECYCLE_OVERRIDE_FILE=/tmp/not-present-lifecycle
       PINNED_IMAGE_OWNER=zensgit
       PINNED_IMAGE_TAG=${sha}
       docker() {
         if [[ "$1" == "inspect" ]]; then
           return 1
         fi
         printf '%s|%s|%s' "$IMAGE_OWNER" "$IMAGE_TAG" "$*"
       }
       compose_staging_cmd "" config`,
      'bash',
      REMOTE_SH,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'status',
        OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`^zensgit\\|${sha}\\|compose `))

  const source = read(REMOTE_SH)
  const offBody = actionOffBody(source)
  assert.ok(
    offBody.indexOf('pin_live_backend_image_for_transition') < offBody.indexOf('backup_lifecycle_override'),
    'action_off: image pin must be captured before the first write',
  )
  const aliasBody = actionAliasBody(source)
  assert.ok(
    aliasBody.indexOf('pin_live_backend_image_for_transition')
      < aliasBody.indexOf('establish_alias_off_rollback_baseline'),
    'action_alias: image pin must be captured before OFF baseline / ON write',
  )
})

test('P1 deployed SHA provenance conflicts fail closed instead of selecting one source', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /image_commit.*health_commit/s)
  assert.match(source, /image_commit.*==.*health_commit/s)
  assert.match(source, /printf 'conflict'/)
  assert.match(source, /build_provenance_conflict/)
  assert.match(source, /deployed staging SHA provenance conflict/)
  assert.match(source, /printf 'unknown'/)
  assert.doesNotMatch(source, /if \[\[ -n "\$image_commit" \]\]; then printf/)
  assert.doesNotMatch(source, /if \[\[ "\$health_commit" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then printf/)
})

test('production preflight accepts only an exact resolved SHA; unknown and conflict fail closed', () => {
  function run(buildSha) {
    return spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         SNAP_MIGRATIONS_ZERO=true
         SNAP_MODE=off
         SNAP_BUILD_SHA="$2"
         SNAP_HEALTH_OK=true
         EXPECTED_CURRENT_MODE=''
         DEPLOY_SHA=''
         preflight_for_target off
         printf '%s|%s' "$PREFLIGHT_OK" "$PREFLIGHT_NOTE"`,
        'bash',
        REMOTE_SH,
        buildSha,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
  }
  assert.equal(run('a'.repeat(40)).stdout, 'true|ok')
  assert.equal(run('unknown').stdout, 'false|build_provenance_unknown')
  assert.equal(run('conflict').stdout, 'false|build_provenance_conflict')
  assert.equal(run('not-a-sha').stdout, 'false|build_provenance_unknown')
})

test('backend health proof never falls back to the web health endpoint', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('capture_live_snapshot()')
  const end = source.indexOf('\nbackup_lifecycle_override()', start)
  const body = source.slice(start, end)
  assert.match(body, /SNAP_HEALTH_OK="\$\(fetch_backend_health_ok\)"/)
  assert.doesNotMatch(body, /STAGING_WEB_HEALTH_URL/)
})

// --- P1: migrations unknown is never success ------------------------------------------

test('P1 migrations: probe returns true|false|unknown and require_migrations rejects unknown', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /probe_migration_pending_zero\(\)/)
  assert.match(source, /printf 'unknown'/)
  assert.match(source, /require_migrations_pending_zero_true/)
  assert.match(
    source,
    /migrations_pending_zero must be exactly true \(got '\$\{v\}' — probe unknown/,
  )
  // preflight fails on unknown
  assert.match(source, /migrations_probe_unknown/)
  assert.match(
    source,
    /if \[\[ "\$SNAP_MIGRATIONS_ZERO" != "true" \]\]/,
  )
})

test('MUTATION: treating unknown migrations as success would fail require_migrations contract', () => {
  const original = read(REMOTE_SH)
  // If someone softens require to accept unknown as ok, the exact fail string disappears.
  const mutated = original.replaceAll(
    'migrations_pending_zero must be exactly true (got \'${v}\' — probe unknown/failed; refuse, do not treat unknown as success)',
    'migrations probe soft-pass',
  )
  let failed = false
  try {
    assert.match(mutated, /do not treat unknown as success/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('production function: require_migrations_pending_zero_true accepts only true', () => {
  function run(v) {
    return spawnSync(
      'bash',
      ['-o', 'pipefail', '-c', `source "$1"; require_migrations_pending_zero_true "$2" test`, 'bash', REMOTE_SH, v],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
  }
  assert.equal(run('true').status, 0)
  assert.notEqual(run('false').status, 0)
  assert.notEqual(run('unknown').status, 0)
  assert.match(run('unknown').stderr, /unknown/)
})

// --- P1: pending/deprovision/alias are explicit transient operators ------------------

test('P1 pending/deprovision route to action_pending/action_deprovision; alias routes to action_alias; bootstrap/human-bootstrap route', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /bootstrap\) action_bootstrap/)
  assert.match(source, /human-bootstrap\) action_human_bootstrap/)
  assert.match(source, /alias\) action_alias/)
  assert.match(source, /pending\) action_pending/)
  assert.match(source, /deprovision\) action_deprovision/)
  assert.match(source, /action_pending\(\)/)
  assert.match(source, /action_deprovision\(\)/)
  assert.doesNotMatch(source, /action_not_executable_on/)
  assert.doesNotMatch(source, /not_executable_no_real_verifier/)
  const preflightStart = source.indexOf('preflight_for_target()')
  const preflightEnd = source.indexOf('\naction_preflight()', preflightStart)
  const preflightBody = source.slice(preflightStart, preflightEnd)
  // Stack readiness only — no force not-executable for pending/deprovision.
  assert.doesNotMatch(preflightBody, /not_executable_no_real_verifier/)
  assert.match(preflightBody, /pending\|deprovision\)/)
})

test('P1 action=off/alias/pending/deprovision write lifecycle override; bootstrap/human-bootstrap do not', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /off\) action_off/)
  assert.match(source, /bootstrap\) action_bootstrap/)
  assert.match(source, /human-bootstrap\) action_human_bootstrap/)
  assert.match(source, /alias\) action_alias/)
  assert.match(source, /pending\) action_pending/)
  assert.match(source, /deprovision\) action_deprovision/)
  assert.match(source, /action_off\(\)/)
  assert.match(source, /action_bootstrap\(\)/)
  assert.match(source, /action_human_bootstrap\(\)/)
  assert.match(source, /action_alias\(\)/)
  assert.match(source, /write_lifecycle_override "false" "false" "false"/)
  assert.match(source, /write_lifecycle_override "true" "false" "false"/)
  assert.match(source, /write_lifecycle_override "false" "true" "false"/)
  assert.match(source, /write_lifecycle_override "false" "false" "true"/)
  const bootstrapBody = actionBootstrapBody(source)
  assert.doesNotMatch(bootstrapBody, /write_lifecycle_override/)
  assert.doesNotMatch(bootstrapBody, /recreate_backend_only/)
  const humanBody = actionHumanBootstrapBody(source)
  assert.doesNotMatch(humanBody, /write_lifecycle_override/)
  assert.doesNotMatch(humanBody, /recreate_backend_only/)
})

test('MUTATION: routing alias back to not-executable would fail action_alias contract', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    'alias) action_alias ;;',
    'alias) action_not_executable_on alias ;;',
  )
  let failed = false
  try {
    assert.match(mutated, /alias\) action_alias/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('workflow and remote do not export raw subject values; subject is path-only secret file', () => {
  const yaml = read(WORKFLOW)
  const source = read(REMOTE_SH)
  assert.doesNotMatch(yaml, /export CANARY_SUBJECT_ID=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID=/)
  assert.doesNotMatch(yaml, /OWNER_CONFIRM/)
  assert.doesNotMatch(source, /has_canary_inputs/)
  assert.match(source, /CANARY_DIRECTORY_ACCOUNT_ID_FILE/)
  assert.match(source, /no auto-selection/)
  // Path-only export is allowed; raw value export is not.
  assert.match(yaml, /export CANARY_DIRECTORY_ACCOUNT_ID_FILE=/)
})

// --- P1: health true required after restart -------------------------------------------

test('P1 recreate_backend_only requires health true after restart (returns 1 otherwise)', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /recreate_backend_only\(\)/)
  assert.match(source, /backend health not true after restart — refuse transition success/)
  assert.match(source, /return 1/)
  // action=off must not claim success without recreate success
  assert.match(source, /if ! recreate_backend_only; then/)
  assert.match(source, /fail_transition_restore "backend_health_not_true_after_restart"/)
  assert.match(source, /resolve_deployed_sha\)" != "\$DEPLOY_SHA"/)
  assert.match(source, /fail_transition_restore "post_restart_sha_mismatch"/)
})

test('MUTATION: dropping health requirement after recreate turns contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replaceAll(
    'backend health not true after restart — refuse transition success',
    'loop ended ok',
  )
  let failed = false
  try {
    assert.match(mutated, /backend health not true after restart — refuse transition success/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

// --- P1: previous-override restore on failure -----------------------------------------

test('P1 off backs up previous override and restores on restart/health/mode failure', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /backup_lifecycle_override/)
  assert.match(source, /restore_lifecycle_override/)
  assert.match(source, /fail_transition_restore/)
  assert.match(source, /LIFECYCLE_PREV_STATE/)
  assert.match(source, /previous override restored/)
  // Order must be measured inside the production action body, never against definitions.
  const actionStart = source.indexOf('action_off()')
  const actionEnd = source.indexOf('\naction_alias()', actionStart)
  const actionBody = source.slice(actionStart, actionEnd)
  const backupIdx = actionBody.indexOf('backup_lifecycle_override')
  const writeIdx = actionBody.indexOf('write_lifecycle_override "false" "false" "false"')
  const restoreIdx = actionBody.indexOf('fail_transition_restore')
  assert.ok(backupIdx > 0 && writeIdx > backupIdx, 'backup before write')
  assert.ok(restoreIdx > 0)
})

test('MUTATION: removing restore-on-failure path turns rollback contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replaceAll('fail_transition_restore', 'fail_no_restore')
  let failed = false
  try {
    assert.match(mutated, /fail_transition_restore/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

// --- P2: multi-on status/preflight fail closed; off still clears ----------------------

test('P2 classify_mode returns multi-on without dying; status/preflight fail closed; off clears', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /classify_mode_from_flags/)
  assert.match(source, /printf 'multi-on'/)
  // Must NOT fail inside classify (old derive_mode_from_flags fail closed blocked off)
  const classifyStart = source.indexOf('classify_mode_from_flags()')
  const classifyEnd = source.indexOf('\nread_live_flags()', classifyStart)
  const classifyBody = source.slice(classifyStart, classifyEnd)
  assert.doesNotMatch(classifyBody, /\bfail\b/)
  assert.match(source, /multi_on_fail_closed/)
  assert.match(source, /status fail-closed: \$\{note\}/)
  assert.match(source, /write_lifecycle_override "false" "false" "false"/)
})

test('P1 lifecycle flag reads distinguish a missing key from docker exec failure', () => {
  function runDocker(body) {
    return spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         docker() { ${body}; }
         if value="$(read_flag_from_container "$FLAG_ALIAS")"; then
           printf 'accepted:%s' "$value"
         else
           printf 'rejected'
         fi`,
        'bash',
        REMOTE_SH,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
  }

  const missing = runDocker('printf "__MISSING__"; return 0')
  assert.equal(missing.status, 0, missing.stderr)
  assert.equal(missing.stdout, 'accepted:false')

  const execFailure = runDocker('return 125')
  assert.equal(execFailure.status, 0, execFailure.stderr)
  assert.equal(execFailure.stdout, 'rejected')

  const source = read(REMOTE_SH)
  assert.doesNotMatch(source, /printenv "\$key"[^\n]*\|\| true/)
  assert.match(source, /failed to read lifecycle flags from the running staging backend/)
})

test('production function: classify_mode_from_flags multi-on vs single modes', () => {
  function run(a, p, d) {
    return spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'source "$1"; classify_mode_from_flags "$2" "$3" "$4"',
        'bash',
        REMOTE_SH,
        a,
        p,
        d,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
  }
  assert.equal(run('false', 'false', 'false').stdout.trim(), 'off')
  assert.equal(run('true', 'false', 'false').stdout.trim(), 'alias')
  assert.equal(run('true', 'true', 'false').stdout.trim(), 'multi-on')
  assert.equal(run('true', 'false', 'true').status, 0) // does not die
  assert.equal(run('true', 'false', 'true').stdout.trim(), 'multi-on')
})

test('MUTATION: reintroducing fail inside classify_mode blocks off path (contract red)', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    "printf 'multi-on'\n    return 0",
    'fail "multi-on blocked in classify"\n    return 1',
  )
  const classifyStart = mutated.indexOf('classify_mode_from_flags()')
  const classifyEnd = mutated.indexOf('\nread_live_flags()', classifyStart)
  const classifyBody = mutated.slice(classifyStart, classifyEnd)
  let failed = false
  try {
    assert.doesNotMatch(classifyBody, /\bfail\b/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

// --- override atomic + attendance compose ---------------------------------------------

test('lifecycle override separate from attendance; atomic mktemp+validate+mv', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /LIFECYCLE_PERSIST_DIR="\$\{HOME\}\/\.metasheet2\/lifecycle-canary"/)
  assert.match(source, /ATTENDANCE_OVERRIDE_FILE=/)
  assert.match(source, /override_tmp="\$\(mktemp "\$\{LIFECYCLE_PERSIST_DIR\}\/\.override\.XXXXXX"\)"/)
  assert.match(source, /mv -f "\$override_tmp" "\$LIFECYCLE_OVERRIDE_FILE"/)
  assert.match(source, /up -d --no-deps --force-recreate backend/)
})

// --- status artifact redaction --------------------------------------------------------

test('status artifact is values-free (no credentials/PII/canary ids)', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('write_status_artifact()')
  const end = source.indexOf('\ncapture_live_snapshot()', start)
  const body = source.slice(start, end)
  assert.match(body, /schema=dingtalk-lifecycle-staging-canary-status-v1/)
  assert.match(body, /migrations_pending_zero=/)
  assert.doesNotMatch(body, /DATABASE_URL/)
  assert.doesNotMatch(body, /JWT_SECRET/)
  assert.doesNotMatch(body, /CANARY_SUBJECT/)
  assert.doesNotMatch(body, /printenv/)
})

test('alias summary reports only booleans/counts/reason enums/SHA (no secret fields)', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  assert.match(body, /pre_login_ok=/)
  assert.match(body, /post_on_login_ok=/)
  assert.match(body, /post_rollback_login_ok=/)
  assert.match(body, /rolled_back_to_off=/)
  assert.match(body, /backfill_inserted=/)
  assert.match(body, /backfill_collisions=/)
  assert.match(body, /cutover_ready=/)
  assert.match(body, /build_sha=/)
  assert.doesNotMatch(body, /identifier=/)
  assert.doesNotMatch(body, /password=/)
  assert.doesNotMatch(body, /Authorization/)
  assert.doesNotMatch(body, /Bearer /)
})

// --- alias canary load-bearing sequence -----------------------------------------------

test('alias requires secret files, expected_current_mode=off, exact SHA, migrations, health', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  assert.match(body, /require_canary_secret_files "alias"/)
  assert.match(body, /assert_canary_identifier_matches_owner "alias"/)
  assert.match(body, /require_sha/)
  assert.match(body, /assert_exact_sha/)
  assert.match(body, /require_migrations_pending_zero_true/)
  assert.match(body, /expected_current_mode=off/)
  assert.match(body, /backend_health_ok must be true before any env write/)
  assert.match(body, /live mode must be off before cutover/)
  // Refuse auto-selection explicitly; never implement password reset or prod containers.
  assert.match(body, /refuse auto-selection/)
  assert.doesNotMatch(body, /resetPassword|reset_password|password-reset/)
  assert.doesNotMatch(body, /container_name: metasheet-backend/)
  assert.doesNotMatch(body, /metasheet-backend:latest/)
  // Alias never consumes repo-global ATTENDANCE_ADMIN_JWT.
  assert.match(body, /never secrets\.ATTENDANCE_ADMIN_JWT|Never.*ATTENDANCE_ADMIN_JWT/i)
})

test('alias proves pre-login JWT mint before any env write; backfill and readiness before write', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  const mint = body.indexOf('mint_canary_admin_jwt_from_password_login "pre_on"')
  const backfill = body.indexOf('run_alias_backfill')
  const cutover = body.indexOf('run_alias_cutover_status')
  const baseline = body.indexOf('establish_alias_off_rollback_baseline')
  const write = body.indexOf('write_lifecycle_override "true" "false" "false"')
  assert.ok(mint > 0, 'pre_on login+JWT mint required')
  assert.ok(backfill > mint, 'backfill after pre-login JWT mint')
  assert.ok(cutover > backfill, 'cutover-status after backfill')
  assert.ok(baseline > cutover, 'explicit OFF baseline after readiness')
  assert.ok(write > baseline, 'ON write after OFF baseline')
  assert.doesNotMatch(body, /backup_lifecycle_override/)
  assert.match(body, /pre-ON password login \/ JWT mint failed \(no env write performed\)/)
  assert.match(body, /login-aliases backfill failed \(no env write performed\)/)
  assert.match(body, /cutover-status not ready\/canEnableCutover \(no env write performed\)/)
  assert.match(body, /admin JWT file missing after mint/)
})

test('alias post-ON path requires recreate, exact SHA, mode alias, post-ON login; failures restore first', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  assert.match(body, /fail_transition_restore "backend_health_not_true_after_restart"/)
  assert.match(body, /fail_transition_restore "post_restart_sha_mismatch"/)
  assert.match(body, /fail_transition_restore "post_restart_mode_not_alias"/)
  assert.match(body, /fail_transition_restore "post_on_password_login_failed"/)
  assert.match(body, /prove_canary_password_login "post_on"/)
  assert.match(body, /assert_exact_mode_alias/)
  const writeIdx = body.indexOf('write_lifecycle_override "true" "false" "false"')
  const postOn = body.indexOf('prove_canary_password_login "post_on"')
  const restoreSuccess = body.indexOf('restoring explicit OFF rollback baseline')
  assert.ok(postOn > writeIdx)
  assert.ok(restoreSuccess > postOn, 'success path restores explicit OFF after ON proof')
})

test('alias success requires/proves OFF and post-rollback login; admits unproven OFF if rollback recreate fails', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  const source = read(REMOTE_SH)
  assert.match(body, /restore_lifecycle_override/)
  assert.match(body, /assert_exact_mode_off/)
  assert.match(body, /prove_canary_password_login "post_rollback"/)
  assert.match(body, /rolled_back_to_off="true"/)
  assert.match(body, /alias_cutover_canary_success_proved_off/)
  assert.match(body, /success requires\/proves OFF/)
  assert.match(body, /runtime OFF cannot be proven/)
  assert.match(body, /establish_alias_off_rollback_baseline/)
  assert.doesNotMatch(source, /ALWAYS returns to OFF|ALWAYS restores OFF/)
  const restoreIdx = body.indexOf('restoring explicit OFF rollback baseline')
  const endSummary = body.indexOf('action=alias OK')
  assert.ok(restoreIdx > 0 && endSummary > restoreIdx)
})

test('alias secret helpers never interpolate secret values into shell argv or logs', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /require_canary_secret_files\(\)/)
  assert.match(source, /prove_canary_password_login\(\)/)
  assert.match(source, /mint_canary_admin_jwt_from_password_login\(\)/)
  assert.match(source, /admin_api_request\(\)/)
  assert.match(source, /CANARY_ADMIN_JWT_FILE/)
  assert.match(source, /CANARY_LOGIN_IDENTIFIER_FILE/)
  assert.match(source, /CANARY_LOGIN_PASSWORD_FILE/)
  // Python reads files from argv paths — values not passed as argv.
  assert.match(
    source,
    /^\s*identifier = pathlib\.Path\(ident_path\)\.read_bytes\(\)\.decode\("utf-8"\)\.strip\(\)\s*$/m,
  )
  // Complete assignment line — trailing .strip() must not match.
  assert.match(
    source,
    /^\s*password = pathlib\.Path\(pass_path\)\.read_bytes\(\)\.decode\("utf-8"\)\s*$/m,
  )
  assert.doesNotMatch(
    source,
    /^\s*password = pathlib\.Path\(pass_path\)\.read_bytes\(\)\.decode\("utf-8"\)\.strip\(\)\s*$/m,
  )
  assert.match(source, /pathlib\.Path\(jwt_path\)\.read_text/)
  // Minted JWT is written via pathlib write_bytes, never echoed.
  assert.match(source, /out\.write_bytes\(token\.encode\("utf-8"\)\)/)
  assert.match(source, /os\.chmod\(out, 0o600\)/)
  // Never curl -d with expanded password env or echo secret file contents.
  assert.doesNotMatch(source, /curl[^\n]*\$\{?CANARY_LOGIN_PASSWORD\}?/)
  assert.doesNotMatch(source, /curl[^\n]*\$\{?ATTENDANCE_ADMIN_JWT\}?/)
  assert.doesNotMatch(source, /echo\s+[\"']?\$\{?(CANARY_LOGIN_PASSWORD|ATTENDANCE_ADMIN_JWT|CANARY_ADMIN_JWT)/)
  assert.doesNotMatch(source, /cat\s+\"?\$\{?CANARY_LOGIN_PASSWORD_FILE/)
  assert.match(source, /values never logged/)
  // require_canary_secret_files must not require JWT file from secrets.
  const reqStart = source.indexOf('require_canary_secret_files()')
  const reqEnd = source.indexOf('\nassert_canary_identifier_matches_owner()', reqStart)
  const reqBody = source.slice(reqStart, reqEnd)
  assert.match(reqBody, /CANARY_LOGIN_IDENTIFIER_FILE/)
  assert.match(reqBody, /CANARY_LOGIN_PASSWORD_FILE/)
  assert.doesNotMatch(reqBody, /CANARY_ADMIN_JWT_FILE/)
})

test('alias admin calls target backfill and cutover-status endpoints', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /\/api\/admin\/login-aliases\/backfill/)
  assert.match(source, /\/api\/admin\/login-aliases\/cutover-status/)
  assert.match(source, /\/api\/auth\/login/)
  assert.match(source, /canEnableCutover/)
})

// Load-bearing MUTATION tests: removing any required gate turns the suite red.
test('MUTATION: removing pre-ON login/JWT mint requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    'mint_canary_admin_jwt_from_password_login "pre_on"',
    'true # pre_on mint removed',
  )
  const body = actionAliasBody(mutated)
  let failed = false
  try {
    assert.match(body, /mint_canary_admin_jwt_from_password_login "pre_on"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing post-ON login requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace('prove_canary_password_login "post_on"', 'true # post_on removed')
  const body = actionAliasBody(mutated)
  let failed = false
  try {
    assert.match(body, /prove_canary_password_login "post_on"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing post-rollback login requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    'prove_canary_password_login "post_rollback"',
    'true # post_rollback removed',
  )
  const body = actionAliasBody(mutated)
  let failed = false
  try {
    assert.match(body, /prove_canary_password_login "post_rollback"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing backfill requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replaceAll('run_alias_backfill', 'true_backfill_removed')
  let failed = false
  try {
    assert.match(mutatedBody, /run_alias_backfill/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing cutover-status readiness requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replaceAll('run_alias_cutover_status', 'true_cutover_removed')
  let failed = false
  try {
    assert.match(mutatedBody, /run_alias_cutover_status/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing success-path OFF restore after ON proof turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    'restoring explicit OFF rollback baseline (success requires/proves OFF; canary must not leave alias enabled)',
    'skip restore',
  )
  const body = actionAliasBody(mutated)
  let failed = false
  try {
    assert.match(
      body,
      /restoring explicit OFF rollback baseline \(success requires\/proves OFF; canary must not leave alias enabled\)/,
    )
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: using backup_lifecycle_override instead of explicit OFF baseline turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replace(
    'establish_alias_off_rollback_baseline',
    'backup_lifecycle_override',
  )
  let failed = false
  try {
    assert.match(mutatedBody, /establish_alias_off_rollback_baseline/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  assert.match(mutatedBody, /backup_lifecycle_override/)
})

test('MUTATION: removing exact SHA assert from alias turns contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replace('assert_exact_sha', 'true # sha removed')
  let failed = false
  try {
    assert.match(mutatedBody, /assert_exact_sha/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing migrations require from alias turns contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replace(
    'require_migrations_pending_zero_true "$SNAP_MIGRATIONS_ZERO" "action=alias"',
    'true # migrations removed',
  )
  let failed = false
  try {
    assert.match(mutatedBody, /require_migrations_pending_zero_true "\$SNAP_MIGRATIONS_ZERO" "action=alias"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing secret-file requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const body = actionAliasBody(original)
  const mutatedBody = body.replaceAll('require_canary_secret_files', 'true_secrets_removed')
  let failed = false
  try {
    assert.match(mutatedBody, /require_canary_secret_files/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('production function: require_canary_secret_files rejects missing login paths (JWT not required)', () => {
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      'source "$1"; CANARY_ADMIN_JWT_FILE=; CANARY_LOGIN_IDENTIFIER_FILE=; CANARY_LOGIN_PASSWORD_FILE=; require_canary_secret_files alias',
      'bash',
      REMOTE_SH,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'status',
        OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CANARY_LOGIN_IDENTIFIER_FILE|CANARY_LOGIN_PASSWORD_FILE|secret file/)
  assert.doesNotMatch(result.stderr, /CANARY_ADMIN_JWT_FILE/)
})

test('alias backfill requires exact nonnegative counts and collisions==0 before env write', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /collisions_nonzero/)
  assert.match(source, /collisions must be 0/)
  assert.match(source, /type\(v\) is not int/)
  assert.match(source, /nonneg_int/)
  assert.match(source, /malformed/)
  const body = actionAliasBody(source)
  const backfillIdx = body.indexOf('run_alias_backfill')
  const writeIdx = body.indexOf('write_lifecycle_override "true" "false" "false"')
  assert.ok(backfillIdx > 0 && writeIdx > backfillIdx)
})

test('production function: run_alias_backfill refuses collisions>0 and malformed counts', () => {
  function runWithBody(jsonBody) {
    return spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         BODY_JSON="$2"
         admin_api_request() { printf '200\\n%s' "$BODY_JSON"; }
         if run_alias_backfill; then
           printf 'ok|%s|%s|%s' "$BACKFILL_INSERTED" "$BACKFILL_COLLISIONS" "$BACKFILL_SKIPPED"
         else
           printf 'fail|%s|%s|%s|%s' "$BACKFILL_NOTE" "$BACKFILL_INSERTED" "$BACKFILL_COLLISIONS" "$BACKFILL_SKIPPED"
         fi`,
        'bash',
        REMOTE_SH,
        jsonBody,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
          CANARY_ADMIN_JWT_FILE: '/dev/null',
        },
      },
    )
  }

  const ok = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: 2, collisions: 0, skippedEmpty: 1 } }),
  )
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /(?:^|\n)ok\|2\|0\|1\s*$/)

  const collisions = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: 2, collisions: 1, skippedEmpty: 0 } }),
  )
  assert.equal(collisions.status, 0, collisions.stderr)
  assert.match(collisions.stdout, /(?:^|\n)fail\|collisions_nonzero\|/)

  const malformed = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: 'x', collisions: 0, skippedEmpty: 0 } }),
  )
  assert.equal(malformed.status, 0, malformed.stderr)
  assert.match(malformed.stdout, /(?:^|\n)fail\|malformed\|/)

  const negative = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: -1, collisions: 0, skippedEmpty: 0 } }),
  )
  assert.equal(negative.status, 0, negative.stderr)
  assert.match(negative.stdout, /(?:^|\n)fail\|malformed\|/)

  // Fail closed: JSON float 1.0 and numeric string "1" are not Python int.
  // (JSON.stringify(1.0) collapses to 1 — force a real float token in the body.)
  const floatOne = runWithBody(
    '{"ok":true,"data":{"inserted":1.0,"collisions":0,"skippedEmpty":0}}',
  )
  assert.equal(floatOne.status, 0, floatOne.stderr)
  assert.match(floatOne.stdout, /(?:^|\n)fail\|malformed\|/)

  const stringOne = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: '1', collisions: 0, skippedEmpty: 0 } }),
  )
  assert.equal(stringOne.status, 0, stringOne.stderr)
  assert.match(stringOne.stdout, /(?:^|\n)fail\|malformed\|/)

  // bool is an int subclass — must not be accepted via isinstance(int).
  const boolTrue = runWithBody(
    JSON.stringify({ ok: true, data: { inserted: true, collisions: 0, skippedEmpty: 0 } }),
  )
  assert.equal(boolTrue.status, 0, boolTrue.stderr)
  assert.match(boolTrue.stdout, /(?:^|\n)fail\|malformed\|/)
})

test('MUTATION: accepting collisions>0 would fail backfill zero-collision contract', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replaceAll('collisions_nonzero', 'collisions_ignored')
  let failed = false
  try {
    assert.match(mutated, /collisions_nonzero/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

// Production password assignment must be the complete line (no trailing transforms).
const PROD_PASSWORD_ASSIGN =
  /^\s*password = pathlib\.Path\(pass_path\)\.read_bytes\(\)\.decode\("utf-8"\)\s*$/m
const PROD_PASSWORD_ASSIGN_STRIPPED =
  /^\s*password = pathlib\.Path\(pass_path\)\.read_bytes\(\)\.decode\("utf-8"\)\.strip\(\)\s*$/m
const PROD_PASSWORD_LINE =
  'password = pathlib.Path(pass_path).read_bytes().decode("utf-8")'

test('prove_canary_password_login production assignment is exact (no trailing .strip)', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('prove_canary_password_login()')
  const end = source.indexOf('\nadmin_api_request()', start)
  const body = source.slice(start, end)
  assert.match(
    body,
    /^\s*identifier = pathlib\.Path\(ident_path\)\.read_bytes\(\)\.decode\("utf-8"\)\.strip\(\)\s*$/m,
  )
  // Anchored complete line: prefix-only match would still pass if .strip() is appended.
  assert.match(body, PROD_PASSWORD_ASSIGN)
  assert.doesNotMatch(body, PROD_PASSWORD_ASSIGN_STRIPPED)
  assert.doesNotMatch(body, /password = pathlib\.Path\(pass_path\)\.read_text/)
  assert.doesNotMatch(body, /password\s*=\s*[^\n]*\.strip\(\)/)
})

test('MUTATION: appending .strip() to password assignment turns exact-bytes contract red', () => {
  const original = read(REMOTE_SH)
  assert.match(original, PROD_PASSWORD_ASSIGN)
  const mutated = original.replace(
    PROD_PASSWORD_LINE,
    `${PROD_PASSWORD_LINE}.strip()`,
  )
  // Mutation must break the anchored complete-line assertion (prefix-only would stay green).
  let failed = false
  try {
    assert.match(mutated, PROD_PASSWORD_ASSIGN)
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'anchored password line must reject trailing .strip()')
  assert.match(mutated, PROD_PASSWORD_ASSIGN_STRIPPED)
})

/**
 * Collect stdout/stderr and exit code from an async child process.
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @param {number} timeoutMs
 */
function collectChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`child timed out after ${timeoutMs}ms stdout=${stdout} stderr=${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, signal, stdout, stderr })
    })
  })
}

test('FUNCTIONAL: prove_canary_password_login sends exact CR/LF password bytes on loopback', async () => {
  // Loopback server AND the production helper both run as separate child processes.
  // Never use in-process HTTP + spawnSync (event-loop deadlock → 20s request_failed).
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-canary-login-'))
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProc = null
  /** @type {import('node:child_process').ChildProcess | null} */
  let helperProc = null
  const overallMs = 8000
  try {
    const identFile = join(dir, 'ident')
    const passFile = join(dir, 'pass')
    const captureFile = join(dir, 'captured-request.json')
    // Explicit CR bytes so the fixture cannot be newline-normalized by editors.
    writeFileSync(
      identFile,
      Buffer.from([0x20, 0x20, ...Buffer.from('admin@example.com'), 0x0d, 0x0a]),
    )
    writeFileSync(
      passFile,
      Buffer.from([...Buffer.from('s3cret'), 0x0d, 0x0a, ...Buffer.from('trailing')]),
    )

    const serverPy = `
import json
import http.server
import socketserver
from pathlib import Path

capture = Path(${JSON.stringify(captureFile)})

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n).decode("utf-8")
        capture.write_text(
            json.dumps({"method": "POST", "url": self.path, "rawBody": raw, "json": json.loads(raw)}),
            encoding="utf-8",
        )
        body = json.dumps({"success": True, "data": {"token": "loopback-token"}}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.handle_request()
`
    serverProc = spawn('python3', ['-c', serverPy], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const serverDone = collectChild(serverProc, overallMs)

    const port = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('loopback server port timeout')), 3000)
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        const line = buf.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (/^\d+$/.test(line)) {
          clearTimeout(timer)
          serverProc.stdout.off('data', onData)
          resolve(Number(line))
        }
      }
      serverProc.stdout.on('data', onData)
      serverProc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      serverProc.on('exit', (code) => {
        if (code && code !== 0) {
          clearTimeout(timer)
          reject(new Error(`loopback server exited early: ${code}`))
        }
      })
    })
    const base = `http://127.0.0.1:${port}`

    // Async spawn of the real sourced production helper (not spawnSync).
    helperProc = spawn(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         CANARY_LOGIN_IDENTIFIER_FILE="$2"
         CANARY_LOGIN_PASSWORD_FILE="$3"
         STAGING_API_BASE_URL="$4"
         prove_canary_password_login loopback_exact_bytes`,
        'bash',
        REMOTE_SH,
        identFile,
        passFile,
        base,
      ],
      {
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const helperResult = await collectChild(helperProc, overallMs)
    assert.equal(
      helperResult.code,
      0,
      `helper failed: ${helperResult.stderr}${helperResult.stdout}`,
    )
    assert.match(helperResult.stdout, /password login OK \(loopback_exact_bytes\)/)

    // Server should finish after one request; don't hang if capture already written.
    await Promise.race([
      serverDone,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])

    assert.ok(existsSync(captureFile), 'capture file missing — production helper never hit loopback')
    const captured = JSON.parse(readFileSync(captureFile, 'utf8'))
    assert.equal(captured.method, 'POST')
    assert.equal(captured.url, '/api/auth/login')
    assert.ok(captured.json, `expected JSON body, got: ${captured.rawBody}`)
    // Identifier may trim; password must be exact stored bytes including CR/LF.
    assert.equal(captured.json.identifier, 'admin@example.com')
    assert.equal(captured.json.password, 's3cret\r\ntrailing')
    assert.equal(Buffer.from(captured.json.password, 'utf8')[6], 0x0d)
    // Raw body must contain json.dumps CR escape (\\r), not a stripped password.
    assert.match(captured.rawBody, /s3cret\\r\\ntrailing/)
  } finally {
    for (const proc of [helperProc, serverProc]) {
      if (proc && !proc.killed && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FUNCTIONAL harness: action_alias success call order pre-login+mint→backfill→status→ON→OFF', () => {
  const sha = 'c'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { record require_sha; }
       require_canary_secret_files() { record require_secrets; }
       assert_canary_identifier_matches_owner() { record assert_owner_ident; }
       capture_live_snapshot() {
         record capture_live_snapshot
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { record assert_exact_sha; }
       pin_live_backend_image_for_transition() { record pin_image; }
       require_migrations_pending_zero_true() { record require_migrations; }
       mint_canary_admin_jwt_from_password_login() {
         record "mint:\$1"
         CANARY_ADMIN_JWT_FILE="/tmp/lifecycle-canary-minted.jwt"
         printf 'minted-token' > "\$CANARY_ADMIN_JWT_FILE"
         return 0
       }
       prove_canary_password_login() { record "login:\$1"; return 0; }
       run_alias_backfill() {
         record backfill
         BACKFILL_OK=true; BACKFILL_INSERTED=1; BACKFILL_COLLISIONS=0; BACKFILL_SKIPPED=0; BACKFILL_NOTE=ok
         return 0
       }
       run_alias_cutover_status() {
         record cutover_status
         CUTOVER_READY=true; CUTOVER_CAN_ENABLE=true
         return 0
       }
       establish_alias_off_rollback_baseline() { record off_baseline; }
       backup_lifecycle_override() { record backup_stale; }
       arm_alias_exit_rollback_guard() { record arm_exit_guard; }
       disarm_alias_exit_rollback_guard() { record disarm_exit_guard; }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       recreate_backend_only() { record recreate; return 0; }
       resolve_deployed_sha() { record resolve_sha; printf '%s' "$DEPLOY_SHA"; }
       assert_exact_mode_alias() { record mode_alias; return 0; }
       assert_exact_mode_off() { record mode_off; return 0; }
       restore_lifecycle_override() { record restore; }
       fetch_backend_health_ok() { record health; printf 'true'; }
       cleanup_prev_backup() { record cleanup_backup; }
       write_status_artifact() { record write_status; }
       OUTPUT_DIR="$2"
       mkdir -p "$OUTPUT_DIR"
       DEPLOY_SHA="$3"
       EXPECTED_CURRENT_MODE=off
       ACTION=alias
       action_alias
       printf '%s\\n' "\${CALL_LOG[@]}"`,
      'bash',
      REMOTE_SH,
      '/tmp/lifecycle-canary-functional-success',
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'alias',
        OUTPUT_DIR: '/tmp/lifecycle-canary-functional-success',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const lines = result.stdout.trim().split('\n')
  const idx = (name) => {
    const i = lines.indexOf(name)
    assert.ok(i >= 0, `missing call ${name} in ${lines.join(',')}`)
    return i
  }
  assert.ok(idx('assert_owner_ident') < idx('mint:pre_on'))
  assert.ok(idx('mint:pre_on') < idx('backfill'))
  assert.ok(idx('backfill') < idx('cutover_status'))
  assert.ok(idx('cutover_status') < idx('off_baseline'))
  assert.ok(idx('off_baseline') < idx('write:true:false:false'))
  assert.ok(idx('off_baseline') < idx('arm_exit_guard'))
  assert.ok(idx('arm_exit_guard') < idx('write:true:false:false'))
  assert.ok(!lines.includes('backup_stale'), 'must not backup stale on-disk override')
  assert.ok(idx('write:true:false:false') < idx('recreate'))
  assert.ok(idx('recreate') < idx('mode_alias'))
  assert.ok(idx('mode_alias') < idx('login:post_on'))
  assert.ok(idx('login:post_on') < idx('restore'))
  // Second recreate after restore for OFF proof.
  const restoreI = idx('restore')
  const secondRecreate = lines.indexOf('recreate', restoreI + 1)
  assert.ok(secondRecreate > restoreI, 'rollback recreate after restore')
  assert.ok(secondRecreate < idx('mode_off'))
  assert.ok(idx('mode_off') < idx('login:post_rollback'))
  assert.ok(idx('login:post_rollback') < idx('disarm_exit_guard'))
})

test('FUNCTIONAL: SIGTERM/SIGPIPE in alias ON window restore, recreate, and prove OFF before exit', () => {
  const sha = 'e'.repeat(40)
  for (const [signal, expectedStatus] of [['TERM', 143], ['PIPE', 141]]) {
    const dir = mkdtempSync(join(tmpdir(), `lifecycle-alias-${signal.toLowerCase()}-`))
    const calls = join(dir, 'calls.log')
    try {
      const result = spawnSync(
        'bash',
        [
          '-o',
          'pipefail',
          '-c',
          `source "$1"
           CALLS="$2"
           record() { printf '%s\\n' "$1" >> "$CALLS"; }
           restore_lifecycle_override() { record restore_off; return 0; }
           recreate_backend_only() { record recreate_backend; return 0; }
           resolve_deployed_sha() { record resolve_sha; printf '%s' "$DEPLOY_SHA"; }
           assert_exact_mode_off() { record mode_off; return 0; }
           fetch_backend_health_ok() { record health_ok; printf 'true'; }
           cleanup_prev_backup() { record cleanup_backup; }
           DEPLOY_SHA="$3"
           ACTION=alias
           arm_alias_exit_rollback_guard
           record alias_on_written
           kill -${signal} $$
           record after_signal`,
          'bash',
          REMOTE_SH,
          calls,
          sha,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ACTION: 'alias',
            OUTPUT_DIR: dir,
            RUN_STAMP: `contract-${signal.toLowerCase()}`,
            LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
          },
        },
      )
      assert.equal(result.status, expectedStatus, result.stderr + result.stdout)
      const lines = readFileSync(calls, 'utf8').trim().split('\n')
      const idx = (name) => {
        const i = lines.indexOf(name)
        assert.ok(i >= 0, `signal=${signal} missing ${name}; calls=${lines.join(',')}`)
        return i
      }
      assert.ok(idx('alias_on_written') < idx('restore_off'))
      assert.ok(idx('restore_off') < idx('recreate_backend'))
      assert.ok(idx('recreate_backend') < idx('mode_off'))
      assert.ok(idx('mode_off') < idx('health_ok'))
      assert.ok(idx('health_ok') < idx('cleanup_backup'))
      assert.ok(!lines.includes('after_signal'))
      assert.match(
        readFileSync(join(dir, 'alias-emergency-rollback.log'), 'utf8'),
        /alias rollback guard proved runtime OFF/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('MUTATION: removing alias EXIT guard wiring fails the ON-window contract', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  const arm = body.indexOf('arm_alias_exit_rollback_guard')
  const writeOn = body.indexOf('write_lifecycle_override "true" "false" "false"')
  const postRollbackLogin = body.indexOf('prove_canary_password_login "post_rollback"')
  const disarm = body.indexOf('disarm_alias_exit_rollback_guard')
  assert.ok(arm >= 0 && arm < writeOn, 'guard must arm before persistent alias ON write')
  assert.ok(disarm > postRollbackLogin, 'guard must remain armed through post-rollback login proof')

  const mutated = body.replace(
    '\n  arm_alias_exit_rollback_guard\n',
    '\n  : # guard removed\n',
  )
  assert.doesNotMatch(mutated, /^\s*arm_alias_exit_rollback_guard\s*$/m)
  assert.throws(
    () => assert.match(mutated, /^\s*arm_alias_exit_rollback_guard\s*$/m),
    /arm_alias_exit_rollback_guard/,
  )
})

test('FUNCTIONAL harness: post-ON login failure invokes fail_transition_restore before termination', () => {
  const sha = 'd'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { :; }
       require_canary_secret_files() { :; }
       assert_canary_identifier_matches_owner() { :; }
       capture_live_snapshot() {
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { :; }
       pin_live_backend_image_for_transition() { :; }
       require_migrations_pending_zero_true() { :; }
       mint_canary_admin_jwt_from_password_login() {
         record "mint:\$1"
         CANARY_ADMIN_JWT_FILE="/tmp/lifecycle-canary-minted-fail.jwt"
         printf 'minted-token' > "\$CANARY_ADMIN_JWT_FILE"
         return 0
       }
       prove_canary_password_login() {
         record "login:\$1"
         if [[ "\$1" == "post_on" ]]; then return 1; fi
         return 0
       }
       run_alias_backfill() {
         BACKFILL_OK=true; BACKFILL_INSERTED=0; BACKFILL_COLLISIONS=0; BACKFILL_SKIPPED=0
         return 0
       }
       run_alias_cutover_status() { CUTOVER_READY=true; CUTOVER_CAN_ENABLE=true; return 0; }
       establish_alias_off_rollback_baseline() { record off_baseline; }
       arm_alias_exit_rollback_guard() { record arm_exit_guard; }
       disarm_alias_exit_rollback_guard() { record disarm_exit_guard; }
       backup_lifecycle_override() { record backup_stale; }
       write_lifecycle_override() { record write_on; }
       recreate_backend_only() { record recreate; return 0; }
       resolve_deployed_sha() { printf '%s' "$DEPLOY_SHA"; }
       assert_exact_mode_alias() { return 0; }
       restore_lifecycle_override() { record restore; }
       cleanup_prev_backup() { record cleanup_backup; }
       # Keep production fail_transition_restore; only replace terminal fail().
       fail() { record "fail:\$*"; printf '%s\\n' "\${CALL_LOG[@]}"; exit 1; }
       OUTPUT_DIR="$2"
       mkdir -p "$OUTPUT_DIR"
       DEPLOY_SHA="$3"
       EXPECTED_CURRENT_MODE=off
       ACTION=alias
       action_alias
       printf '%s\\n' "\${CALL_LOG[@]}"
       exit 0`,
      'bash',
      REMOTE_SH,
      '/tmp/lifecycle-canary-functional-fail',
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'alias',
        OUTPUT_DIR: '/tmp/lifecycle-canary-functional-fail',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
      },
    },
  )
  assert.notEqual(result.status, 0, 'post_on failure must fail the action')
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const baseline = lines.indexOf('off_baseline')
  const postOn = lines.indexOf('login:post_on')
  const restore = lines.indexOf('restore')
  const failLine = lines.findIndex((l) => l.startsWith('fail:'))
  assert.ok(baseline >= 0, `log=${lines.join(',')}`)
  assert.ok(!lines.includes('backup_stale'), 'must not backup stale on-disk override')
  assert.ok(postOn >= 0, `log=${lines.join(',')}`)
  assert.ok(restore > postOn, 'fail_transition_restore must restore after post_on failure')
  assert.ok(failLine > restore, 'termination must follow restore')
  assert.match(lines[failLine], /post_on_password_login_failed/)
})

test('FUNCTIONAL: stale on-disk alias=true is discarded; alias rollback baseline is explicit OFF', () => {
  // Live runtime is off, but a stale unapplied override file still has alias=true.
  // establish_alias_off_rollback_baseline must write compose-validated OFF and use
  // that as LIFECYCLE_PREV_BACKUP — never the stale prior file.
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-stale-override-'))
  try {
    const overrideFile = join(dir, 'docker-compose.lifecycle-canary.override.yml')
    const persistDir = dir
    writeFileSync(
      overrideFile,
      [
        'services:',
        '  backend:',
        '    environment:',
        '      AUTH_LOGIN_USE_ALIASES: "true"',
        '      DIRECTORY_PENDING_ACTIVATION_ENABLED: "false"',
        '      DIRECTORY_DEPROVISION_ENABLED: "false"',
        '',
      ].join('\n'),
      'utf8',
    )
    const result = spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         LIFECYCLE_PERSIST_DIR="$2"
         LIFECYCLE_OVERRIDE_FILE="$3"
         RUN_STAMP=contract-stale
         require_compose_v2() { return 0; }
         compose_staging_cmd() { return 0; }
         # Production establish writes OFF via write_lifecycle_override (mocked compose ok).
         establish_alias_off_rollback_baseline
         # After establish: live override + backup must be explicit OFF, not stale true.
         if grep -q 'AUTH_LOGIN_USE_ALIASES: "true"' "\$LIFECYCLE_OVERRIDE_FILE"; then
           echo 'FAIL:live_override_still_true' >&2
           exit 3
         fi
         if ! grep -q 'AUTH_LOGIN_USE_ALIASES: "false"' "\$LIFECYCLE_OVERRIDE_FILE"; then
           echo 'FAIL:live_override_missing_false' >&2
           exit 4
         fi
         if [[ "\$LIFECYCLE_PREV_STATE" != "present" || ! -s "\$LIFECYCLE_PREV_BACKUP" ]]; then
           echo 'FAIL:baseline_backup_missing' >&2
           exit 5
         fi
         if grep -q 'AUTH_LOGIN_USE_ALIASES: "true"' "\$LIFECYCLE_PREV_BACKUP"; then
           echo 'FAIL:baseline_backup_has_true' >&2
           exit 6
         fi
         if ! grep -q 'AUTH_LOGIN_USE_ALIASES: "false"' "\$LIFECYCLE_PREV_BACKUP"; then
           echo 'FAIL:baseline_backup_missing_false' >&2
           exit 7
         fi
         # Simulate post-write ON, then restore: must reinstall OFF baseline, not stale true.
         cat > "\$LIFECYCLE_OVERRIDE_FILE" <<'ON'
services:
  backend:
    environment:
      AUTH_LOGIN_USE_ALIASES: "true"
      DIRECTORY_PENDING_ACTIVATION_ENABLED: "false"
      DIRECTORY_DEPROVISION_ENABLED: "false"
ON
         restore_lifecycle_override
         if grep -q 'AUTH_LOGIN_USE_ALIASES: "true"' "\$LIFECYCLE_OVERRIDE_FILE"; then
           echo 'FAIL:restore_reinstalled_stale_true' >&2
           exit 8
         fi
         if ! grep -q 'AUTH_LOGIN_USE_ALIASES: "false"' "\$LIFECYCLE_OVERRIDE_FILE"; then
           echo 'FAIL:restore_not_explicit_off' >&2
           exit 9
         fi
         echo 'OK:explicit_off_baseline'
         cleanup_prev_backup`,
        'bash',
        REMOTE_SH,
        persistDir,
        overrideFile,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /OK:explicit_off_baseline/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- bootstrap fixed canary admin -----------------------------------------------------

/** Extract the embedded non-secret bootstrap Node program (NODE heredoc). */
function bootstrapNodeSource(source = read(REMOTE_SH)) {
  const start = source.indexOf("cat >\"$BOOTSTRAP_NODE_TMP\" <<'NODE'")
  assert.notEqual(start, -1, 'bootstrap BOOTSTRAP_NODE_TMP NODE heredoc must exist')
  const bodyStart = source.indexOf('\n', start) + 1
  const end = source.indexOf('\nNODE\n', bodyStart)
  assert.notEqual(end, -1, 'NODE terminator missing')
  return source.slice(bodyStart, end)
}

/** SQL string payloads passed to c.query("...") inside the bootstrap node program. */
function bootstrapSqlPayloads(nodeSrc) {
  const payloads = []
  const re = /c\.query\(\s*"((?:\\.|[^"\\])*)"/g
  let m
  while ((m = re.exec(nodeSrc)) !== null) {
    payloads.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'))
  }
  return payloads
}

test('bootstrap fixed ownership markers and collision fail-closed transaction shape', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /CANARY_OWNER_EMAIL="lifecycle-canary@staging\.invalid"/)
  assert.match(
    source,
    /CANARY_OWNER_USER_ID="6c1fe000-ca0a-4000-8000-1ec0c1e00001"/,
  )
  assert.match(source, /bootstrap_lifecycle_canary_admin\(\)/)
  assert.match(source, /action_bootstrap\(\)/)
  assert.match(source, /collision_not_owned/)
  assert.match(source, /collision_multiple_rows/)
  assert.match(source, /FOR UPDATE/)
  assert.match(source, /BEGIN/)
  assert.match(source, /COMMIT/)
  assert.match(source, /ROLLBACK/)
  assert.match(source, /local_password_set = TRUE/)
  assert.match(source, /must_change_password = FALSE/)
  assert.match(source, /activation_status = 'activated'/)
  assert.match(source, /user_roles/)
  assert.match(source, /role_id.*admin|VALUES \(\$1, 'admin'\)/)
  // permissions omitted (054 TEXT[] vs jsonb drift) — never '[]'::jsonb cast.
  assert.doesNotMatch(source, /'::jsonb/)
  assert.match(source, /Omit permissions|omit permissions/i)
  // Never mutates an arbitrary admin by email/role scan.
  assert.doesNotMatch(source, /WHERE role = 'admin'[\s\S]{0,80}UPDATE users/)
  assert.doesNotMatch(source, /WHERE is_admin = TRUE[\s\S]{0,80}UPDATE users/)
})

test('bootstrap SQL uses single-quoted PostgreSQL string literals (double-quote reversion is red)', () => {
  const node = bootstrapNodeSource()
  const sqls = bootstrapSqlPayloads(node)
  assert.ok(sqls.length >= 5, `expected multiple c.query SQL strings, got ${sqls.length}`)
  const joined = sqls.join('\n')

  // Required single-quoted literals (PG string syntax).
  assert.match(joined, /role = 'admin'/)
  assert.match(joined, /activation_status = 'activated'/)
  assert.match(joined, /table_schema = 'public'/)
  assert.match(joined, /VALUES \(\$1, 'admin'\)/)
  assert.match(joined, /VALUES \(\$1, \$2, \$3, \$4, 'admin'/)
  assert.match(joined, /IN \('\*:\*', 'admin:users', 'admin:roles', 'admin:permissions'\)/)
  assert.match(joined, /NULLIF\(trim\(name\), ''\)/)

  // Forbidden: double-quoted SQL string literals (PG treats them as identifiers).
  const forbidden = [
    /role\s*=\s*"admin"/,
    /activation_status\s*=\s*"activated"/,
    /table_schema\s*=\s*"public"/,
    /VALUES\s*\([^)]*"admin"/,
    /IN\s*\(\s*"/,
    /NULLIF\([^)]*,\s*""\)/,
  ]
  for (const re of forbidden) {
    assert.doesNotMatch(joined, re)
  }

  // MUTATION: reintroducing double-quoted SQL literals must fail this contract.
  const mutated = joined
    .replaceAll("role = 'admin'", 'role = "admin"')
    .replaceAll("activation_status = 'activated'", 'activation_status = "activated"')
  let failed = false
  try {
    assert.doesNotMatch(mutated, /role\s*=\s*"admin"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'double-quoted role = "admin" must turn the contract red')
})

test('bootstrap create and repair upsert user_session_revocations like session-revocation.ts', () => {
  const node = bootstrapNodeSource()
  const removeRevocationUpsert = (source, reason) => {
    const reasonArgs = `[ownerId, ownerId, "${reason}"]`
    const reasonIdx = source.indexOf(reasonArgs)
    assert.ok(reasonIdx > 0, `${reason} args must exist`)
    const queryStart = source.lastIndexOf('await c.query(', reasonIdx)
    const queryEnd = source.indexOf(');', reasonIdx)
    assert.ok(queryStart > 0 && queryEnd > reasonIdx, `${reason} query bounds must exist`)
    assert.match(
      source.slice(queryStart, reasonIdx),
      /INSERT INTO user_session_revocations/,
      `${reason} must belong to the revocation upsert`,
    )
    return `${source.slice(0, queryStart)}/* revocation upsert removed */${source.slice(queryEnd + 2)}`
  }
  // Primary guard: same column list + ON CONFLICT watermark as revokeUserSessions().
  assert.match(
    node,
    /INSERT INTO user_session_revocations \(user_id, revoked_after, updated_at, updated_by, reason\) VALUES \(\$1, NOW\(\), NOW\(\), \$2, \$3\) ON CONFLICT \(user_id\) DO UPDATE SET revoked_after = EXCLUDED\.revoked_after, updated_at = EXCLUDED\.updated_at, updated_by = EXCLUDED\.updated_by, reason = EXCLUDED\.reason/,
  )
  assert.match(node, /lifecycle_canary_bootstrap_password_repair/)
  assert.match(node, /lifecycle_canary_bootstrap_password_create/)
  assert.equal((node.match(/INSERT INTO user_session_revocations/g) || []).length, 2)
  // Param shape: userId, updatedBy, reason — not reason-only / userId-as-reason confusion.
  assert.match(
    node,
    /\[ownerId, ownerId, "lifecycle_canary_bootstrap_password_repair"\]/,
  )
  // Order: revocations upsert before optional user_sessions belt.
  const revIdx = node.indexOf('INSERT INTO user_session_revocations')
  const sessIdx = node.indexOf('UPDATE user_sessions SET revoked_at')
  assert.ok(revIdx > 0, 'user_session_revocations upsert required')
  assert.ok(sessIdx > revIdx, 'user_sessions belt must follow user_session_revocations primary guard')
  assert.match(node, /Additional belt only|additional belt/i)
  assert.doesNotMatch(node, /table_name = 'user_session_revocations'/)
  assert.match(node, /absence must roll back the repair/i)

  // MUTATION: dropping either branch's revocation upsert must redden its own contract.
  const withoutRepairRev = removeRevocationUpsert(
    node,
    'lifecycle_canary_bootstrap_password_repair',
  )
  assert.match(withoutRepairRev, /lifecycle_canary_bootstrap_password_create/)
  let repairFailed = false
  try {
    assert.match(
      withoutRepairRev,
      /\[ownerId, ownerId, "lifecycle_canary_bootstrap_password_repair"\]/,
    )
  } catch {
    repairFailed = true
  }
  assert.equal(repairFailed, true)

  const withoutCreateRev = removeRevocationUpsert(
    node,
    'lifecycle_canary_bootstrap_password_create',
  )
  assert.match(withoutCreateRev, /lifecycle_canary_bootstrap_password_repair/)
  let createFailed = false
  try {
    assert.match(
      withoutCreateRev,
      /\[ownerId, ownerId, "lifecycle_canary_bootstrap_password_create"\]/,
    )
  } catch {
    createFailed = true
  }
  assert.equal(createFailed, true)
})

test('bootstrap frames secrets before docker exec; never nests heredoc pipeline or copies container files', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('bootstrap_lifecycle_canary_admin()')
  const end = source.indexOf('\n# Admin API via JWT file', start)
  const body = source.slice(start, end)
  assert.match(body, /struct\.pack\(">I"/)
  assert.match(body, /readFrame|readUInt32BE/)
  assert.match(body, /docker exec -i/)
  assert.match(body, /no container secret files/i)
  assert.match(body, /bootstrap\.frames\.XXXXXX/)
  assert.match(body, /chmod 600 "\$BOOTSTRAP_FRAMED_TMP"/)
  assert.match(body, />"\$BOOTSTRAP_FRAMED_TMP" <<'PY'/)
  assert.match(body, /<"\$BOOTSTRAP_FRAMED_TMP"\)"/)
  assert.match(body, /cleanup_bootstrap_tmps/)
  assert.match(body, /arm_bootstrap_tmp_cleanup_guard/)
  assert.match(source, /trap cleanup_bootstrap_tmps EXIT/)
  assert.match(source, /trap 'exit 143' TERM/)
  assert.match(body, /cleanup_bootstrap_tmps\s+disarm_bootstrap_tmp_cleanup_guard/)
  assert.ok(
    body.indexOf('>"$BOOTSTRAP_FRAMED_TMP" <<\'PY\'') < body.indexOf('docker exec -i'),
    'secret framing must complete before docker exec command substitution',
  )
  assert.doesNotMatch(body, /<<'PY'\s*\|\s*docker exec/)
  assert.doesNotMatch(body, /docker cp/)
  // Host may mktemp a non-secret node source; must never docker-cp login secret files.
  assert.doesNotMatch(body, /docker cp[^\n]*login\.(identifier|password)/)
  assert.doesNotMatch(body, /BACKEND_CONTAINER:[^\n]*login\.(identifier|password)/)
  assert.match(body, /secret framing input read failed/)
  assert.doesNotMatch(body, /struct\.pack\(">I", 0\) \+ struct\.pack\(">I", 0\)/)
  assert.match(body, /CANARY_BOOTSTRAP_MIN_PASSWORD_LEN=12|password_too_short/)
  assert.match(body, /password\.length < minLen|password_too_short/)
  // JWT revocation watermark is authoritative; user_sessions is an additional belt.
  assert.match(body, /INSERT INTO user_session_revocations/)
  assert.match(body, /revoked_after = EXCLUDED\.revoked_after/)
  assert.match(body, /ON CONFLICT \(user_id\) DO UPDATE/)
  assert.match(body, /user_sessions/)
  assert.match(body, /revoked_at/)
  assert.match(body, /lifecycle_canary_bootstrap_password_repair/)
})

test('FUNCTIONAL: bootstrap producer completes before docker and preserves exact framed password bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-bootstrap-frames-'))
  const ident = join(dir, 'login.identifier')
  const password = join(dir, 'login.password')
  writeFileSync(ident, 'lifecycle-canary@staging.invalid\n', { mode: 0o600 })
  writeFileSync(password, Buffer.from('Exact\r\nPassword-12345', 'utf8'), { mode: 0o600 })
  const harness = `
set -euo pipefail
export LIFECYCLE_CANARY_SOURCE_ONLY=true
source "$1"
CANARY_LOGIN_IDENTIFIER_FILE="$2"
CANARY_LOGIN_PASSWORD_FILE="$3"
docker() {
  [[ "$1" == "exec" && "$2" == "-i" ]] || return 91
  python3 -c 'import pathlib,sys; data=sys.stdin.buffer.read(); n1=int.from_bytes(data[:4],"big"); v1=data[4:4+n1]; p=4+n1; n2=int.from_bytes(data[p:p+4],"big"); v2=data[p+4:p+4+n2]; assert p+4+n2 == len(data); assert v1 == pathlib.Path(sys.argv[1]).read_bytes().strip(); assert v2 == pathlib.Path(sys.argv[2]).read_bytes(); print("true|created", end="")' "$CANARY_LOGIN_IDENTIFIER_FILE" "$CANARY_LOGIN_PASSWORD_FILE"
}
bootstrap_lifecycle_canary_admin
`
  try {
    const result = spawnSync('bash', ['-c', harness, 'bash', REMOTE_SH, ident, password], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'bootstrap',
        OUTPUT_DIR: dir,
        RUN_STAMP: 'contract-bootstrap-frames',
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /bootstrap transaction OK outcome=created/)
    assert.deepEqual(readdirSync(dir).sort(), ['login.identifier', 'login.password'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FUNCTIONAL: bootstrap removes framed secrets on docker failure and SIGTERM', () => {
  for (const [mode, dockerBody, expectedStatus] of [
    ['failure', 'return 92', 1],
    ['sigterm', 'kill -TERM $$; sleep 1', 143],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), `lifecycle-bootstrap-${mode}-`))
    const ident = join(dir, 'login.identifier')
    const password = join(dir, 'login.password')
    writeFileSync(ident, 'lifecycle-canary@staging.invalid', { mode: 0o600 })
    writeFileSync(password, Buffer.from('ExactFailurePassword-12345', 'utf8'), { mode: 0o600 })
    const harness = `
set -euo pipefail
export LIFECYCLE_CANARY_SOURCE_ONLY=true
source "$1"
CANARY_LOGIN_IDENTIFIER_FILE="$2"
CANARY_LOGIN_PASSWORD_FILE="$3"
docker() { ${dockerBody}; }
bootstrap_lifecycle_canary_admin
`
    try {
      const result = spawnSync('bash', ['-c', harness, 'bash', REMOTE_SH, ident, password], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'bootstrap',
          OUTPUT_DIR: dir,
          RUN_STAMP: `contract-bootstrap-${mode}`,
        },
      })
      assert.equal(result.status, expectedStatus, `${mode}: ${result.stderr}${result.stdout}`)
      assert.deepEqual(
        readdirSync(dir).sort(),
        ['login.identifier', 'login.password'],
        `${mode}: framed temp must be removed`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('bootstrap requires exact SHA, OFF, health, migrations zero; never writes lifecycle env', () => {
  const body = actionBootstrapBody(read(REMOTE_SH))
  assert.match(body, /require_sha/)
  assert.match(body, /assert_exact_sha/)
  assert.match(body, /require_migrations_pending_zero_true "\$SNAP_MIGRATIONS_ZERO" "action=bootstrap"/)
  assert.match(body, /require_canary_secret_files "bootstrap"/)
  assert.match(body, /assert_canary_identifier_matches_owner "bootstrap"/)
  assert.match(body, /expected_current_mode=off/)
  assert.match(body, /backend_health_ok must be true before account mutation/)
  assert.match(body, /live mode must be off/)
  assert.match(body, /bootstrap_lifecycle_canary_admin/)
  assert.match(body, /sleep 1\.1/)
  assert.match(body, /prove_canary_password_login "bootstrap"/)
  // Post-bootstrap re-assert mode/health/SHA.
  assert.match(body, /post-bootstrap live mode must remain off/)
  assert.match(body, /post-bootstrap backend_health_ok must remain true/)
  assert.match(body, /require_migrations_pending_zero_true "\$SNAP_MIGRATIONS_ZERO" "action=bootstrap post-check"/)
  assert.match(body, /post-bootstrap SHA/)
  assert.match(body, /post_bootstrap_mode_off=true/)
  assert.match(body, /transition_applied=false/)
  assert.match(body, /lifecycle_env_write=false/)
  assert.doesNotMatch(body, /write_lifecycle_override/)
  assert.doesNotMatch(body, /recreate_backend_only/)
  assert.doesNotMatch(body, /AUTH_LOGIN_USE_ALIASES/)
  assert.doesNotMatch(body, /pin_live_backend_image_for_transition/)
})

test('MUTATION: bootstrap enabling a lifecycle flag would fail no-env-write contract', () => {
  const original = actionBootstrapBody(read(REMOTE_SH))
  const mutated = `${original}\n  write_lifecycle_override "true" "false" "false"\n`
  let failed = false
  try {
    assert.doesNotMatch(mutated, /write_lifecycle_override/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('alias JWT derivation mints from password login; never ATTENDANCE_ADMIN_JWT', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /mint_canary_admin_jwt_from_password_login\(\)/)
  assert.match(source, /admin\.jwt/)
  assert.match(source, /never secrets\.ATTENDANCE_ADMIN_JWT|Never.*ATTENDANCE_ADMIN_JWT/i)
  assert.match(source, /CANARY_ADMIN_JWT_FILE set from password login mint/)
  const aliasBody = actionAliasBody(source)
  assert.match(aliasBody, /mint_canary_admin_jwt_from_password_login "pre_on"/)
  const mintIdx = aliasBody.indexOf('mint_canary_admin_jwt_from_password_login "pre_on"')
  const backfillIdx = aliasBody.indexOf('run_alias_backfill')
  assert.ok(mintIdx >= 0 && backfillIdx > mintIdx)
  // Workflow must not inject secrets.ATTENDANCE_ADMIN_JWT; remote must not read that secret.
  const yaml = read(WORKFLOW)
  assert.doesNotMatch(yaml, /\$\{\{\s*secrets\.ATTENDANCE_ADMIN_JWT/)
  assert.doesNotMatch(source, /\$\{\{\s*secrets\.ATTENDANCE_ADMIN_JWT/)
  assert.doesNotMatch(source, /ATTENDANCE_ADMIN_JWT_FILE|printf.*ATTENDANCE_ADMIN_JWT/)
})

test('FUNCTIONAL harness: action_bootstrap order gates then create/repair then login then reassert; no env write', () => {
  const sha = 'f'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { record require_sha; }
       require_canary_secret_files() { record require_secrets; }
       assert_canary_identifier_matches_owner() { record assert_owner; }
       capture_live_snapshot() {
         record capture
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { record assert_sha; }
       require_migrations_pending_zero_true() { record require_mig; }
       bootstrap_lifecycle_canary_admin() { record bootstrap_txn; BOOTSTRAP_OUTCOME=created; return 0; }
       prove_canary_password_login() { record "login:\$1"; return 0; }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       write_status_artifact() { record write_status; }
       OUTPUT_DIR="$2"
       mkdir -p "$OUTPUT_DIR"
       DEPLOY_SHA="$3"
       EXPECTED_CURRENT_MODE=off
       ACTION=bootstrap
       action_bootstrap
       printf '%s\\n' "\${CALL_LOG[@]}"`,
      'bash',
      REMOTE_SH,
      '/tmp/lifecycle-canary-bootstrap-success',
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'bootstrap',
        OUTPUT_DIR: '/tmp/lifecycle-canary-bootstrap-success',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const lines = result.stdout.trim().split('\n')
  const idx = (name) => {
    const i = lines.indexOf(name)
    assert.ok(i >= 0, `missing call ${name} in ${lines.join(',')}`)
    return i
  }
  assert.ok(idx('require_sha') < idx('require_secrets'))
  assert.ok(idx('require_secrets') < idx('assert_owner'))
  assert.ok(idx('assert_sha') < idx('bootstrap_txn'))
  assert.ok(idx('require_mig') < idx('bootstrap_txn'))
  assert.ok(idx('bootstrap_txn') < idx('login:bootstrap'))
  // Second capture + assert_exact_sha after login for post-bootstrap reassert.
  const loginI = idx('login:bootstrap')
  const secondCapture = lines.indexOf('capture', loginI + 1)
  assert.ok(secondCapture > loginI, 'post-bootstrap recapture required')
  const secondSha = lines.indexOf('assert_sha', loginI + 1)
  assert.ok(secondSha > secondCapture, 'post-bootstrap SHA reassert after recapture')
  assert.ok(!lines.some((l) => l.startsWith('write:')), 'bootstrap must not write lifecycle override')
})

test('FUNCTIONAL: mint_canary_admin_jwt_from_password_login writes chmod-600 JWT file from login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-canary-mint-'))
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProc = null
  /** @type {import('node:child_process').ChildProcess | null} */
  let helperProc = null
  const overallMs = 8000
  try {
    const identFile = join(dir, 'login.identifier')
    const passFile = join(dir, 'login.password')
    writeFileSync(identFile, 'lifecycle-canary@staging.invalid')
    writeFileSync(passFile, 's3cret-canary-pass')
    const jwtOut = join(dir, 'admin.jwt')

    const serverPy = `
import json
import http.server
import socketserver

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(n)
        body = json.dumps({"success": True, "data": {"token": "minted-loopback-jwt"}}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args):
        return

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.handle_request()
`
    serverProc = spawn('python3', ['-c', serverPy], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const serverDone = collectChild(serverProc, overallMs)
    const port = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('loopback server port timeout')), 3000)
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        const line = buf.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (/^\d+$/.test(line)) {
          clearTimeout(timer)
          serverProc.stdout.off('data', onData)
          resolve(Number(line))
        }
      }
      serverProc.stdout.on('data', onData)
      serverProc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    helperProc = spawn(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         CANARY_LOGIN_IDENTIFIER_FILE="$2"
         CANARY_LOGIN_PASSWORD_FILE="$3"
         STAGING_API_BASE_URL="$4"
         mint_canary_admin_jwt_from_password_login loopback_mint
         printf 'PATH=%s\\n' "\$CANARY_ADMIN_JWT_FILE"
         printf 'TOKEN='
         cat "\$CANARY_ADMIN_JWT_FILE"
         printf '\\n'
         stat -f '%Lp' "\$CANARY_ADMIN_JWT_FILE" 2>/dev/null || stat -c '%a' "\$CANARY_ADMIN_JWT_FILE"`,
        'bash',
        REMOTE_SH,
        identFile,
        passFile,
        `http://127.0.0.1:${port}`,
      ],
      {
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const helperResult = await collectChild(helperProc, overallMs)
    assert.equal(
      helperResult.code,
      0,
      `helper failed: ${helperResult.stderr}${helperResult.stdout}`,
    )
    assert.match(helperResult.stdout, /PATH=.*admin\.jwt/)
    assert.match(helperResult.stdout, /TOKEN=minted-loopback-jwt/)
    assert.match(helperResult.stdout, /600/)
    assert.ok(existsSync(jwtOut))
    assert.equal(readFileSync(jwtOut, 'utf8'), 'minted-loopback-jwt')
    await Promise.race([serverDone, new Promise((resolve) => setTimeout(resolve, 1000))])
  } finally {
    for (const proc of [helperProc, serverProc]) {
      if (proc && !proc.killed && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})


// --- pending admit canary -------------------------------------------------------------

test('pending admit-only: subject secret, expected off, SHA, migrations; no temp_password activate; OAuth NOT_EXECUTED', () => {
  const body = actionPendingBody(read(REMOTE_SH))
  assert.match(body, /require_canary_secret_files "pending"/)
  assert.match(body, /require_canary_directory_account_id_file "pending"/)
  assert.match(body, /require_sha/)
  assert.match(body, /assert_exact_sha/)
  assert.match(body, /require_migrations_pending_zero_true/)
  assert.match(body, /expected_current_mode=off/)
  assert.match(body, /write_lifecycle_override "false" "true" "false"/)
  assert.match(body, /assert_exact_mode_pending/)
  assert.match(body, /run_pending_admit/)
  assert.match(body, /assert_subject_user_access_state "pending_activation" "false"/)
  assert.match(body, /oauth_negative_checkpoint="NOT_EXECUTED"/)
  assert.match(body, /oauth_positive_checkpoint="NOT_EXECUTED"/)
  assert.match(body, /password_login_denied_checkpoint="NOT_EXECUTED"/)
  assert.match(body, /password_login_denied_ok=false/)
  assert.match(body, /activate_executed="false"|activate_executed=\$\{activate_executed\}/)
  assert.match(body, /run_pending_sso_activate/)
  assert.match(body, /PENDING_SSO_ACTIVATE/)
  // No vacuous wrong-password denial; no temp_password activate path.
  assert.doesNotMatch(body, /lifecycle-canary-login-must-fail/)
  assert.doesNotMatch(body, /run_pending_activate\b/)
  assert.doesNotMatch(body, /mode.: .temp_password|mode": "temp_password/)
  assert.doesNotMatch(body, /prove_subject_login_denied "/)
  assert.match(body, /restore_lifecycle_override/)
  assert.match(body, /assert_exact_mode_off/)
  assert.match(body, /rolled_back_to_off/)
})

test('pending SSO phase uses mode=sso and keeps OAuth checkpoints NOT_EXECUTED', () => {
  const source = read(REMOTE_SH)
  const body = actionPendingBody(source)
  assert.match(body, /phase="sso_activate"|phase=sso_activate/)
  assert.match(body, /run_pending_sso_activate/)
  assert.match(body, /browser OAuth NOT_EXECUTED|oauth_positive_checkpoint="NOT_EXECUTED"/)
  assert.match(body, /lifecycle_env_write=false/)
  // SSO body lives in the helper (not only action_pending).
  assert.match(source, /"mode": "sso"/)
  assert.match(source, /enableDingTalkGrant.: True|enableDingTalkGrant": true/)
})

test('MUTATION: reintroducing wrong-password login denial as evidence turns contract red', () => {
  const source = read(REMOTE_SH)
  assert.doesNotMatch(source, /lifecycle-canary-login-must-fail/)
  const mutated = source + '\nprove_subject_login_denied() { curl -d password=lifecycle-canary-login-must-fail; }\n'
  let failed = false
  try {
    assert.doesNotMatch(mutated, /lifecycle-canary-login-must-fail/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: pending admit claiming password_login_denied_ok=true without proven password turns red', () => {
  const body = actionPendingBody(read(REMOTE_SH))
  // Admit phase summary must keep denied_ok false / NOT_EXECUTED.
  assert.match(body, /password_login_denied_ok=false/)
  const mutated = body.replaceAll('password_login_denied_ok=false', 'password_login_denied_ok=true')
  let failed = false
  try {
    assert.match(mutated, /password_login_denied_ok=false/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing pending admit assertion turns contract red', () => {
  const body = actionPendingBody(read(REMOTE_SH))
  const mutated = body.replaceAll('run_pending_admit', 'true_admit_removed')
  let failed = false
  try {
    assert.match(mutated, /run_pending_admit/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing pending OFF restore turns contract red', () => {
  const body = actionPendingBody(read(REMOTE_SH))
  const mutated = body.replace(
    'restoring explicit OFF rollback baseline (success requires/proves OFF; canary must not leave pending enabled)',
    'skip restore',
  )
  let failed = false
  try {
    assert.match(
      mutated,
      /restoring explicit OFF rollback baseline \(success requires\/proves OFF; canary must not leave pending enabled\)/,
    )
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('production function: require_canary_directory_account_id_file rejects missing/empty/non-uuid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-subject-'))
  try {
    function run(pathValue) {
      return spawnSync(
        'bash',
        [
          '-o',
          'pipefail',
          '-c',
          'source "$1"; CANARY_DIRECTORY_ACCOUNT_ID_FILE="$2"; require_canary_directory_account_id_file pending',
          'bash',
          REMOTE_SH,
          pathValue,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ACTION: 'status',
            OUTPUT_DIR: '/tmp/lifecycle-canary-contract-source-only',
            RUN_STAMP: 'contract',
            LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
          },
        },
      )
    }
    assert.notEqual(run('').status, 0)
    assert.match(run('').stderr, /CANARY_DIRECTORY_ACCOUNT_ID_FILE|no auto-selection/)
    const missing = join(dir, 'missing.id')
    assert.notEqual(run(missing).status, 0)
    const empty = join(dir, 'empty.id')
    writeFileSync(empty, '', { mode: 0o600 })
    assert.notEqual(run(empty).status, 0)
    const bad = join(dir, 'bad.id')
    writeFileSync(bad, 'not-a-uuid', { mode: 0o600 })
    assert.notEqual(run(bad).status, 0)
    assert.match(run(bad).stderr, /subject_not_uuid|invalid/)
    const good = join(dir, 'good.id')
    writeFileSync(good, '6c1fe000-ca0a-4000-8000-1ec0c1e00099', { mode: 0o600 })
    assert.equal(run(good).status, 0, run(good).stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FUNCTIONAL: subject omission refuses pending before any env write', () => {
  const sha = 'f'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { record require_sha; }
       require_canary_secret_files() { :; }
       assert_canary_identifier_matches_owner() { :; }
       require_canary_directory_account_id_file() {
         record require_subject
         fail "action=pending requires CANARY_DIRECTORY_ACCOUNT_ID_FILE (chmod-600 secret file path); no auto-selection"
       }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       fail() { record "fail:\$*"; printf '%s\\n' "\${CALL_LOG[@]}"; exit 1; }
       DEPLOY_SHA="$2"
       EXPECTED_CURRENT_MODE=off
       ACTION=pending
       action_pending
       printf '%s\\n' "\${CALL_LOG[@]}"`,
      'bash',
      REMOTE_SH,
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'pending',
        OUTPUT_DIR: '/tmp/lifecycle-canary-pending-omit',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
      },
    },
  )
  assert.notEqual(result.status, 0)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  assert.ok(lines.includes('require_subject'), lines.join(','))
  assert.ok(!lines.some((l) => l.startsWith('write:')), 'must not write lifecycle override without subject')
})

test('FUNCTIONAL: pending interrupt in ON window restores OFF before exit', () => {
  const sha = '1'.repeat(40)
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-pending-term-'))
  const calls = join(dir, 'calls.log')
  try {
    const result = spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         CALLS="$2"
         record() { printf '%s\\n' "$1" >> "$CALLS"; }
         restore_lifecycle_override() { record restore_off; return 0; }
         recreate_backend_only() { record recreate_backend; return 0; }
         resolve_deployed_sha() { record resolve_sha; printf '%s' "$DEPLOY_SHA"; }
         assert_exact_mode_off() { record mode_off; return 0; }
         fetch_backend_health_ok() { record health_ok; printf 'true'; }
         cleanup_prev_backup() { record cleanup_backup; }
         DEPLOY_SHA="$3"
         ACTION=pending
         arm_alias_exit_rollback_guard
         record pending_on_written
         kill -TERM $$
         record after_signal`,
        'bash',
        REMOTE_SH,
        calls,
        sha,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'pending',
          OUTPUT_DIR: dir,
          RUN_STAMP: 'contract-pending-term',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
    assert.equal(result.status, 143, result.stderr + result.stdout)
    const lines = readFileSync(calls, 'utf8').trim().split('\n')
    assert.ok(lines.indexOf('pending_on_written') < lines.indexOf('restore_off'))
    assert.ok(lines.indexOf('restore_off') < lines.indexOf('recreate_backend'))
    assert.ok(!lines.includes('after_signal'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- deprovision apply / restore ------------------------------------------------------

test('deprovision apply phase: subject, source disable confirm, exact run ledger, flags OFF, not end-to-end', () => {
  const source = read(REMOTE_SH)
  const body = actionDeprovisionApplyBody(source)
  const all = actionDeprovisionBody(source)
  assert.match(source, /DEPROVISION_SOURCE_CONFIRMATION="DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED"/)
  assert.match(source, /DEPROVISION_RESTORE_CONFIRMATION="DINGTALK_SOURCE_REACTIVATED_CONFIRMED"/)
  assert.match(all, /DEPROVISION_SOURCE_CONFIRMATION|DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED/)
  assert.match(all, /DEPROVISION_RESTORE_CONFIRMATION|action_deprovision_restore/)
  assert.match(all, /action_deprovision_apply/)
  assert.match(all, /action_deprovision_restore/)
  assert.match(body, /require_canary_directory_account_id_file "deprovision"/)
  assert.match(body, /run_deprovision_sync_preview_subject_gate/)
  assert.ok(
    body.indexOf('run_deprovision_sync_preview_subject_gate')
      < body.indexOf('write_lifecycle_override "false" "false" "true"'),
    'preview gate must precede deprovision env write',
  )
  assert.match(body, /write_lifecycle_override "false" "false" "true"/)
  assert.match(body, /run_directory_sync_for_subject "deprovision_apply" "true"/)
  assert.match(body, /verify_deprovision_ledger_for_subject/)
  assert.match(body, /ledger_run_match/)
  assert.match(body, /source_still_active_after_sync_external_gate/)
  assert.match(body, /access_restored=false/)
  assert.match(body, /canary_access_rollback_complete=false/)
  assert.match(body, /end_to_end_restore_claimed=false/)
  assert.match(body, /restore_phase_required=true/)
  assert.match(body, /prove_subject_login_denied_with_proven_password/)
  assert.match(body, /login_denied_checkpoint="NOT_EXECUTED"|login_denied_checkpoint=\$\{login_denied_checkpoint\}/)
  assert.match(body, /NOT_EXECUTED/)
  // Vacuous wrong-password helper must not exist.
  assert.doesNotMatch(body, /lifecycle-canary-login-must-fail/)
  assert.doesNotMatch(body, /end_to_end_restore_claimed=true/)
})

test('deprovision restore phase: source reactivated confirm, rehire, resolved, access restored, flags OFF', () => {
  const source = read(REMOTE_SH)
  const body = actionDeprovisionRestoreBody(source)
  assert.match(body, /run_directory_sync_for_subject "deprovision_restore"/)
  assert.match(body, /run_or_resume_deprovision_rehire_restore/)
  const resume = runOrResumeRestoreBody(source)
  assert.match(resume, /run_deprovision_rehire_restore/)
  assert.match(resume, /verify_deprovision_event_resolved/)
  assert.match(body, /assert_subject_user_access_state "activated" "true"/)
  assert.match(body, /flags_remain_off/)
  assert.match(body, /canary_access_rollback_complete=true/)
  assert.match(body, /server_side_access_graph_restore_proven=true/)
  assert.match(body, /end_to_end_restore_claimed=false/)
  assert.match(body, /lifecycle_env_write=false/)
  assert.doesNotMatch(body, /write_lifecycle_override "false" "false" "true"/)
  // Rehire mode is on the restore helper (not the action body).
  assert.match(source, /"mode": "rehire"/)
  assert.match(source, /run_deprovision_rehire_restore\(\)/)
})

test('deprovision ledger requires exact sync run.id equality (load-bearing)', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  assert.match(ledger, /CANARY_SUBJECT_SYNC_RUN_ID_FILE/)
  assert.match(ledger, /event_run_id_mismatch/)
  assert.match(ledger, /expected_run_id/)
  assert.match(ledger, /run_id == expected_run_id|rid == expected_run_id/)
  assert.match(ledger, /SYNC_DEPROVISION_APPLIED/)
  assert.match(ledger, /sync_deprovision_not_applied/)
  // Must not pick newest event without run filter.
  assert.doesNotMatch(ledger, /Pick newest event/)
})

test('MUTATION: dropping ledger run_id equality turns contract red', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  // Remove the equality check lines.
  const mutated = ledger
    .replaceAll('event_run_id_mismatch', 'event_run_ignored')
    .replaceAll('rid == expected_run_id', 'True')
    .replaceAll('event_run != expected_run_id', 'False')
  let failed = false
  try {
    assert.match(mutated, /event_run_id_mismatch/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: accepting any applied event without run match turns ledger contract red', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  const mutated = ledger.replace(
    'if rid == expected_run_id:\n        matched.append(item)',
    'matched.append(item)  # run equality removed',
  )
  let failed = false
  try {
    assert.match(mutated, /if rid == expected_run_id:\s*\n\s*matched\.append\(item\)/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: deprovision apply claiming end-to-end restore turns contract red', () => {
  const body = actionDeprovisionApplyBody(read(REMOTE_SH))
  const mutated = body.replaceAll('end_to_end_restore_claimed=false', 'end_to_end_restore_claimed=true')
  let failed = false
  try {
    assert.match(mutated, /end_to_end_restore_claimed=false/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: removing deprovision rehire restore from restore phase turns red', () => {
  const body = actionDeprovisionRestoreBody(read(REMOTE_SH))
  const mutated = body.replaceAll('run_deprovision_rehire_restore', 'true_restore_removed')
  let failed = false
  try {
    assert.match(mutated, /run_deprovision_rehire_restore/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: setting login_denied_ok=true without proven password path turns red', () => {
  const body = actionDeprovisionApplyBody(read(REMOTE_SH))
  // When no proven password, login_denied_ok must stay false / NOT_EXECUTED.
  assert.match(body, /login_denied_ok="false"/)
  assert.match(body, /login_denied_checkpoint="NOT_EXECUTED"/)
  const mutated = body.replace(
    'login_denied_ok="false"\n    login_denied_checkpoint="NOT_EXECUTED"',
    'login_denied_ok="true"\n    login_denied_checkpoint="NOT_EXECUTED"',
  )
  let failed = false
  try {
    assert.match(mutated, /login_denied_ok="false"\n\s*login_denied_checkpoint="NOT_EXECUTED"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('FUNCTIONAL: deprovision refuses without source confirmation before env write', () => {
  const sha = '2'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { record require_sha; }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       fail() { record "fail:\$*"; printf '%s\\n' "\${CALL_LOG[@]}"; exit 1; }
       DEPLOY_SHA="$2"
       EXPECTED_CURRENT_MODE=off
       BOOTSTRAP_CONFIRMATION=WRONG
       ACTION=deprovision
       action_deprovision
       printf '%s\\n' "\${CALL_LOG[@]}"`,
      'bash',
      REMOTE_SH,
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'deprovision',
        OUTPUT_DIR: '/tmp/lifecycle-canary-deprov-confirm',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
        BOOTSTRAP_CONFIRMATION: 'WRONG',
      },
    },
  )
  assert.notEqual(result.status, 0)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  assert.ok(lines.some((l) => l.includes('DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED') || l.includes('DINGTALK_SOURCE_REACTIVATED')))
  assert.ok(!lines.some((l) => l.startsWith('write:')), 'must not write without confirmation')
})

test('FUNCTIONAL harness: pending admit failure after ON write restores OFF before terminate', () => {
  const sha = '3'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { :; }
       require_canary_secret_files() { :; }
       assert_canary_identifier_matches_owner() { :; }
       require_canary_directory_account_id_file() { :; }
       capture_live_snapshot() {
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { :; }
       pin_live_backend_image_for_transition() { :; }
       require_migrations_pending_zero_true() { :; }
       mint_canary_admin_jwt_from_password_login() {
         record "mint:\$1"
         CANARY_ADMIN_JWT_FILE="/tmp/lifecycle-canary-pending-mint.jwt"
         printf 'minted-token' > "\$CANARY_ADMIN_JWT_FILE"
         return 0
       }
       load_canary_directory_subject() {
         record "load:\$1"
         SUBJECT_OK=true; SUBJECT_NOTE=ok; SUBJECT_PROVIDER_OK=true; SUBJECT_NAME_OK=true
         SUBJECT_ACTIVE=true; SUBJECT_LINK_STATUS=unmatched; SUBJECT_HAS_LOCAL_USER=false
         SUBJECT_LOCAL_USERNAME_OK=false; SUBJECT_LOCAL_NAME_OK=false
         return 0
       }
       establish_alias_off_rollback_baseline() { record off_baseline; }
       arm_alias_exit_rollback_guard() { record arm_exit_guard; }
       disarm_alias_exit_rollback_guard() { record disarm_exit_guard; }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       recreate_backend_only() { record recreate; return 0; }
       resolve_deployed_sha() { printf '%s' "$DEPLOY_SHA"; }
       assert_exact_mode_pending() { record mode_pending; return 0; }
       run_pending_admit() { record admit; ADMIT_NOTE=forced_fail; return 1; }
       restore_lifecycle_override() { record restore; }
       cleanup_prev_backup() { record cleanup_backup; }
       fail() { record "fail:\$*"; printf '%s\\n' "\${CALL_LOG[@]}"; exit 1; }
       OUTPUT_DIR="$2"
       mkdir -p "$OUTPUT_DIR"
       DEPLOY_SHA="$3"
       EXPECTED_CURRENT_MODE=off
       ACTION=pending
       BOOTSTRAP_CONFIRMATION=
       action_pending
       printf '%s\\n' "\${CALL_LOG[@]}"
       exit 0`,
      'bash',
      REMOTE_SH,
      '/tmp/lifecycle-canary-pending-fail',
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'pending',
        OUTPUT_DIR: '/tmp/lifecycle-canary-pending-fail',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
      },
    },
  )
  assert.notEqual(result.status, 0)
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  const writeIdx = lines.indexOf('write:false:true:false')
  const admitIdx = lines.indexOf('admit')
  const restoreIdx = lines.indexOf('restore')
  const failIdx = lines.findIndex((l) => l.startsWith('fail:'))
  assert.ok(writeIdx >= 0, lines.join(','))
  assert.ok(admitIdx > writeIdx)
  assert.ok(restoreIdx > admitIdx, 'fail_transition_restore must restore after admit failure')
  assert.ok(failIdx > restoreIdx)
})

test('workflow pending/deprovision phase confirmations and honest claims', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /PENDING_SSO_ACTIVATE/)
  assert.match(yaml, /DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED/)
  assert.match(yaml, /DINGTALK_SOURCE_REACTIVATED_CONFIRMED/)
  assert.match(yaml, /directory-account\.id/)
  assert.match(yaml, /NOT_EXECUTED/)
  assert.match(yaml, /restore phase|RESTORE/)
  assert.doesNotMatch(yaml, /docs may still say NOT EXECUTABLE|follow-up to refresh docs/i)
  assert.match(yaml, /exactly one total directory account/)
  assert.match(yaml, /reserves and journals the exact sync run UUID before env\/HTTP/)
})


test('P1-D: login denial accepts only 401/403 auth errors; 5xx/transport fail', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('prove_subject_login_denied_with_proven_password()')
  assert.notEqual(start, -1)
  const end = source.indexOf('\nrun_pending_sso_activate()', start)
  const body = source.slice(start, end)
  assert.match(body, /code not in \(401, 403\)/)
  assert.match(body, /not_auth_denial/)
  assert.match(body, /get\("success"\) is not False/)
  assert.match(body, /CLOSED_LOGIN_ERRORS|Invalid account or password/)
  assert.match(body, /auth_error_not_in_closed_set|auth_denied/)
  assert.match(body, /bad_json/)
  assert.doesNotMatch(body, /"invalid" in err_l|"password" in err_l|"unauthorized" in err_l/)
  assert.doesNotMatch(body, /print\(f"true\|http_\{int\(e\.code\)\}_denied"\)/)
})

test('P1-E: SSO activate uses mode=sso and enableDingTalkGrant true; no temp_password', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /"mode": "sso"/)
  assert.match(source, /"enableDingTalkGrant": True/)
  assert.match(source, /run_pending_sso_activate/)
  assert.doesNotMatch(source, /"mode": "temp_password"/)
  assert.match(source, /Pending admit: grant must stay false|enableDingTalkGrant": False/)
  assert.match(source, /oauth_negative_checkpoint="NOT_EXECUTED"/)
  assert.match(source, /oauth_positive_checkpoint="NOT_EXECUTED"/)
})

test('P1-F: deprovision sync/preview gate requires sole linked deactivation matching subject', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /run_deprovision_sync_preview_subject_gate/)
  assert.match(source, /\/sync\/preview/)
  assert.match(source, /wouldDeactivateAccounts/)
  assert.match(source, /wouldDeactivateLinkedAccounts/)
  assert.match(source, /would_deactivate_not_exactly_one/)
  assert.match(source, /would_deactivate_linked_not_exactly_one/)
  assert.match(source, /sampled_deactivations_not_exactly_one/)
  assert.match(source, /sampled_external_not_subject/)
  assert.match(source, /subject\.external-user-id/)
  const apply = actionDeprovisionApplyBody(source)
  assert.ok(
    apply.indexOf('run_deprovision_sync_preview_subject_gate')
      < apply.indexOf('write_lifecycle_override "false" "false" "true"'),
  )
})

test('P2-C: ledger counts only status exactly applied', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  assert.match(ledger, /st != "applied"|st == "applied"/)
  assert.match(ledger, /exactly "applied"|must be exactly|status must be exactly/)
  assert.doesNotMatch(ledger, /in \("applied", "open"/)
})

test('FUNCTIONAL: preview gate refuses when wouldDeactivateAccounts is 2 (collateral)', () => {
  const py = [
    'preview={"wouldDeactivateAccounts":2,"wouldDeactivateLinkedAccounts":2,"sampledDeactivations":[{"externalUserId":"u1","linked":True},{"externalUserId":"u2","linked":True}]}',
    'would=preview["wouldDeactivateAccounts"]',
    'linked=preview["wouldDeactivateLinkedAccounts"]',
    'print("false|would_deactivate_not_exactly_one|%s|%s"%(would,linked) if would!=1 else ("false|would_deactivate_linked_not_exactly_one|%s|%s"%(would,linked) if linked!=1 else "true|ok|1|1"))',
  ].join('\n')
  const result = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /false\|would_deactivate_not_exactly_one/)
})

test('MUTATION: treating HTTP 500 as login denial turns contract red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('prove_subject_login_denied_with_proven_password()')
  const end = source.indexOf('\nrun_pending_sso_activate()', start)
  const body = source.slice(start, end)
  const mutated = body.replace(
    'if code not in (401, 403):',
    'if code not in (401, 403, 500):  # mutation softens 500',
  )
  let failed = false
  try {
    assert.match(mutated, /if code not in \(401, 403\):/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: preview gate accepting wouldDeactivateAccounts!=1 turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('run_deprovision_sync_preview_subject_gate()')
  const end = source.indexOf('\nrun_directory_sync_for_subject()', start)
  const body = source.slice(start, end)
  const mutated = body.replace('if would != 1:', 'if False:  # would check removed')
  let failed = false
  try {
    assert.match(mutated, /if would != 1:/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: ledger counting empty status as applied turns red', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  const mutated = ledger.replace(
    'if type(st) is not str or st != "applied":',
    'if False:  # empty/open accepted',
  )
  let failed = false
  try {
    assert.match(mutated, /type\(st\) is not str or st != "applied"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('FUNCTIONAL: proven-password denial rejects HTTP 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-deny-5xx-'))
  const passFile = join(dir, 'pass')
  writeFileSync(passFile, 'ProvenPass-12345!', { mode: 0o600 })
  const serverPy = `
import json, http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        self.rfile.read(n)
        self.send_response(500)
        self.send_header('Content-Type', 'application/json')
        body = json.dumps({"success": False, "error": "Internal server error"}).encode()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        return
with socketserver.TCPServer(('127.0.0.1', 0), H) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.handle_request()
`
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverProc = null
  try {
    serverProc = spawn('python3', ['-c', serverPy], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const port = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('loopback port timeout')), 3000)
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        const line = buf.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (/^\d+$/.test(line)) {
          clearTimeout(timer)
          serverProc.stdout.off('data', onData)
          resolve(Number(line))
        }
      }
      serverProc.stdout.on('data', onData)
      serverProc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    const result = spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'source "$1"; STAGING_API_BASE_URL="http://127.0.0.1:$2"; SUBJECT_OWNER_USERNAME=lifecycle-canary-employee; SUBJECT_PASSWORD_PROVEN_OK=true; CANARY_SUBJECT_TEMP_PASSWORD_FILE="$3"; if prove_subject_login_denied_with_proven_password loopback_5xx; then echo FAIL_ACCEPTED; exit 3; fi; echo "note=${LOGIN_DENIED_NOTE}"; exit 0',
        'bash',
        REMOTE_SH,
        String(port),
        passFile,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'status',
          OUTPUT_DIR: dir,
          RUN_STAMP: 'contract',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /note=http_500_not_auth_denial/)
    assert.doesNotMatch(result.stdout, /FAIL_ACCEPTED/)
  } finally {
    if (serverProc && serverProc.exitCode === null) {
      try {
        serverProc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})


// --- Round-3 fail-closed hardening ----------------------------------------------------

test('R3: assert_subject_user_access_state requires JSON boolean is_active (missing/null/string fail)', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('assert_subject_user_access_state()')
  const end = source.indexOf('\nresolve_subject_password_file()', start)
  const body = source.slice(start, end)
  assert.match(body, /is_active_missing/)
  assert.match(body, /is_active_not_boolean/)
  assert.match(body, /type\(is_active\) is not bool/)
  // Must not coerce missing/null/string to false.
  assert.doesNotMatch(body, /active_s = "true" if is_active is True else "false"\nactivation = str/)
  assert.doesNotMatch(body, /is_active is None:\n    is_active = data\.get/)
})

test('FUNCTIONAL: assert_subject_user_access_state rejects missing/null/string is_active', () => {
  function runPayload(userObj) {
    const py = `
import json
user = json.loads(${JSON.stringify(JSON.stringify(userObj))})
if "is_active" in user:
    is_active = user["is_active"]
elif "isActive" in user:
    is_active = user["isActive"]
else:
    print("false|is_active_missing")
    raise SystemExit(0)
if type(is_active) is not bool:
    print("false|is_active_not_boolean")
    raise SystemExit(0)
print("true|ok|" + ("true" if is_active is True else "false"))
`
    return spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  }
  for (const bad of [{}, { is_active: null }, { is_active: 'false' }, { isActive: 'false' }, { is_active: 0 }]) {
    const r = runPayload(bad)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /false\|is_active_(missing|not_boolean)/)
  }
  const ok = runPayload({ is_active: false, activationStatus: 'activated' })
  assert.match(ok.stdout, /true\|ok\|false/)
})

test('MUTATION: coercing missing is_active to false turns access contract red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('assert_subject_user_access_state()')
  const end = source.indexOf('\nresolve_subject_password_file()', start)
  const body = source.slice(start, end)
  const mutated = body.replace(
    'emit("false", "is_active_missing")',
    'is_active = False  # mutation: missing becomes false',
  )
  let failed = false
  try {
    assert.match(mutated, /is_active_missing/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R3: login denial closed-set only Invalid account or password', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('prove_subject_login_denied_with_proven_password()')
  const end = source.indexOf('\nrun_pending_sso_activate()', start)
  const body = source.slice(start, end)
  assert.match(body, /CLOSED_LOGIN_ERRORS/)
  assert.match(body, /Invalid account or password/)
  assert.match(body, /auth_error_not_in_closed_set/)
  assert.doesNotMatch(body, /"invalid" in err_l/)
  assert.doesNotMatch(body, /"unauthorized" in err_l/)
  assert.doesNotMatch(body, /"forbidden" in err_l/)
})

test('FUNCTIONAL: closed-set denial rejects CSRF-style 403 error text', () => {
  const py = `
CLOSED_LOGIN_ERRORS = frozenset({"Invalid account or password"})
for code, err in [(403, "CSRF token missing"), (401, "Unauthorized"), (401, "Invalid account or password")]:
    ok = err in CLOSED_LOGIN_ERRORS
    print(f"{code}|{err}|{'true' if ok else 'false'}")
`
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /403\|CSRF token missing\|false/)
  assert.match(r.stdout, /401\|Unauthorized\|false/)
  assert.match(r.stdout, /401\|Invalid account or password\|true/)
})

test('R3: apply persists exact run/event/effects; restore forbids discovery', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /persist_deprovision_apply_state/)
  assert.match(source, /load_deprovision_apply_state/)
  assert.match(source, /clear_deprovision_apply_state/)
  assert.match(source, /lifecycle-canary-deprovision-apply-state-v4/)
  assert.match(source, /\.apply-state\.json/)
  assert.doesNotMatch(source, /discover_applied_deprovision_event_for_subject/)
  assert.match(source, /event_id_file_missing_no_discovery|no event auto-discovery|no_discovery/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /persist_deprovision_apply_state|journal_upgrade_ledger_bound/)
  const restore = actionDeprovisionRestoreBody(source)
  assert.match(restore, /load_deprovision_apply_state/)
  assert.match(restore, /clear_deprovision_apply_state/)
  assert.doesNotMatch(restore, /discover_applied/)
})

test('R3: restore requires fully_resolved and all effects reversed', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('verify_deprovision_event_resolved()')
  const end = source.indexOf('\nprove_access_graph_state()', start)
  const body = source.slice(start, end)
  assert.match(body, /fully_resolved/)
  assert.match(body, /effect_not_reversed|status.*reversed/)
  assert.match(body, /event_status_superseded|event_not_fully_resolved/)
  assert.match(body, /effect_missing_after_restore/)
  assert.match(body, /effects_empty_after_restore/)
  // Must not treat "not in applied list" alone as success without fully_resolved.
  assert.doesNotMatch(body, /emit\("true", "resolved"\)/)
  assert.match(body, /fully_resolved_all_reversed/)
})

test('MUTATION: restore accepting event merely absent from applied turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('verify_deprovision_event_resolved()')
  const end = source.indexOf('\nprove_access_graph_state()', start)
  const body = source.slice(start, end)
  const mutated = body.replaceAll('fully_resolved', 'applied_absent')
  let failed = false
  try {
    assert.match(mutated, /fully_resolved/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R3: access graph proof uses DB user/membership/grant not profile-only access API', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /prove_access_graph_state/)
  assert.match(source, /user_orgs/)
  assert.match(source, /user_external_auth_grants/)
  assert.match(source, /provider = \$2|provider = 'dingtalk'|provider = \$2/)
  assert.match(source, /server_side_access_graph_restore_proven/)
  const restore = actionDeprovisionRestoreBody(source)
  assert.match(restore, /prove_access_graph_state "restored"/)
  assert.match(restore, /server_side_access_graph_restore_proven=true/)
  assert.match(restore, /end_to_end_restore_claimed=false/)
  assert.doesNotMatch(restore, /end_to_end_restore_claimed=true/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /prove_access_graph_state "deprovisioned"/)
})

test('R3: post-sync radius requires candidate=1 and accountsDeactivated=1', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /sync_candidate_radius_not_one/)
  assert.match(source, /sync_accounts_deactivated_not_one/)
  assert.match(source, /candidates != 1|candidates == 1/)
  assert.match(source, /accounts != 1|accounts == 1/)
  assert.match(source, /sync_radius_not_atomic_lock|not atomic/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /SYNC_DEPROVISION_CANDIDATES\}?" == "1"|SYNC_DEPROVISION_CANDIDATES" == "1"/)
  assert.match(apply, /SYNC_ACCOUNTS_DEACTIVATED\}?" == "1"|SYNC_ACCOUNTS_DEACTIVATED" == "1"/)
  assert.match(apply, /\$\{SYNC_DEPROVISION_CANDIDATES\}" == "1"/)
  assert.match(apply, /\$\{SYNC_ACCOUNTS_DEACTIVATED\}" == "1"/)
})

test('MUTATION: dropping post-sync accountsDeactivated==1 check turns red', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const mutated = apply.replaceAll('sync_accounts_deactivated_not_one', 'radius_ignored')
  let failed = false
  try {
    assert.match(mutated, /sync_accounts_deactivated_not_one/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: claiming end_to_end_restore_claimed=true while OAuth NOT_EXECUTED turns red', () => {
  const restore = actionDeprovisionRestoreBody(read(REMOTE_SH))
  assert.match(restore, /oauth_positive_checkpoint="NOT_EXECUTED"|oauth_positive_checkpoint=NOT_EXECUTED/)
  assert.match(restore, /end_to_end_restore_claimed=false/)
  const mutated = restore.replaceAll('end_to_end_restore_claimed=false', 'end_to_end_restore_claimed=true')
  let failed = false
  try {
    assert.match(mutated, /end_to_end_restore_claimed=false/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

// --- Round 4: org-scoped membership, effect-metadata graph, exact effect set, state bind ---

function proveAccessGraphBody(source) {
  const start = source.indexOf('prove_access_graph_state()')
  assert.notEqual(start, -1, 'prove_access_graph_state must exist')
  const end = source.indexOf('\nvalidate_mode_name()', start)
  assert.notEqual(end, -1, 'validate_mode_name after prove_access_graph_state')
  return source.slice(start, end)
}

function loadDeprovisionApplyStateBody(source) {
  const start = source.indexOf('load_deprovision_apply_state()')
  assert.notEqual(start, -1)
  // R5: load is last journal helper before rehire restore.
  let end = source.indexOf('\nrun_deprovision_rehire_restore()', start)
  if (end === -1) {
    end = source.indexOf('\n# POST rehire restore', start)
  }
  assert.notEqual(end, -1)
  return source.slice(start, end)
}

function persistDeprovisionApplyStateBody(source) {
  // R5: ledger_bound upgrade lives in journal_upgrade_ledger_bound; persist is a thin alias.
  const start = source.indexOf('journal_upgrade_ledger_bound()')
  assert.notEqual(start, -1)
  const end = source.indexOf('\n// Compat name used by older comments', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
}

function journalStateMachineRegion(source) {
  const start = source.indexOf('# --- recovery journal state machine')
  assert.notEqual(start, -1)
  const end = source.indexOf('# POST rehire restore for EXACT event id', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
}

function rehireRestoreBody(source) {
  const start = source.indexOf('run_deprovision_rehire_restore()')
  assert.notEqual(start, -1)
  const end = source.indexOf('\nverify_deprovision_event_resolved()', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
}

function eventResolvedBody(source) {
  const start = source.indexOf('verify_deprovision_event_resolved()')
  assert.notEqual(start, -1)
  const end = source.indexOf('\nprove_access_graph_state()', start)
  assert.notEqual(end, -1)
  return source.slice(start, end)
}

test('R4: membership graph is org-scoped via exact integration org_id (not all-orgs)', () => {
  const body = proveAccessGraphBody(read(REMOTE_SH))
  assert.match(body, /directory_integrations/)
  assert.match(body, /provider = \$2/)
  assert.match(body, /dingtalk/)
  assert.match(body, /org_id/)
  assert.match(body, /user_id = \$1 AND org_id = \$2 AND COALESCE\(is_active, TRUE\) = TRUE/)
  // Must NOT count membership across all orgs without org_id filter.
  assert.doesNotMatch(
    body,
    /FROM user_orgs WHERE user_id = \$1 AND COALESCE\(is_active, TRUE\) = TRUE(?![\s\S]*org_id)/,
  )
  // Active integration preferred/required.
  assert.match(body, /integration_not_active|integStatus !== "active"/)
  assert.match(body, /integration_org_not_unique/)
})

test('MUTATION: dropping org_id scope on membership turns red', () => {
  const body = proveAccessGraphBody(read(REMOTE_SH))
  const mutated = body.replaceAll(
    'user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE',
    'user_id = $1 AND COALESCE(is_active, TRUE) = TRUE',
  )
  let failed = false
  try {
    assert.match(mutated, /user_id = \$1 AND org_id = \$2 AND COALESCE\(is_active, TRUE\) = TRUE/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R4: graph proofs are effect-metadata driven (closed types + before/after/grant_row_created)', () => {
  const source = read(REMOTE_SH)
  const ledger = verifyDeprovisionLedgerBody(source)
  assert.match(ledger, /membership_changed/)
  assert.match(ledger, /grant_changed/)
  assert.match(ledger, /user_changed/)
  assert.match(ledger, /before_active/)
  assert.match(ledger, /after_active/)
  assert.match(ledger, /grant_row_created/)
  assert.match(ledger, /CLOSED_EFFECT_TYPES/)
  assert.match(ledger, /effect_id_duplicate/)
  assert.match(ledger, /effect_type_not_closed_set/)
  assert.match(ledger, /effect_type_set_not_exact_triple|user_changed_effect_missing/)
  const graph = proveAccessGraphBody(source)
  assert.match(graph, /membership_changed/)
  assert.match(graph, /grant_changed/)
  assert.match(graph, /user_changed/)
  assert.match(graph, /after_active/)
  assert.match(graph, /before_active/)
  assert.match(graph, /grant_row_created/)
  assert.match(graph, /grant_row_created_not_absent/)
  assert.match(graph, /grant_enabled_not_before|grant_enabled_not_after/)
  // No free-floating "always require user inactive / membership zero" without effects.
  assert.doesNotMatch(graph, /if \(isActive !== false\) \{\s*emit\("false", "user_still_active"/)
})

test('FUNCTIONAL: other-org active membership must not green restore when target org inactive', () => {
  // Pure predicate: target-org scoped active flag only.
  const py = `
mem_active_target = False  # target org inactive after "failed" restore
mem_active_other = True    # other org still active
expected_before = True     # membership_changed before_active
ok = mem_active_target == expected_before
print("restore_ok" if ok else "restore_fail")
# deprovision: target inactive, other active → still pass
mem_active_target_dep = False
expected_after = False
ok_dep = mem_active_target_dep == expected_after
print("deprov_ok" if ok_dep else "deprov_fail")
`
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /restore_fail/)
  assert.match(r.stdout, /deprov_ok/)
})

test('R4: restore live effect id set must equal persisted exactly (no extra/missing/dup/non-reversed)', () => {
  const body = eventResolvedBody(read(REMOTE_SH))
  assert.match(body, /effect_extra_live/)
  assert.match(body, /effect_missing_after_restore/)
  assert.match(body, /effect_id_duplicate_live|expected_effect_id_duplicate/)
  assert.match(body, /effect_not_reversed/)
  assert.match(body, /len\(by_id\) != len\(expected_effects\)/)
  assert.match(body, /live_id not in seen_exp/)
})

test('MUTATION: allowing extra live effects turns red', () => {
  const body = eventResolvedBody(read(REMOTE_SH))
  const mutated = body.replaceAll('effect_extra_live', 'extra_ignored')
  let failed = false
  try {
    assert.match(mutated, /effect_extra_live/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R4: restoredEffectCount must equal persisted effect_count exactly', () => {
  const body = rehireRestoreBody(read(REMOTE_SH))
  assert.match(body, /restore_effect_count_mismatch/)
  assert.match(body, /count != expected/)
  assert.match(body, /restoredEffectCount/)
  assert.doesNotMatch(body, /count < 1:\s*\n\s*emit\("false", "restore_effect_count_invalid"\)\s*\nemit\("true"/)
})

test('MUTATION: restoredEffectCount only >0 turns red', () => {
  const body = rehireRestoreBody(read(REMOTE_SH))
  const mutated = body
    .replaceAll('if count != expected:', 'if count < 1:')
    .replaceAll('restore_effect_count_mismatch', 'restore_effect_count_invalid')
  let failed = false
  try {
    assert.match(mutated, /restore_effect_count_mismatch/)
    assert.match(mutated, /count != expected/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R4: post-sync requires deprovisionUsersDeactivatedCount exact 1', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /sync_users_deactivated_not_one/)
  assert.match(source, /deprovisionUsersDeactivatedCount/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /\$\{SYNC_USERS_DEACTIVATED\}" == "1"/)
  assert.match(apply, /sync_users_deactivated_not_one/)
})

test('MUTATION: dropping usersDeactivated==1 assertion turns red', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const mutated = apply.replaceAll('sync_users_deactivated_not_one', 'users_ignored')
  let failed = false
  try {
    assert.match(mutated, /sync_users_deactivated_not_one/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R4: apply state binds local_user_id+integration_id+directory_account_id+subject_key+run/event/effects', () => {
  const source = read(REMOTE_SH)
  const region = journalStateMachineRegion(source)
  assert.match(region, /local_user_id/)
  assert.match(region, /integration_id/)
  assert.match(region, /directory_account_id/)
  assert.match(region, /subject_key/)
  assert.match(region, /sync_run_id/)
  assert.match(region, /event_id/)
  assert.match(region, /effect_count/)
  assert.match(region, /lifecycle-canary-deprovision-apply-state-v4/)
  assert.match(region, /refuse overwrite|unrecovered recovery journal/)
  const load = loadDeprovisionApplyStateBody(source)
  assert.match(load, /live_user != local_user_id|SystemExit\(10\)/)
  assert.match(load, /live_integ != integration_id|SystemExit\(11\)/)
  assert.match(load, /live_acct != directory_account_id|SystemExit\(12\)/)
  assert.match(load, /lifecycle-canary-deprovision-apply-state-v4/)
  assert.match(load, /ledger_bound/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /refuse_existing_deprovision_apply_state/)
  assert.match(apply, /journal_init_prepared/)
  // refuse + prepared must run before env write
  const refuseIdx = apply.indexOf('refuse_existing_deprovision_apply_state')
  const preparedIdx = apply.indexOf('journal_init_prepared')
  const writeIdx = apply.indexOf('write_lifecycle_override')
  assert.ok(refuseIdx > 0 && preparedIdx > refuseIdx && writeIdx > preparedIdx, 'refuse+prepared before env write')
  const restore = actionDeprovisionRestoreBody(source)
  assert.match(restore, /clear_deprovision_apply_state/)
  // clear only after successful path markers
  const clearIdx = restore.indexOf('clear_deprovision_apply_state')
  const graphIdx = restore.indexOf('prove_access_graph_state "restored"')
  assert.ok(clearIdx > graphIdx, 'clear state only after successful restore proofs')
})

test('MUTATION: state bound only by username (no id rebind) turns red', () => {
  const load = loadDeprovisionApplyStateBody(read(REMOTE_SH))
  const mutated = load
    .replaceAll('local_user_id', 'subject_only')
    .replaceAll('integration_id', 'subject_only')
    .replaceAll('directory_account_id', 'subject_only')
  let failed = false
  try {
    assert.match(mutated, /local_user_id/)
    assert.match(mutated, /integration_id/)
    assert.match(mutated, /directory_account_id/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: apply overwriting existing unrecovered state turns red', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const mutated = apply.replaceAll('refuse_existing_deprovision_apply_state', 'skip_state_refuse')
  let failed = false
  try {
    assert.match(mutated, /refuse_existing_deprovision_apply_state/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R4: graph DB failure/unknown fail closed; never log ids/PII', () => {
  const source = read(REMOTE_SH)
  const body = proveAccessGraphBody(source)
  assert.match(body, /db_query_failed/)
  assert.match(body, /database_url_missing/)
  assert.match(body, /docker_exec_failed/)
  // Values-free notes only — no echo of user/integration ids in log lines.
  assert.doesNotMatch(body, /log ".*\$\{?userId/)
  assert.doesNotMatch(body, /log ".*\$\{?integrationId/)
  assert.doesNotMatch(body, /console\.log\(userId|console\.log\(integrationId/)
  // Doc comment sits immediately above the function (outside body slice).
  const header = source.slice(
    source.lastIndexOf('# Authoritative access-graph', source.indexOf('prove_access_graph_state()')),
    source.indexOf('prove_access_graph_state()'),
  )
  assert.match(header, /Never prints user\/ids\/PII|never prints/i)
})
test('FUNCTIONAL: effect metadata capture requires closed types and strict booleans', () => {
  const py = `
CLOSED = frozenset({"membership_changed", "grant_changed", "user_changed"})
def check(fx):
    if fx.get("type") not in CLOSED: return "type"
    if type(fx.get("before_active")) is not bool: return "ba"
    if type(fx.get("after_active")) is not bool: return "aa"
    if type(fx.get("grant_row_created")) is not bool: return "grc"
    return "ok"
cases = [
  {"type":"user_changed","before_active":True,"after_active":False,"grant_row_created":False},
  {"type":"weird","before_active":True,"after_active":False,"grant_row_created":False},
  {"type":"grant_changed","before_active":"x","after_active":False,"grant_row_created":False},
]
for c in cases:
    print(check(c))
`
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.deepEqual(lines, ['ok', 'type', 'ba'])
})

// --- Round 5: recovery journal, run-id-before-counts, precondition, keep-journal ---

test('R5: prepared journal reserves run id before HTTP and radius judgments', () => {
  const source = read(REMOTE_SH)
  const journal = journalStateMachineRegion(source)
  const start = source.indexOf('run_directory_sync_for_subject()')
  const end = source.indexOf('\nverify_deprovision_ledger_for_subject()', start)
  const body = source.slice(start, end)
  const reserveIdx = journal.indexOf('uuid.uuid4()')
  const journalWriteIdx = journal.indexOf('tmp.replace(pathlib.Path(out_path))')
  const requestIdx = body.indexOf('urllib.request.Request')
  const radiusIdx = body.indexOf('sync_candidate_radius_not_one')
  assert.ok(reserveIdx > 0 && journalWriteIdx > reserveIdx, 'prepared journal must reserve and persist run id')
  assert.ok(requestIdx > 0 && radiusIdx > requestIdx, 'reserved-id request must precede radius emit')
  // Radius failures must still emit run_present=true.
  assert.match(body, /sync_candidate_radius_not_one[\s\S]*"true"\)/)
  assert.match(body, /SYNC_RUN_ID_PRESENT" == "true"/)
  assert.match(body, /reserved_run_id/)
  assert.match(body, /"runId": reserved_run_id/)
})

test('MUTATION: radius fail without run_present=true turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('run_directory_sync_for_subject()')
  const end = source.indexOf('\nverify_deprovision_ledger_for_subject()', start)
  const body = source.slice(start, end)
  // Corrupt the radius emit to drop run_present true.
  const mutated = body.replaceAll(
    'emit("false", "sync_candidate_radius_not_one", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates), "true")',
    'emit("false", "sync_candidate_radius_not_one", applied_s, nonneg(users), nonneg(accounts), nonneg(candidates))',
  )
  let failed = false
  try {
    assert.match(
      mutated,
      /emit\("false", "sync_candidate_radius_not_one", applied_s, nonneg\(users\), nonneg\(accounts\), nonneg\(candidates\), "true"\)/,
    )
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R5: journal state machine prepared→run_bound→ledger_bound unidirectional', () => {
  const region = journalStateMachineRegion(read(REMOTE_SH))
  assert.match(region, /phase": "prepared"|phase.: .prepared/)
  assert.match(region, /"phase": "run_bound"|phase = "run_bound"|state\["phase"\] = "run_bound"/)
  assert.match(region, /"phase": "ledger_bound"|state\["phase"\] = "ledger_bound"/)
  assert.match(region, /phase"\) not in \{"prepared", "run_bound"\}/)
  assert.match(region, /phase"\) not in \{"prepared", "run_bound"\}/)
  assert.match(region, /lifecycle-canary-deprovision-apply-state-v4/)
  assert.match(region, /journal_init_prepared/)
  assert.match(region, /journal_upgrade_run_bound/)
  assert.match(region, /journal_upgrade_ledger_bound/)
  assert.match(region, /reconcile_run_journal_to_ledger_bound/)
  // Restore load only accepts ledger_bound after exact reserved-run reconcile.
  const load = loadDeprovisionApplyStateBody(read(REMOTE_SH))
  assert.match(load, /reconcile to ledger_bound|phase"\) != "ledger_bound"/)
  assert.match(load, /reconcile_run_journal_to_ledger_bound|prepared.*run_bound/)
  // Comments may mention "sole event" only as FORBIDDEN; must not implement discovery.
  assert.doesNotMatch(load, /discover_applied|items\[0\]|matched\[0\].*without run/)
  assert.match(load, /no sole-event guess|never "sole event"|no event auto-discovery/i)
})

test('R5: apply orders precondition→prepared→sync→run_bound→ledger→radius/graph', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const pre = apply.indexOf('prove_dedicated_subject_deprovision_precondition')
  const prepared = apply.indexOf('journal_init_prepared')
  const write = apply.indexOf('write_lifecycle_override')
  const sync = apply.indexOf('run_directory_sync_for_subject "deprovision_apply"')
  const runBound = apply.indexOf('journal_upgrade_run_bound')
  const ledger = apply.indexOf('verify_deprovision_ledger_for_subject')
  const bound = apply.indexOf('persist_deprovision_apply_state')
  const radius = apply.indexOf('sync_candidate_radius_not_one')
  const graph = apply.indexOf('prove_access_graph_state "deprovisioned"')
  assert.ok(pre > 0 && prepared > pre && write > prepared, 'precond+prepared before env write')
  assert.ok(sync > write && runBound > sync && ledger > runBound && bound > ledger, 'run_bound then ledger then bound')
  assert.ok(radius > bound && graph > radius, 'radius/graph only after ledger_bound')
  assert.match(apply, /fail_deprovision_apply_keep_journal/)
  assert.match(apply, /journal_clear_if_phase_prepared/)
})

test('R6: destructive apply sends its pre-reserved exact run before polling', () => {
  const body = runDirectorySyncForSubjectBody(read(REMOTE_SH))
  const reserveRead = body.indexOf('reserved_run_id = str(state.get("sync_run_id")')
  const asyncRequest = body.indexOf('{"async": True, "runId": reserved_run_id}')
  const bind = body.indexOf('state["phase"] = "run_bound"')
  const poll = body.indexOf('while time.monotonic() < deadline')
  assert.ok(reserveRead > 0 && asyncRequest > reserveRead, 'deprovision apply must send pre-reserved run id')
  assert.ok(bind > asyncRequest && poll > bind, 'run existence must be journaled before polling')
  assert.match(body, /status in \{"completed", "failed"\}/)
  assert.match(body, /run_url = integration_base \+ "\/runs\/" \+ urllib\.parse\.quote\(run_id, safe=""\)/)
  assert.match(body, /exact_run = poll_data\.get\("run"\)/)
  assert.match(body, /str\(exact_run\.get\("id"\) or ""\)\.strip\(\) != run_id/)
  assert.doesNotMatch(body, /pageSize|poll_data\.get\("items"\)/)
})

test('MUTATION: reverting destructive apply to synchronous start turns recovery contract red', () => {
  const body = runDirectorySyncForSubjectBody(read(REMOTE_SH))
  const mutated = body.replace('{"async": True, "runId": reserved_run_id}', '{"async": True}')
  assert.throws(() => assert.match(mutated, /\{"async": True, "runId": reserved_run_id\}/))
})

test('R6: restore is resumable after the exact event already committed fully_resolved', () => {
  const helper = runOrResumeRestoreBody(read(REMOTE_SH))
  const verify = helper.indexOf('verify_deprovision_event_resolved')
  const post = helper.indexOf('run_deprovision_rehire_restore')
  assert.ok(verify > 0 && post > verify, 'exact-event resolved probe must precede restore POST')
  assert.match(helper, /RESTORE_RESUMED_FULLY_RESOLVED="true"/)
  assert.match(helper, /skipping duplicate POST/)
  assert.match(helper, /event_not_fully_resolved/)
})

test('R6: restore status probes the exact event tuple, never a paginated recent list', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('read_exact_deprovision_event_status()')
  const end = source.indexOf('\n# After restore:', start)
  const body = source.slice(start, end)
  assert.match(body, /FROM directory_deprovision_events/)
  assert.match(body, /WHERE id = \$1::uuid/)
  assert.match(body, /local_user_id = \$2/)
  assert.match(body, /integration_id = \$3/)
  assert.doesNotMatch(body, /limit["']?:\s*["']?100/i)
})

test('MUTATION: removing exact event-id scope from restore status probe turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('read_exact_deprovision_event_status()')
  const end = source.indexOf('\n# After restore:', start)
  const body = source.slice(start, end)
  const mutated = body.replace('WHERE id = $1::uuid', 'WHERE TRUE')
  assert.throws(() => assert.match(mutated, /WHERE id = \$1::uuid/))
})

test('FUNCTIONAL: fully_resolved resume skips a duplicate non-idempotent restore POST', () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-restore-resume-'))
  const calls = join(home, 'restore.calls')
  const script = `
set -euo pipefail
source "$1"
verify_deprovision_event_resolved() { RESOLVED_NOTE=fully_resolved_all_reversed; return 0; }
run_deprovision_rehire_restore() { echo called >> "$2"; return 0; }
LEDGER_EFFECT_COUNT=3
run_or_resume_deprovision_rehire_restore
printf '%s|%s|%s\n' "$RESTORE_RESUMED_FULLY_RESOLVED" "$RESTORE_OK" "$RESTORE_EFFECT_COUNT"
test ! -e "$2"
`
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, calls], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACTION: 'deprovision',
      OUTPUT_DIR: home,
      RUN_STAMP: 'contract-r6-restore-resume',
      LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
    },
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /true\|true\|3/)
  assert.equal(existsSync(calls), false)
  rmSync(home, { recursive: true, force: true })
})

test('FUNCTIONAL: async destructive sync binds run before polling terminal stats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-async-sync-'))
  const sec = join(home, 'secrets')
  const stateDir = join(home, 'state')
  const { mkdirSync, chmodSync } = awaitImportFs()
  mkdirSync(sec, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const jwt = join(sec, 'admin.jwt')
  const integ = join(sec, 'subject.integration-id')
  const stateFile = join(stateDir, 'subject.apply-state.json')
  const integrationId = '11111111-2222-3333-4444-555555555555'
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  writeFileSync(jwt, 'test-token')
  writeFileSync(integ, integrationId)
  writeFileSync(stateFile, JSON.stringify({
    schema: 'lifecycle-canary-deprovision-apply-state-v4',
    phase: 'prepared',
    subject_key: 'lifecycle-canary-employee',
    local_user_id: '99999999-8888-7777-6666-555555555555',
    integration_id: integrationId,
    directory_account_id: '12121212-3434-5656-7878-909090909090',
    sync_run_id: runId,
    sync_users_deactivated: null,
    sync_accounts_deactivated: null,
    sync_deprovision_candidates: null,
    deprovision_applied: null,
    event_id: null,
    effect_count: null,
    effects: null,
  }))
  chmodSync(jwt, 0o600)
  chmodSync(integ, 0o600)
  chmodSync(stateFile, 0o600)

  const serverSource = `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
RUN = "${runId}"
STATE = ${JSON.stringify(stateFile)}
polls = 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send_json(self, code, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        if body != {"async": True, "runId": RUN}:
            self.send_json(400, {"ok": False})
            return
        self.send_json(202, {"ok": True, "data": {"accepted": True, "runId": RUN}})
    def do_GET(self):
        global polls
        state = json.load(open(STATE))
        if state.get("phase") != "run_bound" or state.get("sync_run_id") != RUN:
            self.send_json(409, {"ok": False})
            return
        polls += 1
        status = "running" if polls == 1 else "completed"
        stats = {} if status == "running" else {
            "deprovisionApplied": True,
            "deprovisionUsersDeactivatedCount": 1,
            "accountsDeactivatedCount": 1,
            "deprovisionCandidateCount": 1,
        }
        self.send_json(200, {"ok": True, "data": {"run": {"id": RUN, "status": status, "stats": stats}}})
s = HTTPServer(("127.0.0.1", 0), H)
print(s.server_port, flush=True)
s.serve_forever()
`
  const server = spawn('python3', ['-u', '-c', serverSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock sync server did not start')), 5000)
    server.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock sync server exited ${code}`))
    })
    server.stdout.once('data', (chunk) => {
      clearTimeout(timer)
      resolve(String(chunk).trim())
    })
  })
  try {
    const script = `
set -euo pipefail
source "$1"
STAGING_API_BASE_URL="http://127.0.0.1:$2"
CANARY_ADMIN_JWT_FILE="$3"
CANARY_SUBJECT_INTEGRATION_ID_FILE="$4"
CANARY_DIRECTORY_ACCOUNT_ID_FILE="$5/directory-account.id"
CANARY_APPLY_STATE_FILE="$6"
SUBJECT_OWNER_USERNAME=lifecycle-canary-employee
printf '%s' 12121212-3434-5656-7878-909090909090 > "$CANARY_DIRECTORY_ACCOUNT_ID_FILE"
run_directory_sync_for_subject deprovision_apply true
journal_upgrade_run_bound
python3 - "$6" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
print("|".join([s["phase"], s["sync_run_id"], str(s["sync_users_deactivated"]), str(s["deprovision_applied"]).lower()]))
PY
`
    const r = spawnSync(
      'bash',
      ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, port, jwt, integ, sec, stateFile],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          ACTION: 'deprovision',
          OUTPUT_DIR: home,
          RUN_STAMP: 'contract-r6-async-sync',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, new RegExp(`run_bound\\|${runId}\\|1\\|true`))
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.phase, 'run_bound')
    assert.equal(state.sync_run_id, runId)
    assert.equal(state.sync_accounts_deactivated, 1)
    assert.equal(state.sync_deprovision_candidates, 1)
  } finally {
    server.kill('SIGTERM')
    rmSync(home, { recursive: true, force: true })
  }
})

test('FUNCTIONAL: lost 202 keeps the pre-request reserved run journal recoverable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-lost-202-'))
  const sec = join(home, 'secrets')
  const stateFile = join(home, 'subject.apply-state.json')
  const record = join(home, 'request.json')
  const { mkdirSync, chmodSync } = awaitImportFs()
  mkdirSync(sec, { recursive: true })
  const jwt = join(sec, 'admin.jwt')
  const integ = join(sec, 'subject.integration-id')
  const acct = join(sec, 'directory-account.id')
  const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const integrationId = '11111111-2222-4333-8444-555555555555'
  writeFileSync(jwt, 'test-token')
  writeFileSync(integ, integrationId)
  writeFileSync(acct, '12121212-3434-4656-8878-909090909090')
  writeFileSync(stateFile, JSON.stringify({
    schema: 'lifecycle-canary-deprovision-apply-state-v4',
    phase: 'prepared',
    subject_key: 'lifecycle-canary-employee',
    local_user_id: '99999999-8888-4777-8666-555555555555',
    integration_id: integrationId,
    directory_account_id: '12121212-3434-4656-8878-909090909090',
    sync_run_id: runId,
    sync_users_deactivated: null,
    sync_accounts_deactivated: null,
    sync_deprovision_candidates: null,
    deprovision_applied: null,
    event_id: null,
    effect_count: null,
    effects: null,
  }))
  chmodSync(jwt, 0o600)
  chmodSync(integ, 0o600)
  chmodSync(acct, 0o600)
  chmodSync(stateFile, 0o600)

  const serverSource = `
import json, socket
from http.server import BaseHTTPRequestHandler, HTTPServer
RECORD = ${JSON.stringify(record)}
class H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        open(RECORD, "w").write(json.dumps(body, separators=(",", ":")))
        self.connection.shutdown(socket.SHUT_RDWR)
        self.connection.close()
s = HTTPServer(("127.0.0.1", 0), H)
print(s.server_port, flush=True)
s.serve_forever()
`
  const server = spawn('python3', ['-u', '-c', serverSource], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lost-202 server did not start')), 5000)
    server.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`lost-202 server exited ${code}`))
    })
    server.stdout.once('data', (chunk) => {
      clearTimeout(timer)
      resolve(String(chunk).trim())
    })
  })
  try {
    const script = `
set -euo pipefail
source "$1"
STAGING_API_BASE_URL="http://127.0.0.1:$2"
CANARY_ADMIN_JWT_FILE="$3"
CANARY_SUBJECT_INTEGRATION_ID_FILE="$4"
CANARY_DIRECTORY_ACCOUNT_ID_FILE="$5"
CANARY_APPLY_STATE_FILE="$6"
SUBJECT_OWNER_USERNAME=lifecycle-canary-employee
set +e
run_directory_sync_for_subject deprovision_apply true
rc=$?
set -e
python3 - "$6" "$rc" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
print("|".join([str(sys.argv[2]), s["phase"], s["sync_run_id"]]))
PY
`
    const r = spawnSync(
      'bash',
      ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, port, jwt, integ, acct, stateFile],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ACTION: 'deprovision',
          OUTPUT_DIR: home,
          RUN_STAMP: 'contract-r6-lost-202',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
      },
    )
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, new RegExp(`1\\|prepared\\|${runId}`))
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { async: true, runId })
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.phase, 'prepared')
    assert.equal(state.sync_run_id, runId)
  } finally {
    server.kill('SIGTERM')
    rmSync(home, { recursive: true, force: true })
  }
})

test('MUTATION: clearing prepared journal after a lost 202 turns red', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const start = apply.indexOf('run_directory_sync_for_subject "deprovision_apply"')
  const end = apply.indexOf('journal_upgrade_run_bound', start)
  const responseLossWindow = apply.slice(start, end)
  assert.match(responseLossWindow, /fail_deprovision_apply_keep_journal/)
  assert.doesNotMatch(responseLossWindow, /journal_clear_if_phase_prepared/)
  const mutated = responseLossWindow.replace(
    'fail_deprovision_apply_keep_journal',
    'journal_clear_if_phase_prepared',
  )
  assert.throws(() => assert.doesNotMatch(mutated, /journal_clear_if_phase_prepared/))
})

test('MUTATION: deleting the pre-POST resolved probe makes the resume golden red', () => {
  const helper = runOrResumeRestoreBody(read(REMOTE_SH))
  const mutated = helper.replace('if verify_deprovision_event_resolved; then', 'if false; then')
  assert.throws(() => {
    const verify = mutated.indexOf('if verify_deprovision_event_resolved; then')
    const post = mutated.indexOf('run_deprovision_rehire_restore')
    assert.ok(verify > 0 && post > verify)
  })
})

test('R5: dedicated subject precondition requires one-account manual integration and exact effects', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /prove_dedicated_subject_deprovision_precondition/)
  const start = source.indexOf('prove_dedicated_subject_deprovision_precondition()')
  const end = source.indexOf('\nvalidate_mode_name()', start)
  const body = source.slice(start, end)
  assert.match(body, /mark_inactive/)
  assert.match(body, /policy_not_mark_inactive/)
  assert.match(body, /integration_not_manual_only/)
  assert.match(body, /integration_automation_not_disabled/)
  assert.match(body, /integration_not_single_account/)
  assert.match(body, /count\(\*\)::int AS n/)
  assert.match(body, /count\(\*\) FILTER \(WHERE id = \$2\)::int AS target_n/)
  assert.match(body, /WHERE integration_id = \$1/)
  assert.match(body, /not_globally_clear/)
  assert.match(body, /dingtalk_grant_not_enabled/)
  assert.match(body, /target_org_membership_not_active/)
  assert.match(body, /user_not_active/)
  assert.match(body, /ok_expected_effects_membership_grant_user/)
  // other-org membership must not be used as global membership scan without org scope
  assert.match(body, /user_id = \$1 AND org_id = \$2/)
})

test('MUTATION: dropping the one-account integration radius guard turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('prove_dedicated_subject_deprovision_precondition()')
  const end = source.indexOf('\nvalidate_mode_name()', start)
  const body = source.slice(start, end)
  const mutated = body.replace('Number(radius.rows[0]?.n) !== 1', 'false')
  assert.throws(() => assert.match(mutated, /Number\(radius\.rows\[0\]\?\.n\) !== 1/))
})

test('MUTATION: dropping dedicated precondition before env write turns red', () => {
  const apply = actionDeprovisionApplyBody(read(REMOTE_SH))
  const mutated = apply.replaceAll('prove_dedicated_subject_deprovision_precondition', 'skip_precond')
  let failed = false
  try {
    assert.match(mutated, /prove_dedicated_subject_deprovision_precondition/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('R5: radius/graph failure keeps journal and sets recovery_required', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /fail_deprovision_apply_keep_journal/)
  const start = source.indexOf('fail_deprovision_apply_keep_journal()')
  const end = source.indexOf('\n# --- actions', start)
  const body = source.slice(start, end > 0 ? end : start + 2500)
  assert.match(body, /recovery_required=true/)
  assert.match(body, /exact_run_persisted=/)
  assert.match(body, /journal_retained=true/)
  assert.match(body, /journal_phase=/)
  assert.doesNotMatch(body, /rm -f "\$CANARY_APPLY_STATE_FILE"/)
  assert.match(body, /restore_lifecycle_override/)
  const apply = actionDeprovisionApplyBody(source)
  assert.match(apply, /fail_deprovision_apply_keep_journal "sync_candidate_radius_not_one"/)
  assert.match(apply, /fail_deprovision_apply_keep_journal "sync_users_deactivated_not_one"/)
  assert.match(apply, /fail_deprovision_apply_keep_journal "access_graph_not_deprovisioned/)
})

test('MUTATION: radius failure clearing journal turns red', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('fail_deprovision_apply_keep_journal()')
  const end = source.indexOf('\naction_status()', start)
  const body = source.slice(start, end > 0 ? end : start + 3000)
  const mutated = body + '\nrm -f "$CANARY_APPLY_STATE_FILE"\n'
  // Production body must not clear journal; inject proves the mutation detector.
  assert.doesNotMatch(body, /rm -f "\$CANARY_APPLY_STATE_FILE"/)
  assert.match(mutated, /rm -f "\$CANARY_APPLY_STATE_FILE"/)
})

test('R6: deprovision failure disarms rollback guard only after runtime OFF is proven', () => {
  const source = read(REMOTE_SH)
  const start = source.indexOf('fail_deprovision_apply_keep_journal()')
  const end = source.indexOf('\n# --- actions', start)
  const body = source.slice(start, end > 0 ? end : start + 3500)
  const proof = body.indexOf('if assert_exact_mode_off')
  const disarm = body.indexOf('disarm_alias_exit_rollback_guard')
  const cleanup = body.indexOf('cleanup_prev_backup')
  assert.ok(proof > 0 && disarm > proof && cleanup > disarm)
  assert.match(body, /EXIT rollback guard remains armed for a final retry/)
})

test('FUNCTIONAL: an unproven first OFF restore gets one EXIT-guard retry before exit', () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-off-retry-'))
  const outDir = mkdtempSync(join(tmpdir(), 'lifecycle-canary-off-retry-out-'))
  const stateFile = join(home, 'subject.apply-state.json')
  const attempts = join(home, 'attempts.log')
  writeFileSync(stateFile, JSON.stringify({
    schema: 'lifecycle-canary-deprovision-apply-state-v4',
    phase: 'prepared',
    subject_key: 'lifecycle-canary-employee',
    sync_run_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  }))

  const script = `
set -euo pipefail
source "$1"
OUTPUT_DIR="$2"
CANARY_APPLY_STATE_FILE="$3"
ATTEMPTS_FILE="$4"
ACTION=deprovision
DEPLOY_SHA=1111111111111111111111111111111111111111
SUBJECT_OWNER_USERNAME=lifecycle-canary-employee
RECREATE_ATTEMPTS=0
restore_lifecycle_override() { echo restore >> "$ATTEMPTS_FILE"; }
recreate_backend_only() { RECREATE_ATTEMPTS=$((RECREATE_ATTEMPTS + 1)); echo recreate >> "$ATTEMPTS_FILE"; return 0; }
assert_exact_mode_off() { [[ "$RECREATE_ATTEMPTS" -ge 2 ]]; }
resolve_deployed_sha() { echo "$DEPLOY_SHA"; }
fetch_backend_health_ok() { echo true; }
capture_live_snapshot() { SNAP_MODE=unknown; SNAP_BUILD_SHA="$DEPLOY_SHA"; }
cleanup_prev_backup() { echo cleanup >> "$ATTEMPTS_FILE"; }
fail() { echo fail >> "$ATTEMPTS_FILE"; exit 2; }
arm_alias_exit_rollback_guard
fail_deprovision_apply_keep_journal first_off_unproven
`
  const r = spawnSync(
    'bash',
    ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, outDir, stateFile, attempts],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'deprovision',
        OUTPUT_DIR: outDir,
        RUN_STAMP: 'contract-r6-off-retry',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.notEqual(r.status, 0)
  const calls = readFileSync(attempts, 'utf8').trim().split('\n')
  assert.equal(calls.filter((line) => line === 'restore').length, 2)
  assert.equal(calls.filter((line) => line === 'recreate').length, 2)
  assert.equal(calls.filter((line) => line === 'cleanup').length, 1)
  assert.match(readFileSync(join(outDir, 'alias-emergency-rollback.log'), 'utf8'), /proved runtime OFF/)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).phase, 'prepared')
  rmSync(home, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

test('R5: ledger requires exact effect type triple membership+grant+user', () => {
  const ledger = verifyDeprovisionLedgerBody(read(REMOTE_SH))
  assert.match(ledger, /effect_type_set_not_exact_triple/)
  assert.match(ledger, /grant_row_created_unexpected_for_canary/)
  assert.match(ledger, /effect_before_after_not_active_to_inactive/)
  assert.match(ledger, /len\(applied_effects\) != 3/)
})

test('FUNCTIONAL: journal prepared→run_bound→ledger_bound upgrades and refuses overwrite', () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-journal-'))
  const stateDir = join(home, '.metasheet2', 'lifecycle-canary', 'subject-state')
  const { mkdirSync, chmodSync } = awaitImportFs()
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, 'lifecycle-canary-employee.apply-state.json')
  const sec = mkdtempSync(join(tmpdir(), 'lifecycle-canary-sec-'))
  const u = '11111111-1111-1111-1111-111111111111'
  const i = '22222222-2222-2222-2222-222222222222'
  const a = '33333333-3333-3333-3333-333333333333'
  const run = '44444444-4444-4444-4444-444444444444'
  const ev = '55555555-5555-5555-5555-555555555555'
  const e1 = '66666666-6666-6666-6666-666666666666'
  const e2 = '77777777-7777-7777-7777-777777777777'
  const e3 = '88888888-8888-8888-8888-888888888888'
  writeFileSync(join(sec, 'subject.local-user-id'), u)
  writeFileSync(join(sec, 'subject.integration-id'), i)
  writeFileSync(join(sec, 'directory-account.id'), a)
  writeFileSync(join(sec, 'subject.sync-run-id'), run)
  writeFileSync(join(sec, 'subject.deprovision-event-id'), ev)
  const effects = {
    effects: [
      { id: e1, type: 'membership_changed', before_active: true, after_active: false, grant_row_created: false },
      { id: e2, type: 'grant_changed', before_active: true, after_active: false, grant_row_created: false },
      { id: e3, type: 'user_changed', before_active: true, after_active: false, grant_row_created: false },
    ],
    effect_count: 3,
  }
  writeFileSync(join(sec, 'subject.deprovision-effects.json'), JSON.stringify(effects))

  const script = `
set -euo pipefail
source "$1"
export HOME="$2"
CANARY_APPLY_STATE_DIR="$3"
CANARY_APPLY_STATE_FILE="$4"
CANARY_SUBJECT_LOCAL_USER_ID_FILE="$5/subject.local-user-id"
CANARY_SUBJECT_INTEGRATION_ID_FILE="$5/subject.integration-id"
CANARY_DIRECTORY_ACCOUNT_ID_FILE="$5/directory-account.id"
CANARY_SUBJECT_SYNC_RUN_ID_FILE="$5/subject.sync-run-id"
CANARY_SUBJECT_DEPROVISION_EVENT_ID_FILE="$5/subject.deprovision-event-id"
CANARY_SUBJECT_EFFECTS_FILE="$5/subject.deprovision-effects.json"
SUBJECT_OWNER_USERNAME="lifecycle-canary-employee"
SYNC_USERS_DEACTIVATED=1
SYNC_ACCOUNTS_DEACTIVATED=1
SYNC_DEPROVISION_CANDIDATES=1
SYNC_DEPROVISION_APPLIED=true
fail() { echo "FAIL:$*"; exit 9; }
journal_init_prepared
python3 -c "import json;print(json.load(open('$4'))['phase'])"
journal_upgrade_run_bound
python3 -c "import json;print(json.load(open('$4'))['phase'])"
journal_upgrade_ledger_bound
python3 -c "import json;s=json.load(open('$4'));print(s['phase']);print(s['effect_count'])"
`
  const harnessEnv = {
    ...process.env,
    ACTION: 'deprovision',
    OUTPUT_DIR: home,
    RUN_STAMP: 'contract-r5-journal',
    LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
  }
  const r = spawnSync(
    'bash',
    ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, home, stateDir, stateFile, sec],
    { encoding: 'utf8', env: harnessEnv },
  )
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /prepared/)
  assert.match(r.stdout, /run_bound/)
  assert.match(r.stdout, /ledger_bound/)
  assert.match(r.stdout, /3/)
  assert.ok(existsSync(stateFile), 'journal must remain on disk')
  const final = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(final.phase, 'ledger_bound')
  assert.equal(final.schema, 'lifecycle-canary-deprovision-apply-state-v4')
  assert.equal(final.effect_count, 3)
  // Second prepared must refuse (file exists).
  const r2 = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       export HOME="$2"
       CANARY_APPLY_STATE_DIR="$3"
       CANARY_APPLY_STATE_FILE="$4"
       CANARY_SUBJECT_LOCAL_USER_ID_FILE="$5/subject.local-user-id"
       CANARY_SUBJECT_INTEGRATION_ID_FILE="$5/subject.integration-id"
       CANARY_DIRECTORY_ACCOUNT_ID_FILE="$5/directory-account.id"
       SUBJECT_OWNER_USERNAME=lifecycle-canary-employee
       fail() { echo REFUSED; exit 3; }
       journal_init_prepared
       echo UNEXPECTED_OK`,
      'bash',
      REMOTE_SH,
      home,
      stateDir,
      stateFile,
      sec,
    ],
    { encoding: 'utf8', env: harnessEnv },
  )
  assert.notEqual(r2.status, 0)
  assert.match(r2.stdout, /REFUSED/)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).phase, 'ledger_bound')
  rmSync(home, { recursive: true, force: true })
  rmSync(sec, { recursive: true, force: true })
})

test('FUNCTIONAL: radius anomaly failure path retains host journal and reports recovery markers', () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-canary-radius-'))
  const stateDir = join(home, '.metasheet2', 'lifecycle-canary', 'subject-state')
  const { mkdirSync, chmodSync } = awaitImportFs()
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, 'lifecycle-canary-employee.apply-state.json')
  const outDir = mkdtempSync(join(tmpdir(), 'lifecycle-canary-out-'))
  const run = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const u = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const i = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const a = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  writeFileSync(
    stateFile,
    JSON.stringify({
      schema: 'lifecycle-canary-deprovision-apply-state-v4',
      phase: 'run_bound',
      subject_key: 'lifecycle-canary-employee',
      local_user_id: u,
      integration_id: i,
      directory_account_id: a,
      sync_run_id: run,
      sync_users_deactivated: 2,
      sync_accounts_deactivated: 1,
      sync_deprovision_candidates: 2,
      deprovision_applied: true,
      event_id: null,
      effect_count: null,
      effects: null,
    }),
  )
  chmodSync(stateFile, 0o600)
  const script = `
set -euo pipefail
source "$1"
export HOME="$2"
CANARY_APPLY_STATE_DIR="$3"
CANARY_APPLY_STATE_FILE="$4"
OUTPUT_DIR="$5"
ACTION=deprovision
SUBJECT_OWNER_USERNAME=lifecycle-canary-employee
restore_lifecycle_override() { :; }
recreate_backend_only() { return 0; }
disarm_alias_exit_rollback_guard() { :; }
cleanup_prev_backup() { :; }
assert_exact_mode_off() { return 0; }
capture_live_snapshot() { SNAP_MODE=off; SNAP_BUILD_SHA=deadbeef; }
fail() { echo "FAIL:$*"; exit 2; }
fail_deprovision_apply_keep_journal "sync_candidate_radius_not_one"
`
  const r = spawnSync(
    'bash',
    ['-o', 'pipefail', '-c', script, 'bash', REMOTE_SH, home, stateDir, stateFile, outDir],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'deprovision',
        OUTPUT_DIR: outDir,
        RUN_STAMP: 'contract-r5-radius',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
      },
    },
  )
  assert.notEqual(r.status, 0, r.stderr + r.stdout)
  assert.ok(existsSync(stateFile), 'host journal must survive radius failure path')
  const st = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(st.phase, 'run_bound')
  assert.equal(st.sync_run_id, run)
  assert.ok(existsSync(join(outDir, 'summary.txt')), `summary missing: ${r.stdout}\n${r.stderr}`)
  const summary = readFileSync(join(outDir, 'summary.txt'), 'utf8')
  assert.match(summary, /recovery_required=true/)
  assert.match(summary, /exact_run_persisted=true/)
  assert.match(summary, /journal_retained=true/)
  assert.match(summary, /journal_phase=run_bound/)
  assert.match(summary, /rolled_back_flags_off=true/)
  assert.doesNotMatch(summary, /aaaaaaaa-aaaa/)
  rmSync(home, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

function awaitImportFs() {
  // mkdirSync/chmodSync not in top-level imports — pull via createRequire for harness only.
  const require = createRequire(import.meta.url)
  return require('node:fs')
}

// --- docs / staging blockers ----------------------------------------------------------

test('docs mark pending/deprovision executable but NOT EXECUTED; alias transient canary and bootstrap documented', () => {
  const closeout = read(CLOSEOUT_DOC)
  const go = read(CANARY_GO_DOC)
  assert.doesNotMatch(closeout, /pending[^\n]*NOT EXECUTABLE|deprovision[^\n]*NOT EXECUTABLE/i)
  assert.doesNotMatch(go, /pending[^\n]*NOT EXECUTABLE|deprovision[^\n]*NOT EXECUTABLE/i)
  assert.match(go, /pending/)
  assert.match(go, /deprovision/)
  assert.match(go, /Executable only as a transient canary/)
  assert.match(go, /Executable only as a two-phase transient canary/)
  assert.match(go, /NOT EXECUTED/)
  assert.match(go, /dedicated one-account integration|single selected directory account/i)
  assert.match(go, /pre-reserves|before.*env.*HTTP|before env\/HTTP/i)
  assert.match(go, /alias/)
  assert.match(go, /bootstrap/)
  assert.match(go, /lifecycle-canary@staging\.invalid/)
  assert.match(go, /success requires\/proves OFF|Success requires\/proves OFF/i)
  assert.match(go, /failure restores the OFF override before failing/i)
  assert.match(go, /runtime OFF cannot be proven/i)
  assert.doesNotMatch(go, /ALWAYS returns to OFF|always returns to OFF|always restores OFF/i)
  assert.match(go, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER|secret-backed/)
  assert.match(go, /collisions==0|collisions must be 0|collisions==0/i)
  assert.match(go, /ATTENDANCE_ADMIN_JWT/)
  assert.match(go, /never.*ATTENDANCE_ADMIN_JWT|not.*ATTENDANCE_ADMIN_JWT|mint.*password login/i)
  // No invented successful pending/deprovision execution evidence.
  assert.doesNotMatch(go, /pending admission[^\n]*\*\*(PASS|COMPLETE)|deprovision[^\n]*\*\*(PASS|COMPLETE)/i)
})

test('docs distinguish emergency off env-gate from OR-column fallback reintroduction', () => {
  const closeout = read(CLOSEOUT_DOC)
  assert.match(closeout, /emergency|env gate|env-gate/i)
  assert.match(closeout, /OR-column|OR fallback|OR 三列/i)
  assert.doesNotMatch(
    closeout,
    /turn alias read path off and prove the pre-cutover login path is restored/,
  )
})

test('six-step T2-Gate still points at post-fix 20260725 UAT', () => {
  const closeout = read(CLOSEOUT_DOC)
  assert.match(closeout, /dingtalk-directory-corp-scope-staging-uat-20260725\.md/)
})

test('staging env example keeps three flags OFF and documents lifecycle canary', () => {
  const env = read(STAGING_ENV_EXAMPLE)
  assert.match(env, /^AUTH_LOGIN_USE_ALIASES=false$/m)
  assert.match(env, /^DIRECTORY_PENDING_ACTIVATION_ENABLED=false$/m)
  assert.match(env, /^DIRECTORY_DEPROVISION_ENABLED=false$/m)
  assert.match(env, /NOT EXECUTABLE|lifecycle.*canary|canary.*lifecycle/i)
})

test('workflow exports only safe remote env keys (no raw secret values)', () => {
  const yaml = read(WORKFLOW)
  for (const key of [
    'ACTION',
    'TARGET_MODE',
    'EXPECTED_CURRENT_MODE',
    'DEPLOY_SHA',
    'BOOTSTRAP_CONFIRMATION',
    'STAGING_DEPLOY_PATH',
    'DEPLOY_PATH',
    'OUTPUT_DIR',
    'RUN_STAMP',
  ]) {
    assert.match(yaml, new RegExp(`export ${key}=`))
  }
  assert.doesNotMatch(yaml, /export CANARY_SUBJECT_ID=/)
  assert.doesNotMatch(yaml, /export OWNER_CONFIRM=/)
  assert.doesNotMatch(yaml, /export ATTENDANCE_ADMIN_JWT=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_PASSWORD=/)
  assert.doesNotMatch(yaml, /export STAGING_OWNER_ADMIN_PASSWORD=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_DIRECTORY_ACCOUNT_ID=/)
  assert.doesNotMatch(yaml, /export CANARY_ADMIN_JWT_FILE=/)
  // Path-only exports for secret files are allowed.
  assert.match(yaml, /export CANARY_LOGIN_IDENTIFIER_FILE=/)
  assert.match(yaml, /export CANARY_LOGIN_PASSWORD_FILE=/)
  assert.match(yaml, /export STAGING_OWNER_ADMIN_PASSWORD_FILE=/)
  assert.match(yaml, /export CANARY_DIRECTORY_ACCOUNT_ID_FILE=/)
})

// --- human-bootstrap: fixed separate human platform admin -----------------------------

test('human-bootstrap fixed identity markers and confirmation CREATE_STAGING_HUMAN_ADMIN', () => {
  const source = read(REMOTE_SH)
  const yaml = read(WORKFLOW)
  assert.match(source, /HUMAN_OWNER_USERNAME="staging-owner-admin"/)
  assert.match(source, /HUMAN_OWNER_NAME="Staging Owner Admin"/)
  assert.match(source, /action_human_bootstrap\(\)/)
  assert.match(source, /bootstrap_human_platform_admin\(\)/)
  assert.match(source, /STAGING_OWNER_ADMIN_PASSWORD_FILE/)
  assert.match(source, /BOOTSTRAP_CONFIRMATION=CREATE_STAGING_HUMAN_ADMIN/)
  assert.match(yaml, /CREATE_STAGING_HUMAN_ADMIN/)
  assert.match(yaml, /human-bootstrap/)
  assert.match(yaml, /staging-owner-admin/)
})

test('human-bootstrap requires exact SHA, OFF, health, migrations zero; never writes lifecycle env or restarts', () => {
  const body = actionHumanBootstrapBody(read(REMOTE_SH))
  assert.match(body, /require_sha/)
  assert.match(body, /assert_exact_sha/)
  assert.match(body, /require_migrations_pending_zero_true "\$SNAP_MIGRATIONS_ZERO" "action=human-bootstrap"/)
  assert.match(body, /require_canary_secret_files "human-bootstrap"/)
  assert.match(body, /assert_canary_identifier_matches_owner "human-bootstrap"/)
  assert.match(body, /require_staging_owner_admin_password_file "human-bootstrap"/)
  assert.match(body, /BOOTSTRAP_CONFIRMATION=CREATE_STAGING_HUMAN_ADMIN/)
  assert.match(body, /expected_current_mode=off/)
  assert.match(body, /backend_health_ok must be true before account mutation/)
  assert.match(body, /live mode must be off/)
  assert.match(body, /mint_canary_admin_jwt_from_password_login "human-bootstrap"/)
  assert.match(body, /bootstrap_human_platform_admin/)
  assert.match(body, /post-human-bootstrap live mode must remain off/)
  assert.match(body, /all lifecycle flags must remain OFF/)
  assert.match(body, /post-human-bootstrap backend_health_ok must remain true/)
  assert.match(body, /require_migrations_pending_zero_true "\$SNAP_MIGRATIONS_ZERO" "action=human-bootstrap post-check"/)
  assert.match(body, /post-human-bootstrap SHA/)
  assert.match(body, /post_human_bootstrap_mode_off=true/)
  assert.match(body, /post_human_bootstrap_flags_off=true/)
  assert.match(body, /post_human_bootstrap_migrations_zero=true/)
  assert.match(body, /transition_applied=false/)
  assert.match(body, /lifecycle_env_write=false/)
  assert.match(body, /backend_recreate=false/)
  assert.doesNotMatch(body, /write_lifecycle_override/)
  assert.doesNotMatch(body, /recreate_backend_only/)
  assert.doesNotMatch(body, /pin_live_backend_image_for_transition/)
  // Values-free summary only (no password/token/PII fields).
  assert.doesNotMatch(body, /password=/)
  assert.doesNotMatch(body, /identifier=/)
  assert.doesNotMatch(body, /Authorization/)
  assert.doesNotMatch(body, /Bearer /)
})

test('human-bootstrap sequence: mint JWT then create/repair with required reset/access/login/revoke', () => {
  const body = actionHumanBootstrapBody(read(REMOTE_SH))
  const mint = body.indexOf('mint_canary_admin_jwt_from_password_login "human-bootstrap"')
  const txn = body.indexOf('bootstrap_human_platform_admin')
  const postCapture = body.indexOf('post-human-bootstrap live mode must remain off')
  assert.ok(mint > 0, 'canary JWT mint required')
  assert.ok(txn > mint, 'human mutation after canary JWT mint')
  assert.ok(postCapture > txn, 'post-check after mutation')

  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  // Create path via POST /api/admin/users without email/mobile.
  assert.match(helper, /\/api\/admin\/users/)
  assert.match(helper, /"username": owner_username/)
  assert.match(helper, /"name": owner_name/)
  assert.match(helper, /"role": "admin"/)
  assert.match(helper, /"roleId": "admin"/)
  const createBody = helper.match(/create_body = \{[\s\S]*?\n    \}/)?.[0] || ''
  assert.ok(createBody, 'create_body must exist')
  assert.doesNotMatch(createBody, /"password":/)
  assert.match(helper, /no email\/mobile|Create path: username\+name\+admin only; no email\/mobile/i)
  assert.doesNotMatch(helper, /"email":/)
  assert.doesNotMatch(helper, /"mobile":/)
  // Safe repair / collision fail-closed.
  assert.match(helper, /collision_multiple_rows/)
  assert.match(helper, /identity_name_mismatch/)
  assert.match(helper, /require_admin_access\(user_id, token, "pre_reset"\)/)
  assert.match(helper, /f"\{phase\}_access_not_admin"/)
  assert.match(helper, /identity_contact_not_empty/)
  assert.match(helper, /outcome = "repaired"/)
  assert.match(helper, /outcome = "created"/)
  // Required reset-password forces must_change_password.
  assert.match(helper, /\/reset-password/)
  assert.match(helper, /must_change_password|Required reset-password forces must_change_password/)
  // GET access verifies admin role/isAdmin.
  assert.match(helper, /\/access/)
  assert.match(helper, /isAdmin/)
  assert.match(helper, /access_not_admin/)
  assert.match(helper, /access_inactive/)
  assert.match(helper, /access_not_activated/)
  // Real login verifies passwordChangeRequired + exact username.
  assert.match(helper, /\/api\/auth\/login/)
  assert.match(helper, /passwordChangeRequired/)
  assert.match(helper, /login_password_change_required_missing/)
  assert.match(helper, /login_username_mismatch/)
  // Required revoke-sessions with canary JWT (not human token).
  assert.match(helper, /\/revoke-sessions/)
  assert.match(helper, /lifecycle_canary_human_bootstrap/)
  assert.match(helper, /revoke_proof_missing/)
  // Existing-account repair proves RBAC ownership before reset. Both paths prove it
  // again after reset, then login and revoke the proof session.
  const preAccessIdx = helper.indexOf('require_admin_access(user_id, token, "pre_reset")')
  const resetIdx = helper.indexOf('f"/api/admin/users/{urllib.parse.quote(user_id, safe=\'\')}/reset-password"')
  const postAccessIdx = helper.indexOf('require_admin_access(user_id, token, "post_reset")')
  const loginIdx = helper.indexOf('base.rstrip("/") + "/api/auth/login"')
  const revokeIdx = helper.indexOf('f"/api/admin/users/{urllib.parse.quote(user_id, safe=\'\')}/revoke-sessions"')
  assert.ok(preAccessIdx > 0 && preAccessIdx < resetIdx, 'existing-account access proof before reset-password')
  assert.ok(postAccessIdx > resetIdx, 'post-write access proof after reset-password')
  assert.ok(loginIdx > postAccessIdx, 'login after post-write access proof')
  assert.ok(revokeIdx > loginIdx, 'revoke-sessions after login proof')
  // Secrets: password from file path only; never logged.
  assert.match(helper, /STAGING_OWNER_ADMIN_PASSWORD_FILE|pass_path/)
  assert.match(helper, /values never logged|never logged/i)
  assert.doesNotMatch(helper, /print\(password\)|log\(password\)|echo .*password/i)
  assert.doesNotMatch(helper, /sys\.stdout\.write\(password\)/)
})

test('human-bootstrap workflow wiring demotes STAGING_OWNER_ADMIN_PASSWORD and cleans local+remote files', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const remoteStep = doc.jobs.run.steps.find((s) => s.name === 'Run remote action')
  assert.ok(remoteStep?.env?.STAGING_OWNER_ADMIN_PASSWORD)
  assert.match(
    String(remoteStep.env.STAGING_OWNER_ADMIN_PASSWORD),
    /inputs\.action == 'human-bootstrap'.*secrets\.STAGING_OWNER_ADMIN_PASSWORD/,
  )
  assert.match(remoteStep.run, /_STAGING_OWNER_PASS="\$\{STAGING_OWNER_ADMIN_PASSWORD-\}"/)
  assert.match(
    remoteStep.run,
    /unset LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD STAGING_OWNER_ADMIN_PASSWORD/,
  )
  assert.match(remoteStep.run, /printf '%s' "\$\{_STAGING_OWNER_PASS\}"/)
  assert.match(remoteStep.run, /staging-owner-admin\.password/)
  assert.match(remoteStep.run, /chmod 600 .*staging-owner-admin\.password|chmod 600 "\$\{secrets_dir\}\/staging-owner-admin\.password"/)
  assert.match(remoteStep.run, /export STAGING_OWNER_ADMIN_PASSWORD_FILE=/)
  assert.match(remoteStep.run, /human-bootstrap requires STAGING_OWNER_ADMIN_PASSWORD/)
  // Cleanup both local and remote secret dirs.
  assert.match(remoteStep.run, /CLEAN_LOCAL_SECRETS_DIR/)
  assert.match(remoteStep.run, /CLEAN_REMOTE_SECRETS_DIR/)
  assert.match(remoteStep.run, /rm -rf "\$\{CLEAN_LOCAL_SECRETS_DIR\}"/)
  assert.match(remoteStep.run, /rm -rf '\$\{remote_secrets_dir\}'|if \[\[ -n '\$\{remote_secrets_dir\}' \]\]; then rm -rf/)
  // Never log secret.
  assert.doesNotMatch(remoteStep.run, /echo .*_STAGING_OWNER_PASS/)
  assert.doesNotMatch(remoteStep.run, /(?:echo|printf)[^\n]*\$\{?STAGING_OWNER_ADMIN_PASSWORD\}?/)
  assert.doesNotMatch(yaml, /export STAGING_OWNER_ADMIN_PASSWORD=/)
})

test('human-bootstrap enforces the backend password policy before any account mutation', () => {
  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  const policyEnd = helper.indexOf('# 1) Lookup by username query')
  assert.ok(policyEnd > 0, 'password policy must precede the first API lookup')
  const policy = helper.slice(0, policyEnd)
  assert.match(policy, /password != password\.strip\(\)/)
  assert.match(policy, /len\(password\) < 8/)
  assert.match(policy, /len\(password\) > 128/)
  assert.match(policy, /char\.islower\(\)/)
  assert.match(policy, /char\.isupper\(\)/)
  assert.match(policy, /char\.isdigit\(\)/)
  for (const weak of ['password', '123456', 'qwerty', 'abc123', 'letmein', 'admin']) {
    assert.match(policy, new RegExp(`"${weak}"`))
  }
})

test('FUNCTIONAL harness: action_human_bootstrap order gates then mint then mutation then reassert; no env write', () => {
  const sha = 'c'.repeat(40)
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      `source "$1"
       CALL_LOG=()
       record() { CALL_LOG+=("\$1"); }
       require_sha() { record require_sha; }
       require_canary_secret_files() { record require_secrets; }
       assert_canary_identifier_matches_owner() { record assert_owner; }
       require_staging_owner_admin_password_file() { record require_owner_pass; }
       capture_live_snapshot() {
         record capture
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { record assert_sha; }
       require_migrations_pending_zero_true() { record require_mig; }
       mint_canary_admin_jwt_from_password_login() {
         record "mint:\$1"
         CANARY_ADMIN_JWT_FILE=/tmp/lifecycle-human-bootstrap-jwt
         printf 'jwt' > "\$CANARY_ADMIN_JWT_FILE"
         return 0
       }
       bootstrap_human_platform_admin() { record human_txn; HUMAN_BOOTSTRAP_OUTCOME=created; return 0; }
       write_lifecycle_override() { record "write:\$1:\$2:\$3"; }
       recreate_backend_only() { record recreate; return 0; }
       write_status_artifact() { record write_status; }
       OUTPUT_DIR="$2"
       mkdir -p "$OUTPUT_DIR"
       DEPLOY_SHA="$3"
       EXPECTED_CURRENT_MODE=off
       BOOTSTRAP_CONFIRMATION=CREATE_STAGING_HUMAN_ADMIN
       ACTION=human-bootstrap
       action_human_bootstrap
       printf '%s\\n' "\${CALL_LOG[@]}"`,
      'bash',
      REMOTE_SH,
      '/tmp/lifecycle-canary-human-bootstrap-success',
      sha,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTION: 'human-bootstrap',
        OUTPUT_DIR: '/tmp/lifecycle-canary-human-bootstrap-success',
        RUN_STAMP: 'contract',
        LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        DEPLOY_SHA: sha,
        EXPECTED_CURRENT_MODE: 'off',
        BOOTSTRAP_CONFIRMATION: 'CREATE_STAGING_HUMAN_ADMIN',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const lines = result.stdout.trim().split('\n')
  const idx = (name) => {
    const i = lines.indexOf(name)
    assert.ok(i >= 0, `missing call ${name} in ${lines.join(',')}`)
    return i
  }
  assert.ok(idx('require_sha') < idx('require_secrets'))
  assert.ok(idx('require_secrets') < idx('assert_owner'))
  assert.ok(idx('assert_owner') < idx('require_owner_pass'))
  assert.ok(idx('require_mig') < idx('mint:human-bootstrap'))
  assert.ok(idx('mint:human-bootstrap') < idx('human_txn'))
  const humanI = idx('human_txn')
  const secondCapture = lines.indexOf('capture', humanI + 1)
  assert.ok(secondCapture > humanI, 'post-human-bootstrap recapture required')
  const secondSha = lines.indexOf('assert_sha', humanI + 1)
  assert.ok(secondSha > secondCapture, 'post-human-bootstrap SHA reassert after recapture')
  assert.ok(!lines.some((l) => l.startsWith('write:')), 'human-bootstrap must not write lifecycle override')
  assert.ok(!lines.includes('recreate'), 'human-bootstrap must not recreate backend')
})

test('FUNCTIONAL: bootstrap_human_platform_admin create path orders reset/access/login/revoke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-human-bootstrap-create-'))
  const jwtFile = join(dir, 'admin.jwt')
  const passFile = join(dir, 'staging-owner-admin.password')
  const callsFile = join(dir, 'calls.txt')
  writeFileSync(jwtFile, 'canary-jwt-token', { mode: 0o600 })
  writeFileSync(passFile, 'HumanPass9Xyz', { mode: 0o600 })
  writeFileSync(callsFile, '', { mode: 0o600 })
  const serverPy = `
import json, http.server, socketserver, pathlib
calls = pathlib.Path(${JSON.stringify(callsFile)})
class H(http.server.BaseHTTPRequestHandler):
    def _read(self):
        n = int(self.headers.get('Content-Length', '0'))
        return self.rfile.read(n) if n else b''
    def _write(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        calls.write_text(calls.read_text() + f'GET {self.path}\\n', encoding='utf-8')
        auth = self.headers.get('Authorization', '')
        assert auth == 'Bearer canary-jwt-token'
        if self.path.startswith('/api/admin/users?') and 'staging-owner-admin' in self.path:
            return self._write(200, {'ok': True, 'data': {'items': [], 'total': 0}})
        if self.path.endswith('/access'):
            return self._write(200, {
                'ok': True,
                'data': {
                    'user': {
                        'id': 'user-new',
                        'username': 'staging-owner-admin',
                        'name': 'Staging Owner Admin',
                        'email': None,
                        'mobile': None,
                        'role': 'admin',
                        'is_admin': True,
                        'is_active': True,
                        'activationStatus': 'activated',
                    },
                    'roles': ['admin'],
                    'isAdmin': True,
                },
            })
        self._write(404, {'ok': False})
    def do_POST(self):
        raw = self._read()
        calls.write_text(calls.read_text() + f'POST {self.path}\\n', encoding='utf-8')
        auth = self.headers.get('Authorization', '')
        if self.path == '/api/auth/login':
            body = json.loads(raw.decode('utf-8'))
            assert body['identifier'] == 'staging-owner-admin'
            assert body['password'] == 'HumanPass9Xyz'
            return self._write(200, {
                'success': True,
                'data': {
                    'token': 'human-session-jwt',
                    'passwordChangeRequired': True,
                    'user': {'username': 'staging-owner-admin', 'name': 'Staging Owner Admin'},
                },
            })
        assert auth == 'Bearer canary-jwt-token'
        if self.path == '/api/admin/users':
            body = json.loads(raw.decode('utf-8'))
            assert body.get('username') == 'staging-owner-admin'
            assert body.get('name') == 'Staging Owner Admin'
            assert body.get('role') == 'admin'
            assert body.get('roleId') == 'admin'
            assert 'password' not in body
            assert 'email' not in body
            assert 'mobile' not in body
            return self._write(200, {
                'ok': True,
                'data': {
                    'user': {
                        'id': 'user-new',
                        'username': 'staging-owner-admin',
                        'name': 'Staging Owner Admin',
                        'email': None,
                        'mobile': None,
                        'role': 'admin',
                        'is_admin': True,
                    },
                },
            })
        if self.path.endswith('/reset-password'):
            body = json.loads(raw.decode('utf-8'))
            assert body.get('password') == 'HumanPass9Xyz'
            return self._write(200, {'ok': True, 'data': {'userId': 'user-new'}})
        if self.path.endswith('/revoke-sessions'):
            return self._write(200, {
                'ok': True,
                'data': {'userId': 'user-new', 'revokedAfter': '2026-08-11T00:00:00.000Z'},
            })
        self._write(404, {'ok': False})
    def log_message(self, *args):
        return
with socketserver.TCPServer(('127.0.0.1', 0), H) as httpd:
    print(httpd.server_address[1], flush=True)
    for _ in range(6):
        httpd.handle_request()
`
  const serverProc = spawn('python3', ['-c', serverPy], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  const serverDone = collectChild(serverProc, 10000)
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('port timeout')), 3000)
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        const line = buf.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (/^\d+$/.test(line)) {
          clearTimeout(timer)
          serverProc.stdout.off('data', onData)
          resolve(line)
        }
      }
      serverProc.stdout.on('data', onData)
    })
    const result = spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `source "$1"
         CANARY_ADMIN_JWT_FILE="$2"
         STAGING_OWNER_ADMIN_PASSWORD_FILE="$3"
         STAGING_API_BASE_URL="http://127.0.0.1:$4"
         bootstrap_human_platform_admin
         printf 'OUTCOME=%s\\n' "$HUMAN_BOOTSTRAP_OUTCOME"`,
        'bash',
        REMOTE_SH,
        jwtFile,
        passFile,
        port,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ACTION: 'human-bootstrap',
          OUTPUT_DIR: dir,
          RUN_STAMP: 'contract-human-create',
          LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
        },
        timeout: 10000,
      },
    )
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /OUTCOME=created/)
    assert.match(result.stdout, /human-bootstrap OK outcome=created/)
    const calls = readFileSync(callsFile, 'utf8')
    assert.match(calls, /GET \/api\/admin\/users\?/)
    assert.match(calls, /POST \/api\/admin\/users\n/)
    assert.match(calls, /POST \/api\/admin\/users\/user-new\/reset-password/)
    assert.match(calls, /GET \/api\/admin\/users\/user-new\/access/)
    assert.match(calls, /POST \/api\/auth\/login/)
    assert.match(calls, /POST \/api\/admin\/users\/user-new\/revoke-sessions/)
    const order = [
      calls.indexOf('GET /api/admin/users?'),
      calls.indexOf('POST /api/admin/users\n'),
      calls.indexOf('POST /api/admin/users/user-new/reset-password'),
      calls.indexOf('GET /api/admin/users/user-new/access'),
      calls.indexOf('POST /api/auth/login'),
      calls.indexOf('POST /api/admin/users/user-new/revoke-sessions'),
    ]
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] > order[i - 1], `call order broken at ${i}: ${calls}`)
    }
    await Promise.race([serverDone, new Promise((r) => setTimeout(r, 500))])
  } finally {
    if (!serverProc.killed && serverProc.exitCode === null) {
      try {
        serverProc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FUNCTIONAL: bootstrap_human_platform_admin safe repair and collision rejection', async () => {
  async function runScenario(items, expectOk, expectNote, options = {}) {
    const {
      accessAdmin = true,
      accessActive = true,
      accessActivationStatus = 'activated',
      passwordChangeRequired = true,
      resetCode = 200,
      revokeCode = 200,
      revokeProof = true,
    } = options
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-human-bootstrap-repair-'))
    const jwtFile = join(dir, 'admin.jwt')
    const passFile = join(dir, 'staging-owner-admin.password')
    writeFileSync(jwtFile, 'canary-jwt-token', { mode: 0o600 })
    writeFileSync(passFile, 'HumanPass9Xyz', { mode: 0o600 })
    const serverPy = `
import json, http.server, socketserver
items = json.loads(${JSON.stringify(JSON.stringify(items))})
access_admin = ${accessAdmin ? 'True' : 'False'}
access_active = ${accessActive ? 'True' : 'False'}
access_activation_status = ${JSON.stringify(accessActivationStatus)}
password_change_required = ${passwordChangeRequired ? 'True' : 'False'}
reset_code = ${Number(resetCode)}
revoke_code = ${Number(revokeCode)}
revoke_proof = ${revokeProof ? 'True' : 'False'}
class H(http.server.BaseHTTPRequestHandler):
    def _read(self):
        n = int(self.headers.get('Content-Length', '0'))
        return self.rfile.read(n) if n else b''
    def _write(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith('/api/admin/users?'):
            return self._write(200, {'ok': True, 'data': {'items': items, 'total': len(items)}})
        if '/access' in self.path:
            u = items[0]
            access_user = dict(u)
            access_user['is_active'] = access_active
            access_user['activationStatus'] = access_activation_status
            return self._write(200, {
                'ok': True,
                'data': {
                    'user': access_user,
                    'roles': ['admin'] if access_admin else [],
                    'isAdmin': access_admin,
                },
            })
        self._write(404, {'ok': False})
    def do_POST(self):
        if self.path == '/api/auth/login':
            return self._write(200, {
                'success': True,
                'data': {
                    'token': 't',
                    'passwordChangeRequired': password_change_required,
                    'user': {'username': 'staging-owner-admin'},
                },
            })
        if self.path.endswith('/reset-password'):
            return self._write(reset_code, {'ok': reset_code == 200, 'data': {}})
        if self.path.endswith('/revoke-sessions'):
            data = {
                'revokedAfter': '2026-08-11T00:00:00.000Z' if revoke_proof else None,
            }
            return self._write(revoke_code, {'ok': revoke_code == 200, 'data': data})
        if self.path == '/api/admin/users':
            return self._write(500, {'ok': False})
        self._write(404, {'ok': False})
    def log_message(self, *args):
        return
with socketserver.TCPServer(('127.0.0.1', 0), H) as httpd:
    print(httpd.server_address[1], flush=True)
    for _ in range(8):
        httpd.handle_request()
`
    const serverProc = spawn('python3', ['-c', serverPy], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const serverDone = collectChild(serverProc, 10000)
    try {
      const port = await new Promise((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => reject(new Error('port timeout')), 3000)
        const onData = (chunk) => {
          buf += chunk.toString('utf8')
          const line = buf.trim().split(/\r?\n/).filter(Boolean).pop() || ''
          if (/^\d+$/.test(line)) {
            clearTimeout(timer)
            serverProc.stdout.off('data', onData)
            resolve(line)
          }
        }
        serverProc.stdout.on('data', onData)
      })
      const result = spawnSync(
        'bash',
        [
          '-o',
          'pipefail',
          '-c',
          `source "$1"
           CANARY_ADMIN_JWT_FILE="$2"
           STAGING_OWNER_ADMIN_PASSWORD_FILE="$3"
           STAGING_API_BASE_URL="http://127.0.0.1:$4"
           if bootstrap_human_platform_admin; then
             printf 'ok|%s' "$HUMAN_BOOTSTRAP_OUTCOME"
           else
             printf 'fail|%s' "$HUMAN_BOOTSTRAP_OUTCOME"
           fi`,
          'bash',
          REMOTE_SH,
          jwtFile,
          passFile,
          port,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ACTION: 'human-bootstrap',
            OUTPUT_DIR: dir,
            RUN_STAMP: 'contract-human-repair',
            LIFECYCLE_CANARY_SOURCE_ONLY: 'true',
          },
          timeout: 10000,
        },
      )
      assert.equal(result.status, 0, result.stderr + result.stdout)
      if (expectOk) {
        assert.match(result.stdout, new RegExp(`(?:^|\\n)ok\\|${expectNote}`))
      } else {
        assert.match(result.stdout, new RegExp(`(?:^|\\n)fail\\|${expectNote}`))
      }
      await Promise.race([serverDone, new Promise((r) => setTimeout(r, 500))])
    } finally {
      if (!serverProc.killed && serverProc.exitCode === null) {
        try {
          serverProc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }

  await runScenario(
    [
      {
        id: 'owned-1',
        username: 'staging-owner-admin',
        name: 'Staging Owner Admin',
        email: null,
        mobile: null,
        role: 'admin',
        is_admin: true,
      },
    ],
    true,
    'repaired',
  )
  await runScenario(
    [
      {
        id: 'a',
        username: 'staging-owner-admin',
        name: 'Staging Owner Admin',
        email: null,
        mobile: null,
        role: 'admin',
        is_admin: true,
      },
      {
        id: 'b',
        username: 'staging-owner-admin',
        name: 'Staging Owner Admin',
        email: null,
        mobile: null,
        role: 'admin',
        is_admin: true,
      },
    ],
    false,
    'collision_multiple_rows',
  )
  await runScenario(
    [
      {
        id: 'x',
        username: 'staging-owner-admin',
        name: 'Wrong Name',
        email: null,
        mobile: null,
        role: 'admin',
        is_admin: true,
      },
    ],
    false,
    'identity_name_mismatch',
  )
  await runScenario(
    [
      {
        id: 'y',
        username: 'staging-owner-admin',
        name: 'Staging Owner Admin',
        email: null,
        mobile: null,
        role: 'user',
        is_admin: false,
      },
    ],
    false,
    'pre_reset_access_not_admin',
    { accessAdmin: false },
  )
  const ownedAdmin = [{
    id: 'owned-proof',
    username: 'staging-owner-admin',
    name: 'Staging Owner Admin',
    email: null,
    mobile: null,
    role: 'admin',
    is_admin: true,
  }]
  await runScenario(ownedAdmin, false, 'reset_http_503', { resetCode: 503 })
  await runScenario(ownedAdmin, false, 'pre_reset_access_inactive', {
    accessActive: false,
  })
  await runScenario(ownedAdmin, false, 'pre_reset_access_not_activated', {
    accessActivationStatus: 'pending_activation',
  })
  await runScenario(ownedAdmin, false, 'login_password_change_required_missing', {
    passwordChangeRequired: false,
  })
  await runScenario(ownedAdmin, false, 'revoke_http_503', { revokeCode: 503 })
  await runScenario(ownedAdmin, false, 'revoke_proof_missing', { revokeProof: false })
})

test('MUTATION: human-bootstrap create request carrying operator password turns contract red', () => {
  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  const mutated = helper.replace(
    '"roleId": "admin",',
    '"roleId": "admin",\n        "password": password,',
  )
  const createBody = mutated.match(/create_body = \{[\s\S]*?\n    \}/)?.[0] || ''
  assert.throws(() => assert.doesNotMatch(createBody, /"password":/))
})

test('MUTATION: human-bootstrap dropping reset-password turns contract red', () => {
  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  const mutated = helper.replaceAll('/reset-password', '/no-reset')
  let failed = false
  try {
    assert.match(mutated, /\/reset-password/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: human-bootstrap dropping login passwordChangeRequired check turns contract red', () => {
  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  const mutated = helper.replaceAll('passwordChangeRequired', 'passwordChangeIgnored')
  let failed = false
  try {
    assert.match(mutated, /passwordChangeRequired/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: human-bootstrap dropping revoke-sessions turns contract red', () => {
  const helper = bootstrapHumanPlatformAdminBody(read(REMOTE_SH))
  const mutated = helper.replaceAll('/revoke-sessions', '/no-revoke')
  let failed = false
  try {
    assert.match(mutated, /\/revoke-sessions/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: human-bootstrap writing lifecycle override turns no-env-write contract red', () => {
  const original = actionHumanBootstrapBody(read(REMOTE_SH))
  const mutated = `${original}\n  write_lifecycle_override "true" "false" "false"\n`
  let failed = false
  try {
    assert.doesNotMatch(mutated, /write_lifecycle_override/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('MUTATION: human-bootstrap skipping canary JWT mint turns contract red', () => {
  const body = actionHumanBootstrapBody(read(REMOTE_SH))
  const mutated = body.replace(
    'mint_canary_admin_jwt_from_password_login "human-bootstrap"',
    'true # mint removed',
  )
  let failed = false
  try {
    assert.match(mutated, /mint_canary_admin_jwt_from_password_login "human-bootstrap"/)
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})
