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
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'node:fs'
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
    flags: sliceBetween(remote, 'action_soak_flags() {', '\n# --- soak daily-batch guard', 'soak-flags'),
    // The run slice deliberately spans the guard/classifier helper functions ahead of
    // action_soak_run — they are that action's testable units.
    run: sliceBetween(remote, '# --- soak daily-batch guard', '\nsoak_status_scalar() {', 'soak-run'),
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
  //
  // The forbidden-DML regexes are ASSEMBLED FROM PARTS deliberately: a contiguous
  // "INSERT INTO <posture-table>" literal in THIS file would itself be booked as an
  // unauthorized writer by the repo's own single-writer inventory sweeps
  // (w4c3a-rollout-control-inventory.test.ts greps every tracked .mjs for exactly that
  // pattern, negative assertions included). Splitting the literal keeps this guard's
  // behavior identical while staying outside those sweeps' text domain — prefer
  // not-tripping over widening an inventory allowlist.
  const postureInsertRe = (table) => new RegExp('INSERT\\s+INTO\\s+attendance_calculation_' + table, 'i')
  assert.doesNotMatch(
    remote,
    postureInsertRe('rollout_state'),
    'the remote script must NEVER insert into the W4 rollout posture table (Gate C CLI is the only path)',
  )
  assert.doesNotMatch(
    remote,
    postureInsertRe('context_source_state'),
    'the remote script must NEVER insert into the W7 context-source posture table (W7-3 CLI is the only path)',
  )
  assert.doesNotMatch(
    remote,
    new RegExp('UPDATE\\s+attendance_calculation_' + '(rollout|context_source)_state', 'i'),
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
    'ON CONFLICT (org_id, group_id) DO NOTHING',
    'ON CONFLICT (shift_id, segment_index) DO NOTHING',
  ]) {
    assert.ok(slices.seed.includes(literal), `seed SQL must be idempotent: missing ${literal}`)
  }
  assert.ok(
    (slices.seed.match(/NOT EXISTS \(/g) || []).length >= 6,
    'seed SQL must guard business-key inserts with NOT EXISTS existence checks (users, shift, group, members, assignments, memberships)',
  )
  // Identity-gate defect (staging run 31957449480): the W4C0 §4.1 canonical identity gate
  // fail-closes non-UUID user ids at the live shadow boundary, so seeded user IDS must be
  // minted UUIDs and the family marker may only ride username/email. Structural pins:
  // (a) the users INSERT mints gen_random_uuid()::text as the id expression;
  // (b) no INSERT puts a prefix-composed value into users.id (the retired shape);
  // (c) users idempotency is keyed on the username business key (ids are non-deterministic).
  const usersInsert = slices.seed.slice(
    slices.seed.indexOf('INSERT INTO users ('),
    slices.seed.indexOf('UPDATE users'),
  )
  assert.ok(usersInsert.length > 0, 'seed SQL must contain the users INSERT ahead of the family UPDATE')
  assert.match(usersInsert, /SELECT gen_random_uuid\(\)::text,/, 'seeded user ids must be minted UUIDs (W4C0 §4.1 identity gate)')
  assert.doesNotMatch(
    usersInsert,
    /SELECT :'user_prefix' \|\| lpad/,
    'the users INSERT must not mint prefix-composed ids (the retired TEXT-id shape 500s in W4 shadow)',
  )
  assert.match(
    usersInsert,
    /WHERE u\.username = :'user_prefix' \|\| lpad/,
    'users idempotency must be keyed on the username business key',
  )
  // (d) EXACT-SET pin on every seed-SQL line touching :'user_prefix'. The #4931 gate
  // showed a line-scoped negative regex is dodgeable four ways (same-line `.username`
  // decoys, continuation lines, VALUES form, to_char instead of lpad) — 枚举陷阱不收敛,
  // so instead: enumerate every prefix-touching line and pin the ordered multiset. Any
  // new or changed use of the prefix in the seed SQL turns this red and forces review.
  // Sanctioned forms only: email projection, username projection, username comparisons/
  // joins, and the family credential UPDATE's WHERE.
  const seedSqlBody = slices.seed.slice(
    slices.seed.indexOf('-- Synthetic users (closed set;'),
    slices.seed.indexOf('COMMIT;'),
  )
  const prefixLines = seedSqlBody.split('\n').map((l) => l.trim()).filter((l) => l.includes(":'user_prefix'"))
  assert.deepEqual(
    prefixLines,
    [
      ":'user_prefix' || lpad(i::text, 2, '0') || '@w4w7-soak.synthetic',",
      ":'user_prefix' || lpad(i::text, 2, '0'),",
      "SELECT 1 FROM users u WHERE u.username = :'user_prefix' || lpad(i::text, 2, '0'));",
      "WHERE username LIKE :'user_prefix' || '%';",
      "JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')",
      "JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')",
      "JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')",
      "JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')",
      "JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')",
    ],
    "every seed-SQL use of :'user_prefix' must be one of the sanctioned username/email forms — exact ordered set; a composed user_id would recreate the retired TEXT-id shape",
  )
  assert.ok(
    slices.seed.includes('INSERT INTO users (id, email, username, name, password_hash'),
    'the users INSERT column order must stay pinned (id first) so the minted-UUID projection pin binds to the id column',
  )
  // Retired-family remint: prefix-scoped (current UUIDs can never match), transactional,
  // canonical-bucket read-guard BEFORE any delete, users last in the dependency chain.
  assert.ok(
    slices.seed.includes("SELECT count(*) FROM users WHERE id LIKE '${SOAK_USER_PREFIX}%'"),
    'remint must detect the retired TEXT-id family by users.id prefix',
  )
  assert.ok(
    slices.seed.includes('refusing to remint'),
    'remint must fail closed if retired records carry canonical-bucket calculation artifacts',
  )
  const remintGuardIdx = slices.seed.indexOf('refusing to remint')
  const remintDeleteIdx = slices.seed.indexOf("DELETE FROM attendance_records WHERE user_id LIKE :'retired_prefix'")
  const remintUsersDeleteIdx = slices.seed.indexOf("DELETE FROM users WHERE id LIKE :'retired_prefix'")
  assert.notEqual(remintDeleteIdx, -1, 'remint must delete retired attendance_records by the retired user_id prefix')
  assert.notEqual(remintUsersDeleteIdx, -1, 'remint must delete the retired users rows by id prefix')
  assert.ok(remintGuardIdx < remintDeleteIdx, 'the canonical-bucket guard must run BEFORE any remint delete')
  assert.ok(remintDeleteIdx < remintUsersDeleteIdx, 'remint must delete dependents before the users rows')
  assert.doesNotMatch(
    slices.seed,
    /DELETE FROM attendance_record_calculations/,
    'remint must NEVER delete from the canonical-writer-only calculations table',
  )
  // #4931 gate P2 hardening — each pin below was proven load-bearing by a neuter probe
  // that left the whole suite GREEN before the pin existed (probes C9/C2'/C3/C6/C12):
  // P2-1 (C9): an unscoped retired_prefix ("%") would DELETE every user/user_org/record
  // on the host — pin the exact psql -v composition.
  assert.ok(
    slices.seed.includes('-v retired_prefix="${SOAK_USER_PREFIX}%"'),
    'remint psql must scope retired_prefix to the closed family prefix + trailing %',
  )
  // P2-2 (C2'): the canonical-bucket guard must be an exact zero comparison — `-n` (or any
  // always-true test) makes the fail-closed refusal unreachable.
  assert.ok(
    slices.seed.includes('[[ "$retired_calc" == "0" ]]'),
    'the canonical-bucket remint guard must compare the count to exact zero',
  )
  // P2-3 (C3): the remint must delete EXACTLY these seven tables in dependency order — a
  // dropped dependent (e.g. user_orgs) orphans rows whose user_id no longer resolves,
  // which the username anti-join preflight counts as non-synthetic → the org is bricked
  // for every future seed with no scripted remedy.
  const remintSqlStart = slices.seed.indexOf("DELETE FROM attendance_records WHERE user_id LIKE :'retired_prefix';")
  const remintSqlEndMark = "DELETE FROM users WHERE id LIKE :'retired_prefix';"
  const remintSqlBody = slices.seed.slice(remintSqlStart, slices.seed.indexOf(remintSqlEndMark) + remintSqlEndMark.length)
  assert.deepEqual(
    remintSqlBody.match(/DELETE FROM [a-z_]+/g) || [],
    [
      'DELETE FROM attendance_records',
      'DELETE FROM attendance_calculation_group_memberships',
      'DELETE FROM attendance_shift_assignments',
      'DELETE FROM attendance_group_members',
      'DELETE FROM user_permissions',
      'DELETE FROM user_orgs',
      'DELETE FROM users',
    ],
    'the remint must delete exactly these seven tables, dependents first, users last',
  )
  // P2-4 (C6): the deletes must run as ONE transaction under ON_ERROR_STOP — the operator-
  // facing failure message says "transactional — nothing deleted" and must stay true.
  const remintHeredoc = slices.seed.slice(
    slices.seed.indexOf('cat > "$remint_sql"'),
    slices.seed.indexOf('< "$remint_sql"'),
  )
  assert.match(remintHeredoc, /\\set ON_ERROR_STOP on/, 'remint SQL must stop on first error')
  const remintBeginIdx = remintHeredoc.indexOf('\nBEGIN;\n')
  const remintCommitIdx = remintHeredoc.indexOf('\nCOMMIT;\n')
  const remintFirstDeleteIdx = remintHeredoc.indexOf('DELETE FROM attendance_records')
  const remintLastDeleteIdx = remintHeredoc.indexOf('DELETE FROM users WHERE')
  assert.ok(remintBeginIdx !== -1 && remintCommitIdx !== -1, 'remint SQL must open and commit a transaction')
  assert.ok(
    remintBeginIdx < remintFirstDeleteIdx && remintLastDeleteIdx < remintCommitIdx,
    'every remint delete must sit inside the BEGIN/COMMIT transaction',
  )
  // P2-6 (C12): the family credential UPDATE must keep its username-prefix WHERE bound to
  // THAT statement — a bare UPDATE would reset every staging account's password and set
  // local_password_set on all of them.
  assert.match(
    slices.seed,
    /UPDATE users\n {3}SET password_hash = :'pw_hash',\n {7}is_active = true,\n {7}activation_status = 'activated',\n {7}local_password_set = true\n WHERE username LIKE :'user_prefix' \|\| '%';/,
    'the credential UPDATE must be prefix-scoped to synthetic usernames (WHERE bound to the statement)',
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
  // P2-3: entrypointInventoryRef must be operator-supplied, never a runner-fabricated
  // constant (the internal inconsistency the gate flagged — refusing to fabricate one ref
  // while fabricating another). Resolved in the honest direction: required input.
  assert.ok(
    slices.seed.includes('entrypoint_inventory_ref is required for action=soak-seed'),
    'seed must require entrypoint_inventory_ref as an operator attestation (never fabricated as a constant)',
  )
  assert.doesNotMatch(
    slices.seed,
    /entrypointInventoryRef":"w4-lock-12\.8-entry-4"/,
    'the W4 manifest must NOT hardcode entrypointInventoryRef as a literal constant',
  )
  // P2-3: customerData:false / syntheticOrgRef must be BACKED by a synthetic-org check, not
  // asserted for an arbitrary org — refuse any org holding non-synthetic content.
  assert.ok(
    slices.seed.includes('non-synthetic user_orgs member'),
    'seed must verify each org is exclusively synthetic before attesting customerData=false',
  )
  // Family membership = users.username prefix via an anti-join (ids are minted UUIDs and
  // carry no marker); a user_id that resolves to NO users row also counts as non-synthetic.
  assert.ok(
    slices.seed.includes("NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uo.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%')"),
    'the synthetic-org check must scope on the closed synthetic-user family via the username anti-join',
  )
  assert.doesNotMatch(
    slices.seed,
    /user_id NOT LIKE '\$\{SOAK_USER_PREFIX\}%'/,
    'the synthetic-org check must not use the retired user_id-prefix predicate (ids are UUIDs now)',
  )
  assert.ok(
    slices.seed.includes('foreign posture history'),
    'seed must refuse an org carrying a posture row not written by this soakʼs own seed actor',
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
  // Per-org walk identity (real-dispatch 31953379181 defect): every word of a `local`
  // simple command expands BEFORE the builtin assigns, so `local org="$1" org8="${org:0:8}"`
  // derived org8 from the CALLER's `org` (the seeding loop's local, left at org3) — org2's
  // walk ran against the right org but its label, artifact filenames, and the manifest's
  // syntheticOrgRef suffix all said org3, and org2's plan/apply JSONs were overwritten.
  // Pin the fixed two-statement shape and forbid the rejoined form.
  assert.ok(
    slices.seed.includes('  local org="$1"\n  local org8="${org:0:8}"'),
    'the W4 walk must assign `org` and derive `org8` in TWO separate local statements (same-statement self-reference reads the CALLERʼs org — dispatch 31953379181)',
  )
  assert.doesNotMatch(
    slices.seed,
    // Statement-anchored (multiline): the fix's own explanatory COMMENT legitimately quotes
    // the buggy spelling; only a real `local ...` statement at line start may not.
    /^\s*local org="\$1" org8=/m,
    'the W4 walk must never rejoin org/org8 into one local statement (org8 would expand against the callerʼs org)',
  )
  // ...and every CLI walk invocation must target the function-local loop arg, never a
  // SOAK_ORG* literal reached past it.
  assert.doesNotMatch(
    slices.seed,
    /--org "\$SOAK_ORG/,
    'walk CLI invocations must use the function-local $org, never a SOAK_ORG* literal',
  )

  // soak-flags: baseline-marker order gate BEFORE the override write; atomic
  // candidate->validate->rename via the SAME persistent override; backend-only recreate
  // with postgres/redis/web container-id assertions; exact env verification + health.
  const markerGateIdx = slices.flags.indexOf('[[ -f "$SOAK_BASELINE_MARKER" ]]')
  const overrideTmpIdx = slices.flags.indexOf('mktemp "${RUNNER_PERSIST_DIR}/.soak-override.XXXXXX"')
  const flagsValidateIdx = slices.flags.indexOf('-f "$soak_override_tmp" config')
  const flagsRenameIdx = slices.flags.indexOf('mv -f "$soak_override_tmp" "$OVERRIDE_FILE"')
  assert.notEqual(markerGateIdx, -1, 'soak-flags must gate on the soak-baseline marker (baseline BEFORE flags)')
  // P2-2: the marker gate must be SHA-scoped — a stale-build marker (mid-soak redeploy) must
  // not satisfy it, or every later O4-2 "+5% vs baseline" anchors to the wrong image.
  assert.match(
    slices.flags,
    /\[\[ "\$marker_sha" == "\$DEPLOY_SHA" \]\]/,
    'soak-flags must compare the baseline markerʼs staging_build_commit to DEPLOY_SHA',
  )
  assert.ok(
    slices.flags.includes('re-run action=soak-baseline against the deployed SHA'),
    'soak-flags must refuse a baseline captured on a different build (O4-2 same-SHA anchor)',
  )
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
  // P2-4: the live-allowlist COVERAGE guard (config orgs must be inside the live allowlists,
  // else load silently no-ops) — deleting both loops previously left 35/35 green.
  assert.ok(
    slices.run.includes('is NOT in the live W4 allowlist'),
    'soak-run must fail closed when a config org is outside the live W4 allowlist',
  )
  assert.ok(
    slices.run.includes('is NOT in the live W7 allowlist'),
    'soak-run must fail closed when a both-machines config org is outside the live W7 allowlist',
  )
  // P3-2/P3-3 (revised for the pair cadence): a single soak-run is one DAILY BATCH capped
  // at total_users x 2, so targets_met/daily_capacity_exhausted stay reachable inside the
  // job timeout. The 2/user/day cap is LOAD-BEARING: same-day session packing (the old
  // 8/day row) floods §4.2-critical review_required diffs (soak-status 31962440160), and
  // backdated acceleration is rejected by the routeʼs global-latest punch ordering
  // (#4932 gate P1-1) — the honest accelerator is users_per_org at seed time.
  assert.ok(
    slices.run.includes("one-day clean-punch capacity"),
    'soak-run must cap punch_target at the configʼs one-day capacity (total_users x 2)',
  )
  assert.ok(
    slices.run.includes('day_capacity=$(( total_users * 2 ))'),
    'the one-day capacity must be total_users x 2 (one in/out pair per user per wall-day)',
  )
  assert.ok(slices.run.includes('--rate-limit-per-sec 1'), 'soak-run must pin the ruled <=1 req/sec global ceiling')
  assert.ok(
    slices.run.includes('--punches-per-user-per-day 2'),
    'soak-run must pin the 2 punches/user/day pair cadence (8/day floods critical review_required diffs)',
  )
  assert.doesNotMatch(
    slices.run,
    /--punches-per-user-per-day 8/,
    'the retired 8/day session-packing quota must not come back',
  )
  // Gate round-2 P2-1: the generatorʼs daily cap is per-process, so the runner must refuse
  // a second batch inside the same org-calendar day (marker written BEFORE the generator
  // runs — a partial batch already punched some users) with an explicit override only.
  assert.ok(
    slices.seed.includes('"dailyCapTimezone": tz,'),
    'soak-seed must write each entryʼs org cap timezone into the config',
  )
  assert.ok(
    slices.run.includes('soak-run-last-batch-day'),
    'soak-run must track the last batch day host-side',
  )
  assert.ok(
    slices.run.includes('is missing orgId/dailyCapTimezone'),
    'the guard must refuse a config without orgId/dailyCapTimezone (stale-config silent revert)',
  )
  assert.doesNotMatch(
    slices.run,
    /\.get\("dailyCapTimezone"/,
    'no .get on dailyCapTimezone may exist in the run slice at all — subscript access is the by-construction fail-closed shape, and any .get re-introduction is the silent-revert channel (#4933 gate P2-1: an `or "UTC"` fallback slipped past the narrowed form)',
  )
  assert.ok(
    slices.run.includes('allow_same_day_rerun'),
    'the same-day guard must have exactly the explicit override, never a silent bypass',
  )
  // Codex post-merge P1: the marker is a PER-ORG closed set and the batch refuses WHOLE if
  // ANY org already ran on its own local day — a first-entry-only derivation would admit a
  // second batch the moment org1 crossed midnight while org2/org3 had not.
  assert.ok(
    slices.run.includes('soak_batch_guard_check() {'),
    'the per-org same-day guard function must exist',
  )
  // Codex r2 P1: the marker must be a CLOSED SET — exact (orgId,timezone) equality with the
  // config, no duplicates — and the stamp must write atomically (temp + rename), so a
  // half-written marker can neither be observed nor silently admit its missing orgs.
  assert.ok(
    slices.run.includes("does not carry EXACTLY the config's (orgId, timezone) set"),
    'the guard must refuse a marker whose org set differs from the config (a subset admits the missing orgs)',
  )
  assert.ok(
    slices.run.includes('carries duplicate org lines'),
    'the guard must refuse a marker with duplicate org lines',
  )
  assert.match(
    slices.run,
    /tmp="\$\{marker\}\.tmp\.\$\$"[\s\S]{0,600}?mv -f "\$tmp" "\$marker"/,
    'the stamp must write the full set to a temp file and rename it into place (atomic)',
  )
  assert.ok(
    slices.run.includes('if (( clean > attempts )); then'),
    'the classifier must WARN on a contradictory tally (clean > attempts opens the ok path via negative subtraction)',
  )
  assert.match(
    slices.run,
    /while IFS=\$'\\t' read -r org tz; do\n\s+today="\$\(TZ="\$tz" date \+%Y-%m-%d\)"/,
    'the guard must derive TODAY per org from that orgʼs own timezone (never entries[0] alone)',
  )
  assert.doesNotMatch(
    slices.run,
    /entries"\]\[0\]\["dailyCapTimezone"\]/,
    'no first-entry-only timezone derivation may remain in the batch guard path',
  )
  const guardIdx = slices.run.indexOf('soak_batch_guard_check "$config_path" "$batch_marker"')
  const markerWriteIdx = slices.run.indexOf('soak_batch_guard_stamp "$config_path" "$batch_marker"')
  const generatorRunIdx = slices.run.indexOf('--punches-per-user-per-day 2')
  assert.ok(guardIdx !== -1 && markerWriteIdx !== -1, 'the same-day guard check and per-org stamp must exist')
  assert.ok(
    guardIdx < markerWriteIdx && markerWriteIdx < generatorRunIdx,
    'the guard must run before the stamp, and the stamp must land BEFORE the generator runs',
  )
  // Gate round-2 P2-3 + Codex post-merge P2: ONE classifier decides the batch result — ok
  // requires a clean halt AND zero incidents AND target reached; capacity exhaustion alone
  // proves nothing (dailyCounts increments on every ATTEMPT).
  assert.ok(
    slices.run.includes('soak_run_classify() {'),
    'the halt classifier function must exist',
  )
  assert.match(
    slices.run,
    /targets_met\|daily_capacity_exhausted\)\n\s+if \(\( incidents > 0 \)\); then echo "WARN"/,
    'a clean-halt batch with ANY incidents must classify WARN, never ok',
  )
  assert.ok(
    slices.run.includes('max_consecutive_incidents) echo "FAIL"'),
    'the incident halt must classify FAIL',
  )
  assert.ok(
    slices.run.includes('*) echo "WARN"'),
    'every other halt reason (stall, duration, safety cap) must classify WARN, never ok',
  )
  assert.ok(
    slices.run.includes('echo "result=$(soak_run_classify "$halted" "$total_clean" "$total_attempts" "$punch_target")"'),
    'the summary result line must come from the classifier, never an inline case',
  )
  assert.ok(
    slices.run.includes('--confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY'),
    'soak-run must carry the generatorʼs exact execute confirmation token',
  )
  assert.ok(slices.run.includes('--confirm-org-ids'), 'soak-run must pass the org-set confirmation (set-equality guard)')
  assert.match(remote, /SOAK_GENERATOR_SCRIPT="attendance-w4w7-soak-load-generator\.mjs"/, 'the committed generator must be the one executed')
  // NIT-1 strengthened: not a single-spelling match — forbid any COPY-family line (cp / mv /
  // scp / install) whose text pairs the token-bearing $run_config_host with an OUTPUT_DIR
  // target, so a differently spelled `cp "$run_config_host" "${OUTPUT_DIR}/x"` cannot evade
  // it. (The benign login line tees the login LOG — ids + ok/fail only — to OUTPUT_DIR and
  // merely PASSES $run_config_host as a python arg, so it carries no copy verb and is allowed.)
  for (const line of slices.run.split('\n')) {
    if (/\brun_config_host\b/.test(line) && /\b(cp|mv|scp|install)\b/.test(line) && /OUTPUT_DIR/.test(line)) {
      assert.fail(`the token-bearing run config must never be copied into OUTPUT_DIR: ${line.trim()}`)
    }
  }
  // And it must never be redirected into OUTPUT_DIR either.
  assert.doesNotMatch(
    slices.run,
    /run_config_host[^\n]*>\s*"?\$\{?OUTPUT_DIR/,
    'the token-bearing run config must never be redirected into the uploaded artifact dir',
  )
  assert.ok(slices.run.includes('cleanup_soak_run'), 'soak-run must delete the token-bearing temp config (trap cleanup)')
  assert.ok(slices.run.includes('max_consecutive_incidents'), 'soak-run must fail on the consecutive-incident halt (alert-class)')
  // Dispatch 31953571638: five punch 500s with zero server-side evidence in the artifact —
  // the backend-log slice (same filtered_pipe contract as action_smoke) is what makes a
  // server-side punch failure diagnosable from the runʼs own artifact.
  assert.ok(
    slices.run.includes('soak-run-backend-log-slice.log'),
    'soak-run must capture a filtered backend-log slice into the artifact',
  )
  assert.match(
    slices.run,
    /filtered_pipe "\$\{OUTPUT_DIR\}\/soak-run-backend-log-slice\.log"/,
    'the backend-log slice must go through filtered_pipe (producer failure must fail the step; zero matches must not)',
  )
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
  // Post-merge review P1: the W4-side operations join is STRUCTURALLY EMPTY for a
  // legacy_only org, so C1/C2/C3 evidence must reach the control arm through its own
  // regime — completed pair days from the legacy tables — and Q3's universe must be the
  // config CLOSED SET (a posture-table-derived universe can never show a pure-legacy org).
  assert.ok(slices.status.includes('[Q2b]'), 'the legacy-control byte-neutrality read must exist')
  assert.ok(
    slices.status.includes('Q2b_legacy_control_w4_rows'),
    'a legacy-postured config org with ANY W4 calc/operation row must raise a mechanical alert',
  )
  const q1Idx = slices.status.indexOf('[Q1]_clean_punch_total_cumulative')
  // #4975 gate P2-3: the slice ends at the NEXT Q-label, never at a redirection token — a
  // dropped `>/dev/null` widened the old slice across [Q2] and satisfied Q1's regexes
  // vacuously while the suite stayed green.
  const q1Sql = slices.status.slice(q1Idx, slices.status.indexOf('[Q2]', q1Idx))
  assert.match(
    q1Sql,
    /\+ \(SELECT count\(\*\) FROM attendance_records r WHERE r\.org_id IN/,
    '[Q1] must ADD the legacy-regime completed-pair count — the operations join alone cannot see the control org',
  )
  assert.match(
    q1Sql,
    /NOT EXISTS \(SELECT 1 FROM attendance_calculation_rollout_state s WHERE s\.org_id = r\.org_id AND s\.state <> 'legacy'\)/,
    'the legacy-side count must scope to legacy-postured orgs only (a W4-shadow orgʼs legacy rows would double count)',
  )
  assert.match(
    q1Sql,
    /r\.first_in_at IS NOT NULL AND r\.last_out_at IS NOT NULL/,
    'the legacy clean unit is the COMPLETED PAIR DAY — mirroring the W4 sideʼs converged unit',
  )
  const q2Idx = slices.status.indexOf('[Q2] per-org clean punches')
  const q2Sql = slices.status.slice(q2Idx, slices.status.indexOf('[Q3]', q2Idx))
  assert.match(q2Sql, /UNION ALL/, '[Q2] must union both regimes so every config org can appear')
  // #4975 gate P2-1: [Q2] must be closed-set LEFT JOINed so a zero-count config org still
  // appears as a row (omit-on-zero hid exactly the org the criteria need to see).
  assert.match(
    q2Sql,
    /FROM \(VALUES \('\$\{SOAK_ORG1\}'\),\('\$\{SOAK_ORG2\}'\),\('\$\{SOAK_ORG3\}'\)\) AS target\(org_id\) LEFT JOIN/,
    '[Q2] must LEFT JOIN the config closed set — every config org appears even at zero',
  )
  assert.match(
    q2Sql,
    /UNION ALL SELECT r\.org_id, count\(\*\) FROM attendance_records r/,
    '[Q2]ʼs legacy branch must COUNT real rows, never a constant',
  )
  // #4975 gate P2-4: the legacy addendʼs WINDOW scope is load-bearing (an unscoped count
  // would import pre-window history into C1/C2).
  assert.match(
    q1Sql,
    /r\.created_at >= '\$\{window_start\}'::timestamptz AND r\.created_at < now\(\)/,
    'the legacy addend must be window-scoped',
  )
  // #4975 gate P1: Q2b must count calc rows plus only NON-legacy-posture operations — a
  // legacy_projection_only op row is the RULED ledger of a legacy write, not contamination
  // (the gate reproduced 60 such rows on the control org; the naive form would hard-fail
  // every future soak-status on correct behavior).
  assert.ok(
    slices.status.includes("COALESCE(accepted_write_posture, '') <> 'legacy_projection_only'"),
    'Q2b must exclude the ruled legacy_projection_only operation ledger from the contamination count',
  )
  assert.ok(
    slices.status.includes('[Q3b]_posture_constancy_violations'),
    'the posture-constancy guard must exist (a rollback or out-of-plan posture voids the dual-regime counters)',
  )
  assert.match(
    slices.status,
    /state NOT IN \('legacy','shadow'\) OR \(state = 'legacy' AND prior_state IS NOT NULL\)/,
    'Q3b must catch BOTH the rolled-back shape and out-of-plan states',
  )
  assert.ok(
    slices.status.includes('alerts+=("Q3b_posture_constancy_violations'),
    'a posture-constancy violation must raise a mechanical alert',
  )
  assert.match(
    slices.status,
    /FROM \(VALUES \('\$\{SOAK_ORG1\}'\),\('\$\{SOAK_ORG2\}'\),\('\$\{SOAK_ORG3\}'\)\) AS target\(org_id\) LEFT JOIN attendance_calculation_rollout_state w4/,
    '[Q3] universe must be the config closed set — a posture-derived universe structurally omits the legacy control org',
  )
  assert.ok(slices.status.includes("'group_effective'"), 'W7-2 counters must scope on the selector discriminator')

  // P1-1 signature guard: a W7 group-shadow comparison row carries operation_id IS NULL BY
  // DESIGN, so a [Q4b] spelling that joins attendance_result_operations while filtering
  // selector='group_effective' is structurally zero forever — the exact bug. Extract the Q4b
  // region and forbid that conjunction; require the marker-operationId count instead.
  const q4bStart = slices.status.indexOf('[Q4b]_w7_group_arm_clean_punches_cumulative')
  assert.notEqual(q4bStart, -1, 'soak-status must run the [Q4b] W7 group-arm count')
  const q4bAfter = slices.status.indexOf('soak_status_', q4bStart + 1)
  const q4bRegion = slices.status.slice(q4bStart, q4bAfter === -1 ? undefined : q4bAfter)
  // Signature guard FIRST (it is the exact bug): the join is what makes C4 read zero forever.
  assert.doesNotMatch(
    q4bRegion,
    /attendance_result_operations/,
    '[Q4b] must NOT join attendance_result_operations — comparison rows have operation_id IS NULL (chk_arc_operation_id marker disjunct), so that join is identically empty and C4 would read zero forever',
  )
  assert.match(
    q4bRegion,
    /selector'\)? = 'group_effective'/,
    '[Q4b] must be selector-scoped to the group arm',
  )
  assert.ok(
    q4bRegion.includes("input_provenance -> 'w7GroupShadowCompare' ->> 'operationId'"),
    '[Q4b] must count the producing operationId out of the w7GroupShadowCompare marker (w7-compare-window-status.ts:189-196)',
  )
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

test('EXECUTABLE: bash expands a whole `local` statement before assigning — the org2-walk misattribution class (dispatch 31953379181) — and the split form fixes it', () => {
  // Runs REAL bash (the same invocation shape as the workflow's remote command), not a
  // paraphrase: the JOINED form must leak the callerʼs `org` into org8 (the defect — this
  // half is the positive control proving the probe discriminates), and the SPLIT form the
  // remote script now uses must derive org8 from the function argument.
  const probe = [
    'set -euo pipefail',
    'joined() { local org="$1" org8="${org:0:8}"; echo "joined=$org8"; }',
    'split() { local org="$1"; local org8="${org:0:8}"; echo "split=$org8"; }',
    'caller() { local org="33333333-caller-org"; joined "22222222-arg-org"; split "22222222-arg-org"; }',
    'caller',
  ].join('\n')
  const result = runPipefailBash(probe)
  assert.equal(result.status, 0, `probe must run; stderr: ${result.stderr}`)
  assert.match(
    result.stdout,
    /joined=33333333/,
    'positive control: the joined form must expand org8 against the CALLERʼs org (the defect) — if this stops leaking, bash semantics changed and the pin should be re-examined',
  )
  assert.match(
    result.stdout,
    /split=22222222/,
    'the split form (what the remote script uses) must derive org8 from the function argument',
  )
})

test('MUTATION: rejoining the W4 walkʼs org/org8 into one local statement turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const fixed = '  local org="$1"\n  local org8="${org:0:8}"'
  assert.ok(original.includes(fixed), 'mutation anchor must hit the fixed split shape')
  const mutated = original.replace(fixed, '  local org="$1" org8="${org:0:8}"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /TWO separate local statements|never rejoin org\/org8/,
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

test('MUTATION (legacy control): dropping the legacy-regime addend from [Q1] turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = "+ (SELECT count(*) FROM attendance_records r WHERE r.org_id IN"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the legacy addend')
  const mutated = original.replace(anchor, "+ (SELECT 0 WHERE 'x' IN")
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /operations join alone cannot see the control org/,
  )
})

test('MUTATION (legacy control): reverting [Q3] to the posture-derived universe turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  // Anchor includes Q3's own LEFT JOIN target so it cannot hit [Q2]'s closed-set join.
  const anchor = "FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id) LEFT JOIN attendance_calculation_rollout_state w4"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the Q3 closed-set universe')
  const mutated = original.replace(
    anchor,
    'FROM (SELECT DISTINCT org_id FROM attendance_calculation_rollout_state UNION SELECT DISTINCT org_id FROM attendance_calculation_context_source_state) target LEFT JOIN attendance_calculation_rollout_state w4',
  )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /structurally omits the legacy control org/,
  )
})

test('MUTATION (legacy control): deleting the Q2b byte-neutrality alert turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = 'alerts+=("Q2b_legacy_control_w4_rows_'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the Q2b alert push')
  const mutated = original.replace(anchor, 'true # ("Q2b_note_')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /must raise a mechanical alert/,
  )
})

