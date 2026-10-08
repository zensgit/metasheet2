/** Test-only target process: never opens the source database or source roots. */
import assert from 'node:assert/strict'
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'
import type { LocalCustodyReceipt } from '../src/multitable/recovery-local-custody-store'
import type { RecoveryArchiveRestoreJobQuery } from '../src/multitable/recovery-archive-restore-jobs'
import type { ManualRollbackInput, ManualRollbackResult } from './verify-recovery-local-rollback.mts'

const require = createRequire(import.meta.url)
const backend = fileURLToPath(new URL('../', import.meta.url))
const launcher = fileURLToPath(new URL('./start-recovery-local.mts', import.meta.url))
const rollbackWitness = fileURLToPath(new URL('./verify-recovery-local-rollback.mts', import.meta.url))

export interface ManualTargetInput {
  readonly databaseName: string
  readonly local: {
    readonly archivePath: string
    readonly custodyPath: string
    readonly custodyId: string
    readonly storeId: string
    readonly receipt: LocalCustodyReceipt
    readonly recoverySecret: Uint8Array
  }
  readonly identity: { readonly sheetId: string; readonly actorId: string }
  readonly password: string
  readonly generationId: string
  readonly recordId: string
  readonly recordIds: readonly string[]
  readonly fieldId: string
  readonly attachmentFieldId: string
  readonly attachmentId: string
  readonly attachmentBytes: Uint8Array
}

async function send(message: { kind: 'manual-target-done'; rollbackTableCount: number } | { kind: 'manual-target-error'; code: string; frames: string[] }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_IPC_MISSING'))
    process.send(message, undefined, undefined, (error) => error ? reject(error) : resolve())
  })
}

