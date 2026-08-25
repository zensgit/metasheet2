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
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'node:fs'
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
  const restoreIdx = remote.indexOf('pg_restore -j 2 --exit-on-error --section=pre-data -U')
  assert.notEqual(restoreIdx, -1, 'expected the rehearsal pg_restore invocation to exist')
  const setIdx = remote.indexOf("SET session_replication_role = 'replica'")
  const resetIdx = remote.indexOf('RESET session_replication_role')
  assert.notEqual(setIdx, -1, 'rehearsal lost the DB-level replica-role SET before restore')
  assert.notEqual(resetIdx, -1, 'rehearsal lost the RESET after restore (rehearsal migrate must run under normal trigger semantics)')
  assert.ok(setIdx < restoreIdx, 'replica-role SET must come BEFORE the pg_restore invocation')
  assert.ok(restoreIdx < resetIdx, 'RESET must come AFTER the pg_restore invocation')
})

test('rehearsal restore splits archive sections around a clone-only legacy function compatibility shim', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const rehearseStart = remote.indexOf('action_migrate_rehearse() {')
  const rehearseEnd = remote.indexOf('\naction_migrate_apply() {', rehearseStart)
  assert.ok(rehearseStart >= 0 && rehearseEnd > rehearseStart, 'expected rehearsal function bounds')
  const rehearse = remote.slice(rehearseStart, rehearseEnd)

  const preData = rehearse.indexOf('--section=pre-data')
  const shim = rehearse.indexOf('ALTER FUNCTION ${legacy_fn_signature} SET search_path = pg_catalog, public')
  const data = rehearse.indexOf('--section=data')
  const postData = rehearse.indexOf('--section=post-data')
  const reset = rehearse.indexOf('ALTER FUNCTION ${legacy_fn_signature} RESET search_path')
  assert.ok(preData >= 0 && shim > preData && data > shim && postData > data && reset > postData,
    'restore must run pre-data -> clone shim -> data -> post-data -> clone reset')

  assert.match(rehearse, /-d "\$MIGRATE_BACKUP_PG_DB" -tA[\s\S]*SELECT pg_get_functiondef/,
    'legacy-shape detection must query the source DB read-only')
  assert.match(rehearse, /-d "\$REHEARSAL_DB" -v ON_ERROR_STOP=1[\s\S]*ALTER FUNCTION \$\{legacy_fn_signature\} SET search_path/,
    'compatibility ALTER must target only the fixed rehearsal DB')
  assert.doesNotMatch(rehearse, /-d "\$MIGRATE_BACKUP_PG_DB"[^\n]*ALTER FUNCTION/,
    'compatibility shim must never alter the real staging DB')
  assert.match(rehearse, /legacy_fn_def.*attendance_w4_canonical_date_text\(work_date\)/s,
    'shim must be gated on the exact known unqualified legacy call shape')
  assert.match(rehearse, /legacy_fn_config.*search_path=/s,
    'shim must not override a source function that already pins its search_path')
  assert.equal((rehearse.match(/pg_restore -j 2 --exit-on-error --section=/g) || []).length, 3,
    'all three archive sections must fail closed on the first restore error')
})