test('MUTATION (P1-1): reverting [Q4b] to the attendance_result_operations join turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  // The pre-fix spelling: join operations, filter selector='group_effective'. The producing
  // rows carry operation_id IS NULL, so this counts 0 forever — the exact defect.
  const fixed = "SELECT count(DISTINCT (c.input_provenance -> 'w7GroupShadowCompare' ->> 'operationId')) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.created_at >= '${window_start}'::timestamptz AND c.created_at < now() AND c.mode = 'shadow' AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') = 'group_effective' AND c.outcome = 'completed' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal');"
  const reverted = "SELECT count(DISTINCT op.operation_id) FROM attendance_result_operations op JOIN attendance_record_calculations c ON c.org_id = op.org_id AND c.operation_id = op.operation_id WHERE op.entrypoint = 'live_punch' AND op.state = 'completed' AND op.created_at >= '${window_start}'::timestamptz AND op.created_at < now() AND c.calculation_kind = 'calculation' AND c.outcome = 'completed' AND c.mode = 'shadow' AND c.context_snapshot ->> 'selector' = 'group_effective' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal');"
  assert.ok(original.includes(fixed), 'mutation anchor must hit the fixed [Q4b] query')
  const mutated = original.replace(fixed, reverted)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /must NOT join attendance_result_operations/,
  )
})

