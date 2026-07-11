import { describe, expect, test, vi } from 'vitest'

import {
  META_REVISION_RETENTION_DEFAULT_KEEP_N,
  META_REVISION_RETENTION_MIN_DAYS,
  META_REVISION_RETENTION_MIN_KEEP_N,
  resolveMetaRevisionRetentionConfig,
  startMetaRevisionRetention,
  sweepFieldValueTombstoneRetention,
  sweepLinkTombstoneRetention,
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