function assertExactTargetMigrationContract({ remote, workflow }) {
  assert.match(
    workflow,
    /"\$ACTION" == "deploy" \|\| "\$ACTION" == "migrate" \|\| "\$ACTION" == "smoke" \|\| "\$ACTION" == "soak-flags"/,
    'workflow must require a full deploy_sha for action=migrate',
  )
  assert.match(remote, /TARGET_MIGRATION_IMAGE="ghcr\.io\/\$\{IMAGE_OWNER\}\/metasheet2-backend:\$\{DEPLOY_SHA\}"/)
  assert.match(remote, /org\.opencontainers\.image\.revision/)
  assert.match(remote, /\[\[ "\$revision" == "\$DEPLOY_SHA" \]\]/, 'target image revision must equal the requested SHA')
  assert.match(remote, /--network "container:\$\{BACKEND_CONTAINER\}"/)
  // PINNED-ASSERTION CHANGE (2026-08-24, P1-1 hardening): this used to be a bare
  // "--env-file is present" check — proving env PROPAGATION exists without proving it is
  // SAFE, which is exactly what let the verbatim Config.Env copy (and any inherited
  // MIGRATION_EXCLUDE riding along with it) ship invisibly under a green suite
  // (staging-review-adjudication-20260824.md: "it pins the vector rather than guarding
  // against it"). --env-file itself is kept (still the only safe "inherit another
  // container's env" primitive docker offers) but the assertion now also requires the
  // narrowing allowlist, the detect-and-abort hazard check, and the forced -e backstop to
  // all be present alongside it — the HARDENED shape, not the old bare-propagation one.
  assert.match(remote, /--env-file "\$TARGET_MIGRATION_ENV_FILE"/)
  assert.match(remote, /chmod 0600 "\$TARGET_MIGRATION_ENV_FILE"/)
  assert.match(remote, /trap cleanup_target_migration_runtime EXIT/)
  assert.match(remote, /trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM/, 'P2-4: HUP\\/INT\\/TERM must be trapped, not just EXIT')
  assert.match(remote, /trap 'cleanup_rehearsal; cleanup_target_migration_runtime; exit 1' HUP INT TERM/, 'P2-4: the rehearsal DB cleanup must also survive a caught signal')
  assert.match(remote, /^TARGET_MIGRATION_ENV_ALLOWLIST=\(/m, 'P1-1: the copied env must be narrowed to an explicit allowlist, not verbatim Config.Env')
  for (const name of ['DATABASE_URL', 'NODE_ENV', 'DB_SSL', 'STORAGE_BASE_URL', 'SECRET_PROVIDER', 'SECRET_FILE_PATH']) {
    assert.match(remote, new RegExp(`\\b${name}\\b`), `allowlist must carry ${name}`)
  }
  assert.doesNotMatch(
    remote,
    /handle\.write\("\\n"\.join\(values\)/,
    'P1-1: must not regress to writing the FULL unfiltered Config.Env verbatim',
  )
  assert.match(remote, /raise SystemExit\(\s*$/m, 'P1-1: materialization must be able to abort (hazard-var detection)')
  assert.match(remote, /hazards\.append\(name\)/, 'P1-1: hazard-var detection must actually collect offending names')
  assert.match(remote, /-e "MIGRATION_EXCLUDE="/, 'P1-1: every migrate-family docker run must force MIGRATION_EXCLUDE empty')
  assert.match(remote, /-e "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false"/, 'P1-1: every migrate-family docker run must force this off')
  assert.match(remote, /-e "ALLOW_DB_RESET=false"/, 'P1-1: every migrate-family docker run must force this off')
  assert.match(remote, /^compute_in_play_migrations\(\) \{/m, 'P1-2: an in-play migration set must be mechanically computed')
  assert.match(remote, /^confirm_in_play_migrations\(\) \{/m, 'P1-2: every in-play migration must be name-confirmed')

  const start = remote.indexOf('action_migrate() {')
  const end = remote.indexOf('\n# --- W4+W7 combined-soak', start)
  assert.ok(start !== -1 && end > start, 'expected action_migrate() bounds')
  const migrate = remote.slice(start, end)
  const inventory = migrate.indexOf('target-migrate-list-before.txt')
  const prechecks = migrate.indexOf('action_migrate_read_only_prechecks')
  const backup = migrate.indexOf('action_migrate_backup')
  const rehearsal = migrate.indexOf('action_migrate_rehearse')
  const apply = migrate.indexOf('action_migrate_apply')
  assert.ok(inventory >= 0 && inventory < prechecks, 'exact target inventory must precede read-only data prechecks')
  assert.ok(prechecks < backup, 'read-only prechecks must precede the host backup and all migration writes')
  assert.ok(backup < rehearsal && rehearsal < apply, 'backup -> clone rehearsal -> real apply order must be fixed')
  assert.doesNotMatch(migrate, /(?:compose_staging|docker compose)/, 'action=migrate must never switch or recreate an application image')

  const rehearsalStart = remote.indexOf('action_migrate_rehearse() {')
  const applyStart = remote.indexOf('action_migrate_apply() {', rehearsalStart)
  const migrateStart = remote.indexOf('action_migrate() {', applyStart)
  const rehearsalBody = remote.slice(rehearsalStart, applyStart)
  const applyBody = remote.slice(applyStart, migrateStart)
  assert.doesNotMatch(rehearsalBody, /staging_exec_env[^\n]+MIGRATE_JS/, 'clone rehearsal must not use the running old image')
  assert.doesNotMatch(applyBody, /staging_exec[^\n]+MIGRATE_JS/, 'real apply must not use the running old image')
  assert.ok((rehearsalBody.match(/target_migrate_exec/g) || []).length >= 2, 'rehearsal run + list must use the target image')
  assert.ok((applyBody.match(/target_migrate_exec/g) || []).length >= 4, 'real list/run/list/confirm must use the target image')
  assert.match(applyBody, /--confirm 076_create_integration_stock_prep_pack_installs/)
  assert.match(migrate, /rollout_shadow_flags=OFF/)
  assert.match(migrate, /application_deployed=no/)
  assert.match(remote, /zzzz20260823040000_recovery09_prepare_legacy_default_org/)
  assert.match(remote, /zzzz20260823149900_recovery09_close_approval_org_gap/)
  assert.match(remote, /recovery09_unsupported_class6_count/)
  assert.match(remote, /directory_integration_non_default_count/)
  assert.match(remote, /legacy_anchor_active_membership_witness_count/)
  assert.match(
    remote,
    /if \[\[ "\$repairable_users" -gt 0 \|\| "\$class6" -gt 0 \]\]/,
    'a safe retry must gate on users that can gain a new default row, not actionless default conflicts',
  )
}

test('action=migrate runs the exact target-SHA migration universe without switching the running app', () => {
  assertExactTargetMigrationContract({
    remote: readFileSync(REMOTE_SH, 'utf8'),
    workflow: readFileSync(WORKFLOW, 'utf8'),
  })
})

test('MUTATION: falling back to the running backend for real apply turns the exact-target contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace(
    'target_migrate_exec -- node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-run.log"',
    'staging_exec node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-run.log"',
  )
  assert.throws(
    () => assertExactTargetMigrationContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /real apply must not use the running old image/,
  )
})

test('MUTATION (pinned-assertion change): reverting the allowlist marker to the pre-hardening name turns the contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace('TARGET_MIGRATION_ENV_ALLOWLIST=(', 'NOT_AN_ALLOWLIST=(')
  assert.throws(
    () => assertExactTargetMigrationContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /allowlist/,
  )
})

// --- P1-1/P1-2/P2-4 hardening (2026-08-24, staging-review-adjudication-20260824.md) -----
//
// The tests below run the REAL committed functions (never paraphrased) under a FAKE
// `docker` placed first on PATH, which intercepts exactly the three docker invocation
// shapes these functions use (`inspect -f '{{json .Config.Env}}'`, `run ... sh -c '...'`
// filesystem listing, `run ... node ... --confirm NAME`, and `exec ... psql ...`) and
// nothing else — an unexpected shape is a hard failure (exit 96-99), so a test that
// "passes" because the fake silently no-opped an unanticipated call is not possible here.
// This proves BEHAVIOR (house doctrine: source-text assertions are not behavior
// assertions), not just that certain strings appear in the script.

function extractRunnerArray(name) {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const m = remote.match(new RegExp(`^${name}=\\([\\s\\S]*?\\n\\)`, 'm'))
  assert.ok(m, `expected an array declaration: ${name}`)
  return m[0]
}

// writeFakeDocker: one fake docker(1) script reused by every test below, its behavior
// steered entirely by env vars set per-spawn (see callers) — never by which test invoked
// it — so no test can accidentally get a different fake than the one every other test
// exercises.
const FAKE_DOCKER_DIR = mkdtempSync(join(tmpdir(), 'window-runner-fake-docker-'))
writeFileSync(
  join(FAKE_DOCKER_DIR, 'docker'),
  `#!/bin/bash
set -u
if [[ "\${1:-}" == "inspect" ]]; then
  cat "$FAKE_CONFIG_ENV_JSON"
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  shift
  if [[ -n "\${FAKE_DOCKER_RUN_LOG:-}" ]]; then
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_RUN_LOG"
  fi
  while [[ "\${1:-}" == -* ]]; do
    case "$1" in
      --network|--env-file) shift 2 ;;
      -e) shift 2 ;;
      --rm) shift ;;
      --pull=never) shift ;;
      --pull) shift 2 ;;
      *) echo "unhandled fake-docker run flag: $1" >&2; exit 96 ;;
    esac
  done
  shift # image name, unused by the fake
  if [[ "\${1:-}" == "sh" && "\${2:-}" == "-c" ]]; then
    script="\${3//\\/app\\//$FAKE_APP_ROOT\\/}"
    sh -c "$script"
    exit $?
  fi
  if [[ "\${1:-}" == "node" ]]; then
    shift; shift # node <script.js>
    if [[ "\${1:-}" == "--confirm" ]]; then
      name="$2"
      IFS=',' read -ra applied_arr <<< "\${FAKE_CONFIRM_APPLIED:-}"
      for a in "\${applied_arr[@]}"; do
        if [[ "$a" == "$name" ]]; then
          echo "migration \\"$name\\" is applied"
          exit 0
        fi
      done
      echo "migration \\"$name\\" not found among the known migrations" >&2
      exit 2
    fi
    echo "fake-docker: unhandled node invocation: $*" >&2
    exit 95
  fi
  echo "unexpected fake-docker run tail: $*" >&2
  exit 98
fi
if [[ "\${1:-}" == "exec" ]]; then
  cat "\${FAKE_APPLIED_NAMES:-/dev/null}"
  exit 0
fi
echo "unexpected fake-docker call: $*" >&2
exit 97
`,
  { mode: 0o755 },
)

/**
 * buildMigrationEnvHarness: extracts materialize_target_migration_env,
 * TARGET_MIGRATION_ENV_ALLOWLIST, target_migrate_exec, list_migration_name_universe,
 * list_migration_names_applied, compute_in_play_migrations, confirm_in_play_migrations,
 * and cleanup_target_migration_runtime VERBATIM from the shipped runner, applies an
 * optional text transform to any one of them (mutation tests), and wraps them in a
 * minimal, real, `set -euo pipefail` bash program with the fake docker above.
 */
function buildMigrationEnvHarness(transforms = {}) {
  const pieces = {
    allowlist: extractRunnerArray('TARGET_MIGRATION_ENV_ALLOWLIST'),
    materialize: extractRunnerFunctions(['materialize_target_migration_env']),
    targetExec: extractRunnerFunctions(['target_migrate_exec']),
    universe: extractRunnerFunctions(['list_migration_name_universe']),
    applied: extractRunnerFunctions(['list_migration_names_applied']),
    inPlay: extractRunnerFunctions(['compute_in_play_migrations']),
    countsAgree: extractRunnerFunctions(['assert_applied_counts_agree']),
    confirm: extractRunnerFunctions(['confirm_in_play_migrations']),
    cleanup: extractRunnerFunctions(['cleanup_target_migration_runtime']),
  }
  for (const [key, transform] of Object.entries(transforms)) {
    assert.ok(key in pieces, `unknown harness piece: ${key}`)
    pieces[key] = transform(pieces[key])
  }
  const failLine = extractRunnerLine('fail')
  const logLine = extractRunnerLine('log')
  return `#!/bin/bash
set -euo pipefail
BACKEND_CONTAINER="fake-backend"
POSTGRES_CONTAINER="fake-postgres"
MIGRATE_BACKUP_PG_USER="fakeuser"
MIGRATE_JS="fake-migrate.js"
TARGET_MIGRATION_IMAGE="fake-image:tag"
${failLine}
${logLine}
${pieces.allowlist}
${pieces.cleanup}
${pieces.targetExec}
${pieces.universe}
${pieces.applied}
${pieces.inPlay}
${pieces.countsAgree}
${pieces.confirm}
${pieces.materialize}
`
}

function runMigrationEnvHarness(script, driverTail, env = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'window-runner-migrate-out-'))
  const envFile = join(outDir, 'target-migrate-env')
  writeFileSync(envFile, '')
  const full = `${script}\nOUTPUT_DIR="${outDir}"\nTARGET_MIGRATION_ENV_FILE="${envFile}"\n${driverTail}\n`
  const result = spawnSync('bash', ['-c', full], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FAKE_DOCKER_DIR}:${process.env.PATH}`,
      ...env,
    },
  })
  return { ...result, outDir, envFile }
}

function configEnvFixture(dir, pairs) {
  const file = join(dir, 'config-env.json')
  writeFileSync(file, JSON.stringify(pairs.map(([k, v]) => `${k}=${v}`)))
  return file
}

const REQUIRED_MIGRATE_ENV = [
  ['DATABASE_URL', 'postgres://u:p@postgres:5432/metasheet'],
  ['NODE_ENV', 'production'],
  ['DB_SSL', 'false'],
  ['DB_SSL_REJECT_UNAUTHORIZED', 'false'],
  ['DB_SSL_CA', ''],
  ['DB_SSL_CERT', ''],
  ['DB_SSL_KEY', ''],
  ['DB_POOL_MAX', '20'],
  ['DB_POOL_MIN', '2'],
  ['DB_IDLE_TIMEOUT', '30000'],
  ['DB_CONNECT_TIMEOUT', '10000'],
  ['DB_QUERY_TIMEOUT', '30000'],
  ['DB_STATEMENT_TIMEOUT', '30000'],
  ['DB_SLOW_MS', '500'],
  ['APP_NAME', 'metasheet-backend'],
  ['STORAGE_BASE_URL', 'http://localhost:8900/files'],
  ['SECRET_PROVIDER', 'env'],
  ['LOG_LEVEL', 'info'],
]

for (const [hazardName, hazardValue] of [
  ['MIGRATION_EXCLUDE', '076_create_integration_stock_prep_pack_installs'],
  ['MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL', 'true'],
  ['ALLOW_DB_RESET', 'true'],
]) {
  test(`EXECUTABLE (P1-1 detect-and-abort): a hostile inherited ${hazardName} aborts materialization, values-free`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'window-runner-hazard-'))
    const secretMarker = 'HAZARD_VALUE_MUST_NEVER_APPEAR_' + hazardName
    const configEnv = configEnvFixture(dir, [...REQUIRED_MIGRATE_ENV, [hazardName, hazardValue === 'true' ? 'true' : secretMarker]])
    const script = buildMigrationEnvHarness()
    const r = runMigrationEnvHarness(script, 'materialize_target_migration_env', {
      FAKE_CONFIG_ENV_JSON: configEnv,
    })
    assert.notEqual(r.status, 0, `expected materialization to abort; stdout=${r.stdout}`)
    assert.match(r.stderr, new RegExp(`ABORT.*${hazardName}`), 'must name the offending variable')
    if (hazardValue !== 'true') {
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secretMarker), 'must never echo the hazardous value, only the name')
    }
    assert.equal(readFileSync(r.envFile, 'utf8'), '', 'must not have written anything to the env file before aborting')
  })
}

test('EXECUTABLE (P1-1 detect-and-abort) MUTATION: removing the hazard-var scan turns all three hostile-env tests red — and ONLY changes the abort path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-hazard-mut-'))
  const configEnv = configEnvFixture(dir, [...REQUIRED_MIGRATE_ENV, ['MIGRATION_EXCLUDE', '076_create_integration_stock_prep_pack_installs']])
  const script = buildMigrationEnvHarness({
    materialize: (text) => text.replace(/if hazards:\n[\s\S]*?\n    \)\n/, ''),
  })
  const r = runMigrationEnvHarness(script, 'materialize_target_migration_env', { FAKE_CONFIG_ENV_JSON: configEnv })
  assert.equal(r.status, 0, `expected the mutated (unguarded) materialization to SUCCEED where the real one aborts; stderr=${r.stderr}`)
  assert.doesNotMatch(r.stderr, /ABORT/, 'the mutation must actually remove the abort, not just reword it')
  // Positive control that this is a targeted mutation, not a broken harness: the SAME
  // mutated harness on a CLEAN env still materializes correctly.
  const cleanConfigEnv = configEnvFixture(dir, REQUIRED_MIGRATE_ENV)
  const clean = runMigrationEnvHarness(script, 'materialize_target_migration_env', { FAKE_CONFIG_ENV_JSON: cleanConfigEnv })
  assert.equal(clean.status, 0)
  assert.match(readFileSync(clean.envFile, 'utf8'), /DATABASE_URL=/)
})

test('EXECUTABLE (P1-1 allowlist): a non-allowlisted secret-shaped var (JWT_SECRET) is silently dropped from the written env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-allowlist-drop-'))
  const configEnv = configEnvFixture(dir, [
    ...REQUIRED_MIGRATE_ENV,
    ['JWT_SECRET', 'do-not-leak-this-jwt-secret'],
    ['POSTGRES_PASSWORD', 'do-not-leak-this-pg-password'],
    ['DINGTALK_CLIENT_SECRET', 'do-not-leak-this-dingtalk-secret'],
  ])
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, 'materialize_target_migration_env', { FAKE_CONFIG_ENV_JSON: configEnv })
  assert.equal(r.status, 0, `expected clean materialization; stderr=${r.stderr}`)
  const written = readFileSync(r.envFile, 'utf8')
  assert.doesNotMatch(written, /do-not-leak-this/, 'non-allowlisted secrets must never reach the migration env file')
  assert.match(written, /DATABASE_URL=/, 'the allowlisted vars must still be present')
})

test('EXECUTABLE (P1-1 allowlist) POSITIVE CONTROL: the full required migrate-path env surface survives materialization intact (nothing needed is silently dropped)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-allowlist-positive-'))
  const configEnv = configEnvFixture(dir, [...REQUIRED_MIGRATE_ENV, ['IRRELEVANT_NOISE', 'x']])
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, 'materialize_target_migration_env', { FAKE_CONFIG_ENV_JSON: configEnv })
  assert.equal(r.status, 0, `expected clean materialization; stderr=${r.stderr}`)
  const written = readFileSync(r.envFile, 'utf8')
  for (const [name] of REQUIRED_MIGRATE_ENV) {
    assert.match(written, new RegExp(`^${name}=`, 'm'), `${name} must survive materialization — dropping it can break staging (e.g. DB_SSL absence + baked-in NODE_ENV=production flips SSL on against a non-SSL postgres)`)
  }
  assert.doesNotMatch(written, /IRRELEVANT_NOISE/, 'non-allowlisted noise must still be dropped even in the positive-control fixture')
})

test('MUTATION (P1-1 allowlist completeness): dropping DB_SSL from the allowlist turns the positive-control test red', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-allowlist-mut-'))
  const configEnv = configEnvFixture(dir, REQUIRED_MIGRATE_ENV)
  const script = buildMigrationEnvHarness({
    allowlist: (text) => text.replace('DB_SSL ', ''),
  })
  const r = runMigrationEnvHarness(script, 'materialize_target_migration_env', { FAKE_CONFIG_ENV_JSON: configEnv })
  assert.equal(r.status, 0, `materialization itself should still succeed; stderr=${r.stderr}`)
  const written = readFileSync(r.envFile, 'utf8')
  assert.doesNotMatch(written, /^DB_SSL=/m, 'the mutated allowlist must actually have dropped DB_SSL, proving the positive-control test is discriminating')
})

test('EXECUTABLE (P1-1 layer 3): target_migrate_exec forces the three hazard vars off on every migrate-family docker run, winning over any earlier flag', () => {
  const script = buildMigrationEnvHarness()
  const runLog = join(mkdtempSync(join(tmpdir(), 'window-runner-runlog-')), 'run.log')
  const r = runMigrationEnvHarness(
    script,
    'target_migrate_exec "MIGRATION_EXCLUDE=should-be-overridden" -- node "$MIGRATE_JS" --confirm somename',
    { FAKE_DOCKER_RUN_LOG: runLog, FAKE_CONFIRM_APPLIED: 'somename' },
  )
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const logged = readFileSync(runLog, 'utf8')
  assert.match(logged, /-e MIGRATION_EXCLUDE=should-be-overridden.*-e MIGRATION_EXCLUDE=(?!should)/, 'the forced empty override must come AFTER the caller-supplied value (docker: last -e for a name wins)')
  assert.match(logged, /-e MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false/)
  assert.match(logged, /-e ALLOW_DB_RESET=false/)
})

test('MUTATION (P1-1 layer 3): removing the forced -e overrides turns the previous test red', () => {
  const script = buildMigrationEnvHarness({
    targetExec: (text) => text
      .replace('-e "MIGRATION_EXCLUDE=" \\\n', '')
      .replace('-e "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false" \\\n', '')
      .replace('-e "ALLOW_DB_RESET=false" \\\n', ''),
  })
  const runLog = join(mkdtempSync(join(tmpdir(), 'window-runner-runlog-mut-')), 'run.log')
  const r = runMigrationEnvHarness(
    script,
    'target_migrate_exec "MIGRATION_EXCLUDE=should-be-overridden" -- node "$MIGRATE_JS" --confirm somename',
    { FAKE_DOCKER_RUN_LOG: runLog, FAKE_CONFIRM_APPLIED: 'somename' },
  )
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const logged = readFileSync(runLog, 'utf8')
  assert.match(logged, /MIGRATION_EXCLUDE=should-be-overridden/)
  assert.doesNotMatch(logged, /-e MIGRATION_EXCLUDE=(?!should)/, 'with the mutation, the hazardous caller value is no longer overridden — proving the real code is what wins')
})

// fakeAppRootFixture: mirrors the REAL migrations layout, including the two file types
// that co-exist inside src/db/migrations/ (verified in review, 2026-08-24 —
// 20250925_create_view_tables.sql / 20250926_create_audit_tables.sql sit alongside the
// .ts migrations, not just in the top-level migrations/ folder; missing that glob would
// silently narrow the universe, exactly the failure mode this whole change exists to
// prevent). Also plants a `_`-prefixed non-migration helper file (mirroring the real
// _patterns.ts/_template.ts) to prove it is excluded, not merely absent from the fixture.
function fakeAppRootFixture(names, { legacySqlInTsDir = [], underscorePrefixedNoise = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'window-runner-fake-app-'))
  const tsDir = join(root, 'packages', 'core-backend', 'src', 'db', 'migrations')
  const sqlDir = join(root, 'packages', 'core-backend', 'migrations')
  mkdirSync(tsDir, { recursive: true })
  mkdirSync(sqlDir, { recursive: true })
  for (const name of names) {
    if (name.startsWith('076')) {
      writeFileSync(join(sqlDir, `${name}.sql`), '-- fixture\n')
    } else {
      writeFileSync(join(tsDir, `${name}.ts`), '// fixture\n')
    }
  }
  for (const name of legacySqlInTsDir) {
    writeFileSync(join(tsDir, `${name}.sql`), '-- legacy fixture\n')
  }
  if (underscorePrefixedNoise) {
    writeFileSync(join(tsDir, '_patterns.ts'), '// shared helper, not a migration\n')
  }
  return root
}

test('EXECUTABLE (P1-2): compute_in_play_migrations = image filesystem manifest MINUS already-applied (both env-immune)', () => {
  const appRoot = fakeAppRootFixture(['zzzz1_already_applied', 'zzzz2_pending_a', 'zzzz3_pending_b', '076_create_integration_stock_prep_pack_installs'])
  const appliedFile = join(appRoot, 'applied.txt')
  writeFileSync(appliedFile, 'zzzz1_already_applied\n076_create_integration_stock_prep_pack_installs\n')
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, 'compute_in_play_migrations fakerealdb', {
    FAKE_APP_ROOT: appRoot,
    FAKE_APPLIED_NAMES: appliedFile,
  })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const inPlay = readFileSync(join(r.outDir, 'migration-in-play.txt'), 'utf8').trim().split('\n').filter(Boolean).sort()
  assert.deepEqual(inPlay, ['zzzz2_pending_a', 'zzzz3_pending_b'])
})

test('EXECUTABLE (P1-2 universe fidelity): a legacy .sql file living INSIDE src/db/migrations/ (not just the top-level migrations/) is counted, and a `_`-prefixed shared-helper file is not', () => {
  // Mirrors the real repo shape caught in review: 20250925_create_view_tables.sql /
  // 20250926_create_audit_tables.sql sit next to the .ts migrations, and _patterns.ts /
  // _template.ts are shared helper code the provider itself skips by name convention.
  const appRoot = fakeAppRootFixture(['zzzz1_pending'], {
    legacySqlInTsDir: ['20250925_create_view_tables', '20250926_create_audit_tables'],
  })
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, 'list_migration_name_universe', { FAKE_APP_ROOT: appRoot })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const universe = r.stdout.trim().split('\n').filter(Boolean).sort()
  assert.deepEqual(universe, ['20250925_create_view_tables', '20250926_create_audit_tables', 'zzzz1_pending'])
  assert.doesNotMatch(r.stdout, /_patterns/, 'the underscore-prefixed helper file must never be mistaken for a migration name')
})

test('MUTATION (P1-2 universe fidelity): dropping the src/db/migrations *.sql glob turns the previous test red', () => {
  const appRoot = fakeAppRootFixture(['zzzz1_pending'], {
    legacySqlInTsDir: ['20250925_create_view_tables', '20250926_create_audit_tables'],
  })
  const script = buildMigrationEnvHarness({
    universe: (text) => text.replace(
      '/app/packages/core-backend/src/db/migrations/*.sql /app/packages/core-backend/migrations/*.sql',
      '/app/packages/core-backend/migrations/*.sql',
    ),
  })
  const r = runMigrationEnvHarness(script, 'list_migration_name_universe', { FAKE_APP_ROOT: appRoot })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const universe = r.stdout.trim().split('\n').filter(Boolean).sort()
  assert.deepEqual(universe, ['zzzz1_pending'], 'with the mutation, the two legacy .sql migrations silently vanish from the universe')
})

function writeCountFixtures(dir, { psqlLines, providerAppliedLine }) {
  const psqlFile = join(dir, 'psql-applied.txt')
  const providerFile = join(dir, 'provider-list.txt')
  writeFileSync(psqlFile, psqlLines.map((l) => `${l}\n`).join(''))
  writeFileSync(providerFile, `${providerAppliedLine}\nPending: 0\n`)
  return { psqlFile, providerFile }
}

test('EXECUTABLE (P2 sanity floor): assert_applied_counts_agree passes when the env-immune psql count matches the provider Applied:N', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-counts-agree-'))
  const { psqlFile, providerFile } = writeCountFixtures(dir, {
    psqlLines: ['a', 'b', 'c'],
    providerAppliedLine: 'Applied: 3',
  })
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, `assert_applied_counts_agree "${psqlFile}" "${providerFile}" && echo COUNTS_AGREE_OK`)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.match(r.stdout, /COUNTS_AGREE_OK/)
})

test('EXECUTABLE (P2 sanity floor): assert_applied_counts_agree FAILS LOUD on a zero-count psql read (the empty-read-is-not-absence class)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-counts-zero-'))
  const { psqlFile, providerFile } = writeCountFixtures(dir, {
    psqlLines: [],
    providerAppliedLine: 'Applied: 321',
  })
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, `assert_applied_counts_agree "${psqlFile}" "${providerFile}" && echo COUNTS_AGREE_OK`)
  assert.notEqual(r.status, 0, 'a zero applied-count from psql must never be silently trusted for a live staging DB')
  assert.match(r.stderr, /not a positive integer/)
  assert.doesNotMatch(r.stdout, /COUNTS_AGREE_OK/)
})

test('EXECUTABLE (P2 sanity floor): assert_applied_counts_agree FAILS LOUD when the two independent sources disagree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-counts-mismatch-'))
  const { psqlFile, providerFile } = writeCountFixtures(dir, {
    psqlLines: ['a', 'b', 'c'],
    providerAppliedLine: 'Applied: 4',
  })
  const script = buildMigrationEnvHarness()
  const r = runMigrationEnvHarness(script, `assert_applied_counts_agree "${psqlFile}" "${providerFile}" && echo COUNTS_AGREE_OK`)
  assert.notEqual(r.status, 0, 'a psql/provider disagreement must fail loud rather than silently pick one source')
  assert.match(r.stderr, /count mismatch/)
  assert.doesNotMatch(r.stdout, /COUNTS_AGREE_OK/)
})

test('MUTATION (P2 sanity floor): removing the equality check turns the mismatch test red', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-counts-mismatch-mut-'))
  const { psqlFile, providerFile } = writeCountFixtures(dir, {
    psqlLines: ['a', 'b', 'c'],
    providerAppliedLine: 'Applied: 4',
  })
  const script = buildMigrationEnvHarness({
    countsAgree: (text) => text.replace(
      /\[\[ "\$applied_count_psql" == "\$applied_count_provider" \][^\n]*\n[^\n]*\n/,
      '',
    ),
  })
  const r = runMigrationEnvHarness(script, `assert_applied_counts_agree "${psqlFile}" "${providerFile}" && echo COUNTS_AGREE_OK`)
  assert.equal(r.status, 0, `expected the mutated (unguarded) check to wrongly pass a real mismatch; stderr=${r.stderr}`)
  assert.match(r.stdout, /COUNTS_AGREE_OK/)
})

test('EXECUTABLE (P1-2): confirm_in_play_migrations passes when every in-play migration name-confirms applied', () => {
  const script = buildMigrationEnvHarness()
  const namesFile = join(mkdtempSync(join(tmpdir(), 'window-runner-names-')), 'in-play.txt')
  writeFileSync(namesFile, 'zzzz2_pending_a\nzzzz3_pending_b\n')
  const r = runMigrationEnvHarness(script, `confirm_in_play_migrations "${namesFile}" && echo CONFIRM_LOOP_OK`, {
    FAKE_CONFIRM_APPLIED: 'zzzz2_pending_a,zzzz3_pending_b',
  })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.match(r.stdout, /CONFIRM_LOOP_OK/)
})

test('EXECUTABLE (P1-2 exclusion canary): confirm_in_play_migrations FAILS LOUD, naming the migration, when one in-play name is not confirmable (kysely returns exit 2 for an excluded name)', () => {
  const script = buildMigrationEnvHarness()
  const namesFile = join(mkdtempSync(join(tmpdir(), 'window-runner-names-canary-')), 'in-play.txt')
  writeFileSync(namesFile, 'zzzz2_pending_a\nzzzz3_pending_b\n')
  const r = runMigrationEnvHarness(script, `confirm_in_play_migrations "${namesFile}" && echo CONFIRM_LOOP_OK`, {
    // zzzz3_pending_b is NOT in the applied set — simulates it having been silently
    // excluded from the provider's getMigrations() (MIGRATION_EXCLUDE-class exclusion).
    FAKE_CONFIRM_APPLIED: 'zzzz2_pending_a',
  })
  assert.notEqual(r.status, 0, 'the loop must fail when any in-play migration cannot be confirmed')
  assert.match(r.stderr, /'zzzz3_pending_b'/, 'must name the specific migration that failed confirmation')
  assert.doesNotMatch(r.stdout, /CONFIRM_LOOP_OK/, 'must never report success past an unconfirmed in-play migration')
})

test('MUTATION (P1-2): weakening confirm_in_play_migrations to accept ANY output turns the exclusion-canary test red', () => {
  const script = buildMigrationEnvHarness({
    confirm: (text) => text.replace(
      'grep -q "^migration \\"${name}\\" is applied\\$" <<< "$out" \\\n      || fail "named confirmation for in-play migration \'${name}\' did not pass (see confirm-in-play.txt): ${out}"',
      'true',
    ),
  })
  const namesFile = join(mkdtempSync(join(tmpdir(), 'window-runner-names-canary-mut-')), 'in-play.txt')
  writeFileSync(namesFile, 'zzzz2_pending_a\nzzzz3_pending_b\n')
  const r = runMigrationEnvHarness(script, `confirm_in_play_migrations "${namesFile}" && echo CONFIRM_LOOP_OK`, {
    FAKE_CONFIRM_APPLIED: 'zzzz2_pending_a',
  })
  assert.equal(r.status, 0, 'the mutated (unguarded) loop must now wrongly report success')
  assert.match(r.stdout, /CONFIRM_LOOP_OK/)
})

test('EXECUTABLE (P2-4): SIGTERM mid-run still removes the migration secret file, and the process actually terminates', async () => {
  const cleanupFn = extractRunnerFunctions(['cleanup_target_migration_runtime'])
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-signal-'))
  const envFile = join(dir, 'secret-env-file')
  writeFileSync(envFile, 'DATABASE_URL=postgres://fake\n', { mode: 0o600 })
  const script = `#!/bin/bash
set -u
TARGET_MIGRATION_ENV_FILE="${envFile}"
${cleanupFn}
trap cleanup_target_migration_runtime EXIT
trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM
echo READY
sleep 30
`
  const { spawn } = await import('node:child_process')
  const proc = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve) => {
    proc.stdout.once('data', () => resolve())
  })
  assert.ok(existsSync(envFile), 'precondition: the secret file exists before the signal')
  proc.kill('SIGTERM')
  const exitInfo = await new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
  assert.ok(!existsSync(envFile), 'SIGTERM must trigger cleanup (shred/rm) of the migration secret file before the process exits')
  assert.notEqual(exitInfo.code, 0, 'a signal-terminated run must not report a clean exit code')
})

// The registration test below (not the SIGTERM-delivery test above) carries this change's
// mutation proof. Empirically (verified on both bash 3.2 and bash 5.3 here), a bare `trap
// ... EXIT` ALSO runs on an uncaught SIGHUP/SIGINT/SIGTERM in these bash versions — so a
// file-existence assertion after `kill -TERM` does not by itself discriminate the explicit
// HUP/INT/TERM trap from EXIT-only (both left no file behind in that A/B check). That
// behavior is bash's own signal-handling implementation detail, not a documented contract
// (POSIX/the bash manual only guarantee EXIT fires "on exit from the shell"), so relying on
// it is exactly the fragility this hardening avoids: explicit registration is the portable,
// self-documenting contract. What DOES discriminate, deterministically, is whether HUP/INT/
// TERM are actually REGISTERED (`trap -p`) — which is what "add HUP/INT/TERM traps" means.
test('EXECUTABLE (P2-4 registration): the runner registers explicit HUP/INT/TERM handlers, not only EXIT', () => {
  const trapLines = [
    "trap cleanup_target_migration_runtime EXIT",
    "trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM",
  ]
  for (const line of trapLines) {
    assert.ok(readFileSync(REMOTE_SH, 'utf8').includes(line), `expected the runner to contain: ${line}`)
  }
  const cleanupFn = extractRunnerFunctions(['cleanup_target_migration_runtime'])
  const script = `#!/bin/bash
set -u
TARGET_MIGRATION_ENV_FILE=""
${cleanupFn}
${trapLines.join('\n')}
trap -p
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.match(r.stdout, /trap -- '[^']*' (SIGHUP|HUP)/)
  assert.match(r.stdout, /trap -- '[^']*' (SIGINT|INT)/)
  assert.match(r.stdout, /trap -- '[^']*' (SIGTERM|TERM)/)
  assert.match(r.stdout, /trap -- '[^']*' (SIGEXIT|EXIT)/)
})

// Comment-stripped view of a function body. Two independent reviews of c5be6a54e8 (the external
// one and the gate's N1) proved every WIRING pin below was satisfiable by a COMMENTED-OUT line:
// with all eight load-bearing lines turned into `# ...` comments, bash -n passed and this suite
// stayed green at 136/136 while action=deploy migrated nothing and the P1-2 pipeline was fully
// unwired. A wiring pin may only match EXECUTABLE lines: strip full-line comments, then anchor
// at line start.
function executableLines(body) {
  return body.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

test('EXECUTABLE (P1-2 wiring): action_migrate_apply CALLS the pipeline — real body, recording stubs, order and arguments', () => {
  // The stronger tier, and why it exists alongside the anchored text pins: a text pin — even
  // comment-stripped and line-anchored — is still satisfied by a call wrapped in dead control
  // flow (`if false; then ... fi`). Executing the REAL extracted body with recording stubs is
  // not: commented, deleted, and dead-wrapped calls all fail identically — the recorder never
  // sees them.
  const applyFn = extractRunnerFunctions(['action_migrate_apply'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-apply-wiring-'))
  const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
MIGRATE_JS="fake/dist/migrate.js"
MIGRATE_BACKUP_PATH="/dev/null"
CALLS="${dir}/calls.txt"
log() { :; }
fail() { echo "HARNESS-FAIL:$*" >&2; exit 1; }
resolve_backend_database_url() { echo "postgres://u:p@postgres:5432/stagingdb"; }
dsn_database_name() { echo "stagingdb"; }
target_migrate_exec() {
  echo "exec:$*" >> "$CALLS"
  if [[ "$*" == *"--confirm 076_create_integration_stock_prep_pack_installs"* ]]; then
    echo 'migration "076_create_integration_stock_prep_pack_installs" is applied'
  elif [[ "$*" == *"--list"* ]]; then
    echo "Applied: 337"
    echo "Pending: 0"
  else
    echo "migrations run"
  fi
}
compute_in_play_migrations() { echo "compute:$1" >> "$CALLS"; echo "zzzz_example" > "$OUTPUT_DIR/migration-in-play.txt"; }
assert_applied_counts_agree() { echo "counts:$1|$2" >> "$CALLS"; }
confirm_in_play_migrations() { echo "confirm:$1" >> "$CALLS"; }
${applyFn}
action_migrate_apply
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const calls = readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n')
  const compute = calls.indexOf('compute:stagingdb')
  const counts = calls.indexOf(`counts:${dir}/migration-applied-before.txt|${dir}/apply-migrate-list-before.txt`)
  const confirm = calls.indexOf(`confirm:${dir}/migration-in-play.txt`)
  const mutating = calls.indexOf('exec:-- node fake/dist/migrate.js')
  assert.ok(compute >= 0, `compute_in_play_migrations never RAN with the real DB name; calls=${calls.join(' ; ')}`)
  assert.ok(counts >= 0, `assert_applied_counts_agree never RAN with the two ledger paths; calls=${calls.join(' ; ')}`)
  assert.ok(confirm >= 0, `confirm_in_play_migrations never RAN with the in-play file; calls=${calls.join(' ; ')}`)
  assert.ok(mutating >= 0, 'the mutating migrate exec itself vanished — the harness drifted from the body')
  assert.ok(compute < counts && counts < mutating, `the gates must run BEFORE the mutating migrate: compute=${compute} counts=${counts} mutating=${mutating}`)
  assert.ok(confirm > mutating, 'per-name confirmation must follow the apply')
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (F1 probe honesty): a FAILED probe refuses SAFE; unset and set-but-empty pass', () => {
  // N2 (gate on c5be6a54e8): the first probe ended in `|| true`, collapsing docker exec rc=125
  // and printenv-missing rc=127 into value="" -> SAFE certified without observing anything.
  // printenv distinguishes natively: rc=0 set, rc=1 unset, else the PROBE failed.
  const fn = extractRunnerFunctions(['assert_deploy_migrate_env_safe'])
  const outDir = mkdtempSync(join(tmpdir(), 'wr-probe-'))
  const harness = (dockerBody) => `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${outDir}"
BACKEND_CONTAINER="fake-backend"
fail() { echo "[window-runner][error] $*" >&2; exit 1; }
docker() { ${dockerBody}; }
${fn}
assert_deploy_migrate_env_safe
echo SAFE
`
  // docker exec itself fails (daemon down / container gone): must REFUSE, naming the rc.
  const broken = spawnSync('bash', ['-c', harness('return 125')], { encoding: 'utf8' })
  assert.equal(broken.status, 1, `stderr=${broken.stderr}`)
  assert.match(broken.stderr, /rc=125/, 'the refusal must name the probe rc')
  assert.match(broken.stderr, /FAILED probe/i)
  // unset everywhere (printenv rc=1): SAFE.
  const unset = spawnSync('bash', ['-c', harness('return 1')], { encoding: 'utf8' })
  assert.equal(unset.status, 0, `stderr=${unset.stderr}`)
  assert.match(unset.stdout, /SAFE/)
  // set-but-EMPTY (printenv rc=0, empty output): SAFE — all three consumers treat only
  // non-empty / exact-true as active, so empty must not block a deploy.
  const empty = spawnSync('bash', ['-c', harness('if [[ "$4" == "MIGRATION_EXCLUDE" ]]; then echo ""; else return 1; fi')], { encoding: 'utf8' })
  assert.equal(empty.status, 0, `stderr=${empty.stderr}`)
  assert.match(empty.stdout, /SAFE/)
})

// The W7 env NAME is referenced via a const, mirroring the runner's own `${SOAK_W7_ENV_NAME}:`
// indirection: the W7-1a inertness sweep (attendance-w7-1a-inertness-sweep.test.ts) asserts that
// no tracked non-/tests/ file contains the literal name followed by ':' or '=' — its test-file
// carve-out predates this scripts/ops suite, and the compliant idiom in this tree is indirection,
// not a literal. The fixtures on DISK still carry the real name; only this SOURCE avoids it.
const W4_FLAG_NAME = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_FLAG_NAME = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'

test('EXECUTABLE (override classification): all four shapes + absence classify correctly, values-free', () => {
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovshape-'))
  const overrideOf = (envLines) => `# Written by attendance-staging-window-runner (run test).
services:
  backend:
    image: ghcr.io/x/metasheet2-backend:deadbeef
${envLines}  web:
    image: ghcr.io/x/metasheet2-web:deadbeef
`
  // liveSpec: map name -> printenv rc for the stub docker
  const run = (fileBody, liveSpec) => {
    const overridePath = join(dir, `ov-${Math.random().toString(36).slice(2, 8)}.yml`)
    if (fileBody !== null) writeFileSync(overridePath, fileBody)
    // The stub EMULATES docker exec's single sh -c protocol (P2-1 round 2): it runs the exact
    // in-container script the classifier sends, under a shadow printenv that answers from
    // liveSpec and — like the real printenv (measured on docker 29.5.3) — WRITES THE VALUE to
    // stdout on rc=0. A classifier script that forgets to discard printenv's stdout therefore
    // leaks the canary into the enumerator output, and the values-free assertions bite. Every
    // invocation is counted: the whole classification must observe the container EXACTLY ONCE —
    // a control-then-loop shape (the round-1 TOCTOU) makes 5 calls and reds the count pin.
    const setCases = Object.entries(liveSpec).filter(([, v]) => v === 0).map(([k]) => k)
    const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() {
  echo call >> "${dir}/docker-calls.txt"
  local body="$5"
  shift 6
  (
    printenv() {
      case "$1" in
        PATH) echo "/usr/bin:org_secret_live_canary"; return 0 ;;
${setCases.map((k) => `        ${k}) echo "org_secret_live_canary"; return 0 ;;`).join('\n')}
        *) return 1 ;;
      esac
    }
    eval "$body"
  )
}
${fn}
classify_runner_override
`
    rmSync(join(dir, 'docker-calls.txt'), { force: true })
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    const calls = existsSync(join(dir, 'docker-calls.txt'))
      ? readFileSync(join(dir, 'docker-calls.txt'), 'utf8').trim().split('\n').filter(Boolean).length
      : 0
    return { r, report: readFileSync(join(dir, 'override-shape.txt'), 'utf8'), calls }
  }

  // absent file, nothing live -> absent, match=true, exit 0
  let { r, report } = run(null, {})
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.match(report, /^override_shape=absent$/m)
  assert.match(report, /^file_live_match=true$/m)

  // none-shape (no environment block), nothing live -> none, exit 0
  ;({ r, report } = run(overrideOf(''), {}))
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.match(report, /^override_shape=none$/m)

  // rd-window file + both live -> rd-window, match=true, exit 0
  const rdEnv = '    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n'
  let calls
  ;({ r, report, calls } = run(overrideOf(rdEnv), { ATTENDANCE_SCHEDULER_ENABLED: 0, ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: 0 }))
  assert.equal(r.status, 0, `stderr=${r.stderr}\nreport=${report}`)
  assert.match(report, /^override_shape=rd-window$/m)
  assert.match(report, /^file_live_match=true$/m)
  // P2-1 round 2 (TOCTOU): control and enumeration must be ONE observation. The round-1 shape
  // probed PATH and then looped four more execs (5 calls); a channel dying between them turned
  // "observed nothing" into "observed unset". Structurally pinned: exactly one docker call.
  assert.equal(calls, 1, `the live side must observe the container EXACTLY once, saw ${calls}`)

  // soak file (with ORG VALUES) + both soak flags live -> soak-w4w7 AND the org slugs leak nowhere
  const soakEnv = `    environment:\n      ${W4_FLAG_NAME}: "org_secret_alpha,org_secret_beta"\n      ${W7_FLAG_NAME}: "org_secret_beta"\n`
  ;({ r, report } = run(overrideOf(soakEnv), { [W4_FLAG_NAME]: 0, [W7_FLAG_NAME]: 0 }))
  assert.equal(r.status, 0, `stderr=${r.stderr}\nreport=${report}`)
  assert.match(report, /^override_shape=soak-w4w7$/m)
  assert.ok(!r.stdout.includes('org_secret') && !r.stderr.includes('org_secret') && !report.includes('org_secret'),
    'org allowlist VALUES leaked into the classification output — the collection must be values-free (file-side canary from the fixture, live-side canary echoed by every rc=0 probe answer)')

  // mixture (one rd + one soak) -> unexpected, exit 1, but the report is still WRITTEN
  const mixEnv = `    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ${W4_FLAG_NAME}: "org_secret_alpha"\n`
  ;({ r, report } = run(overrideOf(mixEnv), { ATTENDANCE_SCHEDULER_ENABLED: 0, [W4_FLAG_NAME]: 0 }))
  assert.equal(r.status, 1, 'an unexpected shape must fail loud')
  assert.match(report, /^override_shape=unexpected$/m)

  // unknown UPPER key -> unexpected too (the pattern cannot be satisfied by novel flags)
  ;({ r, report } = run(overrideOf('    environment:\n      SOME_NOVEL_FLAG: "1"\n'), { }))
  assert.equal(r.status, 1)
  assert.match(report, /^override_shape=unexpected$/m)
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): drift and probe failure both fail loud, never green', () => {
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovdrift-'))
  const rdFile = `services:
  backend:
    image: x
    environment:
      ATTENDANCE_SCHEDULER_ENABLED: "true"
      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"
  web:
    image: x
`
  const overridePath = join(dir, 'ov.yml')
  writeFileSync(overridePath, rdFile)
  const script = (dockerBody) => `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { ${dockerBody}; }
${fn}
classify_runner_override
`
  // DRIFT: file says rd-window, container has only the scheduler flag -> match=false, exit 1.
  // The stub emulates the single sh -c enumerator: shadow printenv answers PATH + scheduler.
  const driftBody = `local body="$5"; shift 6; (
    printenv() { case "$1" in PATH|ATTENDANCE_SCHEDULER_ENABLED) echo "org_secret_live_canary"; return 0 ;; *) return 1 ;; esac; }
    eval "$body"
  )`
  let r = spawnSync('bash', ['-c', script(driftBody)], { encoding: 'utf8' })
  assert.equal(r.status, 1, `drift must fail loud; stderr=${r.stderr}`)
  let report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^override_shape=rd-window$/m)
  assert.match(report, /^file_live_match=false$/m)

  // PROBE FAILURE: docker exec rc=125 -> indeterminate, exit 1 — a zero-read is not a read of zero.
  r = spawnSync('bash', ['-c', script('return 125')], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'a failed probe must refuse to certify agreement')
  report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^file_live_match=indeterminate$/m)

  // P2-2 (gate on fa74e5cae1, MEASURED): a stopped container, a missing container and an
  // unreachable daemon all return rc=1 from docker exec — the SAME code as "var unset". The
  // first shape read rc=1-everywhere as four unset observations and printed a confident
  // file_live_match over zero observations. The PATH positive control makes this refuse instead.
  r = spawnSync('bash', ['-c', script('return 1')], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'rc=1-everywhere (container gone) must NOT read as an observation of unset')
  report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^file_live_match=indeterminate$/m)
  assert.match(report, /^live_flag_names=unobserved$/m, 'an unobserved live side must say so, not render as none')
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): a hostile candidate NAME cannot execute in-container — argv splice, not text splice', () => {
  // Requal-2 NIT, gate-measured on the text-splice form: a candidate containing $(…) really
  // executed inside the container. Candidates are constants today; the mechanism is dead anyway
  // now — names travel as argv after the `_` $0 slot and never enter the script text. The
  // harness forces a hostile name through SOAK_W7_ENV_NAME and pins that nothing executes.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovhostile-'))
  const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${dir}/absent.yml"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED"
SOAK_W7_ENV_NAME='$(touch "${dir}/pwned-marker")'
docker() { local body="$5"; shift 6; (
  printenv() { [[ "$1" == "PATH" ]] && return 0 || return 1; }
  eval "$body"
); }
${fn}
classify_runner_override
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  // Execution leaves no stdout trace (command substitution BECOMES the word), so the probe is a
  // filesystem side-effect: under the text-splice form the $(touch …) RUNS and the marker
  // appears; under the argv form the whole string is one inert argument.
  assert.ok(!existsSync(join(dir, 'pwned-marker')),
    'the hostile candidate name EXECUTED in-container — names are being spliced into the script text again')
  const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.ok(!report.includes('pwned'), 'hostile name leaked into the report')
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): a cross-block DUPLICATE name still refuses — counts, not only the deduped set', () => {
  // Requal-2 P3-a, gate-measured false on the set-only guard: a web-block key whose NAME already
  // appears in the backend block collapsed into the sort -u comparison — both-blocks duplicates
  // classified rd-window with a confident match. Occurrence counts close it.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovdup-'))
  const cases = [
    ['both-blocks-duplicate', `services:\n  backend:\n    image: x\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n  web:\n    image: x\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n`],
    ['web-dup-soak', `services:\n  backend:\n    image: x\n    environment:\n      ${W4_FLAG_NAME}: "org_secret_alpha"\n      ${W7_FLAG_NAME}: "org_secret_alpha"\n  web:\n    image: x\n    environment:\n      ${W7_FLAG_NAME}: "org_secret_alpha"\n`],
  ]
  for (const [label, body] of cases) {
    const overridePath = join(dir, `ov-${label}.yml`)
    writeFileSync(overridePath, body)
    const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { local body="$5"; shift 6; (
  printenv() { [[ "$1" == "PATH" ]] && return 0; return 1; }
  eval "$body"
); }
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 1, `${label}: a duplicated cross-block name must refuse, not classify`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, /^override_shape=unexpected$/m, `${label} classified as ${report.match(/override_shape=(.*)/)?.[1]}`)
    assert.ok(!report.includes('org_secret'), 'values leaked')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): tamper guard — an unasked NAME in the enumerator output refuses AND never reaches the report', () => {
  // Requal-2 P3-b: the guard existed but nothing exercised it (removal stayed 143/143 green). It
  // is diagnostic-only by construction — but what its removal costs is REPORT HONESTY:
  // unvalidated container stdout would land in live_flag_names in the uploaded artifact.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovtamper-'))
  const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${dir}/absent.yml"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { echo "EVIL_UNASKED_NAME"; return 0; }
${fn}
classify_runner_override
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'an unasked name in the channel must refuse certification')
  const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^file_live_match=indeterminate$/m)
  assert.match(report, /^live_flag_names=unobserved$/m)
  assert.ok(!report.includes('EVIL_UNASKED_NAME'), 'unvalidated container output reached the report')
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): env keys under the WRONG service never classify — backend-scoped parse', () => {
  // P2-2 (external review of 4141c27832): the round-1 grep collected every indented UPPER key in
  // the whole file, so two rd-window keys under services.web.environment classified as rd-window
  // and matched the BACKEND's live env — certifying agreement between one service's file entry
  // and a DIFFERENT service's runtime.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovsvc-'))
  const cases = [
    ['web-block', `services:\n  backend:\n    image: x\n  web:\n    image: x\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n`],
    ['both-blocks', `services:\n  backend:\n    image: x\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n  web:\n    image: x\n    environment:\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n`],
  ]
  for (const [label, body] of cases) {
    const overridePath = join(dir, `ov-${label}.yml`)
    writeFileSync(overridePath, body)
    const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { local b="$5"; shift 6; (
  printenv() { case "$1" in PATH|ATTENDANCE_SCHEDULER_ENABLED|ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED) echo v; return 0 ;; *) return 1 ;; esac; }
  eval "$b"
); }
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 1, `${label}: keys outside services.backend.environment must refuse, not classify`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, /^override_shape=unexpected$/m, `${label} classified as ${report.match(/override_shape=(.*)/)?.[1]}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (override classification): legal-but-unparsed environment spellings are UNEXPECTED, never a calm none', () => {
  // P2-3 (gate on fa74e5cae1): quoted keys, flow maps and list-form entries are legal compose
  // spellings the key parser does not read; each parsed as none — the CALM shape — inverting the
  // fail-loud principle. An environment block whose keys we cannot enumerate must refuse.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovspell-'))
  const spellings = [
    ['list-form', '    environment:\n      - ATTENDANCE_SCHEDULER_ENABLED=true\n'],
    ['flow-map', '    environment: { ATTENDANCE_SCHEDULER_ENABLED: "true" }\n'],
    ['quoted-key', '    environment:\n      "ATTENDANCE_SCHEDULER_ENABLED": "true"\n'],
  ]
  // …and the door is ANCHORED (requal P3 on 4141c27832): a comment MENTIONING environment: and
  // an image tag CONTAINING it are not environment blocks — both must stay a calm none.
  const nonBlocks = [
    ['comment-mention', '# deliberately no environment: block on purpose\n'],
    ['image-tag-substring', ''],
  ]
  for (const [label, prefix] of nonBlocks) {
    const overridePath = join(dir, `ov-nb-${label}.yml`)
    const image = label === 'image-tag-substring' ? 'ghcr.io/zensgit/environment:abc123' : 'x'
    writeFileSync(overridePath, `${prefix}services:\n  backend:\n    image: ${image}\n  web:\n    image: x\n`)
    const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { local b="$5"; shift 6; ( printenv() { [[ "$1" == "PATH" ]] && return 0 || return 1; }; eval "$b" ); }
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${label}: a mere mention of environment: must not fail a true none; stderr=${r.stderr}`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, /^override_shape=none$/m, `${label} classified as ${report.match(/override_shape=(.*)/)?.[1]}`)
  }
  for (const [label, envLines] of spellings) {
    const overridePath = join(dir, `ov-${label}.yml`)
    writeFileSync(overridePath, `services:\n  backend:\n    image: x\n${envLines}  web:\n    image: x\n`)
    const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { if [[ "$4" == "PATH" ]]; then return 0; else return 1; fi; }
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 1, `${label}: an unparseable environment block must fail loud`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, /^override_shape=unexpected$/m, `${label} classified as ${report.match(/override_shape=(.*)/)?.[1]}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('WIRING (override classification): action_status runs the classifier and the summary carries the shape', () => {
  const statusBody = executableLines(extractRunnerFunctions(['action_status']))
  assert.match(statusBody, /^\s*classify_runner_override \|\| status_rc=1/m,
    'action_status no longer runs the override classification (or its failure no longer reddens status_rc)')
  assert.match(statusBody, /^\s*grep '\^override_shape=' "\$\{OUTPUT_DIR\}\/override-shape\.txt"/m,
    'the status summary no longer carries the override shape')
})

test('WIRING (P1-2): the pipeline calls are present in the REAL apply path — deletion-mutation-provable', () => {
  // The gate on 5b4b38d925 proved the previous shape's hole with arithmetic: each of these three
  // CALLS could be deleted from the script with this whole suite still green at 132/132 — the
  // functions were tested, their wiring was not, and a tested-but-never-called guard is a claim,
  // not a check. These pins are function-scoped (extracted from the REAL runner source, not a
  // replica) so deleting the call site — the gate's exact mutation — reds here.
  const applyBody = executableLines(extractRunnerFunctions(['action_migrate_apply']))
  assert.match(applyBody, /^\s*compute_in_play_migrations "\$real_db"\s*$/m,
    'action_migrate_apply no longer computes the in-play set — the per-name confirmation below would confirm an empty list')
  assert.match(applyBody, /^\s*assert_applied_counts_agree "\$\{OUTPUT_DIR\}\/migration-applied-before\.txt" "\$\{OUTPUT_DIR\}\/apply-migrate-list-before\.txt"\s*$/m,
    'action_migrate_apply no longer cross-checks the applied counts — ledger-invisible exclusions regain cover')
  assert.match(applyBody, /^\s*confirm_in_play_migrations "\$\{OUTPUT_DIR\}\/migration-in-play\.txt"\s*$/m,
    'action_migrate_apply no longer name-confirms the in-play migrations — the exclusion canary is unwired')
})

test('WIRING (P2-4): BOTH signal-trap arm points in action_migrate, in ORDER — deletion-mutation-provable', () => {
  // Gate finding F3 on 5b4b38d925: the plain HUP/INT/TERM literal appears at TWO arm points and
  // the bare includes() in the registration test is satisfied by either — deleting either one
  // alone stayed green at 132/132. The second arm point matters because rehearsal installs its
  // OWN trap; without re-arming, the real-DB apply runs with the rehearsal-shaped trap gone and
  // the secret env-file survives a caught signal (the pre-hardening shape).
  const migrateBody = executableLines(extractRunnerFunctions(['action_migrate']))
  const arms = [...migrateBody.matchAll(/^\s*trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM\s*$/gm)].map((m) => m.index)
  assert.equal(arms.length, 2, `action_migrate must arm the signal trap at BOTH points, found ${arms.length}`)
  const precheckIdx = migrateBody.indexOf('action_migrate_read_only_prechecks')
  const rehearseIdx = migrateBody.indexOf('action_migrate_rehearse')
  const applyIdx = migrateBody.indexOf('action_migrate_apply')
  assert.ok(precheckIdx > 0 && rehearseIdx > 0 && applyIdx > 0, 'the migrate pipeline steps moved; re-anchor this test')
  assert.ok(arms[0] < precheckIdx, 'the first arm point must precede the read-only prechecks')
  assert.ok(rehearseIdx < arms[1] && arms[1] < applyIdx, 'the RE-arm must sit between rehearsal (which retraps) and the real-DB apply')
})

test('WIRING (F1): action_deploy inline migrate is exclusion-proof — hazard abort + forced MIGRATION_EXCLUDE=', () => {
  // Found independently by the 5b4b38d925 gate AND the external review: action=deploy migrated
  // via bare staging_exec in the RUNNING container, inheriting any container-level
  // MIGRATION_EXCLUDE — which is ledger-INVISIBLE (excluded names vanish from --list, so the
  // `Pending: 0` gate and the alignment report, which parses the same --list text with no
  // filesystem census of its own, both go green over unapplied migrations).
  const deployBody = executableLines(extractRunnerFunctions(['action_deploy']))
  assert.match(deployBody, /^\s*assert_deploy_migrate_env_safe\s*$/m, 'the hazard abort is unwired from action_deploy')
  const forced = [...deployBody.matchAll(/^\s*staging_exec_env "MIGRATION_EXCLUDE=" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "\$MIGRATE_JS"/gm)]
  assert.equal(forced.length, 3, `all three deploy-path MIGRATE_JS invocations must force ALL THREE hazard vars empty (N3; list-before, run, list-after); found ${forced.length}`)
  assert.ok(!/^\s*staging_exec node "\$MIGRATE_JS"/m.test(deployBody),
    'a bare staging_exec MIGRATE_JS reappeared in action_deploy — it inherits container MIGRATION_EXCLUDE')
})

test('EXECUTABLE (F1): assert_deploy_migrate_env_safe fails loud on a set hazard var, value never printed; passes when all three are unset', () => {
  const fn = extractRunnerFunctions(['assert_deploy_migrate_env_safe'])
  const outDir = mkdtempSync(join(tmpdir(), 'wr-probe-'))
  const harness = (dockerBody) => `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${outDir}"
BACKEND_CONTAINER="fake-backend"
fail() { echo "[window-runner][error] $*" >&2; exit 1; }
docker() { ${dockerBody}; }
${fn}
assert_deploy_migrate_env_safe
echo SAFE
`
  // Hazard set: printenv answers for MIGRATION_EXCLUDE.
  const bad = spawnSync('bash', ['-c', harness('if [[ "$4" == "MIGRATION_EXCLUDE" ]]; then echo "076_secret_name"; else return 1; fi')], { encoding: 'utf8' })
  assert.equal(bad.status, 1, `stderr=${bad.stderr}`)
  assert.match(bad.stderr, /MIGRATION_EXCLUDE/, 'the abort must NAME the hazard var')
  assert.ok(!bad.stderr.includes('076_secret_name') && !bad.stdout.includes('076_secret_name'),
    'the hazard VALUE must never be printed')
  // All clear: printenv finds nothing.
  const ok = spawnSync('bash', ['-c', harness('return 1')], { encoding: 'utf8' })
  assert.equal(ok.status, 0, `stderr=${ok.stderr}`)
  assert.match(ok.stdout, /SAFE/)
})

test('MUTATION (P2-4 registration): a runner registering only EXIT (pre-hardening shape) shows no HUP/INT/TERM in `trap -p`', () => {
  const cleanupFn = extractRunnerFunctions(['cleanup_target_migration_runtime'])
  // Pre-hardening shape: only EXIT is trapped.
  const script = `#!/bin/bash
set -u
TARGET_MIGRATION_ENV_FILE=""
${cleanupFn}
trap cleanup_target_migration_runtime EXIT
trap -p
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.doesNotMatch(r.stdout, /(SIGHUP|SIGINT|SIGTERM)/, 'proving the registration test above is discriminating: without the explicit trap call, trap -p shows nothing for HUP/INT/TERM')
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
    // posture walks, the shared password mint/hash helpers, the rotate_password act)
    // through the end of action_soak_seed — they are one action's body.
    seed: sliceBetween(remote, 'soak_seed_write_org_sql() {', '\naction_soak_flags() {', 'soak-seed'),
    // Rotation's OWN function text, precisely bounded — assertions below anchor here (not
    // to seed-wide substrings) so a mutation inside soak_seed_rotate_password cannot hide
    // behind an unrelated match elsewhere in the (much larger) seed slice.
    rotate: sliceBetween(remote, 'soak_seed_rotate_password() {', '\naction_soak_seed() {', 'soak-seed-rotate-password'),
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
    /"\$ACTION" == "deploy" \|\| "\$ACTION" == "migrate" \|\| "\$ACTION" == "smoke" \|\| "\$ACTION" == "soak-flags"/,
    'deploy_sha must be required for migrate and soak-flags (both are exact-image acts)',
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

  // soak-seed rotate_password=true: a standalone act that rotates ONLY the host-only
  // synthetic-user password + its DB hash for the EXISTING closed synthetic family. Every
  // assertion below anchors to slices.rotate (soak_seed_rotate_password's own text), not
  // to seed-wide substrings, per the taskʼs own anchoring rule.

  // Dispatch: action_soak_seed must read rotate_password, reject any value other than
  // 'true', refuse the three full-seed-only opts in the same invocation, and call the
  // rotation function ONLY from inside that guarded branch.
  assert.ok(
    slices.seed.includes("rotate_password=\"$(soak_opt rotate_password '')\""),
    'action_soak_seed must read rotate_password via soak_opt with an empty (non-rotating) default',
  )
  assert.ok(
    slices.seed.includes("rotate_password only accepts 'true'"),
    'a rotate_password value other than true/absent must be refused',
  )
  assert.ok(
    slices.seed.includes('rotate_password=true is a standalone act and refuses users_per_org/tz/w7_target'),
    'rotate_password=true must refuse if users_per_org/tz/w7_target are ALSO supplied',
  )
  for (const key of ['users_per_org', 'tz', 'w7_target']) {
    assert.ok(
      slices.seed.includes(`soak_opt_present ${key} && rotate_conflicts+=(${key})`),
      `the standalone-act guard must check PRESENCE (not resolved value) of ${key}`,
    )
  }
  const rotateDispatchIdx = slices.seed.indexOf("if [[ \"$rotate_password\" == \"true\" ]]; then")
  const rotateCallIdx = slices.seed.indexOf('soak_seed_rotate_password\n    return 0', rotateDispatchIdx)
  const requireOrgsIdx = slices.seed.indexOf('soak_require_orgs\n  mkdir -p "$SOAK_PERSIST_DIR"')
  assert.notEqual(rotateDispatchIdx, -1, 'action_soak_seed must branch on rotate_password=="true"')
  assert.notEqual(rotateCallIdx, -1, 'the rotate branch must call soak_seed_rotate_password and return 0')
  assert.ok(rotateDispatchIdx < rotateCallIdx, 'the call must sit inside the rotate_password=="true" branch')
  assert.ok(
    rotateCallIdx < requireOrgsIdx,
    'the rotate branch (and its return) must come BEFORE soak_require_orgs — rotation never reaches soak_orgs/owner_ref/entrypoint_inventory_ref requirements',
  )

  // soak_seed_rotate_password itself: missing-credentials-file fail-closed (never silently
  // mint), atomic tmp+mv replace with a recoverable .prev, prefix-scoped UPDATE with no
  // inserts/posture/seeding, and the plaintext password NEVER touching OUTPUT_DIR/logs.
  assert.ok(
    slices.rotate.includes('no credentials file exists at ${SOAK_CREDENTIALS_FILE} — nothing to rotate'),
    'rotation must fail closed (never silently mint) when the credentials file is absent',
  )
  const credGuardIdx = slices.rotate.indexOf('no credentials file exists')
  const mktempIdx = slices.rotate.indexOf('mktemp "${SOAK_PERSIST_DIR}/.credentials.XXXXXX"')
  assert.notEqual(mktempIdx, -1, 'rotation must write the new credentials file via a same-dir mktemp candidate (atomic replace)')
  assert.ok(credGuardIdx < mktempIdx, 'the missing-file guard must run BEFORE any credentials-file write')
  // NIT-1 (post-gate #5063 F-round): .prev is created with the SAME umask-077 idiom the
  // first-mint path uses (0600 from birth), not cp -p + a separate chmod.
  assert.ok(
    slices.rotate.includes('( umask 077 && cp "$SOAK_CREDENTIALS_FILE" "${SOAK_CREDENTIALS_FILE}.prev" )'),
    'rotation must preserve the pre-rotation credentials file as .prev (umask-077 idiom, 0600 from birth) before replacing it (recoverable botched rotation)',
  )
  assert.match(
    slices.rotate,
    /mv -f "\$cred_tmp" "\$SOAK_CREDENTIALS_FILE"/,
    'the credentials file replace must be an atomic same-dir rename',
  )
  // F4 (post-gate #5063): the recovery message on a nonzero DB-step exit must NOT assert
  // "nothing committed" as fact (a transport failure can occur AFTER a real COMMIT) — it
  // must tell the operator how to check (ROTATE_RESULT + COMMIT both present) before ever
  // touching .prev.
  assert.ok(
    slices.rotate.includes('does NOT prove nothing committed'),
    'the DB-step failure message must not overclaim that nothing committed',
  )
  assert.ok(
    slices.rotate.includes("check soak-seed-rotate.txt for 'ROTATE_RESULT ...' followed by 'COMMIT'"),
    'the DB-step failure message must tell the operator how to verify commit status before restoring .prev',
  )
  assert.ok(
    slices.rotate.includes('must NOT be restored'),
    'the DB-step failure message must warn against restoring .prev when the DB may already be rotated',
  )
  // The credentials swap must run BEFORE the DB step (only then is a failed DB step a
  // "botched rotation" the .prev file can recover from — see the recovery message above).
  const credSwapIdx = slices.rotate.indexOf('mv -f "$cred_tmp" "$SOAK_CREDENTIALS_FILE"')
  const updateIdx = slices.rotate.indexOf('UPDATE users')
  assert.ok(credSwapIdx < updateIdx, 'the credentials-file swap must happen BEFORE the DB step')
  // #4931-class C9 pin: the psql -v COMPOSITION is what scopes the UPDATE, not just the
  // WHERE-clause text — a bare "%" here would rewrite every staging password_hash while
  // every other assertion in this block stays green.
  assert.ok(
    slices.rotate.includes('-v user_prefix="${SOAK_USER_PREFIX}%"'),
    'the rotate UPDATE psql invocation must scope user_prefix to the closed synthetic family prefix (a bare "%" rewrites every staging password_hash)',
  )
  assert.match(
    slices.rotate,
    /UPDATE users SET password_hash = v_pw_hash WHERE username LIKE v_user_prefix;/,
    'the rotate SQL must be exactly this prefix-scoped UPDATE (no other column, no other WHERE)',
  )
  assert.doesNotMatch(slices.rotate, /INSERT\s+INTO/i, 'rotation must never INSERT — it only re-hashes existing rows')
  assert.doesNotMatch(slices.rotate, /attendance_shifts|attendance_group|SOAK_W4C5_CLI|SOAK_W7_CLI/, 'rotation must never touch shift/group config or the posture CLIs')

  // F1 (post-gate #5063): psql -e (echo-queries) prints the interpolated bcrypt hash into
  // OUTPUT_DIR — a world-downloadable CI artifact. The rotate psql invocation must carry
  // NEITHER -e (the leak) NOR -q (verified empirically: -q silences the RAISE NOTICE the
  // row-count parse below depends on, so that "fix" would break rotation silently while
  // staying green). Anchored to the invocation's own two-line call site, not slice-wide.
  const rotatePsqlCallIdx = slices.rotate.indexOf('docker exec -i "$POSTGRES_CONTAINER" psql')
  assert.notEqual(rotatePsqlCallIdx, -1, 'expected the rotate psql invocation')
  const rotatePsqlCall = slices.rotate.slice(rotatePsqlCallIdx, slices.rotate.indexOf('\n', slices.rotate.indexOf('\n', rotatePsqlCallIdx) + 1) + 1)
  assert.doesNotMatch(rotatePsqlCall, /\s-e\s/, 'the rotate psql invocation must NEVER carry -e (echoes the interpolated bcrypt hash into the OUTPUT_DIR artifact)')
  assert.doesNotMatch(rotatePsqlCall, /\s-q\s/, 'the rotate psql invocation must NEVER carry -q (silences the RAISE NOTICE the row-count parse depends on)')
  // psql client-side `:'var'` substitution does not reach inside a `DO $$ ... $$` body —
  // verified empirically against a real postgres:16 (a naive :'user_prefix' there is a
  // syntax error, not merely untested). The SQL must route values through a transaction-
  // local GUC (set_config/current_setting) instead, and must suppress the SELECT
  // set_config(...) result printout via \gset (a bare SELECT would itself echo the hash).
  assert.doesNotMatch(slices.rotate, /:'user_prefix'[\s\S]{0,40}\$\$/, 'no :\'user_prefix\' token may appear inside a dollar-quoted DO body (psql will not substitute it there)')
  assert.ok(slices.rotate.includes("set_config('rotate.pw_hash', :'pw_hash', true)"), 'the hash must be routed into the DO block via a transaction-local set_config, substituted OUTSIDE any dollar-quoted body')
  assert.match(slices.rotate, /SELECT set_config\('rotate\.pw_hash', :'pw_hash', true\) AS _discard \\gset/, 'the set_config call for the hash must suppress its own result printout via \\gset (a bare SELECT echoes the hash)')
  assert.ok(slices.rotate.includes("current_setting('rotate.pw_hash')"), 'the DO block must read the hash back via current_setting, not a psql : token')

  // F2 (post-gate #5063): a rotation that matches ZERO family rows must never report
  // result=ok — the DB genuinely was not touched (an UPDATE matching 0 rows changes
  // nothing), so this auto-restores .prev rather than leaving a credentials file that
  // matches no DB user.
  assert.ok(
    slices.rotate.includes('(( rotated_users > 0 ))'),
    'rotation must require rotated_users > 0, not just "is it a number" (a 0-row match must not report result=ok)',
  )
  const zeroGuardIdx = slices.rotate.indexOf('(( rotated_users > 0 ))')
  const zeroRestoreIdx = slices.rotate.indexOf('mv -f "${SOAK_CREDENTIALS_FILE}.prev" "$SOAK_CREDENTIALS_FILE"')
  assert.notEqual(zeroRestoreIdx, -1, 'the 0-row path must restore .prev onto the credentials file')
  assert.ok(zeroGuardIdx < zeroRestoreIdx, 'the >0 guard must gate the .prev restore (not the other way round)')
  assert.ok(
    slices.rotate.includes("matched 0 users for username LIKE '${SOAK_USER_PREFIX}%'"),
    'the 0-row failure message must name the exact predicate that matched nothing',
  )
  assert.ok(
    slices.rotate.includes('restored the pre-rotation credentials file'),
    'the 0-row failure message must state what was restored',
  )

  // F-round-2 (post-gate #5063 round 2, P3): RAISE NOTICE is gated by client_min_messages
  // — a session running at the postgres default of 'warning' would silently DROP the
  // ROTATE_RESULT line even though the transaction committed, which breaks the F4 recovery
  // rule ('markers absent' must reliably mean 'did not commit'). Verified empirically
  // against a real postgres:16 both ways (default session AND PGOPTIONS=-c
  // client_min_messages=warning) — see the PR body for the exact evidence.
  assert.ok(
    slices.rotate.includes('SET LOCAL client_min_messages = notice;'),
    'the rotation transaction must force client_min_messages=notice so ROTATE_RESULT is never silently dropped by a warning-level session default',
  )
  const beginIdx = slices.rotate.indexOf('\nBEGIN;\n')
  const clientMinMsgIdx = slices.rotate.indexOf('SET LOCAL client_min_messages = notice;')
  const setConfigIdx = slices.rotate.indexOf("SELECT set_config('rotate.user_prefix'")
  assert.notEqual(beginIdx, -1, 'expected the rotate transaction BEGIN')
  assert.ok(beginIdx < clientMinMsgIdx, 'client_min_messages must be set AFTER BEGIN (LOCAL is transaction-scoped)')
  assert.ok(clientMinMsgIdx < setConfigIdx, 'client_min_messages must be set BEFORE anything that could RAISE NOTICE later in the transaction')

  // F3 (post-gate #5063): blast-radius, inside the SAME transaction, before COMMIT — a
  // ceiling sanity (999, defense-in-depth, explicitly NOT a derived family-size bound —
  // the family accumulates across dispatches with no hard cap), the UPDATE's row count
  // must equal a pre-count on the same predicate, and the UPDATE must not have left
  // NOTHING un-matched (the mis-composed "%" case, on top of the static C9 pin above).
  assert.ok(slices.rotate.includes('family_count > 999'), 'rotation must refuse a family bigger than the 999 sanity ceiling')
  assert.ok(slices.rotate.includes('999 sanity ceiling'), 'the ceiling refusal must be self-documenting')
  assert.ok(slices.rotate.includes('NOT a derived bound'), 'the ceiling must be documented as defense-in-depth, not a tight family-size bound (the family accumulates across dispatches)')
  assert.ok(slices.rotate.includes('GET DIAGNOSTICS updated_count = ROW_COUNT'), 'rotation must read the ACTUAL UPDATE row count via GET DIAGNOSTICS, not assume it equals the pre-count')
  assert.ok(slices.rotate.includes('updated_count <> family_count'), 'rotation must refuse if the UPDATE touched a different count than the family pre-count (concurrent-write guard)')
  assert.ok(slices.rotate.includes('username NOT LIKE v_user_prefix'), 'rotation must verify the UPDATE left at least one row un-matched')
  assert.ok(slices.rotate.includes('updated_count > 0 AND untouched_count = 0'), 'the "touched everything" refusal must only fire when rows were actually touched (an empty-family run must not false-positive)')
  // These three checks must all run BEFORE the COMMIT that would persist the UPDATE.
  const ceilingIdx = slices.rotate.indexOf('family_count > 999')
  const doUpdateIdx = slices.rotate.indexOf('UPDATE users SET password_hash')
  const blastRadiusIdx = slices.rotate.indexOf('updated_count > 0 AND untouched_count = 0')
  const commitIdx = slices.rotate.indexOf('\nCOMMIT;')
  assert.ok(ceilingIdx < doUpdateIdx, 'the ceiling check must run BEFORE the UPDATE')
  assert.ok(doUpdateIdx < blastRadiusIdx && blastRadiusIdx < commitIdx, 'the blast-radius checks must run AFTER the UPDATE but BEFORE COMMIT')

  // NIT-2 (post-gate #5063): the owner_ref/entrypoint_inventory_ref asymmetry (refused
  // for users_per_org/tz/w7_target, but NOT for these two) must be documented, not silent.
  assert.ok(
    slices.rotate.includes('owner_ref / entrypoint_inventory_ref asymmetry'),
    'the asymmetry with the users_per_org/tz/w7_target refusal must be documented in the function header',
  )
  // F5 (post-gate #5063): the single-generation .prev limitation must be documented (the
  // owner-facing choice was to document it, given F2's auto-restore removes the common
  // repeat-failure trigger, rather than add a second .prev2 generation).
  assert.ok(
    slices.rotate.includes('SINGLE generation'),
    'the .prev single-generation limitation must be documented in the function header',
  )
  assert.match(slices.rotate, /\\set ON_ERROR_STOP on\nBEGIN;/, 'the rotate UPDATE must run inside a stop-on-error transaction')
  assert.ok(slices.rotate.includes('rotated_users=${rotated_users}'), 'the summary must record the rotated-user count')
  assert.ok(slices.rotate.includes('echo "rotated=1"'), 'the summary must record rotated=1')
  // Structural (not textual) proof the plaintext password is never printed: every line in
  // soak_seed_rotate_password that mentions the variable must be free of echo/tee/>>/OUTPUT_DIR.
  const passwordLines = slices.rotate.split('\n').filter((l) => l.includes('new_password'))
  assert.ok(passwordLines.length >= 2, 'expected new_password to appear (mint + the one sanctioned credentials-file write)')
  for (const line of passwordLines) {
    assert.doesNotMatch(line, /\bOUTPUT_DIR\b/, `password variable must never touch OUTPUT_DIR: ${line}`)
    assert.doesNotMatch(line, />>/, `password variable must never be appended (>>): ${line}`)
    assert.doesNotMatch(line, /\btee\b/, `password variable must never flow through tee: ${line}`)
    assert.doesNotMatch(line, /\becho\b/, `password variable must never be echoed: ${line}`)
  }

  // Shared generator/hasher: exactly ONE implementation each, used by both the first-mint
  // path and rotate_password=true (proves "same generator as the first-mint path").
  assert.equal(
    (remote.match(/head -c 24 \/dev\/urandom/g) || []).length,
    1,
    'the password generator must be a single shared implementation (soak_mint_password)',
  )
  assert.equal(
    (remote.match(/const b = require\("bcryptjs"\)/g) || []).length,
    1,
    'the bcrypt-in-container hasher must be a single shared implementation (soak_hash_password_in_backend)',
  )
  assert.ok(slices.seed.includes('password="$(soak_mint_password)"'), 'the first-mint path must call the shared generator')
  assert.ok(slices.rotate.includes('new_password="$(soak_mint_password)"'), 'rotate_password must call the SAME shared generator as the first-mint path')
  assert.ok(slices.seed.includes('pw_hash="$(soak_hash_password_in_backend "$password")"'), 'the first-mint path must call the shared hasher')
  assert.ok(slices.rotate.includes('new_hash="$(soak_hash_password_in_backend "$new_password")"'), 'rotate_password must call the SAME shared hasher as the first-mint path')

  // The staging-only guard runs UNCONDITIONALLY before the action dispatch (main, bottom of
  // the file) — rotation inherits it structurally without needing its own call.
  assert.ok(
    remote.includes('assert_staging_only\n\ncase "$ACTION" in'),
    'assert_staging_only must run before the action dispatch switch, so rotate_password=true (routed through soak-seed) inherits it unconditionally',
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
    '[Q17]', '[Q18]',
  ]) {
    assert.ok(slices.status.includes(label), `soak-status must run the monitoring-pack ${label} read`)
  }
  // Q17/Q18 are pinned at their CALL SITES (gate #5041 P2): the bare label check above is
  // satisfied by the section comment alone, so deleting both reads stayed green. Each predicate
  // pin is anchored to ITS OWN captured invocation (gate round-2 P3): `GROUP BY r.org_id` and the
  // SOAK_USER_PREFIX key also occur in Q1/Q2, so a slice-wide match was vacuous for Q17. The
  // capture runs to the closing `;"` of the SQL argument (gate round-3 P3): a bash double-quoted
  // argument may span lines, and a two-line capture let a third-line restriction hide from the
  // negative `doesNotMatch` pin.
  const q17Match = slices.status.match(/soak_status_rows "\[Q17\] synthetic-account attendance_records by ACTUAL org_id[\s\S]*?;"/)
  assert.ok(q17Match, 'Q17 read must be invoked (call site, not just the section comment)')
  const q17 = q17Match[0]
  assert.doesNotMatch(q17, /SOAK_ORG[123]/, 'Q17 must NOT be restricted to the soak orgs — that restriction is the blind spot it exists to remove')
  assert.match(q17, /GROUP BY r\.org_id/, 'Q17 must group by the ACTUAL org_id')
  assert.match(q17, /u\.username LIKE '\$\{SOAK_USER_PREFIX\}%'/, 'Q17 must key on SOAK_USER_PREFIX, not a hardcoded prefix')
  const q18Match = slices.status.match(/soak_status_rows "\[Q18\] tester \(u01\) attendance_records rows[\s\S]*?;"/)
  assert.ok(q18Match, 'Q18 read must be invoked (call site, not just the section comment)')
  const q18 = q18Match[0]
  assert.match(q18, /to_jsonb\(r\) - 'id' - 'user_id' - 'org_id'/, 'Q18 must stay column-agnostic via to_jsonb')
  assert.match(q18, /u\.username LIKE '\$\{SOAK_USER_PREFIX\}%-u01'/, 'Q18 must select the tester (u01) accounts via SOAK_USER_PREFIX')
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
    /state NOT IN \('legacy','shadow'\) OR \(state = 'legacy' AND prior_state IS NOT NULL\) OR changed_at >= '\$\{window_start\}'::timestamptz/,
    'Q3b must catch the rolled-back shape, out-of-plan states, AND any in-window posture change (forward walks land on nominal-looking shapes)',
  )
  // #4975 gate round-2 P3: the window scope is load-bearing on BOTH legacy branches.
  assert.match(
    q2Sql,
    /r\.created_at >= '\$\{window_start\}'::timestamptz AND r\.created_at < now\(\)/,
    '[Q2]ʼs legacy branch must be window-scoped too',
  )
  assert.ok(
    slices.status.includes('alerts+=("Q3b_posture_constancy_violations'),
    'a posture-constancy violation must raise a mechanical alert',
  )
  // Post-merge review P3: [Q14]'s universe must also be the config closed set — the
  // posture-derived universe rendered a two-row summary that hid the control org.
  const q14Idx = slices.status.indexOf('[Q14] posture-state distribution')
  const q14Sql = slices.status.slice(q14Idx, slices.status.indexOf('posture rows for the three soak orgs', q14Idx))
  assert.match(
    q14Sql,
    /FROM \(VALUES \('\$\{SOAK_ORG1\}'\),\('\$\{SOAK_ORG2\}'\),\('\$\{SOAK_ORG3\}'\)\) AS target\(org_id\)/,
    '[Q14] must derive its universe from the config closed set (a posture-derived universe omits the legacy control org)',
  )
  assert.doesNotMatch(
    q14Sql,
    /SELECT DISTINCT org_id FROM attendance_calculation_rollout_state UNION/,
    '[Q14] must not fall back to the posture-derived universe',
  )
  const q3Idx = slices.status.indexOf('[Q3] org/posture classification')
  const q3Sql = slices.status.slice(q3Idx, slices.status.indexOf('[Q4a]', q3Idx))
  assert.match(
    q3Sql,
    /FROM \(VALUES \('\$\{SOAK_ORG1\}'\),\('\$\{SOAK_ORG2\}'\),\('\$\{SOAK_ORG3\}'\)\) AS target\(org_id\)/,
    '[Q3] universe must be the config closed set — a posture-derived universe structurally omits the legacy control org',
  )
  assert.doesNotMatch(
    q3Sql,
    /SELECT DISTINCT org_id FROM attendance_calculation_rollout_state UNION/,
    '[Q3] must not fall back to the posture-derived universe',
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
  // Position-bounded: locate the VALUES clause INSIDE the [Q3] block (both [Q2] and [Q14]
  // now carry closed-set joins of their own — third anchor-ambiguity of this family).
  const q3Start = original.indexOf('[Q3] org/posture classification')
  const q3End = original.indexOf('[Q4a]', q3Start)
  const valuesClause = "FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id)"
  const at = original.indexOf(valuesClause, q3Start)
  assert.ok(q3Start !== -1 && at !== -1 && at < q3End, 'mutation anchor must hit the Q3 closed-set universe inside the Q3 block')
  const mutated = original.slice(0, at)
    + 'FROM (SELECT DISTINCT org_id FROM attendance_calculation_rollout_state UNION SELECT DISTINCT org_id FROM attendance_calculation_context_source_state) target'
    + original.slice(at + valuesClause.length)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /structurally omits the legacy control org/,
  )
})

test('MUTATION (legacy control): reverting [Q14] to the posture-derived universe turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const q14Anchor = "org-count summary; config closed set)\" \\"
  assert.ok(original.includes(q14Anchor), 'mutation anchor must hit the Q14 header')
  const q14Start = original.indexOf(q14Anchor)
  const q14End = original.indexOf('posture rows for the three soak orgs', q14Start)
  const closedSet = original.indexOf("FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id) LEFT JOIN attendance_calculation_rollout_state w4 ON w4.org_id = target.org_id LEFT JOIN attendance_calculation_context_source_state w7", q14Start)
  assert.ok(q14Start !== -1 && q14End !== -1 && closedSet !== -1 && closedSet < q14End, 'mutation anchor must hit Q14ʼs closed-set universe inside the Q14 block')
  const mutated = original.slice(0, closedSet)
    + original.slice(closedSet).replace(
      "FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id)",
      'FROM (SELECT DISTINCT org_id FROM attendance_calculation_rollout_state UNION SELECT DISTINCT org_id FROM attendance_calculation_context_source_state) target',
    )
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    // Q14's OWN message only (#5008 gate P2: the loose /omits the legacy control org/ was
    // a substring of Q3's message too, so the oracle could not tell which site it tested).
    /\[Q14\] must derive its universe/,
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

// --- rotate_password=true MUTATION legs -------------------------------------------------
// Same convention as above: mutate the shipped soak_seed_rotate_password/action_soak_seed
// text in memory and prove assertSoakContract turns red for the RIGHT reason (the message
// each assertion pins), not just "some assertion somewhere failed".

test('MUTATION (rotate C9): unscoping the rotate UPDATEʼs user_prefix to "%" turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = '-v user_prefix="${SOAK_USER_PREFIX}%"'
  assert.ok(original.includes(anchor), 'mutation anchor must exist')
  const mutated = original.replace(anchor, '-v user_prefix="%"')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /a bare "%" rewrites every staging password_hash/,
  )
})

test('MUTATION (gate #5063 F1): adding -e back to the rotate psql invocation turns the soak contract red (it would echo the interpolated bcrypt hash into OUTPUT_DIR)', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = 'docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" \\\n    -v pw_hash="$new_hash"'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(
    anchor,
    'docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -e \\\n    -v pw_hash="$new_hash"',
  )
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /must NEVER carry -e/,
  )
})

test('MUTATION (gate #5063 F1): switching the rotate psql invocation to -q turns the soak contract red (the obvious-looking "fix" that silently breaks rotation)', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = 'docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" \\\n    -v pw_hash="$new_hash"'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(
    anchor,
    'docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -q \\\n    -v pw_hash="$new_hash"',
  )
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /must NEVER carry -q/,
  )
})

test('MUTATION (gate #5063 F2): removing the rotated_users > 0 guard turns the soak contract red (the gate\'s M4 gap)', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = '(( rotated_users > 0 )) \\'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(anchor, 'true \\')
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rotation must require rotated_users > 0/,
  )
})