test('MUTATION (P2-2): deleting the baseline-marker SHA comparison turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const guard = '  [[ "$marker_sha" == "$DEPLOY_SHA" ]] \\\n'
  assert.ok(original.includes(guard), 'mutation anchor must hit the SHA-scope guard')
  const mutated = original.replace(guard, '  [[ -n "$marker_sha" ]] \\\n')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /compare the baseline markerʼs staging_build_commit to DEPLOY_SHA/,
  )
})

test('MUTATION (identity-gate): reverting the users INSERT to prefix-composed TEXT ids turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  // The retired shape — the exact defect staging run 31957449480 proved: a TEXT family id
  // 500s (W4C0_USER_ID_INVALID) on every punch once its org enters W4 shadow.
  const minted = 'SELECT gen_random_uuid()::text,\n'
  assert.ok(original.includes(minted), 'mutation anchor must hit the minted-UUID id expression')
  const mutated = original.replace(minted, "SELECT :'user_prefix' || lpad(i::text, 2, '0'),\n")
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /minted UUIDs/,
  )
})

test('MUTATION (identity-gate): a remint DELETE on the canonical calculations table turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const recordsDelete = "DELETE FROM attendance_records WHERE user_id LIKE :'retired_prefix';"
  assert.ok(original.includes(recordsDelete), 'mutation anchor must hit the remint records delete')
  const mutated = original.replace(
    recordsDelete,
    "DELETE FROM attendance_record_calculations c USING attendance_records r WHERE c.attendance_record_id = r.id AND r.user_id LIKE :'retired_prefix';\n" + recordsDelete,
  )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /canonical-writer-only calculations table/,
  )
})

