/**
 * Pure L5 analytics small-sample suppression policy (ratified design contract
 * section 7.4). The system hard minimum group size is 5; an org threshold may
 * only raise it. Persistence, routes, and export stay out of this module; a
 * later export slice reuses this same policy.
 */

export const ELEARNING_ANALYTICS_MIN_GROUP_SIZE = 5 as const

export type ElearningAnalyticsSuppressionErrorCode =
  | 'invalid_group_size'
  | 'invalid_input'
  | 'invalid_metrics'
  | 'invalid_min_group_size'

export class ElearningAnalyticsSuppressionError extends Error {
  constructor(readonly code: ElearningAnalyticsSuppressionErrorCode) {
    super(code)
    this.name = 'ElearningAnalyticsSuppressionError'
  }
}

export interface ElearningAnalyticsSuppressedProjection {
  readonly suppressed: true
}

export interface ElearningAnalyticsVisibleProjection {
  readonly suppressed: false
  readonly groupSize: number
  readonly metrics: Readonly<Record<string, number>>
}

export type ElearningAnalyticsSuppressionProjection =
  | ElearningAnalyticsSuppressedProjection
  | ElearningAnalyticsVisibleProjection

function fail(code: ElearningAnalyticsSuppressionErrorCode): never {
  throw new ElearningAnalyticsSuppressionError(code)
}

/** Snapshot the own enumerable string-key set exactly once; proxies stay hostile. */
function readEnumerableStringKeys(
  value: object,
  code: ElearningAnalyticsSuppressionErrorCode,
): string[] {
  let ownKeys: PropertyKey[]
  try {
    ownKeys = Reflect.ownKeys(value).filter((key) => (
      Object.prototype.propertyIsEnumerable.call(value, key)
    ))
  } catch {
    fail(code)
  }
  if (ownKeys.some((key) => typeof key !== 'string')) fail(code)
  return ownKeys as string[]
}

function readField(input: object, key: string): unknown {
  try {
    return (input as Record<string, unknown>)[key]
  } catch {
    fail('invalid_input')
  }
}

function requireGroupSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_group_size')
  }
  return value
}

function requireMinGroupSize(value: unknown): number {
  if (value === undefined || value === null) return ELEARNING_ANALYTICS_MIN_GROUP_SIZE
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < ELEARNING_ANALYTICS_MIN_GROUP_SIZE
  ) {
    fail('invalid_min_group_size')
  }
  return value
}

/** Clone a nonempty closed metrics map, reading each metric value at most once. */
function readMetrics(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_metrics')
  }
  const keys = readEnumerableStringKeys(value, 'invalid_metrics')
  if (keys.length === 0) fail('invalid_metrics')
  const metrics: Record<string, number> = {}
  for (const key of keys) {
    let metric: unknown
    try {
      metric = (value as Record<string, unknown>)[key]
    } catch {
      fail('invalid_metrics')
    }
    if (typeof metric !== 'number' || !Number.isFinite(metric)) fail('invalid_metrics')
    Object.defineProperty(metrics, key, {
      configurable: true,
      enumerable: true,
      value: metric,
      writable: true,
    })
  }
  return metrics
}

export function applyElearningAnalyticsSuppression(
  input: unknown,
): ElearningAnalyticsSuppressionProjection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  const keys = readEnumerableStringKeys(input, 'invalid_input')
  if (
    keys.some((key) => key !== 'groupSize' && key !== 'metrics' && key !== 'minGroupSize')
    || !keys.includes('groupSize')
    || !keys.includes('metrics')
  ) {
    fail('invalid_input')
  }
  const groupSize = requireGroupSize(readField(input, 'groupSize'))
  const minGroupSize = requireMinGroupSize(
    keys.includes('minGroupSize') ? readField(input, 'minGroupSize') : undefined,
  )
  const metrics = readMetrics(readField(input, 'metrics'))
  if (groupSize < minGroupSize) {
    return Object.freeze({ suppressed: true as const })
  }
  return Object.freeze({
    suppressed: false as const,
    groupSize,
    metrics: Object.freeze(metrics),
  })
}
