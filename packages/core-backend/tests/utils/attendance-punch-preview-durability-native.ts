import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { expect, it } from 'vitest'
import { punchDetailPreparationFixture } from '../../src/attendance/__tests__/helpers/punch-detail-plan-fixture'
import { createAttendancePunchDetailPreviewHostV1, type AttendancePunchDetailPreviewAuthorizerV1 } from '../../src/attendance/w4c3a-punch-detail-preview-host'
import { createAttendancePunchDetailPreviewJobHostV1 } from '../../src/attendance/w4c3a-punch-detail-preview-job-host'
import type { AttendanceSyncImportHostDepsV1 } from '../../src/attendance/w4c3a-sync-import-host'

const businessTables = ['attendance_records', 'attendance_events', 'attendance_record_calculations',
  'attendance_record_segments', 'attendance_import_batches', 'attendance_import_items',
  'attendance_result_operations', 'attendance_result_event_outbox'] as const
const authorize: AttendancePunchDetailPreviewAuthorizerV1 = async (client, input) =>
  (await client.query("SELECT 1 FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:import'",
    [input.scope.actorId])).length === 1

type QueryHook = (client: PoolClient, sql: string, result: QueryResult, pid: number) => Promise<void>
function nativeDeps(pool: Pool, hook?: QueryHook, acquired?: (pid: number) => void): AttendanceSyncImportHostDepsV1 {
  return { async acquireConnection() {
    const client = await pool.connect()
    let pid: number
    try {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      acquired?.(pid)
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('PUNCH_PREVIEW_PID_PROBE_FAILED'))
      throw error
    }
    return { client: { async query(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params)
      await hook?.(client, sql, result, pid)
      return result
    } }, release(error?: Error) { client.release(error) } }
  } }
}
function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PUNCH_PREVIEW_BARRIER_NOT_OBSERVED')), 3000)
  })]) } finally { clearTimeout(timer) }
}
let childExecutable: Promise<string> | undefined
async function compiledChild() {
  if (!childExecutable) childExecutable = (async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const artifacts = path.join(root, 'artifacts')
    await mkdir(artifacts, { recursive: true })
    const directory = await mkdtemp(path.join(artifacts, 'punch-preview-recovery-'))
    const outfile = path.join(directory, 'worker.cjs')
    const require = createRequire(import.meta.url)
    // Use the compiler owned by the already-declared tsx dependency; no install or dependency edit.
    const compiler = createRequire(require.resolve('tsx'))('esbuild') as {
      build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>
    }
    const build = await compiler.build({ absWorkingDir: root,
      entryPoints: [fileURLToPath(new URL('./attendance-punch-preview-recovery-child.cjs', import.meta.url))],
      outfile, platform: 'node', format: 'cjs', bundle: true, packages: 'external', metafile: true, logLevel: 'silent' })
    const sourceHashes: Record<string, string> = {}
    for (const file of Object.keys(build.metafile.inputs)) {
      sourceHashes[file] = createHash('sha256').update(await readFile(path.resolve(root, file))).digest('hex')
    }
    await writeFile(path.join(directory, 'source-manifest.json'), JSON.stringify({ sourceHashes,
      bundleSHA256: createHash('sha256').update(await readFile(outfile)).digest('hex') }, null, 2) + '\n')
    return outfile
  })()
  return childExecutable
}
async function freshProcess(jobId: string, genericDatabaseOnly = false) {
  const executable = await compiledChild()
  const env = { ...process.env }
  if (genericDatabaseOnly) delete env.ATTENDANCE_TEST_DATABASE_URL
  return new Promise<{ result: { kind: string; idempotent?: boolean; code?: string }; pid: number;
    businessQueries: number; fullSnapshotReads: number; namespaceReads: number }>((resolve, reject) => {
    execFile(process.execPath, [executable, jobId],
      { env, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          const stages = stdout.split('\n').filter(line => line.startsWith('PUNCH_PREVIEW_CHILD_STAGE '))
            .slice(-4).map(line => JSON.parse(line.slice('PUNCH_PREVIEW_CHILD_STAGE '.length)))
          reject(new Error('PUNCH_PREVIEW_FRESH_PROCESS_FAILED ' + JSON.stringify({
            code: error.code, killed: error.killed, signal: error.signal, stages,
          })))
          return
        }
        const rows = stdout.split('\n').filter(line => line.startsWith('PUNCH_PREVIEW_CHILD '))
        if (rows.length !== 1) { reject(new Error('PUNCH_PREVIEW_CHILD_RECEIPT_MISSING')); return }
        resolve(JSON.parse(rows[0].slice('PUNCH_PREVIEW_CHILD '.length)))
      })
  })
}