test('MUTATION (identity-gate): reverting the synthetic-org check to the retired user_id-prefix predicate turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const antiJoin = "SELECT count(*) FROM user_orgs uo WHERE uo.org_id = '${org}' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uo.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%')"
  assert.ok(original.includes(antiJoin), 'mutation anchor must hit the username anti-join preflight')
  const mutated = original.replace(
    antiJoin,
    "SELECT count(*) FROM user_orgs WHERE org_id = '${org}' AND user_id NOT LIKE '${SOAK_USER_PREFIX}%'",
  )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /username anti-join|retired user_id-prefix predicate/,
  )
})

test('MUTATION (identity-gate): swapping the remint delete order (users before dependents) turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const recordsDelete = "DELETE FROM attendance_records WHERE user_id LIKE :'retired_prefix';"
  const usersDelete = "DELETE FROM users WHERE id LIKE :'retired_prefix';"
  assert.ok(original.includes(recordsDelete) && original.includes(usersDelete), 'mutation anchors must hit both remint deletes')
  const SWAP = '__SOAK_REMINT_SWAP_SENTINEL__'
  const mutated = original.replace(recordsDelete, SWAP).replace(usersDelete, recordsDelete).replace(SWAP, usersDelete)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /dependents before the users rows/,
  )
})