test('MUTATION (gate #5063 F3): removing the pre-COMMIT blast-radius check turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = "  IF updated_count > 0 AND untouched_count = 0 THEN\n    RAISE EXCEPTION 'rotate_password blast-radius check failed: the UPDATE touched % row(s) and left NOTHING un-matched (0 rows are NOT LIKE %) - refusing what looks like a full-table rewrite', updated_count, v_user_prefix;\n  END IF;\n\n"
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(anchor, '')
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /the "touched everything" refusal must only fire when rows were actually touched/,
  )
})

test('MUTATION (gate #5063 F3): removing the family-count ceiling check turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = "  IF family_count > 999 THEN\n    RAISE EXCEPTION 'rotate_password refuses: % users match username LIKE % - exceeds the 999 sanity ceiling (defense-in-depth, not the real family size)', family_count, v_user_prefix;\n  END IF;\n\n"
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(anchor, '')
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rotation must refuse a family bigger than the 999 sanity ceiling/,
  )
})

test('MUTATION (gate #5063 round-2, P3): removing SET LOCAL client_min_messages turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = 'SET LOCAL client_min_messages = notice;\n'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(anchor, '')
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /the rotation transaction must force client_min_messages=notice/,
  )
})

test('MUTATION: deleting the rotate missing-credentials-file guard turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = '  [[ -f "$SOAK_CREDENTIALS_FILE" ]] \\\n    || fail "rotate_password=true but no credentials file exists at ${SOAK_CREDENTIALS_FILE} — nothing to rotate (run action=soak-seed once, without rotate_password, first)"\n'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(anchor, '')
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rotation must fail closed \(never silently mint\) when the credentials file is absent/,
  )
})

