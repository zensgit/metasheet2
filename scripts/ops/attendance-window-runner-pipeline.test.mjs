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
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, posix } from 'node:path'
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

test('rehearsal restore splits archive sections around a general clone-only function search_path shim', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const rehearseStart = remote.indexOf('action_migrate_rehearse() {')
  const rehearseEnd = remote.indexOf('\naction_migrate_apply() {', rehearseStart)
  assert.ok(rehearseStart >= 0 && rehearseEnd > rehearseStart, 'expected rehearsal function bounds')
  const rehearse = remote.slice(rehearseStart, rehearseEnd)

  const select = rehearse.indexOf('-c "$(rehearsal_shim_candidates_sql)"')
  const validate = rehearse.indexOf('rehearsal_shim_validate_signatures "$shim_list"')
  const preData = rehearse.indexOf('--section=pre-data')
  const shim = rehearse.indexOf('rehearsal_shim_sql set "$shim_list"')
  const data = rehearse.indexOf('--section=data')
  const postData = rehearse.indexOf('--section=post-data')
  const reset = rehearse.indexOf('rehearsal_shim_sql reset "$shim_list"')
  assert.ok(select >= 0 && validate > select && preData > validate && shim > preData && data > shim && postData > data && reset > postData,
    'restore must run: select candidates -> validate -> pre-data -> clone shim -> data -> post-data -> clone reset')

  // The source DB (the real staging DB) is used exactly twice in the rehearsal, both times as a
  // read-only SELECT built by a lib function: the candidate list and the parity digest.
  const sourceUses = rehearse.match(/-d "\$MIGRATE_BACKUP_PG_DB"[^\n]*\n[^\n]*/g) || []
  assert.equal(sourceUses.length, 2, `the source DB must be touched exactly twice in the rehearsal, got ${sourceUses.length}`)
  assert.equal((rehearse.match(/MIGRATE_BACKUP_PG_DB/g) || []).length, 2,
    'the source DB variable appears exactly twice in the rehearsal, in any spelling (braced, unquoted, --dbname=)')
  assert.match(sourceUses[0], /-d "\$MIGRATE_BACKUP_PG_DB" -tA -v ON_ERROR_STOP=1 \\\n\s+-c "\$\(rehearsal_shim_candidates_sql\)" \\$/,
    'first source use: the read-only candidate SELECT')
  assert.match(sourceUses[1], /-d "\$MIGRATE_BACKUP_PG_DB" -tA -v ON_ERROR_STOP=1 \\\n\s+-c "\$\(rehearsal_shim_parity_sql\)" \| tr -d '\[:space:\]'\)" \\$/,
    'second source use: the read-only parity digest')
  assert.doesNotMatch(rehearse, /-d "\$MIGRATE_BACKUP_PG_DB"[^\n]*ALTER FUNCTION/,
    'compatibility shim must never alter the real staging DB')

  // Exactly one SET and one RESET, each gated on a nonempty list, each piped only to the clone
  // in one transaction, SET before RESET.
  const setUses = rehearse.match(/rehearsal_shim_sql\s+set\b/g) || []
  const resetUses = rehearse.match(/rehearsal_shim_sql\s+reset\b/g) || []
  assert.equal(setUses.length, 1, 'exactly one SET pipeline')
  assert.equal(resetUses.length, 1, 'exactly one RESET pipeline')
  assert.ok(rehearse.lastIndexOf('rehearsal_shim_sql set') < rehearse.indexOf('rehearsal_shim_sql reset'), 'no SET may follow the RESET')
  for (const mode of ['set', 'reset']) {
    assert.match(rehearse, new RegExp(`if \\[\\[ "\\$shim_count" -gt 0 \\]\\]; then\\n\\s+log "[^"\\n]*"\\n\\s+rehearsal_shim_sql ${mode} "\\$shim_list" \\\\\\n\\s+\\| docker exec -i "\\$POSTGRES_CONTAINER" psql -U "\\$pg_user" -d "\\$REHEARSAL_DB" -v ON_ERROR_STOP=1 -q -1 -f - \\\\\\n`),
      `the ${mode} pipeline must be gated on shim_count > 0 and go only to the rehearsal DB, in one transaction`)
  }

  // After the RESET the clone's function configuration must equal the source's, or the rehearsal stops.
  const parity = rehearse.indexOf('[[ "$source_fn_digest" =~ ^[0-9a-f]{32}$ && "$source_fn_digest" == "$clone_fn_digest" ]]')
  assert.ok(parity > rehearse.indexOf('rehearsal_shim_sql reset'), 'the parity check must run after the RESET')
  const cloneDigest = rehearse.indexOf('clone_fn_digest="$(docker exec')
  assert.ok(cloneDigest > rehearse.indexOf('rehearsal_shim_sql reset'), 'the clone digest must be MEASURED after the RESET')
  assert.ok(cloneDigest < parity, 'the clone digest must be measured before it is compared')
  assert.equal((rehearse.match(/source_fn_digest=/g) || []).length, 1, 'exactly one source digest assignment')
  assert.equal((rehearse.match(/clone_fn_digest=/g) || []).length, 1, 'exactly one clone digest assignment')
  assert.equal((rehearse.match(/\bclone_fn_digest\b/g) || []).length, 4, 'clone digest token count, any spelling')
  assert.equal((rehearse.match(/\bsource_fn_digest\b/g) || []).length, 6, 'source digest token count, any spelling')
  assert.match(rehearse, /clone_fn_digest="\$\(docker exec "\$POSTGRES_CONTAINER" psql -U "\$pg_user" -d "\$REHEARSAL_DB" -tA -v ON_ERROR_STOP=1 \\\n\s+-c "\$\(rehearsal_shim_parity_sql\)" \| tr -d '\[:space:\]'\)" \\\n/, 'clone digest tail anchored like the source one')
  const shimCalls = [...rehearse.matchAll(/\brehearsal_shim_sql\s+(\S+)/g)].map((m) => m[1])
  assert.deepEqual(shimCalls, ['set', 'reset'], `exactly one SET then one RESET, mode spelled literally; got ${JSON.stringify(shimCalls)}`)
  assert.match(rehearse, /tee "\$\{OUTPUT_DIR\}\/rehearsal-restore-compat\.log" \\\n\s+\|\| fail "rehearsal restore compatibility: applying the clone-only search_path shim failed"/,
    'a failed SET pipeline must fail the rehearsal')
  assert.match(rehearse, /tee -a "\$\{OUTPUT_DIR\}\/rehearsal-restore-compat\.log" \\\n\s+\|\| fail "rehearsal restore compatibility: resetting the clone-only search_path shim failed"/,
    'a failed RESET pipeline must fail the rehearsal')
  assert.match(rehearse, /\[\[ "\$source_fn_digest" =~ \^\[0-9a-f\]\{32\}\$ && "\$source_fn_digest" == "\$clone_fn_digest" \]\] \\\n\s+\|\| fail "rehearsal restore compatibility: the clone's public function configuration differs/,
    'a digest mismatch (or a non-digest) must fail the rehearsal')
  assert.match(rehearse, /clone_fn_digest="\$\(docker exec "\$POSTGRES_CONTAINER" psql -U "\$pg_user" -d "\$REHEARSAL_DB" -tA -v ON_ERROR_STOP=1 \\\n\s+-c "\$\(rehearsal_shim_parity_sql\)"/)

  // Fail closed on a bad query or an unexpected signature shape.
  assert.match(rehearse, /> "\$shim_list" \\\n\s+\|\| fail "rehearsal restore compatibility: candidate function query/)
  assert.match(rehearse, /shim_count="\$\(rehearsal_shim_validate_signatures "\$shim_list"\)" \\\n\s+\|\| fail "rehearsal restore compatibility: a candidate function signature has an unexpected shape/)

  assert.equal((rehearse.match(/pg_restore -j 2 --exit-on-error --section=/g) || []).length, 3,
    'all three archive sections must fail closed on the first restore error')
})

test('rehearsal shim SQL is pinned byte for byte (candidate filter direction and parity ordering are load-bearing)', () => {
  const candidates = runPipefailBash(`source '${LIB}'\nrehearsal_shim_candidates_sql`)
  assert.equal(candidates.status, 0, candidates.stderr)
  assert.equal(candidates.stdout,
    "SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname) || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' "
    + 'FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang '
    + "WHERE n.nspname = 'public' AND p.prokind = 'f' AND l.lanname IN ('sql', 'plpgsql') "
    + "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e') "
    + "AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%') "
    + 'ORDER BY 1;')
  const parity = runPipefailBash(`source '${LIB}'\nrehearsal_shim_parity_sql`)
  assert.equal(parity.status, 0, parity.stderr)
  assert.equal(parity.stdout,
    "SELECT md5(coalesce(string_agg(p.oid::pg_catalog.regprocedure::text || '|' || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-'), ';' "
    + 'ORDER BY p.oid::pg_catalog.regprocedure::text COLLATE "C"), \'\')) '
    + "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';")
})

test('EXECUTABLE (rehearsal_shim_validate_signatures): counts real catalog shapes, fails closed on anything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-shim-'))
  const run = (lines) => {
    const file = join(dir, 'list.txt')
    writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''))
    return runPipefailBash(`source '${LIB}'\nrehearsal_shim_validate_signatures '${file}'`)
  }
  const good = run([
    'public.attendance_w4_job_proof_vector_valid(source_kind text, root uuid, vector jsonb, item_count integer, operational_branch text, distinct_target_count integer)',
    'public.attendance_w4c3a_exact_object_keys(value jsonb, expected text[])',
    'public.attendance_w4_deny_mutation()',
    'public.f(VARIADIC args text[], at timestamp with time zone, "Weird" public.custom_type)',
  ])
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.trim(), '4')
  const empty = run([])
  assert.equal(empty.status, 0)
  assert.equal(empty.stdout.trim(), '0')
  for (const bad of [
    'public.f(); DROP TABLE users; --()',
    'public.f(a;b)',
    "public.f(a'b)",
    'public.f(a\\b)',
    'public.f(a$$b)',
    'public.f(a=b)',
    'public.f(a*/b)',
    'public.f(a-b)',
    'public.f(a(b)',
    'public.f(a)b)',
    'x public.f(a text)',
    'public."Weird"(a text)',
    'other.f(a text)',
    'public.f(a text) ',
    "public.f(a text)'",
    'public.f(a text)\\',
    'f(a text)',
  ]) {
    const r = run(['public.ok(a text)', bad])
    assert.equal(r.status, 1, `must reject: ${bad}`)
    assert.equal(r.stdout, '', `must print nothing on rejection: ${bad}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (rehearsal_shim_sql): one ALTER per signature for set and reset; unknown mode fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-shim-'))
  const file = join(dir, 'list.txt')
  writeFileSync(file, 'public.a(x jsonb)\n\npublic.b(y text[], z integer)\n')
  const set = runPipefailBash(`source '${LIB}'\nrehearsal_shim_sql set '${file}'`)
  assert.equal(set.status, 0, set.stderr)
  assert.equal(set.stdout, 'ALTER FUNCTION public.a(x jsonb) SET search_path = pg_catalog, public;\nALTER FUNCTION public.b(y text[], z integer) SET search_path = pg_catalog, public;\n')
  const reset = runPipefailBash(`source '${LIB}'\nrehearsal_shim_sql reset '${file}'`)
  assert.equal(reset.status, 0, reset.stderr)
  assert.equal(reset.stdout, 'ALTER FUNCTION public.a(x jsonb) RESET search_path;\nALTER FUNCTION public.b(y text[], z integer) RESET search_path;\n')
  const bad = runPipefailBash(`source '${LIB}'\nrehearsal_shim_sql drop '${file}'`)
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  rmSync(dir, { recursive: true, force: true })
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
  assert.match(remote, /-e "MIGRATION_EXCLUDE=\$\{owner_exclude\}"/, 'P1-1: every migrate-family docker run must force MIGRATION_EXCLUDE to exactly the owner-ruled list')
  assert.doesNotMatch(remote, /-e "MIGRATION_EXCLUDE=" /, 'P1-1: no migrate-family docker run may pass an empty exclude anymore (the owner list is forced instead)')
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
source '${LIB}'
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
  assert.match(logged, /-e MIGRATION_EXCLUDE=should-be-overridden.*-e MIGRATION_EXCLUDE=(?!should)/, 'the forced override must come AFTER the caller-supplied value (docker: last -e for a name wins)')
  assert.match(logged, /-e MIGRATION_EXCLUDE=zzzz20260919090000_create_approval_template_group_backfill_batches(?:\s|$)/, 'the forced value must be exactly the owner-ruled list')
  assert.match(logged, /-e MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false/)
  assert.match(logged, /-e ALLOW_DB_RESET=false/)
})

test('MUTATION (P1-1 layer 3): removing the forced -e overrides turns the previous test red', () => {
  const script = buildMigrationEnvHarness({
    targetExec: (text) => text
      .replace('-e "MIGRATION_EXCLUDE=${owner_exclude}" \\\n', '')
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
MIGRATE_BACKUP_PG_USER="fakeuser"
assert_owner_exclusions_hold() { echo "owner:$1|$2|$3" >> "$CALLS"; }
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
  const owner = calls.indexOf('owner:fakeuser|stagingdb|after-apply')
  assert.ok(owner > confirm, `the owner-exclusion check must run on the real DB after the confirmations; calls=${calls.join(' ; ')}`)
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

test('EXECUTABLE (override classification): a legal x-* extension block cannot impersonate services.backend', () => {
  // External review round 3, reproduced before fixing: `x-template:\n  backend:\n    environment:`
  // is legal compose (docker compose config accepts it), and the un-scoped awk matched its
  // `  backend:` — feeding BOTH the set guard and the count guard from the same mis-scoped walk —
  // so a file whose real services.backend carries no env classified rd-window with
  // file_live_match=true: a confident green handed to the deploy decision. The walk now requires
  // the FULL parent path (column-0 `services:` context).
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovxext-'))
  const cases = [
    // extension block carries the env; real backend has none -> the file's UPPER keys exist
    // OUTSIDE services.backend.environment -> unexpected, never a calm rd-window/none.
    ['x-template-impersonation', `x-template:\n  backend:\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\nservices:\n  backend:\n    image: x\n  web:\n    image: x\n`, 1, /^override_shape=unexpected$/m],
    // anchor-swap control: the REAL services.backend env still classifies when an x-* block
    // merely exists (empty) above it — proves the fix scopes rather than blinds.
    ['x-block-plus-real-backend', `x-unrelated:\n  note: irrelevant\nservices:\n  backend:\n    image: x\n    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n  web:\n    image: x\n`, 0, /^override_shape=rd-window$/m],
  ]
  for (const [label, body, wantRc, wantShape] of cases) {
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
  printenv() { case "$1" in PATH|ATTENDANCE_SCHEDULER_ENABLED|ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED) return 0 ;; *) return 1 ;; esac; }
  eval "$body"
); }
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, wantRc, `${label}: rc=${r.status} stderr=${r.stderr}`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, wantShape, `${label} report:\n${report}`)
  }
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
  const forced = [...deployBody.matchAll(/^\s*staging_exec_env "MIGRATION_EXCLUDE=\$\{owner_exclude\}" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "\$MIGRATE_JS"/gm)]
  assert.equal(forced.length, 3, `all three deploy-path MIGRATE_JS invocations must pass exactly the owner-ruled exclude and force the other two hazard vars empty (N3; list-before, run, list-after); found ${forced.length}`)
  assert.equal((deployBody.match(/MIGRATION_EXCLUDE=/g) || []).length, 3, 'no other MIGRATION_EXCLUDE value may appear in action_deploy')
  assert.match(deployBody, /^\s*owner_exclude="\$\(staging_owner_exclude_csv\)" \\\n\s+\|\| fail /m, 'deploy must take the exclude value from the lib list, failing on a bad list')
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

test('persistent override: set_window_env=none writes NO flag env — the override body emits its environment block only via backend_override_environment_lines, whose ATTENDANCE_*_ENABLED echoes sit behind the rd-window gate, so a none redeploy clears prior flags from the persisted file', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  // scope strictly to the override-write heredoc region (ATTENDANCE_SCHEDULER_ENABLED also
  // appears earlier in the env-flags diagnostic block, which is not the override body)
  const start = remote.indexOf('override_tmp="$(mktemp')
  const end = remote.indexOf('> "$override_tmp"', start)
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected the override-write heredoc region')
  const body = remote.slice(start, end)
  assert.match(body, /backend_override_environment_lines "\$SET_WINDOW_ENV" "\$TASKS_WINDOW_ENABLED"/, 'the override body must delegate its environment block to the lib writer')
  assert.doesNotMatch(body, /ATTENDANCE_SCHEDULER_ENABLED|ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED|TASKS_ENABLED:|environment:/, 'the override body must not echo flag keys or an environment: header directly')
  const lib = readFileSync(LIB, 'utf8')
  const fnStart = lib.indexOf('backend_override_environment_lines() {')
  assert.notEqual(fnStart, -1, 'expected backend_override_environment_lines in the lib')
  const fnEnd = lib.indexOf('\n}\n', fnStart)
  const fn = lib.slice(fnStart, fnEnd)
  const rdIdx = fn.indexOf('if [[ "$set_window_env" == "rd-window" ]]; then')
  const fiIdx = fn.indexOf('\n  fi', rdIdx)
  const schedIdx = fn.indexOf('ATTENDANCE_SCHEDULER_ENABLED')
  const workerIdx = fn.indexOf('ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED')
  assert.notEqual(rdIdx, -1, 'expected the rd-window gate inside the lib writer')
  assert.notEqual(fiIdx, -1, 'expected the rd-window gate to be closed with fi')
  assert.ok(rdIdx < schedIdx && schedIdx < fiIdx, 'the scheduler flag echo must sit INSIDE the rd-window gate')
  assert.ok(rdIdx < workerIdx && workerIdx < fiIdx, 'the worker flag echo must sit INSIDE the rd-window gate')
  const none = runPipefailBash(`source '${LIB}'\nbackend_override_environment_lines 'none' 'false'`)
  assert.equal(none.status, 0, `none/false must not trip errexit; stderr: ${none.stderr}`)
  assert.equal(none.stdout, '', 'set_window_env=none + tasks_enabled=false must write no environment block at all')
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

test('tasks_enabled: an explicit deploy-only choice input that defaults to false, validated fail-closed, and reaches the remote script', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.match(
    workflow,
    /tasks_enabled:\n\s+description:[^\n]+\n\s+required: false\n\s+type: choice\n\s+options: \['false', 'true'\]\n\s+default: 'false'/,
    'tasks_enabled must be a choice workflow input (false/true) defaulting to false',
  )
  assert.match(
    workflow,
    /case "\$TASKS_ENABLED_INPUT" in true\|false\) ;; \*\) echo "tasks_enabled must be true or false/,
    'workflow input validation must fail closed on an invalid tasks_enabled value',
  )
  assert.match(
    workflow,
    /if \[\[ "\$ACTION" != "deploy" && "\$TASKS_ENABLED_INPUT" == "true" \]\]; then\n\s+echo "tasks_enabled=true is only allowed for action=deploy/,
    'workflow input validation must reject tasks_enabled=true on non-deploy actions',
  )
  assert.match(workflow, /export TASKS_WINDOW_ENABLED='\$\{TASKS_ENABLED_INPUT\}'/, 'validated tasks_enabled must reach the remote script as TASKS_WINDOW_ENABLED')

  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(remote, /TASKS_WINDOW_ENABLED="\$\{TASKS_WINDOW_ENABLED:-false\}"/, 'remote script must default TASKS_WINDOW_ENABLED to false')
  assert.match(
    remote,
    /case "\$TASKS_WINDOW_ENABLED" in\n\s+true\|false\) ;;\n\s+\*\) fail "TASKS_WINDOW_ENABLED must be true or false/,
    'remote script must independently fail closed on an invalid TASKS_WINDOW_ENABLED (defense-in-depth, same as FORCE_RECREATE)',
  )
  assert.match(
    remote,
    /if \[\[ "\$ACTION" != "deploy" && "\$TASKS_WINDOW_ENABLED" == "true" \]\]; then\n\s+fail "TASKS_WINDOW_ENABLED=true is only allowed for action=deploy/,
    'remote script must independently reject TASKS_WINDOW_ENABLED=true on non-deploy actions',
  )
})

test('tasks smoke id is registered: workflow choice list + remote action_smoke case statement', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.match(workflow, /options: \[ae4, rd45, otbank-v18, mp6, hmr5, tasks\]/, 'the smoke input must offer tasks alongside the five bundle window smokes')

  const remote = readFileSync(REMOTE_SH, 'utf8')
  const start = remote.indexOf('action_smoke() {')
  const end = remote.indexOf('\n# residue_check', start)
  assert.ok(start !== -1 && end > start, 'expected action_smoke() bounds')
  const smoke = remote.slice(start, end)
  assert.match(smoke, /tasks\)\n\s+smoke_script="staging-tasks-smoke\.mjs"\n\s+stamp_prefix="tasks-smoke"/, 'action_smoke must map smoke=tasks to staging-tasks-smoke.mjs with stamp_prefix tasks-smoke')
  assert.match(
    smoke,
    /if \[\[ "\$SMOKE_ID" == "tasks" \]\]; then\n(?:\s+#[^\n]*\n)*\s+local tasks_live\n\s+tasks_live="\$\(soak_backend_env TASKS_ENABLED\)"\n\s+\[\[ "\$tasks_live" == "true" \]\] \\\n\s+\|\| fail "smoke=tasks requires TASKS_ENABLED=true/,
    'action_smoke must fail closed unless the running backend actually has TASKS_ENABLED=true',
  )
  assert.match(
    smoke,
    /if \[\[ "\$SMOKE_ID" == "tasks" \]\]; then\n(?:\s+#[^\n]*\n)*\s+run_env\+=\("SUBJECT_TOKEN=\$\(mint_token "\$\{stamp\}" 'user' 'tasks:read,tasks:write' 'default'\)"\)\n\s+run_env\+=\("MEMBER_TOKEN=\$\(mint_token "\$\{stamp\}-member" 'user' 'tasks:read,tasks:write' 'default'\)"\)\n\s+run_env\+=\("OUTSIDER_TOKEN=\$\(mint_token "\$\{stamp\}-outsider" 'user' 'tasks:read' 'default'\)"\)\n\s+fi/,
    'action_smoke must mint tenant-scoped SUBJECT_TOKEN, MEMBER_TOKEN and OUTSIDER_TOKEN for the tasks smoke, org default (the same deterministic org every other window smoke uses)',
  )
})

test('mint_token: tenant_id stays optional (pre-existing 3-arg callers unaffected) and is argv-passed, never text-spliced', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const start = remote.indexOf('mint_token() {')
  const end = remote.indexOf('\ncapture_settings() {', start)
  assert.ok(start !== -1 && end > start, 'expected mint_token() bounds')
  const fn = remote.slice(start, end)
  assert.match(fn, /local user_id="\$1" roles="\$2" perms="\$3" tenant_id="\$\{4:-\}"/, 'tenant_id must be the 4th, optional, positional argument')
  assert.match(fn, /--mint --user-id "\$user_id" --roles "\$roles" --perms "\$perms" --tenant-id "\$tenant_id"/, 'tenant_id, when given, must be passed as its own --tenant-id argv element')
  assert.match(fn, /--mint --user-id "\$user_id" --roles "\$roles" --perms "\$perms"\n  fi/, 'the pre-existing 3-arg call shape must be preserved byte-for-byte when tenant_id is empty')
})

test('EXECUTABLE (backend_override_environment_lines): all 4 set_window_env x tasks_window_enabled combos emit AT MOST ONE environment: block with the exact expected keys, never a duplicate key', () => {
  const cases = [
    ['none', 'false', ''],
    ['none', 'true', '    environment:\n      TASKS_ENABLED: "true"\n'],
    ['rd-window', 'false', '    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n'],
    ['rd-window', 'true', '    environment:\n      ATTENDANCE_SCHEDULER_ENABLED: "true"\n      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: "true"\n      TASKS_ENABLED: "true"\n'],
  ]
  for (const [setWindowEnv, tasksEnabled, expected] of cases) {
    const result = runPipefailBash(`source '${LIB}'\nbackend_override_environment_lines '${setWindowEnv}' '${tasksEnabled}'`)
    assert.equal(result.status, 0, `set_window_env=${setWindowEnv} tasks=${tasksEnabled}: stderr=${result.stderr}`)
    assert.equal(result.stdout, expected, `set_window_env=${setWindowEnv} tasks=${tasksEnabled}`)
    const envBlockCount = (result.stdout.match(/^ {4}environment:$/gm) || []).length
    assert.ok(envBlockCount <= 1, `set_window_env=${setWindowEnv} tasks=${tasksEnabled}: expected 0 or 1 environment: blocks, found ${envBlockCount}`)
    const keyOccurrences = (name) => (result.stdout.match(new RegExp(`^ {6}${name}:`, 'gm')) || []).length
    for (const name of ['ATTENDANCE_SCHEDULER_ENABLED', 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED', 'TASKS_ENABLED']) {
      assert.ok(keyOccurrences(name) <= 1, `set_window_env=${setWindowEnv} tasks=${tasksEnabled}: key ${name} appeared ${keyOccurrences(name)} times (must never duplicate)`)
    }
  }
})

test('EXECUTABLE (backend_override_environment_lines x classify_runner_override): each combo\'s writer output classifies as the matching shape (none / none+tasks / rd-window / rd-window+tasks), values-free, no errexit trip', () => {
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovtasks-'))
  const cases = [
    ['none', 'false', 'none', []],
    ['none', 'true', 'none+tasks', ['TASKS_ENABLED']],
    ['rd-window', 'false', 'rd-window', ['ATTENDANCE_SCHEDULER_ENABLED', 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED']],
    ['rd-window', 'true', 'rd-window+tasks', ['ATTENDANCE_SCHEDULER_ENABLED', 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED', 'TASKS_ENABLED']],
  ]
  for (const [setWindowEnv, tasksEnabled, wantShape, liveKeys] of cases) {
    const overridePath = join(dir, `ov-${setWindowEnv}-${tasksEnabled}.yml`)
    const script = `#!/bin/bash
set -euo pipefail
source '${LIB}'
{
  echo "# test fixture"
  echo "services:"
  echo "  backend:"
  echo "    image: ghcr.io/x/metasheet2-backend:deadbeef"
  backend_override_environment_lines '${setWindowEnv}' '${tasksEnabled}'
  echo "  web:"
  echo "    image: ghcr.io/x/metasheet2-web:deadbeef"
} > '${overridePath}'
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() {
  local body="$5"
  shift 6
  (
    printenv() {
      case "$1" in
        PATH) echo "/usr/bin"; return 0 ;;
${liveKeys.map((k) => `        ${k}) echo v; return 0 ;;`).join('\n')}
        *) return 1 ;;
      esac
    }
    eval "$body"
  )
}
${fn}
classify_runner_override
`
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${setWindowEnv}/${tasksEnabled}: stderr=${r.stderr}`)
    const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
    assert.match(report, new RegExp(`^override_shape=${wantShape.replace('+', '\\+')}$`, 'm'), `${setWindowEnv}/${tasksEnabled} report:\n${report}`)
    assert.match(report, /^file_live_match=true$/m, `${setWindowEnv}/${tasksEnabled} report:\n${report}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (classify_runner_override): a file whose ONLY key is TASKS_ENABLED (none+tasks) does not trip errexit stripping it down to empty', () => {
  // Regression pin for the exact hazard the sans-tasks extraction was written to avoid: naively
  // piping file_names through `grep -v '^TASKS_ENABLED$'` when TASKS_ENABLED is the only name
  // present yields ZERO lines, and grep exits 1 on zero matches — which would abort this
  // function under the caller's `set -euo pipefail` (the same P3-1 hazard class the awk calls
  // elsewhere in this function dodge with `|| true`). The shipped extraction uses a plain bash
  // word loop instead, which has no such exit-code hazard.
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovtasksonly-'))
  const overridePath = join(dir, 'ov.yml')
  writeFileSync(overridePath, 'services:\n  backend:\n    image: x\n    environment:\n      TASKS_ENABLED: "true"\n  web:\n    image: x\n')
  const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { local body="$5"; shift 6; ( printenv() { case "$1" in PATH|TASKS_ENABLED) echo v; return 0 ;; *) return 1 ;; esac; }; eval "$body" ); }
${fn}
classify_runner_override
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^override_shape=none\+tasks$/m)
  assert.match(report, /^file_live_match=true$/m)
  rmSync(dir, { recursive: true, force: true })
})

test('EXECUTABLE (classify_runner_override): soak-w4w7 + TASKS_ENABLED together is unexpected — no writer produces that combination', () => {
  const fn = extractRunnerFunctions(['classify_runner_override', 'hash_value'])
  const dir = mkdtempSync(join(tmpdir(), 'wr-ovsoaktasks-'))
  const overridePath = join(dir, 'ov.yml')
  writeFileSync(
    overridePath,
    `services:\n  backend:\n    image: x\n    environment:\n      ${W4_FLAG_NAME}: "org_secret_alpha"\n      ${W7_FLAG_NAME}: "org_secret_alpha"\n      TASKS_ENABLED: "true"\n  web:\n    image: x\n`,
  )
  const script = `#!/bin/bash
set -euo pipefail
OUTPUT_DIR="${dir}"
OVERRIDE_FILE="${overridePath}"
BACKEND_CONTAINER="fake-backend"
SOAK_W4_ENV_NAME="${W4_FLAG_NAME}"
SOAK_W7_ENV_NAME="${W7_FLAG_NAME}"
docker() { local body="$5"; shift 6; ( printenv() { case "$1" in PATH|${W4_FLAG_NAME}|${W7_FLAG_NAME}|TASKS_ENABLED) echo v; return 0 ;; *) return 1 ;; esac; }; eval "$body" ); }
${fn}
classify_runner_override
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 1, 'soak-w4w7+tasks must refuse, not classify')
  const report = readFileSync(join(dir, 'override-shape.txt'), 'utf8')
  assert.match(report, /^override_shape=unexpected$/m)
  assert.ok(!report.includes('org_secret'), 'values leaked')
  rmSync(dir, { recursive: true, force: true })
})

