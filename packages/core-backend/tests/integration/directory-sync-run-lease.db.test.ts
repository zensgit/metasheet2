import { afterAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { reclaimStaleDirectorySyncRuns } from '../../src/directory/directory-sync'

/**
 * DT-HARDEN-05 — the lease itself and the liveness predicate, proved against the REAL
 * migrated tables.
 *
 * The unit suite pins the reclaim SQL as a string through a mocked pg; that guards the
 * text, not the semantics. These goldens prove the two things only Postgres can:
 *
 *   1. `uq_directory_sync_runs_one_running_per_integration` (partial unique ON
 *      (integration_id) WHERE status='running') makes "at most one running run per
 *      integration" a database invariant — a concurrent second claim is a 23505,
 *      not a race.
 *   2. `COALESCE(last_heartbeat_at, started_at)` staleness on real timestamps: a LIVE
 *      long run (old started_at, fresh beat) is never reclaimed — the exact case a
 *      started_at-only predicate got wrong — while a stale beat or a never-beat crash
 *      is reclaimed once past the threshold.
 *
 * Deliberately NOT replicated here: the completion UPDATE's `AND status = 'running'`
 * guard lives inside syncDirectoryIntegration and is pinned at unit level — re-writing
 * that SQL by hand in a test would reintroduce the drift these goldens exist to kill.
 *
 * Reclaim is always called SCOPED to this suite's integrations: the plugin-tests job
 * runs many suites against ONE database, and an unscoped sweep would eat a sibling
 * suite's running fixtures.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

async function seedIntegration(name: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, status)
     VALUES ($1, $2, 'active')
     RETURNING id`,
    [`lease-golden ${name} ${STAMP}`, `lease-corp-${name}-${STAMP}`],
  )
  return result.rows[0].id
}

async function seedRun(opts: {
  integrationId: string
  status?: string
  startedAgoMinutes: number
  heartbeatAgoMinutes?: number | null
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, started_at, last_heartbeat_at, triggered_by)
     VALUES (
       $1,
       $2,
       NOW() - ($3::int * INTERVAL '1 minute'),
       CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4::int * INTERVAL '1 minute') END,
       'lease-golden'
     )
     RETURNING id`,
    [opts.integrationId, opts.status ?? 'running', opts.startedAgoMinutes, opts.heartbeatAgoMinutes ?? null],
  )
  return result.rows[0].id
}

async function runStatus(runId: string): Promise<{ status: string; error_message: string | null }> {
  const result = await query<{ status: string; error_message: string | null }>(
    `SELECT status, error_message FROM directory_sync_runs WHERE id = $1`,
    [runId],
  )
  return result.rows[0]
}

describeIfDatabase('DT-HARDEN-05 sync-run lease (real DB)', () => {
  const integrationIds: string[] = []

  async function integration(name: string): Promise<string> {
    const id = await seedIntegration(name)
    integrationIds.push(id)
    return id
  }

  afterAll(async () => {
    for (const id of integrationIds) {
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
  })

  it('enforces at most one running run per integration via the partial unique index', async () => {
    const a = await integration('uniq-a')
    const b = await integration('uniq-b')

    await seedRun({ integrationId: a, startedAgoMinutes: 1, heartbeatAgoMinutes: 0 })

    // Second concurrent claim on the SAME integration: unique violation, not a race.
    await expect(
      seedRun({ integrationId: a, startedAgoMinutes: 0, heartbeatAgoMinutes: 0 }),
    ).rejects.toMatchObject({ code: '23505' })

    // A different integration claims freely.
    await expect(
      seedRun({ integrationId: b, startedAgoMinutes: 0, heartbeatAgoMinutes: 0 }),
    ).resolves.toBeTruthy()

    // The index is partial: terminal rows do not block a new claim.
    await query(
      `UPDATE directory_sync_runs SET status = 'failed', finished_at = NOW() WHERE integration_id = $1`,
      [a],
    )
    await expect(
      seedRun({ integrationId: a, startedAgoMinutes: 0, heartbeatAgoMinutes: 0 }),
    ).resolves.toBeTruthy()
  })

  it('never reclaims a live long run: old started_at with a fresh heartbeat survives', async () => {
    const id = await integration('live-long')
    const runId = await seedRun({ integrationId: id, startedAgoMinutes: 180, heartbeatAgoMinutes: 0 })

    const reclaimed = await reclaimStaleDirectorySyncRuns(id)

    expect(reclaimed).toBe(0)
    expect((await runStatus(runId)).status).toBe('running')
  })

  it('reclaims a run whose heartbeat went stale, marking it orphaned', async () => {
    const id = await integration('stale-beat')
    const runId = await seedRun({ integrationId: id, startedAgoMinutes: 180, heartbeatAgoMinutes: 30 })

    const reclaimed = await reclaimStaleDirectorySyncRuns(id)

    expect(reclaimed).toBe(1)
    const row = await runStatus(runId)
    expect(row.status).toBe('failed')
    expect(row.error_message).toContain('orphaned')
  })

  it('falls back to started_at for a run that died before its first beat — but only once stale', async () => {
    const id = await integration('never-beat')
    const dead = await seedRun({ integrationId: id, startedAgoMinutes: 30, heartbeatAgoMinutes: null })

    expect(await reclaimStaleDirectorySyncRuns(id)).toBe(1)
    expect((await runStatus(dead)).status).toBe('failed')

    const young = await seedRun({ integrationId: id, startedAgoMinutes: 2, heartbeatAgoMinutes: null })
    expect(await reclaimStaleDirectorySyncRuns(id)).toBe(0)
    expect((await runStatus(young)).status).toBe('running')
  })
})