test('MUTATION: widening rotate_password to accept any value turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = "rotate_password only accepts 'true' (or omit the key entirely), got '${rotate_password}'"
  assert.ok(original.includes(anchor), 'mutation anchor must exist')
  const mutated = original.replace(anchor, 'ignored — any value accepted')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /a rotate_password value other than true\/absent must be refused/,
  )
})

test('MUTATION: dropping the standalone-act conflict guard (users_per_org/tz/w7_target) turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = "soak_opt_present w7_target && rotate_conflicts+=(w7_target)"
  assert.ok(original.includes(anchor), 'mutation anchor must exist')
  const mutated = original.replace(anchor, '# removed w7_target conflict check')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /the standalone-act guard must check PRESENCE/,
  )
})

test('MUTATION: printing the plaintext password into OUTPUT_DIR turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = 'printf \'SOAK_SYNTH_PASSWORD=%s\\n\' "$new_password" > "$cred_tmp"'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(
    anchor,
    `${anchor}\n  echo "debug: rotated to $new_password" >> "\${OUTPUT_DIR}/debug.log"`,
  )
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /password variable must never touch OUTPUT_DIR/,
  )
})

test('MUTATION: an INSERT slipped into the rotate SQL turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const anchor = 'UPDATE users SET password_hash = v_pw_hash WHERE username LIKE v_user_prefix;'
  assert.ok(slices.rotate.includes(anchor), 'mutation anchor must hit the rotate slice')
  const mutatedRotate = slices.rotate.replace(
    anchor,
    `INSERT INTO users (id) VALUES (gen_random_uuid());\n  ${anchor}`,
  )
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rotation must never INSERT/,
  )
})

