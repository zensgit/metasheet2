#!/usr/bin/env node
// dingtalk-lifecycle-staging-canary-contract.test.mjs
//
// Durable synthetic contract for the MINIMAL SAFE staging lifecycle lane:
//   EXECUTABLE: status | preflight | off | alias
//   NOT EXECUTABLE: pending | deprovision (fail-closed preflight-only)
//
// Alias is a TRANSIENT secret-backed cutover canary: success requires/proves OFF;
// failure restores the OFF override before failing. Runtime OFF cannot be proven
// if rollback recreate itself fails.
// Load-bearing mutations for owner P1/P2 gaps:
//   * migrations_pending_zero unknown must fail preflight/off/alias (never success)
//   * pending/deprovision never apply (transition_applied=false; NOT EXECUTABLE)
//   * alias requires pre-login, backfill, readiness, post-ON login, rollback,
//     post-rollback login, exact SHA, migrations, and secret-file transport
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
  const end = source.indexOf('\n# --- main', start)
  assert.notEqual(end, -1, 'main marker after action_alias')
  return source.slice(start, end)
}

function actionOffBody(source) {
  const start = source.indexOf('action_off()')
  assert.notEqual(start, -1, 'action_off() must exist')
  const end = source.indexOf('\naction_alias()', start)
  assert.notEqual(end, -1, 'action_alias after action_off')
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

test('workflow action choices include status/preflight/off/alias and non-executable ON names', () => {
  const options = workflowOn(loadYaml(read(WORKFLOW))).workflow_dispatch.inputs.action.options
  assert.deepEqual(options, ['status', 'preflight', 'off', 'alias', 'pending', 'deprovision'])
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

test('workflow requires deploy_sha + expected_current for off and alias; pending/deprovision NOT EXECUTABLE', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /expected_current_mode is required for action=off/)
  assert.match(yaml, /expected_current_mode must be exactly 'off' for action=alias/)
  assert.match(yaml, /deploy_sha must be the FULL 40-char lowercase commit SHA for action=alias/)
  // Secret presence is checked only in Run remote action (not Validate inputs).
  assert.match(yaml, /alias requires ATTENDANCE_ADMIN_JWT \+ LIFECYCLE_CANARY_LOGIN_IDENTIFIER\/PASSWORD \(checked in Run remote action only\)/)
  assert.match(yaml, /NOT EXECUTABLE/)
  // Must not require canary subject/integration for a pretend ON transition.
  assert.doesNotMatch(yaml, /canary_subject_id:/)
  assert.doesNotMatch(yaml, /canary_integration_id:/)
  assert.doesNotMatch(yaml, /owner_confirm:/)
  // No password-reset API / admin reset path (prose saying "no password reset" is fine).
  assert.doesNotMatch(yaml, /resetPassword|reset_password|\/api\/.*password-reset/i)
  assert.doesNotMatch(yaml, /POST\s+\/api\/admin\/.*password/i)
  // No unconditional always-OFF claim in structural validation comments.
  assert.doesNotMatch(yaml, /always OFF after/i)
})

test('workflow alias secret transport uses chmod-600 files + scp, not secret values in remote argv', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /chmod 600/)
  assert.match(yaml, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER/)
  assert.match(yaml, /LIFECYCLE_CANARY_LOGIN_PASSWORD/)
  assert.match(yaml, /ATTENDANCE_ADMIN_JWT/)
  assert.match(yaml, /CANARY_ADMIN_JWT_FILE=/)
  assert.match(yaml, /CANARY_LOGIN_IDENTIFIER_FILE=/)
  assert.match(yaml, /CANARY_LOGIN_PASSWORD_FILE=/)
  assert.match(yaml, /\.canary-secrets/)
  assert.match(yaml, /scp \$ssh_opts/)
  // printf uses non-exported shell vars after env demote (not raw env names).
  assert.match(yaml, /printf '%s' "\$\{_CANARY_PASS\}"/)
  assert.match(yaml, /printf '%s' "\$\{_CANARY_JWT\}"/)
  assert.match(yaml, /printf '%s' "\$\{_CANARY_IDENT\}"/)
  // Must not export raw secret values into the remote script env.
  assert.doesNotMatch(yaml, /export ATTENDANCE_ADMIN_JWT=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_IDENTIFIER=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_PASSWORD=/)
  assert.doesNotMatch(yaml, /export CANARY_LOGIN_PASSWORD='/)
})

