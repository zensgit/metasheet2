import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect, it } from 'vitest'

type Reply = { status: number; body: unknown }
type Dependencies = {
  pool(): Pool
  baseUrl(): string
  seedDay(workDate: string, segments: Array<{ startTime: string; endTime: string }>, timezone: string,
    identity: { orgId: string; userId: string }):
    Promise<{ orgId: string; userId: string; headers: Record<string, string> }>
  request(url: string, options?: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> }): Promise<Reply>
}
const scenarios = [
  { id: 'gap', day: '2026-03-08', reason: 'dst_gap_local_time',
    clocks: [['00:30', '01:00'], ['02:30', '04:00']],
    instants: ['05:30', '06:00', '07:30', '08:00'] },
  { id: 'shared_fold', day: '2025-11-02', reason: 'dst_fold_shared_boundary_ambiguous',
    clocks: [['00:30', '01:30'], ['01:30', '03:00']],
    instants: ['04:30', '05:30', '06:30', '08:00'] },
] as const
const data = (reply: Reply) => (reply.body as { data: Record<string, unknown> }).data


async function withReviewFixture(
  deps: Dependencies,
  scenario: typeof scenarios[number],
  run: (fixture: Awaited<ReturnType<Dependencies['seedDay']>>, roleId: string) => Promise<void>,
) {
  // Allocate ownership before seeding, so a partially failed seed is still cleaned.
  const identity = { orgId: randomUUID(), userId: randomUUID() }
  const roleId = 'punch-review-' + randomUUID()
  const pool = deps.pool()
  try {
    const fixture = await deps.seedDay(scenario.day,
      scenario.clocks.map(([startTime, endTime]) => ({ startTime, endTime })), 'America/New_York', identity)
    expect({ orgId: fixture.orgId, userId: fixture.userId }).toEqual(identity)
    await run(fixture, roleId)
  } finally {
    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [identity.userId])
    await pool.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId])
    await pool.query('DELETE FROM roles WHERE id=$1', [roleId])
    await pool.query('DELETE FROM user_namespace_admissions WHERE user_id=$1', [identity.userId])
    await pool.query('DELETE FROM user_permissions WHERE user_id=$1', [identity.userId])
    await pool.query('DELETE FROM user_sessions WHERE user_id=$1', [identity.userId])
    await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2',
      [identity.userId, identity.orgId])
    // Keep referenced business-history rows while removing the synthetic actor's authority.
    await pool.query("UPDATE users SET is_active=false, is_admin=false, permissions='[]'::jsonb WHERE id=$1", [identity.userId])
    const residue = (await pool.query(`SELECT
      (SELECT count(*)::int FROM users WHERE id=$1 AND (is_active OR is_admin OR permissions <> '[]'::jsonb)) AS users,
      (SELECT count(*)::int FROM user_orgs WHERE user_id=$1 AND org_id=$2 AND is_active) AS memberships,
      (SELECT count(*)::int FROM user_permissions WHERE user_id=$1) AS permissions,
      (SELECT count(*)::int FROM user_roles WHERE user_id=$1) AS roles,
      (SELECT count(*)::int FROM role_permissions WHERE role_id=$3) AS role_permissions,
      (SELECT count(*)::int FROM roles WHERE id=$3) AS role_records,
      (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id=$1) AS admissions,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=$1) AS sessions`,
    [identity.userId, identity.orgId, roleId])).rows[0]
    expect(residue, 'PUNCH_REVIEW_FIXTURE_AUTHORITY_REMOVED').toEqual({
      users: 0, memberships: 0, permissions: 0, roles: 0, role_permissions: 0,
      role_records: 0, admissions: 0, sessions: 0,
    })
    console.log('PUNCH_REVIEW_FIXTURE_CLEANUP_RECEIPT ' + JSON.stringify({ authorityRows: 0, businessHistoryRetained: true }))
  }
}