test('MUTATION: dropping rotated=1 from the rotate summary turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const anchor = 'echo "rotated=1"'
  assert.ok(original.includes(anchor), 'mutation anchor must exist')
  const mutated = original.replace(anchor, '# rotated flag removed')
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /the summary must record rotated=1/,
  )
})

test('MUTATION: reordering the DB step before the credentials-file swap turns the soak contract red (would make .prev meaningless)', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  // Swap the two ordering anchors so the UPDATE textually precedes the mv -f swap.
  const swapAnchor = 'mv -f "$cred_tmp" "$SOAK_CREDENTIALS_FILE"'
  const updateAnchor = 'UPDATE users SET password_hash = v_pw_hash WHERE username LIKE v_user_prefix;'
  assert.ok(slices.rotate.includes(swapAnchor) && slices.rotate.includes(updateAnchor), 'mutation anchors must hit the rotate slice')
  const swapIdx = slices.rotate.indexOf(swapAnchor)
  const updateIdx = slices.rotate.indexOf(updateAnchor)
  assert.ok(swapIdx < updateIdx, 'precondition: swap currently precedes update')
  // Move the swap line to just AFTER the update block (reversing the real order).
  const withoutSwap = slices.rotate.slice(0, swapIdx) + slices.rotate.slice(swapIdx + swapAnchor.length)
  const reinsertAt = withoutSwap.indexOf(updateAnchor) + updateAnchor.length
  const mutatedRotate = withoutSwap.slice(0, reinsertAt) + '\n  ' + swapAnchor + withoutSwap.slice(reinsertAt)
  const mutated = original.replace(slices.rotate, () => mutatedRotate)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /the credentials-file swap must happen BEFORE the DB step/,
  )
})