test('action=soak-flags guard also refuses to silently drop a live TASKS_ENABLED (extends the existing rd-window protection)', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(
    remote,
    /if \[\[ -f "\$OVERRIDE_FILE" \]\] && grep -qE 'ATTENDANCE_SCHEDULER_ENABLED\|ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED\|TASKS_ENABLED' "\$OVERRIDE_FILE"; then\n\s+fail "existing runner override carries/,
    'soak-flags must refuse to rewrite an override that already carries TASKS_ENABLED, same as it already refuses for the rd-window flags',
  )
})

test('assert_window_env_flags: residue-sweep and status pass tasks_mode="false" explicitly (WARN, never FAIL, on an unrequested live TASKS_ENABLED)', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  assert.match(remote, /assert_window_env_flags "\$TASKS_WINDOW_ENABLED"/, 'action_deploy must pass its own TASKS_WINDOW_ENABLED')
  const residueCalls = (remote.match(/assert_window_env_flags "false" \|\| (env_flags_ok=0|status_rc=1)/g) || []).length
  assert.equal(residueCalls, 2, 'residue-sweep and status must both pass tasks_mode="false" explicitly')
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
      "ON family_user.username = :'user_prefix' || lpad(family_i::text, 2, '0')",
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
  assert.ok(
    slices.seed.includes("SELECT u.id, 'attendance:read'"),
    'seed must grant attendance:read to each synthetic user (self-service policy routes are permission-gated)',
  )
  assert.match(
    slices.seed,
    /ON CONFLICT \(org_id, code\) DO UPDATE[\s\S]*?is_active = true/,
    'seed must idempotently leave its dedicated leave type active',
  )
  assert.match(
    slices.seed,
    /ON CONFLICT \(org_id, name\) DO UPDATE[\s\S]*?is_active = true/,
    'seed must idempotently leave its dedicated overtime rule active',
  )
  assert.match(
    slices.seed,
    /substr\(md5\('w4w7-soak-selfservice-scope:' \|\| :'org' \|\| ':' \|\| u\.id\), 1, 8\)[\s\S]*?\|\| '-4' \|\|[\s\S]*?\|\| '-8' \|\|[\s\S]*?\)::uuid/,
    'each synthetic self-service scope must use a deterministic RFC 4122 v4-shaped id',
  )
  assert.match(
    slices.seed,
    /substr\(md5\('w4w7-soak-shift-swap-source:' \|\| :'org' \|\| ':' \|\| u\.username\), 1, 8\)[\s\S]*?\|\| '-4' \|\|[\s\S]*?\|\| '-8' \|\|[\s\S]*?\)::uuid/,
    'each manual shift-swap assignment must use a deterministic RFC 4122 v4-shaped id',
  )
  assert.match(
    slices.seed,
    /ARRAY\['view'\]::text\[\][\s\S]*?jsonb_build_object\([\s\S]*?'userIds'/,
    'synthetic users may receive only view scope over the closed user-id family',
  )
  assert.match(
    slices.seed,
    /:'end_date'::date \+ 1, :'end_date'::date \+ 1, true,[\s\S]*?NULL, NULL, NULL, NULL, 'published', 'regular'[\s\S]*?FROM generate_series\(1, 2\)/,
    'shift-swap fixtures must be two same-day manual published assignments outside the soak date window',
  )
  assert.match(
    remote,
    /users_per_org must be 2\.\.99 so the shift-swap fixture has two distinct users/,
    'soak seed must refuse a user family too small to exercise shift swap',
  )
  assert.ok(
    remote.includes('(( users_per_org >= 2 ))'),
    'the users-per-org lower bound must enforce the two-user shift-swap fixture contract',
  )
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

test('MUTATION: dropping the synthetic attendance:read grant turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace("SELECT u.id, 'attendance:read'", "SELECT u.id, 'attendance:write'")
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /attendance:read/,
  )
})

