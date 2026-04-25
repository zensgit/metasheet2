import { describe, expect, it } from 'vitest'

import { runWithRequestContext } from '../../src/context/request-context'
import { applyCorrelationHeader } from '../../src/data-adapters/HTTPAdapter'

describe('HTTPAdapter correlation propagation', () => {
  it('sets X-Correlation-ID on outbound requests when a request context is active', () => {
    const config = runWithRequestContext(
      { correlationId: 'trace-123' },
      () => applyCorrelationHeader({ headers: {} }),
    )

    expect(config.headers?.['X-Correlation-ID']).toBe('trace-123')
  })

  it('does not override an explicit caller-supplied correlation header', () => {
    const config = runWithRequestContext(
      { correlationId: 'trace-123' },
      () => applyCorrelationHeader({ headers: { 'x-correlation-id': 'caller-trace' } }),
    )

    expect(config.headers?.['x-correlation-id']).toBe('caller-trace')
    expect(config.headers?.['X-Correlation-ID']).toBeUndefined()
  })

  it('leaves outbound requests unchanged when no request context is active', () => {
    const config = applyCorrelationHeader({ headers: { Authorization: 'Bearer token' } })

    expect(config.headers).toEqual({ Authorization: 'Bearer token' })
  })
})