test('MUTATION: physically reordering soak_require_orgs to precede the rotate_password dispatch turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const slices = extractSoakSlices(original)
  const dispatchAnchor = 'if [[ "$rotate_password" == "true" ]]; then'
  const requireOrgsAnchor = 'soak_require_orgs\n  mkdir -p "$SOAK_PERSIST_DIR"'
  const dispatchIdx = slices.seed.indexOf(dispatchAnchor)
  const requireOrgsIdx = slices.seed.indexOf(requireOrgsAnchor)
  assert.ok(dispatchIdx !== -1 && requireOrgsIdx !== -1 && dispatchIdx < requireOrgsIdx, 'preconditions: real order is dispatch-block, then require_orgs')
  // Physically swap: move the require_orgs+mkdir line to run BEFORE the rotate dispatch
  // block (everything from `if [[ "$rotate_password"...` up to that line), reversing the
  // real order the ordering assertion pins.
  const before = slices.seed.slice(0, dispatchIdx)
  const dispatchBlock = slices.seed.slice(dispatchIdx, requireOrgsIdx)
  const after = slices.seed.slice(requireOrgsIdx + requireOrgsAnchor.length)
  const mutatedSeed = before + requireOrgsAnchor + '\n  ' + dispatchBlock + after
  const mutated = original.replace(slices.seed, () => mutatedSeed)
  assert.notEqual(mutated, original, 'mutation must change the file')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /rotation never reaches soak_orgs\/owner_ref\/entrypoint_inventory_ref requirements/,
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

// --- rotate_password=true workflow-validation legs ---------------------------------------
// soak_orgs stays a REQUIRED workflow input for action=soak-seed regardless of
// rotate_password (present-and-ignored, like owner_ref) — the exact dispatch command an
// operator uses for rotation still supplies -f soak_orgs=... (verified empirically here,
// not assumed from the taskʼs own dispatch-command shorthand).

test('rotate_password: a rotation dispatch WITH soak_orgs supplied passes workflow validation', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'rotate_password=true' })
  assert.equal(r.status, 0, `rotation dispatch with soak_orgs must pass validation; stderr: ${r.stderr}`)
})

