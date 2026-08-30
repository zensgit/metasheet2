/**
 * Pure L4 title-threshold policy kernel. Normalizes a complete title-threshold
 * snapshot and resolves the current title for a credit balance. Persistence,
 * routes, and feature flags stay out of this module so resolution stays
 * deterministic.
 */

const ELEARNING_TITLE_TEXT_MAX = 512
const ELEARNING_TITLE_ROW_KEYS = ['id', 'name', 'threshold'] as const

export type ElearningTitlePolicyErrorCode =
  | 'invalid_snapshot'
  | 'invalid_row'
  | 'duplicate_id'
  | 'duplicate_threshold'
  | 'invalid_balance'

export class ElearningTitlePolicyError extends Error {
  constructor(readonly code: ElearningTitlePolicyErrorCode) {
    super(code)
    this.name = 'ElearningTitlePolicyError'
  }
}

export interface ElearningTitleThresholdRow {
  id: string
  name: string
  threshold: number
}

declare const normalizedTitleSnapshot: unique symbol

export type ElearningTitleThresholdSnapshot = readonly ElearningTitleThresholdRow[] & {
  readonly [normalizedTitleSnapshot]: true
}

function fail(code: ElearningTitlePolicyErrorCode): never {
  throw new ElearningTitlePolicyError(code)
}

function assertSupportedText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) fail('invalid_row')
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_row')
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_row')
    }
  }
}

function requireTitleText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_row')
  const text = value.trim()
  if (text === '' || text.length > ELEARNING_TITLE_TEXT_MAX) fail('invalid_row')
  assertSupportedText(text)
  return text
}

function requireThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_row')
  }
  return value
}

function normalizeRow(value: unknown): ElearningTitleThresholdRow {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail('invalid_row')
    }
    const enumerableKeys = Reflect.ownKeys(value).filter((key) => (
      Object.prototype.propertyIsEnumerable.call(value, key)
    ))
    if (enumerableKeys.some((key) => typeof key !== 'string')) fail('invalid_row')
    const keys = (enumerableKeys as string[]).sort()
    if (
      keys.length !== ELEARNING_TITLE_ROW_KEYS.length
      || keys.some((key, index) => key !== ELEARNING_TITLE_ROW_KEYS[index])
    ) fail('invalid_row')
    const row = value as Record<string, unknown>
    return Object.freeze({
      id: requireTitleText(row.id),
      name: requireTitleText(row.name),
      threshold: requireThreshold(row.threshold),
    })
  } catch (error) {
    if (error instanceof ElearningTitlePolicyError) throw error
    fail('invalid_row')
  }
}

/**
 * Normalize a complete title-threshold snapshot into a frozen, threshold-ascending
 * canonical form. An empty snapshot means the organization has no configured titles.
 * Fail-closed: any invalid row rejects the whole snapshot.
 */
export function normalizeElearningTitleThresholdSnapshot(
  input: unknown,
): ElearningTitleThresholdSnapshot {
  try {
    if (!Array.isArray(input)) fail('invalid_snapshot')
    const rows = input.map(normalizeRow)

    const seenIds = new Set<string>()
    const seenThresholds = new Set<number>()
    for (const row of rows) {
      if (seenIds.has(row.id)) fail('duplicate_id')
      seenIds.add(row.id)
      if (seenThresholds.has(row.threshold)) fail('duplicate_threshold')
      seenThresholds.add(row.threshold)
    }

    return Object.freeze(
      [...rows].sort((left, right) => left.threshold - right.threshold),
    ) as ElearningTitleThresholdSnapshot
  } catch (error) {
    if (error instanceof ElearningTitlePolicyError) throw error
    fail('invalid_snapshot')
  }
}

/**
 * Resolve the highest threshold row at or below the balance; null when the
 * balance is below the first threshold. Negative balances are valid input.
 */
export function resolveElearningTitle(
  snapshot: ElearningTitleThresholdSnapshot,
  balance: unknown,
): ElearningTitleThresholdRow | null {
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance)) {
    fail('invalid_balance')
  }
  let matched: ElearningTitleThresholdRow | null = null
  for (const row of snapshot) {
    if (row.threshold > balance) break
    matched = row
  }
  if (matched === null) return null
  return { id: matched.id, name: matched.name, threshold: matched.threshold }
}
