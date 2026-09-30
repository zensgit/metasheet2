/** Test-only target process: never opens the source database or source roots. */
import assert from 'node:assert/strict'
import { fork, spawn, type ChildProcess } from 'node:child_process'
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

  const pool: Pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 4, application_name: 'tm_local_manual_target' })
  const query: RecoveryArchiveRestoreJobQuery = (text, values) => pool.query(text, values)
  let service: ChildProcess | undefined
  try {
    const identity = await query('SELECT current_database() AS database_name')
    assert.equal((identity.rows[0] as { database_name?: string } | undefined)?.database_name, input.databaseName)
    const appConfig = join(targetRoot, 'application-config.json')
    const recoveryConfig = join(targetRoot, 'recovery-config.json')
    await writeFile(appConfig, '{}\n', { flag: 'wx', mode: 0o600 })
    await writeFile(recoveryConfig, `${JSON.stringify({
      archivePath: input.local.archivePath, custodyPath: input.local.custodyPath,
      custodyId: input.local.custodyId, storeId: input.local.storeId,
      maxObjectBytes: 16 * 1024 * 1024, receipt: input.local.receipt,
      auditedReplayHorizonMs: 60_000, asyncResumeHorizonMs: 600_000,
      workerIntervalMs: 10, leaseMs: 60_000, replayHorizonMs: 60_000,
      sweepLimit: 100, maxChunksPerRun: 20,
    })}\n`, { flag: 'wx', mode: 0o600 })
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
    await restoreImportedManualArchiveOverHttp({
      runtime: { query }, identity: input.identity,
      generationId: input.generationId, recordId: input.recordId,
      fieldId: input.fieldId, attachmentFieldId: input.attachmentFieldId,
      attachmentId: input.attachmentId,
    }, origin, { 'content-type': 'application/json', authorization: `Bearer ${loginBody.data.token}` })
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
    child.kill('SIGKILL')
    await exited
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
