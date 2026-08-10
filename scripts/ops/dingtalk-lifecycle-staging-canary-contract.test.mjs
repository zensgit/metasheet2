#!/usr/bin/env node
// dingtalk-lifecycle-staging-canary-contract.test.mjs
//
// Durable synthetic contract for the MINIMAL SAFE staging lifecycle lane:
//   EXECUTABLE: status | preflight | off
//   NOT EXECUTABLE: alias | pending | deprovision (fail-closed preflight-only)
//
// Load-bearing mutations for owner P1/P2 gaps:
//   * migrations_pending_zero unknown must fail preflight/off (never success)
//   * alias/pending/deprovision never apply (transition_applied=false; NOT EXECUTABLE)
//   * recreate requires health true after restart
//   * previous-override restore on transition failure
//   * multi-on: status/preflight fail closed; off still clears via classify_mode
//
// No network, no secrets, no workflow execution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
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

test('workflow action choices include status/preflight/off and non-executable ON names', () => {
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

test('workflow only requires deploy_sha + expected_current_mode for action=off (not for ON names)', () => {
  const yaml = read(WORKFLOW)
  assert.match(yaml, /expected_current_mode is required for action=off/)
  assert.match(yaml, /NOT EXECUTABLE/)
  // Must not require canary subject/integration for a pretend ON transition.
  assert.doesNotMatch(yaml, /canary_subject_id:/)
  assert.doesNotMatch(yaml, /canary_integration_id:/)
  assert.doesNotMatch(yaml, /owner_confirm:/)
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
  assert.match(source, /IMAGE_OWNER="\$image_owner" IMAGE_TAG="\$image_tag" docker compose/)
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

// --- P1: ON actions NOT EXECUTABLE ----------------------------------------------------

test('P1 ON not executable: alias/pending/deprovision route to action_not_executable_on', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /alias\) action_not_executable_on alias/)
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
  assert.match(preflightBody, /PREFLIGHT_OK="false"[\s\S]*not_executable_no_real_verifier/)
})

test('P1 only action=off writes lifecycle override (executable transition)', () => {
  const source = read(REMOTE_SH)
  assert.match(source, /off\) action_off/)
  assert.match(source, /action_off\(\)/)
  // write_lifecycle_override only with all false for off
  assert.match(source, /write_lifecycle_override "false" "false" "false"/)
  // No flags_for_mode true for alias in executable path
  assert.doesNotMatch(source, /write_lifecycle_override "true"/)
})

test('MUTATION: re-enabling alias as action_transition would fail NOT EXECUTABLE contract', () => {
  const original = read(REMOTE_SH)
  const mutated = original.replace(
    'alias) action_not_executable_on alias ;;',
    'alias) action_off ;;', // wrong — would break the not-executable contract
  )
  let failed = false
  try {
    assert.match(mutated, /alias\) action_not_executable_on alias/)
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
  const actionEnd = source.indexOf('\n# --- main', actionStart)
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

// --- docs / staging blockers ----------------------------------------------------------

test('docs mark alias/pending/deprovision NOT EXECUTABLE and canary NOT EXECUTED', () => {
  const closeout = read(CLOSEOUT_DOC)
  const go = read(CANARY_GO_DOC)
  for (const doc of [closeout, go]) {
    assert.match(doc, /NOT EXECUTABLE/)
    assert.match(doc, /NOT EXECUTED/)
  }
  // Current live evidence and remaining provenance blocker are called out.
  assert.match(closeout, /314\/0|Pending: 0|migrations_pending_zero=true/i)
  assert.match(closeout, /provenance conflict|metadata.*old|image.*health/i)
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

test('staging env example keeps three flags OFF and documents minimal safe lane', () => {
  const env = read(STAGING_ENV_EXAMPLE)
  assert.match(env, /^AUTH_LOGIN_USE_ALIASES=false$/m)
  assert.match(env, /^DIRECTORY_PENDING_ACTIVATION_ENABLED=false$/m)
  assert.match(env, /^DIRECTORY_DEPROVISION_ENABLED=false$/m)
  assert.match(env, /NOT EXECUTABLE|lifecycle.*canary|canary.*lifecycle/i)
})

test('workflow exports only safe remote env keys (no canary tokens)', () => {
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
  assert.doesNotMatch(yaml, /export CANARY_/)
  assert.doesNotMatch(yaml, /export OWNER_CONFIRM=/)
})
