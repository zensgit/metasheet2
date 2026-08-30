import { describe, expect, it } from 'vitest'
import {
  applyElearningAnalyticsSuppression,
  ELEARNING_ANALYTICS_MIN_GROUP_SIZE,
  ElearningAnalyticsSuppressionError,
  type ElearningAnalyticsSuppressedProjection,
  type ElearningAnalyticsVisibleProjection,
} from '../../src/services/elearning-analytics-suppression'

const baseMetrics = () => ({
  completionRate: 0.42,
  learnerCount: 7,
})

const baseInput = () => ({
  groupSize: 7,
  metrics: baseMetrics(),
})

function expectVisible(input: unknown): ElearningAnalyticsVisibleProjection {
  const result = applyElearningAnalyticsSuppression(input)
  if (result.suppressed) throw new Error('expected visible projection')
  return result
}

function expectSuppressed(input: unknown): ElearningAnalyticsSuppressedProjection {
  const result = applyElearningAnalyticsSuppression(input)
  if (!result.suppressed) throw new Error('expected suppressed projection')
  return result
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningAnalyticsSuppressionError)
    const policyError = error as ElearningAnalyticsSuppressionError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.name).toBe('ElearningAnalyticsSuppressionError')
    expect(policyError.cause).toBeUndefined()
    const surface = `${policyError.message}\n${policyError.stack ?? ''}`
    expect(surface).not.toContain('secret')
  }
}

