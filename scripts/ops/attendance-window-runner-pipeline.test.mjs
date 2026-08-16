#!/usr/bin/env node
// attendance-window-runner-pipeline.test.mjs
//
// Committed proof for the attendance staging window-runner's remote pipeline semantics
// (owner-ruled acceptance for .github/workflows/attendance-staging-window-runner.yml):
//
//   (a) a grep with ZERO matches inside the pipeline still yields overall exit 0
//       (zero matches is a normal outcome, e.g. filtering quiet logs), and
//   (b) when the first pipeline stage (the `docker logs`-equivalent producer) FAILS,
//       the overall exit is NONZERO (pipefail propagates).
//
// The tests run the EXACT committed helper (scripts/ops/attendance-window-runner-pipeline.lib.sh,
// sourced by the remote script) under the EXACT invocation shape the workflow uses
// (`bash -o pipefail -c '<script>'`), plus a raw-pipeline positive control proving the
// `-o pipefail` flag itself is load-bearing (without it, the failure leg goes green).
//
// Wired into CI via scripts/ops/attendance-run-gate-contract-case.sh (strict case),
// which the Attendance Gate Contract Matrix workflow runs on every pull request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, 'attendance-window-runner-pipeline.lib.sh')
const REMOTE_SH = join(HERE, 'attendance-staging-window-runner-remote.sh')
const LIFECYCLE_REMOTE_SH = join(HERE, 'dingtalk-lifecycle-staging-canary-remote.sh')
const WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'attendance-staging-window-runner.yml')
const STAGING_COMPOSE = join(HERE, '..', '..', 'docker-compose.app.staging.yml')

function runPipefailBash(script) {
  // Same shape as the workflow's remote invocation: bash -o pipefail -c '<script>'.
  return spawnSync('bash', ['-o', 'pipefail', '-c', script], { encoding: 'utf8' })
}

function runPlainBash(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' })
}

test('leg (a): zero grep matches in the pipeline still exits 0 (normal outcome)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-pipe-'))
  const out = join(dir, 'filtered.log')
  const result = runPipefailBash(
    `set -euo pipefail
source '${LIB}'
filtered_pipe '${out}' 'PATTERN_THAT_MATCHES_NOTHING_XYZ' -- printf '%s\\n' alpha beta gamma
echo POST_PIPE_REACHED`,
  )
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`)
  assert.match(result.stdout, /POST_PIPE_REACHED/, 'script must continue past the zero-match pipeline')
  assert.equal(readFileSync(out, 'utf8'), '', 'zero matches must produce an empty filter file')
})

test('leg (b): producer failure propagates as a NONZERO overall exit, even when grep matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-pipe-'))
  const out = join(dir, 'filtered.log')
  const result = runPipefailBash(
    `set -euo pipefail
source '${LIB}'
filtered_pipe '${out}' 'partial' -- bash -c 'echo partial-output-before-crash; exit 7'
echo MUST_NOT_REACH`,
  )
  assert.equal(result.status, 7, `expected the producer rc (7) to propagate, got ${result.status}`)
  assert.doesNotMatch(result.stdout, /MUST_NOT_REACH/, 'a failed producer must abort the script')
  assert.match(result.stderr, /producer failed rc=7/, 'the failure must name the producer rc')
})

test('leg (b) variant: producer failure with ZERO grep matches is still NONZERO (not misread as leg a)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-pipe-'))
  const out = join(dir, 'filtered.log')
  const result = runPipefailBash(
    `set -euo pipefail
source '${LIB}'
filtered_pipe '${out}' 'PATTERN_THAT_MATCHES_NOTHING_XYZ' -- bash -c 'echo noise; exit 5'`,
  )
  assert.equal(result.status, 5, `expected producer rc (5), got ${result.status}; stderr: ${result.stderr}`)
})

test('positive control: the -o pipefail wrapper is load-bearing for raw pipelines', () => {
  // Raw pipeline (no helper), same shape as `docker exec ... | tee log` in the remote
  // script: with pipefail the producer failure propagates; without it the pipe goes
  // green — which is exactly why the workflow must wrap the remote command in
  // `bash -o pipefail -c` instead of relying on the SSH login shell.
  const script = `bash -c 'echo produced; exit 9' | cat > /dev/null`
  const withPipefail = runPipefailBash(script)
  assert.equal(withPipefail.status, 9, 'with pipefail, the raw pipeline must fail with the producer rc')
  const withoutPipefail = runPlainBash(script)
  assert.equal(withoutPipefail.status, 0, 'control: without pipefail the same pipeline exits 0 (masking the failure)')
})

test('embedded scripts parse (bash -n) — remote runner + pipeline lib', () => {
  for (const file of [REMOTE_SH, LIB]) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `bash -n failed for ${file}: ${result.stderr}`)
  }
})

test('workflow shape contract: remote commands run under explicit `bash -o pipefail -c`', () => {
  assert.ok(existsSync(WORKFLOW), `workflow file missing: ${WORKFLOW}`)
  const yaml = readFileSync(WORKFLOW, 'utf8')
  const pipefailInvocations = yaml.match(/bash -o pipefail -c/g) || []
  assert.ok(
    pipefailInvocations.length >= 2,
    `expected every remote (ssh) command to be wrapped in \`bash -o pipefail -c\` (sync + action), found ${pipefailInvocations.length}`,
  )
  assert.doesNotMatch(yaml, /bash\s+-s\b/, 'the workflow must not fall back to `ssh ... bash -s` (login-shell pipefail is not guaranteed)')
})

test('workflow pins deploy-host identity for every SSH and SCP operation', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.match(workflow, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(workflow, /DEPLOY_KNOWN_HOSTS is required/)
  assert.match(workflow, /decoded_known_hosts=.*base64 -d/)
  assert.match(workflow, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/)
  assert.match(workflow, /did not resolve to a recognizable key/)
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/)
  const strictUses = workflow.match(/StrictHostKeyChecking=yes/g) || []
  assert.ok(strictUses.length >= 3, `expected strict host checks on sync SSH, compose SCP, and remote action; found ${strictUses.length}`)
  assert.match(workflow, /UserKnownHostsFile=~\/\.ssh\/known_hosts/)
  assert.match(workflow, /UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts/)
})