test('MUTATION (gate C9): unscoping the remint retired_prefix to "%" turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const scoped = '-v retired_prefix="${SOAK_USER_PREFIX}%"'
  assert.ok(original.includes(scoped), 'mutation anchor must hit the scoped retired_prefix flag')
  const mutated = original.replace(scoped, '-v retired_prefix="%"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /closed family prefix \+ trailing %/,
  )
})

test('MUTATION (gate C2ʹ): weakening the canonical-bucket guard to a non-empty test turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const guard = '[[ "$retired_calc" == "0" ]]'
  assert.ok(original.includes(guard), 'mutation anchor must hit the exact-zero guard')
  const mutated = original.replace(guard, '[[ -n "$retired_calc" ]]')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /compare the count to exact zero/,
  )
})

test('MUTATION (gate C3): dropping the remint user_orgs delete turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const line = "DELETE FROM user_orgs WHERE user_id LIKE :'retired_prefix';\n"
  assert.ok(original.includes(line), 'mutation anchor must hit the user_orgs delete')
  const mutated = original.replace(line, '')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /exactly these seven tables/,
  )
})

test('MUTATION (gate C6): stripping BEGIN/COMMIT from the remint SQL turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const remintAnchor = "log \"soak-seed: reminting ${retired}"
  assert.ok(original.includes(remintAnchor), 'mutation anchor must hit the remint block')
  const heredocStart = original.indexOf('cat > "$remint_sql"')
  const heredocEnd = original.indexOf('< "$remint_sql"')
  assert.ok(heredocStart !== -1 && heredocEnd > heredocStart, 'remint heredoc bounds must resolve')
  const heredoc = original.slice(heredocStart, heredocEnd)
  const mutatedHeredoc = heredoc.replace('\nBEGIN;\n', '\n').replace('\nCOMMIT;\n', '\n')
  assert.notEqual(mutatedHeredoc, heredoc, 'mutation must change the heredoc')
  const mutated = original.slice(0, heredocStart) + mutatedHeredoc + original.slice(heredocEnd)
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /open and commit a transaction/,
  )
})

test('MUTATION (gate C12): deleting the credential UPDATEʼs WHERE turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const where = "\n WHERE username LIKE :'user_prefix' || '%';"
  assert.ok(original.includes(where), 'mutation anchor must hit the credential-UPDATE WHERE')
  const mutated = original.replace(where, ';')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /prefix-scoped to synthetic usernames|sanctioned username\/email forms/,
  )
})

test('MUTATION (exact-set): a rogue prefix-composed user_id projection in the seed SQL turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  // Continuation-line dodge from the #4931 gate: a bare composed value on its own line,
  // no SELECT/.username on the line — the retired negative regex never saw it.
  const anchor = "INSERT INTO user_orgs (user_id, org_id, is_active)\nSELECT u.id, :'org', true\n"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the user_orgs insert head')
  const mutated = original.replace(
    anchor,
    "INSERT INTO user_orgs (user_id, org_id, is_active)\nSELECT\n  :'user_prefix' || lpad(i::text, 2, '0'), :'org', true\n",
  )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /sanctioned username\/email forms/,
  )
})

test('MUTATION (P2-4): deleting the soak-run live-allowlist coverage loops turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const w4Loop = 'config org ${org} is NOT in the live W4 allowlist'
  const w7Loop = 'both-machines config org ${org} is NOT in the live W7 allowlist'
  assert.ok(slices.run.includes(w4Loop) && slices.run.includes(w7Loop), 'mutation anchors must hit the run slice')
  const mutatedRun = slices.run
    .replace(w4Loop, 'DELETED_W4_COVERAGE_MESSAGE')
    .replace(w7Loop, 'DELETED_W7_COVERAGE_MESSAGE')
  // Replacement-FUNCTION form: the run slice now contains bash `$'` sequences, which
  // String.replace treats as special replacement patterns and silently corrupts the file.
  const mutated = original.replace(slices.run, () => mutatedRun)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /fail closed when a config org is outside the live W[47] allowlist/,
  )
})

