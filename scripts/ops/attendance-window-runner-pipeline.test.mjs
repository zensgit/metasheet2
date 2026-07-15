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
