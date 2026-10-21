import { describe, expect, test, vi } from 'vitest'

import {
  META_REVISION_RETENTION_DEFAULT_KEEP_N,
  META_REVISION_RETENTION_MIN_DAYS,
  META_REVISION_RETENTION_MIN_KEEP_N,
  resolveMetaRevisionRetentionConfig,
  startMetaRevisionRetention,
  sweepConfigRevisionRetention,
  sweepFieldValueTombstoneRetention,
  sweepLinkTombstoneRetention,
  sweepMetaRevisionRetention,
} from '../../src/multitable/meta-revision-retention'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never

describe('meta-revision retention config', () => {
  test('disabled by default (no env) — preserves the restore guarantee until opt-in', () => {
    const cfg = resolveMetaRevisionRetentionConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.policy).toBe('keep-last-n')
    expect(cfg.keepN).toBe(META_REVISION_RETENTION_DEFAULT_KEEP_N)
  })

  test('enabled only when explicitly "1"', () => {
    expect(resolveMetaRevisionRetentionConfig({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '0' }).enabled).toBe(false)
    expect(resolveMetaRevisionRetentionConfig({ MULTITABLE_META_REVISION_RETENTION_ENABLED: 'true' }).enabled).toBe(false)
    expect(resolveMetaRevisionRetentionConfig({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' }).enabled).toBe(true)
  })

  test('keep-last-n value is floored so a mis-set cannot gut history', () => {
    const cfg = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_KEEP_N: '1',
    })
    expect(cfg.keepN).toBe(META_REVISION_RETENTION_MIN_KEEP_N) // floored, not 1
  })

  test('keep-days policy + floored window', () => {
    const cfg = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_POLICY: 'keep-days',
      MULTITABLE_META_REVISION_RETENTION_DAYS: '2',
    })
    expect(cfg.policy).toBe('keep-days')
    expect(cfg.retentionDays).toBe(META_REVISION_RETENTION_MIN_DAYS) // floored
  })

  test('explicit valid values pass through', () => {
    const cfg = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_KEEP_N: '50',
    })
    expect(cfg.keepN).toBe(50)
  })

  test('scheduler: disabled (default) is a no-op — returns a stop fn, never touches the DB', () => {
    let called = 0
    const queryFn = (async () => { called++; return { rows: [], rowCount: 0 } }) as never
    const stop = startMetaRevisionRetention({ env: {}, query: queryFn, logger: silentLogger, intervalMs: 60_000 })
    expect(typeof stop).toBe('function')
    expect(called).toBe(0)
    stop()
  })

  test('scheduler: enabled returns a working stop fn (sweep runs on the interval, not synchronously)', () => {
    const queryFn = (async () => ({ rows: [], rowCount: 0 })) as never
    const stop = startMetaRevisionRetention({
      env: { MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' },
      query: queryFn,
      logger: silentLogger,
      intervalMs: 3_600_000,
    })
    expect(typeof stop).toBe('function')
    stop() // clears the interval without error
  })

  test('scheduler: enabled sweeps BOTH record and config revisions on a tick (T9 D4 — one knob ages both)', async () => {
    const seenSql: string[] = []
    const queryFn = (async (sql: string) => { seenSql.push(String(sql)); return { rows: [], rowCount: 0 } }) as never
    vi.useFakeTimers()
    try {
      const stop = startMetaRevisionRetention({
        env: { MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' },
        query: queryFn,
        logger: silentLogger,
        intervalMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(1_000) // fire one tick + flush the async sweep chains
      stop()
    } finally {
      vi.useRealTimers()
    }
    const joined = seenSql.join('\n')
    // record-revision sweep ran (already wired before this fix)…
    expect(joined).toContain('meta_record_revisions')
    // …AND the config-revision sweep ran — the wiring gap this fix closes (config revisions
    // were never pruned by the scheduler even with retention enabled, despite #3168's
    // "same policy as records" / one-knob-ages-both intent).
    expect(joined).toContain('meta_config_revisions')
    // 4c-2 C6: the two tombstone tables age under the SAME tick/knob.
    expect(joined).toContain('meta_field_value_tombstones')
    expect(joined).toContain('meta_link_tombstones')
  })

  // 4c-2 C6 — tombstone retention (keep-days ONLY; no keep-last-n concept, no never-delete-latest floor).
  test('tombstone sweeps are no-ops when retention is disabled (default)', async () => {
    let called = 0
    const queryFn = (async () => { called++; return { rows: [], rowCount: 0 } }) as never
    const config = resolveMetaRevisionRetentionConfig({})
    expect(await sweepFieldValueTombstoneRetention(queryFn, config)).toBe(0)
    expect(await sweepLinkTombstoneRetention(queryFn, config)).toBe(0)
    expect(called).toBe(0) // disabled → never even queries
  })

  test('tombstone sweeps ALWAYS use keep-days age-based pruning, even when the shared policy knob is keep-last-n', async () => {
    const seenSql: string[] = []
    const queryFn = (async (sql: string) => { seenSql.push(String(sql)); return { rows: [], rowCount: 0 } }) as never
    const config = resolveMetaRevisionRetentionConfig({
      MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
      MULTITABLE_META_REVISION_RETENTION_POLICY: 'keep-last-n', // deliberately NOT keep-days
    })
    await sweepFieldValueTombstoneRetention(queryFn, config)
    await sweepLinkTombstoneRetention(queryFn, config)
    // both statements are age-based (interval arithmetic), never a row_number()/rn>N partition query —
    // "keep-last-n has no meaning for a tombstone" (design-lock C6).
    for (const sql of seenSql) {
      expect(sql).toContain("interval '1 day'")
      expect(sql).not.toContain('row_number()')
    }
  })

  test('tombstone sweep degrades to 0 (never throws) when the table predates the migration', async () => {
    const queryFn = (async () => {
      throw Object.assign(new Error('relation "meta_field_value_tombstones" does not exist'), { code: '42P01' })
    }) as never
    const config = resolveMetaRevisionRetentionConfig({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' })
    await expect(sweepFieldValueTombstoneRetention(queryFn, config)).resolves.toBe(0)
  })
})

describe('D2d1 operation_id ordinary-retention exclusion', () => {
  const enabled = resolveMetaRevisionRetentionConfig({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' })
  const enabledDays = resolveMetaRevisionRetentionConfig({
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
    MULTITABLE_META_REVISION_RETENTION_POLICY: 'keep-days',
  })

  function captureSql() {
    const seenSql: string[] = []
    const queryFn = (async (sql: string) => {
      seenSql.push(String(sql))
      return { rows: [], rowCount: 0 }
    }) as never
    return { seenSql, queryFn }
  }

  test('record keep-last-n candidates require operation_id IS NULL and keep tagged rows in the ranking window', async () => {
    // Deliberate minimal semantics: tagged rows occupy recency ranks; only untagged
    // rows outside keep-N are deleted. Whole-operation prune of tagged evidence is D2d2.
    const { seenSql, queryFn } = captureSql()
    await sweepMetaRevisionRetention(queryFn, enabled)
    expect(seenSql).toHaveLength(1)
    const [windowSql, candidateSql] = String(seenSql[0]).split(') ranked')
    expect(windowSql).toContain('row_number()')
    expect(windowSql).toContain('FROM meta_record_revisions')
    expect(windowSql).not.toContain('operation_id IS NULL')
    expect(candidateSql).toContain('ranked.operation_id IS NULL')
  })

  test('record keep-days candidates require operation_id IS NULL after ranking, not inside the window', async () => {
    const { seenSql, queryFn } = captureSql()
    await sweepMetaRevisionRetention(queryFn, enabledDays)
    expect(seenSql).toHaveLength(1)
    const [windowSql, candidateSql] = String(seenSql[0]).split(') ranked')
    expect(windowSql).toContain('row_number()')
    expect(windowSql).not.toContain('operation_id IS NULL')
    expect(candidateSql).toContain('ranked.operation_id IS NULL')
  })

  test('config keep-last-n and keep-days candidates require operation_id IS NULL after ranking', async () => {
    const lastN = captureSql()
    await sweepConfigRevisionRetention(lastN.queryFn, enabled)
    expect(lastN.seenSql[0]).toMatch(/FROM meta_config_revisions\s*\) ranked/)
    expect(lastN.seenSql[0]).toContain('ranked.operation_id IS NULL')
    expect(lastN.seenSql[0]).not.toMatch(/FROM meta_config_revisions\s+WHERE operation_id IS NULL/)

    const days = captureSql()
    await sweepConfigRevisionRetention(days.queryFn, enabledDays)
    expect(days.seenSql[0]).toMatch(/FROM meta_config_revisions\s*\) ranked/)
    expect(days.seenSql[0]).toContain('ranked.operation_id IS NULL')
  })

  test('record/config sweeps return janitor 0 when the missing column is identified as operation_id', async () => {
    const queryFn = (async () => {
      throw Object.assign(new Error('column "operation_id" does not exist'), { code: '42703' })
    }) as never
    await expect(sweepMetaRevisionRetention(queryFn, enabled)).resolves.toBe(0)
    await expect(sweepConfigRevisionRetention(queryFn, enabled)).resolves.toBe(0)
  })

  test('tombstone grouped deletion is eligible only when every row in the exact anchor group is untagged', async () => {
    const { seenSql, queryFn } = captureSql()
    await sweepFieldValueTombstoneRetention(queryFn, enabled)
    const grouped = seenSql.find((sql) => sql.includes('GROUP BY') && sql.includes('config_revision_id'))
    const loose = seenSql.find((sql) => sql.includes('config_revision_id IS NULL'))
    expect(grouped).toContain('HAVING bool_and(operation_id IS NULL)')
    expect(grouped?.replace(/\s+/g, ' ')).toContain(
      'DELETE FROM meta_field_value_tombstones WHERE operation_id IS NULL AND config_revision_id IN',
    )
    expect(loose).toContain('operation_id IS NULL')
    for (const sql of seenSql) {
      expect(sql.startsWith('DELETE')).toBe(true)
      expect(sql).toContain('operation_id IS NULL')
    }
  })

  test('link-tombstone 42703 delete_revision_id fallback still requires an untagged exact-anchor group', async () => {
    const seenSql: string[] = []
    const queryFn = (async (sql: string) => {
      seenSql.push(String(sql))
      if (sql.includes('delete_revision_id')) {
        throw Object.assign(new Error('column tr.delete_revision_id does not exist'), { code: '42703' })
      }
      return { rows: [], rowCount: 0 }
    }) as never
    await sweepLinkTombstoneRetention(queryFn, enabled)
    const fallback = seenSql.find((sql) => sql.includes('GROUP BY') && !sql.includes('delete_revision_id'))
    const loose = seenSql.find((sql) => sql.includes('source_revision_id IS NULL'))
    expect(fallback).toContain('HAVING bool_and(operation_id IS NULL)')
    expect(fallback?.replace(/\s+/g, ' ')).toContain(
      'DELETE FROM meta_link_tombstones WHERE operation_id IS NULL AND source_revision_id IN',
    )
    expect(loose).toContain('operation_id IS NULL')
    expect(seenSql.some((sql) => sql.startsWith('DELETE') && !sql.includes('operation_id IS NULL'))).toBe(false)
  })

  test('tombstone sweep returns janitor 0 for a missing operation_id column and never issues a guardless DELETE', async () => {
    const seenSql: string[] = []
    const queryFn = (async (sql: string) => {
      seenSql.push(String(sql))
      throw Object.assign(new Error('column "operation_id" does not exist'), { code: '42703' })
    }) as never
    await expect(sweepFieldValueTombstoneRetention(queryFn, enabled)).resolves.toBe(0)
    await expect(sweepLinkTombstoneRetention(queryFn, enabled)).resolves.toBe(0)
    expect(seenSql.length).toBeGreaterThan(0)
    expect(seenSql.some((sql) => sql.startsWith('DELETE') && !sql.includes('operation_id IS NULL'))).toBe(false)
  })
})
