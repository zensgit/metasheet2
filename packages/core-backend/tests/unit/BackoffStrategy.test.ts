import { describe, it, expect } from 'vitest'
import { BackoffStrategy } from '../../src/utils/BackoffStrategy'

describe('BackoffStrategy', () => {
  it('should calculate fixed backoff', () => {
    const options = { type: 'fixed' as const, initialDelay: 1000 }
    expect(BackoffStrategy.calculate(1, options)).toBe(1000)
    expect(BackoffStrategy.calculate(2, options)).toBe(1000)
    expect(BackoffStrategy.calculate(3, options)).toBe(1000)
  })

  it('should calculate linear backoff', () => {
    const options = { type: 'linear' as const, initialDelay: 1000 }
    expect(BackoffStrategy.calculate(1, options)).toBe(1000)
    expect(BackoffStrategy.calculate(2, options)).toBe(2000)
    expect(BackoffStrategy.calculate(3, options)).toBe(3000)
  })

  it('should calculate exponential backoff', () => {
    const options = { type: 'exponential' as const, initialDelay: 1000, factor: 2 }
    expect(BackoffStrategy.calculate(1, options)).toBe(1000)
    expect(BackoffStrategy.calculate(2, options)).toBe(2000)
    expect(BackoffStrategy.calculate(3, options)).toBe(4000)
  })

  it('should respect maxDelay', () => {
    const options = { type: 'exponential' as const, initialDelay: 1000, maxDelay: 3000 }
    expect(BackoffStrategy.calculate(1, options)).toBe(1000)
    expect(BackoffStrategy.calculate(2, options)).toBe(2000)
    expect(BackoffStrategy.calculate(3, options)).toBe(3000) // Capped
    expect(BackoffStrategy.calculate(4, options)).toBe(3000) // Capped
  })

  it('should add jitter', () => {
    const options = { type: 'fixed' as const, initialDelay: 1000, jitter: true }
    const delay = BackoffStrategy.calculate(1, options)
    expect(delay).toBeGreaterThanOrEqual(1000)
    expect(delay).toBeLessThan(1200)
  })
})
