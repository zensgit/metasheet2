import { describe, expect, test } from 'vitest'

import {
  META_REVISION_RETENTION_DEFAULT_KEEP_N,
  META_REVISION_RETENTION_MIN_DAYS,
  META_REVISION_RETENTION_MIN_KEEP_N,
  resolveMetaRevisionRetentionConfig,
} from '../../src/multitable/meta-revision-retention'

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
})