function assertPersistentComposeContract({ workflow, remote, lifecycleRemote, stagingCompose }) {
  assert.match(
    workflow,
    /scp[^\n]*\\\n\s+docker-compose\.app\.staging\.yml \\\n\s+"\$DEPLOY_USER@\$DEPLOY_HOST:\$\{runner_dir\}\/docker-compose\.app\.staging\.yml"/,
    'the remote action must receive the compose file from the exact workflow checkout',
  )
  assert.match(remote, /PERSISTENT_STAGING_COMPOSE_FILE="\$\{RUNNER_PERSIST_DIR\}\/docker-compose\.app\.staging\.yml"/)
  assert.match(remote, /prepare_staging_compose_for_deploy\(\)/)
  assert.match(remote, /candidate="\$\{HERE\}\/docker-compose\.app\.staging\.yml"/)
  assert.match(remote, /mv -f "\$STAGING_COMPOSE_CANDIDATE_TMP" "\$PERSISTENT_STAGING_COMPOSE_FILE"/)

  const deployStart = remote.indexOf('action_deploy() {')
  const deployEnd = remote.indexOf('\naction_smoke() {', deployStart)
  const deploy = remote.slice(deployStart, deployEnd)
  const prepareIndex = deploy.indexOf('prepare_staging_compose_for_deploy')
  const pairValidationIndex = deploy.indexOf('-f "$STAGING_COMPOSE_CANDIDATE_TMP" -f "$override_tmp" config')
  const baseMoveIndex = deploy.indexOf('mv -f "$STAGING_COMPOSE_CANDIDATE_TMP" "$PERSISTENT_STAGING_COMPOSE_FILE"')
  assert.ok(prepareIndex >= 0 && prepareIndex < pairValidationIndex, 'deploy must prepare the checked-out base before pair validation')
  assert.ok(pairValidationIndex < baseMoveIndex, 'the base/override pair must validate before either persistent file changes')
  assert.equal(
    (remote.match(/prepare_staging_compose_for_deploy/g) || []).length,
    2,
    'only the function definition and action=deploy call may prepare the persistent compose',
  )

  assert.match(stagingCompose, /METASHEET_BUILD_COMMIT: \$\{IMAGE_TAG:-unknown\}/)
  assert.match(stagingCompose, /METASHEET_BUILD_IMAGE_TAG: \$\{IMAGE_TAG:-unknown\}/)
  assert.match(
    remote,
    /IMAGE_OWNER="\$IMAGE_OWNER" IMAGE_TAG="\$DEPLOY_SHA" \\\n\s+docker compose --project-directory "\$STAGING_DIR" -f "\$STAGING_COMPOSE_FILE" -f "\$OVERRIDE_FILE"/,
    'live pull/up must render health identity from the exact deploy SHA',
  )
  assert.match(
    deploy,
    /IMAGE_OWNER="\$IMAGE_OWNER" IMAGE_TAG="\$DEPLOY_SHA" \\\n\s+docker compose --project-directory "\$STAGING_DIR" -f "\$STAGING_COMPOSE_CANDIDATE_TMP" -f "\$override_tmp" config/,
    'base/override validation must use the same exact-SHA interpolation as live pull/up',
  )
  assert.equal(
    (remote.match(/docker compose --project-directory "\$STAGING_DIR"/g) || []).length,
    4,
    'every non-version-check attendance compose invocation must pin the staging project directory (compose_staging, deploy compose-candidate validation, deploy pair validation, soak-flags pair validation)',
  )
  assert.equal(
    (lifecycleRemote.match(/docker compose --project-directory "\$STAGING_DIR"/g) || []).length,
    1,
    'the lifecycle compose entry point must pin the staging project directory',
  )
  for (const source of [remote, lifecycleRemote]) {
    assert.match(source, /PERSISTENT_STAGING_COMPOSE_FILE=/)
  }
}

test('deploy ships and atomically installs the checked-out staging compose at a persistent path', () => {
  assertPersistentComposeContract({
    workflow: readFileSync(WORKFLOW, 'utf8'),
    remote: readFileSync(REMOTE_SH, 'utf8'),
    lifecycleRemote: readFileSync(LIFECYCLE_REMOTE_SH, 'utf8'),
    stagingCompose: readFileSync(STAGING_COMPOSE, 'utf8'),
  })
})

test('MUTATION: removing the deploy compose preparation call turns the full contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const deployStart = original.indexOf('action_deploy() {')
  const deployEnd = original.indexOf('\naction_smoke() {', deployStart)
  const mutated = `${original.slice(0, deployStart)}${original.slice(deployStart, deployEnd).replace(
    '  prepare_staging_compose_for_deploy\n',
    '',
  )}${original.slice(deployEnd)}`
  assert.throws(
    () => assertPersistentComposeContract({
      workflow: readFileSync(WORKFLOW, 'utf8'),
      remote: mutated,
      lifecycleRemote: readFileSync(LIFECYCLE_REMOTE_SH, 'utf8'),
      stagingCompose: readFileSync(STAGING_COMPOSE, 'utf8'),
    }),
    /deploy must prepare the checked-out base/,
  )
})

test('MUTATION: dropping exact-SHA interpolation from live compose turns the health contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace(
    'IMAGE_OWNER="$IMAGE_OWNER" IMAGE_TAG="$DEPLOY_SHA" \\\n    docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_FILE" -f "$OVERRIDE_FILE"',
    'docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_FILE" -f "$OVERRIDE_FILE"',
  )
  assert.throws(
    () => assertPersistentComposeContract({
      workflow: readFileSync(WORKFLOW, 'utf8'),
      remote: mutated,
      lifecycleRemote: readFileSync(LIFECYCLE_REMOTE_SH, 'utf8'),
      stagingCompose: readFileSync(STAGING_COMPOSE, 'utf8'),
    }),
    /live pull\/up must render health identity/,
  )
})

test('dsn_database_name: extracts the db-name path segment, stripping the query string', () => {
  const cases = [
    ['postgresql://u:p@staging-postgres:5432/metasheet', 'metasheet'],
    ['postgresql://u:p@staging-postgres:5432/metasheet?sslmode=disable', 'metasheet'],
    ['postgres://u@h/window_runner_rehearsal?a=1&b=2', 'window_runner_rehearsal'],
  ]
  for (const [dsn, expected] of cases) {
    const result = runPipefailBash(`source '${LIB}'\ndsn_database_name '${dsn}'`)
    assert.equal(result.status, 0, `expected exit 0 for dsn=${dsn}; stderr: ${result.stderr}`)
    assert.equal(result.stdout.trim(), expected, `dsn=${dsn}`)
  }
})

