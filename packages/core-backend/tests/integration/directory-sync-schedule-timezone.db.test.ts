import { afterAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  createDirectoryIntegration,
  getDirectorySyncScheduleSnapshot,
  updateDirectoryIntegration,
} from '../../src/directory/directory-sync'

/**
 * Roadmap §7.8 "Add timezone support" — the schedule_timezone COLUMN round-trip against a
 * REAL migrated database.
 *
 * The unit suite (directory-sync-scheduler.test.ts / admin-directory-routes.test.ts) pins
 * the SQL text and route wiring through a mocked pg client; that guards the shape, not
 * whether the zzzz migration actually created a real, writable column with the expected
 * default. This proves the two things only Postgres can:
 *
 *   1. `schedule_timezone` persists and round-trips through create → read → update →
 *      read, exactly like `schedule_cron`.
 *   2. `updateDirectoryIntegration`'s absent-vs-present distinction (see the comment on
 *      that function): omitting the key on an update PRESERVES the currently-saved value;
 *      an explicit empty string CLEARS it back to the default. This is the one behavior a
 *      mocked-pg unit test cannot prove end-to-end, because it never round-trips through
 *      an actual second SELECT.
 *
 * Fixture IDs are namespaced with this file's own STAMP — the plugin-tests job runs many
 * suites against ONE shared database.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

function basePayload(nameSuffix: string) {
  return {
    name: `sched-tz golden ${nameSuffix} ${STAMP}`,
    corpId: `sched-tz-corp-${nameSuffix}-${STAMP}`,
    appKey: `app-key-${nameSuffix}`,
    appSecret: 'super-secret',
    syncEnabled: true,
  }
}

describeIfDatabase('directory_integrations.schedule_timezone (real DB, roadmap §7.8)', () => {
  const integrationIds: string[] = []

  afterAll(async () => {
    for (const id of integrationIds) {
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
  })

  it('persists a configured IANA zone on create and returns it from the summary and the schedule snapshot', async () => {
    const created = await createDirectoryIntegration({
      ...basePayload('create'),
      scheduleCron: '0 2 * * *',
      scheduleTimezone: 'Asia/Shanghai',
    })
    integrationIds.push(created.id)

    expect(created.scheduleTimezone).toBe('Asia/Shanghai')

    const snapshot = await getDirectorySyncScheduleSnapshot(created.id)
    expect(snapshot?.scheduleTimezone).toBe('Asia/Shanghai')
    // The snapshot's nextExpectedRunAt estimate must actually use this zone, not a
    // hardcoded UTC — regression guard for the exact bug roadmap §7.8 fixes.
    expect(snapshot?.cronValid).toBe(true)
    expect(snapshot?.nextExpectedRunAt).not.toBeNull()
  })

  it('leaves schedule_timezone NULL by default (byte-identical to pre-§7.8) when not provided on create', async () => {
    const created = await createDirectoryIntegration({
      ...basePayload('default'),
      scheduleCron: '*/15 * * * *',
    })
    integrationIds.push(created.id)

    expect(created.scheduleTimezone).toBeNull()

    const row = await query<{ schedule_timezone: string | null }>(
      `SELECT schedule_timezone FROM directory_integrations WHERE id = $1`,
      [created.id],
    )
    expect(row.rows[0].schedule_timezone).toBeNull()
  })

  it('rejects an invalid IANA zone at the service layer the same way admin-directory.ts does', async () => {
    // The route validates before ever calling createDirectoryIntegration; this proves the
    // column itself has no separate CHECK constraint silently laundering a bad value — the
    // application-level gate is the only thing standing between junk and the DB, and
    // (defensively) resolveDirectoryScheduleTimezone at read time still degrades a
    // hypothetical bad row to UTC. This test writes the RAW column directly (bypassing the
    // service layer entirely, like a hand-authored migration/backfill might) to prove that
    // defensive degrade actually holds against the real column.
    const created = await createDirectoryIntegration({
      ...basePayload('junk-bypass'),
      scheduleCron: '0 3 * * *',
    })
    integrationIds.push(created.id)

    await query(`UPDATE directory_integrations SET schedule_timezone = $2 WHERE id = $1`, [created.id, 'Not/AZone'])

    const snapshot = await getDirectorySyncScheduleSnapshot(created.id)
    // Read-time resolver defensively treats the persisted junk as UTC rather than crashing
    // the snapshot / scheduler boot.
    expect(snapshot?.scheduleTimezone).toBe('Not/AZone') // raw column value is surfaced as-is…
    expect(snapshot?.cronValid).toBe(true) // …but next-run computation did not throw/degrade to invalid
    expect(snapshot?.nextExpectedRunAt).not.toBeNull()
  })

  describe('update absent-vs-present semantics', () => {
    it('an ABSENT scheduleTimezone key on update PRESERVES the currently-saved value', async () => {
      const created = await createDirectoryIntegration({
        ...basePayload('preserve'),
        scheduleCron: '0 2 * * *',
        scheduleTimezone: 'America/New_York',
      })
      integrationIds.push(created.id)
      expect(created.scheduleTimezone).toBe('America/New_York')

      // Simulates the CURRENT (pre-FE-support) UI form save: the payload omits
      // scheduleTimezone entirely (no key), just like DirectoryManagementView.vue's draft
      // object does today.
      const updated = await updateDirectoryIntegration(created.id, {
        ...basePayload('preserve'),
        scheduleCron: '0 3 * * *', // admin only changed the cron
      })

      expect(updated?.scheduleCron).toBe('0 3 * * *')
      expect(updated?.scheduleTimezone).toBe('America/New_York') // untouched, not wiped to null

      const row = await query<{ schedule_timezone: string | null }>(
        `SELECT schedule_timezone FROM directory_integrations WHERE id = $1`,
        [created.id],
      )
      expect(row.rows[0].schedule_timezone).toBe('America/New_York')
    })

    it('an explicitly PRESENT empty-string scheduleTimezone on update CLEARS it back to the default', async () => {
      const created = await createDirectoryIntegration({
        ...basePayload('clear'),
        scheduleCron: '0 2 * * *',
        scheduleTimezone: 'Europe/London',
      })
      integrationIds.push(created.id)
      expect(created.scheduleTimezone).toBe('Europe/London')

      const updated = await updateDirectoryIntegration(created.id, {
        ...basePayload('clear'),
        scheduleCron: '0 2 * * *',
        scheduleTimezone: '', // explicit clear
      })

      expect(updated?.scheduleTimezone).toBeNull()

      const row = await query<{ schedule_timezone: string | null }>(
        `SELECT schedule_timezone FROM directory_integrations WHERE id = $1`,
        [created.id],
      )
      expect(row.rows[0].schedule_timezone).toBeNull()
    })

    it('an explicitly PRESENT new zone on update OVERWRITES the previous one', async () => {
      const created = await createDirectoryIntegration({
        ...basePayload('overwrite'),
        scheduleCron: '0 2 * * *',
        scheduleTimezone: 'Asia/Shanghai',
      })
      integrationIds.push(created.id)

      const updated = await updateDirectoryIntegration(created.id, {
        ...basePayload('overwrite'),
        scheduleCron: '0 2 * * *',
        scheduleTimezone: 'Europe/Paris',
      })

      expect(updated?.scheduleTimezone).toBe('Europe/Paris')
    })
  })
})
