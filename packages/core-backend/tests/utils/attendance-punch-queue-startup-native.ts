import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Pool } from 'pg'
import { expect, it } from 'vitest'

type Reply = { status: number; body: unknown }
export type Fixture = {
  pool: Pool; orgId: string; userId: string; command: Record<string, unknown>
  login(orgId: string, fullImport: boolean): Promise<{ userId: string; roleId: string; token: string }>
  call(path: string, token?: string, body?: Record<string, unknown>): Promise<Reply>
  effects(): Promise<unknown[]>
}
export type Runtime = {
  createPluginContext(input: unknown): { services: Record<string, unknown> }
  deactivatePluginByName(name: string): Promise<{ status: string }>
  activatePluginByName(name: string): Promise<{ status: string }>
}
type WireMessage = { kind: string; outcome?: string; code?: string; pid?: number; offered?: unknown }

export async function startRecovery(jobId: string) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const artifacts = path.join(root, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  const directory = await mkdtemp(path.join(artifacts, 'punch-queue-startup-'))
  const outfile = path.join(directory, 'worker.cjs')
  const require = createRequire(import.meta.url)
  // Compile current source with the existing tsx dependency, never an old dist.
  const compiler = createRequire(require.resolve('tsx'))('esbuild') as {
    build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>
  }
  const build = await compiler.build({ absWorkingDir: root,
    entryPoints: [fileURLToPath(new URL('./attendance-punch-queue-startup-child.ts', import.meta.url))],
    outfile, platform: 'node', format: 'cjs', bundle: true, packages: 'external', metafile: true, logLevel: 'silent' })
  const sourceHashes: Record<string, string> = {}
  for (const file of Object.keys(build.metafile.inputs)) {
    sourceHashes[file] = createHash('sha256').update(await readFile(path.resolve(root, file))).digest('hex')
  }
  await writeFile(path.join(directory, 'source-manifest.json'), JSON.stringify({ sourceHashes,
    bundleSHA256: createHash('sha256').update(await readFile(outfile)).digest('hex') }, null, 2) + '\n')
  const child = fork(outfile, [], {
    execArgv: [],
    env: { ...process.env, NODE_ENV: 'test', RBAC_BYPASS: 'false', RBAC_TOKEN_TRUST: 'false' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const messages: WireMessage[] = []
  let wake: (() => void) | undefined
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const exited = new Promise<void>(resolve => child.once('exit', (code, signal) => {
    exit = { code, signal }; wake?.(); resolve()
  }))
  child.on('message', (message: WireMessage) => { messages.push(message); wake?.() })
  const next = async (kind: string) => {
    const until = Date.now() + 60000
    while (Date.now() < until) {
      const message = messages.shift()
      if (message) {
        if (message.kind === 'error') throw new Error(message.code)
        expect(message.kind).toBe(kind)
        return message
      }
      if (exit) throw new Error('PUNCH_QUEUE_CHILD_EXITED')
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve() }, 100)
        wake = () => { clearTimeout(timer); wake = undefined; resolve() }
      })
    }
    throw new Error('PUNCH_QUEUE_CHILD_MESSAGE_TIMEOUT')
  }
  const stop = async () => {
    if (!exit) child.send({ action: 'stop' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PUNCH_QUEUE_CHILD_STOP_TIMEOUT')), 15000)
      })])
      expect(exit).toEqual({ code: 0, signal: null })
    } finally {
      clearTimeout(timer)
      if (!exit) { child.kill('SIGKILL'); await exited }
    }
  }
  try {
    await next('boot')
    child.send({ action: 'start', jobId })
    const ready = await next('ready')
    expect(ready.pid).not.toBe(process.pid)
    expect(ready.offered, 'PUNCH_QUEUE_STARTUP_TARGET_OFFERED').toEqual({
      queue: 'attendance-import', name: 'attendance-import-commit-async', data: { jobId },
      options: { jobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: false },
    })
    return { stop, attempt: async () => { child.send({ action: 'attempt' }); return next('attempt') } }
  } catch (error) {
    try { await stop() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'PUNCH_QUEUE_START_AND_CLEANUP_FAILED')
    }
    throw error
  }
}

