#!/usr/bin/env node
/** Additive snapshot gate using the existing nonce-owned PostgreSQL runner. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.umask(0o077)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runner = path.join(repo, 'scripts/verification/plm-managed-companion-pg/owned-socket.mjs')
const out = mkdtempSync(path.join(tmpdir(), 'plm-snapshot-share-ci-'))
const report = path.join(out, 'tests.json'), log = path.join(out, 'tests.log')
const proof = { out, started: null, cleanup: null, passed: false }
function control(args) {
  const child = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 45000 })
  const value = JSON.parse(child.stdout)
  if (child.status !== 0 || value.ok !== true) throw new Error('owned PostgreSQL control refused')
  return value
}
let failure
try {
  proof.started = control(['start'])
  const dsn = proof.started.dsn
  if (typeof dsn !== 'string' || !new URL(dsn).searchParams.get('host')?.startsWith('/tmp/plm-managed-consumer-pg-')) throw new Error('owned DSN missing')
  const fd = openSync(log, 'wx', 0o600)
  let tests
  try {
    tests = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--watch=false',
      '--config', 'vitest.plm-snapshot-share.config.ts', '--reporter=json', '--outputFile=' + report], {
      cwd: path.join(repo, 'packages/core-backend'), timeout: 120000, stdio: ['ignore', fd, fd],
      env: { ...process.env, DATABASE_URL: dsn, PLM_SNAPSHOT_SHARE_TEST_PG_URL: dsn,
        ENCRYPTION_KEY: 'snapshot-ci-synthetic-key-not-production', ENCRYPTION_SALT: 'snapshot-ci-synthetic-salt-not-production' },
    })
  } finally { closeSync(fd) }
  if (tests.status !== 0) throw new Error('snapshot PostgreSQL tests failed')
  const checked = spawnSync(process.execPath, [path.join(repo, 'scripts/verification/plm-managed-companion-ci/assert-report.mjs'), report, '16'], { encoding: 'utf8', timeout: 10000 })
  if (checked.status !== 0) throw new Error('snapshot test count/zero-skip gate refused')
  proof.report = JSON.parse(checked.stdout)
  proof.reportSha256 = createHash('sha256').update(readFileSync(report)).digest('hex')
  proof.passed = true
} catch (error) { failure = error } finally {
  if (proof.started) {
    const pglog = path.join(proof.started.root, 'pg.log')
    if (existsSync(pglog)) copyFileSync(pglog, path.join(out, 'postgres.log'))
    try {
      proof.cleanup = control(['cleanup', '--root', proof.started.root, '--nonce', proof.started.nonce])
      if (!proof.cleanup.directoryRemoved || !proof.cleanup.postgresStopped || proof.cleanup.postgresRunning || !proof.cleanup.markerMatched) throw new Error('owned cleanup not proved')
    } catch (error) { failure ??= error }
  }
  writeFileSync(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
}
console.log(JSON.stringify(proof))
if (failure) {
  console.error(failure.message)
  if (existsSync(log)) console.error(readFileSync(log, 'utf8').slice(-8000))
  process.exitCode = 1
}
