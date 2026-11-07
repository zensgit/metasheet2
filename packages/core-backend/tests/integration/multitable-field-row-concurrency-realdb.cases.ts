/**
 * Field-row lost updates on the host alone (real Postgres, a synthetic base/sheet/fields): `PATCH /fields/:fieldId` and
 * the generic config-revert branch of `POST /sheets/:sheetId/config-restore-execute`, each racing a concurrent change
 * of the same field row.
 *
 *   RT-5   Tier-2 field revert (type + property, MULTITABLE_ENABLE_FIELD_RETYPE_REVERT): held after its re-read of the
 *          stored property (the lock/switch carry); a concurrent switch write must not be reverted — it waits on the
 *          row lock the revert holds since its in-transaction snapshot, then lands on top.
 *   RT-5b  Tier-1 name revert (the drift check): held after the snapshot; a concurrent rename must not be overwritten
 *          without CONFIG_DRIFT — it waits, then lands on top.
 *   RT-6   the shared column drag (one PATCH per field, all at once): PATCH(B) must finish while PATCH(A) is held after
 *          its first read. Guards the lock PLACEMENT: a lock taken at the first read would park B on A here, and the
 *          real fan-out would deadlock.
 *   RT-8   PATCH held after its first read, one concurrent raw change per column: property, type and name survive (the
 *          PATCH re-runs on fresh data — its first read runs twice); order survives WITHOUT a retry (order is not
 *          compared; the fallback comes from the locked row) and the PATCH's config revision does not claim the move.
 *
 * The writer fence is pinned OFF (it closes these races by itself); every race case asserts that first. A CASES MODULE,
 * registered from the already-wired real-DB file tests/integration/multitable-record-duplicate.test.ts — do NOT list a
 * standalone file. Values-free: every id is synthetic and per-run.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { isWriterFenceEnabled } from '../../src/multitable/canonical-sheet-fence'
import {
  FIELD_CONFIG_SNAPSHOT_LOCKED_SQL,
  FIELD_CONFIG_SNAPSHOT_SQL,
  FIELD_REVERT_STORED_PROPERTY_SQL,
} from '../../src/multitable/config-restore'
import { PATCH_FIELD_LOCKED_REREAD_SQL, PATCH_FIELD_READ_SQL } from '../../src/multitable/field-row-write-guard'
import {
  holdAfter,
  type ParkOutcome,
  raceParkedOrSettled,
  rawClient,
  tracked,
  useWriterFencePinnedOff,
} from '../utils/field-row-race-harness'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const RETYPE_REVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const LOSSY_REVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'
// The raw competitors: one atomic statement each, on a dedicated connection outside every wrapped transaction.
const SWITCH_COMPETITOR_SQL = `UPDATE meta_fields SET property = property || '{"stockPreparationManualRows":"disabled"}'::jsonb WHERE id = $1`
const PROPERTY_COMPETITOR_SQL = `UPDATE meta_fields SET property = property || '{"t3Competitor":"b"}'::jsonb WHERE id = $1`
const TYPE_COMPETITOR_SQL = `UPDATE meta_fields SET type = 'number' WHERE id = $1`
const RENAME_COMPETITOR_SQL = 'UPDATE meta_fields SET name = $2 WHERE id = $1'
const ORDER_COMPETITOR_SQL = 'UPDATE meta_fields SET "order" = "order" + 5 WHERE id = $1'

type FieldRow = { name: string; type: string; property: Record<string, unknown>; order: number }

export function defineMultitableFieldRowConcurrencyRealDbCases(): void {
  test('field row concurrency real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the field row concurrency real-DB cases would skip-green')
    }
  })

  describeIfDatabase('field row writes vs a concurrent change of the same row — PATCH /fields and the config revert (real Postgres)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const BASE = `base_frc_${TOKEN}`
    const SHEET = `sheet_frc_${TOKEN}`
    const SHEET_ORDER = `sheet_frc_order_${TOKEN}`
    const ADMIN = { id: `u_frc_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    const fld = (tag: string) => `fld_frc_${tag}_${TOKEN}`
    useWriterFencePinnedOff()
    const pinned = usePinnedServer()
    const http = () => request(pinned.url())

    const fieldRow = async (id: string): Promise<FieldRow> => {
      const row = (await q('SELECT name, type, property, "order" FROM meta_fields WHERE id = $1', [id])).rows[0] as FieldRow | undefined
      if (!row) throw new Error('field row missing')
      return { name: row.name, type: row.type, property: (row.property ?? {}) as Record<string, unknown>, order: Number(row.order) }
    }
    const seedField = (sheetId: string, id: string, name: string, type: string, property: Record<string, unknown>, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, sheetId, name, type, JSON.stringify(property), order])
    const patchField = (id: string, body: Record<string, unknown>) => http().patch(`/api/multitable/fields/${id}`).send(body)
    const insertRev = async (entityId: string, before: unknown, after: unknown, changedKeys: string[]) =>
      String(((await q(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
         VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5::text[],$6) RETURNING id`,
        [SHEET, entityId, JSON.stringify(before), JSON.stringify(after), changedKeys, ADMIN.id],
      )).rows[0] as { id: string }).id)
    const preview = (revisionId: string) => http().post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId })
    const execute = (revisionId: string, previewToken: string) => http().post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send({ revisionId, previewToken })
    const patchRevisions = async (id: string) => (await q(
      "SELECT changed_keys FROM meta_config_revisions WHERE entity_id = $1 AND actor_id = $2 AND COALESCE(source, 'mutation') <> 'restore' ORDER BY created_at, id",
      [id, ADMIN.id],
    )).rows as Array<{ changed_keys: string[] }>

    /**
     * Run one raw competitor statement on its own connection while a transaction is held, and report whether it
     * finished ('settled') or waited on the held transaction ('parked'). The connection is released only after the
     * statement has finished, so call `finish()` after the hold is released.
     */
    async function competeWhileHeld(pid: number, sql: string, params: unknown[]) {
      const client = await rawClient()
      const run = tracked(() => client.query(sql, params))
      const outcome: ParkOutcome = await raceParkedOrSettled({ blockerPid: pid, queryText: sql, settled: run.settled })
      return {
        outcome,
        async finish() {
          try {
            await run.promise
          } finally {
            client.release()
          }
        },
      }
    }

    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use((req, _res, next) => { ;(req as any).user = ADMIN; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)
      await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'FRC Base'])
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'FRC Sheet'])
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ORDER, BASE, 'FRC Order Sheet'])
    })

    afterAll(async () => {
      for (const sheet of [SHEET, SHEET_ORDER]) {
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
      }
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    })

    test('RT-5 Tier-2 revert held after its stored-property re-read: a concurrent switch write waits on the row lock and survives', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const savedRetype = process.env[RETYPE_REVERT_FLAG]
      const savedLossy = process.env[LOSSY_REVERT_FLAG]
      process.env[RETYPE_REVERT_FLAG] = 'true'
      delete process.env[LOSSY_REVERT_FLAG]
      const id = fld('rt5')
      // The column sits at the revision's `after` (string, locked) so the baseline/drift checks pass and the hold is reached.
      await seedField(SHEET, id, 'RT5 field', 'string', { humanWriteLock: 'plm_system' }, 20)
      const rev = await insertRev(id, { type: 'number', property: {} }, { type: 'string', property: { humanWriteLock: 'plm_system' } }, ['type', 'property'])
      const hold = holdAfter(FIELD_REVERT_STORED_PROPERTY_SQL)
      let executing: ReturnType<typeof tracked> | null = null
      try {
        const pv = await preview(rev)
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        expect(pv.body?.data?.preview?.driftConflict).toBe(false)
        const ex = tracked(() => execute(rev, pv.body.data.previewToken))
        executing = ex
        const pid = await hold.reached()
        const competitor = await competeWhileHeld(pid, SWITCH_COMPETITOR_SQL, [id])
        hold.release()
        const res = (await ex.promise) as { status: number; body: unknown }
        await competitor.finish()
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        const after = await fieldRow(id)
        expect(after.type, 'the revert itself happened').toBe('number')
        expect(after.property.stockPreparationManualRows, 'RT-5: the concurrent switch write survives the revert').toBe('disabled')
        expect(after.property.humanWriteLock).toBe('plm_system')
        expect(competitor.outcome, 'RT-5: the switch write waited on the row lock the revert holds since its snapshot').toBe('parked')
      } finally {
        hold.restore()
        if (executing) await executing.promise.catch(() => {})
        if (savedRetype === undefined) delete process.env[RETYPE_REVERT_FLAG]
        else process.env[RETYPE_REVERT_FLAG] = savedRetype
        if (savedLossy === undefined) delete process.env[LOSSY_REVERT_FLAG]
        else process.env[LOSSY_REVERT_FLAG] = savedLossy
      }
    })

    test('RT-5b Tier-1 name revert held after its snapshot: a concurrent rename is not overwritten without CONFIG_DRIFT', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const id = fld('rt5b')
      await seedField(SHEET, id, 'RT5b New', 'string', {}, 21)
      const rev = await insertRev(id, { name: 'RT5b Old' }, { name: 'RT5b New' }, ['name'])
      const hold = holdAfter([FIELD_CONFIG_SNAPSHOT_SQL, FIELD_CONFIG_SNAPSHOT_LOCKED_SQL])
      let executing: ReturnType<typeof tracked> | null = null
      try {
        const pv = await preview(rev)
        expect(pv.status, JSON.stringify(pv.body).slice(0, 300)).toBe(200)
        const ex = tracked(() => execute(rev, pv.body.data.previewToken))
        executing = ex
        const pid = await hold.reached()
        const competitor = await competeWhileHeld(pid, RENAME_COMPETITOR_SQL, [id, 'RT5b C'])
        hold.release()
        const res = (await ex.promise) as { status: number; body: unknown }
        await competitor.finish()
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        expect((await fieldRow(id)).name, 'RT-5b: the concurrent rename is not silently overwritten by the revert').toBe('RT5b C')
        expect(competitor.outcome, 'RT-5b: the rename waited on the row lock the revert holds since its snapshot').toBe('parked')
      } finally {
        hold.restore()
        if (executing) await executing.promise.catch(() => {})
      }
    })

    test('RT-6 shared column drag: PATCH(B) finishes while PATCH(A) is held after its first read (no lock is taken there)', async () => {
      expect(isWriterFenceEnabled()).toBe(false)
      const a = fld('rt6a')
      const b = fld('rt6b')
      await seedField(SHEET_ORDER, a, 'RT6 A', 'string', {}, 0)
      await seedField(SHEET_ORDER, b, 'RT6 B', 'string', {}, 1)
      // Hold on either text: the naive fix (a locked first read) must still be held here, so that it reds this case.
      const hold = holdAfter([PATCH_FIELD_READ_SQL, PATCH_FIELD_LOCKED_REREAD_SQL])
      const patchingA = tracked(() => patchField(a, { order: 1 }))
      let patchingB: ReturnType<typeof tracked> | null = null
      try {
        const pid = await hold.reached()
        const pb = tracked(() => patchField(b, { order: 0 }))
        patchingB = pb
        const outcome = await raceParkedOrSettled({ blockerPid: pid, settled: pb.settled })
        expect(outcome, 'RT-6: PATCH(B) finished while PATCH(A) was held after its first read').toBe('settled')
        const resB = (await pb.promise) as { status: number; body: unknown }
        expect(resB.status, JSON.stringify(resB.body).slice(0, 300)).toBe(200)
        hold.release()
        const resA = (await patchingA.promise) as { status: number; body: unknown }
        expect(resA.status, JSON.stringify(resA.body).slice(0, 300)).toBe(200)
        expect({ a: (await fieldRow(a)).order, b: (await fieldRow(b)).order }).toEqual({ a: 1, b: 0 })
      } finally {
        hold.restore()
        await patchingA.promise.catch(() => {})
        if (patchingB) await patchingB.promise.catch(() => {})
      }
    })

    const perColumnCases: Array<{
      tag: string
      seed: { type: string; property: Record<string, unknown>; order: number }
      body: Record<string, unknown>
      competitor: { sql: string; params: (id: string) => unknown[] }
      expectAfter: (after: FieldRow) => void
      attempts: number
    }> = [
      {
        tag: 'property',
        seed: { type: 'string', property: {}, order: 30 },
        body: { name: 'RT8 property case renamed' },
        competitor: { sql: PROPERTY_COMPETITOR_SQL, params: (id) => [id] },
        expectAfter: (after) => {
          expect(after.property.t3Competitor, 'RT-8 property: the concurrent property change survives').toBe('b')
          expect(after.name).toBe('RT8 property case renamed')
        },
        attempts: 2,
      },
      {
        tag: 'type',
        seed: { type: 'string', property: {}, order: 31 },
        body: { name: 'RT8 type case renamed' },
        competitor: { sql: TYPE_COMPETITOR_SQL, params: (id) => [id] },
        expectAfter: (after) => {
          expect(after.type, 'RT-8 type: the concurrent retype survives').toBe('number')
          expect(after.name).toBe('RT8 type case renamed')
        },
        attempts: 2,
      },
      {
        tag: 'name',
        seed: { type: 'string', property: {}, order: 32 },
        body: { property: { t3Marker: 'rt8' } },
        competitor: { sql: RENAME_COMPETITOR_SQL, params: (id) => [id, 'RT8 competitor name'] },
        expectAfter: (after) => {
          expect(after.name, 'RT-8 name: the concurrent rename survives').toBe('RT8 competitor name')
          expect(after.property.t3Marker).toBe('rt8')
        },
        attempts: 2,
      },
      {
        tag: 'order',
        seed: { type: 'string', property: {}, order: 33 },
        body: { name: 'RT8 order case renamed' },
        competitor: { sql: ORDER_COMPETITOR_SQL, params: (id) => [id] },
        expectAfter: (after) => {
          expect(after.order, 'RT-8 order: the concurrent reorder survives').toBe(38)
          expect(after.name).toBe('RT8 order case renamed')
        },
        attempts: 1,
      },
    ]

    for (const c of perColumnCases) {
      test(`RT-8 ${c.tag}: PATCH held after its first read; a concurrent ${c.tag} change of the same row survives`, async () => {
        expect(isWriterFenceEnabled()).toBe(false)
        const id = fld(`rt8${c.tag}`)
        await seedField(SHEET, id, `RT8 ${c.tag} field`, c.seed.type, c.seed.property, c.seed.order)
        const hold = holdAfter(PATCH_FIELD_READ_SQL)
        const patching = tracked(() => patchField(id, c.body))
        try {
          const pid = await hold.reached()
          const competitor = await competeWhileHeld(pid, c.competitor.sql, c.competitor.params(id))
          expect(competitor.outcome, 'the PATCH holds no row lock at its first read').toBe('settled')
          await competitor.finish()
          hold.release()
          const res = (await patching.promise) as { status: number; body: unknown }
          expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
          c.expectAfter(await fieldRow(id))
          expect(hold.count(), `RT-8 ${c.tag}: the first read ran ${c.attempts}×`).toBe(c.attempts)
          if (c.tag === 'order') {
            const revisions = await patchRevisions(id)
            expect(revisions.map((r) => r.changed_keys), 'RT-8 order: one revision, and it does not claim the concurrent move').toEqual([['name']])
          }
        } finally {
          hold.restore()
          await patching.promise.catch(() => {})
        }
      })
    }
  })
}