// --- P2-1 executable negative controls: the workflow input-validation block must REJECT a
// newline-injection payload (the here-string `read` validators only inspect line 1; a newline
// slips the tail past them and into the single-quoted remote prelude). These EXECUTE the real
// workflow validation `run:` block, not a paraphrase of it.
function extractWorkflowRunBlock(workflow, stepName) {
  const stepIdx = workflow.indexOf(`- name: ${stepName}`)
  assert.notEqual(stepIdx, -1, `expected workflow step: ${stepName}`)
  const runIdx = workflow.indexOf('run: |', stepIdx)
  assert.notEqual(runIdx, -1, `expected a run: | block in step ${stepName}`)
  const body = workflow.slice(workflow.indexOf('\n', runIdx) + 1)
  const out = []
  for (const line of body.split('\n')) {
    if (line.trim() === '') { out.push(''); continue }
    if (/^ {0,8}\S/.test(line)) break // a line indented <=8 spaces ends the 10-space run body
    out.push(line.replace(/^ {10}/, ''))
  }
  return out.join('\n')
}

function runWorkflowValidation(env) {
  const block = extractWorkflowRunBlock(readFileSync(WORKFLOW, 'utf8'), 'Validate inputs and embedded scripts')
  const repoRoot = join(HERE, '..', '..')
  return spawnSync('bash', ['-c', block], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ACTION: env.ACTION, SOAK_ORGS: env.SOAK_ORGS ?? '', SOAK_OPTS: env.SOAK_OPTS ?? '', DEPLOY_SHA: '', SET_WINDOW_ENV: 'none', FORCE_RECREATE: 'false', STAMPS: '', PATH: process.env.PATH },
  })
}

const THREE_UUIDS = '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333'
const INJECT = "\n'; touch /tmp/PWNED_soak_test; echo '"

test('P2-1 negative control: a benign single-line soak-seed input PASSES workflow validation (harness discriminates)', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'owner_ref=ownerX;entrypoint_inventory_ref=invY;users_per_org=10' })
  assert.equal(r.status, 0, `benign input must pass validation; stderr: ${r.stderr}`)
})

test('P2-1: a newline-injection payload in soak_orgs is REJECTED by workflow validation', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS + INJECT, SOAK_OPTS: '' })
  assert.equal(r.status, 2, `newline in soak_orgs must be rejected (exit 2); got ${r.status}, stderr: ${r.stderr}`)
  assert.match(r.stderr, /single-line/, 'rejection must name the single-line rule')
})

test('P2-1: a newline-injection payload in soak_opts is REJECTED by workflow validation', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'punch_target=200' + INJECT })
  assert.equal(r.status, 2, `newline in soak_opts must be rejected (exit 2); got ${r.status}, stderr: ${r.stderr}`)
  assert.match(r.stderr, /single-line/, 'rejection must name the single-line rule')
})

/**
 * Generator cadence contract — ONE assertion body shared by the source test AND its
 * mutation legs (#4932 gate P2-2: legs that re-check a pin by hand instead of calling the
 * pinned assertion are tautologies — deleting the pin left both legs green).
 */
function assertGeneratorCadenceContract(generator) {
  assert.ok(
    generator.includes("'SOAK_PUNCHES_PER_USER_PER_DAY', 2)"),
    'the generator default must be 2 punches/user/day — one in/out pair per user per wall-day (8/day session packing floods §4.2-critical review_required diffs, soak-status 31962440160)',
  )
  assert.ok(
    generator.includes("haltedReason = 'daily_capacity_exhausted'"),
    'the scheduler must end a daily batch cleanly when every user is day-capped or org-satisfied, never idle to the stall timeout',
  )
  // Server-clock pin bound to the CODE, not a comment (#4932 gate round-2 P2-2: the earlier
  // comment-string pin stayed green when occurredAt was re-introduced mid-object): extract
  // the actual `const body = {...}` construction, STRIP comment lines, and assert the
  // remaining code never mentions occurredAt in any spelling.
  const bodyStart = generator.indexOf('const body = {')
  assert.ok(bodyStart !== -1, 'the punch body construction must exist')
  const bodyEnd = generator.indexOf('\n  }', bodyStart)
  assert.ok(bodyEnd > bodyStart, 'the punch body construction must close')
  const bodyCode = generator
    .slice(bodyStart, bodyEnd)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.doesNotMatch(
    bodyCode,
    /occurredAt/,
    'the punch body CODE must not carry occurredAt in any form — server clock only (backdating is rejected by enforcePunchConstraintsʼ global-latest ordering, #4932 gate P1-1)',
  )
  assert.doesNotMatch(
    generator,
    /body\.occurredAt/,
    'no post-construction assignment may sneak occurredAt into the punch body',
  )
  // P2-1: the 2/day cap must count against the ORGʼS calendar day (per-entry
  // dailyCapTimezone), and every daily-count site must resolve it via the one helper.
  assert.ok(
    generator.includes('function capTimezoneFor(entry, config)'),
    'the per-entry cap-timezone resolver must exist',
  )
  // Round-3 P2-R3-1: REQUIRED, fail-closed — an optional field lets any stale config
  // silently revert the cap (and the runner guard) to UTC days.
  assert.ok(
    generator.includes('.dailyCapTimezone is required'),
    'dailyCapTimezone must be REQUIRED — a stale config must refuse, never silently revert to UTC days',
  )
  assert.doesNotMatch(
    generator,
    /entry\.dailyCapTimezone \|\|/,
    'the cap-timezone resolver must have no fallback (a fallback is the silent-revert channel)',
  )
  assert.equal(
    (generator.match(/capTimezoneFor\((?:candidate|picked|u)\.entry, config\)/g) || []).length,
    3,
    'all three daily-count sites (eligibility scan, all-capped halt, count increment) must key the day on the entryʼs cap timezone',
  )
}

test('MUTATION (closed set): deleting the set-equality refusal turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = "does not carry EXACTLY the config's (orgId, timezone) set"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the set-equality refusal')
  const mutated = original.replace(anchor, 'set note (informational)')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /subset admits the missing orgs/,
  )
})

test('MUTATION (atomic stamp): reverting to a truncate-then-append writer turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = '  mv -f "$tmp" "$marker"'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the rename')
  const mutated = original.replace(anchor, '  cat "$tmp" > "$marker"; rm -f "$tmp"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rename it into place/,
  )
})

test('MUTATION (tally sanity): deleting the clean>attempts guard turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = 'if (( clean > attempts )); then'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the sanity guard')
  const mutated = original.replace(anchor, 'if (( clean > attempts + 999999 )); then')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /contradictory tally/,
  )
})

test('soak generator: pair-cadence contract (2/day default, daily-batch clean halt, server clock only)', () => {
  assertGeneratorCadenceContract(readFileSync(GENERATOR, 'utf8'))
})

test('MUTATION (cadence): restoring the 8/day default turns the cadence contract red', () => {
  const original = readFileSync(GENERATOR, 'utf8')
  const anchor = "'SOAK_PUNCHES_PER_USER_PER_DAY', 2)"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the daily-cap default')
  const mutated = original.replace(anchor, "'SOAK_PUNCHES_PER_USER_PER_DAY', 8)")
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(() => assertGeneratorCadenceContract(mutated), /2 punches\/user\/day/)
})

test('MUTATION (cadence): deleting the daily-batch clean halt turns the cadence contract red', () => {
  const original = readFileSync(GENERATOR, 'utf8')
  const anchor = "haltedReason = 'daily_capacity_exhausted'"
  assert.ok(original.includes(anchor), 'mutation anchor must hit the clean-halt assignment')
  const mutated = original.replace(anchor, "void 0")
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(() => assertGeneratorCadenceContract(mutated), /daily batch cleanly/)
})

test('MUTATION (cadence): re-introducing occurredAt into the punch body mid-object turns the cadence contract red', () => {
  const original = readFileSync(GENERATOR, 'utf8')
  // The exact green-while-mutated shape the round-2 gate demonstrated: occurredAt inserted
  // MID-object, comment left in place.
  const anchor = 'operationId, // idempotency key — same value reused across the retries below'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the body construction')
  const mutated = original.replace(anchor, `${anchor}\n    occurredAt: new Date().toISOString(),`)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(() => assertGeneratorCadenceContract(mutated), /server clock only/)
})