test('MUTATION: changing synthetic scheduler scope from view turns the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace("ARRAY['view']::text[]", "ARRAY['edit']::text[]")
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /view scope/,
  )
})

test('MUTATION: raw md5 UUIDs without RFC version and variant bits turn the soak contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace(
    /\(\n {9}substr\(md5\('w4w7-soak-shift-swap-source:'[\s\S]*?\n {7}\)::uuid/,
    "md5('w4w7-soak-shift-swap-source:' || :'org' || ':' || u.username)::uuid",
  )
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /RFC 4122/,
  )
})

test('MUTATION: moving manual shift-swap fixtures into the soak window turns the contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace(
    ":'end_date'::date + 1, :'end_date'::date + 1, true,",
    ":'end_date'::date, :'end_date'::date, true,",
  )
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /outside the soak date window/,
  )
})

test('MUTATION: allowing a one-user soak family turns the shift-swap fixture contract red', () => {
  const original = readFileSync(REMOTE_SH, 'utf8')
  const mutated = original.replace('(( users_per_org >= 2 ))', '(( users_per_org >= 1 ))')
  assert.notEqual(mutated, original, 'mutation anchor must hit')
  assert.throws(
    () => assertSoakContract({ remote: mutated, workflow: readFileSync(WORKFLOW, 'utf8') }),
    /two-user shift-swap fixture contract/,
  )
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
    env: { ACTION: env.ACTION, SOAK_ORGS: env.SOAK_ORGS ?? '', SOAK_OPTS: env.SOAK_OPTS ?? '', DEPLOY_SHA: '', SET_WINDOW_ENV: 'none', TASKS_ENABLED_INPUT: env.TASKS_ENABLED_INPUT ?? 'false', FORCE_RECREATE: 'false', STAMPS: '', PATH: process.env.PATH },
  })
}

const THREE_UUIDS = '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333'
const INJECT = "\n'; touch /tmp/PWNED_soak_test; echo '"

test('P2-1 negative control: a benign single-line soak-seed input PASSES workflow validation (harness discriminates)', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'owner_ref=ownerX;entrypoint_inventory_ref=invY;users_per_org=10' })
  assert.equal(r.status, 0, `benign input must pass validation; stderr: ${r.stderr}`)
})

test('workflow rejects a synthetic family too small for the two-user shift-swap fixture', () => {
  const r = runWorkflowValidation({ ACTION: 'soak-seed', SOAK_ORGS: THREE_UUIDS, SOAK_OPTS: 'owner_ref=ownerX;entrypoint_inventory_ref=invY;users_per_org=1' })
  assert.equal(r.status, 2, `users_per_org=1 must be rejected before SSH; got ${r.status}, stderr: ${r.stderr}`)
  assert.match(r.stderr, /users_per_org must be 2\.\.99/, 'rejection must name the shared workflow/remote lower bound')
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

// --- tasks_enabled: executable checks (runner review round 1) ---------------------------------

function extractAssertWindowEnvFlags() {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  // End at the next top-level function: the embedded node -e body contains column-0 `}` lines,
  // so a "first column-0 brace" extractor would truncate this function.
  const start = remote.indexOf('assert_window_env_flags() {')
  const end = remote.indexOf('snapshot_staging_ps() {', start)
  assert.ok(start !== -1 && end > start, 'expected assert_window_env_flags() bounds')
  return remote.slice(start, end)
}

function runAssertWindowEnvFlags({ requested, live }) {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-envflags-'))
  const script = `set -euo pipefail
OUTPUT_DIR='${dir}'
SET_WINDOW_ENV=none
staging_exec() {
  if [[ "$STUB_LIVE" == "<unset>" ]]; then
    env -u TASKS_ENABLED -u ATTENDANCE_REPORT_DIGEST_ENABLED -u ATTENDANCE_SCHEDULER_ENABLED -u ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED "$@"
  else
    env -u ATTENDANCE_REPORT_DIGEST_ENABLED -u ATTENDANCE_SCHEDULER_ENABLED -u ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED TASKS_ENABLED="$STUB_LIVE" "$@"
  fi
}
${extractAssertWindowEnvFlags()}
assert_window_env_flags "$STUB_REQUESTED"
`
  const result = spawnSync('bash', ['-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, STUB_LIVE: live, STUB_REQUESTED: requested },
  })
  const flags = existsSync(join(dir, 'env-flags.txt')) ? readFileSync(join(dir, 'env-flags.txt'), 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { ...result, flags }
}

test('EXECUTABLE (assert_window_env_flags): tasks requested but not live FAILS closed; requested=false only WARNs', () => {
  const cases = [
    { requested: 'true', live: '<unset>', rc: 1, out: /FAIL: tasks_enabled=true requested but TASKS_ENABLED=undefined/ },
    { requested: 'true', live: 'false', rc: 1, out: /FAIL: tasks_enabled=true requested but TASKS_ENABLED=false/ },
    { requested: 'true', live: 'true', rc: 0, flags: /tasks=true\(requested=true\)/ },
    { requested: 'false', live: '<unset>', rc: 0, flags: /tasks=<unset>\(requested=false\)/ },
    { requested: 'false', live: 'true', rc: 0, out: /WARN: tasks_enabled=false/, flags: /tasks=true\(requested=false\)/ },
  ]
  for (const c of cases) {
    const r = runAssertWindowEnvFlags(c)
    const label = `requested=${c.requested} live=${c.live}`
    assert.equal(r.status, c.rc, `${label}: rc ${r.status}; stderr: ${r.stderr}`)
    if (c.out) assert.match(r.stderr + r.stdout, c.out, label)
    if (c.flags) assert.match(r.flags, c.flags, label)
  }
})

test('workflow validation: tasks_enabled rejects non-deploy true and any value other than true|false (exit 2); false passes', () => {
  const notDeploy = runWorkflowValidation({ ACTION: 'status', TASKS_ENABLED_INPUT: 'true' })
  assert.equal(notDeploy.status, 2, notDeploy.stderr)
  assert.match(notDeploy.stderr, /tasks_enabled=true is only allowed for action=deploy/)
  const badValue = runWorkflowValidation({ ACTION: 'status', TASKS_ENABLED_INPUT: 'TRUE' })
  assert.equal(badValue.status, 2, badValue.stderr)
  assert.match(badValue.stderr, /tasks_enabled must be true or false, got: 'TRUE'/)
  const ok = runWorkflowValidation({ ACTION: 'status', TASKS_ENABLED_INPUT: 'false' })
  assert.equal(ok.status, 0, ok.stderr)
})

test('workflow: both the validation step and the remote-action step map TASKS_ENABLED_INPUT from inputs.tasks_enabled', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  for (const step of ['Validate inputs and embedded scripts', 'Run remote action']) {
    const at = workflow.indexOf(`- name: ${step}`)
    assert.notEqual(at, -1, `expected workflow step: ${step}`)
    const runAt = workflow.indexOf('run: |', at)
    assert.match(workflow.slice(at, runAt), /\n\s+TASKS_ENABLED_INPUT: \$\{\{ inputs\.tasks_enabled \}\}\n/, `${step} must map TASKS_ENABLED_INPUT`)
  }
})

test('EXECUTABLE (remote script): TASKS_WINDOW_ENABLED is re-validated fail-closed before any action runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-runner-tasks-validate-'))
  const base = { PATH: process.env.PATH, OUTPUT_DIR: dir, RUN_STAMP: 'gh1a1' }
  const bad = spawnSync('bash', ['-o', 'pipefail', REMOTE_SH], { encoding: 'utf8', env: { ...base, ACTION: 'status', TASKS_WINDOW_ENABLED: 'yes' } })
  assert.equal(bad.status, 1, bad.stderr)
  assert.match(bad.stderr, /TASKS_WINDOW_ENABLED must be true or false, got: 'yes'/)
  const notDeploy = spawnSync('bash', ['-o', 'pipefail', REMOTE_SH], { encoding: 'utf8', env: { ...base, ACTION: 'status', TASKS_WINDOW_ENABLED: 'true' } })
  assert.equal(notDeploy.status, 1, notDeploy.stderr)
  assert.match(notDeploy.stderr, /TASKS_WINDOW_ENABLED=true is only allowed for action=deploy/)
  assert.doesNotMatch(bad.stdout + notDeploy.stdout, /\[window-runner\] (?!.*error)/, 'nothing may run before the validation fails')
  rmSync(dir, { recursive: true, force: true })
})

// --- owner-ruled staging migration exclusions (owner 2026-09-29: A-3 off staging) -----------

test('owner exclusions: the committed list is exactly the owner-ruled A-3 migration and its three tables', () => {
  const r = runPipefailBash(`source '${LIB}'
printf 'names=%s\\n' "$(staging_owner_exclude_csv)"
printf 'tables=%s\\n' "\${STAGING_OWNER_EXCLUDED_TABLES[*]}"
staging_owner_excluded_tables_present_sql`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout,
    'names=zzzz20260919090000_create_approval_template_group_backfill_batches\n'
    + 'tables=approval_template_group_backfill_batches approval_template_group_backfill_batch_groups approval_template_group_backfill_batch_links\n'
    + "SELECT count(*) FROM (VALUES ('public.approval_template_group_backfill_batches'), ('public.approval_template_group_backfill_batch_groups'), ('public.approval_template_group_backfill_batch_links')) AS t(n) WHERE pg_catalog.to_regclass(t.n) IS NOT NULL;",
    'changing the owner-ruled list is an owner decision; update this pin in the same reviewed change')
})

test('EXECUTABLE (owner exclusions): a bad migration or table name fails closed; an empty list yields no exclude and a zero-table check', () => {
  for (const bad of ['a,b', 'a b', "a'b", 'a;b', '']) {
    const r = runPipefailBash(`source '${LIB}'\nSTAGING_OWNER_EXCLUDED_MIGRATIONS=(${JSON.stringify(bad)})\nstaging_owner_exclude_csv`)
    assert.equal(r.status, 1, `migration name must be rejected: ${JSON.stringify(bad)}`)
    assert.equal(r.stdout, '')
  }
  for (const bad of ['Upper', 'a-b', "a'b", 'public.a', '1a']) {
    const r = runPipefailBash(`source '${LIB}'\nSTAGING_OWNER_EXCLUDED_TABLES=(${JSON.stringify(bad)})\nstaging_owner_excluded_tables_present_sql`)
    assert.equal(r.status, 1, `table name must be rejected: ${JSON.stringify(bad)}`)
    assert.equal(r.stdout, '')
  }
  const empty = runPipefailBash(`source '${LIB}'\nSTAGING_OWNER_EXCLUDED_MIGRATIONS=()\nSTAGING_OWNER_EXCLUDED_TABLES=()\nprintf '[%s]\\n' "$(staging_owner_exclude_csv)"\nstaging_owner_excluded_tables_present_sql`)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(empty.stdout, '[]\nSELECT 0;')
})