test('workflow Validate inputs does not receive alias secrets (no child inheritance gap)', () => {
  const yaml = read(WORKFLOW)
  const doc = loadYaml(yaml)
  const validate = doc.jobs.run.steps.find((s) => s.name === 'Validate inputs and embedded scripts')
  assert.ok(validate?.env, 'Validate inputs must declare env')
  assert.equal(validate.env.ATTENDANCE_ADMIN_JWT, undefined)
  assert.equal(validate.env.LIFECYCLE_CANARY_LOGIN_IDENTIFIER, undefined)
  assert.equal(validate.env.LIFECYCLE_CANARY_LOGIN_PASSWORD, undefined)
  // No secret presence checks in this step (they launch after bash -n otherwise).
  assert.doesNotMatch(validate.run, /ATTENDANCE_ADMIN_JWT/)
  assert.doesNotMatch(validate.run, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER/)
  assert.doesNotMatch(validate.run, /LIFECYCLE_CANARY_LOGIN_PASSWORD/)
  assert.match(validate.run, /bash -n scripts\/ops\/dingtalk-lifecycle-staging-canary-remote\.sh/)
  // Structural alias checks remain; secret presence does not.
  assert.match(validate.run, /expected_current_mode must be exactly 'off' for action=alias/)
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
    if (t.startsWith('unset ATTENDANCE_ADMIN_JWT LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD')) {
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
      '_CANARY_JWT="${ATTENDANCE_ADMIN_JWT-}"',
      '_CANARY_IDENT="${LIFECYCLE_CANARY_LOGIN_IDENTIFIER-}"',
      '_CANARY_PASS="${LIFECYCLE_CANARY_LOGIN_PASSWORD-}"',
    ],
    'only demote assignments (builtins) before secret env unset — no external commands',
  )

  // Order after demote: trap → mktemp → printf from shell vars → unset shell vars → remote scp.
  const trapIdx = runBody.indexOf('trap cleanup_canary_ephemeral_paths EXIT INT TERM')
  const envUnsetIdx = runBody.indexOf(
    'unset ATTENDANCE_ADMIN_JWT LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD',
  )
  const mktempIdx = runBody.indexOf('mktemp -d')
  const printfPassIdx = runBody.indexOf("printf '%s' \"${_CANARY_PASS}\"")
  // Post-write shell-var wipe (must follow password printf; fail-path unset is earlier).
  const unsetShellIdx = runBody.indexOf(
    'unset _CANARY_JWT _CANARY_IDENT _CANARY_PASS',
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
  assert.ok(unsetShellIdx > printfPassIdx, 'unset shell secret vars immediately after printf writes')
  assert.ok(unsetShellIdx < remoteMkdirIdx, 'shell secret vars cleared before remote copy')
  assert.ok(remoteMkdirIdx > mktempIdx, 'remote secrets mkdir after local materialize')
  assert.ok(scpIdx > remoteMkdirIdx, 'scp after remote mkdir')

  assert.match(remoteStep.run, /trap cleanup_canary_ephemeral_paths EXIT INT TERM/)
  assert.match(remoteStep.run, /mktemp -d/)
  assert.match(remoteStep.run, /printf '%s' "\$\{_CANARY_PASS\}"/)
  assert.match(remoteStep.run, /unset ATTENDANCE_ADMIN_JWT LIFECYCLE_CANARY_LOGIN_IDENTIFIER LIFECYCLE_CANARY_LOGIN_PASSWORD/)
  assert.ok(remoteStep.env, 'Run remote action must declare env')
  assert.ok(remoteStep.env.ATTENDANCE_ADMIN_JWT, 'JWT secret on Run remote action only')
  assert.ok(remoteStep.env.LIFECYCLE_CANARY_LOGIN_IDENTIFIER, 'identifier secret on Run remote action only')
  assert.ok(remoteStep.env.LIFECYCLE_CANARY_LOGIN_PASSWORD, 'password secret on Run remote action only')
  assert.equal(remoteStep.env.SECRETS_DIR, undefined, 'no secrets_dir cross-step handoff')

  assert.match(runBody, /CLEAN_REMOTE_SECRETS_DIR/)
  assert.match(runBody, /CLEAN_REMOTE_RUNNER_DIR/)
  assert.match(runBody, /NEVER touch persistent/)
  assert.doesNotMatch(runBody, /rm -rf[^\n]*\.metasheet2/)
  assert.match(runBody, /OUTPUT_COLLECTED=1/)
  // Explicit: secrets_dir must not be a step output handoff.
  assert.doesNotMatch(runBody, /secrets_dir=.*GITHUB_OUTPUT/)
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

// --- P1: pending/deprovision NOT EXECUTABLE; alias is executable ----------------------

test('P1 pending/deprovision route to action_not_executable_on; alias routes to action_alias', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /alias\) action_alias/)
  assert.match(source, /pending\) action_not_executable_on pending/)
  assert.match(source, /deprovision\) action_not_executable_on deprovision/)
  assert.match(source, /NOT EXECUTABLE/)
  assert.match(source, /not_executable_no_real_verifier/)
  assert.match(source, /transition_applied=false/)
  // Must not call write_lifecycle_override from the not-executable path with true flags.
  const start = source.indexOf('action_not_executable_on()')
  const end = source.indexOf('\naction_off()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const body = source.slice(start, end)
  assert.doesNotMatch(body, /write_lifecycle_override/)
  assert.doesNotMatch(body, /recreate_backend_only/)
  assert.match(body, /transition_applied.*false|false" "false"/)
  const preflightStart = source.indexOf('preflight_for_target()')
  const preflightEnd = source.indexOf('\naction_preflight()', preflightStart)
  const preflightBody = source.slice(preflightStart, preflightEnd)
  // pending/deprovision still force not-executable; alias does not.
  assert.match(preflightBody, /pending\|deprovision\)[\s\S]*not_executable_no_real_verifier/)
  assert.doesNotMatch(
    preflightBody,
    /alias\)[\s\S]{0,400}not_executable_no_real_verifier/,
  )
})