test('MUTATION (cadence): re-keying a daily-count site off the entry cap timezone turns the cadence contract red', () => {
  const original = readFileSync(GENERATOR, 'utf8')
  const anchor = 'capTimezoneFor(picked.entry, config)'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the count-increment site')
  const mutated = original.replace(anchor, 'config.timezone')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(() => assertGeneratorCadenceContract(mutated), /cap timezone/)
})

test('MUTATION (cadence): reverting the runner to the 8/day invocation turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = '--punches-per-user-per-day 2'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the runner invocation flag')
  const mutated = original.replace(anchor, '--punches-per-user-per-day 8')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /pair cadence|8\/day session-packing/,
  )
})

test('MUTATION (same-day guard): removing the guard-check call turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = 'soak_batch_guard_check "$config_path" "$batch_marker"'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the guard-check call')
  const mutated = original.replace(anchor, 'true # guard skipped')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /guard check and per-org stamp must exist|guard must run before the stamp/,
  )
})

test('MUTATION (same-day guard): reverting to a first-entry-only timezone derivation turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  // The Codex P1 shape: derive one global day from entries[0] instead of per-org days.
  const anchor = '  while IFS=$\'\\t\' read -r org tz; do\n    today="$(TZ="$tz" date +%Y-%m-%d)"'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the per-org day loop')
  const mutated = original.replace(
    anchor,
    () => '  tz="$(soak_batch_guard_entries "$config_path" | head -1 | cut -f2)"\n  today="$(TZ="$tz" date +%Y-%m-%d)"\n  while IFS=$\'\\t\' read -r org _ignored_tz; do',
  )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /orgʼs own timezone/,
  )
})

test('MUTATION (halt classes): letting an incident-bearing clean halt classify ok turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = 'if (( incidents > 0 )); then echo "WARN"'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the incidents branch')
  const mutated = original.replace(anchor, 'if (( incidents > 999999 )); then echo "WARN"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /ANY incidents must classify WARN/,
  )
})

test('MUTATION (halt classes): letting a stall halt classify ok turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = '*) echo "WARN"'
  assert.ok(original.includes(anchor), 'mutation anchor must hit the WARN default case')
  const mutated = original.replace(anchor, '*) echo "ok"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /classify WARN, never ok/,
  )
})

/**
 * EXECUTABLE legs — extract the REAL guard/classifier functions from the shipped runner and
 * drive them with fixture configs/markers (the Codex P1 three-timezone cross-day
 * counterexample, and the P2 interleaved clean/fail classification matrix). Extraction runs
 * the shipped bytes, so a behavioural regression cannot hide behind an intact source pin.
 */
function extractRunnerFunctions(names) {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  return names
    .map((name) => {
      const m = remote.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm'))
      assert.ok(m, `${name} must exist in the runner`)
      return m[0]
    })
    .join('\n')
}