test('dsn_replace_database: swaps the db-name path segment, preserving host/port/query', () => {
  const cases = [
    // [input DSN, new db name, expected output]
    [
      'postgres://metasheet:change-me@postgres:5432/metasheet',
      'window_runner_rehearsal',
      'postgres://metasheet:change-me@postgres:5432/window_runner_rehearsal',
    ],
    [
      // The exact runbook / app.staging.env.example shape, with the ?sslmode=disable
      // suffix the docker/app.staging.env.example comment calls out — must survive.
      'postgres://metasheet:change-me@postgres:5432/metasheet?sslmode=disable',
      'window_runner_rehearsal',
      'postgres://metasheet:change-me@postgres:5432/window_runner_rehearsal?sslmode=disable',
    ],
    [
      // postgresql:// scheme + multiple query params.
      'postgresql://appuser:secret@db-host:5433/dbname?sslmode=require&connect_timeout=10',
      'window_runner_rehearsal',
      'postgresql://appuser:secret@db-host:5433/window_runner_rehearsal?sslmode=require&connect_timeout=10',
    ],
    [
      // No explicit port, no query string.
      'postgres://metasheet@postgres/metasheet',
      'window_runner_rehearsal',
      'postgres://metasheet@postgres/window_runner_rehearsal',
    ],
  ]
  for (const [dsn, newDb, expected] of cases) {
    const result = runPipefailBash(`source '${LIB}'\ndsn_replace_database '${dsn}' '${newDb}'`)
    assert.equal(result.status, 0, `expected exit 0 for dsn=${dsn}; stderr: ${result.stderr}`)
    assert.equal(result.stdout, expected, `dsn rewrite mismatch for input: ${dsn}`)
  }
})

test('staging-only contract: the remote script names only staging containers', () => {
  const source = readFileSync(REMOTE_SH, 'utf8')
  for (const name of [
    'metasheet-staging-backend',
    'metasheet-staging-web',
    'metasheet-staging-postgres',
    'metasheet-staging-redis',
  ]) {
    assert.match(source, new RegExp(name), `remote script must pin ${name}`)
  }
  // Any literal prod-track container name (not merely the metasheet-staging- prefix)
  // in the remote script is a regression.
  const withoutStaging = source.replaceAll(/metasheet-staging-(backend|web|postgres|redis)/g, '')
  assert.doesNotMatch(
    withoutStaging,
    /['"]metasheet-(backend|web|postgres|redis)['"]/,
    'remote script must never reference prod-track container names',
  )
  assert.match(source, /docker-compose\.app\.staging\.yml/, 'remote script must pin the staging compose file')
  assert.doesNotMatch(
    source.replaceAll('docker-compose.app.staging.yml', ''),
    /docker-compose\.app\.yml/,
    'remote script must never reference the prod-track compose file',
  )
})

test('rehearsal restore keeps the replica-role trigger suppression (load-bearing: partition-inherited row triggers fire during COPY without it — runs 29340321213/29347058494; --disable-triggers is inert in full restores)', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const restoreIdx = remote.indexOf('pg_restore -j 2 -U')
  assert.notEqual(restoreIdx, -1, 'expected the rehearsal pg_restore invocation to exist')
  const setIdx = remote.indexOf("SET session_replication_role = 'replica'")
  const resetIdx = remote.indexOf('RESET session_replication_role')
  assert.notEqual(setIdx, -1, 'rehearsal lost the DB-level replica-role SET before restore')
  assert.notEqual(resetIdx, -1, 'rehearsal lost the RESET after restore (rehearsal migrate must run under normal trigger semantics)')
  assert.ok(setIdx < restoreIdx, 'replica-role SET must come BEFORE the pg_restore invocation')
  assert.ok(restoreIdx < resetIdx, 'RESET must come AFTER the pg_restore invocation')
})

// --- action=residue-sweep (bundle §7 "Consolidated final residue sweep") --------------

function extractResidueSweepAction() {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const startMarker = 'action_residue_sweep() {'
  const start = remote.indexOf(startMarker)
  assert.notEqual(start, -1, 'expected action_residue_sweep() to be defined in the remote script')
  const end = remote.indexOf('\naction_status() {', start)
  assert.notEqual(end, -1, 'expected action_status() to immediately follow action_residue_sweep() (used as the end marker)')
  return remote.slice(start, end)
}

test('residue-sweep is wired into the remote-script dispatcher and the workflow action choices', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(
    remote,
    /residue-sweep\)\s*action_residue_sweep\s*;;/,
    'expected the case "$ACTION" dispatcher to route residue-sweep to action_residue_sweep',
  )
  const yaml = readFileSync(WORKFLOW, 'utf8')
  assert.match(
    yaml,
    /options:\s*\[deploy,\s*smoke,\s*status,\s*migrate,\s*residue-sweep,\s*soak-baseline,\s*soak-seed,\s*soak-flags,\s*soak-run,\s*soak-status\]/,
    'expected the workflow action input to list residue-sweep (and the soak actions) as choices',
  )
  assert.match(yaml, /stamps:/, 'expected a `stamps` workflow_dispatch input for action=residue-sweep')
})

test('residue-sweep SQL covers all five bundle §7 stamp-prefix families and the three shared-deliveries source_type families (source-contract, mutation-provable: dropping any one literal below fails its own assertion)', () => {
  const action = extractResidueSweepAction()

  // bundle §5's mutually-exclusive stamp prefixes — every one of the five smokes must be
  // represented by at least one literal prefix match in the sweep SQL (not just accepted as
  // an unused input).
  const stampPrefixFamilies = {
    'ae4-smoke-': "'ae4-smoke-'",
    'rd45-smoke-': "'rd45-smoke-'",
    'otbank-v18-smoke-': "'otbank-v18-smoke-'",
    'mp6-smoke-': "'mp6-smoke-'",
    'hmr5-smoke-': "'hmr5-smoke-'",
  }
  for (const [family, literal] of Object.entries(stampPrefixFamilies)) {
    const count = action.split(literal).length - 1
    assert.ok(count >= 1, `expected the residue-sweep SQL to reference the ${family} family prefix (${literal}) at least once, found ${count}`)
  }

  // bundle §5 "The shared deliveries table" — every source_type that writes
  // attendance_notification_deliveries must be scoped explicitly (never source_type alone).
  const sourceTypeFamilies = ["'attendance_result_edit'", "'attendance_report_digest'", "'manual_missed_punch_reminder'"]
  for (const literal of sourceTypeFamilies) {
    const count = action.split(literal).length - 1
    assert.ok(count >= 1, `expected the residue-sweep SQL to scope a query by source_type = ${literal}, found ${count}`)
  }
})

