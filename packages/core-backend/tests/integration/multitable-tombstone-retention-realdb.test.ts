/**
 * 4c-2 C6 — tombstone-table retention sweep, real DB. Design-lock
 * `docs/development/multitable-global-history-4c2-forward-tombstone-capture-design-lock-20260707.md`
 * §5 C6 / §6 G8: the two tombstone tables age under the SAME knob/schedule as
 * `meta_record_revisions`/`meta_config_revisions` (disabled by default), but ALWAYS keep-days
 * (age-based) regardless of the shared policy setting, with NO "keep the latest" floor — a tombstone
 * is an independent historical capture, not a superseded-by-newer-version log, so once it ages out R1
 * rehydration correctly (and safely) degrades to the honest no-tombstone path.
 *
 * G8: bounded batch (a backlog larger than one pass drains over multiple sweeps, never one giant
 * DELETE) + the keep-days floor (a mis-set tiny `..._DAYS` still floors at
 * META_REVISION_RETENTION_MIN_DAYS = 30) + disabled-by-default (no env → zero rows touched).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import { describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  META_REVISION_RETENTION_MIN_DAYS,
  resolveMetaRevisionRetentionConfig,
  sweepFieldValueTombstoneRetention,
  sweepLinkTombstoneRetention,
} from '../../src/multitable/meta-revision-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const SHEET = `sheet_tsret_${TS}`
const FIELD = `fld_tsret_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

async function insertValueTombstone(recordId: string, ageDays: number): Promise<void> {
  await q(
    `INSERT INTO meta_field_value_tombstones (id, sheet_id, field_id, record_id, value, reason, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, '"x"'::jsonb, 'field_delete', now() - ($4::int * interval '1 day'))`,
    [SHEET, FIELD, recordId, ageDays],
  )
}
async function insertLinkTombstone(recordId: string, foreignRecordId: string, ageDays: number): Promise<void> {
  await q(
    `INSERT INTO meta_link_tombstones (id, sheet_id, field_id, record_id, foreign_record_id, reason, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'field_delete', now() - ($5::int * interval '1 day'))`,
    [SHEET, FIELD, recordId, foreignRecordId, ageDays],
  )
}

describeIfDatabase('4c-2 C6 tombstone retention sweep (real DB)', () => {
  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G8 disabled by default: a sweep with no enable flag touches ZERO rows even with old tombstones present', async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
    await insertValueTombstone('r1', 400) // ancient — 400 days old
    const config = resolveMetaRevisionRetentionConfig({}) // no env at all → disabled
    const deleted = await sweepFieldValueTombstoneRetention(q, config)
    expect(deleted).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])).toBe(1)
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
  })

  test('G8 keep-days age-based purge: rows older than the window are pruned, rows within it survive', async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
    await insertValueTombstone('old1', 40) // older than a 30-day window
    await insertValueTombstone('old2', 35)
    await insertValueTombstone('fresh1', 5) // within the window — must survive
    const config = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_DAYS: '30',
      MULTITABLE_META_REVISION_RETENTION_BATCH: '100',
    })
    const deleted = await sweepFieldValueTombstoneRetention(q, config)
    expect(deleted).toBe(2)
    const remaining = (await q('SELECT record_id FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])).rows as Array<{ record_id: string }>
    expect(remaining.map((r) => r.record_id)).toEqual(['fresh1'])
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
  })

  test('G8 link tombstones: same age-based purge behavior, independent of the value-tombstone table', async () => {
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])
    await insertLinkTombstone('old1', 'foreign1', 40)
    await insertLinkTombstone('fresh1', 'foreign2', 5)
    const config = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_DAYS: '30',
      MULTITABLE_META_REVISION_RETENTION_BATCH: '100',
    })
    const deleted = await sweepLinkTombstoneRetention(q, config)
    expect(deleted).toBe(1)
    const remaining = (await q('SELECT record_id FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])).rows as Array<{ record_id: string }>
    expect(remaining.map((r) => r.record_id)).toEqual(['fresh1'])
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET])
  })

  test('G8 bounded batch: a backlog larger than one pass drains over MULTIPLE sweeps, never in one giant DELETE', async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
    const TOTAL_OLD = 5
    for (let i = 0; i < TOTAL_OLD; i++) await insertValueTombstone(`batch-old-${i}`, 400)
    const config = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_DAYS: '30',
      MULTITABLE_META_REVISION_RETENTION_BATCH: '2', // small batch — must NOT drain all 5 in one pass
    })
    const firstPass = await sweepFieldValueTombstoneRetention(q, config)
    expect(firstPass).toBe(2) // bounded — exactly batchSize, not all 5
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])).toBe(3)
    const secondPass = await sweepFieldValueTombstoneRetention(q, config)
    expect(secondPass).toBe(2)
    const thirdPass = await sweepFieldValueTombstoneRetention(q, config)
    expect(thirdPass).toBe(1) // drains the remainder
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])).toBe(0)
  })

  test('G8 keep-days floor: a mis-set tiny retention-days value is floored at 30, never guts recent tombstones', async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
    await insertValueTombstone('recent', 10) // 10 days old — younger than the 30-day FLOOR
    const config = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_DAYS: '1', // attempted 1-day window
    })
    expect(config.retentionDays).toBe(META_REVISION_RETENTION_MIN_DAYS) // floored to 30 by resolveMetaRevisionRetentionConfig
    const deleted = await sweepFieldValueTombstoneRetention(q, config)
    expect(deleted).toBe(0) // 10-day-old row survives the FLOORED 30-day window
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])).toBe(1)
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET])
  })
})