/** Public-route review proof; seedDay retains its existing auth-bypass fixture boundary. */
export function registerPunchReviewPublicNativeCases(deps: Dependencies) {
  it('PUNCH_REVIEW_FIXTURE_PARTIAL_SEED: seed failure still removes owned fixture authority', async () => {
    const priorRollout = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    let bodyEntered = false
    try {
      await expect(withReviewFixture({
        ...deps,
        seedDay: async (...args) => {
          await deps.seedDay(...args)
          throw new Error('PUNCH_REVIEW_EXPECTED_SEED_FAILURE')
        },
      }, scenarios[0], async () => { bodyEntered = true })).rejects.toThrow('PUNCH_REVIEW_EXPECTED_SEED_FAILURE')
      expect(bodyEntered).toBe(false)
    } finally {
      if (priorRollout === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorRollout
    }
  }, 120000)

  it.each(scenarios)('PUNCH_REVIEW_PUBLIC_$id: four public paths retain review and refuse ordinary recompute', async scenario => {
    const prior = Object.fromEntries(['ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED',
      'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'].map(key => [key, process.env[key]]))
    const completedPaths: string[] = []
    try {
      process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = 'false'
      for (const asyncMode of [false, true]) {
        await withReviewFixture(deps, scenario, async (f, roleId) => {
          const pool = deps.pool()
          await pool.query('INSERT INTO roles (id,name) VALUES ($1,$1)', [roleId])
          await pool.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'attendance:import')", [roleId])
          await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [f.userId, roleId])
          await pool.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled) VALUES ($1,'attendance',true)", [f.userId])
          const call = (path: string, body?: Record<string, unknown>) => deps.request(deps.baseUrl() + path,
            { method: body === undefined ? 'GET' : 'POST', headers: f.headers, ...(body === undefined ? {} : { body }) })
          const effects = async () => {
            const result: unknown[] = []
            for (const table of ['attendance_records', 'attendance_record_calculations', 'attendance_record_segments',
              'attendance_import_batches', 'attendance_import_items', 'attendance_result_operation_batches',
              'attendance_result_operations', 'attendance_result_event_outbox']) {
              result.push((await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [f.orgId])).rows)
            }
            return result
          }
          const punches = scenario.instants.map((clock, ordinal) => ({
            direction: ordinal % 2 === 0 ? 'check_in' : 'check_out', occurredAt: scenario.day + 'T' + clock + ':00.000Z',
          }))
          const command = { inputKind: 'punch_events_v1', orgId: f.orgId, userId: f.userId,
            workDate: scenario.day, timezone: 'America/New_York', mode: 'override',
            idempotencyKey: randomUUID(), punches }
          const target = { userId: f.userId, workDate: scenario.day, outcome: 'review_required',
            reasonCode: scenario.reason, dailyProjection: null, segments: [] }
          const waitJob = async (jobId: string) => {
            let row: { status: string; w4_execution_reason_code: string | null } | undefined
            for (let attempt = 0; attempt < 100; attempt += 1) {
              row = (await pool.query('SELECT status,w4_execution_reason_code FROM attendance_import_jobs WHERE id=$1 AND org_id=$2',
                [jobId, f.orgId])).rows[0]
              if (row?.status === 'completed' || row?.status === 'failed') break
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            expect(row, 'PUNCH_REVIEW_PUBLIC_JOB_COMPLETED').toEqual({ status: 'completed', w4_execution_reason_code: null })
          }
          const before = await effects()
          const previewPath = '/api/attendance/import/preview' + (asyncMode ? '-async' : '')
          const preview = await call(previewPath, command)
          expect(preview.status, 'PUNCH_REVIEW_PUBLIC_PREVIEW_HTTP').toBe(200)
          let projection = data(preview)
          if (asyncMode) {
            const jobId = (data(preview).job as { id: string }).id
            expect(typeof jobId).toBe('string')
            await waitJob(jobId)
            const read = await call('/api/attendance/import/jobs/' + jobId)
            expect(read.status).toBe(200)
            projection = data(read).preview as Record<string, unknown>
            const stored = (await pool.query('SELECT snapshot FROM attendance_import_punch_preview_records WHERE job_id=$1 AND org_id=$2',
              [jobId, f.orgId])).rows
            expect(stored).toHaveLength(1)
            expect(stored[0].snapshot.preview).toEqual(projection)
          }
          expect(projection).toMatchObject({ inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1,
            processedRows: 4, failedRows: 0 })
          expect(projection.targets, 'PUNCH_REVIEW_PUBLIC_TYPED_PREVIEW').toEqual([target])
          expect(projection.items).toEqual(punches.map((punch, sourceOrdinal) => ({ sourceOrdinal, ...punch })))
          expect(await effects(), 'PUNCH_REVIEW_PUBLIC_PREVIEW_NO_BUSINESS_WRITES').toEqual(before)
          completedPaths.push(asyncMode ? 'async_preview' : 'sync_preview')

          const prepared = await call('/api/attendance/import/prepare', { orgId: f.orgId })
          expect(prepared.status).toBe(200)
          const commitPath = '/api/attendance/import/commit' + (asyncMode ? '-async' : '')
          const committed = await call(commitPath, { ...command, idempotencyKey: randomUUID(), commitToken: data(prepared).commitToken })
          expect(committed.status, 'PUNCH_REVIEW_PUBLIC_COMMIT_HTTP').toBe(200)
          let batchId = data(committed).batchId
          if (asyncMode) {
            const jobId = (data(committed).job as { id: string }).id
            expect(typeof jobId).toBe('string')
            await waitJob(jobId)
            batchId = (await pool.query('SELECT batch_id FROM attendance_import_jobs WHERE id=$1 AND org_id=$2', [jobId, f.orgId])).rows[0].batch_id
          } else {
            expect(data(committed)).toMatchObject({ inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1, processedRows: 4, failedRows: 0 })
          }
          expect(typeof batchId).toBe('string')
          const parents = (await pool.query(`SELECT id,projection_owner,current_calculation_id,visibility_state,visibility_reason,
            first_in_at,last_out_at,work_minutes,late_minutes,early_leave_minutes
            FROM attendance_records WHERE org_id=$1 AND user_id=$2 AND work_date=$3`, [f.orgId, f.userId, scenario.day])).rows
          expect(parents).toHaveLength(1)
          expect(parents[0], 'PUNCH_REVIEW_PUBLIC_NO_ACTIVE_POINTER').toEqual({ id: parents[0].id,
            projection_owner: 'legacy_untracked', current_calculation_id: null, visibility_state: 'retired',
            visibility_reason: 'review_placeholder', first_in_at: null, last_out_at: null, work_minutes: 0,
            late_minutes: 0, early_leave_minutes: 0 })
          const calculations = (await pool.query(`SELECT entrypoint,mode,outcome,outcome_reason_code,projection_effect,
            expected_segment_count,projected_status,projected_first_in_at,projected_last_out_at,
            projected_work_minutes,projected_late_minutes,projected_early_leave_minutes,projected_daily_fingerprint,evidence_snapshot
            FROM attendance_record_calculations WHERE org_id=$1 AND attendance_record_id=$2 AND calculation_kind='calculation'`,
          [f.orgId, parents[0].id])).rows
          expect(calculations, 'PUNCH_REVIEW_PUBLIC_TYPED_CALCULATION').toEqual([{ entrypoint: 'legacy_import',
            mode: 'authoritative', outcome: 'review_required', outcome_reason_code: scenario.reason, projection_effect: 'none',
            expected_segment_count: 0, projected_status: null, projected_first_in_at: null, projected_last_out_at: null,
            projected_work_minutes: null, projected_late_minutes: null, projected_early_leave_minutes: null,
            projected_daily_fingerprint: null, evidence_snapshot: punches.map((punch, ordinal) => ({
              kind: 'punch', ref: `import:${batchId}:${ordinal}:${punch.direction}`, ...punch, source: 'import',
            })) }])
          expect((await pool.query('SELECT id FROM attendance_record_segments WHERE org_id=$1', [f.orgId])).rows).toEqual([])
          const items = (await pool.query(`SELECT (preview_snapshot->>'sourceOrdinal')::int AS ordinal,
            preview_snapshot->>'direction' AS direction,preview_snapshot->>'occurredAt' AS occurred_at
            FROM attendance_import_items WHERE org_id=$1 AND batch_id=$2 ORDER BY ordinal`, [f.orgId, batchId])).rows
          expect(items).toEqual(punches.map((punch, ordinal) => ({ ordinal, direction: punch.direction, occurred_at: punch.occurredAt })))
          const after = await effects()
          const refused = await call('/api/attendance/records/' + parents[0].id + '/recompute',
            { orgId: f.orgId, operationId: randomUUID(), policy: 'frozen_prior',
              expectedCalculationId: null, expectedCalculationVersion: null })
          expect(refused.status, 'PUNCH_REVIEW_PUBLIC_RECOMPUTE_REFUSED').toBe(409)
          expect((refused.body as { error: { code: string } }).error.code).toBe('ATTENDANCE_RECORD_RETIRED')
          expect(await effects(), 'PUNCH_REVIEW_PUBLIC_REFUSAL_NO_BUSINESS_WRITES').toEqual(after)
          completedPaths.push(asyncMode ? 'async_commit' : 'sync_commit')
        })
      }
      expect(completedPaths).toEqual(['sync_preview', 'sync_commit', 'async_preview', 'async_commit'])
      console.log('PUNCH_REVIEW_PUBLIC_RECEIPT ' + JSON.stringify({ family: scenario.id, reason: scenario.reason,
        completedPaths, physicalEvents: 4, activePointers: 0, projectedMinutes: null,
        recompute: 'ATTENDANCE_RECORD_RETIRED', unchangedBusinessTablesOnPreviewAndRefusal: 8,
        fixtureAuthBypass: true, realRedis: false }))
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 120000)
}