test('residue-sweep runs all 29 bundle §7 named checks (source-contract, mutation-provable: removing any name below fails)', () => {
  const action = extractResidueSweepAction()
  const expectedNames = [
    'users', 'user_orgs', 'records', 'requests',
    'ae4_deliveries', 'rd45_deliveries', 'stray_deliveries_to_smoke_users',
    'settlements', 'cycles', 'lots', 'fixtures', 'leave_types', 'holidays', 'approval_instances',
    'mp6_requests', 'mp6_records', 'mp6_events', 'mp6_approval_instances', 'mp6_users', 'mp6_user_orgs', 'mp6_deliveries',
    'hmr5_deliveries', 'hmr5_stray_deliveries', 'hmr5_requests', 'hmr5_records', 'hmr5_scopes', 'hmr5_user_orgs', 'hmr5_user_roles', 'hmr5_users',
  ]
  assert.equal(expectedNames.length, 29, 'test fixture itself must list exactly 29 names (bundle §7)')
  for (const name of expectedNames) {
    const re = new RegExp(`residue_check\\s+"\\$pg_user"\\s+"\\$pg_db"\\s+${name}\\s`)
    assert.match(action, re, `expected a residue_check call named "${name}"`)
  }
  const calls = action.match(/residue_check\s+"\$pg_user"\s+"\$pg_db"\s+\S+/g) || []
  assert.equal(calls.length, 29, `expected exactly 29 residue_check invocations, found ${calls.length}`)
})

test('residue-sweep captured-id substitutions are documented at their call site (bundle §7 named these :otbank_approval_ids / :otbank_cycle_ids / :mp6_request_ids / :mp6_approval_ids / :rd45_smoke_org / :hmr5_org, which no helper archives to a file)', () => {
  const action = extractResidueSweepAction()
  for (const needle of ['SUBSTITUTION:', ':otbank_approval_ids', ':otbank_cycle_ids', ':mp6_request_ids', ':mp6_approval_ids', ':rd45_smoke_org', ':hmr5_org']) {
    assert.ok(action.includes(needle), `expected the residue-sweep action to document the ${needle} substitution`)
  }
})

test('residue-sweep fails closed on nonzero residue and emits the CONSOLIDATED_RESIDUE_SWEEP summary line', () => {
  const action = extractResidueSweepAction()
  assert.match(action, /result="FAIL"/, 'expected the sweep to set result=FAIL when any check is nonzero')
  assert.match(
    action,
    /echo "CONSOLIDATED_RESIDUE_SWEEP result=\$\{result\} nonzero=\$\{nonzero_list\}"/,
    'expected the exact CONSOLIDATED_RESIDUE_SWEEP result=<ok|FAIL> nonzero=<list> summary line',
  )
  assert.match(action, /fail "residue sweep found nonzero residue/, 'expected the job to fail (non-zero exit) when any check is nonzero')
})

test('residue-sweep validates the 5-field stamps shape and each stamp against its own STAMP_PATTERN before querying', () => {
  const action = extractResidueSweepAction()
  assert.match(action, /\^ae4-smoke-\[A-Za-z0-9-\]\+\$/)
  assert.match(action, /\^rd45-smoke-\[A-Za-z0-9-\]\+\$/)
  assert.match(action, /\^otbank-v18-smoke-\[A-Za-z0-9-\]\+\$/)
  assert.match(action, /\^mp6-smoke-\[A-Za-z0-9-\]\+\$/)
  assert.match(action, /\^hmr5-smoke-\[A-Za-z0-9-\]\+\$/)
})

// --- persistent runner override lifecycle (#3317; fixes containment run 29398270060) ------

test('persistent override: lives under $HOME/.metasheet2/window-runner, NOT the per-run OUTPUT_DIR (a per-run path is deleted on cleanup, dangling each container docker-compose config_files label)', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(remote, /RUNNER_PERSIST_DIR="\$\{HOME\}\/\.metasheet2\/window-runner"/, 'expected a persistent runner dir under $HOME/.metasheet2/window-runner')
  assert.match(remote, /OVERRIDE_FILE="\$\{RUNNER_PERSIST_DIR\}\/docker-compose\.window-runner\.override\.yml"/, 'OVERRIDE_FILE must resolve under the persistent dir')
  assert.doesNotMatch(remote, /OVERRIDE_FILE="\$\{OUTPUT_DIR\}/, 'OVERRIDE_FILE must NOT live under the per-run OUTPUT_DIR')
})

test('persistent override: written atomically — mktemp candidate + docker compose config validation + rename, never a truncating write straight onto the live file', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(remote, /override_tmp="\$\(mktemp "\$\{RUNNER_PERSIST_DIR\}\/\.override\.XXXXXX"\)"/, 'expected a mktemp candidate override in the persist dir (X placeholder at the END — no trailing suffix)')
  const validateIdx = remote.indexOf('docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_CANDIDATE_TMP" -f "$override_tmp" config')
  const mvIdx = remote.indexOf('mv -f "$override_tmp" "$OVERRIDE_FILE"')
  assert.notEqual(validateIdx, -1, 'candidate override must be validated with docker compose config before replacing the live file')
  // the validation MUST run in the same cwd as compose_staging() (cd "$STAGING_DIR"), or it
  // resolves relative env_file/.env differently than the config `up -d` actually executes
  assert.match(
    remote.slice(Math.max(0, validateIdx - 120), validateIdx),
    /\(cd "\$STAGING_DIR" && IMAGE_OWNER="\$IMAGE_OWNER" IMAGE_TAG="\$DEPLOY_SHA" \\\n\s*$/,
    'candidate pair validation must use the staging cwd and exact-SHA interpolation, matching compose_staging()',
  )
  assert.notEqual(mvIdx, -1, 'candidate override must be atomically renamed into place')
  assert.ok(validateIdx < mvIdx, 'validation must come BEFORE the atomic rename')
  assert.doesNotMatch(remote, /\}\s*>\s*"\$OVERRIDE_FILE"\n/, 'the override body must be written to the temp candidate, not truncated directly onto the live override')
})