test('rotate_password: soak_orgs is STILL required at the workflow layer even for rotate_password=true (present-and-ignored, not exempt)', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: '', SOAK_OPTS: 'rotate_password=true' })
  assert.equal(r.status, 2, `empty soak_orgs must still be rejected for action=soak-seed; got ${r.status}, stdout: ${r.stdout}`)
  assert.match(r.stderr, /soak_orgs must be exactly 3 comma-separated org UUIDs/, 'rejection must name the soak_orgs requirement')
})

test('rotate_password: users_per_org ALONGSIDE rotate_password=true still passes WORKFLOW validation (the conflict refusal is a script-level, not workflow-level, guard)', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'rotate_password=true;users_per_org=5' })
  assert.equal(r.status, 0, `workflow validation only shape-checks each key independently; stderr: ${r.stderr}`)
})

for (const badValue of ['false', '1', 'TRUE', 'yes']) {
  test(`rotate_password invalid-value negative (workflow layer): rotate_password=${badValue} is REJECTED`, () => {
    const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: `rotate_password=${badValue}` })
    assert.equal(r.status, 2, `rotate_password=${badValue} must be rejected (exit 2); got ${r.status}, stdout: ${r.stdout}`)
    assert.match(r.stderr, /rotate_password only accepts 'true'/, 'rejection must name the rotate_password value rule')
  })
}