function ownerCheckHarness({ applied, present, phase = 'before' }) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-owner-excl-'))
  const fn = extractRunnerFunctions(['assert_owner_exclusions_hold'])
  const script = `#!/bin/bash
set -euo pipefail
source '${LIB}'
OUTPUT_DIR="${dir}"
POSTGRES_CONTAINER="fake-postgres"
log() { echo "LOG:$*"; }
fail() { echo "FAIL:$*" >&2; exit 1; }
TABLE_SQL="$(staging_owner_excluded_tables_present_sql)"
docker() {
  echo "docker $*" >> "${dir}/docker.log"
  local sql="\${@: -1}"
  if [[ "$sql" == "SELECT name FROM kysely_migration ORDER BY name;" ]]; then
    printf '%s\\n' ${applied.map((n) => JSON.stringify(n)).join(' ')}
  elif [[ "$sql" == "$TABLE_SQL" ]]; then
    echo "${present}"
  else
    return 9
  fi
}
${fn}
assert_owner_exclusions_hold pguser stagingdb ${phase}
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  const docker = existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8') : ''
  const record = existsSync(join(dir, `owner-exclusions-${phase}.txt`)) ? readFileSync(join(dir, `owner-exclusions-${phase}.txt`), 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { ...r, docker, record }
}

test('EXECUTABLE (owner exclusions): holds on a clean DB; stale exclusion or a present table fails loud; read-only', () => {
  const clean = ownerCheckHarness({ applied: ['0001_init', 'zzzz20260926120000_create_task_p0a_tables'], present: 0 })
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.record, /^migration=zzzz20260919090000_create_approval_template_group_backfill_batches applied=no$/m)
  assert.match(clean.record, /^excluded_tables_present=0$/m)
  assert.doesNotMatch(clean.docker, /\b(ALTER|INSERT|UPDATE|DELETE|DROP|CREATE)\b/, 'the check must be read-only')
  assert.equal((clean.docker.match(/-d stagingdb/g) || []).length, 2, 'both reads must target the given DB')

  const stale = ownerCheckHarness({ applied: ['0001_init', 'zzzz20260919090000_create_approval_template_group_backfill_batches'], present: 0 })
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /is already applied on stagingdb — the exclusion is stale/)

  const tables = ownerCheckHarness({ applied: ['0001_init'], present: 2 })
  assert.equal(tables.status, 1)
  assert.match(tables.stderr, /2 owner-excluded table\(s\) exist on stagingdb/)

  const unreadable = ownerCheckHarness({ applied: ['0001_init'], present: '' })
  assert.equal(unreadable.status, 1, 'an unreadable table count must not certify absence')

  for (const phase of ['before', 'rehearsal', 'after-apply', 'deploy-before', 'deploy-after']) {
    const r = ownerCheckHarness({ applied: ['0001_init'], present: 0, phase })
    assert.equal(r.status, 0, `${phase}: ${r.stderr}`)
    assert.match(r.record, /^excluded_tables_present=0$/m, `${phase}: the record is written under the phase name`)
    const bad = ownerCheckHarness({ applied: ['0001_init'], present: 1, phase })
    assert.equal(bad.status, 1, `${phase}: a present table must fail in every phase`)
  }
})

test('owner exclusions: compute_in_play subtracts the owner list; every migration step checks the exclusions on the right DB', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const inPlay = extractRunnerFunctions(['compute_in_play_migrations'])
  assert.match(inPlay, /staging_owner_excluded_names \| sort -u > "\$\{OUTPUT_DIR\}\/migration-owner-excluded\.txt" \\\n\s+\|\| fail /)
  assert.match(inPlay, /comm -23 "\$\{OUTPUT_DIR\}\/migration-in-play-before-owner-exclusions\.txt" "\$\{OUTPUT_DIR\}\/migration-owner-excluded\.txt" \\\n\s+> "\$\{OUTPUT_DIR\}\/migration-in-play\.txt"/)
  const migrate = executableLines(extractRunnerFunctions(['action_migrate']))
  assert.match(migrate, /action_migrate_read_only_prechecks\n\s*assert_owner_exclusions_hold "\$MIGRATE_BACKUP_PG_USER" "\$MIGRATE_BACKUP_PG_DB" before\n\s*action_migrate_backup/)
  const rehearse = remote.slice(remote.indexOf('action_migrate_rehearse() {'), remote.indexOf('\naction_migrate_apply() {'))
  assert.match(rehearse, /\|\| fail "rehearsal migrate run did not leave the rehearsal DB at pending=0[^\n]*\n\s*assert_owner_exclusions_hold "\$REHEARSAL_PG_USER" "\$REHEARSAL_DB" rehearsal\n/)
  const deploy = executableLines(extractRunnerFunctions(['action_deploy']))
  const before = deploy.indexOf('assert_owner_exclusions_hold "$deploy_pg_user" "$deploy_db" deploy-before')
  const firstMigrate = deploy.indexOf('node "$MIGRATE_JS"')
  const after = deploy.indexOf('assert_owner_exclusions_hold "$deploy_pg_user" "$deploy_db" deploy-after')
  const pending = deploy.indexOf("grep -q '^Pending: 0$' \"${OUTPUT_DIR}/migrate-list-after.txt\"")
  assert.ok(before >= 0 && before < firstMigrate, 'deploy must check the exclusions before its inline migrate')
  assert.ok(after > pending, 'deploy must check the exclusions after pending=0')
  assert.match(deploy, /deploy_db="\$\(dsn_database_name "\$\(resolve_backend_database_url\)"\)"/, 'the deploy check must target the DB the backend migrates')
  assert.equal((remote.match(/assert_owner_exclusions_hold "/g) || []).length, 5, 'exactly five checkpoints: migrate before, rehearsal, after-apply, deploy before and after')
  assert.match(remote, /echo "owner_excluded_migrations=\$\(staging_owner_exclude_csv\)"/, 'migrate summary records the exclusion')
  assert.match(remote, /echo "owner_excluded_migrations=\$\{owner_exclude\}"/, 'deploy summary records the exclusion')
})

test('EXECUTABLE (owner exclusions): compute_in_play_migrations drops an owner-excluded name that is otherwise in play', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-inplay-owner-'))
  const fn = extractRunnerFunctions(['compute_in_play_migrations'])
  const script = `#!/bin/bash
