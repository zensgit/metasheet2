/**
 * Pure helpers for the directory sync golden files: key-set allowlist, projection, aliasing
 * and golden comparison. No database or network access; unit-tested on their own.
 *
 * Comparison never prints values. A mismatch writes the actual object to
 * `test-results/directory-adapter-golden/<scenario>.actual.json` and fails with a fixed message
 * that only names the scenario.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type StatsTrigger = 'manual' | 'scheduler'

export interface GoldenAllowlist {
  _meta: { allowlistVersion: number; rule: string }
  statsKeys: string[]
  durationKeys: string[]
  diagnosticKeys: string[]
  previewKeys: string[]
}

export const KEY_SET_MISMATCH_MESSAGE =
  '键集合与白名单不符；纯新增键须同 PR 更新白名单与黄金'

export const DURATION_MARKER = '<duration>'

export const GOLDEN_BASE_MAIN_SHA = '7363f2d570707c075e6a5e22687613bf4d2eba4a'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const GOLDEN_DIR = path.join(HERE, 'golden')
export const GOLDEN_ACTUAL_DIR = path.resolve(HERE, '../../../test-results/directory-adapter-golden')

export function loadAllowlist(dir: string = GOLDEN_DIR): GoldenAllowlist {
  return JSON.parse(readFileSync(path.join(dir, 'stats-allowlist.json'), 'utf8')) as GoldenAllowlist
}

export function expectedStatsKeys(allowlist: GoldenAllowlist, trigger: StatsTrigger): string[] {
  const keys = [...allowlist.statsKeys, ...allowlist.durationKeys]
  if (trigger === 'manual') keys.push(...allowlist.diagnosticKeys)
  return keys.sort()
}

export function expectedPreviewKeys(allowlist: GoldenAllowlist): string[] {
  return [...allowlist.previewKeys].sort()
}

/** Throws a fixed message when the two key sets differ in either direction. */
export function assertKeySet(actualKeys: readonly string[], expectedKeys: readonly string[]): void {
  const actual = [...actualKeys].sort()
  const expected = [...expectedKeys].sort()
  const same = actual.length === expected.length && actual.every((key, index) => key === expected[index])
  if (!same) throw new Error(KEY_SET_MISMATCH_MESSAGE)
}

/**
 * Checks the key set of a run-stats object, then returns the allowlisted values in sorted key
 * order; duration keys must be non-negative numbers and are replaced by a marker.
 */
export function projectStats(
  stats: Record<string, unknown>,
  allowlist: GoldenAllowlist,
  trigger: StatsTrigger,
): Record<string, unknown> {
  assertKeySet(Object.keys(stats), expectedStatsKeys(allowlist, trigger))
  const durations = new Set(allowlist.durationKeys)
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(stats).sort()) {
    if (durations.has(key)) {
      const value = stats[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`duration key is not a non-negative number: ${key}`)
      }
      projected[key] = DURATION_MARKER
    } else {
      projected[key] = stats[key]
    }
  }
  return projected
}

/** Checks the key set of a preview response, then returns it in sorted key order. */
export function projectPreview(
  preview: Record<string, unknown>,
  allowlist: GoldenAllowlist,
): Record<string, unknown> {
  assertKeySet(Object.keys(preview), expectedPreviewKeys(allowlist))
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(preview).sort()) projected[key] = preview[key]
  return projected
}

/** Maps random identifiers to stable aliases, in the order they are first seen. */
export function createAliaser(prefix: string): (id: string | null | undefined, hint?: string) => string | null {
  const known = new Map<string, string>()
  return (id, hint) => {
    if (id === null || id === undefined) return null
    const existing = known.get(id)
    if (existing) return existing
    const alias = `${prefix}-${hint ?? known.size + 1}`
    known.set(id, alias)
    return alias
  }
}

/** Stable JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export interface CompareOptions {
  scenario: string
  actual: unknown
  goldenDir?: string
  actualDir?: string
}

/**
 * Writes the actual object next to the test results, then compares it with the committed golden
 * (everything except its `_meta`). Fails with a fixed message that never contains a value.
 */
export function compareWithGolden(options: CompareOptions): void {
  const goldenDir = options.goldenDir ?? GOLDEN_DIR
  const actualDir = options.actualDir ?? GOLDEN_ACTUAL_DIR
  mkdirSync(actualDir, { recursive: true })
  writeFileSync(path.join(actualDir, `${options.scenario}.actual.json`), canonicalJson(options.actual))
  const goldenPath = path.join(goldenDir, `${options.scenario}.json`)
  if (!existsSync(goldenPath)) throw new Error(`golden missing: ${options.scenario}`)
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, unknown>
  delete golden._meta
  if (canonicalJson(golden) !== canonicalJson(options.actual)) {
    throw new Error(`golden mismatch: ${options.scenario}`)
  }
}