/** Only queue transport is controlled; fresh server creates the actual startup query, port and authorization callback. */
export function registerPunchQueueStartupNativeCases(
  fixture: (run: (f: Fixture) => Promise<void>) => Promise<void>,
  getServer: () => unknown,
) {
  it('PUNCH_QUEUE_PREVIEW: failed enqueue survives fresh server startup and current scoped policy gates', async () => {
    await fixture(async f => {
      const actor = await f.login(f.orgId, true)
      const before = await f.effects()
      const runtime = getServer() as Runtime
      const original = runtime.createPluginContext
      const failures: string[] = []
      let recovery: Awaited<ReturnType<typeof startRecovery>> | undefined
      const durable = async (jobId: string) => (await f.pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(r) AS record
        FROM attendance_import_jobs j JOIN attendance_import_punch_preview_records r ON r.job_id=j.id WHERE j.id=$1`,
      [jobId])).rows
      try {
        expect((await runtime.deactivatePluginByName('plugin-attendance')).status).toBe('inactive')
        runtime.createPluginContext = function (input) {
          const context = original.call(this, input)
          context.services.queue = {
            process() {},
            async add(_queue: string, _name: string, data: { jobId: string }) {
              const row = (await f.pool.query('SELECT created_by FROM attendance_import_jobs WHERE id=$1', [data.jobId])).rows[0]
              if (row?.created_by === actor.userId) {
                failures.push(data.jobId)
                throw new Error('PUNCH_QUEUE_CONTROLLED_ADD_FAILURE')
              }
            },
          }
          return context
        }
        expect((await runtime.activatePluginByName('plugin-attendance')).status).toBe('active')
        const prepared = await f.call('/api/attendance/import/prepare', actor.token, {})
        expect(prepared.status).toBe(200)
        const token = (prepared.body as { data: { commitToken: string } }).data.commitToken
        const command = { ...f.command, commitToken: token }
        const failed = await f.call('/api/attendance/import/preview-async', actor.token, command)
        expect(failed.status, 'PUNCH_QUEUE_ADD_FAILED_HTTP').toBe(500)
        expect(failed.body).toEqual({ ok: false, error: {
          code: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED', message: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED' } })
        expect(failures).toHaveLength(1)
        const jobId = failures[0]
        const frozen = await durable(jobId)
        expect(frozen).toHaveLength(1)
        expect(frozen[0].job).toMatchObject({ status: 'queued', punch_preview_version: 1, w4_contract_version: null })
        const tokenState = async () => (await f.pool.query(
          'SELECT to_jsonb(t) AS row FROM attendance_import_tokens t WHERE token=$1', [token])).rows
        const afterReservationToken = await tokenState()
        expect(afterReservationToken).toHaveLength(process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN === '1' ? 0 : 1)
        const replay = await f.call('/api/attendance/import/preview-async', actor.token, command)
        expect(replay.status).toBe(200)
        expect(replay.body).toMatchObject({ ok: true, data: { idempotent: true, job: { id: jobId, status: 'queued' } } })
        expect(failures).toHaveLength(1)
        expect(await tokenState(), 'PUNCH_QUEUE_REPLAY_TOKEN_UNCHANGED').toEqual(afterReservationToken)
        expect(await durable(jobId)).toEqual(frozen)
        expect(await f.effects()).toEqual(before)
        expect((await runtime.deactivatePluginByName('plugin-attendance')).status).toBe('inactive')
        await f.pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance:import'", [actor.roleId])
        recovery = await startRecovery(jobId)
        const denied = async (label: string) => {
          expect(await recovery!.attempt(), label).toEqual({
            kind: 'attempt', outcome: 'rejected', code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' })
          expect(await durable(jobId), label + '_DURABLE_UNCHANGED').toEqual(frozen)
          expect(await f.effects(), label + '_BUSINESS_UNCHANGED').toEqual(before)
        }
        await denied('PUNCH_QUEUE_CURRENT_IMPORT_REVOKED')
        const scopeId = randomUUID()
        await f.pool.query(`INSERT INTO attendance_scheduler_scopes
          (id,org_id,subject_type,subject_ref,actions,scope,is_active,created_by,updated_by)
          VALUES ($1,$2,'user',$3,ARRAY['import']::text[],$4::jsonb,true,'integration-test','integration-test')`,
        [scopeId, f.orgId, actor.userId, JSON.stringify({ userIds: [actor.userId] })])
        await denied('PUNCH_QUEUE_WRONG_SCOPED_TARGET')
        await f.pool.query('UPDATE attendance_scheduler_scopes SET scope=$2::jsonb WHERE id=$1',
          [scopeId, JSON.stringify({ userIds: [f.userId] })])
        await f.pool.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id=$1 AND namespace='attendance'", [actor.userId])
        await denied('PUNCH_QUEUE_CURRENT_NAMESPACE')
        await f.pool.query("UPDATE user_namespace_admissions SET enabled=true WHERE user_id=$1 AND namespace='attendance'", [actor.userId])
        await f.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [f.userId, f.orgId])
        await denied('PUNCH_QUEUE_CURRENT_SUBJECT')
        await f.pool.query('UPDATE user_orgs SET is_active=true WHERE user_id=$1 AND org_id=$2', [f.userId, f.orgId])
        expect((await f.pool.query(`SELECT rp.permission_code FROM role_permissions rp
          JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=$1
          AND rp.permission_code IN ('attendance:import','attendance:admin')
          UNION ALL SELECT permission_code FROM user_permissions WHERE user_id=$1
          AND permission_code IN ('attendance:import','attendance:admin')`, [actor.userId])).rows).toEqual([])
        expect(await recovery.attempt(), 'PUNCH_QUEUE_CURRENT_SCOPED_SUCCESS').toEqual({ kind: 'attempt', outcome: 'returned' })
        const completed = await durable(jobId)
        expect(completed[0].job).toMatchObject({ status: 'completed', progress: 4, total: 4, error: null })
        expect(completed[0].record).toEqual(frozen[0].record)
        expect(await f.effects()).toEqual(before)
        expect(await recovery.attempt()).toEqual({ kind: 'attempt', outcome: 'returned' })
        expect(await durable(jobId)).toEqual(completed)
        expect(await f.effects(), 'PUNCH_QUEUE_TERMINAL_REPLAY_NO_BUSINESS_EFFECT').toEqual(before)
        console.log('PUNCH_QUEUE_PREVIEW_RECEIPT ' + JSON.stringify({
          queueAddFailed: 1, exactRetryNoReenqueue: true, freshServerStartupOfferedJobId: true,
          currentPermissionDenied: true, wrongScopeDenied: true, namespaceDenied: true, subjectDenied: true,
          scopedWorkerCompleted: true, globalImportGrants: 0, immutableRecordUnchanged: true,
          unchangedBusinessTables: 7, redisTransport: false,
        }))
      } finally {
        try { if (recovery) await recovery.stop() } finally {
          runtime.createPluginContext = original
          try {
            expect((await runtime.deactivatePluginByName('plugin-attendance')).status).toBe('inactive')
          } finally {
            expect((await runtime.activatePluginByName('plugin-attendance')).status).toBe('active')
          }
        }
      }
    })
  }, 120000)
}