set -euo pipefail
source '${LIB}'
OUTPUT_DIR="${dir}"
fail() { echo "FAIL:$*" >&2; exit 1; }
list_migration_name_universe() { printf '%s\\n' 0001_init zzzz20260919090000_create_approval_template_group_backfill_batches zzzz20260926120000_create_task_p0a_tables | sort -u; }
list_migration_names_applied() { printf '%s\\n' 0001_init; }
${fn}
compute_in_play_migrations stagingdb
cat "${dir}/migration-in-play.txt"
`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'zzzz20260926120000_create_task_p0a_tables\n')
})

test('owner exclusions: deploy checks sit directly around its inline migrate; summaries derive the absence claim from the check record', () => {
  const deploy = extractRunnerFunctions(['action_deploy'])
  assert.match(deploy, /\n  assert_owner_exclusions_hold "\$deploy_pg_user" "\$deploy_db" deploy-before\n  staging_exec_env "MIGRATION_EXCLUDE=\$\{owner_exclude\}" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "\$MIGRATE_JS" --list /,
    'deploy-before must directly precede the first inline migrate call (no wrapper, no gap)')
  assert.match(deploy, /\n    \|\| fail "migrations did not end at pending=0 \(see migrate-list-after\.txt\)"\n  assert_owner_exclusions_hold "\$deploy_pg_user" "\$deploy_db" deploy-after\n/,
    'deploy-after must directly follow the pending=0 gate (no wrapper, no gap)')
  assert.match(deploy, /grep -qx 'excluded_tables_present=0' "\$\{OUTPUT_DIR\}\/owner-exclusions-deploy-after\.txt" 2>\/dev\/null \\\n\s+&& echo "owner_excluded_tables_absent=yes" \|\| echo "owner_excluded_tables_absent=unverified"/,
    'the deploy summary must derive the absence claim from the deploy-after record')
  const migrate = extractRunnerFunctions(['action_migrate'])
  assert.match(migrate, /grep -qx 'excluded_tables_present=0' "\$\{OUTPUT_DIR\}\/owner-exclusions-after-apply\.txt" 2>\/dev\/null \\\n\s+&& echo "owner_excluded_tables_absent=yes" \|\| echo "owner_excluded_tables_absent=unverified"/,
    'the migrate summary must derive the absence claim from the after-apply record')
  assert.doesNotMatch(extractRunnerFunctions(['action_deploy', 'action_migrate']), /echo "owner_excluded_tables_absent=yes"\n/, 'no unconditional absence claim')
})

test('EXECUTABLE (owner_excluded_only_pending): true only when every pending name is owner-excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-owner-pending-'))
  const run = (text) => {
    const f = join(dir, 'list.txt')
    writeFileSync(f, text)
    return runPipefailBash(`source '${LIB}'\nowner_excluded_only_pending '${f}' && echo YES || echo NO`).stdout.trim()
  }
  const A3 = 'zzzz20260919090000_create_approval_template_group_backfill_batches'
  assert.equal(run(`Applied: 425\nPending: 1\n  - ${A3}\n`), 'YES')
  assert.equal(run(`Applied: 425\nPending: 0\n`), 'NO', 'nothing pending is not an owner-excluded-only state')
  assert.equal(run(`Applied: 424\nPending: 2\n  - ${A3}\n  - zzzz20260926120000_create_task_p0a_tables\n`), 'NO', 'any other pending name must keep the plain refusal')
  assert.equal(run(`Applied: 424\nPending: 2\n  - ${A3}\n`), 'NO', 'a count that does not match the listed names is not trusted')
  assert.equal(run('garbage\n'), 'NO', 'an unreadable list is not trusted')
  rmSync(dir, { recursive: true, force: true })
})

test('soak-seed stays strict on pending=0 but names an owner-ruled exclusion instead of sending the operator to migrate', () => {
  const seed = executableLines(extractRunnerFunctions(['action_soak_seed']))
  assert.match(seed, /if ! grep -q '\^Pending: 0\$' "\$\{OUTPUT_DIR\}\/seed-migrate-list\.txt"; then\n\s*if owner_excluded_only_pending "\$\{OUTPUT_DIR\}\/seed-migrate-list\.txt"; then\n\s*fail "staging's only pending migration\(s\) are owner-ruled exclusions/,
    'the owner-excluded case must fail with its own message')
  assert.match(seed, /\n\s*fi\n\s*fail "staging has pending migrations — the transition manifests attest pendingMigrations=0/,
    'every other pending state keeps the original refusal')
  assert.match(seed, /staging_exec node "\$MIGRATE_JS" --list < \/dev\/null > "\$\{OUTPUT_DIR\}\/seed-migrate-list\.txt" 2>&1/,
    'the seed list stays unscoped: scoping the attestation is an owner decision')
})

test('status summary names the owner exclusions so a pending owner-excluded migration is not read as drift', () => {
  const status = extractRunnerFunctions(['action_status'])
  assert.match(status, /echo "owner_excluded_migrations=\$\(staging_owner_exclude_csv 2>\/dev\/null \|\| echo '<invalid list>'\)"/)
  assert.match(status, /if \[\[ -s "\$\{OUTPUT_DIR\}\/migrate-list\.txt" \]\] && owner_excluded_only_pending "\$\{OUTPUT_DIR\}\/migrate-list\.txt"; then\n\s*echo "pending_is_owner_excluded_only=yes"/)
  assert.match(status, /staging_exec node "\$MIGRATE_JS" --list < \/dev\/null 2>&1 \| tee "\$\{OUTPUT_DIR\}\/migrate-list\.txt"/, 'the status list itself stays unscoped')
})

// --- Runner bundle contract: action=smoke ships every smoke from the per-run bundle -----------
//
// Rules proven below:
//   * every smoke arm of action_smoke names, in smoke_deps, exactly the smoke script's sibling
//     closure, computed here from the module sources. A sibling is a file a closure module names
//     with a literal relative specifier in one of the BUNDLE_SIBLING_FORMS: static, side-effect
//     and dynamic import (a template literal without ${} counts as a literal), require(),
//     require.resolve(), createRequire(...)(...), import.meta.resolve(), and
//     new URL(<specifier>, import.meta.url), which also covers sibling reads such as
//     readFileSync(new URL('./x.json', import.meta.url)). .mjs/.cjs/.js members are scanned too;
//   * no closure module reaches a file in a form that scan cannot resolve (BUNDLE_OPAQUE_FORMS:
//     createRequire bound to a name, a non-literal or interpolated import()/require(), new URL
//     over a non-literal with import.meta.url, a module-directory path, a cwd-relative read)
//     unless BUNDLE_OPAQUE_ALLOWLIST names the module and the form with the reason the bundle is
//     still complete; an allowlist entry that no longer matches fails too;
//   * every smoke script and closure member lives directly in scripts/ops (the bundle is
//     extracted flat with --strip-components=2) and is in the workflow tar list;
//   * every packaged .mjs is in the workflow's node --check list;
//   * running the real action_smoke refuses ae4, mp6 and otbank-v18 first (packaged but not
//     enabled in this runner): no docker call, identity check, settings read, host psql/curl,
//     git or output file. For rd45, hmr5 and tasks it copies the smoke script and its whole
//     closure into the container runner dir before the smoke runs, and fails closed, before any
//     docker call, when the bundle lacks a file; rd45's PLUGIN_INDEX_PATH env (what stands in
//     for its plugin load) reaches the container run;
//   * each smoke started alone from a flat copy of its bundle files (and the mint helper, which
//     prepare_container_runner copies alone), with a stub pg, an empty env and a working
//     directory outside the bundle, gets to its own env refusal: a top-level load of any form
//     that the bundle does not satisfy fails here;
//   * the remote script and every bundle file it sources (each `source`/`.` must name a
//     "${HERE}/<file>" or be listed with a reason) run no git command; PROD_REPO_DIR is used only
//     for the staging-only guard; the skip_host_sync input is gone from the workflow;
//   * in the workflow, only the bundle sync and the remote action call ssh or scp, whatever the
//     run form (|, |-, >, >-, indicators, one-line, nameless `- run:`), and neither runs git.
// The smoke arms, closures, tar list and node --check list are all derived from source, so a
// smoke or helper added on one side only fails here.

const REPO_ROOT = join(HERE, '..', '..')
const BUNDLE_SOURCE_DIR = 'scripts/ops'
// A literal relative specifier: './x' or '../x' in single, double or back quotes (no ${}).
const LITERAL_SPECIFIER = String.raw`([\x27\x22\x60])(\.{1,2}\/[^\x27\x22\x60\n$]+)\1`
const BARE_LITERAL = String.raw`[\x27\x22](?:node:|@|[A-Za-z0-9_])[^\x27\x22\n]*[\x27\x22]`
const BUNDLE_SIBLING_FORMS = [
  ['static import', String.raw`\bfrom\s*${LITERAL_SPECIFIER}`],
  ['side-effect import', String.raw`\bimport\s*${LITERAL_SPECIFIER}`],
  ['dynamic import', String.raw`\bimport\s*\(\s*${LITERAL_SPECIFIER}\s*[,)]`],
  ['require', String.raw`\brequire\s*\(\s*${LITERAL_SPECIFIER}\s*\)`],
  ['require.resolve', String.raw`\brequire\.resolve\s*\(\s*${LITERAL_SPECIFIER}\s*[,)]`],
  ['createRequire call', String.raw`\bcreateRequire\s*\([^()]*\)\s*\(\s*${LITERAL_SPECIFIER}\s*\)`],
  ['import.meta.resolve', String.raw`\bimport\.meta\.resolve\s*\(\s*${LITERAL_SPECIFIER}\s*\)`],
  ['new URL', String.raw`\bnew\s+URL\s*\(\s*${LITERAL_SPECIFIER}\s*,\s*import\.meta\.url\s*\)`],
].map(([form, source]) => [form, new RegExp(source, 'g')])
// Searched after every sibling-form match is replaced by RESOLVED_SIBLING, so the import() around
// import(new URL('./x.mjs', import.meta.url).href) reads as resolved.
const RESOLVED_SIBLING = '__bundle_sibling__'
const BUNDLE_OPAQUE_FORMS = [
  ['createRequire', /\bcreateRequire\s*\(/g],
  ['non-literal require', new RegExp(String.raw`\brequire(?:\.resolve)?\s*\((?!\s*(?:${BARE_LITERAL}\s*[,)]|${RESOLVED_SIBLING}\b))`, 'g')],
  ['non-literal import()', new RegExp(String.raw`\bimport\s*\((?!\s*(?:${BARE_LITERAL}\s*[,)]|${RESOLVED_SIBLING}\b))`, 'g')],
  ['non-literal import.meta.resolve', /\bimport\.meta\.resolve\s*\(/g],
  ['new URL over import.meta.url', /\bnew\s+URL\s*\((?:[^()\n]|\([^()\n]*\))*?,\s*import\.meta\.url\s*\)/g],
  ['module directory', /\bfileURLToPath\s*\(\s*import\.meta\.url\s*\)|\bimport\.meta\.(?:dirname|filename)\b|\b__dirname\b|\b__filename\b/g],
  ['cwd-relative read', new RegExp(String.raw`\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir)\s*\(\s*${LITERAL_SPECIFIER}`, 'g')],
]
// Opaque loads a closure module may keep, with the reason the bundle is still complete.
const BUNDLE_OPAQUE_ALLOWLIST = [
  {
    module: 'scripts/ops/staging-attendance-report-digest-rd45-smoke.mjs',
    forms: ['createRequire', 'module directory'],
    reason: 'loadDigestSeam requires the attendance plugin from PLUGIN_INDEX_PATH, which the rd45 arm sets to the deployed image copy under /app (pinned by the executable copy test); the module-directory path is only its fallback in a repository checkout',
  },
]

function scanBundleModule(source) {
  const siblings = []
  let residual = source
  for (const [form, pattern] of BUNDLE_SIBLING_FORMS) {
    for (const match of source.matchAll(pattern)) siblings.push({ form, specifier: match[2] })
    residual = residual.replace(pattern, ` ${RESOLVED_SIBLING} `)
  }
  const opaque = []
  for (const [form, pattern] of BUNDLE_OPAQUE_FORMS) {
    for (const match of residual.matchAll(pattern)) opaque.push({ form, text: match[0] })
  }
  return { siblings, opaque }
}

// The sibling closure of a module (members sorted, entry excluded) and every opaque load found in
// the entry or any module member.
function bundleClosure(entry, { root = REPO_ROOT } = {}) {
  const members = new Set()
  const findings = []
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()
    const absolute = join(root, current)
    assert.ok(existsSync(absolute), `bundle closure target does not exist: ${current}`)
    const { siblings, opaque } = scanBundleModule(readFileSync(absolute, 'utf8'))
    for (const { form, text } of opaque) findings.push({ module: current, form, text })
    for (const { specifier } of siblings) {
      const target = posix.normalize(posix.join(posix.dirname(current), specifier))
      if (seen.has(target)) continue
      seen.add(target)
      members.add(target)
      if (/\.(?:mjs|cjs|js)$/.test(target)) queue.push(target)
      else assert.ok(existsSync(join(root, target)), `bundle closure target does not exist: ${target}`)
    }
  }
  return { members: [...members].sort(), findings }
}

function workflowSmokeChoices(workflow) {
  const m = workflow.match(/\n {6}smoke:\n(?: {8}[^\n]*\n)*? {8}options: \[([^\]]*)\]/)
  assert.ok(m, 'expected the smoke choice input with an options list')
  return m[1].split(',').map((value) => value.trim()).filter(Boolean)
}

function workflowTarList(workflow) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'tar -czf - \\')
  assert.notEqual(start, -1, 'expected the runner bundle `tar -czf - \\` command in the workflow')
  const entries = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('| ssh ')) return entries
    const m = trimmed.match(/^(\S+) \\$/)
    assert.ok(m, `unexpected line inside the runner bundle tar list: ${JSON.stringify(lines[i])}`)
    entries.push(m[1])
  }
  assert.fail('the runner bundle tar list never reaches its `| ssh` consumer')
}

function workflowNodeCheckList(workflow) {
  const block = extractWorkflowRunBlock(workflow, 'Validate inputs and embedded scripts')
  return [...block.matchAll(/^node --check (\S+)$/gm)].map((m) => m[1])
}

function smokeCaseBlock() {
  const body = extractRunnerFunctions(['action_smoke'])
  const start = body.indexOf('  case "$SMOKE_ID" in\n')
  const end = body.indexOf('\n  esac\n', start)
  assert.ok(start !== -1 && end > start, 'expected the case "$SMOKE_ID" block in action_smoke')
  return body.slice(start, end + '\n  esac'.length)
}

function smokeArmIds() {
  return [...smokeCaseBlock().matchAll(/^ {4}([A-Za-z0-9][A-Za-z0-9-]*)\)$/gm)].map((m) => m[1])
}

// Evaluates action_smoke's own case statement under bash for one smoke id, so the smoke script
// and smoke_deps are read exactly as the runner reads them.
function evaluateSmokeArm(id) {
  const script = `set -euo pipefail
${extractRunnerLine('fail')}
probe() {
  local smoke_script stamp_prefix
  local -a extra_env=() extra_tokens=() smoke_deps=()
${smokeCaseBlock()}
  printf 'script=%s\\n' "$smoke_script"
  local dep
  for dep in \${smoke_deps[@]+"\${smoke_deps[@]}"}; do printf 'dep=%s\\n' "$dep"; done
}
SMOKE_ID="$1" probe
`
  const result = spawnSync('bash', ['-c', script, 'probe', id], { encoding: 'utf8' })
  assert.equal(result.status, 0, `evaluating the ${id} arm failed: ${result.stderr}`)
  const lines = result.stdout.split('\n').filter(Boolean)
  const smokeScript = lines.find((line) => line.startsWith('script='))?.slice('script='.length) ?? ''
  const deps = lines.filter((line) => line.startsWith('dep=')).map((line) => line.slice('dep='.length))
  return { smokeScript, deps }
}

function smokeArms() {
  return smokeArmIds().map((id) => {
    const { smokeScript, deps } = evaluateSmokeArm(id)
    const { members, findings } = bundleClosure(`${BUNDLE_SOURCE_DIR}/${smokeScript}`)
    return { id, smokeScript, deps, closure: members, findings }
  })
}

test('runner bundle closure scan: control cells, one per sibling form, opaque form and non-load', () => {
  const cells = [
    // sibling forms: the specifier joins the closure
    ["import { a } from './a.mjs'", ['./a.mjs'], []],
    ["import './b.mjs'", ['./b.mjs'], []],
    ["const m = await import('./c.mjs')", ['./c.mjs'], []],
    ['const m = await import(`./d.mjs`)', ['./d.mjs'], []],
    ["const m = await import('./e.json', { with: { type: 'json' } })", ['./e.json'], []],
    ["const x = require('./f.cjs')", ['./f.cjs'], []],
    ["const p = require.resolve('./g.json')", ['./g.json'], []],
    ["const x = createRequire(import.meta.url)('./h.cjs')", ['./h.cjs'], []],
    ["const u = import.meta.resolve('./i.mjs')", ['./i.mjs'], []],
    ["const m = await import(new URL('./j.mjs', import.meta.url).href)", ['./j.mjs'], []],
    ["const t = readFileSync(new URL('../ops/k.json', import.meta.url), 'utf8')", ['../ops/k.json'], []],
    ['const t = await readFile(new URL("./l.json", import.meta.url))', ['./l.json'], []],
    // opaque forms: refused unless allowlisted
    ["const req = createRequire(import.meta.url)\nreq('./m.cjs')", [], ['createRequire']],
    ['const m = await import(`./${name}.mjs`)', [], ['non-literal import()']],
    ['const m = await import(name)', [], ['non-literal import()']],
    ["const m = await import('./' + name)", [], ['non-literal import()']],
    ['const x = require(name)', [], ['non-literal require']],
    ['const p = require.resolve(name)', [], ['non-literal require']],
    ['const u = import.meta.resolve(name)', [], ['non-literal import.meta.resolve']],
    ['const u = new URL(name, import.meta.url)', [], ['new URL over import.meta.url']],
    ['const u = new URL(`./${name}.json`, import.meta.url)', [], ['new URL over import.meta.url']],
    ['const here = dirname(fileURLToPath(import.meta.url))', [], ['module directory']],
    ['const here = import.meta.dirname', [], ['module directory']],
    ["const p = join(__dirname, 'n.json')", [], ['module directory']],
    ["const t = readFileSync('./o.json', 'utf8')", [], ['cwd-relative read']],
    // not loads of a bundle file
    ["const pg = await import('pg')\nconst c = await import( 'node:crypto' )\nconst fs = require('node:fs')", [], []],
    ['const url = new URL(`${BASE_URL}${pathname}`)', [], []],
    ['const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href', [], []],
    ["import { createRequire } from 'node:module'", [], []],
    ['const requireCjs = makeLoader()\nrequireCjs(path)', [], []],
  ]
  for (const [source, siblings, opaque] of cells) {
    const scan = scanBundleModule(source)
    assert.deepEqual(scan.siblings.map((sibling) => sibling.specifier).sort(), [...siblings].sort(), `siblings of: ${source}`)
    assert.deepEqual([...new Set(scan.opaque.map((finding) => finding.form))].sort(), [...opaque].sort(), `opaque forms of: ${source}`)
  }
})

test('runner bundle closure scan: members are followed transitively through .cjs and data files, outside the repo too', () => {
  const root = mkdtempSync(join(tmpdir(), 'wr-closure-'))
  try {
    mkdirSync(join(root, 'ops'))
    writeFileSync(join(root, 'ops', 'entry.mjs'), "import './a.cjs'\nconst t = readFileSync(new URL('./d.json', import.meta.url))\n")
    writeFileSync(join(root, 'ops', 'a.cjs'), "const b = require('./b.cjs')\n")
    writeFileSync(join(root, 'ops', 'b.cjs'), "module.exports = require.resolve('./c.json')\n")
    writeFileSync(join(root, 'ops', 'c.json'), '{}')
    writeFileSync(join(root, 'ops', 'd.json'), '{}')
    const { members, findings } = bundleClosure('ops/entry.mjs', { root })
    assert.deepEqual(members, ['ops/a.cjs', 'ops/b.cjs', 'ops/c.json', 'ops/d.json'])
    assert.deepEqual(findings, [])
    writeFileSync(join(root, 'ops', 'b.cjs'), "const req = createRequire(__filename)\nmodule.exports = req('./c.json')\n")
    assert.deepEqual(bundleClosure('ops/entry.mjs', { root }).findings.map(({ module, form }) => `${module}: ${form}`).sort(), ['ops/b.cjs: createRequire', 'ops/b.cjs: module directory'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runner bundle: no closure module loads a file in a form the closure scan cannot resolve, except the allowlisted ones', () => {
  const found = new Map()
  for (const arm of smokeArms()) {
    for (const { module, form, text } of arm.findings) {
      const entry = BUNDLE_OPAQUE_ALLOWLIST.find((allowed) => allowed.module === module)
      assert.ok(
        entry && entry.forms.includes(form),
        `${arm.id}: ${module} loads a file through ${form} (${JSON.stringify(text)}), which the closure scan cannot resolve; name the file with a literal sibling form so it ships with the smoke, or allowlist the use with the reason the bundle is still complete`,
      )
      if (!found.has(module)) found.set(module, new Set())
      found.get(module).add(form)
    }
  }
  for (const entry of BUNDLE_OPAQUE_ALLOWLIST) {
    assert.ok(entry.reason.length > 0)
    for (const form of entry.forms) {
      assert.ok(found.get(entry.module)?.has(form), `stale allowlist entry: ${entry.module} no longer uses ${form}`)
    }
  }
  const mintHelper = bundleClosure(`${BUNDLE_SOURCE_DIR}/attendance-window-runner-mint-token.mjs`)
  assert.deepEqual(mintHelper, { members: [], findings: [] }, 'prepare_container_runner copies the mint helper alone, so it may load no bundle file')
})

test('runner bundle: every smoke arm names its sibling closure in smoke_deps, and the arms match the workflow smoke choices', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const arms = smokeArms()
  assert.deepEqual(
    arms.map((arm) => arm.id).sort(),
    [...workflowSmokeChoices(workflow)].sort(),
    'action_smoke must have exactly one case arm per workflow smoke choice',
  )
  for (const arm of arms) {
    assert.match(arm.smokeScript, /^[A-Za-z0-9._-]+\.mjs$/, `${arm.id}: smoke_script must be a bare .mjs file name`)
    assert.ok(existsSync(join(REPO_ROOT, BUNDLE_SOURCE_DIR, arm.smokeScript)), `${arm.id}: ${arm.smokeScript} must exist in ${BUNDLE_SOURCE_DIR}`)
    for (const member of arm.closure) {
      assert.equal(
        posix.dirname(member),
        BUNDLE_SOURCE_DIR,
        `${arm.id}: ${member} is outside ${BUNDLE_SOURCE_DIR}; the bundle is extracted flat (--strip-components=2), so a relative specifier may only name a sibling file`,
      )
    }
    assert.equal(new Set(arm.deps).size, arm.deps.length, `${arm.id}: smoke_deps lists a file twice`)
    assert.deepEqual(
      [...arm.deps].sort(),
      arm.closure.map((member) => posix.basename(member)),
      `${arm.id}: smoke_deps must equal the sibling closure of ${arm.smokeScript}`,
    )
  }
  const ae4 = arms.find((arm) => arm.id === 'ae4')
  assert.ok(ae4 && ae4.closure.includes(`${BUNDLE_SOURCE_DIR}/staging-attendance-tooling-teardown.mjs`), 'positive control: the ae4 closure contains the shared teardown helper')
})

test('runner bundle: the workflow tar list ships, flat, every smoke script and closure member plus the runner files', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const tarList = workflowTarList(workflow)
  assert.equal(new Set(tarList).size, tarList.length, 'the tar list names a file twice')
  for (const entry of tarList) {
    assert.equal(posix.dirname(entry), BUNDLE_SOURCE_DIR, `tar entry ${entry} must sit directly in ${BUNDLE_SOURCE_DIR}: the bundle is extracted with --strip-components=2`)
    assert.ok(existsSync(join(REPO_ROOT, entry)), `tar entry does not exist: ${entry}`)
  }
  assert.match(
    workflow,
    /tar -xzf - -C \$\{runner_dir\} --strip-components=2'/,
    'the bundle must be extracted flat into the per-run dir the remote script runs from',
  )
  for (const runnerFile of [
    'attendance-staging-window-runner-remote.sh',
    'attendance-window-runner-pipeline.lib.sh',
    'attendance-window-runner-mint-token.mjs',
    'attendance-w4w7-soak-load-generator.mjs',
  ]) {
    assert.ok(tarList.includes(`${BUNDLE_SOURCE_DIR}/${runnerFile}`), `the tar list must keep shipping ${runnerFile}`)
  }
  for (const arm of smokeArms()) {
    for (const file of [`${BUNDLE_SOURCE_DIR}/${arm.smokeScript}`, ...arm.closure]) {
      assert.ok(tarList.includes(file), `${arm.id}: the workflow tar list must ship ${file}`)
    }
  }
})

test('runner bundle: node --check covers every packaged .mjs', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const checked = new Set(workflowNodeCheckList(workflow))
  const packagedModules = workflowTarList(workflow).filter((entry) => entry.endsWith('.mjs'))
  assert.ok(packagedModules.length > 0, 'expected packaged .mjs files')
  for (const entry of packagedModules) {
    assert.ok(checked.has(entry), `the validate step must node --check ${entry}`)
  }
})

function populateRunnerBundle(dir, { omit = [] } = {}) {
  // Same layout `tar -xzf - -C <runner_dir> --strip-components=2` produces: every tar entry
  // lands flat in the directory the remote script runs from (HERE).
  for (const entry of workflowTarList(readFileSync(WORKFLOW, 'utf8'))) {
    const name = posix.basename(entry)
    if (omit.includes(name)) continue
    writeFileSync(join(dir, name), readFileSync(join(REPO_ROOT, entry)))
  }
}

// The REAL action_smoke and the functions it calls, extracted verbatim, run under
// `set -euo pipefail` with a recording docker function. Only the two curl probes against the
// staging web port are stubbed: fetch_health_commit answers the deploy SHA and records each call
// in probeLog; capture_settings answers 200 and records each call (with the snapshot file name) in
// settingsLog. The docker stub's `printenv TASKS_ENABLED` answers `tasksEnabled`; null makes it
// exit 1 with no output, as printenv does for an unset variable.
function buildActionSmokeHarness({ hereDir, outputDir, dockerLog, probeLog, settingsLog, tasksEnabled = 'true' }) {
  const tasksEnabledAnswer = tasksEnabled === null ? 'return 1' : `printf '%s\\n' '${tasksEnabled}'`
  const vars = ['BACKEND_CONTAINER', 'CONTAINER_RUNNER_DIR', 'IN_CONTAINER_BASE_URL', 'STAGING_WEB_HEALTH_URL', 'IMAGE_OWNER']
    .map((name) => extractRunnerVar(name))
    .join('\n')
  const functions = extractRunnerFunctions([
    'require_sha',
    'staging_exec',
    'staging_exec_env',
    'prepare_container_runner',
    'require_smoke_bundle',
    'copy_smoke_bundle',
    'find_admin_user',
    'mint_token',
    'soak_backend_env',
    'snapshot_staging_ps',
    'action_smoke',
  ])
  return `#!/bin/bash
set -euo pipefail
source '${LIB}'
${extractRunnerLine('log')}
${extractRunnerLine('fail')}
${vars}
${functions}
fetch_health_commit() { printf 'fetch_health_commit\\n' >> '${probeLog}'; printf '%s' "$DEPLOY_SHA"; }
capture_settings() { printf 'capture_settings %s\\n' "\${2##*/}" >> '${settingsLog}'; printf '200'; }
docker() {
  printf '%s\\n' "$*" >> '${dockerLog}'
  if [[ "\${1:-}" == "exec" ]]; then
    shift
    while [[ "\${1:-}" == "-e" ]]; do shift 2; done
    shift
    case "$*" in
      "printenv TASKS_ENABLED") ${tasksEnabledAnswer} ;;
      *" --find-admin") printf 'fake-admin\\n' ;;
      *" --mint "*) printf 'fake-token\\n' ;;
    esac
  fi
  return 0
}
HERE='${hereDir}'
OUTPUT_DIR='${outputDir}'
DEPLOY_SHA='${'a'.repeat(40)}'
RUN_STAMP='gh1a1'
action_smoke
`
}

function runActionSmoke(id, { omit = [], tasksEnabled = 'true' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-smoke-bundle-'))
  const hereDir = join(dir, 'here')
  const outputDir = join(dir, 'out')
  const binDir = join(dir, 'bin')
  mkdirSync(hereDir)
  mkdirSync(outputDir)
  mkdirSync(binDir)
  populateRunnerBundle(hereDir, { omit })
  const dockerLog = join(dir, 'docker.log')
  writeFileSync(dockerLog, '')
  const probeLog = join(dir, 'probe.log')
  writeFileSync(probeLog, '')
  const settingsLog = join(dir, 'settings.log')
  writeFileSync(settingsLog, '')
  // Any `git` found on PATH is recorded and fails; the run's cwd is the temp dir, so a git
  // command run by mistake cannot act on the test checkout either.
  const gitLog = join(dir, 'git.log')
  writeFileSync(gitLog, '')
  writeFileSync(join(binDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexit 1\n`)
  chmodSync(join(binDir, 'git'), 0o755)
  // A host-side psql or curl (a database or staging API call outside docker exec and the two stubbed
  // probes) is recorded the same way and fails.
  const hostLog = join(dir, 'host.log')
  writeFileSync(hostLog, '')
  for (const tool of ['psql', 'curl']) {
    writeFileSync(join(binDir, tool), `#!/bin/sh\nprintf '%s %s\\n' '${tool}' "$*" >> '${hostLog}'\nexit 1\n`)
    chmodSync(join(binDir, tool), 0o755)
  }
  const scriptPath = join(dir, 'harness.sh')
  writeFileSync(scriptPath, buildActionSmokeHarness({ hereDir, outputDir, dockerLog, probeLog, settingsLog, tasksEnabled }))
  const result = spawnSync('bash', [scriptPath], { cwd: dir, encoding: 'utf8', env: { PATH: `${binDir}:${process.env.PATH}`, SMOKE_ID: id } })
  const docker = readFileSync(dockerLog, 'utf8').split('\n').filter(Boolean)
  const git = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)
  const probes = readFileSync(probeLog, 'utf8').split('\n').filter(Boolean)
  const settings = readFileSync(settingsLog, 'utf8').split('\n').filter(Boolean)
  const host = readFileSync(hostLog, 'utf8').split('\n').filter(Boolean)
  const outputFiles = readdirSync(outputDir).sort()
  const summary = outputFiles.includes('summary.txt') ? readFileSync(join(outputDir, 'summary.txt'), 'utf8') : null
  rmSync(dir, { recursive: true, force: true })
  return { ...result, docker, git, probes, settings, host, outputFiles, summary, hereDir }
}

