import { describe, expect, test, vi } from 'vitest'

import {
  META_REVISION_RETENTION_DEFAULT_KEEP_N,
  META_REVISION_RETENTION_MIN_DAYS,
  META_REVISION_RETENTION_MIN_KEEP_N,
  resolveMetaRevisionRetentionConfig,
  startMetaRevisionRetention,
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
  })
})