test('EXECUTABLE (Codex P1): the per-org guard refuses a cross-day second batch that a first-entry derivation would admit', () => {
  const fns = extractRunnerFunctions(['soak_batch_guard_entries', 'soak_batch_guard_check', 'soak_batch_guard_stamp'])
  // Kiritimati (UTC+14) and Pago Pago (UTC-11) are 25h apart: their local calendar days are
  // NEVER both equal to their values one real day apart, so "org1 crossed midnight, org2
  // has not" is constructible at ANY wall-clock moment: stamp all orgs, then rewind ONLY
  // org1's line one day. A first-entry-only guard (keyed on org1) would see yesterday!=today
  // and ADMIT the batch; the per-org guard must refuse on org2/org3.
  const dir = mkdtempSync(join(tmpdir(), 'soak-guard-'))
  try {
    const cfg = join(dir, 'config.json')
    const marker = join(dir, 'marker')
    const script = join(dir, 'probe.sh')
    writeFileSync(cfg, JSON.stringify({
      entries: [
        { orgId: 'aaaaaaaa-0000-0000-0000-000000000001', dailyCapTimezone: 'Pacific/Kiritimati' },
        { orgId: 'bbbbbbbb-0000-0000-0000-000000000002', dailyCapTimezone: 'Pacific/Pago_Pago' },
        { orgId: 'cccccccc-0000-0000-0000-000000000003', dailyCapTimezone: 'Asia/Shanghai' },
      ],
    }))
    writeFileSync(script, `#!/bin/bash\nset -u\n${fns}\n"$@"\n`)
    const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' })
    // Fresh marker: stamp writes one line per org, each under its OWN timezone.
    let r = run('soak_batch_guard_stamp', cfg, marker)
    assert.equal(r.status, 0, `stamp must succeed: ${r.stderr}`)
    const lines = readFileSync(marker, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3, 'stamp must write one line per org')
    for (const line of lines) assert.match(line, /^[0-9a-f-]+=[A-Za-z0-9_/+-]+=\d{4}-\d{2}-\d{2}$/)
    // Same-day re-dispatch: refused (any org matches its own local day).
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'a same-day second batch must be refused')
    assert.match(r.stdout, /already ran \(or started\) a batch on its local day/)
    // Cross-day counterexample: rewind ONLY org1's (first entry!) recorded day. A guard
    // keyed on entries[0] alone sees a stale day and admits; the per-org guard still
    // refuses because org2/org3 remain on their same local days.
    const rewound = lines.map((line) => {
      if (!line.startsWith('aaaaaaaa-')) return line
      const [org, tz, day] = line.split('=')
      const d = new Date(`${day}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 1)
      return `${org}=${tz}=${d.toISOString().slice(0, 10)}`
    })
    writeFileSync(marker, `${rewound.join('\n')}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'org1 crossing midnight must NOT admit a batch while org2/org3 are still on their punched local day')
    // org2 ONLY (#4933 gate P2-2): entries order makes org2 the first same-day match under
    // correct code at EVERY wall-clock instant, while under a first-entry-only derivation
    // org2 (Pago Pago, 25h from Kiritimati — never the same calendar day) can NEVER refuse;
    // the old /bbbbbbbb|cccccccc/ disjunction let org3 (Shanghai, same date as Kiritimati
    // 18h/day) mask that mutation 75% of the time.
    assert.match(r.stdout, /bbbbbbbb/, 'the refusal must come from org2 (the 25h-offset org)')
    assert.doesNotMatch(r.stdout, /cccccccc/, 'org3 must not be the refusing org while org2 precedes it in entry order')
    // All orgs rewound one day: the batch may proceed.
    const allRewound = lines.map((line) => {
      const [org, tz, day] = line.split('=')
      const d = new Date(`${day}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 1)
      return `${org}=${tz}=${d.toISOString().slice(0, 10)}`
    })
    writeFileSync(marker, `${allRewound.join('\n')}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 0, `all orgs on a fresh local day must be admitted: ${r.stdout}`)
    // Override admits a same-day batch (deliberate escape hatch).
    writeFileSync(marker, `${lines.join('\n')}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'true')
    assert.equal(r.status, 0, 'the explicit override must admit a same-day retry')
    // Legacy/corrupted marker content refuses fail-closed.
    writeFileSync(marker, '2026-08-17\n')
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'a legacy single-date marker must refuse fail-closed')
    assert.match(r.stdout, /unrecognized batch-marker line/)
    // BEHAVIOURAL stale-config refusal (#4933 gate P2-1: a text pin alone was neuterable —
    // an `or "UTC"` fallback kept the pinned string while silently reverting): a config
    // whose entry lacks dailyCapTimezone must refuse through the REAL function, whatever
    // the source spelling.
    const staleCfg = join(dir, 'stale-config.json')
    writeFileSync(staleCfg, JSON.stringify({
      entries: [
        { orgId: 'aaaaaaaa-0000-0000-0000-000000000001', dailyCapTimezone: 'Asia/Shanghai' },
        { orgId: 'bbbbbbbb-0000-0000-0000-000000000002' },
      ],
    }))
    rmSync(marker, { force: true })
    r = run('soak_batch_guard_check', staleCfg, marker, 'false')
    assert.equal(r.status, 1, 'a config entry without dailyCapTimezone must refuse — never default to UTC days')
    assert.match(r.stdout, /is missing orgId\/dailyCapTimezone/)
    // LEGACY-PATH MIGRATION (#4933 gate P2-3: the marker was renamed -day -> -days; a
    // pre-rename marker at the old path must be migrated conservatively, never silently
    // ignored). The migrated day counts for EVERY org, so a same-day batch refuses...
    const legacyMarker = join(dir, 'marker-day')
    const migratedMarker = join(dir, 'marker-days')
    const orgToday = (tz) => {
      const r2 = spawnSync('bash', ['-c', `TZ=${tz} date +%Y-%m-%d`], { encoding: 'utf8' })
      return r2.stdout.trim()
    }
    rmSync(migratedMarker, { force: true })
    writeFileSync(legacyMarker, `${orgToday('Pacific/Pago_Pago')}\n`)
    r = run('soak_batch_guard_check', cfg, migratedMarker, 'false')
    assert.equal(r.status, 1, 'a legacy same-day marker must migrate AND refuse')
    assert.ok(!existsSync(legacyMarker), 'the legacy marker must be consumed by migration')
    assert.ok(existsSync(migratedMarker), 'migration must write the per-org marker')
    assert.equal(
      readFileSync(migratedMarker, 'utf8').trim().split('\n').length,
      3,
      'migration must attribute the legacy day to EVERY org (conservative fail-closed)',
    )
    // ...and unrecognized legacy content refuses without migrating.
    rmSync(migratedMarker, { force: true })
    writeFileSync(legacyMarker, 'not-a-date\n')
    r = run('soak_batch_guard_check', cfg, migratedMarker, 'false')
    assert.equal(r.status, 1, 'unrecognized legacy marker content must refuse fail-closed')
    assert.match(r.stdout, /legacy batch marker .* holds unrecognized content/)
    assert.ok(existsSync(legacyMarker), 'an unrecognized legacy marker must be left in place for inspection')
    rmSync(legacyMarker, { force: true })
    // CLOSED-SET cells (Codex r2 P1 — replayed probe: an org1-only marker admitted
    // org2/org3 into a same-day second batch):
    const yday = (tz) => {
      const d = new Date(`${orgToday(tz)}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 1)
      return d.toISOString().slice(0, 10)
    }
    // (a) partial marker — one org missing — must refuse whatever its recorded days say.
    writeFileSync(marker, `aaaaaaaa-0000-0000-0000-000000000001=Pacific/Kiritimati=${yday('Pacific/Kiritimati')}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'a marker missing config orgs must refuse — its absent orgs would be silently admitted')
    assert.match(r.stdout, /does not carry EXACTLY/)
    // (b) ...but the explicit override admits (and the following full-set stamp self-heals).
    r = run('soak_batch_guard_check', cfg, marker, 'true')
    assert.equal(r.status, 0, 'the explicit override must admit past a set-mismatched marker')
    // (c) duplicate org lines refuse.
    writeFileSync(marker, `${lines.join('\n')}\n${lines[0]}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'duplicate org lines must refuse fail-closed')
    assert.match(r.stdout, /duplicate org lines/)
    // (d) a timezone drift on one line is a set mismatch too ((orgId,tz) tuple equality).
    const tzDrift = lines.map((line, idx) => (idx === 0 ? line.replace('Pacific/Kiritimati', 'Etc/UTC') : line))
    writeFileSync(marker, `${tzDrift.join('\n')}\n`)
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'a timezone drift in a marker line must refuse (tuple equality, not orgId alone)')
    assert.match(r.stdout, /does not carry EXACTLY/)
    // (e) atomicity: the stamp must leave no temp residue and produce the exact set.
    r = run('soak_batch_guard_stamp', cfg, marker)
    assert.equal(r.status, 0)
    const leftovers = readFileSync(marker, 'utf8').trim().split('\n')
    assert.equal(leftovers.length, 3, 'the stamp must write the full set')
    assert.equal(
      readdirSync(dir).filter((f) => f.includes('.tmp.')).length,
      0,
      'the atomic stamp must leave no temp residue in the marker directory',
    )
    r = run('soak_batch_guard_check', cfg, marker, 'false')
    assert.equal(r.status, 1, 'a freshly stamped marker must refuse a same-day second batch')
    // (f) ATOMICITY oracle (#4936 gate P2-1 — its own construction, adopted verbatim): in a
    // read-only marker directory the shipped temp+rename stamp FAILS CLEANLY (rename cannot
    // land; the existing marker survives untouched), while a truncate-then-append writer
    // "succeeds" destructively — the `> "$marker"` truncation needs only FILE write
    // permission, so the marker is emptied and the run exits 0. This discriminates the
    // exact mutant the source pin alone could not (it cleans up its temp and left the
    // residue assertion green).
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 3, 'precondition: marker holds the full set')
    chmodSync(dir, 0o555)
    try {
      r = run('soak_batch_guard_stamp', cfg, marker)
      assert.notEqual(r.status, 0, 'the stamp must FAIL when the rename cannot land (read-only dir)')
      assert.equal(
        readFileSync(marker, 'utf8').trim().split('\n').length,
        3,
        'a failed stamp must leave the existing marker byte-intact — a truncate-then-append writer empties it and exits 0',
      )
    } finally {
      chmodSync(dir, 0o755)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EXECUTABLE (Codex P2): the halt classifier never calls an incident-bearing or short batch ok', () => {
  const fns = extractRunnerFunctions(['soak_run_classify'])
  const dir = mkdtempSync(join(tmpdir(), 'soak-classify-'))
  try {
    const script = join(dir, 'probe.sh')
    writeFileSync(script, `#!/bin/bash\nset -u\n${fns}\n"$@"\n`)
    const classify = (...args) => {
      const r = spawnSync('bash', [script, 'soak_run_classify', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, `classifier must not error: ${r.stderr}`)
      return r.stdout.trim()
    }
    assert.equal(classify('targets_met', '180', '180', '180'), 'ok')
    assert.equal(classify('daily_capacity_exhausted', '180', '180', '180'), 'ok')
    // Interleaved clean/fail (scattered 429/500s, never 5 consecutive): capacity exhausts
    // with a shortfall — MUST NOT be ok (the Codex P2 shape).
    assert.equal(classify('daily_capacity_exhausted', '160', '180', '180'), 'WARN')
    assert.equal(classify('targets_met', '180', '183', '180'), 'WARN')
    assert.equal(classify('daily_capacity_exhausted', '160', '160', '180'), 'WARN')
    assert.equal(classify('max_consecutive_incidents', '10', '15', '180'), 'FAIL')
    assert.equal(classify('no_eligible_users_stall_timeout', '180', '180', '180'), 'WARN')
    assert.equal(classify('duration_elapsed', '180', '180', '180'), 'WARN')
    assert.equal(classify('targets_met', 'unknown', 'unknown', '180'), 'WARN')
    // Codex r2 P2 (replayed probe): a contradictory tally (clean > attempts) made the
    // subtraction negative and opened the ok path — must WARN.
    assert.equal(classify('daily_capacity_exhausted', '181', '180', '180'), 'WARN')
    assert.equal(classify('targets_met', '200', '180', '180'), 'WARN')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  // The §2A.7 rowʼs 8/day default was REVISED to 2/day (a documented, owner-vetoable §2A.9
  // deviation): the soak itself proved 8/day floods §4.2-critical review_required diffs
  // (soak-status 31962440160). The 2/day pin lives in assertGeneratorCadenceContract above.
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
  const files = [REMOTE_SH, WORKFLOW, GENERATOR, SOAK_TEMPLATE, join(HERE, 'attendance-window-runner-pipeline.test.mjs')]
  // Allowed: \t (0x09), \n (0x0a), \r (0x0d). Everything else below 0x20, plus 0x7f NUL-class
  // bytes, turns the file git-binary (diff-blind; secret-scan merge gates skip it).
  const hasControlByte = (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i]
      if (!(byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x20)) return i
    }
    return -1
  }
  // POSITIVE CONTROL: the scanner actually detects an injected NUL (else the negative result
  // below is vacuous).
  assert.equal(hasControlByte(Buffer.from('ok\x00ok', 'binary')), 2, 'scanner must catch an injected NUL')
  assert.equal(hasControlByte(Buffer.from('plain ascii\ttab\nnewline', 'utf8')), -1, 'scanner must pass allowed whitespace')
  for (const file of files) {
    const off = hasControlByte(readFileSync(file))
    assert.equal(off, -1, `${file} carries a raw control byte at offset ${off}`)
  }
})
