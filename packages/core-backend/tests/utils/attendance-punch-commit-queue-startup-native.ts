import { expect, it } from 'vitest'
import { EP01_DST_READY_CASES } from './attendance-ep01-dst-ready-callers'
import { startRecovery } from './attendance-punch-queue-startup-native'
import type { Fixture, Runtime } from './attendance-punch-queue-startup-native'

const scenario = EP01_DST_READY_CASES[0]
type Actor = Awaited<ReturnType<Fixture['login']>>
type Durable = { job: Record<string, unknown>; plan: unknown; chunks: unknown[]; terminal: unknown[] }
type Reserved = {
  actor: Actor; jobId: string; batchId: string; before: unknown[]; frozen: Durable
  durable(): Promise<Durable>
  recovery: Awaited<ReturnType<typeof startRecovery>>
}
type FixtureRunner = (run: (f: Fixture) => Promise<void>) => Promise<void>

/** The transport alone is controlled; producer, durable plan and worker are production paths. */
async function withFailedCommitQueue(
  f: Fixture, getServer: () => unknown, run: (reserved: Reserved) => Promise<void>,
) {
  const actor = await f.login(f.orgId, true)
  const before = await f.effects()
  const runtime = getServer() as Runtime
  const original = runtime.createPluginContext
  const failures: string[] = []
  let recovery: Awaited<ReturnType<typeof startRecovery>> | undefined
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
            throw new Error('PUNCH_COMMIT_CONTROLLED_ADD_FAILURE')
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
    const failed = await f.call('/api/attendance/import/commit-async', actor.token, command)
    expect(failed.status, 'PUNCH_COMMIT_QUEUE_ADD_FAILED_HTTP').toBe(500)
    expect(failed.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED', message: 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED' } })
    expect(failures).toHaveLength(1)
    const jobId = failures[0]
    const durable = async (): Promise<Durable> => {
      const rows = (await f.pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(p) AS plan
        FROM attendance_import_jobs j JOIN attendance_import_legacy_execution_plans p
          ON p.job_id=j.id AND p.org_id=j.org_id WHERE j.id=$1 AND j.org_id=$2`, [jobId, f.orgId])).rows
      expect(rows).toHaveLength(1)
      const chunks = (await f.pool.query(`SELECT to_jsonb(t) AS row
        FROM attendance_import_legacy_execution_plan_chunks t
        JOIN attendance_import_legacy_execution_plans p ON p.job_id=t.job_id AND p.org_id=$2
        WHERE t.job_id=$1 ORDER BY t.chunk_index`,
      [jobId, f.orgId])).rows
      const terminal = (await f.pool.query(`SELECT to_jsonb(t) AS row
        FROM attendance_import_legacy_terminal_responses t WHERE job_id=$1 AND org_id=$2 ORDER BY to_jsonb(t)::text`,
      [jobId, f.orgId])).rows
      return { ...rows[0], chunks, terminal }
    }
    const frozen = await durable()
    expect(frozen.job).toMatchObject({ status: 'queued', w4_contract_version: 1, punch_preview_version: null })
    expect(frozen.chunks.length).toBeGreaterThan(0)
    expect(frozen.terminal).toEqual([])
    const batchId = frozen.job.batch_id
    if (typeof batchId !== 'string') throw new Error('PUNCH_COMMIT_BATCH_REQUIRED')
    const tokens = async () => (await f.pool.query('SELECT to_jsonb(t) AS row FROM attendance_import_tokens t WHERE token=$1', [token])).rows
    expect(await tokens(), 'PUNCH_COMMIT_TOKEN_CONSUMED_ONCE').toEqual([])
    const replay = await f.call('/api/attendance/import/commit-async', actor.token, command)
    expect(replay.status, 'PUNCH_COMMIT_QUEUED_RETRY').toBe(200)
    expect(replay.body).toMatchObject({ ok: true, data: { idempotent: true, job: { id: jobId, status: 'queued' } } })
    expect(failures).toHaveLength(1)
    expect((await f.pool.query('SELECT id FROM attendance_import_jobs WHERE org_id=$1 AND created_by=$2 ORDER BY id',
      [f.orgId, actor.userId])).rows).toEqual([{ id: jobId }])
    expect(await tokens()).toEqual([])
    expect(await durable(), 'PUNCH_COMMIT_RETRY_DURABLE_UNCHANGED').toEqual(frozen)
    expect(await f.effects()).toEqual(before)
    expect((await runtime.deactivatePluginByName('plugin-attendance')).status).toBe('inactive')
    recovery = await startRecovery(jobId)
    await run({ actor, jobId, batchId, before, frozen, durable, recovery })
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
}

export function registerPunchCommitQueueStartupNativeCases(fixture: FixtureRunner, getServer: () => unknown) {
  for (const revoked of ['permission', 'namespace', 'subject'] as const) {
    it('PUNCH_COMMIT_QUEUE_' + revoked.toUpperCase() + ': restart rejects current revocation without business effects', async () => {
      await fixture(async f => withFailedCommitQueue(f, getServer, async r => {
        const setAdmission = async (enabled: boolean) => {
          if (revoked === 'permission') {
            if (enabled) await f.pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:import')", [r.actor.roleId])
            else await f.pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='attendance:import'", [r.actor.roleId])
          } else if (revoked === 'namespace') {
            await f.pool.query("UPDATE user_namespace_admissions SET enabled=$2 WHERE user_id=$1 AND namespace='attendance'", [r.actor.userId, enabled])
          } else {
            await f.pool.query('UPDATE user_orgs SET is_active=$3 WHERE user_id=$1 AND org_id=$2', [f.userId, f.orgId, enabled])
          }
        }
        try {
          await setAdmission(false)
          expect(await r.recovery.attempt()).toEqual({ kind: 'attempt', outcome: 'returned' })
          const failed = await r.durable()
          expect(failed.job, 'PUNCH_COMMIT_CURRENT_' + revoked.toUpperCase()).toMatchObject({
            status: 'failed', w4_execution_reason_code: revoked === 'subject'
              ? 'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED' : 'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
          })
          expect({ plan: failed.plan, chunks: failed.chunks, terminal: failed.terminal })
            .toEqual({ plan: r.frozen.plan, chunks: r.frozen.chunks, terminal: [] })
          expect(await f.effects(), 'PUNCH_COMMIT_REFUSAL_NO_BUSINESS_EFFECT').toEqual(r.before)
          await setAdmission(true)
          expect(await r.recovery.attempt()).toEqual({ kind: 'attempt', outcome: 'returned' })
          expect(await r.durable(), 'PUNCH_COMMIT_FAILED_JOB_NOT_REVIVED').toEqual(failed)
          expect(await f.effects()).toEqual(r.before)
          console.log('PUNCH_COMMIT_QUEUE_RECEIPT ' + JSON.stringify({
            variant: revoked, realPasswordSession: true, queueAddFailed: 1, exactRetryNoReenqueue: true,
            freshServerStartup: true, namedTerminalRefusal: true, immutablePlanChunks: true,
            unchangedBusinessTables: 7, failedJobNotRevived: true, redisTransport: false,
          }))
        } finally {
          // Idempotent restoration avoids duplicate role grants when the assertion fails after restoration.
          if (revoked === 'permission') await f.pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:import') ON CONFLICT DO NOTHING", [r.actor.roleId])
          else await setAdmission(true)
        }
      }))
    }, 120000)
  }

  it('PUNCH_COMMIT_QUEUE_HEALTHY: startup executes the frozen four-event plan once and terminal replay has no extras', async () => {
    await fixture(async f => withFailedCommitQueue(f, getServer, async r => {
      expect(await r.recovery.attempt()).toEqual({ kind: 'attempt', outcome: 'returned' })
      const completed = await r.durable()
      expect(completed.job, 'PUNCH_COMMIT_RECOVERY_COMPLETED').toMatchObject({
        status: 'completed', w4_execution_reason_code: null, progress: 4, total: 4,
      })
      expect(completed.plan).toEqual(r.frozen.plan)
      expect(completed.chunks).toEqual(r.frozen.chunks)
      expect(completed.terminal).toHaveLength(1)
      const current = (await f.pool.query(`SELECT c.id,c.projected_work_minutes,c.outcome,c.entrypoint,c.expected_segment_count,c.projection_effect
        FROM attendance_records r JOIN attendance_record_calculations c
          ON c.id=r.current_calculation_id AND c.org_id=r.org_id AND c.attendance_record_id=r.id
        WHERE r.org_id=$1 AND r.user_id=$2 AND r.work_date=$3::date`, [f.orgId, f.userId, scenario.workDate])).rows
      expect(current).toHaveLength(1)
      expect(current[0]).toMatchObject({ projected_work_minutes: 165, outcome: 'completed',
        entrypoint: 'legacy_import', expected_segment_count: 2, projection_effect: 'set_active' })
      const segments = (await f.pool.query(`SELECT segment_index,expected_start_at,expected_end_at,actual_in_at,actual_out_at,
        work_minutes,late_minutes,early_leave_minutes,status,status_reasons FROM attendance_record_segments
        WHERE org_id=$1 AND calculation_id=$2 ORDER BY segment_index`, [f.orgId, current[0].id])).rows
      expect(segments, 'PUNCH_COMMIT_RECOVERED_SEGMENTS').toEqual(scenario.expected.map((s, index) => ({
        segment_index: index, expected_start_at: new Date(s.start), expected_end_at: new Date(s.end),
        actual_in_at: new Date(s.start), actual_out_at: new Date(s.end), work_minutes: s.minutes,
        late_minutes: 0, early_leave_minutes: 0, status: 'normal', status_reasons: [...s.reasons],
      })))
      const items = (await f.pool.query(`SELECT user_id,work_date::text AS work_date,
        (preview_snapshot->>'sourceOrdinal')::int AS ordinal,preview_snapshot->>'direction' AS direction,
        preview_snapshot->>'occurredAt' AS occurred_at FROM attendance_import_items
        WHERE org_id=$1 AND batch_id=$2 ORDER BY ordinal`, [f.orgId, r.batchId])).rows
      expect(items, 'PUNCH_COMMIT_RECOVERED_ALL_PHYSICAL_EVENTS').toEqual(scenario.punches.map(([direction, occurredAt], ordinal) => ({
        user_id: f.userId, work_date: scenario.workDate, ordinal, direction, occurred_at: occurredAt,
      })))
      const after = await f.effects()
      expect((after[1] as unknown[]).length, 'PUNCH_COMMIT_ONE_NEW_CALCULATION').toBe((r.before[1] as unknown[]).length + 1)
      expect((after[3] as unknown[]).length, 'PUNCH_COMMIT_ONE_NEW_BATCH').toBe((r.before[3] as unknown[]).length + 1)
      expect((after[4] as unknown[]).length, 'PUNCH_COMMIT_FOUR_NEW_ITEMS').toBe((r.before[4] as unknown[]).length + 4)
      expect(await r.recovery.attempt()).toEqual({ kind: 'attempt', outcome: 'returned' })
      expect(await r.durable(), 'PUNCH_COMMIT_TERMINAL_REPLAY_DURABLE_UNCHANGED').toEqual(completed)
      expect(await f.effects(), 'PUNCH_COMMIT_TERMINAL_REPLAY_NO_EXTRAS').toEqual(after)
      console.log('PUNCH_COMMIT_QUEUE_RECEIPT ' + JSON.stringify({
        variant: 'healthy', realPasswordSession: true, queueAddFailed: 1, exactRetryNoReenqueue: true,
        freshServerStartup: true, physicalEvents: 4, segments: 2, minutes: 165, immutablePlanChunks: true,
        terminalReplayUnchangedBusinessTables: 7, redisTransport: false,
      }))
    }))
  }, 120000)
}
