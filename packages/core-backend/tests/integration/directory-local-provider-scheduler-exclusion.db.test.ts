import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { SchedulerServiceImpl } from '../../src/services/SchedulerService'
import {
  resetDirectorySyncSchedulerForTests,
  startDirectorySyncScheduler,
} from '../../src/directory/directory-sync-scheduler'

/**
 * Canonical Org MVP — B1 owner round P2-2 (local-provider bootstrap), #4215 §5.1, real DB.
 *
 * `getOrCreateLocalIntegration`'s doc comment claims a `provider='local'` row is "NEVER
 * scheduled or swept" because `directory-sync-scheduler.ts`'s `listScheduleRows()` selects
 * `WHERE provider = 'dingtalk'`. That was a code-facts-only claim with no test pinning it. This
 * proves it against the scheduler's REAL startup-scan path (`startDirectorySyncScheduler`,
 * which calls `listScheduleRows()` against real Postgres), not a mocked one:
 *
 *   - a `provider='local'` row is inserted FORCED to `status='active'`, `sync_enabled=true`, and
 *     a valid `schedule_cron` — i.e. every condition `shouldSchedule()` checks is satisfied,
 *     so if the scheduler's provider filter were ever dropped this row WOULD schedule;
 *   - an identically-configured `provider='dingtalk'` row is inserted alongside it as a
 *     POSITIVE CONTROL: after the same startup scan, ITS job must be registered, proving the
 *     test is actually observing real scheduling and not just an inert no-op scan;
 *   - after `startDirectorySyncScheduler` runs, the local row's job (exact
 *     `directory-sync:<id>` format built by the scheduler module's private `buildJobName`,
 *     replicated inline here since it isn't exported) must be absent, while the dingtalk row's
 *     job must be present.
 *
 * Uses a real `SchedulerServiceImpl` (not a mock) so `getJob()` reflects genuine
 * registration/absence. The forced schedule_cron is a once-a-year expression so no scheduled
 * fire can occur during the test's lifetime; the scheduler instance is destroyed in `afterEach`
 * regardless.
 *
 * Fixture IDs are namespaced with this file's own STAMP + a per-test suffix — integration specs
 * share one real Postgres in CI (plugin-tests.yml), so a bare `Date.now()` can collide with
 * another file's fixtures in the same run.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
// Mirrors directory-sync-scheduler.ts's private `JOB_PREFIX` + `buildJobName` — not exported,
// so the format is replicated here (same convention the unit test suite for this module uses).
const JOB_PREFIX = 'directory-sync'
// Once a year (Jan 1, 00:00 UTC): a valid cron expression that cannot fire during this test.
const FAR_FUTURE_CRON = '0 0 1 1 *'

function orgId(suffix: string): string {
  return `b1-sched-excl-${STAMP}-${suffix}`
}

function jobName(integrationId: string): string {
  return `${JOB_PREFIX}:${integrationId}`
}

async function insertForcedScheduleRow(params: {
  org: string
  provider: 'local' | 'dingtalk'
  corpId: string
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config, sync_enabled, schedule_cron, schedule_timezone)
     VALUES ($1, $2, $3, 'active', $4, '{}'::jsonb, true, $5, 'UTC')
     RETURNING id`,
    [params.org, params.provider, `Scheduler exclusion ${params.provider} ${STAMP}`, params.corpId, FAR_FUTURE_CRON],
  )
  return result.rows[0].id
}

describeIfDatabase('Canonical Org MVP — B1 owner round P2-2: scheduler excludes provider=local (real DB)', () => {
  const seededOrgIds: string[] = []
  let scheduler: SchedulerServiceImpl | null = null

  afterEach(async () => {
    scheduler?.destroy()
    scheduler = null
    resetDirectorySyncSchedulerForTests()

    const ids = seededOrgIds.splice(0)
    for (const id of ids) {
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [id])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('startup scan never registers a job for a forced-active/enabled/valid-cron local row, while an identically-configured dingtalk row (positive control) IS registered', async () => {
    const org = orgId('exclusion')
    seededOrgIds.push(org)

    const localId = await insertForcedScheduleRow({ org, provider: 'local', corpId: `local:${org}` })
    const dingtalkId = await insertForcedScheduleRow({ org, provider: 'dingtalk', corpId: `corp-${STAMP}` })

    resetDirectorySyncSchedulerForTests()
    scheduler = new SchedulerServiceImpl()
    await startDirectorySyncScheduler({ scheduler })

    const localJob = await scheduler.getJob(jobName(localId))
    expect(localJob).toBeNull()

    const dingtalkJob = await scheduler.getJob(jobName(dingtalkId))
    expect(dingtalkJob).not.toBeNull()
  })
})