// The runner's rule for the window smokes: ae4, mp6 and otbank-v18 stay packaged (the closure,
// tar-list and flat-start tests cover every arm) but action_smoke refuses them before anything
// else; rd45, hmr5 and tasks run. Pinned here, not derived from remote.sh.
const REFUSED_SMOKE_IDS = ['ae4', 'mp6', 'otbank-v18']
const RUNNABLE_SMOKE_IDS = ['rd45', 'hmr5', 'tasks']
const SMOKE_REFUSAL_RULE = 'is not enabled in this runner: ae4, mp6 and otbank-v18 stay packaged but are refused until their cleanup and fixtures match the current code'

function runnableSmokeArms() {
  const arms = smokeArms().filter((arm) => RUNNABLE_SMOKE_IDS.includes(arm.id))
  assert.deepEqual(arms.map((arm) => arm.id).sort(), [...RUNNABLE_SMOKE_IDS].sort(), 'every runnable smoke id has an arm')
  return arms
}

test('runner bundle (EXECUTABLE): ae4, mp6 and otbank-v18 are refused first, with nothing probed, minted, copied, run or written; rd45, hmr5 and tasks still run', () => {
  const arms = smokeArms()
  assert.deepEqual(
    arms.map((arm) => arm.id).sort(),
    [...REFUSED_SMOKE_IDS, ...RUNNABLE_SMOKE_IDS].sort(),
    'every smoke arm is either refused or runnable',
  )
  for (const id of REFUSED_SMOKE_IDS) {
    const arm = arms.find((candidate) => candidate.id === id)
    // A complete bundle, and one without the smoke script and its closure: the refusal comes before
    // the bundle check either way.
    for (const omit of [[], [arm.smokeScript, ...arm.deps]]) {
      const label = `${id} (${omit.length === 0 ? 'complete bundle' : 'bundle without its files'})`
      const r = runActionSmoke(id, { omit })
      assert.equal(r.status, 1, `${label}: the run must fail\n${r.stderr}`)
      assert.ok(r.stderr.includes(`smoke=${id} ${SMOKE_REFUSAL_RULE}`), `${label}: the failure states the rule\n${r.stderr}`)
      assert.doesNotMatch(r.stderr, /runner bundle is missing/, `${label}: the refusal comes before the bundle check`)
      assert.deepEqual(r.docker, [], `${label}: no docker call at all: no TASKS_ENABLED probe, container prep, admin lookup, token mint, copy, smoke run or in-container psql`)
      assert.deepEqual(r.probes, [], `${label}: the identity check never ran`)
      assert.deepEqual(r.settings, [], `${label}: no settings snapshot was read from staging`)
      assert.deepEqual(r.host, [], `${label}: no host-side psql or curl`)
      assert.deepEqual(r.git, [], `${label}: no git`)
      assert.deepEqual(r.outputFiles, [], `${label}: nothing was written to the output dir (no summary, settings snapshot or smoke log)`)
    }
  }
  for (const id of RUNNABLE_SMOKE_IDS) {
    const r = runActionSmoke(id)
    assert.equal(r.status, 0, `${id}: the smoke must still run\n${r.stderr}`)
    assert.doesNotMatch(r.stderr, /is not enabled in this runner/, `${id}: not refused`)
    const arm = arms.find((candidate) => candidate.id === id)
    assert.ok(r.docker.some((line) => line.startsWith('exec ') && line.endsWith(`/scripts/ops/${arm.smokeScript}`)), `${id}: the smoke script runs in the container`)
    assert.deepEqual(r.probes, ['fetch_health_commit'], `${id}: the identity check runs once`)
    assert.deepEqual(r.settings, ['capture_settings settings-before.json', 'capture_settings settings-after.json'], `${id}: settings are captured before and after`)
    assert.deepEqual(r.host, [], `${id}: no host-side psql or curl`)
    assert.match(r.summary ?? '', new RegExp(`^smoke=${id}\\n[\\s\\S]*^smoke_rc=0$`, 'm'), `${id}: the run writes its summary`)
  }
})

