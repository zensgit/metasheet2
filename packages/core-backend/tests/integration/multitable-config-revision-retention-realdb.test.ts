/**
 * T9 D4 — config-revision retention sweep (real DB). Mirrors the record-revision retention: same policy knobs, prunes
 * meta_config_revisions per (sheet_id, entity_type, entity_id), ALWAYS keeps the latest per entity (so current config
 * stays inspectable + revertible), disabled by default. Runs only with DATABASE_URL.
 */
import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { sweepConfigRevisionRetention, type MetaRevisionRetentionConfig } from '../../src/multitable/meta-revision-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const SHEET = `sheet_crr_${TS}`
const FIELD = `fld_crr_${TS}`
const FIELD2 = `fld_crr2_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
const sweep = (cfg: Partial<MetaRevisionRetentionConfig>) => sweepConfigRevisionRetention(
  (sql, params) => poolManager.get().query(sql, params ?? []),
  { enabled: true, policy: 'keep-last-n', keepN: 2, retentionDays: 365, batchSize: 5000, ...cfg },
)
// insert one revision `minutesAgo` old for an entity
const seed = (entityId: string, minutesAgo: number) => q(
  `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, changed_keys, created_at)
   VALUES ($1, 'field', $2, 'update', ARRAY['name']::text[], now() - ($3 || ' minutes')::interval)`,
  [SHEET, entityId, String(minutesAgo)],
)
const countFor = async (entityId: string) => Number(((await q('SELECT count(*)::int AS c FROM meta_config_revisions WHERE entity_id = $1', [entityId])).rows[0] as { c: number }).c)

describeIfDatabase('config-revision retention — T9 D4 (real DB)', () => {
  beforeEach(async () => { await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]) })
  afterAll(async () => { await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {}) })

  test('disabled (the default) is a no-op — deletes nothing', async () => {
    await seed(FIELD, 100); await seed(FIELD, 50); await seed(FIELD, 1)
    expect(await sweep({ enabled: false })).toBe(0)
    expect(await countFor(FIELD)).toBe(3)
  })

  test('keep-last-n prunes older revisions per entity, ALWAYS keeps the latest', async () => {
    // keepN is floored to MIN_KEEP_N=10 (the inherited safety floor), so an entity must exceed 10 to prune.
    for (let i = 13; i >= 1; i--) await seed(FIELD, i) // 13 revisions
    await seed(FIELD2, 3) // a second entity with one revision — must be untouched (its latest)
    const deleted = await sweep({ keepN: 2 }) // floored to 10
    expect(deleted).toBe(3) // FIELD: 13 → 10 kept; FIELD2: 1 (latest) kept
    expect(await countFor(FIELD)).toBe(10)
    expect(await countFor(FIELD2)).toBe(1) // latest-per-entity invariant
  })

  test('keep-days prunes old NON-latest rows but never the latest, even when the latest is old', async () => {
    await seed(FIELD, 60 * 24 * 400) // ~400 days old (the only/latest revision)
    await seed(FIELD2, 60 * 24 * 400); await seed(FIELD2, 60 * 24 * 10) // entity2: an old one + a 10-day one (latest)
    const deleted = await sweep({ policy: 'keep-days', retentionDays: 365 })
    expect(deleted).toBe(1) // only FIELD2's 400-day NON-latest pruned
    expect(await countFor(FIELD)).toBe(1) // latest kept even though 400 days old
    expect(await countFor(FIELD2)).toBe(1) // 10-day latest kept, 400-day non-latest pruned
  })

  test('batchSize bounds one pass', async () => {
    for (let i = 15; i >= 1; i--) await seed(FIELD, i) // 15 revisions; keepN floored to 10 → 5 prunable
    expect(await sweep({ keepN: 1, batchSize: 3 })).toBe(3) // one pass caps at 3 even though 5 are prunable
    expect(await countFor(FIELD)).toBe(12) // 15 - 3
  })
})