async function run(input: ManualTargetInput): Promise<number> {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED, 'true')
  assert.equal(process.env.MULTITABLE_ENABLE_WRITER_FENCE, 'true')
  assert.equal(typeof process.env.DATABASE_URL, 'string')
  assert.equal(typeof process.env.ATTACHMENT_PATH, 'string')
  assert.equal(typeof process.env.JWT_SECRET, 'string')
  const targetRoot = dirname(input.local.archivePath)
  assert.equal(dirname(input.local.custodyPath), targetRoot)
  assert.equal(dirname(process.env.ATTACHMENT_PATH!), targetRoot)

  const { Pool: PgPool } = require('pg') as typeof import('pg')
  const { restoreImportedManualArchiveOverHttp } = require('./verify-recovery-local-manual-http.ts') as typeof import('./verify-recovery-local-manual-http')
  const { getAttachmentStorageService } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
  const { poolManager } = require('../src/integration/db/connection-pool.ts') as typeof import('../src/integration/db/connection-pool')

  const pool: Pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 4, application_name: 'tm_local_manual_target', connectionTimeoutMillis: 1000 })
  const query: RecoveryArchiveRestoreJobQuery = (text, values) => pool.query(text, values)
  let service: ChildProcess | undefined
  try {
    const identity = await query('SELECT current_database() AS database_name')
    assert.equal((identity.rows[0] as { database_name?: string } | undefined)?.database_name, input.databaseName)
    const appConfig = join(targetRoot, 'application-config.json')
    const recoveryConfig = join(targetRoot, 'recovery-config.json')
    await writeFile(appConfig, '{}\n', { flag: 'wx', mode: 0o600 })
    const recoveryProfile = {
      archivePath: input.local.archivePath, custodyPath: input.local.custodyPath,
      custodyId: input.local.custodyId, storeId: input.local.storeId,
      maxObjectBytes: 16 * 1024 * 1024, receipt: input.local.receipt,
      auditedReplayHorizonMs: 60_000, asyncResumeHorizonMs: 600_000,
      workerIntervalMs: 60_000, leaseMs: 60_000, replayHorizonMs: 60_000,
      sweepLimit: 100, maxChunksPerRun: 1,
    }
    await writeFile(recoveryConfig, `${JSON.stringify(recoveryProfile)}\n`, { flag: 'wx', mode: 0o600 })
    const rollbackInput = { databaseName: input.databaseName, identity: input.identity,
      password: input.password, generationId: input.generationId }
    const offBefore = await probeFlagOff(rollbackInput, appConfig, targetRoot)
    const port = await reserveLoopbackPort()
    service = launch(recoveryConfig, appConfig, targetRoot, port)
    await waitForLocked(service)
    assert.equal(await canConnect(port), false, 'RECOVERY_LOCAL_BACKUP_MANUAL_PRE_UNLOCK_LISTENER')
    await writePipeSecret(service, input.local.recoverySecret)
    await waitForListener(port)
    const origin = `http://127.0.0.1:${port}`
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${input.identity.actorId}@example.test`, password: input.password }),
    })
    assert.equal(login.status, 200, 'RECOVERY_LOCAL_BACKUP_MANUAL_LOGIN_FAILED')
    const loginBody = await login.json() as { data?: { token?: unknown } }
    assert.equal(typeof loginBody.data?.token, 'string')
    const jobId = await restoreImportedManualArchiveOverHttp({
      runtime: { query }, identity: input.identity,
      generationId: input.generationId, recordId: input.recordId, recordIds: input.recordIds,
      fieldId: input.fieldId, attachmentFieldId: input.attachmentFieldId,
      attachmentId: input.attachmentId,
    }, origin, { 'content-type': 'application/json', authorization: `Bearer ${loginBody.data.token}` })
    const first = await waitForJob(query, jobId, row => row.completed_count === '5000')
    assert.equal(first.state, 'applying')
    assert.equal(first.archive_generation_id, input.generationId)
    assert.equal(first.total_count, '5001')
    assert.equal(first.terminal_operation_id, null)
    const firstChunks = await readChunks(query, jobId)
    assert.deepEqual(firstChunks.map(row => [row.chunk_index, row.state, row.committed_count]),
      [[0, 'committed', '5000'], [1, 'pending', null]])
    assert.equal(typeof service.pid, 'number')
    assert.equal(service.exitCode, null)
    assert.equal(service.signalCode, null)
    assert.equal(Number(execFileSync('ps', ['-p', String(service.pid), '-o', 'ppid='], { encoding: 'utf8' }).trim()), process.pid)
    assert.equal(typeof process.getuid, 'function')
    assert.equal(Number(execFileSync('ps', ['-p', String(service.pid), '-o', 'uid='], { encoding: 'utf8' }).trim()), process.getuid!())
    const killed = new Promise<NodeJS.Signals | null>(resolve => service!.once('exit', (_code, signal) => resolve(signal)))
    assert.equal(service.kill('SIGKILL'), true)
    assert.equal(await killed, 'SIGKILL')
    service = undefined
    await waitForNoListener(port)
    const stopped = await readJob(query, jobId)
    assert.equal(stopped.completed_count, '5000')
    assert.equal(stopped.block_fence, first.block_fence)
    assert.equal(stopped.worker_fence, first.worker_fence)
    assert.equal(stopped.worker_owner_id, first.worker_owner_id)
    await assertOrdinaryWriterBlocked(pool, input)
    // Wait on database time, not a host-clock guess. No lease mutation or HTTP /resume.
    await waitForJob(query, jobId, row => row.lease_expired === true)
    service = launch(recoveryConfig, appConfig, targetRoot, port)
    await waitForLocked(service)
    assert.equal(await canConnect(port), false)
    await writePipeSecret(service, input.local.recoverySecret)
    await waitForListener(port)
    const takenOver = await waitForJob(query, jobId, row => BigInt(row.worker_fence) > BigInt(stopped.worker_fence))
    assert.equal(takenOver.state, 'applying')
    assert.equal(typeof takenOver.worker_owner_id, 'string')
    assert.notEqual(takenOver.worker_owner_id, null)
    assert.equal(takenOver.block_fence, stopped.block_fence)
    assert.notEqual(takenOver.worker_owner_id, stopped.worker_owner_id)
    assert.equal(takenOver.archive_generation_id, input.generationId)
    const stale = await query(`UPDATE public.meta_recovery_archive_jobs SET row_version=row_version+1
      WHERE id=$1::uuid AND state='applying' AND worker_owner_id=$2
        AND worker_fence=$3::bigint AND block_fence=$4::bigint
        AND lease_until=$5::timestamptz AND lease_until>clock_timestamp() RETURNING id`,
      [jobId, stopped.worker_owner_id, stopped.worker_fence, stopped.block_fence, stopped.lease_until])
    assert.equal(stale.rowCount, 0, 'RECOVERY_LOCAL_BACKUP_MANUAL_STALE_CAS_WRITES')
    const done = await waitForJob(query, jobId, row => row.state === 'done')
    assert.equal(done.completed_count, '5001')
    assert.equal(done.block_fence, stopped.block_fence)
    assert.equal(done.archive_generation_id, input.generationId)
    const chunks = await readChunks(query, jobId)
    assert.deepEqual(chunks.map(row => [row.chunk_index, row.state, row.committed_count]),
      [[0, 'committed', '5000'], [1, 'committed', '1']])
    assert.deepEqual(chunks[0], firstChunks[0], 'RECOVERY_LOCAL_BACKUP_MANUAL_CHUNK_DOUBLE_APPLY')
    const members = (await query(`SELECT ordinal, child_operation_id::text AS child_operation_id
      FROM public.meta_record_history_operation_members WHERE sheet_id=$1 AND parent_operation_id=$2::uuid ORDER BY ordinal`,
      [input.identity.sheetId, done.terminal_operation_id])).rows
    assert.deepEqual(members, chunks.map((row, index) => ({ ordinal: index + 1, child_operation_id: row.operation_id })))
    const terminalOperation = await query(`SELECT operation_kind, component_count FROM public.meta_record_history_operations
      WHERE sheet_id=$1 AND operation_id=$2::uuid`, [input.identity.sheetId, done.terminal_operation_id])
    assert.deepEqual(terminalOperation.rows, [{ operation_kind: 'restore_aggregate', component_count: 2 }])
    assert.equal(chunks.some(row => row.operation_id === done.terminal_operation_id), false)
    assert.deepEqual((await query('SELECT recovery_writer_state FROM public.meta_sheets WHERE id=$1',
      [input.identity.sheetId])).rows, [{ recovery_writer_state: null }])
    await assertRestoredRows(query, input)
    await stopLauncher(service, true)
    service = undefined
    await waitForNoListener(port)
    // The slow lease/takeover profile is immutable. C drains terminal derived effects only.
    const drainConfig = join(targetRoot, 'recovery-drain-config.json')
    await writeFile(drainConfig, `${JSON.stringify({ ...recoveryProfile, workerIntervalMs: 10 })}\n`,
      { flag: 'wx', mode: 0o600 })
    service = launch(drainConfig, appConfig, targetRoot, port)
    await waitForLocked(service)
    assert.equal(await canConnect(port), false)
    await writePipeSecret(service, input.local.recoverySecret)
    await waitForListener(port)
    await waitForDerivedEffects(query, jobId)
    assert.deepEqual(await readJob(query, jobId), done, 'RECOVERY_LOCAL_BACKUP_MANUAL_DRAIN_JOB_CHANGED')
    assert.deepEqual(await readChunks(query, jobId), chunks, 'RECOVERY_LOCAL_BACKUP_MANUAL_DRAIN_CHUNKS_CHANGED')
    assert.deepEqual((await query(`SELECT ordinal, child_operation_id::text AS child_operation_id
      FROM public.meta_record_history_operation_members WHERE sheet_id=$1 AND parent_operation_id=$2::uuid ORDER BY ordinal`,
      [input.identity.sheetId, done.terminal_operation_id])).rows, members)
    assert.deepEqual((await query(`SELECT operation_kind, component_count FROM public.meta_record_history_operations
      WHERE sheet_id=$1 AND operation_id=$2::uuid`, [input.identity.sheetId, done.terminal_operation_id])).rows,
    terminalOperation.rows)
    await assertRestoredRows(query, input)
    const metadata = await query(
      'SELECT storage_path FROM public.multitable_attachments WHERE id=$1 AND sheet_id=$2',
      [input.attachmentId, input.identity.sheetId],
    )
    assert.equal(metadata.rows.length, 1)
    const storagePath = (metadata.rows[0] as { storage_path?: unknown }).storage_path
    assert.equal(typeof storagePath, 'string')
    const recovered = await getAttachmentStorageService().readContentAddressed(storagePath as string)
    assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(input.attachmentBytes))
    await stopLauncher(service, true)
    service = undefined
    assert.equal(await canConnect(port), false, 'RECOVERY_LOCAL_BACKUP_MANUAL_LISTENER_RESIDUE')
    const offAfter = await probeFlagOff(rollbackInput, appConfig, targetRoot)
    assert.deepEqual(offAfter.responses, offBefore.responses, 'RECOVERY_LOCAL_ROLLBACK_HTTP_PARITY_FAILED')
    assert.equal(offAfter.tableCount, offBefore.tableCount)
    return offBefore.tableCount
  } finally {
    try {
      if (service) await stopLauncher(service, false)
    } finally {
      input.local.recoverySecret.fill(0)
      await pool.end()
      await poolManager.close()
    }
  }
}

interface JobWitness {
  state: string; total_count: string; completed_count: string; archive_generation_id: string
  block_fence: string; worker_fence: string; worker_owner_id: string | null; lease_until: Date | string
  lease_expired: boolean; terminal_operation_id: string | null
}
async function readJob(query: RecoveryArchiveRestoreJobQuery, jobId: string): Promise<JobWitness> {
  const result = await query(`SELECT state,total_count::text,completed_count::text,archive_generation_id::text,
    block_fence::text,worker_fence::text,worker_owner_id,lease_until,
    lease_until<=clock_timestamp() AS lease_expired,terminal_operation_id::text
    FROM public.meta_recovery_archive_jobs WHERE id=$1::uuid`, [jobId])
  assert.equal(result.rows.length, 1)
  return result.rows[0] as JobWitness
}
async function waitForJob(query: RecoveryArchiveRestoreJobQuery, jobId: string,
  ready: (row: JobWitness) => boolean): Promise<JobWitness> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const row = await readJob(query, jobId)
    if (ready(row)) return row
    assert.equal(['abandoned_partial', 'cancelled_zero_write', 'paused_retryable'].includes(row.state), false)
    await delay(25)
  }
  throw new Error('RECOVERY_LOCAL_BACKUP_MANUAL_JOB_TIMEOUT')
}
async function readChunks(query: RecoveryArchiveRestoreJobQuery, jobId: string) {
  return (await query(`SELECT chunk_index,state,committed_count::text,operation_id::text
    FROM public.meta_recovery_archive_job_chunks WHERE job_id=$1::uuid ORDER BY chunk_index`, [jobId])).rows as
    Array<{ chunk_index: number; state: string; committed_count: string | null; operation_id: string | null }>
}
async function assertOrdinaryWriterBlocked(pool: Pool, input: ManualTargetInput): Promise<void> {
  const { fenceWriterEntry, SheetWriterBlockedError } = require('../src/multitable/canonical-sheet-fence.ts') as typeof import('../src/multitable/canonical-sheet-fence')
  const client = await pool.connect()
  let reachedWrite = false
  try {
    await client.query('BEGIN')
    await assert.rejects(async () => {
      await fenceWriterEntry((text, values) => client.query(text, values), input.identity.sheetId)
      reachedWrite = true
      await client.query('UPDATE public.meta_records SET version=version+1 WHERE id=$1', [input.recordIds[0]])
    }, SheetWriterBlockedError)
    assert.equal(reachedWrite, false)
  } finally { await client.query('ROLLBACK'); client.release() }
}
async function assertRestoredRows(query: RecoveryArchiveRestoreJobQuery, input: ManualTargetInput): Promise<void> {
  const rows = (await query(`SELECT r.id,r.data,r.version,
    (SELECT count(*)::int FROM public.meta_record_revisions v WHERE v.record_id=r.id AND v.source='restore') AS restores
    FROM public.meta_records r WHERE r.sheet_id=$1 ORDER BY r.id`, [input.identity.sheetId])).rows
  assert.deepEqual(rows, input.recordIds.map(id => ({ id,
    data: { [input.fieldId]: 'captured', [input.attachmentFieldId]: id === input.recordId ? [input.attachmentId] : [] },
    version: id === input.recordId ? 4 : 3, restores: id === input.recordId ? 2 : 1 })))
}
async function waitForDerivedEffects(query: RecoveryArchiveRestoreJobQuery, jobId: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const rows = (await query(`SELECT count(*)::int AS total,count(completed_at)::int AS completed
      FROM public.meta_recovery_archive_derived_effects WHERE job_id=$1::uuid`, [jobId])).rows
    if ((rows[0] as { completed: number }).completed === 5001) {
      assert.deepEqual(rows, [{ total: 5001, completed: 5001 }]); return
    }
    await delay(50)
  }
  throw new Error('RECOVERY_LOCAL_BACKUP_MANUAL_DRAIN_TIMEOUT')
}
async function waitForNoListener(port: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return
    await delay(25)
  }
  throw new Error('RECOVERY_LOCAL_BACKUP_MANUAL_LISTENER_RESIDUE')
}

function launch(recoveryConfig: string, appConfig: string, targetRoot: string, port: number): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', launcher, recoveryConfig], {
    cwd: backend,
    env: targetEnvironment(appConfig, targetRoot, port),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
}

function targetEnvironment(appConfig: string, targetRoot: string, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
    ATTACHMENT_PATH: process.env.ATTACHMENT_PATH, JWT_SECRET: process.env.JWT_SECRET,
    CONFIG_FILE: appConfig, SECRET_PROVIDER: 'env', CACHE_TYPE: 'memory',
    SKIP_PLUGINS: 'true', DISABLE_WORKFLOW: 'true', DISABLE_EVENT_BUS: 'true',
    APPROVAL_PROJECTION_SWEEP_DISABLED: '1', APPROVAL_SLA_SCHEDULER_DISABLED: '1',
    WEBHOOK_RETRY_SCHEDULER_DISABLED: '1', MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1',
    DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1', DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
    MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true',
    MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true', METASHEET_ENV_DIR: targetRoot,
    HOST: '127.0.0.1', PORT: String(port),
  }
}

async function probeFlagOff(input: ManualRollbackInput, appConfig: string, targetRoot: string): Promise<ManualRollbackResult> {
  const child = fork(rollbackWitness, [], {
    cwd: backend, execArgv: ['--import', 'tsx'],
    env: { ...targetEnvironment(appConfig, targetRoot, 0),
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'false', MULTITABLE_ENABLE_WRITER_FENCE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  let timer: NodeJS.Timeout | undefined
  try {
    return await new Promise<ManualRollbackResult>((resolve, reject) => {
      let result: ManualRollbackResult | undefined
      timer = setTimeout(() => reject(new Error('RECOVERY_LOCAL_ROLLBACK_TIMEOUT')), 180_000)
      child.once('error', () => reject(new Error('RECOVERY_LOCAL_ROLLBACK_LAUNCH_FAILED')))
      child.on('message', (message: { kind: string; result?: ManualRollbackResult; code?: string; frames?: string[] }) => {
        if (message.kind === 'flag-off-done') result = message.result
        else if (message.kind === 'flag-off-error') {
          if (message.frames?.length) console.log(JSON.stringify({ phase: 'flag-off', frames: message.frames }))
          reject(new Error(message.code && /^RECOVERY_[A-Z0-9_]+$/.test(message.code)
            ? message.code : 'RECOVERY_LOCAL_ROLLBACK_FAILED'))
        }
      })
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null && result) resolve(result)
        else reject(new Error('RECOVERY_LOCAL_ROLLBACK_EARLY_EXIT'))
      })
      child.send(input, error => { if (error) reject(new Error('RECOVERY_LOCAL_ROLLBACK_IPC_FAILED')) })
    })
  } finally {
    clearTimeout(timer)
    await stopLauncher(child, false)
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (connected: boolean) => { socket.destroy(); resolve(connected) }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitForListener(port: number): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await canConnect(port)) return
    await delay(100)
  }
  throw new Error('RECOVERY_LOCAL_BACKUP_MANUAL_LISTENER_TIMEOUT')
}

async function waitForLocked(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_LOCK_TIMEOUT')), 120_000)
    let output = ''
    const consume = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-512)
      if (output.includes('RECOVERY_LOCAL_CUSTODY_LOCKED')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.once('error', () => { clearTimeout(timer); reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_LAUNCH_FAILED')) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_EARLY_EXIT')) })
  })
}

async function writePipeSecret(child: ChildProcess, secret: Uint8Array): Promise<void> {
  const pipe = child.stdio[3]
  assert.ok(pipe && 'end' in pipe)
  const payload = Buffer.from(secret)
  try {
    await new Promise<void>((resolve, reject) => {
      pipe.once('error', reject)
      pipe.end(payload, resolve)
    })
  } finally {
    payload.fill(0)
  }
}

async function stopLauncher(child: ChildProcess, requireGraceful: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (requireGraceful) assert.deepEqual({ code: child.exitCode, signal: child.signalCode }, { code: 0, signal: null })
    return
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  child.kill('SIGTERM')
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 60_000) })
  const result = await Promise.race([exited, timeout])
  clearTimeout(timer)
  if (!result) {
    throw new Error('RECOVERY_LOCAL_BACKUP_MANUAL_STOP_TIMEOUT')
  }
  if (requireGraceful) assert.deepEqual(result, { code: 0, signal: null })
}

process.once('message', (input: ManualTargetInput) => {
  void (async () => {
    try {
      const rollbackTableCount = await run(input)
      await send({ kind: 'manual-target-done', rollbackTableCount })
    } catch (error) {
      const code = error instanceof Error && /^RECOVERY_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_FAILED'
      const frames = error instanceof Error
        ? [...(error.stack ?? '').matchAll(/\/(verify-recovery-local-manual-(?:http\.ts|target\.mts)):(\d+)/g)]
          .map((match) => `${match[1]}:${match[2]}`) : []
      await send({ kind: 'manual-target-error', code, frames })
      process.exitCode = 1
    } finally {
      process.disconnect()
    }
  })()
})