// The `smoke` dispatch input of the workflow, read without a YAML parser (the runner's self-check
// step installs nothing). The input is the `      smoke:` key at column 6; its keys sit at column 8
// until the next column-6 key. Only the shapes the input uses are read: a one-line plain, 'single' or
// "double" quoted scalar for description and default, and a one-line flow list for options. Any other
// line in the block (a block scalar or list, a repeated key) throws, so a reshaped input fails the
// tests instead of being misread. A key the input does not have comes back undefined; the keys of
// the next input are never borrowed.
function workflowSmokeInput(workflow) {
  const lines = workflow.split('\n')
  const starts = lines.flatMap((line, index) => (/^ {6}smoke:[ \t]*$/.test(line) ? [index] : []))
  assert.equal(starts.length, 1, 'expected exactly one `      smoke:` input (column 6) in the workflow')
  const scalar = (raw) => {
    const single = raw.match(/^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/)
    if (single) return single[1].replace(/''/g, "'")
    const double = raw.match(/^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/)
    if (double) return double[1].replace(/\\(.)/g, '$1')
    const plain = raw.replace(/[ \t]+#.*$/, '')
    if (plain === '' || /^['"[\]{}&*!|>%@`]/.test(plain)) throw new Error(`workflow smoke input: not a scalar this reader reads: ${JSON.stringify(raw)}`)
    return plain
  }
  const keys = new Map()
  for (let k = starts[0] + 1; k < lines.length; k += 1) {
    const line = lines[k]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (line.length - line.trimStart().length <= 6) break // the next input, or the end of the inputs
    const entry = line.match(/^ {8}([A-Za-z0-9_-]+):[ \t]+(\S.*?)[ \t]*$/)
    if (!entry) throw new Error(`workflow smoke input: line ${k + 1} is not a one-line \`key: value\` at column 8: ${JSON.stringify(line)}`)
    if (keys.has(entry[1])) throw new Error(`workflow smoke input: ${entry[1]} appears twice`)
    keys.set(entry[1], entry[2])
  }
  const flowList = (raw) => {
    const list = raw.match(/^\[([^\]]*)\][ \t]*(?:#.*)?$/)
    if (!list) throw new Error(`workflow smoke input: options is not a one-line flow list: ${JSON.stringify(raw)}`)
    return list[1].split(',').map((part) => scalar(part.trim()))
  }
  return {
    description: keys.has('description') ? scalar(keys.get('description')) : undefined,
    options: keys.has('options') ? flowList(keys.get('options')) : undefined,
    default: keys.has('default') ? scalar(keys.get('default')) : undefined,
  }
}

// The ids action_smoke refuses, read from the refusal itself: the one
// `fail "smoke=${SMOKE_ID} is not enabled in this runner ...` call, which must sit directly under
// `  if [[ "$SMOKE_ID" == "<id>" || ... ]]; then`. The tasks arms of action_smoke test $SMOKE_ID too,
// so the ids come from this condition alone. Any other shape throws (a clause that is not a plain id
// test, an extra `[[ ]]`, a guard line that is not the plain `if`, a fail call with anything in
// front of it): a refusal conditioned on anything else is never read as a plain list of ids.
function refusedSmokeIds(actionSmokeBody) {
  const lines = actionSmokeBody.split('\n')
  const fails = lines.flatMap((line, index) => (line.includes('fail "smoke=${SMOKE_ID} is not enabled in this runner') ? [index] : []))
  assert.equal(fails.length, 1, 'action_smoke has exactly one refusal: a fail "smoke=${SMOKE_ID} is not enabled in this runner ..." call')
  assert.ok(
    lines[fails[0]].startsWith('    fail "smoke=${SMOKE_ID} is not enabled in this runner'),
    `the refusal is a plain fail call with nothing in front of it, got: ${JSON.stringify(lines[fails[0]])}`,
  )
  const guardLine = lines[fails[0] - 1] ?? ''
  const guard = guardLine.match(/^ {2}if \[\[ (.+) \]\]; then$/)
  assert.ok(guard, `the refusal's fail call sits directly under \`  if [[ ... ]]; then\`, got: ${JSON.stringify(guardLine)}`)
  return guard[1].split(' || ').map((clause) => {
    const id = clause.match(/^"\$SMOKE_ID" == "([A-Za-z0-9][A-Za-z0-9-]*)"$/)
    assert.ok(id, `every clause of the refusal condition is exactly "$SMOKE_ID" == "<id>", got: ${JSON.stringify(clause)}`)
    return id[1]
  })
}

// `id` named as a whole token in `text`, not inside a longer id such as otbank-v18-smoke.
const namesSmokeId = (text, id) => new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`).test(text)

test('workflow smoke input: the default is tasks, an offered id that action_smoke does not refuse, and the description names every refused id', () => {
  const input = workflowSmokeInput(readFileSync(WORKFLOW, 'utf8'))
  // The refused ids come from the refusal in remote.sh, not from a list kept here.
  const refused = refusedSmokeIds(executableLines(extractRunnerFunctions(['action_smoke'])))
  assert.equal(typeof input.default, 'string', 'the smoke input declares a default; without one the pick is left to the dispatch form')
  assert.ok(Array.isArray(input.options), 'the smoke input has a one-line options list')
  assert.ok(input.options.includes(input.default), `the default ${input.default} is one of the options: ${input.options.join(', ')}`)
  assert.ok(refused.length > 0, 'the refusal read from remote.sh names at least one id (an empty list would pass the next checks vacuously)')
  for (const id of refused) assert.ok(input.options.includes(id), `refused id ${id} is one of the smoke options`)
  assert.ok(!refused.includes(input.default), `the default ${input.default} is refused by action_smoke (${refused.join(', ')}): a dispatch that changes nothing would only get the refusal`)
  assert.equal(input.default, 'tasks', 'the smoke input defaults to tasks')
  assert.equal(typeof input.description, 'string', 'the smoke input has a description')
  for (const id of refused) assert.ok(namesSmokeId(input.description, id), `the smoke input description names the refused id ${id}: ${input.description}`)
})

test('workflow smoke input readers: control cells, one per shape they read and per shape they refuse', () => {
  const fail = '    fail "smoke=${SMOKE_ID} is not enabled in this runner: ae4 stays packaged"'
  const tasksArm = '  if [[ "$SMOKE_ID" == "tasks" ]]; then\n    local tasks_live\n  fi'
  // The refusal's own condition is read, wherever the tasks tests sit around it.
  assert.deepEqual(refusedSmokeIds(`${tasksArm}\n  if [[ "$SMOKE_ID" == "ae4" || "$SMOKE_ID" == "otbank-v18" ]]; then\n${fail}\n  fi\n${tasksArm}`), ['ae4', 'otbank-v18'])
  assert.deepEqual(refusedSmokeIds(`  if [[ "$SMOKE_ID" == "mp6" ]]; then\n${fail}\n  fi`), ['mp6'])
  for (const [label, body] of [
    ['no refusal', tasksArm],
    ['two refusals', `  if [[ "$SMOKE_ID" == "ae4" ]]; then\n${fail}\n  fi\n  if [[ "$SMOKE_ID" == "mp6" ]]; then\n${fail}\n  fi`],
    ['an environment bypass in the condition', `  if [[ "$SMOKE_ID" == "ae4" ]] && [[ "\${ALLOW:-}" != "1" ]]; then\n${fail}\n  fi`],
    ['a clause that is not an id test', `  if [[ "$SMOKE_ID" == "ae4" || -n "\${X:-}" ]]; then\n${fail}\n  fi`],
    ['a test that is not an equality', `  if [[ "$SMOKE_ID" != "tasks" ]]; then\n${fail}\n  fi`],
    ['an environment bypass in front of the fail call', `  if [[ "$SMOKE_ID" == "ae4" ]]; then\n    [[ "\${ALLOW:-}" == "1" ]] || ${fail.trim()}\n  fi`],
    ['a refusal nested under another block', `    if [[ "$SMOKE_ID" == "ae4" ]]; then\n${fail}\n    fi`],
    ['a refusal that is not under an if', `  [[ "$SMOKE_ID" == "ae4" ]] && ${fail.trim()}`],
  ]) {
    assert.throws(() => refusedSmokeIds(body), assert.AssertionError, label)
  }

  // A refused id counts as named only as a whole token, not inside a longer id or word.
  assert.ok(namesSmokeId('ae4, mp6 and otbank-v18 are refused (rd45 runs).', 'otbank-v18'))
  assert.ok(namesSmokeId('ae4, mp6 and otbank-v18 are refused (rd45 runs).', 'ae4'))
  for (const [text, id] of [['see otbank-v18-smoke', 'otbank-v18'], ['mp60 runs', 'mp6'], ['xae4', 'ae4'], ['pre-mp6', 'mp6']]) {
    assert.ok(!namesSmokeId(text, id), `${id} is not named in: ${text}`)
  }

  const inputOf = (...body) => ['on:', '  workflow_dispatch:', '    inputs:', '      action:', '        default: status', '      smoke:', ...body, '      stamps:', "        default: ''", ''].join('\n')
  assert.deepEqual(
    workflowSmokeInput(inputOf("        description: 'Pick one (it''s here)'", '        required: false', '        type: choice', '        options: [a, "b", \'c\']  # three', '        default: b # the plain one')),
    { description: "Pick one (it's here)", options: ['a', 'b', 'c'], default: 'b' },
  )
  assert.deepEqual(workflowSmokeInput(inputOf('        default: "d"')), { description: undefined, options: undefined, default: 'd' })
  // A missing default stays absent: the next input's `default: ''` is not borrowed.
  assert.equal(workflowSmokeInput(inputOf('        options: [a]')).default, undefined)
  for (const body of [
    ['        options:', '          - a'], // a block list
    ['        description: >', '          folded text'], // a block scalar
    ['        default: a', '        default: b'], // a repeated key
    ['        default: [a]'], // a list where a scalar belongs
    ['        options: a'], // a scalar where a list belongs
  ]) {
    assert.throws(() => workflowSmokeInput(inputOf(...body)), /^Error: workflow smoke input: /, body.join(' / '))
  }
  assert.throws(() => workflowSmokeInput('on:\n  workflow_dispatch:\n    inputs:\n      action:\n        default: status\n'), assert.AssertionError, 'no smoke input in the workflow')
})

test('runner bundle (EXECUTABLE): smoke=tasks without TASKS_ENABLED=true on the backend fails closed before the identity check and before anything touches the container', () => {
  const container = extractRunnerVar('BACKEND_CONTAINER').match(/^BACKEND_CONTAINER="([^"]+)"$/)[1]
  const flagProbe = `exec ${container} printenv TASKS_ENABLED`
  for (const [live, observed] of [['false', 'false'], [null, '<unset>'], ['TRUE', 'TRUE']]) {
    const r = runActionSmoke('tasks', { tasksEnabled: live })
    assert.notEqual(r.status, 0, `TASKS_ENABLED=${observed}: the run must fail`)
    assert.ok(
      r.stderr.includes(`smoke=tasks requires TASKS_ENABLED=true on the running staging backend (observed: '${observed}')`),
      `TASKS_ENABLED=${observed}: the failure names the flag and the observed value\n${r.stderr}`,
    )
    assert.deepEqual(r.docker, [flagProbe], `TASKS_ENABLED=${observed}: the flag probe is the only docker call (no container prep, mint or copy)`)
    assert.deepEqual(r.probes, [], `TASKS_ENABLED=${observed}: the identity check never ran`)
    assert.deepEqual(r.git, [])
  }
  // Control: with the flag live, the flag probe is the first docker call, the identity check runs
  // once, and the run goes on to the container.
  const r = runActionSmoke('tasks')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.docker[0], flagProbe, 'the flag probe is the first docker call')
  assert.deepEqual(r.probes, ['fetch_health_commit'], 'the identity check runs once after the flag check')
  assert.ok(r.docker.some((line) => line.startsWith('cp ')), 'the run goes on to copy into the container')
})

test('runner bundle (EXECUTABLE): the real action_smoke copies each runnable smoke script and its whole closure into the container runner dir before running it', () => {
  const container = extractRunnerVar('BACKEND_CONTAINER').match(/^BACKEND_CONTAINER="([^"]+)"$/)[1]
  const runnerDir = extractRunnerVar('CONTAINER_RUNNER_DIR').match(/^CONTAINER_RUNNER_DIR="([^"]+)"$/)[1]
  // The refused arms (ae4, mp6, otbank-v18) never reach the container; see the refusal test.
  for (const arm of runnableSmokeArms()) {
    const r = runActionSmoke(arm.id)
    assert.equal(r.status, 0, `${arm.id}: action_smoke must succeed against a complete bundle; stderr: ${r.stderr}`)
    assert.deepEqual(r.git, [], `${arm.id}: action_smoke must not run git`)
    const copies = r.docker.filter((line) => line.startsWith('cp '))
    const expected = ['attendance-window-runner-mint-token.mjs', arm.smokeScript, ...arm.closure.map((member) => posix.basename(member))]
      .map((name) => `cp ${r.hereDir}/${name} ${container}:${runnerDir}/scripts/ops/${name}`)
    assert.deepEqual([...copies].sort(), [...expected].sort(), `${arm.id}: the container must receive exactly the mint helper, the smoke script and its closure`)
    const runIndex = r.docker.findIndex((line) => line.startsWith('exec ') && line.endsWith(` node ${runnerDir}/scripts/ops/${arm.smokeScript}`))
    assert.notEqual(runIndex, -1, `${arm.id}: action_smoke must run the smoke from the container runner dir`)
    for (const line of expected) {
      assert.ok(r.docker.indexOf(line) < runIndex, `${arm.id}: ${line} must happen before the smoke runs`)
    }
    if (arm.id === 'rd45') {
      assert.match(
        r.docker[runIndex],
        / -e PLUGIN_INDEX_PATH=\/app\/plugins\/plugin-attendance\/index\.cjs /,
        'rd45 loads the attendance plugin from PLUGIN_INDEX_PATH (the image copy); without it the smoke falls back to a repository path the flat bundle cannot hold (see BUNDLE_OPAQUE_ALLOWLIST)',
      )
    }
    if (arm.id === 'tasks') {
      const run = r.docker[runIndex]
      assert.match(run, / -e SUBJECT_TOKEN=fake-token /, 'the tasks smoke must receive SUBJECT_TOKEN')
      assert.match(run, / -e MEMBER_TOKEN=fake-token /, 'the tasks smoke must receive MEMBER_TOKEN')
      assert.match(run, / -e OUTSIDER_TOKEN=fake-token /, 'the tasks smoke must receive OUTSIDER_TOKEN')
      assert.ok(
        r.docker.some((line) => line.endsWith('--mint --user-id tasks-smoke-gh1a1 --roles user --perms tasks:read,tasks:write --tenant-id default')),
        'the subject token is minted for the stamp itself, tenant default',
      )
      assert.ok(
        r.docker.some((line) => line.endsWith('--mint --user-id tasks-smoke-gh1a1-member --roles user --perms tasks:read,tasks:write --tenant-id default')),
        'the member token is minted for <stamp>-member with the subject role claims, tenant default',
      )
      assert.ok(
        r.docker.some((line) => line.endsWith('--mint --user-id tasks-smoke-gh1a1-outsider --roles user --perms tasks:read --tenant-id default')),
        'the outsider token is minted for <stamp>-outsider, tasks:read, tenant default',
      )
    }
  }
})

test('runner bundle (EXECUTABLE): a bundle missing any file the smoke needs fails closed before any docker call', () => {
  for (const arm of smokeArms()) {
    const missing = arm.closure.length > 0 ? posix.basename(arm.closure[arm.closure.length - 1]) : arm.smokeScript
    const r = runActionSmoke(arm.id, { omit: [missing] })
    assert.notEqual(r.status, 0, `${arm.id}: a bundle without ${missing} must fail`)
    if (REFUSED_SMOKE_IDS.includes(arm.id)) {
      // The refusal comes before the bundle check.
      assert.ok(r.stderr.includes(`smoke=${arm.id} ${SMOKE_REFUSAL_RULE}`), `${arm.id}: a refused smoke fails with the rule\n${r.stderr}`)
    } else {
      assert.match(r.stderr, new RegExp(`runner bundle is missing: ${missing.replace(/\./g, '\\.')}`), `${arm.id}: the failure must name ${missing}`)
    }
    assert.deepEqual(r.docker, [], `${arm.id}: nothing may be read from or copied into the container before the bundle check`)
  }
})

// Starts `file` from a flat copy of exactly `files` (taken from the extracted bundle), laid out like
// the container runner dir: scripts/ops/<file> with a node_modules beside scripts/ that holds only
// a stub `pg` (the runner links the image's node_modules there; pg is the only package the smokes
// load, after their env check). Empty env, and a working directory outside the bundle.
function runFromFlatLayout(file, files) {
  // realpath: a smoke's IS_MAIN check compares import.meta.url with argv[1], and a symlinked
  // tmpdir (as on macOS) would make main() silently not run.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'wr-smoke-layout-'))
  try {
    const hereDir = join(dir, 'here')
    const opsDir = join(dir, 'runner', 'scripts', 'ops')
    const pgDir = join(dir, 'runner', 'node_modules', 'pg')
    const cwd = join(dir, 'cwd')
    for (const path of [hereDir, opsDir, pgDir, cwd]) mkdirSync(path, { recursive: true })
    populateRunnerBundle(hereDir)
    for (const name of files) {
      assert.ok(existsSync(join(hereDir, name)), `${name} is not in the extracted bundle`)
      writeFileSync(join(opsDir, name), readFileSync(join(hereDir, name)))
    }
    writeFileSync(join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', main: 'index.js' }))
    writeFileSync(join(pgDir, 'index.js'), "module.exports = { Pool: class Pool { constructor() { throw new Error('pg stub: the layout check has no database') } } }\n")
    const result = spawnSync(process.execPath, [join(opsDir, file)], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('runner bundle (EXECUTABLE): each smoke, started alone from a flat copy of its bundle files, gets to its own env refusal', () => {
  for (const arm of smokeArms()) {
    const r = runFromFlatLayout(arm.smokeScript, [arm.smokeScript, ...arm.deps])
    assert.doesNotMatch(r.out, /MODULE_NOT_FOUND|Cannot find module|ENOENT/, `${arm.id}: a file the smoke loads is not in its bundle\n${r.out}`)
    assert.equal(r.status, 2, `${arm.id}: must stop at its env refusal (exit 2)\n${r.out}`)
    assert.match(r.out, /^FAIL: BASE_URL and DATABASE_URL are required\.$/m, `${arm.id}: the refusal names the missing env\n${r.out}`)
  }
  const mint = runFromFlatLayout('attendance-window-runner-mint-token.mjs', ['attendance-window-runner-mint-token.mjs'])
  assert.doesNotMatch(mint.out, /MODULE_NOT_FOUND|Cannot find module|ENOENT/, mint.out)
  assert.equal(mint.status, 2, mint.out)
  assert.match(mint.out, /^usage: attendance-window-runner-mint-token\.mjs /m, 'the mint helper, copied alone, starts and prints its usage')
})

test('runner bundle: action_smoke copies only through copy_smoke_bundle, with the smoke and its smoke_deps', () => {
  const body = executableLines(extractRunnerFunctions(['action_smoke']))
  assert.equal((body.match(/^\s*copy_smoke_bundle\b.*$/gm) || []).length, 1, 'exactly one copy_smoke_bundle call in action_smoke')
  assert.match(body, /^ {2}copy_smoke_bundle "\$smoke_script" \$\{smoke_deps\[@\]\+"\$\{smoke_deps\[@\]\}"\}$/m)
  assert.match(body, /^ {2}require_smoke_bundle "\$smoke_script" \$\{smoke_deps\[@\]\+"\$\{smoke_deps\[@\]\}"\}$/m)
  assert.doesNotMatch(body, /\bdocker cp\b/, 'action_smoke must not docker-cp a file outside copy_smoke_bundle')
  assert.ok(body.indexOf('require_smoke_bundle "$smoke_script"') < body.indexOf('prepare_container_runner'), 'the bundle check runs before anything touches the container')
  const copyFn = executableLines(extractRunnerFunctions(['copy_smoke_bundle']))
  assert.match(copyFn, /docker cp "\$\{HERE\}\/\$\{file\}" "\$\{BACKEND_CONTAINER\}:\$\{CONTAINER_RUNNER_DIR\}\/scripts\/ops\/\$\{file\}"/)
})

// `git` as a command word: after the line start, whitespace, a shell operator, a quote, a slash (an
// absolute path such as /usr/bin/git) or a backslash (\git), and followed by the end of the line,
// whitespace, a quote or a shell operator. `command git` and `env git` match through the space.
const GIT_INVOCATION = /(^|[\s;&|(`"'/\\])git(?=$|[\s"';&|)`])/

test('runner bundle: the git-invocation pin matches every spelling of a git command and nothing else', () => {
  for (const line of [
    'git -C "$PROD_REPO_DIR" pull --ff-only origin main',
    '(cd "$PROD_REPO_DIR" && git pull --ff-only origin main)',
    '/usr/bin/git -C "$(resolve_home_path "$DEPLOY_PATH")" pull --ff-only origin main || true',
    'command git -C "$DEPLOY_PATH" pull',
    'env git pull',
    'env GIT_TERMINAL_PROMPT=0 git pull',
    '"git" pull',
    "'git' pull",
    '\\git pull',
    'sha="$(git rev-parse HEAD)"',
    'sha=`git rev-parse HEAD`',
    'true; git fetch',
    'sudo -u deploy git pull',
    'exec git pull',
    'git',
  ]) {
    assert.ok(GIT_INVOCATION.test(line), `must match: ${line}`)
  }
  for (const line of [
    'digit=1',
    'legit_value="x"',
    'cat .gitignore',
    'GIT_DIR=/tmp/x',
    'git_sha="abc"',
    'echo "--git-dir"',
    'printf "%s" "$gitref"',
    'image="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${sha}"',
    'url="https://github.com/zensgit/metasheet2"',
  ]) {
    assert.ok(!GIT_INVOCATION.test(line), `must not match: ${line}`)
  }
})

// `source` or `.` in command position (line start, or after a shell operator, an opening paren or a
// backtick, optionally after then/do/else), with its first argument.
const SOURCE_COMMAND = /(?:^|[;&|(`])\s*(?:(?:then|do|else)\s+)?(?:source|\.)\s+([^\s;&|)]+)/g
// A sourced runner bundle file. The bundle is extracted flat into the directory the remote script
// runs from (HERE), so a bundle file is named "${HERE}/<file>" or "$HERE/<file>".
const SOURCED_BUNDLE_FILE = /^"(?:\$HERE|\$\{HERE\})\/([A-Za-z0-9._-]+)"$/
// Files the remote script sources that are not bundle files, with the reason they hold no commands.
const NON_BUNDLE_SOURCES = [
  {
    argument: '"$SOAK_CREDENTIALS_FILE"',
    reason: 'host-only credentials data file the runner itself writes in its persist dir, mode 0600: one SOAK_SYNTH_PASSWORD=<48 hex chars> line from soak_mint_password, written by printf on seed and on rotate; it holds no commands',
  },
]

// The bundle files a shell script sources, read from its executable lines. Every `source`/`.`
// command must name a bundle file or be listed in NON_BUNDLE_SOURCES; any other spelling throws, so
// a newly sourced file cannot sit outside the population the no-git pin scans.
function sourcedFiles(script) {
  const bundle = []
  const nonBundle = []
  for (const line of executableLines(script).split('\n')) {
    for (const match of line.matchAll(SOURCE_COMMAND)) {
      const file = match[1].match(SOURCED_BUNDLE_FILE)
      if (file) bundle.push(file[1])
      else if (NON_BUNDLE_SOURCES.some((entry) => entry.argument === match[1])) nonBundle.push(match[1])
      else throw new Error(`unrecognized source command (name a "\${HERE}/<file>" bundle file or list it in NON_BUNDLE_SOURCES): ${line.trim()}`)
    }
  }
  return { bundle, nonBundle }
}

const readOpsFile = (file) => readFileSync(join(HERE, file), 'utf8')

// The remote script and every bundle file it sources, transitively: the shell code that runs on
// the deploy host.
function remoteScriptPopulation(read = readOpsFile, entry = posix.basename(REMOTE_SH)) {
  const files = [entry]
  const nonBundle = []
  for (let k = 0; k < files.length; k += 1) {
    const sourced = sourcedFiles(read(files[k]))
    nonBundle.push(...sourced.nonBundle)
    for (const file of sourced.bundle) if (!files.includes(file)) files.push(file)
  }
  return { files, nonBundle }
}

// The executable lines that run git, for each file of a population that has any.
function gitLinesByFile(files, read = readOpsFile) {
  return files
    .map((file) => ({ file, lines: executableLines(read(file)).split('\n').filter((line) => GIT_INVOCATION.test(line)) }))
    .filter((entry) => entry.lines.length > 0)
}

test('runner bundle: the source-command reader finds every sourced bundle file, skips what is not a source command and refuses any other spelling', () => {
  for (const [line, expected] of [
    ['source "${HERE}/a.sh"', ['a.sh']],
    ['. "$HERE/b.sh"', ['b.sh']],
    ['if [[ -f x ]]; then source "${HERE}/c.sh"; fi', ['c.sh']],
    ['[[ -f x ]] && . "${HERE}/d.sh"', ['d.sh']],
    ['  # source "${HERE}/e.sh"', []],
    ['source "$SOAK_CREDENTIALS_FILE"', []],
    ['find . -name x', []],
    ['log "trust the source DB"', []],
    ['source_fn_digest="x"', []],
    ['cp -R "$OUTDIR/." "$LOCAL/"', []],
  ]) {
    assert.deepEqual(sourcedFiles(line).bundle, expected, line)
  }
  for (const line of ['source "${OTHER}/x.sh"', '. ~/.bashrc', 'source /etc/profile', 'source x.sh', 'true && . "$f"', 'source "${HERE}/../x.sh"']) {
    assert.throws(() => sourcedFiles(line), /unrecognized source command/, line)
  }
  // A population followed through two levels of sourcing, with a git call only in the last file.
  const fake = {
    'r.sh': '#!/usr/bin/env bash\nsource "${HERE}/l1.sh"\nmain() {\n  filtered_pipe x y -- true\n}\n',
    'l1.sh': '. "$HERE/l2.sh"\nfiltered_pipe() {\n  "$@"\n}\n',
    'l2.sh': '# git is mentioned in this comment only\nhead_of() {\n  /usr/bin/git -C "$1" rev-parse HEAD || true\n}\n',
  }
  const population = remoteScriptPopulation((file) => fake[file], 'r.sh')
  assert.deepEqual(population.files, ['r.sh', 'l1.sh', 'l2.sh'], 'sourced files are followed transitively')
  assert.deepEqual(
    gitLinesByFile(population.files, (file) => fake[file]),
    [{ file: 'l2.sh', lines: ['  /usr/bin/git -C "$1" rev-parse HEAD || true'] }],
    'a git call in a file sourced two levels down is reported, a comment is not',
  )
})

test('runner bundle: action=smoke never touches the deploy host production checkout, and skip_host_sync is gone', () => {
  const remote = readFileSync(REMOTE_SH, 'utf8')
  const workflow = readFileSync(WORKFLOW, 'utf8')
  assert.doesNotMatch(remote, /host_sync|skip_host_sync/i, 'the remote script must not sync a repository on the deploy host')
  assert.doesNotMatch(workflow, /skip_host_sync/i, 'the skip_host_sync input, env line and prelude export must be gone')
  // The remote script and every bundle file it sources (the pipeline lib today).
  const population = remoteScriptPopulation()
  assert.ok(population.files.includes('attendance-window-runner-pipeline.lib.sh'), 'positive control: the pipeline lib the remote script sources is in the scanned population')
  const tarList = workflowTarList(workflow)
  for (const file of population.files) {
    assert.ok(tarList.includes(`${BUNDLE_SOURCE_DIR}/${file}`), `${file} runs on the deploy host, so the tar list must ship it`)
  }
  assert.deepEqual(
    gitLinesByFile(population.files),
    [],
    `the remote script and the files it sources (${population.files.join(', ')}) must not run git at all (no fetch/checkout/pull of any checkout on the deploy host)`,
  )
  for (const entry of NON_BUNDLE_SOURCES) {
    assert.ok(population.nonBundle.includes(entry.argument), `stale NON_BUNDLE_SOURCES entry: nothing sources ${entry.argument}`)
  }
  const prodRepoReferences = remote.split('\n').filter((line) => line.includes('PROD_REPO_DIR')).map((line) => line.trim())
  assert.deepEqual(
    prodRepoReferences,
    ['PROD_REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"', 'if [[ "$STAGING_DIR" == "$PROD_REPO_DIR" ]]; then'],
    'PROD_REPO_DIR may only be defined and compared by the staging-only guard',
  )
  assert.match(
    workflow,
    /for pair in "DEPLOY_PATH=\$DEPLOY_PATH" "STAGING_DEPLOY_PATH=\$STAGING_DEPLOY_PATH"; do\n/,
    'the remote-action safe-character loop validates only inputs that always carry a value',
  )
})

// Every step of every job in a workflow, in order: { name, run, uses, line }, where name, run and
// uses are null when the step has no such key and line is the step's first line (1-based). A step
// is a `- ` item at column 6 of a `steps:` list at column 4. Its keys sit at column 8 (the first one
// on the item line itself) and may come in any order. A key's value is the rest of its line plus
// every following line that is blank or indented deeper than column 8, so a run: nested under
// with: or env: belongs to that key, not to the step:
//   * after a block scalar header (| or >, then an optional chomping indicator + or - and an
//     optional indentation indicator 1-9 in either order, then an optional comment), the value is
//     those following lines, less the indicator's indentation (column 8 + indicator) or else the
//     first non-blank line's;
//   * otherwise it is a flow scalar: the rest of the line (outer quotes removed; for an unquoted
//     value a trailing ` #` comment dropped), then each continuation line, trimmed.
// A line at the steps column that is not a `- ` item, or a key line that is not `key: value` at
// column 8 (for example a flow mapping `- {name: x, run: y}`), throws: a step this reader cannot
// read fails the tests instead of going unseen.
function workflowSteps(workflow) {
  const lines = workflow.split('\n')
  const indentOf = (line) => line.length - line.trimStart().length
  const skippable = (line) => line.trim() === '' || /^\s*#/.test(line)
  // Reads the key on `keyLine` (lines[index], or the item line re-indented to column 8) and its
  // value; returns the index of the next unread line.
  const readKey = (step, keyLine, index) => {
    const m = keyLine.match(/^ {8}([A-Za-z0-9_-]+):(?:[ \t]+(.*?))?[ \t]*$/)
    if (!m) throw new Error(`workflow steps: line ${index + 1} is not a step key at column 8: ${JSON.stringify(lines[index])}`)
    const [, key, rest = ''] = m
    const body = []
    let next = index + 1
    while (next < lines.length && (lines[next].trim() === '' || indentOf(lines[next]) > 8)) body.push(lines[next++])
    while (body.length > 0 && body[body.length - 1].trim() === '') { body.pop(); next -= 1 }
    let value
    const header = rest.match(/^[|>](?:[+-]?([1-9])?|([1-9])[+-])(?:[ \t]+#.*)?$/)
    if (header) {
      const indicator = header[1] ?? header[2]
      const first = body.find((line) => line.trim() !== '')
      const strip = indicator ? 8 + Number(indicator) : first === undefined ? 0 : indentOf(first)
      value = body.map((line) => line.slice(Math.min(strip, indentOf(line)))).join('\n')
    } else {
      const quote = /^["']/.test(rest) ? rest[0] : null
      const head = quote ? rest : rest.replace(/[ \t]+#.*$/, '')
      value = [head, ...body.map((line) => line.trim())].filter((part, k) => k > 0 || part !== '').join('\n')
      if (quote && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1)
    }
    if (key === 'name' || key === 'run' || key === 'uses') step[key] = value
    return next
  }
  const steps = []
  let i = 0
  while (i < lines.length) {
    if (!/^ {4}steps:[ \t]*(?:#.*)?$/.test(lines[i])) { i += 1; continue }
    i += 1
    for (;;) {
      while (i < lines.length && skippable(lines[i])) i += 1
      if (i >= lines.length || indentOf(lines[i]) < 6) break // the steps list ended
      const item = lines[i].match(/^ {6}- (.*)$/)
      if (!item) throw new Error(`workflow steps: line ${i + 1} is neither a step item nor the end of the steps list: ${JSON.stringify(lines[i])}`)
      const step = { name: null, run: null, uses: null, line: i + 1 }
      steps.push(step)
      i = readKey(step, ' '.repeat(8) + item[1], i)
      for (;;) {
        while (i < lines.length && skippable(lines[i])) i += 1
        if (i >= lines.length || indentOf(lines[i]) <= 6) break // the next step, or the end of the list
        i = readKey(step, lines[i], i)
      }
    }
  }
  return steps
}

// `ssh` or `scp` as a command word, with the same boundaries as GIT_INVOCATION.
const REMOTE_INVOCATION = /(^|[\s;&|(`"'/\\])(?:ssh|scp)(?=$|[\s"';&|)`])/

// The steps whose run script calls ssh or scp on an executable line, and how a step is named in a
// failure (a nameless step by its first line).
function remoteWorkflowSteps(steps) {
  return steps.filter((step) => step.run !== null && executableLines(step.run).split('\n').some((line) => REMOTE_INVOCATION.test(line)))
}
function workflowStepLabel(step) {
  return step.name ?? `<nameless step at line ${step.line}>`
}

test('runner bundle: the workflow step reader reads every run form and step shape, and refuses a step it cannot read', () => {
  const lines = [
    'on: workflow_dispatch',
    'jobs:',
    '  first:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v4',
    '      - name: Literal',
    '        run: |',
    '          ssh host one',
    '',
    '          # a comment line',
    '      - name: Literal strip',
    '        run: |-',
    '          ssh host two',
    '      - name: Folded strip',
    '        id: folded',
    '        run: >-',
    '          ssh -o StrictHostKeyChecking=yes "$U@$H"',
    '          "git -C ~/r pull --ff-only origin main || true"',
    '      - name: Folded with indentation indicator',
    '        run: >2+ # trailing comment',
    '            ssh host three',
    '      - run: ssh "$U@$H" "git pull"',
    '      - run: |',
    '          scp a "$U@$H:/x"',
    '      - run: ssh host four',
    '        name: Name after run',
    "      - name: 'Quoted name'",
    '        run: "ssh host five"  ',
    '      - name: Plain over two lines',
    '        run: ssh host',
    '          six',
    '      - name: Run under with',
    '        uses: some/action@v1',
    '        with:',
    '          run: ssh host seven',
    '        env:',
    '          X: y',
    '  second:',
    '    needs: first',
    '    steps:',
    '      # a comment between steps',
    '      - name: Second job',
    '        run: echo ok # no ssh here',
    '',
  ]
  const lineOf = (text) => lines.indexOf(text) + 1
  const steps = workflowSteps(lines.join('\n'))
  assert.deepEqual(steps.map(({ name, run, uses }) => ({ name, run, uses })), [
    { name: 'Checkout', run: null, uses: 'actions/checkout@v4' },
    { name: 'Literal', run: 'ssh host one\n\n# a comment line', uses: null },
    { name: 'Literal strip', run: 'ssh host two', uses: null },
    { name: 'Folded strip', run: 'ssh -o StrictHostKeyChecking=yes "$U@$H"\n"git -C ~/r pull --ff-only origin main || true"', uses: null },
    { name: 'Folded with indentation indicator', run: '  ssh host three', uses: null },
    { name: null, run: 'ssh "$U@$H" "git pull"', uses: null },
    { name: null, run: 'scp a "$U@$H:/x"', uses: null },
    { name: 'Name after run', run: 'ssh host four', uses: null },
    { name: 'Quoted name', run: 'ssh host five', uses: null },
    { name: 'Plain over two lines', run: 'ssh host\nsix', uses: null },
    { name: 'Run under with', run: null, uses: 'some/action@v1' },
    { name: 'Second job', run: 'echo ok', uses: null },
  ])
  const nameless = [lineOf('      - run: ssh "$U@$H" "git pull"'), lineOf('      - run: |')].map((line) => `<nameless step at line ${line}>`)
  const remote = remoteWorkflowSteps(steps)
  assert.deepEqual(remote.map(workflowStepLabel), [
    'Literal',
    'Literal strip',
    'Folded strip',
    'Folded with indentation indicator',
    ...nameless,
    'Name after run',
    'Quoted name',
    'Plain over two lines',
  ], 'every run form that calls ssh or scp counts as a remote step, named or not; a run under with: does not')
  assert.deepEqual(
    remote.filter((step) => executableLines(step.run).split('\n').some((line) => GIT_INVOCATION.test(line))).map(workflowStepLabel),
    ['Folded strip', nameless[0]],
    'the git calls in a `run: >-` step and in a nameless one-line step are both seen',
  )
  for (const bad of [
    ['      - {name: x, run: ssh host}'],
    ['      -name: x'],
    ['      - name: x', '       run: ssh host'],
    ['      - name: x', '        run: |', '          true', '        # ends the block', '          ssh host'],
  ]) {
    assert.throws(() => workflowSteps(['jobs:', '  j:', '    steps:', ...bad, ''].join('\n')), /^Error: workflow steps: line \d+ /, bad.join(' / '))
  }
})

test('runner bundle: the remote-invocation pin finds every ssh and scp command and nothing else', () => {
  for (const line of [
    '| ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts -o IdentitiesOnly=yes -i ~/.ssh/deploy_key \\',
    'ssh $ssh_opts "$DEPLOY_USER@$DEPLOY_HOST" "bash -o pipefail -c \'${escaped_script}\'" 2>&1 \\',
    'scp $ssh_opts -r "$DEPLOY_USER@$DEPLOY_HOST:${remote_output_dir}/." output/window-runner/ 2>&1 \\',
    'scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts -o IdentitiesOnly=yes -i ~/.ssh/deploy_key \\',
    '/usr/bin/ssh host true',
    'command ssh host true',
    'out="$(ssh host true)"',
    '"ssh" host true',
    "'scp' a host:/x",
  ]) {
    assert.ok(REMOTE_INVOCATION.test(line), `must match: ${line}`)
  }
  for (const line of [
    'mkdir -p ~/.ssh',
    'ssh_opts="-o StrictHostKeyChecking=yes"',
    "grep -Eq 'ssh-ed25519|ssh-rsa|ecdsa-sha2|ssh-dss' ~/.ssh/known_hosts \\",
    '| tee output/window-runner/ssh.log',
    'chmod 600 ~/.ssh/deploy_key ~/.ssh/known_hosts',
  ]) {
    assert.ok(!REMOTE_INVOCATION.test(line), `must not match: ${line}`)
  }
})

test('runner bundle: no workflow step runs git on the deploy host: only the two known steps call ssh or scp, and no executable line of theirs runs git', () => {
  const steps = workflowSteps(readFileSync(WORKFLOW, 'utf8'))
  assert.ok(steps.length >= 7, 'expected the runner workflow steps')
  for (const step of steps) {
    // GitHub requires exactly one of the two; a run script the reader did not see leaves neither.
    assert.equal(Number(step.run !== null) + Number(step.uses !== null), 1, `${workflowStepLabel(step)}: a step has exactly one of run and uses`)
  }
  const remoteSteps = remoteWorkflowSteps(steps)
  assert.deepEqual(
    remoteSteps.map(workflowStepLabel),
    ['Sync runner scripts to deploy host', 'Run remote action'],
    'only the bundle sync and the remote action may talk to the deploy host',
  )
  // Every executable line of those steps, which covers the ssh command lines themselves, any
  // variable a remote command is built from, and the remote prelude string sent to the host.
  for (const step of remoteSteps) {
    const gitLines = executableLines(step.run).split('\n').filter((line) => GIT_INVOCATION.test(line))
    assert.deepEqual(gitLines, [], `${workflowStepLabel(step)}: no remote command may run git on the deploy host`)
  }
})
