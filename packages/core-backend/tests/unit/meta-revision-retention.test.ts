import { describe, expect, test } from 'vitest'

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
})