async function fixture(pool: Pool) {
  const orgId = randomUUID(), actorId = randomUUID(), userId = randomUUID(), shiftId = randomUUID()
  const roleId = 'punch-durable-' + actorId
  const priorRollout = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  for (const id of [actorId, userId]) {
    await pool.query(`INSERT INTO users (id,email,username,name,password_hash,role,permissions,is_active,is_admin,activation_status)
      VALUES ($1,$2,$1,'preview durability fixture','x','user','[]'::jsonb,true,false,'activated')`, [id, id + '@example.test'])
    await pool.query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [id, orgId])
  }
  await pool.query('INSERT INTO roles (id,name) VALUES ($1,$1)', [roleId])
  await pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:import')", [roleId])
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [actorId, roleId])
  await pool.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ($1,'attendance',true)", [actorId])
  await pool.query("INSERT INTO user_permissions (user_id,permission_code) VALUES ($1,'attendance:import')", [actorId])
  await pool.query(`INSERT INTO attendance_calculation_rollout_state
    (org_id,state,engine_version,reason_code,actor_id,version,prior_state,scope)
    VALUES ($1,'legacy','preview-durability-test','TEST_FIXTURE',$2,1,NULL,'synthetic_staging')`, [orgId, actorId])
  await pool.query("UPDATE attendance_calculation_rollout_state SET state='shadow',prior_state='legacy',version=2 WHERE org_id=$1", [orgId])
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
  const preparation = punchDetailPreparationFixture('fold_start', {
    orgId, actorId, actorPosture: 'attendance_admin', tokenSubjectUserId: actorId,
  }, randomUUID(), { userId, shiftId })
  const input = { scope: preparation.scope, envelope: { ...preparation.envelope, idempotencyKey: randomUUID() },
    jobId: randomUUID(), batchId: preparation.batchId, previewLimit: 2 }
  const callbacks = { authorizeTarget: authorize, beforeCreate: async () => {}, resolveFrozenTarget: async () => ({
    attribution: preparation.attribution, context: preparation.context, policySourceProof: preparation.policySourceProof,
  }) }
  const effects = async () => {
    const rows = []
    for (const table of businessTables) rows.push((await pool.query(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [orgId])).rows)
    return rows
  }
  const receipt = async () => (await pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(r) AS record
    FROM attendance_import_jobs j JOIN attendance_import_punch_preview_records r ON r.job_id=j.id WHERE j.id=$1`, [input.jobId])).rows
  return { orgId, actorId, input, callbacks, effects, receipt,
    async cleanup() {
      await pool.query('DELETE FROM attendance_import_tokens WHERE org_id=$1', [orgId])
      await pool.query("DELETE FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:import'", [actorId])
      await pool.query("DELETE FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [actorId])
      await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2', [actorId, roleId])
      await pool.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId])
      await pool.query('DELETE FROM roles WHERE id=$1', [roleId])
      if (priorRollout === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorRollout
    } }
}

/** Native lifecycle proof; frozen input and target policy callback are synthetic, not real-auth proof. */
export function registerPunchPreviewDurabilityNativeCases(getPool: () => Pool) {
  it('PUNCH_PREVIEW_DURABILITY_ACQUIRE_FAILURE: releases a checked-out helper client when PID probe fails', async () => {
    const error = new Error('PUNCH_PREVIEW_CONTROLLED_PID_FAILURE')
    const released: Array<Error | undefined> = []
    const pool = { connect: async () => ({ query: async () => { throw error },
      release: (failure?: Error) => { released.push(failure) } }) } as unknown as Pool
    await expect(nativeDeps(pool).acquireConnection()).rejects.toBe(error)
    expect(released).toEqual([error])
  })

  it('PUNCH_PREVIEW_DURABILITY_RECOVERY: fresh job-ID-only process rechecks admission and completes frozen preview', async () => {
    const pool = getPool(), f = await fixture(pool)
    try {
      const before = await f.effects()
      const reserved = await createAttendancePunchDetailPreviewHostV1(nativeDeps(pool)).reservePunchDetailPreview(f.input, f.callbacks)
      expect(reserved.created).toBe(true)
      expect(reserved.job.status).toBe('queued')
      expect(reserved.record.preview).toMatchObject({ eventCount: 4, previewLimit: 2, truncated: true,
        targets: [{ dailyProjection: { workedMinutes: 165 } }] })
      const queued = await f.receipt()
      await pool.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id=$1 AND namespace='attendance'", [f.actorId])
      const denied = await freshProcess(f.input.jobId, true)
      expect(denied.result, 'PUNCH_PREVIEW_RECOVERY_CURRENT_ADMISSION').toEqual({ kind: 'refused', code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' })
      expect(denied.fullSnapshotReads).toBe(0)
      expect(denied.businessQueries).toBe(0)
      expect(await f.receipt()).toEqual(queued)
      await pool.query("UPDATE user_namespace_admissions SET enabled=true WHERE user_id=$1 AND namespace='attendance'", [f.actorId])
      const completed = await freshProcess(f.input.jobId, true)
      expect(completed.result, 'PUNCH_PREVIEW_RECOVERY_COMPLETED').toEqual({ kind: 'completed', idempotent: false })
      expect(completed.pid).not.toBe(process.pid)
      expect(completed.fullSnapshotReads).toBe(1)
      expect(completed.namespaceReads).toBeGreaterThan(0)
      expect(completed.businessQueries).toBe(0)
      const terminal = await f.receipt()
      expect(terminal).toHaveLength(1)
      expect(terminal[0].record, 'PUNCH_PREVIEW_RECOVERY_FROZEN_RECORD').toEqual(queued[0].record)
      expect(terminal[0].job).toMatchObject({ status: 'completed', progress: 4, total: 4, error: null })
      const repeated = await freshProcess(f.input.jobId)
      expect(repeated.pid).not.toBe(completed.pid)
      expect(repeated.result).toEqual({ kind: 'completed', idempotent: true })
      expect(repeated.businessQueries).toBe(0)
      expect(await f.receipt()).toEqual(terminal)
      expect(await f.effects()).toEqual(before)
      console.log('PUNCH_PREVIEW_DURABILITY_RECEIPT ' + JSON.stringify({ case: 'fresh_process',
        childProcesses: 3, jobIdOnly: true, currentAdmissionRefusals: 1, frozenRecordUnchanged: true,
        businessTablesUnchanged: 8, realPolicyProof: false, redisQueueRestartProof: false }))
    } finally { await f.cleanup() }
  }, 120000)

  it('PUNCH_PREVIEW_DURABILITY_CONCURRENCY: competing native workers observe one completion and an idempotent terminal', async () => {
    const pool = getPool(), f = await fixture(pool)
    const held = signal(), release = signal()
    const pending: Promise<unknown>[] = []
    try {
      const before = await f.effects()
      await createAttendancePunchDetailPreviewHostV1(nativeDeps(pool)).reservePunchDetailPreview(f.input, f.callbacks)
      const queued = await f.receipt()
      let successfulUpdates = 0, firstPID = 0, secondPID = 0, paused = false
      const first = createAttendancePunchDetailPreviewJobHostV1(nativeDeps(pool, async (_client, sql) => {
        if (sql.includes('FOR UPDATE OF j') && !paused) { paused = true; held.resolve(); await release.promise }
        if (sql.startsWith('UPDATE attendance_import_jobs AS j')) successfulUpdates += 1
      }, pid => { firstPID = pid })).processPunchDetailPreviewJob({ jobId: f.input.jobId }, authorize)
      pending.push(first); first.catch(() => held.resolve())
      await bounded(held.promise)
      expect(paused).toBe(true)
      const second = createAttendancePunchDetailPreviewJobHostV1(nativeDeps(pool, async (_client, sql) => {
        if (sql.startsWith('UPDATE attendance_import_jobs AS j')) successfulUpdates += 1
      }, pid => { secondPID = pid })).processPunchDetailPreviewJob({ jobId: f.input.jobId }, authorize)
      pending.push(second); second.catch(() => {})
      let blocked = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (secondPID) {
          const rows = await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [secondPID, firstPID])
          if (rows.rows[0].blocked === true) { blocked = true; break }
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked, 'PUNCH_PREVIEW_NATIVE_LOCK_CONTENTION').toBe(true)
      release.resolve()
      expect(await Promise.all([first, second]), 'PUNCH_PREVIEW_SINGLE_NATIVE_COMPLETION').toEqual([
        { kind: 'completed', idempotent: false }, { kind: 'completed', idempotent: true },
      ])
      expect(successfulUpdates).toBe(1)
      const terminal = await f.receipt()
      expect(terminal[0].record).toEqual(queued[0].record)
      expect(terminal[0].job).toMatchObject({ status: 'completed', progress: 4, total: 4 })
      expect(await f.effects()).toEqual(before)
      console.log('PUNCH_PREVIEW_DURABILITY_RECEIPT ' + JSON.stringify({ case: 'concurrency',
        observedNativeBlocking: true, successfulCompletionUpdates: 1, idempotentPeer: true, businessTablesUnchanged: 8 }))
    } finally { release.resolve(); await Promise.allSettled(pending); await f.cleanup() }
  }, 120000)

  it('PUNCH_PREVIEW_DURABILITY_ROLLBACK: native SQL abort rolls back token, reservation and completion metadata', async () => {
    const pool = getPool(), f = await fixture(pool)
    try {
      const before = await f.effects(), token = randomUUID()
      await pool.query(`INSERT INTO attendance_import_tokens (token,org_id,user_id,expires_at,created_at)
        VALUES ($1,$2,$3,now()+interval '10 minutes',now())`, [token, f.orgId, f.actorId])
      const tokenRows = async () => (await pool.query('SELECT to_jsonb(t) AS row FROM attendance_import_tokens t WHERE token=$1', [token])).rows
      const originalToken = await tokenRows()
      const callbacks = { ...f.callbacks, beforeCreate: async (client: Parameters<typeof authorize>[0]) => {
        expect(await client.query('DELETE FROM attendance_import_tokens WHERE token=$1 RETURNING token', [token])).toEqual([{ token }])
      } }
      let reservationAbortObserved = false
      const fault = nativeDeps(pool, async (client, sql) => {
        if (sql.startsWith('INSERT INTO attendance_import_punch_preview_records')) {
          reservationAbortObserved = true
          await client.query('SELECT 1/0')
        }
      })
      await expect(createAttendancePunchDetailPreviewHostV1(fault).reservePunchDetailPreview(f.input, callbacks))
        .rejects.toMatchObject({ code: '22012' })
      expect(reservationAbortObserved).toBe(true)
      expect(await tokenRows(), 'PUNCH_PREVIEW_ROLLBACK_TOKEN').toEqual(originalToken)
      for (const [table, key] of [['attendance_import_jobs', 'id'], ['attendance_import_punch_preview_records', 'job_id']]) {
        expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${key}=$1`, [f.input.jobId])).rows,
          'PUNCH_PREVIEW_ROLLBACK_RESERVATION').toEqual([])
      }
      await createAttendancePunchDetailPreviewHostV1(nativeDeps(pool)).reservePunchDetailPreview(f.input, callbacks)
      expect(await tokenRows()).toEqual([])
      const queued = await f.receipt()
      let completionAbortObserved = false
      const completionFault = nativeDeps(pool, async (client, sql) => {
        if (sql.startsWith('UPDATE attendance_import_jobs AS j')) {
          completionAbortObserved = true
          await client.query('SELECT 1/0')
        }
      })
      await expect(createAttendancePunchDetailPreviewJobHostV1(completionFault)
        .processPunchDetailPreviewJob({ jobId: f.input.jobId }, authorize)).rejects.toMatchObject({ code: '22012' })
      expect(completionAbortObserved).toBe(true)
      expect(await f.receipt(), 'PUNCH_PREVIEW_ROLLBACK_COMPLETION').toEqual(queued)
      expect(await createAttendancePunchDetailPreviewJobHostV1(nativeDeps(pool))
        .processPunchDetailPreviewJob({ jobId: f.input.jobId }, authorize)).toEqual({ kind: 'completed', idempotent: false })
      expect((await f.receipt())[0].record).toEqual(queued[0].record)
      expect(await f.effects()).toEqual(before)
      console.log('PUNCH_PREVIEW_DURABILITY_RECEIPT ' + JSON.stringify({ case: 'rollback',
        nativeSqlAborts: 2, tokenRestored: true, failedReservationRows: 0, failedCompletionUnchanged: true,
        restoredCompletion: true, businessTablesUnchanged: 8, sharedTokenRaceProof: false }))
    } finally { await f.cleanup() }
  }, 120000)
}
