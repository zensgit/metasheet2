import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DURATION_MARKER,
  KEY_SET_MISMATCH_MESSAGE,
  assertKeySet,
  canonicalJson,
  compareWithGolden,
  createAliaser,
  expectedPreviewKeys,
  expectedStatsKeys,
  loadAllowlist,
  projectPreview,
  projectStats,
} from '../fixtures/directory/golden-harness'

const allowlist = loadAllowlist()

function statsFor(trigger: 'manual' | 'scheduler'): Record<string, unknown> {
  const stats: Record<string, unknown> = {}
  for (const key of expectedStatsKeys(allowlist, trigger)) stats[key] = 0
  return stats
}

describe('directory golden harness: key-set allowlist', () => {
  it('lists 55 keys for a scheduler run and 66 for a manual run', () => {
    expect(expectedStatsKeys(allowlist, 'scheduler')).toHaveLength(55)
    expect(expectedStatsKeys(allowlist, 'manual')).toHaveLength(66)
    expect(expectedPreviewKeys(allowlist)).toHaveLength(14)
  })

  it('accepts exactly the allowlisted stats keys', () => {
    expect(() => projectStats(statsFor('scheduler'), allowlist, 'scheduler')).not.toThrow()
    expect(() => projectStats(statsFor('manual'), allowlist, 'manual')).not.toThrow()
  })

  it('rejects an allowlisted key that is missing', () => {
    const stats = statsFor('scheduler')
    delete stats.linkedCount
    expect(() => projectStats(stats, allowlist, 'scheduler')).toThrow(KEY_SET_MISMATCH_MESSAGE)
  })

  it('rejects a key that is not allowlisted', () => {
    const stats = statsFor('scheduler')
    stats.someAdditionalCount = 1
    expect(() => projectStats(stats, allowlist, 'scheduler')).toThrow(KEY_SET_MISMATCH_MESSAGE)
  })

  it('treats the diagnostic keys as manual-only in both directions', () => {
    expect(() => projectStats(statsFor('manual'), allowlist, 'scheduler')).toThrow(KEY_SET_MISMATCH_MESSAGE)
    expect(() => projectStats(statsFor('scheduler'), allowlist, 'manual')).toThrow(KEY_SET_MISMATCH_MESSAGE)
  })

  it('applies the same check to the preview keys', () => {
    const preview: Record<string, unknown> = {}
    for (const key of expectedPreviewKeys(allowlist)) preview[key] = 0
    expect(() => projectPreview(preview, allowlist)).not.toThrow()
    delete preview.departmentsSeen
    expect(() => projectPreview(preview, allowlist)).toThrow(KEY_SET_MISMATCH_MESSAGE)
    preview.departmentsSeen = 0
    preview.someAdditionalCount = 1
    expect(() => projectPreview(preview, allowlist)).toThrow(KEY_SET_MISMATCH_MESSAGE)
  })

  it('keeps the key-set failure free of values', () => {
    const stats = statsFor('scheduler')
    stats.someAdditionalCount = 'sensitive-looking-value'
    let message = ''
    try {
      projectStats(stats, allowlist, 'scheduler')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe(KEY_SET_MISMATCH_MESSAGE)
    expect(message).not.toContain('sensitive-looking-value')
  })

  it('replaces duration values by a marker and requires them to be non-negative numbers', () => {
    const stats = statsFor('scheduler')
    for (const key of allowlist.durationKeys) stats[key] = 12
    const projected = projectStats(stats, allowlist, 'scheduler')
    for (const key of allowlist.durationKeys) expect(projected[key]).toBe(DURATION_MARKER)
    stats.durationMs = -1
    expect(() => projectStats(stats, allowlist, 'scheduler')).toThrow()
    stats.durationMs = 'slow'
    expect(() => projectStats(stats, allowlist, 'scheduler')).toThrow()
  })

  it('assertKeySet compares as sets, in either argument order', () => {
    expect(() => assertKeySet(['b', 'a'], ['a', 'b'])).not.toThrow()
    expect(() => assertKeySet(['a'], ['a', 'b'])).toThrow(KEY_SET_MISMATCH_MESSAGE)
    expect(() => assertKeySet(['a', 'b'], ['a'])).toThrow(KEY_SET_MISMATCH_MESSAGE)
  })
})

describe('directory golden harness: comparison', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  function scratch(): { goldenDir: string; actualDir: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'golden-harness-'))
    dirs.push(root)
    return { goldenDir: path.join(root, 'golden'), actualDir: path.join(root, 'actual') }
  }

  it('fails with a fixed message when the golden is missing and still writes the actual object', () => {
    const { goldenDir, actualDir } = scratch()
    expect(() => compareWithGolden({ scenario: 'x', actual: { a: 'secret-ish' }, goldenDir, actualDir }))
      .toThrow('golden missing: x')
    expect(JSON.parse(readFileSync(path.join(actualDir, 'x.actual.json'), 'utf8'))).toEqual({ a: 'secret-ish' })
  })

  it('passes on an equal object regardless of key order and ignores the golden _meta', () => {
    const { goldenDir, actualDir } = scratch()
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(path.join(goldenDir, 'x.json'), JSON.stringify({ _meta: { m: 1 }, b: [1, 2], a: { d: 1, c: 2 } }))
    expect(() => compareWithGolden({ scenario: 'x', actual: { a: { c: 2, d: 1 }, b: [1, 2] }, goldenDir, actualDir }))
      .not.toThrow()
  })

  it('fails with a message that names the scenario and carries no value on a difference', () => {
    const { goldenDir, actualDir } = scratch()
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(path.join(goldenDir, 'x.json'), JSON.stringify({ a: 'expected-value' }))
    let message = ''
    try {
      compareWithGolden({ scenario: 'x', actual: { a: 'actual-value' }, goldenDir, actualDir })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('golden mismatch: x')
    expect(existsSync(path.join(actualDir, 'x.actual.json'))).toBe(true)
  })

  it('treats array order as significant', () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })
})

describe('directory golden harness: aliasing', () => {
  it('maps each identifier to one stable alias in order of first sight', () => {
    const alias = createAliaser('acct')
    expect(alias('u-1')).toBe('acct-1')
    expect(alias('u-2')).toBe('acct-2')
    expect(alias('u-1')).toBe('acct-1')
    expect(alias(null)).toBeNull()
    expect(alias('u-3', 'x')).toBe('acct-x')
  })
})
