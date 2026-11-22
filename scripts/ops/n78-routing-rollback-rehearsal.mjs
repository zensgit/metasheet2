#!/usr/bin/env node
// Disposable synthetic databases only. No package manager, database creation, retry or automatic deletion.
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const help = 'Usage: node scripts/ops/n78-routing-rollback-rehearsal.mjs OLD_CHECKOUT NEW_CHECKOUT OUTPUT_JSON\nEnvironment: DATABASE_URL, EXPECT_DB=1; optional MIGRATION_EXCLUDE.\nUse an empty n78_08a_rollback_synthetic_pg14..pg17 database; old HEAD must be 32aac002a2.\nNo retries. Preserve the output and database after any failure.\n'
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); process.exit(0) }
if (args.length !== 3) { process.stderr.write(help); process.exit(2) }
const [oldRoot, newRoot, output] = args.map(arg => resolve(arg))
let reserved = false
const evidence = { format: 1, status: 'running', steps: [], error: null }
const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n')
const fail = code => { const error = new Error(code); error.code = code; throw error }
const worker = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/core-backend/tests/utils/n78-routing-rollback-worker.cts')
function runStep(name, action, root, expectedCode = 'OK') {
  const started = performance.now()
  // Do not inherit application secrets or NODE_OPTIONS. The database URL is never in argv/logs.
  const env = Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'DATABASE_URL', 'MIGRATION_EXCLUDE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { NODE_ENV: 'test', LOG_LEVEL: 'error', EXPECT_DB: '1', SECRET_MASTER_KEY: 'n78-synthetic-rehearsal-only' })
  const child = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), worker, root, action], {
    cwd: dirname(output), env, encoding: 'utf8', timeout: 360000, maxBuffer: 8 * 1024 * 1024,
  })
  const marker = child.stdout?.split('\n').find(line => line.startsWith('N78_RESULT='))
  let result
  try { result = marker ? JSON.parse(marker.slice('N78_RESULT='.length)) : { code: 'WORKER_NO_RESULT' } }
  catch { result = { code: 'WORKER_INVALID_RESULT' } }
  const step = { name, action, elapsedMs: performance.now() - started, exitCode: child.status, ...result }
  evidence.steps.push(step); save()
  if (child.error || child.status !== 0 || step.code !== expectedCode) fail('REHEARSAL_STEP_FAILED')
  return step
}
try {
  closeSync(openSync(output, 'wx', 0o600)); reserved = true
  if (process.env.EXPECT_DB !== '1') fail('EXPECT_DB_REQUIRED')
  let url
  try { url = new URL(process.env.DATABASE_URL ?? '') } catch { fail('DATABASE_URL_REQUIRED') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/n78_08a_rollback_synthetic_pg(14|15|16|17)$/.test(url.pathname)) fail('SYNTHETIC_DATABASE_REQUIRED')
  const ref = root => {
    const child = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    if (child.status !== 0 || !/^[0-9a-f]{40}\s*$/.test(child.stdout)) fail('CHECKOUT_HEAD_UNAVAILABLE')
    // Dirty source would invalidate the pinned comparison; do not modify either checkout.
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' })
    if (status.status !== 0 || status.stdout.trim()) fail('CHECKOUT_DIRTY')
    return child.stdout.trim()
  }
  evidence.oldHead = ref(oldRoot); evidence.newHead = ref(newRoot)
  if (evidence.oldHead !== '32aac002a2f771effea450276d51c7d5ec3aa8ae') fail('OLD_HEAD_MISMATCH')
  runStep('empty synthetic preflight', 'empty', newRoot)
  runStep('new migrate latest', 'latest', newRoot)
  runStep('old readiness refuses migrated catalog', 'readiness', oldRoot, 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE')
  runStep('new readiness accepts migrated catalog', 'readiness', newRoot)
  runStep('empty M06d rollback', 'down-decisions', newRoot)
  runStep('empty M06c rollback', 'down-policy', newRoot)
  runStep('restore both migrations', 'latest', newRoot)
  runStep('insert one synthetic paused policy', 'seed-policy', newRoot)
  // One down removes M06d, so M06c must be at the ledger tip before testing its refusal.
  runStep('empty M06d before policy refusal', 'down-decisions', newRoot)
  const before = runStep('snapshot before refused down', 'snapshot', newRoot)
  runStep('nonempty M06c refuses down', 'down-policy-blocked', newRoot, 'NOTIFICATION_ROUTING_DOWN_BLOCKED')
  const after = runStep('snapshot after refused down', 'snapshot', newRoot)
  if (before.snapshot !== after.snapshot) fail('REFUSED_DOWN_CHANGED_DATABASE')
  runStep('forward recovery with retained policy', 'latest', newRoot)
  runStep('final new readiness', 'readiness', newRoot)
  runStep('verify retained synthetic policy and empty decisions', 'final', newRoot)
  evidence.status = 'passed'; save()
} catch (error) {
  const known = new Set(['EXPECT_DB_REQUIRED', 'DATABASE_URL_REQUIRED', 'SYNTHETIC_DATABASE_REQUIRED', 'CHECKOUT_HEAD_UNAVAILABLE', 'CHECKOUT_DIRTY', 'OLD_HEAD_MISMATCH', 'REHEARSAL_STEP_FAILED', 'REFUSED_DOWN_CHANGED_DATABASE'])
  evidence.status = 'failed'; evidence.error = known.has(error.code) ? error.code : 'REHEARSAL_FAILED'
  if (reserved) save()
  process.stderr.write(`${reserved ? evidence.error : 'OUTPUT_UNAVAILABLE'}\n`)
  process.exitCode = 1
}