test('rotate_password: an unrelated action carrying rotate_password in soak_opts is rejected (soak_opts scoping unchanged)', () => {
  const r = runWorkflowValidation({ ACTION: 'status', SOAK_ORGS: '', SOAK_OPTS: 'rotate_password=true' })
  assert.equal(r.status, 2, `soak_opts must stay scoped to soak actions; got ${r.status}, stdout: ${r.stdout}`)
  assert.match(r.stderr, /soak_opts is only meaningful for soak actions/)
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

// extractRunnerLine: same idea as extractRunnerFunctions, for single-physical-line
// functions (log/fail) that extractRunnerFunctions canʼt match (its regex requires a
// newline before the closing brace). Extracting these VERBATIM — rather than paraphrasing
// them in a probe script — matters: the shipped log() writes to STDOUT, and a paraphrased
// stand-in that flipped it to stderr would invert a stdout-marker assertion below.
function extractRunnerLine(name) {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const m = remote.match(new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm'))
  assert.ok(m, `${name} must exist as a single-line function in the runner`)
  return m[0]
}

function extractRunnerVar(name) {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const m = remote.match(new RegExp(`^${name}=.*$`, 'm'))
  assert.ok(m, `expected a top-level assignment: ${name}`)
  return m[0]
}

/**
 * Minimal, REAL bash harness for action_soak_seed's rotate_password dispatch — extracts the
 * shipped fail/log, the SOAK_OPTS/SOAK_OPT_VALUE_RE globals, soak_validate_opts/soak_opt/
 * soak_opt_present, and action_soak_seed itself verbatim from the runner. The two functions
 * action_soak_seed calls at its two exit branches (soak_seed_rotate_password and
 * soak_require_orgs) are STUBBED to a one-line marker-and-return by default so each test
 * proves ONLY the dispatch/guard logic — never masked by (or accidentally dependent on)
 * downstream docker/psql calls that arenʼt available in this test environment. Pass
 * `real: true` for either to extract the REAL function instead (used by the missing-
 * credentials-file test, whose guard is the first line of the real function and needs no
 * docker/psql to prove).
 */
function buildActionSoakSeedProbe({ realRotate = false, realRequireOrgs = false } = {}) {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const failLine = extractRunnerLine('fail')
  const logLine = extractRunnerLine('log')
  const optsRe = extractRunnerVar('SOAK_OPTS_RE')
  const optValueRe = extractRunnerVar('SOAK_OPT_VALUE_RE')
  const optFns = extractRunnerFunctions(['soak_validate_opts', 'soak_opt', 'soak_opt_present'])
  // action_soak_seed itself is extracted via sliceBetween (marker-bounded), NOT
  // extractRunnerFunctions: its body embeds a `python3 - <<'PY' ... PY` block whose Python
  // dict literal closes with a column-0 `}`, which extractRunnerFunctionsʼ brace-counting
  // regex misreads as the bash function's own end — silently truncating mid-function and
  // producing an unbalanced (syntax-error) probe script.
  const actionSoakSeed = sliceBetween(remote, 'action_soak_seed() {', '\naction_soak_flags() {', 'action_soak_seed')
  const coreFns = optFns + '\n' + actionSoakSeed
  const rotateFn = realRotate
    ? extractRunnerFunctions(['soak_seed_rotate_password', 'soak_mint_password', 'soak_hash_password_in_backend', 'soak_resolve_pg', 'soak_psql_ta'])
    : 'soak_seed_rotate_password() { echo "ROTATE_CALLED"; }'
  const requireOrgsFn = realRequireOrgs
    ? extractRunnerFunctions(['soak_require_orgs'])
    : 'soak_require_orgs() { echo "REQUIRE_ORGS_CALLED"; exit 0; }'
  return `#!/bin/bash
set -u
${failLine}
${logLine}
${optsRe}
${optValueRe}
SOAK_USER_PREFIX="synth-w4w7-"
${requireOrgsFn}
${rotateFn}
${coreFns}
action_soak_seed
`
}

function runActionSoakSeedProbe(soakOpts, opts = {}, extraEnv = {}) {
  const script = buildActionSoakSeedProbe(opts)
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, SOAK_OPTS: soakOpts, ...extraEnv },
  })
}

test('rotate_password EXECUTABLE (a): rotation is invoked ONLY when rotate_password=true — the real dispatch branch, run for real', () => {
  const without = runActionSoakSeedProbe('')
  assert.equal(without.status, 0, `expected clean exit; stderr: ${without.stderr}`)
  assert.match(without.stdout, /REQUIRE_ORGS_CALLED/, 'without rotate_password, the normal soak_require_orgs path must run')
  assert.doesNotMatch(without.stdout, /ROTATE_CALLED/, 'without rotate_password, rotation must never be invoked')

  const withRotate = runActionSoakSeedProbe('rotate_password=true')
  assert.equal(withRotate.status, 0, `expected clean exit; stderr: ${withRotate.stderr}`)
  assert.match(withRotate.stdout, /ROTATE_CALLED/, 'rotate_password=true must invoke rotation')
  assert.doesNotMatch(withRotate.stdout, /REQUIRE_ORGS_CALLED/, 'rotate_password=true must never reach soak_require_orgs')
})

test('rotate_password EXECUTABLE (b): rotation with users_per_org ALSO set refuses (standalone act), and never calls rotation', () => {
  const r = runActionSoakSeedProbe('rotate_password=true;users_per_org=5')
  assert.notEqual(r.status, 0, `expected a nonzero exit; stdout: ${r.stdout}`)
  assert.match(r.stderr, /rotate_password=true is a standalone act and refuses users_per_org\/tz\/w7_target/, 'must name the standalone-act rule')
  assert.match(r.stderr, /users_per_org/, 'must name the specific conflicting key')
  assert.doesNotMatch(r.stdout, /ROTATE_CALLED/, 'rotation must never be invoked when a conflicting opt is present')
})

for (const [key, value] of [['tz', 'UTC'], ['w7_target', 'group_shadow']]) {
  test(`rotate_password EXECUTABLE (b) variant: rotation with ${key} ALSO set refuses`, () => {
    const r = runActionSoakSeedProbe(`rotate_password=true;${key}=${value}`)
    assert.notEqual(r.status, 0, `expected a nonzero exit; stdout: ${r.stdout}`)
    assert.match(r.stderr, new RegExp(key), `must name ${key} as the conflicting opt`)
    assert.doesNotMatch(r.stdout, /ROTATE_CALLED/, 'rotation must never be invoked when a conflicting opt is present')
  })
}

test('rotate_password EXECUTABLE (c): a missing credentials file refuses ("nothing to rotate"), via the REAL rotation function', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-rotate-'))
  const missingCredFile = join(dir, 'credentials.env')
  assert.ok(!existsSync(missingCredFile), 'precondition: the credentials file must not exist')
  const r = runActionSoakSeedProbe('rotate_password=true', { realRotate: true, realRequireOrgs: true }, {
    SOAK_CREDENTIALS_FILE: missingCredFile,
  })
  assert.notEqual(r.status, 0, `expected a nonzero exit; stdout: ${r.stdout}`)
  assert.match(r.stderr, /no credentials file exists at .* — nothing to rotate/, 'must name the specific fail-closed reason')
  assert.match(r.stderr, new RegExp(missingCredFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'must name the exact path checked')
})

test('rotate_password EXECUTABLE: an EXISTING credentials file clears the missing-file guard (positive control distinguishing the guard from a generic failure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-rotate-'))
  const credFile = join(dir, 'credentials.env')
  writeFileSync(credFile, 'SOAK_SYNTH_PASSWORD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n', { mode: 0o600 })
  const r = runActionSoakSeedProbe('rotate_password=true', { realRotate: true, realRequireOrgs: true }, {
    SOAK_CREDENTIALS_FILE: credFile,
  })
  // The real soak_seed_rotate_password proceeds past the file-exists guard and then calls
  // soak_resolve_pg/docker, neither stubbed here — it WILL fail, but never with the
  // missing-file message (proving that specific guard, not a downstream failure, gated the
  // previous test).
  assert.notEqual(r.status, 0, 'expected a nonzero exit (docker/psql unavailable in this test env)')
  assert.doesNotMatch(r.stderr, /nothing to rotate/, 'the missing-credentials-file guard must NOT be what failed this run')
})

test('rotate_password EXECUTABLE (gate #5063 F2, 0-row path): a rotation matching ZERO family rows auto-restores .prev and fails — never reports result=ok', () => {
  // Drives the REAL soak_seed_rotate_password end-to-end with a FAKE `docker` on PATH
  // (no real postgres/backend container involved), whose canned output mirrors exactly
  // what the real SQL prints for family_count=0 (verified against a real postgres:16
  // separately — see the PR body). This proves the F2 fix behaviourally, not just
  // textually: the credentials file really gets restored to the pre-rotation password.
  const dir = mkdtempSync(join(tmpdir(), 'soak-rotate-f2-'))
  const persistDir = join(dir, 'persist')
  mkdirSync(persistDir, { recursive: true })
  const credFile = join(persistDir, 'credentials.env')
  const outputDir = join(dir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const oldPassword = 'OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD'
  writeFileSync(credFile, `SOAK_SYNTH_PASSWORD=${oldPassword}\n`, { mode: 0o600 })

  const fakeBinDir = join(dir, 'bin')
  mkdirSync(fakeBinDir, { recursive: true })
  const fakeDocker = join(fakeBinDir, 'docker')
  writeFileSync(fakeDocker, `#!/bin/bash
argv="$*"
if [[ "$argv" == *"metasheet-staging-backend"*"node"* ]]; then
  cat >/dev/null
  echo '$2b$10$fakefakefakefakefakefakefakefakefakefakefakefakef'
  exit 0
fi
if [[ "$argv" == *"metasheet-staging-postgres"*"psql"* ]]; then
  cat >/dev/null
  echo "BEGIN"
  echo "NOTICE:  ROTATE_RESULT family_count=0 updated_count=0"
  echo "DO"
  echo "COMMIT"
  exit 0
fi
echo "fake docker: unhandled invocation: $argv" >&2
exit 1
`)
  chmodSync(fakeDocker, 0o755)

  const rotateFns = extractRunnerFunctions([
    'soak_seed_rotate_password',
    'soak_mint_password',
    'soak_hash_password_in_backend',
    'soak_resolve_pg',
  ])
  const failLine = extractRunnerLine('fail')
  const logLine = extractRunnerLine('log')
  const optsRe = extractRunnerVar('SOAK_OPTS_RE')
  const optValueRe = extractRunnerVar('SOAK_OPT_VALUE_RE')
  const noticeRe = extractRunnerVar('SOAK_ROTATE_NOTICE_RE')
  const script = `#!/bin/bash
set -u
${failLine}
${logLine}
${optsRe}
${optValueRe}
${noticeRe}
SOAK_USER_PREFIX="synth-w4w7-"
BACKEND_CONTAINER="metasheet-staging-backend"
POSTGRES_CONTAINER="metasheet-staging-postgres"
SOAK_PG_USER="postgres"
SOAK_PG_DB="metasheet"
resolve_postgres_creds() { echo "postgres metasheet"; }
snapshot_staging_ps() { :; }
${rotateFns}
soak_seed_rotate_password
`
  const scriptFile = join(dir, 'run.sh')
  writeFileSync(scriptFile, script)
  const r = spawnSync('bash', [scriptFile], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, SOAK_CREDENTIALS_FILE: credFile, SOAK_PERSIST_DIR: persistDir, OUTPUT_DIR: outputDir },
  })
  assert.notEqual(r.status, 0, `expected a nonzero exit on a 0-row rotation; stdout: ${r.stdout}; stderr: ${r.stderr}`)
  assert.match(r.stderr, /matched 0 users for username LIKE 'synth-w4w7-%'/, 'must name the specific 0-row reason')
  assert.match(r.stderr, /restored the pre-rotation credentials file/, 'must state that .prev was restored')
  // The restore is `mv -f .prev credentials.env` — mv CONSUMES its source, so .prev is
  // gone afterward (the main file IS the recovered state; nothing is left to restore
  // FROM anymore). Absence of .prev here is itself part of proving the real `mv` ran,
  // not a copy that would have left both files behind.
  assert.ok(!existsSync(`${credFile}.prev`), '.prev must have been consumed by the restore mv (not merely copied)')
  const restored = readFileSync(credFile, 'utf8')
  assert.match(restored, new RegExp(oldPassword), 'the credentials file must be restored to the pre-rotation password, not left holding the new one')
  const summaryPath = join(outputDir, 'summary.txt')
  assert.ok(!existsSync(summaryPath), 'a 0-row rotation must never reach the result=ok summary write')
})

for (const badValue of ['false', '1', 'TRUE', 'yes']) {
  test(`rotate_password EXECUTABLE invalid-value negative (script layer): rotate_password=${badValue} is refused`, () => {
    const r = runActionSoakSeedProbe(`rotate_password=${badValue}`)
    assert.notEqual(r.status, 0, `expected a nonzero exit; stdout: ${r.stdout}`)
    assert.match(r.stderr, /rotate_password only accepts 'true'/, 'must name the rotate_password value rule')
    assert.doesNotMatch(r.stdout, /ROTATE_CALLED|REQUIRE_ORGS_CALLED/, 'neither branch may run on an invalid value')
  })
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