test('persistent override: set_window_env=none writes NO flag env — the ATTENDANCE_*_ENABLED echoes in the override BODY are gated behind the rd-window branch, so a none redeploy clears prior flags from the persisted file', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  // scope strictly to the override-write heredoc region (ATTENDANCE_SCHEDULER_ENABLED also
  // appears earlier in the env-flags diagnostic block, which is not the override body)
  const start = remote.indexOf('override_tmp="$(mktemp')
  const end = remote.indexOf('> "$override_tmp"', start)
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected the override-write heredoc region')
  const body = remote.slice(start, end)
  const rdIdx = body.indexOf('if [[ "$SET_WINDOW_ENV" == "rd-window" ]]; then')
  const fiIdx = body.indexOf('\n    fi', rdIdx)
  const schedIdx = body.indexOf('ATTENDANCE_SCHEDULER_ENABLED')
  const workerIdx = body.indexOf('ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED')
  assert.notEqual(rdIdx, -1, 'expected the rd-window gate inside the override body')
  assert.notEqual(fiIdx, -1, 'expected the rd-window gate to be closed with fi')
  assert.ok(rdIdx < schedIdx && schedIdx < fiIdx, 'the scheduler flag echo must sit INSIDE the rd-window gate')
  assert.ok(rdIdx < workerIdx && workerIdx < fiIdx, 'the worker flag echo must sit INSIDE the rd-window gate')
})

test('persistent override: the workflow cleanup rm -rf never targets the persistent runner dir, so the override (and the containers config_files label) survives OUTPUT_DIR removal', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.match(workflow, /rm -rf \$\{remote_output_dir\} \$\{RUNNER_DIR\}/, 'expected the post-run cleanup rm to target only the per-run output + checkout dirs')
  assert.doesNotMatch(workflow, /rm -rf[^\n]*\.metasheet2/, 'workflow cleanup must NEVER rm the persistent .metasheet2 runner override dir')
})

test('persistent override: POSITIVE CONTROL — the exact mktemp template REALLY randomizes on this platform (a mid-template X run like .XXXXXX.yml makes GNU mktemp error and BSD return the literal)', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const m = remote.match(/mktemp "\$\{RUNNER_PERSIST_DIR\}(\/[^"]+)"/)
  assert.ok(m, 'expected the mktemp candidate template to extract')
  const dir = mkdtempSync(join(tmpdir(), 'winrunner-persist-'))
  const template = `${dir}${m[1]}` // e.g. <dir>/.override.XXXXXX
  const r1 = spawnSync('mktemp', [template], { encoding: 'utf8' })
  const r2 = spawnSync('mktemp', [template], { encoding: 'utf8' })
  assert.equal(r1.status, 0, `mktemp REJECTED the template (non-portable): ${r1.stderr || r1.error}`)
  assert.equal(r2.status, 0, `mktemp REJECTED the template (non-portable): ${r2.stderr || r2.error}`)
  const p1 = r1.stdout.trim(), p2 = r2.stdout.trim()
  assert.notEqual(p1, template, 'mktemp returned the LITERAL template (no randomization) — X placeholder not honored (non-portable)')
  assert.notEqual(p1, p2, 'two mktemp calls produced the SAME path — not randomized')
  assert.ok(existsSync(p1) && existsSync(p2), 'mktemp did not actually create the candidate files')
})

test('persistent override re-normalization: force_recreate is an explicit deploy-only boolean that defaults off', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.match(
    workflow,
    /force_recreate:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    'force_recreate must be a boolean workflow input and default to false',
  )
  assert.match(
    workflow,
    /if \[\[ "\$ACTION" != "deploy" && "\$FORCE_RECREATE" == "true" \]\]; then\n\s+echo "force_recreate=true is only allowed for action=deploy"/,
    'workflow input validation must reject force_recreate on non-deploy actions',
  )
  assert.match(workflow, /export FORCE_RECREATE='\$\{FORCE_RECREATE\}'/, 'validated force_recreate must reach the remote script')
})

test('persistent override re-normalization: force mode adds --force-recreate while the service set stays exactly backend+web', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const start = remote.indexOf('action_deploy() {')
  const end = remote.indexOf('\naction_smoke() {', start)
  assert.ok(start !== -1 && end > start, 'expected action_deploy() bounds')
  const deploy = remote.slice(start, end)
  assert.match(deploy, /local -a up_args=\(up -d --no-deps\)/, 'deploy must retain --no-deps')
  assert.match(
    deploy,
    /if \[\[ "\$FORCE_RECREATE" == "true" \]\]; then\n\s+up_args\+=\(--force-recreate\)\n\s+fi/,
    'force mode must add the load-bearing --force-recreate option',
  )
  assert.match(deploy, /up_args\+=\(backend web\)\n\s+compose_staging "\$\{up_args\[@\]\}"/, 'the only recreated services must be backend and web')
  assert.doesNotMatch(deploy, /up_args\+=\([^\n]*(?:postgres|redis)/, 'postgres/redis must never enter the recreate service list')
})

// --- W4+W7 combined-soak actions (#4556): soak-baseline / soak-seed / soak-flags /
// --- soak-run / soak-status source contracts --------------------------------------------
//
// Same discipline as the residue-sweep block above: extract each action's slice by its
// function markers, assert the load-bearing literals, and prove the assertions are
// themselves load-bearing with mutation legs that delete one guard and require the
// contract to go red.

const GENERATOR = join(HERE, 'attendance-w4w7-soak-load-generator.mjs')
const SOAK_TEMPLATE = join(HERE, 'attendance-w4w7-soak-config.template.json')

