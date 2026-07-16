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
const WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'attendance-staging-window-runner.yml')

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
    /options:\s*\[deploy,\s*smoke,\s*status,\s*migrate,\s*residue-sweep\]/,
    'expected the workflow action input to list residue-sweep as a choice',
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
  const validateIdx = remote.indexOf('docker compose -f "$STAGING_COMPOSE_FILE" -f "$override_tmp" config')
  const mvIdx = remote.indexOf('mv -f "$override_tmp" "$OVERRIDE_FILE"')
  assert.notEqual(validateIdx, -1, 'candidate override must be validated with docker compose config before replacing the live file')
  // the validation MUST run in the same cwd as compose_staging() (cd "$STAGING_DIR"), or it
  // resolves relative env_file/.env differently than the config `up -d` actually executes
  assert.match(
    remote.slice(Math.max(0, validateIdx - 40), validateIdx),
    /\(cd "\$STAGING_DIR" &&\s*$/,
    'candidate override validation must run inside (cd "$STAGING_DIR" && docker compose …), matching compose_staging()',
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