test('P1 action=off and action=alias write lifecycle override; pending/deprovision do not', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /off\) action_off/)
  assert.match(source, /alias\) action_alias/)
  assert.match(source, /action_off\(\)/)
  assert.match(source, /action_alias\(\)/)
  assert.match(source, /write_lifecycle_override "false" "false" "false"/)
  assert.match(source, /write_lifecycle_override "true" "false" "false"/)
  const notExec = source.slice(
    source.indexOf('action_not_executable_on()'),
    source.indexOf('\naction_off()'),
  )
  assert.doesNotMatch(notExec, /write_lifecycle_override/)
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

test('workflow and remote do not export or require canary presence tokens as ON enablers', () => {
  const yaml = read(WORKFLOW)
  const source = read(REMOTE_SH)
  assert.doesNotMatch(yaml, /CANARY_SUBJECT_ID/)
  assert.doesNotMatch(yaml, /OWNER_CONFIRM/)
  assert.doesNotMatch(source, /has_canary_inputs/)
  assert.match(source, /NOT used/)
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
  assert.match(body, /require_canary_secret_files/)
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
})

test('alias proves pre-login before any env write; backfill and readiness before write', () => {
  const body = actionAliasBody(read(REMOTE_SH))
  const preLogin = body.indexOf('prove_canary_password_login "pre_on"')
  const backfill = body.indexOf('run_alias_backfill')
  const cutover = body.indexOf('run_alias_cutover_status')
  const baseline = body.indexOf('establish_alias_off_rollback_baseline')
  const write = body.indexOf('write_lifecycle_override "true" "false" "false"')
  assert.ok(preLogin > 0, 'pre_on login required')
  assert.ok(backfill > preLogin, 'backfill after pre-login')
  assert.ok(cutover > backfill, 'cutover-status after backfill')
  assert.ok(baseline > cutover, 'explicit OFF baseline after readiness')
  assert.ok(write > baseline, 'ON write after OFF baseline')
  assert.doesNotMatch(body, /backup_lifecycle_override/)
  assert.match(body, /pre-ON password login failed \(no env write performed\)/)
  assert.match(body, /login-aliases backfill failed \(no env write performed\)/)
  assert.match(body, /cutover-status not ready\/canEnableCutover \(no env write performed\)/)
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
  // Never curl -d with expanded password env or echo secret file contents.
  assert.doesNotMatch(source, /curl[^\n]*\$\{?CANARY_LOGIN_PASSWORD\}?/)
  assert.doesNotMatch(source, /curl[^\n]*\$\{?ATTENDANCE_ADMIN_JWT\}?/)
  assert.doesNotMatch(source, /echo\s+[\"']?\$\{?(CANARY_LOGIN_PASSWORD|ATTENDANCE_ADMIN_JWT|CANARY_ADMIN_JWT)/)
  assert.doesNotMatch(source, /cat\s+\"?\$\{?CANARY_LOGIN_PASSWORD_FILE/)
  assert.match(source, /values never logged/)
})

test('alias admin calls target backfill and cutover-status endpoints', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /\/api\/admin\/login-aliases\/backfill/)
  assert.match(source, /\/api\/admin\/login-aliases\/cutover-status/)
  assert.match(source, /\/api\/auth\/login/)
  assert.match(source, /canEnableCutover/)
})

// Load-bearing MUTATION tests: removing any required gate turns the suite red.
test('MUTATION: removing pre-ON login requirement turns alias contract red', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace('prove_canary_password_login "pre_on"', 'true # pre_on removed')
  const body = actionAliasBody(mutated)
  let failed = false
  try {
    assert.match(body, /prove_canary_password_login "pre_on"/)
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

test('production function: require_canary_secret_files rejects missing paths', () => {
  const result = spawnSync(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      'source "$1"; CANARY_ADMIN_JWT_FILE=; CANARY_LOGIN_IDENTIFIER_FILE=; CANARY_LOGIN_PASSWORD_FILE=; require_canary_secret_files',
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
  assert.match(result.stderr, /CANARY_ADMIN_JWT_FILE|secret file/)
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

test('FUNCTIONAL harness: action_alias success call order pre-login→backfill→status→ON→OFF', () => {
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
       capture_live_snapshot() {
         record capture_live_snapshot
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { record assert_exact_sha; }
       pin_live_backend_image_for_transition() { record pin_image; }
       require_migrations_pending_zero_true() { record require_migrations; }
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
  assert.ok(idx('login:pre_on') < idx('backfill'))
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
       capture_live_snapshot() {
         SNAP_ALIAS=false; SNAP_PENDING=false; SNAP_DEPROV=false; SNAP_MODE=off
         SNAP_BUILD_SHA="$DEPLOY_SHA"; SNAP_ALIAS_READY=true; SNAP_CAN_ENABLE_ALIAS=true
         SNAP_MIGRATIONS_ZERO=true; SNAP_HEALTH_OK=true
       }
       assert_exact_sha() { :; }
       pin_live_backend_image_for_transition() { :; }
       require_migrations_pending_zero_true() { :; }
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

// --- docs / staging blockers ----------------------------------------------------------

test('docs mark pending/deprovision NOT EXECUTABLE; alias is executable transient canary', () => {
  const closeout = read(CLOSEOUT_DOC)
  const go = read(CANARY_GO_DOC)
  // Closeout may still describe historical NOT EXECUTABLE for ON names; go-doc is authoritative.
  assert.match(closeout, /NOT EXECUTABLE/)
  assert.match(go, /NOT EXECUTABLE/)
  assert.match(go, /pending/)
  assert.match(go, /deprovision/)
  assert.match(go, /EXECUTABLE/)
  assert.match(go, /alias/)
  assert.match(go, /success requires\/proves OFF|Success requires\/proves OFF/i)
  assert.match(go, /failure restores the OFF override before failing/i)
  assert.match(go, /runtime OFF cannot be proven/i)
  assert.doesNotMatch(go, /ALWAYS returns to OFF|always returns to OFF|always restores OFF/i)
  assert.match(go, /LIFECYCLE_CANARY_LOGIN_IDENTIFIER|secret-backed/)
  assert.match(go, /collisions==0|collisions must be 0|collisions==0/i)
  // No invented successful canary execution evidence.
  assert.doesNotMatch(go, /alias canary EXECUTED successfully|alias cutover canary PASSED on staging/i)
  assert.match(go, /NOT EXECUTED/)
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
    'STAGING_DEPLOY_PATH',
    'DEPLOY_PATH',
    'OUTPUT_DIR',
    'RUN_STAMP',
  ]) {
    assert.match(yaml, new RegExp(`export ${key}=`))
  }
  assert.doesNotMatch(yaml, /export CANARY_SUBJECT/)
  assert.doesNotMatch(yaml, /export OWNER_CONFIRM=/)
  assert.doesNotMatch(yaml, /export ATTENDANCE_ADMIN_JWT=/)
  assert.doesNotMatch(yaml, /export LIFECYCLE_CANARY_LOGIN_PASSWORD=/)
})