function sliceBetween(source, startMarker, endMarker, what) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `expected ${what} start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `expected ${what} end marker: ${endMarker}`)
  return source.slice(start, end)
}

function extractSoakSlices(remote) {
  return {
    baseline: sliceBetween(remote, 'action_soak_baseline() {', '\nsoak_seed_write_org_sql() {', 'soak-baseline'),
    // The seed slice deliberately spans its helpers (SQL writer, per-org report, W4/W7
    // posture walks) through the end of action_soak_seed — they are one action's body.
    seed: sliceBetween(remote, 'soak_seed_write_org_sql() {', '\naction_soak_flags() {', 'soak-seed'),
    flags: sliceBetween(remote, 'action_soak_flags() {', '\naction_soak_run() {', 'soak-flags'),
    run: sliceBetween(remote, 'action_soak_run() {', '\nsoak_status_scalar() {', 'soak-run'),
    status: sliceBetween(remote, 'soak_status_scalar() {', '\n# --- main', 'soak-status'),
  }
}

function assertSoakContract({ remote, workflow }) {
  const slices = extractSoakSlices(remote)

  // Dispatcher + workflow wiring: every soak action routed, enum + validation updated,
  // inputs exported into the remote prelude, generator shipped in the sync tar.
  for (const action of ['baseline', 'seed', 'flags', 'run', 'status']) {
    assert.match(
      remote,
      new RegExp(`soak-${action}\\)\\s*action_soak_${action}\\s*;;`),
      `dispatcher must route soak-${action} to action_soak_${action}`,
    )
  }
  assert.match(
    workflow,
    /case "\$ACTION" in deploy\|smoke\|status\|migrate\|residue-sweep\|soak-baseline\|soak-seed\|soak-flags\|soak-run\|soak-status\)/,
    'workflow input validation must accept exactly the dispatcherʼs action set',
  )
  assert.match(
    workflow,
    /"\$ACTION" == "deploy" \|\| "\$ACTION" == "smoke" \|\| "\$ACTION" == "soak-flags"/,
    'deploy_sha must be required for soak-flags (env-only action still pins the RUNNING image tags)',
  )
  assert.match(workflow, /export SOAK_ORGS='\$\{SOAK_ORGS\}'/, 'validated soak_orgs must reach the remote script')
  assert.match(workflow, /export SOAK_OPTS='\$\{SOAK_OPTS\}'/, 'validated soak_opts must reach the remote script')
  assert.match(
    workflow,
    /scripts\/ops\/attendance-w4w7-soak-load-generator\.mjs \\\n/,
    'the sync tar must ship the soak load generator to the deploy host',
  )
  assert.match(
    workflow,
    /node --check scripts\/ops\/attendance-w4w7-soak-load-generator\.mjs/,
    'the validate step must parse-check the generator',
  )

  // Posture single-writer discipline: NOWHERE in the remote script may a posture table be
  // written directly — both tables carry legal-transition triggers and exactly one
  // sanctioned writer each, driven only through the operator CLIs.
  assert.doesNotMatch(
    remote,
    /INSERT INTO attendance_calculation_rollout_state/i,
    'the remote script must NEVER insert into attendance_calculation_rollout_state (Gate C CLI is the only path)',
  )
  assert.doesNotMatch(
    remote,
    /INSERT INTO attendance_calculation_context_source_state/i,
    'the remote script must NEVER insert into attendance_calculation_context_source_state (W7-3 CLI is the only path)',
  )
  assert.doesNotMatch(
    remote,
    /UPDATE attendance_calculation_(rollout|context_source)_state/i,
    'the remote script must NEVER update a posture table directly',
  )

  // soak-baseline: fail-closed order gate BEFORE any measurement; both allowlist envs
  // probed; the two P95 pack queries; marker + p95-baseline-<sha8>-<ts> naming.
  const refusalIdx = slices.baseline.indexOf('refusing to capture the p95 baseline')
  const measureIdx = slices.baseline.indexOf('percentile_cont(0.95)')
  assert.notEqual(refusalIdx, -1, 'soak-baseline must refuse when either allowlist env is already set')
  assert.notEqual(measureIdx, -1, 'soak-baseline must run the P95 pack latency-proxy query')
  assert.ok(refusalIdx < measureIdx, 'the flags-already-set refusal must come BEFORE any measurement')
  assert.match(slices.baseline, /SOAK_W4_ENV_NAME/, 'baseline must probe the W4 allowlist env')
  assert.match(slices.baseline, /SOAK_W7_ENV_NAME/, 'baseline must probe the W7 allowlist env')
  assert.match(slices.baseline, /pg_stat_statements/, 'baseline must capture (or record as absent) the pg_stat_statements channel')
  assert.match(slices.baseline, /p95-baseline-\$\{sha8\}-\$\{ts\}/, 'baseline artifact must be named p95-baseline-<sha8>-<ts>')
  assert.match(slices.baseline, /> "\$SOAK_BASELINE_MARKER"/, 'baseline must write the marker soak-flags gates on')
  assert.match(remote, /ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED/, 'the W4 allowlist env name must be pinned')
  assert.match(remote, /ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED/, 'the W7 allowlist env name must be pinned')

  // soak-seed: idempotent SQL, closed synthetic-user family, permission grant, both
  // operator CLIs with their exact confirmation tokens, owner-authored authorization ref,
  // verified-before-attested manifest preflight, kickoff-rung-only W7 walk.
  for (const literal of [
    'ON CONFLICT (id) DO NOTHING',
    'ON CONFLICT (org_id, group_id) DO NOTHING',
    'ON CONFLICT (shift_id, segment_index) DO NOTHING',
  ]) {
    assert.ok(slices.seed.includes(literal), `seed SQL must be idempotent: missing ${literal}`)
  }
  assert.ok(
    (slices.seed.match(/NOT EXISTS \(/g) || []).length >= 5,
    'seed SQL must guard business-key inserts with NOT EXISTS existence checks (shift, group, members, assignments, memberships)',
  )
  assert.match(remote, /SOAK_USER_PREFIX="synth-w4w7-"/, 'the closed synthetic user family prefix must be pinned')
  assert.ok(slices.seed.includes("'attendance:write'"), 'seed must grant attendance:write (punch route is withPermission-gated)')
  assert.ok(slices.seed.includes('"$SOAK_W4C5_CLI" plan'), 'W4 posture must go through the Gate C CLI plan')
  assert.ok(slices.seed.includes('"$SOAK_W4C5_CLI" apply'), 'W4 posture must go through the Gate C CLI apply')
  assert.ok(slices.seed.includes('"$SOAK_W7_CLI" plan'), 'W7 posture must go through the W7-3 CLI plan')
  assert.ok(slices.seed.includes('"$SOAK_W7_CLI" apply'), 'W7 posture must go through the W7-3 CLI apply')
  assert.ok(
    slices.seed.includes('--confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_ONLY'),
    'W4C-5 apply must carry its exact confirmation token',
  )
  assert.ok(
    slices.seed.includes('--confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_CONTEXT_SOURCE_ONLY'),
    'W7-3 apply must carry its exact confirmation token',
  )
  assert.ok(
    slices.seed.includes('owner_ref is required for action=soak-seed'),
    'seed must refuse without an owner-authored authorization reference (never fabricated)',
  )
  assert.ok(slices.seed.includes("grep -q '^Pending: 0$'"), 'seed must VERIFY pending=0 before attesting it in a manifest')
  assert.ok(slices.seed.includes('"ok":true'), 'seed must VERIFY service health before attesting it in a manifest')
  assert.ok(
    slices.seed.includes('refusing to attest externalNotificationsDisabled=true'),
    'seed must verify the delivery worker is off before attesting notifications disabled',
  )
  assert.ok(
    slices.seed.includes('is not runnable by this kickoff seeder'),
    'seed must refuse W7 targets beyond group_shadow (compare-window exit predicates need real soak evidence)',
  )
  assert.match(slices.seed, /suspended\)\s*\n\s*fail/, 'seed must fail closed on a suspended posture, never resume it')

  // soak-flags: baseline-marker order gate BEFORE the override write; atomic
  // candidate->validate->rename via the SAME persistent override; backend-only recreate
  // with postgres/redis/web container-id assertions; exact env verification + health.
  const markerGateIdx = slices.flags.indexOf('[[ -f "$SOAK_BASELINE_MARKER" ]]')
  const overrideTmpIdx = slices.flags.indexOf('mktemp "${RUNNER_PERSIST_DIR}/.soak-override.XXXXXX"')
  const flagsValidateIdx = slices.flags.indexOf('-f "$soak_override_tmp" config')
  const flagsRenameIdx = slices.flags.indexOf('mv -f "$soak_override_tmp" "$OVERRIDE_FILE"')
  assert.notEqual(markerGateIdx, -1, 'soak-flags must gate on the soak-baseline marker (baseline BEFORE flags)')
  assert.notEqual(overrideTmpIdx, -1, 'soak-flags must write a mktemp candidate in the persist dir')
  assert.notEqual(flagsValidateIdx, -1, 'soak-flags must docker-compose-config-validate the candidate pair')
  assert.notEqual(flagsRenameIdx, -1, 'soak-flags must atomically rename the candidate onto OVERRIDE_FILE')
  assert.ok(markerGateIdx < overrideTmpIdx, 'the baseline-marker gate must come BEFORE the override write')
  assert.ok(overrideTmpIdx < flagsValidateIdx && flagsValidateIdx < flagsRenameIdx, 'candidate -> validate -> rename, in that order')
  assert.ok(
    slices.flags.includes('carries rd-window env flags'),
    'soak-flags must refuse to silently rewrite an rd-window override',
  )
  assert.match(
    slices.flags,
    /compose_staging up -d --no-deps backend 2>&1/,
    'soak-flags must recreate ONLY the backend service',
  )
  assert.doesNotMatch(
    slices.flags,
    /up -d --no-deps backend web/,
    'soak-flags must never recreate the web service',
  )
  assert.doesNotMatch(slices.flags, /up -d[^\n]*(postgres|redis)/, 'soak-flags must never recreate postgres/redis')
  assert.equal(
    (slices.flags.match(/hard constraint violated/g) || []).length,
    2,
    'postgres AND redis container ids must be asserted unchanged',
  )
  assert.ok(
    slices.flags.includes('soak-flags must touch ONLY the backend'),
    'the web container id must be asserted unchanged too',
  )
  assert.match(
    slices.flags,
    /\[\[ "\$live_w4" == "\$\{SOAK_ORG1\},\$\{SOAK_ORG2\},\$\{SOAK_ORG3\}" \]\]/,
    'the W4 allowlist must be verified EXACT-MATCH in the running container env',
  )
  assert.match(
    slices.flags,
    /\[\[ "\$live_w7" == "\$\{SOAK_ORG3\}" \]\]/,
    'the W7 allowlist must be verified EXACT-MATCH (org3 only) in the running container env',
  )
  assert.ok(slices.flags.includes('"ok":true'), 'soak-flags must health-check after the recreate')
  assert.match(slices.flags, /> "\$SOAK_WINDOW_START_FILE"/, 'soak-flags must record the soak window start')

  // soak-run: real login route only (never minted tokens), ruled rate ceiling + daily
  // quota, generator + exact execute confirmation, flags-live order gate, tokens never
  // shipped into the artifact, haltedReason surfaced.
  assert.ok(slices.run.includes('/api/auth/login'), 'soak-run must obtain tokens via the REAL login route')
  assert.doesNotMatch(slices.run, /\bmint_token\b/, 'soak-run must never mint a token for soak users')
  assert.ok(
    slices.run.includes('allowlist env not live on the backend'),
    'soak-run must refuse before soak-flags has run (order enforcement)',
  )
  assert.ok(slices.run.includes('--rate-limit-per-sec 1'), 'soak-run must pin the ruled <=1 req/sec global ceiling')
  assert.ok(slices.run.includes('--punches-per-user-per-day 8'), 'soak-run must pin the ruled 8 punches/user/day quota')
  assert.ok(
    slices.run.includes('--confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY'),
    'soak-run must carry the generatorʼs exact execute confirmation token',
  )
  assert.ok(slices.run.includes('--confirm-org-ids'), 'soak-run must pass the org-set confirmation (set-equality guard)')
  assert.match(remote, /SOAK_GENERATOR_SCRIPT="attendance-w4w7-soak-load-generator\.mjs"/, 'the committed generator must be the one executed')
  assert.doesNotMatch(
    slices.run,
    /run_config_host" "\$\{OUTPUT_DIR\}/,
    'the token-bearing run config must NEVER be copied into the uploaded artifact dir',
  )
  assert.ok(slices.run.includes('cleanup_soak_run'), 'soak-run must delete the token-bearing temp config (trap cleanup)')
  assert.ok(slices.run.includes('max_consecutive_incidents'), 'soak-run must fail on the consecutive-incident halt (alert-class)')
  assert.ok(slices.run.includes('haltedReason is LOAD-BEARING'), 'soak-run must surface haltedReason semantics in its summary')

  // soak-status: the monitoring-pack Q-series labels must all be present, plus the W7-2
  // compare-window discriminators (marker AND selector — selector alone would count W4
  // shadow rows), and a mechanical-alert exit.
  for (const label of [
    '[Q1]', '[Q2]', '[Q3]', '[Q4a]', '[Q4b]', '[Q5]', '[Q6]', '[Q7]', '[Q8]',
    '[Q9]', '[Q10]', '[Q11]', '[Q12]', '[Q13]', '[Q14]', '[Q15a]', '[Q15b]', '[Q15c]', '[Q16]',
  ]) {
    assert.ok(slices.status.includes(label), `soak-status must run the monitoring-pack ${label} read`)
  }
  assert.ok(slices.status.includes('w7GroupShadowCompare'), 'W7-2 counters must scope on the writer-controlled marker')
  assert.ok(slices.status.includes("'group_effective'"), 'W7-2 counters must scope on the selector discriminator')
  assert.ok(
    slices.status.includes("shadow_diff_code IN ('work_date_mismatch','context_mismatch','input_mismatch','review_required')"),
    'the critical shadow-diff code set must be spelled exactly',
  )
  assert.ok(
    slices.status.includes("(c.context_snapshot ->> 'selector') IS NULL"),
    'the selector-less totality (corruption) probe must run',
  )
  assert.ok(
    slices.status.includes('readAttendanceRequestSnapshotDefectReportV1'),
    'Q8 must call the EXISTING 8-cell report function, never a raw-SQL re-derivation',
  )
  assert.ok(slices.status.includes('mechanical alert condition'), 'soak-status must exit nonzero on mechanical alerts')
}

test('combined-soak actions: full source contract (workflow wiring, order gates, single-writer posture discipline, ruled rate/quota pins)', () => {
  assertSoakContract({
    remote: readFileSync(REMOTE_SH, 'utf8'),
    workflow: readFileSync(WORKFLOW, 'utf8'),
  })
})

test('MUTATION: deleting the soak-flags baseline-marker gate turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace('  [[ -f "$SOAK_BASELINE_MARKER" ]] \\\n', '')
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /baseline marker|baseline-marker/,
  )
})

test('MUTATION: deleting the soak-flags postgres container-id assertion turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const guard = '  [[ "$pg_id_before" == "$pg_id_after" ]] || fail "staging postgres container was recreated — hard constraint violated"\n'
  assert.ok(slices.flags.includes(guard), 'mutation anchor must hit the flags slice')
  const mutatedFlags = slices.flags.replace(guard, '')
  const mutated = original.replace(slices.flags, mutatedFlags)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /postgres AND redis container ids/,
  )
})

test('MUTATION: dropping the generator execute-confirmation from soak-run turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace(
    '    --confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY \\\n',
    '',
  )
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /execute confirmation token/,
  )
})

test('MUTATION: unrouting soak-seed from the dispatcher turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace('  soak-seed) action_soak_seed ;;\n', '')
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /dispatcher must route soak-seed/,
  )
})

test('soak generator: committed tool keeps its reviewed guard rails (rate ceiling, dry-run default, ruled daily quota, upper-bound count semantics)', () => {
  const generator = readFileSync(GENERATOR, 'utf8')
  assert.ok(
    generator.includes("'I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY'"),
    'the exact-match execute confirmation literal must survive promotion',
  )
  assert.match(
    generator,
    /rateLimitPerSec <= 0 \|\| opts\.rateLimitPerSec > 1/,
    'the (0,1] global rate ceiling guard must survive promotion',
  )
  assert.match(
    generator,
    /'SOAK_PUNCHES_PER_USER_PER_DAY', 8\)/,
    'the ruled default of 8 punches/user/day (§2A.7/§2A.9 row) must be the default',
  )
  assert.ok(generator.includes('UPPER-BOUNDS'), 'the HTTP-tally-upper-bounds-DB-count semantics note must survive')
  assert.ok(generator.includes("execute: readBoolOpt(args, 'execute', 'SOAK_EXECUTE', false)"), 'dry-run must stay the default')
  assert.doesNotMatch(generator, /dev-token\?/, 'the generator must never call the test-only dev-token endpoint')
})

test('soak config template: inert by construction (three postures, empty tokenOrCreds)', () => {
  const template = JSON.parse(readFileSync(SOAK_TEMPLATE, 'utf8'))
  assert.equal(template.entries.length, 3, 'template must model the three-posture design')
  assert.deepEqual(
    template.entries.map((entry) => entry.posture),
    ['legacy_only', 'w4_only_legacy_arm', 'both_machines_group_arm'],
    'template postures must follow the C3 order',
  )
  for (const entry of template.entries) {
    assert.deepEqual(entry.tokenOrCreds, {}, 'template must never carry tokens — the generator refuses token-less users, keeping the template inert')
    assert.ok(entry.userIds.length > 0, 'template entries must model the closed user set')
    assert.ok(entry.userIds.every((id) => id.startsWith('synth-w4w7-')), 'template user ids must follow the closed synthetic family convention')
  }
  assert.equal(template.sourceTag, 'synthetic_w4w7_soak_accelerator_v1', 'the durable source tag must match the generator default')
})

test('raw-control-byte guard: no soak-touched file carries raw control bytes (git-binary diff-blindness class)', () => {
  const files = [REMOTE_SH, WORKFLOW, GENERATOR, SOAK_TEMPLATE]
  // Allowed: \t (0x09), \n (0x0a), \r (0x0d). Everything else below 0x20, plus 0x7f NUL-class
  // bytes, turns the file git-binary (diff-blind; secret-scan merge gates skip it).
  for (const file of files) {
    const buf = readFileSync(file)
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i]
      const isAllowed = byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x20
      assert.ok(isAllowed, `${file} carries a raw control byte 0x${byte.toString(16)} at offset ${i}`)
    }
  }
})