describe('elearning analytics suppression policy', () => {
  it('exposes the system hard minimum group size of exactly 5', () => {
    expect(ELEARNING_ANALYTICS_MIN_GROUP_SIZE).toBe(5)
  })

  it('returns a frozen exact-shape visible projection with cloned frozen metrics', () => {
    const input = baseInput()
    const result = expectVisible(input)
    expect(Object.keys(result).sort()).toEqual(['groupSize', 'metrics', 'suppressed'])
    expect(result).toMatchObject({
      suppressed: false,
      groupSize: 7,
      metrics: { completionRate: 0.42, learnerCount: 7 },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.metrics)).toBe(true)
    expect(result.metrics).not.toBe(input.metrics)
    expect(() => {
      ;(result as { groupSize: number }).groupSize = 99
    }).toThrow(TypeError)
    expect(() => {
      ;(result.metrics as Record<string, number>).learnerCount = 99
    }).toThrow(TypeError)
    expect(result.groupSize).toBe(7)
    expect(result.metrics.learnerCount).toBe(7)
  })

  it('returns a frozen exact-shape suppressed projection with no numeric values', () => {
    const result = expectSuppressed({ groupSize: 4, metrics: baseMetrics() })
    expect(Object.keys(result)).toEqual(['suppressed'])
    expect(result.suppressed).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toHaveProperty('groupSize')
    expect(result).not.toHaveProperty('metrics')
    expect(result).not.toHaveProperty('threshold')
    const json = JSON.stringify(result)
    expect(json).toBe('{"suppressed":true}')
    expect(json).not.toMatch(/[0-9]/)
    expect(json).not.toContain('0.42')
    expect(json).not.toContain('learnerCount')
  })

  it('suppresses below the default threshold and stays visible at exactly 5', () => {
    expectSuppressed({ groupSize: 4, metrics: baseMetrics() })
    expectSuppressed({ groupSize: 1, metrics: baseMetrics() })
    expectSuppressed({ groupSize: 0, metrics: baseMetrics() })
    const atThreshold = expectVisible({ groupSize: 5, metrics: baseMetrics() })
    expect(atThreshold.groupSize).toBe(5)
    expectVisible({ groupSize: 6, metrics: baseMetrics() })
  })

  it('defaults a missing or null minGroupSize to 5', () => {
    expectSuppressed({ groupSize: 4, metrics: baseMetrics(), minGroupSize: null })
    const visible = expectVisible({ groupSize: 5, metrics: baseMetrics(), minGroupSize: null })
    expect(visible.groupSize).toBe(5)
    expectVisible({ groupSize: 5, metrics: baseMetrics(), minGroupSize: undefined })
    expectVisible({ groupSize: 5, metrics: baseMetrics() })
  })

  it('lets an org threshold only raise the bar above 5', () => {
    expectSuppressed({ groupSize: 9, metrics: baseMetrics(), minGroupSize: 10 })
    const atThreshold = expectVisible({ groupSize: 10, metrics: baseMetrics(), minGroupSize: 10 })
    expect(atThreshold.groupSize).toBe(10)
    expectVisible({ groupSize: 5, metrics: baseMetrics(), minGroupSize: 5 })
    expectSuppressed({ groupSize: 5, metrics: baseMetrics(), minGroupSize: 6 })
    const huge = expectVisible({
      groupSize: Number.MAX_SAFE_INTEGER,
      metrics: baseMetrics(),
      minGroupSize: Number.MAX_SAFE_INTEGER,
    })
    expect(huge.groupSize).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects an org threshold below 5 or otherwise invalid', () => {
    for (const minGroupSize of [
      4,
      3,
      0,
      -1,
      4.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '5',
      'secret-threshold',
      true,
      {},
      [],
    ]) {
      expectCode(
        () => applyElearningAnalyticsSuppression({ groupSize: 9, metrics: baseMetrics(), minGroupSize }),
        'invalid_min_group_size',
      )
    }
  })

  it('rejects a negative, fractional, unsafe, or non-number groupSize', () => {
    for (const groupSize of [
      -1,
      4.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '7',
      'secret-group-size',
      null,
      true,
      {},
      [],
    ]) {
      expectCode(
        () => applyElearningAnalyticsSuppression({ groupSize, metrics: baseMetrics() }),
        'invalid_group_size',
      )
    }
  })

  it('keeps count, rate, and distribution-bucket aggregates visible as exact clones', () => {
    const metrics = {
      learnerCount: 12,
      completionRate: 0.75,
      passRate: 0.5,
      'bucket:0-59': 1,
      'bucket:60-79': 3,
      'bucket:80-100': 8,
    }
    const result = expectVisible({ groupSize: 12, metrics })
    expect(result.metrics).toEqual(metrics)
    expect(result.metrics).not.toBe(metrics)
  })

  it('suppresses count, rate, and distribution rows below threshold with no fake zero', () => {
    const result = expectSuppressed({
      groupSize: 3,
      metrics: { learnerCount: 3, completionRate: 0, 'bucket:0-59': 3 },
    })
    expect(Object.keys(result)).toEqual(['suppressed'])
    expect(JSON.stringify(result)).toBe('{"suppressed":true}')
  })

  it('accepts negative finite metric values', () => {
    const result = expectVisible({ groupSize: 5, metrics: { scoreDelta: -3.5, count: 2 } })
    expect(result.metrics.scoreDelta).toBe(-3.5)
  })

  it('preserves prototype-named metrics as frozen own data properties', () => {
    const metrics = { constructor: 2 } as Record<string, number>
    Object.defineProperty(metrics, '__proto__', {
      enumerable: true,
      value: 1,
    })

    const result = expectVisible({ groupSize: 5, metrics })
    expect(Object.keys(result.metrics).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.prototype.hasOwnProperty.call(result.metrics, '__proto__')).toBe(true)
    expect(result.metrics.__proto__).toBe(1)
    expect(result.metrics.constructor).toBe(2)
    expect(Object.isFrozen(result.metrics)).toBe(true)
  })

  it('rejects empty, non-object, or non-finite metrics maps', () => {
    for (const metrics of [
      null,
      undefined,
      'secret-metrics',
      5,
      true,
      [],
      [1],
      {},
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: Number.NEGATIVE_INFINITY },
      { value: '7' },
      { value: 'secret-metric-value' },
      { value: null },
      { value: true },
      { value: {} },
      { value: [] },
      { value: undefined },
    ]) {
      expectCode(
        () => applyElearningAnalyticsSuppression({ groupSize: 7, metrics }),
        'invalid_metrics',
      )
    }
    expectCode(
      () => applyElearningAnalyticsSuppression({
        groupSize: 7,
        metrics: { [Symbol('secret-symbol')]: 1 },
      }),
      'invalid_metrics',
    )
  })

  it('rejects extra, missing, or non-string own input keys', () => {
    expectCode(
      () => applyElearningAnalyticsSuppression({ ...baseInput(), extra: 'secret-extra' }),
      'invalid_input',
    )
    expectCode(
      () => applyElearningAnalyticsSuppression({ metrics: baseMetrics() }),
      'invalid_input',
    )
    expectCode(
      () => applyElearningAnalyticsSuppression({ groupSize: 7 }),
      'invalid_input',
    )
    expectCode(
      () => applyElearningAnalyticsSuppression({
        ...baseInput(),
        [Symbol('secret-symbol')]: 'secret-symbol-value',
      }),
      'invalid_input',
    )
    expectCode(() => applyElearningAnalyticsSuppression({}), 'invalid_input')
  })

  it('rejects non-object, array, and null input', () => {
    for (const input of [null, undefined, 'secret-input', 5, true, [baseInput()]]) {
      expectCode(() => applyElearningAnalyticsSuppression(input), 'invalid_input')
    }
  })

  it('does not mutate or retain the caller objects', () => {
    const input = baseInput()
    const snapshot = { groupSize: input.groupSize, metrics: { ...input.metrics } }
    const result = expectVisible(input)
    expect(input.groupSize).toBe(snapshot.groupSize)
    expect(input.metrics).toEqual(snapshot.metrics)
    input.metrics.learnerCount = 99
    input.metrics.completionRate = 1
    input.groupSize = 1
    expect(result.groupSize).toBe(7)
    expect(result.metrics).toEqual(snapshot.metrics)
  })

  it('fails closed on hostile getters and proxies', () => {
    const throwingGroupSize = baseInput()
    Object.defineProperty(throwingGroupSize, 'groupSize', {
      enumerable: true,
      get() { throw new Error('secret-getter-boom') },
    })
    expectCode(() => applyElearningAnalyticsSuppression(throwingGroupSize), 'invalid_input')

    const throwingMetrics = baseInput()
    Object.defineProperty(throwingMetrics, 'metrics', {
      enumerable: true,
      get() { throw new Error('secret-getter-boom') },
    })
    expectCode(() => applyElearningAnalyticsSuppression(throwingMetrics), 'invalid_input')

    const throwingThreshold = { ...baseInput(), minGroupSize: 5 }
    Object.defineProperty(throwingThreshold, 'minGroupSize', {
      enumerable: true,
      get() { throw new Error('secret-getter-boom') },
    })
    expectCode(() => applyElearningAnalyticsSuppression(throwingThreshold), 'invalid_input')

    expectCode(() => applyElearningAnalyticsSuppression(new Proxy(baseInput(), {
      ownKeys() { throw new Error('secret-ownkeys-boom') },
    })), 'invalid_input')
    expectCode(() => applyElearningAnalyticsSuppression(new Proxy(baseInput(), {
      get() { throw new Error('secret-get-boom') },
    })), 'invalid_input')

    const hostileMetrics = { value: 1 }
    Object.defineProperty(hostileMetrics, 'value', {
      enumerable: true,
      get() { throw new Error('secret-metric-getter-boom') },
    })
    expectCode(
      () => applyElearningAnalyticsSuppression({ groupSize: 7, metrics: hostileMetrics }),
      'invalid_metrics',
    )
    expectCode(
      () => applyElearningAnalyticsSuppression({
        groupSize: 7,
        metrics: new Proxy({ value: 1 }, {
          ownKeys() { throw new Error('secret-metrics-ownkeys-boom') },
        }),
      }),
      'invalid_metrics',
    )
  })

  it('observes the input own-key set exactly once', () => {
    let ownKeysCalls = 0
    const input = new Proxy(baseInput(), {
      ownKeys(target) {
        ownKeysCalls += 1
        return Reflect.ownKeys(target)
      },
    })
    expect(expectVisible(input).groupSize).toBe(7)
    expect(ownKeysCalls).toBe(1)

    let metricsOwnKeysCalls = 0
    const metricsProxy = new Proxy(baseMetrics(), {
      ownKeys(target) {
        metricsOwnKeysCalls += 1
        return Reflect.ownKeys(target)
      },
    })
    expect(expectVisible({ groupSize: 7, metrics: metricsProxy }).metrics.learnerCount).toBe(7)
    expect(metricsOwnKeysCalls).toBe(1)
  })

  it('reads each input field and metric value at most once', () => {
    const reads: Record<string, number> = { groupSize: 0, metrics: 0, minGroupSize: 0 }
    const metrics = baseMetrics()
    const input = {}
    Object.defineProperty(input, 'groupSize', {
      enumerable: true,
      get() {
        reads.groupSize += 1
        return reads.groupSize === 1 ? 7 : 1
      },
    })
    Object.defineProperty(input, 'metrics', {
      enumerable: true,
      get() {
        reads.metrics += 1
        return metrics
      },
    })
    Object.defineProperty(input, 'minGroupSize', {
      enumerable: true,
      get() {
        reads.minGroupSize += 1
        return reads.minGroupSize === 1 ? 5 : Number.MAX_SAFE_INTEGER
      },
    })
    const metricReads: Record<string, number> = { completionRate: 0, learnerCount: 0 }
    for (const key of Object.keys(metrics) as Array<keyof ReturnType<typeof baseMetrics>>) {
      Object.defineProperty(metrics, key, {
        enumerable: true,
        get() {
          metricReads[key] += 1
          return key === 'learnerCount' ? 7 : 0.42
        },
      })
    }
    const result = expectVisible(input)
    expect(reads).toEqual({ groupSize: 1, metrics: 1, minGroupSize: 1 })
    expect(metricReads).toEqual({ completionRate: 1, learnerCount: 1 })
    expect(result.groupSize).toBe(7)
    expect(result.metrics).toEqual({ completionRate: 0.42, learnerCount: 7 })
  })

  it('keeps every failure code-only and values-free across the throwable chain', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...baseInput(), extra: 'secret-extra' }, 'invalid_input'],
      [{ groupSize: 'secret-group-size', metrics: baseMetrics() }, 'invalid_group_size'],
      [{ groupSize: 9, metrics: baseMetrics(), minGroupSize: 4 }, 'invalid_min_group_size'],
      [{ groupSize: 7, metrics: { 'secret-metric': 'secret-value' } }, 'invalid_metrics'],
      [{ groupSize: 7, metrics: {} }, 'invalid_metrics'],
      [null, 'invalid_input'],
    ]
    for (const [input, code] of cases) {
      try {
        applyElearningAnalyticsSuppression(input)
        throw new Error('expected policy error')
      } catch (error) {
        expect(error).toBeInstanceOf(ElearningAnalyticsSuppressionError)
        const policyError = error as ElearningAnalyticsSuppressionError
        expect(policyError.code).toBe(code)
        expect(policyError.message).toBe(code)
        expect(policyError.cause).toBeUndefined()
        const surface = `${policyError.message}\n${policyError.stack ?? ''}`
        expect(surface).not.toContain('secret')
      }
    }
  })
})
